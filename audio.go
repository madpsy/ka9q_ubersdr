package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/pion/rtp"
	"golang.org/x/net/ipv4"
	"golang.org/x/sys/unix"
)

// AudioPacket represents an audio packet with PCM data and timestamps
type AudioPacket struct {
	PCMData      []byte
	RTPTimestamp uint32 // RTP timestamp from radiod (kept for reference)
	GPSTimeNs    int64  // Unix ns at which the first sample was captured, or 0 if unknown; see capture_time.go
	RxTimeNs     int64  // Unix ns at which the kernel received the packet (system clock)
	SampleRate   int    // sample rate at which this PCM was encoded by radiod
	Channels     int    // 1 = mono, 2 = interleaved stereo (IQ modes)
}

// AudioReceiver receives PCM audio from radiod multicast streams
type AudioReceiver struct {
	dataAddr         *net.UDPAddr
	iface            *net.Interface
	sessions         *SessionManager
	conn             *net.UDPConn
	running          bool
	mu               sync.RWMutex
	unknownSSRCCount map[uint32]int // Track unknown SSRC counts for debug logging
	sentPacketCount  map[string]int // Track sent packet counts per session for debug logging

	// capture supplies radiod's capture references, which turn each packet's
	// RTP timestamp into the time its samples were captured.  Nil means packets
	// carry their arrival time.  Set before Start.
	capture captureSource
}

// SetCaptureSource gives the receiver radiod's capture references.  Call before Start.
func (ar *AudioReceiver) SetCaptureSource(src captureSource) {
	ar.capture = src
}

// NewAudioReceiver creates a new audio receiver
func NewAudioReceiver(dataAddr *net.UDPAddr, iface *net.Interface, sessions *SessionManager) (*AudioReceiver, error) {
	ar := &AudioReceiver{
		dataAddr: dataAddr,
		iface:    iface,
		sessions: sessions,
	}

	// Create UDP connection for receiving multicast
	// Match ka9q-radio's listen_mcast() behavior from multicast.c
	conn, err := setupDataSocket(dataAddr, iface)
	if err != nil {
		return nil, fmt.Errorf("failed to setup data socket: %w", err)
	}

	ar.conn = conn
	log.Printf("Audio receiver listening on %s (iface: %v)", dataAddr.String(), iface)

	return ar, nil
}

// setupDataSocket creates a UDP socket for receiving multicast data
// This matches ka9q-radio's listen_mcast() behavior
func setupDataSocket(addr *net.UDPAddr, iface *net.Interface) (*net.UDPConn, error) {
	// Create listening config
	lc := net.ListenConfig{
		Control: func(network, address string, c syscall.RawConn) error {
			var sockErr error
			err := c.Control(func(fd uintptr) {
				// Issue #3: Set SO_REUSEPORT to allow multiple processes to bind
				if err := unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_REUSEPORT, 1); err != nil {
					sockErr = fmt.Errorf("failed to set SO_REUSEPORT: %w", err)
					return
				}

				// Issue #3: Set SO_REUSEADDR to allow address reuse
				if err := unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_REUSEADDR, 1); err != nil {
					sockErr = fmt.Errorf("failed to set SO_REUSEADDR: %w", err)
					return
				}

				// Have the kernel stamp each datagram as it enters the stack, so
				// packet time excludes the socket queue and goroutine scheduling.
				// Not fatal: receiveLoop falls back to the time of the read.
				if err := unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_TIMESTAMPNS, 1); err != nil {
					log.Printf("Warning: failed to set SO_TIMESTAMPNS, audio timestamps will use read time: %v", err)
				}
			})
			if err != nil {
				return err
			}
			return sockErr
		},
	}

	// Listen on the multicast address
	conn, err := lc.ListenPacket(context.Background(), "udp4", addr.String())
	if err != nil {
		return nil, fmt.Errorf("failed to listen: %w", err)
	}

	udpConn := conn.(*net.UDPConn)

	// Set a large receive buffer to absorb bursts during Go GC pauses.
	// With many IQ192 channels (~47 pkt/s × 16 KB each), the inbound rate can
	// exceed 40 MB/s. A GC pause of even 5-20 ms at that rate fills the old
	// 1 MB buffer and causes kernel-level drops that stutter ALL channels.
	// 32 MB gives ~2 seconds of headroom at 130 Mbps.
	//
	// IMPORTANT: The kernel silently caps SetReadBuffer at net.core.rmem_max.
	// The default rmem_max is only 208 KB — at 130 Mbps that fills in ~12 ms,
	// causing periodic drops that stutter ALL sessions simultaneously.
	// Run: sudo sysctl -w net.core.rmem_max=134217728
	// (install-hub.sh sets this automatically)
	const wantedBufSize = 32 * 1024 * 1024
	if err := udpConn.SetReadBuffer(wantedBufSize); err != nil {
		log.Printf("Warning: failed to set UDP read buffer size: %v", err)
	}
	// Verify the actual buffer size granted by the kernel via SO_RCVBUF.
	// The kernel doubles the value internally, so divide by 2 for the true size.
	// If it's much smaller than requested, net.core.rmem_max needs to be increased.
	var actualBufSize int
	if rawConn, err := udpConn.SyscallConn(); err == nil {
		rawConn.Control(func(fd uintptr) {
			if v, err := unix.GetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_RCVBUF); err == nil {
				actualBufSize = v / 2 // kernel doubles the value
			}
		})
	}
	if actualBufSize > 0 {
		if actualBufSize < wantedBufSize/2 {
			log.Printf("WARNING: UDP receive buffer is only %d KB (requested %d KB). "+
				"Kernel net.core.rmem_max is too low — high-throughput IQ streaming will "+
				"cause packet drops and audio stuttering. "+
				"Fix: sudo sysctl -w net.core.rmem_max=134217728",
				actualBufSize/1024, wantedBufSize/1024)
		} else {
			log.Printf("UDP receive buffer set to %d KB (requested %d KB)",
				actualBufSize/1024, wantedBufSize/1024)
		}
	}

	// Join multicast group on specified interface
	p := ipv4.NewPacketConn(udpConn)
	if iface != nil {
		if err := p.JoinGroup(iface, addr); err != nil {
			log.Printf("Warning: failed to join multicast group on %s: %v", iface.Name, err)
		}
	}

	// Issue #4: Also join on loopback interface for local traffic
	loopback, err := getLoopbackInterface()
	if err == nil && loopback != nil {
		if err := p.JoinGroup(loopback, addr); err != nil {
			log.Printf("Warning: failed to join multicast group on loopback: %v", err)
		}
	}

	return udpConn, nil
}

// Start starts the audio receiver
func (ar *AudioReceiver) Start() {
	ar.mu.Lock()
	if ar.running {
		ar.mu.Unlock()
		return
	}
	ar.running = true
	ar.mu.Unlock()

	go ar.receiveLoop()
	log.Println("Audio receiver started")
}

// Stop stops the audio receiver
func (ar *AudioReceiver) Stop() {
	ar.mu.Lock()
	defer ar.mu.Unlock()

	if !ar.running {
		return
	}

	ar.running = false
	if ar.conn != nil {
		ar.conn.Close()
	}

	log.Println("Audio receiver stopped")
}

// kernelRxTimeNs returns the SO_TIMESTAMPNS receive time carried in a
// datagram's control messages. It walks the headers in place rather than
// using ParseSocketControlMessage, which allocates on every packet.
func kernelRxTimeNs(oob []byte) (int64, bool) {
	for len(oob) > 0 {
		hdr, data, rest, err := unix.ParseOneSocketControlMessage(oob)
		if err != nil {
			return 0, false
		}
		if hdr.Level == unix.SOL_SOCKET && hdr.Type == unix.SCM_TIMESTAMPNS &&
			len(data) >= int(unsafe.Sizeof(unix.Timespec{})) {
			ts := (*unix.Timespec)(unsafe.Pointer(&data[0]))
			return ts.Nano(), true
		}
		oob = rest
	}
	return 0, false
}

// throttledLog prints at most one line per interval and reports how many
// were suppressed in between, so a persistent fault in a per-packet path
// cannot flood the log. Not safe for concurrent use.
type throttledLog struct {
	interval   time.Duration
	last       time.Time
	suppressed int
}

func (t *throttledLog) Printf(format string, args ...any) {
	now := time.Now()
	if !t.last.IsZero() && now.Sub(t.last) < t.interval {
		t.suppressed++
		return
	}
	if t.suppressed > 0 {
		format += fmt.Sprintf(" (%d similar suppressed)", t.suppressed)
	}
	log.Printf(format, args...)
	t.last = now
	t.suppressed = 0
}

// receiveLoop continuously receives and processes audio packets
func (ar *AudioReceiver) receiveLoop() {
	buffer := make([]byte, 65536)
	// Room for the timestamp message with headroom for any other the kernel
	// adds; a truncated control area just means falling back to read time.
	oob := make([]byte, 128)
	packetCount := 0
	fallbackLogged := false
	readErrLog := throttledLog{interval: 10 * time.Second}
	parseErrLog := throttledLog{interval: 10 * time.Second}

	for {
		ar.mu.RLock()
		running := ar.running
		ar.mu.RUnlock()

		if !running {
			break
		}

		// Read packet
		n, oobn, _, _, err := ar.conn.ReadMsgUDP(buffer, oob)
		if err != nil {
			if !ar.running {
				break
			}
			readErrLog.Printf("Error reading UDP packet: %v", err)
			continue
		}

		// Arrival time is when the kernel received the packet, taken once per
		// packet regardless of client count.  routeAudio turns it, with radiod's
		// capture reference, into the capture time every consumer downstream --
		// WebSocket, KiwiSDR, WebSDR, HTTP stream, extensions -- carries.
		rxTimeNs, ok := kernelRxTimeNs(oob[:oobn])
		if !ok {
			if !fallbackLogged {
				log.Printf("Warning: audio packet arrived without a kernel receive timestamp; using read time where one is missing")
				fallbackLogged = true
			}
			rxTimeNs = time.Now().UnixNano()
		}

		if n < 12 {
			// Too small to be valid RTP
			if DebugMode {
				log.Printf("DEBUG: Received packet too small (%d bytes), skipping", n)
			}
			continue
		}

		// Parse RTP packet using pion/rtp library
		packet := &rtp.Packet{}
		if err := packet.Unmarshal(buffer[:n]); err != nil {
			if ar.running {
				parseErrLog.Printf("Error parsing RTP packet: %v", err)
			}
			continue
		}

		packetCount++

		// Route to appropriate session using SSRC from RTP header
		// Pass payload, RTP timestamp, and GPS timestamp
		ar.routeAudio(packet.SSRC, packet.Payload, packet.Timestamp, rxTimeNs)
	}

	if DebugMode {
		log.Printf("DEBUG: Audio receive loop exited after %d packets", packetCount)
	}
}

// routeAudio routes audio data to the appropriate session based on RTP SSRC.
// rxTimeNs is when the kernel received the packet (system clock).
func (ar *AudioReceiver) routeAudio(ssrc uint32, pcmData []byte, rtpTimestamp uint32, rxTimeNs int64) {
	// Look up session by SSRC
	session, ok := ar.sessions.GetSessionBySSRC(ssrc)
	if !ok {
		// Unknown SSRC - silently ignore (other receivers on the multicast group)
		return
	}

	// CRITICAL: Make a copy of the PCM data!
	// The RTP library reuses the buffer, so we must copy before sending to channel
	dataCopy := make([]byte, len(pcmData))
	copy(dataCopy, pcmData)

	// Read once and use for both the substitution below and the packet header,
	// so the announcement can never be chosen for one rate and labelled another.
	sampleRate := session.SampleRate
	channels := session.Channels

	// When the samples were captured, from radiod's reference for this channel.
	// Only this goroutine touches session.captureStamp.
	var ref captureRef
	var haveRef bool
	if ar.capture != nil {
		ref, haveRef = ar.capture.CaptureRef(ssrc)
	}
	gpsTimeNs := session.captureStamp.stamp(ref, haveRef, rtpTimestamp, rxTimeNs)

	// Blocked ranges: an ordinary listener tuned inside one hears an
	// announcement instead of the band.  Done here rather than in each
	// streaming loop so that one place covers all of them -- the native
	// WebSocket, the KiwiSDR and WebSDR emulations, the HTTP stream tap and
	// audio extensions all read what is written below.  The buffer is
	// overwritten in place, so packet timing, length and RTP/GPS timestamps are
	// exactly those of the real audio it replaces.  See audio_blocked.go.
	session.applyBlockedAudio(dataCopy, sampleRate, channels)

	// Create audio packet with PCM data and timestamps.
	// Stamp SampleRate and Channels NOW from the session — by the time the
	// websocket loop dequeues this packet, both may already reflect a new mode,
	// causing the packet header to lie about the rate or the channel count of
	// the buffered payload. Sending a stale mono packet with the stereo flag
	// set desynchronises a KiwiSDR client for the rest of the connection.
	audioPacket := AudioPacket{
		PCMData:      dataCopy,
		RTPTimestamp: rtpTimestamp,
		GPSTimeNs:    gpsTimeNs,
		RxTimeNs:     rxTimeNs,
		SampleRate:   sampleRate,
		Channels:     channels,
	}

	// Send audio packet to session's channel.
	//
	// The Done guard is necessary but NOT sufficient on its own: select picks at
	// random among ready cases, and a send on a closed channel counts as ready,
	// so it can win over Done and panic. This is where the "panic: send on closed
	// channel" of 2026-07-21 landed. What actually makes this safe is that
	// DestroySession() no longer closes AudioChan — see the note there.
	select {
	case <-session.Done:
		// Session is being destroyed, skip this packet
		return
	case session.AudioChan <- audioPacket:
		// Successfully sent
	default:
		// Channel full, skip this packet silently
	}

	// Also send to audio extension if attached.
	// Check HasAudioExtension() BEFORE converting to int16 to avoid a
	// make([]int16, N) allocation on every packet when no extension is running.
	// With many IQ192 channels this was adding ~30 MB/s of wasted allocations.
	if len(dataCopy) > 0 && len(dataCopy)%2 == 0 && session.HasAudioExtension() {
		samples := bytesToInt16Samples(dataCopy)
		audioSample := AudioSample{
			PCMData:      samples,
			RTPTimestamp: rtpTimestamp,
			GPSTimeNs:    gpsTimeNs,
		}
		session.SendAudioToExtension(audioSample)
	}
}

// bytesToInt16Samples converts big-endian PCM bytes to int16 samples
func bytesToInt16Samples(pcmBytes []byte) []int16 {
	sampleCount := len(pcmBytes) / 2
	samples := make([]int16, sampleCount)

	for i := 0; i < sampleCount; i++ {
		// Big-endian int16
		samples[i] = int16(pcmBytes[i*2])<<8 | int16(pcmBytes[i*2+1])
	}

	return samples
}

// GetChannelAudio returns a channel for receiving audio for a specific session
// Audio routing is automatic via SSRC matching, no subscription needed
func (ar *AudioReceiver) GetChannelAudio(session *Session) <-chan AudioPacket {
	return session.AudioChan
}

// ReleaseChannelAudio releases audio routing for a session
// No action needed since routing is automatic via SSRC
func (ar *AudioReceiver) ReleaseChannelAudio(session *Session) {
	// No-op: session cleanup handles everything
}

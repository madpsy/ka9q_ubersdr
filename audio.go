package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"sync"
	"syscall"
	"time"

	"github.com/pion/rtp"
	"golang.org/x/net/ipv4"
	"golang.org/x/sys/unix"
)

// AudioPacket represents an audio packet with PCM data and timestamps
type AudioPacket struct {
	PCMData      []byte
	RTPTimestamp uint32 // RTP timestamp from radiod (kept for reference)
	GPSTimeNs    int64  // GPS-synchronized Unix time in nanoseconds
	SampleRate   int    // sample rate at which this PCM was encoded by radiod
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

// receiveLoop continuously receives and processes audio packets
func (ar *AudioReceiver) receiveLoop() {
	buffer := make([]byte, 65536)
	packetCount := 0

	for {
		ar.mu.RLock()
		running := ar.running
		ar.mu.RUnlock()

		if !running {
			break
		}

		// Read packet
		n, _, err := ar.conn.ReadFromUDP(buffer)
		if err != nil {
			if !ar.running {
				break
			}
			log.Printf("Error reading UDP packet: %v", err)
			continue
		}

		// Capture GPS-synchronized timestamp immediately after packet arrival
		// This is done once per packet regardless of client count for efficiency
		gpsTimeNs := time.Now().UnixNano()

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
				log.Printf("Error parsing RTP packet: %v", err)
			}
			continue
		}

		packetCount++

		// Route to appropriate session using SSRC from RTP header
		// Pass payload, RTP timestamp, and GPS timestamp
		ar.routeAudio(packet.SSRC, packet.Payload, packet.Timestamp, gpsTimeNs)
	}

	if DebugMode {
		log.Printf("DEBUG: Audio receive loop exited after %d packets", packetCount)
	}
}

// routeAudio routes audio data to the appropriate session based on RTP SSRC
// The GPS timestamp represents when the packet arrived at ubersdr (GPS-synchronized)
func (ar *AudioReceiver) routeAudio(ssrc uint32, pcmData []byte, rtpTimestamp uint32, gpsTimeNs int64) {
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

	// Create audio packet with PCM data and timestamps.
	// Stamp SampleRate NOW from the session — by the time the websocket loop
	// dequeues this packet, session.SampleRate may already reflect a new mode,
	// causing the packet header to lie about the rate of the buffered payload.
	audioPacket := AudioPacket{
		PCMData:      dataCopy,
		RTPTimestamp: rtpTimestamp,
		GPSTimeNs:    gpsTimeNs,
		SampleRate:   session.SampleRate,
	}

	// Send audio packet to session's channel
	// Check session.Done first to avoid race condition with DestroySession()
	// which closes Done before closing AudioChan
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

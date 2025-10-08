package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"sync"
	"syscall"

	"github.com/pion/rtp"
	"golang.org/x/net/ipv4"
	"golang.org/x/sys/unix"
)

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

	// Set buffer size (1 MB like multidecoder)
	if err := udpConn.SetReadBuffer(1024 * 1024); err != nil {
		log.Printf("Warning: failed to set read buffer size: %v", err)
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
		ar.routeAudio(packet.SSRC, packet.Payload)
	}
	
	if DebugMode {
		log.Printf("DEBUG: Audio receive loop exited after %d packets", packetCount)
	}
}

// routeAudio routes audio data to the appropriate session based on RTP SSRC
func (ar *AudioReceiver) routeAudio(ssrc uint32, pcmData []byte) {
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

	// Send audio to session's channel
	select {
	case session.AudioChan <- dataCopy:
		// Successfully sent - log first few in debug mode
		if DebugMode {
			ar.mu.Lock()
			if ar.sentPacketCount == nil {
				ar.sentPacketCount = make(map[string]int)
			}
			ar.sentPacketCount[session.ID]++
			count := ar.sentPacketCount[session.ID]
			ar.mu.Unlock()
			
			if count <= 5 {
				log.Printf("DEBUG: Routed audio packet #%d to session %s (SSRC: 0x%08x, %d bytes)",
					count, session.ID, ssrc, len(dataCopy))
			}
		}
	default:
		// Channel full, skip this packet
		log.Printf("Warning: audio channel full for session %s (SSRC: %d)", session.ID, ssrc)
	}
}

// GetChannelAudio returns a channel for receiving audio for a specific session
// Audio routing is automatic via SSRC matching, no subscription needed
func (ar *AudioReceiver) GetChannelAudio(session *Session) <-chan []byte {
	return session.AudioChan
}

// ReleaseChannelAudio releases audio routing for a session
// No action needed since routing is automatic via SSRC
func (ar *AudioReceiver) ReleaseChannelAudio(session *Session) {
	// No-op: session cleanup handles everything
}
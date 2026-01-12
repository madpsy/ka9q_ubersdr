package main

import (
	"fmt"
	"log"
	"net"
	"sync"
	"time"
)

// HPSDR Protocol 1 Implementation (Metis/Hermes)
// Based on: OpenHPSDR Metis Protocol
// Used by: SDR Console, older HPSDR software

const (
	// Protocol 1 magic bytes
	Protocol1MagicByte1 = 0xef
	Protocol1MagicByte2 = 0xfe

	// Protocol 1 commands
	Protocol1CmdDiscovery = 0x02
	Protocol1CmdStart     = 0x01
	Protocol1CmdStop      = 0x00

	// Protocol 1 packet sizes
	Protocol1DiscoverySize = 63   // Discovery request
	Protocol1ResponseSize  = 60   // Discovery response
	Protocol1DataSize      = 1032 // IQ data packet (8 header + 1024 data) - but actually needs 8 + 512*6 = 3080 for 24-bit samples
	Protocol1ControlSize   = 1024 // Control packet (can be 1024 or 1032, accept both)

	// Protocol 1 device types
	Protocol1DeviceMetis      = 0x00
	Protocol1DeviceHermes     = 0x01
	Protocol1DeviceGriffin    = 0x02
	Protocol1DeviceAngelia    = 0x04
	Protocol1DeviceOrion      = 0x05
	Protocol1DeviceHermesLite = 0x06

	// Protocol 1 uses port 1024 for everything (discovery, control, and data)
	Protocol1Port = 1024
)

// Protocol1Config holds configuration for HPSDR Protocol 1 emulation
type Protocol1Config struct {
	Interface    string
	IPAddress    string
	MACAddress   net.HardwareAddr
	NumReceivers int
	DeviceType   byte
}

// Protocol1Server implements HPSDR Protocol 1 (Metis)
type Protocol1Server struct {
	config  Protocol1Config
	running bool
	mu      sync.RWMutex

	// Socket - Protocol 1 uses single port for everything
	// In socket-less mode (auto-detect), this will be nil and sharedSock will be used
	sock       *net.UDPConn
	sharedSock *net.UDPConn // Shared socket from Protocol 2 (for auto-detect mode)

	// Client address
	clientAddr *net.UDPAddr

	// Receiver state (Protocol 1 typically supports 1-4 receivers)
	receivers [MaxReceivers]*Protocol1ReceiverState

	// Synchronization for IQ data
	sendFlags     uint32
	doneSendFlags uint32
	sendMu        sync.Mutex
	sendCond      *sync.Cond
	doneSendMu    sync.Mutex
	doneSendCond  *sync.Cond

	// Shutdown
	stopChan chan struct{}
	wg       sync.WaitGroup

	// Sequence number for data packets
	seqNum uint32
}

// Protocol1ReceiverState holds state for a single receiver in Protocol 1
type Protocol1ReceiverState struct {
	num          int
	enabled      bool
	frequency    int64
	sampleRate   int // in kHz (typically 48, 96, or 192)
	iqBuffer     []complex64
	packetBuf    [63 * 6 * 2]byte // 2 frames × 63 IQ samples × 6 bytes (I24 + Q24) = 756 bytes
	mu           sync.Mutex
	receiverMask uint32
	lastActivity time.Time // Last time a control packet was received
}

// NewProtocol1Server creates a new HPSDR Protocol 1 server
func NewProtocol1Server(config Protocol1Config) (*Protocol1Server, error) {
	if config.NumReceivers < 1 || config.NumReceivers > MaxReceivers {
		config.NumReceivers = 4 // Protocol 1 typically supports up to 4 receivers
	}

	s := &Protocol1Server{
		config:   config,
		stopChan: make(chan struct{}),
	}

	s.sendCond = sync.NewCond(&s.sendMu)
	s.doneSendCond = sync.NewCond(&s.doneSendMu)

	// Initialize receivers
	for i := 0; i < config.NumReceivers; i++ {
		receiverMask := uint32(1 << uint(i))
		s.receivers[i] = &Protocol1ReceiverState{
			num:          i,
			frequency:    10000000,               // 10 MHz default
			sampleRate:   192,                    // 192 kHz default
			iqBuffer:     make([]complex64, 126), // 126 samples per packet (63 per frame × 2 frames)
			receiverMask: receiverMask,
		}
		// Initialize doneSendFlags so first LoadIQData() call doesn't block
		s.doneSendFlags |= receiverMask
	}

	return s, nil
}

// Start begins the Protocol 1 server
// If skipSocket is true, don't create socket (will be called from Protocol2's discovery port)
func (s *Protocol1Server) Start() error {
	return s.StartWithSocket(true)
}

// StartWithSocket begins the Protocol 1 server with optional socket creation
// If sharedSocket is provided, use it instead of creating our own (for auto-detect mode)
func (s *Protocol1Server) StartWithSocket(createSocket bool) error {
	if createSocket {
		// Create UDP socket on port 1024
		// Protocol 1 uses the same port for discovery, control, and data
		addr := &net.UDPAddr{
			IP:   net.ParseIP(s.config.IPAddress),
			Port: Protocol1Port,
		}

		var err error
		s.sock, err = net.ListenUDP("udp4", addr)
		if err != nil {
			return fmt.Errorf("failed to create Protocol 1 socket: %w", err)
		}

		log.Printf("Protocol1: Server started on %s:%d with %d receivers",
			s.config.IPAddress, Protocol1Port, s.config.NumReceivers)

		// Start main thread
		s.wg.Add(1)
		go s.mainThread()
	} else {
		log.Printf("Protocol1: Server started (socket-less mode, using shared socket) with %d receivers",
			s.config.NumReceivers)
	}

	return nil
}

// SetSharedSocket sets the shared socket for socket-less mode
func (s *Protocol1Server) SetSharedSocket(sock *net.UDPConn) {
	s.sharedSock = sock
}

// Stop shuts down the Protocol 1 server
func (s *Protocol1Server) Stop() {
	close(s.stopChan)

	// Wake up all threads waiting on condition variables
	s.sendCond.Broadcast()
	s.doneSendCond.Broadcast()

	s.wg.Wait()

	// Close socket
	if s.sock != nil {
		s.sock.Close()
	}

	log.Println("Protocol1: Server stopped")
}

// mainThread handles all Protocol 1 packets (discovery, control, and data on same port)
func (s *Protocol1Server) mainThread() {
	defer s.wg.Done()
	log.Println("Protocol1: Main thread started")

	buffer := make([]byte, 2048)
	s.sock.SetReadDeadline(time.Now().Add(100 * time.Millisecond))

	for {
		select {
		case <-s.stopChan:
			log.Println("Protocol1: Main thread stopped")
			return
		default:
		}

		n, addr, err := s.sock.ReadFromUDP(buffer)
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				// Use longer timeout when no client connected to reduce CPU usage
				s.mu.RLock()
				hasClient := s.clientAddr != nil
				s.mu.RUnlock()

				if hasClient {
					s.sock.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
				} else {
					s.sock.SetReadDeadline(time.Now().Add(1 * time.Second))
				}
				continue
			}
			log.Printf("Protocol1: Read error: %v", err)
			continue
		}

		// Check for Protocol 1 magic bytes
		if n < 3 || buffer[0] != Protocol1MagicByte1 || buffer[1] != Protocol1MagicByte2 {
			if debugDiscovery {
				log.Printf("Protocol1: Received non-Protocol1 packet (%d bytes) from %s", n, addr)
			}
			continue
		}

		// Dispatch based on packet type
		cmd := buffer[2]

		switch {
		case n == Protocol1DiscoverySize && cmd == Protocol1CmdDiscovery:
			// Discovery packet
			if debugDiscovery {
				log.Printf("Protocol1: Discovery packet from %s", addr)
			}
			s.handleDiscovery(addr)

		case n == Protocol1ControlSize:
			// Control packet (start/stop, frequency changes, etc.)
			if debugDiscovery {
				log.Printf("Protocol1: Control packet from %s (cmd=0x%02x)", addr, cmd)
			}
			s.handleControl(buffer[:n], addr)

		default:
			if debugDiscovery {
				log.Printf("Protocol1: Unknown packet type: %d bytes, cmd=0x%02x from %s", n, cmd, addr)
			}
		}
	}
}

// handleDiscovery sends Protocol 1 discovery response
func (s *Protocol1Server) handleDiscovery(addr *net.UDPAddr) {
	response := make([]byte, Protocol1ResponseSize)

	// Bytes 0-1: Magic bytes
	response[0] = Protocol1MagicByte1
	response[1] = Protocol1MagicByte2

	// Byte 2: Status (0x02 = not running, 0x03 = running)
	s.mu.RLock()
	if s.running {
		response[2] = 0x03
	} else {
		response[2] = 0x02
	}
	s.mu.RUnlock()

	// Bytes 3-8: MAC address (6 bytes)
	copy(response[3:9], s.config.MACAddress)

	// Byte 9: Device type
	response[9] = s.config.DeviceType

	// Byte 10: Code version (firmware version)
	response[10] = FirmwareVersion

	// Bytes 11-59: Reserved/zeros

	_, err := s.sock.WriteToUDP(response, addr)
	if err != nil {
		log.Printf("Protocol1: Failed to send discovery response: %v", err)
		return
	}

	log.Printf("Protocol1: Discovery response sent to %s (Device=0x%02x, FW=%d)",
		addr, s.config.DeviceType, FirmwareVersion)

	if debugDiscovery {
		log.Printf("Protocol1: Discovery response details:")
		log.Printf("Protocol1:   Magic: ef fe")
		log.Printf("Protocol1:   Status: 0x%02x (%s)", response[2],
			func() string {
				if response[2] == 0x03 {
					return "running"
				}
				return "not running"
			}())
		log.Printf("Protocol1:   MAC: %02x:%02x:%02x:%02x:%02x:%02x",
			response[3], response[4], response[5], response[6], response[7], response[8])
		log.Printf("Protocol1:   Device Type: 0x%02x", response[9])
		log.Printf("Protocol1:   Firmware: %d", response[10])
	}
}

// handleControlFromDiscoveryPort handles Protocol 1 control packets received from Protocol2's discovery port
// This is used when running in auto-detect mode where Protocol2 forwards Protocol1 packets
func (s *Protocol1Server) handleControlFromDiscoveryPort(buffer []byte, addr *net.UDPAddr) {
	s.handleControl(buffer, addr)
}

// handleControl processes Protocol 1 control packets
func (s *Protocol1Server) handleControl(buffer []byte, addr *net.UDPAddr) {
	if len(buffer) < 3 {
		return
	}

	cmd := buffer[2]

	// Update last activity timestamp for all receivers
	now := time.Now()
	for i := 0; i < s.config.NumReceivers; i++ {
		s.receivers[i].mu.Lock()
		s.receivers[i].lastActivity = now
		s.receivers[i].mu.Unlock()
	}

	if debugDiscovery {
		log.Printf("Protocol1: Control packet received from %s: cmd=0x%02x, %d bytes", addr, cmd, len(buffer))
	}

	// Handle different packet types
	switch cmd {
	case 0x04: // Program/Set packet (64 bytes) - used for configuration
		if len(buffer) < 64 {
			if debugDiscovery {
				log.Printf("Protocol1: Program packet too short: %d bytes", len(buffer))
			}
			return
		}
		// These are configuration packets, can be safely ignored for basic operation
		if debugDiscovery {
			log.Printf("Protocol1: Program/Set packet received (ignoring)")
		}
		return

	case Protocol1CmdStart: // 0x01 - Start/control packet (1024 bytes)
		if len(buffer) < 1024 {
			if debugDiscovery {
				log.Printf("Protocol1: Control packet too short: %d bytes (need 1024)", len(buffer))
			}
			return
		}

		// Parse control data first to extract frequency
		s.parseControlPacket(buffer)

		// Start command - start radio if not already running
		s.mu.Lock()
		if !s.running {
			s.running = true
			s.clientAddr = addr
			log.Printf("Protocol1: Radio started by client %s", addr)

			// Start single sender thread that interleaves all receivers
			s.wg.Add(1)
			go s.senderThread()
		}
		s.mu.Unlock()

	case Protocol1CmdStop: // 0x00 - Stop command
		if len(buffer) < 1024 {
			return
		}

		// Stop command
		s.mu.Lock()
		if s.running {
			s.running = false
			s.clientAddr = nil
			log.Printf("Protocol1: Radio stopped by client %s", addr)

			// Reset receivers
			for i := 0; i < s.config.NumReceivers; i++ {
				s.receivers[i].enabled = false
				s.receivers[i].frequency = 0
			}
		}
		s.mu.Unlock()

	default:
		// Other control commands
		if len(buffer) >= 1024 {
			if debugDiscovery {
				log.Printf("Protocol1: Processing control packet with cmd=0x%02x", cmd)
			}
			s.parseControlPacket(buffer)
		}
	}
}

// parseControlPacket extracts control information from Protocol 1 control packet
func (s *Protocol1Server) parseControlPacket(buffer []byte) {
	// Protocol 1 packet structure (1024 bytes from SDR Console):
	// Bytes 0-2: ef fe 01 (Metis header)
	// Byte 3: endpoint (usually 0x02)
	// Bytes 4-7: sequence number (4 bytes)
	// Bytes 8-519: Frame 1 (512 bytes)
	//   - Bytes 8-10: 0x7F 0x7F 0x7F (sync)
	//   - Bytes 11-15: C0 C1 C2 C3 C4 (control bytes)
	//   - Bytes 16-519: IQ/audio data
	// Bytes 520-1031: Frame 2 (512 bytes, same structure)

	if len(buffer) < 1024 {
		return
	}

	// Parse first frame's control bytes
	// Frame 1 starts at byte 8
	if len(buffer) >= 16 && buffer[8] == 0x7F && buffer[9] == 0x7F && buffer[10] == 0x7F {
		c0 := buffer[11] // Control byte 0: MOX, command type
		c1 := buffer[12] // Control byte 1: varies by command
		c2 := buffer[13] // Control byte 2: varies by command
		c3 := buffer[14] // Control byte 3: varies by command
		c4 := buffer[15] // Control byte 4: varies by command

		// Determine command type from C0
		commandType := (c0 >> 1) & 0x1F

		if debugDiscovery {
			log.Printf("Protocol1: Frame 1 - C0=0x%02x (MOX=%v, Cmd=%d), C1-C4=%02x %02x %02x %02x",
				c0, (c0&0x01) != 0, commandType, c1, c2, c3, c4)
		}

		// Handle different command types
		switch commandType {
		case 0: // Configuration command (command 0x00)
			// C1 contains sample rate and other config
			// Bits 0-1: Sample rate (00=48k, 01=96k, 02=192k, 03=384k)
			sampleRateBits := c1 & 0x03
			var sampleRateKHz int
			switch sampleRateBits {
			case 0x00:
				sampleRateKHz = 48
			case 0x01:
				sampleRateKHz = 96
			case 0x02:
				sampleRateKHz = 192
			case 0x03:
				sampleRateKHz = 384
			default:
				sampleRateKHz = 192 // Default to 192 kHz
			}

			// Ignore 48 kHz - SDR Console uses this as a default in command cycling
			// Only accept 96, 192, or 384 kHz
			if sampleRateKHz != 48 {
				// Update sample rate for all receivers
				for i := 0; i < s.config.NumReceivers; i++ {
					s.receivers[i].mu.Lock()
					if s.receivers[i].sampleRate != sampleRateKHz {
						s.receivers[i].sampleRate = sampleRateKHz
						log.Printf("Protocol1: Receiver %d sample rate = %d kHz", i, sampleRateKHz)
					}
					s.receivers[i].mu.Unlock()
				}
			}

		case 1: // TX frequency (command 0x02)
			// TX frequency - we don't need to handle this for RX-only operation
			if debugDiscovery {
				freq := int64(uint32(c1)<<24 | uint32(c2)<<16 | uint32(c3)<<8 | uint32(c4))
				log.Printf("Protocol1: TX frequency command: %d Hz (%.3f MHz)", freq, float64(freq)/1e6)
			}

		case 2, 3, 4, 5: // RX frequencies (commands 0x04, 0x06, 0x08, 0x0A)
			// RX frequency commands: 0x04=RX0, 0x06=RX1, 0x08=RX2, 0x0A=RX3
			// Command type 2 = 0x04 >> 1, type 3 = 0x06 >> 1, etc.
			// So receiver number = commandType - 2
			receiverNum := int(commandType) - 2

			if receiverNum >= 0 && receiverNum < s.config.NumReceivers {
				// C1-C4 contain the 32-bit frequency in Hz (big-endian)
				freq := int64(uint32(c1)<<24 | uint32(c2)<<16 | uint32(c3)<<8 | uint32(c4))

				// Ignore 10 MHz - SDR Console uses this as a "park" frequency in command cycling
				// Only process frequencies that are NOT 10 MHz
				if freq > 0 && freq != 10000000 {
					s.receivers[receiverNum].mu.Lock()
					oldFreq := s.receivers[receiverNum].frequency
					wasEnabled := s.receivers[receiverNum].enabled

					// Update frequency immediately (no debouncing)
					if freq != oldFreq {
						s.receivers[receiverNum].frequency = freq
						log.Printf("Protocol1: Receiver %d frequency = %d Hz (%.3f MHz)",
							receiverNum, freq, float64(freq)/1e6)
					}

					// Enable receiver when frequency is set
					if !wasEnabled {
						s.receivers[receiverNum].enabled = true
						log.Printf("Protocol1: Receiver %d enabled at %d Hz (%.3f MHz)",
							receiverNum, freq, float64(freq)/1e6)
					}
					s.receivers[receiverNum].mu.Unlock()
				}
			}
		}

		// Enable receiver 0 immediately when radio starts if not already enabled
		// Protocol 1 expects the radio to start streaming as soon as it receives start command
		s.receivers[0].mu.Lock()
		if !s.receivers[0].enabled {
			if s.receivers[0].frequency == 0 {
				s.receivers[0].frequency = 14200000 // 14.2 MHz default
			}
			s.receivers[0].enabled = true
			log.Printf("Protocol1: Receiver 0 enabled at %d Hz (%.3f MHz)",
				s.receivers[0].frequency, float64(s.receivers[0].frequency)/1e6)
		}
		s.receivers[0].mu.Unlock()
	}

	// Parse second frame's control bytes (if present)
	// Frame 2 starts at byte 520
	if len(buffer) >= 528 && buffer[520] == 0x7F && buffer[521] == 0x7F && buffer[522] == 0x7F {
		c0 := buffer[523]
		c1 := buffer[524]
		c2 := buffer[525]
		c3 := buffer[526]
		c4 := buffer[527]

		commandType := (c0 >> 1) & 0x1F

		if debugDiscovery {
			log.Printf("Protocol1: Frame 2 - C0=0x%02x (MOX=%v, Cmd=%d), C1-C4=%02x %02x %02x %02x",
				c0, (c0&0x01) != 0, commandType, c1, c2, c3, c4)
		}

		// Process Frame 2 commands as well (SDR Console uses both frames for command cycling)
		switch commandType {
		case 0: // Configuration command
			// C1 contains sample rate and other config
			sampleRateBits := c1 & 0x03
			var sampleRateKHz int
			switch sampleRateBits {
			case 0x00:
				sampleRateKHz = 48
			case 0x01:
				sampleRateKHz = 96
			case 0x02:
				sampleRateKHz = 192
			case 0x03:
				sampleRateKHz = 384
			default:
				sampleRateKHz = 192
			}

			// Ignore 48 kHz - SDR Console uses this as a default in command cycling
			if sampleRateKHz != 48 {
				// Update sample rate for all receivers
				for i := 0; i < s.config.NumReceivers; i++ {
					s.receivers[i].mu.Lock()
					if s.receivers[i].sampleRate != sampleRateKHz {
						s.receivers[i].sampleRate = sampleRateKHz
						log.Printf("Protocol1: Receiver %d sample rate = %d kHz", i, sampleRateKHz)
					}
					s.receivers[i].mu.Unlock()
				}
			}

		case 2, 3, 4, 5: // RX frequencies (commands 0x04, 0x06, 0x08, 0x0A)
			receiverNum := int(commandType) - 2

			if receiverNum >= 0 && receiverNum < s.config.NumReceivers {
				freq := int64(uint32(c1)<<24 | uint32(c2)<<16 | uint32(c3)<<8 | uint32(c4))

				// Ignore 10 MHz - SDR Console uses this as a "park" frequency in command cycling
				if freq > 0 && freq != 10000000 {
					s.receivers[receiverNum].mu.Lock()
					oldFreq := s.receivers[receiverNum].frequency
					wasEnabled := s.receivers[receiverNum].enabled

					// Update frequency immediately (no debouncing)
					if freq != oldFreq {
						s.receivers[receiverNum].frequency = freq
						log.Printf("Protocol1: Receiver %d frequency = %d Hz (%.3f MHz)",
							receiverNum, freq, float64(freq)/1e6)
					}

					// Enable receiver when frequency is set
					if !wasEnabled {
						s.receivers[receiverNum].enabled = true
						log.Printf("Protocol1: Receiver %d enabled at %d Hz (%.3f MHz)",
							receiverNum, freq, float64(freq)/1e6)
					}
					s.receivers[receiverNum].mu.Unlock()
				}
			}
		}
	}
}

// senderThread sends IQ data packets with all receivers interleaved (Protocol 1 format)
func (s *Protocol1Server) senderThread() {
	defer s.wg.Done()
	log.Printf("Protocol1: Sender thread started")

	for {
		select {
		case <-s.stopChan:
			log.Printf("Protocol1: Sender thread stopped")
			return
		default:
		}

		s.mu.RLock()
		running := s.running
		clientAddr := s.clientAddr
		numReceivers := s.config.NumReceivers
		s.mu.RUnlock()

		if !running || clientAddr == nil {
			time.Sleep(50 * time.Millisecond)
			continue
		}

		// Count enabled receivers
		enabledCount := 0
		var enabledReceivers []*Protocol1ReceiverState
		for i := 0; i < numReceivers; i++ {
			s.receivers[i].mu.Lock()
			if s.receivers[i].enabled {
				enabledCount++
				enabledReceivers = append(enabledReceivers, s.receivers[i])
			}
			s.receivers[i].mu.Unlock()
		}

		if enabledCount == 0 {
			time.Sleep(50 * time.Millisecond)
			continue
		}

		// Wait for ALL enabled receivers to have data ready
		s.sendMu.Lock()
		allReady := false
		for !allReady {
			allReady = true
			for _, rcv := range enabledReceivers {
				if (s.sendFlags & rcv.receiverMask) == 0 {
					allReady = false
					break
				}
			}
			if !allReady {
				select {
				case <-s.stopChan:
					s.sendMu.Unlock()
					return
				default:
				}
				s.sendCond.Wait()
			}
		}
		// Clear all enabled receiver flags
		for _, rcv := range enabledReceivers {
			s.sendFlags &= ^rcv.receiverMask
		}
		s.sendMu.Unlock()

		// Calculate number of IQ samples per frame based on number of receivers
		// Formula from linhpsdr: iq_samples = (512-8) / ((num_receivers * 6) + 2)
		samplesPerFrame := (512 - 8) / ((enabledCount * 6) + 2)

		// Build Protocol 1 data packet (1032 bytes)
		// Structure: 8-byte Metis header + 2 frames of 512 bytes each
		packet := make([]byte, Protocol1DataSize)

		// Metis header (8 bytes)
		packet[0] = Protocol1MagicByte1 // 0xEF
		packet[1] = Protocol1MagicByte2 // 0xFE
		packet[2] = 0x01                // Data packet
		packet[3] = 0x06                // Endpoint 6 (standard for IQ data)

		// Sequence number (4 bytes, big-endian, 32-bit)
		packet[4] = byte(s.seqNum >> 24)
		packet[5] = byte(s.seqNum >> 16)
		packet[6] = byte(s.seqNum >> 8)
		packet[7] = byte(s.seqNum)

		// Frame 1 (512 bytes starting at offset 8)
		packet[8] = 0x7F  // Sync 0
		packet[9] = 0x7F  // Sync 1
		packet[10] = 0x7F // Sync 2
		packet[11] = 0x00 // C0 - control byte 0
		packet[12] = 0x00 // C1 - control byte 1
		packet[13] = 0x00 // C2 - control byte 2
		packet[14] = 0x00 // C3 - control byte 3
		packet[15] = 0x00 // C4 - control byte 4

		// Pack IQ samples with all receivers interleaved for frame 1
		// Format: RX0_I(3) RX0_Q(3) RX1_I(3) RX1_Q(3) ... Mic(2) repeated samplesPerFrame times
		frameOffset := 16
		for sampleIdx := 0; sampleIdx < samplesPerFrame; sampleIdx++ {
			// Interleave all enabled receivers' samples
			for _, rcv := range enabledReceivers {
				rcv.mu.Lock()
				// Copy I and Q samples (6 bytes) for this receiver
				copy(packet[frameOffset:frameOffset+6], rcv.packetBuf[sampleIdx*6:(sampleIdx+1)*6])
				rcv.mu.Unlock()
				frameOffset += 6
			}
			// Add mic sample (2 bytes, zeros for now)
			packet[frameOffset] = 0x00
			packet[frameOffset+1] = 0x00
			frameOffset += 2
		}

		// Frame 2 (512 bytes starting at offset 520)
		packet[520] = 0x7F // Sync 0
		packet[521] = 0x7F // Sync 1
		packet[522] = 0x7F // Sync 2
		packet[523] = 0x00 // C0 - control byte 0
		packet[524] = 0x00 // C1 - control byte 1
		packet[525] = 0x00 // C2 - control byte 2
		packet[526] = 0x00 // C3 - control byte 3
		packet[527] = 0x00 // C4 - control byte 4

		// Pack IQ samples with all receivers interleaved for frame 2
		frameOffset = 528
		for sampleIdx := samplesPerFrame; sampleIdx < samplesPerFrame*2; sampleIdx++ {
			// Interleave all enabled receivers' samples
			for _, rcv := range enabledReceivers {
				rcv.mu.Lock()
				// Copy I and Q samples (6 bytes) for this receiver
				copy(packet[frameOffset:frameOffset+6], rcv.packetBuf[sampleIdx*6:(sampleIdx+1)*6])
				rcv.mu.Unlock()
				frameOffset += 6
			}
			// Add mic sample (2 bytes, zeros for now)
			packet[frameOffset] = 0x00
			packet[frameOffset+1] = 0x00
			frameOffset += 2
		}

		// Send packet to client
		var sock *net.UDPConn
		if s.sock != nil {
			sock = s.sock
		} else if s.sharedSock != nil {
			sock = s.sharedSock
		} else {
			log.Printf("Protocol1: Cannot send - no socket available")
			continue
		}

		_, err := sock.WriteToUDP(packet, clientAddr)
		if err != nil {
			log.Printf("Protocol1: Send error: %v", err)
			continue
		}

		// Increment sequence number
		s.seqNum++

		// Signal completion to all enabled receivers
		s.doneSendMu.Lock()
		for _, rcv := range enabledReceivers {
			s.doneSendFlags |= rcv.receiverMask
		}
		s.doneSendCond.Broadcast()
		s.doneSendMu.Unlock()
	}
}

// LoadIQData loads IQ samples into a receiver's buffer (Protocol 1 format)
// Converts complex64 samples to 24-bit integer format
func (s *Protocol1Server) LoadIQData(receiverNum int, samples []complex64) error {
	if receiverNum < 0 || receiverNum >= s.config.NumReceivers {
		return fmt.Errorf("invalid receiver number: %d", receiverNum)
	}

	// Calculate expected number of samples based on number of enabled receivers
	// For now, we'll accept variable length and store what we get
	// The sender thread will calculate the correct number to use

	rcv := s.receivers[receiverNum]

	// Wait for previous packet to be sent
	s.doneSendMu.Lock()
	for (s.doneSendFlags & rcv.receiverMask) == 0 {
		select {
		case <-s.stopChan:
			s.doneSendMu.Unlock()
			return fmt.Errorf("server stopping")
		default:
		}
		s.doneSendCond.Wait()
	}
	s.doneSendFlags &= ^rcv.receiverMask
	s.doneSendMu.Unlock()

	// Convert complex64 samples to 24-bit integer format
	// Protocol 1 uses 24-bit samples (3 bytes each for I and Q)
	// Scale factor: Use same as Protocol 2 for 192 kHz (4000.0)
	// The full 24-bit range (8388607) is too hot and causes S9+80 readings
	const scale = 4000.0

	rcv.mu.Lock()
	// Store up to 126 samples (maximum for single receiver case)
	maxSamples := len(samples)
	if maxSamples > 126 {
		maxSamples = 126
	}
	for i := 0; i < maxSamples; i++ {
		// Scale from float32 [-1.0, 1.0] to int32 24-bit range
		// Use moderate scaling to match Protocol 2 signal levels
		iVal := int32(real(samples[i]) * scale)
		qVal := int32(imag(samples[i]) * scale)

		// Pack as 24-bit big-endian, signed (Q first, then I - opposite of Protocol 2!)
		// linhpsdr reads: left_sample (I), right_sample (Q)
		// But the spectrum is backwards, so we need to swap: Q first, then I
		// Each sample is 6 bytes total (3 for Q, 3 for I)
		offset := i * 6
		rcv.packetBuf[offset+0] = byte(qVal >> 16)
		rcv.packetBuf[offset+1] = byte(qVal >> 8)
		rcv.packetBuf[offset+2] = byte(qVal)
		rcv.packetBuf[offset+3] = byte(iVal >> 16)
		rcv.packetBuf[offset+4] = byte(iVal >> 8)
		rcv.packetBuf[offset+5] = byte(iVal)
	}
	rcv.mu.Unlock()

	// Signal that data is ready
	s.sendMu.Lock()
	s.sendFlags |= rcv.receiverMask
	s.sendCond.Broadcast()
	s.sendMu.Unlock()

	return nil
}

// GetReceiverState returns the current state of a receiver
func (s *Protocol1Server) GetReceiverState(receiverNum int) (enabled bool, frequency int64, sampleRate int, err error) {
	if receiverNum < 0 || receiverNum >= s.config.NumReceivers {
		return false, 0, 0, fmt.Errorf("invalid receiver number: %d", receiverNum)
	}

	rcv := s.receivers[receiverNum]
	rcv.mu.Lock()

	// Check if receiver has timed out (no control packets for 5 seconds)
	if rcv.enabled {
		if rcv.lastActivity.IsZero() {
			// First call - initialize to now
			rcv.lastActivity = time.Now()
		} else if time.Since(rcv.lastActivity) > 5*time.Second {
			log.Printf("Protocol1: Receiver %d timed out (no activity for %.1fs), disabling",
				receiverNum, time.Since(rcv.lastActivity).Seconds())
			rcv.enabled = false
			rcv.frequency = 0
		}
	}

	enabled = rcv.enabled
	frequency = rcv.frequency
	sampleRate = rcv.sampleRate
	rcv.mu.Unlock()

	// Check if we should stop the radio (do this outside the receiver lock)
	if !enabled {
		s.mu.Lock()
		anyEnabled := false
		for i := 0; i < s.config.NumReceivers; i++ {
			s.receivers[i].mu.Lock()
			if s.receivers[i].enabled {
				anyEnabled = true
			}
			s.receivers[i].mu.Unlock()
			if anyEnabled {
				break
			}
		}
		if !anyEnabled && s.running {
			s.running = false
			s.clientAddr = nil
			log.Printf("Protocol1: All receivers timed out, stopping radio")
		}
		s.mu.Unlock()
	}

	return enabled, frequency, sampleRate, nil
}

// IsRunning returns whether the radio is running
func (s *Protocol1Server) IsRunning() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.running
}

// GetClientAddr returns the current client address
func (s *Protocol1Server) GetClientAddr() *net.UDPAddr {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.clientAddr
}

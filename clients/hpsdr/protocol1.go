package main

import (
	"fmt"
	"log"
	"net"
	"sync"
	"sync/atomic"
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

// Debug flags — set via SetDebugDiscovery from main()
var (
	debugDiscovery bool // Log discovery and control packet details
	debugSeqNum    bool // Log sequence numbers every 100 packets
	// debugBridge is declared in main.go
)

// SetDebugDiscovery enables/disables discovery debug logging
func SetDebugDiscovery(v bool) { debugDiscovery = v }

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

	// Shutdown
	stopChan chan struct{}
	wg       sync.WaitGroup

	// Sequence number for data packets
	seqNum uint32
}

// iqChanDepth is the number of IQ sample packets buffered per receiver channel.
// Depth 4 gives ~4 packet-intervals of headroom before LoadIQData drops a packet.
const iqChanDepth = 4

// maxSamplesPerPacket is the maximum number of IQ samples in one Protocol 1 packet
// (single-receiver case: 63 samples/frame × 2 frames = 126).
const maxSamplesPerPacket = 126

// Protocol1ReceiverState holds state for a single receiver in Protocol 1
type Protocol1ReceiverState struct {
	num          int
	enabled      bool
	frequency    int64
	sampleRate   int // in kHz (typically 48, 96, or 192)
	mu           sync.Mutex
	lastActivity time.Time // Last time a control packet was received

	// iqChan carries raw complex64 IQ samples from LoadIQData to senderThread.
	// The sender encodes them with the current samplesPerFrame so the encoding
	// is always consistent with the current receiver count — no layout mismatch
	// when the receiver count changes mid-stream.
	// Buffered at depth iqChanDepth; oldest packet dropped if full (non-blocking send).
	iqChan  chan [maxSamplesPerPacket]complex64
	iqDrops uint64 // count of packets dropped due to full iqChan (accessed atomically)
}

// NewProtocol1Server creates a new HPSDR Protocol 1 server
func NewProtocol1Server(config Protocol1Config) (*Protocol1Server, error) {
	if config.NumReceivers < 1 || config.NumReceivers > MaxReceivers {
		config.NumReceivers = MaxReceivers
	}

	s := &Protocol1Server{
		config:   config,
		stopChan: make(chan struct{}),
	}

	// Initialize receivers — each gets its own buffered IQ channel.
	// Depth 4 gives ~4 packet-intervals of headroom (~2–4 ms at 192 kHz) before
	// LoadIQData drops a packet.  The sender drains at the hardware-paced rate so
	// the channel should rarely be more than 1 deep in steady state.
	for i := 0; i < config.NumReceivers; i++ {
		s.receivers[i] = &Protocol1ReceiverState{
			num:        i,
			frequency:  10000000, // 10 MHz default
			sampleRate: 0,        // 0 = not yet set by client
			iqChan:     make(chan [maxSamplesPerPacket]complex64, iqChanDepth),
		}
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
	s.wg.Wait()

	// Close socket
	if s.sock != nil {
		_ = s.sock.Close()
	}

	log.Println("Protocol1: Server stopped")
}

// mainThread handles all Protocol 1 packets (discovery, control, and data on same port)
func (s *Protocol1Server) mainThread() {
	defer s.wg.Done()
	log.Println("Protocol1: Main thread started")

	buffer := make([]byte, 2048)
	_ = s.sock.SetReadDeadline(time.Now().Add(100 * time.Millisecond))

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
					_ = s.sock.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
				} else {
					_ = s.sock.SetReadDeadline(time.Now().Add(1 * time.Second))
				}
				continue
			}
			log.Printf("Protocol1: Read error: %v", err)
			continue
		}

		// Check for Protocol 1 magic bytes — ignore anything else (e.g. Protocol 2 discovery probes)
		if n < 3 || buffer[0] != Protocol1MagicByte1 || buffer[1] != Protocol1MagicByte2 {
			if debugDiscovery {
				log.Printf("Protocol1: Ignoring non-Protocol1 packet (%d bytes) from %s", n, addr)
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

		case n == Protocol1ControlSize || n == Protocol1DataSize:
			// Control packet (start/stop, frequency changes, etc.)
			// Accept both 1024 and 1032 byte packets
			s.handleControl(buffer[:n], addr)

		case n == 64 && cmd == 0x04:
			// SparkSDR start/stop command: ef fe 04 03 (start) or ef fe 04 00 (stop)
			s.handleControl(buffer[:n], addr)

		default:
			if debugDiscovery {
				log.Printf("Protocol1: Unknown packet type: %d bytes, cmd=0x%02x from %s", n, cmd, addr)
			}
		}
	}
}

// handleDiscovery sends Protocol 1 discovery response.
//
// HL2 discovery response layout (60 bytes) per PROTOCOL.md §Metis Discovery Reply:
//
//	Byte  0:    0xef  (magic)
//	Byte  1:    0xfe  (magic)
//	Byte  2:    0x02 (not running) or 0x03 (running)
//	Bytes 3-8:  MAC address (6 bytes)
//	              Bytes 3-6: OUI+fixed 00:1c:c0:a2 (Microchip Technology — all HL2s)
//	              Bytes 7-8: unit ID Y:Z (user-configurable per-device)
//	Byte  9:    Gateware Major Version (firmware version)
//	Byte  10:   Board ID (0x06 = HermesLite2, 0x01 = Hermes emulation)
//	Bytes 11-16: zeros (MCP4662 EEPROM fields, not used here)
//	Bytes 17-18: MCP4662 0x0C/0x0D — MAC unit ID Y:Z (must match MAC bytes 7-8)
//	Byte  19:   Number of Hardware Receivers (0x13 per spec)
//	Bytes 20-21: 0x45 0x08 (HL2 extended info)
//	Bytes 22-59: zeros (reserved)
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

	// Bytes 3-8: MAC address (6 bytes) — per spec byte 0x03 = MAC[0]
	copy(response[3:9], s.config.MACAddress)

	// Byte 9: Gateware Major Version (firmware version)
	response[9] = FirmwareVersion

	// Byte 10: Board ID (device type)
	response[10] = s.config.DeviceType

	// Bytes 11-16: zeros (MCP4662 EEPROM fields — not populated)

	// Bytes 17-18: MAC unit ID Y:Z — must match MAC bytes 4-5 (the user-configurable octets).
	// Per spec: byte 0x11 = MCP4662 0x0C (MAC Y), byte 0x12 = MCP4662 0x0D (MAC Z).
	// Real HL2 MAC: 00:1c:c0:a2:<Y>:<Z> where Y and Z are the configurable unit ID bytes.
	response[17] = s.config.MACAddress[4]
	response[18] = s.config.MACAddress[5]

	// Byte 19: Number of receivers (spec byte 0x13)
	response[19] = byte(s.config.NumReceivers)

	// Bytes 20-21: HL2 extended info
	response[20] = 0x45
	response[21] = 0x08

	// Bytes 22-59: Reserved/zeros

	// Use shared socket if available (socket-less mode), otherwise use own socket
	sock := s.sock
	if sock == nil {
		sock = s.sharedSock
	}

	if sock == nil {
		log.Printf("Protocol1: Cannot send discovery response - no socket available")
		return
	}

	_, err := sock.WriteToUDP(response, addr)
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
		log.Printf("Protocol1:   Device Type: 0x%02x", response[10])
		log.Printf("Protocol1:   Firmware: %d", response[9])
	}
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

	// Handle different packet types
	switch cmd {
	case 0x04: // Start/stop command (64 bytes): ef fe 04 <running>
		// byte[3]: 0x01 or 0x03 = start (running), 0x00 = stop
		// SparkSDR sends: ef fe 04 03 (start) and ef fe 04 00 (stop)
		if len(buffer) < 4 {
			return
		}
		running := buffer[3] != 0x00
		if running {
			s.mu.Lock()
			if !s.running {
				s.running = true
				s.clientAddr = addr
				log.Printf("Protocol1: Radio STARTING by client %s (cmd=0x04 start)", addr)
				s.wg.Add(1)
				go s.senderThread()
			}
			s.mu.Unlock()
		} else {
			s.mu.Lock()
			if s.running {
				s.running = false
				log.Printf("Protocol1: Radio STOPPING by client %s (cmd=0x04 stop)", addr)
			}
			s.mu.Unlock()
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
			log.Printf("Protocol1: Radio STARTING by client %s (socket=%v, sharedSock=%v)", addr, s.sock != nil, s.sharedSock != nil)

			// Start single sender thread that interleaves all receivers
			s.wg.Add(1)
			go s.senderThread()
		}
		s.mu.Unlock()

	case Protocol1CmdStop: // 0x00 - Stop command
		if len(buffer) < 1024 {
			return
		}

		// Parse control bytes even on stop — the packet still carries valid C0-C4
		// configuration (sample rate, frequencies, etc.) that we need to capture
		// before the radio starts. SparkSDR sends 48 kHz in a stop packet first.
		s.parseControlPacket(buffer)

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

// setReceiverFrequency updates a receiver's frequency and enables it if not already enabled.
// Skips park/unset frequencies (< MinFrequencyHz or exactly 10 MHz SDR Console park).
// receiverNum is 0-based (0 = RX1, 1 = RX2, ...).
func (s *Protocol1Server) setReceiverFrequency(receiverNum int, freq int64) {
	if receiverNum < 0 || receiverNum >= s.config.NumReceivers {
		return
	}
	// Skip park/unset frequencies:
	// - < MinFrequencyHz: unset/garbage (SparkSDR sends 32 Hz for unconfigured receivers)
	// - 10 MHz: SDR Console park frequency
	if freq < MinFrequencyHz || freq == 10000000 {
		return
	}
	s.receivers[receiverNum].mu.Lock()
	oldFreq := s.receivers[receiverNum].frequency
	wasEnabled := s.receivers[receiverNum].enabled
	if freq != oldFreq {
		s.receivers[receiverNum].frequency = freq
		log.Printf("Protocol1: Receiver %d frequency = %d Hz (%.3f MHz)",
			receiverNum, freq, float64(freq)/1e6)
	}
	if !wasEnabled {
		s.receivers[receiverNum].enabled = true
		log.Printf("Protocol1: Receiver %d enabled at %d Hz (%.3f MHz)",
			receiverNum, freq, float64(freq)/1e6)
	}
	s.receivers[receiverNum].mu.Unlock()
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

		// Determine command type from C0.
		// Spec: C0[6:1] = ADDR[5:0] (6 bits), C0[0] = MOX.
		// Mask must be 0x3F (6 bits), not 0x1F (5 bits).
		commandType := (c0 >> 1) & 0x3F

		// Handle different command types
		switch commandType {
		case 0: // Configuration command (ADDR 0x00)
			// DATA[25:24] = Speed (bits 1:0 of C1)
			// DATA[6:3]   = Number of Receivers (bits 6:3 of C4, i.e. DATA[7:0])
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

			// Update sample rate for all receivers (all rates including 48 kHz are valid)
			log.Printf("Protocol1: Client requested sample rate = %d kHz", sampleRateKHz)
			for i := 0; i < s.config.NumReceivers; i++ {
				s.receivers[i].mu.Lock()
				if s.receivers[i].sampleRate != sampleRateKHz {
					s.receivers[i].sampleRate = sampleRateKHz
					log.Printf("Protocol1: Receiver %d sample rate = %d kHz", i, sampleRateKHz)
				}
				s.receivers[i].mu.Unlock()
			}

			// Parse number of receivers from ADDR 0x00 bits [6:3] = DATA[6:3] = C4[6:3].
			// Spec encoding: 0000=1 receiver, 0001=2, ..., 1011=12.
			numRxBits := (c4 >> 3) & 0x0F
			numRx := int(numRxBits) + 1
			if numRx >= 1 && numRx <= MaxReceivers {
				if numRx != s.config.NumReceivers {
					log.Printf("Protocol1: Client requested %d receivers (was %d)", numRx, s.config.NumReceivers)
					s.config.NumReceivers = numRx
				}
			}

		case 1: // TX frequency (ADDR 0x01) — RX-only bridge; silently ignore

		// ADDR 0x02-0x08: RX1-RX7 NCO frequencies (receiver indices 0-6)
		// Spec: 0x02=RX1, 0x03=RX2, ..., 0x08=RX7
		// Note: ADDR 0x09-0x11 are NOT RX frequencies (TX drive, LNA gain, CW hang time, etc.)
		case 2, 3, 4, 5, 6, 7, 8:
			receiverNum := int(commandType) - 2 // 0x02→0, 0x03→1, ..., 0x08→6
			freq := int64(uint32(c1)<<24 | uint32(c2)<<16 | uint32(c3)<<8 | uint32(c4))
			s.setReceiverFrequency(receiverNum, freq)

		// ADDR 0x12-0x16: RX8-RX12 NCO frequencies (receiver indices 7-11)
		// Spec: 0x12=RX8, 0x13=RX9, 0x14=RX10, 0x15=RX11, 0x16=RX12
		case 0x12, 0x13, 0x14, 0x15, 0x16:
			receiverNum := int(commandType) - 0x12 + 7 // 0x12→7, 0x13→8, 0x14→9, 0x15→10, 0x16→11
			freq := int64(uint32(c1)<<24 | uint32(c2)<<16 | uint32(c3)<<8 | uint32(c4))
			s.setReceiverFrequency(receiverNum, freq)
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

		// Spec: C0[6:1] = ADDR[5:0] (6 bits) — mask must be 0x3F
		commandType := (c0 >> 1) & 0x3F

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

			// Update sample rate for all receivers (all rates including 48 kHz are valid)
			log.Printf("Protocol1: Client requested sample rate = %d kHz (Frame 2)", sampleRateKHz)
			for i := 0; i < s.config.NumReceivers; i++ {
				s.receivers[i].mu.Lock()
				if s.receivers[i].sampleRate != sampleRateKHz {
					s.receivers[i].sampleRate = sampleRateKHz
					log.Printf("Protocol1: Receiver %d sample rate = %d kHz", i, sampleRateKHz)
				}
				s.receivers[i].mu.Unlock()
			}

			// Parse number of receivers from ADDR 0x00 bits [6:3] = DATA[6:3] = C4[6:3].
			// Spec encoding: 0000=1 receiver, 0001=2, ..., 1011=12.
			numRxBits := (c4 >> 3) & 0x0F
			numRx := int(numRxBits) + 1
			if numRx >= 1 && numRx <= MaxReceivers {
				if numRx != s.config.NumReceivers {
					log.Printf("Protocol1: Client requested %d receivers (was %d)", numRx, s.config.NumReceivers)
					s.config.NumReceivers = numRx
				}
			}

		// ADDR 0x02-0x08: RX1-RX7 NCO frequencies (receiver indices 0-6)
		case 2, 3, 4, 5, 6, 7, 8:
			receiverNum := int(commandType) - 2
			freq := int64(uint32(c1)<<24 | uint32(c2)<<16 | uint32(c3)<<8 | uint32(c4))
			s.setReceiverFrequency(receiverNum, freq)

		// ADDR 0x12-0x16: RX8-RX12 NCO frequencies (receiver indices 7-11)
		case 0x12, 0x13, 0x14, 0x15, 0x16:
			receiverNum := int(commandType) - 0x12 + 7
			freq := int64(uint32(c1)<<24 | uint32(c2)<<16 | uint32(c3)<<8 | uint32(c4))
			s.setReceiverFrequency(receiverNum, freq)
		}
	}
}

// senderThread sends IQ data packets with all receivers interleaved (Protocol 1 format).
//
// Rate pacing: the send rate is naturally controlled by the primary receiver's iqChan.
// LoadIQData pushes one packet per audio delivery cycle; senderThread blocks on the
// channel read, so it sends at exactly the rate audio arrives — no separate ticker needed.
// Additional receivers are read non-blocking (silence used if no data available), so a
// slow or reconnecting secondary receiver never stalls the primary.
func (s *Protocol1Server) senderThread() {
	defer s.wg.Done()
	log.Printf("Protocol1: Sender thread started")

	lastEnabledCnt := -1 // sentinel: force flush on first iteration
	// Per-receiver silence counters for throttled debug logging.
	silenceCounts := make([]uint64, s.config.NumReceivers)

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

		// Count enabled receivers and read the current sample rate.
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

		// When the number of enabled receivers changes, the samplesPerFrame formula
		// produces a different value, so any packets already queued in iqChan were
		// produced for the OLD samplesPerFrame.  Reading them with the new value
		// would cause frame 2 to index into the wrong samples (layout mismatch).
		// Drain all iqChans before proceeding so we only ever encode fresh packets.
		if enabledCount != lastEnabledCnt {
			log.Printf("Protocol1: Receiver count changed %d→%d (samplesPerFrame %d→%d), flushing iqChans",
				lastEnabledCnt, enabledCount,
				func() int {
					if lastEnabledCnt > 0 {
						return (512 - 8) / ((lastEnabledCnt * 6) + 2)
					}
					return 0
				}(),
				(512-8)/((enabledCount*6)+2),
			)
			lastEnabledCnt = enabledCount
			for i := 0; i < numReceivers; i++ {
				drained := 0
				for {
					select {
					case <-s.receivers[i].iqChan:
						drained++
					default:
						goto doneDrain
					}
				}
			doneDrain:
				if drained > 0 {
					log.Printf("Protocol1: Flushed %d stale packet(s) from receiver %d iqChan", drained, i)
				}
			}
			// After flushing, loop back so we block on a fresh packet from the
			// primary receiver rather than immediately reading stale data.
			continue
		}

		// Calculate number of IQ samples per frame based on number of receivers.
		// Formula from linhpsdr: iq_samples = (512-8) / ((num_receivers * 6) + 2)
		samplesPerFrame := (512 - 8) / ((enabledCount * 6) + 2)

		// Collect one pre-encoded IQ buffer from each enabled receiver.
		// Each receiver's LoadIQData goroutine pushes [iqPacketBufSize]byte values
		// into rcv.iqChan independently — no rendezvous needed.
		//
		// We wait up to one packet-interval for the first (primary) receiver so that
		// the sender stays in sync with the incoming audio rate.  For additional
		// receivers we do a non-blocking read: if no data is available we use silence
		// (all zeros) for that receiver this packet.  This prevents a slow or
		// reconnecting secondary receiver from stalling the primary.
		// Collect one raw IQ sample buffer from each enabled receiver.
		// The sender encodes them itself using the current samplesPerFrame so the
		// encoding is always consistent with the current receiver count.
		snapshots := make([][maxSamplesPerPacket]complex64, len(enabledReceivers))
		if len(enabledReceivers) > 0 {
			// Wait for primary receiver with stopChan escape.
			select {
			case buf, ok := <-enabledReceivers[0].iqChan:
				if ok {
					snapshots[0] = buf
				}
			case <-s.stopChan:
				return
			}
			// Non-blocking reads for additional receivers.
			for i := 1; i < len(enabledReceivers); i++ {
				select {
				case buf, ok := <-enabledReceivers[i].iqChan:
					if ok {
						snapshots[i] = buf
						silenceCounts[i] = 0 // reset on successful read
					}
				default:
					// No data yet — silence (zeros already in snapshots[i])
					silenceCounts[i]++
					if debugBridge && (silenceCounts[i] == 1 || silenceCounts[i]%500 == 0) {
						log.Printf("Protocol1: Receiver %d: no IQ data available, using silence (count=%d)", i, silenceCounts[i])
					}
				}
			}
		}

		// Periodic sender health log: every 500 packets log geometry and channel depths.
		if debugBridge && s.seqNum%500 == 0 {
			samplesPerFrame := (512 - 8) / ((enabledCount * 6) + 2)
			depths := make([]int, numReceivers)
			for i := 0; i < numReceivers; i++ {
				depths[i] = len(s.receivers[i].iqChan)
			}
			log.Printf("Protocol1: seq=%d enabledRx=%d samplesPerFrame=%d samplesPerPacket=%d iqChanDepths=%v",
				s.seqNum, enabledCount, samplesPerFrame, samplesPerFrame*2, depths)
		}

		// Build Protocol 1 data packet (1032 bytes).
		// Structure: 8-byte Metis header + 2 frames of 512 bytes each.
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

		// Build the Classic Response C0-C4 bytes for this packet.
		//
		// Per PROTOCOL.md "Classic Response when ACK==0":
		//   C0[7]   = 0 (ACK=0)
		//   C0[6:3] = RADDR[3:0]
		//   C0[2]   = Dot (CW key, always 0 for RX-only bridge)
		//   C0[1]   = Dash (always 0)
		//   C0[0]   = PTT (always 0 for RX-only bridge)
		//
		// Per PROTOCOL.md "Base Memory Map when ACK==0":
		//   RADDR=0x00: DATA[25]=Tx Inhibited (Active Low), DATA[7:0]=Firmware Version
		//   RADDR=0x01: DATA[31:16]=Temperature, DATA[15:0]=Forward Power
		//   RADDR=0x02: DATA[31:16]=Reverse Power, DATA[15:0]=Current
		//
		// The radio must cycle through RADDR 0x00→0x01→0x02 on successive packets.
		// Both frames in the same packet carry the same RADDR.
		raddr := byte(s.seqNum % 3) // 0x00, 0x01, 0x02, 0x00, ...
		c0 := raddr << 3            // C0[6:3] = RADDR[3:0]; C0[2:0] = 0 (no PTT/dot/dash)

		var c1, c2, c3, c4 byte
		switch raddr {
		case 0x00:
			// DATA[25] = Tx Inhibited (Active Low) → must be 1 = TX not inhibited.
			// C1 = DATA[31:24]; DATA[25] = C1[1] → C1 = 0x02.
			// DATA[7:0] = Firmware Version → C4 = FirmwareVersion.
			c1 = 0x02
			c4 = FirmwareVersion // 0x40
		case 0x01:
			// Temperature=0, Forward Power=0 — all zeros (RX-only bridge has no PA)
		case 0x02:
			// Reverse Power=0, Current=0 — all zeros
		}

		// Frame 1 (512 bytes starting at offset 8)
		packet[8] = 0x7F  // Sync 0
		packet[9] = 0x7F  // Sync 1
		packet[10] = 0x7F // Sync 2
		packet[11] = c0   // C0 - RADDR cycling per openHPSDR spec
		packet[12] = c1   // C1 - status data for this RADDR
		packet[13] = c2   // C2
		packet[14] = c3   // C3
		packet[15] = c4   // C4

		// encodeIQ writes one complex64 sample as 24-bit big-endian I then Q into packet[off:off+6].
		// Scale factor 4000.0 matches Protocol 2 signal levels (full 24-bit range is too hot).
		const scale = float32(4000.0)
		encodeIQ := func(off int, s complex64) {
			iVal := int32(real(s) * scale)
			qVal := int32(imag(s) * scale)
			packet[off+0] = byte(iVal >> 16)
			packet[off+1] = byte(iVal >> 8)
			packet[off+2] = byte(iVal)
			packet[off+3] = byte(qVal >> 16)
			packet[off+4] = byte(qVal >> 8)
			packet[off+5] = byte(qVal)
		}

		// Pack IQ samples with all receivers interleaved for frame 1.
		// Format: RX0_I(3) RX0_Q(3) RX1_I(3) RX1_Q(3) ... Mic(2) repeated samplesPerFrame times.
		// snapshots[i] contains raw complex64 samples; we encode here with the current samplesPerFrame.
		frameOffset := 16
		for sampleIdx := 0; sampleIdx < samplesPerFrame; sampleIdx++ {
			for i := range enabledReceivers {
				encodeIQ(frameOffset, snapshots[i][sampleIdx])
				frameOffset += 6
			}
			// Mic sample (2 bytes, zeros — RX-only bridge)
			packet[frameOffset] = 0x00
			packet[frameOffset+1] = 0x00
			frameOffset += 2
		}

		// Frame 2 (512 bytes starting at offset 520)
		// Same RADDR/C0-C4 as frame 1 — both frames in a packet share the same response.
		packet[520] = 0x7F // Sync 0
		packet[521] = 0x7F // Sync 1
		packet[522] = 0x7F // Sync 2
		packet[523] = c0   // C0 - same RADDR as frame 1
		packet[524] = c1   // C1
		packet[525] = c2   // C2
		packet[526] = c3   // C3
		packet[527] = c4   // C4

		// Pack IQ samples with all receivers interleaved for frame 2.
		frameOffset = 528
		for sampleIdx := samplesPerFrame; sampleIdx < samplesPerFrame*2; sampleIdx++ {
			for i := range enabledReceivers {
				encodeIQ(frameOffset, snapshots[i][sampleIdx])
				frameOffset += 6
			}
			// Mic sample (2 bytes, zeros — RX-only bridge)
			packet[frameOffset] = 0x00
			packet[frameOffset+1] = 0x00
			frameOffset += 2
		}

		// Send packet to client.
		var sock *net.UDPConn
		if s.sock != nil {
			sock = s.sock
			if debugSeqNum && s.seqNum%100 == 0 {
				log.Printf("Protocol1: Sending seq=%d via own socket to %s", s.seqNum, clientAddr)
			}
		} else if s.sharedSock != nil {
			sock = s.sharedSock
			if debugSeqNum && s.seqNum%100 == 0 {
				log.Printf("Protocol1: Sending seq=%d via shared socket to %s", s.seqNum, clientAddr)
			}
		} else {
			log.Printf("Protocol1: Cannot send - no socket available")
			continue
		}

		_, err := sock.WriteToUDP(packet, clientAddr)
		if err != nil {
			log.Printf("Protocol1: Send error: %v", err)
			continue
		}

		// Log first few packets to confirm sending is working.
		if s.seqNum < 5 {
			log.Printf("Protocol1: Successfully sent IQ packet seq=%d (%d bytes) to %s", s.seqNum, len(packet), clientAddr)
		}

		// Increment sequence number.
		s.seqNum++
	}
}

// LoadIQData encodes IQ samples into Protocol 1 24-bit format and pushes them
// into the receiver's iqChan for the sender thread to consume.
//
// samplesPerPacket must match the value computed by forwardToHPSDR() and senderThread()
// for the current enabled-receiver count:
//
//	samplesPerFrame  = (512-8) / ((numEnabledReceivers*6)+2)
//	samplesPerPacket = samplesPerFrame * 2
//
// The call is non-blocking: if the channel is full (sender is behind) the oldest
// buffered packet is discarded and the new one is queued.  This prevents any
// receiver goroutine from ever blocking on another receiver's progress.
func (s *Protocol1Server) LoadIQData(receiverNum int, samples []complex64, samplesPerPacket int) error {
	if receiverNum < 0 || receiverNum >= s.config.NumReceivers {
		return fmt.Errorf("invalid receiver number: %d", receiverNum)
	}

	// Clamp samplesPerPacket to the physical buffer size (126 = single-receiver max).
	const maxPacketSamples = 126
	if samplesPerPacket <= 0 || samplesPerPacket > maxPacketSamples {
		samplesPerPacket = maxPacketSamples
	}

	rcv := s.receivers[receiverNum]

	// Copy samples into a fixed-size [maxSamplesPerPacket]complex64 array.
	// The sender encodes them to 24-bit bytes using its own samplesPerFrame,
	// which is always consistent with the current receiver count.
	// Tail beyond writeSamples is zero (zero-value array = silence).
	var buf [maxSamplesPerPacket]complex64
	writeSamples := len(samples)
	if writeSamples > samplesPerPacket {
		writeSamples = samplesPerPacket
	}
	copy(buf[:writeSamples], samples[:writeSamples])

	// Non-blocking send: if the channel is full, drain the oldest entry first
	// so we always push the freshest data.
	dropped := false
	select {
	case rcv.iqChan <- buf:
		// queued successfully
	default:
		// Channel full — discard oldest, then queue new.
		dropped = true
		select {
		case <-rcv.iqChan:
		default:
		}
		select {
		case rcv.iqChan <- buf:
		default:
		}
	}

	if dropped {
		drops := atomic.AddUint64(&rcv.iqDrops, 1)
		if debugBridge && (drops == 1 || drops%100 == 0) {
			log.Printf("Protocol1: Receiver %d iqChan full, dropped oldest packet (total drops=%d, chan depth=%d/%d)",
				receiverNum, drops, len(rcv.iqChan), cap(rcv.iqChan))
		}
	}

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

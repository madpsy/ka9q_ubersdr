package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"log"
	"math"
	"net"
	"os"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// Debug flags (can be set via environment variables or SetDebugDiscovery function)
var debugSeqNum = os.Getenv("HPSDR_DEBUG_SEQ") != ""
var debugDiscovery = os.Getenv("HPSDR_DEBUG_DISCOVERY") != ""

// SetDebugDiscovery enables or disables discovery debug logging
func SetDebugDiscovery(enabled bool) {
	debugDiscovery = enabled
}

// HPSDR Protocol 2 Implementation
// Based on: https://github.com/TAPR/OpenHPSDR-Firmware/blob/master/Protocol%202/Documentation/openHPSDR%20Ethernet%20Protocol%20v4.3.pdf

const (
	// Device types
	DeviceHermes     = 0x01
	DeviceHermesLite = 0x06

	// Protocol constants
	MaxReceivers       = 10 // Support up to 10 receivers (Hermes-Lite2 extension)
	SamplesPerPacket   = 238
	IQDataSize         = 1428 // 238 samples * 6 bytes
	BitsPerSample      = 24
	WidebandSampleSize = 32768

	// Port assignments
	PortDiscovery   = 1024
	PortHighPrio    = 1027
	PortDDCSpecific = 1025
	PortMic         = 1026
	PortDDC0        = 1035 // DDC ports are 1035-1044 (1035 + receiver_num)

	// Firmware version
	// Use Hermes-Lite2 cicrx version: FW=72 (0x48), Protocol=8
	FirmwareVersion = 72
	ProtocolVersion = 8
)

// Protocol2Config holds configuration for HPSDR Protocol 2 emulation
type Protocol2Config struct {
	Interface        string
	IPAddress        string
	MACAddress       net.HardwareAddr
	NumReceivers     int
	DeviceType       byte
	WidebandEnable   bool
	MicrophoneEnable bool
}

// Protocol2Server implements HPSDR Protocol 2
type Protocol2Server struct {
	config      Protocol2Config
	running     bool
	genReceived bool // General packet received flag
	mu          sync.RWMutex

	// Protocol 1 server for handling Protocol 1 data packets (optional)
	protocol1Server *Protocol1Server

	// Sockets
	discoverySock *net.UDPConn
	highPrioSock  *net.UDPConn
	ddcSpecSock   *net.UDPConn
	micSock       *net.UDPConn
	widebandSock  *net.UDPConn
	rxSocks       [MaxReceivers]*net.UDPConn

	// Client address
	clientAddr *net.UDPAddr

	// Receiver state
	receivers [MaxReceivers]*ReceiverState

	// Control flags
	bits      int // Frequency conversion mode bits
	adcDither bool
	adcRandom bool
	stepAtt0  int
	wbEnable  bool
	wbLength  int
	wbSize    int
	wbRate    int
	wbPPF     int

	// Synchronization
	sendFlags     uint32
	doneSendFlags uint32
	sendMu        sync.Mutex
	sendCond      *sync.Cond
	doneSendMu    sync.Mutex
	doneSendCond  *sync.Cond

	// Shutdown
	stopChan chan struct{}
	wg       sync.WaitGroup
}

// ReceiverState holds state for a single receiver
type ReceiverState struct {
	num          int
	enabled      bool
	frequency    int64
	sampleRate   int // in kHz
	scale        float32
	seqNum       uint32
	errCount     uint32 // Error counter for diagnostics
	iqBuffer     []complex64
	packetBuf    [SamplesPerPacket * 6]byte
	mu           sync.Mutex
	receiverMask uint32
	lastActivity time.Time // Last time a packet was received from HPSDR client
}

// NewProtocol2Server creates a new HPSDR Protocol 2 server
func NewProtocol2Server(config Protocol2Config) (*Protocol2Server, error) {
	if config.NumReceivers < 1 || config.NumReceivers > MaxReceivers {
		config.NumReceivers = MaxReceivers
	}

	s := &Protocol2Server{
		config:   config,
		stopChan: make(chan struct{}),
		bits:     0x08, // Enable fractional frequency mode by default
	}

	s.sendCond = sync.NewCond(&s.sendMu)
	s.doneSendCond = sync.NewCond(&s.doneSendMu)

	// Initialize receivers
	for i := 0; i < config.NumReceivers; i++ {
		receiverMask := uint32(1 << uint(i))
		s.receivers[i] = &ReceiverState{
			num:          i,
			frequency:    10000000, // 10 MHz default
			sampleRate:   192,      // 192 kHz default
			scale:        4000.0,   // Default for 192 kHz
			iqBuffer:     make([]complex64, SamplesPerPacket*2),
			receiverMask: receiverMask,
		}
		// Initialize doneSendFlags so first LoadIQData() call doesn't block
		s.doneSendFlags |= receiverMask
	}

	return s, nil
}

// Start begins the Protocol 2 server
func (s *Protocol2Server) Start() error {
	var err error

	// Create ListenConfig that sets SO_REUSEADDR and SO_REUSEPORT before bind
	// This allows multiple instances to share ports
	createListenConfig := func(bindToInterface bool) *net.ListenConfig {
		return &net.ListenConfig{
			Control: func(network, address string, c syscall.RawConn) error {
				var sockErr error
				err := c.Control(func(fd uintptr) {
					// Set SO_REUSEADDR
					if err := syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 1); err != nil {
						sockErr = fmt.Errorf("failed to set SO_REUSEADDR: %w", err)
						return
					}
					// Set SO_REUSEPORT - critical for multiple instances
					if err := syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, unix.SO_REUSEPORT, 1); err != nil {
						sockErr = fmt.Errorf("failed to set SO_REUSEPORT: %w", err)
						return
					}
					// Optionally bind to specific interface
					if bindToInterface && s.config.Interface != "" {
						if err := syscall.SetsockoptString(int(fd), syscall.SOL_SOCKET, unix.SO_BINDTODEVICE, s.config.Interface); err != nil {
							sockErr = fmt.Errorf("failed to bind to interface %s: %w", s.config.Interface, err)
							return
						}
					}
				})
				if err != nil {
					return err
				}
				return sockErr
			},
		}
	}

	// Setup discovery socket (port 1024)
	// Always bind to 0.0.0.0:1024 to receive broadcast packets
	// SO_BINDTODEVICE (if interface specified) restricts to specific interface
	// SO_REUSEPORT allows multiple instances to coexist
	lc := createListenConfig(s.config.Interface != "")
	lp, err := lc.ListenPacket(context.Background(), "udp4", "0.0.0.0:1024")
	if err != nil {
		return fmt.Errorf("failed to create discovery socket: %w", err)
	}
	s.discoverySock = lp.(*net.UDPConn)
	log.Printf("Protocol2: Discovery socket bound to 0.0.0.0:1024 (interface: %s)",
		func() string {
			if s.config.Interface != "" {
				return s.config.Interface
			}
			return "all"
		}())

	// Setup high priority socket (port 1027)
	lc = createListenConfig(true)
	lp, err = lc.ListenPacket(context.Background(), "udp4", fmt.Sprintf("%s:%d", s.config.IPAddress, PortHighPrio))
	if err != nil {
		return fmt.Errorf("failed to create high priority socket: %w", err)
	}
	s.highPrioSock = lp.(*net.UDPConn)

	// Setup DDC specific socket (port 1025)
	lc = createListenConfig(true)
	lp, err = lc.ListenPacket(context.Background(), "udp4", fmt.Sprintf("%s:%d", s.config.IPAddress, PortDDCSpecific))
	if err != nil {
		return fmt.Errorf("failed to create DDC specific socket: %w", err)
	}
	s.ddcSpecSock = lp.(*net.UDPConn)

	// Setup microphone socket (port 1026)
	lc = createListenConfig(true)
	lp, err = lc.ListenPacket(context.Background(), "udp4", fmt.Sprintf("%s:%d", s.config.IPAddress, PortMic))
	if err != nil {
		return fmt.Errorf("failed to create microphone socket: %w", err)
	}
	s.micSock = lp.(*net.UDPConn)

	// Setup receiver sockets (ports 1035-1042)
	for i := 0; i < s.config.NumReceivers; i++ {
		lc = createListenConfig(true)
		lp, err = lc.ListenPacket(context.Background(), "udp4", fmt.Sprintf("%s:%d", s.config.IPAddress, PortDDC0+i))
		if err != nil {
			return fmt.Errorf("failed to create receiver %d socket: %w", i, err)
		}
		s.rxSocks[i] = lp.(*net.UDPConn)
	}

	// Start threads
	threadCount := 3
	s.wg.Add(threadCount)
	go s.discoveryThread()
	go s.highPriorityThread()
	go s.ddcSpecificThread()

	if s.config.MicrophoneEnable {
		s.wg.Add(1)
		go s.microphoneThread()
	}

	if s.config.WidebandEnable {
		s.widebandSock = s.highPrioSock // Shares port 1027
		s.wg.Add(1)
		go s.widebandThread()
	}

	log.Printf("Protocol2: Started HPSDR Protocol 2 server on %s with %d receivers",
		s.config.IPAddress, s.config.NumReceivers)

	return nil
}

// Stop shuts down the Protocol 2 server
func (s *Protocol2Server) Stop() {
	close(s.stopChan)

	// Wake up all threads waiting on condition variables
	s.sendCond.Broadcast()
	s.doneSendCond.Broadcast()

	s.wg.Wait()

	// Close all sockets
	if s.discoverySock != nil {
		s.discoverySock.Close()
	}
	if s.highPrioSock != nil {
		s.highPrioSock.Close()
	}
	if s.ddcSpecSock != nil {
		s.ddcSpecSock.Close()
	}
	if s.micSock != nil {
		s.micSock.Close()
	}
	for i := 0; i < s.config.NumReceivers; i++ {
		if s.rxSocks[i] != nil {
			s.rxSocks[i].Close()
		}
	}

	log.Println("Protocol2: Server stopped")
}

// setSocketOptions sets SO_REUSEADDR and SO_REUSEPORT on a UDP socket
// If bindToInterface is true, also sets SO_BINDTODEVICE
func (s *Protocol2Server) setSocketOptions(conn *net.UDPConn, bindToInterface bool) error {
	if conn == nil {
		return nil
	}

	rawConn, err := conn.SyscallConn()
	if err != nil {
		return fmt.Errorf("failed to get raw connection: %w", err)
	}

	var bindErr error
	rawConn.Control(func(fd uintptr) {
		// Set SO_REUSEADDR
		if err := syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 1); err != nil {
			log.Printf("Protocol2: Failed to set SO_REUSEADDR: %v", err)
		}

		// Set SO_REUSEPORT (use unix package for Linux-specific constant)
		if err := syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, unix.SO_REUSEPORT, 1); err != nil {
			log.Printf("Protocol2: Failed to set SO_REUSEPORT: %v", err)
		}

		// Optionally bind to specific interface (if configured)
		// Discovery socket should NOT be bound to interface to allow broadcast reception
		if bindToInterface && s.config.Interface != "" {
			if err := syscall.SetsockoptString(int(fd), syscall.SOL_SOCKET, unix.SO_BINDTODEVICE, s.config.Interface); err != nil {
				bindErr = fmt.Errorf("failed to bind to interface %s: %w", s.config.Interface, err)
			}
		}
	})

	return bindErr
}

// convertFrequency converts a 32-bit frequency value to Hz
// If bits & 0x08 is set, uses fractional conversion with 122.88 MHz reference
func (s *Protocol2Server) convertFrequency(freqVal uint32) int64 {
	if s.bits&0x08 != 0 {
		// Fractional frequency: freq = 122.88 MHz * (freqVal / 2^32)
		freq := math.Round(122880000.0 * float64(freqVal) / 4294967296.0)
		return int64(freq)
	}
	// Direct frequency in Hz
	return int64(freqVal)
}

// adjustSampleRate adjusts sample rate for rates > 192 kHz
// Adds 100 Hz as workaround for pcmrecord issues
func adjustSampleRate(rateKHz int) int {
	if rateKHz > 192 {
		return (rateKHz * 1000) + 100
	}
	return rateKHz * 1000
}

// discoveryThread handles discovery and general packets on port 1024
func (s *Protocol2Server) discoveryThread() {
	defer s.wg.Done()
	log.Println("Protocol2: Discovery thread started")

	buffer := make([]byte, 1024)
	s.discoverySock.SetReadDeadline(time.Now().Add(100 * time.Millisecond))

	for {
		select {
		case <-s.stopChan:
			log.Println("Protocol2: Discovery thread stopped")
			return
		default:
		}

		n, addr, err := s.discoverySock.ReadFromUDP(buffer)
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				// Use longer timeout when no client connected to reduce CPU usage
				s.mu.RLock()
				hasClient := s.clientAddr != nil
				s.mu.RUnlock()

				if hasClient {
					s.discoverySock.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
				} else {
					s.discoverySock.SetReadDeadline(time.Now().Add(1 * time.Second))
				}
				continue
			}
			log.Printf("Protocol2: Discovery read error: %v", err)
			continue
		}

		// Debug: Log all packets received on port 1024
		if debugDiscovery {
			log.Printf("Protocol2: Discovery port received %d bytes from %s", n, addr)
			if n >= 5 {
				log.Printf("Protocol2: First 5 bytes: %02x %02x %02x %02x %02x",
					buffer[0], buffer[1], buffer[2], buffer[3], buffer[4])
			}
			if n >= 60 {
				log.Printf("Protocol2: Full packet hex dump:")
				for i := 0; i < n; i += 16 {
					end := i + 16
					if end > n {
						end = n
					}
					hexStr := ""
					asciiStr := ""
					for j := i; j < end; j++ {
						hexStr += fmt.Sprintf("%02x ", buffer[j])
						if buffer[j] >= 32 && buffer[j] <= 126 {
							asciiStr += string(buffer[j])
						} else {
							asciiStr += "."
						}
					}
					log.Printf("Protocol2:   %04x: %-48s %s", i, hexStr, asciiStr)
				}
			}
		}

		// Standard HPSDR Protocol 2 discovery packet: 60 bytes starting with 00 00 00 00 02
		if n == 60 && buffer[4] == 0x02 {
			if debugDiscovery {
				log.Printf("Protocol2: Identified as standard HPSDR DISCOVERY packet (byte[4]=0x02)")
			}
			s.handleDiscovery(addr)
			continue
		}

		// General packet: 60 bytes starting with 00 00 00 00 00
		if n == 60 && buffer[4] == 0x00 {
			if debugDiscovery {
				log.Printf("Protocol2: Identified as GENERAL packet (byte[4]=0x00)")
			}
			s.clientAddr = addr
			s.handleGeneralPacket(buffer[:n])
			continue
		}

		// Check for Protocol 1 (Metis) packets
		// Protocol 1 uses ef fe magic bytes
		if n >= 3 && buffer[0] == 0xef && buffer[1] == 0xfe {
			cmd := buffer[2]

			if cmd == 0x02 {
				// Discovery packet
				if debugDiscovery {
					log.Printf("Protocol2: Received HPSDR Protocol 1 discovery from %s", addr)
				}
				// Send Protocol 1 discovery response
				s.handleProtocol1Discovery(addr)
				continue
			}

			// Control/data packets - forward to Protocol 1 server if available
			if s.protocol1Server != nil {
				if debugDiscovery {
					log.Printf("Protocol2: Forwarding Protocol 1 packet (cmd=0x%02x, %d bytes) from %s to Protocol1Server", cmd, n, addr)
				}
				// Forward to Protocol 1 server's handler
				s.protocol1Server.handleControlFromDiscoveryPort(buffer[:n], addr)
				continue
			} else {
				// No Protocol 1 server available
				if debugDiscovery {
					log.Printf("Protocol2: Received Protocol 1 control/data packet (cmd=0x%02x) but no Protocol1Server available", cmd)
				}
				continue
			}
		}

		// Unknown packet format
		if debugDiscovery {
			log.Printf("Protocol2: Unknown packet format: %d bytes, byte[4]=0x%02x", n, buffer[4])
		}
	}
}

// handleDiscovery sends discovery response
// Standard HPSDR Protocol 2 format with Hermes-Lite2 extensions
func (s *Protocol2Server) handleDiscovery(addr *net.UDPAddr) {
	response := make([]byte, 60)

	// Bytes 0-3: zeros
	// Byte 4: 0x02 (not running) or 0x03 (running)
	s.mu.RLock()
	if s.running {
		response[4] = 0x03
	} else {
		response[4] = 0x02
	}
	s.mu.RUnlock()

	// Bytes 5-10: MAC address
	copy(response[5:11], s.config.MACAddress)

	// Byte 11: Device type (0x06 = HermesLite)
	response[11] = s.config.DeviceType

	// Byte 12: Firmware version (VERSION_MAJOR)
	response[12] = FirmwareVersion

	// Byte 13: Protocol version (VERSION_MINOR)
	response[13] = ProtocolVersion

	// Bytes 14-19: Reserved/zeros

	// Byte 20: Number of receivers
	response[20] = byte(s.config.NumReceivers)

	// Byte 21: Board ID with bandscope bits
	// Format: {BANDSCOPE_BITS[1:0], BOARD[5:0]}
	// BANDSCOPE_BITS = 0x01, BOARD = 5 -> 0x45
	response[21] = 0x45

	// Byte 22: Protocol info
	response[22] = 3

	// Bytes 23-59: zeros

	s.discoverySock.WriteToUDP(response, addr)
	log.Printf("Protocol2: Discovery response sent to %s (FW=%d.%d, Board=0x%02x, Receivers=%d)",
		addr, FirmwareVersion, ProtocolVersion, response[21], s.config.NumReceivers)

	if debugDiscovery {
		log.Printf("Protocol2: Discovery response details:")
		log.Printf("Protocol2:   Status: 0x%02x (%s)", response[4],
			func() string {
				if response[4] == 0x03 {
					return "running"
				}
				return "not running"
			}())
		log.Printf("Protocol2:   MAC: %02x:%02x:%02x:%02x:%02x:%02x",
			response[5], response[6], response[7], response[8], response[9], response[10])
		log.Printf("Protocol2:   Device Type: 0x%02x", response[11])
		log.Printf("Protocol2:   Firmware: %d", response[12])
		log.Printf("Protocol2:   Protocol: %d", response[13])
		log.Printf("Protocol2:   Receivers: %d", response[20])
		log.Printf("Protocol2:   Board ID: 0x%02x", response[21])
		log.Printf("Protocol2:   Protocol Info: %d", response[22])
		log.Printf("Protocol2: Full response hex dump:")
		for i := 0; i < 60; i += 16 {
			end := i + 16
			if end > 60 {
				end = 60
			}
			hexStr := ""
			for j := i; j < end; j++ {
				hexStr += fmt.Sprintf("%02x ", response[j])
			}
			log.Printf("Protocol2:   %04x: %s", i, hexStr)
		}
	}
}

// handleGeneralPacket processes general packet (starts radio)
func (s *Protocol2Server) handleGeneralPacket(buffer []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Mark that general packet was received
	s.genReceived = true

	if !s.running {
		s.running = true
		log.Printf("Protocol2: Radio started by client %s", s.clientAddr)

		// Start receiver threads
		for i := 0; i < s.config.NumReceivers; i++ {
			s.wg.Add(1)
			go s.receiverThread(i)
		}
	}

	// Parse wideband configuration
	if s.config.WidebandEnable && len(buffer) >= 29 {
		s.wbEnable = (buffer[23] & 0x01) != 0
		s.wbLength = int(binary.BigEndian.Uint16(buffer[24:26]))
		s.wbSize = int(buffer[26])
		s.wbRate = int(buffer[27])
		s.wbPPF = int(buffer[28])
		log.Printf("Protocol2: Wideband config - enable=%v len=%d size=%d rate=%d ppf=%d",
			s.wbEnable, s.wbLength, s.wbSize, s.wbRate, s.wbPPF)
	}
}

// handleProtocol1Discovery sends Protocol 1 (Metis) discovery response
// This allows SDR Console to see the device, even though full Protocol 1 data streaming isn't implemented
func (s *Protocol2Server) handleProtocol1Discovery(addr *net.UDPAddr) {
	response := make([]byte, 60)

	// Bytes 0-1: Protocol 1 magic bytes
	response[0] = 0xef
	response[1] = 0xfe

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

	// Byte 9: Device type (use same as Protocol 2)
	response[9] = s.config.DeviceType

	// Byte 10: Code version (firmware version)
	response[10] = FirmwareVersion

	// Bytes 11-59: Reserved/zeros

	s.discoverySock.WriteToUDP(response, addr)
	if s.protocol1Server != nil {
		log.Printf("Protocol2: Protocol 1 discovery response sent to %s (Device=0x%02x, FW=%d) - full Protocol 1 support active",
			addr, s.config.DeviceType, FirmwareVersion)
	} else {
		log.Printf("Protocol2: Protocol 1 discovery response sent to %s (Device=0x%02x, FW=%d) - discovery only",
			addr, s.config.DeviceType, FirmwareVersion)
	}

	if debugDiscovery {
		log.Printf("Protocol2: Protocol 1 discovery response details:")
		log.Printf("Protocol2:   Magic: ef fe")
		log.Printf("Protocol2:   Status: 0x%02x (%s)", response[2],
			func() string {
				if response[2] == 0x03 {
					return "running"
				}
				return "not running"
			}())
		log.Printf("Protocol2:   MAC: %02x:%02x:%02x:%02x:%02x:%02x",
			response[3], response[4], response[5], response[6], response[7], response[8])
		log.Printf("Protocol2:   Device Type: 0x%02x", response[9])
		log.Printf("Protocol2:   Firmware: %d", response[10])
		log.Printf("Protocol2: Full response hex dump:")
		for i := 0; i < 60; i += 16 {
			end := i + 16
			if end > 60 {
				end = 60
			}
			hexStr := ""
			for j := i; j < end; j++ {
				hexStr += fmt.Sprintf("%02x ", response[j])
			}
			log.Printf("Protocol2:   %04x: %s", i, hexStr)
		}
	}
}

// highPriorityThread handles high priority control packets on port 1027
func (s *Protocol2Server) highPriorityThread() {
	defer s.wg.Done()
	log.Println("Protocol2: High priority thread started")

	buffer := make([]byte, 1444)
	s.highPrioSock.SetReadDeadline(time.Now().Add(10 * time.Millisecond))

	var seqNum uint32

	for {
		select {
		case <-s.stopChan:
			log.Println("Protocol2: High priority thread stopped")
			return
		default:
		}

		n, _, err := s.highPrioSock.ReadFromUDP(buffer)
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				// Use longer timeout when not running to reduce CPU usage
				s.mu.RLock()
				running := s.running
				s.mu.RUnlock()

				if running {
					s.highPrioSock.SetReadDeadline(time.Now().Add(10 * time.Millisecond))
				} else {
					s.highPrioSock.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
				}
				continue
			}
			continue
		}

		if n != 1444 {
			continue
		}

		// Update last activity timestamp for all receivers (high priority packets affect all)
		now := time.Now()
		for i := 0; i < s.config.NumReceivers; i++ {
			s.receivers[i].mu.Lock()
			s.receivers[i].lastActivity = now
			s.receivers[i].mu.Unlock()
		}

		// Parse sequence number
		newSeqNum := binary.BigEndian.Uint32(buffer[0:4])
		if seqNum != 0 && newSeqNum != seqNum+1 {
			log.Printf("Protocol2: HP sequence error, old=%d new=%d", seqNum, newSeqNum)
		}
		seqNum = newSeqNum

		// Parse running flag
		running := (buffer[4] & 0x01) != 0
		s.mu.Lock()
		if running != s.running {
			s.running = running
			if running {
				log.Printf("Protocol2: Running = true (client connected)")
			} else {
				log.Printf("Protocol2: Running = false (client disconnected)")
			}
			if !running {
				// Reset all receivers
				for i := 0; i < s.config.NumReceivers; i++ {
					s.receivers[i].enabled = false
					s.receivers[i].frequency = 0
					s.receivers[i].sampleRate = 0
				}
			}
		}
		s.mu.Unlock()

		// Parse ADC settings
		s.adcDither = (buffer[5] & 0x01) != 0
		s.adcRandom = (buffer[6] & 0x01) != 0
		s.stepAtt0 = int(buffer[1443])

		// Parse DDC frequencies
		// Standard HPSDR: bytes 9-40 (8 receivers × 4 bytes, receivers 0-7)
		// Hermes-Lite2 extension: bytes 41-48 (2 receivers × 4 bytes, receivers 8-9)
		for i := 0; i < s.config.NumReceivers && i < 8; i++ {
			offset := 9 + (i * 4)
			freqVal := binary.BigEndian.Uint32(buffer[offset : offset+4])

			// Convert to Hz using fractional conversion if needed
			freq := s.convertFrequency(freqVal)

			if s.receivers[i].frequency != freq {
				s.receivers[i].mu.Lock()
				s.receivers[i].frequency = freq
				s.receivers[i].mu.Unlock()
				// log.Printf("Protocol2: DDC%d frequency = %d Hz", i, freq)
			}
		}

		// Hermes-Lite2 extension: Parse receivers 8-9 from bytes 41-48
		// This maintains backwards compatibility - standard 8-receiver clients won't send this data
		if s.config.NumReceivers > 8 && len(buffer) >= 49 {
			for i := 8; i < s.config.NumReceivers && i < 10; i++ {
				offset := 41 + ((i - 8) * 4)
				freqVal := binary.BigEndian.Uint32(buffer[offset : offset+4])

				// Convert to Hz using fractional conversion if needed
				freq := s.convertFrequency(freqVal)

				if s.receivers[i].frequency != freq {
					s.receivers[i].mu.Lock()
					s.receivers[i].frequency = freq
					s.receivers[i].mu.Unlock()
					// log.Printf("Protocol2: DDC%d frequency = %d Hz (HL2 extension)", i, freq)
				}
			}
		}
	}
}

// ddcSpecificThread handles DDC-specific configuration on port 1025
func (s *Protocol2Server) ddcSpecificThread() {
	defer s.wg.Done()
	log.Println("Protocol2: DDC specific thread started")

	buffer := make([]byte, 1444)
	s.ddcSpecSock.SetReadDeadline(time.Now().Add(10 * time.Millisecond))

	var seqNum uint32

	for {
		select {
		case <-s.stopChan:
			log.Println("Protocol2: DDC specific thread stopped")
			return
		default:
		}

		s.mu.RLock()
		running := s.running
		s.mu.RUnlock()

		if !running {
			time.Sleep(100 * time.Millisecond)
			seqNum = 0
			continue
		}

		n, _, err := s.ddcSpecSock.ReadFromUDP(buffer)
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				s.ddcSpecSock.SetReadDeadline(time.Now().Add(10 * time.Millisecond))
				continue
			}
			continue
		}

		if n != 1444 {
			continue
		}

		// Update last activity timestamp for all receivers (DDC specific packets affect all)
		now := time.Now()
		for i := 0; i < s.config.NumReceivers; i++ {
			s.receivers[i].mu.Lock()
			s.receivers[i].lastActivity = now
			s.receivers[i].mu.Unlock()
		}

		// Parse sequence number
		newSeqNum := binary.BigEndian.Uint32(buffer[0:4])
		if seqNum != 0 && newSeqNum != seqNum+1 {
			log.Printf("Protocol2: DDC spec sequence error, old=%d new=%d", seqNum, newSeqNum)
		}
		seqNum = newSeqNum

		// Parse DDC enable bits (bytes 7-8, 1 bit per receiver)
		for i := 0; i < s.config.NumReceivers; i++ {
			byteIdx := 7 + (i / 8)
			bitIdx := i % 8
			enabled := (buffer[byteIdx]>>uint(bitIdx))&0x01 != 0

			// Parse sample rate (bytes 18 + i*6, 2 bytes)
			rateOffset := 18 + (i * 6)
			sampleRate := int(binary.BigEndian.Uint16(buffer[rateOffset : rateOffset+2]))

			// Clamp sample rate to maximum of 192 kHz
			// HPSDR clients may request 384, 768, or 1536 kHz, but we limit to 192 kHz
			if sampleRate > 192 {
				log.Printf("Protocol2: DDC%d requested %d kHz, clamping to 192 kHz maximum", i, sampleRate)
				sampleRate = 192
			}

			s.receivers[i].mu.Lock()
			modified := false

			if sampleRate != 0 && sampleRate != s.receivers[i].sampleRate {
				s.receivers[i].sampleRate = sampleRate
				s.receivers[i].scale = getSampleRateScale(sampleRate)
				modified = true
			}

			if enabled != s.receivers[i].enabled {
				s.receivers[i].enabled = enabled
				modified = true

				if enabled {
					// Signal that this receiver is ready
					s.sendMu.Lock()
					s.sendFlags |= s.receivers[i].receiverMask
					s.sendCond.Broadcast()
					s.sendMu.Unlock()
				}
			}

			if modified {
				log.Printf("Protocol2: DDC%d Enable=%v Rate=%d kHz", i, enabled, sampleRate)
			}

			s.receivers[i].mu.Unlock()
		}
	}
}

// getSampleRateScale returns the scaling factor for a given sample rate
func getSampleRateScale(rateKHz int) float32 {
	switch rateKHz {
	case 48:
		return 8000.0
	case 96:
		return 6000.0
	case 192:
		return 4000.0
	case 384:
		return 3000.0
	case 768:
		return 1700.0
	case 1536:
		return 1000.0
	default:
		return 4000.0
	}
}

// receiverThread sends IQ data for a specific receiver
func (s *Protocol2Server) receiverThread(receiverNum int) {
	defer s.wg.Done()
	log.Printf("Protocol2: Receiver %d thread started", receiverNum)

	rcv := s.receivers[receiverNum]
	buffer := make([]byte, 1444)
	var packetCount uint64

	for {
		select {
		case <-s.stopChan:
			log.Printf("Protocol2: Receiver %d thread stopped", receiverNum)
			return
		default:
		}

		rcv.mu.Lock()
		enabled := rcv.enabled
		sampleRate := rcv.sampleRate
		frequency := rcv.frequency
		rcv.mu.Unlock()

		s.mu.RLock()
		running := s.running
		genReceived := s.genReceived
		clientAddr := s.clientAddr
		s.mu.RUnlock()

		if !genReceived || !running || !enabled || sampleRate == 0 || frequency == 0 || clientAddr == nil {
			time.Sleep(50 * time.Millisecond)
			rcv.seqNum = 0
			packetCount = 0
			continue
		}

		// Wait for IQ data to be ready BEFORE building packet
		s.sendMu.Lock()
		for (s.sendFlags & rcv.receiverMask) == 0 {
			// Check if we should stop before waiting
			select {
			case <-s.stopChan:
				s.sendMu.Unlock()
				log.Printf("Protocol2: Receiver %d thread stopped (in wait)", receiverNum)
				return
			default:
			}
			s.sendCond.Wait()
		}
		s.sendFlags &= ^rcv.receiverMask
		s.sendMu.Unlock()

		// Build packet header with current sequence number
		binary.BigEndian.PutUint32(buffer[0:4], rcv.seqNum)

		// Timestamp (9 bytes) - currently zeros
		for i := 4; i < 13; i++ {
			buffer[i] = 0
		}

		// Bits per sample
		buffer[13] = BitsPerSample
		buffer[14] = 0
		buffer[15] = SamplesPerPacket

		// Copy IQ data (this would come from actual IQ source)
		// For now, copy from packet buffer (populated by loadPacket)
		copy(buffer[16:], rcv.packetBuf[:])

		// Send packet
		_, err := s.rxSocks[receiverNum].WriteToUDP(buffer, clientAddr)
		if err != nil {
			log.Printf("Protocol2: Receiver %d send error: %v", receiverNum, err)
			// Don't increment sequence number on error
			continue
		}

		// Debug logging for sequence numbers (enable with HPSDR_DEBUG_SEQ=1)
		if debugSeqNum && packetCount%100 == 0 {
			log.Printf("Protocol2: DDC%d sent seq=%d (packet #%d)", receiverNum, rcv.seqNum, packetCount)
		}

		// Increment sequence number AFTER successful send
		rcv.seqNum++
		packetCount++

		// Signal completion
		s.doneSendMu.Lock()
		s.doneSendFlags |= rcv.receiverMask
		s.doneSendCond.Broadcast()
		s.doneSendMu.Unlock()
	}
}

// LoadIQData loads IQ samples into a receiver's buffer and prepares packet
// This should be called by the IQ data source (e.g., from multicast stream)
func (s *Protocol2Server) LoadIQData(receiverNum int, samples []complex64) error {
	if receiverNum < 0 || receiverNum >= s.config.NumReceivers {
		return fmt.Errorf("invalid receiver number: %d", receiverNum)
	}

	if len(samples) != SamplesPerPacket {
		return fmt.Errorf("expected %d samples, got %d", SamplesPerPacket, len(samples))
	}

	rcv := s.receivers[receiverNum]

	// Wait for previous packet to be sent
	s.doneSendMu.Lock()
	for (s.doneSendFlags & rcv.receiverMask) == 0 {
		// Check if we should stop before waiting
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

	// Convert samples to 24-bit IQ format
	rcv.mu.Lock()
	scale := rcv.scale
	rcv.mu.Unlock()

	for i := 0; i < SamplesPerPacket; i++ {
		// Extract I and Q components from complex sample
		// complex64 in Go: real(z) = I (in-phase), imag(z) = Q (quadrature)
		iVal := int32(real(samples[i]) * scale)
		qVal := int32(imag(samples[i]) * scale)

		// Pack as 24-bit big-endian in HPSDR format (Q first, then I)
		// This matches ka9q_hpsdr.c load_packet() function:
		//   IQData = (int)cimagf(out_buf[i]);  // Q (imaginary)
		//   pbuf[k][j] = IQData >> 16; ... (3 bytes for Q)
		//   IQData = (int)crealf(out_buf[i]);  // I (real)
		//   pbuf[k][j+3] = IQData >> 16; ... (3 bytes for I)
		offset := i * 6
		rcv.packetBuf[offset+0] = byte(qVal >> 16)
		rcv.packetBuf[offset+1] = byte(qVal >> 8)
		rcv.packetBuf[offset+2] = byte(qVal)
		rcv.packetBuf[offset+3] = byte(iVal >> 16)
		rcv.packetBuf[offset+4] = byte(iVal >> 8)
		rcv.packetBuf[offset+5] = byte(iVal)
	}

	// Signal that data is ready
	s.sendMu.Lock()
	s.sendFlags |= rcv.receiverMask
	s.sendCond.Broadcast()
	s.sendMu.Unlock()

	return nil
}

// microphoneThread sends microphone audio (silence) on port 1026
func (s *Protocol2Server) microphoneThread() {
	defer s.wg.Done()
	log.Println("Protocol2: Microphone thread started")

	buffer := make([]byte, 132)
	var seqNum uint32

	for {
		select {
		case <-s.stopChan:
			log.Println("Protocol2: Microphone thread stopped")
			return
		default:
		}

		s.mu.RLock()
		running := s.running
		genReceived := s.genReceived
		clientAddr := s.clientAddr
		s.mu.RUnlock()

		if !genReceived || !running || clientAddr == nil {
			seqNum = 0
			// Sleep longer when no client connected to reduce CPU usage
			time.Sleep(100 * time.Millisecond)
			continue
		}

		// Client is connected - use fast ticker
		ticker := time.NewTicker(1333333 * time.Nanosecond) // 1.333ms (64 samples at 48kHz)

		for {
			select {
			case <-s.stopChan:
				ticker.Stop()
				log.Println("Protocol2: Microphone thread stopped")
				return
			case <-ticker.C:
			}

			s.mu.RLock()
			running := s.running
			genReceived := s.genReceived
			clientAddr := s.clientAddr
			s.mu.RUnlock()

			if !genReceived || !running || clientAddr == nil {
				ticker.Stop()
				seqNum = 0
				break // Break inner loop to go back to idle sleep
			}

			// Build packet (all zeros = silence)
			binary.BigEndian.PutUint32(buffer[0:4], seqNum)
			seqNum++

			// Send packet
			s.micSock.WriteToUDP(buffer, clientAddr)
		}
	}
}

// widebandThread sends wideband spectrum data on port 1027
func (s *Protocol2Server) widebandThread() {
	defer s.wg.Done()
	log.Println("Protocol2: Wideband thread started")

	buffer := make([]byte, 1028)

	for {
		select {
		case <-s.stopChan:
			log.Println("Protocol2: Wideband thread stopped")
			return
		default:
		}

		s.mu.RLock()
		running := s.running
		genReceived := s.genReceived
		wbEnable := s.wbEnable
		clientAddr := s.clientAddr
		s.mu.RUnlock()

		if !genReceived || !running || !wbEnable || clientAddr == nil {
			time.Sleep(50 * time.Millisecond)
			continue
		}

		// TODO: Read wideband data from source (e.g., /dev/shm/rx888wb.bin)
		// For now, send zeros
		var seqNum uint32
		for frame := 0; frame < 32; frame++ {
			binary.BigEndian.PutUint32(buffer[0:4], seqNum)
			seqNum++

			// Wideband data would go in buffer[4:1028]
			// Currently sending zeros
			// In production, read 32768 bytes and send in 32 packets of 1024 bytes each
			// with byte-swapping: buffer[j+5] = samples[j], buffer[j+4] = samples[j+1]

			s.widebandSock.WriteToUDP(buffer, clientAddr)
		}

		time.Sleep(66 * time.Millisecond) // ~15 fps
	}
}

// GetReceiverState returns the current state of a receiver
func (s *Protocol2Server) GetReceiverState(receiverNum int) (enabled bool, frequency int64, sampleRate int, err error) {
	if receiverNum < 0 || receiverNum >= s.config.NumReceivers {
		return false, 0, 0, fmt.Errorf("invalid receiver number: %d", receiverNum)
	}

	rcv := s.receivers[receiverNum]
	rcv.mu.Lock()
	defer rcv.mu.Unlock()

	return rcv.enabled, rcv.frequency, rcv.sampleRate, nil
}

// IsRunning returns whether the radio is running
func (s *Protocol2Server) IsRunning() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.running
}

// GetReceiverLastActivity returns the last activity time for a receiver
func (s *Protocol2Server) GetReceiverLastActivity(receiverNum int) (time.Time, error) {
	if receiverNum < 0 || receiverNum >= s.config.NumReceivers {
		return time.Time{}, fmt.Errorf("invalid receiver number: %d", receiverNum)
	}

	rcv := s.receivers[receiverNum]
	rcv.mu.Lock()
	defer rcv.mu.Unlock()

	return rcv.lastActivity, nil
}

// GetClientAddr returns the current HPSDR client address
func (s *Protocol2Server) GetClientAddr() *net.UDPAddr {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.clientAddr
}

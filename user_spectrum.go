package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"log"
	"math"
	"net"
	"sync"
	"syscall"
	"time"

	"golang.org/x/net/ipv4"
)

const SO_REUSEPORT = 15 // Linux SO_REUSEPORT constant

// UserSpectrumManager manages per-user spectrum data polling
type UserSpectrumManager struct {
	radiod   *RadiodController
	config   *Config
	sessions *SessionManager

	// Status group listener (shared across all users)
	statusConn *net.UDPConn
	statusAddr *net.UDPAddr

	// Control
	running      bool
	stopChan     chan struct{}
	wg           sync.WaitGroup
	pollInterval time.Duration
}

// NewUserSpectrumManager creates a new per-user spectrum manager
func NewUserSpectrumManager(radiod *RadiodController, config *Config, sessions *SessionManager) (*UserSpectrumManager, error) {
	// Parse status multicast address
	statusAddr, err := net.ResolveUDPAddr("udp", config.Radiod.StatusGroup)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve status address: %w", err)
	}

	usm := &UserSpectrumManager{
		radiod:       radiod,
		config:       config,
		sessions:     sessions,
		statusAddr:   statusAddr,
		stopChan:     make(chan struct{}),
		pollInterval: time.Duration(config.Spectrum.PollPeriodMs) * time.Millisecond,
	}

	return usm, nil
}

// Start initializes the user spectrum manager and begins polling
func (usm *UserSpectrumManager) Start() error {
	usm.running = true

	if usm.config.Spectrum.Enabled {
		// Set up status group listener
		if err := usm.setupStatusListener(); err != nil {
			return fmt.Errorf("failed to setup status listener: %w", err)
		}

		// Start polling loop
		usm.wg.Add(1)
		go usm.pollLoop()

		log.Printf("User spectrum manager started (poll interval: %v)", usm.pollInterval)
	} else {
		log.Printf("User spectrum manager disabled in config")
	}

	return nil
}

// Stop shuts down the user spectrum manager
func (usm *UserSpectrumManager) Stop() {
	if !usm.running {
		return
	}
	usm.running = false

	// Signal stop
	close(usm.stopChan)

	// Wait for polling loop to finish
	usm.wg.Wait()

	// Close status listener
	if usm.statusConn != nil {
		usm.statusConn.Close()
	}

	log.Println("User spectrum manager stopped")
}

// setupStatusListener creates a UDP listener for STATUS packets
func (usm *UserSpectrumManager) setupStatusListener() error {
	// Create UDP connection with SO_REUSEPORT
	lc := net.ListenConfig{
		Control: func(network, address string, c syscall.RawConn) error {
			var sockErr error
			err := c.Control(func(fd uintptr) {
				if err := syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, SO_REUSEPORT, 1); err != nil {
					sockErr = fmt.Errorf("failed to set SO_REUSEPORT: %w", err)
				}
			})
			if err != nil {
				return err
			}
			return sockErr
		},
	}

	conn, err := lc.ListenPacket(context.Background(), "udp4", fmt.Sprintf(":%d", usm.statusAddr.Port))
	if err != nil {
		return fmt.Errorf("failed to create status listener: %w", err)
	}

	udpConn := conn.(*net.UDPConn)

	// Join multicast group
	if usm.statusAddr.IP.IsMulticast() {
		iface := usm.radiod.GetInterface()
		p := ipv4.NewPacketConn(udpConn)
		if err := p.JoinGroup(iface, usm.statusAddr); err != nil {
			conn.Close()
			return fmt.Errorf("failed to join status multicast group: %w", err)
		}
	}

	usm.statusConn = udpConn
	log.Printf("User spectrum status listener created on %s", usm.statusAddr)
	return nil
}

// pollLoop periodically polls radiod for spectrum data from all active spectrum sessions
func (usm *UserSpectrumManager) pollLoop() {
	defer usm.wg.Done()

	ticker := time.NewTicker(usm.pollInterval)
	defer ticker.Stop()

	// Start receiver goroutine
	usm.wg.Add(1)
	go usm.receiveLoop()

	for {
		select {
		case <-usm.stopChan:
			return
		case <-ticker.C:
			// Poll all active spectrum sessions
			usm.pollAllSpectrumSessions()
		}
	}
}

// pollAllSpectrumSessions sends poll commands for all active spectrum sessions
func (usm *UserSpectrumManager) pollAllSpectrumSessions() {
	// Get all sessions (need to iterate safely)
	usm.sessions.mu.RLock()
	spectrumSSRCs := make([]uint32, 0)
	for _, session := range usm.sessions.sessions {
		if session.IsSpectrum {
			spectrumSSRCs = append(spectrumSSRCs, session.SSRC)
		}
	}
	usm.sessions.mu.RUnlock()

	// Send poll for each spectrum session
	for _, ssrc := range spectrumSSRCs {
		if err := usm.sendPoll(ssrc); err != nil {
			log.Printf("ERROR: Failed to send spectrum poll for SSRC 0x%08x: %v", ssrc, err)
		}
	}
}

// sendPoll sends a poll command to request spectrum data for a specific SSRC
func (usm *UserSpectrumManager) sendPoll(ssrc uint32) error {
	buf := make([]byte, 0, 256)
	buf = append(buf, 1)                                     // CMD packet type
	buf = encodeInt32(&buf, 0x12, ssrc)                      // OUTPUT_SSRC
	buf = encodeInt32(&buf, 0x01, uint32(time.Now().Unix())) // COMMAND_TAG
	buf = append(buf, 0)                                     // EOL

	return usm.radiod.sendCommand(buf)
}

// receiveLoop receives and processes STATUS packets
func (usm *UserSpectrumManager) receiveLoop() {
	defer usm.wg.Done()

	buffer := make([]byte, 65536)
	packetCount := 0

	for {
		select {
		case <-usm.stopChan:
			return
		default:
		}

		// Set read deadline to allow checking stopChan
		usm.statusConn.SetReadDeadline(time.Now().Add(100 * time.Millisecond))

		n, _, err := usm.statusConn.ReadFromUDP(buffer)
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				continue
			}
			log.Printf("ERROR: Failed to read STATUS packet: %v", err)
			continue
		}

		if n < 2 || buffer[0] != 0 { // STATUS = 0
			// Skip non-STATUS packets silently
			continue
		}

		packetCount++
		if DebugMode && packetCount%100 == 1 {
			log.Printf("DEBUG: Received STATUS packet #%d (%d bytes)", packetCount, n)
		}

		// Parse STATUS packet
		usm.parseStatusPacket(buffer[1:n])
	}
}

// parseStatusPacket extracts spectrum data and channel parameters from a STATUS packet
func (usm *UserSpectrumManager) parseStatusPacket(payload []byte) {
	var ssrc uint32
	var binData []float32
	var radiodBinBW float32
	var radiodBinCount int
	var radiodFreq uint64
	var radiodLowEdge float32
	var radiodHighEdge float32
	foundSSRC := false
	foundBinData := false
	foundBinBW := false
	foundBinCount := false
	foundFreq := false
	foundLowEdge := false
	foundHighEdge := false

	i := 0
	for i < len(payload) {
		if i+1 >= len(payload) {
			break
		}

		tag := payload[i]
		i++

		if tag == 0 {
			break // EOL
		}

		length := int(payload[i])
		i++

		// Handle extended length encoding
		if length >= 128 {
			lengthOfLength := length & 0x7f
			length = 0
			for j := 0; j < lengthOfLength && i < len(payload); j++ {
				length = (length << 8) | int(payload[i])
				i++
			}
		}

		if i+length > len(payload) {
			break
		}

		switch tag {
		case 0x12: // OUTPUT_SSRC
			ssrc = 0
			for j := 0; j < length && j < 8; j++ {
				ssrc = (ssrc << 8) | uint32(payload[i+j])
			}
			foundSSRC = true

		case 0x5d: // NONCOHERENT_BIN_BW (float32)
			if length == 4 {
				bits := binary.BigEndian.Uint32(payload[i : i+4])
				radiodBinBW = math.Float32frombits(bits)
				foundBinBW = true
			}

		case 0x5e: // BIN_COUNT (int32)
			radiodBinCount = 0
			for j := 0; j < length && j < 8; j++ {
				radiodBinCount = (radiodBinCount << 8) | int(payload[i+j])
			}
			foundBinCount = true

		case 0x21: // RADIO_FREQUENCY (double)
			if length <= 8 {
				bits := uint64(0)
				for j := 0; j < length; j++ {
					bits = (bits << 8) | uint64(payload[i+j])
				}
				// Shift left to fill 64 bits if needed
				for j := length; j < 8; j++ {
					bits <<= 8
				}
				radiodFreq = uint64(math.Float64frombits(bits))
				foundFreq = true
			}

		case 0x27: // LOW_EDGE (float32)
			if length == 4 {
				bits := binary.BigEndian.Uint32(payload[i : i+4])
				radiodLowEdge = math.Float32frombits(bits)
				foundLowEdge = true
			}

		case 0x28: // HIGH_EDGE (float32)
			if length == 4 {
				bits := binary.BigEndian.Uint32(payload[i : i+4])
				radiodHighEdge = math.Float32frombits(bits)
				foundHighEdge = true
			}

		case 0x60: // BIN_DATA (large length means bin data array)
			if length > 100 {
				numBins := length / 4
				binData = make([]float32, numBins)

				// Parse power values and convert to dB
				for j := 0; j < numBins; j++ {
					bits := binary.BigEndian.Uint32(payload[i+j*4 : i+j*4+4])
					power := math.Float32frombits(bits)

					// Convert power to dB (same as test_spectrum does)
					if power > 0 {
						binData[j] = 10.0 * float32(math.Log10(float64(power)))
					} else {
						binData[j] = -120.0 // Noise floor
					}

					// Apply gain adjustment from config
					binData[j] += float32(usm.config.Spectrum.GainDB)
				}
				foundBinData = true

				if DebugMode {
					// Calculate min/max/avg of dB values
					min, max, sum := float32(999), float32(-999), float32(0)
					for _, v := range binData {
						if v < min {
							min = v
						}
						if v > max {
							max = v
						}
						sum += v
					}
					// Removed debug logging
				}
			}

		case 0x8E: // BIN_DATA (alternate tag)
			numBins := length / 4
			binData = make([]float32, numBins)

			// Parse power values and convert to dB
			for j := 0; j < numBins; j++ {
				bits := binary.BigEndian.Uint32(payload[i+j*4 : i+j*4+4])
				power := math.Float32frombits(bits)

				// Convert power to dB (same as test_spectrum does)
				if power > 0 {
					binData[j] = 10.0 * float32(math.Log10(float64(power)))
				} else {
					binData[j] = -120.0 // Noise floor
				}

				// Apply gain adjustment from config
				binData[j] += float32(usm.config.Spectrum.GainDB)
			}
			foundBinData = true

			if DebugMode {
				// Calculate min/max/avg of dB values
				min, max, sum := float32(999), float32(-999), float32(0)
				for _, v := range binData {
					if v < min {
						min = v
					}
					if v > max {
						max = v
					}
					sum += v
				}
				// Removed debug logging
			}
		}

		i += length
	}

	// Handle spectrum channels
	if foundSSRC && foundBinData {
		// Check for parameter mismatches (with rate limiting to avoid log spam)
		if foundBinBW && foundBinCount {
			usm.checkSpectrumParameterMismatch(ssrc, radiodBinBW, radiodBinCount)
		}
		usm.distributeSpectrum(ssrc, binData)
	} else if foundSSRC {
		// Handle audio channels (no bin data, but has frequency and filter edges)
		if foundFreq && foundLowEdge && foundHighEdge {
			usm.checkAudioParameterMismatch(ssrc, radiodFreq, radiodLowEdge, radiodHighEdge)
		}
	} else if DebugMode {
		if !foundSSRC {
			log.Printf("DEBUG: No SSRC found in STATUS packet")
		}
	}
}

// Track last mismatch log and retry time per SSRC
var (
	lastMismatchLog   = make(map[uint32]time.Time)
	lastRetryTime     = make(map[uint32]time.Time)
	mismatchMutex     sync.Mutex
	mismatchLogPeriod = 30 * time.Second // Only log once per 30 seconds per SSRC
	retryPeriod       = 1 * time.Second  // Only retry once per second per SSRC
)

// checkSpectrumParameterMismatch compares radiod's actual spectrum parameters with our session state
// and automatically retries the update if they don't match (rate-limited to avoid spam)
func (usm *UserSpectrumManager) checkSpectrumParameterMismatch(ssrc uint32, radiodBinBW float32, radiodBinCount int) {
	session, ok := usm.sessions.GetSessionBySSRC(ssrc)
	if !ok {
		return
	}

	if !session.IsSpectrum {
		return
	}

	session.mu.RLock()
	sessionFreq := session.Frequency
	sessionBinBW := float32(session.BinBandwidth)
	sessionBinCount := session.BinCount
	session.mu.RUnlock()

	// Check if parameters match (with small tolerance for floating point comparison)
	const tolerance = 0.01
	binBWMatch := math.Abs(float64(radiodBinBW-sessionBinBW)) < tolerance
	binCountMatch := radiodBinCount == sessionBinCount

	if !binBWMatch || !binCountMatch {
		now := time.Now()
		
		mismatchMutex.Lock()
		lastLog, logExists := lastMismatchLog[ssrc]
		lastRetry, retryExists := lastRetryTime[ssrc]
		
		// Determine if we should log
		shouldLog := !logExists || now.Sub(lastLog) > mismatchLogPeriod
		
		// Determine if we should retry (once per second)
		shouldRetry := !retryExists || now.Sub(lastRetry) > retryPeriod
		
		if shouldLog {
			lastMismatchLog[ssrc] = now
		}
		if shouldRetry {
			lastRetryTime[ssrc] = now
		}
		mismatchMutex.Unlock()

		if shouldLog {
			log.Printf("INFO: Parameter mismatch for SSRC 0x%08x - Session: bins=%d bw=%.1f Hz, Radiod: bins=%d bw=%.1f Hz",
				ssrc, sessionBinCount, sessionBinBW, radiodBinCount, radiodBinBW)
		}

		// Automatically retry sending the update command
		if shouldRetry {
			log.Printf("INFO: Retrying spectrum update for SSRC 0x%08x to correct mismatch", ssrc)
			
			// Determine if bin count changed (compare with radiod's current value)
			binCountChanged := sessionBinCount != radiodBinCount
			
			if err := usm.radiod.UpdateSpectrumChannel(ssrc, sessionFreq, float64(sessionBinBW), sessionBinCount, binCountChanged); err != nil {
				log.Printf("ERROR: Failed to retry spectrum update for SSRC 0x%08x: %v", ssrc, err)
			}
		}
	}
}

// checkAudioParameterMismatch compares radiod's actual audio channel parameters with our session state
// and automatically retries the update if they don't match (rate-limited to avoid spam)
func (usm *UserSpectrumManager) checkAudioParameterMismatch(ssrc uint32, radiodFreq uint64, radiodLowEdge, radiodHighEdge float32) {
	session, ok := usm.sessions.GetSessionBySSRC(ssrc)
	if !ok {
		return
	}

	if session.IsSpectrum {
		return // This is a spectrum channel, not audio
	}

	session.mu.RLock()
	sessionFreq := session.Frequency
	sessionMode := session.Mode
	sessionLowEdge := float32(session.BandwidthLow)
	sessionHighEdge := float32(session.BandwidthHigh)
	session.mu.RUnlock()

	// Check if parameters match (with small tolerance for floating point comparison)
	const tolerance = 0.01
	freqMatch := sessionFreq == radiodFreq
	lowEdgeMatch := math.Abs(float64(radiodLowEdge-sessionLowEdge)) < tolerance
	highEdgeMatch := math.Abs(float64(radiodHighEdge-sessionHighEdge)) < tolerance

	if !freqMatch || !lowEdgeMatch || !highEdgeMatch {
		now := time.Now()
		
		mismatchMutex.Lock()
		lastLog, logExists := lastMismatchLog[ssrc]
		lastRetry, retryExists := lastRetryTime[ssrc]
		
		// Determine if we should log
		shouldLog := !logExists || now.Sub(lastLog) > mismatchLogPeriod
		
		// Determine if we should retry (once per second)
		shouldRetry := !retryExists || now.Sub(lastRetry) > retryPeriod
		
		if shouldLog {
			lastMismatchLog[ssrc] = now
		}
		if shouldRetry {
			lastRetryTime[ssrc] = now
		}
		mismatchMutex.Unlock()

		if shouldLog {
			log.Printf("INFO: Audio parameter mismatch for SSRC 0x%08x - Session: freq=%d Hz edges=%.1f-%.1f Hz, Radiod: freq=%d Hz edges=%.1f-%.1f Hz",
				ssrc, sessionFreq, sessionLowEdge, sessionHighEdge, radiodFreq, radiodLowEdge, radiodHighEdge)
		}

		// Automatically retry sending the update command
		if shouldRetry {
			log.Printf("INFO: Retrying audio channel update for SSRC 0x%08x to correct mismatch", ssrc)
			
			// Send update command with all parameters to ensure they're synchronized
			// Always send bandwidth edges since that's what we're correcting
			if err := usm.radiod.UpdateChannel(ssrc, sessionFreq, sessionMode, int(sessionLowEdge), int(sessionHighEdge), true); err != nil {
				log.Printf("ERROR: Failed to retry audio channel update for SSRC 0x%08x: %v", ssrc, err)
			}
		}
	}
}

// distributeSpectrum sends spectrum data to the appropriate session
func (usm *UserSpectrumManager) distributeSpectrum(ssrc uint32, data []float32) {
	session, ok := usm.sessions.GetSessionBySSRC(ssrc)
	if !ok {
		if DebugMode {
			log.Printf("DEBUG: No session found for SSRC 0x%08x", ssrc)
		}
		return
	}

	if !session.IsSpectrum {
		if DebugMode {
			log.Printf("DEBUG: Session 0x%08x is not a spectrum session", ssrc)
		}
		return
	}

	// Send to session's spectrum channel (non-blocking)
	select {
	case session.SpectrumChan <- data:
		// Removed debug logging
	default:
		if DebugMode {
			log.Printf("DEBUG: Channel full for session 0x%08x, dropping data", ssrc)
		}
	}
}

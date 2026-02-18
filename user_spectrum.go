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
	// Parse status multicast address (with FNV-1 hash fallback)
	statusAddr, err := resolveMulticastAddr(config.Radiod.StatusGroup)
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
// Polls are sent in parallel for better performance with many users
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

	// Send polls in parallel (non-blocking)
	// This dramatically improves performance with many users (e.g., 50 users)
	// sendCommand() is thread-safe (protected by mutex in RadiodController)
	for _, ssrc := range spectrumSSRCs {
		go func(s uint32) {
			if err := usm.sendPoll(s); err != nil {
				log.Printf("ERROR: Failed to send spectrum poll for SSRC 0x%08x: %v", s, err)
			}
		}(ssrc)
	}
	// Don't wait for polls to complete - they send asynchronously
	// radiod will respond via multicast when ready
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

					// Apply only master gain here - frequency-specific gain will be applied per-session
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

				// Apply only master gain here - frequency-specific gain will be applied per-session
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

		// Automatically retry sending the update command
		if shouldRetry {

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

	// Skip parameter checking for wide IQ modes - they use preset bandwidth values
	wideIQModes := map[string]bool{
		"iq48": true, "iq96": true, "iq192": true, "iq384": true,
	}
	if wideIQModes[sessionMode] {
		return
	}

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

		// Automatically retry sending the update command
		if shouldRetry {

			// Send update command with all parameters to ensure they're synchronized
			// Always send bandwidth edges since that's what we're correcting
			if err := usm.radiod.UpdateChannel(ssrc, sessionFreq, sessionMode, int(sessionLowEdge), int(sessionHighEdge), true); err != nil {
				log.Printf("ERROR: Failed to retry audio channel update for SSRC 0x%08x: %v", ssrc, err)
			}
		}
	}
}

// calculateBinFrequency determines the center frequency of a spectrum bin
// Uses the same calculation as spectrum-display.js for consistency
// binIndex: index of the bin (0 to numBins-1)
// centerFreq: center frequency of the spectrum in Hz
// binBW: bandwidth per bin in Hz
// numBins: total number of bins
func (usm *UserSpectrumManager) calculateBinFrequency(binIndex int, centerFreq uint64, binBW float32, numBins int) uint64 {
	// Match frontend calculation exactly:
	// const startFreq = this.centerFreq - this.totalBandwidth / 2;
	// const freq = startFreq + (binIndex / totalBins) * this.totalBandwidth;

	totalBandwidth := float64(binBW) * float64(numBins)
	startFreq := float64(centerFreq) - (totalBandwidth / 2.0)

	// Calculate bin frequency using the same formula as frontend
	binFreq := startFreq + (float64(binIndex)/float64(numBins))*totalBandwidth

	// Ensure we don't return negative frequencies
	if binFreq < 0 {
		return 0
	}

	return uint64(binFreq)
}

// distributeSpectrum sends spectrum data to the appropriate session
// Applies frequency-specific gain based on the session's actual center frequency and bin bandwidth
func (usm *UserSpectrumManager) distributeSpectrum(ssrc uint32, data []float32) {
	// Defer recovery to handle any panics from sending on closed channels
	defer func() {
		if r := recover(); r != nil {
			// Channel was likely closed during session cleanup - this is expected during shutdown
			if DebugMode {
				log.Printf("DEBUG: Recovered from panic in distributeSpectrum for SSRC 0x%08x: %v", ssrc, r)
			}
		}
	}()

	session, ok := usm.sessions.GetSessionBySSRC(ssrc)
	if !ok {
		return
	}

	if !session.IsSpectrum {
		return
	}

	// Check if session is being destroyed (Done channel closed)
	select {
	case <-session.Done:
		// Session is being destroyed, don't send data
		return
	default:
		// Session is still active, continue
	}

	// Apply frequency-specific gain per-session if configured
	if len(usm.config.Spectrum.GainDBFrequencyRanges) > 0 {
		// Get session parameters (these reflect the user's actual view)
		session.mu.RLock()
		sessionFreq := session.Frequency
		sessionBinBW := session.BinBandwidth
		session.mu.RUnlock()

		// Create a copy of the data to apply session-specific gain
		sessionData := make([]float32, len(data))
		copy(sessionData, data)

		// Apply frequency-specific gain to each bin
		// Data is in FFT order: [positive freqs (DC to +Nyquist), negative freqs (-Nyquist to DC)]
		// Calculate bin frequencies in FFT order to match the data layout (more efficient than unwrap/wrap)
		halfBins := len(sessionData) / 2
		for j := 0; j < len(sessionData); j++ {
			// Calculate bin frequency in FFT order
			var binFreq uint64
			if j < halfBins {
				// First half: positive frequencies (DC to +Nyquist)
				// Bin 0 = centerFreq, Bin halfBins-1 = centerFreq + (halfBins-1)*binBW
				binFreq = sessionFreq + uint64(float64(j)*sessionBinBW)
			} else {
				// Second half: negative frequencies (-Nyquist to -DC)
				// Bin halfBins = centerFreq - halfBins*binBW, Bin N-1 = centerFreq - binBW
				binFreq = sessionFreq - uint64(float64(len(sessionData)-j)*sessionBinBW)
			}

			// Find matching frequency range and apply its gain with optional transition
			for _, freqRange := range usm.config.Spectrum.GainDBFrequencyRanges {
				var gainMultiplier float32 = 0.0

				// Check if we're in the full gain zone (inside the range)
				if binFreq >= freqRange.StartFreq && binFreq <= freqRange.EndFreq {
					gainMultiplier = 1.0
				} else if freqRange.TransitionHz > 0 {
					// Apply linear transition zones outside the range
					if binFreq < freqRange.StartFreq {
						// Below start frequency - check if in transition zone
						distanceOutside := freqRange.StartFreq - binFreq
						if distanceOutside <= freqRange.TransitionHz {
							// Linear ramp: 0 at (start - transition), 1.0 at start
							gainMultiplier = float32(freqRange.TransitionHz-distanceOutside) / float32(freqRange.TransitionHz)
						}
						// else: too far below, gainMultiplier stays 0
					} else if binFreq > freqRange.EndFreq {
						// Above end frequency - check if in transition zone
						distanceOutside := binFreq - freqRange.EndFreq
						if distanceOutside <= freqRange.TransitionHz {
							// Linear ramp: 1.0 at end, 0 at (end + transition)
							gainMultiplier = float32(freqRange.TransitionHz-distanceOutside) / float32(freqRange.TransitionHz)
						}
						// else: too far above, gainMultiplier stays 0
					}
				}

				// Apply the gain with the multiplier
				if gainMultiplier > 0 {
					sessionData[j] += float32(freqRange.GainDB) * gainMultiplier
					break // Use first matching range
				}
			}
		}

		// Send session-specific data
		select {
		case session.SpectrumChan <- sessionData:
			// Data sent successfully
		default:
			// Channel full, drop data
		}
	} else {
		// No frequency-specific gain configured, send original data
		select {
		case session.SpectrumChan <- data:
			// Data sent successfully
		default:
			// Channel full, drop data
		}
	}
}

// calculateBinFrequencyForSession calculates bin frequency using session parameters
// This matches the frontend's calculation exactly
func (usm *UserSpectrumManager) calculateBinFrequencyForSession(binIndex int, centerFreq uint64, binBW float32, numBins int) uint64 {
	// Match frontend calculation exactly:
	// const startFreq = this.centerFreq - this.totalBandwidth / 2;
	// const freq = startFreq + (binIndex / totalBins) * this.totalBandwidth;

	totalBandwidth := float64(binBW) * float64(numBins)
	startFreq := float64(centerFreq) - (totalBandwidth / 2.0)

	// Calculate bin frequency using the same formula as frontend
	binFreq := startFreq + (float64(binIndex)/float64(numBins))*totalBandwidth

	// Ensure we don't return negative frequencies
	if binFreq < 0 {
		return 0
	}

	return uint64(binFreq)
}

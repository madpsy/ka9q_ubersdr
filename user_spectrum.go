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

// spectrumPacket represents a parsed spectrum packet ready for distribution
type spectrumPacket struct {
	ssrc    uint32
	binData []float32
}

// UserSpectrumManager manages per-user spectrum data polling
type UserSpectrumManager struct {
	radiod   *RadiodController
	config   *Config
	sessions *SessionManager

	// Status group listener (shared across all users)
	statusConn *net.UDPConn
	statusAddr *net.UDPAddr

	// Per-packet goroutine dispatch with semaphore to bound concurrency
	dispatchSem             chan struct{} // semaphore: limits concurrent distributeSpectrum goroutines
	hasNonZeroFrequencyGain bool          // true if any GainDBFrequencyRange has a non-zero gain_db

	// Control
	running                bool
	stopChan               chan struct{}
	wg                     sync.WaitGroup
	pollInterval           time.Duration
	backgroundPollInterval time.Duration
}

// NewUserSpectrumManager creates a new per-user spectrum manager
func NewUserSpectrumManager(radiod *RadiodController, config *Config, sessions *SessionManager) (*UserSpectrumManager, error) {
	// Parse status multicast address (with FNV-1 hash fallback)
	statusAddr, err := resolveMulticastAddr(config.Radiod.StatusGroup)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve status address: %w", err)
	}

	// Pre-compute whether any frequency gain range has a non-zero gain_db.
	// This avoids the expensive O(bins × ranges) loop in sendSpectrumToSession
	// when all ranges are 0 dB (the common case for uncalibrated setups).
	hasNonZeroGain := false
	for _, r := range config.Spectrum.GainDBFrequencyRanges {
		if r.GainDB != 0.0 {
			hasNonZeroGain = true
			break
		}
	}

	usm := &UserSpectrumManager{
		radiod:                  radiod,
		config:                  config,
		sessions:                sessions,
		statusAddr:              statusAddr,
		stopChan:                make(chan struct{}),
		pollInterval:            time.Duration(config.Spectrum.PollPeriodMs) * time.Millisecond,
		backgroundPollInterval:  time.Duration(config.Spectrum.BackgroundPollPeriodMs) * time.Millisecond,
		hasNonZeroFrequencyGain: hasNonZeroGain,
		dispatchSem:             make(chan struct{}, 2000), // allow up to 2000 concurrent distributeSpectrum goroutines
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

		log.Printf("User spectrum manager started (poll interval: %v, background poll interval: %v)",
			usm.pollInterval, usm.backgroundPollInterval)
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

	// Wait for polling loop and any in-flight distributeSpectrum goroutines to finish
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

	// Increase UDP receive buffer to handle bursts from many users
	// Default is typically 208KB, increase to 8MB to prevent packet loss
	// With 40+ users, radiod may send all responses in a tight burst
	const recvBufferSize = 16 * 1024 * 1024 // 16MB
	if err := udpConn.SetReadBuffer(recvBufferSize); err != nil {
		log.Printf("Warning: failed to set UDP receive buffer size to %d bytes: %v", recvBufferSize, err)
	} else {
		log.Printf("UDP receive buffer set to %d MB for spectrum data", recvBufferSize/(1024*1024))
	}

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

	bgTicker := time.NewTicker(usm.backgroundPollInterval)
	defer bgTicker.Stop()

	// Start receiver goroutine
	usm.wg.Add(1)
	go usm.receiveLoop()

	for {
		select {
		case <-usm.stopChan:
			return
		case <-ticker.C:
			// Poll user-facing spectrum sessions only (excludes background/internal sessions)
			usm.pollUserSpectrumSessions()
		case <-bgTicker.C:
			// Poll background/internal spectrum sessions (noisefloor, frequency-reference) at a slower rate
			usm.pollBackgroundSpectrumSessions()
		}
	}
}

// pollUserSpectrumSessions sends poll commands for user-facing spectrum sessions only.
// Background sessions (noisefloor, frequency-reference) are excluded and polled separately
// at a lower rate to avoid saturating the radio stat thread with expensive wide-bin spectrum_poll() calls.
// SSRCs are deduplicated so the shared default channel is only polled once regardless of
// how many subscribers it has.
func (usm *UserSpectrumManager) pollUserSpectrumSessions() {
	usm.sessions.mu.RLock()
	seen := make(map[uint32]bool)
	spectrumSSRCs := make([]uint32, 0)
	for _, session := range usm.sessions.sessions {
		if session.IsSpectrum && !session.IsBackground {
			if !seen[session.SSRC] {
				seen[session.SSRC] = true
				spectrumSSRCs = append(spectrumSSRCs, session.SSRC)
			}
		}
	}
	// Also poll the shared default channel SSRC if it is active and not already covered
	// by a subscriber session (it always is, but this is a safety net).
	if sdc := usm.sessions.sharedDefaultChan; sdc != nil && sdc.active && !seen[sdc.ssrc] {
		spectrumSSRCs = append(spectrumSSRCs, sdc.ssrc)
	}
	usm.sessions.mu.RUnlock()

	// Send polls in parallel (non-blocking)
	// sendCommand() is thread-safe (protected by mutex in RadiodController)
	for _, ssrc := range spectrumSSRCs {
		go func(s uint32) {
			if err := usm.sendPoll(s); err != nil {
				log.Printf("ERROR: Failed to send spectrum poll for SSRC 0x%08x: %v", s, err)
			}
		}(ssrc)
	}
}

// pollBackgroundSpectrumSessions sends poll commands for internal background spectrum sessions
// (noisefloor, frequency-reference). These are polled at a much lower rate than user sessions
// because they use wide-bin mode in radiod, where spectrum_poll() runs synchronously in the
// radio stat thread and iterates over thousands of master FFT bins per call.
func (usm *UserSpectrumManager) pollBackgroundSpectrumSessions() {
	usm.sessions.mu.RLock()
	spectrumSSRCs := make([]uint32, 0)
	for _, session := range usm.sessions.sessions {
		if session.IsSpectrum && session.IsBackground {
			spectrumSSRCs = append(spectrumSSRCs, session.SSRC)
		}
	}
	usm.sessions.mu.RUnlock()

	for _, ssrc := range spectrumSSRCs {
		go func(s uint32) {
			if err := usm.sendPoll(s); err != nil {
				log.Printf("ERROR: Failed to send background spectrum poll for SSRC 0x%08x: %v", s, err)
			}
		}(ssrc)
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

		// Parse STATUS packet and dispatch distribution in a goroutine.
		// Using per-packet goroutines instead of a fixed worker pool + queue
		// means bursts of any size (e.g. 2000 channels) are handled without
		// dropping packets due to a full queue.
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

		// Dispatch distribution in a dedicated goroutine so the receive loop
		// is never blocked and bursts of any size are absorbed without drops.
		// A semaphore (2000 slots) bounds peak concurrency: if all slots are
		// occupied the packet is dropped, which only happens when
		// distributeSpectrum() is consistently slower than the poll rate.
		select {
		case usm.dispatchSem <- struct{}{}:
			usm.wg.Add(1)
			go func(s uint32, d []float32) {
				defer func() { <-usm.dispatchSem }()
				defer usm.wg.Done()
				usm.distributeSpectrum(s, d)
			}(ssrc, binData)
		default:
			if DebugMode {
				log.Printf("DEBUG: Spectrum dispatch semaphore full, dropping packet for SSRC 0x%08x", ssrc)
			}
		}
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
	// Check whether this SSRC belongs to the shared default channel.
	// If so, compare against the canonical shared-channel parameters rather than
	// an individual subscriber's session (which would be the same values anyway,
	// but this avoids a 1:1 SSRC→session assumption).
	usm.sessions.mu.RLock()
	sdc, isShared := usm.sessions.ssrcToShared[ssrc]
	usm.sessions.mu.RUnlock()

	var sessionFreq uint64
	var sessionBinBW float32
	var sessionBinCount int

	if isShared {
		// Use the shared channel's canonical (default) parameters.
		def := usm.sessions.config.Spectrum.Default
		sessionFreq = def.CenterFrequency
		sessionBinBW = float32(def.BinBandwidth)
		sessionBinCount = def.BinCount
		_ = sdc // used only for the isShared check
	} else {
		session, ok := usm.sessions.GetSessionBySSRC(ssrc)
		if !ok {
			return
		}
		if !session.IsSpectrum {
			return
		}
		session.mu.RLock()
		sessionFreq = session.Frequency
		sessionBinBW = float32(session.BinBandwidth)
		sessionBinCount = session.BinCount
		session.mu.RUnlock()
	}

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

// distributeSpectrum sends spectrum data to the appropriate session(s).
// For the shared default channel SSRC it fans out to all subscribers.
// Applies frequency-specific gain based on the session's actual center frequency and bin bandwidth.
func (usm *UserSpectrumManager) distributeSpectrum(ssrc uint32, data []float32) {
	// Defer recovery to handle any panics from sending on closed channels.
	// This must be the first statement so it covers both the shared fan-out and
	// the private-channel path below.
	defer func() {
		if r := recover(); r != nil {
			// Channel was likely closed during session cleanup - this is expected during shutdown
			if DebugMode {
				log.Printf("DEBUG: Recovered from panic in distributeSpectrum for SSRC 0x%08x: %v", ssrc, r)
			}
		}
	}()

	// ── Shared channel fan-out ────────────────────────────────────────────────
	// Check whether this SSRC belongs to the shared default channel.
	// If so, deliver data to every subscriber independently.
	usm.sessions.mu.RLock()
	sdc, isShared := usm.sessions.ssrcToShared[ssrc]
	usm.sessions.mu.RUnlock()

	if isShared {
		// Take a snapshot of subscribers under sdc.mu so we don't hold it
		// while doing potentially-blocking channel sends.
		sdc.mu.RLock()
		subscribers := make([]*Session, 0, len(sdc.subscribers))
		for _, sub := range sdc.subscribers {
			subscribers = append(subscribers, sub)
		}
		sdc.mu.RUnlock()

		for _, session := range subscribers {
			// Skip sessions that are being destroyed.
			select {
			case <-session.Done:
				continue
			default:
			}

			usm.sendSpectrumToSession(session, data)
		}
		return
	}

	// ── Private channel path ──────────────────────────────────────────────────
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

	usm.sendSpectrumToSession(session, data)
}

// sendSpectrumToSession delivers spectrum data to a single session, applying any
// configured frequency-specific gain adjustments.
func (usm *UserSpectrumManager) sendSpectrumToSession(session *Session, data []float32) {
	// Apply frequency-specific gain per-session if configured.
	// Skip entirely when all ranges have gain_db == 0.0 (hasNonZeroFrequencyGain is false)
	// to avoid the expensive O(bins × ranges) nested loop for zero net effect.
	if usm.hasNonZeroFrequencyGain {
		// Read session parameters under the lock.
		session.mu.RLock()
		sessionFreq := session.Frequency
		sessionBinBW := session.BinBandwidth
		// Check whether the cached LUT is still valid for this freq/BW.
		lutValid := session.gainLUT != nil &&
			len(session.gainLUT) == len(data) &&
			session.gainLUTFreq == sessionFreq &&
			session.gainLUTBW == sessionBinBW
		session.mu.RUnlock()

		if !lutValid {
			// Rebuild the LUT for the current session view.
			// Data is in FFT order: [positive freqs (DC to +Nyquist), negative freqs (-Nyquist to DC)]
			lut := make([]float32, len(data))
			halfBins := len(lut) / 2
			for j := 0; j < len(lut); j++ {
				var binFreq uint64
				if j < halfBins {
					binFreq = sessionFreq + uint64(float64(j)*sessionBinBW)
				} else {
					binFreq = sessionFreq - uint64(float64(len(lut)-j)*sessionBinBW)
				}

				for _, freqRange := range usm.config.Spectrum.GainDBFrequencyRanges {
					var gainMultiplier float32

					if binFreq >= freqRange.StartFreq && binFreq <= freqRange.EndFreq {
						gainMultiplier = 1.0
					} else if freqRange.TransitionHz > 0 {
						if binFreq < freqRange.StartFreq {
							distanceOutside := freqRange.StartFreq - binFreq
							if distanceOutside <= freqRange.TransitionHz {
								gainMultiplier = float32(freqRange.TransitionHz-distanceOutside) / float32(freqRange.TransitionHz)
							}
						} else {
							distanceOutside := binFreq - freqRange.EndFreq
							if distanceOutside <= freqRange.TransitionHz {
								gainMultiplier = float32(freqRange.TransitionHz-distanceOutside) / float32(freqRange.TransitionHz)
							}
						}
					}

					if gainMultiplier > 0 {
						lut[j] = float32(freqRange.GainDB) * gainMultiplier
						break // first matching range wins
					}
				}
			}

			// Store the new LUT under the write lock.
			session.mu.Lock()
			session.gainLUT = lut
			session.gainLUTFreq = sessionFreq
			session.gainLUTBW = sessionBinBW
			session.mu.Unlock()
		}

		// Apply the LUT: single O(N) pass, no inner range loop.
		sessionData := make([]float32, len(data))
		copy(sessionData, data)
		session.mu.RLock()
		lut := session.gainLUT
		session.mu.RUnlock()
		for j := range sessionData {
			sessionData[j] += lut[j]
		}

		// Send session-specific data.
		select {
		case <-session.Done:
			return
		case session.SpectrumChan <- sessionData:
		default:
			// Channel full, drop data
		}
	} else {
		// No non-zero frequency gain configured — send original data directly.
		select {
		case <-session.Done:
			return
		case session.SpectrumChan <- data:
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

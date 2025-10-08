package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"log"
	"math"
	"math/rand"
	"net"
	"sync"
	"syscall"
	"time"

	"golang.org/x/net/ipv4"
)

const SO_REUSEPORT = 15 // Linux SO_REUSEPORT constant

// SpectrumManager manages spectrum data via STATUS packet polling
type SpectrumManager struct {
	radiod       *RadiodController
	config       *Config
	ssrc         uint32
	frequency    uint64
	binCount     int
	binBandwidth float64
	
	// Status group listener
	statusConn   *net.UDPConn
	statusAddr   *net.UDPAddr
	
	// Spectrum data distribution
	mu           sync.RWMutex
	subscribers  map[chan []float32]struct{}
	latestData   []float32
	lastUpdate   time.Time
	
	// Smoothing
	previousData []float32 // For temporal EMA smoothing
	
	// Control
	running      bool
	stopChan     chan struct{}
	wg           sync.WaitGroup
	pollInterval time.Duration
}

// NewSpectrumManager creates a new spectrum manager
// NOTE: This is now deprecated in favor of per-user spectrum sessions
// Kept for backward compatibility with static spectrum channel
func NewSpectrumManager(radiod *RadiodController, config *Config, audioReceiver *AudioReceiver) (*SpectrumManager, error) {
	// SSRC for static spectrum channel is based on frequency in kHz
	// Per radio.c:848: ssrc = round(freq / 1000.0)
	// For 15 MHz: ssrc = 15000
	ssrc := uint32(config.Spectrum.Default.CenterFrequency / 1000)
	
	sm := &SpectrumManager{
		radiod:       radiod,
		config:       config,
		ssrc:         ssrc,
		frequency:    config.Spectrum.Default.CenterFrequency,
		binCount:     config.Spectrum.Default.BinCount,
		binBandwidth: config.Spectrum.Default.BinBandwidth,
		subscribers:  make(map[chan []float32]struct{}),
		stopChan:     make(chan struct{}),
		pollInterval: time.Duration(config.Spectrum.PollPeriodMs) * time.Millisecond,
	}
	
	// Parse status multicast address
	statusAddr, err := net.ResolveUDPAddr("udp", config.Radiod.StatusGroup)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve status address: %w", err)
	}
	sm.statusAddr = statusAddr
	
	return sm, nil
}

// Start initializes the spectrum manager and begins polling
// NOTE: The spectrum channel must already exist as a static channel in radiod config
func (sm *SpectrumManager) Start() error {
	sm.mu.Lock()
	if sm.running {
		sm.mu.Unlock()
		return fmt.Errorf("spectrum manager already running")
	}
	sm.running = true
	sm.mu.Unlock()
	
	if sm.config.Spectrum.Enabled {
		// Set up status group listener
		if err := sm.setupStatusListener(); err != nil {
			return fmt.Errorf("failed to setup status listener: %w", err)
		}
		
		// Start polling loop
		sm.wg.Add(1)
		go sm.pollLoop()
		
		log.Printf("Spectrum polling enabled: SSRC=0x%08x, expecting %d bins @ %.1f Hz bandwidth, center: %d Hz",
			sm.ssrc, sm.binCount, sm.binBandwidth, sm.frequency)
		log.Printf("NOTE: Spectrum channel must be pre-configured in radiod as a static channel")
	} else {
		log.Printf("Spectrum polling disabled in config")
	}
	
	log.Printf("Spectrum manager started")
	return nil
}

// Stop shuts down the spectrum manager
func (sm *SpectrumManager) Stop() {
	sm.mu.Lock()
	if !sm.running {
		sm.mu.Unlock()
		return
	}
	sm.running = false
	sm.mu.Unlock()
	
	// Signal stop
	close(sm.stopChan)
	
	// Wait for polling loop to finish
	sm.wg.Wait()
	
	// Close status listener
	if sm.statusConn != nil {
		sm.statusConn.Close()
	}
	
	log.Println("Spectrum manager stopped")
}

// setupStatusListener creates a UDP listener for STATUS packets
func (sm *SpectrumManager) setupStatusListener() error {
	// Create UDP connection for receiving STATUS packets with SO_REUSEPORT
	// This allows multiple processes to listen on the same port
	lc := net.ListenConfig{
		Control: func(network, address string, c syscall.RawConn) error {
			var sockErr error
			err := c.Control(func(fd uintptr) {
				// Set SO_REUSEPORT to allow multiple listeners
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
	
	// Listen on the status port
	conn, err := lc.ListenPacket(context.Background(), "udp4", fmt.Sprintf(":%d", sm.statusAddr.Port))
	if err != nil {
		return fmt.Errorf("failed to create status listener: %w", err)
	}
	
	udpConn := conn.(*net.UDPConn)
	
	// Join multicast group
	if sm.statusAddr.IP.IsMulticast() {
		iface := sm.radiod.GetInterface()
		p := ipv4.NewPacketConn(udpConn)
		if err := p.JoinGroup(iface, sm.statusAddr); err != nil {
			conn.Close()
			return fmt.Errorf("failed to join status multicast group: %w", err)
		}
	}
	
	sm.statusConn = udpConn
	log.Printf("Status listener created on %s (with SO_REUSEPORT)", sm.statusAddr)
	return nil
}

// pollLoop periodically polls radiod for spectrum data
func (sm *SpectrumManager) pollLoop() {
	defer sm.wg.Done()
	
	ticker := time.NewTicker(sm.pollInterval)
	defer ticker.Stop()
	
	// Start receiver goroutine
	sm.wg.Add(1)
	go sm.receiveLoop()
	
	for {
		select {
		case <-sm.stopChan:
			return
		case <-ticker.C:
			if err := sm.sendPoll(); err != nil {
				log.Printf("ERROR: Failed to send spectrum poll: %v", err)
			}
		}
	}
}

// sendPoll sends a poll command to request spectrum data
// Per radio.c:1365-1377, any command with OUTPUT_SSRC triggers STATUS response
// For spectrum mode, STATUS includes BIN_DATA computed by spectrum_poll()
func (sm *SpectrumManager) sendPoll() error {
	buf := make([]byte, 0, 256)
	buf = append(buf, 1) // CMD packet type
	buf = encodeInt32(&buf, 0x12, sm.ssrc) // OUTPUT_SSRC - identifies the channel
	buf = encodeInt32(&buf, 0x01, rand.Uint32()) // COMMAND_TAG - for tracking
	buf = append(buf, 0) // EOL
	
	if DebugMode {
		log.Printf("DEBUG: Sending spectrum poll for SSRC=0x%08x", sm.ssrc)
	}
	
	return sm.radiod.sendCommand(buf)
}

// receiveLoop receives and processes STATUS packets
func (sm *SpectrumManager) receiveLoop() {
	defer sm.wg.Done()
	
	buffer := make([]byte, 65536)
	packetsReceived := 0
	
	if DebugMode {
		log.Printf("DEBUG: Spectrum receive loop started, listening for STATUS packets")
	}
	
	for {
		select {
		case <-sm.stopChan:
			if DebugMode {
				log.Printf("DEBUG: Spectrum receive loop stopping, received %d packets total", packetsReceived)
			}
			return
		default:
		}
		
		// Set read deadline to allow checking stopChan
		sm.statusConn.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		
		n, addr, err := sm.statusConn.ReadFromUDP(buffer)
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				continue // Timeout is expected, check stopChan and continue
			}
			log.Printf("ERROR: Failed to read STATUS packet: %v", err)
			continue
		}
		
		packetsReceived++
		
		if DebugMode {
			if packetsReceived <= 20 || packetsReceived%10 == 1 {
				log.Printf("DEBUG: Received packet #%d from %s, length=%d bytes, type=%d",
					packetsReceived, addr, n, buffer[0])
			}
		}
		
		if n < 2 {
			if DebugMode {
				log.Printf("DEBUG: Packet too small (%d bytes), skipping", n)
			}
			continue // Too small to be valid
		}
		
		// Check packet type (first byte)
		if buffer[0] != 0 { // STATUS = 0
			if DebugMode {
				log.Printf("DEBUG: Non-STATUS packet (type=%d), skipping", buffer[0])
			}
			continue
		}
		
		// Parse STATUS packet
		sm.parseStatusPacket(buffer[1:n])
	}
}

// parseStatusPacket extracts spectrum data from a STATUS packet
func (sm *SpectrumManager) parseStatusPacket(payload []byte) {
	var ssrc uint32
	var binData []float32
	var demodType int = -1
	var binCount int = -1
	var binBW float32 = -1
	foundSSRC := false
	foundBinData := false
	allTags := []string{} // Track all tags seen
	gainDB := float32(sm.config.Spectrum.GainDB) // Get gain adjustment from config
	
	if DebugMode {
		log.Printf("DEBUG: Parsing STATUS packet, payload length=%d bytes", len(payload))
		// Dump first 64 bytes for inspection
		dumpLen := 64
		if len(payload) < dumpLen {
			dumpLen = len(payload)
		}
		log.Printf("DEBUG: First %d bytes: % x", dumpLen, payload[:dumpLen])
	}
	
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
			if DebugMode {
				log.Printf("DEBUG: Invalid length at tag 0x%02x: length=%d, remaining=%d", tag, length, len(payload)-i)
			}
			break // Invalid length
		}
		
		// Track all tags for debugging
		if DebugMode {
			allTags = append(allTags, fmt.Sprintf("0x%02x(len=%d)", tag, length))
		}
		
		switch tag {
		case 0x12: // OUTPUT_SSRC - variable length integer
			// Radiod uses variable-length encoding: read 1-8 bytes as big-endian
			ssrc = 0
			for j := 0; j < length && j < 8; j++ {
				ssrc = (ssrc << 8) | uint32(payload[i+j])
			}
			foundSSRC = true
			if DebugMode {
				log.Printf("DEBUG: Found SSRC=0x%08x (length=%d bytes, looking for 0x%08x)", ssrc, length, sm.ssrc)
			}
		case 0x32: // DEMOD_TYPE
			if length > 0 {
				demodType = int(payload[i])
			}
			if DebugMode {
				log.Printf("DEBUG: Found DEMOD_TYPE=%d (7=SPECT_DEMOD)", demodType)
			}
		case 0x5e: // BIN_COUNT (tag 94)
			// Small length, treat as BIN_COUNT integer
			binCount = 0
			for j := 0; j < length && j < 4; j++ {
				binCount = (binCount << 8) | int(payload[i+j])
			}
			if DebugMode {
				log.Printf("DEBUG: Found BIN_COUNT=%d", binCount)
			}
		case 0x5d: // NONCOHERENT_BIN_BW (tag 93)
			if length == 4 {
				bits := binary.BigEndian.Uint32(payload[i : i+4])
				binBW = math.Float32frombits(bits)
			}
			if DebugMode {
				log.Printf("DEBUG: Found NONCOHERENT_BIN_BW=%.1f Hz", binBW)
			}
		case 0x60: // BIN_DATA (radiod may use 0x60 for bin data in some cases)
			if length > 100 { // Large length means it's bin data
				// Extract float32 array (power values, not dB)
				numBins := length / 4
				binData = make([]float32, numBins)
				for j := 0; j < numBins; j++ {
					bits := binary.BigEndian.Uint32(payload[i+j*4 : i+j*4+4])
					power := math.Float32frombits(bits)
					
					// Convert power to dB and apply gain adjustment
					if power > 0 {
						binData[j] = 10.0 * float32(math.Log10(float64(power))) + gainDB
					} else {
						binData[j] = -120.0 + gainDB // Noise floor
					}
				}
				foundBinData = true
				if DebugMode {
					log.Printf("DEBUG: Found BIN_DATA at tag 0x60 with %d bins (%d bytes)", numBins, length)
				}
			}
		case 0x8E: // BIN_DATA (tag 142) - standard tag, but radiod may not use this
			// Extract float32 array (power values, not dB)
			numBins := length / 4
			binData = make([]float32, numBins)
			for j := 0; j < numBins; j++ {
				bits := binary.BigEndian.Uint32(payload[i+j*4 : i+j*4+4])
				power := math.Float32frombits(bits)
				
				// Convert power to dB and apply gain adjustment
				if power > 0 {
					binData[j] = 10.0 * float32(math.Log10(float64(power))) + gainDB
				} else {
					binData[j] = -120.0 + gainDB // Noise floor
				}
			}
			foundBinData = true
			if DebugMode {
				log.Printf("DEBUG: Found BIN_DATA at tag 0x8E with %d bins", numBins)
			}
		}
		
		i += length
	}
	
	if DebugMode {
		log.Printf("DEBUG: All tags in packet: %v", allTags)
		log.Printf("DEBUG: demodType=%d, binCount=%d, binBW=%.1f", demodType, binCount, binBW)
	}
	
	if DebugMode {
		log.Printf("DEBUG: Parse complete: foundSSRC=%v, foundBinData=%v, ssrc=0x%08x, binData=%v",
			foundSSRC, foundBinData, ssrc, binData != nil)
	}
	
	// Check if this is our spectrum channel and we have data
	if ssrc == sm.ssrc && binData != nil {
		sm.distributeSpectrum(binData)
	} else if DebugMode {
		if ssrc != sm.ssrc {
			log.Printf("DEBUG: SSRC mismatch: got 0x%08x, want 0x%08x", ssrc, sm.ssrc)
		}
		if binData == nil {
			log.Printf("DEBUG: No bin data found in packet")
		}
	}
}

// distributeSpectrum sends spectrum data to all subscribers
func (sm *SpectrumManager) distributeSpectrum(data []float32) {
	// Apply smoothing if enabled
	if sm.config.Spectrum.Smoothing.Enabled {
		// 1. Apply spatial smoothing (frequency domain) - Gaussian filter
		if sm.config.Spectrum.Smoothing.SpatialSigma > 0 {
			data = smoothGaussian(data, sm.config.Spectrum.Smoothing.SpatialSigma)
		}
		
		// 2. Apply temporal smoothing (time domain) - EMA
		if sm.config.Spectrum.Smoothing.TemporalAlpha > 0 && sm.config.Spectrum.Smoothing.TemporalAlpha <= 1 {
			data = sm.applyTemporalSmoothing(data, sm.config.Spectrum.Smoothing.TemporalAlpha)
		}
	}
	
	sm.mu.Lock()
	sm.latestData = data
	sm.lastUpdate = time.Now()
	
	// Send to all subscribers (non-blocking)
	for ch := range sm.subscribers {
		select {
		case ch <- data:
		default:
			// Channel full, skip this update for this subscriber
		}
	}
	sm.mu.Unlock()
}

// Subscribe adds a new subscriber for spectrum data
func (sm *SpectrumManager) Subscribe() chan []float32 {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	
	ch := make(chan []float32, 10) // Buffer to avoid blocking
	sm.subscribers[ch] = struct{}{}
	
	// Send latest data immediately if available
	if sm.latestData != nil {
		select {
		case ch <- sm.latestData:
		default:
		}
	}
	
	return ch
}

// Unsubscribe removes a subscriber
func (sm *SpectrumManager) Unsubscribe(ch chan []float32) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	
	delete(sm.subscribers, ch)
	close(ch)
}

// GetLatestData returns the most recent spectrum data
func (sm *SpectrumManager) GetLatestData() ([]float32, time.Time) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	
	if sm.latestData == nil {
		return nil, time.Time{}
	}
	
	// Return a copy to avoid race conditions
	data := make([]float32, len(sm.latestData))
	copy(data, sm.latestData)
	
	return data, sm.lastUpdate
}

// isRunning checks if the manager is running (thread-safe)
func (sm *SpectrumManager) isRunning() bool {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.running
}

// GetInfo returns spectrum configuration info
func (sm *SpectrumManager) GetInfo() map[string]interface{} {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	
	return map[string]interface{}{
		"center_frequency": sm.frequency,
		"bin_count":        sm.binCount,
		"bin_bandwidth":    sm.binBandwidth,
		"total_bandwidth":  float64(sm.binCount) * sm.binBandwidth,
		"last_update":      sm.lastUpdate,
		"subscribers":      len(sm.subscribers),
	}
}

// smoothGaussian applies Gaussian smoothing to spectrum data (spatial/frequency domain)
// sigma controls the amount of smoothing (higher = more smoothing)
func smoothGaussian(data []float32, sigma float32) []float32 {
	if sigma <= 0 || len(data) < 3 {
		return data
	}
	
	// Kernel size based on sigma (typically 3*sigma, rounded up)
	kernelSize := int(math.Ceil(float64(3*sigma))) * 2 + 1
	if kernelSize > len(data) {
		kernelSize = len(data)
		if kernelSize%2 == 0 {
			kernelSize--
		}
	}
	
	// Generate Gaussian kernel
	kernel := make([]float32, kernelSize)
	sum := float32(0)
	center := kernelSize / 2
	
	for i := range kernel {
		x := float64(i - center)
		kernel[i] = float32(math.Exp(-(x * x) / (2 * float64(sigma) * float64(sigma))))
		sum += kernel[i]
	}
	
	// Normalize kernel
	for i := range kernel {
		kernel[i] /= sum
	}
	
	// Apply convolution
	smoothed := make([]float32, len(data))
	halfKernel := kernelSize / 2
	
	for i := range data {
		value := float32(0)
		weightSum := float32(0)
		
		for j := 0; j < kernelSize; j++ {
			idx := i + j - halfKernel
			if idx >= 0 && idx < len(data) {
				value += data[idx] * kernel[j]
				weightSum += kernel[j]
			}
		}
		
		// Normalize by actual weight sum (handles edges)
		if weightSum > 0 {
			smoothed[i] = value / weightSum
		} else {
			smoothed[i] = data[i]
		}
	}
	
	return smoothed
}

// applyTemporalSmoothing applies exponential moving average (EMA) smoothing
// across time (between spectrum updates)
// alpha: 0-1, where lower values = more smoothing (more weight to previous data)
func (sm *SpectrumManager) applyTemporalSmoothing(newData []float32, alpha float32) []float32 {
	if sm.previousData == nil || len(sm.previousData) != len(newData) {
		// First frame or size mismatch, just store and return
		sm.previousData = make([]float32, len(newData))
		copy(sm.previousData, newData)
		return newData
	}
	
	// Apply EMA: smoothed = alpha * new + (1-alpha) * old
	smoothed := make([]float32, len(newData))
	for i := range newData {
		smoothed[i] = alpha*newData[i] + (1-alpha)*sm.previousData[i]
	}
	
	// Store for next iteration
	copy(sm.previousData, smoothed)
	
	return smoothed
}
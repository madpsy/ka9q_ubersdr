package main

import (
	"encoding/binary"
	"fmt"
	"log"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// MultiDecoder manages multiple decoder bands and their sessions
type MultiDecoder struct {
	config   *DecoderConfig
	radiod   *RadiodController
	sessions *SessionManager

	// Decoder bands
	decoderBands map[string]*DecoderBand
	bandsReady   bool

	// Decoder spawner
	spawner *DecoderSpawner

	// Spot reporters
	pskReporter *PSKReporter
	wsprNet     *WSPRNet

	// CSV logger
	spotsLogger *SpotsLogger

	// Metrics logger (JSON Lines)
	metricsLogger         *MetricsLogger
	metricsFirstWriteDone bool
	metricsFirstWriteMu   sync.Mutex

	// Metrics summary aggregator
	summaryAggregator *MetricsSummaryAggregator

	// Statistics
	stats *DecoderStats

	// Prometheus metrics
	prometheusMetrics *PrometheusMetrics

	// Control
	running  bool
	stopChan chan struct{}
	wg       sync.WaitGroup

	// Callback for decoded spots
	onDecodeCallback func(DecodeInfo)
	callbackMu       sync.RWMutex
}

// NewMultiDecoder creates a new multi-decoder instance
func NewMultiDecoder(config *DecoderConfig, radiod *RadiodController, sessions *SessionManager, prometheusMetrics *PrometheusMetrics) (*MultiDecoder, error) {
	if !config.Enabled {
		return nil, nil
	}

	// Validate configuration
	if err := config.Validate(); err != nil {
		return nil, fmt.Errorf("invalid decoder configuration: %w", err)
	}

	// Create data directory
	if err := os.MkdirAll(config.DataDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create decoder data directory: %w", err)
	}

	// Check decoder availability
	modes := make([]DecoderMode, 0)
	for _, band := range config.GetEnabledBands() {
		modes = append(modes, band.Mode)
	}
	if err := CheckDecoderAvailability(config, modes); err != nil {
		return nil, fmt.Errorf("decoder availability check failed: %w", err)
	}

	md := &MultiDecoder{
		config:            config,
		radiod:            radiod,
		sessions:          sessions,
		decoderBands:      make(map[string]*DecoderBand),
		spawner:           NewDecoderSpawner(config),
		stats:             NewDecoderStats(),
		prometheusMetrics: prometheusMetrics,
		stopChan:          make(chan struct{}),
	}

	// Initialize spot reporters if enabled
	if config.PSKReporterEnabled {
		programName := fmt.Sprintf("%s %s", "UberSDR", Version)
		psk, err := NewPSKReporter(config.ReceiverCallsign, config.ReceiverLocator, programName, config.ReceiverAntenna)
		if err != nil {
			return nil, fmt.Errorf("failed to initialize PSKReporter: %w", err)
		}
		md.pskReporter = psk
	}

	if config.WSPRNetEnabled {
		// Use wsprnet_callsign if set, otherwise use receiver_callsign
		wsprnetCallsign := config.ReceiverCallsign
		if config.WSPRNetCallsign != "" {
			wsprnetCallsign = config.WSPRNetCallsign
		}
		wspr, err := NewWSPRNet(wsprnetCallsign, config.ReceiverLocator, "UberSDR", "")
		if err != nil {
			return nil, fmt.Errorf("failed to initialize WSPRNet: %w", err)
		}
		md.wsprNet = wspr
	}

	// Initialize spots logger (independent of reporting)
	// Path resolution is handled in main.go before this is called
	if config.SpotsLogEnabled {
		logger, err := NewSpotsLogger(config.SpotsLogDataDir, true, config.SpotsLogMaxAgeDays)
		if err != nil {
			return nil, fmt.Errorf("failed to initialize spots logger: %w", err)
		}
		md.spotsLogger = logger
		if config.SpotsLogMaxAgeDays > 0 {
			log.Printf("Spots CSV logging enabled: %s (cleanup: %d days)", config.SpotsLogDataDir, config.SpotsLogMaxAgeDays)
		} else {
			log.Printf("Spots CSV logging enabled: %s (no cleanup)", config.SpotsLogDataDir)
		}
	}

	// Initialize metrics logger (JSON Lines format)
	// Path resolution is handled in main.go before this is called
	if config.MetricsLogEnabled {
		writeInterval := time.Duration(config.MetricsLogIntervalSecs) * time.Second
		if writeInterval == 0 {
			writeInterval = 5 * time.Minute // Default to 5 minutes
		}
		logger, err := NewMetricsLogger(config.MetricsLogDataDir, true, writeInterval)
		if err != nil {
			return nil, fmt.Errorf("failed to initialize metrics logger: %w", err)
		}
		md.metricsLogger = logger
		log.Printf("Metrics JSON Lines logging enabled: %s (interval: %v)", config.MetricsLogDataDir, writeInterval)

		// Load recent metrics from files to restore state after restart
		if err := logger.LoadRecentMetrics(prometheusMetrics.digitalMetrics); err != nil {
			log.Printf("Warning: failed to load recent metrics from files: %v", err)
		}

		// Initialize metrics summary aggregator
		// Path resolution is handled in main.go before this is called
		aggregator, err := NewMetricsSummaryAggregator(config.MetricsLogDataDir, config.MetricsSummaryDataDir, logger)
		if err != nil {
			return nil, fmt.Errorf("failed to initialize metrics summary aggregator: %w", err)
		}
		md.summaryAggregator = aggregator
		log.Printf("Metrics summary aggregator enabled: %s", config.MetricsSummaryDataDir)
	}

	return md, nil
}

// Start begins the multi-decoder operation
func (md *MultiDecoder) Start() error {
	if md == nil {
		return nil // Disabled
	}

	md.running = true

	log.Printf("Creating decoder sessions for %d bands", len(md.config.GetEnabledBands()))

	// Create audio sessions for each enabled band
	for _, bandConfig := range md.config.GetEnabledBands() {
		if err := md.createBandSession(bandConfig); err != nil {
			return fmt.Errorf("failed to create session for %s: %w", bandConfig.Name, err)
		}
	}

	md.bandsReady = true

	// Connect spot reporters
	if md.pskReporter != nil {
		if err := md.pskReporter.Connect(); err != nil {
			log.Printf("Warning: Failed to connect to PSKReporter: %v", err)
		}
	}

	if md.wsprNet != nil {
		if err := md.wsprNet.Connect(); err != nil {
			log.Printf("Warning: Failed to connect to WSPRNet: %v", err)
		}
	}

	// Start monitoring loops for each band
	for _, band := range md.decoderBands {
		md.wg.Add(1)
		go md.bandMonitorLoop(band)
	}

	// Start metrics logger periodic write goroutine
	if md.metricsLogger != nil {
		log.Printf("Starting metrics write loop (interval: %v)", md.metricsLogger.writeInterval)
		md.wg.Add(1)
		go md.metricsWriteLoop()
	}

	log.Printf("Multi-decoder started (%d bands active)", len(md.decoderBands))

	return nil
}

// createBandSession creates an audio session for a decoder band
func (md *MultiDecoder) createBandSession(bandConfig DecoderBandConfig) error {
	// Generate unique SSRC
	ssrc := uint32(rand.Int31())
	if ssrc == 0 || ssrc == 0xffffffff {
		ssrc = 1
	}

	// Ensure SSRC is unique
	md.sessions.mu.RLock()
	for {
		if _, exists := md.sessions.ssrcToSession[ssrc]; !exists {
			break
		}
		ssrc = uint32(rand.Int31())
		if ssrc == 0 || ssrc == 0xffffffff {
			ssrc = 1
		}
	}
	md.sessions.mu.RUnlock()

	// Create channel name
	channelName := fmt.Sprintf("decoder-%s", bandConfig.Name)

	// Get mode info
	modeInfo := GetModeInfo(bandConfig.Mode)

	// Create radiod channel (use USB preset, 12kHz sample rate for digital modes)
	sampleRate := 12000
	bandwidth := 3000 // 3 kHz bandwidth for digital modes

	// Create the channel with the preset
	if err := md.radiod.CreateChannelWithBandwidth(
		channelName,
		bandConfig.Frequency,
		modeInfo.Preset,
		sampleRate,
		ssrc,
		bandwidth, // 3000 Hz bandwidth
	); err != nil {
		return fmt.Errorf("failed to create radiod channel: %w", err)
	}

	// Wait for radiod to process the channel creation
	time.Sleep(100 * time.Millisecond)

	// Create session ID first (needed for UpdateSessionWithEdges)
	sessionID := fmt.Sprintf("decoder-%s-%08x", bandConfig.Name, ssrc)

	// Create audio channel for receiving data
	audioChan := make(chan AudioPacket, 100)

	// Register session with session manager BEFORE updating bandwidth
	session := &Session{
		ID:          sessionID,
		ChannelName: channelName,
		SSRC:        ssrc,
		Frequency:   bandConfig.Frequency,
		Mode:        modeInfo.Preset,
		SampleRate:  sampleRate,
		AudioChan:   audioChan,
		CreatedAt:   time.Now(),
		LastActive:  time.Now(),
		IsSpectrum:  false,
	}

	md.sessions.mu.Lock()
	md.sessions.sessions[sessionID] = session
	md.sessions.ssrcToSession[ssrc] = session
	md.sessions.mu.Unlock()

	// Now set the filter bandwidth using LOW_EDGE and HIGH_EDGE
	// For USB digital modes (FT8/FT4/WSPR): 0 Hz to 3000 Hz
	// This gives us the full 3 kHz bandwidth needed for digital mode decoding
	// Use SessionManager's UpdateSessionWithEdges to properly set bandwidth
	if err := md.sessions.UpdateSessionWithEdges(
		sessionID,
		0,         // don't change frequency
		"",        // don't change mode
		0,         // LOW_EDGE: 0 Hz (start of USB passband)
		bandwidth, // HIGH_EDGE: 3000 Hz (end of USB passband)
		true,      // send bandwidth parameters
	); err != nil {
		log.Printf("Warning: failed to set bandwidth for %s: %v", channelName, err)
	}

	log.Printf("Set decoder bandwidth for %s: 0 to %d Hz", channelName, bandwidth)

	// Create decoder band
	band := &DecoderBand{
		Config:       bandConfig,
		SSRC:         ssrc,
		SessionID:    sessionID,
		AudioChan:    audioChan,
		LastDataTime: time.Now(),
		DecoderSession: &DecoderSession{
			SampleRate: sampleRate,
			Channels:   1, // Mono
			FileCycle:  -1,
		},
	}
	band.DecoderSession.Band = band

	md.decoderBands[bandConfig.Name] = band

	log.Printf("Created decoder session for %s (SSRC: 0x%08x, freq: %.6f MHz, mode: %s)",
		bandConfig.Name, ssrc, float64(bandConfig.Frequency)/1e6, bandConfig.Mode.String())

	return nil
}

// bandMonitorLoop monitors audio data for a single band
func (md *MultiDecoder) bandMonitorLoop(band *DecoderBand) {
	defer md.wg.Done()

	modeInfo := GetModeInfo(band.Config.Mode)

	// Check if this is a streaming mode
	if modeInfo.IsStreaming {
		md.streamingMonitorLoop(band)
		return
	}

	// Batch mode (WAV file based)
	cycleTime := modeInfo.CycleTime
	recordingTime := modeInfo.TransmissionTime
	if md.config.IncludeDeadTime {
		recordingTime = cycleTime
	}

	if DebugMode {
		log.Printf("DEBUG: Monitor loop started for %s (cycle: %v, recording: %v)",
			band.Config.Name, cycleTime, recordingTime)
	}

	for {
		select {
		case <-md.stopChan:
			// Close any open file
			if band.DecoderSession.WavFile != nil {
				md.closeAndDecode(band)
			}
			return

		case audioPacket := <-band.AudioChan:
			// Process audio packet (LastDataTime will be updated when decoder completes)
			// Extract PCM data from the audio packet (RTP timestamp not needed for decoders)
			md.processAudioPacket(band, audioPacket.PCMData, time.Now())
		}
	}
}

// streamingMonitorLoop handles streaming decoders (JS8, etc.)
func (md *MultiDecoder) streamingMonitorLoop(band *DecoderBand) {
	// Get decoder binary path based on mode
	var binaryPath string
	switch band.Config.Mode {
	case ModeJS8:
		binaryPath = md.config.JS8Path
	default:
		log.Printf("Error: Unknown streaming mode %s", band.Config.Mode)
		return
	}

	// Create streaming decoder
	decoder, err := NewStreamingDecoder(binaryPath, band, md.config, globalCTY)
	if err != nil {
		log.Printf("Error creating streaming decoder for %s: %v", band.Config.Name, err)
		return
	}
	defer decoder.Stop()

	// Start goroutine to process decoder results
	md.wg.Add(1)
	go func() {
		defer md.wg.Done()
		for decode := range decoder.GetResults() {
			// Skip JS8 spots without a valid callsign (they're just noise/partial decodes)
			if decode.Mode == "JS8" && !decode.HasCallsign {
				continue
			}

			// Update last data time
			band.mu.Lock()
			band.LastDataTime = time.Now()
			band.mu.Unlock()

			// Update statistics
			md.stats.IncrementDecodes(band.Config.Name, 1)
			md.stats.IncrementSpots(band.Config.Name, 1)

			// Record decode metrics (streaming modes don't have cycles, use 0)
			if md.prometheusMetrics != nil {
				md.prometheusMetrics.RecordDigitalDecode(decode.Mode, band.Config.Name, decode.Callsign, 0)
			}

			// Record decode in summary aggregator
			if md.summaryAggregator != nil {
				md.summaryAggregator.RecordDecode(decode.Mode, band.Config.Name, decode.Timestamp)
			}

			// Log to CSV
			if md.spotsLogger != nil {
				shouldLog := true
				if md.config.SpotsLogLocatorsOnly && !decode.HasLocator {
					shouldLog = false
				}
				if shouldLog {
					if err := md.spotsLogger.LogSpot(decode); err != nil {
						log.Printf("Warning: Failed to log spot to CSV: %v", err)
					}
				}
			}

			// Notify callback for websocket broadcasting
			md.notifyDecode(*decode)

			// Submit to PSKReporter (WSPR requires locator, FT8/FT4/JS8 do not)
			if md.pskReporter != nil {
				shouldSubmit := decode.Mode != "WSPR" || decode.Locator != ""
				if shouldSubmit {
					if err := md.pskReporter.Submit(decode); err != nil {
						log.Printf("Warning: Failed to submit to PSKReporter: %v", err)
					} else {
						md.stats.IncrementPSKReporter(1)
					}
				}
			}
		}
	}()

	// Feed audio to streaming decoder
	for {
		select {
		case <-md.stopChan:
			return

		case audioPacket := <-band.AudioChan:
			// Update last data time when audio is received
			band.mu.Lock()
			band.LastDataTime = time.Now()
			band.mu.Unlock()

			// Convert PCM data from big-endian (radiod format) to little-endian (js8 expects)
			pcmLE := convertBigEndianToLittleEndian(audioPacket.PCMData)

			// Write PCM data to streaming decoder
			if err := decoder.WriteAudio(pcmLE); err != nil {
				// Don't log "broken pipe" errors - these are expected when decoder exits/restarts
				if !strings.Contains(err.Error(), "broken pipe") {
					log.Printf("Error writing audio to streaming decoder for %s: %v", band.Config.Name, err)
				}
			}
		}
	}
}

// processAudioPacket processes an audio packet for a band
func (md *MultiDecoder) processAudioPacket(band *DecoderBand, audioData []byte, timestamp time.Time) {
	ds := band.DecoderSession
	modeInfo := GetModeInfo(band.Config.Mode)

	// Calculate current cycle
	cycleTime := modeInfo.CycleTime
	recordingTime := modeInfo.TransmissionTime
	if md.config.IncludeDeadTime {
		recordingTime = cycleTime
	}

	currentCycle := timestamp.Unix() / int64(cycleTime.Seconds())
	modTime := timestamp.Unix() % int64(cycleTime.Seconds())
	modTimeSec := float64(modTime)

	ds.mu.Lock()
	defer ds.mu.Unlock()

	ds.CurrentCycle = currentCycle

	// State machine: Check if we need to close current file
	if ds.WavFile != nil && ds.FileCycle != currentCycle {
		// Cycle boundary - close and decode
		ds.mu.Unlock()
		md.closeAndDecode(band)
		ds.mu.Lock()
	}

	// Check if we're past recording window
	if ds.WavFile != nil && modTimeSec >= recordingTime.Seconds() {
		// Past recording window - close and decode
		ds.mu.Unlock()
		md.closeAndDecode(band)
		ds.mu.Lock()
	}

	// Check if we need to create a new file
	if ds.WavFile == nil && modTimeSec < recordingTime.Seconds() {
		// Calculate cycle start time
		cycleStart := timestamp.Add(-time.Duration(modTime) * time.Second)
		ds.mu.Unlock()
		md.createNewFile(band, cycleStart)
		ds.mu.Lock()
	}

	// Write audio data if file is open
	if ds.WavFile != nil {
		n, err := ds.WavFile.WriteBytes(audioData)
		if err != nil {
			log.Printf("Error writing audio data for %s: %v", band.Config.Name, err)
		} else {
			ds.SamplesWritten += int64(n)
			ds.TotalSamples += int64(n)
		}
	}
}

// createNewFile creates a new WAV file for recording
func (md *MultiDecoder) createNewFile(band *DecoderBand, cycleStart time.Time) {
	ds := band.DecoderSession

	ds.mu.Lock()
	defer ds.mu.Unlock()

	// Create directory for this band
	bandDir := filepath.Join(md.config.DataDir, fmt.Sprintf("%d", band.Config.Frequency))
	if err := os.MkdirAll(bandDir, 0755); err != nil {
		log.Printf("Error creating band directory %s: %v", bandDir, err)
		return
	}

	// Generate filename based on mode and time
	var filename string
	tm := cycleStart.UTC()

	switch band.Config.Mode {
	case ModeWSPR:
		filename = filepath.Join(bandDir, fmt.Sprintf("%02d%02d%02d_%02d%02d.wav",
			tm.Year()%100, tm.Month(), tm.Day(), tm.Hour(), tm.Minute()))
	case ModeFT8, ModeFT4:
		filename = filepath.Join(bandDir, fmt.Sprintf("%02d%02d%02d_%02d%02d%02d.wav",
			tm.Year()%100, tm.Month(), tm.Day(), tm.Hour(), tm.Minute(), tm.Second()))
	}

	// Create WAV writer
	wavWriter, err := NewWAVWriter(filename, ds.SampleRate, ds.Channels, 16)
	if err != nil {
		log.Printf("Error creating WAV file %s: %v", filename, err)
		return
	}

	ds.WavFile = wavWriter
	ds.Filename = filename
	ds.FileCycle = ds.CurrentCycle
	ds.SamplesWritten = 0
}

// closeAndDecode closes the current WAV file and spawns a decoder
func (md *MultiDecoder) closeAndDecode(band *DecoderBand) {
	ds := band.DecoderSession

	ds.mu.Lock()
	if ds.WavFile == nil {
		ds.mu.Unlock()
		return
	}

	filename := ds.Filename

	// Close WAV file
	if err := ds.WavFile.Close(); err != nil {
		log.Printf("Error closing WAV file %s: %v", filename, err)
	}

	ds.WavFile = nil
	ds.FileCycle = -1
	ds.mu.Unlock()

	// Spawn decoder in goroutine
	go func() {
		var outputFile, logFile string

		// Ensure cleanup always happens, even if errors occur
		defer func() {
			// Cleanup WAV file
			md.spawner.CleanupFiles(filename, "", band.Config.Mode)

			// Cleanup log file separately if we have one and keep_logs is false
			if logFile != "" && !md.config.KeepLogs {
				if removeErr := os.Remove(logFile); removeErr != nil && !os.IsNotExist(removeErr) {
					log.Printf("Warning: failed to remove log file %s: %v", logFile, removeErr)
				}
			}
		}()

		// SpawnDecoder now waits for the decoder process to complete before returning
		var execTime time.Duration
		var err error
		outputFile, logFile, execTime, err = md.spawner.SpawnDecoder(filename, band)
		if err != nil {
			log.Printf("Error spawning decoder for %s: %v", band.Config.Name, err)
			md.stats.IncrementErrors()
			return
		}

		// Process decoder output (decoder has already completed)
		decodes, err := md.spawner.ProcessDecoderOutput(outputFile, band, md.config.ReceiverLocator)
		if err != nil {
			log.Printf("Error processing decoder output for %s: %v", band.Config.Name, err)
			md.stats.IncrementErrors()
			// Don't return yet - we still want to clean up the log file
			// Continue to cleanup section below
		} else {
			// Update last data time only when decoder successfully completes
			band.mu.Lock()
			band.LastDataTime = time.Now()
			band.mu.Unlock()
		}

		// Update statistics
		md.stats.IncrementDecodes(band.Config.Name, int64(len(decodes)))

		// Record raw decode count (before parsing) for average per cycle metric
		if md.prometheusMetrics != nil && md.prometheusMetrics.digitalMetrics != nil {
			md.prometheusMetrics.digitalMetrics.RecordRawCycleDecodes(band.Config.Mode.String(), band.Config.Name, len(decodes))
		}

		if len(decodes) > 0 {
			// Get cycle time for this mode
			modeInfo := GetModeInfo(band.Config.Mode)
			cycleSeconds := int(modeInfo.CycleTime.Seconds())

			// Check if this is the first decode (check before recording)
			md.metricsFirstWriteMu.Lock()
			shouldWriteNow := !md.metricsFirstWriteDone && md.metricsLogger != nil
			if shouldWriteNow {
				md.metricsFirstWriteDone = true
			}
			md.metricsFirstWriteMu.Unlock()

			// Submit to PSKReporter/WSPRNet and notify callback
			for _, decode := range decodes {
				// Record individual decode with callsign for unique tracking and totals
				if md.prometheusMetrics != nil {
					md.prometheusMetrics.RecordDigitalDecode(decode.Mode, band.Config.Name, decode.Callsign, cycleSeconds)
				}

				// Record decode in summary aggregator (event-driven)
				if md.summaryAggregator != nil {
					md.summaryAggregator.RecordDecode(decode.Mode, band.Config.Name, decode.Timestamp)
				}

				// Log to CSV (independent of reporting)
				if md.spotsLogger != nil {
					// Check if we should only log spots with valid locators
					shouldLog := true
					if md.config.SpotsLogLocatorsOnly && !decode.HasLocator {
						shouldLog = false
					}

					if shouldLog {
						if err := md.spotsLogger.LogSpot(decode); err != nil {
							log.Printf("Warning: Failed to log spot to CSV: %v", err)
						}
					}
				}

				// Notify callback for websocket broadcasting
				md.notifyDecode(*decode)

				// Submit to PSKReporter (WSPR requires locator, FT8/FT4/JS8 do not)
				// This matches ka9q_multidecoder behavior which sends FT8/FT4/WSPR to PSKReporter
				if md.pskReporter != nil {
					shouldSubmit := decode.Mode != "WSPR" || decode.Locator != ""
					if shouldSubmit {
						if err := md.pskReporter.Submit(decode); err != nil {
							log.Printf("Warning: Failed to submit to PSKReporter: %v", err)
						} else {
							md.stats.IncrementPSKReporter(1)
						}
					}
				}

				// Submit to WSPRNet (WSPR only)
				if md.wsprNet != nil && decode.Mode == "WSPR" {
					if err := md.wsprNet.Submit(decode); err != nil {
						log.Printf("Warning: Failed to submit to WSPRNet: %v", err)
					} else {
						md.stats.IncrementWSPRNet(1)
					}
				}
			}

			md.stats.IncrementSpots(band.Config.Name, int64(len(decodes)))

			// Write metrics immediately if this was the first decode (after all decodes are recorded)
			if shouldWriteNow {
				log.Printf("First decode detected - writing initial metrics snapshot")
				if err := md.metricsLogger.WriteMetrics(md.prometheusMetrics.digitalMetrics); err != nil {
					log.Printf("Warning: Failed to write initial metrics: %v", err)
				}
			}
		}

		// Record execution time metric only if we successfully got one
		if err == nil && md.prometheusMetrics != nil {
			md.prometheusMetrics.digitalMetrics.RecordExecutionTime(band.Config.Mode.String(), band.Config.Name, execTime)
		}
	}()
}

// Stop shuts down the multi-decoder
func (md *MultiDecoder) Stop() {
	if md == nil || !md.running {
		return
	}

	md.running = false
	close(md.stopChan)
	md.wg.Wait()

	// Disable and remove all decoder channels
	if md.bandsReady {
		for bandName, band := range md.decoderBands {
			// Disable radiod channel
			channelName := fmt.Sprintf("decoder-%s", bandName)
			if err := md.radiod.DisableChannel(channelName, band.SSRC); err != nil {
				log.Printf("Warning: failed to disable %s channel: %v", bandName, err)
			}

			// Remove from session manager
			md.sessions.mu.Lock()
			delete(md.sessions.sessions, band.SessionID)
			delete(md.sessions.ssrcToSession, band.SSRC)
			md.sessions.mu.Unlock()

			// Close audio channel
			close(band.AudioChan)
		}
	}

	// Stop spot reporters
	if md.pskReporter != nil {
		md.pskReporter.Stop()
	}

	if md.wsprNet != nil {
		md.wsprNet.Stop()
	}

	// Close spots logger
	if md.spotsLogger != nil {
		if err := md.spotsLogger.Close(); err != nil {
			log.Printf("Warning: Failed to close spots logger: %v", err)
		}
	}

	// Close metrics logger
	if md.metricsLogger != nil {
		if err := md.metricsLogger.Close(); err != nil {
			log.Printf("Warning: Failed to close metrics logger: %v", err)
		}
	}

	log.Printf("Multi-decoder stopped (%d bands cleaned up)", len(md.decoderBands))
}

// GetStats returns current decoder statistics
func (md *MultiDecoder) GetStats() map[string]interface{} {
	if md == nil {
		return nil
	}
	return md.stats.GetStats()
}

// OnDecode registers a callback function to be called when a decode is completed
func (md *MultiDecoder) OnDecode(callback func(DecodeInfo)) {
	if md == nil {
		return
	}
	md.callbackMu.Lock()
	defer md.callbackMu.Unlock()
	md.onDecodeCallback = callback
}

// notifyDecode calls the registered callback with a decode
func (md *MultiDecoder) notifyDecode(decode DecodeInfo) {
	md.callbackMu.RLock()
	callback := md.onDecodeCallback
	md.callbackMu.RUnlock()

	if callback != nil {
		// Run in goroutine to avoid blocking decoder processing
		go callback(decode)
	}
}

// metricsWriteLoop periodically writes metrics snapshots to JSON Lines files
func (md *MultiDecoder) metricsWriteLoop() {
	defer md.wg.Done()

	log.Printf("Metrics write loop started")
	ticker := time.NewTicker(md.metricsLogger.writeInterval)
	defer ticker.Stop()

	for {
		select {
		case <-md.stopChan:
			// Write final metrics before stopping
			if err := md.metricsLogger.WriteMetrics(md.prometheusMetrics.digitalMetrics); err != nil {
				log.Printf("Warning: Failed to write final metrics: %v", err)
			}
			return

		case <-ticker.C:
			// Write metrics snapshot
			if err := md.metricsLogger.WriteMetrics(md.prometheusMetrics.digitalMetrics); err != nil {
				log.Printf("Warning: Failed to write metrics: %v", err)
			}

			// Write summary files to disk (summaries are updated in real-time via RecordDecode)
			if md.summaryAggregator != nil {
				if err := md.summaryAggregator.WriteIfNeeded(); err != nil {
					log.Printf("Warning: Failed to write summaries: %v", err)
				}
			}
		}
	}
}

// convertBigEndianToLittleEndian converts PCM int16 samples from big-endian to little-endian
func convertBigEndianToLittleEndian(data []byte) []byte {
	if len(data)%2 != 0 {
		log.Printf("Warning: PCM data length is not even (%d bytes), truncating", len(data))
		data = data[:len(data)-1]
	}

	numSamples := len(data) / 2
	result := make([]byte, len(data))

	for i := 0; i < numSamples; i++ {
		// Read as big-endian int16
		sample := int16(binary.BigEndian.Uint16(data[i*2 : i*2+2]))
		// Write as little-endian int16
		binary.LittleEndian.PutUint16(result[i*2:i*2+2], uint16(sample))
	}

	return result
}

package main

import (
	"bufio"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// RecordingState represents the state of the recording process
type RecordingState int

const (
	RecordingStateWaiting RecordingState = 0 // Coordinator started, waiting for first recording
	RecordingStateSuccess RecordingState = 1 // Recording successfully
	RecordingStateFailed  RecordingState = 2 // Recording failed
)

// WSPRCoordinator manages WSPR recording and decoding cycles
type WSPRCoordinator struct {
	config          *Config
	client          *KiwiClient
	wsprdPath       string
	workDir         string
	displayName     string // User-friendly name for GUI display
	uniqueID        string // Unique identifier for this coordinator (instance_frequency)
	mqttPublisher   *MQTTPublisher
	mqttTopicPrefix string // Optional MQTT topic prefix override for this instance
	oneShot         bool
	manager         *CoordinatorManager
	mu              sync.Mutex
	running         bool
	stopChan        chan struct{}
	lastDecodeTime  time.Time
	lastDecodeCount int
	recordingState  RecordingState // Current recording state
	lastError       string         // Track last error message
}

// WSPRDecode represents a decoded WSPR spot
type WSPRDecode struct {
	Timestamp time.Time
	SNR       int
	DT        float64
	Frequency float64
	Callsign  string
	Locator   string
	Power     int
	Drift     int
}

// WSPR regex pattern for standard wsprd output format
// Format: YYMMDD HHMM Seq SNR DT Freq Callsign Locator Power [extra columns]
var wsprPattern = regexp.MustCompile(`^(\d{6})\s+(\d{4})\s+\d+\s+(-?\d+)\s+([-\d.]+)\s+([\d.]+)\s+(\S+)\s+(.+)$`)

// NewWSPRCoordinator creates a new WSPR coordinator
// displayName is the user-friendly name for GUI display (from config)
// mqttTopicPrefix is an optional MQTT topic prefix override for this instance
func NewWSPRCoordinator(config *Config, wsprdPath, _, _, workDir, displayName, uniqueID string, mqttPublisher *MQTTPublisher, mqttTopicPrefix string, oneShot bool, manager *CoordinatorManager) *WSPRCoordinator {
	return &WSPRCoordinator{
		config:          config,
		wsprdPath:       wsprdPath,
		workDir:         workDir,
		displayName:     displayName,
		uniqueID:        uniqueID,
		mqttPublisher:   mqttPublisher,
		mqttTopicPrefix: mqttTopicPrefix,
		oneShot:         oneShot,
		manager:         manager,
		stopChan:        make(chan struct{}),
	}
}

// Start begins the WSPR recording and decoding cycle
func (wc *WSPRCoordinator) Start() error {
	wc.mu.Lock()
	wc.running = true
	wc.recordingState = RecordingStateWaiting // Start in waiting state
	wc.mu.Unlock()

	// Create unique work directory to avoid wsprd output file conflicts
	// Use instance_frequency format (e.g., kiwi1_14097)
	uniqueWorkDir := filepath.Join(wc.workDir, wc.uniqueID)
	if err := os.MkdirAll(uniqueWorkDir, 0755); err != nil {
		return fmt.Errorf("failed to create work directory: %w", err)
	}
	wc.workDir = uniqueWorkDir

	// Clean up any old WAV files from previous runs
	wc.cleanupOldWavFiles()

	log.Println("WSPR Coordinator: Starting...")
	log.Printf("WSPR Coordinator: Work directory: %s", wc.workDir)
	log.Printf("WSPR Coordinator: wsprd path: %s", wc.wsprdPath)

	// Start the recording/decoding loop immediately
	// It will sync to WSPR cycle boundaries internally
	go wc.recordingLoop()

	return nil
}

// cleanupOldWavFiles removes old WAV files from the work directory
func (wc *WSPRCoordinator) cleanupOldWavFiles() {
	pattern := filepath.Join(wc.workDir, "*_wspr.wav")
	files, err := filepath.Glob(pattern)
	if err != nil {
		log.Printf("WSPR Coordinator: Error finding old WAV files: %v", err)
		return
	}

	for _, file := range files {
		if err := os.Remove(file); err != nil {
			log.Printf("WSPR Coordinator: Error removing old WAV file %s: %v", file, err)
		} else {
			log.Printf("WSPR Coordinator: Removed old WAV file: %s", filepath.Base(file))
		}
	}
}

// waitForWSPRCycle waits until the start of the next WSPR cycle
func (wc *WSPRCoordinator) waitForWSPRCycle() {
	now := time.Now().UTC()

	// Calculate seconds until next even minute
	currentMinute := now.Minute()
	currentSecond := now.Second()

	// Round up to next even minute
	nextEvenMinute := currentMinute
	if currentMinute%2 == 1 {
		nextEvenMinute = currentMinute + 1
	} else if currentSecond > 0 {
		nextEvenMinute = currentMinute + 2
	}

	// Calculate wait time
	minutesToWait := nextEvenMinute - currentMinute
	secondsToWait := minutesToWait*60 - currentSecond

	if secondsToWait > 0 {
		log.Printf("WSPR Coordinator: Waiting %d seconds for next WSPR cycle...", secondsToWait)
		time.Sleep(time.Duration(secondsToWait) * time.Second)
	}

	log.Println("WSPR Coordinator: Synchronized to WSPR cycle")
}

// recordingLoop handles the continuous recording and decoding cycle
func (wc *WSPRCoordinator) recordingLoop() {
	// WSPR requires recordings to start exactly on even minute boundaries
	for {
		select {
		case <-wc.stopChan:
			log.Println("WSPR Coordinator: Stopping recording loop")
			return
		default:
		}

		// Wait until next WSPR cycle boundary (even minutes: 00, 02, 04, etc.)
		now := time.Now().UTC()
		currentMinute := now.Minute()
		currentSecond := now.Second()

		// Calculate next even minute
		nextEvenMinute := currentMinute
		if currentMinute%2 == 1 {
			nextEvenMinute = currentMinute + 1
		} else if currentSecond > 0 {
			nextEvenMinute = currentMinute + 2
		}

		// Wait until the cycle boundary
		minutesToWait := nextEvenMinute - currentMinute
		secondsToWait := minutesToWait*60 - currentSecond

		if secondsToWait > 0 {
			log.Printf("WSPR Coordinator: Waiting %d seconds for next WSPR cycle...", secondsToWait)
			time.Sleep(time.Duration(secondsToWait) * time.Second)
		}

		// Record one WSPR cycle (2 minutes) starting exactly now
		cycleStart := time.Now().UTC()
		log.Printf("WSPR Coordinator: Starting recording cycle at %s", cycleStart.Format("15:04:05"))

		wavFile, err := wc.recordCycle(cycleStart)
		if err != nil {
			log.Printf("WSPR Coordinator: Recording error: %v", err)
			
			// Track recording failure
			wc.mu.Lock()
			wc.recordingState = RecordingStateFailed
			wc.lastError = err.Error()
			wc.mu.Unlock()
			
			// Wait a bit before retrying
			time.Sleep(10 * time.Second)
			continue
		}
		
		// Track recording success
		wc.mu.Lock()
		wc.recordingState = RecordingStateSuccess
		wc.lastError = ""
		wc.mu.Unlock()

		// Decode the recording that just completed
		go func(file string, timestamp time.Time) {
			log.Printf("WSPR Coordinator: Decoding %s", filepath.Base(file))
			decodes, err := wc.decodeCycle(file, timestamp)
			if err != nil {
				log.Printf("WSPR Coordinator: Decoding error: %v", err)
			} else {
				// Update decode statistics
				wc.mu.Lock()
				wc.lastDecodeTime = time.Now()
				wc.lastDecodeCount = len(decodes)
				wc.mu.Unlock()
				
				if len(decodes) > 0 {
					log.Printf("WSPR Coordinator: Decoded %d spots from %s", len(decodes), timestamp.Format("15:04"))
					// Publish to MQTT
					if wc.mqttPublisher != nil {
						// Auto-calculate band name from frequency for MQTT topic consistency
						bandName := frequencyToBand(wc.config.Frequency)
						for _, decode := range decodes {
							if err := wc.mqttPublisher.PublishWSPRDecode(decode, bandName, uint64(wc.config.Frequency*1000), wc.mqttTopicPrefix); err != nil {
								log.Printf("MQTT publish error: %v", err)
							}
						}
					}
				} else {
					log.Printf("WSPR Coordinator: No spots decoded from %s", timestamp.Format("15:04"))
				}
			}

			// Clean up WAV file only if not in one-shot mode and not configured to keep
			if !wc.oneShot && wc.config.Filename == "" {
				os.Remove(file)
			}

			// Notify manager if in one-shot mode
			if wc.oneShot && wc.manager != nil {
				wc.manager.NotifyOneShotComplete()
			}
		}(wavFile, cycleStart)

		// Exit after one cycle in one-shot mode
		if wc.oneShot {
			log.Println("WSPR Coordinator: One-shot mode complete, stopping...")
			return
		}
	}
}

// recordCycle records one WSPR cycle (2 minutes) - creates new client each time for new file
func (wc *WSPRCoordinator) recordCycle(cycleStart time.Time) (string, error) {
	// Generate filename based on cycle start time
	// Frequency is already in kHz, use it directly for filename
	baseFilename := fmt.Sprintf("%s_%d_wspr.wav",
		cycleStart.Format("20060102_150405"),
		int(wc.config.Frequency))

	fullPath := filepath.Join(wc.workDir, baseFilename)

	// Close previous client if exists to start fresh recording
	if wc.client != nil {
		wc.client.Close()
		wc.client = nil
	}

	log.Printf("WSPR Coordinator: Starting recording to %s", baseFilename)

	// Create config for this recording cycle
	recordConfig := *wc.config
	// WSPR transmissions are ~110.6 seconds, record for 115 seconds to capture full transmission
	// This leaves 5 seconds before the next cycle for cleanup and connection setup
	recordConfig.Duration = 115 * time.Second
	recordConfig.Filename = baseFilename
	recordConfig.OutputDir = wc.workDir

	client, err := NewKiwiClient(&recordConfig)
	if err != nil {
		return "", fmt.Errorf("failed to create client: %w", err)
	}

	wc.client = client

	// Start client in background
	go func() {
		if err := client.Run(); err != nil {
			log.Printf("WSPR Coordinator: Client error: %v", err)
		}
	}()

	// Wait for the recording to complete (115 seconds)
	// This ensures we stop before the next WSPR cycle starts
	time.Sleep(115 * time.Second)
	
	// Close the client to ensure WAV file is flushed
	if wc.client != nil {
		wc.client.Close()
		wc.client = nil
	}

	// Give a moment for file to be fully written
	time.Sleep(100 * time.Millisecond)

	// Verify file was created
	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		return "", fmt.Errorf("WAV file was not created: %s", fullPath)
	}

	return fullPath, nil
}

// decodeCycle decodes a WSPR recording using wsprd
func (wc *WSPRCoordinator) decodeCycle(wavFile string, cycleStart time.Time) ([]*WSPRDecode, error) {
	// wsprd arguments: -f freq_MHz -C cycles -w wavfile
	freqMHz := fmt.Sprintf("%.6f", wc.config.Frequency/1000.0)

	// Check file exists and get size
	fileInfo, err := os.Stat(wavFile)
	if err != nil {
		return nil, fmt.Errorf("WAV file not found: %w", err)
	}
	log.Printf("WSPR Coordinator: WAV file size: %.2f MB", float64(fileInfo.Size())/(1024*1024))

	// Resample to 12000 Hz (wsprd requirement)
	log.Printf("WSPR Coordinator: Resampling to 12000 Hz...")
	resampledFile, err := ResampleWAVFile(wavFile, 12000)
	if err != nil {
		return nil, fmt.Errorf("failed to resample WAV file: %w", err)
	}

	// Clean up resampled file after decoding (if it's different from original and not in one-shot mode)
	if resampledFile != wavFile && !wc.oneShot {
		defer os.Remove(resampledFile)
	}

	// Rename to wsprd-compatible format: YYMMDD_HHMM.wav
	// wsprd expects this format to extract timestamp information
	wsprdFilename := filepath.Join(wc.workDir, fmt.Sprintf("%02d%02d%02d_%02d%02d.wav",
		cycleStart.Year()%100, cycleStart.Month(), cycleStart.Day(),
		cycleStart.Hour(), cycleStart.Minute()))

	// Remove original WAV file and rename resampled file
	if resampledFile != wavFile {
		os.Remove(wavFile) // Remove original non-resampled file
	}

	if err := os.Rename(resampledFile, wsprdFilename); err != nil {
		return nil, fmt.Errorf("failed to rename resampled file: %w", err)
	}

	// Restore the original filename after wsprd completes (if not in one-shot mode)
	if !wc.oneShot {
		defer func() {
			os.Rename(wsprdFilename, resampledFile)
		}()
	}

	// Build command - wsprd expects just the filename without path when run in the directory
	// Use 10000 cycles as default (same as ubersdr)
	cmd := exec.Command(wc.wsprdPath,
		"-f", freqMHz,
		"-C", "10000", // Cycles parameter (default for WSPR)
		"-w", filepath.Base(wsprdFilename))

	cmd.Dir = wc.workDir

	// Run wsprd
	log.Printf("WSPR Coordinator: Running wsprd -f %s -C 10000 -w %s", freqMHz, filepath.Base(wsprdFilename))
	startTime := time.Now()

	err = cmd.Run()
	duration := time.Since(startTime)

	if err != nil {
		log.Printf("WSPR Coordinator: wsprd error: %v", err)
		return nil, fmt.Errorf("wsprd failed: %w", err)
	}

	log.Printf("WSPR Coordinator: wsprd completed in %.1fs", duration.Seconds())

	// Parse wspr_spots.txt
	spotsFile := filepath.Join(wc.workDir, "wspr_spots.txt")
	decodes, err := wc.parseWSPRSpots(spotsFile)
	if err != nil {
		return nil, fmt.Errorf("failed to parse spots: %w", err)
	}

	return decodes, nil
}

// parseWSPRSpots parses the wspr_spots.txt file
func (wc *WSPRCoordinator) parseWSPRSpots(filename string) ([]*WSPRDecode, error) {
	file, err := os.Open(filename)
	if err != nil {
		if os.IsNotExist(err) {
			// No spots file means no decodes
			return []*WSPRDecode{}, nil
		}
		return nil, fmt.Errorf("failed to open spots file: %w", err)
	}
	defer file.Close()

	var decodes []*WSPRDecode
	scanner := bufio.NewScanner(file)

	for scanner.Scan() {
		line := scanner.Text()
		// Skip empty lines and status markers
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.Contains(trimmed, "<DecodeFinished>") {
			continue
		}
		// Skip lines with invalid callsigns like <...>
		if strings.Contains(trimmed, "<...>") {
			continue
		}
		decode, err := wc.parseWSPRLine(line)
		if err != nil {
			log.Printf("WSPR Coordinator: Failed to parse line: %v - Line: %q", err, line)
			continue
		}
		decodes = append(decodes, decode)
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("error reading spots file: %w", err)
	}

	return decodes, nil
}

// parseWSPRLine parses a single line from wspr_spots.txt
func (wc *WSPRCoordinator) parseWSPRLine(line string) (*WSPRDecode, error) {
	trimmed := strings.TrimSpace(line)
	matches := wsprPattern.FindStringSubmatch(trimmed)
	if matches == nil {
		return nil, fmt.Errorf("line does not match WSPR format")
	}

	// Parse date and time (YYMMDD HHMM)
	dateStr := matches[1]
	timeStr := matches[2]

	year, _ := strconv.Atoi("20" + dateStr[0:2])
	month, _ := strconv.Atoi(dateStr[2:4])
	day, _ := strconv.Atoi(dateStr[4:6])
	hour, _ := strconv.Atoi(timeStr[0:2])
	minute, _ := strconv.Atoi(timeStr[2:4])

	timestamp := time.Date(year, time.Month(month), day, hour, minute, 0, 0, time.UTC)

	// Parse SNR
	snr, _ := strconv.Atoi(matches[3])

	// Parse DT (time drift)
	dt, _ := strconv.ParseFloat(matches[4], 64)

	// Parse frequency (absolute frequency in MHz)
	freqMHz, _ := strconv.ParseFloat(matches[5], 64)

	// Parse callsign
	callsign := strings.Trim(strings.TrimSpace(matches[6]), "<>")

	// Parse remaining fields (grid and dBm)
	remaining := strings.Fields(strings.TrimSpace(matches[7]))
	if len(remaining) < 1 {
		return nil, fmt.Errorf("missing power field")
	}

	var locator string
	var power int

	// Check if first field is a grid locator or power
	if len(remaining) >= 2 && len(remaining[0]) >= 2 &&
		remaining[0][0] >= 'A' && remaining[0][0] <= 'R' {
		locator = remaining[0]
		power, _ = strconv.Atoi(remaining[1])
	} else {
		locator = ""
		power, _ = strconv.Atoi(remaining[0])
	}

	return &WSPRDecode{
		Timestamp: timestamp,
		SNR:       snr,
		DT:        dt,
		Frequency: freqMHz,
		Callsign:  callsign,
		Locator:   locator,
		Power:     power,
		Drift:     0,
	}, nil
}

// GetStatus returns the current status of this coordinator
// Returns: lastDecodeTime, lastDecodeCount, recordingState, lastError
func (wc *WSPRCoordinator) GetStatus() (time.Time, int, RecordingState, string) {
	wc.mu.Lock()
	defer wc.mu.Unlock()
	return wc.lastDecodeTime, wc.lastDecodeCount, wc.recordingState, wc.lastError
}

// UpdateMQTTPublisher updates the MQTT publisher for this coordinator
func (wc *WSPRCoordinator) UpdateMQTTPublisher(publisher *MQTTPublisher, topicPrefix string) {
	wc.mu.Lock()
	defer wc.mu.Unlock()
	wc.mqttPublisher = publisher
	wc.mqttTopicPrefix = topicPrefix
	log.Printf("WSPR Coordinator (%s): MQTT publisher and topic prefix updated to '%s'", wc.displayName, topicPrefix)
}

// Stop stops the WSPR coordinator
func (wc *WSPRCoordinator) Stop() {
	wc.mu.Lock()
	defer wc.mu.Unlock()

	if !wc.running {
		return
	}

	log.Println("WSPR Coordinator: Stopping...")
	close(wc.stopChan)

	// Close the client connection to ensure WAV file is properly closed
	if wc.client != nil {
		wc.client.Close()
		wc.client = nil
	}

	// Clean up any remaining WAV files only if not in one-shot mode
	if !wc.oneShot {
		wc.cleanupOldWavFiles()
	} else {
		log.Println("WSPR Coordinator: One-shot mode - keeping WAV files")
	}

	wc.running = false
}

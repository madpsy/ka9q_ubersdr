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

// WSPRCoordinator manages WSPR recording and decoding cycles
type WSPRCoordinator struct {
	config          *Config
	client          *KiwiClient
	wsprdPath       string
	receiverLocator string
	receiverCall    string
	workDir         string
	bandName        string
	mqttPublisher   *MQTTPublisher
	mu              sync.Mutex
	running         bool
	stopChan        chan struct{}
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

// WSPR regex pattern
var wsprPattern = regexp.MustCompile(`^(\d{6})\s+(\d{4})\s+\d+\s+(-?\d+)\s+([-\d.]+)\s+([\d.]+)\s+(\S+)\s+(.+)$`)

// NewWSPRCoordinator creates a new WSPR coordinator
func NewWSPRCoordinator(config *Config, wsprdPath, receiverLocator, receiverCall, workDir, bandName string, mqttPublisher *MQTTPublisher) *WSPRCoordinator {
	return &WSPRCoordinator{
		config:          config,
		wsprdPath:       wsprdPath,
		receiverLocator: receiverLocator,
		receiverCall:    receiverCall,
		workDir:         workDir,
		bandName:        bandName,
		mqttPublisher:   mqttPublisher,
		stopChan:        make(chan struct{}),
	}
}

// Start begins the WSPR recording and decoding cycle
func (wc *WSPRCoordinator) Start() error {
	wc.mu.Lock()
	wc.running = true
	wc.mu.Unlock()

	// Create work directory
	if err := os.MkdirAll(wc.workDir, 0755); err != nil {
		return fmt.Errorf("failed to create work directory: %w", err)
	}

	log.Println("WSPR Coordinator: Starting...")
	log.Printf("WSPR Coordinator: Work directory: %s", wc.workDir)
	log.Printf("WSPR Coordinator: wsprd path: %s", wc.wsprdPath)
	log.Printf("WSPR Coordinator: Receiver: %s @ %s", wc.receiverCall, wc.receiverLocator)

	// Wait until we're synchronized to a WSPR cycle boundary
	// WSPR transmissions start at even minutes (00, 02, 04, etc.)
	wc.waitForWSPRCycle()

	// Start the recording/decoding loop
	go wc.recordingLoop()

	return nil
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
	for {
		select {
		case <-wc.stopChan:
			log.Println("WSPR Coordinator: Stopping recording loop")
			return
		default:
		}

		// Record one WSPR cycle (2 minutes)
		cycleStart := time.Now().UTC()
		log.Printf("WSPR Coordinator: Starting recording cycle at %s", cycleStart.Format("15:04:05"))

		wavFile, err := wc.recordCycle(cycleStart)
		if err != nil {
			log.Printf("WSPR Coordinator: Recording error: %v", err)
			// Wait a bit before retrying
			time.Sleep(10 * time.Second)
			continue
		}

		// Decode the recording
		decodes, err := wc.decodeCycle(wavFile, cycleStart)
		if err != nil {
			log.Printf("WSPR Coordinator: Decoding error: %v", err)
		} else if len(decodes) > 0 {
			log.Printf("WSPR Coordinator: Decoded %d spots", len(decodes))
			for _, decode := range decodes {
				log.Printf("  %s: %s %s %ddBm SNR:%d",
					decode.Timestamp.Format("15:04"),
					decode.Callsign,
					decode.Locator,
					decode.Power,
					decode.SNR)

				// Publish to MQTT
				if wc.mqttPublisher != nil {
					if err := wc.mqttPublisher.PublishWSPRDecode(decode, wc.bandName, uint64(wc.config.Frequency*1000)); err != nil {
						log.Printf("MQTT publish error: %v", err)
					}
				}
			}
		} else {
			log.Println("WSPR Coordinator: No spots decoded")
		}

		// Clean up WAV file if configured
		if wc.config.Filename == "" {
			os.Remove(wavFile)
		}
	}
}

// recordCycle records one WSPR cycle (2 minutes) using persistent connection
func (wc *WSPRCoordinator) recordCycle(cycleStart time.Time) (string, error) {
	// Generate filename based on cycle start time
	filename := filepath.Join(wc.workDir,
		fmt.Sprintf("%s_%d_wspr.wav",
			cycleStart.Format("20060102_150405"),
			int(wc.config.Frequency*1000)))

	// Create client on first cycle or if disconnected
	if wc.client == nil {
		log.Printf("WSPR Coordinator: Establishing persistent connection to %s:%d",
			wc.config.ServerHost, wc.config.ServerPort)

		// Update config for continuous recording
		recordConfig := *wc.config
		recordConfig.Duration = 0 // Unlimited duration for persistent connection
		recordConfig.Filename = filename
		recordConfig.OutputDir = wc.workDir

		client, err := NewKiwiClient(&recordConfig)
		if err != nil {
			return "", fmt.Errorf("failed to create client: %w", err)
		}

		wc.client = client

		// Start client in background
		go func() {
			if err := wc.client.Run(); err != nil {
				log.Printf("WSPR Coordinator: Client error: %v", err)
				wc.client = nil // Will reconnect on next cycle
			}
		}()

		// Give it time to connect and start recording
		time.Sleep(2 * time.Second)
	}

	// Record for 2 minutes (WSPR cycle)
	// The client is already running, just wait for the cycle to complete
	time.Sleep(120 * time.Second)

	// Verify file was created
	if _, err := os.Stat(filename); os.IsNotExist(err) {
		return "", fmt.Errorf("WAV file was not created: %s", filename)
	}

	return filename, nil
}

// decodeCycle decodes a WSPR recording using wsprd
func (wc *WSPRCoordinator) decodeCycle(wavFile string, cycleStart time.Time) ([]*WSPRDecode, error) {
	// wsprd arguments: -f freq_MHz -C cycles -w wavfile
	freqMHz := fmt.Sprintf("%.6f", wc.config.Frequency/1000.0)

	// Build command
	cmd := exec.Command(wc.wsprdPath,
		"-f", freqMHz,
		"-C", "10000", // Default cycles
		"-w", wavFile)

	cmd.Dir = wc.workDir

	// Run wsprd
	log.Printf("WSPR Coordinator: Running wsprd on %s", filepath.Base(wavFile))
	startTime := time.Now()

	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("wsprd failed: %w\nOutput: %s", err, string(output))
	}

	duration := time.Since(startTime)
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
		decode, err := wc.parseWSPRLine(line)
		if err != nil {
			log.Printf("WSPR Coordinator: Failed to parse line: %v", err)
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

// Stop stops the WSPR coordinator
func (wc *WSPRCoordinator) Stop() {
	wc.mu.Lock()
	defer wc.mu.Unlock()

	if !wc.running {
		return
	}

	log.Println("WSPR Coordinator: Stopping...")
	close(wc.stopChan)
	wc.running = false
}

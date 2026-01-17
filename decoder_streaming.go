package main

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// decoder_streaming.go - Streaming decoder support for modes that require continuous audio feed
//
// This module provides support for decoders that process audio in real-time rather than
// in fixed time cycles. Unlike batch decoders (FT8/FT4/WSPR) that buffer audio to WAV files
// and spawn a decoder process per cycle, streaming decoders:
//
//   - Receive continuous PCM audio via stdin
//   - Run as persistent processes
//   - Output decodes in real-time via stdout
//   - Don't require cycle synchronization
//
// Example usage:
//
//   // Create streaming decoder for JS8 mode
//   decoder, err := NewStreamingDecoder(
//       "/usr/local/bin/js8",  // Path to decoder binary
//       band,                   // DecoderBand configuration
//       config,                 // DecoderConfig
//       ctyDatabase,            // Optional CTY database for enrichment
//   )
//   if err != nil {
//       log.Fatal(err)
//   }
//   defer decoder.Stop()
//
//   // Feed audio continuously
//   go func() {
//       for audioPacket := range band.AudioChan {
//           decoder.WriteAudio(audioPacket.PCMData)
//       }
//   }()
//
//   // Process decoded results
//   for decode := range decoder.GetResults() {
//       log.Printf("Decoded: %s from %s (SNR: %d dB)", decode.Message, decode.Callsign, decode.SNR)
//   }
//
// Supported output format (JS8-style):
//   TIME SNR DT FREQ MODE DIAL_FREQ CALLSIGN GRID MESSAGE
//   17:17:45 -27 -0.5 1502 A 7079502 MM7MMU <> MM7MMU: DL4VCW HEARING

// StreamingDecoder manages a persistent decoder process with continuous audio input
type StreamingDecoder struct {
	band        *DecoderBand
	config      *DecoderConfig
	binaryPath  string
	cmd         *exec.Cmd
	stdin       io.WriteCloser
	stdout      io.ReadCloser
	stderr      io.ReadCloser
	running     bool
	mu          sync.Mutex
	stopChan    chan struct{}
	resultChan  chan *DecodeInfo
	ctyDatabase *CTYDatabase
	restartChan chan struct{} // Signal to restart the decoder
}

// NewStreamingDecoder creates and starts a streaming decoder process
// binaryPath: path to the decoder binary
// band: decoder band configuration
// config: decoder configuration
// ctyDatabase: optional CTY database for callsign enrichment
func NewStreamingDecoder(binaryPath string, band *DecoderBand, config *DecoderConfig, ctyDatabase *CTYDatabase) (*StreamingDecoder, error) {
	// Build command arguments
	args := []string{
		"-f", fmt.Sprintf("%d", band.Config.Frequency), // Dial frequency in Hz
		"--stdin",                                  // Read audio from stdin
		"-d", fmt.Sprintf("%d", band.Config.Depth), // Decode depth
	}

	cmd := exec.Command(binaryPath, args...)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("failed to create stdin pipe: %w", err)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		return nil, fmt.Errorf("failed to create stdout pipe: %w", err)
	}

	stderr, err := cmd.StderrPipe()
	if err != nil {
		stdin.Close()
		stdout.Close()
		return nil, fmt.Errorf("failed to create stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		stdin.Close()
		stdout.Close()
		stderr.Close()
		return nil, fmt.Errorf("failed to start decoder: %w", err)
	}

	sd := &StreamingDecoder{
		band:        band,
		config:      config,
		binaryPath:  binaryPath,
		cmd:         cmd,
		stdin:       stdin,
		stdout:      stdout,
		stderr:      stderr,
		running:     true,
		stopChan:    make(chan struct{}),
		resultChan:  make(chan *DecodeInfo, 100),
		ctyDatabase: ctyDatabase,
		restartChan: make(chan struct{}, 1),
	}

	// Start output readers
	go sd.readStdout()
	go sd.readStderr()

	// Start process monitor for automatic restart
	go sd.monitorProcess()

	log.Printf("Started streaming decoder for %s (PID: %d, binary: %s)", band.Config.Name, cmd.Process.Pid, binaryPath)

	return sd, nil
}

// monitorProcess monitors the decoder process and restarts it if it exits unexpectedly
func (sd *StreamingDecoder) monitorProcess() {
	for {
		select {
		case <-sd.stopChan:
			// Normal shutdown requested
			return
		case <-sd.restartChan:
			// Restart requested
			log.Printf("Restarting streaming decoder for %s after 30 second delay...", sd.band.Config.Name)
			time.Sleep(30 * time.Second)

			// Check if we're still supposed to be running
			sd.mu.Lock()
			if !sd.running {
				sd.mu.Unlock()
				return
			}
			sd.mu.Unlock()

			// Restart the decoder
			if err := sd.restart(); err != nil {
				log.Printf("Failed to restart streaming decoder for %s: %v", sd.band.Config.Name, err)
				// Try again after another delay
				select {
				case sd.restartChan <- struct{}{}:
				default:
				}
			} else {
				log.Printf("Successfully restarted streaming decoder for %s", sd.band.Config.Name)
			}
		}
	}
}

// restart restarts the decoder process
func (sd *StreamingDecoder) restart() error {
	sd.mu.Lock()
	defer sd.mu.Unlock()

	// Build command arguments
	args := []string{
		"-f", fmt.Sprintf("%d", sd.band.Config.Frequency), // Dial frequency in Hz
		"--stdin",                                     // Read audio from stdin
		"-d", fmt.Sprintf("%d", sd.band.Config.Depth), // Decode depth
	}

	cmd := exec.Command(sd.binaryPath, args...)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("failed to create stdin pipe: %w", err)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		return fmt.Errorf("failed to create stdout pipe: %w", err)
	}

	stderr, err := cmd.StderrPipe()
	if err != nil {
		stdin.Close()
		stdout.Close()
		return fmt.Errorf("failed to create stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		stdin.Close()
		stdout.Close()
		stderr.Close()
		return fmt.Errorf("failed to start decoder: %w", err)
	}

	// Update decoder state
	sd.cmd = cmd
	sd.stdin = stdin
	sd.stdout = stdout
	sd.stderr = stderr

	// Restart output readers
	go sd.readStdout()
	go sd.readStderr()

	log.Printf("Restarted streaming decoder for %s (PID: %d)", sd.band.Config.Name, cmd.Process.Pid)

	return nil
}

// WriteAudio sends PCM audio data to the decoder's stdin
// pcmData: raw PCM audio bytes (16-bit little-endian samples)
func (sd *StreamingDecoder) WriteAudio(pcmData []byte) error {
	sd.mu.Lock()
	defer sd.mu.Unlock()

	if !sd.running {
		return fmt.Errorf("decoder not running")
	}

	if sd.stdin == nil {
		return fmt.Errorf("stdin pipe not available")
	}

	_, err := sd.stdin.Write(pcmData)
	if err != nil {
		log.Printf("Error writing to decoder stdin for %s: %v", sd.band.Config.Name, err)
		return fmt.Errorf("failed to write audio: %w", err)
	}

	return nil
}

// readStdout continuously reads and parses decoder output
func (sd *StreamingDecoder) readStdout() {
	scanner := bufio.NewScanner(sd.stdout)

	for scanner.Scan() {
		line := scanner.Text()

		// Always log stdout from JS8 to help with debugging
		log.Printf("JS8 stdout [%s]: %s", sd.band.Config.Name, line)

		// Parse the output line
		decode, err := ParseStreamingDecoderLine(line, sd.band.Config.Frequency, sd.config.ReceiverLocator, sd.ctyDatabase)
		if err != nil {
			log.Printf("JS8 parse error [%s]: %v (line: %s)", sd.band.Config.Name, err, line)
			continue
		}

		// Set band name and mode
		decode.BandName = sd.band.Config.Name
		decode.Mode = sd.band.Config.Mode.String()

		// Send to result channel
		select {
		case sd.resultChan <- decode:
			// Successfully sent
		default:
			log.Printf("Warning: result channel full for %s, dropping decode", sd.band.Config.Name)
		}
	}

	if err := scanner.Err(); err != nil {
		log.Printf("Error reading decoder stdout for %s: %v", sd.band.Config.Name, err)
	}

	log.Printf("Decoder stdout reader exited for %s", sd.band.Config.Name)

	// Check if this was an unexpected exit (not during shutdown)
	sd.mu.Lock()
	stillRunning := sd.running
	sd.mu.Unlock()

	if stillRunning {
		log.Printf("Streaming decoder for %s exited unexpectedly, scheduling restart", sd.band.Config.Name)
		// Signal restart (non-blocking)
		select {
		case sd.restartChan <- struct{}{}:
		default:
			// Restart already scheduled
		}
	}
}

// readStderr logs decoder error output to stdout
func (sd *StreamingDecoder) readStderr() {
	scanner := bufio.NewScanner(sd.stderr)
	for scanner.Scan() {
		line := scanner.Text()
		// Log all stderr output to stdout (same as other logs)
		if strings.TrimSpace(line) != "" {
			log.Printf("JS8 [%s]: %s", sd.band.Config.Name, line)
		}
	}

	if err := scanner.Err(); err != nil {
		log.Printf("Error reading JS8 stderr for %s: %v", sd.band.Config.Name, err)
	}
}

// GetResults returns the channel for receiving decode results
func (sd *StreamingDecoder) GetResults() <-chan *DecodeInfo {
	return sd.resultChan
}

// IsRunning returns true if the decoder is still running
func (sd *StreamingDecoder) IsRunning() bool {
	sd.mu.Lock()
	defer sd.mu.Unlock()
	return sd.running
}

// Stop gracefully stops the decoder
func (sd *StreamingDecoder) Stop() error {
	sd.mu.Lock()
	if !sd.running {
		sd.mu.Unlock()
		return nil
	}
	sd.running = false
	sd.mu.Unlock()

	close(sd.stopChan)

	// Close stdin to signal decoder to exit
	if sd.stdin != nil {
		sd.stdin.Close()
	}

	// Wait for process to exit (with timeout)
	done := make(chan error, 1)
	go func() {
		done <- sd.cmd.Wait()
	}()

	var exitErr error
	select {
	case err := <-done:
		if err != nil {
			log.Printf("Streaming decoder for %s exited with error: %v", sd.band.Config.Name, err)
		} else {
			log.Printf("Streaming decoder for %s exited cleanly", sd.band.Config.Name)
		}
		exitErr = err
	case <-time.After(5 * time.Second):
		log.Printf("Streaming decoder for %s did not exit within timeout, killing", sd.band.Config.Name)
		if err := sd.cmd.Process.Kill(); err != nil {
			exitErr = fmt.Errorf("failed to kill decoder: %w", err)
		} else {
			exitErr = fmt.Errorf("decoder killed after timeout")
		}
	}

	// Close result channel to unblock any goroutines reading from it
	// This must be done after the process has exited to ensure no more results will be sent
	close(sd.resultChan)

	return exitErr
}

// ParseStreamingDecoderLine parses a line of streaming decoder output (JS8Call format)
//
// Format: TIME SNR DT FREQ MODE DIAL_FREQ CALLSIGN GRID MESSAGE
//
// Example lines:
//
//	17:17:45 -27 -0.5 1502 A 7079502 MM7MMU     <>     MM7MMU: DL4VCW HEARING
//	17:10:30 -14 -0.7  695 A 7078695 DL3KAN     JO30   DL3KAN: @HB HEARTBEAT JO30
//	17:18:00 -24 -0.5 1503 A 7079503 <>         <>     DL3KAN IU2ITE
//
// Field descriptions:
//
//	TIME:      HH:MM:SS format (UTC time when signal was decoded)
//	SNR:       Signal-to-noise ratio in dB (can be negative)
//	DT:        Time offset/drift in seconds (positive or negative)
//	FREQ:      Frequency offset from dial frequency in Hz
//	MODE:      Single letter JS8 submode indicator:
//	           'A' = Normal mode
//	           'B' = Fast mode
//	           'C' = Turbo mode
//	           'E' = Slow mode
//	           Other letters may exist for different JS8 submodes
//	DIAL_FREQ: Dial/center frequency in Hz (e.g., 7078695 = 7.078695 MHz)
//	CALLSIGN:  Transmitting station's callsign
//	           '<>' means no callsign available (empty field)
//	GRID:      Maidenhead grid locator (e.g., JO30, BL97)
//	           '<>' means no grid locator available (empty field)
//	MESSAGE:   Decoded message text (everything after GRID field)
//	           Examples:
//	           - "DL3KAN: @HB HEARTBEAT JO30" (heartbeat with grid)
//	           - "MM7MMU: DL4VCW HEARING" (directed message)
//	           - "DL3KAN IU2ITE" (callsigns only, no sender in CALLSIGN field)
//
// Note: The '<>' placeholder indicates missing/empty data for CALLSIGN and/or GRID fields.
// When CALLSIGN is '<>', the actual callsign(s) may be in the MESSAGE field instead.
func ParseStreamingDecoderLine(line string, dialFreq uint64, receiverLocator string, ctyDatabase *CTYDatabase) (*DecodeInfo, error) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return nil, fmt.Errorf("empty line")
	}

	// Split by whitespace (handles multiple spaces)
	parts := strings.Fields(trimmed)
	if len(parts) < 9 {
		return nil, fmt.Errorf("insufficient fields: %d (need at least 9)", len(parts))
	}

	// Parse time (HH:MM:SS)
	timeStr := parts[0]
	timeParts := strings.Split(timeStr, ":")
	if len(timeParts) != 3 {
		return nil, fmt.Errorf("invalid time format: %s", timeStr)
	}

	hour, err := strconv.Atoi(timeParts[0])
	if err != nil {
		return nil, fmt.Errorf("invalid hour: %w", err)
	}

	minute, err := strconv.Atoi(timeParts[1])
	if err != nil {
		return nil, fmt.Errorf("invalid minute: %w", err)
	}

	second, err := strconv.Atoi(timeParts[2])
	if err != nil {
		return nil, fmt.Errorf("invalid second: %w", err)
	}

	// Parse SNR
	snr, err := strconv.Atoi(parts[1])
	if err != nil {
		return nil, fmt.Errorf("invalid SNR: %w", err)
	}

	// Parse DT (time offset)
	dt, err := strconv.ParseFloat(parts[2], 32)
	if err != nil {
		return nil, fmt.Errorf("invalid DT: %w", err)
	}

	// Parse frequency offset (audio tone frequency within passband)
	// Note: This is not added to the dial frequency - it's just the audio tone
	_, err = strconv.Atoi(parts[3])
	if err != nil {
		return nil, fmt.Errorf("invalid frequency offset: %w", err)
	}

	// parts[4] is the JS8 submode flag (e.g., 'A' for Normal, 'B' for Fast, 'C' for Turbo, 'E' for Slow)
	submode := parts[4]

	// Parse dial frequency (parts[5])
	dialFromOutput, err := strconv.ParseUint(parts[5], 10, 64)
	if err != nil {
		return nil, fmt.Errorf("invalid dial frequency: %w", err)
	}

	// Callsign is parts[6]
	callsign := strings.Trim(parts[6], "<>")
	if callsign == "" || callsign == "<>" {
		// No callsign in this field
		callsign = ""
	}

	// Grid is parts[7]
	grid := strings.Trim(parts[7], "<>")
	if grid == "" || grid == "<>" {
		grid = ""
	}

	// Message is everything from parts[8] onwards
	message := strings.Join(parts[8:], " ")

	// Note: dialFromOutput (field 5) is already the complete frequency to report.
	// Field 3 (freqOffset) is the audio frequency within the passband, not to be added.
	// For example: "18:09:45 0 -1.0 1356 A 7079356 F4JKS JN03 ..."
	//   - 1356 is the audio tone frequency (field 3)
	//   - 7079356 is the actual RF frequency to report (field 5)

	// Create timestamp from time string
	now := time.Now().UTC()
	timestamp := time.Date(now.Year(), now.Month(), now.Day(), hour, minute, second, 0, time.UTC)

	// If timestamp is in the future, it's from yesterday
	if timestamp.After(now) {
		timestamp = timestamp.Add(-24 * time.Hour)
	}

	decode := &DecodeInfo{
		Timestamp:     timestamp,
		SNR:           snr,
		DT:            float32(dt),
		Frequency:     dialFromOutput, // Use dial frequency directly (field 5)
		Submode:       submode,        // JS8 submode (A/B/C/E)
		Callsign:      callsign,
		Locator:       grid,
		Message:       message,
		HasLocator:    grid != "" && len(grid) >= 4,
		HasCallsign:   callsign != "" && isValidCallsign(callsign),
		DialFrequency: dialFromOutput,
	}

	// Enrich with CTY data if available and callsign is present
	if ctyDatabase != nil && decode.HasCallsign {
		info := ctyDatabase.LookupCallsignFull(callsign)
		if info != nil {
			decode.Country = info.Country
			decode.CQZone = info.CQZone
			decode.ITUZone = info.ITUZone
			decode.Continent = info.Continent
			decode.TimeOffset = info.TimeOffset
		}
	}

	// Calculate distance/bearing if both locators available
	if receiverLocator != "" && decode.Locator != "" && len(decode.Locator) >= 4 {
		if dist, bearing, err := CalculateDistanceAndBearingFromLocators(receiverLocator, decode.Locator); err == nil {
			decode.DistanceKm = &dist
			decode.BearingDeg = &bearing
		}
	}

	return decode, nil
}

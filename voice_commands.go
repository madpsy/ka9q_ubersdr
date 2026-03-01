package main

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/cwsl/ka9q_ubersdr/audio_extensions/whisper"
	"github.com/gorilla/websocket"
)

/*
 * Voice Commands Handler
 * Processes voice commands from browser microphone using Whisper speech-to-text
 * Integrates with DX cluster WebSocket for communication
 */

// VoiceCommandHandler manages voice command processing
type VoiceCommandHandler struct {
	config          WhisperConfig
	sessions        *SessionManager
	whisperDecoders map[string]*whisper.WhisperDecoder // Per-session decoders
	decodersMu      sync.RWMutex

	// Per-session audio channels for voice commands
	audioChannels map[string]chan whisper.AudioSample
	audioChanMu   sync.RWMutex

	// Per-session state (volume, mute, etc.)
	sessionState map[string]*VoiceCommandSessionState
	stateMu      sync.RWMutex

	// Command parsing
	commandPatterns map[string]*regexp.Regexp
}

// Security constants for voice command validation
const (
	MaxAudioChunkSize    = 128 * 1024 // 128KB max per audio chunk (generous for streaming chunks)
	MaxAudioChunksPerSec = 50         // Max 50 chunks per second (reasonable for 16kHz audio)
	MaxTotalAudioBytes   = 512 * 1024 // 512KB max total audio per session (10 sec @ 16kHz = ~320KB)
	MaxTranscriptionLen  = 500        // Max transcription length to process
)

// VoiceCommandSessionState stores per-session state for voice commands
type VoiceCommandSessionState struct {
	PreMuteGain      float64
	StartTime        time.Time // Track when voice command started
	AudioChunkCount  int       // Number of audio chunks received
	TotalAudioBytes  int64     // Total bytes of audio received
	LastChunkTime    time.Time // Time of last audio chunk (for rate limiting)
	ChunksThisSecond int       // Number of chunks in current second
	LastSecondStart  time.Time // Start of current second window
}

// NewVoiceCommandHandler creates a new voice command handler
func NewVoiceCommandHandler(config WhisperConfig, sessions *SessionManager) *VoiceCommandHandler {
	vch := &VoiceCommandHandler{
		config:          config,
		sessions:        sessions,
		whisperDecoders: make(map[string]*whisper.WhisperDecoder),
		audioChannels:   make(map[string]chan whisper.AudioSample),
		sessionState:    make(map[string]*VoiceCommandSessionState),
		commandPatterns: make(map[string]*regexp.Regexp),
	}

	// Initialize command patterns
	vch.initCommandPatterns()

	return vch
}

// initCommandPatterns initializes regex patterns for command parsing
func (vch *VoiceCommandHandler) initCommandPatterns() {
	// Frequency patterns
	vch.commandPatterns["tune_mhz"] = regexp.MustCompile(`(?i)tune\s+(?:to\s+)?(\d+(?:\.\d+)?)\s*(?:mega\s*hertz|mhz|megahertz)`)
	vch.commandPatterns["tune_khz"] = regexp.MustCompile(`(?i)tune\s+(?:to\s+)?(\d+(?:\.\d+)?)\s*(?:kilo\s*hertz|khz|kilohertz)`)
	vch.commandPatterns["frequency_mhz"] = regexp.MustCompile(`(?i)(?:go\s+to|set\s+frequency\s+to)\s+(\d+(?:\.\d+)?)\s*(?:mega\s*hertz|mhz|megahertz)`)
	vch.commandPatterns["frequency_khz"] = regexp.MustCompile(`(?i)(?:go\s+to|set\s+frequency\s+to)\s+(\d+(?:\.\d+)?)\s*(?:kilo\s*hertz|khz|kilohertz)`)

	// Mode patterns
	vch.commandPatterns["mode"] = regexp.MustCompile(`(?i)(?:switch\s+to|change\s+mode\s+to|set\s+mode\s+to)\s+(usb|lsb|am|fm|cw|cwu|cwl|nfm)`)

	// Volume patterns
	vch.commandPatterns["volume_set"] = regexp.MustCompile(`(?i)(?:set\s+volume\s+to|volume)\s+(\d+)\s*(?:percent|%)?`)
	vch.commandPatterns["volume_up"] = regexp.MustCompile(`(?i)(?:increase|raise|turn\s+up)\s+volume`)
	vch.commandPatterns["volume_down"] = regexp.MustCompile(`(?i)(?:decrease|lower|turn\s+down)\s+volume`)
	vch.commandPatterns["mute"] = regexp.MustCompile(`(?i)mute`)
	vch.commandPatterns["unmute"] = regexp.MustCompile(`(?i)unmute`)

	// Bandwidth patterns
	vch.commandPatterns["bandwidth"] = regexp.MustCompile(`(?i)(?:set\s+bandwidth\s+to|bandwidth)\s+(\d+(?:\.\d+)?)\s*(?:kilo\s*hertz|khz|kilohertz)`)

	// Recording patterns
	vch.commandPatterns["start_recording"] = regexp.MustCompile(`(?i)start\s+recording`)
	vch.commandPatterns["stop_recording"] = regexp.MustCompile(`(?i)stop\s+recording`)
}

// HandleVoiceCommandMessage processes voice command messages from WebSocket
func (vch *VoiceCommandHandler) HandleVoiceCommandMessage(sessionID string, conn *websocket.Conn, msg map[string]interface{}) error {
	msgType, ok := msg["type"].(string)
	if !ok {
		return fmt.Errorf("missing message type")
	}

	switch msgType {
	case "voice_command":
		// New buffered approach - complete audio in one message
		return vch.handleCompleteAudio(sessionID, conn, msg)
	case "voice_command_start":
		return vch.handleStart(sessionID, conn, msg)
	case "voice_command_audio":
		return vch.handleAudio(sessionID, conn, msg)
	case "voice_command_stop":
		return vch.handleStop(sessionID, conn)
	default:
		return fmt.Errorf("unknown voice command message type: %s", msgType)
	}
}

// handleStart starts voice command processing for a session
func (vch *VoiceCommandHandler) handleStart(sessionID string, conn *websocket.Conn, msg map[string]interface{}) error {
	if !vch.config.Enabled || !vch.config.EnableVoiceCommands {
		return vch.sendError(conn, "Voice commands are not enabled")
	}

	// Note: sessionID here is the DX cluster WebSocket userSessionID, not an audio session ID
	// Voice commands work independently of audio sessions

	vch.decodersMu.Lock()
	defer vch.decodersMu.Unlock()

	// Check if already running
	if _, exists := vch.whisperDecoders[sessionID]; exists {
		return vch.sendError(conn, "Voice commands already active")
	}

	// Create Whisper decoder configuration
	whisperConfig := whisper.WhisperConfig{
		Enabled:             vch.config.Enabled,
		ServerURL:           vch.config.ServerURL,
		Model:               vch.config.Model,
		Language:            vch.config.Language,
		Translate:           vch.config.Translate,
		SendIntervalMs:      vch.config.SendIntervalMs,
		InitialPrompt:       "Voice commands for radio control: tune, frequency, mode, volume, bandwidth, recording.",
		EnableVoiceCommands: vch.config.EnableVoiceCommands,
	}

	// Create decoder (16kHz is standard for browser audio)
	decoder := whisper.NewWhisperDecoder(16000, whisperConfig)

	// Create channels for audio and results
	audioChan := make(chan whisper.AudioSample, 100)
	resultChan := make(chan []byte, 100)

	// Start decoder
	if err := decoder.Start(audioChan, resultChan); err != nil {
		return vch.sendError(conn, fmt.Sprintf("Failed to start voice command decoder: %v", err))
	}

	// Store decoder
	vch.whisperDecoders[sessionID] = decoder

	// Start result processor
	go vch.processResults(sessionID, conn, resultChan)

	// Store audio channel for later use
	vch.audioChanMu.Lock()
	vch.audioChannels[sessionID] = audioChan
	vch.audioChanMu.Unlock()

	// Initialize session state with start time and security tracking
	now := time.Now()
	vch.stateMu.Lock()
	vch.sessionState[sessionID] = &VoiceCommandSessionState{
		StartTime:       now,
		LastChunkTime:   now,
		LastSecondStart: now,
	}
	vch.stateMu.Unlock()

	// Start timeout timer (10 seconds)
	go vch.enforceTimeout(sessionID, conn)

	log.Printf("[VoiceCommands] Started for session %s", sessionID)

	return vch.sendMessage(conn, map[string]interface{}{
		"type":    "voice_command_started",
		"message": "Voice commands activated",
	})
}

// enforceTimeout automatically stops voice command after 10 seconds
func (vch *VoiceCommandHandler) enforceTimeout(sessionID string, conn *websocket.Conn) {
	// Wait for 10 seconds
	time.Sleep(10 * time.Second)

	// Check if session still exists
	vch.stateMu.RLock()
	state, exists := vch.sessionState[sessionID]
	vch.stateMu.RUnlock()

	if !exists {
		// Already stopped
		return
	}

	// Check if we've exceeded 10 seconds from start time
	if time.Since(state.StartTime) >= 10*time.Second {
		log.Printf("[VoiceCommands] Timeout reached for session %s, stopping", sessionID)

		// Stop the voice command session
		vch.handleStop(sessionID, conn)

		// Send timeout notification to client
		vch.sendMessage(conn, map[string]interface{}{
			"type":    "voice_command_timeout",
			"message": "Voice command timeout (10 seconds maximum)",
		})
	}
}

// handleAudio processes incoming audio data from browser
func (vch *VoiceCommandHandler) handleAudio(sessionID string, conn *websocket.Conn, msg map[string]interface{}) error {
	// Get audio data (base64 encoded)
	audioDataStr, ok := msg["audio"].(string)
	if !ok {
		return vch.sendError(conn, "missing audio data")
	}

	// Validate base64 string length before decoding (prevent excessive memory allocation)
	if len(audioDataStr) > MaxAudioChunkSize*2 { // base64 is ~1.33x larger, use 2x for safety
		log.Printf("[VoiceCommands] Audio chunk too large for session %s: %d bytes (base64)", sessionID, len(audioDataStr))
		return vch.sendError(conn, "audio chunk too large")
	}

	// Decode base64
	audioData, err := base64.StdEncoding.DecodeString(audioDataStr)
	if err != nil {
		return vch.sendError(conn, "failed to decode audio data")
	}

	// Validate decoded audio size
	audioSize := int64(len(audioData))
	if audioSize > MaxAudioChunkSize {
		log.Printf("[VoiceCommands] Audio chunk exceeds limit for session %s: %d bytes", sessionID, audioSize)
		return vch.sendError(conn, fmt.Sprintf("audio chunk exceeds %d byte limit", MaxAudioChunkSize))
	}

	// Get and validate session state
	vch.stateMu.Lock()
	state, exists := vch.sessionState[sessionID]
	if !exists {
		vch.stateMu.Unlock()
		return vch.sendError(conn, "voice command session not found")
	}

	// Rate limiting: check chunks per second
	now := time.Now()
	if now.Sub(state.LastSecondStart) >= time.Second {
		// New second window
		state.LastSecondStart = now
		state.ChunksThisSecond = 0
	}
	state.ChunksThisSecond++
	if state.ChunksThisSecond > MaxAudioChunksPerSec {
		vch.stateMu.Unlock()
		log.Printf("[VoiceCommands] Rate limit exceeded for session %s: %d chunks/sec", sessionID, state.ChunksThisSecond)
		return vch.sendError(conn, "rate limit exceeded: too many audio chunks per second")
	}

	// Check total audio bytes limit
	state.TotalAudioBytes += audioSize
	if state.TotalAudioBytes > MaxTotalAudioBytes {
		vch.stateMu.Unlock()
		log.Printf("[VoiceCommands] Total audio limit exceeded for session %s: %d bytes", sessionID, state.TotalAudioBytes)
		// Stop the session
		vch.handleStop(sessionID, conn)
		return vch.sendError(conn, fmt.Sprintf("total audio limit exceeded (%d KB maximum)", MaxTotalAudioBytes/1024))
	}

	// Update tracking
	state.AudioChunkCount++
	state.LastChunkTime = now
	vch.stateMu.Unlock()

	// Get audio channel
	vch.audioChanMu.RLock()
	audioChan, exists := vch.audioChannels[sessionID]
	vch.audioChanMu.RUnlock()

	if !exists {
		return vch.sendError(conn, "voice command not started")
	}

	// Convert audio data to PCM samples
	// Assuming browser sends Float32 PCM data
	pcmSamples := vch.convertAudioToPCM(audioData)

	// Send to decoder
	select {
	case audioChan <- whisper.AudioSample{
		PCMData:      pcmSamples,
		RTPTimestamp: 0,
		GPSTimeNs:    time.Now().UnixNano(),
	}:
	default:
		log.Printf("[VoiceCommands] Audio channel full for session %s, dropping sample", sessionID)
	}

	return nil
}

// handleStop stops voice command processing for a session
func (vch *VoiceCommandHandler) handleStop(sessionID string, conn *websocket.Conn) error {
	vch.decodersMu.Lock()
	decoder, exists := vch.whisperDecoders[sessionID]
	if exists {
		delete(vch.whisperDecoders, sessionID)
	}
	vch.decodersMu.Unlock()

	if !exists {
		return nil // Already stopped
	}

	// Stop decoder
	if err := decoder.Stop(); err != nil {
		log.Printf("[VoiceCommands] Error stopping decoder for session %s: %v", sessionID, err)
	}

	// Clean up audio channel
	vch.audioChanMu.Lock()
	if audioChan, exists := vch.audioChannels[sessionID]; exists {
		close(audioChan)
		delete(vch.audioChannels, sessionID)
	}
	vch.audioChanMu.Unlock()

	// Clean up session state
	vch.stateMu.Lock()
	delete(vch.sessionState, sessionID)
	vch.stateMu.Unlock()

	log.Printf("[VoiceCommands] Stopped for session %s", sessionID)

	return vch.sendMessage(conn, map[string]interface{}{
		"type":    "voice_command_stopped",
		"message": "Voice commands deactivated",
	})
}

// handleCompleteAudio handles complete buffered audio in one message
func (vch *VoiceCommandHandler) handleCompleteAudio(sessionID string, conn *websocket.Conn, msg map[string]interface{}) error {
	if !vch.config.Enabled || !vch.config.EnableVoiceCommands {
		return vch.sendError(conn, "Voice commands are not enabled")
	}

	// Get audio data (base64 encoded)
	audioDataStr, ok := msg["audio"].(string)
	if !ok {
		return vch.sendError(conn, "missing audio data")
	}

	// Validate base64 string length before decoding
	if len(audioDataStr) > MaxTotalAudioBytes*2 {
		log.Printf("[VoiceCommands] Audio too large for session %s: %d bytes (base64)", sessionID, len(audioDataStr))
		return vch.sendError(conn, "audio too large")
	}

	// Decode base64
	audioData, err := base64.StdEncoding.DecodeString(audioDataStr)
	if err != nil {
		return vch.sendError(conn, "failed to decode audio data")
	}

	// Validate decoded audio size
	audioSize := int64(len(audioData))
	if audioSize > MaxTotalAudioBytes {
		log.Printf("[VoiceCommands] Audio exceeds limit for session %s: %d bytes", sessionID, audioSize)
		return vch.sendError(conn, fmt.Sprintf("audio exceeds %d KB limit", MaxTotalAudioBytes/1024))
	}

	if audioSize == 0 {
		return vch.sendError(conn, "no audio data received")
	}

	log.Printf("[VoiceCommands] Received complete audio for session %s: %d bytes", sessionID, audioSize)

	// Create Whisper decoder configuration
	whisperConfig := whisper.WhisperConfig{
		Enabled:             vch.config.Enabled,
		ServerURL:           vch.config.ServerURL,
		Model:               vch.config.Model,
		Language:            vch.config.Language,
		Translate:           vch.config.Translate,
		SendIntervalMs:      vch.config.SendIntervalMs,
		InitialPrompt:       "Voice commands for radio control: tune, frequency, mode, volume, bandwidth, recording.",
		EnableVoiceCommands: vch.config.EnableVoiceCommands,
	}

	// Create decoder (16kHz is standard for browser audio)
	decoder := whisper.NewWhisperDecoder(16000, whisperConfig)

	// Create channels for audio and results
	audioChan := make(chan whisper.AudioSample, 100)
	resultChan := make(chan []byte, 100)

	// Start decoder
	if err := decoder.Start(audioChan, resultChan); err != nil {
		log.Printf("[VoiceCommands] Failed to start decoder for session %s: %v", sessionID, err)
		return vch.sendError(conn, "failed to start speech recognition")
	}

	log.Printf("[VoiceCommands] Started decoder for session %s", sessionID)

	// Process results in background
	go vch.processResults(sessionID, conn, resultChan)

	// Send all audio at once through the channel
	// Convert byte array to int16 samples
	numSamples := len(audioData) / 2
	pcmData := make([]int16, numSamples)
	for i := 0; i < numSamples; i++ {
		pcmData[i] = int16(binary.LittleEndian.Uint16(audioData[i*2 : i*2+2]))
	}

	durationSeconds := float64(numSamples) / 16000.0
	log.Printf("[VoiceCommands] Sending audio to WhisperLive: %d bytes, %d samples, %.2f seconds @ 16kHz",
		audioSize, numSamples, durationSeconds)

	// Send as a single AudioSample
	audioChan <- whisper.AudioSample{
		PCMData:      pcmData,
		RTPTimestamp: 0,
		GPSTimeNs:    time.Now().UnixNano(),
	}

	log.Printf("[VoiceCommands] Audio sent to decoder, waiting for transcription...")

	// Close audio channel to signal end of audio
	close(audioChan)

	// Wait a bit for processing to complete
	time.Sleep(3 * time.Second)

	// Stop decoder
	if err := decoder.Stop(); err != nil {
		log.Printf("[VoiceCommands] Error stopping decoder for session %s: %v", sessionID, err)
	}

	log.Printf("[VoiceCommands] Completed processing for session %s", sessionID)

	return nil
}

// processResults processes transcription results and executes commands
func (vch *VoiceCommandHandler) processResults(sessionID string, conn *websocket.Conn, resultChan <-chan []byte) {
	segmentCount := 0
	for result := range resultChan {
		// Decode result
		if len(result) < 13 {
			continue
		}

		msgType := result[0]
		// timestamp := binary.BigEndian.Uint64(result[1:9])
		jsonLength := binary.BigEndian.Uint32(result[9:13])

		if len(result) < 13+int(jsonLength) {
			continue
		}

		jsonData := result[13 : 13+jsonLength]

		// Handle segments (transcriptions)
		if msgType == 0x02 {
			var segments []map[string]interface{}
			if err := json.Unmarshal(jsonData, &segments); err != nil {
				log.Printf("[VoiceCommands] Failed to parse segments: %v", err)
				continue
			}

			log.Printf("[VoiceCommands] Received %d segments from WhisperLive for session %s", len(segments), sessionID)

			// Process each segment
			for i, segment := range segments {
				text, ok := segment["text"].(string)
				if !ok {
					continue
				}

				completed, _ := segment["completed"].(bool)
				segmentCount++

				log.Printf("[VoiceCommands] Segment #%d (total: %d): text=\"%s\", completed=%v",
					i+1, segmentCount, text, completed)

				// Only process completed segments for command execution
				if completed {
					log.Printf("[VoiceCommands] Processing completed segment as command: \"%s\"", text)
					vch.processCommand(sessionID, conn, text)
				} else {
					// Send interim transcription to UI
					log.Printf("[VoiceCommands] Sending interim transcription to UI: \"%s\"", text)
					vch.sendMessage(conn, map[string]interface{}{
						"type":      "voice_command_transcription",
						"text":      text,
						"completed": false,
						"timestamp": time.Now().UnixNano() / 1e6,
					})
				}
			}
		}
	}
	log.Printf("[VoiceCommands] Result channel closed for session %s, processed %d total segments", sessionID, segmentCount)
}

// sanitizeTranscription sanitizes transcription text to prevent injection attacks
func sanitizeTranscription(text string) string {
	// Trim whitespace
	text = strings.TrimSpace(text)

	// Limit length to prevent excessive data
	if len(text) > MaxTranscriptionLen {
		text = text[:MaxTranscriptionLen]
	}

	// Remove control characters and non-printable characters
	// Keep only printable ASCII and common punctuation
	var sanitized strings.Builder
	sanitized.Grow(len(text))

	for _, r := range text {
		// Allow printable ASCII (space through tilde) and common extended chars
		if (r >= 32 && r <= 126) || r == '\n' || r == '\t' {
			sanitized.WriteRune(r)
		}
		// Skip other characters (control chars, etc.)
	}

	return sanitized.String()
}

// processCommand parses a voice command and sends it to the UI for execution
func (vch *VoiceCommandHandler) processCommand(sessionID string, conn *websocket.Conn, text string) {
	// Sanitize input to prevent injection attacks
	text = sanitizeTranscription(text)
	if text == "" {
		return
	}

	log.Printf("[VoiceCommands] Processing command for session %s: %s", sessionID, text)

	// Try to parse command
	command, err := vch.parseCommand(text)
	if err != nil {
		// Not a recognized command, just send transcription
		vch.sendMessage(conn, map[string]interface{}{
			"type":       "voice_command_transcription",
			"text":       text,
			"completed":  true,
			"recognized": false,
			"timestamp":  time.Now().UnixNano() / 1e6,
		})
		return
	}

	// Send parsed command to UI for execution
	response := map[string]interface{}{
		"type":       "voice_command_result",
		"text":       text,
		"command":    command.Action,
		"parameters": command.Parameters,
		"timestamp":  time.Now().UnixNano() / 1e6,
	}

	vch.sendMessage(conn, response)
	log.Printf("[VoiceCommands] Sent command to UI: %s with parameters: %v", command.Action, command.Parameters)
}

// VoiceCommand represents a parsed voice command
type VoiceCommand struct {
	Action     string
	Parameters map[string]interface{}
}

// parseCommand parses text into a voice command
func (vch *VoiceCommandHandler) parseCommand(text string) (*VoiceCommand, error) {
	text = strings.TrimSpace(text)

	// Try frequency commands (MHz)
	if matches := vch.commandPatterns["tune_mhz"].FindStringSubmatch(text); matches != nil {
		freq, _ := strconv.ParseFloat(matches[1], 64)
		return &VoiceCommand{
			Action: "tune",
			Parameters: map[string]interface{}{
				"frequency": int(freq * 1e6), // Convert MHz to Hz
			},
		}, nil
	}

	if matches := vch.commandPatterns["frequency_mhz"].FindStringSubmatch(text); matches != nil {
		freq, _ := strconv.ParseFloat(matches[1], 64)
		return &VoiceCommand{
			Action: "tune",
			Parameters: map[string]interface{}{
				"frequency": int(freq * 1e6),
			},
		}, nil
	}

	// Try frequency commands (kHz)
	if matches := vch.commandPatterns["tune_khz"].FindStringSubmatch(text); matches != nil {
		freq, _ := strconv.ParseFloat(matches[1], 64)
		return &VoiceCommand{
			Action: "tune",
			Parameters: map[string]interface{}{
				"frequency": int(freq * 1e3), // Convert kHz to Hz
			},
		}, nil
	}

	if matches := vch.commandPatterns["frequency_khz"].FindStringSubmatch(text); matches != nil {
		freq, _ := strconv.ParseFloat(matches[1], 64)
		return &VoiceCommand{
			Action: "tune",
			Parameters: map[string]interface{}{
				"frequency": int(freq * 1e3),
			},
		}, nil
	}

	// Try mode commands
	if matches := vch.commandPatterns["mode"].FindStringSubmatch(text); matches != nil {
		mode := strings.ToUpper(matches[1])
		return &VoiceCommand{
			Action: "mode",
			Parameters: map[string]interface{}{
				"mode": mode,
			},
		}, nil
	}

	// Try volume commands
	if matches := vch.commandPatterns["volume_set"].FindStringSubmatch(text); matches != nil {
		volume, _ := strconv.Atoi(matches[1])
		if volume < 0 {
			volume = 0
		}
		if volume > 100 {
			volume = 100
		}
		return &VoiceCommand{
			Action: "volume",
			Parameters: map[string]interface{}{
				"volume": volume,
			},
		}, nil
	}

	if vch.commandPatterns["volume_up"].MatchString(text) {
		return &VoiceCommand{
			Action: "volume_adjust",
			Parameters: map[string]interface{}{
				"delta": 10,
			},
		}, nil
	}

	if vch.commandPatterns["volume_down"].MatchString(text) {
		return &VoiceCommand{
			Action: "volume_adjust",
			Parameters: map[string]interface{}{
				"delta": -10,
			},
		}, nil
	}

	if vch.commandPatterns["mute"].MatchString(text) {
		return &VoiceCommand{
			Action: "mute",
			Parameters: map[string]interface{}{
				"muted": true,
			},
		}, nil
	}

	if vch.commandPatterns["unmute"].MatchString(text) {
		return &VoiceCommand{
			Action: "mute",
			Parameters: map[string]interface{}{
				"muted": false,
			},
		}, nil
	}

	// Try bandwidth commands
	if matches := vch.commandPatterns["bandwidth"].FindStringSubmatch(text); matches != nil {
		bw, _ := strconv.ParseFloat(matches[1], 64)
		return &VoiceCommand{
			Action: "bandwidth",
			Parameters: map[string]interface{}{
				"bandwidth": int(bw * 1e3), // Convert kHz to Hz
			},
		}, nil
	}

	// Try recording commands
	if vch.commandPatterns["start_recording"].MatchString(text) {
		return &VoiceCommand{
			Action:     "recording",
			Parameters: map[string]interface{}{"start": true},
		}, nil
	}

	if vch.commandPatterns["stop_recording"].MatchString(text) {
		return &VoiceCommand{
			Action:     "recording",
			Parameters: map[string]interface{}{"start": false},
		}, nil
	}

	return nil, fmt.Errorf("command not recognized")
}

// convertAudioToPCM converts browser audio data to PCM int16 samples
func (vch *VoiceCommandHandler) convertAudioToPCM(audioData []byte) []int16 {
	// Browser typically sends Float32 PCM data (4 bytes per sample)
	numSamples := len(audioData) / 4
	pcmSamples := make([]int16, numSamples)

	for i := 0; i < numSamples; i++ {
		// Read float32 (little-endian)
		bits := binary.LittleEndian.Uint32(audioData[i*4 : (i+1)*4])
		floatVal := math.Float32frombits(bits)

		// Convert to int16 (-1.0 to 1.0 -> -32768 to 32767)
		intVal := int16(floatVal * 32767.0)
		pcmSamples[i] = intVal
	}

	return pcmSamples
}

// sendMessage sends a message to the WebSocket client
func (vch *VoiceCommandHandler) sendMessage(conn *websocket.Conn, message map[string]interface{}) error {
	messageJSON, err := json.Marshal(message)
	if err != nil {
		return fmt.Errorf("failed to marshal message: %w", err)
	}

	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return conn.WriteMessage(websocket.TextMessage, messageJSON)
}

// sendError sends an error message to the WebSocket client
func (vch *VoiceCommandHandler) sendError(conn *websocket.Conn, errorMsg string) error {
	return vch.sendMessage(conn, map[string]interface{}{
		"type":  "voice_command_error",
		"error": errorMsg,
	})
}

// Cleanup stops all active voice command sessions
func (vch *VoiceCommandHandler) Cleanup() {
	vch.decodersMu.Lock()
	defer vch.decodersMu.Unlock()

	for sessionID, decoder := range vch.whisperDecoders {
		if err := decoder.Stop(); err != nil {
			log.Printf("[VoiceCommands] Error stopping decoder for session %s: %v", sessionID, err)
		}
	}

	vch.whisperDecoders = make(map[string]*whisper.WhisperDecoder)
}

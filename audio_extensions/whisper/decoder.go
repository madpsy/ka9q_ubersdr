package whisper

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

/*
 * Whisper Decoder - Streaming Implementation
 * Connects to WhisperLive server via WebSocket for real-time transcription
 */

// WhisperConfig is defined in the main package (config.go)
// This type alias allows the whisper package to use it
type WhisperConfig struct {
	Enabled        bool
	ServerURL      string
	Model          string
	Language       string
	Translate      bool
	SendIntervalMs int
	InitialPrompt  string
}

// WhisperDecoder handles streaming audio to WhisperLive
type WhisperDecoder struct {
	sampleRate int
	config     WhisperConfig
	clientUID  string // Unique client ID for WhisperLive

	// WebSocket connection to WhisperLive
	wsConn   *websocket.Conn
	wsConnMu sync.Mutex

	// Audio buffering
	audioBuffer []int16
	bufferMu    sync.Mutex

	// Resampler for converting to 16 kHz
	resampler *Resampler

	// Segment deduplication (matching WhisperLive client.py behavior)
	transcript   []map[string]interface{} // Completed segments
	transcriptMu sync.Mutex
	lastSegment  map[string]interface{} // Last incomplete segment

	// Control
	running     bool
	stopChan    chan struct{}
	wg          sync.WaitGroup
	serverReady chan struct{} // Signals when WhisperLive server is ready

	// Text filtering
	suppressPhrases []*regexp.Regexp
}

// NewWhisperDecoder creates a new Whisper decoder
func NewWhisperDecoder(sampleRate int, config WhisperConfig) *WhisperDecoder {
	log.Printf("[Whisper] Creating decoder: input=%d Hz, output=%d Hz (WhisperLive)", sampleRate, targetSampleRate)

	// Compile suppress phrases (case-insensitive)
	// Include optional trailing punctuation [!.?]* to remove punctuation marks
	suppressPhrases := []*regexp.Regexp{
		regexp.MustCompile(`(?i)thanks?\s+for\s+watching[!.?]*`),
		regexp.MustCompile(`(?i)please\s+subscribe[!.?]*`),
		regexp.MustCompile(`(?i)like\s+and\s+subscribe[!.?]*`),
		regexp.MustCompile(`(?i)don'?t\s+forget\s+to\s+subscribe[!.?]*`),
		regexp.MustCompile(`(?i)hit\s+the\s+bell[!.?]*`),
		regexp.MustCompile(`(?i)smash\s+that\s+like\s+button[!.?]*`),
	}

	return &WhisperDecoder{
		sampleRate:      sampleRate,
		config:          config,
		clientUID:       uuid.New().String(),
		audioBuffer:     make([]int16, 0),
		resampler:       NewResampler(sampleRate),
		stopChan:        make(chan struct{}),
		serverReady:     make(chan struct{}),
		suppressPhrases: suppressPhrases,
	}
}

// Start begins the decoding process
func (d *WhisperDecoder) Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error {
	d.running = true

	// Try initial connection, but don't fail if it doesn't work
	// The receiveResultsLoop will handle reconnection with delays
	if err := d.connectWebSocket(); err != nil {
		log.Printf("[Whisper] Initial connection failed: %v", err)
		log.Printf("[Whisper] Will retry connection in background...")
		// Set connection to nil so receiveResultsLoop will retry
		d.wsConnMu.Lock()
		d.wsConn = nil
		d.wsConnMu.Unlock()
	} else {
		log.Printf("[Whisper] Successfully connected to WhisperLive")
	}

	// Start audio sender goroutine
	d.wg.Add(1)
	go d.sendAudioLoop(audioChan)

	// Start result receiver goroutine (will handle reconnection if needed)
	d.wg.Add(1)
	go d.receiveResultsLoop(resultChan)

	return nil
}

// GetServerReadyChannel returns the channel that signals when the server is ready
func (d *WhisperDecoder) GetServerReadyChannel() <-chan struct{} {
	return d.serverReady
}

// Stop stops the decoder
func (d *WhisperDecoder) Stop() error {
	if !d.running {
		return nil
	}

	d.running = false
	close(d.stopChan)

	// Close WebSocket connection
	d.wsConnMu.Lock()
	if d.wsConn != nil {
		_ = d.wsConn.Close() // Ignore close error during shutdown
		d.wsConn = nil
	}
	d.wsConnMu.Unlock()

	d.wg.Wait()
	return nil
}

// connectWebSocket establishes WebSocket connection to WhisperLive
func (d *WhisperDecoder) connectWebSocket() error {
	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
	}

	conn, _, err := dialer.Dial(d.config.ServerURL, nil)
	if err != nil {
		return fmt.Errorf("WebSocket dial failed: %w", err)
	}

	d.wsConnMu.Lock()
	d.wsConn = conn
	d.wsConnMu.Unlock()

	// Send initial configuration to WhisperLive in the format it expects
	// Based on WhisperLive client.py on_open() method
	task := "transcribe"
	if d.config.Translate {
		task = "translate"
	}

	// Set language to nil (null in JSON) for auto-detection, otherwise use the configured value
	var language interface{}
	if d.config.Language == "" || d.config.Language == "auto" {
		language = nil // Will be encoded as null in JSON
	} else {
		language = d.config.Language
	}

	configMsg := map[string]interface{}{
		"uid":                   d.clientUID,
		"language":              language, // nil for auto-detect, string for specific language
		"task":                  task,     // "transcribe" or "translate" based on config
		"model":                 d.config.Model,
		"use_vad":               true,
		"send_last_n_segments":  1, // Only send current segment, not previous ones
		"no_speech_thresh":      0.45,
		"clip_audio":            false,
		"same_output_threshold": 10,
		"enable_translation":    false,
		"target_language":       "en",
		"vad_parameters": map[string]interface{}{
			"max_speech_duration_s":   15.0, // Force segment breaks every 15 seconds (default: 30)
			"min_silence_duration_ms": 160,  // Minimum silence to detect pause (default: 160)
			"threshold":               0.5,  // Speech detection threshold (default: 0.5)
		},
	}

	// Add initial_prompt if configured
	if d.config.InitialPrompt != "" {
		configMsg["initial_prompt"] = d.config.InitialPrompt
	}

	configJSON, err := json.Marshal(configMsg)
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	if err := conn.WriteMessage(websocket.TextMessage, configJSON); err != nil {
		return fmt.Errorf("failed to send config: %w", err)
	}

	languageStr := d.config.Language
	if languageStr == "" || languageStr == "auto" {
		languageStr = "auto-detect"
	}
	log.Printf("[Whisper] Connected to WhisperLive at %s (uid: %s, model: %s, language: %s, task: %s)",
		d.config.ServerURL, d.clientUID, d.config.Model, languageStr, task)

	return nil
}

// reconnectWebSocket attempts to reconnect to WhisperLive
func (d *WhisperDecoder) reconnectWebSocket() error {
	// Close existing connection if any
	d.wsConnMu.Lock()
	if d.wsConn != nil {
		_ = d.wsConn.Close()
		d.wsConn = nil
	}
	d.wsConnMu.Unlock()

	log.Printf("[Whisper] Reconnecting to WhisperLive...")

	// Attempt to reconnect
	return d.connectWebSocket()
}

// sendAudioLoop accumulates and sends audio to WhisperLive
func (d *WhisperDecoder) sendAudioLoop(audioChan <-chan AudioSample) {
	defer d.wg.Done()

	sendInterval := time.Duration(d.config.SendIntervalMs) * time.Millisecond
	ticker := time.NewTicker(sendInterval)
	defer ticker.Stop()

	for {
		select {
		case <-d.stopChan:
			return

		case sample, ok := <-audioChan:
			if !ok {
				return
			}

			// Accumulate audio samples
			d.bufferMu.Lock()
			d.audioBuffer = append(d.audioBuffer, sample.PCMData...)
			d.bufferMu.Unlock()

		case <-ticker.C:
			// Send accumulated audio
			d.bufferMu.Lock()
			if len(d.audioBuffer) == 0 {
				d.bufferMu.Unlock()
				continue
			}

			// Copy buffer for sending
			audioToSend := make([]int16, len(d.audioBuffer))
			copy(audioToSend, d.audioBuffer)
			d.audioBuffer = d.audioBuffer[:0] // Clear buffer
			d.bufferMu.Unlock()

			// Resample to 16 kHz if needed
			audioToSend = d.resampler.Resample(audioToSend)

			// Convert int16 to float32 for Whisper (normalize to -1.0 to 1.0)
			floatData := make([]float32, len(audioToSend))
			for i, s := range audioToSend {
				floatData[i] = float32(s) / 32768.0
			}

			// Send as binary message
			d.wsConnMu.Lock()
			conn := d.wsConn
			d.wsConnMu.Unlock()

			if conn != nil {
				// Convert float32 array to bytes (little-endian IEEE 754)
				buf := make([]byte, len(floatData)*4)
				for i, f := range floatData {
					bits := math.Float32bits(f)
					binary.LittleEndian.PutUint32(buf[i*4:], bits)
				}

				err := conn.WriteMessage(websocket.BinaryMessage, buf)
				if err != nil {
					// Connection is dead, close it and let receiveResultsLoop reconnect
					log.Printf("[Whisper] Error sending audio: %v, closing connection for reconnect", err)
					d.wsConnMu.Lock()
					if d.wsConn == conn {
						_ = d.wsConn.Close()
						d.wsConn = nil
					}
					d.wsConnMu.Unlock()
				}
			}
		}
	}
}

// receiveResultsLoop receives transcription results from WhisperLive
func (d *WhisperDecoder) receiveResultsLoop(resultChan chan<- []byte) {
	defer d.wg.Done()

	for d.running {
		d.wsConnMu.Lock()
		conn := d.wsConn
		d.wsConnMu.Unlock()

		if conn == nil {
			// Connection is nil, attempt to reconnect
			log.Printf("[Whisper] Connection is nil, attempting reconnect...")
			if reconnectErr := d.reconnectWebSocket(); reconnectErr != nil {
				log.Printf("[Whisper] Reconnect failed: %v, retrying in 5 seconds...", reconnectErr)
				time.Sleep(5 * time.Second)
			} else {
				log.Printf("[Whisper] Successfully reconnected to WhisperLive")
			}
			continue
		}

		messageType, message, err := conn.ReadMessage()
		if err != nil {
			if d.running {
				log.Printf("[Whisper] WebSocket read error: %v, attempting reconnect...", err)
				// Try to reconnect
				if reconnectErr := d.reconnectWebSocket(); reconnectErr != nil {
					log.Printf("[Whisper] Reconnect failed: %v, retrying in 5 seconds...", reconnectErr)
					time.Sleep(5 * time.Second) // Wait before next attempt
				} else {
					log.Printf("[Whisper] Successfully reconnected to WhisperLive")
				}
			}
			continue // Don't return, keep trying
		}

		if messageType == websocket.TextMessage {
			// Parse message from WhisperLive
			var result map[string]interface{}

			if err := json.Unmarshal(message, &result); err != nil {
				log.Printf("[Whisper] JSON parse error: %v", err)
				continue
			}

			// Check if this message is for our client
			if uid, ok := result["uid"].(string); ok && uid != d.clientUID {
				continue
			}

			// Handle status messages
			if status, ok := result["status"].(string); ok {
				switch status {
				case "WAIT":
					log.Printf("[Whisper] Server is full, waiting...")
				case "ERROR":
					if msg, ok := result["message"].(string); ok {
						log.Printf("[Whisper] Server error: %s", msg)
					}
				}
				continue
			}

			// Handle server ready message
			if msg, ok := result["message"].(string); ok {
				switch msg {
				case "SERVER_READY":
					backend := "unknown"
					if b, ok := result["backend"].(string); ok {
						backend = b
					}
					log.Printf("[Whisper] Server ready with backend: %s", backend)
					// Signal that server is ready (non-blocking, may already be closed)
					select {
					case d.serverReady <- struct{}{}:
					default:
					}
				case "DISCONNECT":
					log.Printf("[Whisper] Server disconnected, will reconnect...")
					// Close connection and let the loop reconnect
					d.wsConnMu.Lock()
					if d.wsConn != nil {
						_ = d.wsConn.Close()
						d.wsConn = nil
					}
					d.wsConnMu.Unlock()
					continue
				}
				continue
			}

			// Handle language detection
			if lang, ok := result["language"].(string); ok {
				langProb := 0.0
				if lp, ok := result["language_prob"].(float64); ok {
					langProb = lp
				}
				log.Printf("[Whisper] Detected language: %s (probability: %.2f)", lang, langProb)

				// Send language detection to frontend
				languageData := map[string]interface{}{
					"language":      lang,
					"language_prob": langProb,
				}
				languageJSON, err := json.Marshal(languageData)
				if err != nil {
					log.Printf("[Whisper] Failed to marshal language data: %v", err)
					continue
				}

				encoded := d.encodeLanguageDetection(languageJSON, time.Now().UnixNano())

				// Send to result channel (non-blocking)
				select {
				case resultChan <- encoded:
				default:
					log.Printf("[Whisper] Result channel full, dropping language detection")
				}
				continue
			}

			// Handle transcription segments
			if segments, ok := result["segments"].([]interface{}); ok && len(segments) > 0 {
				// Apply filtering and deduplication
				segments = d.processSegments(segments)

				// Only send if we have segments after filtering
				if len(segments) > 0 {
					// Send segments as JSON to frontend
					segmentsJSON, err := json.Marshal(segments)
					if err != nil {
						log.Printf("[Whisper] Failed to marshal segments: %v", err)
						continue
					}

					// Encode segments for client
					encoded := d.encodeSegments(segmentsJSON, time.Now().UnixNano())

					// Send to result channel (non-blocking)
					select {
					case resultChan <- encoded:
					default:
						log.Printf("[Whisper] Result channel full, dropping segments")
					}
				}
			}
		}
	}
}

// processSegments filters and processes segments from WhisperLive
// With send_last_n_segments=1, WhisperLive sends the last completed segment + current incomplete
// We need to track which completed segments we've already sent to avoid duplicates
func (d *WhisperDecoder) processSegments(segments []interface{}) []interface{} {
	d.transcriptMu.Lock()
	defer d.transcriptMu.Unlock()

	var filteredSegments []interface{}

	for i, segInterface := range segments {
		seg, ok := segInterface.(map[string]interface{})
		if !ok {
			continue
		}

		segText, ok := seg["text"].(string)
		if !ok {
			continue
		}

		// Apply text filtering
		segText = d.filterText(segText)
		seg["text"] = segText

		// Skip empty segments
		if segText == "" {
			continue
		}

		completed, _ := seg["completed"].(bool)

		// Completed segments - check if we've already sent this one
		if completed {
			// Check if this segment is already in our transcript
			// Use text as primary key since timestamps might vary slightly
			alreadySent := false

			for _, existingSeg := range d.transcript {
				if existingText, ok := existingSeg["text"].(string); ok {
					if existingText == segText {
						alreadySent = true
						break
					}
				}
			}

			// Only send if we haven't sent it before
			if !alreadySent {
				d.transcript = append(d.transcript, seg)
				filteredSegments = append(filteredSegments, seg)
				log.Printf("[Whisper] Sending completed segment: %s", segText)
			}
			// Skip logging for duplicates - too verbose
		} else if i == len(segments)-1 {
			// Last segment that's not completed - send for real-time updates
			d.lastSegment = seg
			filteredSegments = append(filteredSegments, seg)
		}
	}

	return filteredSegments
}

// filterText applies all text filters to the input string
func (d *WhisperDecoder) filterText(text string) string {
	// First, remove suppressed phrases
	for _, pattern := range d.suppressPhrases {
		text = pattern.ReplaceAllString(text, "")
	}

	// Remove consecutive word repetitions
	text = d.removeConsecutiveWords(text)

	// Clean up extra whitespace
	text = strings.TrimSpace(text)
	text = regexp.MustCompile(`\s+`).ReplaceAllString(text, " ")

	return text
}

// removeConsecutiveWords removes consecutive repetitions of the same word
// e.g., "ha ha ha" becomes "ha"
func (d *WhisperDecoder) removeConsecutiveWords(text string) string {
	words := strings.Fields(text)
	if len(words) == 0 {
		return text
	}

	result := []string{words[0]}
	for i := 1; i < len(words); i++ {
		// Compare case-insensitively
		if !strings.EqualFold(words[i], words[i-1]) {
			result = append(result, words[i])
		}
	}

	return strings.Join(result, " ")
}

// encodeSegments encodes transcription segments into binary protocol
// Format: [type:1][timestamp:8][json_length:4][json:N]
// The JSON contains an array of segments with text, start, end, and completed fields
func (d *WhisperDecoder) encodeSegments(segmentsJSON []byte, timestamp int64) []byte {
	buf := make([]byte, 1+8+4+len(segmentsJSON))

	buf[0] = 0x02 // Message type: segments
	binary.BigEndian.PutUint64(buf[1:9], uint64(timestamp))
	binary.BigEndian.PutUint32(buf[9:13], uint32(len(segmentsJSON)))
	copy(buf[13:], segmentsJSON)

	return buf
}

// encodeLanguageDetection encodes language detection into binary protocol
// Format: [type:1][timestamp:8][json_length:4][json:N]
// The JSON contains language and language_prob fields
func (d *WhisperDecoder) encodeLanguageDetection(languageJSON []byte, timestamp int64) []byte {
	buf := make([]byte, 1+8+4+len(languageJSON))

	buf[0] = 0x03 // Message type: language detection
	binary.BigEndian.PutUint64(buf[1:9], uint64(timestamp))
	binary.BigEndian.PutUint32(buf[9:13], uint32(len(languageJSON)))
	copy(buf[13:], languageJSON)

	return buf
}

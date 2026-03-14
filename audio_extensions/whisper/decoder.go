package whisper

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
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

// Message type constants for binary protocol
const (
	// Outgoing message types (backend -> frontend)
	MessageTypeSegments          = 0x02 // Transcription segments
	MessageTypeLanguageDetection = 0x03 // Language detection
	MessageTypeError             = 0x04 // Error message
	MessageTypeSummary           = 0x05 // Summary response

	// Incoming message types (frontend -> backend)
	MessageTypeSummaryRequest = 0x06 // Summary request from frontend
)

// WhisperConfig is defined in the main package (config.go)
// This type alias allows the whisper package to use it
type WhisperConfig struct {
	Enabled           bool
	ServerURL         string
	Model             string
	InitialPrompt     string
	InstanceUUID      string
	LibreTranslateURL string
	SummaryURL        string
	TargetLanguage    string // Target language for translation (from frontend)
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

	// Segment storage for summarization (stores English text before translation)
	englishSegments    []string // Circular buffer of up to 1000 English segments
	englishSegmentsMu  sync.Mutex
	maxEnglishSegments int // Maximum number of segments to store (default: 1000)

	// Control
	running     bool
	stopChan    chan struct{}
	wg          sync.WaitGroup
	serverReady chan struct{} // Signals when WhisperLive server is ready

	// Connection failure tracking
	failedAttempts    int
	lastConnectionErr string

	// Text filtering
	suppressPhrases []*regexp.Regexp

	// HTTP client for LibreTranslate
	httpClient *http.Client

	// Detected language from Whisper
	detectedLanguage string
	languageMu       sync.RWMutex
}

// NewWhisperDecoder creates a new Whisper decoder
func NewWhisperDecoder(sampleRate int, config WhisperConfig) *WhisperDecoder {
	log.Printf("[Whisper] Creating decoder: input=%d Hz, output=%d Hz (WhisperLive)", sampleRate, targetSampleRate)

	// Compile suppress phrases (case-insensitive)
	// Include optional trailing punctuation [!.?]* to remove punctuation marks
	suppressPhrases := []*regexp.Regexp{
		regexp.MustCompile(`(?i)thanks?\s+(you\s+)?for\s+watching[!.?]*`),
		regexp.MustCompile(`(?i)please\s+subscribe[!.?]*`),
		regexp.MustCompile(`(?i)like\s+and\s+subscribe[!.?]*`),
		regexp.MustCompile(`(?i)don'?t\s+forget\s+to\s+subscribe[!.?]*`),
		regexp.MustCompile(`(?i)hit\s+the\s+bell[!.?]*`),
		regexp.MustCompile(`(?i)smash\s+that\s+like\s+button[!.?]*`),
	}

	return &WhisperDecoder{
		sampleRate:         sampleRate,
		config:             config,
		clientUID:          uuid.New().String(),
		audioBuffer:        make([]int16, 0),
		resampler:          NewResampler(sampleRate),
		stopChan:           make(chan struct{}),
		serverReady:        make(chan struct{}),
		suppressPhrases:    suppressPhrases,
		englishSegments:    make([]string, 0, 1000),
		maxEnglishSegments: 1000,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
			Transport: &http.Transport{
				MaxIdleConns:        100,
				MaxIdleConnsPerHost: 10,
				IdleConnTimeout:     90 * time.Second,
				DisableKeepAlives:   false,
			},
		},
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

	// Clear stored English segments
	d.clearEnglishSegments()

	d.wg.Wait()
	return nil
}

// sendErrorToFrontend sends an error message to the frontend via the result channel
// Binary protocol: [type:1][timestamp:8][error_length:4][error:N]
func (d *WhisperDecoder) sendErrorToFrontend(resultChan chan<- []byte, errorMsg string) {
	errorBytes := []byte(errorMsg)
	msg := make([]byte, 1+8+4+len(errorBytes))

	msg[0] = MessageTypeError
	binary.BigEndian.PutUint64(msg[1:9], uint64(time.Now().UnixNano()))
	binary.BigEndian.PutUint32(msg[9:13], uint32(len(errorBytes)))
	copy(msg[13:], errorBytes)

	select {
	case resultChan <- msg:
		log.Printf("[Whisper] Sent error to frontend: %s", errorMsg)
	default:
		log.Printf("[Whisper] Failed to send error to frontend (channel full): %s", errorMsg)
	}
}

// connectWebSocket establishes WebSocket connection to WhisperLive
func (d *WhisperDecoder) connectWebSocket() error {
	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
	}

	// Prepare headers including instance UUID, model, and max users
	headers := make(map[string][]string)
	if d.config.InstanceUUID != "" {
		headers["X-UberSDR-UUID"] = []string{d.config.InstanceUUID}
	}
	if d.config.Model != "" {
		headers["X-UberSDR-Model"] = []string{d.config.Model}
	}
	if GlobalConfigProvider != nil && GlobalConfigProvider.MaxUsers > 0 {
		headers["X-UberSDR-Max-Users"] = []string{fmt.Sprintf("%d", GlobalConfigProvider.MaxUsers)}
	}

	conn, resp, err := dialer.Dial(d.config.ServerURL, headers)
	if err != nil {
		// Try to parse JSON error response from server
		if resp != nil && resp.Body != nil {
			defer resp.Body.Close()
			body, readErr := io.ReadAll(resp.Body)
			if readErr == nil && len(body) > 0 {
				// Try to parse as JSON error
				var errorResp struct {
					Error string `json:"error"`
				}
				if jsonErr := json.Unmarshal(body, &errorResp); jsonErr == nil && errorResp.Error != "" {
					log.Printf("[Whisper] Server error: %s", errorResp.Error)
					return fmt.Errorf("server error: %s", errorResp.Error)
				}
				// If not JSON, log the raw response
				log.Printf("[Whisper] Server response: %s", string(body))
			}
		}
		return fmt.Errorf("WebSocket dial failed: %w", err)
	}

	// Set up ping/pong handlers to respond to server keepalive pings
	// This prevents "keepalive ping timeout" errors
	conn.SetPingHandler(func(appData string) error {
		// Respond with pong - must use WriteControl with deadline
		d.wsConnMu.Lock()
		defer d.wsConnMu.Unlock()
		err := conn.WriteControl(websocket.PongMessage, []byte(appData), time.Now().Add(10*time.Second))
		if err != nil {
			log.Printf("[Whisper] Error sending pong: %v", err)
		}
		return err
	})

	conn.SetPongHandler(func(appData string) error {
		return nil
	})

	// Set read deadline to detect stale connections
	// This will be reset after each successful read
	conn.SetReadDeadline(time.Now().Add(60 * time.Second))

	d.wsConnMu.Lock()
	d.wsConn = conn
	d.wsConnMu.Unlock()

	// Send initial configuration to WhisperLive in the format it expects
	// Based on WhisperLive client.py on_open() method
	// Always use "translate" task to get English output from Whisper
	// Language is always set to nil for auto-detection

	configMsg := map[string]interface{}{
		"uid":                   d.clientUID,
		"language":              nil, // Always nil for auto-detection
		"task":                  "translate",
		"model":                 d.config.Model,
		"use_vad":               true,
		"send_last_n_segments":  1, // Only send current segment, not previous ones
		"no_speech_thresh":      0.45,
		"clip_audio":            false,
		"same_output_threshold": 10,
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

	log.Printf("[Whisper] Connected to WhisperLive at %s (uid: %s, model: %s, language: auto-detect, task: translate)",
		d.config.ServerURL, d.clientUID, d.config.Model)

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

	// Hardcoded to 100ms send interval
	sendInterval := 100 * time.Millisecond
	ticker := time.NewTicker(sendInterval)
	defer ticker.Stop()

	// Maximum audio chunk size to prevent exceeding WebSocket message limits
	// WhisperLive server has a 1MB default limit, so we cap at 500KB to be safe
	// At 16kHz float32 (4 bytes per sample), this is ~125K samples = ~7.8 seconds of audio
	const maxChunkSizeBytes = 500 * 1024 // 500KB

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

			// Limit chunk size to prevent exceeding WebSocket message limits
			// Each float32 is 4 bytes, so maxChunkSizeBytes/4 gives us max samples
			maxSamples := maxChunkSizeBytes / 4
			if len(audioToSend) > maxSamples {
				log.Printf("[Whisper] Audio buffer too large (%d samples, %.2f seconds), truncating to %d samples (%.2f seconds)",
					len(audioToSend), float64(len(audioToSend))/16000.0,
					maxSamples, float64(maxSamples)/16000.0)
				audioToSend = audioToSend[:maxSamples]
			}

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
				d.failedAttempts++
				d.lastConnectionErr = reconnectErr.Error()
				log.Printf("[Whisper] Reconnect failed (%d/3): %v", d.failedAttempts, reconnectErr)

				// After 3 failed attempts, send error to frontend and stop
				if d.failedAttempts >= 3 {
					log.Printf("[Whisper] Maximum reconnection attempts reached, stopping decoder")
					d.sendErrorToFrontend(resultChan, fmt.Sprintf("Connection failed: %s", d.lastConnectionErr))
					// Stop the decoder
					d.running = false
					return
				}

				log.Printf("[Whisper] Retrying in 5 seconds...")
				time.Sleep(5 * time.Second)
			} else {
				log.Printf("[Whisper] Successfully reconnected to WhisperLive")
				d.failedAttempts = 0 // Reset counter on successful connection
			}
			continue
		}

		messageType, message, err := conn.ReadMessage()
		if err != nil {
			if d.running {
				log.Printf("[Whisper] WebSocket read error: %v, attempting reconnect...", err)
				// Try to reconnect
				if reconnectErr := d.reconnectWebSocket(); reconnectErr != nil {
					d.failedAttempts++
					d.lastConnectionErr = reconnectErr.Error()
					log.Printf("[Whisper] Reconnect failed (%d/3): %v", d.failedAttempts, reconnectErr)

					// After 3 failed attempts, send error to frontend and stop
					if d.failedAttempts >= 3 {
						log.Printf("[Whisper] Maximum reconnection attempts reached, stopping decoder")
						d.sendErrorToFrontend(resultChan, fmt.Sprintf("Connection failed: %s", d.lastConnectionErr))
						// Stop the decoder
						d.running = false
						return
					}

					log.Printf("[Whisper] Retrying in 5 seconds...")
					time.Sleep(5 * time.Second) // Wait before next attempt
				} else {
					log.Printf("[Whisper] Successfully reconnected to WhisperLive")
					d.failedAttempts = 0 // Reset counter on successful connection
				}
			}
			continue // Don't return, keep trying
		}

		// Reset read deadline after successful read to keep connection alive
		conn.SetReadDeadline(time.Now().Add(60 * time.Second))

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

				// Store detected language for translation
				d.languageMu.Lock()
				d.detectedLanguage = lang
				d.languageMu.Unlock()

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

			// Handle transcription segments - always use regular segments
			segments, ok := result["segments"].([]interface{})
			if ok && len(segments) > 0 {
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
			// Use ORIGINAL text (before translation) as primary key since timestamps might vary slightly
			// Store the original English text for deduplication
			originalText := segText
			alreadySent := false

			for _, existingSeg := range d.transcript {
				// Check against the original_text field if it exists, otherwise fall back to text
				if existingOriginal, ok := existingSeg["original_text"].(string); ok {
					if existingOriginal == originalText {
						alreadySent = true
						break
					}
				} else if existingText, ok := existingSeg["text"].(string); ok {
					if existingText == originalText {
						alreadySent = true
						break
					}
				}
			}

			// Only send if we haven't sent it before
			if !alreadySent {
				// Store original English text for deduplication
				seg["original_text"] = originalText

				// Store English segment for summarization (circular buffer)
				d.storeEnglishSegment(originalText)

				// Apply translation if target language is not English
				// Whisper always returns English, so we translate from English to target language
				if d.config.TargetLanguage != "" && d.config.TargetLanguage != "en" {
					// Translate from English (Whisper's output) to target language
					translatedText := d.translateText(segText, "en", d.config.TargetLanguage)
					seg["text"] = translatedText
				}

				d.transcript = append(d.transcript, seg)
				filteredSegments = append(filteredSegments, seg)
			}
		} else if i == len(segments)-1 {
			// Last segment that's not completed - send for real-time updates (no translation)
			d.lastSegment = seg
			filteredSegments = append(filteredSegments, seg)
		}
	}

	return filteredSegments
}

// trimToLastSentence trims text to end at the last complete sentence boundary.
// A sentence boundary is defined as a '.', '!', or '?' character (optionally
// followed by a closing quote or parenthesis) that is followed by whitespace or
// the end of the string.  If no sentence boundary is found the original text is
// returned unchanged so the caller always gets something useful.
func trimToLastSentence(text string) string {
	// Walk backwards through the runes looking for a sentence-ending punctuation
	// mark that is followed by whitespace (or is at the very end).
	runes := []rune(text)
	n := len(runes)

	for i := n - 1; i >= 0; i-- {
		r := runes[i]
		if r == '.' || r == '!' || r == '?' {
			// Allow an optional closing quote/paren immediately after the punctuation
			end := i + 1
			for end < n && (runes[end] == '"' || runes[end] == '\'' || runes[end] == ')') {
				end++
			}
			// The character after the sentence-end must be whitespace or EOT
			if end == n || runes[end] == ' ' || runes[end] == '\n' || runes[end] == '\t' || runes[end] == '\r' {
				return strings.TrimRight(string(runes[:end]), " \t\r\n")
			}
		}
	}

	// No sentence boundary found – return the original text trimmed of trailing space
	return strings.TrimRight(text, " \t\r\n")
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

// removeConsecutiveWords removes consecutive repetitions of words and phrases
// e.g., "ha ha ha" becomes "ha"
// e.g., "que es el que es el que es el" becomes "que es el"
func (d *WhisperDecoder) removeConsecutiveWords(text string) string {
	words := strings.Fields(text)
	if len(words) == 0 {
		return text
	}

	// First, try to detect repeating phrases (patterns of 2-10 words)
	// Start with longer patterns for better accuracy
	for patternLen := 10; patternLen >= 2; patternLen-- {
		if len(words) < patternLen*2 {
			continue // Not enough words for this pattern length
		}

		// Check if we have a repeating pattern
		pattern := words[:patternLen]
		repetitions := 1

		// Count how many times the pattern repeats from the start
		for i := patternLen; i+patternLen <= len(words); i += patternLen {
			matches := true
			for j := 0; j < patternLen; j++ {
				if !strings.EqualFold(words[i+j], pattern[j]) {
					matches = false
					break
				}
			}
			if matches {
				repetitions++
			} else {
				break
			}
		}

		// If pattern repeats at least 3 times, remove the repetitions
		if repetitions >= 3 {
			// Keep one instance of the pattern plus any remaining words
			remainingStart := patternLen * repetitions
			result := make([]string, patternLen)
			copy(result, pattern)
			if remainingStart < len(words) {
				result = append(result, words[remainingStart:]...)
			}
			return strings.Join(result, " ")
		}
	}

	// Fall back to single word repetition removal
	result := []string{words[0]}
	for i := 1; i < len(words); i++ {
		// Compare case-insensitively
		if !strings.EqualFold(words[i], words[i-1]) {
			result = append(result, words[i])
		}
	}

	return strings.Join(result, " ")
}

// storeEnglishSegment stores an English segment in the circular buffer for summarization
// Maintains a maximum of maxEnglishSegments (1000) segments
func (d *WhisperDecoder) storeEnglishSegment(text string) {
	d.englishSegmentsMu.Lock()
	defer d.englishSegmentsMu.Unlock()

	// Add segment to buffer
	d.englishSegments = append(d.englishSegments, text)

	// If we exceed the maximum, remove oldest segments (FIFO)
	if len(d.englishSegments) > d.maxEnglishSegments {
		// Remove oldest segments to maintain max size
		excess := len(d.englishSegments) - d.maxEnglishSegments
		d.englishSegments = d.englishSegments[excess:]
	}
}

// getLastNEnglishSegments retrieves the last n English segments for summarization
// Returns fewer segments if n exceeds available segments
func (d *WhisperDecoder) getLastNEnglishSegments(n int) []string {
	d.englishSegmentsMu.Lock()
	defer d.englishSegmentsMu.Unlock()

	totalSegments := len(d.englishSegments)
	if totalSegments == 0 {
		return []string{}
	}

	// If n is greater than available segments, return all segments
	if n > totalSegments {
		n = totalSegments
	}

	// Return last n segments
	startIndex := totalSegments - n
	result := make([]string, n)
	copy(result, d.englishSegments[startIndex:])
	return result
}

// clearEnglishSegments clears all stored English segments
func (d *WhisperDecoder) clearEnglishSegments() {
	d.englishSegmentsMu.Lock()
	defer d.englishSegmentsMu.Unlock()
	d.englishSegments = make([]string, 0, d.maxEnglishSegments)
}

// encodeSegments encodes transcription segments into binary protocol
// Format: [type:1][timestamp:8][json_length:4][json:N]
// The JSON contains an array of segments with text, start, end, and completed fields
func (d *WhisperDecoder) encodeSegments(segmentsJSON []byte, timestamp int64) []byte {
	buf := make([]byte, 1+8+4+len(segmentsJSON))

	buf[0] = MessageTypeSegments
	binary.BigEndian.PutUint64(buf[1:9], uint64(timestamp))
	binary.BigEndian.PutUint32(buf[9:13], uint32(len(segmentsJSON)))
	copy(buf[13:], segmentsJSON)

	return buf
}

// encodeSummaryResponse encodes summary response into binary protocol
// Format: [type:1][timestamp:8][json_length:4][json:N]
// The JSON contains summary text and metadata
func (d *WhisperDecoder) encodeSummaryResponse(summaryJSON []byte, timestamp int64) []byte {
	buf := make([]byte, 1+8+4+len(summaryJSON))

	buf[0] = MessageTypeSummary
	binary.BigEndian.PutUint64(buf[1:9], uint64(timestamp))
	binary.BigEndian.PutUint32(buf[9:13], uint32(len(summaryJSON)))
	copy(buf[13:], summaryJSON)

	return buf
}

// translateText translates text using LibreTranslate API
// Returns the translated text, or the original text if translation fails or is not needed
func (d *WhisperDecoder) translateText(text, sourceLang, targetLang string) string {
	// Skip translation if not configured
	if d.config.LibreTranslateURL == "" {
		return text
	}

	// Skip translation if source and target are the same
	if sourceLang == targetLang {
		return text
	}

	// Skip translation if source is already English and target is English
	if sourceLang == "en" && targetLang == "en" {
		return text
	}

	// Prepare request body
	requestBody := map[string]interface{}{
		"q":      text,
		"source": sourceLang,
		"target": targetLang,
		"format": "text",
	}

	jsonData, err := json.Marshal(requestBody)
	if err != nil {
		log.Printf("[Whisper] Failed to marshal LibreTranslate request: %v", err)
		return text
	}

	// Create HTTP request with same headers as WhisperLive connection
	req, err := http.NewRequest("POST", d.config.LibreTranslateURL, bytes.NewBuffer(jsonData))
	if err != nil {
		log.Printf("[Whisper] Failed to create LibreTranslate request: %v", err)
		return text
	}

	req.Header.Set("Content-Type", "application/json")

	// Add same headers as WhisperLive WebSocket connection
	if d.config.InstanceUUID != "" {
		req.Header.Set("X-UberSDR-UUID", d.config.InstanceUUID)
	}
	if d.config.Model != "" {
		req.Header.Set("X-UberSDR-Model", d.config.Model)
	}
	if GlobalConfigProvider != nil && GlobalConfigProvider.MaxUsers > 0 {
		req.Header.Set("X-UberSDR-Max-Users", fmt.Sprintf("%d", GlobalConfigProvider.MaxUsers))
	}

	// Send request
	resp, err := d.httpClient.Do(req)
	if err != nil {
		log.Printf("[Whisper] LibreTranslate request failed: %v", err)
		return text
	}
	defer func() {
		if closeErr := resp.Body.Close(); closeErr != nil {
			log.Printf("[Whisper] Failed to close LibreTranslate response body: %v", closeErr)
		}
	}()

	// Check response status
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		log.Printf("[Whisper] LibreTranslate returned status %d: %s", resp.StatusCode, string(body))
		return text
	}

	// Parse response
	var result struct {
		TranslatedText string `json:"translatedText"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		log.Printf("[Whisper] Failed to decode LibreTranslate response: %v", err)
		return text
	}

	if result.TranslatedText == "" {
		log.Printf("[Whisper] LibreTranslate returned empty translation")
		return text
	}

	return result.TranslatedText
}

// summarizeText summarizes text using the summary API endpoint
// Returns the summary text, or the original text if summarization fails or is not configured
func (d *WhisperDecoder) summarizeText(text string) string {
	// Skip summarization if not configured
	if d.config.SummaryURL == "" {
		return text
	}

	// Skip summarization for very short text (less than 100 characters)
	if len(text) < 100 {
		return text
	}

	// Prepare request body
	requestBody := map[string]interface{}{
		"text": text,
	}

	jsonData, err := json.Marshal(requestBody)
	if err != nil {
		log.Printf("[Whisper] Failed to marshal summary request: %v", err)
		return text
	}

	// Create HTTP request with same headers as WhisperLive connection
	req, err := http.NewRequest("POST", d.config.SummaryURL, bytes.NewBuffer(jsonData))
	if err != nil {
		log.Printf("[Whisper] Failed to create summary request: %v", err)
		return text
	}

	req.Header.Set("Content-Type", "application/json")

	// Add same headers as WhisperLive WebSocket connection
	if d.config.InstanceUUID != "" {
		req.Header.Set("X-UberSDR-UUID", d.config.InstanceUUID)
	}
	if d.config.Model != "" {
		req.Header.Set("X-UberSDR-Model", d.config.Model)
	}
	if GlobalConfigProvider != nil && GlobalConfigProvider.MaxUsers > 0 {
		req.Header.Set("X-UberSDR-Max-Users", fmt.Sprintf("%d", GlobalConfigProvider.MaxUsers))
	}

	// Send request
	resp, err := d.httpClient.Do(req)
	if err != nil {
		log.Printf("[Whisper] Summary request failed: %v", err)
		return text
	}
	defer func() {
		if closeErr := resp.Body.Close(); closeErr != nil {
			log.Printf("[Whisper] Failed to close summary response body: %v", closeErr)
		}
	}()

	// Check response status
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		log.Printf("[Whisper] Summary API returned status %d: %s", resp.StatusCode, string(body))
		return text
	}

	// Parse response
	var result struct {
		InputLength  int    `json:"input_length"`
		OutputLength int    `json:"output_length"`
		Summary      string `json:"summary"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		log.Printf("[Whisper] Failed to decode summary response: %v", err)
		return text
	}

	if result.Summary == "" {
		log.Printf("[Whisper] Summary API returned empty summary")
		return text
	}

	log.Printf("[Whisper] Summarized text: %d chars -> %d chars", result.InputLength, result.OutputLength)
	return result.Summary
}

// encodeLanguageDetection encodes language detection into binary protocol
// Format: [type:1][timestamp:8][json_length:4][json:N]
// The JSON contains language and language_prob fields
func (d *WhisperDecoder) encodeLanguageDetection(languageJSON []byte, timestamp int64) []byte {
	buf := make([]byte, 1+8+4+len(languageJSON))

	buf[0] = MessageTypeLanguageDetection
	binary.BigEndian.PutUint64(buf[1:9], uint64(timestamp))
	binary.BigEndian.PutUint32(buf[9:13], uint32(len(languageJSON)))
	copy(buf[13:], languageJSON)

	return buf
}

// handleSummaryRequest processes a summary request from the frontend
// Request format: [type:1][n_segments:4]
// where n_segments is the number of segments to summarize
func (d *WhisperDecoder) handleSummaryRequest(message []byte, resultChan chan<- []byte) {
	// Validate message length (minimum: 1 byte type + 4 bytes n_segments)
	if len(message) < 5 {
		log.Printf("[Whisper] Invalid summary request: message too short (%d bytes)", len(message))
		d.sendErrorToFrontend(resultChan, "Invalid summary request: message too short")
		return
	}

	// Extract number of segments to summarize
	nSegments := int(binary.BigEndian.Uint32(message[1:5]))
	log.Printf("[Whisper] Summary request received: last %d segments", nSegments)

	// Validate n_segments
	if nSegments <= 0 {
		log.Printf("[Whisper] Invalid summary request: n_segments must be positive (got %d)", nSegments)
		d.sendErrorToFrontend(resultChan, fmt.Sprintf("Invalid summary request: n_segments must be positive (got %d)", nSegments))
		return
	}

	// Check if summary URL is configured
	if d.config.SummaryURL == "" {
		log.Printf("[Whisper] Summary request rejected: summary_url not configured")
		d.sendErrorToFrontend(resultChan, "Summary feature not configured (summary_url is empty)")
		return
	}

	// Get last n English segments
	segments := d.getLastNEnglishSegments(nSegments)
	if len(segments) == 0 {
		log.Printf("[Whisper] No segments available for summarization")
		d.sendErrorToFrontend(resultChan, "No segments available for summarization")
		return
	}

	log.Printf("[Whisper] Retrieved %d segments for summarization (requested %d)", len(segments), nSegments)

	// Build a single block of text from the segments (oldest first), capped at
	// 20,000 words.  If the cap is reached we trim to the last complete sentence
	// so the LLM always receives well-formed input.
	const maxWords = 20000
	wordCount := 0
	lastIncluded := 0 // index of the last segment included (exclusive)
	for lastIncluded < len(segments) {
		segWords := len(strings.Fields(segments[lastIncluded]))
		if wordCount+segWords > maxWords {
			break
		}
		wordCount += segWords
		lastIncluded++
	}

	inputText := strings.Join(segments[:lastIncluded], "\n")

	// If we stopped before the end, trim to the last complete sentence boundary.
	if lastIncluded < len(segments) {
		inputText = trimToLastSentence(inputText)
		log.Printf("[Whisper] Word limit reached after %d segments (~%d words); trimmed to last sentence", lastIncluded, wordCount)
	}

	log.Printf("[Whisper] Summarizing %d segments (~%d words)", lastIncluded, wordCount)

	summary := d.summarizeText(inputText)

	log.Printf("[Whisper] Summary generated, length: %d chars", len(summary))

	// If target language is not English, translate the concatenated summary
	if d.config.TargetLanguage != "" && d.config.TargetLanguage != "en" {
		log.Printf("[Whisper] Translating summary from English to %s", d.config.TargetLanguage)
		summary = d.translateText(summary, "en", d.config.TargetLanguage)
	}

	// Prepare response JSON
	responseData := map[string]interface{}{
		"summary":            summary,
		"segments_used":      len(segments),
		"segments_requested": nSegments,
		"target_language":    d.config.TargetLanguage,
	}

	responseJSON, err := json.Marshal(responseData)
	if err != nil {
		log.Printf("[Whisper] Failed to marshal summary response: %v", err)
		d.sendErrorToFrontend(resultChan, fmt.Sprintf("Failed to create summary response: %v", err))
		return
	}

	// Encode and send summary response
	encoded := d.encodeSummaryResponse(responseJSON, time.Now().UnixNano())

	// Send to result channel (non-blocking)
	select {
	case resultChan <- encoded:
		log.Printf("[Whisper] Summary response sent (%d segments, %d chars)", len(segments), len(summary))
	default:
		log.Printf("[Whisper] Result channel full, dropping summary response")
	}
}

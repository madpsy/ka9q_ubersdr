package whisper

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

/*
 * Whisper Decoder - Streaming Implementation
 * Connects to WhisperLive server via WebSocket for real-time transcription
 */

// WhisperConfig contains decoder configuration
type WhisperConfig struct {
	ServerURL      string // WebSocket URL (e.g., "ws://localhost:9090")
	Model          string // "tiny", "base", "small", "medium", "large"
	Language       string // "en", "es", "auto", etc.
	SendIntervalMs int    // How often to send audio chunks (milliseconds)
}

// DefaultWhisperConfig returns default configuration
func DefaultWhisperConfig() WhisperConfig {
	return WhisperConfig{
		ServerURL:      "ws://whisperlive:9090",
		Model:          "small",
		Language:       "en",
		SendIntervalMs: 100, // Send audio every 100ms
	}
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

	// Control
	running  bool
	stopChan chan struct{}
	wg       sync.WaitGroup
}

// NewWhisperDecoder creates a new Whisper decoder
func NewWhisperDecoder(sampleRate int, config WhisperConfig) *WhisperDecoder {
	return &WhisperDecoder{
		sampleRate:  sampleRate,
		config:      config,
		clientUID:   uuid.New().String(),
		audioBuffer: make([]int16, 0),
		stopChan:    make(chan struct{}),
	}
}

// Start begins the decoding process
func (d *WhisperDecoder) Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error {
	d.running = true

	// Connect to WhisperLive WebSocket
	if err := d.connectWebSocket(); err != nil {
		log.Printf("[Whisper] ERROR: Failed to connect to WhisperLive server at %s: %v", d.config.ServerURL, err)
		log.Printf("[Whisper] Make sure WhisperLive server is running on %s", d.config.ServerURL)
		return fmt.Errorf("failed to connect to WhisperLive: %w", err)
	}

	// Start audio sender goroutine
	d.wg.Add(1)
	go d.sendAudioLoop(audioChan)

	// Start result receiver goroutine
	d.wg.Add(1)
	go d.receiveResultsLoop(resultChan)

	return nil
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
	configMsg := map[string]interface{}{
		"uid":                   d.clientUID,
		"language":              d.config.Language,
		"task":                  "transcribe", // Required field - "transcribe" or "translate"
		"model":                 d.config.Model,
		"use_vad":               true,
		"send_last_n_segments":  10,
		"no_speech_thresh":      0.45,
		"clip_audio":            false,
		"same_output_threshold": 10,
		"enable_translation":    false,
		"target_language":       "en",
	}

	configJSON, err := json.Marshal(configMsg)
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	if err := conn.WriteMessage(websocket.TextMessage, configJSON); err != nil {
		return fmt.Errorf("failed to send config: %w", err)
	}

	log.Printf("[Whisper] Connected to WhisperLive at %s (uid: %s, model: %s, language: %s)",
		d.config.ServerURL, d.clientUID, d.config.Model, d.config.Language)

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

			// Convert int16 to float32 for Whisper (normalize to -1.0 to 1.0)
			floatData := make([]float32, len(audioToSend))
			for i, s := range audioToSend {
				floatData[i] = float32(s) / 32768.0
			}

			// Send as binary message
			d.wsConnMu.Lock()
			if d.wsConn != nil {
				// Convert float32 array to bytes (little-endian IEEE 754)
				buf := make([]byte, len(floatData)*4)
				for i, f := range floatData {
					bits := math.Float32bits(f)
					binary.LittleEndian.PutUint32(buf[i*4:], bits)
				}

				err := d.wsConn.WriteMessage(websocket.BinaryMessage, buf)
				if err != nil {
					log.Printf("[Whisper] Error sending audio: %v", err)
				}
			}
			d.wsConnMu.Unlock()
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
			time.Sleep(100 * time.Millisecond)
			continue
		}

		messageType, message, err := conn.ReadMessage()
		if err != nil {
			if d.running {
				log.Printf("[Whisper] WebSocket read error: %v, attempting reconnect...", err)
				// Try to reconnect
				if reconnectErr := d.reconnectWebSocket(); reconnectErr != nil {
					log.Printf("[Whisper] Reconnect failed: %v", reconnectErr)
					time.Sleep(5 * time.Second) // Wait before next attempt
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
				case "DISCONNECT":
					log.Printf("[Whisper] Server disconnected")
					return
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
				continue
			}

			// Handle transcription segments
			if segments, ok := result["segments"].([]interface{}); ok && len(segments) > 0 {
				// Send segments as JSON to frontend
				// The frontend will handle completed vs incomplete segments
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

// encodeSegments encodes transcription segments into binary protocol
// Format: [type:1][timestamp:8][json_length:4][json:N]
// The JSON contains an array of segments with text, start, end, and completed fields
func (d *WhisperDecoder) encodeSegments(segmentsJSON []byte, timestamp int64) []byte {
	buf := make([]byte, 1+8+4+len(segmentsJSON))

	buf[0] = 0x02 // Message type: segments (changed from 0x01)
	binary.BigEndian.PutUint64(buf[1:9], uint64(timestamp))
	binary.BigEndian.PutUint32(buf[9:13], uint32(len(segmentsJSON)))
	copy(buf[13:], segmentsJSON)

	return buf
}

package whisper

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

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
		ServerURL:      "ws://localhost:9090",
		Model:          "base",
		Language:       "en",
		SendIntervalMs: 100, // Send audio every 100ms
	}
}

// WhisperDecoder handles streaming audio to WhisperLive
type WhisperDecoder struct {
	sampleRate int
	config     WhisperConfig

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
		audioBuffer: make([]int16, 0),
		stopChan:    make(chan struct{}),
	}
}

// Start begins the decoding process
func (d *WhisperDecoder) Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error {
	d.running = true

	// Connect to WhisperLive WebSocket
	if err := d.connectWebSocket(); err != nil {
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

	// Send initial configuration to WhisperLive
	configMsg := map[string]interface{}{
		"type":        "config",
		"model":       d.config.Model,
		"language":    d.config.Language,
		"sample_rate": d.sampleRate,
	}

	configJSON, err := json.Marshal(configMsg)
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	if err := conn.WriteMessage(websocket.TextMessage, configJSON); err != nil {
		return fmt.Errorf("failed to send config: %w", err)
	}

	log.Printf("[Whisper] Connected to WhisperLive at %s (model: %s, language: %s, sample rate: %d Hz)",
		d.config.ServerURL, d.config.Model, d.config.Language, d.sampleRate)

	return nil
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

			// Convert int16 to float32 for Whisper
			floatData := make([]float32, len(audioToSend))
			for i, s := range audioToSend {
				floatData[i] = float32(s) / 32768.0
			}

			// Send as binary message
			d.wsConnMu.Lock()
			if d.wsConn != nil {
				// Convert float32 array to bytes (little-endian)
				buf := make([]byte, len(floatData)*4)
				for i, f := range floatData {
					binary.LittleEndian.PutUint32(buf[i*4:], uint32(f))
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
				log.Printf("[Whisper] WebSocket read error: %v", err)
			}
			return
		}

		if messageType == websocket.TextMessage {
			// Parse transcription result from WhisperLive
			var result struct {
				Type string `json:"type"`
				Text string `json:"text"`
			}

			if err := json.Unmarshal(message, &result); err != nil {
				log.Printf("[Whisper] JSON parse error: %v", err)
				continue
			}

			// Only process transcription messages with non-empty text
			if result.Type == "transcription" && result.Text != "" {
				// Encode result for client
				encoded := d.encodeResult(result.Text, time.Now().UnixNano())

				// Send to result channel (non-blocking)
				select {
				case resultChan <- encoded:
				default:
					log.Printf("[Whisper] Result channel full, dropping transcription")
				}
			}
		}
	}
}

// encodeResult encodes transcription text into binary protocol
// Format: [type:1][timestamp:8][text_length:4][text:N]
func (d *WhisperDecoder) encodeResult(text string, timestamp int64) []byte {
	textBytes := []byte(text)
	buf := make([]byte, 1+8+4+len(textBytes))

	buf[0] = 0x01 // Message type: transcription
	binary.BigEndian.PutUint64(buf[1:9], uint64(timestamp))
	binary.BigEndian.PutUint32(buf[9:13], uint32(len(textBytes)))
	copy(buf[13:], textBytes)

	return buf
}

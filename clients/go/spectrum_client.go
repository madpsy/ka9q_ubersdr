package main

import (
	"compress/gzip"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// SpectrumClient manages the spectrum WebSocket connection to the UberSDR server
type SpectrumClient struct {
	serverURL      string
	userSessionID  string
	password       string
	conn           *websocket.Conn
	mu             sync.RWMutex
	connected      bool
	running        bool
	ctx            context.Context
	cancel         context.CancelFunc
	dataCallback   func([]byte)                 // Callback to send spectrum data to frontend clients
	configCallback func(map[string]interface{}) // Callback for config updates

	// Spectrum configuration state (from config messages)
	centerFreq     float64 // Center frequency of spectrum in Hz
	totalBandwidth float64 // Total bandwidth of spectrum in Hz
	binCount       int     // Number of spectrum bins

	// Rate limiting for commands (10 per second max)
	lastCommandTime time.Time
	commandMu       sync.Mutex
	minCommandDelay time.Duration

	// Binary protocol support
	usingBinaryProtocol bool
	binarySpectrumData  []float32 // State for delta decoding (float32)
	binarySpectrumData8 []uint8   // State for delta decoding (uint8)

	// Format tracking - what format we're receiving from the ubersdr instance
	spectrumFormat string // "JSON", "Binary", or "Binary8" - format received from UberSDR instance
}

// NewSpectrumClient creates a new spectrum client
func NewSpectrumClient(serverURL, userSessionID, password string) *SpectrumClient {
	ctx, cancel := context.WithCancel(context.Background())

	return &SpectrumClient{
		serverURL:       serverURL,
		userSessionID:   userSessionID,
		password:        password,
		ctx:             ctx,
		cancel:          cancel,
		minCommandDelay: 100 * time.Millisecond, // 10 commands per second max
		lastCommandTime: time.Time{},
	}
}

// Connect establishes connection to the spectrum WebSocket endpoint
func (s *SpectrumClient) Connect() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.connected {
		return fmt.Errorf("already connected")
	}

	// Parse server URL and build WebSocket URL
	u, err := url.Parse(s.serverURL)
	if err != nil {
		return fmt.Errorf("invalid server URL: %w", err)
	}

	// Convert http/https to ws/wss
	scheme := "ws"
	if u.Scheme == "https" {
		scheme = "wss"
	}

	// Build WebSocket URL with query parameters
	wsURL := fmt.Sprintf("%s://%s/ws/user-spectrum", scheme, u.Host)
	query := url.Values{}
	if s.userSessionID != "" {
		query.Set("user_session_id", s.userSessionID)
	}
	if s.password != "" {
		query.Set("password", s.password)
	}
	// Request binary8 mode for maximum bandwidth reduction (8-bit encoding)
	query.Set("mode", "binary8")
	wsURL = fmt.Sprintf("%s?%s", wsURL, query.Encode())

	log.Printf("Connecting to spectrum WebSocket: %s", wsURL)

	// Connect to WebSocket
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		return fmt.Errorf("failed to connect to spectrum WebSocket: %w", err)
	}

	s.conn = conn
	s.connected = true
	s.running = true

	// Start message handler
	go s.handleMessages()

	log.Printf("Spectrum WebSocket connected")
	return nil
}

// Disconnect closes the spectrum WebSocket connection
func (s *SpectrumClient) Disconnect() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.connected {
		return fmt.Errorf("not connected")
	}

	s.running = false
	s.connected = false

	if s.conn != nil {
		s.conn.Close()
		s.conn = nil
	}

	log.Printf("Spectrum WebSocket disconnected")
	return nil
}

// IsConnected returns whether the spectrum client is connected
func (s *SpectrumClient) IsConnected() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.connected
}

// GetSpectrumFormat returns the detected spectrum format ("JSON" or "Binary")
func (s *SpectrumClient) GetSpectrumFormat() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.spectrumFormat
}

// SetDataCallback sets the callback for spectrum data
func (s *SpectrumClient) SetDataCallback(callback func([]byte)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dataCallback = callback
}

// SetConfigCallback sets the callback for config updates
func (s *SpectrumClient) SetConfigCallback(callback func(map[string]interface{})) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.configCallback = callback
}

// SendZoomCommand sends a zoom command to change spectrum bandwidth
func (s *SpectrumClient) SendZoomCommand(frequency int, binBandwidth float64) error {
	// Apply rate limiting
	s.commandMu.Lock()
	now := time.Now()
	timeSinceLastCommand := now.Sub(s.lastCommandTime)

	if timeSinceLastCommand < s.minCommandDelay && !s.lastCommandTime.IsZero() {
		// Too soon since last command, drop this one (throttled)
		s.commandMu.Unlock()
		return nil
	}

	s.lastCommandTime = now
	s.commandMu.Unlock()

	s.mu.RLock()
	defer s.mu.RUnlock()

	if !s.connected || s.conn == nil {
		return fmt.Errorf("not connected")
	}

	command := map[string]interface{}{
		"type":         "zoom",
		"frequency":    frequency,
		"binBandwidth": binBandwidth,
	}

	log.Printf("Spectrum command: type=zoom, params=map[binBandwidth:%v frequency:%v type:zoom]", binBandwidth, frequency)
	return s.conn.WriteJSON(command)
}

// SendPanCommand sends a pan command to change center frequency
func (s *SpectrumClient) SendPanCommand(frequency int) error {
	// Apply rate limiting
	s.commandMu.Lock()
	now := time.Now()
	timeSinceLastCommand := now.Sub(s.lastCommandTime)

	if timeSinceLastCommand < s.minCommandDelay && !s.lastCommandTime.IsZero() {
		// Too soon since last command, drop this one (throttled)
		s.commandMu.Unlock()
		return nil
	}

	s.lastCommandTime = now
	s.commandMu.Unlock()

	s.mu.RLock()
	defer s.mu.RUnlock()

	if !s.connected || s.conn == nil {
		return fmt.Errorf("not connected")
	}

	command := map[string]interface{}{
		"type":      "pan",
		"frequency": frequency,
	}

	log.Printf("Spectrum command: type=pan, params=map[frequency:%v type:pan]", frequency)
	return s.conn.WriteJSON(command)
}

// handleMessages processes incoming WebSocket messages
func (s *SpectrumClient) handleMessages() {
	defer func() {
		s.mu.Lock()
		s.connected = false
		s.running = false
		if s.conn != nil {
			s.conn.Close()
			s.conn = nil
		}
		s.mu.Unlock()
	}()

	for s.running {
		s.mu.RLock()
		conn := s.conn
		s.mu.RUnlock()

		if conn == nil {
			break
		}

		// Set read deadline
		conn.SetReadDeadline(time.Now().Add(30 * time.Second))

		// Read message
		messageType, message, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("Spectrum WebSocket error: %v", err)
			}
			break
		}

		// Handle message based on type
		if messageType == websocket.BinaryMessage {
			// Check for binary spectrum protocol magic header "SPEC"
			if len(message) >= 4 && string(message[0:4]) == "SPEC" {
				// Binary spectrum protocol detected
				if !s.usingBinaryProtocol {
					s.usingBinaryProtocol = true
					log.Printf("🚀 Binary spectrum protocol detected - bandwidth optimized!")
					// Format will be set in handleBinarySpectrumMessage based on flags
				}
				// Parse binary spectrum message
				s.handleBinarySpectrumMessage(message)
			} else {
				// Legacy binary message - decompress with gzip
				s.handleBinaryMessage(message)
			}
		} else if messageType == websocket.TextMessage {
			// Text message - parse JSON directly
			// Set spectrum format to JSON on first text message
			if s.spectrumFormat == "" {
				s.spectrumFormat = "JSON"
				log.Printf("JSON spectrum protocol detected")
			}
			s.handleTextMessage(message)
		}
	}

	log.Printf("Spectrum message handler stopped")
}

// handleBinaryMessage handles gzip-compressed binary messages
func (s *SpectrumClient) handleBinaryMessage(message []byte) {
	// Decompress gzip
	reader, err := gzip.NewReader(io.NopCloser(io.Reader(newBytesReader(message))))
	if err != nil {
		log.Printf("Failed to create gzip reader: %v", err)
		return
	}
	defer reader.Close()

	decompressed, err := io.ReadAll(reader)
	if err != nil {
		log.Printf("Failed to decompress message: %v", err)
		return
	}

	// Parse JSON
	s.handleTextMessage(decompressed)
}

// handleTextMessage handles JSON text messages
func (s *SpectrumClient) handleTextMessage(message []byte) {
	var data map[string]interface{}
	if err := json.Unmarshal(message, &data); err != nil {
		log.Printf("Failed to parse spectrum message: %v", err)
		return
	}

	msgType, ok := data["type"].(string)
	if !ok {
		return
	}

	switch msgType {
	case "config":
		// Configuration update - extract and store config state
		if centerFreq, ok := data["centerFreq"].(float64); ok {
			s.mu.Lock()
			s.centerFreq = centerFreq
			s.mu.Unlock()
		}
		if totalBandwidth, ok := data["totalBandwidth"].(float64); ok {
			s.mu.Lock()
			s.totalBandwidth = totalBandwidth
			s.mu.Unlock()
		}
		if binCount, ok := data["binCount"].(float64); ok {
			s.mu.Lock()
			s.binCount = int(binCount)
			s.mu.Unlock()
		}

		// Forward config to frontend clients
		s.mu.RLock()
		callback := s.dataCallback
		s.mu.RUnlock()

		if callback != nil {
			// Re-encode as JSON to send to frontend
			jsonData, err := json.Marshal(data)
			if err != nil {
				log.Printf("Failed to marshal config data: %v", err)
				return
			}
			callback(jsonData)
		}

	case "spectrum":
		// Spectrum data update - enrich with config state before forwarding
		s.mu.RLock()
		centerFreq := s.centerFreq
		totalBandwidth := s.totalBandwidth
		callback := s.dataCallback
		s.mu.RUnlock()

		// Add config data to spectrum message for signal level calculation
		// Note: We do NOT unwrap FFT bins here because the web UI expects raw FFT order
		// The unwrapping happens in updateTCISignalLevel() for TCI signal calculation only
		if centerFreq > 0 && totalBandwidth > 0 {
			data["centerFreq"] = centerFreq
			data["totalBandwidth"] = totalBandwidth
		}

		if callback != nil {
			// Re-encode as JSON to send to frontend
			jsonData, err := json.Marshal(data)
			if err != nil {
				log.Printf("Failed to marshal spectrum data: %v", err)
				return
			}
			callback(jsonData)
		}
	}
}

// Helper to create bytes reader from byte slice
func newBytesReader(b []byte) io.Reader {
	return &bytesReader{b: b}
}

type bytesReader struct {
	b []byte
	i int
}

func (r *bytesReader) Read(p []byte) (n int, err error) {
	if r.i >= len(r.b) {
		return 0, io.EOF
	}
	n = copy(p, r.b[r.i:])
	r.i += n
	return n, nil
}

// handleBinarySpectrumMessage handles binary spectrum protocol messages
// Binary format:
// - Header (22 bytes):
//   - Magic: 0x53 0x50 0x45 0x43 (4 bytes) "SPEC"
//   - Version: 0x01 (1 byte)
//   - Flags: 0x01=full (float32), 0x02=delta (float32), 0x03=full (uint8), 0x04=delta (uint8) (1 byte)
//   - Timestamp: uint64 milliseconds (8 bytes, little-endian)
//   - Frequency: uint64 Hz (8 bytes, little-endian)
//
// - For full frame (float32): all bins as float32 (binCount * 4 bytes, little-endian)
// - For delta frame (float32):
//   - ChangeCount: uint16 (2 bytes, little-endian)
//   - Changes: array of [index: uint16, value: float32] (6 bytes each, little-endian)
//
// - For full frame (uint8): all bins as uint8 (binCount * 1 byte)
// - For delta frame (uint8):
//   - ChangeCount: uint16 (2 bytes, little-endian)
//   - Changes: array of [index: uint16, value: uint8] (3 bytes each, little-endian)
func (s *SpectrumClient) handleBinarySpectrumMessage(message []byte) {
	if len(message) < 22 {
		log.Printf("Binary message too short: %d bytes", len(message))
		return
	}

	// Parse header
	magic := string(message[0:4])
	if magic != "SPEC" {
		log.Printf("Invalid magic: %s", magic)
		return
	}

	version := message[4]
	if version != 0x01 {
		log.Printf("Unsupported version: %d", version)
		return
	}

	flags := message[5]
	timestamp := binary.LittleEndian.Uint64(message[6:14])
	frequency := binary.LittleEndian.Uint64(message[14:22])

	var spectrumData []float32

	if flags == 0x01 {
		// Full frame (float32)
		binCount := (len(message) - 22) / 4
		spectrumData = make([]float32, binCount)

		for i := 0; i < binCount; i++ {
			offset := 22 + i*4
			bits := binary.LittleEndian.Uint32(message[offset : offset+4])
			spectrumData[i] = math.Float32frombits(bits)
		}

		// Store for delta decoding
		s.mu.Lock()
		s.binarySpectrumData = make([]float32, len(spectrumData))
		copy(s.binarySpectrumData, spectrumData)
		s.spectrumFormat = "Binary"
		s.mu.Unlock()

	} else if flags == 0x02 {
		// Delta frame (float32)
		s.mu.Lock()
		if s.binarySpectrumData == nil {
			s.mu.Unlock()
			log.Printf("Delta frame received before full frame")
			return
		}

		changeCount := binary.LittleEndian.Uint16(message[22:24])
		offset := 24

		// Apply changes to previous data
		for i := 0; i < int(changeCount); i++ {
			index := binary.LittleEndian.Uint16(message[offset : offset+2])
			bits := binary.LittleEndian.Uint32(message[offset+2 : offset+6])
			value := math.Float32frombits(bits)
			if int(index) < len(s.binarySpectrumData) {
				s.binarySpectrumData[index] = value
			}
			offset += 6
		}

		spectrumData = s.binarySpectrumData
		s.mu.Unlock()

	} else if flags == 0x03 {
		// Full frame (uint8) - binary8 format
		binCount := len(message) - 22
		spectrumData = make([]float32, binCount)

		// Read uint8 values and convert to dBFS
		for i := 0; i < binCount; i++ {
			uint8Value := message[22+i]
			// Convert: 0 = -256 dB, 255 = -1 dB
			spectrumData[i] = float32(uint8Value) - 256.0
		}

		// Store uint8 data for delta decoding
		s.mu.Lock()
		s.binarySpectrumData8 = make([]uint8, binCount)
		copy(s.binarySpectrumData8, message[22:])
		s.spectrumFormat = "Binary8"
		s.mu.Unlock()

		// Log first binary8 frame
		log.Printf("🚀 Binary8 protocol active - 75%% bandwidth reduction vs float32!")

	} else if flags == 0x04 {
		// Delta frame (uint8) - binary8 format
		s.mu.Lock()
		if s.binarySpectrumData8 == nil {
			s.mu.Unlock()
			log.Printf("Binary8 delta frame received before full frame")
			return
		}

		changeCount := binary.LittleEndian.Uint16(message[22:24])
		offset := 24

		// Apply changes to previous uint8 data
		for i := 0; i < int(changeCount); i++ {
			index := binary.LittleEndian.Uint16(message[offset : offset+2])
			value := message[offset+2] // uint8 value
			if int(index) < len(s.binarySpectrumData8) {
				s.binarySpectrumData8[index] = value
			}
			offset += 3 // 2 bytes index + 1 byte value
		}

		// Convert uint8 array to float32 for display
		spectrumData = make([]float32, len(s.binarySpectrumData8))
		for i := 0; i < len(s.binarySpectrumData8); i++ {
			spectrumData[i] = float32(s.binarySpectrumData8[i]) - 256.0
		}
		s.mu.Unlock()

	} else {
		log.Printf("Unknown flags: %d", flags)
		return
	}

	// Convert to JSON format for frontend compatibility
	data := map[string]interface{}{
		"type":      "spectrum",
		"data":      spectrumData,
		"frequency": frequency,
		"timestamp": timestamp,
	}

	// Add config data if available
	s.mu.RLock()
	if s.centerFreq > 0 && s.totalBandwidth > 0 {
		data["centerFreq"] = s.centerFreq
		data["totalBandwidth"] = s.totalBandwidth
	}
	callback := s.dataCallback
	s.mu.RUnlock()

	if callback != nil {
		// Encode as JSON to send to frontend
		jsonData, err := json.Marshal(data)
		if err != nil {
			log.Printf("Failed to marshal binary spectrum data: %v", err)
			return
		}
		callback(jsonData)
	}
}

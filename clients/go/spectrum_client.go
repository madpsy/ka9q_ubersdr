package main

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
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
}

// NewSpectrumClient creates a new spectrum client
func NewSpectrumClient(serverURL, userSessionID, password string) *SpectrumClient {
	ctx, cancel := context.WithCancel(context.Background())
	return &SpectrumClient{
		serverURL:     serverURL,
		userSessionID: userSessionID,
		password:      password,
		ctx:           ctx,
		cancel:        cancel,
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
	if s.userSessionID != "" || s.password != "" {
		query := url.Values{}
		if s.userSessionID != "" {
			query.Set("user_session_id", s.userSessionID)
		}
		if s.password != "" {
			query.Set("password", s.password)
		}
		wsURL = fmt.Sprintf("%s?%s", wsURL, query.Encode())
	}

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

	return s.conn.WriteJSON(command)
}

// SendPanCommand sends a pan command to change center frequency
func (s *SpectrumClient) SendPanCommand(frequency int) error {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if !s.connected || s.conn == nil {
		return fmt.Errorf("not connected")
	}

	command := map[string]interface{}{
		"type":      "pan",
		"frequency": frequency,
	}

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
			// Binary message - decompress with gzip
			s.handleBinaryMessage(message)
		} else if messageType == websocket.TextMessage {
			// Text message - parse JSON directly
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
		// Configuration update
		s.mu.RLock()
		callback := s.configCallback
		s.mu.RUnlock()

		if callback != nil {
			callback(data)
		}

	case "spectrum":
		// Spectrum data update - forward to frontend clients
		s.mu.RLock()
		callback := s.dataCallback
		s.mu.RUnlock()

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

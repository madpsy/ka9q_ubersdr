package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

// UserSpectrumWebSocketHandler handles per-user spectrum WebSocket connections
type UserSpectrumWebSocketHandler struct {
	sessions *SessionManager
}

// NewUserSpectrumWebSocketHandler creates a new per-user spectrum WebSocket handler
func NewUserSpectrumWebSocketHandler(sessions *SessionManager) *UserSpectrumWebSocketHandler {
	return &UserSpectrumWebSocketHandler{
		sessions: sessions,
	}
}

// UserSpectrumClientMessage represents a message from the client
type UserSpectrumClientMessage struct {
	Type         string  `json:"type"`
	Frequency    uint64  `json:"frequency,omitempty"`    // Center frequency for pan
	BinBandwidth float64 `json:"binBandwidth,omitempty"` // Bandwidth per bin for zoom
}

// UnmarshalJSON implements custom JSON unmarshaling to handle both float and int for Frequency
func (m *UserSpectrumClientMessage) UnmarshalJSON(data []byte) error {
	// Use a temporary struct with float64 for Frequency to accept both types
	type Alias struct {
		Type         string   `json:"type"`
		Frequency    *float64 `json:"frequency,omitempty"`
		BinBandwidth *float64 `json:"binBandwidth,omitempty"`
	}

	var aux Alias
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}

	m.Type = aux.Type

	// Convert frequency from float64 to uint64, rounding if necessary
	if aux.Frequency != nil {
		if *aux.Frequency < 0 {
			m.Frequency = 0
		} else {
			m.Frequency = uint64(*aux.Frequency + 0.5) // Round to nearest integer
		}
	}

	// BinBandwidth can stay as float64
	if aux.BinBandwidth != nil {
		m.BinBandwidth = *aux.BinBandwidth
	}

	return nil
}

// UserSpectrumServerMessage represents a message to the client
type UserSpectrumServerMessage struct {
	Type         string      `json:"type"`
	Data         []float32   `json:"data,omitempty"`         // Spectrum bin data
	Frequency    uint64      `json:"frequency,omitempty"`    // Current center frequency
	BinCount     int         `json:"binCount,omitempty"`     // Number of bins (constant)
	BinBandwidth float64     `json:"binBandwidth,omitempty"` // Bandwidth per bin
	SessionID    string      `json:"sessionId,omitempty"`
	Error        string      `json:"error,omitempty"`
	Info         interface{} `json:"info,omitempty"`
}

// HandleSpectrumWebSocket handles spectrum WebSocket connections
func (swsh *UserSpectrumWebSocketHandler) HandleSpectrumWebSocket(w http.ResponseWriter, r *http.Request) {
	// Upgrade HTTP connection to WebSocket
	rawConn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Failed to upgrade spectrum connection: %v", err)
		return
	}

	log.Printf("Spectrum WebSocket connected - Using manual gzip compression")

	conn := &wsConn{conn: rawConn, aggregator: globalStatsSpectrum}
	globalStatsSpectrum.addConnection()
	defer func() {
		globalStatsSpectrum.removeConnection()
		conn.close()
	}()

	// Start stats logger if not already running
	startStatsLogger()

	// Create spectrum session with default parameters
	session, err := swsh.sessions.CreateSpectrumSession()
	if err != nil {
		log.Printf("Failed to create spectrum session: %v", err)
		swsh.sendError(conn, "Failed to create spectrum session: "+err.Error())
		return
	}

	log.Printf("Spectrum WebSocket connected: session %s", session.ID)

	// Send initial status
	swsh.sendStatus(conn, session)

	// Start spectrum streaming goroutine
	done := make(chan struct{})
	go swsh.streamSpectrum(conn, session, done)

	// Handle incoming messages
	swsh.handleMessages(conn, session, done)

	// Cleanup
	swsh.sessions.DestroySession(session.ID)
}

// handleMessages processes incoming WebSocket messages
func (swsh *UserSpectrumWebSocketHandler) handleMessages(conn *wsConn, session *Session, done chan struct{}) {
	defer close(done)

	for {
		var msg UserSpectrumClientMessage
		err := conn.readJSON(&msg)
		if err != nil {
			// Check if it's a normal close
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("Spectrum WebSocket error: %v", err)
			}
			// For any error (including JSON parsing), close the connection
			// This is appropriate because we can't recover from a malformed message stream
			break
		}

		// Update last active time
		swsh.sessions.TouchSession(session.ID)

		// Handle message based on type
		switch msg.Type {
		case "reset":
			// Reset to full bandwidth view
			defaultFreq := swsh.sessions.config.Spectrum.Default.CenterFrequency
			defaultBinBW := swsh.sessions.config.Spectrum.Default.BinBandwidth
			defaultBinCount := swsh.sessions.config.Spectrum.Default.BinCount

			// Check if already at defaults
			if session.Frequency == defaultFreq && session.BinBandwidth == defaultBinBW && session.BinCount == defaultBinCount {
				log.Printf("Spectrum session %s already at defaults (freq: %d Hz, bins: %d, bw: %.1f Hz) - skipping radiod update",
					session.ID, defaultFreq, defaultBinCount, defaultBinBW)

				// Still send status to acknowledge the request
				swsh.sendStatus(conn, session)
			} else {
				log.Printf("Resetting spectrum session %s to defaults: freq %d Hz, bins %d, bw %.1f Hz",
					session.ID, defaultFreq, defaultBinCount, defaultBinBW)

				if err := swsh.sessions.UpdateSpectrumSession(session.ID, defaultFreq, defaultBinBW, defaultBinCount); err != nil {
					swsh.sendError(conn, "Failed to reset spectrum: "+err.Error())
					continue
				}

				// Send updated status
				swsh.sendStatus(conn, session)
			}

		case "zoom", "pan":
			// Update spectrum parameters (zoom changes bin_bw, pan changes frequency)
			newFreq := session.Frequency
			newBinBW := session.BinBandwidth
			newBinCount := session.BinCount

			if msg.Frequency > 0 {
				// Enforce minimum center frequency of 100 kHz
				const minCenterFreq = 100000 // 100 kHz
				if msg.Frequency < minCenterFreq {
					log.Printf("Rejecting spectrum update: center frequency %d Hz < minimum %d Hz (100 kHz)",
						msg.Frequency, minCenterFreq)
					swsh.sendError(conn, "Center frequency must be at least 100 kHz")
					continue
				}
				newFreq = msg.Frequency
			}
			if msg.BinBandwidth > 0 {
				newBinBW = msg.BinBandwidth
			}

			// Smart zoom logic: dynamically adjust bin_count for deep zoom levels
			// Keep current behavior up to 256x zoom (bin_bw down to safe minimum)
			// Beyond that, reduce bin_count to allow deeper zooming
			session.mu.RLock()
			defaultBinCount := swsh.sessions.config.Spectrum.Default.BinCount
			currentBinCount := session.BinCount
			session.mu.RUnlock()

			// Radiod has constraints on valid sample rates (must be compatible with block rate)
			// Safe bin_bw values that work with radiod: 50, 100, 200, 500, 1000, 2000, 5000 Hz
			// Below 50 Hz, we need to reduce bin_count instead
			const minSafeBinBW = 50.0        // Minimum safe bin_bw before reducing bin_count
			const maxBinBWForRestore = 200.0 // Above this, restore bin_count if reduced

			// Round bin_bw to nearest safe value
			safeBinBW := newBinBW
			if newBinBW < 50 {
				safeBinBW = 50
			} else if newBinBW < 75 {
				safeBinBW = 50
			} else if newBinBW < 150 {
				safeBinBW = 100
			} else if newBinBW < 350 {
				safeBinBW = 200
			} else if newBinBW < 750 {
				safeBinBW = 500
			} else if newBinBW < 1500 {
				safeBinBW = 1000
			} else if newBinBW < 3500 {
				safeBinBW = 2000
			} else if newBinBW < 7500 {
				safeBinBW = 5000
			} else {
				// For very large bin bandwidths (e.g., default 29296.875 for full 0-30 MHz),
				// don't round - pass through as-is for full bandwidth view
				safeBinBW = newBinBW
			}

			// If user is trying to zoom deeper than min safe bin_bw, reduce bin_count instead
			if newBinBW < minSafeBinBW && currentBinCount > 256 {
				// Reduce bin_count by half, keep bin_bw at safe minimum
				newBinCount = currentBinCount / 2
				if newBinCount < 256 {
					newBinCount = 256 // Minimum bin count
				}
				newBinBW = minSafeBinBW
				log.Printf("Deep zoom: reducing bin_count from %d to %d, keeping bin_bw at %.1f Hz",
					currentBinCount, newBinCount, newBinBW)
			} else if newBinBW > maxBinBWForRestore && currentBinCount < defaultBinCount {
				// Zooming out: restore bin_count if it was reduced
				newBinCount = currentBinCount * 2
				if newBinCount > defaultBinCount {
					newBinCount = defaultBinCount
				}
				newBinBW = safeBinBW
				log.Printf("Zoom out: restoring bin_count from %d to %d, bin_bw %.1f Hz",
					currentBinCount, newBinCount, newBinBW)
			} else {
				// Normal zoom: use safe bin_bw value
				newBinBW = safeBinBW
			}

			// Only update if something changed
			if newFreq != session.Frequency || newBinBW != session.BinBandwidth || newBinCount != session.BinCount {
				log.Printf("Updating spectrum session %s: freq %d -> %d Hz, bins %d -> %d, bw %.1f -> %.1f Hz",
					session.ID, session.Frequency, newFreq, session.BinCount, newBinCount, session.BinBandwidth, newBinBW)

				if err := swsh.sessions.UpdateSpectrumSession(session.ID, newFreq, newBinBW, newBinCount); err != nil {
					swsh.sendError(conn, "Failed to update spectrum: "+err.Error())
					continue
				}

				// Send updated status
				swsh.sendStatus(conn, session)
			} else {
				// State is already correct, accept request but don't send to radiod
				log.Printf("Spectrum session %s already at requested state (freq: %d Hz, bins: %d, bw: %.1f Hz) - skipping radiod update",
					session.ID, newFreq, newBinCount, newBinBW)

				// Still send status to acknowledge the request
				swsh.sendStatus(conn, session)
			}

		case "ping":
			// Keepalive
			swsh.sendMessage(conn, UserSpectrumServerMessage{Type: "pong"})

		case "get_status":
			swsh.sendStatus(conn, session)

		default:
			log.Printf("Unknown spectrum message type: %s", msg.Type)
		}
	}
}

// streamSpectrum streams spectrum data to the client
func (swsh *UserSpectrumWebSocketHandler) streamSpectrum(conn *wsConn, session *Session, done <-chan struct{}) {
	for {
		select {
		case <-done:
			return

		case <-session.Done:
			return

		case spectrumData, ok := <-session.SpectrumChan:
			if !ok {
				return
			}

			if DebugMode {
				// Calculate min/max/avg for debugging
				min, max, sum := float32(999), float32(-999), float32(0)
				for _, v := range spectrumData {
					if v < min {
						min = v
					}
					if v > max {
						max = v
					}
					sum += v
				}
				// Removed debug logging
			}

			// Send spectrum message
			msg := UserSpectrumServerMessage{
				Type:         "spectrum",
				Data:         spectrumData,
				Frequency:    session.Frequency,
				BinCount:     session.BinCount,
				BinBandwidth: session.BinBandwidth,
			}

			if err := swsh.sendMessage(conn, msg); err != nil {
				log.Printf("Failed to send spectrum data: %v", err)
				return
			}
		}
	}
}

// sendStatus sends current session status to client
// Sends as "config" message to match what spectrum-display.js expects
func (swsh *UserSpectrumWebSocketHandler) sendStatus(conn *wsConn, session *Session) error {
	session.mu.RLock()
	totalBandwidth := float64(session.BinCount) * session.BinBandwidth

	// Create message matching the format spectrum-display.js expects
	// It looks for: centerFreq, binCount, binBandwidth, totalBandwidth
	msg := map[string]interface{}{
		"type":           "config",
		"centerFreq":     session.Frequency, // JavaScript expects centerFreq (camelCase)
		"binCount":       session.BinCount,
		"binBandwidth":   session.BinBandwidth,
		"totalBandwidth": totalBandwidth,
		"sessionId":      session.ID,
	}
	session.mu.RUnlock()

	conn.setWriteDeadline(time.Now().Add(10 * time.Second))
	return conn.writeJSONCompressed(msg)
}

// sendError sends an error message to the client
func (swsh *UserSpectrumWebSocketHandler) sendError(conn *wsConn, errMsg string) error {
	msg := UserSpectrumServerMessage{
		Type:  "error",
		Error: errMsg,
	}
	return swsh.sendMessage(conn, msg)
}

// sendMessage sends a message to the client
func (swsh *UserSpectrumWebSocketHandler) sendMessage(conn *wsConn, msg UserSpectrumServerMessage) error {
	conn.setWriteDeadline(time.Now().Add(10 * time.Second))
	return conn.writeJSONCompressed(msg)
}

// Helper function to convert spectrum data to JSON-friendly format
func spectrumToJSON(data []float32) string {
	bytes, _ := json.Marshal(data)
	return string(bytes)
}

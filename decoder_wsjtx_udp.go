package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"log"
	"net"
	"sync"
	"time"
)

// WSJTXUDPBroadcaster broadcasts decoded spots using the WSJT-X UDP protocol
// This allows third-party applications like JTAlert, GridTracker, etc. to receive spots
type WSJTXUDPBroadcaster struct {
	enabled         bool
	host            string
	port            int
	enabledModes    map[string]bool // e.g., {"FT8": true, "FT4": false, "WSPR": false}
	clientID        string
	schemaVersion   uint32
	conn            *net.UDPConn
	remoteAddr      *net.UDPAddr
	mu              sync.RWMutex // Protects state (running, enabled, etc.)
	sendMutex       sync.Mutex   // Serializes UDP sends to prevent batch interleaving
	heartbeatTicker *time.Ticker
	stopChan        chan struct{}
	running         bool

	// Track last band/mode to send Status when switching
	lastBandName string
	lastDialFreq uint64
	lastMode     string
}

// WSJT-X UDP Protocol constants
const (
	wsjtxMagicNumber  = 0xadbccbda
	wsjtxSchemaNumber = 3 // Qt 5.4+ format

	// Message types
	wsjtxMsgHeartbeat  = 0
	wsjtxMsgStatus     = 1
	wsjtxMsgDecode     = 2
	wsjtxMsgClear      = 3
	wsjtxMsgReply      = 4
	wsjtxMsgQSOLogged  = 5
	wsjtxMsgClose      = 6
	wsjtxMsgReplay     = 7
	wsjtxMsgHaltTx     = 8
	wsjtxMsgFreeText   = 9
	wsjtxMsgWSPRDecode = 10

	// Heartbeat interval (WSJT-X expects every 15 seconds)
	wsjtxHeartbeatInterval = 15 * time.Second
)

// NewWSJTXUDPBroadcaster creates a new WSJT-X UDP broadcaster
func NewWSJTXUDPBroadcaster(host string, port int, clientID string, enabledModes map[string]bool) *WSJTXUDPBroadcaster {
	if clientID == "" {
		clientID = "UberSDR"
	}

	return &WSJTXUDPBroadcaster{
		enabled:       true,
		host:          host,
		port:          port,
		enabledModes:  enabledModes,
		clientID:      clientID,
		schemaVersion: wsjtxSchemaNumber,
		stopChan:      make(chan struct{}),
	}
}

// Start initializes the UDP connection and starts the heartbeat
func (w *WSJTXUDPBroadcaster) Start() error {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.running {
		return fmt.Errorf("WSJT-X UDP broadcaster already running")
	}

	// Resolve remote address
	remoteAddr, err := net.ResolveUDPAddr("udp", fmt.Sprintf("%s:%d", w.host, w.port))
	if err != nil {
		return fmt.Errorf("failed to resolve UDP address: %w", err)
	}
	w.remoteAddr = remoteAddr

	// Create UDP connection
	conn, err := net.DialUDP("udp", nil, remoteAddr)
	if err != nil {
		return fmt.Errorf("failed to create UDP connection: %w", err)
	}
	w.conn = conn

	w.running = true

	// Send initial heartbeat
	if err := w.sendHeartbeat(); err != nil {
		log.Printf("WSJT-X UDP: Failed to send initial heartbeat: %v", err)
	}

	// Start heartbeat ticker
	w.heartbeatTicker = time.NewTicker(wsjtxHeartbeatInterval)
	go w.heartbeatLoop()

	log.Printf("WSJT-X UDP broadcaster started: %s:%d (ID: %s)", w.host, w.port, w.clientID)
	return nil
}

// Stop closes the UDP connection and stops the heartbeat
func (w *WSJTXUDPBroadcaster) Stop() error {
	w.mu.Lock()
	defer w.mu.Unlock()

	if !w.running {
		return nil
	}

	// Send close message
	if err := w.sendClose(); err != nil {
		log.Printf("WSJT-X UDP: Failed to send close message: %v", err)
	}

	// Stop heartbeat
	if w.heartbeatTicker != nil {
		w.heartbeatTicker.Stop()
	}

	close(w.stopChan)

	// Close connection
	if w.conn != nil {
		if err := w.conn.Close(); err != nil {
			return fmt.Errorf("failed to close UDP connection: %w", err)
		}
	}

	w.running = false
	log.Printf("WSJT-X UDP broadcaster stopped")
	return nil
}

// IsModeEnabled checks if a mode is enabled for broadcasting
func (w *WSJTXUDPBroadcaster) IsModeEnabled(mode string) bool {
	w.mu.RLock()
	defer w.mu.RUnlock()

	if !w.enabled || !w.running {
		return false
	}

	enabled, exists := w.enabledModes[mode]
	return exists && enabled
}

// SendDecode sends a decode message (Type 2) for FT8/FT4
func (w *WSJTXUDPBroadcaster) SendDecode(decode *DecodeInfo) error {
	// Lock send mutex to serialize all sends (prevents batch interleaving)
	w.sendMutex.Lock()
	defer w.sendMutex.Unlock()

	// Check running state
	w.mu.RLock()
	if !w.running {
		w.mu.RUnlock()
		return fmt.Errorf("broadcaster not running")
	}
	w.mu.RUnlock()

	// Check if we need to send a Status message first (band/mode/freq changed)
	w.mu.Lock()
	needStatus := (decode.BandName != w.lastBandName ||
		decode.DialFrequency != w.lastDialFreq ||
		decode.Mode != w.lastMode)

	if needStatus {
		// Update tracking
		w.lastBandName = decode.BandName
		w.lastDialFreq = decode.DialFrequency
		w.lastMode = decode.Mode
	}
	w.mu.Unlock()

	// Send Status message first if needed (still under sendMutex)
	if needStatus {
		if err := w.SendStatus(decode.DialFrequency, decode.Mode, decode.BandName); err != nil {
			log.Printf("WSJT-X UDP: Failed to send Status for %s: %v", decode.BandName, err)
		}
	}

	// Build message
	buf := new(bytes.Buffer)

	// Write header
	if err := w.writeHeader(buf, wsjtxMsgDecode); err != nil {
		return err
	}

	// Write payload
	w.writeBool(buf, true) // New decode

	// Convert timestamp to QTime (milliseconds since midnight)
	qtime := w.timeToQTime(decode.Timestamp)
	w.writeUint32(buf, qtime)

	// Calculate delta frequency (offset from dial frequency in Hz)
	// decode.Frequency is the actual RF frequency, decode.DialFrequency is the center/dial frequency
	deltaFreq := int64(decode.Frequency) - int64(decode.DialFrequency)

	w.writeInt32(buf, int32(decode.SNR))   // SNR
	w.writeDouble(buf, float64(decode.DT)) // Delta time
	w.writeUint32(buf, uint32(deltaFreq))  // Delta frequency (offset from dial)
	w.writeString(buf, decode.Mode)        // Mode
	w.writeString(buf, decode.Message)     // Message text
	w.writeBool(buf, false)                // Low confidence
	w.writeBool(buf, false)                // Off air

	// Send datagram
	_, err := w.conn.Write(buf.Bytes())
	return err
}

// SendWSPRDecode sends a WSPR decode message (Type 10)
func (w *WSJTXUDPBroadcaster) SendWSPRDecode(decode *DecodeInfo) error {
	// Lock send mutex to serialize all sends (prevents batch interleaving)
	w.sendMutex.Lock()
	defer w.sendMutex.Unlock()

	// Check running state
	w.mu.RLock()
	if !w.running {
		w.mu.RUnlock()
		return fmt.Errorf("broadcaster not running")
	}
	w.mu.RUnlock()

	// Check if we need to send a Status message first (band/mode/freq changed)
	w.mu.Lock()
	needStatus := (decode.BandName != w.lastBandName ||
		decode.DialFrequency != w.lastDialFreq ||
		decode.Mode != w.lastMode)

	if needStatus {
		// Update tracking
		w.lastBandName = decode.BandName
		w.lastDialFreq = decode.DialFrequency
		w.lastMode = decode.Mode
	}
	w.mu.Unlock()

	// Send Status message first if needed (still under sendMutex)
	if needStatus {
		if err := w.SendStatus(decode.DialFrequency, decode.Mode, decode.BandName); err != nil {
			log.Printf("WSJT-X UDP: Failed to send Status for %s: %v", decode.BandName, err)
		}
	}

	// Build message
	buf := new(bytes.Buffer)

	// Write header
	if err := w.writeHeader(buf, wsjtxMsgWSPRDecode); err != nil {
		return err
	}

	// Write payload
	w.writeBool(buf, true) // New decode

	// Convert timestamp to QTime
	qtime := w.timeToQTime(decode.Timestamp)
	w.writeUint32(buf, qtime)

	w.writeInt32(buf, int32(decode.SNR))   // SNR
	w.writeDouble(buf, float64(decode.DT)) // Delta time
	w.writeUint64(buf, decode.TxFrequency) // Frequency (Hz)
	w.writeInt32(buf, int32(decode.Drift)) // Drift (Hz)
	w.writeString(buf, decode.Callsign)    // Callsign
	w.writeString(buf, decode.Locator)     // Grid
	w.writeInt32(buf, int32(decode.DBm))   // Power (dBm)
	w.writeBool(buf, false)                // Off air

	// Send datagram
	_, err := w.conn.Write(buf.Bytes())
	return err
}

// SendStatus sends a status message (Type 1) with dial frequency and mode
// Note: This is called from within SendDecode/SendWSPRDecode which already hold sendMutex
func (w *WSJTXUDPBroadcaster) SendStatus(dialFreq uint64, mode string, bandName string) error {
	w.mu.RLock()
	running := w.running
	w.mu.RUnlock()

	if !running {
		return fmt.Errorf("broadcaster not running")
	}

	// Build message
	buf := new(bytes.Buffer)

	// Write header
	if err := w.writeHeader(buf, wsjtxMsgStatus); err != nil {
		return err
	}

	// Write payload (Status message fields)
	w.writeUint64(buf, dialFreq) // Dial frequency (Hz)
	w.writeString(buf, mode)     // Mode (e.g., "FT8", "FT4", "WSPR")
	w.writeString(buf, "")       // DX call (empty)
	w.writeString(buf, "")       // Report (empty)
	w.writeString(buf, mode)     // Tx mode (same as mode)
	w.writeBool(buf, false)      // Tx enabled
	w.writeBool(buf, false)      // Transmitting
	w.writeBool(buf, true)       // Decoding
	w.writeUint32(buf, 0)        // Rx DF (0)
	w.writeUint32(buf, 0)        // Tx DF (0)
	w.writeString(buf, "")       // DE call (empty, could use receiver callsign)
	w.writeString(buf, "")       // DE grid (empty, could use receiver locator)
	w.writeString(buf, "")       // DX grid (empty)
	w.writeBool(buf, false)      // Tx watchdog
	w.writeString(buf, "")       // Sub-mode (empty)
	w.writeBool(buf, false)      // Fast mode
	w.writeBool(buf, false)      // Special operation mode (uint8 in schema 3, but bool works)
	w.writeUint32(buf, 0)        // Frequency tolerance (Hz)
	w.writeUint32(buf, 0)        // T/R period (seconds)
	w.writeString(buf, bandName) // Configuration name (use band name)

	// Send datagram
	_, err := w.conn.Write(buf.Bytes())
	return err
}

// sendHeartbeat sends a heartbeat message (Type 0)
func (w *WSJTXUDPBroadcaster) sendHeartbeat() error {
	if !w.running {
		return nil
	}

	buf := new(bytes.Buffer)

	// Write header
	if err := w.writeHeader(buf, wsjtxMsgHeartbeat); err != nil {
		return err
	}

	// Write payload
	w.writeUint32(buf, wsjtxSchemaNumber) // Maximum schema number
	w.writeString(buf, "UberSDR")         // Version
	w.writeString(buf, "1.0")             // Revision

	// Send datagram
	_, err := w.conn.Write(buf.Bytes())
	return err
}

// sendClose sends a close message (Type 6)
func (w *WSJTXUDPBroadcaster) sendClose() error {
	if !w.running {
		return nil
	}

	buf := new(bytes.Buffer)

	// Write header (no additional payload for close message)
	if err := w.writeHeader(buf, wsjtxMsgClose); err != nil {
		return err
	}

	// Send datagram
	_, err := w.conn.Write(buf.Bytes())
	return err
}

// heartbeatLoop sends periodic heartbeats
func (w *WSJTXUDPBroadcaster) heartbeatLoop() {
	for {
		select {
		case <-w.heartbeatTicker.C:
			if err := w.sendHeartbeat(); err != nil {
				log.Printf("WSJT-X UDP: Failed to send heartbeat: %v", err)
			}
		case <-w.stopChan:
			return
		}
	}
}

// writeHeader writes the message header (magic, schema, type, id)
func (w *WSJTXUDPBroadcaster) writeHeader(buf *bytes.Buffer, msgType uint32) error {
	// Magic number
	if err := binary.Write(buf, binary.BigEndian, uint32(wsjtxMagicNumber)); err != nil {
		return err
	}

	// Schema number
	if err := binary.Write(buf, binary.BigEndian, w.schemaVersion); err != nil {
		return err
	}

	// Message type
	if err := binary.Write(buf, binary.BigEndian, msgType); err != nil {
		return err
	}

	// Client ID (utf8 string)
	w.writeString(buf, w.clientID)

	return nil
}

// writeString writes a UTF-8 string in QDataStream format
// Format: 4-byte length (big-endian) + UTF-8 bytes
func (w *WSJTXUDPBroadcaster) writeString(buf *bytes.Buffer, s string) {
	data := []byte(s)
	binary.Write(buf, binary.BigEndian, uint32(len(data)))
	buf.Write(data)
}

// writeBool writes a boolean in QDataStream format (1 byte)
func (w *WSJTXUDPBroadcaster) writeBool(buf *bytes.Buffer, b bool) {
	if b {
		buf.WriteByte(1)
	} else {
		buf.WriteByte(0)
	}
}

// writeUint32 writes a 32-bit unsigned integer in big-endian format
func (w *WSJTXUDPBroadcaster) writeUint32(buf *bytes.Buffer, v uint32) {
	binary.Write(buf, binary.BigEndian, v)
}

// writeInt32 writes a 32-bit signed integer in big-endian format
func (w *WSJTXUDPBroadcaster) writeInt32(buf *bytes.Buffer, v int32) {
	binary.Write(buf, binary.BigEndian, v)
}

// writeUint64 writes a 64-bit unsigned integer in big-endian format
func (w *WSJTXUDPBroadcaster) writeUint64(buf *bytes.Buffer, v uint64) {
	binary.Write(buf, binary.BigEndian, v)
}

// writeDouble writes a 64-bit float in big-endian format
func (w *WSJTXUDPBroadcaster) writeDouble(buf *bytes.Buffer, v float64) {
	binary.Write(buf, binary.BigEndian, v)
}

// timeToQTime converts a Go time.Time to QTime format (milliseconds since midnight UTC)
func (w *WSJTXUDPBroadcaster) timeToQTime(t time.Time) uint32 {
	utc := t.UTC()
	midnight := time.Date(utc.Year(), utc.Month(), utc.Day(), 0, 0, 0, 0, time.UTC)
	duration := utc.Sub(midnight)
	return uint32(duration.Milliseconds())
}

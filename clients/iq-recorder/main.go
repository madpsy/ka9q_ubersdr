package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const (
	UserAgent = "UberSDR IQ Recorder"
)

// ConnectionCheckRequest for /connection endpoint
type ConnectionCheckRequest struct {
	UserSessionID string `json:"user_session_id"`
	Password      string `json:"password,omitempty"`
}

// ConnectionCheckResponse from /connection endpoint
type ConnectionCheckResponse struct {
	Allowed        bool     `json:"allowed"`
	Reason         string   `json:"reason,omitempty"`
	ClientIP       string   `json:"client_ip,omitempty"`
	SessionTimeout int      `json:"session_timeout"`
	MaxSessionTime int      `json:"max_session_time"`
	Bypassed       bool     `json:"bypassed"`
	AllowedIQModes []string `json:"allowed_iq_modes,omitempty"`
}

// containsString checks if a string slice contains a specific string
func containsString(slice []string, str string) bool {
	for _, s := range slice {
		if s == str {
			return true
		}
	}
	return false
}

// WAVHeader represents a WAV file header for IQ data
type WAVHeader struct {
	ChunkID       [4]byte // "RIFF"
	ChunkSize     uint32  // File size - 8
	Format        [4]byte // "WAVE"
	Subchunk1ID   [4]byte // "fmt "
	Subchunk1Size uint32  // 16 for PCM
	AudioFormat   uint16  // 1 for PCM
	NumChannels   uint16  // 2 for IQ (I and Q)
	SampleRate    uint32  // Sample rate
	ByteRate      uint32  // SampleRate * NumChannels * BitsPerSample/8
	BlockAlign    uint16  // NumChannels * BitsPerSample/8
	BitsPerSample uint16  // 16 bits
	Subchunk2ID   [4]byte // "data"
	Subchunk2Size uint32  // Data size
}

// IQRecorder records IQ48 data to a WAV file
type IQRecorder struct {
	host              string
	port              int
	frequency         int
	duration          *int
	outputFile        string
	outputDir         string // Directory for output files
	ssl               bool
	password          string
	userSessionID     string
	file              *os.File
	mu                sync.Mutex
	samplesWritten    uint32
	sampleRate        int
	startTime         time.Time
	conn              *websocket.Conn
	pcmDecoder        *PCMBinaryDecoder
	firstTimestamp    uint64        // First wall clock timestamp (nanoseconds)
	lastTimestamp     uint64        // Last wall clock timestamp (nanoseconds)
	firstTimestampSet bool          // Whether first timestamp has been set
	finalFilename     string        // Final filename after first timestamp is known
	doneChan          chan struct{} // Signal when recording is complete
}

// NewIQRecorder creates a new IQ recorder
func NewIQRecorder(host string, port int, frequency int, duration *int, outputDir string, ssl bool, password string) (*IQRecorder, error) {
	// Initialize PCM decoder
	pcmDecoder, err := NewPCMBinaryDecoder()
	if err != nil {
		return nil, fmt.Errorf("failed to initialize PCM decoder: %w", err)
	}

	return &IQRecorder{
		host:          host,
		port:          port,
		frequency:     frequency,
		duration:      duration,
		outputDir:     outputDir,
		ssl:           ssl,
		password:      password,
		userSessionID: uuid.New().String(),
		pcmDecoder:    pcmDecoder,
		doneChan:      make(chan struct{}),
	}, nil
}

// writeWAVHeader writes the WAV header to the file
func (r *IQRecorder) writeWAVHeader() error {
	header := WAVHeader{
		ChunkID:       [4]byte{'R', 'I', 'F', 'F'},
		ChunkSize:     0, // Will be updated when closing
		Format:        [4]byte{'W', 'A', 'V', 'E'},
		Subchunk1ID:   [4]byte{'f', 'm', 't', ' '},
		Subchunk1Size: 16,
		AudioFormat:   1, // PCM
		NumChannels:   2, // I and Q channels
		SampleRate:    uint32(r.sampleRate),
		ByteRate:      uint32(r.sampleRate * 2 * 2), // SampleRate * NumChannels * BytesPerSample
		BlockAlign:    4,                            // NumChannels * BytesPerSample
		BitsPerSample: 16,
		Subchunk2ID:   [4]byte{'d', 'a', 't', 'a'},
		Subchunk2Size: 0, // Will be updated when closing
	}

	return binary.Write(r.file, binary.LittleEndian, &header)
}

// updateWAVHeader updates the WAV header with final sizes
func (r *IQRecorder) updateWAVHeader() error {
	dataSize := r.samplesWritten * 4 // 2 channels * 2 bytes per sample
	fileSize := dataSize + 36        // Header size is 44 bytes, minus 8 for ChunkID and ChunkSize

	// Seek to ChunkSize position (byte 4)
	if _, err := r.file.Seek(4, 0); err != nil {
		return err
	}
	if err := binary.Write(r.file, binary.LittleEndian, fileSize); err != nil {
		return err
	}

	// Seek to Subchunk2Size position (byte 40)
	if _, err := r.file.Seek(40, 0); err != nil {
		return err
	}
	if err := binary.Write(r.file, binary.LittleEndian, dataSize); err != nil {
		return err
	}

	return nil
}

// checkConnectionAllowed checks if connection is allowed and gets session info
func (r *IQRecorder) checkConnectionAllowed() (bool, error) {
	protocol := "http"
	if r.ssl {
		protocol = "https"
	}

	checkURL := fmt.Sprintf("%s://%s:%d/connection", protocol, r.host, r.port)

	// Prepare request body
	reqBody := ConnectionCheckRequest{
		UserSessionID: r.userSessionID,
		Password:      r.password,
	}

	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return false, fmt.Errorf("failed to marshal request: %w", err)
	}

	req, err := http.NewRequest("POST", checkURL, bytes.NewBuffer(jsonData))
	if err != nil {
		return false, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", UserAgent)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("Connection check failed: %v", err)
		log.Printf("Attempting connection anyway...")
		return true, nil // Continue on error (like the go client does)
	}
	defer resp.Body.Close()

	var respData ConnectionCheckResponse
	if err := json.NewDecoder(resp.Body).Decode(&respData); err != nil {
		return false, fmt.Errorf("failed to decode response: %w", err)
	}

	if !respData.Allowed {
		return false, fmt.Errorf("connection rejected: %s", respData.Reason)
	}

	// Check if IQ48 mode is allowed
	if len(respData.AllowedIQModes) > 0 && !respData.Bypassed {
		if !containsString(respData.AllowedIQModes, "iq48") {
			return false, fmt.Errorf("IQ48 mode not allowed by server (allowed modes: %v)", respData.AllowedIQModes)
		}
	}

	clientIP := respData.ClientIP
	if clientIP == "" {
		clientIP = "unknown"
	}
	log.Printf("Connection allowed (client IP: %s, bypassed: %v, max session time: %ds)",
		clientIP, respData.Bypassed, respData.MaxSessionTime)

	if len(respData.AllowedIQModes) > 0 {
		log.Printf("Allowed IQ modes: %v", respData.AllowedIQModes)
	}

	return true, nil
}

// Start starts recording IQ data
func (r *IQRecorder) Start() error {
	// Check if connection is allowed
	allowed, err := r.checkConnectionAllowed()
	if err != nil {
		return fmt.Errorf("connection check error: %w", err)
	}
	if !allowed {
		return fmt.Errorf("connection not allowed by server")
	}

	// Create temporary output file (will be renamed after first timestamp)
	tempFile := fmt.Sprintf("%s/temp_recording_%s.wav", r.outputDir, r.userSessionID)
	file, err := os.Create(tempFile)
	if err != nil {
		return fmt.Errorf("failed to create output file: %w", err)
	}
	r.file = file
	r.outputFile = tempFile

	// Build WebSocket URL
	wsScheme := "ws"
	if r.ssl {
		wsScheme = "wss"
	}
	wsURL := fmt.Sprintf("%s://%s:%d/ws", wsScheme, r.host, r.port)

	// Parse URL and add query parameters
	u, err := url.Parse(wsURL)
	if err != nil {
		return fmt.Errorf("failed to parse WebSocket URL: %w", err)
	}

	q := u.Query()
	q.Set("frequency", fmt.Sprintf("%d", r.frequency))
	q.Set("mode", "iq48")
	q.Set("user_session_id", r.userSessionID)
	q.Set("format", "pcm-zstd") // Request pcm-zstd format
	if r.password != "" {
		q.Set("password", url.QueryEscape(r.password))
	}
	u.RawQuery = q.Encode()

	// Set up WebSocket headers
	headers := http.Header{}
	headers.Set("User-Agent", UserAgent)
	if r.password != "" {
		headers.Set("X-Password", r.password)
	}

	// Connect to WebSocket
	log.Printf("Connecting to %s...", u.String())
	conn, _, err := websocket.DefaultDialer.Dial(u.String(), headers)
	if err != nil {
		r.file.Close()
		return fmt.Errorf("WebSocket connection failed: %w", err)
	}
	r.conn = conn
	r.startTime = time.Now()

	log.Printf("Connected. Recording IQ48 data at %d Hz...", r.frequency)

	// Start receiving data
	go r.receiveData()

	return nil
}

// receiveData receives and writes IQ data
func (r *IQRecorder) receiveData() {
	defer func() {
		r.Stop()
		close(r.doneChan) // Signal that recording is complete
	}()

	headerWritten := false

	// Pre-initialize decoder with IQ48 defaults since server doesn't send initial status for binary formats
	// IQ48 mode always uses 48000 Hz sample rate and 2 channels
	r.pcmDecoder.lastSampleRate = 48000
	r.pcmDecoder.lastChannels = 2
	r.sampleRate = 48000
	log.Printf("Initialized for IQ48 mode: 48000 Hz, 2 channels")

	for {
		// Check if duration has elapsed
		if r.duration != nil {
			elapsed := time.Since(r.startTime)
			if elapsed >= time.Duration(*r.duration)*time.Second {
				log.Printf("Recording duration reached (%d seconds)", *r.duration)
				return
			}
		}

		messageType, message, err := r.conn.ReadMessage()
		if err != nil {
			log.Printf("Read error: %v", err)
			return
		}

		if messageType == websocket.BinaryMessage {
			// Binary message contains compressed IQ data - decode it
			pcmData, sampleRate, channels, gpsTimestampNanos, err := r.pcmDecoder.DecodePCMBinary(message, true)
			if err != nil {
				// Log error with packet details for debugging
				log.Printf("Warning: Failed to decode PCM data (packet size: %d bytes): %v", len(message), err)
				// Don't skip - this creates gaps and clicks
				// Instead, continue to next packet
				continue
			}

			// Log successful decode for first few packets
			if r.samplesWritten < 5 {
				log.Printf("Decoded packet: %d bytes PCM, sample rate: %d, channels: %d, timestamp: %d",
					len(pcmData), sampleRate, channels, gpsTimestampNanos)
			}

			r.mu.Lock()

			// Update sample rate and channels from decoded data (if we got them)
			// For minimal headers, sampleRate and channels will be from the last full header
			if r.sampleRate == 0 && sampleRate > 0 {
				r.sampleRate = sampleRate
				log.Printf("Detected sample rate: %d Hz, channels: %d", sampleRate, channels)
			}

			// Track first and last timestamps (GPS-synchronized nanosecond timestamps)
			if gpsTimestampNanos > 0 {
				if !r.firstTimestampSet {
					r.firstTimestamp = gpsTimestampNanos
					r.firstTimestampSet = true
					// Convert nanoseconds to time.Time and print
					firstTime := time.Unix(0, int64(gpsTimestampNanos)).UTC()
					log.Printf("First packet timestamp: %s", firstTime.Format("2006-01-02 15:04:05.000 MST"))

					// Generate final filename: frequency_timestamp.wav
					// Format: 14074000_2026-01-21T12:10:19.937Z.wav
					r.finalFilename = fmt.Sprintf("%s/%d_%s.wav",
						r.outputDir,
						r.frequency,
						firstTime.Format("2006-01-02T15:04:05.000Z"))
				}
				r.lastTimestamp = gpsTimestampNanos
			}

			// Write header on first data packet
			if !headerWritten && r.sampleRate > 0 {
				if err := r.writeWAVHeader(); err != nil {
					log.Printf("Failed to write WAV header: %v", err)
					r.mu.Unlock()
					return
				}
				headerWritten = true
				log.Printf("WAV header written (sample rate: %d Hz, channels: %d)", r.sampleRate, channels)
			}

			// Write decoded IQ data (even if we haven't written header yet, buffer it)
			if headerWritten && len(pcmData) > 0 {
				n, err := r.file.Write(pcmData)
				if err != nil {
					log.Printf("Failed to write data: %v", err)
					r.mu.Unlock()
					return
				}
				r.samplesWritten += uint32(n / 4) // 4 bytes per sample (2 channels * 2 bytes)
			}

			r.mu.Unlock()
		} else if messageType == websocket.TextMessage {
			// Text messages might contain initial configuration
			// Parse it to get sample rate before first binary packet
			var msg map[string]interface{}
			if err := json.Unmarshal(message, &msg); err == nil {
				if sr, ok := msg["sampleRate"].(float64); ok && r.sampleRate == 0 {
					r.sampleRate = int(sr)
					log.Printf("Sample rate from text message: %d Hz", r.sampleRate)
				}
				if ch, ok := msg["channels"].(float64); ok {
					log.Printf("Channels from text message: %d", int(ch))
				}
			}
		}
	}
}

// Stop stops recording and closes the file
func (r *IQRecorder) Stop() {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.conn != nil {
		r.conn.Close()
		r.conn = nil
	}

	if r.pcmDecoder != nil {
		r.pcmDecoder.Close()
		r.pcmDecoder = nil
	}

	if r.file != nil {
		// Update WAV header with final sizes
		if err := r.updateWAVHeader(); err != nil {
			log.Printf("Warning: Failed to update WAV header: %v", err)
		}

		tempFilename := r.outputFile
		r.file.Close()
		r.file = nil

		duration := time.Since(r.startTime)
		fileSize := r.samplesWritten * 4
		log.Printf("Recording stopped. Wrote %d samples (%.2f MB) in %v",
			r.samplesWritten, float64(fileSize)/(1024*1024), duration.Round(time.Millisecond))

		// Print last timestamp if we have it
		if r.lastTimestamp > 0 {
			lastTime := time.Unix(0, int64(r.lastTimestamp)).UTC()
			log.Printf("Last packet timestamp: %s", lastTime.Format("2006-01-02 15:04:05.000 MST"))
		}

		// Print time span if we have both timestamps
		if r.firstTimestampSet && r.lastTimestamp > 0 {
			timeSpan := time.Duration(r.lastTimestamp - r.firstTimestamp)
			log.Printf("Recording time span: %v", timeSpan.Round(time.Millisecond))
		}

		// Rename temp file to final filename if we have a timestamp
		if r.finalFilename != "" {
			if err := os.Rename(tempFilename, r.finalFilename); err != nil {
				log.Printf("Warning: Failed to rename file: %v", err)
				log.Printf("Recording saved as: %s", tempFilename)
			} else {
				log.Printf("Recording saved as: %s", r.finalFilename)
			}
		} else {
			log.Printf("Recording saved as: %s", tempFilename)
		}
	}
}

func main() {
	// Command line flags
	host := flag.String("host", "localhost", "UberSDR server host")
	port := flag.Int("port", 8073, "UberSDR server port")
	frequency := flag.Int("frequency", 14074000, "Frequency in Hz")
	duration := flag.Int("duration", 60, "Recording duration in seconds (0 for unlimited)")
	outputDir := flag.String("output-dir", ".", "Output directory for WAV files")
	ssl := flag.Bool("ssl", false, "Use SSL/TLS connection")
	password := flag.String("password", "", "Server password (if required)")

	flag.Parse()

	// Validate duration
	var durationPtr *int
	if *duration > 0 {
		durationPtr = duration
	}

	// Create recorder
	recorder, err := NewIQRecorder(*host, *port, *frequency, durationPtr, *outputDir, *ssl, *password)
	if err != nil {
		log.Fatalf("Failed to create recorder: %v", err)
	}

	// Set up signal handling for graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	// Start recording
	if err := recorder.Start(); err != nil {
		log.Fatalf("Failed to start recording: %v", err)
	}

	// Wait for either signal or recording to complete
	select {
	case <-sigChan:
		log.Println("Interrupted by user, shutting down...")
		recorder.Stop()
	case <-recorder.doneChan:
		// Recording completed normally (duration reached or connection closed)
		log.Println("Recording complete")
	}
}

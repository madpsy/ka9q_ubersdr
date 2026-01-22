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
	"strings"
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

// InstanceConfig holds configuration for a single instance
type InstanceConfig struct {
	Host     string
	Port     int
	SSL      bool
	Password string
	Name     string // Optional friendly name for the instance
}

// PCMPacket represents a decoded PCM packet with metadata
type PCMPacket struct {
	Data       []byte
	Timestamp  uint64 // GPS timestamp in nanoseconds
	SampleRate int
	Channels   int
}

// IQRecorder records IQ48 data to a WAV file
type IQRecorder struct {
	config            InstanceConfig
	frequency         int
	duration          *int
	outputFile        string
	outputDir         string // Directory for output files
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
	metadata          []byte        // JSON metadata from /api/description
	targetSamples     *uint32       // Target number of samples for synchronized recording

	// Alignment support
	alignmentEnabled bool
	alignStartTime   *uint64       // Shared alignment start timestamp
	packetBuffer     []PCMPacket   // Buffer for packets before alignment
	alignmentReady   chan struct{} // Signal when alignment timestamp is set
	bufferProcessed  bool          // Whether buffered packets have been processed
}

// NewIQRecorder creates a new IQ recorder
func NewIQRecorder(config InstanceConfig, frequency int, duration *int, outputDir string, alignmentEnabled bool, alignStartTime *uint64, targetSamples *uint32) (*IQRecorder, error) {
	// Initialize PCM decoder
	pcmDecoder, err := NewPCMBinaryDecoder()
	if err != nil {
		return nil, fmt.Errorf("failed to initialize PCM decoder: %w", err)
	}

	recorder := &IQRecorder{
		config:           config,
		frequency:        frequency,
		duration:         duration,
		outputDir:        outputDir,
		userSessionID:    uuid.New().String(),
		pcmDecoder:       pcmDecoder,
		doneChan:         make(chan struct{}),
		alignmentEnabled: alignmentEnabled,
		alignStartTime:   alignStartTime,
		packetBuffer:     make([]PCMPacket, 0, 100),
		targetSamples:    targetSamples,
	}

	if alignmentEnabled {
		recorder.alignmentReady = make(chan struct{})
	}

	return recorder, nil
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
	if r.config.SSL {
		protocol = "https"
	}

	checkURL := fmt.Sprintf("%s://%s:%d/connection", protocol, r.config.Host, r.config.Port)

	// Prepare request body
	reqBody := ConnectionCheckRequest{
		UserSessionID: r.userSessionID,
		Password:      r.config.Password,
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
	defer func() {
		_ = resp.Body.Close()
	}()

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
	log.Printf("[%s] Connection allowed (client IP: %s, bypassed: %v, max session time: %ds)",
		r.getInstanceIdentifier(), clientIP, respData.Bypassed, respData.MaxSessionTime)

	if len(respData.AllowedIQModes) > 0 {
		log.Printf("[%s] Allowed IQ modes: %v", r.getInstanceIdentifier(), respData.AllowedIQModes)
	}

	return true, nil
}

// getInstanceIdentifier returns a friendly identifier for this instance
func (r *IQRecorder) getInstanceIdentifier() string {
	if r.config.Name != "" {
		return r.config.Name
	}
	return fmt.Sprintf("%s:%d", r.config.Host, r.config.Port)
}

// fetchMetadata fetches the /api/description endpoint and stores the JSON
func (r *IQRecorder) fetchMetadata() error {
	protocol := "http"
	if r.config.SSL {
		protocol = "https"
	}

	descURL := fmt.Sprintf("%s://%s:%d/api/description", protocol, r.config.Host, r.config.Port)

	req, err := http.NewRequest("GET", descURL, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("User-Agent", UserAgent)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to fetch description: %w", err)
	}
	defer func() {
		_ = resp.Body.Close()
	}()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status code: %d", resp.StatusCode)
	}

	// Read and store the raw JSON
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(resp.Body); err != nil {
		return fmt.Errorf("failed to read response: %w", err)
	}

	r.metadata = buf.Bytes()
	log.Printf("[%s] Fetched metadata (%d bytes)", r.getInstanceIdentifier(), len(r.metadata))

	return nil
}

// saveMetadata saves the metadata JSON to a file alongside the WAV file
func (r *IQRecorder) saveMetadata() error {
	if len(r.metadata) == 0 {
		return fmt.Errorf("no metadata to save")
	}

	if r.finalFilename == "" {
		return fmt.Errorf("final filename not set")
	}

	// Replace .wav extension with .json
	metadataFilename := strings.TrimSuffix(r.finalFilename, ".wav") + ".json"

	// Pretty-print the JSON
	var prettyJSON bytes.Buffer
	if err := json.Indent(&prettyJSON, r.metadata, "", "  "); err != nil {
		// If pretty-printing fails, just write the raw JSON
		if err := os.WriteFile(metadataFilename, r.metadata, 0644); err != nil {
			return fmt.Errorf("failed to write metadata file: %w", err)
		}
	} else {
		if err := os.WriteFile(metadataFilename, prettyJSON.Bytes(), 0644); err != nil {
			return fmt.Errorf("failed to write metadata file: %w", err)
		}
	}

	log.Printf("[%s] Metadata saved to: %s", r.getInstanceIdentifier(), metadataFilename)
	return nil
}

// Start starts recording IQ data
func (r *IQRecorder) Start() error {
	// Fetch metadata first
	if err := r.fetchMetadata(); err != nil {
		log.Printf("[%s] Warning: Failed to fetch metadata: %v", r.getInstanceIdentifier(), err)
		// Continue anyway - metadata is optional
	}

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
	if r.config.SSL {
		wsScheme = "wss"
	}
	wsURL := fmt.Sprintf("%s://%s:%d/ws", wsScheme, r.config.Host, r.config.Port)

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
	if r.config.Password != "" {
		q.Set("password", url.QueryEscape(r.config.Password))
	}
	u.RawQuery = q.Encode()

	// Set up WebSocket headers
	headers := http.Header{}
	headers.Set("User-Agent", UserAgent)
	if r.config.Password != "" {
		headers.Set("X-Password", r.config.Password)
	}

	// Connect to WebSocket
	log.Printf("[%s] Connecting to %s...", r.getInstanceIdentifier(), u.String())
	conn, _, err := websocket.DefaultDialer.Dial(u.String(), headers)
	if err != nil {
		_ = r.file.Close()
		return fmt.Errorf("WebSocket connection failed: %w", err)
	}
	r.conn = conn
	r.startTime = time.Now()

	log.Printf("[%s] Connected. Recording IQ48 data at %d Hz...", r.getInstanceIdentifier(), r.frequency)

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
	log.Printf("[%s] Initialized for IQ48 mode: 48000 Hz, 2 channels", r.getInstanceIdentifier())

	// If alignment is enabled, wait for alignment timestamp to be set
	if r.alignmentEnabled {
		log.Printf("[%s] Buffering packets for timestamp alignment...", r.getInstanceIdentifier())
	}

	for {
		// Check if target sample count has been reached (for synchronized recording)
		if r.targetSamples != nil {
			r.mu.Lock()
			if r.samplesWritten >= *r.targetSamples {
				log.Printf("[%s] Target sample count reached (%d samples)", r.getInstanceIdentifier(), r.samplesWritten)
				r.mu.Unlock()
				return
			}
			r.mu.Unlock()
		} else if r.duration != nil {
			// Fallback to time-based duration for single instance
			elapsed := time.Since(r.startTime)
			if elapsed >= time.Duration(*r.duration)*time.Second {
				log.Printf("[%s] Recording duration reached (%d seconds)", r.getInstanceIdentifier(), *r.duration)
				return
			}
		}

		messageType, message, err := r.conn.ReadMessage()
		if err != nil {
			log.Printf("[%s] Read error: %v", r.getInstanceIdentifier(), err)
			return
		}

		if messageType == websocket.BinaryMessage {
			// Binary message contains compressed IQ data - decode it
			pcmData, sampleRate, channels, gpsTimestampNanos, err := r.pcmDecoder.DecodePCMBinary(message, true)
			if err != nil {
				// Log error with packet details for debugging
				log.Printf("[%s] Warning: Failed to decode PCM data (packet size: %d bytes): %v", r.getInstanceIdentifier(), len(message), err)
				// Don't skip - this creates gaps and clicks
				// Instead, continue to next packet
				continue
			}

			// Log successful decode for first few packets
			if r.samplesWritten < 5 && !r.alignmentEnabled {
				log.Printf("[%s] Decoded packet: %d bytes PCM, sample rate: %d, channels: %d, timestamp: %d",
					r.getInstanceIdentifier(), len(pcmData), sampleRate, channels, gpsTimestampNanos)
			}

			r.mu.Lock()

			// Update sample rate and channels from decoded data (if we got them)
			// For minimal headers, sampleRate and channels will be from the last full header
			if r.sampleRate == 0 && sampleRate > 0 {
				r.sampleRate = sampleRate
				log.Printf("[%s] Detected sample rate: %d Hz, channels: %d", r.getInstanceIdentifier(), sampleRate, channels)
			}

			// Track first timestamp
			if gpsTimestampNanos > 0 && !r.firstTimestampSet {
				r.firstTimestamp = gpsTimestampNanos
				r.firstTimestampSet = true
				firstTime := time.Unix(0, int64(gpsTimestampNanos)).UTC()
				log.Printf("[%s] First packet timestamp: %s", r.getInstanceIdentifier(), firstTime.Format("2006-01-02 15:04:05.000 MST"))
			}

			// If alignment is enabled, buffer packets until alignment timestamp is ready
			if r.alignmentEnabled && r.alignStartTime != nil && *r.alignStartTime == 0 {
				// Still waiting for alignment timestamp
				if gpsTimestampNanos > 0 {
					r.packetBuffer = append(r.packetBuffer, PCMPacket{
						Data:       append([]byte(nil), pcmData...), // Copy data
						Timestamp:  gpsTimestampNanos,
						SampleRate: sampleRate,
						Channels:   channels,
					})
				}
				r.mu.Unlock()
				continue
			}

			// If we just got the alignment timestamp, process buffered packets
			if r.alignmentEnabled && len(r.packetBuffer) > 0 {
				alignStart := *r.alignStartTime
				alignTime := time.Unix(0, int64(alignStart)).UTC()
				log.Printf("[%s] Alignment timestamp set to: %s", r.getInstanceIdentifier(), alignTime.Format("2006-01-02 15:04:05.000 MST"))
				log.Printf("[%s] Processing %d buffered packets...", r.getInstanceIdentifier(), len(r.packetBuffer))

				// Process buffered packets, finding the first one at or after alignment timestamp
				foundAlignedPacket := false
				for i, pkt := range r.packetBuffer {
					if pkt.Timestamp >= alignStart {
						if !foundAlignedPacket {
							foundAlignedPacket = true
							log.Printf("[%s] Found aligned packet at index %d (timestamp: %d, align: %d)",
								r.getInstanceIdentifier(), i, pkt.Timestamp, alignStart)
						}

						// Calculate sample offset within this packet
						if pkt.Timestamp > alignStart && pkt.SampleRate > 0 {
							// Need to trim the beginning of this packet
							timeDiff := pkt.Timestamp - alignStart
							samplesToSkip := int((timeDiff * uint64(pkt.SampleRate)) / 1000000000)
							bytesToSkip := samplesToSkip * 4 // 4 bytes per sample (2 channels * 2 bytes)

							if bytesToSkip < len(pkt.Data) {
								pkt.Data = pkt.Data[bytesToSkip:]
								log.Printf("[%s] Trimmed %d samples from first aligned packet", r.getInstanceIdentifier(), samplesToSkip)
							}
						}

						// Write header if not written yet
						if !headerWritten && r.sampleRate > 0 {
							if err := r.writeWAVHeader(); err != nil {
								log.Printf("[%s] Failed to write WAV header: %v", r.getInstanceIdentifier(), err)
								r.mu.Unlock()
								return
							}
							headerWritten = true
							log.Printf("[%s] WAV header written (sample rate: %d Hz, channels: %d)", r.getInstanceIdentifier(), r.sampleRate, pkt.Channels)

							// Set final filename based on alignment timestamp
							instanceIdentifier := r.config.Name
							if instanceIdentifier == "" {
								instanceIdentifier = r.config.Host
							}
							r.finalFilename = fmt.Sprintf("%s/%s_%d_%s.wav",
								r.outputDir,
								instanceIdentifier,
								r.frequency,
								alignTime.Format("2006-01-02T15:04:05.000Z"))
						}

						// Write the packet data
						if headerWritten && len(pkt.Data) > 0 {
							n, err := r.file.Write(pkt.Data)
							if err != nil {
								log.Printf("[%s] Failed to write data: %v", r.getInstanceIdentifier(), err)
								r.mu.Unlock()
								return
							}
							r.samplesWritten += uint32(n / 4)
						}
					}
				}

				if !foundAlignedPacket {
					log.Printf("[%s] No buffered packets >= alignment timestamp, will start from next packet", r.getInstanceIdentifier())
				}

				log.Printf("[%s] Finished processing buffered packets, now recording live...", r.getInstanceIdentifier())
				r.packetBuffer = nil     // Clear buffer
				r.bufferProcessed = true // Mark buffer as processed

				// If no aligned packet was found in buffer, we need to write header now
				// and start recording from the next packet that arrives
				if !foundAlignedPacket && !headerWritten && r.sampleRate > 0 {
					if err := r.writeWAVHeader(); err != nil {
						log.Printf("[%s] Failed to write WAV header: %v", r.getInstanceIdentifier(), err)
						r.mu.Unlock()
						return
					}
					headerWritten = true
					log.Printf("[%s] WAV header written (sample rate: %d Hz, channels: 2)", r.getInstanceIdentifier(), r.sampleRate)

					// Set final filename based on alignment timestamp
					alignTime := time.Unix(0, int64(alignStart)).UTC()
					instanceIdentifier := r.config.Name
					if instanceIdentifier == "" {
						instanceIdentifier = r.config.Host
					}
					r.finalFilename = fmt.Sprintf("%s/%s_%d_%s.wav",
						r.outputDir,
						instanceIdentifier,
						r.frequency,
						alignTime.Format("2006-01-02T15:04:05.000Z"))
				}
			}

			// Update last timestamp
			if gpsTimestampNanos > 0 {
				r.lastTimestamp = gpsTimestampNanos
			}

			// For non-aligned mode, generate filename on first timestamp
			if !r.alignmentEnabled && gpsTimestampNanos > 0 && r.finalFilename == "" {
				firstTime := time.Unix(0, int64(r.firstTimestamp)).UTC()
				instanceIdentifier := r.config.Name
				if instanceIdentifier == "" {
					instanceIdentifier = r.config.Host
				}
				r.finalFilename = fmt.Sprintf("%s/%s_%d_%s.wav",
					r.outputDir,
					instanceIdentifier,
					r.frequency,
					firstTime.Format("2006-01-02T15:04:05.000Z"))
			}

			// Write header on first data packet (non-aligned mode)
			if !r.alignmentEnabled && !headerWritten && r.sampleRate > 0 {
				if err := r.writeWAVHeader(); err != nil {
					log.Printf("[%s] Failed to write WAV header: %v", r.getInstanceIdentifier(), err)
					r.mu.Unlock()
					return
				}
				headerWritten = true
				log.Printf("[%s] WAV header written (sample rate: %d Hz, channels: %d)", r.getInstanceIdentifier(), r.sampleRate, channels)
			}

			// Write decoded IQ data (non-aligned mode or after alignment)
			if !r.alignmentEnabled && headerWritten && len(pcmData) > 0 {
				n, err := r.file.Write(pcmData)
				if err != nil {
					log.Printf("[%s] Failed to write data: %v", r.getInstanceIdentifier(), err)
					r.mu.Unlock()
					return
				}
				r.samplesWritten += uint32(n / 4) // 4 bytes per sample (2 channels * 2 bytes)
			} else if r.alignmentEnabled && headerWritten && len(pcmData) > 0 && r.bufferProcessed {
				// Aligned mode, after buffer is processed
				// Only write packets that are at or after the alignment timestamp
				if gpsTimestampNanos >= *r.alignStartTime {
					// Trim the first packet if needed
					if r.samplesWritten == 0 && gpsTimestampNanos > *r.alignStartTime && sampleRate > 0 {
						timeDiff := gpsTimestampNanos - *r.alignStartTime
						samplesToSkip := int((timeDiff * uint64(sampleRate)) / 1000000000)
						bytesToSkip := samplesToSkip * 4
						if bytesToSkip < len(pcmData) {
							pcmData = pcmData[bytesToSkip:]
							log.Printf("[%s] Trimmed %d samples from first live packet", r.getInstanceIdentifier(), samplesToSkip)
						}
					}

					// If we have a target sample count, truncate packet if it would exceed the target
					if r.targetSamples != nil {
						packetSamples := uint32(len(pcmData) / 4)
						samplesRemaining := *r.targetSamples - r.samplesWritten

						if packetSamples > samplesRemaining {
							// Truncate packet to exact target
							bytesToWrite := int(samplesRemaining * 4)
							pcmData = pcmData[:bytesToWrite]
							log.Printf("[%s] Truncating final packet: %d samples needed to reach target %d",
								r.getInstanceIdentifier(), samplesRemaining, *r.targetSamples)
						}
					}

					n, err := r.file.Write(pcmData)
					if err != nil {
						log.Printf("[%s] Failed to write data: %v", r.getInstanceIdentifier(), err)
						r.mu.Unlock()
						return
					}
					r.samplesWritten += uint32(n / 4)
				}
			}

			r.mu.Unlock()
		} else if messageType == websocket.TextMessage {
			// Text messages might contain initial configuration
			// Parse it to get sample rate before first binary packet
			var msg map[string]interface{}
			if err := json.Unmarshal(message, &msg); err == nil {
				if sr, ok := msg["sampleRate"].(float64); ok && r.sampleRate == 0 {
					r.sampleRate = int(sr)
					log.Printf("[%s] Sample rate from text message: %d Hz", r.getInstanceIdentifier(), r.sampleRate)
				}
				if ch, ok := msg["channels"].(float64); ok {
					log.Printf("[%s] Channels from text message: %d", r.getInstanceIdentifier(), int(ch))
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
		_ = r.conn.Close()
		r.conn = nil
	}

	if r.pcmDecoder != nil {
		r.pcmDecoder.Close()
		r.pcmDecoder = nil
	}

	if r.file != nil {
		// Update WAV header with final sizes
		if err := r.updateWAVHeader(); err != nil {
			log.Printf("[%s] Warning: Failed to update WAV header: %v", r.getInstanceIdentifier(), err)
		}

		tempFilename := r.outputFile
		_ = r.file.Close()
		r.file = nil

		duration := time.Since(r.startTime)
		fileSize := r.samplesWritten * 4
		actualDuration := float64(r.samplesWritten) / float64(r.sampleRate)
		log.Printf("[%s] Recording stopped. Wrote %d samples (%.2f MB, %.3f seconds) in %v",
			r.getInstanceIdentifier(), r.samplesWritten, float64(fileSize)/(1024*1024), actualDuration, duration.Round(time.Millisecond))

		// Print last timestamp if we have it
		if r.lastTimestamp > 0 {
			lastTime := time.Unix(0, int64(r.lastTimestamp)).UTC()
			log.Printf("[%s] Last packet timestamp: %s", r.getInstanceIdentifier(), lastTime.Format("2006-01-02 15:04:05.000 MST"))
		}

		// Print time span if we have both timestamps
		if r.firstTimestampSet && r.lastTimestamp > 0 {
			timeSpan := time.Duration(r.lastTimestamp - r.firstTimestamp)
			log.Printf("[%s] Recording time span: %v", r.getInstanceIdentifier(), timeSpan.Round(time.Millisecond))
		}

		// Rename temp file to final filename if we have a timestamp
		if r.finalFilename != "" {
			if err := os.Rename(tempFilename, r.finalFilename); err != nil {
				log.Printf("[%s] Warning: Failed to rename file: %v", r.getInstanceIdentifier(), err)
				log.Printf("[%s] Recording saved as: %s", r.getInstanceIdentifier(), tempFilename)
			} else {
				log.Printf("[%s] Recording saved as: %s", r.getInstanceIdentifier(), r.finalFilename)

				// Save metadata file alongside WAV file
				if err := r.saveMetadata(); err != nil {
					log.Printf("[%s] Warning: Failed to save metadata: %v", r.getInstanceIdentifier(), err)
				}
			}
		} else {
			log.Printf("[%s] Recording saved as: %s", r.getInstanceIdentifier(), tempFilename)
		}
	}
}

// stringSlice is a custom flag type for collecting multiple string values
type stringSlice []string

func (s *stringSlice) String() string {
	return strings.Join(*s, ",")
}

func (s *stringSlice) Set(value string) error {
	*s = append(*s, value)
	return nil
}

func main() {
	// Command line flags
	var hosts stringSlice
	var ports stringSlice
	var names stringSlice
	var passwords stringSlice

	flag.Var(&hosts, "host", "UberSDR server host (can be specified multiple times)")
	flag.Var(&ports, "port", "UberSDR server port (can be specified multiple times, must match number of hosts)")
	flag.Var(&names, "name", "Optional friendly name for instance (can be specified multiple times)")
	flag.Var(&passwords, "password", "Server password if required (can be specified multiple times)")

	frequency := flag.Int("frequency", 14074000, "Frequency in Hz")
	duration := flag.Int("duration", 60, "Recording duration in seconds (0 for unlimited)")
	outputDir := flag.String("output-dir", ".", "Output directory for WAV files")
	ssl := flag.Bool("ssl", false, "Use SSL/TLS connection for all instances")
	align := flag.Bool("align", true, "Align recordings to common GPS timestamp (default: true)")

	flag.Parse()

	// Validate that we have at least one host
	if len(hosts) == 0 {
		log.Fatal("At least one -host must be specified")
	}

	// If no ports specified, use default for all hosts
	if len(ports) == 0 {
		defaultPort := "8073"
		if *ssl {
			defaultPort = "443"
		}
		for range hosts {
			ports = append(ports, defaultPort)
		}
	}

	// Validate that number of ports matches number of hosts
	if len(ports) != len(hosts) {
		log.Fatalf("Number of ports (%d) must match number of hosts (%d)", len(ports), len(hosts))
	}

	// Validate duration
	var durationPtr *int
	if *duration > 0 {
		durationPtr = duration
	}

	// Build instance configurations
	var instances []InstanceConfig
	for i, host := range hosts {
		// Parse port
		var port int
		if _, err := fmt.Sscanf(ports[i], "%d", &port); err != nil {
			log.Fatalf("Invalid port '%s': %v", ports[i], err)
		}

		// Get name if provided
		var name string
		if i < len(names) {
			name = names[i]
		}

		// Get password if provided
		var password string
		if i < len(passwords) {
			password = passwords[i]
		}

		instances = append(instances, InstanceConfig{
			Host:     host,
			Port:     port,
			SSL:      *ssl,
			Password: password,
			Name:     name,
		})
	}

	// Determine if alignment is needed (only for multiple instances)
	alignmentEnabled := *align && len(instances) > 1
	if alignmentEnabled {
		log.Printf("Recording from %d instance(s) at %d Hz with timestamp alignment", len(instances), *frequency)
	} else {
		log.Printf("Recording from %d instance(s) at %d Hz", len(instances), *frequency)
	}

	// Shared alignment timestamp (0 means not set yet)
	var alignStartTime uint64 = 0

	// Calculate target sample count for synchronized recording
	// IQ48 mode always uses 48000 Hz sample rate
	var targetSamples uint32
	var targetSamplesPtr *uint32
	if alignmentEnabled && durationPtr != nil {
		targetSamples = uint32(*durationPtr * 48000)
		targetSamplesPtr = &targetSamples
		log.Printf("Target sample count for synchronized recording: %d samples (%d seconds at 48000 Hz)",
			targetSamples, *durationPtr)
	}

	// Create recorders for each instance
	var recorders []*IQRecorder
	var wg sync.WaitGroup

	for _, config := range instances {
		recorder, err := NewIQRecorder(config, *frequency, durationPtr, *outputDir, alignmentEnabled, &alignStartTime, targetSamplesPtr)
		if err != nil {
			log.Fatalf("Failed to create recorder for %s:%d: %v", config.Host, config.Port, err)
		}
		recorders = append(recorders, recorder)
	}

	// Set up signal handling for graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	// Start all recorders
	for _, recorder := range recorders {
		if err := recorder.Start(); err != nil {
			log.Fatalf("Failed to start recording for %s: %v", recorder.getInstanceIdentifier(), err)
		}

		wg.Add(1)
		go func(r *IQRecorder) {
			defer wg.Done()
			<-r.doneChan
		}(recorder)
	}

	// If alignment is enabled, wait for all recorders to get their first timestamp
	if alignmentEnabled {
		log.Println("Waiting for all instances to receive first GPS timestamp...")

		// Wait for all recorders to have a first timestamp
		timeout := time.After(30 * time.Second)
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()

	waitLoop:
		for {
			select {
			case <-timeout:
				log.Fatal("Timeout waiting for all instances to receive GPS timestamps")
			case <-ticker.C:
				allReady := true
				var maxTimestamp uint64 = 0

				for _, r := range recorders {
					r.mu.Lock()
					if !r.firstTimestampSet {
						allReady = false
						r.mu.Unlock()
						break
					}
					if r.firstTimestamp > maxTimestamp {
						maxTimestamp = r.firstTimestamp
					}
					r.mu.Unlock()
				}

				if allReady {
					// All recorders have timestamps, set alignment time to max + 1 second
					alignStartTime = maxTimestamp + 1000000000 // Add 1 second
					alignTime := time.Unix(0, int64(alignStartTime)).UTC()
					log.Printf("All instances ready. Alignment timestamp: %s", alignTime.Format("2006-01-02 15:04:05.000 MST"))
					break waitLoop
				}
			}
		}
	}

	// Wait for either signal or all recordings to complete
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	select {
	case <-sigChan:
		log.Println("Interrupted by user, shutting down all recorders...")
		for _, recorder := range recorders {
			recorder.Stop()
		}
		wg.Wait()
	case <-done:
		// All recordings completed normally
		log.Println("All recordings complete")

		// Verify all recordings have the same sample count
		if len(recorders) > 1 {
			var sampleCounts []uint32
			for _, r := range recorders {
				r.mu.Lock()
				sampleCounts = append(sampleCounts, r.samplesWritten)
				r.mu.Unlock()
			}

			allSame := true
			firstCount := sampleCounts[0]
			for i, count := range sampleCounts {
				log.Printf("Instance %d (%s): %d samples", i, recorders[i].getInstanceIdentifier(), count)
				if count != firstCount {
					allSame = false
				}
			}

			if allSame {
				log.Printf("✓ All recordings have identical sample count: %d samples", firstCount)
			} else {
				log.Printf("⚠ Warning: Sample counts differ across recordings!")
			}
		}
	}
}

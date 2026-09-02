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

// IQRecorder records IQ data to a WAV file
type IQRecorder struct {
	config            InstanceConfig
	frequency         int
	iqMode            string // IQ capture mode: iq, iq48, iq96, iq192 or iq384
	modeSampleRate    int    // Sample rate iqMode delivers, from the mode table
	minFreqHz         int64  // Receiver tuning range, from /api/description
	maxFreqHz         int64
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
	pcmDecoder        *PCMv4StreamDecoder
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
func NewIQRecorder(config InstanceConfig, frequency int, iqMode string, duration *int, outputDir string, alignmentEnabled bool, alignStartTime *uint64, targetSamples *uint32) (*IQRecorder, error) {
	rate, ok := sampleRateForIQMode(iqMode)
	if !ok {
		return nil, validateIQMode(iqMode)
	}

	// The version 4 decoder carries the predictor's adaptation state and the
	// header fields the server chose not to repeat, so it belongs to one
	// connection: StartRecording replaces it on every connect.
	pcmDecoder := NewPCMv4StreamDecoder()

	recorder := &IQRecorder{
		config:           config,
		frequency:        frequency,
		iqMode:           iqMode,
		modeSampleRate:   rate,
		minFreqHz:        MinFrequencyHz,
		maxFreqHz:        MaxFrequencyHz,
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

	// Check that the mode being recorded is one this receiver offers. The list
	// is per-instance, so in a multi-instance run one receiver may permit iq384
	// while another stops at iq48 -- which is worth failing on by name rather
	// than discovering as a recording that never starts.
	if len(respData.AllowedIQModes) > 0 && !respData.Bypassed {
		if !containsString(respData.AllowedIQModes, r.iqMode) {
			return false, fmt.Errorf("%s mode not allowed by server (allowed modes: %v)", r.iqMode, respData.AllowedIQModes)
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

	// The same document carries how far this receiver tunes. Read it here
	// rather than with a second request, and per instance rather than once for
	// the run: a multi-instance capture can span receivers with different front
	// ends, and the one that cannot reach the frequency is the one to name.
	r.minFreqHz, r.maxFreqHz = tuningRangeFrom(r.metadata)

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

	// Warn rather than refuse when the frequency falls outside what the receiver
	// published. The range is advisory -- it can be stale, or absent, and a
	// receiver is entitled to serve an edge it did not advertise -- so this
	// names the mismatch and lets the server give the real answer.
	if int64(r.frequency) < r.minFreqHz || int64(r.frequency) > r.maxFreqHz {
		log.Printf("[%s] Warning: %.6f MHz is outside the receiver's published tuning range (%.6f - %.6f MHz); trying anyway",
			r.getInstanceIdentifier(), float64(r.frequency)/1e6,
			float64(r.minFreqHz)/1e6, float64(r.maxFreqHz)/1e6)
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
	q.Set("mode", r.iqMode)
	q.Set("user_session_id", r.userSessionID)
	q.Set("format", "pcm-zstd") // Lossless; IQ is served this way regardless
	// Named explicitly rather than left to the server's default of 1, so the
	// query says which format this recorder actually reads. A server from
	// 0.1.63 on refuses a version it cannot serve; older ones clamp silently
	// and receiveData recognises what comes back.
	q.Set("version", fmt.Sprintf("%d", pcmProtocolVersion))
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

	// The predictor adapts from the samples already decoded, so its state is
	// only meaningful within one socket. A reconnect must start from nothing or
	// it decodes the new stream against the old stream's taps.
	r.pcmDecoder = NewPCMv4StreamDecoder()

	log.Printf("[%s] Connected. Recording %s (%d Hz sample rate) at %d Hz...",
		r.getInstanceIdentifier(), r.iqMode, r.modeSampleRate, r.frequency)

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

	// Versions 1-3 needed the rate assigned up front, because a minimal-header
	// packet carried none and the server sends no initial status for a binary
	// format. Version 4 resynchronises every five seconds and on any change, so
	// the stream states its own rate and channel count and the first packet
	// carries them. The mode's expected rate is still recorded so a server that
	// serves something other than what was asked for is visible rather than
	// silently written into the WAV header.
	r.sampleRate = r.modeSampleRate
	log.Printf("[%s] Expecting %s: %d Hz, 2 channels", r.getInstanceIdentifier(), r.iqMode, r.modeSampleRate)

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
			// A server older than 0.1.63 clamps the requested version to 1-3
			// and answers with version 1 rather than refusing it, so its frames
			// arrive as zstd rather than as an error. Naming that beats filling
			// a log with "bad magic" and leaving an empty WAV behind.
			if isZstdFrame(message) {
				log.Printf("[%s] Server does not support audio protocol version %d (needs UberSDR 0.1.63 or later)",
					r.getInstanceIdentifier(), pcmProtocolVersion)
				return
			}

			// Binary message contains coded IQ data - decode it
			pcmData, sampleRate, channels, gpsTimestampNanos, err := r.pcmDecoder.DecodePacketLE(message)
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

			// The stream is authoritative about its own rate: every version 4
			// packet carries it, forward-filled from the last resynchronisation
			// point. Adopt it, and say so when it is not what the mode promised
			// -- the WAV header is written once from this value, so a rate that
			// differs unnoticed is a file that plays back at the wrong speed.
			if sampleRate > 0 && sampleRate != r.sampleRate {
				if headerWritten {
					log.Printf("[%s] Warning: sample rate changed to %d Hz mid-recording; the WAV header still says %d Hz",
						r.getInstanceIdentifier(), sampleRate, r.sampleRate)
				} else {
					if sampleRate != r.modeSampleRate {
						log.Printf("[%s] Warning: server is sending %d Hz for %s, not the expected %d Hz",
							r.getInstanceIdentifier(), sampleRate, r.iqMode, r.modeSampleRate)
					}
					log.Printf("[%s] Stream sample rate: %d Hz, channels: %d", r.getInstanceIdentifier(), sampleRate, channels)
					r.sampleRate = sampleRate
				}
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

	// The version 4 decoder is left in place. It holds no OS resources -- the
	// zstd reader that had to be closed here is gone -- and Stop runs on the
	// signal handler's goroutine while receiveData may still be inside a
	// decode, so clearing it would race for nothing to gain.

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
	iqMode := flag.String("mode", "iq48", "IQ capture mode: "+strings.Join(iqModeList(), ", ")+
		" (12, 48, 96, 192 and 384 kHz respectively). A receiver publishes which it permits.")
	duration := flag.Int("duration", 60, "Recording duration in seconds (0 for unlimited)")
	outputDir := flag.String("output-dir", ".", "Output directory for WAV files")
	ssl := flag.Bool("ssl", false, "Use SSL/TLS connection for all instances")
	align := flag.Bool("align", true, "Align recordings to common GPS timestamp (default: true)")

	flag.Parse()

	// Validate that we have at least one host
	if len(hosts) == 0 {
		log.Fatal("At least one -host must be specified")
	}

	// Reject an unknown mode before anything is dialled or any file is created.
	if err := validateIQMode(*iqMode); err != nil {
		log.Fatal(err)
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
		log.Printf("Recording %s from %d instance(s) at %d Hz with timestamp alignment", *iqMode, len(instances), *frequency)
	} else {
		log.Printf("Recording %s from %d instance(s) at %d Hz", *iqMode, len(instances), *frequency)
	}

	// Shared alignment timestamp (0 means not set yet)
	var alignStartTime uint64 = 0

	// Calculate target sample count for synchronized recording.
	//
	// The rate comes from the mode rather than the 48000 this assumed while
	// iq48 was the only option: at iq384 that constant would have stopped every
	// recording at an eighth of the requested duration, and the alignment would
	// still have called the result a success because all instances agreed on
	// the same wrong count.
	modeRate, _ := sampleRateForIQMode(*iqMode)
	var targetSamples uint32
	var targetSamplesPtr *uint32
	if alignmentEnabled && durationPtr != nil {
		targetSamples = uint32(*durationPtr * modeRate)
		targetSamplesPtr = &targetSamples
		log.Printf("Target sample count for synchronized recording: %d samples (%d seconds at %d Hz)",
			targetSamples, *durationPtr, modeRate)
	}

	// Create recorders for each instance
	var recorders []*IQRecorder
	var wg sync.WaitGroup

	for _, config := range instances {
		recorder, err := NewIQRecorder(config, *frequency, *iqMode, durationPtr, *outputDir, alignmentEnabled, &alignStartTime, targetSamplesPtr)
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

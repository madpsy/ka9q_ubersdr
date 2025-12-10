package main

import (
	"bytes"
	"context"
	"encoding/base64"
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
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/gordonklaus/portaudio"
	"github.com/gorilla/websocket"
)

// RadioClient represents the WebSocket radio client
type RadioClient struct {
	url              string
	host             string
	port             int
	frequency        int
	mode             string
	bandwidthLow     *int
	bandwidthHigh    *int
	outputMode       string
	wavFile          string
	duration         *float64
	ssl              bool
	password         string
	userSessionID    string
	running          bool
	startTime        *time.Time
	sampleRate       int
	channels         int
	wavWriter        *WAVWriter
	audioStream      *portaudio.Stream
	audioBuffer      chan []int16
	audioDeviceIndex int // PortAudio device index (-1 = default)
	nr2Enabled       bool
	nr2Processor     *NR2Processor
	nr2Strength      float64
	nr2Floor         float64
	nr2AdaptRate     float64
	autoReconnect    bool
	retryCount       int
	maxBackoff       time.Duration
	connCallback     func(*websocket.Conn)  // Callback to notify when connection is established
	audioCallback    func([]byte, int, int) // Callback for audio data streaming (data, sampleRate, channels)

	// Resampling support
	resampleEnabled    bool
	resampleOutputRate int
	resampler          *LibsamplerateResampler
	outputChannels     int // Number of output channels (1=mono, 2=stereo)
}

// WAVWriter handles WAV file writing
type WAVWriter struct {
	file       *os.File
	sampleRate int
	channels   int
	dataSize   int
}

// WebSocketMessage represents incoming WebSocket messages
type WebSocketMessage struct {
	Type       string `json:"type"`
	Data       string `json:"data,omitempty"`
	SampleRate int    `json:"sampleRate,omitempty"`
	Channels   int    `json:"channels,omitempty"`
	SessionID  string `json:"sessionId,omitempty"`
	Frequency  int    `json:"frequency,omitempty"`
	Mode       string `json:"mode,omitempty"`
	Error      string `json:"error,omitempty"`
}

// ConnectionCheckRequest for /connection endpoint
type ConnectionCheckRequest struct {
	UserSessionID string `json:"user_session_id"`
	Password      string `json:"password,omitempty"`
}

// ConnectionCheckResponse from /connection endpoint
type ConnectionCheckResponse struct {
	Allowed        bool   `json:"allowed"`
	Reason         string `json:"reason,omitempty"`
	ClientIP       string `json:"client_ip,omitempty"`
	SessionTimeout int    `json:"session_timeout"`
	MaxSessionTime int    `json:"max_session_time"`
	Bypassed       bool   `json:"bypassed"`
}

// NewRadioClient creates a new radio client instance
func NewRadioClient(urlStr, host string, port, frequency int, mode string,
	bandwidthLow, bandwidthHigh *int, outputMode, wavFile string,
	duration *float64, ssl bool, password string, audioDeviceIndex int, nr2Enabled bool, nr2Strength, nr2Floor, nr2AdaptRate float64,
	autoReconnect bool, resampleEnabled bool, resampleOutputRate int, outputChannels int) *RadioClient {

	// Determine default channels based on mode
	// IQ modes are stereo (I and Q channels), others are mono
	modeStr := strings.ToLower(mode)
	defaultChannels := 1
	if modeStr == "iq" || modeStr == "iq48" || modeStr == "iq96" || modeStr == "iq192" || modeStr == "iq384" {
		defaultChannels = 2
	}

	// Determine output channels
	// Default: 2 (stereo) when resampling is enabled for better device compatibility
	// Otherwise use input channels (1 for most modes, 2 for IQ modes)
	if outputChannels == 0 {
		if resampleEnabled {
			outputChannels = 2 // Default to stereo when resampling
		} else {
			outputChannels = defaultChannels // Match input channels
		}
	}

	client := &RadioClient{
		url:                urlStr,
		host:               host,
		port:               port,
		frequency:          frequency,
		mode:               modeStr,
		bandwidthLow:       bandwidthLow,
		bandwidthHigh:      bandwidthHigh,
		outputMode:         outputMode,
		wavFile:            wavFile,
		duration:           duration,
		ssl:                ssl,
		password:           password,
		userSessionID:      uuid.New().String(),
		running:            true,
		sampleRate:         12000,           // Default, will be updated from server
		channels:           defaultChannels, // Default based on mode, will be updated from server
		audioDeviceIndex:   audioDeviceIndex,
		nr2Enabled:         nr2Enabled,
		nr2Strength:        nr2Strength,
		nr2Floor:           nr2Floor,
		nr2AdaptRate:       nr2AdaptRate,
		autoReconnect:      autoReconnect,
		retryCount:         0,
		maxBackoff:         60 * time.Second,
		resampleEnabled:    resampleEnabled,
		resampleOutputRate: resampleOutputRate,
		outputChannels:     outputChannels,
	}

	// Initialize NR2 processor if enabled
	if client.nr2Enabled {
		client.nr2Processor = NewNR2Processor(client.sampleRate, 2048, 4)
		client.nr2Processor.SetParameters(nr2Strength, nr2Floor, nr2AdaptRate)
		client.nr2Processor.Enabled = true
		fmt.Fprintf(os.Stderr, "NR2 noise reduction enabled (strength=%.1f%%, floor=%.1f%%, adapt=%.1f%%)\n",
			nr2Strength, nr2Floor, nr2AdaptRate)
	}

	// Note: Resampler will be initialized later when we know the actual sample rate from the server
	// (in HandleMessage when we receive the first audio packet)

	return client
}

// BuildWebSocketURL constructs the WebSocket URL with query parameters
func (c *RadioClient) BuildWebSocketURL() string {
	if c.url != "" {
		// Parse existing URL
		parsedURL, err := url.Parse(c.url)
		if err != nil {
			log.Fatalf("Invalid URL: %v", err)
		}

		// Get base URL
		baseURL := fmt.Sprintf("%s://%s%s", parsedURL.Scheme, parsedURL.Host, parsedURL.Path)
		if parsedURL.Path == "" {
			baseURL += "/ws"
		}

		// Parse existing query parameters
		params := parsedURL.Query()

		// Override/add our parameters
		params.Set("frequency", fmt.Sprintf("%d", c.frequency))
		params.Set("mode", c.mode)
		params.Set("user_session_id", c.userSessionID)

		if c.bandwidthLow != nil {
			params.Set("bandwidthLow", fmt.Sprintf("%d", *c.bandwidthLow))
		}
		if c.bandwidthHigh != nil {
			params.Set("bandwidthHigh", fmt.Sprintf("%d", *c.bandwidthHigh))
		}
		if c.password != "" {
			params.Set("password", c.password)
		}

		return fmt.Sprintf("%s?%s", baseURL, params.Encode())
	}

	// Build URL from host/port/ssl
	protocol := "ws"
	if c.ssl {
		protocol = "wss"
	}

	wsURL := fmt.Sprintf("%s://%s:%d/ws?frequency=%d&mode=%s&user_session_id=%s",
		protocol, c.host, c.port, c.frequency, c.mode, c.userSessionID)

	if c.bandwidthLow != nil {
		wsURL += fmt.Sprintf("&bandwidthLow=%d", *c.bandwidthLow)
	}
	if c.bandwidthHigh != nil {
		wsURL += fmt.Sprintf("&bandwidthHigh=%d", *c.bandwidthHigh)
	}
	if c.password != "" {
		wsURL += fmt.Sprintf("&password=%s", url.QueryEscape(c.password))
	}

	return wsURL
}

// SetupWAVWriter initializes WAV file writer
func (c *RadioClient) SetupWAVWriter() error {
	file, err := os.Create(c.wavFile)
	if err != nil {
		return fmt.Errorf("failed to create WAV file: %w", err)
	}

	c.wavWriter = &WAVWriter{
		file:       file,
		sampleRate: c.sampleRate,
		channels:   c.channels,
		dataSize:   0,
	}

	// Write WAV header (will be updated on close)
	c.wavWriter.WriteHeader()
	fmt.Fprintf(os.Stderr, "Recording to WAV file: %s (%d channel(s))\n", c.wavFile, c.channels)
	return nil
}

// SetupPortAudio initializes PortAudio for audio playback
func (c *RadioClient) SetupPortAudio() error {
	// Initialize PortAudio
	if err := portaudio.Initialize(); err != nil {
		return fmt.Errorf("failed to initialize PortAudio: %w", err)
	}

	// Determine output sample rate (may differ from input if resampling)
	outputRate := c.sampleRate
	if c.resampleEnabled && c.resampleOutputRate > 0 {
		outputRate = c.resampleOutputRate
	}

	// Create buffered channel for audio samples
	// Buffer size: enough for about 2 seconds of audio at output rate
	// This needs to be larger when resampling to handle the increased data rate
	bufferFrames := outputRate * c.outputChannels * 2
	bufferChunks := bufferFrames / 256
	if bufferChunks < 32 {
		bufferChunks = 32 // Minimum buffer size
	}
	c.audioBuffer = make(chan []int16, bufferChunks)

	// Current position in the current chunk
	var currentChunk []int16
	var chunkPos int

	// Audio callback - called by PortAudio when it needs data
	callback := func(out []int16) {
		outPos := 0
		for outPos < len(out) {
			// If we've exhausted the current chunk, get a new one
			if currentChunk == nil || chunkPos >= len(currentChunk) {
				select {
				case currentChunk = <-c.audioBuffer:
					chunkPos = 0
				default:
					// No data available - output silence
					for i := outPos; i < len(out); i++ {
						out[i] = 0
					}
					return
				}
			}

			// Copy from current chunk to output
			toCopy := len(out) - outPos
			remaining := len(currentChunk) - chunkPos
			if toCopy > remaining {
				toCopy = remaining
			}

			copy(out[outPos:], currentChunk[chunkPos:chunkPos+toCopy])
			outPos += toCopy
			chunkPos += toCopy
		}
	}

	// Open audio stream with 256 frames per buffer (~21ms at 12kHz)
	var stream *portaudio.Stream
	var err error

	if c.audioDeviceIndex >= 0 {
		// Open specific device
		deviceInfo, err := portaudio.Devices()
		if err != nil {
			portaudio.Terminate()
			return fmt.Errorf("failed to get device list: %w", err)
		}

		if c.audioDeviceIndex >= len(deviceInfo) {
			portaudio.Terminate()
			return fmt.Errorf("invalid device index %d (max: %d)", c.audioDeviceIndex, len(deviceInfo)-1)
		}

		device := deviceInfo[c.audioDeviceIndex]

		// Create stream parameters for specific device
		streamParams := portaudio.StreamParameters{
			Output: portaudio.StreamDeviceParameters{
				Device:   device,
				Channels: c.outputChannels,
				Latency:  device.DefaultLowOutputLatency,
			},
			SampleRate:      float64(outputRate),
			FramesPerBuffer: 256,
		}

		stream, err = portaudio.OpenStream(streamParams, callback)
		if err != nil {
			portaudio.Terminate()
			return fmt.Errorf("failed to open audio stream on device %d: %w", c.audioDeviceIndex, err)
		}

		fmt.Fprintf(os.Stderr, "Using audio device [%d]: %s\n", c.audioDeviceIndex, device.Name)
	} else {
		// Use default device
		stream, err = portaudio.OpenDefaultStream(
			0,                // no input channels
			c.outputChannels, // output channels
			float64(outputRate),
			256, // frames per buffer
			callback,
		)
		if err != nil {
			portaudio.Terminate()
			return fmt.Errorf("failed to open audio stream: %w", err)
		}
	}

	// Start the stream
	if err := stream.Start(); err != nil {
		stream.Close()
		portaudio.Terminate()
		return fmt.Errorf("failed to start audio stream: %w", err)
	}

	c.audioStream = stream
	if c.resampleEnabled {
		fmt.Fprintf(os.Stderr, "PortAudio output started (sample rate: %d Hz, channels: %d, resampled from %d Hz)\n",
			outputRate, c.outputChannels, c.sampleRate)
	} else {
		fmt.Fprintf(os.Stderr, "PortAudio output started (sample rate: %d Hz, channels: %d)\n",
			outputRate, c.outputChannels)
	}
	return nil
}

// DecodeAudio decodes base64 audio data to PCM bytes
func (c *RadioClient) DecodeAudio(base64Data string) ([]byte, error) {
	// Decode base64
	audioBytes, err := base64.StdEncoding.DecodeString(base64Data)
	if err != nil {
		return nil, fmt.Errorf("failed to decode base64: %w", err)
	}

	// Convert big-endian to little-endian signed 16-bit PCM
	numSamples := len(audioBytes) / 2
	pcmData := make([]byte, len(audioBytes))

	for i := 0; i < numSamples; i++ {
		// Read big-endian int16
		highByte := audioBytes[i*2]
		lowByte := audioBytes[i*2+1]
		sample := int16((uint16(highByte) << 8) | uint16(lowByte))

		// Write as little-endian int16
		binary.LittleEndian.PutUint16(pcmData[i*2:], uint16(sample))
	}

	return pcmData, nil
}

// OutputAudio outputs audio data based on selected mode
func (c *RadioClient) OutputAudio(pcmData []byte) error {
	// Call audio callback if set (for browser streaming)
	if c.audioCallback != nil {
		c.audioCallback(pcmData, c.sampleRate, c.channels)
	}

	// Convert PCM bytes to int16 samples for processing
	numSamples := len(pcmData) / 2
	samples := make([]int16, numSamples)
	for i := 0; i < numSamples; i++ {
		samples[i] = int16(binary.LittleEndian.Uint16(pcmData[i*2:]))
	}

	// Apply NR2 noise reduction if enabled
	if c.nr2Processor != nil && c.nr2Enabled {
		// Convert to float32 array
		audioFloat := make([]float32, numSamples)
		for i := 0; i < numSamples; i++ {
			audioFloat[i] = float32(samples[i]) / 32768.0
		}

		// Process through NR2
		processedAudio := c.nr2Processor.Process(audioFloat)

		// Apply -3dB makeup gain (matches UI default)
		// -3dB = 10^(-3/20) = 0.7079 gain factor
		for i := range processedAudio {
			processedAudio[i] *= 0.7079
		}

		// Convert back to int16 and clip
		for i := 0; i < numSamples; i++ {
			sample := processedAudio[i] * 32768.0
			if sample > 32767 {
				sample = 32767
			} else if sample < -32768 {
				sample = -32768
			}
			samples[i] = int16(sample)
		}
	}

	// Apply resampling if enabled
	if c.resampleEnabled && c.resampler != nil {
		samples = c.resampler.Process(samples)
	}

	// Convert mono to stereo if needed (after resampling)
	if c.channels == 1 && c.outputChannels == 2 {
		stereoSamples := make([]int16, len(samples)*2)
		for i, sample := range samples {
			stereoSamples[i*2] = sample   // Left channel
			stereoSamples[i*2+1] = sample // Right channel (duplicate)
		}
		samples = stereoSamples
	}

	// Convert samples back to PCM bytes
	pcmData = make([]byte, len(samples)*2)
	for i, sample := range samples {
		binary.LittleEndian.PutUint16(pcmData[i*2:], uint16(sample))
	}

	switch c.outputMode {
	case "stdout":
		// Write raw PCM to stdout
		_, err := os.Stdout.Write(pcmData)
		return err

	case "portaudio":
		// Skip if PortAudio not initialized yet
		if c.audioBuffer == nil {
			return nil
		}

		// Convert PCM bytes to int16 samples for PortAudio
		numSamples := len(pcmData) / 2
		samples := make([]int16, numSamples)
		for i := 0; i < numSamples; i++ {
			samples[i] = int16(binary.LittleEndian.Uint16(pcmData[i*2:]))
		}

		// Send to audio buffer (blocking with timeout)
		select {
		case c.audioBuffer <- samples:
			// Successfully queued
		case <-time.After(100 * time.Millisecond):
			// Buffer full - this shouldn't happen with proper sizing
			fmt.Fprintf(os.Stderr, "Warning: Audio buffer full, dropping samples\n")
		}

	case "wav":
		// Write to WAV file
		if c.wavWriter != nil {
			_, err := c.wavWriter.file.Write(pcmData)
			if err != nil {
				return err
			}
			c.wavWriter.dataSize += len(pcmData)
		}
	}

	return nil
}

// CheckDuration checks if duration limit has been reached
func (c *RadioClient) CheckDuration() bool {
	if c.duration == nil {
		return true
	}

	if c.startTime == nil {
		now := time.Now()
		c.startTime = &now
		return true
	}

	elapsed := time.Since(*c.startTime).Seconds()
	if elapsed >= *c.duration {
		fmt.Fprintf(os.Stderr, "\nRecording duration reached: %.1fs\n", elapsed)
		return false
	}

	return true
}

// HandleMessage handles incoming WebSocket message
func (c *RadioClient) HandleMessage(msg WebSocketMessage) error {
	switch msg.Type {
	case "audio":
		// Process audio data
		sampleRate := msg.SampleRate
		if sampleRate == 0 {
			sampleRate = c.sampleRate
		}
		channels := msg.Channels
		if channels == 0 {
			channels = c.channels
		}

		// Update sample rate if changed OR if this is the first audio packet
		if sampleRate != c.sampleRate || (c.outputMode == "portaudio" && c.audioStream == nil) {
			if sampleRate != c.sampleRate {
				c.sampleRate = sampleRate
				fmt.Fprintf(os.Stderr, "Sample rate updated: %d Hz\n", c.sampleRate)
			}

			// Initialize resampler now that we know the actual sample rate
			if c.resampleEnabled && c.resampler == nil {
				// Don't resample IQ modes - they require exact sample rates
				isIQMode := strings.HasPrefix(c.mode, "iq")
				if isIQMode {
					fmt.Fprintf(os.Stderr, "Resampling disabled for IQ mode (requires exact sample rate)\n")
					c.resampleEnabled = false
				} else {
					// Always use mono (1 channel) for resampling, we'll convert to stereo after if needed
					libsrResampler, err := NewLibsamplerateResampler(c.sampleRate, c.resampleOutputRate, 1, 0)
					if err == nil {
						c.resampler = libsrResampler
						fmt.Fprintf(os.Stderr, "libsamplerate resampler initialized (SRC_SINC_BEST_QUALITY): %d Hz -> %d Hz\n",
							c.sampleRate, c.resampleOutputRate)
					} else {
						fmt.Fprintf(os.Stderr, "Error: libsamplerate not available: %v\n", err)
						fmt.Fprintf(os.Stderr, "Resampling disabled. Please rebuild with libsamplerate support (see build.sh)\n")
						c.resampleEnabled = false
					}
				}
			}

			// Setup PortAudio now that we have the actual sample rate (first time only)
			if c.outputMode == "portaudio" && c.audioStream == nil {
				if err := c.SetupPortAudio(); err != nil {
					fmt.Fprintf(os.Stderr, "Failed to setup PortAudio: %v\n", err)
					c.running = false
					return err
				}
			}
		}

		// Update channels if changed (requires restarting PortAudio)
		if channels != c.channels {
			c.channels = channels
			fmt.Fprintf(os.Stderr, "Channels updated: %d\n", c.channels)

			// Restart PortAudio with new channel count if active
			if c.outputMode == "portaudio" && c.audioStream != nil {
				fmt.Fprintf(os.Stderr, "Restarting PortAudio with new channel configuration...\n")
				c.audioStream.Stop()
				c.audioStream.Close()
				if err := c.SetupPortAudio(); err != nil {
					fmt.Fprintf(os.Stderr, "Failed to restart PortAudio: %v\n", err)
					c.running = false
					return err
				}
			}
		}

		if msg.Data != "" {
			pcmData, err := c.DecodeAudio(msg.Data)
			if err != nil {
				return err
			}

			if err := c.OutputAudio(pcmData); err != nil {
				return err
			}

			// Check duration limit
			if !c.CheckDuration() {
				c.running = false
			}
		}

	case "status":
		// Print status information
		sessionID := msg.SessionID
		if sessionID == "" {
			sessionID = "unknown"
		}
		fmt.Fprintf(os.Stderr, "Status: Session %s, %d Hz, mode %s\n",
			sessionID, msg.Frequency, msg.Mode)

	case "error":
		// Print error message
		errMsg := msg.Error
		if errMsg == "" {
			errMsg = "Unknown error"
		}
		fmt.Fprintf(os.Stderr, "Server error: %s\n", errMsg)
		c.running = false

	case "pong":
		// Keepalive response
		break
	}

	return nil
}

// SendTuneMessage sends a tune message to change frequency/mode/bandwidth without reconnecting
func (c *RadioClient) SendTuneMessage(conn *websocket.Conn, frequency int, mode string, bandwidthLow, bandwidthHigh *int) error {
	// Build tune message
	tuneMsg := map[string]interface{}{
		"type":      "tune",
		"frequency": frequency,
		"mode":      mode,
	}

	// Only include bandwidth for non-IQ modes
	isIQMode := mode == "iq" || mode == "iq48" || mode == "iq96" || mode == "iq192" || mode == "iq384"
	if !isIQMode {
		if bandwidthLow != nil {
			tuneMsg["bandwidthLow"] = *bandwidthLow
		}
		if bandwidthHigh != nil {
			tuneMsg["bandwidthHigh"] = *bandwidthHigh
		}
	}

	// Send the tune message
	if err := conn.WriteJSON(tuneMsg); err != nil {
		return fmt.Errorf("failed to send tune message: %w", err)
	}

	return nil
}

// SendKeepalive sends periodic keepalive messages
func (c *RadioClient) SendKeepalive(ctx context.Context, conn *websocket.Conn) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if c.running {
				msg := map[string]string{"type": "ping"}
				if err := conn.WriteJSON(msg); err != nil {
					fmt.Fprintf(os.Stderr, "Keepalive error: %v\n", err)
					return
				}
			}
		}
	}
}

// CheckConnectionAllowed checks if connection is allowed via /connection endpoint
func (c *RadioClient) CheckConnectionAllowed() (bool, error) {
	// Build HTTP URL for connection check
	protocol := "http"
	if c.ssl {
		protocol = "https"
	}

	var host string
	var port int

	if c.url != "" {
		// Extract host and port from WebSocket URL
		parsedURL, err := url.Parse(c.url)
		if err != nil {
			return false, err
		}
		host = parsedURL.Hostname()
		port = 80
		if parsedURL.Port() != "" {
			fmt.Sscanf(parsedURL.Port(), "%d", &port)
		} else if parsedURL.Scheme == "wss" {
			port = 443
		}
	} else {
		host = c.host
		port = c.port
	}

	httpURL := fmt.Sprintf("%s://%s:%d/connection", protocol, host, port)

	// Prepare request body
	reqBody := ConnectionCheckRequest{
		UserSessionID: c.userSessionID,
		Password:      c.password,
	}

	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return false, err
	}

	fmt.Fprintf(os.Stderr, "Checking connection permission...\n")

	req, err := http.NewRequest("POST", httpURL, bytes.NewBuffer(jsonData))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "UberSDR Client 1.0 (go)")

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Connection check failed: %v\n", err)
		fmt.Fprintf(os.Stderr, "Attempting connection anyway...\n")
		return true, nil // Continue on error (like the web UI does)
	}
	defer resp.Body.Close()

	var respData ConnectionCheckResponse
	if err := json.NewDecoder(resp.Body).Decode(&respData); err != nil {
		return false, err
	}

	if !respData.Allowed {
		fmt.Fprintf(os.Stderr, "Connection rejected: %s\n", respData.Reason)
		return false, nil
	}

	clientIP := respData.ClientIP
	if clientIP == "" {
		clientIP = "unknown"
	}
	fmt.Fprintf(os.Stderr, "Connection allowed (client IP: %s)\n", clientIP)
	return true, nil
}

// calculateBackoff calculates exponential backoff time with max limit
func (c *RadioClient) calculateBackoff() time.Duration {
	// Exponential backoff: 2^retryCount seconds, capped at maxBackoff
	backoff := time.Duration(1<<uint(c.retryCount)) * time.Second
	if backoff > c.maxBackoff {
		backoff = c.maxBackoff
	}
	return backoff
}

// runOnce executes a single connection attempt
func (c *RadioClient) runOnce() int {
	// Check if connection is allowed before attempting WebSocket connection
	allowed, err := c.CheckConnectionAllowed()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Connection check error: %v\n", err)
	}
	if !allowed {
		return 1
	}

	wsURL := c.BuildWebSocketURL()
	fmt.Fprintf(os.Stderr, "Connecting to %s\n", wsURL)
	fmt.Fprintf(os.Stderr, "Frequency: %d Hz, Mode: %s\n", c.frequency, c.mode)

	if c.bandwidthLow != nil && c.bandwidthHigh != nil {
		fmt.Fprintf(os.Stderr, "Bandwidth: %d to %d Hz\n", *c.bandwidthLow, *c.bandwidthHigh)
	}

	// Connect to WebSocket with custom User-Agent header
	headers := http.Header{}
	headers.Set("User-Agent", "UberSDR Client 1.0 (go)")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, headers)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Connection error: %v\n", err)
		return 1
	}
	defer conn.Close()

	fmt.Fprintf(os.Stderr, "Connected!\n")

	// Notify callback if set (for API mode)
	if c.connCallback != nil {
		c.connCallback(conn)
	}

	// Reset retry count on successful connection
	c.retryCount = 0

	// Don't setup PortAudio yet - wait for first audio packet to get actual sample rate
	// (WAV setup can happen now since it doesn't depend on the actual rate)
	if c.outputMode == "wav" {
		if err := c.SetupWAVWriter(); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			return 1
		}
	}

	// Start keepalive goroutine
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.SendKeepalive(ctx, conn)

	// Receive and process messages
	for c.running {
		var msg WebSocketMessage
		err := conn.ReadJSON(&msg)
		if err != nil {
			if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				fmt.Fprintf(os.Stderr, "Connection closed by server\n")
			} else {
				fmt.Fprintf(os.Stderr, "Read error: %v\n", err)
			}
			break
		}

		if err := c.HandleMessage(msg); err != nil {
			fmt.Fprintf(os.Stderr, "Message handling error: %v\n", err)
		}
	}

	c.Cleanup()
	return 0
}

// Run executes the main client loop with auto-reconnect support
func (c *RadioClient) Run() int {
	for c.running {
		exitCode := c.runOnce()

		// If not auto-reconnecting or clean exit, stop
		if !c.autoReconnect || exitCode == 0 {
			return exitCode
		}

		// If user interrupted, stop
		if !c.running {
			return 0
		}

		// Calculate backoff time
		c.retryCount++
		backoff := c.calculateBackoff()

		fmt.Fprintf(os.Stderr, "\nReconnecting in %.0fs (attempt %d)...\n", backoff.Seconds(), c.retryCount)

		// Wait with ability to interrupt
		select {
		case <-time.After(backoff):
			// Continue to reconnect
		case <-func() chan struct{} {
			ch := make(chan struct{})
			go func() {
				for c.running {
					time.Sleep(100 * time.Millisecond)
				}
				close(ch)
			}()
			return ch
		}():
			fmt.Fprintf(os.Stderr, "Reconnect cancelled\n")
			return 1
		}
	}

	return 0
}

// Cleanup cleans up resources
func (c *RadioClient) Cleanup() {
	fmt.Fprintf(os.Stderr, "\nCleaning up...\n")

	// Close WAV file
	if c.wavWriter != nil {
		c.wavWriter.Close()
		fmt.Fprintf(os.Stderr, "WAV file closed: %s\n", c.wavFile)
	}

	// Close PortAudio stream
	if c.audioStream != nil {
		c.audioStream.Stop()
		c.audioStream.Close()
		portaudio.Terminate()
		fmt.Fprintf(os.Stderr, "PortAudio closed\n")
	}

	// Close audio buffer channel
	if c.audioBuffer != nil {
		close(c.audioBuffer)
	}
}

// SetAudioCallback sets a callback function to receive audio data
// The callback receives PCM audio data, sample rate, and number of channels
func (c *RadioClient) SetAudioCallback(callback func([]byte, int, int)) {
	c.audioCallback = callback
}

// WAVWriter methods

// WriteHeader writes the WAV file header
func (w *WAVWriter) WriteHeader() error {
	// WAV header structure
	header := make([]byte, 44)

	// RIFF chunk
	copy(header[0:4], "RIFF")
	// File size - 8 (will be updated on close)
	binary.LittleEndian.PutUint32(header[4:8], 36)
	copy(header[8:12], "WAVE")

	// fmt chunk
	copy(header[12:16], "fmt ")
	binary.LittleEndian.PutUint32(header[16:20], 16) // fmt chunk size
	binary.LittleEndian.PutUint16(header[20:22], 1)  // PCM format
	binary.LittleEndian.PutUint16(header[22:24], 1)  // Number of channels (will be updated)
	binary.LittleEndian.PutUint32(header[24:28], uint32(w.sampleRate))
	binary.LittleEndian.PutUint32(header[28:32], uint32(w.sampleRate*2)) // Byte rate (will be updated)
	binary.LittleEndian.PutUint16(header[32:34], 2)                      // Block align (will be updated)
	binary.LittleEndian.PutUint16(header[34:36], 16)                     // Bits per sample

	// data chunk
	copy(header[36:40], "data")
	binary.LittleEndian.PutUint32(header[40:44], 0) // Data size (will be updated on close)

	_, err := w.file.Write(header)
	return err
}

// Close closes the WAV file and updates the header
func (w *WAVWriter) Close() error {
	if w.file == nil {
		return nil
	}

	// Update header with actual sizes
	w.file.Seek(4, 0)
	binary.Write(w.file, binary.LittleEndian, uint32(36+w.dataSize))

	// Update number of channels
	w.file.Seek(22, 0)
	binary.Write(w.file, binary.LittleEndian, uint16(w.channels))

	// Update byte rate (sample_rate * channels * bytes_per_sample)
	w.file.Seek(28, 0)
	binary.Write(w.file, binary.LittleEndian, uint32(w.sampleRate*w.channels*2))

	// Update block align (channels * bytes_per_sample)
	w.file.Seek(32, 0)
	binary.Write(w.file, binary.LittleEndian, uint16(w.channels*2))

	// Update data size
	w.file.Seek(40, 0)
	binary.Write(w.file, binary.LittleEndian, uint32(w.dataSize))

	return w.file.Close()
}

func listAudioDevices() {
	// Initialize PortAudio
	if err := portaudio.Initialize(); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to initialize PortAudio: %v\n", err)
		os.Exit(1)
	}
	defer portaudio.Terminate()

	devices, err := portaudio.Devices()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to get device list: %v\n", err)
		os.Exit(1)
	}

	defaultOutput, err := portaudio.DefaultOutputDevice()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: Could not get default output device: %v\n", err)
	}

	fmt.Println("Available PortAudio output devices:")
	fmt.Println()

	for i, device := range devices {
		if device.MaxOutputChannels > 0 {
			defaultMarker := ""
			if defaultOutput != nil && device.Name == defaultOutput.Name {
				defaultMarker = " (default)"
			}

			fmt.Printf("  [%d] %s%s\n", i, device.Name, defaultMarker)
			fmt.Printf("      Max channels: %d, Sample rate: %.0f Hz\n",
				device.MaxOutputChannels, device.DefaultSampleRate)
			fmt.Printf("      Latency: %.1f ms\n", device.DefaultLowOutputLatency.Seconds()*1000)
			fmt.Println()
		}
	}
}

func main() {
	// Command-line flags
	apiModeFlag := flag.Bool("api", false, "Run in API mode with web interface")
	apiPortFlag := flag.Int("api-port", 8090, "API server port (default: 8090)")
	urlFlag := flag.String("u", "", "Full WebSocket URL (e.g., ws://host:port/ws or wss://host/ws)")
	hostFlag := flag.String("H", "localhost", "Server hostname (default: localhost, ignored if --url is provided)")
	portFlag := flag.Int("p", 8080, "Server port (default: 8080, ignored if --url is provided)")
	frequencyFlag := flag.Int("f", 0, "Frequency in Hz (e.g., 14074000 for 14.074 MHz)")
	modeFlag := flag.String("m", "", "Demodulation mode (am, sam, usb, lsb, fm, nfm, cwu, cwl, iq, iq48, iq96, iq192, iq384 - wide IQ modes require bypassed IP)")
	bandwidthFlag := flag.String("b", "", "Bandwidth in format low:high (e.g., -5000:5000)")
	outputFlag := flag.String("o", "portaudio", "Output mode (portaudio, stdout, wav)")
	wavFileFlag := flag.String("w", "", "WAV file path (required when output=wav)")
	timeFlag := flag.Float64("t", 0, "Recording duration in seconds (for WAV output)")
	sslFlag := flag.Bool("s", false, "Use WSS (WebSocket Secure, ignored if --url is provided)")
	audioDeviceFlag := flag.Int("audio-device", -1, "PortAudio device index (-1 for default, use --list-devices to see available devices)")
	listDevicesFlag := flag.Bool("list-devices", false, "List available audio output devices and exit")
	nr2Flag := flag.Bool("nr2", false, "Enable NR2 spectral subtraction noise reduction")
	nr2StrengthFlag := flag.Float64("nr2-strength", 40.0, "NR2 noise reduction strength, 0-100% (default: 40)")
	nr2FloorFlag := flag.Float64("nr2-floor", 10.0, "NR2 spectral floor to prevent musical noise, 0-10% (default: 10)")
	nr2AdaptRateFlag := flag.Float64("nr2-adapt-rate", 1.0, "NR2 noise profile adaptation rate, 0.1-5.0% (default: 1)")
	autoReconnectFlag := flag.Bool("auto-reconnect", false, "Automatically reconnect on connection loss with exponential backoff (max 60s)")
	passwordFlag := flag.String("password", "", "Bypass password for accessing wide IQ modes and bypassing session limits")

	// Resampling flags
	resampleFlag := flag.Bool("resample", false, "Enable audio resampling (useful for devices that don't support 12 kHz)")
	resampleRateFlag := flag.Int("resample-rate", 48000, "Target sample rate for resampling (default: 48000 Hz)")

	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "CLI Radio Client for ka9q_ubersdr\n\n")
		fmt.Fprintf(os.Stderr, "Usage: %s [options]\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "Options:\n")
		flag.PrintDefaults()
		fmt.Fprintf(os.Stderr, "\nExamples:\n")
		fmt.Fprintf(os.Stderr, "  # Run in API mode with web interface\n")
		fmt.Fprintf(os.Stderr, "  %s --api\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  # Run in API mode on custom port\n")
		fmt.Fprintf(os.Stderr, "  %s --api --api-port 9000\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  # List available audio devices\n")
		fmt.Fprintf(os.Stderr, "  %s --list-devices\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  # Listen to 14.074 MHz USB via PortAudio (default device)\n")
		fmt.Fprintf(os.Stderr, "  %s -f 14074000 -m usb\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  # Listen using specific audio device\n")
		fmt.Fprintf(os.Stderr, "  %s -f 14074000 -m usb --audio-device 2\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  # Listen with resampling to 48 kHz (for devices that don't support 12 kHz)\n")
		fmt.Fprintf(os.Stderr, "  %s -f 14074000 -m usb --resample --resample-rate 48000\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  # Connect using full URL\n")
		fmt.Fprintf(os.Stderr, "  %s -u ws://radio.example.com:8073/ws -f 14074000 -m usb\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  # Record 1000 kHz AM to WAV file for 60 seconds\n")
		fmt.Fprintf(os.Stderr, "  %s -f 1000000 -m am -o wav -w recording.wav -t 60\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  # Output raw PCM to stdout with custom bandwidth\n")
		fmt.Fprintf(os.Stderr, "  %s -f 7100000 -m lsb -b -2700:-50 -o stdout > audio.pcm\n", os.Args[0])
	}

	flag.Parse()

	// API mode
	if *apiModeFlag {
		// Initialize config manager
		configManager := NewConfigManager(GetConfigPath())
		if err := configManager.Load(); err != nil {
			log.Printf("Warning: Failed to load config: %v (using defaults)", err)
		} else {
			log.Printf("Loaded configuration from %s", GetConfigPath())
		}

		// Update API port from config if not specified on command line
		if *apiPortFlag == 8090 { // Default value
			config := configManager.Get()
			if config.APIPort != 0 {
				*apiPortFlag = config.APIPort
			}
		}

		// Save API port to config
		configManager.Update(func(c *ClientConfig) {
			c.APIPort = *apiPortFlag
		})

		manager := NewWebSocketManager()
		defer manager.Cleanup()

		server := NewAPIServer(manager, configManager, *apiPortFlag)

		// Setup signal handler for graceful shutdown
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
		go func() {
			<-sigChan
			fmt.Fprintf(os.Stderr, "\nShutting down API server...\n")
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			server.Stop(ctx)
			os.Exit(0)
		}()

		// Check for auto-connect
		config := configManager.Get()
		if config.AutoConnect {
			log.Printf("Auto-connect enabled, connecting to %s:%d...", config.Host, config.Port)

			// Create client from saved config
			client := NewRadioClient(
				"", config.Host, config.Port, config.Frequency, config.Mode,
				config.BandwidthLow, config.BandwidthHigh, config.OutputMode, "",
				nil, config.SSL, config.Password, config.AudioDevice, config.NR2Enabled,
				config.NR2Strength, config.NR2Floor, config.NR2AdaptRate, false,
				config.ResampleEnabled, config.ResampleOutputRate,
				config.OutputChannels,
			)

			// Attempt to connect in background
			go func() {
				if err := manager.Connect(client); err != nil {
					log.Printf("Auto-connect failed: %v", err)
				} else {
					log.Printf("Auto-connect successful")
				}
			}()
		}

		// Start API server
		log.Printf("Configuration will be saved to: %s", GetConfigPath())
		if err := server.Start(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("API server error: %v", err)
		}
		return
	}

	// List devices mode
	if *listDevicesFlag {
		listAudioDevices()
		os.Exit(0)
	}

	// Validate required arguments for CLI mode
	if *frequencyFlag == 0 {
		fmt.Fprintf(os.Stderr, "Error: -f/--frequency is required in CLI mode\n")
		flag.Usage()
		os.Exit(1)
	}

	if *modeFlag == "" {
		fmt.Fprintf(os.Stderr, "Error: -m/--mode is required in CLI mode\n")
		flag.Usage()
		os.Exit(1)
	}

	// Validate mode
	validModes := map[string]bool{
		"am": true, "sam": true, "usb": true, "lsb": true,
		"fm": true, "nfm": true, "cwu": true, "cwl": true, "iq": true,
		"iq48": true, "iq96": true, "iq192": true, "iq384": true,
	}
	if !validModes[strings.ToLower(*modeFlag)] {
		fmt.Fprintf(os.Stderr, "Error: invalid mode '%s'\n", *modeFlag)
		os.Exit(1)
	}

	// Validate output mode
	if *outputFlag == "wav" && *wavFileFlag == "" {
		fmt.Fprintf(os.Stderr, "Error: --wav-file is required when output mode is 'wav'\n")
		os.Exit(1)
	}

	if *timeFlag > 0 && *outputFlag != "wav" {
		fmt.Fprintf(os.Stderr, "Error: --time can only be used with output mode 'wav'\n")
		os.Exit(1)
	}

	// Validate NR2 parameters
	if *nr2StrengthFlag < 0 || *nr2StrengthFlag > 100 {
		fmt.Fprintf(os.Stderr, "Error: --nr2-strength must be between 0 and 100\n")
		os.Exit(1)
	}
	if *nr2FloorFlag < 0 || *nr2FloorFlag > 10 {
		fmt.Fprintf(os.Stderr, "Error: --nr2-floor must be between 0 and 10\n")
		os.Exit(1)
	}
	if *nr2AdaptRateFlag < 0.1 || *nr2AdaptRateFlag > 5.0 {
		fmt.Fprintf(os.Stderr, "Error: --nr2-adapt-rate must be between 0.1 and 5.0\n")
		os.Exit(1)
	}

	// Validate resampling parameters
	if *resampleFlag {
		if *resampleRateFlag <= 0 {
			fmt.Fprintf(os.Stderr, "Error: --resample-rate must be positive\n")
			os.Exit(1)
		}
		// Warn if resampling IQ modes
		if strings.HasPrefix(*modeFlag, "iq") {
			fmt.Fprintf(os.Stderr, "Warning: Resampling is disabled for IQ modes (they require exact sample rates)\n")
		}
	}

	// Validate URL
	if *urlFlag != "" {
		parsedURL, err := url.Parse(*urlFlag)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: invalid URL: %v\n", err)
			os.Exit(1)
		}
		if parsedURL.Scheme != "ws" && parsedURL.Scheme != "wss" {
			fmt.Fprintf(os.Stderr, "Error: URL must use ws:// or wss:// scheme\n")
			os.Exit(1)
		}
	}

	// Parse bandwidth
	var bandwidthLow, bandwidthHigh *int
	if *bandwidthFlag != "" {
		parts := strings.Split(*bandwidthFlag, ":")
		if len(parts) != 2 {
			fmt.Fprintf(os.Stderr, "Error: bandwidth must be in format 'low:high' (e.g., '-5000:5000')\n")
			os.Exit(1)
		}
		var low, high int
		if _, err := fmt.Sscanf(parts[0], "%d", &low); err != nil {
			fmt.Fprintf(os.Stderr, "Error: invalid bandwidth low value\n")
			os.Exit(1)
		}
		if _, err := fmt.Sscanf(parts[1], "%d", &high); err != nil {
			fmt.Fprintf(os.Stderr, "Error: invalid bandwidth high value\n")
			os.Exit(1)
		}
		bandwidthLow = &low
		bandwidthHigh = &high
	}

	// Parse duration
	var duration *float64
	if *timeFlag > 0 {
		duration = timeFlag
	}

	// Create client
	client := NewRadioClient(
		*urlFlag, *hostFlag, *portFlag, *frequencyFlag, *modeFlag,
		bandwidthLow, bandwidthHigh, *outputFlag, *wavFileFlag,
		duration, *sslFlag, *passwordFlag, *audioDeviceFlag, *nr2Flag, *nr2StrengthFlag, *nr2FloorFlag, *nr2AdaptRateFlag,
		*autoReconnectFlag,
		*resampleFlag, *resampleRateFlag,
		0, // outputChannels: 0 = auto (2 when resampling, otherwise match input)
	)

	// Setup signal handler for graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigChan
		fmt.Fprintf(os.Stderr, "\nInterrupted, shutting down...\n")
		client.running = false
	}()

	// Run client
	exitCode := client.Run()
	os.Exit(exitCode)
}

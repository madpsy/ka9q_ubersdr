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
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/gordonklaus/portaudio"
	"github.com/gorilla/websocket"
)

// BandRange represents a frequency range for an amateur radio band
type BandRange struct {
	Min int // Minimum frequency in Hz
	Max int // Maximum frequency in Hz
}

// BandRanges defines the frequency ranges for amateur radio bands
// Based on UK RSGB allocations, matching the Python client
var BandRanges = map[string]BandRange{
	"160m": {Min: 1810000, Max: 2000000},
	"80m":  {Min: 3500000, Max: 3800000},
	"60m":  {Min: 5258500, Max: 5406500},
	"40m":  {Min: 7000000, Max: 7200000},
	"30m":  {Min: 10100000, Max: 10150000},
	"20m":  {Min: 14000000, Max: 14350000},
	"17m":  {Min: 18068000, Max: 18168000},
	"15m":  {Min: 21000000, Max: 21450000},
	"12m":  {Min: 24890000, Max: 24990000},
	"10m":  {Min: 28000000, Max: 29700000},
}

// GetBandForFrequency returns the band name for a given frequency
// Returns empty string if frequency is not within any defined band
func GetBandForFrequency(frequency int) string {
	for band, bandRange := range BandRanges {
		if frequency >= bandRange.Min && frequency <= bandRange.Max {
			return band
		}
	}
	return ""
}

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
	tciServer        *TCIServer             // TCI server instance

	// TCI audio resampling (stateful, persistent across packets)
	tciResampler *LibsamplerateResampler // Mono resampler for TCI audio

	// Connection response data
	bypassed       bool     // Whether the connection is bypassed
	allowedIQModes []string // Allowed IQ modes from server
	maxSessionTime int      // Maximum session time in seconds (0 = unlimited)

	// Resampling support
	resampleEnabled    bool
	resampleOutputRate int
	resampler          *LibsamplerateResampler
	outputChannels     int // Number of output channels (1=mono, 2=stereo)

	// FIFO output
	fifoPath    string
	fifoFile    *os.File
	fifoCreated bool // Track if we created the FIFO

	// UDP output
	udpHost    string
	udpPort    int
	udpConn    *net.UDPConn
	udpEnabled bool

	// Audio output settings
	volume              float64 // Volume level 0.0-1.0
	leftChannelEnabled  bool    // Enable left channel output
	rightChannelEnabled bool    // Enable right channel output

	// Mutex for thread-safe output control
	mu sync.RWMutex

	// Band tracking for automatic LSB/USB mode switching
	previousBand string // Track previous band to detect band changes
}

// Output control methods for dynamic enable/disable

// EnablePortAudio starts PortAudio output with the specified device
func (c *RadioClient) EnablePortAudio(deviceIndex int) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.audioStream != nil {
		return fmt.Errorf("PortAudio already enabled")
	}

	c.audioDeviceIndex = deviceIndex

	// Initialize resampler if needed and not already initialized
	if c.resampleEnabled && c.resampler == nil && c.sampleRate > 0 {
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

	return c.SetupPortAudio()
}

// DisablePortAudio stops and closes PortAudio output
func (c *RadioClient) DisablePortAudio() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.audioStream == nil {
		return fmt.Errorf("PortAudio not enabled")
	}

	c.audioStream.Stop()
	c.audioStream.Close()
	c.audioStream = nil

	if c.audioBuffer != nil {
		close(c.audioBuffer)
		c.audioBuffer = nil
	}

	fmt.Fprintf(os.Stderr, "PortAudio disabled\n")
	return nil
}

// EnableFIFO creates and opens a FIFO at the specified path
func (c *RadioClient) EnableFIFO(path string) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.fifoPath != "" {
		return fmt.Errorf("FIFO already enabled at %s", c.fifoPath)
	}

	c.fifoPath = path
	return c.SetupFIFO()
}

// DisableFIFO closes and optionally removes the FIFO
func (c *RadioClient) DisableFIFO() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.fifoPath == "" {
		return fmt.Errorf("FIFO not enabled")
	}

	// Close FIFO file if open
	if c.fifoFile != nil {
		c.fifoFile.Close()
		c.fifoFile = nil
	}

	// Remove FIFO if we created it
	if c.fifoCreated {
		if err := os.Remove(c.fifoPath); err == nil {
			fmt.Fprintf(os.Stderr, "FIFO removed: %s\n", c.fifoPath)
		}
		c.fifoCreated = false
	}

	fmt.Fprintf(os.Stderr, "FIFO disabled: %s\n", c.fifoPath)
	c.fifoPath = ""
	return nil
}

// EnableUDP opens a UDP connection to the specified host and port
func (c *RadioClient) EnableUDP(host string, port int) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.udpConn != nil {
		return fmt.Errorf("UDP already enabled")
	}

	c.udpHost = host
	c.udpPort = port

	addr := &net.UDPAddr{
		IP:   net.ParseIP(host),
		Port: port,
	}

	conn, err := net.DialUDP("udp", nil, addr)
	if err != nil {
		return fmt.Errorf("failed to create UDP connection: %w", err)
	}

	c.udpConn = conn
	c.udpEnabled = true
	fmt.Fprintf(os.Stderr, "UDP enabled: %s:%d\n", host, port)
	return nil
}

// DisableUDP closes the UDP connection
func (c *RadioClient) DisableUDP() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.udpConn == nil {
		return fmt.Errorf("UDP not enabled")
	}

	c.udpConn.Close()
	c.udpConn = nil
	c.udpEnabled = false
	fmt.Fprintf(os.Stderr, "UDP disabled\n")
	return nil
}

// GetOutputStatus returns the current status of all outputs
func (c *RadioClient) GetOutputStatus() map[string]interface{} {
	c.mu.RLock()
	defer c.mu.RUnlock()

	return map[string]interface{}{
		"portaudio": map[string]interface{}{
			"enabled":     c.audioStream != nil,
			"deviceIndex": c.audioDeviceIndex,
		},
		"fifo": map[string]interface{}{
			"enabled": c.fifoPath != "",
			"path":    c.fifoPath,
		},
		"udp": map[string]interface{}{
			"enabled": c.udpConn != nil,
			"host":    c.udpHost,
			"port":    c.udpPort,
		},
		"volume":              c.volume,
		"leftChannelEnabled":  c.leftChannelEnabled,
		"rightChannelEnabled": c.rightChannelEnabled,
		"resampleEnabled":     c.resampleEnabled,
		"resampleOutputRate":  c.resampleOutputRate,
		"outputChannels":      c.outputChannels,
	}
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
	Allowed        bool     `json:"allowed"`
	Reason         string   `json:"reason,omitempty"`
	ClientIP       string   `json:"client_ip,omitempty"`
	SessionTimeout int      `json:"session_timeout"`
	MaxSessionTime int      `json:"max_session_time"`
	Bypassed       bool     `json:"bypassed"`
	AllowedIQModes []string `json:"allowed_iq_modes,omitempty"`
}

// NewRadioClient creates a new radio client instance
func NewRadioClient(urlStr, host string, port, frequency int, mode string,
	bandwidthLow, bandwidthHigh *int, outputMode, wavFile string,
	duration *float64, ssl bool, password string, audioDeviceIndex int, nr2Enabled bool, nr2Strength, nr2Floor, nr2AdaptRate float64,
	autoReconnect bool, resampleEnabled bool, resampleOutputRate int, outputChannels int,
	fifoPath string, udpHost string, udpPort int, udpEnabled bool) *RadioClient {

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
		url:                 urlStr,
		host:                host,
		port:                port,
		frequency:           frequency,
		mode:                modeStr,
		bandwidthLow:        bandwidthLow,
		bandwidthHigh:       bandwidthHigh,
		outputMode:          outputMode,
		wavFile:             wavFile,
		duration:            duration,
		ssl:                 ssl,
		password:            password,
		userSessionID:       uuid.New().String(),
		running:             true,
		sampleRate:          12000,           // Default, will be updated from server
		channels:            defaultChannels, // Default based on mode, will be updated from server
		audioDeviceIndex:    audioDeviceIndex,
		nr2Enabled:          nr2Enabled,
		nr2Strength:         nr2Strength,
		nr2Floor:            nr2Floor,
		nr2AdaptRate:        nr2AdaptRate,
		autoReconnect:       autoReconnect,
		retryCount:          0,
		maxBackoff:          60 * time.Second,
		resampleEnabled:     resampleEnabled,
		resampleOutputRate:  resampleOutputRate,
		outputChannels:      outputChannels,
		fifoPath:            fifoPath,
		udpHost:             udpHost,
		udpPort:             udpPort,
		udpEnabled:          udpEnabled,
		volume:              1.0,                            // Default volume at 100%
		leftChannelEnabled:  true,                           // Left channel enabled by default
		rightChannelEnabled: true,                           // Right channel enabled by default
		previousBand:        GetBandForFrequency(frequency), // Initialize with current band
	}

	// Initialize NR2 processor if enabled
	if client.nr2Enabled {
		client.nr2Processor = NewNR2Processor(client.sampleRate, 2048, 4)
		client.nr2Processor.SetParameters(nr2Strength, nr2Floor, nr2AdaptRate)
		client.nr2Processor.Enabled = true
		fmt.Fprintf(os.Stderr, "NR2 noise reduction enabled (strength=%.1f%%, floor=%.1f%%, adapt=%.1f%%)\n",
			nr2Strength, nr2Floor, nr2AdaptRate)
	}

	// Initialize UDP connection if enabled
	if client.udpEnabled || client.outputMode == "udp" {
		addr := &net.UDPAddr{
			IP:   net.ParseIP(client.udpHost),
			Port: client.udpPort,
		}
		conn, err := net.DialUDP("udp", nil, addr)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Warning: Failed to create UDP connection: %v\n", err)
			client.udpEnabled = false
		} else {
			client.udpConn = conn
			fmt.Fprintf(os.Stderr, "UDP output configured: %s:%d\n", client.udpHost, client.udpPort)
		}
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

// SetupFIFO creates or opens the FIFO (named pipe)
func (c *RadioClient) SetupFIFO() error {
	if c.fifoPath == "" {
		return nil
	}

	// Check if FIFO already exists
	info, err := os.Stat(c.fifoPath)
	if err == nil {
		// File exists, check if it's a FIFO
		if info.Mode()&os.ModeNamedPipe == 0 {
			return fmt.Errorf("%s exists but is not a FIFO", c.fifoPath)
		}
		fmt.Fprintf(os.Stderr, "Using existing FIFO: %s\n", c.fifoPath)
	} else if os.IsNotExist(err) {
		// Create new FIFO
		if err := syscall.Mkfifo(c.fifoPath, 0666); err != nil {
			return fmt.Errorf("failed to create FIFO: %w", err)
		}
		c.fifoCreated = true
		fmt.Fprintf(os.Stderr, "Created FIFO: %s\n", c.fifoPath)
	} else {
		return fmt.Errorf("failed to stat FIFO path: %w", err)
	}

	fmt.Fprintf(os.Stderr, "FIFO ready at: %s (will open when reader connects)\n", c.fifoPath)
	return nil
}

// SetupPortAudio initializes PortAudio for audio playback
func (c *RadioClient) SetupPortAudio() (returnErr error) {
	// Recover from PortAudio panics (e.g., assertion failures in pa_front.c)
	defer func() {
		if r := recover(); r != nil {
			returnErr = fmt.Errorf("PortAudio initialization panic: %v (this may indicate an audio system configuration issue)", r)
		}
	}()

	// Initialize PortAudio
	if err := portaudio.Initialize(); err != nil {
		return fmt.Errorf("failed to initialize PortAudio: %w", err)
	}

	// Determine output sample rate (may differ from input if resampling)
	outputRate := c.sampleRate
	if c.resampleEnabled && c.resampleOutputRate > 0 {
		outputRate = c.resampleOutputRate
	}

	// Try to open the stream, with automatic resampling fallback on sample rate error
	stream, err := c.openPortAudioStream(outputRate)
	if err != nil && !c.resampleEnabled && strings.Contains(err.Error(), "Invalid sample rate") {
		// Sample rate not supported - try enabling resampling to 48kHz (widely supported)
		fmt.Fprintf(os.Stderr, "Warning: Device doesn't support %d Hz, enabling automatic resampling to 48000 Hz...\n", outputRate)

		// Don't resample IQ modes - they require exact sample rates
		isIQMode := strings.HasPrefix(c.mode, "iq")
		if isIQMode {
			portaudio.Terminate()
			return fmt.Errorf("device doesn't support %d Hz and IQ mode cannot be resampled: %w", outputRate, err)
		}

		// Enable resampling
		c.resampleEnabled = true
		c.resampleOutputRate = 48000
		outputRate = 48000

		// Initialize resampler if not already done
		if c.resampler == nil && c.sampleRate > 0 {
			libsrResampler, resamplerErr := NewLibsamplerateResampler(c.sampleRate, c.resampleOutputRate, 1, 0)
			if resamplerErr == nil {
				c.resampler = libsrResampler
				fmt.Fprintf(os.Stderr, "libsamplerate resampler initialized (SRC_SINC_BEST_QUALITY): %d Hz -> %d Hz\n",
					c.sampleRate, c.resampleOutputRate)
			} else {
				portaudio.Terminate()
				return fmt.Errorf("failed to initialize resampler for fallback: %w", resamplerErr)
			}
		}

		// Retry opening stream with resampled rate (PortAudio is still initialized)
		stream, err = c.openPortAudioStream(outputRate)
		if err != nil {
			portaudio.Terminate()
			return fmt.Errorf("failed to open audio stream even with resampling to %d Hz: %w", outputRate, err)
		}

		fmt.Fprintf(os.Stderr, "Successfully enabled automatic resampling fallback\n")
	} else if err != nil {
		portaudio.Terminate()
		return err
	}

	// Wait briefly for initial audio data to arrive before starting playback
	// This helps prevent initial clicks but doesn't block for long
	startTime := time.Now()
	timeout := 500 * time.Millisecond // Short timeout

	for len(c.audioBuffer) == 0 {
		if time.Since(startTime) > timeout {
			// No audio yet, but start anyway - buffer will fill during playback
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	if len(c.audioBuffer) > 0 {
		fmt.Fprintf(os.Stderr, "Audio buffer ready (%d chunks) in %.0fms\n",
			len(c.audioBuffer), time.Since(startTime).Seconds()*1000)
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

// openPortAudioStream opens the PortAudio stream with the specified output rate
// Returns the stream without starting it, so caller can handle errors before starting
func (c *RadioClient) openPortAudioStream(outputRate int) (*portaudio.Stream, error) {

	// Create buffered channel for audio samples
	// Buffer size: 250ms of audio to handle network jitter with minimal delay
	bufferFrames := outputRate * c.outputChannels / 4 // 250ms
	bufferChunks := bufferFrames / 2048               // Chunk size for ~250ms total
	if bufferChunks < 8 {
		bufferChunks = 8 // Minimum buffer size
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

	// Open audio stream with adaptive buffer size
	// Try moderate buffers for ~250ms latency, fall back to smaller if device doesn't support
	var stream *portaudio.Stream
	var err error

	// Buffer sizes targeting ~250ms at 48kHz (12000 frames) down to ~10ms (512 frames)
	bufferSizes := []int{2048, 1024, 512, 256}
	var lastErr error

	if c.audioDeviceIndex >= 0 {
		// Open specific device
		deviceInfo, err := portaudio.Devices()
		if err != nil {
			return nil, fmt.Errorf("failed to get device list: %w", err)
		}

		if c.audioDeviceIndex >= len(deviceInfo) {
			return nil, fmt.Errorf("invalid device index %d (max: %d)", c.audioDeviceIndex, len(deviceInfo)-1)
		}

		device := deviceInfo[c.audioDeviceIndex]

		// Try different buffer sizes until one works
		for _, bufferSize := range bufferSizes {
			// Create stream parameters for specific device
			streamParams := portaudio.StreamParameters{
				Output: portaudio.StreamDeviceParameters{
					Device:   device,
					Channels: c.outputChannels,
					Latency:  device.DefaultHighOutputLatency,
				},
				SampleRate:      float64(outputRate),
				FramesPerBuffer: bufferSize,
			}

			stream, err = portaudio.OpenStream(streamParams, callback)
			if err == nil {
				fmt.Fprintf(os.Stderr, "Using audio device [%d]: %s (buffer: %d frames)\n",
					c.audioDeviceIndex, device.Name, bufferSize)
				break
			}
			lastErr = err

			// Try with default latency if high latency failed
			if bufferSize == bufferSizes[0] {
				streamParams.Output.Latency = device.DefaultLowOutputLatency
				stream, err = portaudio.OpenStream(streamParams, callback)
				if err == nil {
					fmt.Fprintf(os.Stderr, "Using audio device [%d]: %s (buffer: %d frames, low latency mode)\n",
						c.audioDeviceIndex, device.Name, bufferSize)
					break
				}
			}
		}

		if stream == nil {
			return nil, fmt.Errorf("failed to open audio stream on device %d with any buffer size: %w", c.audioDeviceIndex, lastErr)
		}
	} else {
		// Use default device - try different buffer sizes
		for _, bufferSize := range bufferSizes {
			stream, err = portaudio.OpenDefaultStream(
				0,                // no input channels
				c.outputChannels, // output channels
				float64(outputRate),
				bufferSize,
				callback,
			)
			if err == nil {
				fmt.Fprintf(os.Stderr, "Using default audio device (buffer: %d frames)\n", bufferSize)
				break
			}
			lastErr = err
		}

		if stream == nil {
			return nil, fmt.Errorf("failed to open audio stream with any buffer size: %w", lastErr)
		}
	}

	return stream, nil
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
	// Send audio/IQ to TCI server if enabled (before any processing)
	if c.tciServer != nil {
		// Determine if we're in IQ mode or audio mode
		isIQMode := strings.HasPrefix(c.mode, "iq")

		if isIQMode {
			// IQ MODE: Send as IQ stream
			// Convert PCM int16 to float32 for TCI
			iqFloat32 := ConvertPCMToFloat32(pcmData, c.channels)

			// Send to TCI server as IQ stream (receiver 0, at current sample rate)
			c.tciServer.SendIQData(0, iqFloat32, c.sampleRate)
		} else {
			// AUDIO MODE: Send as audio stream
			// TCI expects float32 stereo audio at 48 kHz
			// Convert PCM int16 to float32 normalized to [-1.0, 1.0]
			numSamples := len(pcmData) / 2
			audioFloat32 := make([]float32, numSamples)
			for i := 0; i < numSamples; i++ {
				sample := int16(binary.LittleEndian.Uint16(pcmData[i*2:]))
				audioFloat32[i] = float32(sample) / 32768.0
			}

			// Resample to TCI audio sample rate (48 kHz) if needed
			tciSampleRate := c.tciServer.audioSampleRate
			if c.sampleRate != tciSampleRate {
				// Initialize stateful resampler if needed (mono only, we'll handle stereo separately)
				if c.tciResampler == nil {
					resampler, err := NewLibsamplerateResampler(c.sampleRate, tciSampleRate, 1, 0)
					if err == nil {
						c.tciResampler = resampler
					}
				}

				if c.tciResampler != nil {
					// Handle mono vs stereo resampling
					if c.channels == 1 {
						// Mono: resample directly using float32 data
						// Convert float32 to int16 for resampler
						int16Samples := make([]int16, len(audioFloat32))
						for i, sample := range audioFloat32 {
							int16Samples[i] = int16(sample * 32768.0)
						}

						// Resample
						resampledInt16 := c.tciResampler.Process(int16Samples)

						// Convert back to float32
						audioFloat32 = make([]float32, len(resampledInt16))
						for i, sample := range resampledInt16 {
							audioFloat32[i] = float32(sample) / 32768.0
						}
					} else {
						// Stereo: de-interleave, resample each channel, re-interleave
						// This matches Python's approach for stereo resampling
						leftChannel := make([]int16, numSamples/2)
						rightChannel := make([]int16, numSamples/2)
						for i := 0; i < numSamples/2; i++ {
							leftChannel[i] = int16(audioFloat32[i*2] * 32768.0)
							rightChannel[i] = int16(audioFloat32[i*2+1] * 32768.0)
						}

						// Resample left channel
						leftResampled := c.tciResampler.Process(leftChannel)

						// Need separate resampler for right channel (stateful)
						// For now, use the same resampler (this is a simplification)
						// TODO: Add separate right channel resampler
						rightResampled := c.tciResampler.Process(rightChannel)

						// Re-interleave
						minLen := len(leftResampled)
						if len(rightResampled) < minLen {
							minLen = len(rightResampled)
						}
						audioFloat32 = make([]float32, minLen*2)
						for i := 0; i < minLen; i++ {
							audioFloat32[i*2] = float32(leftResampled[i]) / 32768.0
							audioFloat32[i*2+1] = float32(rightResampled[i]) / 32768.0
						}
					}
				}
			}

			// Convert mono to stereo AFTER resampling (if needed)
			var audioFloat32Stereo []float32
			if c.channels == 1 {
				// Mono input: create proper stereo by interleaving L and R channels
				// We want: [L0, R0, L1, R1, L2, R2, ...] where L=R for mono
				numSamples := len(audioFloat32)
				audioFloat32Stereo = make([]float32, numSamples*2)
				for i := 0; i < numSamples; i++ {
					audioFloat32Stereo[i*2] = audioFloat32[i]   // Left channel (even indices)
					audioFloat32Stereo[i*2+1] = audioFloat32[i] // Right channel (odd indices)
				}
			} else {
				// Already stereo and interleaved
				audioFloat32Stereo = audioFloat32
			}

			// Convert to bytes for TCI transmission (little-endian float32)
			audioBytes := make([]byte, len(audioFloat32Stereo)*4)
			for i, sample := range audioFloat32Stereo {
				bits := math.Float32bits(sample)
				binary.LittleEndian.PutUint32(audioBytes[i*4:], bits)
			}

			// Send to TCI server (receiver 0, at TCI's sample rate)
			c.tciServer.SendAudioData(0, audioBytes, tciSampleRate)
		}
	}

	// Write raw PCM to FIFO FIRST (before any processing)
	// This gives the FIFO the original audio straight from the source
	if c.fifoPath != "" {
		// Try to open FIFO if not already open
		if c.fifoFile == nil {
			// Open in non-blocking mode
			file, err := os.OpenFile(c.fifoPath, os.O_WRONLY|syscall.O_NONBLOCK, 0)
			if err == nil {
				c.fifoFile = file
				fmt.Fprintf(os.Stderr, "FIFO reader connected!\n")
			}
			// If error, no reader yet, skip this write
		}

		// Write to FIFO if open
		if c.fifoFile != nil {
			_, err := c.fifoFile.Write(pcmData)
			if err != nil {
				// Reader disconnected or other error
				fmt.Fprintf(os.Stderr, "FIFO reader disconnected\n")
				c.fifoFile.Close()
				c.fifoFile = nil
			}
		}
	}

	// Call audio callback if set (for browser streaming)
	// Browser gets raw audio before PortAudio-specific processing (volume/channel selection)
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

	// Apply volume and channel selection
	c.mu.RLock()
	volume := c.volume
	leftEnabled := c.leftChannelEnabled
	rightEnabled := c.rightChannelEnabled
	c.mu.RUnlock()

	// Determine actual output channels based on resampling and mode
	actualChannels := c.channels
	if c.resampleEnabled || (c.channels == 1 && c.outputChannels == 2) {
		actualChannels = c.outputChannels
	}

	// Apply volume and channel selection
	if actualChannels == 2 {
		// Stereo output
		for i := 0; i < len(samples); i += 2 {
			// Apply volume to left channel
			if leftEnabled {
				samples[i] = int16(float64(samples[i]) * volume)
			} else {
				samples[i] = 0
			}
			// Apply volume to right channel
			if rightEnabled {
				samples[i+1] = int16(float64(samples[i+1]) * volume)
			} else {
				samples[i+1] = 0
			}
		}
	} else {
		// Mono output - just apply volume
		for i := 0; i < len(samples); i++ {
			samples[i] = int16(float64(samples[i]) * volume)
		}
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
		// Only send to PortAudio if the stream is actually running
		if c.audioStream != nil && c.audioBuffer != nil {
			// Convert PCM bytes to int16 samples for PortAudio
			numSamples := len(pcmData) / 2
			samples := make([]int16, numSamples)
			for i := 0; i < numSamples; i++ {
				samples[i] = int16(binary.LittleEndian.Uint16(pcmData[i*2:]))
			}

			// Send to audio buffer (blocking with longer timeout for network jitter)
			select {
			case c.audioBuffer <- samples:
				// Successfully queued
			case <-time.After(500 * time.Millisecond):
				// Buffer full - this indicates sustained network issues
				fmt.Fprintf(os.Stderr, "Warning: Audio buffer full (sustained), dropping samples\n")
			}
		}
		// Continue to process UDP/FIFO outputs even if PortAudio is disabled

	case "wav":
		// Write to WAV file
		if c.wavWriter != nil {
			_, err := c.wavWriter.file.Write(pcmData)
			if err != nil {
				return err
			}
			c.wavWriter.dataSize += len(pcmData)
		}

	case "udp":
		// Send to UDP socket (main output mode)
		// UDP is connectionless - silently ignore any errors (nothing listening is normal)
		if c.udpConn != nil {
			c.udpConn.Write(pcmData)
		}
	}

	// Send UDP output if enabled as additional output (works alongside any output mode)
	// UDP is connectionless - silently ignore any errors (nothing listening is normal)
	if c.udpEnabled && c.udpConn != nil && c.outputMode != "udp" {
		c.udpConn.Write(pcmData)
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

		// Update sample rate if changed
		if sampleRate != c.sampleRate {
			c.sampleRate = sampleRate
			fmt.Fprintf(os.Stderr, "Sample rate updated: %d Hz\n", c.sampleRate)

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
		}

		// Update channels if changed (requires restarting PortAudio)
		if channels != c.channels {
			c.channels = channels
			fmt.Fprintf(os.Stderr, "Channels updated: %d\n", c.channels)

			// Restart PortAudio with new channel count if it's currently active
			if c.audioStream != nil {
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

	// Store connection response data
	c.bypassed = respData.Bypassed
	c.allowedIQModes = respData.AllowedIQModes
	c.maxSessionTime = respData.MaxSessionTime

	clientIP := respData.ClientIP
	if clientIP == "" {
		clientIP = "unknown"
	}
	fmt.Fprintf(os.Stderr, "Connection allowed (client IP: %s, bypassed: %v, allowed IQ modes: %v, max session time: %ds)\n",
		clientIP, c.bypassed, c.allowedIQModes, c.maxSessionTime)
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

	// Setup FIFO if configured (independent of output mode)
	if c.fifoPath != "" {
		if err := c.SetupFIFO(); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: Failed to setup FIFO: %v\n", err)
			c.fifoPath = "" // Disable FIFO on error
		}
	}

	// Don't setup PortAudio yet - wait for first audio packet to get actual sample rate
	// (WAV setup can happen now since it doesn't depend on the actual rate)
	if c.outputMode == "wav" {
		if err := c.SetupWAVWriter(); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			return 1
		}
	} else if c.outputMode == "udp" {
		fmt.Fprintf(os.Stderr, "UDP output to %s:%d: %d Hz, %d channel(s)\n",
			c.udpHost, c.udpPort, c.sampleRate, c.outputChannels)
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
	// Recover from any panics during cleanup
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(os.Stderr, "Warning: Panic during cleanup (recovered): %v\n", r)
		}
	}()

	fmt.Fprintf(os.Stderr, "\nCleaning up...\n")

	// Close FIFO
	if c.fifoFile != nil {
		c.fifoFile.Close()
		fmt.Fprintf(os.Stderr, "FIFO closed: %s\n", c.fifoPath)
		c.fifoFile = nil
	}

	// Remove FIFO file only if we created it
	if c.fifoPath != "" && c.fifoCreated {
		if err := os.Remove(c.fifoPath); err == nil {
			fmt.Fprintf(os.Stderr, "FIFO removed: %s\n", c.fifoPath)
		}
	}

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
	// Use defer/recover to handle potential double-close panics
	func() {
		defer func() { recover() }()
		if c.audioBuffer != nil {
			close(c.audioBuffer)
			c.audioBuffer = nil
		}
	}()

	// Close UDP connection
	if c.udpConn != nil {
		c.udpConn.Close()
		fmt.Fprintf(os.Stderr, "UDP connection closed\n")
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
	// Recover from PortAudio panics
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(os.Stderr, "PortAudio panic during device listing: %v\n", r)
			fmt.Fprintf(os.Stderr, "This indicates an audio system configuration issue.\n")
			os.Exit(1)
		}
	}()

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
	// Get default values from environment variables if set
	defaultAPIPort := 8090
	if envPort := os.Getenv("API_PORT"); envPort != "" {
		if port, err := strconv.Atoi(envPort); err == nil {
			defaultAPIPort = port
		}
	}

	defaultConfigFile := ""
	if envConfig := os.Getenv("CONFIG_FILE"); envConfig != "" {
		defaultConfigFile = envConfig
	}

	// Command-line flags - API mode only
	apiPortFlag := flag.Int("api-port", defaultAPIPort, "API server port (default: 8090, env: API_PORT)")
	configFileFlag := flag.String("config-file", defaultConfigFile, "Path to configuration file (default: auto-detect, env: CONFIG_FILE)")

	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "API Radio Client for ka9q_ubersdr\n\n")
		fmt.Fprintf(os.Stderr, "This application runs in API mode with a web interface.\n")
		fmt.Fprintf(os.Stderr, "Connect via web browser at http://localhost:%d\n\n", *apiPortFlag)
		fmt.Fprintf(os.Stderr, "Usage: %s [options]\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "Options:\n")
		flag.PrintDefaults()
		fmt.Fprintf(os.Stderr, "\nExamples:\n")
		fmt.Fprintf(os.Stderr, "  # Run with default port (8090)\n")
		fmt.Fprintf(os.Stderr, "  %s\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  # Run on custom port\n")
		fmt.Fprintf(os.Stderr, "  %s --api-port 9000\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  # Use custom config file\n")
		fmt.Fprintf(os.Stderr, "  %s --config-file /path/to/config.json\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "\nConfiguration:\n")
		fmt.Fprintf(os.Stderr, "  All radio settings (frequency, mode, server connection, etc.) are\n")
		fmt.Fprintf(os.Stderr, "  configured through the web interface and saved automatically.\n")
		fmt.Fprintf(os.Stderr, "  Default config file location: %s\n", GetConfigPath())
	}

	flag.Parse()

	// Determine config file path
	configPath := *configFileFlag
	if configPath == "" {
		configPath = GetConfigPath()
	}

	// Initialize config manager
	configManager := NewConfigManager(configPath)
	if err := configManager.Load(); err != nil {
		log.Printf("Warning: Failed to load config: %v (using defaults)", err)
	} else {
		log.Printf("Loaded configuration from %s", configPath)
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

	// Check for auto-connect (backend auto-connect on startup)
	// Note: ConnectOnDemand is handled by the frontend when the page loads
	config := configManager.Get()
	if config.AutoConnect && !config.ConnectOnDemand {
		log.Printf("Auto-connect enabled, connecting to %s:%d...", config.Host, config.Port)

		// Create client from saved config
		client := NewRadioClient(
			"", config.Host, config.Port, config.Frequency, config.Mode,
			config.BandwidthLow, config.BandwidthHigh, config.OutputMode, "",
			nil, config.SSL, config.Password, config.AudioDevice, config.NR2Enabled,
			config.NR2Strength, config.NR2Floor, config.NR2AdaptRate, false,
			config.ResampleEnabled, config.ResampleOutputRate,
			config.OutputChannels,
			config.FIFOPath, config.UDPHost, config.UDPPort, config.UDPEnabled,
		)

		// Attempt to connect in background
		go func() {
			if err := manager.Connect(client); err != nil {
				log.Printf("Auto-connect failed: %v", err)
			} else {
				log.Printf("Auto-connect successful")

				// Restore saved output states after auto-connect
				go func() {
					log.Printf("Output restoration goroutine started (auto-connect), waiting 2 seconds...")
					time.Sleep(2 * time.Second)

					log.Printf("Checking connection status for output restoration...")
					if !manager.IsConnected() {
						log.Printf("Connection lost before output restoration could complete")
						return
					}

					log.Printf("Connection still active, loading config...")
					config := configManager.Get()
					log.Printf("Config loaded: PortAudioEnabled=%v, FIFOEnabled=%v, UDPEnabled=%v",
						config.PortAudioEnabled, config.FIFOEnabled, config.UDPEnabled)

					// Restore PortAudio state
					if config.PortAudioEnabled {
						log.Printf("Attempting to restore PortAudio output (device %d)...", config.PortAudioDevice)
						if err := manager.EnablePortAudioOutput(config.PortAudioDevice); err != nil {
							log.Printf("Warning: Failed to restore PortAudio output: %v", err)
						} else {
							log.Printf("Successfully restored PortAudio output (device %d)", config.PortAudioDevice)
						}
					}

					// Restore FIFO state
					if config.FIFOEnabled && config.FIFOPath != "" {
						log.Printf("Attempting to restore FIFO output (%s)...", config.FIFOPath)
						if err := manager.EnableFIFOOutput(config.FIFOPath); err != nil {
							log.Printf("Warning: Failed to restore FIFO output: %v", err)
						} else {
							log.Printf("Successfully restored FIFO output (%s)", config.FIFOPath)
						}
					}

					// Note: UDP state is already restored via the UDPEnabled flag passed to NewRadioClient
				}()
			}
		}()
	} else if config.ConnectOnDemand {
		log.Printf("Connect-on-demand enabled - connection will be initiated from web UI")
	}

	// Check for flrig auto-connect (independent of SDR connection)
	if config.FlrigEnabled && config.RadioControlType == "flrig" {
		log.Printf("flrig auto-connect enabled, connecting to %s:%d...", config.FlrigHost, config.FlrigPort)
		go func() {
			// Wait a moment for the API server to be ready
			time.Sleep(500 * time.Millisecond)

			if err := manager.ConnectFlrig(config.FlrigHost, config.FlrigPort, config.FlrigVFO,
				config.FlrigSyncToRig, config.FlrigSyncFromRig); err != nil {
				log.Printf("flrig auto-connect failed: %v", err)
			} else {
				log.Printf("flrig auto-connect successful (VFO %s, sync: SDR->rig=%v, rig->SDR=%v)",
					config.FlrigVFO, config.FlrigSyncToRig, config.FlrigSyncFromRig)
			}
		}()
	}

	// Check for TCI auto-start (independent of SDR connection)
	if config.TCIAutoStart && config.TCIPort > 0 {
		log.Printf("TCI auto-start enabled, starting TCI server on port %d...", config.TCIPort)
		go func() {
			// Wait a moment for the API server to be ready
			time.Sleep(500 * time.Millisecond)

			if err := manager.StartTCIServer(config.TCIPort); err != nil {
				log.Printf("TCI auto-start failed: %v", err)
			} else {
				log.Printf("TCI auto-start successful (port %d)", config.TCIPort)
			}
		}()
	}

	// Start API server
	log.Printf("Starting API server on http://localhost:%d", *apiPortFlag)
	log.Printf("Configuration will be saved to: %s", configPath)
	if err := server.Start(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("API server error: %v", err)
	}
}

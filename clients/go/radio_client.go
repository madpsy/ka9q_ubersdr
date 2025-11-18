package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// RadioClient represents the WebSocket radio client
type RadioClient struct {
	url           string
	host          string
	port          int
	frequency     int
	mode          string
	bandwidthLow  *int
	bandwidthHigh *int
	outputMode    string
	wavFile       string
	duration      *float64
	ssl           bool
	userSessionID string
	running       bool
	startTime     *time.Time
	sampleRate    int
	channels      int
	wavWriter     *WAVWriter
	pipewireCmd   *exec.Cmd
	pipewireStdin io.WriteCloser
	nr2Enabled    bool
	nr2Processor  *NR2Processor
	nr2Strength   float64
	nr2Floor      float64
	nr2AdaptRate  float64
	autoReconnect bool
	retryCount    int
	maxBackoff    time.Duration
}

// WAVWriter handles WAV file writing
type WAVWriter struct {
	file       *os.File
	sampleRate int
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
}

// ConnectionCheckResponse from /connection endpoint
type ConnectionCheckResponse struct {
	Allowed  bool   `json:"allowed"`
	Reason   string `json:"reason,omitempty"`
	ClientIP string `json:"client_ip,omitempty"`
}

// NewRadioClient creates a new radio client instance
func NewRadioClient(urlStr, host string, port, frequency int, mode string,
	bandwidthLow, bandwidthHigh *int, outputMode, wavFile string,
	duration *float64, ssl, nr2Enabled bool, nr2Strength, nr2Floor, nr2AdaptRate float64,
	autoReconnect bool) *RadioClient {

	client := &RadioClient{
		url:           urlStr,
		host:          host,
		port:          port,
		frequency:     frequency,
		mode:          strings.ToLower(mode),
		bandwidthLow:  bandwidthLow,
		bandwidthHigh: bandwidthHigh,
		outputMode:    outputMode,
		wavFile:       wavFile,
		duration:      duration,
		ssl:           ssl,
		userSessionID: uuid.New().String(),
		running:       true,
		sampleRate:    12000, // Default, will be updated from server
		channels:      1,     // Default mono, will be updated from server
		nr2Enabled:    nr2Enabled,
		nr2Strength:   nr2Strength,
		nr2Floor:      nr2Floor,
		nr2AdaptRate:  nr2AdaptRate,
		autoReconnect: autoReconnect,
		retryCount:    0,
		maxBackoff:    60 * time.Second,
	}

	// Initialize NR2 processor if enabled
	if client.nr2Enabled {
		client.nr2Processor = NewNR2Processor(client.sampleRate, 2048, 4)
		client.nr2Processor.SetParameters(nr2Strength, nr2Floor, nr2AdaptRate)
		client.nr2Processor.Enabled = true
		fmt.Fprintf(os.Stderr, "NR2 noise reduction enabled (strength=%.1f%%, floor=%.1f%%, adapt=%.1f%%)\n",
			nr2Strength, nr2Floor, nr2AdaptRate)
	}

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
		dataSize:   0,
	}

	// Write WAV header (will be updated on close)
	c.wavWriter.WriteHeader()
	fmt.Fprintf(os.Stderr, "Recording to WAV file: %s\n", c.wavFile)
	return nil
}

// SetupPipewire starts PipeWire playback process
func (c *RadioClient) SetupPipewire() error {
	cmd := exec.Command("pw-play",
		"--format=s16",
		fmt.Sprintf("--rate=%d", c.sampleRate),
		fmt.Sprintf("--channels=%d", c.channels),
		"-")

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("failed to create stdin pipe: %w", err)
	}

	cmd.Stdout = nil
	cmd.Stderr = nil

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start pw-play: %w", err)
	}

	c.pipewireCmd = cmd
	c.pipewireStdin = stdin
	fmt.Fprintf(os.Stderr, "PipeWire output started (sample rate: %d Hz, channels: %d)\n", c.sampleRate, c.channels)
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
	// Apply NR2 noise reduction if enabled
	if c.nr2Processor != nil && c.nr2Enabled {
		// Convert PCM bytes to float32 array
		numSamples := len(pcmData) / 2
		audioFloat := make([]float32, numSamples)

		for i := 0; i < numSamples; i++ {
			sample := int16(binary.LittleEndian.Uint16(pcmData[i*2:]))
			audioFloat[i] = float32(sample) / 32768.0
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
			binary.LittleEndian.PutUint16(pcmData[i*2:], uint16(int16(sample)))
		}
	}

	switch c.outputMode {
	case "stdout":
		// Write raw PCM to stdout
		_, err := os.Stdout.Write(pcmData)
		return err

	case "pipewire":
		// Write to PipeWire process
		if c.pipewireStdin != nil {
			_, err := c.pipewireStdin.Write(pcmData)
			if err != nil {
				fmt.Fprintf(os.Stderr, "PipeWire connection lost\n")
				c.running = false
				return err
			}
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

		// Update sample rate if changed
		if sampleRate != c.sampleRate {
			c.sampleRate = sampleRate
			fmt.Fprintf(os.Stderr, "Sample rate updated: %d Hz\n", c.sampleRate)
		}

		// Update channels if changed (requires restarting PipeWire)
		if channels != c.channels {
			c.channels = channels
			fmt.Fprintf(os.Stderr, "Channels updated: %d\n", c.channels)

			// Restart PipeWire with new channel count if active
			if c.outputMode == "pipewire" && c.pipewireStdin != nil {
				fmt.Fprintf(os.Stderr, "Restarting PipeWire with new channel configuration...\n")
				c.pipewireStdin.Close()
				if c.pipewireCmd != nil {
					c.pipewireCmd.Wait()
				}
				if err := c.SetupPipewire(); err != nil {
					fmt.Fprintf(os.Stderr, "Failed to restart PipeWire: %v\n", err)
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

	// Reset retry count on successful connection
	c.retryCount = 0

	// Setup output based on mode
	switch c.outputMode {
	case "pipewire":
		if err := c.SetupPipewire(); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			return 1
		}
	case "wav":
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

	// Close PipeWire process
	if c.pipewireStdin != nil {
		c.pipewireStdin.Close()
	}
	if c.pipewireCmd != nil {
		c.pipewireCmd.Wait()
	}
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
	binary.LittleEndian.PutUint16(header[22:24], 1)  // Mono
	binary.LittleEndian.PutUint32(header[24:28], uint32(w.sampleRate))
	binary.LittleEndian.PutUint32(header[28:32], uint32(w.sampleRate*2)) // Byte rate
	binary.LittleEndian.PutUint16(header[32:34], 2)                      // Block align
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

	w.file.Seek(40, 0)
	binary.Write(w.file, binary.LittleEndian, uint32(w.dataSize))

	return w.file.Close()
}

func main() {
	// Command-line flags
	urlFlag := flag.String("u", "", "Full WebSocket URL (e.g., ws://host:port/ws or wss://host/ws)")
	hostFlag := flag.String("H", "localhost", "Server hostname (default: localhost, ignored if --url is provided)")
	portFlag := flag.Int("p", 8080, "Server port (default: 8080, ignored if --url is provided)")
	frequencyFlag := flag.Int("f", 0, "Frequency in Hz (e.g., 14074000 for 14.074 MHz)")
	modeFlag := flag.String("m", "", "Demodulation mode (am, sam, usb, lsb, fm, nfm, cwu, cwl, iq)")
	bandwidthFlag := flag.String("b", "", "Bandwidth in format low:high (e.g., -5000:5000)")
	outputFlag := flag.String("o", "pipewire", "Output mode (pipewire, stdout, wav)")
	wavFileFlag := flag.String("w", "", "WAV file path (required when output=wav)")
	timeFlag := flag.Float64("t", 0, "Recording duration in seconds (for WAV output)")
	sslFlag := flag.Bool("s", false, "Use WSS (WebSocket Secure, ignored if --url is provided)")
	nr2Flag := flag.Bool("nr2", false, "Enable NR2 spectral subtraction noise reduction")
	nr2StrengthFlag := flag.Float64("nr2-strength", 40.0, "NR2 noise reduction strength, 0-100% (default: 40)")
	nr2FloorFlag := flag.Float64("nr2-floor", 10.0, "NR2 spectral floor to prevent musical noise, 0-10% (default: 10)")
	nr2AdaptRateFlag := flag.Float64("nr2-adapt-rate", 1.0, "NR2 noise profile adaptation rate, 0.1-5.0% (default: 1)")
	autoReconnectFlag := flag.Bool("auto-reconnect", false, "Automatically reconnect on connection loss with exponential backoff (max 60s)")

	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "CLI Radio Client for ka9q_ubersdr\n\n")
		fmt.Fprintf(os.Stderr, "Usage: %s [options]\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "Options:\n")
		flag.PrintDefaults()
		fmt.Fprintf(os.Stderr, "\nExamples:\n")
		fmt.Fprintf(os.Stderr, "  # Listen to 14.074 MHz USB via PipeWire\n")
		fmt.Fprintf(os.Stderr, "  %s -f 14074000 -m usb\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  # Connect using full URL\n")
		fmt.Fprintf(os.Stderr, "  %s -u ws://radio.example.com:8073/ws -f 14074000 -m usb\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  # Record 1000 kHz AM to WAV file for 60 seconds\n")
		fmt.Fprintf(os.Stderr, "  %s -f 1000000 -m am -o wav -w recording.wav -t 60\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  # Output raw PCM to stdout with custom bandwidth\n")
		fmt.Fprintf(os.Stderr, "  %s -f 7100000 -m lsb -b -2700:-50 -o stdout > audio.pcm\n", os.Args[0])
	}

	flag.Parse()

	// Validate required arguments
	if *frequencyFlag == 0 {
		fmt.Fprintf(os.Stderr, "Error: -f/--frequency is required\n")
		flag.Usage()
		os.Exit(1)
	}

	if *modeFlag == "" {
		fmt.Fprintf(os.Stderr, "Error: -m/--mode is required\n")
		flag.Usage()
		os.Exit(1)
	}

	// Validate mode
	validModes := map[string]bool{
		"am": true, "sam": true, "usb": true, "lsb": true,
		"fm": true, "nfm": true, "cwu": true, "cwl": true, "iq": true,
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
		duration, *sslFlag, *nr2Flag, *nr2StrengthFlag, *nr2FloorFlag, *nr2AdaptRateFlag,
		*autoReconnectFlag,
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

package main

import (
	"encoding/binary"
	"fmt"
	"log"
	"net/url"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// KiwiClient represents a connection to a KiwiSDR server
type KiwiClient struct {
	config      *Config
	conn        *websocket.Conn
	decoder     *IMAAdpcmDecoder
	sampleRate  float64
	numChannels int
	outputFile  *os.File
	wavWriter   *WAVWriter
	startTime   time.Time
	stopChan    chan struct{}
	mu          sync.Mutex
	running     bool
	kiwiVersion float64
}

// NewKiwiClient creates a new KiwiSDR client
func NewKiwiClient(config *Config) (*KiwiClient, error) {
	if config.Compression {
		return &KiwiClient{
			config:      config,
			decoder:     NewIMAAdpcmDecoder(),
			numChannels: 1,
			stopChan:    make(chan struct{}),
		}, nil
	}

	return &KiwiClient{
		config:      config,
		numChannels: 1,
		stopChan:    make(chan struct{}),
	}, nil
}

// Connect establishes a WebSocket connection to the KiwiSDR
func (c *KiwiClient) Connect() error {
	// Use nanoseconds to ensure unique timestamps for multiple simultaneous connections
	timestamp := time.Now().UnixNano() / 1000000 // Convert to milliseconds
	wsURL := url.URL{
		Scheme: "ws",
		Host:   fmt.Sprintf("%s:%d", c.config.ServerHost, c.config.ServerPort),
		Path:   fmt.Sprintf("/%d/SND", timestamp),
	}

	log.Printf("Connecting to %s", wsURL.String())

	var err error
	c.conn, _, err = websocket.DefaultDialer.Dial(wsURL.String(), nil)
	if err != nil {
		return fmt.Errorf("websocket dial failed: %w", err)
	}

	log.Println("WebSocket connection established")
	return nil
}

// sendMessage sends a message to the KiwiSDR server
func (c *KiwiClient) sendMessage(msg string) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.conn == nil {
		return fmt.Errorf("connection not established")
	}

	return c.conn.WriteMessage(websocket.TextMessage, []byte(msg))
}

// setupReceiver configures the receiver parameters
func (c *KiwiClient) setupReceiver() error {
	// Set authentication
	authMsg := fmt.Sprintf("SET auth t=kiwi p=%s", c.config.Password)
	if err := c.sendMessage(authMsg); err != nil {
		return err
	}

	// Set user name
	if err := c.sendMessage(fmt.Sprintf("SET ident_user=%s", c.config.User)); err != nil {
		return err
	}

	return nil
}

// setModulation sets the modulation and frequency
func (c *KiwiClient) setModulation() error {
	lowCut, highCut := c.config.GetPassband()

	// Update number of channels based on mode
	if c.config.IsStereo() {
		c.numChannels = 2
	}

	msg := fmt.Sprintf("SET mod=%s low_cut=%.0f high_cut=%.0f freq=%.3f",
		c.config.Modulation, lowCut, highCut, c.config.Frequency)

	return c.sendMessage(msg)
}

// setAGC sets the AGC parameters
func (c *KiwiClient) setAGC() error {
	if c.config.AGCGain >= 0 {
		// Fixed gain (AGC off)
		msg := fmt.Sprintf("SET agc=0 hang=0 thresh=-100 slope=6 decay=1000 manGain=%.0f", c.config.AGCGain)
		return c.sendMessage(msg)
	}

	// AGC on with defaults
	return c.sendMessage("SET agc=1 hang=0 thresh=-100 slope=6 decay=1000 manGain=50")
}

// setCompression sets audio compression mode
func (c *KiwiClient) setCompression() error {
	comp := 0
	if c.config.Compression {
		comp = 1
	}
	return c.sendMessage(fmt.Sprintf("SET compression=%d", comp))
}

// Run starts the recording session
func (c *KiwiClient) Run() error {
	c.mu.Lock()
	c.running = true
	c.startTime = time.Now()
	c.mu.Unlock()

	// Connect to server
	if err := c.Connect(); err != nil {
		return err
	}
	defer c.Close()

	// Send initial authentication immediately after connection
	log.Println("Sending initial authentication...")
	if err := c.setupReceiver(); err != nil {
		return fmt.Errorf("setup receiver failed: %w", err)
	}

	// Process messages
	go c.messageLoop()

	// Start keepalive sender
	go c.keepaliveLoop()

	// Wait for duration or stop signal
	if c.config.Duration > 0 {
		timer := time.NewTimer(c.config.Duration)
		select {
		case <-timer.C:
			log.Println("Recording duration reached")
		case <-c.stopChan:
			timer.Stop()
			log.Println("Recording stopped by user")
		}
	} else {
		<-c.stopChan
		log.Println("Recording stopped by user")
	}

	return nil
}

// keepaliveLoop sends periodic keepalive messages
func (c *KiwiClient) keepaliveLoop() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-c.stopChan:
			return
		case <-ticker.C:
			if err := c.sendMessage("SET keepalive"); err != nil {
				if !c.config.Quiet {
					log.Printf("Keepalive send error: %v", err)
				}
				return
			}
		}
	}
}

// messageLoop processes incoming WebSocket messages
func (c *KiwiClient) messageLoop() {
	defer func() {
		c.mu.Lock()
		c.running = false
		c.mu.Unlock()
	}()

	for {
		select {
		case <-c.stopChan:
			return
		default:
		}

		messageType, message, err := c.conn.ReadMessage()
		if err != nil {
			log.Printf("Read error: %v", err)
			return
		}

		if messageType == websocket.BinaryMessage {
			c.processBinaryMessage(message)
		} else if messageType == websocket.TextMessage {
			c.processTextMessage(string(message))
		}
	}
}

// processTextMessage handles text messages from the server
func (c *KiwiClient) processTextMessage(msg string) {
	if !c.config.Quiet {
		log.Printf("RX: %s", msg)
	}

	// Parse message and handle different types
	if len(msg) < 3 {
		return
	}

	// Handle MSG messages
	if len(msg) >= 4 && msg[:3] == "MSG" {
		c.handleMSG(msg[4:]) // Skip "MSG "
	}
}

// handleMSG processes MSG type messages
func (c *KiwiClient) handleMSG(body string) {
	// Parse key=value pairs separated by spaces
	pairs := splitKeyValue(body)

	for key, value := range pairs {
		switch key {
		case "sample_rate":
			fmt.Sscanf(value, "%f", &c.sampleRate)
			log.Printf("Sample rate: %.0f Hz", c.sampleRate)

			// Send AR OK to acknowledge sample rate
			if err := c.sendMessage(fmt.Sprintf("SET AR OK in=%d out=44100", int(c.sampleRate))); err != nil {
				log.Printf("AR OK error: %v", err)
			}

			// Now that we have sample rate, configure modulation and AGC
			go func() {
				time.Sleep(100 * time.Millisecond)
				if err := c.setModulation(); err != nil {
					log.Printf("Set modulation error: %v", err)
					return
				}
				if err := c.setAGC(); err != nil {
					log.Printf("Set AGC error: %v", err)
					return
				}
				if err := c.setCompression(); err != nil {
					log.Printf("Set compression error: %v", err)
					return
				}
				// Set squelch off
				if err := c.sendMessage("SET squelch=0 max=0"); err != nil {
					log.Printf("Squelch error: %v", err)
				}
				// Set gen off
				if err := c.sendMessage("SET genattn=0"); err != nil {
					log.Printf("Gen attn error: %v", err)
				}
				if err := c.sendMessage("SET gen=0 mix=-1"); err != nil {
					log.Printf("Gen error: %v", err)
				}
				if err := c.sendMessage("SET keepalive"); err != nil {
					if !c.config.Quiet {
						log.Printf("Keepalive error: %v", err)
					}
				}
			}()
		case "audio_rate":
			// Handle audio rate
		case "version_maj":
			// Handle version
		}
	}
}

// splitKeyValue splits a string of key=value pairs
func splitKeyValue(s string) map[string]string {
	result := make(map[string]string)
	parts := splitPreservingQuotes(s, ' ')

	for _, part := range parts {
		if idx := findUnquoted(part, '='); idx != -1 {
			key := part[:idx]
			value := part[idx+1:]
			result[key] = value
		}
	}

	return result
}

// splitPreservingQuotes splits a string by delimiter but preserves quoted sections
func splitPreservingQuotes(s string, delim rune) []string {
	var result []string
	var current []rune
	inQuotes := false

	for _, ch := range s {
		if ch == '"' {
			inQuotes = !inQuotes
		} else if ch == delim && !inQuotes {
			if len(current) > 0 {
				result = append(result, string(current))
				current = nil
			}
		} else {
			current = append(current, ch)
		}
	}

	if len(current) > 0 {
		result = append(result, string(current))
	}

	return result
}

// findUnquoted finds the first occurrence of a character outside quotes
func findUnquoted(s string, target rune) int {
	inQuotes := false
	for i, ch := range s {
		if ch == '"' {
			inQuotes = !inQuotes
		} else if ch == target && !inQuotes {
			return i
		}
	}
	return -1
}

// processBinaryMessage handles binary audio data
func (c *KiwiClient) processBinaryMessage(data []byte) {
	if len(data) < 3 {
		return
	}

	tag := string(data[0:3])
	body := data[3:]

	switch tag {
	case "SND":
		c.processAudioData(body)
	case "W/F":
		// Waterfall data - ignore for now
	case "MSG":
		// MSG can come as binary too, process as text
		c.handleMSG(string(body[1:])) // Skip first byte
	default:
		// Log first occurrence of unknown tags
		log.Printf("Unknown binary tag: %s (len=%d)", tag, len(data))
	}
}

// processAudioData processes audio sample data
func (c *KiwiClient) processAudioData(data []byte) {
	if len(data) < 7 {
		return
	}

	// Parse SND packet header
	flags := data[0]
	_ = binary.LittleEndian.Uint32(data[1:5]) // seq - not used
	_ = binary.BigEndian.Uint16(data[5:7])    // smeter - not used
	audioData := data[7:]

	// Decode audio based on compression flag
	var samples []int16

	compressed := (flags & 0x10) != 0

	if compressed && c.decoder != nil {
		samples = c.decoder.Decode(audioData)
	} else {
		// Uncompressed 16-bit samples (big-endian)
		samples = make([]int16, len(audioData)/2)
		for i := 0; i < len(samples); i++ {
			samples[i] = int16(binary.BigEndian.Uint16(audioData[i*2:]))
		}
	}

	// Write samples to WAV file
	c.writeSamples(samples)
}

// writeSamples writes audio samples to the output file
func (c *KiwiClient) writeSamples(samples []int16) {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Create output file if needed
	if c.wavWriter == nil {
		filename := c.getOutputFilename()
		var err error
		c.outputFile, err = os.Create(filename)
		if err != nil {
			log.Printf("Failed to create output file: %v", err)
			return
		}

		c.wavWriter = NewWAVWriter(c.outputFile, int(c.sampleRate), c.numChannels)
		if err := c.wavWriter.WriteHeader(); err != nil {
			log.Printf("Failed to write WAV header: %v", err)
			return
		}

		log.Printf("Started recording to: %s", filename)
	}

	// Write samples
	if err := c.wavWriter.WriteSamples(samples); err != nil {
		log.Printf("Failed to write samples: %v", err)
	}
}

// getOutputFilename generates the output filename
func (c *KiwiClient) getOutputFilename() string {
	if c.config.Filename != "" {
		return fmt.Sprintf("%s/%s", c.config.OutputDir, c.config.Filename)
	}

	timestamp := c.startTime.UTC().Format("20060102T150405Z")
	filename := fmt.Sprintf("%s_%d_%s.wav",
		timestamp,
		int(c.config.Frequency*1000),
		c.config.Modulation)

	return fmt.Sprintf("%s/%s", c.config.OutputDir, filename)
}

// Close closes the connection and output file
func (c *KiwiClient) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Signal stop
	select {
	case <-c.stopChan:
	default:
		close(c.stopChan)
	}

	// Close WAV file
	if c.wavWriter != nil {
		c.wavWriter.Close()
		c.wavWriter = nil
	}

	if c.outputFile != nil {
		c.outputFile.Close()
		c.outputFile = nil
	}

	// Close WebSocket
	if c.conn != nil {
		c.conn.Close()
		c.conn = nil
	}

	log.Println("Connection closed")
}

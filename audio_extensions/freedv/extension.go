package freedv

import (
	"fmt"
	"log"
	"strings"
	"sync"
)

/*
 * FreeDV Extension Wrapper
 * Integrates freedv-ka9q subprocess with UberSDR audio extension framework
 *
 * The binary at /opt/freedv/freedv-ka9q reads raw int16 PCM from stdin and
 * writes decoded int16 PCM to stdout only when a valid RADE signal is present.
 */

const binaryPath = "/opt/freedv/freedv-ka9q"

// maxFreqHz is the upper bound for a valid HF frequency (30 MHz)
const maxFreqHz = 30_000_000

// outputSampleRate is the fixed output sample rate for decoded audio
const outputSampleRate = 12000

// reportingMessage is the fixed message sent to FreeDV Reporter
const reportingMessage = "UberSDR Decoder"

// GlobalConfigProvider holds instance-level configuration set by the main package.
// Callsign and locator come from the UberSDR instance config, not from the frontend.
type GlobalConfigProvider struct {
	Callsign string // Station callsign (config.Admin.Callsign)
	Locator  string // Maidenhead grid square (derived from config.Admin.GPS lat/lon)
	MaxUsers int    // Maximum concurrent users (0 = unlimited, default: 10)
}

// GlobalConfig is set by main package before the extension is registered
var GlobalConfig *GlobalConfigProvider

// activeUserCount tracks the number of concurrent FreeDV users
var activeUserCount int
var activeUserMutex sync.Mutex

// AudioExtensionParams contains audio stream parameters
type AudioExtensionParams struct {
	SampleRate    int
	Channels      int
	BitsPerSample int
}

// AudioSample contains PCM audio data with timing information
type AudioSample struct {
	PCMData      []int16 // PCM audio samples (mono, int16)
	RTPTimestamp uint32  // RTP timestamp from radiod (for jitter/loss detection)
	GPSTimeNs    int64   // GPS-synchronized Unix time in nanoseconds (packet arrival time)
}

// AudioExtension interface for extensible audio processors
type AudioExtension interface {
	Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error
	Stop() error
	GetName() string
}

// FreeDVExtension wraps the freedv-ka9q subprocess as an AudioExtension
type FreeDVExtension struct {
	decoder *FreeDVDecoder
	config  FreeDVConfig
}

// FreeDVConfig holds configuration for the FreeDV extension
type FreeDVConfig struct {
	InputSampleRate  int    // Sample rate fed to the binary (matches audioParams.SampleRate)
	OutputSampleRate int    // Sample rate the binary outputs decoded audio at
	Callsign         string // FreeDV Reporter callsign (from instance config)
	Locator          string // FreeDV Reporter Maidenhead grid square (from instance config)
	FreqHz           int64  // FreeDV Reporter frequency in Hz (from frontend, 0 = disabled)
	Message          string // Optional FreeDV Reporter user message (from frontend)
}

// NewFreeDVExtension creates a new FreeDV audio extension
func NewFreeDVExtension(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (*FreeDVExtension, error) {
	// Check max users limit
	if GlobalConfig != nil && GlobalConfig.MaxUsers > 0 {
		activeUserMutex.Lock()
		if activeUserCount >= GlobalConfig.MaxUsers {
			activeUserMutex.Unlock()
			return nil, fmt.Errorf("maximum FreeDV users reached (%d/%d)", activeUserCount, GlobalConfig.MaxUsers)
		}
		activeUserCount++
		currentCount := activeUserCount
		activeUserMutex.Unlock()
		log.Printf("[FreeDV Extension] User connected (%d/%d)", currentCount, GlobalConfig.MaxUsers)
	}

	// Validate audio parameters
	if audioParams.Channels != 1 {
		return nil, fmt.Errorf("FreeDV requires mono audio (got %d channels)", audioParams.Channels)
	}
	if audioParams.BitsPerSample != 16 {
		return nil, fmt.Errorf("FreeDV requires 16-bit audio (got %d bits)", audioParams.BitsPerSample)
	}

	// FreeDV RADE only makes sense on SSB modes (USB or LSB).
	// Reject any other mode immediately so the user gets a clear error.
	// Normalise to uppercase so "usb"/"lsb" (from the session) and "USB"/"LSB" both match.
	tunedMode := strings.ToUpper(extensionParams["tuned_mode"].(string))
	switch tunedMode {
	case "USB", "LSB":
		// valid
	default:
		rawMode, _ := extensionParams["tuned_mode"].(string)
		return nil, fmt.Errorf("FreeDV requires USB or LSB mode (current mode: %q)", rawMode)
	}

	config := FreeDVConfig{
		InputSampleRate:  audioParams.SampleRate,
		OutputSampleRate: outputSampleRate, // fixed — not user-configurable
	}

	// Callsign and locator come from the UberSDR instance configuration, not the frontend
	if GlobalConfig != nil {
		config.Callsign = GlobalConfig.Callsign
		config.Locator = GlobalConfig.Locator
	}

	// tuned_frequency_hz is injected automatically by the audio extension manager
	// from the session's current tuned frequency. It is a uint64 in the session,
	// but arrives here as uint64 via extensionParams.
	// 0 means no session frequency is known → FreeDV Reporter disabled.
	if freq, ok := extensionParams["tuned_frequency_hz"].(uint64); ok {
		if freq > maxFreqHz {
			log.Printf("[FreeDV Extension] tuned_frequency_hz %d Hz exceeds HF range (%d Hz) — FreeDV Reporter disabled", freq, maxFreqHz)
		} else {
			config.FreqHz = int64(freq)
		}
	}

	// Reporting message is always hardcoded
	config.Message = reportingMessage

	decoder, err := NewFreeDVDecoder(config)
	if err != nil {
		return nil, fmt.Errorf("failed to create FreeDV decoder: %w", err)
	}

	log.Printf("[FreeDV Extension] Created: input=%d Hz, output=%d Hz, binary=%s",
		config.InputSampleRate, config.OutputSampleRate, binaryPath)

	if config.Callsign != "" && config.Locator != "" && config.FreqHz > 0 {
		log.Printf("[FreeDV Extension] FreeDV Reporter enabled: callsign=%s, locator=%s, freq=%d Hz",
			config.Callsign, config.Locator, config.FreqHz)
	} else {
		log.Printf("[FreeDV Extension] FreeDV Reporter disabled (callsign=%q, locator=%q, freq_hz=%d)",
			config.Callsign, config.Locator, config.FreqHz)
	}

	return &FreeDVExtension{
		decoder: decoder,
		config:  config,
	}, nil
}

// Start begins processing audio
func (e *FreeDVExtension) Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error {
	return e.decoder.Start(audioChan, resultChan)
}

// Stop stops the extension and kills the subprocess
func (e *FreeDVExtension) Stop() error {
	// Decrement active user count
	if GlobalConfig != nil && GlobalConfig.MaxUsers > 0 {
		activeUserMutex.Lock()
		if activeUserCount > 0 {
			activeUserCount--
		}
		currentCount := activeUserCount
		activeUserMutex.Unlock()
		log.Printf("[FreeDV Extension] User disconnected (%d/%d)", currentCount, GlobalConfig.MaxUsers)
	}

	return e.decoder.Stop()
}

// GetName returns the extension name
func (e *FreeDVExtension) GetName() string {
	return "freedv"
}

// CrashChan returns a channel that receives an error if the subprocess crashes
// while the decoder is still supposed to be running.
func (e *FreeDVExtension) CrashChan() <-chan error {
	return e.decoder.CrashChan()
}

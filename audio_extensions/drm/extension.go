package drm

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sync"
)

/*
 * DRM Extension Wrapper
 * Integrates ubersdr-drm subprocess with UberSDR audio extension framework.
 *
 * The binary at /opt/ubersdr-drm/ubersdr-drm reads stereo int16 IQ from stdin
 * (little-endian, I=even index, Q=odd index) and writes mono int16 PCM to stdout
 * (little-endian, 12 kHz) when a DRM signal is being decoded.
 *
 * Accepted IQ modes: any session where Channels==2 and SampleRate>=12000.
 * This includes iq (12 kHz), iq48 (48 kHz), iq96, iq192, etc.
 * Dream scales all OFDM parameters via ADJ_FOR_SRATE(v, sr) = v*sr/48000, and
 * the binary bypasses Dream's internal sample rate clamping via
 * SetSoundCardSigSampleRate(), so all rates are passed through. Below 24 kHz
 * the binary interpolates the IQ up to at least that rate first: Dream mixes
 * baseband IQ to a 6 kHz virtual IF before Hilbert filtering, which would
 * otherwise land the carrier at Nyquist and never acquire.
 */

const binaryDir = "/opt/ubersdr-drm"

// binaryPath is the decoder binary this build should spawn. The C++ build
// names its output after the target architecture using Go's own GOARCH
// spellings (ubersdr-drm_amd64, ubersdr-drm_arm64, ...) so several
// architectures can share /opt/ubersdr-drm/. Fall back to the unsuffixed name
// so an install predating that change keeps working.
var binaryPath = resolveBinaryPath()

func resolveBinaryPath() string {
	arch := filepath.Join(binaryDir, "ubersdr-drm_"+runtime.GOARCH)
	if _, err := os.Stat(arch); err == nil {
		return arch
	}
	return filepath.Join(binaryDir, "ubersdr-drm")
}

// outputSampleRate is the fixed output sample rate for decoded DRM audio.
// DRM standard audio is 12 kHz mono.
const outputSampleRate = 12000

// minInputSampleRate is the minimum IQ sample rate accepted.
// 12 kHz gives ±6 kHz bandwidth — sufficient for DRM Mode A (10 kHz wide).
// Dream scales all OFDM parameters via ADJ_FOR_SRATE so 12 kHz works correctly.
const minInputSampleRate = 12000

// AudioExtensionParams contains audio stream parameters.
// Duplicated from the main package (same pattern as freedv package).
type AudioExtensionParams struct {
	SampleRate    int
	Channels      int
	BitsPerSample int
}

// AudioSample contains PCM audio data with timing information.
// Duplicated from the main package (same pattern as freedv package).
type AudioSample struct {
	PCMData      []int16 // PCM audio samples (stereo IQ for DRM)
	RTPTimestamp uint32  // RTP timestamp from radiod
	GPSTimeNs    int64   // GPS-synchronized Unix time in nanoseconds
}

// AudioExtension interface for extensible audio processors.
// Duplicated from the main package (same pattern as freedv package).
type AudioExtension interface {
	Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error
	Stop() error
	GetName() string
}

// GlobalConfigProvider carries the instance settings the extension needs.
// Set by the main package before the extension is registered.
type GlobalConfigProvider struct {
	MaxUsers int // Maximum concurrent users (0 = unlimited)
}

// GlobalConfig is set by the main package before registration; nil means no
// limit is enforced.
var GlobalConfig *GlobalConfigProvider

// activeUserCount tracks concurrent DRM users. Each one holds a Dream OFDM
// decoder doing a full demodulation plus an AAC decode and an Opus encode, so
// this is a good deal more expensive per user than most extensions.
var (
	activeUserCount int
	activeUserMutex sync.Mutex
)

// DRMExtension wraps the ubersdr-drm subprocess as an AudioExtension.
type DRMExtension struct {
	decoder *DRMDecoder
	config  DRMConfig

	// held is true when this instance is counted in activeUserCount, so Stop
	// releases the slot exactly once however many times it is called.
	held     bool
	stopOnce sync.Once
}

// DRMConfig holds configuration for the DRM extension.
type DRMConfig struct {
	InputSampleRate  int // IQ sample rate fed to the binary (from audioParams.SampleRate)
	OutputSampleRate int // Sample rate the binary outputs decoded audio at (always 12000)
}

// NewDRMExtension creates a new DRM audio extension.
func NewDRMExtension(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (*DRMExtension, error) {
	// Validate: must be stereo IQ (Channels == 2)
	if audioParams.Channels != 2 {
		return nil, fmt.Errorf("DRM requires stereo IQ input (got %d channels) — use an iq/iq48/iq96 mode", audioParams.Channels)
	}

	// Validate: minimum sample rate for DRM.
	if audioParams.SampleRate < minInputSampleRate {
		return nil, fmt.Errorf("DRM requires IQ sample rate >= %d Hz (got %d Hz)", minInputSampleRate, audioParams.SampleRate)
	}

	// Validate: 16-bit samples
	if audioParams.BitsPerSample != 16 {
		return nil, fmt.Errorf("DRM requires 16-bit audio (got %d bits)", audioParams.BitsPerSample)
	}

	// Take a slot before anything expensive is created, and give it back if
	// the decoder cannot be built — otherwise a run of failures would exhaust
	// the limit with nothing actually running.
	held := false
	if GlobalConfig != nil && GlobalConfig.MaxUsers > 0 {
		activeUserMutex.Lock()
		if activeUserCount >= GlobalConfig.MaxUsers {
			count := activeUserCount
			activeUserMutex.Unlock()
			return nil, fmt.Errorf("maximum DRM users reached (%d/%d)", count, GlobalConfig.MaxUsers)
		}
		activeUserCount++
		count := activeUserCount
		held = true
		activeUserMutex.Unlock()
		log.Printf("[DRM Extension] User connected (%d/%d)", count, GlobalConfig.MaxUsers)
	}

	release := func() {
		if !held {
			return
		}
		activeUserMutex.Lock()
		if activeUserCount > 0 {
			activeUserCount--
		}
		activeUserMutex.Unlock()
	}

	config := DRMConfig{
		InputSampleRate:  audioParams.SampleRate,
		OutputSampleRate: outputSampleRate,
	}

	decoder, err := NewDRMDecoder(config)
	if err != nil {
		release()
		return nil, fmt.Errorf("failed to create DRM decoder: %w", err)
	}

	log.Printf("[DRM Extension] Created: input=%d Hz, output=%d Hz, binary=%s",
		config.InputSampleRate, config.OutputSampleRate, binaryPath)

	return &DRMExtension{
		decoder: decoder,
		config:  config,
		held:    held,
	}, nil
}

// Start begins processing audio.
func (e *DRMExtension) Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error {
	return e.decoder.Start(audioChan, resultChan)
}

// Stop stops the extension and kills the subprocess.
func (e *DRMExtension) Stop() error {
	// Once only: the manager may call Stop on teardown and again on a crash,
	// and double-releasing would let the limit drift upwards over a long run.
	e.stopOnce.Do(func() {
		if !e.held {
			return
		}
		activeUserMutex.Lock()
		if activeUserCount > 0 {
			activeUserCount--
		}
		count := activeUserCount
		activeUserMutex.Unlock()
		if GlobalConfig != nil {
			log.Printf("[DRM Extension] User disconnected (%d/%d)", count, GlobalConfig.MaxUsers)
		}
	})
	return e.decoder.Stop()
}

// GetName returns the extension name.
func (e *DRMExtension) GetName() string {
	return "drm"
}

// CrashChan returns a channel that receives an error if the subprocess crashes
// while the decoder is still supposed to be running.
func (e *DRMExtension) CrashChan() <-chan error {
	return e.decoder.CrashChan()
}

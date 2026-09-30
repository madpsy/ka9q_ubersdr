package hdradio

/*
 * HD Radio (NRSC-5) AM decoder extension.
 *
 * Spawns /opt/ubersdr-hdradio/ubersdr-hdradio_<goarch>
 * (https://github.com/madpsy/ubersdr-hdradio). The binary reads stereo int16
 * little-endian IQ on stdin, centred on the station's carrier, and writes:
 *
 *   stdout  the selected program's audio, stereo int16 LE at 48 kHz, only
 *           while it is decoding
 *   fd 3    JSON Lines status: station, programs, now playing, alerts, ...
 *   fd 5    images: album art, station logos, HERE traffic/weather maps
 *
 * and reads commands on fd 4: "program N" and "reset". See its README.md.
 *
 * The extension is registered with a private iq48 channel (see
 * private_iq_channel.go in the main package), so the IQ comes from a radiod
 * channel of its own on the listener's frequency, and Retune is called when
 * that channel has followed the listener somewhere new.
 */

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sync"
)

const binaryDir = "/opt/ubersdr-hdradio"

// binaryPath is the decoder binary this build spawns: named with Go's GOARCH
// spelling (ubersdr-hdradio_amd64, ...), as the Dockerfile installs it, with
// the unsuffixed name as a fallback for a hand install. A variable so tests
// can point it at a stand-in.
var binaryPath = resolveBinaryPath()

func resolveBinaryPath() string {
	arch := filepath.Join(binaryDir, "ubersdr-hdradio_"+runtime.GOARCH)
	if _, err := os.Stat(arch); err == nil {
		return arch
	}
	return filepath.Join(binaryDir, "ubersdr-hdradio")
}

// minInputSampleRate is the lowest IQ rate worth decoding from: 12 kHz covers
// an all-digital (MA3) station. A hybrid one needs 48 kHz, which is what the
// private channel provides.
const minInputSampleRate = 12000

// maxProgram is the highest program number, HD8.
const maxProgram = 7

// AudioExtensionParams contains audio stream parameters.
// Duplicated from the main package (same pattern as the other extensions).
type AudioExtensionParams struct {
	SampleRate    int
	Channels      int
	BitsPerSample int
}

// AudioSample contains PCM audio data with timing information.
// Duplicated from the main package (same pattern as the other extensions).
type AudioSample struct {
	PCMData      []int16 // stereo IQ, interleaved
	RTPTimestamp uint32
	GPSTimeNs    int64
}

// AudioExtension interface for extensible audio processors.
// Duplicated from the main package (same pattern as the other extensions).
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

var (
	activeUserCount int
	activeUserMutex sync.Mutex
)

// HDRadioExtension wraps the ubersdr-hdradio subprocess as an AudioExtension.
type HDRadioExtension struct {
	decoder *Decoder

	// held is true when this instance is counted in activeUserCount, so Stop
	// releases the slot exactly once however many times it is called.
	held     bool
	stopOnce sync.Once
}

// NewHDRadioExtension creates the extension for an IQ stream of the given
// parameters. extensionParams may carry "program" (0 = HD1 .. 7 = HD8).
func NewHDRadioExtension(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (*HDRadioExtension, error) {
	if audioParams.Channels != 2 {
		return nil, fmt.Errorf("HD Radio needs IQ (got %d channels)", audioParams.Channels)
	}
	if audioParams.SampleRate < minInputSampleRate {
		return nil, fmt.Errorf("HD Radio needs IQ at %d Hz or more (got %d Hz)", minInputSampleRate, audioParams.SampleRate)
	}
	if audioParams.BitsPerSample != 16 {
		return nil, fmt.Errorf("HD Radio needs 16-bit samples (got %d bits)", audioParams.BitsPerSample)
	}
	if _, err := os.Stat(binaryPath); err != nil {
		return nil, fmt.Errorf("the HD Radio decoder is not installed at %s — "+
			"it comes from https://github.com/madpsy/ubersdr-hdradio", binaryPath)
	}

	program := 0
	if v, ok := extensionParams["program"]; ok {
		p, ok := toInt(v)
		if !ok || p < 0 || p > maxProgram {
			return nil, fmt.Errorf("program must be 0 (HD1) to %d (HD%d)", maxProgram, maxProgram+1)
		}
		program = p
	}

	// Take a slot before anything expensive is created, and give it back if
	// the decoder cannot be built.
	held := false
	if GlobalConfig != nil && GlobalConfig.MaxUsers > 0 {
		activeUserMutex.Lock()
		if activeUserCount >= GlobalConfig.MaxUsers {
			count := activeUserCount
			activeUserMutex.Unlock()
			return nil, fmt.Errorf("maximum HD Radio users reached (%d/%d)", count, GlobalConfig.MaxUsers)
		}
		activeUserCount++
		held = true
		activeUserMutex.Unlock()
	}

	decoder, err := NewDecoder(audioParams.SampleRate, program)
	if err != nil {
		if held {
			releaseSlot()
		}
		return nil, fmt.Errorf("failed to create HD Radio decoder: %w", err)
	}

	log.Printf("[HD Radio] Created: input %d Hz, program HD%d, binary %s", audioParams.SampleRate, program+1, binaryPath)
	return &HDRadioExtension{decoder: decoder, held: held}, nil
}

func releaseSlot() {
	activeUserMutex.Lock()
	if activeUserCount > 0 {
		activeUserCount--
	}
	activeUserMutex.Unlock()
}

// toInt accepts the number types a JSON-decoded map can hold.
func toInt(v interface{}) (int, bool) {
	switch n := v.(type) {
	case float64:
		if n != float64(int(n)) {
			return 0, false
		}
		return int(n), true
	case int:
		return n, true
	case int64:
		return int(n), true
	}
	return 0, false
}

// Start begins decoding.
func (e *HDRadioExtension) Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error {
	return e.decoder.Start(audioChan, resultChan)
}

// Stop stops the subprocess and releases the user slot. Idempotent.
func (e *HDRadioExtension) Stop() error {
	e.stopOnce.Do(func() {
		if e.held {
			releaseSlot()
		}
	})
	return e.decoder.Stop()
}

// GetName returns the extension name.
func (e *HDRadioExtension) GetName() string {
	return "hdradio"
}

// CrashChan reports the subprocess exiting while it should be running.
func (e *HDRadioExtension) CrashChan() <-chan error {
	return e.decoder.CrashChan()
}

// SetProgram switches to program (0 = HD1 .. 7 = HD8) without restarting.
func (e *HDRadioExtension) SetProgram(program int) error {
	if program < 0 || program > maxProgram {
		return fmt.Errorf("program must be 0 (HD1) to %d (HD%d)", maxProgram, maxProgram+1)
	}
	return e.decoder.SetProgram(program)
}

// Retune is called once the private channel has settled on a new frequency:
// the decoder forgets the old station and acquires afresh.
func (e *HDRadioExtension) Retune(frequencyHz uint64) {
	e.decoder.Reset()
}

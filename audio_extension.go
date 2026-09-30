package main

import (
	"fmt"
	"sync"
	"time"
)

// AudioExtensionParams contains audio stream parameters (from session, not user-configurable)
type AudioExtensionParams struct {
	SampleRate    int // Hz (e.g., 48000)
	Channels      int // 1 = mono (SSB/AM/FM), 2 = stereo IQ (iq48/iq96/iq192/iq384 modes)
	BitsPerSample int // Always 16
}

// AudioSample contains PCM audio data with timing information
type AudioSample struct {
	PCMData      []int16 // PCM audio samples (int16); stereo IQ = interleaved [I0,Q0,I1,Q1,...]
	RTPTimestamp uint32  // RTP timestamp from radiod (for jitter/loss detection)
	GPSTimeNs    int64   // Unix ns at which the first sample was captured, or 0 if unknown; see capture_time.go
}

// AudioExtension interface for extensible audio processors
// These receive the same PCM audio stream as the user hears
type AudioExtension interface {
	// Start begins processing audio and sending results
	// audioChan: receives PCM audio samples with timestamps
	// resultChan: sends binary results back to user
	Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error

	// Stop stops the extension
	Stop() error

	// GetName returns the extension name
	GetName() string
}

// CrashReporter is an optional interface that extensions can implement to signal
// unexpected subprocess or goroutine crashes back to the manager.
// Extensions that cannot crash (pure Go, no subprocess) do not need to implement this.
type CrashReporter interface {
	// CrashChan returns a channel that receives an error when the underlying
	// process exits unexpectedly while the extension is still running.
	// The channel must be buffered (capacity ≥ 1) and receive at most one value.
	CrashChan() <-chan error
}

// AudioExtensionRetuner is an optional interface for extensions with a private
// channel (AudioExtensionInfo.PrivateIQ). Retune is called each time that
// channel has followed the listener to a new frequency and settled there, so
// an extension holding state about the old one — a decoder locked to a
// station — can drop it. Audio from the new frequency follows the call.
//
// It is called on the channel's own goroutine and must not block for long. It
// can race with Stop, so it must be safe to call on a stopped extension (a
// write to a closed pipe that fails and is ignored, say), and it must never
// call back into the manager to detach.
type AudioExtensionRetuner interface {
	Retune(frequencyHz uint64)
}

// AudioExtensionFactory is a function that creates a new extension instance
type AudioExtensionFactory func(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error)

// AudioExtensionInfo contains metadata about a registered extension
type AudioExtensionInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Version     string `json:"version"`

	// PrivateIQ, when set, is an IQ mode ("iq", "iq48", "iq96", ...) the
	// extension is given a radiod channel of its own in, on the listener's
	// frequency and following their retunes, instead of the listener's audio.
	// The listener is not sent that IQ and needs no permission for the mode.
	// Empty means the usual tap on the listener's own audio. See
	// private_iq_channel.go.
	PrivateIQ string `json:"private_iq,omitempty"`

	// DisplayName is how errors about the extension name it to a listener,
	// e.g. "HD Radio". Name is used when it is empty.
	DisplayName string `json:"display_name,omitempty"`

	// RestartCooldown, when set, is the least time between a listener
	// stopping the extension and starting it again. Enforced by the manager
	// before anything is created -- a private channel included -- and started
	// only by stops the listener made (detach, re-attach, closing the socket),
	// never by ones the server made: after an audio reconnect the client
	// re-attaches within 1.5 s and must not be refused. FreeDV and Sound
	// Modem enforce the same inside their own constructors.
	RestartCooldown time.Duration `json:"-"`
}

// AudioExtensionRegistry manages available audio extension types
type AudioExtensionRegistry struct {
	factories map[string]AudioExtensionFactory
	info      map[string]AudioExtensionInfo
	mu        sync.RWMutex
}

// NewAudioExtensionRegistry creates a new audio extension registry
func NewAudioExtensionRegistry() *AudioExtensionRegistry {
	return &AudioExtensionRegistry{
		factories: make(map[string]AudioExtensionFactory),
		info:      make(map[string]AudioExtensionInfo),
	}
}

// Register registers a new audio extension type
func (aer *AudioExtensionRegistry) Register(name string, factory AudioExtensionFactory, info AudioExtensionInfo) {
	aer.mu.Lock()
	defer aer.mu.Unlock()

	aer.factories[name] = factory
	aer.info[name] = info
}

// Create creates a new audio extension instance
func (aer *AudioExtensionRegistry) Create(name string, audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error) {
	aer.mu.RLock()
	factory, exists := aer.factories[name]
	aer.mu.RUnlock()

	if !exists {
		return nil, fmt.Errorf("audio extension not found: %s", name)
	}

	return factory(audioParams, extensionParams)
}

// Info returns the metadata an extension was registered with.
func (aer *AudioExtensionRegistry) Info(name string) (AudioExtensionInfo, bool) {
	aer.mu.RLock()
	defer aer.mu.RUnlock()
	info, ok := aer.info[name]
	return info, ok
}

// List returns information about all registered audio extensions
func (aer *AudioExtensionRegistry) List() []AudioExtensionInfo {
	aer.mu.RLock()
	defer aer.mu.RUnlock()

	list := make([]AudioExtensionInfo, 0, len(aer.info))
	for _, info := range aer.info {
		list = append(list, info)
	}

	return list
}

// Exists checks if an audio extension is registered
func (aer *AudioExtensionRegistry) Exists(name string) bool {
	aer.mu.RLock()
	defer aer.mu.RUnlock()

	_, exists := aer.factories[name]
	return exists
}

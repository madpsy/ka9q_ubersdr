package soundmodem

/*
 * Sound Modem Extension
 * Integrates QtSoundModem (nogui mode) with the UberSDR audio extension framework.
 *
 * QtSoundModem reads raw mono int16 LE PCM from stdin and decodes AX.25 packet
 * frames, making them available via a KISS TNC TCP server and an AGW PE TCP server.
 *
 * Each user session gets its own QtSoundModem subprocess with:
 *   - A unique working directory in /dev/shm (RAM-backed, no disk I/O)
 *   - A unique KISS TCP port (for reading decoded AX.25 frames)
 *   - A unique AGW TCP port (connected for DCD state and monitor text)
 *
 * Wire protocol (backend → frontend):
 *   0x20  AX.25 packet frame (decoded by QtSoundModem via KISS)
 *         [type:1=0x20][kiss_port:1][frame_len:4 uint32 BE][ax25_frame: N bytes]
 *
 *   0x21  Error event (e.g. binary not found, subprocess crash)
 *         [type:1=0x21][msg_len:4 uint32 BE][msg: UTF-8]
 *
 *   0x22  Raw KISS frame (output_mode="kiss")
 *         [type:1=0x22][frame_len:4 uint32 BE][kiss_frame: N bytes]
 *
 *   0x23  DCD state change (from AGW PE 'd' frame)
 *         [type:1=0x23][channel:1][dcd_on:1]
 *
 *   0x24  Monitor text (from AGW PE 'U'/'I'/'S'/'T' frames)
 *         [type:1=0x24][channel:1][is_tx:1][text_len:4 uint32 BE][text: UTF-8]
 *
 * Frontend params (passed in audio_extension_attach → params):
 *   channels: array of up to 4 channel config objects:
 *     { enabled: bool, modem: int, freq: float, rcvr_pairs: int, fx25: int, il2p: int }
 *   dcd_threshold: int (1–100, default 20)
 */

import (
	"fmt"
	"log"
	"sync"
	"time"
)

const (
	binaryPath = "/usr/local/bin/QtSoundModem"

	// portRangeBase is the first port in the KISS/AGW port pool.
	// Ports are allocated in pairs: KISS=base+2*n, AGW=base+2*n+1
	// e.g. instance 0: KISS=18100, AGW=18101
	//      instance 1: KISS=18102, AGW=18103
	portRangeBase = 18100

	// portRangeSize is the number of port pairs available (max concurrent users).
	portRangeSize = 50

	// restartCooldown is the minimum time between Stop() and the next Start()
	// for the same session, to prevent rapid restart loops.
	restartCooldown = 3 * time.Second

	// stopTimeout is how long Stop() waits for the subprocess to exit cleanly.
	stopTimeout = 3 * time.Second
)

// Message type bytes for the binary wire protocol
const (
	MsgPacket    = 0x20 // AX.25 packet frame (KISS headers stripped, output_mode="ax25")
	MsgError     = 0x21 // Error message
	MsgKISSFrame = 0x22 // Raw KISS frame with 0xC0 delimiters (output_mode="kiss")
	MsgDCD       = 0x23 // DCD activity pulse: [type:1][channel:1][dcd_on:1]
	MsgMonitor   = 0x24 // Monitor text: [type:1][channel:1][is_tx:1][text_len:4 BE][text: UTF-8]
	MsgLog       = 0x25 // Process log line (stderr from QtSoundModem): [type:1][line_len:4 BE][line: UTF-8]
)

// --- Global port pool ---

var (
	portMu    sync.Mutex
	usedSlots = make(map[int]bool) // slot index → in use
)

// acquirePortSlot finds a free slot and marks it used.
// Returns (kissPort, agwPort, slotIndex, error).
func acquirePortSlot() (int, int, int, error) {
	portMu.Lock()
	defer portMu.Unlock()
	for i := 0; i < portRangeSize; i++ {
		if !usedSlots[i] {
			usedSlots[i] = true
			kiss := portRangeBase + i*2
			agw := portRangeBase + i*2 + 1
			return kiss, agw, i, nil
		}
	}
	return 0, 0, 0, fmt.Errorf("no free Sound Modem port slots available (max %d concurrent users)", portRangeSize)
}

// releasePortSlot marks a slot as free.
func releasePortSlot(slot int) {
	portMu.Lock()
	delete(usedSlots, slot)
	portMu.Unlock()
}

// --- Global user count ---

var (
	activeUserMu    sync.Mutex
	activeUserCount int
)

// GlobalConfig holds instance-level configuration set by the main package.
type GlobalConfig struct {
	MaxUsers int // Maximum concurrent users (0 = unlimited, default: 5)
}

// GlobalCfg is set by the main package before the extension is registered.
var GlobalCfg *GlobalConfig

// --- Per-session restart cooldown ---

var (
	lastStopMu    sync.Mutex
	lastStopTimes = make(map[string]time.Time)
)

// --- Types ---

// AudioExtensionParams contains audio stream parameters.
type AudioExtensionParams struct {
	SampleRate    int
	Channels      int
	BitsPerSample int
}

// AudioSample contains PCM audio data with timing information.
type AudioSample struct {
	PCMData      []int16
	RTPTimestamp uint32
	GPSTimeNs    int64
}

// AudioExtension is the interface all audio extensions must satisfy.
type AudioExtension interface {
	Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error
	Stop() error
	GetName() string
}

// SoundModemExtension wraps the QtSoundModem subprocess as an AudioExtension.
type SoundModemExtension struct {
	decoder   *SoundModemDecoder
	sessionID string
	portSlot  int
	kissPort  int
	agwPort   int
}

// validateChannelConfig extracts and strictly validates a SoundModemConfig from extensionParams.
// Returns an error for any out-of-range or malformed value — no silent clamping.
//
// The frontend sends:
//
//	params: {
//	  output_mode: "ax25" | "kiss",   // REQUIRED
//	  channels: [
//	    { enabled: true, modem: 1, freq: 1700, rcvr_pairs: 0, fx25: 1, il2p: 0 },
//	    ...  (up to 4)
//	  ],
//	  dcd_threshold: 20
//	}
func validateChannelConfig(sampleRate int, extensionParams map[string]interface{}) (SoundModemConfig, error) {
	cfg := DefaultSoundModemConfig(sampleRate)

	// --- output_mode (REQUIRED) ---
	rawMode, ok := extensionParams["output_mode"]
	if !ok {
		return cfg, fmt.Errorf("output_mode is required: must be \"ax25\" or \"kiss\"")
	}
	modeStr, ok := rawMode.(string)
	if !ok {
		return cfg, fmt.Errorf("output_mode must be a string (\"ax25\" or \"kiss\"), got %T", rawMode)
	}
	switch OutputMode(modeStr) {
	case OutputModeAX25:
		cfg.OutputMode = OutputModeAX25
	case OutputModeKISS:
		cfg.OutputMode = OutputModeKISS
	default:
		return cfg, fmt.Errorf("output_mode %q is invalid: must be \"ax25\" or \"kiss\"", modeStr)
	}

	// --- dcd_threshold ---
	if v, ok := extensionParams["dcd_threshold"]; ok {
		dcd, err := toInt(v, "dcd_threshold")
		if err != nil {
			return cfg, err
		}
		if dcd < 1 || dcd > 100 {
			return cfg, fmt.Errorf("dcd_threshold %d out of range [1, 100]", dcd)
		}
		cfg.DCDThreshold = dcd
	}

	// --- channels ---
	rawChannels, ok := extensionParams["channels"]
	if !ok {
		// No channels provided — use defaults (channel A, AFSK 1200bd)
		return cfg, nil
	}

	chList, ok := rawChannels.([]interface{})
	if !ok {
		return cfg, fmt.Errorf("channels must be an array")
	}
	if len(chList) > 4 {
		return cfg, fmt.Errorf("channels array too long: %d (max 4)", len(chList))
	}

	// Reset all channels to disabled before applying frontend config
	for i := range cfg.Channels {
		cfg.Channels[i] = ChannelConfig{}
	}

	for i, rawCh := range chList {
		chMap, ok := rawCh.(map[string]interface{})
		if !ok {
			return cfg, fmt.Errorf("channels[%d] must be an object", i)
		}

		chName := string(rune('A' + i))

		enabled, err := toBool(chMap, "enabled", false)
		if err != nil {
			return cfg, fmt.Errorf("channels[%d] (%s): %w", i, chName, err)
		}

		modem, err := toIntRequired(chMap, "modem", 1)
		if err != nil {
			return cfg, fmt.Errorf("channels[%d] (%s): %w", i, chName, err)
		}
		if modem < 0 || modem > 15 {
			return cfg, fmt.Errorf("channels[%d] (%s): modem %d out of range [0, 15]", i, chName, modem)
		}

		freq, err := toFloatRequired(chMap, "freq", 1700)
		if err != nil {
			return cfg, fmt.Errorf("channels[%d] (%s): %w", i, chName, err)
		}
		if freq < 100 || freq > 4000 {
			return cfg, fmt.Errorf("channels[%d] (%s): freq %.1f out of range [100, 4000]", i, chName, freq)
		}

		rcvrPairs, err := toIntRequired(chMap, "rcvr_pairs", 0)
		if err != nil {
			return cfg, fmt.Errorf("channels[%d] (%s): %w", i, chName, err)
		}
		if rcvrPairs < 0 || rcvrPairs > 8 {
			return cfg, fmt.Errorf("channels[%d] (%s): rcvr_pairs %d out of range [0, 8]", i, chName, rcvrPairs)
		}

		fx25, err := toIntRequired(chMap, "fx25", 1)
		if err != nil {
			return cfg, fmt.Errorf("channels[%d] (%s): %w", i, chName, err)
		}
		if fx25 < 0 || fx25 > 2 {
			return cfg, fmt.Errorf("channels[%d] (%s): fx25 %d out of range [0, 2]", i, chName, fx25)
		}

		il2p, err := toIntRequired(chMap, "il2p", 0)
		if err != nil {
			return cfg, fmt.Errorf("channels[%d] (%s): %w", i, chName, err)
		}
		if il2p < 0 || il2p > 3 {
			return cfg, fmt.Errorf("channels[%d] (%s): il2p %d out of range [0, 3]", i, chName, il2p)
		}

		cfg.Channels[i] = ChannelConfig{
			Enabled:   enabled,
			ModemType: modem,
			Freq:      freq,
			RcvrPairs: rcvrPairs,
			FX25:      fx25,
			IL2P:      il2p,
		}
	}

	// Ensure at least one channel is enabled
	anyEnabled := false
	for _, ch := range cfg.Channels {
		if ch.Enabled {
			anyEnabled = true
			break
		}
	}
	if !anyEnabled {
		return cfg, fmt.Errorf("at least one channel must be enabled")
	}

	return cfg, nil
}

// --- Strict type-safe helpers (return errors on bad input) ---

// toInt converts an interface{} value to int, returning an error if the type is wrong.
func toInt(v interface{}, name string) (int, error) {
	switch t := v.(type) {
	case float64:
		if t != float64(int(t)) {
			return 0, fmt.Errorf("%s must be an integer, got %v", name, v)
		}
		return int(t), nil
	case int:
		return t, nil
	default:
		return 0, fmt.Errorf("%s must be a number, got %T", name, v)
	}
}

// toBool reads a bool field from a map, returning an error if the value is present but not a bool.
func toBool(m map[string]interface{}, key string, def bool) (bool, error) {
	v, ok := m[key]
	if !ok {
		return def, nil
	}
	b, ok := v.(bool)
	if !ok {
		return false, fmt.Errorf("%s must be a boolean, got %T", key, v)
	}
	return b, nil
}

// toIntRequired reads an int field from a map, using def if absent, returning an error if present but wrong type.
func toIntRequired(m map[string]interface{}, key string, def int) (int, error) {
	v, ok := m[key]
	if !ok {
		return def, nil
	}
	return toInt(v, key)
}

// toFloatRequired reads a float field from a map, using def if absent, returning an error if present but wrong type.
func toFloatRequired(m map[string]interface{}, key string, def float64) (float64, error) {
	v, ok := m[key]
	if !ok {
		return def, nil
	}
	switch t := v.(type) {
	case float64:
		return t, nil
	case int:
		return float64(t), nil
	default:
		return 0, fmt.Errorf("%s must be a number, got %T", key, v)
	}
}

// NewSoundModemExtension creates a new Sound Modem audio extension.
func NewSoundModemExtension(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (*SoundModemExtension, error) {
	sessionID, _ := extensionParams["session_id"].(string)

	// Enforce per-session restart cooldown
	if sessionID != "" {
		lastStopMu.Lock()
		lastStop := lastStopTimes[sessionID]
		lastStopMu.Unlock()
		if !lastStop.IsZero() {
			if remaining := restartCooldown - time.Since(lastStop); remaining > 0 {
				return nil, fmt.Errorf("sound modem restarted too quickly — please wait %.1f more second(s)", remaining.Seconds())
			}
		}
	}

	// Enforce max users
	if GlobalCfg != nil && GlobalCfg.MaxUsers > 0 {
		activeUserMu.Lock()
		if activeUserCount >= GlobalCfg.MaxUsers {
			activeUserMu.Unlock()
			return nil, fmt.Errorf("maximum Sound Modem users reached (%d/%d)", activeUserCount, GlobalCfg.MaxUsers)
		}
		activeUserCount++
		cur := activeUserCount
		activeUserMu.Unlock()
		log.Printf("[SoundModem] User connected (%d/%d)", cur, GlobalCfg.MaxUsers)
	}

	// Validate audio parameters
	if audioParams.Channels != 1 {
		return nil, fmt.Errorf("sound modem requires mono audio (got %d channels)", audioParams.Channels)
	}
	if audioParams.BitsPerSample != 16 {
		return nil, fmt.Errorf("sound modem requires 16-bit audio (got %d bits)", audioParams.BitsPerSample)
	}

	// Validate and parse channel configuration from frontend params
	cfg, err := validateChannelConfig(audioParams.SampleRate, extensionParams)
	if err != nil {
		// Undo user count increment before returning
		if GlobalCfg != nil && GlobalCfg.MaxUsers > 0 {
			activeUserMu.Lock()
			if activeUserCount > 0 {
				activeUserCount--
			}
			activeUserMu.Unlock()
		}
		return nil, fmt.Errorf("invalid sound modem parameters: %w", err)
	}

	// Acquire a port pair
	kissPort, agwPort, slot, err := acquirePortSlot()
	if err != nil {
		// Undo user count increment
		if GlobalCfg != nil && GlobalCfg.MaxUsers > 0 {
			activeUserMu.Lock()
			if activeUserCount > 0 {
				activeUserCount--
			}
			activeUserMu.Unlock()
		}
		return nil, err
	}

	decoder, err := NewSoundModemDecoder(cfg, kissPort, agwPort)
	if err != nil {
		releasePortSlot(slot)
		if GlobalCfg != nil && GlobalCfg.MaxUsers > 0 {
			activeUserMu.Lock()
			if activeUserCount > 0 {
				activeUserCount--
			}
			activeUserMu.Unlock()
		}
		return nil, fmt.Errorf("failed to create Sound Modem decoder: %w", err)
	}

	log.Printf("[SoundModem] Created: sampleRate=%d Hz, KISS port=%d, AGW port=%d, DCD=%d",
		audioParams.SampleRate, kissPort, agwPort, cfg.DCDThreshold)

	return &SoundModemExtension{
		decoder:   decoder,
		sessionID: sessionID,
		portSlot:  slot,
		kissPort:  kissPort,
		agwPort:   agwPort,
	}, nil
}

// Start begins processing audio.
// If Start() fails, it calls Stop() internally to release the port slot and user count,
// since the audio extension manager does not call Stop() when Start() returns an error.
func (e *SoundModemExtension) Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error {
	if err := e.decoder.Start(audioChan, resultChan); err != nil {
		// Decoder failed to start — clean up port slot, user count, and temp dir.
		// We call Stop() directly rather than duplicating the cleanup logic.
		_ = e.Stop()
		return err
	}
	return nil
}

// Stop stops the extension and cleans up resources.
func (e *SoundModemExtension) Stop() error {
	err := e.decoder.Stop()

	// Release port slot
	releasePortSlot(e.portSlot)

	// Decrement active user count
	if GlobalCfg != nil && GlobalCfg.MaxUsers > 0 {
		activeUserMu.Lock()
		if activeUserCount > 0 {
			activeUserCount--
		}
		cur := activeUserCount
		activeUserMu.Unlock()
		log.Printf("[SoundModem] User disconnected (%d/%d)", cur, GlobalCfg.MaxUsers)
	}

	// Record stop time for cooldown enforcement
	if e.sessionID != "" {
		lastStopMu.Lock()
		lastStopTimes[e.sessionID] = time.Now()
		lastStopMu.Unlock()
	}

	return err
}

// GetName returns the extension name.
func (e *SoundModemExtension) GetName() string {
	return "soundmodem"
}

// CrashChan returns a channel that receives an error if the subprocess crashes
// while still supposed to be running.
func (e *SoundModemExtension) CrashChan() <-chan error {
	return e.decoder.CrashChan()
}

package whisper

import (
	"fmt"
	"log"
	"regexp"
	"strings"
	"sync"
	"unicode"
)

// maxInitialPromptLen bounds the client-supplied initial prompt.  Whisper only
// conditions on the last 224 tokens of the prompt anyway, so anything beyond
// roughly this length is silently discarded by the model — the cap exists to
// stop a client pushing unbounded text at the upstream server.
const maxInitialPromptLen = 1024

// reASRLanguage matches an ISO-639 language code with an optional region
// subtag, e.g. "en", "por", "pt-BR".
var reASRLanguage = regexp.MustCompile(`^[a-zA-Z]{2,3}(-[a-zA-Z]{2,4})?$`)

// recognitionParamKeys are the attach parameters gated behind
// whisper.allow_client_params.
var recognitionParamKeys = []string{"initial_prompt", "task", "asr_language"}

// hasRecognitionParams reports whether the client supplied any gated parameter,
// so an attach can fail loudly rather than silently ignoring it.
func hasRecognitionParams(params map[string]interface{}) bool {
	for _, key := range recognitionParamKeys {
		if _, ok := params[key]; ok {
			return true
		}
	}
	return false
}

// sanitiseInitialPrompt trims the prompt, strips control characters (which
// would otherwise be forwarded verbatim into the upstream JSON handshake) and
// enforces the length cap.
func sanitiseInitialPrompt(prompt string) (string, error) {
	cleaned := strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return ' '
		}
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, prompt)

	cleaned = strings.TrimSpace(cleaned)
	if len(cleaned) > maxInitialPromptLen {
		return "", fmt.Errorf("initial_prompt is %d bytes, maximum is %d", len(cleaned), maxInitialPromptLen)
	}
	return cleaned, nil
}

// ConfigProvider is set by main package to provide access to configuration
type ConfigProvider struct {
	Enabled           bool
	ServerURL         string
	Model             string
	InitialPrompt     string
	InstanceUUID      string
	MaxUsers          int
	LibreTranslateURL string
	SummaryURL        string
	Task              string
	ASRLanguage       string
	VADThreshold      float64
	AllowClientParams bool

	// TrustedContainersOnly rejects every attach that does not come from a
	// container listed in whisper.trusted_containers.
	TrustedContainersOnly bool
}

// GlobalConfigProvider is set by main package
var GlobalConfigProvider *ConfigProvider

// activeUserCount tracks the number of concurrent whisper users
var activeUserCount int
var activeUserMutex sync.Mutex

/*
 * Whisper Speech-to-Text Extension
 * Streams audio to WhisperLive server for real-time transcription
 *
 * Copyright (c) 2026, UberSDR project
 */

// AudioExtensionParams contains audio stream parameters
type AudioExtensionParams struct {
	SampleRate    int
	Channels      int
	BitsPerSample int
}

// AudioSample contains PCM audio data with timing information
type AudioSample struct {
	PCMData      []int16 // PCM audio samples (mono, int16)
	RTPTimestamp uint32  // RTP timestamp from radiod
	GPSTimeNs    int64   // GPS-synchronized Unix time in nanoseconds
}

// AudioExtension interface for extensible audio processors
type AudioExtension interface {
	Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error
	Stop() error
	GetName() string
}

// WhisperExtension wraps the Whisper decoder as an AudioExtension
type WhisperExtension struct {
	decoder *WhisperDecoder
	config  WhisperConfig

	// countedUser records whether this instance incremented activeUserCount, so
	// Stop() only decrements what it actually took.  Trusted containers bypass
	// the limit entirely and are never counted.
	countedUser bool
}

// NewWhisperExtension creates a new Whisper audio extension
func NewWhisperExtension(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (*WhisperExtension, error) {
	// Check if extension is enabled
	if GlobalConfigProvider != nil && !GlobalConfigProvider.Enabled {
		return nil, fmt.Errorf("whisper extension is disabled in configuration (set whisper.enabled: true in config.yaml)")
	}

	// trusted_container is written by the host on every attach (empty for a
	// normal listener) and always overwrites whatever the client sent, so it
	// cannot be forged from the frontend.  A trusted server-side addon container
	// may set the recognition parameters regardless of allow_client_params and
	// does not count towards max_users.
	trustedContainer, _ := extensionParams["trusted_container"].(string)
	isTrusted := trustedContainer != ""

	// whisper.trusted_containers_only turns the extension into a back-end
	// service for server-side addons only: enabled, but closed to listeners.
	if GlobalConfigProvider != nil && GlobalConfigProvider.TrustedContainersOnly && !isTrusted {
		return nil, fmt.Errorf("whisper extension is restricted to trusted containers on this instance")
	}

	// Validate audio parameters
	if audioParams.Channels != 1 {
		return nil, fmt.Errorf("whisper requires mono audio (got %d channels)", audioParams.Channels)
	}
	if audioParams.BitsPerSample != 16 {
		return nil, fmt.Errorf("whisper requires 16-bit audio (got %d bits)", audioParams.BitsPerSample)
	}

	// Get config from global config or use defaults.
	// A trusted container is always allowed the recognition parameters, whatever
	// whisper.allow_client_params says.
	var config WhisperConfig
	allowClientParams := isTrusted
	if GlobalConfigProvider != nil {
		config = WhisperConfig{
			Enabled:           GlobalConfigProvider.Enabled,
			ServerURL:         GlobalConfigProvider.ServerURL,
			Model:             GlobalConfigProvider.Model,
			InitialPrompt:     GlobalConfigProvider.InitialPrompt,
			InstanceUUID:      GlobalConfigProvider.InstanceUUID,
			LibreTranslateURL: GlobalConfigProvider.LibreTranslateURL,
			SummaryURL:        GlobalConfigProvider.SummaryURL,
			TargetLanguage:    "en", // Default to English
			Task:              GlobalConfigProvider.Task,
			ASRLanguage:       GlobalConfigProvider.ASRLanguage,
			VADThreshold:      GlobalConfigProvider.VADThreshold,
		}
		allowClientParams = GlobalConfigProvider.AllowClientParams || isTrusted
		log.Printf("[Whisper Extension] Using configuration from config.yaml")
	} else {
		// Default configuration if global config not available
		config = WhisperConfig{
			Enabled:           true, // Assume enabled if no config
			ServerURL:         "ws://whisperlive:9090",
			Model:             "small",
			InitialPrompt:     "",
			InstanceUUID:      "",
			LibreTranslateURL: "https://whisper.ubersdr.org/translate",
			SummaryURL:        "",
			TargetLanguage:    "en", // Default to English
		}
		log.Printf("[Whisper Extension] Using default configuration (config not available)")
	}

	// Override target language from frontend parameter if provided.
	// NOTE: "language" is the LibreTranslate *output* language and always has
	// been; the recognition language is "asr_language" below.  Keeping them
	// separate preserves the existing frontend contract.
	// Validated with the same rule as asr_language below, and for the same
	// reason the comment there gives: it is forwarded verbatim to a
	// possibly-shared upstream — here as the "target" field of every
	// LibreTranslate request, one per transcription segment. It was previously
	// taken unchecked and unbounded, which made a multi-megabyte attach string
	// into a multi-megabyte POST body repeated for the life of the session.
	// Every code the interface offers is a plain ISO-639 code, so nothing
	// legitimate is refused by this.
	if language, ok := extensionParams["language"].(string); ok && language != "" {
		if !reASRLanguage.MatchString(language) {
			return nil, fmt.Errorf("invalid language %q (expected a language code such as \"en\" or \"pt-BR\")", language)
		}
		config.TargetLanguage = language
		log.Printf("[Whisper Extension] Target language from frontend: %s", language)
	}

	// Per-attach overrides of the recognition parameters.  Gated behind
	// whisper.allow_client_params (or a trusted container) because these are
	// forwarded verbatim to a possibly-shared upstream WhisperLive server.
	if allowClientParams {
		if prompt, ok := extensionParams["initial_prompt"].(string); ok {
			cleaned, err := sanitiseInitialPrompt(prompt)
			if err != nil {
				return nil, err
			}
			config.InitialPrompt = cleaned
			if cleaned != "" {
				log.Printf("[Whisper Extension] initial_prompt from client (%d chars)", len(cleaned))
			}
		}

		if task, ok := extensionParams["task"].(string); ok && task != "" {
			if task != "transcribe" && task != "translate" {
				return nil, fmt.Errorf("invalid task %q (must be \"transcribe\" or \"translate\")", task)
			}
			config.Task = task
			log.Printf("[Whisper Extension] task from client: %s", task)
		}

		if lang, ok := extensionParams["asr_language"].(string); ok {
			if lang != "" && !reASRLanguage.MatchString(lang) {
				return nil, fmt.Errorf("invalid asr_language %q (expected a language code such as \"en\" or \"pt-BR\")", lang)
			}
			config.ASRLanguage = lang
			log.Printf("[Whisper Extension] asr_language from client: %q", lang)
		}
	} else if hasRecognitionParams(extensionParams) {
		return nil, fmt.Errorf("per-attach recognition parameters are disabled on this instance (set whisper.allow_client_params: true in config.yaml)")
	}

	// Check max users limit.  Done last so a rejected attach (bad audio params,
	// invalid task, …) never consumes a slot, and skipped entirely for trusted
	// containers, whose sessions must not be squeezed out by listeners.
	countedUser := false
	if GlobalConfigProvider != nil && GlobalConfigProvider.MaxUsers > 0 {
		if isTrusted {
			log.Printf("[Whisper Extension] Trusted container '%s' connected (exempt from max_users)", trustedContainer)
		} else {
			activeUserMutex.Lock()
			if activeUserCount >= GlobalConfigProvider.MaxUsers {
				limit := GlobalConfigProvider.MaxUsers
				current := activeUserCount
				activeUserMutex.Unlock()
				return nil, fmt.Errorf("maximum users reached (%d/%d)", current, limit)
			}
			activeUserCount++
			currentCount := activeUserCount
			activeUserMutex.Unlock()
			countedUser = true
			log.Printf("[Whisper Extension] User connected (%d/%d)", currentCount, GlobalConfigProvider.MaxUsers)
		}
	}

	// Create decoder
	decoder := NewWhisperDecoder(audioParams.SampleRate, config)

	asrLang := config.ASRLanguage
	if asrLang == "" {
		asrLang = "auto-detect"
	}
	log.Printf("[Whisper Extension] Created with server: %s, model: %s, language: %s, target: %s, sample rate: %d Hz",
		config.ServerURL, config.Model, asrLang, config.TargetLanguage, audioParams.SampleRate)

	return &WhisperExtension{
		decoder:     decoder,
		config:      config,
		countedUser: countedUser,
	}, nil
}

// Start begins processing audio
func (e *WhisperExtension) Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error {
	return e.decoder.Start(audioChan, resultChan)
}

// Stop stops the extension
func (e *WhisperExtension) Stop() error {
	// Decrement active user count — only if this instance actually took a slot
	// (trusted containers and attaches created while max_users was 0 did not).
	// Cleared as it is released, so a second Stop — the manager stops an
	// extension whose Start failed as well as on ordinary teardown — cannot
	// give the same slot back twice.
	if e.countedUser {
		e.countedUser = false
		activeUserMutex.Lock()
		if activeUserCount > 0 {
			activeUserCount--
		}
		currentCount := activeUserCount
		activeUserMutex.Unlock()
		maxUsers := 0
		if GlobalConfigProvider != nil {
			maxUsers = GlobalConfigProvider.MaxUsers
		}
		log.Printf("[Whisper Extension] User disconnected (%d/%d)", currentCount, maxUsers)
	}

	return e.decoder.Stop()
}

// GetName returns the extension name
func (e *WhisperExtension) GetName() string {
	return "whisper"
}

// HandleControlMessage handles control messages from the frontend
// This allows the frontend to send summary requests and other control commands
func (e *WhisperExtension) HandleControlMessage(message []byte, resultChan chan<- []byte) {
	if len(message) < 1 {
		return
	}

	messageType := message[0]
	switch messageType {
	case MessageTypeSummaryRequest:
		e.decoder.handleSummaryRequest(message, resultChan)
	case MessageTypeResetTranscript:
		e.decoder.resetTranscript()
	default:
		log.Printf("[Whisper Extension] Unknown control message type: 0x%02x", messageType)
	}
}

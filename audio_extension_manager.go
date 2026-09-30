package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/cwsl/ka9q_ubersdr/audio_extensions/soundmodem"
	"github.com/gorilla/websocket"
)

// AudioExtensionManager manages streaming audio extensions for user sessions
type AudioExtensionManager struct {
	// Active extensions per session (one per user)
	activeExtensions   map[string]*ActiveAudioExtension
	activeExtensionsMu sync.RWMutex

	// Reference to websocket handler for sending messages (uses its mutex system)
	wsHandler *DXClusterWebSocketHandler

	// Reference to session manager for audio tap
	sessionManager *SessionManager

	// Extension registry
	registry *AudioExtensionRegistry

	// Receiver location and CTY database for enrichment
	receiverLocator string
	ctyDatabase     *CTYDatabase

	// When each listener last stopped each extension that has a
	// RestartCooldown, keyed "name|sessionID". See recordStop.
	lastStops   map[string]time.Time
	lastStopsMu sync.Mutex

	// Per-listener attach budgets; see allowAttach.
	attachLimits   map[string]*attachLimit
	attachLimitsMu sync.Mutex
}

// Attaching is the expensive message: for most extensions it starts a
// subprocess, and for some a radiod channel. Each listener may attach
// attachBurst times back to back, then one every 1/attachRefillPerSec
// seconds. The burst clears a start plus the client's six reconnect retries
// (1.5 s apart) with room to spare; a flood is held to one start every two
// seconds. Keyed by the listener, not the socket, so opening more sockets
// buys nothing, and kept when a socket closes, so reconnecting does not
// reset it. Variables so tests can shorten them.
var (
	attachBurst        = 8.0
	attachRefillPerSec = 0.5
	// attachLimitIdle is how long an unused budget is kept before it is
	// forgotten (by which time it would be full again anyway).
	attachLimitIdle = 10 * time.Minute
)

type attachLimit struct {
	bucket   *RateLimiter
	lastUsed time.Time
}

// ActiveAudioExtension represents a running audio extension instance for a user
type ActiveAudioExtension struct {
	SessionID     string
	ExtensionName string
	Extension     AudioExtension
	AudioChan     chan AudioSample
	ResultChan    chan []byte
	StopChan      chan struct{}
	Conn          *websocket.Conn
	Running       bool
	StartedAt     time.Time

	// Session the audio tap was installed on, captured at attach time.
	// stopExtension used to look this up again by UserSessionID, which finds
	// nothing once the session has left the manager's map -- and then closed
	// the tap channel anyway, with the tap still installed on the session the
	// audio receiver is holding. Keeping the pointer means the detach and the
	// close always reach the session the channel was actually attached to.
	Session *Session

	// Guards the teardown in stopExtension. Two websocket connections can
	// share a UserSessionID (same UUID, two tabs), so a replace-on-attach and
	// a disconnect can reach the same record concurrently; without this the
	// second one closes channels the first already closed.
	stopOnce sync.Once

	// The extension's own radiod channel, for one registered with PrivateIQ;
	// nil otherwise. Session is then that channel's session, and Owner the
	// listener's. See private_iq_channel.go.
	private *privateIQChannel
	Owner   *Session
}

// NewAudioExtensionManager creates a new audio extension manager
func NewAudioExtensionManager(wsHandler *DXClusterWebSocketHandler, sessionManager *SessionManager, registry *AudioExtensionRegistry, receiverLocator string, ctyDatabase *CTYDatabase) *AudioExtensionManager {
	return &AudioExtensionManager{
		activeExtensions: make(map[string]*ActiveAudioExtension),
		wsHandler:        wsHandler,
		sessionManager:   sessionManager,
		registry:         registry,
		receiverLocator:  receiverLocator,
		ctyDatabase:      ctyDatabase,
		lastStops:        make(map[string]time.Time),
		attachLimits:     make(map[string]*attachLimit),
	}
}

// allowAttach spends one of the listener's attach tokens, and reports false
// when there are none left.
func (aem *AudioExtensionManager) allowAttach(sessionID string) bool {
	aem.attachLimitsMu.Lock()
	defer aem.attachLimitsMu.Unlock()
	now := time.Now()
	for id, l := range aem.attachLimits {
		if now.Sub(l.lastUsed) > attachLimitIdle {
			delete(aem.attachLimits, id)
		}
	}
	l, ok := aem.attachLimits[sessionID]
	if !ok {
		l = &attachLimit{bucket: &RateLimiter{
			tokens:     attachBurst,
			maxTokens:  attachBurst,
			refillRate: attachRefillPerSec,
			lastRefill: now,
		}}
		aem.attachLimits[sessionID] = l
	}
	l.lastUsed = now
	return l.bucket.Allow()
}

// recordStop notes that the listener stopped this extension, for its
// RestartCooldown. Called only for stops the listener made.
func (aem *AudioExtensionManager) recordStop(activeExtension *ActiveAudioExtension) {
	info, ok := aem.registry.Info(activeExtension.ExtensionName)
	if !ok || info.RestartCooldown <= 0 {
		return
	}
	aem.lastStopsMu.Lock()
	defer aem.lastStopsMu.Unlock()
	now := time.Now()
	for k, t := range aem.lastStops {
		if now.Sub(t) > time.Minute {
			delete(aem.lastStops, k)
		}
	}
	aem.lastStops[activeExtension.ExtensionName+"|"+activeExtension.SessionID] = now
}

// restartCooldownError is the refusal for starting an extension again too
// soon after the listener stopped it, or nil.
func (aem *AudioExtensionManager) restartCooldownError(extensionName, sessionID string) error {
	info, ok := aem.registry.Info(extensionName)
	if !ok || info.RestartCooldown <= 0 {
		return nil
	}
	aem.lastStopsMu.Lock()
	last := aem.lastStops[extensionName+"|"+sessionID]
	aem.lastStopsMu.Unlock()
	if last.IsZero() {
		return nil
	}
	remaining := info.RestartCooldown - time.Since(last)
	if remaining <= 0 {
		return nil
	}
	name := info.DisplayName
	if name == "" {
		name = extensionName
	}
	return fmt.Errorf("%s restarted too quickly — please wait %.1f more second(s)", name, remaining.Seconds())
}

// HandleExtensionMessage processes audio extension control messages from clients
func (aem *AudioExtensionManager) HandleExtensionMessage(sessionID string, conn *websocket.Conn, msg map[string]interface{}) error {
	msgType, ok := msg["type"].(string)
	if !ok {
		return fmt.Errorf("invalid message type")
	}

	switch msgType {
	case "audio_extension_attach":
		return aem.handleAttach(sessionID, conn, msg)

	case "audio_extension_detach":
		return aem.handleDetach(sessionID, conn)

	case "audio_extension_status":
		return aem.handleStatus(sessionID, conn)

	case "audio_extension_list":
		return aem.handleList(sessionID, conn)

	case "audio_extension_control":
		return aem.handleControl(sessionID, conn, msg)

	default:
		return fmt.Errorf("unknown audio extension message type: %s", msgType)
	}
}

// handleAttach attaches an audio extension to the user's audio stream
func (aem *AudioExtensionManager) handleAttach(sessionID string, conn *websocket.Conn, msg map[string]interface{}) error {
	// Extract extension name
	extensionName, ok := msg["extension_name"].(string)
	if !ok || extensionName == "" {
		log.Printf("AudioExtension: Attach failed for session %s - extension_name is required", sessionID)
		return aem.sendErrorSafe(nil, conn, "extension_name is required")
	}

	// Extract optional extension-specific parameters
	extensionParams := make(map[string]interface{})
	if params, ok := msg["params"].(map[string]interface{}); ok {
		extensionParams = params
	}

	log.Printf("AudioExtension: Attach request - User: %s, Extension: %s, Params: %+v", sessionID, extensionName, extensionParams)

	// Find user's audio session by UserSessionID. First, so an attach with no
	// session behind it -- which is what the client's reconnect retries meet
	// -- is refused before it spends anything below.
	session := aem.findAudioSessionByUserID(sessionID)
	if session == nil {
		return aem.sendErrorSafe(nil, conn, "no active audio session found")
	}

	// Attaching starts a subprocess for most extensions: a listener may not
	// do it without limit. Bypassed listeners (IP list or password) are
	// exempt, as they are from the connection limits. Checked before the
	// running extension is torn down, so a refused attach changes nothing.
	if !aem.sessionManager.config.Server.IsIPTimeoutBypassed(session.ClientIP, session.BypassPassword) &&
		!aem.allowAttach(sessionID) {
		log.Printf("AudioExtension: Attach rate limit exceeded for %s (%s)", sessionID, extensionName)
		return aem.sendErrorSafe(nil, conn, "Rate limit exceeded. Please slow down.")
	}
	if err := aem.restartCooldownError(extensionName, sessionID); err != nil {
		return aem.sendErrorSafe(nil, conn, err.Error())
	}

	// Tear down existing extension if any (user can only have one at a time)
	aem.activeExtensionsMu.Lock()
	if existing, exists := aem.activeExtensions[sessionID]; exists {
		log.Printf("AudioExtension: Tearing down existing extension '%s' for user %s (replacing with '%s')",
			existing.ExtensionName, sessionID, extensionName)
		aem.activeExtensionsMu.Unlock()
		aem.stopExtension(existing)
		aem.recordStop(existing)
		aem.activeExtensionsMu.Lock()
	}
	aem.activeExtensionsMu.Unlock()

	// An extension registered with PrivateIQ gets a radiod channel of its own
	// on the listener's frequency, and is fed from that instead of from what
	// the listener hears. tapSession is whichever session the tap goes on.
	owner := session
	tapSession := session
	var private *privateIQChannel
	if info, ok := aem.registry.Info(extensionName); ok && info.PrivateIQ != "" {
		p, err := aem.sessionManager.newPrivateIQChannel(owner, extensionName, info.PrivateIQ)
		if err != nil {
			return aem.sendErrorSafe(nil, conn, fmt.Sprintf("failed to create extension channel: %v", err))
		}
		private = p
		tapSession = p.session
		extensionParams["private_iq_mode"] = info.PrivateIQ
	}

	// Get audio parameters from the session the extension is fed from.
	// Channels is 1 for mono modes (USB, LSB, AM, FM, etc.) and 2 for IQ modes
	// (iq48, iq96, iq192, iq384) where the audio tap delivers stereo interleaved I/Q.
	audioParams := AudioExtensionParams{
		SampleRate:    tapSession.GetSampleRate(),
		Channels:      tapSession.Channels, // 1 = mono, 2 = stereo IQ
		BitsPerSample: 16,                  // Always 16-bit
	}

	// Add receiver locator and CTY database to extension params
	if aem.receiverLocator != "" {
		extensionParams["receiver_locator"] = aem.receiverLocator
	}
	if aem.ctyDatabase != nil {
		extensionParams["cty_database"] = aem.ctyDatabase
	}

	// Inject the session's tuned frequency, mode, and filter edges so extensions
	// can use them without requiring the frontend to send them explicitly.
	extensionParams["tuned_frequency_hz"] = session.Frequency
	extensionParams["tuned_mode"] = session.Mode
	extensionParams["tuned_bandwidth_low_hz"] = session.BandwidthLow
	extensionParams["tuned_bandwidth_high_hz"] = session.BandwidthHigh
	extensionParams["session_id"] = sessionID

	// Raw TCP peer IP of the session's audio WebSocket (never the X-Real-IP
	// derived client IP — a trusted container is the direct peer).  Written
	// unconditionally so it always overwrites any value the client put in its
	// own attach params; extensions use it to recognise server-side addon
	// containers.
	extensionParams["source_ip"] = session.SourceIP

	// Create extension instance
	extension, err := aem.registry.Create(extensionName, audioParams, extensionParams)
	if err != nil {
		if private != nil {
			private.close()
		}
		return aem.sendErrorSafe(nil, conn, fmt.Sprintf("failed to create extension: %v", err))
	}

	// Create channels for audio and results
	audioChan := make(chan AudioSample, 1024)
	resultChan := make(chan []byte, 100)
	stopChan := make(chan struct{})

	// Create active extension record
	activeExtension := &ActiveAudioExtension{
		SessionID:     sessionID,
		ExtensionName: extensionName,
		Extension:     extension,
		AudioChan:     audioChan,
		ResultChan:    resultChan,
		StopChan:      stopChan,
		Conn:          conn,
		Running:       true,
		StartedAt:     time.Now(),
		Session:       tapSession,
		private:       private,
		Owner:         owner,
	}

	// Attach audio tap to session
	tapSession.AttachAudioExtensionTap(audioChan)

	// With a private channel the extension reads through the relay, which
	// holds its audio back while the channel is moving; the tap itself stays
	// audioChan, so teardown below and in stopExtension is unchanged.
	extensionInput := audioChan
	if private != nil {
		extensionInput = make(chan AudioSample, cap(audioChan))
		go private.relay(audioChan, extensionInput)
		private.start(func(frequency uint64, blocked bool) {
			aem.privateChannelSettled(activeExtension, frequency, blocked)
		})
	}

	// Start extension
	if err := extension.Start(extensionInput, resultChan); err != nil {
		if private != nil {
			// The relay is reading the tap, so it has to be closed rather than
			// just detached, or the relay never ends; closing in one step with
			// the detach is what makes that safe (see CloseAudioExtensionTap).
			tapSession.CloseAudioExtensionTap(audioChan)
		} else {
			tapSession.DetachAudioExtensionTap()
		}
		// The constructor succeeded, so this extension may be holding a
		// max_users slot, a port from a pool, or a subprocess — none of which
		// the record below will ever be around to release, since it is not
		// stored and stopExtension can therefore never reach it. Without this
		// a binary that will not start turns every attempt into a permanent
		// leak, and enough attempts lock every user out of the extension.
		// Stop is idempotent in each extension, so one that already cleaned up
		// after its own failed Start is unharmed by being told again.
		if stopErr := extension.Stop(); stopErr != nil {
			log.Printf("AudioExtension: cleanup after failed start of '%s' returned: %v", extensionName, stopErr)
		}
		if private != nil {
			private.close()
		}
		return aem.sendErrorSafe(activeExtension, conn, fmt.Sprintf("failed to start extension: %v", err))
	}

	// Store active extension
	aem.activeExtensionsMu.Lock()
	aem.activeExtensions[sessionID] = activeExtension
	aem.activeExtensionsMu.Unlock()

	// A private channel lives only as long as the listener's own session. The
	// extension otherwise outlives it -- it is attached over the DX cluster
	// socket, not the audio one -- and a listener kicked, timed out or
	// reconnected would leave a radiod channel and a decoder running.
	if private != nil {
		go aem.watchOwner(activeExtension)
	}

	// Start result forwarding goroutine
	go aem.forwardResults(activeExtension)

	log.Printf("AudioExtension: ✅ Successfully attached '%s' to user %s", extensionName, sessionID)
	log.Printf("AudioExtension: Extension parameters: %+v", extensionParams)
	log.Printf("AudioExtension: Audio parameters: SampleRate=%d Hz, Channels=%d, BitsPerSample=%d",
		audioParams.SampleRate, audioParams.Channels, audioParams.BitsPerSample)
	log.Printf("AudioExtension: Active extensions count: %d", aem.GetActiveExtensionCount())

	// Send success confirmation using safe method (now that activeExtension is created)
	return aem.sendTextMessageSafe(activeExtension, map[string]interface{}{
		"type":           "audio_extension_attached",
		"extension_name": extensionName,
		"started_at":     activeExtension.StartedAt.Format(time.RFC3339),
	})
}

// handleDetach detaches the active audio extension from the user's audio stream
func (aem *AudioExtensionManager) handleDetach(sessionID string, conn *websocket.Conn) error {
	aem.activeExtensionsMu.Lock()
	activeExtension, exists := aem.activeExtensions[sessionID]
	if !exists {
		aem.activeExtensionsMu.Unlock()
		return aem.sendErrorSafe(nil, conn, "no active audio extension")
	}
	delete(aem.activeExtensions, sessionID)
	aem.activeExtensionsMu.Unlock()

	// Stop extension
	aem.stopExtension(activeExtension)
	aem.recordStop(activeExtension)

	log.Printf("AudioExtension: Detached '%s' from session %s", activeExtension.ExtensionName, sessionID)

	// Send confirmation using safe method
	return aem.sendTextMessageSafe(activeExtension, map[string]interface{}{
		"type": "audio_extension_detached",
	})
}

// handleStatus returns the status of the user's active audio extension
func (aem *AudioExtensionManager) handleStatus(sessionID string, conn *websocket.Conn) error {
	aem.activeExtensionsMu.RLock()
	activeExtension, exists := aem.activeExtensions[sessionID]
	aem.activeExtensionsMu.RUnlock()

	if !exists {
		return aem.sendTextMessageWithConn(conn, map[string]interface{}{
			"type":   "audio_extension_status",
			"active": false,
		})
	}

	uptime := time.Since(activeExtension.StartedAt)

	return aem.sendTextMessageSafe(activeExtension, map[string]interface{}{
		"type":           "audio_extension_status",
		"active":         true,
		"extension_name": activeExtension.ExtensionName,
		"started_at":     activeExtension.StartedAt.Format(time.RFC3339),
		"uptime_sec":     int(uptime.Seconds()),
	})
}

// handleList returns the list of available audio extensions
func (aem *AudioExtensionManager) handleList(sessionID string, conn *websocket.Conn) error {
	extensions := aem.registry.List()

	return aem.sendTextMessageWithConn(conn, map[string]interface{}{
		"type":       "audio_extension_list",
		"extensions": extensions,
	})
}

// handleControl handles control messages for audio extensions (e.g., summary requests)
func (aem *AudioExtensionManager) handleControl(sessionID string, conn *websocket.Conn, msg map[string]interface{}) error {
	// Get the active extension for this session
	aem.activeExtensionsMu.RLock()
	activeExtension, exists := aem.activeExtensions[sessionID]
	aem.activeExtensionsMu.RUnlock()

	if !exists {
		log.Printf("AudioExtension: Control message for session %s but no active extension", sessionID)
		return aem.sendErrorSafe(nil, conn, "no active audio extension")
	}

	// Extract control type
	controlType, ok := msg["control_type"].(string)
	if !ok || controlType == "" {
		log.Printf("AudioExtension: Control message missing control_type")
		return aem.sendErrorSafe(activeExtension, conn, "control_type is required")
	}

	// Handle different control types
	switch controlType {
	case "summary_request":
		// Extract n_segments
		nSegments, ok := msg["n_segments"].(float64) // JSON numbers are float64
		if !ok {
			log.Printf("AudioExtension: Summary request missing n_segments")
			return aem.sendErrorSafe(activeExtension, conn, "n_segments is required for summary_request")
		}

		// Create binary message for the extension: [type:1][n_segments:4]
		buffer := make([]byte, 5)
		buffer[0] = 0x06 // MessageTypeSummaryRequest
		binary.BigEndian.PutUint32(buffer[1:5], uint32(nSegments))

		// Call HandleControlMessage on the whisper extension wrapper
		if whisperExt, ok := activeExtension.Extension.(*whisperExtensionWrapper); ok {
			whisperExt.HandleControlMessage(buffer, activeExtension.ResultChan)
			log.Printf("AudioExtension: Sent summary request to whisper extension for %d segments", int(nSegments))
		} else {
			log.Printf("AudioExtension: Active extension is not whisper, cannot handle summary request")
			return aem.sendErrorSafe(activeExtension, conn, "summary requests only supported for whisper extension")
		}

	case "reset_transcript":
		// Clear the whisper dedup history — used by scanning clients that retune
		// without detaching, so a repeated phrase on a new frequency is not
		// suppressed as a duplicate of the previous frequency's audio.
		whisperExt, ok := activeExtension.Extension.(*whisperExtensionWrapper)
		if !ok {
			log.Printf("AudioExtension: reset_transcript called on non-whisper extension")
			return aem.sendErrorSafe(activeExtension, conn, "reset_transcript is only supported for the whisper extension")
		}

		whisperExt.HandleControlMessage([]byte{0x07}, activeExtension.ResultChan)
		return aem.sendTextMessageSafe(activeExtension, map[string]interface{}{
			"type":         "audio_extension_control_ack",
			"control_type": "reset_transcript",
		})

	case "set_output_mode":
		// Switch the soundmodem output format on the fly (no subprocess restart needed).
		// Expected message: { "type": "audio_extension_control", "control_type": "set_output_mode", "output_mode": "ax25" | "kiss" }
		modeStr, ok := msg["output_mode"].(string)
		if !ok || modeStr == "" {
			log.Printf("AudioExtension: set_output_mode missing output_mode")
			return aem.sendErrorSafe(activeExtension, conn, "output_mode is required for set_output_mode (\"ax25\" or \"kiss\")")
		}

		smWrapper, ok := activeExtension.Extension.(*soundmodemExtensionWrapper)
		if !ok {
			log.Printf("AudioExtension: set_output_mode called on non-soundmodem extension")
			return aem.sendErrorSafe(activeExtension, conn, "set_output_mode is only supported for the soundmodem extension")
		}

		if err := smWrapper.SetOutputMode(soundmodem.OutputMode(modeStr)); err != nil {
			log.Printf("AudioExtension: set_output_mode failed: %v", err)
			return aem.sendErrorSafe(activeExtension, conn, fmt.Sprintf("set_output_mode failed: %v", err))
		}

		log.Printf("AudioExtension: [%s] output_mode switched to %q", sessionID, modeStr)
		return aem.sendTextMessageSafe(activeExtension, map[string]interface{}{
			"type":         "audio_extension_control_ack",
			"control_type": "set_output_mode",
			"output_mode":  modeStr,
		})

	case "set_squelch":
		// Move the Olivia squelch without rebuilding the decoder.
		// Expected message: { "type": "audio_extension_control", "control_type": "set_squelch", "sync_threshold": 4.5 }
		//
		// Every other Olivia setting resizes the receiver's arrays, so the
		// frontend changes those by re-attaching. The squelch is the exception
		// on purpose: Olivia has no preamble and takes several seconds to
		// acquire, so a slider that tore the decoder down on every drag would
		// be unusable.
		threshold, ok := msg["sync_threshold"].(float64)
		if !ok {
			log.Printf("AudioExtension: set_squelch missing sync_threshold")
			return aem.sendErrorSafe(activeExtension, conn, "sync_threshold is required for set_squelch")
		}

		oliviaWrapper, ok := activeExtension.Extension.(*oliviaExtensionWrapper)
		if !ok {
			log.Printf("AudioExtension: set_squelch called on non-olivia extension")
			return aem.sendErrorSafe(activeExtension, conn, "set_squelch is only supported for the olivia extension")
		}

		applied, err := oliviaWrapper.SetSyncThreshold(threshold)
		if err != nil {
			log.Printf("AudioExtension: set_squelch failed: %v", err)
			return aem.sendErrorSafe(activeExtension, conn, fmt.Sprintf("set_squelch failed: %v", err))
		}

		log.Printf("AudioExtension: [%s] olivia squelch set to %.2f", sessionID, applied)
		// The applied value is echoed rather than the requested one: it is
		// clamped, and a slider that silently disagreed with the decoder would
		// be worse than one that snaps.
		return aem.sendTextMessageSafe(activeExtension, map[string]interface{}{
			"type":           "audio_extension_control_ack",
			"control_type":   "set_squelch",
			"sync_threshold": applied,
		})

	case "set_program":
		// Switch the HD Radio program without restarting the decoder, which
		// would cost the listener several seconds of re-acquisition.
		// Expected message: { "type": "audio_extension_control", "control_type": "set_program", "program": 1 }
		program, ok := msg["program"].(float64)
		if !ok || program != float64(int(program)) {
			return aem.sendErrorSafe(activeExtension, conn, "program is required for set_program (0 = HD1 .. 7 = HD8)")
		}
		setter, ok := activeExtension.Extension.(interface{ SetProgram(int) error })
		if !ok {
			return aem.sendErrorSafe(activeExtension, conn, "set_program is only supported for the hdradio extension")
		}
		if err := setter.SetProgram(int(program)); err != nil {
			return aem.sendErrorSafe(activeExtension, conn, fmt.Sprintf("set_program failed: %v", err))
		}
		return aem.sendTextMessageSafe(activeExtension, map[string]interface{}{
			"type":         "audio_extension_control_ack",
			"control_type": "set_program",
			"program":      int(program),
		})

	default:
		log.Printf("AudioExtension: Unknown control type: %s", controlType)
		return aem.sendErrorSafe(activeExtension, conn, fmt.Sprintf("unknown control_type: %s", controlType))
	}

	return nil
}

// forwardResults forwards binary extension results to the client.
// If the extension implements CrashReporter, it also monitors the crash channel
// and sends an audio_extension_error message to the frontend if the subprocess
// exits unexpectedly while still running.
func (aem *AudioExtensionManager) forwardResults(activeExtension *ActiveAudioExtension) {
	// Obtain crash channel via optional CrashReporter interface (nil for non-subprocess extensions)
	var crashChan <-chan error
	if cr, ok := activeExtension.Extension.(CrashReporter); ok {
		crashChan = cr.CrashChan()
	}

	for {
		select {
		case binaryData, ok := <-activeExtension.ResultChan:
			if !ok {
				// Channel closed
				return
			}

			// Send binary message to client using the websocket handler's mutex system
			if err := aem.sendBinaryMessage(activeExtension.Conn, binaryData); err != nil {
				log.Printf("AudioExtension: Failed to send result to session %s: %v", activeExtension.SessionID, err)
				return
			}

		case crashErr, ok := <-crashChan:
			if !ok {
				// Crash channel closed without an error — treat as nil channel going forward
				crashChan = nil
				continue
			}
			errMsg := fmt.Sprintf("%s subprocess exited unexpectedly", activeExtension.ExtensionName)
			if crashErr != nil {
				errMsg = fmt.Sprintf("%s subprocess crashed: %v", activeExtension.ExtensionName, crashErr)
			}
			log.Printf("AudioExtension: Crash detected for session %s: %s", activeExtension.SessionID, errMsg)
			// A private channel has nothing left to feed; give it back to
			// radiod now rather than when the client next detaches.
			if activeExtension.private != nil {
				activeExtension.private.close()
			}
			// Notify the frontend
			_ = aem.sendErrorSafe(activeExtension, activeExtension.Conn, errMsg)
			return

		case <-activeExtension.StopChan:
			return
		}
	}
}

// stopExtension stops an audio extension and cleans up resources
func (aem *AudioExtensionManager) stopExtension(activeExtension *ActiveAudioExtension) {
	activeExtension.stopOnce.Do(func() {
		activeExtension.Running = false

		// Signal stop
		close(activeExtension.StopChan)

		// Stop extension
		if err := activeExtension.Extension.Stop(); err != nil {
			log.Printf("AudioExtension: Error stopping extension: %v", err)
		}

		// Detach the audio tap and close it in one step. Detaching and then
		// closing separately is what crashed the server on 2026-09-02: the
		// audio receiver had already loaded the channel and its send landed
		// after the close. See Session.CloseAudioExtensionTap.
		if activeExtension.Session != nil {
			activeExtension.Session.CloseAudioExtensionTap(activeExtension.AudioChan)
		} else {
			close(activeExtension.AudioChan)
		}

		if activeExtension.private != nil {
			activeExtension.private.close()
		}

		close(activeExtension.ResultChan)
	})
}

// watchOwner ends an extension with a private channel when the listener's own
// audio session ends, however it ends. Returns when the extension stops first.
func (aem *AudioExtensionManager) watchOwner(activeExtension *ActiveAudioExtension) {
	defer recoverPrivateIQ("owner watch")
	select {
	case <-activeExtension.StopChan:
		return
	case <-activeExtension.Owner.Done:
	}

	// Only the record this watcher belongs to: by now the client may have
	// attached a new one under the same session ID.
	aem.activeExtensionsMu.Lock()
	current, exists := aem.activeExtensions[activeExtension.SessionID]
	if exists && current == activeExtension {
		delete(aem.activeExtensions, activeExtension.SessionID)
	}
	aem.activeExtensionsMu.Unlock()

	log.Printf("AudioExtension: '%s' for session %s stopped: the listener's audio session ended",
		activeExtension.ExtensionName, activeExtension.SessionID)
	aem.stopExtension(activeExtension)
	// Worded so the client's attach hook treats it as transient and attaches
	// again: after a reconnect the listener has a new audio session and the
	// retry succeeds; after a kick there is none, and it gives up cleanly.
	_ = aem.sendErrorSafe(activeExtension, activeExtension.Conn, "no active audio session (the listener's audio session ended)")
}

// privateChannelSettled is called when an extension's private channel has
// followed the listener to a new frequency and settled there. The extension is
// told first, so it has dropped the old station before the new one's audio
// reaches it, then the client, so its display can follow.
func (aem *AudioExtensionManager) privateChannelSettled(activeExtension *ActiveAudioExtension, frequency uint64, blocked bool) {
	// Not for an extension already being stopped: it may have torn down
	// whatever Retune would touch. (Retune must still tolerate the narrow
	// race this leaves; see AudioExtensionRetuner.)
	select {
	case <-activeExtension.StopChan:
		return
	default:
	}
	if retuner, ok := activeExtension.Extension.(AudioExtensionRetuner); ok {
		retuner.Retune(frequency)
	}
	_ = aem.sendTextMessageSafe(activeExtension, map[string]interface{}{
		"type":           "audio_extension_retuned",
		"extension_name": activeExtension.ExtensionName,
		"frequency":      frequency,
		// The listener may not be served this frequency: the channel is
		// passing the extension silence until they tune away.
		"blocked": blocked,
	})
}

// RemoveSession removes all audio extensions for a session (called when user disconnects)
func (aem *AudioExtensionManager) RemoveSession(sessionID string) {
	aem.activeExtensionsMu.Lock()
	activeExtension, exists := aem.activeExtensions[sessionID]
	if exists {
		delete(aem.activeExtensions, sessionID)
	}
	aem.activeExtensionsMu.Unlock()

	if exists {
		log.Printf("AudioExtension: Removing extension for disconnected session %s", sessionID)
		aem.stopExtension(activeExtension)
		// Closing the socket is the listener's doing, like a detach.
		aem.recordStop(activeExtension)
	}
}

// findAudioSessionByUserID finds the audio session for a given UserSessionID
func (aem *AudioExtensionManager) findAudioSessionByUserID(userSessionID string) *Session {
	aem.sessionManager.mu.RLock()
	defer aem.sessionManager.mu.RUnlock()

	for _, session := range aem.sessionManager.sessions {
		if session.UserSessionID == userSessionID && !session.IsSpectrum {
			return session
		}
	}

	return nil
}

// sendTextMessageWithConn sends a JSON text message to the client using a raw connection
// This is used when we don't have an activeExtension yet (e.g., during initial attach errors)
// Note: This should only be used when the connection is not yet shared/stored in activeExtension
func (aem *AudioExtensionManager) sendTextMessageWithConn(conn *websocket.Conn, message map[string]interface{}) error {
	if conn == nil {
		return fmt.Errorf("connection is nil")
	}
	messageJSON, err := json.Marshal(message)
	if err != nil {
		return fmt.Errorf("failed to marshal message: %v", err)
	}

	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return conn.WriteMessage(websocket.TextMessage, messageJSON)
}

// sendTextMessageSafe sends a JSON text message to the client using the DXCluster handler's mutex
func (aem *AudioExtensionManager) sendTextMessageSafe(activeExtension *ActiveAudioExtension, message map[string]interface{}) error {
	if activeExtension.Conn == nil {
		return fmt.Errorf("connection is nil")
	}

	// Use the DXCluster handler's sendMessage which has proper mutex coordination
	return aem.wsHandler.sendMessage(activeExtension.Conn, message)
}

// sendBinaryMessage sends a binary message to the client using the DXCluster handler's mutex system
func (aem *AudioExtensionManager) sendBinaryMessage(conn *websocket.Conn, data []byte) error {
	if conn == nil {
		return fmt.Errorf("connection is nil")
	}

	// Get the write mutex for this connection from the DXCluster handler
	aem.wsHandler.clientsMu.RLock()
	writeMu, exists := aem.wsHandler.clients[conn]
	aem.wsHandler.clientsMu.RUnlock()

	if !exists {
		return fmt.Errorf("connection not found in handler")
	}

	// Lock before writing (using the same mutex as the DXCluster handler)
	writeMu.Lock()
	defer writeMu.Unlock()

	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return conn.WriteMessage(websocket.BinaryMessage, data)
}

// sendErrorSafe sends an error message to the client with proper mutex protection
// If activeExtension is nil, falls back to using the raw connection (for early errors)
func (aem *AudioExtensionManager) sendErrorSafe(activeExtension *ActiveAudioExtension, conn *websocket.Conn, errorMsg string) error {
	message := map[string]interface{}{
		"type":  "audio_extension_error",
		"error": errorMsg,
	}

	if activeExtension != nil {
		return aem.sendTextMessageSafe(activeExtension, message)
	}

	// Fallback for early errors before activeExtension is created
	return aem.sendTextMessageWithConn(conn, message)
}

// GetActiveExtensionCount returns the number of active audio extensions
func (aem *AudioExtensionManager) GetActiveExtensionCount() int {
	aem.activeExtensionsMu.RLock()
	defer aem.activeExtensionsMu.RUnlock()
	return len(aem.activeExtensions)
}

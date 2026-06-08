package main

// app_state.go — AppState holds all mutable application state that is shared
// between the Fyne GUI callbacks and the REST API handlers.
//
// Previously this state lived as local variables inside main().  By moving it
// into a struct we can pass a single *AppState pointer to both the GUI closure
// functions and the HTTP handlers, keeping them in sync without any additional
// synchronisation beyond what Fyne already provides for widget methods.
//
// Thread-safety notes:
//   - Fields backed by Fyne widgets (e.g. CurrentFreq, CurrentMode) are
//     written on the Fyne goroutine by GUI callbacks and read by HTTP handlers
//     from arbitrary goroutines.  These are protected by Mu.
//   - Signal quality fields are written from the AudioOutput onChunkPlayed
//     callback (a goroutine) and read by HTTP handlers.  Also protected by Mu.
//   - Fyne widget Set* methods are themselves goroutine-safe; HTTP handlers
//     may call them directly to keep the GUI in sync.

import (
	"sync"
	"time"

	"fyne.io/fyne/v2/widget"
)

// AppState is the single source of truth for all mutable application state.
type AppState struct {
	Mu sync.RWMutex

	// ── Tuning ────────────────────────────────────────────────────────────────
	CurrentFreq int     // Hz
	CurrentMode string  // "usb", "lsb", etc.
	CurrentBW   float64 // slider value (Hz)
	StepIndex   int     // index into freqSteps

	// ── Audio ─────────────────────────────────────────────────────────────────
	Volume      float64 // 0–100
	Muted       bool
	PremuteVol  float64 // volume before mute (for restore)
	ChannelMode string  // "both", "left", "right"
	Format      string  // "opus" or "pcm-zstd"
	DeviceID    string  // "" = system default

	// ── AGC ───────────────────────────────────────────────────────────────────
	AGCHangTime     float64 // seconds [0.0, 10.0]
	AGCRecoveryRate float64 // dB/s [1.0, 100.0]

	// ── DSP ───────────────────────────────────────────────────────────────────
	DSPAvailable bool
	DSPEnabled   bool
	DSPFilter    string
	DSPFilters   []DSPFilter       // full metadata from server
	DSPParams    map[string]string // current param values for active filter

	// ── Signal quality ────────────────────────────────────────────────────────
	// Updated from the AudioOutput onChunkPlayed callback (~100 ms rate).
	SignalBasebandDBFS     float32
	SignalNoiseDensityDBFS float32
	SignalSNRDB            float32
	SignalAudioDBFS        float32
	SignalUpdatedAt        *time.Time // nil until first reading

	// ── Audio gate ────────────────────────────────────────────────────────────
	// SNR squelch threshold sent to the upstream ubersdr server via set_audio_gate.
	// -999 = disabled (default).  Valid range: -999 to +999.
	AudioGateMinSNR float32

	// SNRSquelchSlider is the Fyne slider widget for the SNR squelch threshold.
	// Held so the API handler can update it when the web UI changes the gate.
	// Fyne widget Set* methods are goroutine-safe.
	SNRSquelchSlider interface{ SetValue(float64) }

	// ── Connection metadata ───────────────────────────────────────────────────
	ActiveCallsign     string
	ActiveName         string
	ActiveLocation     string
	SessionMaxSecs     int       // 0 = unlimited
	SessionConnectedAt time.Time // when the session timer started (zero = not set)
	ConnMaxClients     int       // 0 = not reported
	UserDisconnected   bool
	ActiveUsers        int   // last-fetched active session count; -1 = unknown
	ThroughputBPS      int64 // last-known throughput snapshot (bytes/s)

	// ── FLRig ─────────────────────────────────────────────────────────────────
	FlrigEnabled   bool
	FlrigHost      string
	FlrigPort      int
	FlrigDirection string // "sdr-to-rig", "rig-to-sdr", "both"
	FlrigPTTMute   bool
	FlrigPTTActive bool

	// ── Settings ──────────────────────────────────────────────────────────────
	// BrowserAutoConnect: when true, opening a browser tab (SSE subscriber
	// count 0→1) auto-connects to the last-used SDR instance, and closing all
	// tabs (count N→0) auto-disconnects.
	BrowserAutoConnect bool

	// ── Fyne widget references ────────────────────────────────────────────────
	// Held so HTTP handlers can update the GUI in sync with state changes.
	// All Fyne Set* methods are goroutine-safe.
	FreqEntry             *widget.Entry
	ModeSelect            *widget.Select
	BWSlider              *widget.Slider
	BWValueLabel          *widget.Label
	VolumeSlider          *widget.Slider
	MuteBtn               *widget.Button
	ChannelSelect         *widget.Select
	FormatGroup           *widget.RadioGroup
	DeviceSelect          *widget.Select
	AGCHangSlider         *widget.Slider
	AGCHangLabel          *widget.Label
	AGCRecSlider          *widget.Slider
	AGCRecLabel           *widget.Label
	DSPEnableCheck        *widget.Check
	DSPFilterSel          *widget.Select
	URLEntry              *widget.Entry
	PasswordEntry         *widget.Entry
	StepSelect            *widget.Select
	FlrigPTTMuteChk       *widget.Check      // flrigPTTMuteCheck widget
	FlrigEnabledChk       *widget.Check      // flrigEnabledCheck widget
	FlrigHostEnt          *widget.Entry      // flrigHostEntry widget
	FlrigPortEnt          *widget.Entry      // flrigPortEntry widget
	FlrigDirSel           *widget.RadioGroup // flrigDirSelect widget
	BrowserAutoConnectChk *widget.Check      // browserAutoConnectCheck widget
	// SuppressFormatChange is set true while the API handler is programmatically
	// changing the format radio group to prevent the OnChanged feedback loop.
	SuppressFormatChange *bool
	// SuppressTune is set true while the API tune handler is programmatically
	// updating the mode/BW/freq widgets to prevent the OnChanged feedback loop
	// from calling sendTune() with stale local variables.
	SuppressTune *bool

	// ── Recording ─────────────────────────────────────────────────────────────
	RecordingMgr *RecordingManager

	// RecordBtn is the Fyne record/stop toggle button.
	// Held so the auto-stop timer callback can reset its label/icon.
	RecordBtn *widget.Button

	// RecordStatusLabel is the status text label in the Recording card.
	// Held so API-triggered start/stop can update it.
	RecordStatusLabel *widget.Label

	// RecordFormatGroup is the format radio widget in the Recording card.
	// Held so API-triggered start can sync the selected format to the GUI.
	RecordFormatGroup *widget.RadioGroup

	// RecordTimerStop is closed to stop the live elapsed-time ticker goroutine.
	// A new channel is created each time recording starts; closing it stops the ticker.
	RecordTimerStop chan struct{}

	// ── Callbacks into main() logic ───────────────────────────────────────────
	// These are set by main() after all closures are defined, allowing HTTP
	// handlers to trigger the same actions as GUI button presses.

	// DismissBrowseDialog, if non-nil, hides the currently-open Browse Instances
	// dialog.  Set when the dialog opens, cleared when it closes.  Called by
	// OnStateChange when a connection is established so the dialog auto-dismisses
	// whether the connect was triggered from the GUI or the REST API.
	DismissBrowseDialog func()

	DoConnect    func()
	DoDisconnect func()
	// DoReconnect disconnects (suppressing auto-reconnect) then reconnects.
	// Used by the API when switching instances while already connected.
	DoReconnect            func()
	DoTune                 func()
	DoApplyFreqEntry       func()
	DoProfileConnectByName func(name string) error
	DoSendAGC              func()
	DoApplyFlrigConfig     func()
	// DoStartRecording is called by the API handler to start a recording and
	// update the GUI button.  The format argument is "pcm" or "opus".
	// This callback is intentionally a no-op wrapper — the actual recording
	// start is done by the API handler directly on RecordingMgr; this callback
	// only updates the GUI button state.
	DoStartRecording func(format string)
	// DoStopRecording is called by the API handler to stop a recording and
	// update the GUI button.
	DoStopRecording func()
}

// NewAppState creates an AppState with sensible defaults matching the GUI
// initial values.
func NewAppState() *AppState {
	return &AppState{
		CurrentFreq:            14_200_000,
		CurrentMode:            "usb",
		CurrentBW:              2700,
		StepIndex:              4, // 1 kHz
		Volume:                 100,
		ChannelMode:            "both",
		Format:                 "opus",
		AGCHangTime:            1.1,  // matches agcHangTimeDefault in main.go
		AGCRecoveryRate:        20.0, // matches agcRecoveryDefault in main.go
		DSPParams:              map[string]string{},
		FlrigHost:              "127.0.0.1",
		FlrigPort:              12345,
		FlrigDirection:         "both",
		FlrigPTTMute:           true,
		ActiveUsers:            -1,
		SignalBasebandDBFS:     -999,
		SignalNoiseDensityDBFS: -999,
		SignalSNRDB:            -999,
		SignalAudioDBFS:        -999,
		AudioGateMinSNR:        -999, // disabled by default
		BrowserAutoConnect:     true, // default enabled; overridden from prefs in main()
	}
}

// UpdateSignal stores the latest signal quality readings.
// Called from the AudioOutput onChunkPlayed callback (~100 ms rate).
func (s *AppState) UpdateSignal(basebandDBFS, noiseDensityDBFS, audioDBFS float32) {
	snr := float32(-999)
	if basebandDBFS > -998 && noiseDensityDBFS > -998 {
		snr = basebandDBFS - noiseDensityDBFS
	}
	now := time.Now()
	s.Mu.Lock()
	s.SignalBasebandDBFS = basebandDBFS
	s.SignalNoiseDensityDBFS = noiseDensityDBFS
	s.SignalSNRDB = snr
	s.SignalAudioDBFS = audioDBFS
	s.SignalUpdatedAt = &now
	s.Mu.Unlock()
}

// ClearSignal resets all signal readings to the no-data sentinel (-999).
// Called on disconnect or when entering IQ mode.
func (s *AppState) ClearSignal() {
	s.Mu.Lock()
	s.SignalBasebandDBFS = -999
	s.SignalNoiseDensityDBFS = -999
	s.SignalSNRDB = -999
	s.SignalAudioDBFS = -999
	s.SignalUpdatedAt = nil
	s.Mu.Unlock()
}

// SignalSnapshot returns a consistent copy of the current signal readings.
func (s *AppState) SignalSnapshot() (basebandDBFS, noiseDensityDBFS, snrDB, audioDBFS float32, updatedAt *time.Time) {
	s.Mu.RLock()
	defer s.Mu.RUnlock()
	return s.SignalBasebandDBFS, s.SignalNoiseDensityDBFS, s.SignalSNRDB, s.SignalAudioDBFS, s.SignalUpdatedAt
}

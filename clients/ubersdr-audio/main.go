package main

import (
	_ "embed"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/app"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/layout"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"
)

// ── flrig preference keys ──────────────────────────────────────────────────────
const (
	prefKeyFlrigEnabled   = "flrig_enabled"
	prefKeyFlrigHost      = "flrig_host"
	prefKeyFlrigPort      = "flrig_port"
	prefKeyFlrigDirection = "flrig_direction"
	prefKeyFlrigPTTMute   = "flrig_ptt_mute"
)

//go:embed ubersdr.ico
var appIcon []byte

// audioDeviceList caches the enumerated devices so the selector can map
// display names back to device IDs.  Protected by audioDeviceMu.
var (
	audioDeviceList []AudioDevice
	audioDeviceMu   sync.RWMutex
)

var modeLabels = []string{"USB", "LSB", "AM", "SAM", "FM", "CWU", "CWL", "IQ"}

// wideIQLabels lists the ordered wide (preset-bandwidth) IQ mode labels.
// These are added to modeSelect.Options only when the server permits them.
var wideIQLabels = []string{"IQ48", "IQ96", "IQ192", "IQ384"}

// bwSliderMax returns the maximum slider value (Hz) for a given mode.
func bwSliderMax(mode string) float64 {
	switch mode {
	case "am", "sam", "fm":
		return 6000
	case "iq":
		return 12000
	default:
		return 5000
	}
}

// bwDefaultSlider returns the sensible default slider position for a mode.
func bwDefaultSlider(mode string) float64 {
	switch mode {
	case "usb", "lsb":
		return 2700
	case "cwu", "cwl":
		return 600
	case "am", "sam":
		return 4000
	case "fm":
		return 5000
	case "iq":
		return 12000 // full 12 kHz total BW (±6 kHz sent to server)
	default:
		return 2700
	}
}

// bwToLoHi converts a slider value to (lo, hi) bandwidth cuts for the server.
//
//	USB/CWU: lo=0,          hi=+val
//	LSB/CWL: lo=-val,       hi=0
//	AM/FM:   lo=-val,       hi=+val   (symmetric)
//	IQ:      lo=-(val/2),   hi=+(val/2)  (slider shows total BW; server gets ±half)
//
// For IQ the slider goes up to 10 kHz (total bandwidth) but the server expects
// symmetric edges, so a 10 kHz slider value → lo=-5000, hi=+5000.
func bwToLoHi(mode string, val float64) (lo, hi int) {
	v := int(val)
	switch mode {
	case "usb", "cwu":
		return 0, v
	case "lsb", "cwl":
		return -v, 0
	case "iq":
		half := v / 2
		return -half, half
	default: // am, sam, fm
		return -v, v
	}
}

func modeKey(label string) string { return strings.ToLower(label) }

// freqSteps are in Hz; displayed labels are in kHz.
var freqSteps = []int{1, 10, 100, 500, 1_000, 10_000, 100_000, 1_000_000}

const (
	freqMinHz = 10_000     // 10 kHz
	freqMaxHz = 30_000_000 // 30 MHz
)

// clampFreq clamps hz to the valid tuning range [freqMinHz, freqMaxHz].
func clampFreq(hz int) int {
	if hz < freqMinHz {
		return freqMinHz
	}
	if hz > freqMaxHz {
		return freqMaxHz
	}
	return hz
}

// parseFreqKHz parses a kHz string (e.g. "14200" or "14200.5") and returns Hz.
func parseFreqKHz(s string) (int, error) {
	s = strings.TrimSpace(s)
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, err
	}
	return int(f * 1000), nil
}

// formatFreqKHz formats Hz as a kHz string with exactly 3 decimal places,
// giving 1 Hz resolution (e.g. 14200000 Hz → "14200.000", 14200001 Hz → "14200.001").
func formatFreqKHz(hz int) string {
	return fmt.Sprintf("%.3f", float64(hz)/1000.0)
}

func main() {
	// Raise process priority so the Go IOCP network poller thread is scheduled
	// promptly by Windows. Without this, Windows can starve the poller for several
	// seconds when the process is in the background, causing ReadMessage to block
	// and audio to go silent even though data is sitting in the kernel TCP buffer.
	setAboveNormalPriority()

	a := app.NewWithID("io.github.ka9q.ubersdr.windows-audio")
	a.Settings().SetTheme(theme.DarkTheme())
	a.SetIcon(fyne.NewStaticResource("ubersdr.ico", appIcon))

	w := a.NewWindow("UberSDR - Disconnected")

	client := NewRadioClient()

	// Start mDNS discovery in background (best-effort)
	mdns, _ := NewMDNSDiscovery()

	// ── Preference keys ───────────────────────────────────────────────────────
	const (
		prefKeyURL     = "url"
		prefKeyPass    = "password"
		prefKeyFreq    = "frequency_hz"
		prefKeyMode    = "mode"
		prefKeyBW      = "bandwidth"
		prefKeyFormat  = "format"
		prefKeyStep    = "step_index"
		prefKeyDevice  = "audio_device_id"
		prefKeyVolume  = "volume"
		prefKeyChannel = "channel_mode"
	)
	prefs := a.Preferences()

	// ── flrig sync ────────────────────────────────────────────────────────────
	flrigSync := NewFlrigSync()

	// ── State ────────────────────────────────────────────────────────────────
	currentMode := prefs.StringWithFallback(prefKeyMode, "usb")
	currentFreq := prefs.IntWithFallback(prefKeyFreq, 14_200_000) // Hz

	// Session timer state — updated when /api/description is fetched.
	sessionMaxSecs := 0 // 0 = unlimited
	var sessionTimerStop chan struct{}

	// connMaxClients holds the max_clients value from the last /api/description
	// response so the stats poller can display "active/max".  0 = not reported.
	connMaxClients := 0

	// userDisconnected is set true when the user explicitly presses Disconnect,
	// so that OnStateChange(StateError) does NOT auto-reconnect.
	userDisconnected := false

	// formatSwitching is set true while we're doing a format-change reconnect,
	// so that OnStateChange does NOT clear stationLabel during the brief disconnect.
	formatSwitching := false

	// profileSwitching is set true while loading a profile so that
	// OnStateChange(StateError) does NOT trigger the auto-reconnect countdown.
	profileSwitching := false

	// iqModeSwitching is set true while reconnecting due to an IQ mode change
	// so that rebuildModeOptions does NOT reset the mode during the brief
	// disconnect/error state.  Cleared when StateConnected fires.
	iqModeSwitching := false

	// lastAllowedIQModes caches the AllowedIQModes from the most recent
	// successful /connection response.  Used by rebuildModeOptions on
	// disconnect/error so the wide IQ mode options are preserved when the user
	// disconnects from the same instance (rather than being cleared to nil).
	// Cleared when the URL changes (connecting to a different instance).
	var lastAllowedIQModes []string

	// activeProfileName holds the name of the last profile loaded via applyProfile.
	// Empty string means no profile is active (user started fresh or changed the URL
	// manually).  Used to pre-fill the Save dialog so saving back to the same profile
	// is a single click.
	activeProfileName := ""

	// activeCallsign holds the station callsign from the last successful
	// /api/description fetch.  Stored in saved profiles so the list can show
	// a human-readable subtitle without re-fetching.
	activeCallsign := ""

	// ── Widgets ───────────────────────────────────────────────────────────────

	statusDot := NewStatusDot(dotColorGrey)
	statusLabel := widget.NewLabel("Disconnected")

	// Users label — updated every 10 s while connected; shows "👥 active/max".
	// Declared early so OnStateChange can reference it before the layout is built.
	usersLabel := widget.NewLabel("")

	// Station info — populated from /api/description after URL is set
	stationLabel := widget.NewLabel("")
	stationLabel.Wrapping = fyne.TextWrapWord

	// Single URL field — users paste the HTTP URL of the instance
	urlEntry := widget.NewEntry()
	urlEntry.SetPlaceHolder("http://ubersdr.local:8080")
	urlEntry.SetText(prefs.StringWithFallback(prefKeyURL, "http://ubersdr.local:8080"))
	// suppressProfileClear is set true while applyProfile is running so that
	// the urlEntry.OnChanged handler does not clear activeProfileName when
	// applyProfile programmatically calls urlEntry.SetText.
	suppressProfileClear := false
	urlEntry.OnChanged = func(s string) {
		prefs.SetString(prefKeyURL, s)
		// Changing the URL means we're no longer on the loaded profile's instance,
		// so clear the active profile so the Save dialog doesn't pre-fill the old name.
		// Suppressed during applyProfile so the programmatic SetText doesn't clear it.
		if !suppressProfileClear {
			activeProfileName = ""
			activeCallsign = ""
			lastAllowedIQModes = nil // different instance — clear cached IQ modes
		}
	}

	passwordEntry := widget.NewPasswordEntry()
	passwordEntry.SetPlaceHolder("(optional)")
	passwordEntry.SetText(prefs.String(prefKeyPass))
	passwordEntry.OnChanged = func(s string) { prefs.SetString(prefKeyPass, s) }

	// Frequency entry — displayed and entered in kHz.
	freqEntry := widget.NewEntry()
	freqEntry.SetText(formatFreqKHz(currentFreq))

	stepSelect := widget.NewSelect([]string{"1 Hz", "10 Hz", "100 Hz", "500 Hz", "1 kHz", "10 kHz", "100 kHz", "1 MHz"}, nil)
	stepSelect.SetSelectedIndex(prefs.IntWithFallback(prefKeyStep, 4))
	stepSelect.OnChanged = func(_ string) { prefs.SetInt(prefKeyStep, stepSelect.SelectedIndex()) }

	getStep := func() int {
		idx := stepSelect.SelectedIndex()
		if idx < 0 || idx >= len(freqSteps) {
			return 1000
		}
		return freqSteps[idx]
	}

	// Bandwidth slider — range and default depend on mode.
	savedBW := prefs.FloatWithFallback(prefKeyBW, bwDefaultSlider(currentMode))
	bwSlider := widget.NewSlider(0, bwSliderMax(currentMode))
	bwSlider.Step = 50
	bwSlider.Value = savedBW
	bwValueLabel := widget.NewLabel(fmt.Sprintf("%.0f Hz", bwSlider.Value))

	connectBtn := widget.NewButton("Connect", nil)
	connectBtn.Importance = widget.HighImportance

	// ── updateWindowTitle — sets the window title based on connection state ───
	updateWindowTitle := func() {
		if client.State() != StateConnected {
			w.SetTitle("UberSDR - Disconnected")
			return
		}
		parts := []string{}
		if activeCallsign != "" {
			parts = append(parts, activeCallsign)
		}
		parts = append(parts, formatFreqKHz(currentFreq)+" kHz")
		parts = append(parts, strings.ToUpper(currentMode))
		w.SetTitle("UberSDR - " + strings.Join(parts, " "))
	}

	// ── sendTune — sends a tune command if already connected ─────────────────
	sendTune := func() {
		if client.State() != StateConnected {
			return
		}
		lo, hi := bwToLoHi(currentMode, bwSlider.Value)
		// Wide IQ modes use server-preset bandwidth; send 0,0 as placeholder.
		if isWideIQMode(currentMode) {
			lo, hi = 0, 0
		}
		client.Frequency = currentFreq
		client.Mode = currentMode
		client.BandwidthLow = lo
		client.BandwidthHigh = hi
		if err := client.Tune(currentFreq, currentMode, lo, hi); err != nil {
			statusDot.SetColor(dotColorRed)
			statusLabel.SetText("Tune error: " + err.Error())
		}
		updateWindowTitle()
		// Push SDR→rig (debounced; no-op if disabled or direction is rig-to-sdr).
		flrigSync.PushSDRState(currentFreq, currentMode)
	}

	// ── applyFreqEntry — reads the kHz entry, updates currentFreq, tunes ─────
	applyFreqEntry := func() {
		hz, err := parseFreqKHz(freqEntry.Text)
		if err != nil {
			freqEntry.SetText(formatFreqKHz(currentFreq))
			return
		}
		hz = clampFreq(hz)
		currentFreq = hz
		prefs.SetInt(prefKeyFreq, hz)
		freqEntry.SetText(formatFreqKHz(hz))
		sendTune()
	}

	// ── applyFreqDelta — step buttons ─────────────────────────────────────────
	applyFreqDelta := func(delta int) {
		hz, err := parseFreqKHz(freqEntry.Text)
		if err != nil {
			hz = currentFreq
		}
		hz = clampFreq(hz + delta)
		currentFreq = hz
		prefs.SetInt(prefKeyFreq, hz)
		freqEntry.SetText(formatFreqKHz(hz))
		sendTune()
	}

	// Wire Enter key on frequency field.
	freqEntry.OnSubmitted = func(_ string) { applyFreqEntry() }

	downBtn := widget.NewButtonWithIcon("", theme.NavigateBackIcon(), func() { applyFreqDelta(-getStep()) })
	upBtn := widget.NewButtonWithIcon("", theme.NavigateNextIcon(), func() { applyFreqDelta(getStep()) })

	// Bandwidth slider — tune on release (OnChangeEnded fires when the user
	// releases the slider; OnChanged fires continuously while dragging).
	bwSlider.OnChanged = func(v float64) {
		bwValueLabel.SetText(fmt.Sprintf("%.0f Hz", v))
	}
	bwSlider.OnChangeEnded = func(v float64) {
		prefs.SetFloat(prefKeyBW, v)
		sendTune()
	}

	// Find the display label matching the saved mode key.
	savedModeLabel := "USB"
	for _, lbl := range modeLabels {
		if modeKey(lbl) == currentMode {
			savedModeLabel = lbl
			break
		}
	}
	// modeInitDone gates the BW reset: on the initial SetSelected call we want
	// to restore the saved BW, not overwrite it with the mode default.
	// applyIQConstraints is assigned after formatGroup is declared so the closure
	// can reference it. It enforces format/BW UI state for the current mode.
	var applyIQConstraints func()

	// suppressFormatChange is declared here (before modeSelect) so the IQ-mode
	// reconnect logic inside modeSelect.OnChanged can set it to prevent the
	// formatGroup.SetSelected call inside applyIQConstraints from triggering its
	// own reconnect.  The formatGroup var is declared later but Go closures
	// capture by reference so this is safe.
	var formatGroup *widget.RadioGroup
	suppressFormatChange := false

	modeInitDone := false
	modeSelect := widget.NewSelect(modeLabels, func(selected string) {
		prevMode := currentMode
		currentMode = modeKey(selected)
		prefs.SetString(prefKeyMode, currentMode)
		newMax := bwSliderMax(currentMode)
		bwSlider.Max = newMax
		if modeInitDone {
			// User changed the mode — reset BW to a sensible default for that mode.
			bwSlider.Value = bwDefaultSlider(currentMode)
			prefs.SetFloat(prefKeyBW, bwSlider.Value)
		}
		// else: initial SetSelected — keep the saved BW value already in bwSlider.Value
		bwSlider.Refresh()
		bwValueLabel.SetText(fmt.Sprintf("%.0f Hz", bwSlider.Value))
		// Switching to or from any IQ mode (or between IQ modes) changes the
		// sample rate; a full reconnect is required.  We check this BEFORE calling
		// applyIQConstraints so that the formatGroup.SetSelected("Uncompressed") inside
		// applyIQConstraints does not trigger its own reconnect (we suppress it via
		// suppressFormatChange and handle the reconnect ourselves here).
		// prevMode != currentMode guards against spurious reconnects when
		// rebuildModeOptions calls SetSelected to sync the dropdown to an already-active
		// wide IQ mode (e.g. after loading a profile and connecting).
		needsReconnect := modeInitDone && prevMode != currentMode &&
			client.State() == StateConnected &&
			(isIQMode(currentMode) || isIQMode(prevMode))
		if needsReconnect {
			// Suppress the format-change reconnect that applyIQConstraints would
			// otherwise trigger via formatGroup.SetSelected.
			suppressFormatChange = true
		}
		if applyIQConstraints != nil {
			applyIQConstraints()
		}
		if needsReconnect {
			suppressFormatChange = false
			iqModeSwitching = true
			formatSwitching = true // suppress stationLabel clear during brief disconnect
			// Update client fields so buildWSURL uses the new mode/bandwidth/frequency.
			lo, hi := bwToLoHi(currentMode, bwSlider.Value)
			if isWideIQMode(currentMode) {
				lo, hi = 0, 0
			}
			client.Frequency = currentFreq
			client.Mode = currentMode
			client.BandwidthLow = lo
			client.BandwidthHigh = hi
			client.ReconnectWS()
			return
		}
		sendTune()
	})
	modeSelect.SetSelected(savedModeLabel)
	modeInitDone = true

	// rebuildModeOptions rebuilds modeSelect.Options with the base modes plus any
	// wide IQ modes permitted by the server (from the last /connection response).
	// If the current mode is a wide IQ mode that is no longer in the list, it
	// resets to "usb". Must be called from the Fyne goroutine or a goroutine-safe
	// context (Fyne widget methods are goroutine-safe).
	rebuildModeOptions := func(allowedWideIQ []string) {
		// Build the permitted wide IQ label set.
		permitted := make(map[string]bool, len(allowedWideIQ))
		for _, m := range allowedWideIQ {
			permitted[strings.ToUpper(m)] = true
		}

		opts := make([]string, len(modeLabels))
		copy(opts, modeLabels)
		for _, lbl := range wideIQLabels {
			if permitted[lbl] {
				opts = append(opts, lbl)
			}
		}
		modeSelect.Options = opts
		modeSelect.Refresh()

		// Sync the dropdown selection to currentMode for any mode in the options list.
		// This is needed when a profile sets currentMode to a wide IQ mode (e.g. "iq96")
		// before the option exists in the list; once rebuildModeOptions adds it, we
		// must call SetSelected so the dropdown reflects the actual mode.
		// Also handles the reset-to-USB case when a wide IQ mode is no longer available.
		if isWideIQMode(currentMode) && !iqModeSwitching {
			stillAvailable := false
			for _, lbl := range opts {
				if modeKey(lbl) == currentMode {
					stillAvailable = true
					modeSelect.SetSelected(lbl) // sync dropdown to currentMode
					break
				}
			}
			if !stillAvailable {
				currentMode = "usb"
				prefs.SetString(prefKeyMode, currentMode)
				modeSelect.SetSelected("USB")
			}
		}

		// Apply IQ-specific UI constraints for the current mode.
		// applyIQConstraints is assigned after formatGroup is created; it may be
		// nil during the very first rebuildModeOptions call (startup), which is
		// fine because the initial mode is never an IQ mode at that point.
		if applyIQConstraints != nil {
			applyIQConstraints()
		}
	}
	savedFormat := prefs.StringWithFallback(prefKeyFormat, "Compressed")
	if savedFormat == "Uncompressed" {
		client.Format = FormatPCMZstd
	}
	formatGroup = widget.NewRadioGroup([]string{"Compressed", "Uncompressed"}, func(s string) {
		if suppressFormatChange {
			return
		}
		// Fyne's RadioGroup allows deselection by clicking the active item,
		// which calls OnChanged("").  Re-assert the current selection so the
		// group never appears empty.
		if s == "" {
			suppressFormatChange = true
			if client.Format == FormatOpus {
				formatGroup.SetSelected("Compressed")
			} else {
				formatGroup.SetSelected("Uncompressed")
			}
			suppressFormatChange = false
			return
		}
		if s == "Uncompressed" {
			// Warn the user that uncompressed uses ~4× the bandwidth.
			dialog.ShowConfirm(
				"High Bandwidth Warning",
				"Uncompressed audio uses approximately 4× more bandwidth than Compressed.\n\nThis increases costs for the instance owner. Only switch if you have a specific reason to do so.",
				func(confirmed bool) {
					if !confirmed {
						// Revert selection without triggering reconnect.
						suppressFormatChange = true
						formatGroup.SetSelected("Compressed")
						suppressFormatChange = false
						return
					}
					client.Format = FormatPCMZstd
					prefs.SetString(prefKeyFormat, "Uncompressed")
					if client.State() == StateConnected {
						formatSwitching = true
						client.Disconnect()
						go func() {
							time.Sleep(300 * time.Millisecond)
							formatSwitching = false
							client.Connect()
						}()
					}
				},
				w,
			)
			return
		}
		// Compressed selected.
		client.Format = FormatOpus
		prefs.SetString(prefKeyFormat, "Compressed")
		// If already connected, reconnect with the new format.
		// Set formatSwitching so OnStateChange doesn't clear stationLabel.
		if client.State() == StateConnected {
			formatSwitching = true
			client.Disconnect()
			go func() {
				time.Sleep(300 * time.Millisecond)
				formatSwitching = false
				client.Connect()
			}()
		}
	})
	formatGroup.SetSelected(savedFormat)
	formatGroup.Horizontal = true

	// ── Audio device selector ─────────────────────────────────────────────────
	// Populated on startup; first entry is always "Default Device".
	deviceSelect := widget.NewSelect([]string{"Default Device"}, nil)
	deviceSelect.SetSelectedIndex(0)
	deviceSelect.OnChanged = func(_ string) {
		// Persist the selected device ID so it can be restored on next launch.
		audioDeviceMu.RLock()
		idx := deviceSelect.SelectedIndex()
		var devID string
		if idx >= 0 && idx < len(audioDeviceList) {
			devID = audioDeviceList[idx].ID
		}
		audioDeviceMu.RUnlock()
		prefs.SetString(prefKeyDevice, devID)

		if client.State() != StateConnected {
			return
		}
		client.SetDevice(devID)
	}

	refreshDevicesBtn := widget.NewButtonWithIcon("Refresh", theme.ViewRefreshIcon(), nil)

	populateDevices := func() {
		devices, err := EnumerateAudioDevices()
		if err != nil || len(devices) == 0 {
			devices = []AudioDevice{{ID: "", Name: "Default Device"}}
		}
		names := make([]string, len(devices))
		for i, d := range devices {
			names[i] = d.Name
		}

		// Write the device list under its own lock (safe from any goroutine).
		audioDeviceMu.Lock()
		audioDeviceList = devices
		audioDeviceMu.Unlock()

		// Update the widget options.
		deviceSelect.Options = names

		// Restore the previously saved device ID. If it no longer exists in the
		// current device list, fall back to index 0 (system default).
		savedID := prefs.String(prefKeyDevice)
		restoredIdx := 0
		if savedID != "" {
			for i, d := range devices {
				if d.ID == savedID {
					restoredIdx = i
					break
				}
			}
		}
		deviceSelect.SetSelectedIndex(restoredIdx)
		deviceSelect.Refresh()
	}
	refreshDevicesBtn.OnTapped = populateDevices

	// Populate on startup in background so the window opens immediately
	go populateDevices()

	savedVolume := prefs.FloatWithFallback(prefKeyVolume, 100)
	muted := false
	premuteVolume := savedVolume // volume level to restore when unmuting

	volumeSlider := widget.NewSlider(0, 100)
	volumeSlider.Value = savedVolume
	volumeSlider.Step = 1

	volumeSlider.OnChanged = func(v float64) {
		premuteVolume = v
		client.SetVolume(v / 100.0)
		prefs.SetFloat(prefKeyVolume, v)
	}

	// muteBtn toggles mute; icon switches between speaker and muted-speaker.
	// While muted the slider is disabled so its value is preserved visually.
	muteBtn := widget.NewButtonWithIcon("", theme.VolumeUpIcon(), nil)
	muteBtn.OnTapped = func() {
		muted = !muted
		if muted {
			premuteVolume = volumeSlider.Value
			client.SetVolume(0)
			muteBtn.SetIcon(theme.VolumeMuteIcon())
			volumeSlider.Disable()
		} else {
			client.SetVolume(premuteVolume / 100.0)
			muteBtn.SetIcon(theme.VolumeUpIcon())
			volumeSlider.Enable()
		}
	}

	savedChannel := prefs.StringWithFallback(prefKeyChannel, "Left & Right")
	channelSelect := widget.NewSelect([]string{"Left & Right", "Left", "Right"}, func(selected string) {
		prefs.SetString(prefKeyChannel, selected)
		switch selected {
		case "Left":
			client.SetChannelMode(ChannelModeLeft)
		case "Right":
			client.SetChannelMode(ChannelModeRight)
		default:
			client.SetChannelMode(ChannelModeBoth)
		}
	})
	channelSelect.SetSelected(savedChannel)

	// Signal quality bars — declared before applyIQConstraints so the closure
	// can call SetNoData() when entering an IQ mode (which sends no signal data).
	// Signal: -120 dBFS (noise floor) → -50 dBFS (strong signal)
	// SNR:      25 dB (weak)          →  80 dB (excellent)
	// Audio:   -60 dBFS (quiet)       →   0 dBFS (full scale)
	signalBar := NewLevelBar("Signal", -120, -50, "dBFS")
	snrBar := NewLevelBar("SNR", 25, 80, "dB")
	audioBar := NewLevelBar("Audio", -60, 0, "dBFS")

	// applyIQConstraints enforces format/BW/channel UI state for the current mode.
	// Assigned here (after formatGroup, bwSlider, channelSelect, and signal bars are all created).
	applyIQConstraints = func() {
		if isIQMode(currentMode) {
			// IQ modes require lossless PCM; disable the format selector.
			suppressFormatChange = true
			formatGroup.SetSelected("Uncompressed")
			suppressFormatChange = false
			client.Format = FormatPCMZstd
			formatGroup.Disable()
			// IQ always needs both channels (I and Q); lock the channel selector.
			channelSelect.SetSelected("Left & Right")
			client.SetChannelMode(ChannelModeBoth)
			channelSelect.Disable()
			// IQ modes do not send signal quality data; clear the bars immediately
			// so they don't show stale values from the previous non-IQ mode.
			signalBar.SetNoData()
			snrBar.SetNoData()
		} else {
			formatGroup.Enable()
			channelSelect.Enable()
		}
		// Wide IQ modes use server-preset bandwidth; disable the BW slider.
		if isWideIQMode(currentMode) {
			bwSlider.Disable()
		} else {
			bwSlider.Enable()
		}
	}

	// Apply saved volume and channel mode to the client immediately so they
	// take effect on the first connection without the user having to touch the controls.
	client.SetVolume(savedVolume / 100.0)
	switch savedChannel {
	case "Left":
		client.SetChannelMode(ChannelModeLeft)
	case "Right":
		client.SetChannelMode(ChannelModeRight)
	default:
		client.SetChannelMode(ChannelModeBoth)
	}

	// ── applyInstance — fills URL field from a discovered instance ────────────
	applyInstance := func(inst DiscoveredInstance) {
		scheme := "http"
		if inst.TLS {
			scheme = "https"
		}
		urlEntry.SetText(fmt.Sprintf("%s://%s:%d", scheme, inst.Host, inst.Port))
	}

	// ── doConnect — reads current UI state and starts a new connection ────────
	// Declared as var so it can be referenced by connectAndClose (defined later
	// inside the browseBtn closure) before doConnect's body is assigned.
	// refreshDSPFromDescription is also declared here so doConnect and
	// profileConnectAndClose can call it before the DSP block assigns its body.
	var doConnect func()
	var refreshDSPFromDescription func(*InstanceDescription)
	doConnect = func() {
		rawURL := strings.TrimSpace(urlEntry.Text)
		if rawURL == "" {
			statusDot.SetColor(dotColorRed)
			statusLabel.SetText("Error: URL is required")
			return
		}

		// Set BaseURL first so FetchDescription can use it.
		client.BaseURL = rawURL

		// Fetch /api/description to get station info and session limit.
		// Server-provided default frequency and mode are only applied when the
		// user is connecting to a different URL than last time — i.e. they just
		// picked a new instance. If the URL is the same as the saved one, we
		// keep the user's own saved frequency/mode instead of overwriting them.
		sessionMaxSecs = 0 // reset before each connection
		connMaxClients = 0 // reset before each connection
		applyServerDefaults := rawURL != prefs.StringWithFallback(prefKeyURL, "")
		if desc, err := client.FetchDescription(); err == nil {
			sessionMaxSecs = desc.MaxSessionTime
			connMaxClients = desc.MaxClients
			// Apply default frequency only when switching to a new instance.
			if applyServerDefaults && desc.DefaultFrequency > 0 {
				currentFreq = desc.DefaultFrequency
				freqEntry.SetText(formatFreqKHz(currentFreq))
			}
			// Apply default mode only when switching to a new instance.
			if applyServerDefaults && desc.DefaultMode != "" {
				mk := strings.ToLower(desc.DefaultMode)
				for _, lbl := range modeLabels {
					if strings.ToLower(lbl) == mk {
						currentMode = mk
						modeSelect.SetSelected(lbl)
						newMax := bwSliderMax(currentMode)
						bwSlider.Max = newMax
						bwSlider.Value = bwDefaultSlider(currentMode)
						bwSlider.Refresh()
						bwValueLabel.SetText(fmt.Sprintf("%.0f Hz", bwSlider.Value))
						break
					}
				}
			}
			// Build station info line.
			activeCallsign = desc.Receiver.Callsign
			parts := []string{}
			if desc.Receiver.Callsign != "" {
				parts = append(parts, desc.Receiver.Callsign)
			}
			if desc.Receiver.Name != "" {
				parts = append(parts, desc.Receiver.Name)
			}
			if desc.Receiver.Location != "" {
				parts = append(parts, desc.Receiver.Location)
			}
			if len(parts) > 0 {
				stationLabel.SetText(strings.Join(parts, " · "))
			} else {
				stationLabel.SetText("")
			}
			refreshDSPFromDescription(desc)
		} else {
			refreshDSPFromDescription(nil)
		}

		hz, err := parseFreqKHz(freqEntry.Text)
		if err != nil {
			statusDot.SetColor(dotColorRed)
			statusLabel.SetText("Error: invalid frequency")
			return
		}
		hz = clampFreq(hz)
		currentFreq = hz
		prefs.SetInt(prefKeyFreq, hz)
		freqEntry.SetText(formatFreqKHz(hz))
		lo, hi := bwToLoHi(currentMode, bwSlider.Value)

		client.Password = passwordEntry.Text
		client.Frequency = hz
		client.Mode = currentMode
		client.BandwidthLow = lo
		client.BandwidthHigh = hi
		// client.Format is already set by formatGroup.OnChanged; no need to re-read here.
		// Resolve selected device ID (audioDeviceList protected by audioDeviceMu).
		client.DeviceID = ""
		audioDeviceMu.RLock()
		if idx := deviceSelect.SelectedIndex(); idx >= 0 && idx < len(audioDeviceList) {
			client.DeviceID = audioDeviceList[idx].ID
		}
		audioDeviceMu.RUnlock()
		client.SetVolume(volumeSlider.Value / 100.0)
		client.Connect()
	}

	// ── currentProfile — snapshot of all UI settings as a Profile ────────────
	currentProfile := func(name string) Profile {
		format := prefs.StringWithFallback(prefKeyFormat, "Compressed")
		channel := prefs.StringWithFallback(prefKeyChannel, "Left & Right")
		devID := prefs.String(prefKeyDevice)
		return Profile{
			Name:        name,
			URL:         strings.TrimSpace(urlEntry.Text),
			Password:    passwordEntry.Text,
			FrequencyHz: currentFreq,
			Mode:        currentMode,
			Bandwidth:   bwSlider.Value,
			Format:      format,
			StepIndex:   stepSelect.SelectedIndex(),
			DeviceID:    devID,
			Volume:      volumeSlider.Value,
			Channel:     channel,
			Callsign:    activeCallsign,
		}
	}

	// ── applyProfile — loads a Profile into all UI widgets ───────────────────
	// suppressModeInit prevents the BW slider from being reset to the mode
	// default when we programmatically call modeSelect.SetSelected.
	applyProfile := func(p Profile) {
		// Suppress the urlEntry.OnChanged clear while we programmatically set
		// widget values, then restore activeProfileName/activeCallsign at the end.
		suppressProfileClear = true
		defer func() {
			suppressProfileClear = false
		}()

		// URL / password
		urlEntry.SetText(p.URL)
		passwordEntry.SetText(p.Password)

		// Frequency
		currentFreq = p.FrequencyHz
		freqEntry.SetText(formatFreqKHz(currentFreq))
		prefs.SetInt(prefKeyFreq, currentFreq)

		// Step
		if p.StepIndex >= 0 && p.StepIndex < len(freqSteps) {
			stepSelect.SetSelectedIndex(p.StepIndex)
		}

		// Mode — temporarily disable the BW-reset logic so we can restore the
		// saved bandwidth value afterwards.
		// Search modeSelect.Options (not just modeLabels) so that wide IQ modes
		// like IQ96 that are only added after /connection are also found.
		modeInitDone = false
		for _, lbl := range modeSelect.Options {
			if modeKey(lbl) == p.Mode {
				modeSelect.SetSelected(lbl)
				break
			}
		}
		currentMode = p.Mode
		modeInitDone = true

		// Bandwidth
		bwSlider.Max = bwSliderMax(currentMode)
		bwSlider.Value = p.Bandwidth
		bwSlider.Refresh()
		bwValueLabel.SetText(fmt.Sprintf("%.0f Hz", p.Bandwidth))
		prefs.SetFloat(prefKeyBW, p.Bandwidth)

		// Format
		suppressFormatChange = true
		formatGroup.SetSelected(p.Format)
		suppressFormatChange = false
		if p.Format == "Uncompressed" {
			client.Format = FormatPCMZstd
		} else {
			client.Format = FormatOpus
		}
		prefs.SetString(prefKeyFormat, p.Format)

		// Volume
		volumeSlider.SetValue(p.Volume)
		client.SetVolume(p.Volume / 100.0)
		prefs.SetFloat(prefKeyVolume, p.Volume)

		// Channel
		channelSelect.SetSelected(p.Channel)
		prefs.SetString(prefKeyChannel, p.Channel)

		// Audio device — find by ID in the current device list.
		audioDeviceMu.RLock()
		devIdx := 0
		for i, d := range audioDeviceList {
			if d.ID == p.DeviceID {
				devIdx = i
				break
			}
		}
		audioDeviceMu.RUnlock()
		deviceSelect.SetSelectedIndex(devIdx)
		prefs.SetString(prefKeyDevice, p.DeviceID)

		// Set active profile identity last, after all SetText calls, so that
		// urlEntry.OnChanged (which clears these when suppressProfileClear is false)
		// has already fired and these values are the final ones.
		activeProfileName = p.Name
		activeCallsign = p.Callsign
	}

	// ── profileConnectAndClose — applies a profile and reconnects ─────────────
	// dlgToClose is the profiles dialog to hide before connecting (may be nil).
	// All widget values are captured here on the UI goroutine so the background
	// goroutine never needs to read Fyne widget state.
	// profileSwitching suppresses the auto-reconnect countdown in OnStateChange.
	profileConnectAndClose := func(dlgToClose dialog.Dialog) {
		if dlgToClose != nil {
			dlgToClose.Hide()
		}

		// Capture all values from widgets NOW, on the UI goroutine.
		rawURL := strings.TrimSpace(urlEntry.Text)
		password := passwordEntry.Text
		hz, err := parseFreqKHz(freqEntry.Text)
		if err != nil {
			hz = currentFreq
		}
		hz = clampFreq(hz)
		lo, hi := bwToLoHi(currentMode, bwSlider.Value)
		vol := volumeSlider.Value / 100.0
		var devID string
		audioDeviceMu.RLock()
		if idx := deviceSelect.SelectedIndex(); idx >= 0 && idx < len(audioDeviceList) {
			devID = audioDeviceList[idx].ID
		}
		audioDeviceMu.RUnlock()

		profileSwitching = true
		go func() {
			// Disconnect any existing session and wait for it to fully settle
			// before calling Connect().  Connect() silently returns if the state
			// is still StateConnecting or StateConnected, so we must be sure the
			// previous runLoop has reached StateDisconnected/StateError first.
			// We wait up to 2 s (200 × 10 ms) to give the runLoop goroutine time
			// to process the closed connection and call setState.
			if s := client.State(); s == StateConnected || s == StateConnecting {
				client.Disconnect()
				for i := 0; i < 200; i++ {
					s := client.State()
					if s == StateDisconnected || s == StateError {
						break
					}
					time.Sleep(10 * time.Millisecond)
				}
			}

			// profileSwitching must remain true until Connect() has been called
			// so that any StateError fired by the new runLoop during startup does
			// not trigger the auto-reconnect countdown.  We clear it only after
			// Connect() returns (Connect returns immediately; the flag just needs
			// to be true when OnStateChange(StateError) could fire during the
			// brief window before the WebSocket is established).
			defer func() { profileSwitching = false }()

			if rawURL == "" {
				return
			}

			// Set client fields directly — no widget reads needed.
			client.BaseURL = rawURL
			client.Password = password
			client.Frequency = hz
			client.Mode = currentMode
			client.BandwidthLow = lo
			client.BandwidthHigh = hi
			client.DeviceID = devID
			client.SetVolume(vol)

			// Fetch description for station label / session info (best-effort).
			sessionMaxSecs = 0
			connMaxClients = 0
			if desc, err := client.FetchDescription(); err == nil {
				sessionMaxSecs = desc.MaxSessionTime
				connMaxClients = desc.MaxClients
				activeCallsign = desc.Receiver.Callsign
				parts := []string{}
				if desc.Receiver.Callsign != "" {
					parts = append(parts, desc.Receiver.Callsign)
				}
				if desc.Receiver.Name != "" {
					parts = append(parts, desc.Receiver.Name)
				}
				if desc.Receiver.Location != "" {
					parts = append(parts, desc.Receiver.Location)
				}
				if len(parts) > 0 {
					stationLabel.SetText(strings.Join(parts, " · "))
				} else {
					stationLabel.SetText("")
				}
				refreshDSPFromDescription(desc)
			} else {
				refreshDSPFromDescription(nil)
			}

			client.ConnectForce()
		}()
	}

	// ── openProfilesDialog — browse, load and delete saved profiles ───────────
	openProfilesDialog := func() {
		names := ListProfiles(prefs)

		if len(names) == 0 {
			dialog.ShowInformation("Profiles",
				"No saved profiles yet.\n\nUse the Save (💾) button next to the Web button to save the current settings as a profile.",
				w)
			return
		}

		// selectedIdx tracks which row is highlighted.
		selectedIdx := -1

		var dlgRef dialog.Dialog
		var list *widget.List

		// rebuildList refreshes the list widget after a deletion.
		rebuildList := func() {
			list.Refresh()
		}

		// profiles holds the full Profile data for each name so the list can
		// show the subtitle without re-loading on every update call.
		// Orphaned entries (name in index but no data) are silently deleted.
		cleanNames := names[:0]
		var profiles []Profile
		for _, n := range names {
			if p, ok := LoadProfile(prefs, n); ok {
				cleanNames = append(cleanNames, n)
				profiles = append(profiles, p)
			} else {
				DeleteProfile(prefs, n) // remove stale index entry
			}
		}
		names = cleanNames

		if len(names) == 0 {
			dialog.ShowInformation("Profiles",
				"No saved profiles yet.\n\nUse the Save (💾) button next to the Web button to save the current settings as a profile.",
				w)
			return
		}

		list = widget.NewList(
			func() int { return len(names) },
			func() fyne.CanvasObject {
				return newProfileListRow()
			},
			func(id widget.ListItemID, obj fyne.CanvasObject) {
				row := obj.(*profileListRow)
				if id >= len(names) {
					return
				}
				p := profiles[id]

				// Build subtitle: callsign · freq kHz · MODE
				subParts := []string{}
				if p.Callsign != "" {
					subParts = append(subParts, p.Callsign)
				}
				if p.FrequencyHz > 0 {
					subParts = append(subParts, formatFreqKHz(p.FrequencyHz)+" kHz")
				}
				if p.Mode != "" {
					subParts = append(subParts, strings.ToUpper(p.Mode))
				}
				subtitle := ""
				if len(subParts) > 0 {
					subtitle = "  " + strings.Join(subParts, " · ")
				}
				row.SetContent("📋 "+names[id], subtitle)

				capturedID := id
				doLoad := func() {
					if capturedID >= len(names) {
						return
					}
					p, ok := LoadProfile(prefs, names[capturedID])
					if !ok {
						return
					}
					applyProfile(p)
					profileConnectAndClose(dlgRef)
				}
				row.OnTap = func() { list.Select(capturedID) }
				row.OnDoubleTap = doLoad
			},
		)
		list.OnSelected = func(id widget.ListItemID) {
			selectedIdx = id
		}

		deleteBtn := widget.NewButtonWithIcon("Delete", theme.DeleteIcon(), func() {
			if selectedIdx < 0 || selectedIdx >= len(names) {
				return
			}
			nameToDelete := names[selectedIdx]
			dialog.ShowConfirm(
				"Delete Profile",
				fmt.Sprintf("Delete profile %q?", nameToDelete),
				func(confirmed bool) {
					if !confirmed {
						return
					}
					DeleteProfile(prefs, nameToDelete)
					// Remove from local slices and refresh.
					names = append(names[:selectedIdx], names[selectedIdx+1:]...)
					profiles = append(profiles[:selectedIdx], profiles[selectedIdx+1:]...)
					selectedIdx = -1
					list.UnselectAll()
					rebuildList()
				},
				w,
			)
		})
		deleteBtn.Importance = widget.DangerImportance

		loadBtn := widget.NewButtonWithIcon("Load & Connect", theme.ConfirmIcon(), func() {
			if selectedIdx < 0 || selectedIdx >= len(names) {
				return
			}
			p, ok := LoadProfile(prefs, names[selectedIdx])
			if !ok {
				dialog.ShowError(fmt.Errorf("profile %q not found", names[selectedIdx]), w)
				return
			}
			if dlgRef != nil {
				dlgRef.Hide()
			}
			applyProfile(p)
			profileConnectAndClose(dlgRef)
		})
		loadBtn.Importance = widget.HighImportance

		// Give the list a fixed minimum size so it's scrollable.
		listScroll := container.NewScroll(list)
		listScroll.SetMinSize(fyne.NewSize(400, 260))

		btnRow := container.NewHBox(loadBtn, layout.NewSpacer(), deleteBtn)
		dlgContent := container.NewBorder(nil, btnRow, nil, nil, listScroll)

		dlg := dialog.NewCustom("Profiles", "Close", dlgContent, w)
		dlgRef = dlg
		dlg.Resize(fyne.NewSize(440, 380))
		dlg.Show()
	}

	// ── Browse Instances ──────────────────────────────────────────────────────
	// openBrowseDialog fetches instances and shows the browse dialog.
	// It is called both from the button and automatically on startup.
	openBrowseDialog := func() {
		// Only update the status bar when not already connected — we don't want
		// to overwrite "Connected · Unlimited" just because the user opened the
		// browse dialog while listening.
		if client.State() != StateConnected {
			statusDot.SetColor(dotColorOrange)
			statusLabel.SetText("Fetching instances…")
		}

		go func() {
			public, _ := FetchPublicInstances()
			var local []DiscoveredInstance
			if mdns != nil {
				local = mdns.Instances()
			}

			all := make([]DiscoveredInstance, 0, len(local)+len(public))
			all = append(all, local...)
			all = append(all, public...)

			if len(all) == 0 {
				if client.State() != StateConnected {
					statusDot.SetColor(dotColorRed)
					statusLabel.SetText("No instances found")
				}
				dialog.ShowInformation("Browse Instances",
					"No instances found.\nCheck your internet connection or try again.", w)
				return
			}

			sort.Slice(all, func(i, j int) bool {
				if all[i].Source != all[j].Source {
					return all[i].Source == "local"
				}
				return all[i].Name < all[j].Name
			})

			// Reset status to Disconnected only if we're not currently connected.
			if client.State() != StateConnected {
				statusDot.SetColor(dotColorRed)
				statusLabel.SetText("Disconnected")
			}

			// Build full label list (one per instance in `all`).
			labels := make([]string, len(all))
			for i, inst := range all {
				prefix := "🌐 "
				if inst.Source == "local" {
					prefix = "📡 "
				}
				labels[i] = prefix + inst.DisplayLabel()
			}

			// filtered holds indices into `all` that match the current search.
			filtered := make([]int, len(all))
			for i := range all {
				filtered[i] = i
			}

			// selectedFilteredIdx is the position within `filtered` that is selected.
			selectedFilteredIdx := -1

			// dlgRef holds the dialog so double-click can close it.
			var dlgRef dialog.Dialog

			// connectAndClose applies the chosen instance (by index into `all`)
			// and connects, disconnecting any existing session first.
			connectAndClose := func(allIdx int) {
				if allIdx < 0 || allIdx >= len(all) {
					return
				}
				applyInstance(all[allIdx])
				if dlgRef != nil {
					dlgRef.Hide()
				}
				// Run in a goroutine: disconnect if needed, then connect.
				// Use ConnectForce so that a stale StateConnecting from the
				// previous session never silently swallows the new Connect call.
				go func() {
					if s := client.State(); s == StateConnected || s == StateConnecting {
						client.Disconnect()
						// Wait up to 2 s for the runLoop to reach a terminal state.
						for i := 0; i < 200; i++ {
							s := client.State()
							if s == StateDisconnected || s == StateError {
								break
							}
							time.Sleep(10 * time.Millisecond)
						}
					}
					doConnect()
				}()
			}

			var list *widget.List
			list = widget.NewList(
				func() int { return len(filtered) },
				func() fyne.CanvasObject {
					return newDoubleTapLabel("", nil)
				},
				func(id widget.ListItemID, obj fyne.CanvasObject) {
					lbl := obj.(*doubleTapLabel)
					if id >= len(filtered) {
						return
					}
					allIdx := filtered[id]
					inst := all[allIdx]
					lbl.SetText(labels[allIdx])
					// Colour the row red when the instance is full (no available slots).
					if inst.MaxClients > 0 && inst.AvailableClients == 0 {
						lbl.Importance = widget.DangerImportance
					} else {
						lbl.Importance = widget.MediumImportance
					}
					lbl.Refresh()
					capturedID := id
					capturedAllIdx := allIdx
					// OnTap drives list.Select so the row gets its highlight.
					// Without this the label widget consumes the tap and the
					// list never sees it, so single-click selection doesn't work.
					lbl.OnTap = func() {
						list.Select(capturedID)
					}
					lbl.OnDoubleTap = func() {
						connectAndClose(capturedAllIdx)
					}
				},
			)
			list.OnSelected = func(id widget.ListItemID) {
				selectedFilteredIdx = id
			}

			// Search entry — filters the list live; Up/Down navigate; Enter selects.
			searchEntry := newKeyableEntry()
			searchEntry.SetPlaceHolder("Search callsign, name or URL…")
			searchEntry.OnChanged = func(query string) {
				q := strings.ToLower(strings.TrimSpace(query))
				selectedFilteredIdx = -1
				list.UnselectAll()
				if q == "" {
					filtered = make([]int, len(all))
					for i := range all {
						filtered[i] = i
					}
				} else {
					filtered = filtered[:0]
					for i, inst := range all {
						haystack := strings.ToLower(
							inst.Callsign + " " + inst.Name + " " + inst.Host +
								fmt.Sprintf(":%d", inst.Port),
						)
						if strings.Contains(haystack, q) {
							filtered = append(filtered, i)
						}
					}
				}
				list.Refresh()
			}
			searchEntry.OnUp = func() {
				if len(filtered) == 0 {
					return
				}
				if selectedFilteredIdx <= 0 {
					selectedFilteredIdx = len(filtered) - 1
				} else {
					selectedFilteredIdx--
				}
				list.Select(widget.ListItemID(selectedFilteredIdx))
				list.ScrollTo(widget.ListItemID(selectedFilteredIdx))
			}
			searchEntry.OnDown = func() {
				if len(filtered) == 0 {
					return
				}
				if selectedFilteredIdx < 0 || selectedFilteredIdx >= len(filtered)-1 {
					selectedFilteredIdx = 0
				} else {
					selectedFilteredIdx++
				}
				list.Select(widget.ListItemID(selectedFilteredIdx))
				list.ScrollTo(widget.ListItemID(selectedFilteredIdx))
			}
			searchEntry.OnEnter = func() {
				if selectedFilteredIdx >= 0 && selectedFilteredIdx < len(filtered) {
					connectAndClose(filtered[selectedFilteredIdx])
				}
			}

			// Give the list a fixed minimum size so it's scrollable.
			listScroll := container.NewScroll(list)
			listScroll.SetMinSize(fyne.NewSize(480, 260))

			dlgContent := container.NewBorder(searchEntry, nil, nil, nil, listScroll)

			dlg := dialog.NewCustomConfirm(
				"Browse Instances",
				"Connect",
				"Cancel",
				dlgContent,
				func(ok bool) {
					if !ok || selectedFilteredIdx < 0 || selectedFilteredIdx >= len(filtered) {
						return
					}
					connectAndClose(filtered[selectedFilteredIdx])
				},
				w,
			)
			dlgRef = dlg
			dlg.Resize(fyne.NewSize(520, 420))
			dlg.Show()
			// Focus the search entry so the user can type immediately.
			w.Canvas().Focus(searchEntry)
		}()
	}

	browseBtn := widget.NewButtonWithIcon("Browse…", theme.SearchIcon(), openBrowseDialog)
	profilesBtn := widget.NewButtonWithIcon("Profiles…", theme.ListIcon(), openProfilesDialog)

	// ── saveProfileDialog — prompt for a name and save the current settings ──
	saveProfileDialog := func() {
		nameEntry := widget.NewEntry()
		nameEntry.SetPlaceHolder("Profile name…")
		// Pre-fill with the active profile name so the user can save back to it
		// with a single click (they can still edit the name to save as a new one).
		if activeProfileName != "" {
			nameEntry.SetText(activeProfileName)
		}

		var dlg dialog.Dialog

		// doSave contains the save logic shared by the "Save" button and the
		// Enter key on the name entry.
		doSave := func() {
			name := strings.TrimSpace(nameEntry.Text)
			if !profileNameValid(name) {
				dialog.ShowError(fmt.Errorf("profile name cannot be empty"), w)
				return
			}
			// If the name matches the currently active profile, go straight to
			// the overwrite confirm — no need to check existence separately.
			if name == activeProfileName {
				dlg.Hide()
				dialog.ShowConfirm(
					"Overwrite Profile",
					fmt.Sprintf("Overwrite profile %q with the current settings?", name),
					func(confirmed bool) {
						if confirmed {
							SaveProfile(prefs, currentProfile(name))
							activeProfileName = name
						}
					},
					w,
				)
				return
			}
			// Different name — check whether it already exists.
			if _, exists := LoadProfile(prefs, name); exists {
				dlg.Hide()
				dialog.ShowConfirm(
					"Overwrite Profile",
					fmt.Sprintf("A profile named %q already exists. Overwrite it?", name),
					func(confirmed bool) {
						if confirmed {
							SaveProfile(prefs, currentProfile(name))
							activeProfileName = name
						}
					},
					w,
				)
				return
			}
			SaveProfile(prefs, currentProfile(name))
			activeProfileName = name
			dlg.Hide()
		}

		// Pressing Enter in the name field is equivalent to clicking Save.
		nameEntry.OnSubmitted = func(_ string) { doSave() }

		dlg = dialog.NewCustomConfirm(
			"Save Profile",
			"Save",
			"Cancel",
			nameEntry,
			func(ok bool) {
				if !ok {
					return
				}
				doSave()
			},
			w,
		)
		dlg.Resize(fyne.NewSize(340, 160))
		dlg.Show()
		w.Canvas().Focus(nameEntry)
	}

	saveProfileBtn := widget.NewButtonWithIcon("", theme.DocumentSaveIcon(), saveProfileDialog)
	saveProfileBtn.Importance = widget.MediumImportance

	// ── formatSessionTime — formats remaining seconds as "1h 24m 4s" etc. ────
	formatSessionTime := func(secs int) string {
		if secs <= 0 {
			return "0s"
		}
		h := secs / 3600
		m := (secs % 3600) / 60
		s := secs % 60
		if h > 0 {
			return fmt.Sprintf("%dh %dm %ds", h, m, s)
		}
		if m > 0 {
			return fmt.Sprintf("%dm %ds", m, s)
		}
		return fmt.Sprintf("%ds", s)
	}

	// stopSessionTimer stops any running countdown goroutine.
	stopSessionTimer := func() {
		if sessionTimerStop != nil {
			close(sessionTimerStop)
			sessionTimerStop = nil
		}
	}

	// ── DSP Noise Reduction ───────────────────────────────────────────────────
	// dspAvailable is set true when /api/description reports DSP is enabled on
	// the server.  The card is always shown but controls are disabled when DSP
	// is not available.
	dspAvailable := false
	dspEnabled := false // current insert state (toggled by the check)

	// suppressDSPChange prevents feedback loops when the server's dsp_status
	// response causes SetChecked/SetSelected to fire OnChanged/OnChanged again.
	suppressDSPChange := false

	// dspFilters holds the filter list fetched from the server.
	// Protected by the Fyne goroutine (all UI callbacks run on the same goroutine).
	var dspFilters []DSPFilter

	// dspStatusLabel shows the current insert state.
	dspStatusLabel := widget.NewLabel("Not available on this instance")

	// dspFilterSelect lets the user pick a filter.
	// Must use widget.NewSelect (not a struct literal) so ExtendBaseWidget is called
	// and the widget is properly initialised — struct literals produce broken dropdowns.
	dspFilterSelect := widget.NewSelect([]string{}, nil)
	dspFilterSelect.PlaceHolder = "Select filter…"
	dspFilterSelect.Disable()

	// dspEnableCheck toggles the insert on/off.
	dspEnableCheck := widget.NewCheck("Enable noise reduction", nil)
	dspEnableCheck.Disable()

	// dspApplyBtn sends the current filter selection to the server.
	dspApplyBtn := widget.NewButton("Apply", nil)
	dspApplyBtn.Disable()

	// updateDSPUI refreshes the DSP card state based on dspAvailable/dspEnabled.
	updateDSPUI := func() {
		if !dspAvailable {
			dspEnableCheck.Disable()
			dspFilterSelect.Disable()
			dspApplyBtn.Disable()
			dspStatusLabel.SetText("Not available on this instance")
			return
		}
		if client.State() != StateConnected {
			dspEnableCheck.Disable()
			dspFilterSelect.Disable()
			dspApplyBtn.Disable()
			if dspEnabled {
				dspStatusLabel.SetText("Active (disconnected)")
			} else {
				dspStatusLabel.SetText("Available on this instance — connect to enable")
			}
			return
		}
		// Connected and DSP available: enable the filter selector always so the
		// user can pick a filter before (or after) enabling the insert.
		dspEnableCheck.Enable()
		dspFilterSelect.Enable()
		if dspEnabled {
			dspApplyBtn.Enable()
			dspStatusLabel.SetText("Active")
		} else {
			dspApplyBtn.Disable()
			dspStatusLabel.SetText("Available — check the box to activate")
		}
	}

	// Wire the enable check.
	// suppressDSPChange guards against the feedback loop where OnDSPStatus
	// calls SetChecked → fires OnChanged → sends set_dsp → server sends
	// dsp_status → OnDSPStatus → SetChecked → ... (infinite loop).
	// All Fyne OnChanged callbacks fire on the UI goroutine, so this bool
	// is only ever read/written on the UI goroutine — no race condition.
	dspEnableCheck.OnChanged = func(checked bool) {
		if suppressDSPChange {
			return
		}
		dspEnabled = checked
		if client.State() != StateConnected {
			updateDSPUI()
			return
		}
		if checked {
			filter := dspFilterSelect.Selected
			if filter == "" && len(dspFilters) > 0 {
				filter = dspFilters[0].Name
				suppressDSPChange = true
				dspFilterSelect.SetSelected(filter)
				suppressDSPChange = false
			}
			_ = client.SendSetDSP(true, filter, nil)
		} else {
			_ = client.SendSetDSP(false, "", nil)
		}
		updateDSPUI()
	}

	// Wire the filter selector — when the insert is active, changing the filter
	// immediately re-sends set_dsp with the new selection.
	dspFilterSelect.OnChanged = func(selected string) {
		if suppressDSPChange {
			return
		}
		if client.State() != StateConnected || !dspEnabled || selected == "" {
			return
		}
		_ = client.SendSetDSP(true, selected, nil)
	}

	// Wire the Apply button — re-sends set_dsp with the selected filter.
	// Useful when the user wants to switch filters while the insert is active.
	dspApplyBtn.OnTapped = func() {
		if client.State() != StateConnected || !dspEnabled {
			return
		}
		filter := dspFilterSelect.Selected
		if filter == "" {
			return
		}
		_ = client.SendSetDSP(true, filter, nil)
	}

	// Wire DSP callbacks from the client.
	// These callbacks fire from the WebSocket receive goroutine.
	// Only use goroutine-safe Fyne methods here (SetSelected, SetText, Enable,
	// Disable, Refresh).  Do NOT write dspFilterSelect.Options from here —
	// the filter list is already populated from /api/description on the UI
	// goroutine in refreshDSPFromDescription, and overwriting it from the
	// receive goroutine causes a data race that corrupts the dropdown.
	client.OnDSPFilters = func(resp DSPFiltersResponse) {
		if !resp.Available {
			// Container unreachable — keep dspAvailable and the filter list
			// as-is (set from /api/description) so the dropdown stays usable.
			dspFilters = nil
			dspStatusLabel.SetText("DSP container unreachable on this instance")
			updateDSPUI()
			return
		}
		// Store the richer filter data (parameter details) for future use.
		// Do NOT touch dspFilterSelect.Options — the list is already correct
		// from /api/description.
		dspFilters = resp.Filters
		updateDSPUI()
	}

	client.OnDSPStatus = func(enabled bool, filter string) {
		// This fires from the WebSocket receive goroutine as a server confirmation.
		// Do NOT call SetChecked here — it would post OnChanged to the UI event
		// queue, which fires after suppressDSPChange is already cleared, causing
		// the feedback loop again.  The client already set dspEnabled correctly
		// when the user clicked the checkbox; we just need to sync the filter name.
		suppressDSPChange = true
		if enabled && filter != "" {
			dspFilterSelect.SetSelected(filter)
		}
		suppressDSPChange = false
		// Sync dspEnabled to server-confirmed state (in case it differs).
		dspEnabled = enabled
		updateDSPUI()
	}

	// refreshDSPFromDescription updates DSP availability from the last /api/description
	// response.  Called after each successful FetchDescription.
	refreshDSPFromDescription = func(desc *InstanceDescription) {
		if desc == nil {
			dspAvailable = false
		} else {
			dspAvailable = desc.DSP.Enabled
			if dspAvailable && len(desc.DSP.Filters) > 0 {
				// Pre-populate the filter selector from the description so it's
				// available before the user requests get_dsp_filters.
				names := desc.DSP.Filters
				dspFilterSelect.Options = names
				if dspFilterSelect.Selected == "" && len(names) > 0 {
					dspFilterSelect.SetSelected(names[0])
				}
				dspFilterSelect.Refresh()
			}
		}
		updateDSPUI()
	}

	dspBox := container.NewVBox(
		container.NewBorder(nil, nil, dspEnableCheck, dspApplyBtn, dspFilterSelect),
		dspStatusLabel,
	)

	// ── Callbacks ─────────────────────────────────────────────────────────────
	client.OnStateChange = func(state ConnectionState, msg string) {
		switch state {
		case StateConnected:
			iqModeSwitching = false // IQ mode reconnect completed successfully
			lastAllowedIQModes = client.AllowedIQModes()
			rebuildModeOptions(lastAllowedIQModes)
			updateWindowTitle()
			connectBtn.SetText("Disconnect")
			connectBtn.Importance = widget.DangerImportance
			statusDot.SetColor(dotColorGreen)
			// Request DSP filter list from server (response arrives via OnDSPFilters callback).
			// Only request if DSP is available on this server (known from /api/description).
			if dspAvailable {
				go func() { _ = client.SendGetDSPFilters() }()
			}
			updateDSPUI()
			// Fetch /stats immediately on connect so the user count appears right away
			// rather than waiting up to 10 s for the ticker to fire.
			go func() {
				if active, err := client.FetchStats(); err == nil {
					max := connMaxClients
					if max > 0 {
						usersLabel.SetText(fmt.Sprintf("%d/%d users", active, max))
					} else {
						usersLabel.SetText(fmt.Sprintf("%d users", active))
					}
				}
			}()
			// Override sessionMaxSecs with the per-user value from /connection.
			// This already has the bypass override applied (0 for bypassed users),
			// unlike /api/description which always returns the globally configured value.
			stopSessionTimer()
			sessionMaxSecs = client.ConnMaxSessionTime()
			if sessionMaxSecs > 0 {
				sessionTimerStop = make(chan struct{})
				stopCh := sessionTimerStop
				remaining := sessionMaxSecs
				statusLabel.SetText(fmt.Sprintf("Connected · %s", formatSessionTime(remaining)))
				go func() {
					ticker := time.NewTicker(time.Second)
					defer ticker.Stop()
					for {
						select {
						case <-stopCh:
							return
						case <-ticker.C:
							remaining--
							if remaining <= 0 {
								statusDot.SetColor(dotColorOrange)
								statusLabel.SetText("Session time expired")
								return
							}
							txt := fmt.Sprintf("Connected · %s", formatSessionTime(remaining))
							if remaining <= 300 { // ≤ 5 minutes
								statusDot.SetColor(dotColorOrange)
								txt = fmt.Sprintf("Connected · %s", formatSessionTime(remaining))
							}
							statusLabel.SetText(txt)
						}
					}
				}()
			} else {
				// 0 = unlimited (bypassed user or server has no session limit configured)
				statusLabel.SetText("Connected · Unlimited")
			}
		case StateConnecting:
			stopSessionTimer()
			statusDot.SetColor(dotColorOrange)
			statusLabel.SetText("Connecting…")
			connectBtn.SetText("Cancel")
			connectBtn.Importance = widget.MediumImportance
		case StateError:
			dspEnabled = false
			dspEnableCheck.SetChecked(false)
			updateDSPUI()
			rebuildModeOptions(lastAllowedIQModes)
			stopSessionTimer()
			w.SetTitle("UberSDR - Disconnected")
			statusDot.SetColor(dotColorRed)
			txt := "Error"
			if msg != "" {
				txt += ": " + msg
			}
			statusLabel.SetText(txt)
			connectBtn.SetText("Connect")
			connectBtn.Importance = widget.HighImportance
			signalBar.SetNoData()
			snrBar.SetNoData()
			audioBar.SetNoData()
			if !formatSwitching && !profileSwitching {
				stationLabel.SetText("")
			}
			// Auto-reconnect after 5 s unless the user explicitly disconnected
			// or we are in the middle of a profile-load reconnect.
			if !userDisconnected && !profileSwitching {
				go func() {
					for i := 5; i > 0; i-- {
						statusDot.SetColor(dotColorOrange)
						statusLabel.SetText(fmt.Sprintf("Reconnecting in %ds…", i))
						time.Sleep(time.Second)
					}
					if !userDisconnected {
						doConnect()
					}
				}()
			}
		default:
			dspEnabled = false
			dspEnableCheck.SetChecked(false)
			updateDSPUI()
			rebuildModeOptions(lastAllowedIQModes)
			stopSessionTimer()
			w.SetTitle("UberSDR - Disconnected")
			statusDot.SetColor(dotColorRed)
			statusLabel.SetText("Disconnected")
			connectBtn.SetText("Connect")
			connectBtn.Importance = widget.HighImportance
			signalBar.SetNoData()
			snrBar.SetNoData()
			audioBar.SetNoData()
			if !formatSwitching {
				stationLabel.SetText("")
			}
		}
		connectBtn.Refresh()
	}

	client.OnSignalQuality = func(basebandPower, noiseDensity float32) {
		// IQ modes do not provide meaningful signal/SNR data; keep bars cleared.
		if isIQMode(currentMode) {
			return
		}
		const noData = float32(-999)
		if basebandPower > noData {
			signalBar.SetValue(float64(basebandPower))
		} else {
			signalBar.SetNoData()
		}
		if noiseDensity > noData && basebandPower > noData {
			snr := float64(basebandPower - noiseDensity)
			snrBar.SetValue(snr)
		} else {
			snrBar.SetNoData()
		}
	}

	client.OnAudioLevel = func(dBFS float32) {
		audioBar.SetValue(float64(dBFS))
	}

	connectBtn.OnTapped = func() {
		switch client.State() {
		case StateConnected, StateConnecting:
			userDisconnected = true
			client.Disconnect()
		default:
			userDisconnected = false
			doConnect()
		}
	}

	// Pressing Enter in the URL or password field behaves like clicking Connect.
	connectOrDisconnect := func() { connectBtn.OnTapped() }
	urlEntry.OnSubmitted = func(_ string) { connectOrDisconnect() }
	passwordEntry.OnSubmitted = func(_ string) { connectOrDisconnect() }

	// ── Layout ────────────────────────────────────────────────────────────────

	// "Web" button — opens the current URL in the default browser.
	webBtn := widget.NewButtonWithIcon("Web", theme.ComputerIcon(), func() {
		raw := strings.TrimSpace(urlEntry.Text)
		if raw == "" {
			return
		}
		if !strings.Contains(raw, "://") {
			raw = "http://" + raw
		}
		u, err := url.Parse(raw)
		if err != nil {
			return
		}
		_ = a.OpenURL(u)
	})

	// URL row: entry expands; Save Profile (💾) and Web buttons pinned to the right.
	urlRow := container.NewBorder(nil, nil, nil,
		container.NewHBox(saveProfileBtn, webBtn),
		urlEntry,
	)

	// Server section — URL field + browse/profiles buttons
	serverGrid := container.New(layout.NewFormLayout(),
		widget.NewLabel("URL"), urlRow,
		widget.NewLabel("Password"), passwordEntry,
		widget.NewLabel(""), container.NewHBox(browseBtn, profilesBtn),
		widget.NewLabel("Instance"), stationLabel,
	)

	// Frequency: label | entry (fixed width) | ✓ | (gap) | ◀ stepSelect ▶  — all on one row.
	// The ✓ button lets mouse-only users apply a typed frequency without pressing Enter.
	// Wrap freqEntry in a GridWrap container to enforce a minimum display width.
	freqApplyBtn := widget.NewButtonWithIcon("", theme.ConfirmIcon(), func() { applyFreqEntry() })
	freqEntryFixed := container.New(layout.NewGridWrapLayout(fyne.NewSize(120, 36)), freqEntry)
	freqRow := container.NewHBox(
		widget.NewLabel("Frequency (kHz)"),
		freqEntryFixed,
		freqApplyBtn,
		widget.NewLabel("  "), // visual gap between apply and step buttons
		downBtn,
		stepSelect,
		upBtn,
	)

	// Fixed labels/controls on the left; slider expands to fill remaining space.
	bwGrid := container.NewBorder(
		nil, nil,
		container.NewHBox(
			widget.NewLabel("Mode"), modeSelect,
			widget.NewLabel("  Bandwidth"), bwValueLabel,
		),
		nil,
		bwSlider,
	)

	// Audio
	deviceRow := container.NewBorder(nil, nil, nil, refreshDevicesBtn, deviceSelect)
	audioBox := container.NewVBox(
		container.New(layout.NewFormLayout(),
			widget.NewLabel("Output Device"), deviceRow,
			widget.NewLabel("Format"), formatGroup,
		),
		container.NewBorder(nil, nil, muteBtn, channelSelect, volumeSlider),
		signalBar,
		snrBar,
		audioBar,
	)

	// ── flrig sync UI ─────────────────────────────────────────────────────────

	// Status dot + label for flrig connection state.
	flrigDot := NewStatusDot(dotColorGrey)
	flrigStatusLabel := widget.NewLabel("Disabled")
	flrigStatusLabel.Wrapping = fyne.TextWrapWord

	// PTT indicator badge — green "RX" / red "TX".
	flrigPTTBadge := NewPTTBadge()

	// Restore saved flrig preferences.
	flrigEnabledSaved := prefs.BoolWithFallback(prefKeyFlrigEnabled, false)
	flrigHostSaved := prefs.StringWithFallback(prefKeyFlrigHost, "127.0.0.1")
	flrigPortSaved := prefs.IntWithFallback(prefKeyFlrigPort, 12345)
	flrigDirSaved := prefs.StringWithFallback(prefKeyFlrigDirection, "both")
	flrigPTTMuteSaved := prefs.BoolWithFallback(prefKeyFlrigPTTMute, true)

	// volumeBeforePTT remembers the volume level to restore after TX ends.
	volumeBeforePTT := volumeSlider.Value

	// applyFlrigConfig pushes the current UI values into FlrigSync and persists them.
	// Called whenever any flrig setting changes.
	// flrigWidgetsReady is set true once all widgets are assigned so that the
	// OnChanged callbacks fired during widget construction are no-ops.
	flrigWidgetsReady := false
	var flrigEnabledCheck *widget.Check // forward-declared so applyFlrigConfig can read it
	var flrigHostEntry *widget.Entry
	var flrigPortEntry *widget.Entry
	var flrigDirSelect *widget.RadioGroup
	var flrigPTTMuteCheck *widget.Check

	applyFlrigConfig := func() {
		if !flrigWidgetsReady {
			return
		}
		enabled := flrigEnabledCheck.Checked
		host := strings.TrimSpace(flrigHostEntry.Text)
		if host == "" {
			host = "127.0.0.1"
		}
		portStr := strings.TrimSpace(flrigPortEntry.Text)
		port, err := strconv.Atoi(portStr)
		if err != nil || port < 1 || port > 65535 {
			port = 12345
		}
		dir := flrigDirSelect.Selected
		if dir == "" {
			dir = "both"
		}
		pttMute := flrigPTTMuteCheck.Checked

		prefs.SetBool(prefKeyFlrigEnabled, enabled)
		prefs.SetString(prefKeyFlrigHost, host)
		prefs.SetInt(prefKeyFlrigPort, port)
		prefs.SetString(prefKeyFlrigDirection, dir)
		prefs.SetBool(prefKeyFlrigPTTMute, pttMute)

		flrigSync.Configure(host, port, dir, enabled)

		if !enabled {
			flrigDot.SetColor(dotColorGrey)
			flrigStatusLabel.SetText("Disabled")
		}
	}

	// Wire flrig callbacks — these are called from the FlrigSync poll goroutine.
	flrigSync.OnStatus = func(connected bool, msg string) {
		if connected {
			flrigDot.SetColor(dotColorGreen)
		} else {
			flrigDot.SetColor(dotColorRed)
		}
		flrigStatusLabel.SetText(msg)
	}

	flrigSync.OnPTT = func(active bool) {
		if active {
			flrigPTTBadge.SetTX(true)
			// Mute the SDR during TX if PTT-mute is enabled.
			if flrigPTTMuteCheck.Checked {
				volumeBeforePTT = volumeSlider.Value
				client.SetVolume(0)
			}
		} else {
			flrigPTTBadge.SetTX(false)
			// Restore volume when returning to RX.
			if flrigPTTMuteCheck.Checked {
				client.SetVolume(volumeBeforePTT / 100.0)
			}
		}
	}

	flrigSync.OnFreqMode = func(hz int, sdrMode string) {
		// Guard: only apply if the mode is one we know about.
		knownMode := false
		for _, lbl := range modeLabels {
			if modeKey(lbl) == sdrMode {
				knownMode = true
				break
			}
		}

		currentFreq = hz
		prefs.SetInt(prefKeyFreq, hz)
		freqEntry.SetText(formatFreqKHz(hz))

		if knownMode && sdrMode != currentMode {
			currentMode = sdrMode
			prefs.SetString(prefKeyMode, sdrMode)
			for _, lbl := range modeLabels {
				if modeKey(lbl) == sdrMode {
					modeInitDone = false
					modeSelect.SetSelected(lbl)
					modeInitDone = true
					newMax := bwSliderMax(currentMode)
					bwSlider.Max = newMax
					bwSlider.Value = bwDefaultSlider(currentMode)
					bwSlider.Refresh()
					bwValueLabel.SetText(fmt.Sprintf("%.0f Hz", bwSlider.Value))
					break
				}
			}
		}

		// Tune the SDR to the new frequency/mode from flrig.
		// sendTune calls PushSDRState, but FlrigSync's echo prevention
		// (lastSdrFreq/lastSdrMode already stamped in poll()) will suppress
		// the round-trip push back to flrig.
		if client.State() == StateConnected {
			lo, hi := bwToLoHi(currentMode, bwSlider.Value)
			client.Frequency = currentFreq
			client.Mode = currentMode
			client.BandwidthLow = lo
			client.BandwidthHigh = hi
			_ = client.Tune(currentFreq, currentMode, lo, hi)
			updateWindowTitle()
		}
	}

	// Build flrig UI widgets now that the callbacks are wired.
	flrigEnabledCheck = widget.NewCheck("Enable FLRig sync", func(checked bool) {
		applyFlrigConfig()
	})
	flrigEnabledCheck.SetChecked(flrigEnabledSaved)

	flrigHostEntry = widget.NewEntry()
	flrigHostEntry.SetPlaceHolder("127.0.0.1")
	flrigHostEntry.SetText(flrigHostSaved)
	flrigHostEntry.OnSubmitted = func(_ string) { applyFlrigConfig() }

	flrigPortEntry = widget.NewEntry()
	flrigPortEntry.SetPlaceHolder("12345")
	flrigPortEntry.SetText(strconv.Itoa(flrigPortSaved))
	flrigPortEntry.OnSubmitted = func(_ string) { applyFlrigConfig() }

	flrigDirSelect = widget.NewRadioGroup(
		[]string{"rig-to-sdr", "sdr-to-rig", "both"},
		func(_ string) { applyFlrigConfig() },
	)
	flrigDirSelect.Horizontal = true
	flrigDirSelect.SetSelected(flrigDirSaved)

	flrigPTTMuteCheck = widget.NewCheck("Mute during TX", func(_ bool) {
		applyFlrigConfig()
	})
	flrigPTTMuteCheck.SetChecked(flrigPTTMuteSaved)

	flrigApplyBtn := widget.NewButton("Apply", func() { applyFlrigConfig() })

	flrigStatusRow := container.NewBorder(nil, nil,
		flrigDot,
		container.NewHBox(widget.NewLabel("PTT:"), flrigPTTBadge),
		flrigStatusLabel,
	)

	flrigBox := container.NewVBox(
		flrigEnabledCheck,
		container.New(layout.NewFormLayout(),
			widget.NewLabel("Host"), flrigHostEntry,
			widget.NewLabel("Port"), flrigPortEntry,
			widget.NewLabel("Direction"), flrigDirSelect,
		),
		container.NewHBox(flrigPTTMuteCheck, layout.NewSpacer(), flrigApplyBtn),
		flrigStatusRow,
	)

	// All flrig widgets are now assigned — enable the config callback and apply.
	flrigWidgetsReady = true
	applyFlrigConfig()

	// Start the flrig background goroutines.
	flrigSync.Start()

	// Throughput label — updated every second while connected.
	throughputLabel := widget.NewLabel("")

	// Status + connect row (pinned to bottom).
	// The dot is pinned to the left; the label expands; users+throughput+button pinned right.
	bottomBar := container.NewBorder(nil, nil,
		statusDot,
		container.NewHBox(usersLabel, throughputLabel, connectBtn),
		statusLabel,
	)

	// Main scrollable body
	body := container.NewVBox(
		widget.NewCard("Instance", "", serverGrid),
		widget.NewCard("Frequency", "", container.NewVBox(freqRow, bwGrid)),
		widget.NewCard("Audio", "", audioBox),
		widget.NewCard("Noise Reduction", "", dspBox),
		widget.NewCard("FLRig Sync", "", flrigBox),
	)

	// Full window: scrollable body + fixed status bar at bottom
	content := container.NewBorder(
		nil,
		container.NewVBox(newWhiteSeparator(), bottomBar),
		nil, nil,
		container.NewScroll(body),
	)

	w.SetContent(content)
	w.Resize(fyne.NewSize(580, 780))

	w.SetOnClosed(func() {
		flrigSync.Stop()
		if mdns != nil {
			mdns.Stop()
		}
		cleanupOpusDLL()
	})

	// Throughput + users ticker — runs every second; polls /stats every 10 s.
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		statsTick := 0
		for range ticker.C {
			if client.State() == StateConnected {
				bps := client.BytesReceivedAndReset()
				var txt string
				switch {
				case bps >= 1_000_000:
					txt = fmt.Sprintf("%.1f MB/s", float64(bps)/1_000_000)
				case bps >= 1_000:
					txt = fmt.Sprintf("%.0f kB/s", float64(bps)/1_000)
				default:
					txt = fmt.Sprintf("%d B/s", bps)
				}
				throughputLabel.SetText(txt)

				// Poll /stats every 10 seconds.
				statsTick++
				if statsTick >= 10 {
					statsTick = 0
					if active, err := client.FetchStats(); err == nil {
						max := connMaxClients
						if max > 0 {
							usersLabel.SetText(fmt.Sprintf("%d/%d users", active, max))
						} else {
							usersLabel.SetText(fmt.Sprintf("%d users", active))
						}
					}
				}
			} else {
				throughputLabel.SetText("")
				usersLabel.SetText("")
				statsTick = 0
				client.BytesReceivedAndReset() // drain counter
			}
		}
	}()

	// Auto-open the Browse Instances dialog shortly after the window appears.
	go func() {
		time.Sleep(300 * time.Millisecond)
		openBrowseDialog()
	}()

	w.ShowAndRun()
}

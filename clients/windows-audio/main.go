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

//go:embed ubersdr.ico
var appIcon []byte

// audioDeviceList caches the enumerated devices so the selector can map
// display names back to device IDs.  Protected by audioDeviceMu.
var (
	audioDeviceList []AudioDevice
	audioDeviceMu   sync.RWMutex
)

var modeLabels = []string{"USB", "LSB", "AM", "FM", "CWU", "CWL"}

// bwSliderMax returns the maximum slider value (Hz) for a given mode.
func bwSliderMax(mode string) float64 {
	switch mode {
	case "am", "fm":
		return 6000
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
	case "am":
		return 4000
	case "fm":
		return 5000
	default:
		return 2700
	}
}

// bwToLoHi converts a slider value to (lo, hi) bandwidth cuts for the server.
//
//	USB/CWU: lo=0,        hi=+val
//	LSB/CWL: lo=-val,     hi=0
//	AM/FM:   lo=-val,     hi=+val  (symmetric)
func bwToLoHi(mode string, val float64) (lo, hi int) {
	v := int(val)
	switch mode {
	case "usb", "cwu":
		return 0, v
	case "lsb", "cwl":
		return -v, 0
	default: // am, fm
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

	w := a.NewWindow("UberSDR Audio Client")

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

	// ── State ────────────────────────────────────────────────────────────────
	currentMode := prefs.StringWithFallback(prefKeyMode, "usb")
	currentFreq := prefs.IntWithFallback(prefKeyFreq, 14_200_000) // Hz

	// Session timer state — updated when /api/description is fetched.
	sessionMaxSecs := 0 // 0 = unlimited
	var sessionTimerStop chan struct{}

	// userDisconnected is set true when the user explicitly presses Disconnect,
	// so that OnStateChange(StateError) does NOT auto-reconnect.
	userDisconnected := false

	// formatSwitching is set true while we're doing a format-change reconnect,
	// so that OnStateChange does NOT clear stationLabel during the brief disconnect.
	formatSwitching := false

	// ── Widgets ───────────────────────────────────────────────────────────────

	statusDot := NewStatusDot(dotColorGrey)
	statusLabel := widget.NewLabel("Disconnected")

	// Station info — populated from /api/description after URL is set
	stationLabel := widget.NewLabel("")
	stationLabel.Wrapping = fyne.TextWrapWord

	// Single URL field — users paste the HTTP URL of the instance
	urlEntry := widget.NewEntry()
	urlEntry.SetPlaceHolder("http://ubersdr.local:8080")
	urlEntry.SetText(prefs.StringWithFallback(prefKeyURL, "http://ubersdr.local:8080"))
	urlEntry.OnChanged = func(s string) { prefs.SetString(prefKeyURL, s) }

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

	// ── sendTune — sends a tune command if already connected ─────────────────
	sendTune := func() {
		if client.State() != StateConnected {
			return
		}
		lo, hi := bwToLoHi(currentMode, bwSlider.Value)
		client.Frequency = currentFreq
		client.Mode = currentMode
		client.BandwidthLow = lo
		client.BandwidthHigh = hi
		if err := client.Tune(currentFreq, currentMode, lo, hi); err != nil {
			statusDot.SetColor(dotColorRed)
			statusLabel.SetText("Tune error: " + err.Error())
		}
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
	modeInitDone := false
	modeSelect := widget.NewSelect(modeLabels, func(selected string) {
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
		sendTune()
	})
	modeSelect.SetSelected(savedModeLabel)
	modeInitDone = true

	// Declare formatGroup as var so the closure can reference it before assignment.
	// suppressFormatChange prevents reconnect when reverting the selection programmatically.
	var formatGroup *widget.RadioGroup
	suppressFormatChange := false
	savedFormat := prefs.StringWithFallback(prefKeyFormat, "Compressed")
	if savedFormat == "Uncompressed" {
		client.Format = FormatPCMZstd
	}
	formatGroup = widget.NewRadioGroup([]string{"Compressed", "Uncompressed"}, func(s string) {
		if suppressFormatChange {
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

	// Signal quality bars
	// Signal: -120 dBFS (noise floor) → -50 dBFS (strong signal)
	// SNR:      25 dB (weak)          →  80 dB (excellent)
	// Audio:   -60 dBFS (quiet)       →   0 dBFS (full scale)
	signalBar := NewLevelBar("Signal", -120, -50, "dBFS")
	snrBar := NewLevelBar("SNR", 25, 80, "dB")
	audioBar := NewLevelBar("Audio", -60, 0, "dBFS")

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
	var doConnect func()
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
		applyServerDefaults := rawURL != prefs.StringWithFallback(prefKeyURL, "")
		if desc, err := client.FetchDescription(); err == nil {
			sessionMaxSecs = desc.MaxSessionTime
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
				go func() {
					if s := client.State(); s == StateConnected || s == StateConnecting {
						client.Disconnect()
						// Wait up to 500 ms for the disconnect to complete.
						for i := 0; i < 50; i++ {
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
					lbl.SetText(labels[allIdx])
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
				"Use Selected",
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

	browseBtn := widget.NewButtonWithIcon("Browse Instances…", theme.SearchIcon(), openBrowseDialog)

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

	// ── Callbacks ─────────────────────────────────────────────────────────────
	client.OnStateChange = func(state ConnectionState, msg string) {
		switch state {
		case StateConnected:
			connectBtn.SetText("Disconnect")
			connectBtn.Importance = widget.DangerImportance
			statusDot.SetColor(dotColorGreen)
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
			stopSessionTimer()
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
			if !formatSwitching {
				stationLabel.SetText("")
			}
			// Auto-reconnect after 5 s unless the user explicitly disconnected.
			if !userDisconnected {
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
			stopSessionTimer()
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

	var audioLevelLastUpdate time.Time
	client.OnAudioLevel = func(dBFS float32) {
		now := time.Now()
		if now.Sub(audioLevelLastUpdate) < 100*time.Millisecond {
			return
		}
		audioLevelLastUpdate = now
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

	// URL row: entry expands, Web button pinned to the right.
	urlRow := container.NewBorder(nil, nil, nil, webBtn, urlEntry)

	// Server section — URL field + browse button
	serverGrid := container.New(layout.NewFormLayout(),
		widget.NewLabel("URL"), urlRow,
		widget.NewLabel("Password"), passwordEntry,
		widget.NewLabel(""), browseBtn,
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

	// Throughput label — updated every second while connected.
	throughputLabel := widget.NewLabel("")

	// Status + connect row (pinned to bottom).
	// The dot is pinned to the left; the label expands; throughput+button pinned right.
	bottomBar := container.NewBorder(nil, nil,
		statusDot,
		container.NewHBox(throughputLabel, connectBtn),
		statusLabel,
	)

	// Main scrollable body
	body := container.NewVBox(
		widget.NewCard("Server", "", serverGrid),
		widget.NewCard("Frequency", "", container.NewVBox(freqRow, bwGrid)),
		widget.NewCard("Audio", "", audioBox),
	)

	// Full window: scrollable body + fixed status bar at bottom
	content := container.NewBorder(
		nil,
		container.NewVBox(widget.NewSeparator(), bottomBar),
		nil, nil,
		container.NewScroll(body),
	)

	w.SetContent(content)
	w.Resize(fyne.NewSize(580, 700))

	w.SetOnClosed(func() {
		if mdns != nil {
			mdns.Stop()
		}
		cleanupOpusDLL()
	})

	// Throughput ticker — samples bytes received every second while connected.
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
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
			} else {
				throughputLabel.SetText("")
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

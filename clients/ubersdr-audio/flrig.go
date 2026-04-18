package main

// flrig.go — bidirectional frequency/mode sync with flrig via XML-RPC.
//
// flrig exposes an XML-RPC server (default port 12345) at http://host:port/RPC2.
// This implementation mirrors the logic in the Firefox extension's background.js
// but is adapted for a single-instance Go desktop client (VFO A only).
//
// Sync directions:
//   "sdr-to-rig" — SDR tunes → push to flrig only
//   "rig-to-sdr" — flrig changes → update SDR only
//   "both"       — bidirectional with echo prevention

import (
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ── Mode mapping ───────────────────────────────────────────────────────────────

var flrigToSDR = map[string]string{
	"USB":   "usb",
	"LSB":   "lsb",
	"CW":    "cwu",
	"CWR":   "cwl",
	"CWL":   "cwl",
	"AM":    "am",
	"SAM":   "sam",
	"FM":    "fm",
	"NFM":   "fm",
	"WFM":   "fm",
	"RTTY":  "usb",
	"PSK31": "usb",
	"FT8":   "usb",
}

var sdrToFlrig = map[string]string{
	"usb": "USB",
	"lsb": "LSB",
	"cwu": "CW",
	"cwl": "CWR",
	"am":  "AM",
	"sam": "SAM",
	"fm":  "FM",
	"nfm": "NFM",
}

// ── Timing constants (matching the Firefox extension) ─────────────────────────

const (
	flrigPollInterval      = 100 * time.Millisecond
	flrigReconnectInterval = 10 * time.Second
	flrigEchoCooldown      = 2 * time.Second
	sdrToRigDebounce       = 150 * time.Millisecond
	flrigHTTPTimeout       = 3 * time.Second
)

// ── FlrigSync ─────────────────────────────────────────────────────────────────

// FlrigSync manages bidirectional frequency/mode synchronisation with flrig.
// Create with NewFlrigSync, set callbacks, then call Start().
type FlrigSync struct {
	// Configuration — set before Start() or via Set* methods (thread-safe).
	host      string
	port      int
	direction string // "sdr-to-rig" | "rig-to-sdr" | "both"
	enabled   bool

	// Callbacks — called from the poll goroutine; must be goroutine-safe.
	// OnFreqMode is called when flrig reports a new frequency or mode that
	// differs from what we last sent (rig→SDR direction).
	OnFreqMode func(hz int, mode string)
	// OnPTT is called when the PTT state changes.
	OnPTT func(active bool)
	// OnStatus is called when the connection state changes.
	OnStatus func(connected bool, msg string)

	// Internal state — protected by mu.
	mu        sync.Mutex
	connected bool
	lastPtt   bool

	// Echo prevention (same logic as background.js).
	lastFlrigFreq    int       // last freq READ from flrig; 0 = unknown
	lastFlrigMode    string    // last mode READ from flrig; "" = unknown
	lastSdrFreq      int       // last freq SENT to flrig from SDR; 0 = unknown
	lastSdrMode      string    // last flrig-format mode SENT to flrig; "" = unknown
	sdrToRigPushTime time.Time // time of last SDR→rig push (for cooldown)

	// Debounce for SDR→rig pushes.
	pendingSdrFreq int
	pendingSdrMode string
	debounceTimer  *time.Timer

	// Lifecycle.
	stopCh chan struct{}
	wg     sync.WaitGroup
	client *http.Client
}

// NewFlrigSync creates a new FlrigSync with default settings (disabled).
func NewFlrigSync() *FlrigSync {
	return &FlrigSync{
		host:      "127.0.0.1",
		port:      12345,
		direction: "both",
		enabled:   false,
		client: &http.Client{
			Timeout: flrigHTTPTimeout,
		},
	}
}

// Configure atomically updates host, port, direction, and enabled state.
// If the sync is running and enabled changes to true, the poll loop will
// start connecting on the next reconnect tick.
func (f *FlrigSync) Configure(host string, port int, direction string, enabled bool) {
	f.mu.Lock()
	f.host = host
	f.port = port
	f.direction = direction
	wasEnabled := f.enabled
	f.enabled = enabled
	f.mu.Unlock()

	// If we just disabled, mark disconnected and notify.
	if wasEnabled && !enabled {
		f.mu.Lock()
		f.connected = false
		f.mu.Unlock()
		if f.OnStatus != nil {
			f.OnStatus(false, "Disabled")
		}
	}
}

// IsEnabled returns whether flrig sync is currently enabled.
func (f *FlrigSync) IsEnabled() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.enabled
}

// IsConnected returns whether flrig is currently reachable.
func (f *FlrigSync) IsConnected() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.connected
}

// Start launches the background poll and reconnect goroutines.
// Safe to call multiple times — subsequent calls are no-ops if already running.
func (f *FlrigSync) Start() {
	f.mu.Lock()
	if f.stopCh != nil {
		f.mu.Unlock()
		return // already running
	}
	f.stopCh = make(chan struct{})
	f.mu.Unlock()

	f.wg.Add(1)
	go f.runLoop()
}

// Stop shuts down the background goroutines and waits for them to exit.
func (f *FlrigSync) Stop() {
	f.mu.Lock()
	ch := f.stopCh
	f.stopCh = nil
	// Cancel any pending debounce timer.
	if f.debounceTimer != nil {
		f.debounceTimer.Stop()
		f.debounceTimer = nil
	}
	f.mu.Unlock()

	if ch != nil {
		close(ch)
		f.wg.Wait()
	}
}

// PushSDRState is called by the UI when the user tunes the SDR.
// It debounces rapid changes and pushes the settled value to flrig.
// No-op if disabled, not connected, or direction is "rig-to-sdr".
func (f *FlrigSync) PushSDRState(hz int, sdrMode string) {
	f.mu.Lock()
	defer f.mu.Unlock()

	if !f.enabled || !f.connected {
		return
	}
	if f.direction == "rig-to-sdr" {
		return
	}

	// Accumulate the latest values.
	f.pendingSdrFreq = hz
	f.pendingSdrMode = sdrMode

	// Reset the debounce timer.
	if f.debounceTimer != nil {
		f.debounceTimer.Stop()
	}
	f.debounceTimer = time.AfterFunc(sdrToRigDebounce, f.flushSDRToRig)
}

// flushSDRToRig is called by the debounce timer (from a timer goroutine).
// It sends the pending SDR state to flrig.
func (f *FlrigSync) flushSDRToRig() {
	f.mu.Lock()
	freq := f.pendingSdrFreq
	sdrMode := f.pendingSdrMode
	f.debounceTimer = nil
	f.mu.Unlock()

	if freq == 0 {
		return
	}

	flrigMode := sdrToFlrig[strings.ToLower(sdrMode)]

	var pushed bool

	// Only push freq if it changed from what we last sent.
	f.mu.Lock()
	freqChanged := f.lastSdrFreq == 0 || freq != f.lastSdrFreq
	modeChanged := flrigMode != "" && flrigMode != f.lastSdrMode
	if freqChanged {
		f.lastSdrFreq = freq
	}
	if modeChanged {
		f.lastSdrMode = flrigMode
	}
	f.mu.Unlock()

	if freqChanged {
		if err := f.xmlrpcSetFreq(freq); err != nil {
			return
		}
		pushed = true
	}
	if modeChanged {
		if err := f.xmlrpcSetMode(flrigMode); err != nil {
			return
		}
		pushed = true
	}

	if pushed {
		f.mu.Lock()
		f.sdrToRigPushTime = time.Now()
		f.mu.Unlock()
	}
}

// ── Background run loop ────────────────────────────────────────────────────────

func (f *FlrigSync) runLoop() {
	defer f.wg.Done()

	f.mu.Lock()
	stopCh := f.stopCh
	f.mu.Unlock()

	// Attempt an immediate connect on startup rather than waiting for the
	// first reconnect tick (which fires after flrigReconnectInterval = 10s).
	f.mu.Lock()
	enabledNow := f.enabled
	f.mu.Unlock()
	if enabledNow {
		f.tryConnect()
	}

	reconnectTicker := time.NewTicker(flrigReconnectInterval)
	defer reconnectTicker.Stop()

	pollTicker := time.NewTicker(flrigPollInterval)
	defer pollTicker.Stop()

	for {
		select {
		case <-stopCh:
			return

		case <-reconnectTicker.C:
			f.mu.Lock()
			enabled := f.enabled
			connected := f.connected
			f.mu.Unlock()

			if enabled && !connected {
				f.tryConnect()
			}

		case <-pollTicker.C:
			f.mu.Lock()
			enabled := f.enabled
			connected := f.connected
			f.mu.Unlock()

			if !enabled || !connected {
				continue
			}

			if err := f.poll(); err != nil {
				f.mu.Lock()
				f.connected = false
				f.mu.Unlock()
				if f.OnStatus != nil {
					f.OnStatus(false, "Lost connection")
				}
			}
		}
	}
}

// tryConnect attempts to reach flrig and starts polling on success.
func (f *FlrigSync) tryConnect() {
	f.mu.Lock()
	enabled := f.enabled
	f.mu.Unlock()
	if !enabled {
		return
	}

	// Use system.listMethods as a connection test (standard XML-RPC introspection).
	if _, err := f.xmlrpcCall("system.listMethods", nil); err != nil {
		if f.OnStatus != nil {
			f.OnStatus(false, fmt.Sprintf("Unreachable: %v", err))
		}
		return
	}

	// Reset echo-prevention state on (re)connect so the first poll always syncs.
	f.mu.Lock()
	f.connected = true
	f.lastFlrigFreq = 0
	f.lastFlrigMode = ""
	f.mu.Unlock()

	if f.OnStatus != nil {
		f.OnStatus(true, "Connected")
	}
}

// poll reads freq, mode, and PTT from flrig and pushes changes to the SDR.
func (f *FlrigSync) poll() error {
	freq, err := f.xmlrpcGetFreq()
	if err != nil {
		return err
	}
	modeRaw, err := f.xmlrpcGetMode()
	if err != nil {
		return err
	}

	// PTT — silently ignore if the rig doesn't support it.
	pttNow := false
	if val, err := f.xmlrpcGetPtt(); err == nil {
		pttNow = val
	}

	// Handle PTT transitions.
	f.mu.Lock()
	lastPtt := f.lastPtt
	f.mu.Unlock()
	if pttNow != lastPtt {
		f.mu.Lock()
		f.lastPtt = pttNow
		f.mu.Unlock()
		if f.OnPTT != nil {
			f.OnPTT(pttNow)
		}
	}

	// Rig→SDR: only push if direction allows and we're outside the cooldown window.
	f.mu.Lock()
	direction := f.direction
	inCooldown := time.Since(f.sdrToRigPushTime) < flrigEchoCooldown
	lastFlrigFreq := f.lastFlrigFreq
	lastFlrigMode := f.lastFlrigMode
	f.mu.Unlock()

	if direction == "rig-to-sdr" || direction == "both" {
		if inCooldown {
			return nil
		}

		freqChanged := lastFlrigFreq == 0 || freq != lastFlrigFreq
		modeChanged := modeRaw != "" && modeRaw != lastFlrigMode

		if freqChanged {
			f.mu.Lock()
			f.lastFlrigFreq = freq
			f.mu.Unlock()
		}
		if modeChanged {
			f.mu.Lock()
			f.lastFlrigMode = modeRaw
			f.mu.Unlock()
		}

		if (freqChanged || modeChanged) && f.OnFreqMode != nil {
			sdrMode := flrigToSDR[modeRaw]
			if sdrMode == "" {
				sdrMode = "usb" // safe fallback
			}
			// Stamp _lastSdrFreq/_lastSdrMode so the SDR echo via PushSDRState
			// doesn't immediately push this value back to flrig.
			f.mu.Lock()
			if freqChanged {
				f.lastSdrFreq = freq
			}
			if modeChanged {
				f.lastSdrMode = modeRaw
			}
			f.mu.Unlock()
			f.OnFreqMode(freq, sdrMode)
		}
	}

	return nil
}

// ── XML-RPC helpers ────────────────────────────────────────────────────────────

// xmlrpcCall sends an XML-RPC request and returns the raw response value as a string.
// params may be nil for zero-argument calls.
func (f *FlrigSync) xmlrpcCall(method string, params []string) (string, error) {
	f.mu.Lock()
	host := f.host
	port := f.port
	f.mu.Unlock()

	var paramXML strings.Builder
	for _, p := range params {
		paramXML.WriteString("<param><value>")
		paramXML.WriteString(p)
		paramXML.WriteString("</value></param>")
	}

	body := fmt.Sprintf(
		`<?xml version="1.0"?><methodCall><methodName>%s</methodName><params>%s</params></methodCall>`,
		method, paramXML.String(),
	)

	url := fmt.Sprintf("http://%s:%d/RPC2", host, port)
	req, err := http.NewRequest("POST", url, strings.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "text/xml")
	req.Header.Set("User-Agent", "UberSDR-Audio/1.0")

	resp, err := f.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	return parseXMLRPCResponse(string(raw))
}

// parseXMLRPCResponse extracts the scalar value from a simple XML-RPC response.
// Handles <string>, <double>, <int>, <i4>, <boolean>, and bare <value>text</value>.
func parseXMLRPCResponse(xml string) (string, error) {
	if strings.Contains(xml, "<fault>") {
		re := regexp.MustCompile(`<name>faultString</name>\s*<value><string>([^<]*)</string>`)
		if m := re.FindStringSubmatch(xml); len(m) > 1 {
			return "", fmt.Errorf("XML-RPC fault: %s", m[1])
		}
		return "", fmt.Errorf("XML-RPC fault")
	}

	// Try typed values first.
	patterns := []string{
		`<value><double>([^<]*)</double></value>`,
		`<value><int>([^<]*)</int></value>`,
		`<value><i4>([^<]*)</i4></value>`,
		`<value><boolean>([^<]*)</boolean></value>`,
		`<value><string>([^<]*)</string></value>`,
	}
	for _, pat := range patterns {
		re := regexp.MustCompile(pat)
		if m := re.FindStringSubmatch(xml); len(m) > 1 {
			return m[1], nil
		}
	}

	// Bare value with no type tag — flrig sometimes omits the type element.
	re := regexp.MustCompile(`<value>([^<]+)</value>`)
	if m := re.FindStringSubmatch(xml); len(m) > 1 {
		return m[1], nil
	}

	return "", nil
}

// xmlrpcGetFreq reads the current VFO frequency from flrig (Hz, rounded to int).
func (f *FlrigSync) xmlrpcGetFreq() (int, error) {
	val, err := f.xmlrpcCall("rig.get_vfo", nil)
	if err != nil {
		return 0, err
	}
	fval, err := strconv.ParseFloat(strings.TrimSpace(val), 64)
	if err != nil {
		return 0, fmt.Errorf("parse freq %q: %w", val, err)
	}
	return int(fval + 0.5), nil
}

// xmlrpcSetFreq sets the VFO frequency in flrig.
// flrig expects frequency as a <double>, not <int>.
func (f *FlrigSync) xmlrpcSetFreq(hz int) error {
	param := fmt.Sprintf("<double>%d</double>", hz)
	_, err := f.xmlrpcCall("rig.set_vfo", []string{param})
	return err
}

// xmlrpcGetMode reads the current mode string from flrig (e.g. "USB", "LSB").
func (f *FlrigSync) xmlrpcGetMode() (string, error) {
	val, err := f.xmlrpcCall("rig.get_mode", nil)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(val), nil
}

// xmlrpcSetMode sets the mode in flrig (e.g. "USB", "LSB").
func (f *FlrigSync) xmlrpcSetMode(flrigMode string) error {
	param := fmt.Sprintf("<string>%s</string>", flrigMode)
	_, err := f.xmlrpcCall("rig.set_mode", []string{param})
	return err
}

// xmlrpcGetPtt reads the current PTT state from flrig.
func (f *FlrigSync) xmlrpcGetPtt() (bool, error) {
	val, err := f.xmlrpcCall("rig.get_ptt", nil)
	if err != nil {
		return false, err
	}
	v := strings.TrimSpace(val)
	return v == "1" || strings.EqualFold(v, "true"), nil
}

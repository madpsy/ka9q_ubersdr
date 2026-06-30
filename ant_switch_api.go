package main

// Antenna Switch Control
//
// Talks directly to the switch device over HTTP, mirroring what the KiwiSDR
// ant-switch-frontend bash scripts do with curl.
//
// Supported backend types (set via BackendType in config):
//
//   ms-s7-web   — MS-S7-WEB (7-port, mixing)
//                   GET  /io.cgi          → 7-digit bit string "0100000"
//                   POST /dout.cgi        → pin=N&val=0 (select) / val=1 (deselect)
//                   GET  /widget.cgi      → connectivity check
//
//   ms-sNa-web  — MS-S3A/S4A/S5A/S6A/S7A-WEB (rotary, no mixing)
//                   GET  /               → HTML containing selected antenna number
//                   GET  /4/on           → step clockwise
//                   GET  /5/on           → step counter-clockwise
//
//   kmtronic    — KMTronic 8-ch relay board (mixing)
//                   GET  /status.xml     → XML <relay0>0</relay0>…<relay8>0</relay8>
//                   GET  /FFE000         → ground all
//                   GET  /FF0N01         → turn relay N on
//                   GET  /FF0N00         → turn relay N off
//                   GET  /relays.cgi?relay=N → toggle relay N
//
//   snaptekk    — Snaptekk 8-ch relay board (mixing)
//                   GET  /status        → HTML containing {"Status":[0,0,0,0,0,0,0,0]}
//                   GET  /switch/g      → ground all
//                   GET  /switch/+N     → add antenna N
//                   GET  /switch/-N     → remove antenna N
//                   GET  /switch/tN     → toggle antenna N
//
// Every command (select, ground, add, remove, toggle) returns the new state
// directly — there is no ACK-less protocol and no need for a separate verify
// query.  The old TCP/xinetd transport has been removed entirely.

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ─── Configuration ────────────────────────────────────────────────────────────

// AntSwitchConfig contains antenna switch client configuration.
type AntSwitchConfig struct {
	Enabled bool `yaml:"enabled"` // Enable/disable antenna switch integration

	// BackendType selects the HTTP driver.
	// Valid values: "ms-s7-web", "ms-sNa-web", "kmtronic", "snaptekk"
	BackendType string `yaml:"backend_type"`

	// DeviceURL is the base URL of the switch device, e.g. "http://192.168.1.234"
	DeviceURL string `yaml:"device_url"`

	// TimeoutMs is the HTTP request timeout in milliseconds (default: 2000).
	TimeoutMs int `yaml:"timeout_ms"`

	// NumAntennas: number of antennas supported by the switch (1-10, default: 8).
	// For ms-sNa-web this is the N in the model name (3-7).
	NumAntennas int `yaml:"num_antennas"`

	// AllowMixing controls the switching mode for backends that support it:
	//   false = exclusive mode: ground all first, then select N
	//   true  = mixing mode:    toggle antenna on/off independently
	// For ms-sNa-web this is always false (rotary switch, no mixing).
	AllowMixing bool `yaml:"allow_mixing"`

	// Password for the public control endpoint POST /api/ant-switch/command.
	// When set, callers must include {"password":"..."} in the JSON body.
	// When empty, the public control endpoint returns 401 Unauthorized.
	// Admin endpoint /admin/ant-switch-command never requires this password.
	Password string `yaml:"password"`

	// Thunderstorm: when true, forces all antennas to ground and denies
	// public switching. Admin can still override via admin endpoint.
	Thunderstorm bool `yaml:"thunderstorm"`

	// DefaultAntenna is selected on startup (0 = no automatic selection).
	DefaultAntenna int `yaml:"default_antenna"`

	// AntennaLabels are optional human-readable names for each antenna.
	AntennaLabels []string `yaml:"antenna_labels"`
}

// ─── State ────────────────────────────────────────────────────────────────────

// AntSwitchState holds the current (cached) state of the antenna switch.
type AntSwitchState struct {
	Selected   []int     // active antenna numbers (empty when grounded)
	Grounded   bool      // true when all antennas are grounded
	LastUpdate time.Time // time of last successful query
	LastError  string    // last error string (empty if none)
}

// ─── Change log ───────────────────────────────────────────────────────────────

// AntSwitchLogEntry records a single antenna change event.
type AntSwitchLogEntry struct {
	Time     time.Time `json:"time"`
	Action   string    `json:"action"`   // "select", "ground", "add", "remove", "default"
	Antenna  int       `json:"antenna"`  // 0 for ground/default
	Label    string    `json:"label"`    // human-readable antenna name, or "Ground all"
	Selected []int     `json:"selected"` // resulting selected antennas after the change
	Grounded bool      `json:"grounded"` // resulting grounded state
	Source   string    `json:"source"`   // "public", "admin", "startup"
}

// AntSwitchChangeLog is a fixed-capacity ring buffer of antenna change events.
type AntSwitchChangeLog struct {
	mu      sync.RWMutex
	entries []AntSwitchLogEntry
	cap     int
}

func newAntSwitchChangeLog(capacity int) *AntSwitchChangeLog {
	return &AntSwitchChangeLog{
		entries: make([]AntSwitchLogEntry, 0, capacity),
		cap:     capacity,
	}
}

// Add appends an entry, evicting the oldest if at capacity.
func (cl *AntSwitchChangeLog) Add(e AntSwitchLogEntry) {
	cl.mu.Lock()
	defer cl.mu.Unlock()
	if len(cl.entries) >= cl.cap {
		cl.entries = cl.entries[1:]
	}
	cl.entries = append(cl.entries, e)
}

// Snapshot returns a copy of all entries, newest first.
func (cl *AntSwitchChangeLog) Snapshot() []AntSwitchLogEntry {
	cl.mu.RLock()
	defer cl.mu.RUnlock()
	out := make([]AntSwitchLogEntry, len(cl.entries))
	for i, e := range cl.entries {
		out[len(cl.entries)-1-i] = e
	}
	return out
}

// ─── Backend interface ────────────────────────────────────────────────────────

// antSwitchBackend is the interface each hardware driver must implement.
// Every method returns the new AntSwitchState directly — no separate verify
// query is needed because the device always reports its current state.
type antSwitchBackend interface {
	// GetState queries the device and returns the current antenna state.
	GetState() (AntSwitchState, error)

	// SelectAntenna selects antenna n exclusively (grounds all first if needed).
	SelectAntenna(n int) (AntSwitchState, error)

	// GroundAll grounds all antennas.
	GroundAll() (AntSwitchState, error)

	// AddAntenna adds antenna n without disturbing others (mixing mode).
	AddAntenna(n int) (AntSwitchState, error)

	// RemoveAntenna removes antenna n without disturbing others (mixing mode).
	RemoveAntenna(n int) (AntSwitchState, error)

	// ToggleAntenna toggles antenna n on/off (mixing mode).
	ToggleAntenna(n int) (AntSwitchState, error)
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

// httpGet performs a GET request and returns the response body as a string.
func httpGet(client *http.Client, rawURL string) (string, error) {
	resp, err := client.Get(rawURL)
	if err != nil {
		return "", fmt.Errorf("GET %s: %w", rawURL, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read body from %s: %w", rawURL, err)
	}
	return string(body), nil
}

// httpPost performs a POST request with form-encoded data and returns the body.
func httpPost(client *http.Client, rawURL string, data url.Values) (string, error) {
	resp, err := client.PostForm(rawURL, data)
	if err != nil {
		return "", fmt.Errorf("POST %s: %w", rawURL, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read body from %s: %w", rawURL, err)
	}
	return string(body), nil
}

// ─── ms-s7-web backend ────────────────────────────────────────────────────────
//
// MS-S7-WEB: 7-port relay board with mixing support.
//
//   GET  /io.cgi          → "0100000" (7 bits, 0=selected/active, 1=grounded)
//   POST /dout.cgi        → pin=N&val=0 (select/activate), pin=N&val=1 (deselect/ground)
//
// Note: the bit polarity is inverted — 0 means the relay is energised (antenna
// connected), 1 means grounded.  Antenna N maps to pin N-1 (0-indexed).

type msS7WebBackend struct {
	client  *http.Client
	baseURL string
	nCh     int
}

func newMsS7WebBackend(deviceURL string, nCh int, timeout time.Duration) *msS7WebBackend {
	return &msS7WebBackend{
		client:  &http.Client{Timeout: timeout},
		baseURL: strings.TrimRight(deviceURL, "/"),
		nCh:     nCh,
	}
}

// readBits fetches /io.cgi and returns the raw bit string.
func (b *msS7WebBackend) readBits() (string, error) {
	body, err := httpGet(b.client, b.baseURL+"/io.cgi")
	if err != nil {
		return "", err
	}
	// Strip non-digit characters; keep only 0 and 1
	re := regexp.MustCompile(`[^01]`)
	digits := re.ReplaceAllString(body, "")
	if len(digits) < b.nCh {
		return "", fmt.Errorf("ms-s7-web: unexpected /io.cgi response (got %q)", body)
	}
	return digits[:b.nCh], nil
}

func (b *msS7WebBackend) bitsToState(bits string) AntSwitchState {
	state := AntSwitchState{LastUpdate: time.Now()}
	for i := 0; i < len(bits) && i < b.nCh; i++ {
		// bit '0' means relay energised = antenna active
		if bits[i] == '0' {
			state.Selected = append(state.Selected, i+1)
		}
	}
	if len(state.Selected) == 0 {
		state.Grounded = true
	}
	return state
}

func (b *msS7WebBackend) GetState() (AntSwitchState, error) {
	bits, err := b.readBits()
	if err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	return b.bitsToState(bits), nil
}

func (b *msS7WebBackend) setPin(pin int, val int) error {
	_, err := httpPost(b.client, b.baseURL+"/dout.cgi", url.Values{
		"pin": {strconv.Itoa(pin)},
		"val": {strconv.Itoa(val)},
	})
	return err
}

func (b *msS7WebBackend) SelectAntenna(n int) (AntSwitchState, error) {
	// Ground all first (set all pins to 1), then activate the chosen one (pin=0)
	if _, err := b.GroundAll(); err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	if err := b.setPin(n-1, 0); err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	return b.GetState()
}

func (b *msS7WebBackend) GroundAll() (AntSwitchState, error) {
	for i := 0; i < b.nCh; i++ {
		if err := b.setPin(i, 1); err != nil {
			return AntSwitchState{LastError: err.Error()}, err
		}
	}
	return b.GetState()
}

func (b *msS7WebBackend) AddAntenna(n int) (AntSwitchState, error) {
	if err := b.setPin(n-1, 0); err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	return b.GetState()
}

func (b *msS7WebBackend) RemoveAntenna(n int) (AntSwitchState, error) {
	if err := b.setPin(n-1, 1); err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	return b.GetState()
}

func (b *msS7WebBackend) ToggleAntenna(n int) (AntSwitchState, error) {
	bits, err := b.readBits()
	if err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	pin := n - 1
	if pin >= len(bits) {
		return AntSwitchState{LastError: fmt.Sprintf("antenna %d out of range", n)},
			fmt.Errorf("antenna %d out of range for %d-channel device", n, b.nCh)
	}
	// bit '0' = active; toggle: 0→1 (deactivate), 1→0 (activate)
	if bits[pin] == '0' {
		return b.RemoveAntenna(n)
	}
	return b.AddAntenna(n)
}

// ─── ms-sNa-web backend ───────────────────────────────────────────────────────
//
// MS-S3A/S4A/S5A/S6A/S7A-WEB: rotary switch, no mixing.
//
//   GET /          → HTML page containing the selected antenna number (1-N) or "GROUND"
//   GET /4/on      → step clockwise (increment antenna number)
//   GET /5/on      → step counter-clockwise (decrement antenna number)
//
// The switch is a rotary selector — to reach antenna N from the current
// position we step CW or CCW by the shortest path.

type msSNaWebBackend struct {
	client  *http.Client
	baseURL string
	nCh     int
}

func newMsSNaWebBackend(deviceURL string, nCh int, timeout time.Duration) *msSNaWebBackend {
	return &msSNaWebBackend{
		client:  &http.Client{Timeout: timeout},
		baseURL: strings.TrimRight(deviceURL, "/"),
		nCh:     nCh,
	}
}

// readSelected fetches the root page and parses the currently selected antenna.
// Returns 0 for ground/unknown.
var msSNaSelectedRe = regexp.MustCompile(`(?i)([1-9][0-9]?)<p>|GROUND`)

func (b *msSNaWebBackend) readSelected() (int, error) {
	body, err := httpGet(b.client, b.baseURL+"/")
	if err != nil {
		return 0, err
	}
	m := msSNaSelectedRe.FindString(body)
	if m == "" {
		return 0, nil // treat as ground
	}
	if strings.EqualFold(m, "GROUND") {
		return 0, nil
	}
	// m is like "3<p>" — extract the leading number
	numStr := strings.TrimRight(m, "<p>")
	n, err := strconv.Atoi(numStr)
	if err != nil {
		return 0, nil
	}
	return n, nil
}

func (b *msSNaWebBackend) selectedToState(selected int) AntSwitchState {
	state := AntSwitchState{LastUpdate: time.Now()}
	if selected == 0 {
		state.Grounded = true
	} else {
		state.Selected = []int{selected}
	}
	return state
}

func (b *msSNaWebBackend) GetState() (AntSwitchState, error) {
	sel, err := b.readSelected()
	if err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	return b.selectedToState(sel), nil
}

// stepTo steps the rotary switch from current to target by the shortest path.
// target=0 means ground (position 0).
func (b *msSNaWebBackend) stepTo(target int) (AntSwitchState, error) {
	current, err := b.readSelected()
	if err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	if current == target {
		return b.selectedToState(current), nil
	}

	// Calculate shortest-path steps on a ring of size nCh+1 (positions 0..nCh)
	// Position 0 = ground, positions 1..nCh = antennas
	ringSize := b.nCh + 1
	steps := target - current
	if steps > ringSize/2 {
		steps -= ringSize
	}
	if steps < -(ringSize / 2) {
		steps += ringSize
	}

	var stepURL string
	if steps < 0 {
		stepURL = b.baseURL + "/5/on" // CCW
		steps = -steps
	} else {
		stepURL = b.baseURL + "/4/on" // CW
	}

	for i := 0; i < steps; i++ {
		if _, err := httpGet(b.client, stepURL); err != nil {
			return AntSwitchState{LastError: err.Error()}, err
		}
	}

	return b.GetState()
}

func (b *msSNaWebBackend) SelectAntenna(n int) (AntSwitchState, error) {
	return b.stepTo(n)
}

func (b *msSNaWebBackend) GroundAll() (AntSwitchState, error) {
	return b.stepTo(0)
}

// AddAntenna, RemoveAntenna, ToggleAntenna: rotary switch has no mixing.
// We treat AddAntenna as SelectAntenna (exclusive), and Remove/Toggle as no-ops
// that return the current state.
func (b *msSNaWebBackend) AddAntenna(n int) (AntSwitchState, error) {
	return b.SelectAntenna(n)
}

func (b *msSNaWebBackend) RemoveAntenna(_ int) (AntSwitchState, error) {
	return b.GetState()
}

func (b *msSNaWebBackend) ToggleAntenna(n int) (AntSwitchState, error) {
	// If n is currently selected, ground; otherwise select it.
	sel, err := b.readSelected()
	if err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	if sel == n {
		return b.GroundAll()
	}
	return b.SelectAntenna(n)
}

// ─── kmtronic backend ─────────────────────────────────────────────────────────
//
// KMTronic 8-ch relay board.
//
//   GET /status.xml          → XML: <relay0>0</relay0>…<relay8>0</relay8>
//                              relay0 is a heartbeat; relay1-8 are antennas.
//   GET /FFE000               → ground all (all relays off)
//   GET /FF0N01               → turn relay N on  (N = 1-8, zero-padded to 1 digit)
//   GET /FF0N00               → turn relay N off
//   GET /relays.cgi?relay=N   → toggle relay N

type kmtronicBackend struct {
	client  *http.Client
	baseURL string
	nCh     int
}

func newKmtronicBackend(deviceURL string, nCh int, timeout time.Duration) *kmtronicBackend {
	return &kmtronicBackend{
		client:  &http.Client{Timeout: timeout},
		baseURL: strings.TrimRight(deviceURL, "/"),
		nCh:     nCh,
	}
}

var kmtronicRelayRe = regexp.MustCompile(`relay[0-8]`)

func (b *kmtronicBackend) GetState() (AntSwitchState, error) {
	body, err := httpGet(b.client, b.baseURL+"/status.xml")
	if err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	// Strip relay tag names, keep only 0/1 digits
	digits := kmtronicRelayRe.ReplaceAllString(body, "")
	re := regexp.MustCompile(`[^01]`)
	digits = re.ReplaceAllString(digits, "")
	if len(digits) < 9 {
		digits = "000000000"
	}

	state := AntSwitchState{LastUpdate: time.Now()}
	// digits[0] = relay0 (heartbeat), digits[1..8] = relay1..8 = antennas 1..8
	for i := 1; i <= b.nCh && i < len(digits); i++ {
		if digits[i] == '1' {
			state.Selected = append(state.Selected, i)
		}
	}
	if len(state.Selected) == 0 {
		state.Grounded = true
	}
	return state, nil
}

func (b *kmtronicBackend) SelectAntenna(n int) (AntSwitchState, error) {
	if _, err := httpGet(b.client, b.baseURL+"/FFE000"); err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	if _, err := httpGet(b.client, fmt.Sprintf("%s/FF0%d01", b.baseURL, n)); err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	return b.GetState()
}

func (b *kmtronicBackend) GroundAll() (AntSwitchState, error) {
	if _, err := httpGet(b.client, b.baseURL+"/FFE000"); err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	return b.GetState()
}

func (b *kmtronicBackend) AddAntenna(n int) (AntSwitchState, error) {
	if _, err := httpGet(b.client, fmt.Sprintf("%s/FF0%d01", b.baseURL, n)); err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	return b.GetState()
}

func (b *kmtronicBackend) RemoveAntenna(n int) (AntSwitchState, error) {
	if _, err := httpGet(b.client, fmt.Sprintf("%s/FF0%d00", b.baseURL, n)); err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	return b.GetState()
}

func (b *kmtronicBackend) ToggleAntenna(n int) (AntSwitchState, error) {
	if _, err := httpGet(b.client, fmt.Sprintf("%s/relays.cgi?relay=%d", b.baseURL, n)); err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	return b.GetState()
}

// ─── snaptekk backend ─────────────────────────────────────────────────────────
//
// Snaptekk 8-ch relay board.
//
//   GET /status      → HTML containing {"Status":[0,0,0,0,0,0,0,0]}
//                      1 = relay energised (antenna active)
//   GET /switch/g    → ground all
//   GET /switch/+N   → add antenna N
//   GET /switch/-N   → remove antenna N
//   GET /switch/tN   → toggle antenna N

type snaptekkBackend struct {
	client  *http.Client
	baseURL string
	nCh     int
}

func newSnaptekkBackend(deviceURL string, nCh int, timeout time.Duration) *snaptekkBackend {
	return &snaptekkBackend{
		client:  &http.Client{Timeout: timeout},
		baseURL: strings.TrimRight(deviceURL, "/"),
		nCh:     nCh,
	}
}

var snaptekkStatusRe = regexp.MustCompile(`\{[^}]*"Status"\s*:\s*\[([01,\s]+)\]`)

func (b *snaptekkBackend) GetState() (AntSwitchState, error) {
	body, err := httpGet(b.client, b.baseURL+"/status")
	if err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}

	// Try to parse {"Status":[0,0,...]} from the HTML
	m := snaptekkStatusRe.FindStringSubmatch(body)
	var bits []int
	if m != nil {
		// Parse the comma-separated list inside the brackets
		for _, part := range strings.Split(m[1], ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			v, err := strconv.Atoi(part)
			if err == nil {
				bits = append(bits, v)
			}
		}
	}

	// Fallback: strip non-0/1 chars
	if len(bits) == 0 {
		re := regexp.MustCompile(`[^01]`)
		digits := re.ReplaceAllString(body, "")
		for _, ch := range digits {
			if ch == '0' {
				bits = append(bits, 0)
			} else {
				bits = append(bits, 1)
			}
		}
	}

	state := AntSwitchState{LastUpdate: time.Now()}
	// bits[0] is a status/heartbeat byte; antennas start at bits[1]
	for i := 1; i <= b.nCh && i < len(bits); i++ {
		if bits[i] == 1 {
			state.Selected = append(state.Selected, i)
		}
	}
	if len(state.Selected) == 0 {
		state.Grounded = true
	}
	return state, nil
}

func (b *snaptekkBackend) SelectAntenna(n int) (AntSwitchState, error) {
	if _, err := httpGet(b.client, b.baseURL+"/switch/g"); err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	if _, err := httpGet(b.client, fmt.Sprintf("%s/switch/+%d", b.baseURL, n)); err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	return b.GetState()
}

func (b *snaptekkBackend) GroundAll() (AntSwitchState, error) {
	if _, err := httpGet(b.client, b.baseURL+"/switch/g"); err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	return b.GetState()
}

func (b *snaptekkBackend) AddAntenna(n int) (AntSwitchState, error) {
	if _, err := httpGet(b.client, fmt.Sprintf("%s/switch/+%d", b.baseURL, n)); err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	return b.GetState()
}

func (b *snaptekkBackend) RemoveAntenna(n int) (AntSwitchState, error) {
	if _, err := httpGet(b.client, fmt.Sprintf("%s/switch/-%d", b.baseURL, n)); err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	return b.GetState()
}

func (b *snaptekkBackend) ToggleAntenna(n int) (AntSwitchState, error) {
	if _, err := httpGet(b.client, fmt.Sprintf("%s/switch/t%d", b.baseURL, n)); err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	return b.GetState()
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────

// AntSwitchRateLimiter is a per-IP rate limiter for ant-switch endpoints.
// Status endpoint: 5 req/s; command endpoints: 1 req/s.
type AntSwitchRateLimiter struct {
	limiters map[string]map[string]*RateLimiter
	mu       sync.RWMutex

package main

// Antenna Switch Control
//
// Talks directly to the switch device over HTTP,
//
// Supported backend types (set via BackendType in config):
//
//   ms-s7-web   — MS-S7-WEB (7-port, mixing)
//                   GET  /io.cgi          → 7-digit bit string "0100000"
//                                           bit 0 = relay energised (antenna active)
//                                           bit 1 = relay off (grounded)
//                   POST /dout.cgi        → pin=N&val=0 (select) / val=1 (deselect)
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

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

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

// stripNonBinary removes all characters that are not '0' or '1'.
var stripNonBinaryRe = regexp.MustCompile(`[^01]`)

func stripNonBinary(s string) string {
	return stripNonBinaryRe.ReplaceAllString(s, "")
}

// ─── ms-s7-web backend ────────────────────────────────────────────────────────
//
// MS-S7-WEB: 7-port relay board with mixing support.
//
//   GET  /io.cgi          → "0100000" (N bits, 1=relay energised/antenna active,
//                           0=relay off/grounded)
//   POST /dout.cgi        → pin=N&val=0 (activate), pin=N&val=1 (deactivate)
//
// Antenna N maps to pin N-1 (0-indexed).
// NOTE: bit '1' = antenna active (relay energised), bit '0' = grounded.
// This matches the KiwiSDR bash backend which checks `thisbit == "1"` for active.

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

func (b *msS7WebBackend) readBits() (string, error) {
	body, err := httpGet(b.client, b.baseURL+"/io.cgi")
	if err != nil {
		return "", err
	}
	digits := stripNonBinary(body)
	if len(digits) < b.nCh {
		return "", fmt.Errorf("ms-s7-web: unexpected /io.cgi response (got %q)", body)
	}
	return digits[:b.nCh], nil
}

func (b *msS7WebBackend) bitsToState(bits string) AntSwitchState {
	state := AntSwitchState{LastUpdate: time.Now()}
	for i := 0; i < len(bits) && i < b.nCh; i++ {
		// bit '1' means relay energised = antenna active
		// (matches KiwiSDR bash: `if [ "x$thisbit" == "x1" ]` → antenna selected)
		if bits[i] == '1' {
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
	for i := 0; i < b.nCh; i++ {
		if err := b.setPin(i, 1); err != nil {
			return AntSwitchState{LastError: err.Error()}, err
		}
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
		err := fmt.Errorf("antenna %d out of range for %d-channel device", n, b.nCh)
		return AntSwitchState{LastError: err.Error()}, err
	}
	// bit '0' = inactive → add it; bit '1' = active → remove it
	// (matches KiwiSDR bash: `if [ "x$thisbits" == "x0" ]` → AntSW_AddAntenna)
	if bits[pin] == '0' {
		return b.AddAntenna(n)
	}
	return b.RemoveAntenna(n)
}

// ─── ms-sNa-web backend ───────────────────────────────────────────────────────
//
// MS-S3A/S4A/S5A/S6A/S7A-WEB: rotary switch, no mixing.
//
// Actual device HTML (from GET /):
//
//   <p><a href="/5/on"><button>Up</button></a></p>
//   <p>ANTENNA:</p>
//   <h1>2<p><a href="/4/on"><button>Dn</button></a></p>
//
//   GET /5/on  → step Up   (increment antenna number, e.g. 2→3)
//   GET /4/on  → step Down (decrement antenna number, e.g. 2→1)
//
// The switch is a rotary selector — to reach antenna N from the current
// position we step Up or Down by the shortest path.
// Position 0 = ground, positions 1..nCh = antennas.
//
// Direction convention (matches KiwiSDR bash):
//   steps = current - target
//   steps < 0  → need to go Up   → GET /5/on
//   steps > 0  → need to go Down → GET /4/on
//
// After each step we parse the response HTML to get the new position and
// recalculate — this handles the case where someone presses the hardware
// button mid-sequence.

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

// msSNaSelectedRe matches the antenna number immediately before "<p>" in the
// device HTML, e.g. "2<p>" → 2.  Matches the KiwiSDR bash pattern [1-9](?=<p>).
// Also matches "GROUND" for the grounded state.
var msSNaSelectedRe = regexp.MustCompile(`(?i)([1-9][0-9]?)<p>|GROUND`)

// parseSelected extracts the current antenna position from the device HTML body.
// Returns 0 for ground/unknown.
func (b *msSNaWebBackend) parseSelected(body string) int {
	m := msSNaSelectedRe.FindString(body)
	if m == "" {
		return 0
	}
	if strings.EqualFold(m, "GROUND") {
		return 0
	}
	// m is like "3<p>" — TrimRight strips trailing chars in the set {<,p,>}
	numStr := strings.TrimRight(m, "<p>")
	n, err := strconv.Atoi(numStr)
	if err != nil {
		return 0
	}
	return n
}

// readSelected fetches GET / and returns the current antenna position (0=ground).
func (b *msSNaWebBackend) readSelected() (int, error) {
	body, err := httpGet(b.client, b.baseURL+"/")
	if err != nil {
		return 0, err
	}
	return b.parseSelected(body), nil
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

// msSNaShortestPath returns the signed number of steps to reach target from
// current on a ring of size nCh+1 (positions 0..nCh), using the same formula
// as the KiwiSDR bash backend:
//
//	steps = current - target
//	if steps >  nCh/2  → steps -= nCh+1
//	if steps < -nCh/2  → steps += nCh+1
//
// Positive steps → Down (/4/on), negative steps → Up (/5/on).
func msSNaShortestPath(current, target, nCh int) int {
	steps := current - target
	if steps > nCh/2 {
		steps -= nCh + 1
	}
	if steps < -(nCh / 2) {
		steps += nCh + 1
	}
	return steps
}

// stepTo moves the rotary switch to target position by the shortest path.
// target=0 means ground (GROUND position on the ring).
//
// Device behaviour (confirmed by curl testing):
//   - Ring: GROUND(0) ↔ 1 ↔ 2 ↔ 3 ↔ 4 ↔ 5 ↔ GROUND(0)
//   - GET /5/on → step Up   (increments position, GROUND→1→2→…→5→GROUND)
//   - GET /4/on → step Down (decrements position, GROUND→5→4→…→1→GROUND)
//   - Every command returns the full HTML page with the new position
//   - GROUND is shown as <p>GROUND</p> in the HTML
//   - Antenna N is shown as N<p> in the HTML
//
// Algorithm: send one step, parse the response HTML for the new position,
// recalculate and repeat. No separate GET / needed — the step response is
// authoritative. Stall detection aborts if position doesn't change.
func (b *msSNaWebBackend) stepTo(target int) (AntSwitchState, error) {
	maxSteps := 2*b.nCh + 2 // enough for any ring traversal with margin

	// Read initial position
	body, err := httpGet(b.client, b.baseURL+"/")
	if err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	current := b.parseSelected(body)

	for attempt := 0; attempt < maxSteps; attempt++ {
		if current == target {
			return b.selectedToState(current), nil
		}

		steps := msSNaShortestPath(current, target, b.nCh)

		// Choose direction:
		//   steps < 0 → need to go Up   → GET /5/on
		//   steps > 0 → need to go Down → GET /4/on
		var stepURL string
		if steps < 0 {
			stepURL = b.baseURL + "/5/on" // Up
		} else {
			stepURL = b.baseURL + "/4/on" // Down
		}

		// Send one step — the response contains the new position HTML.
		body, err = httpGet(b.client, stepURL)
		if err != nil {
			return AntSwitchState{LastError: err.Error()}, err
		}

		prev := current
		current = b.parseSelected(body)

		// Stall detection: if the position didn't change after a step, the
		// device is not responding as expected. Abort to avoid hammering it.
		if current == prev {
			log.Printf("AntSwitch ms-sNa-web: position stuck at %d after step toward %d — aborting", current, target)
			e := fmt.Errorf("ms-sNa-web: position stuck at %d after step toward %d", current, target)
			return AntSwitchState{LastError: e.Error(), LastUpdate: time.Now()}, e
		}
	}

	// Reached maxSteps without reaching target
	e := fmt.Errorf("ms-sNa-web: reached step limit (%d) without reaching target %d (at %d)", maxSteps, target, current)
	log.Printf("AntSwitch: %v", e)
	return AntSwitchState{LastError: e.Error(), LastUpdate: time.Now()}, e
}

func (b *msSNaWebBackend) SelectAntenna(n int) (AntSwitchState, error) {
	return b.stepTo(n)
}

func (b *msSNaWebBackend) GroundAll() (AntSwitchState, error) {
	return b.stepTo(0)
}

// AddAntenna: rotary switch has no mixing — treat as SelectAntenna.
func (b *msSNaWebBackend) AddAntenna(n int) (AntSwitchState, error) {
	return b.SelectAntenna(n)
}

// RemoveAntenna: rotary switch has no mixing — return current state unchanged.
func (b *msSNaWebBackend) RemoveAntenna(_ int) (AntSwitchState, error) {
	return b.GetState()
}

// ToggleAntenna: if n is currently selected, ground; otherwise select it.
func (b *msSNaWebBackend) ToggleAntenna(n int) (AntSwitchState, error) {
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
//   GET /FF0N01               → turn relay N on  (N = 1-8)
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

var kmtronicRelayTagRe = regexp.MustCompile(`relay[0-8]`)

func (b *kmtronicBackend) GetState() (AntSwitchState, error) {
	body, err := httpGet(b.client, b.baseURL+"/status.xml")
	if err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	// Strip relay tag names, keep only 0/1 digits
	digits := stripNonBinary(kmtronicRelayTagRe.ReplaceAllString(body, ""))
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
//   GET /status      → HTML: <h1>{"Status":[0,0,0,0,0,0,0,0]}</h1>
//                      Array has exactly 8 elements, one per antenna (1-indexed).
//                      1 = relay energised (antenna active), 0 = grounded.
//   GET /switch/g    → ground all
//   GET /switch/+N   → add antenna N
//   GET /switch/-N   → remove antenna N
//   GET /switch/tN   → toggle antenna N
//
// NOTE on index mapping: the KiwiSDR bash strips the entire HTML to 0/1 chars
// and iterates `for s in 1..8` (skipping index 0 due to HTML noise before the
// array). We parse the JSON array directly, so Status[0] = antenna 1,
// Status[1] = antenna 2, etc. — we iterate from index 0.

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

var snaptekkStatusRe = regexp.MustCompile(`"Status"\s*:\s*\[([01,\s]+)\]`)

func (b *snaptekkBackend) GetState() (AntSwitchState, error) {
	body, err := httpGet(b.client, b.baseURL+"/status")
	if err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}

	var bits []int
	if m := snaptekkStatusRe.FindStringSubmatch(body); m != nil {
		for _, part := range strings.Split(m[1], ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			if v, err := strconv.Atoi(part); err == nil {
				bits = append(bits, v)
			}
		}
	}

	// Fallback: strip non-0/1 chars
	if len(bits) == 0 {
		for _, ch := range stripNonBinary(body) {
			if ch == '0' {
				bits = append(bits, 0)
			} else {
				bits = append(bits, 1)
			}
		}
	}

	state := AntSwitchState{LastUpdate: time.Now()}
	// Status[0] = antenna 1, Status[1] = antenna 2, etc.
	// (We parse the JSON array directly, so no index-0 skip needed unlike the
	// KiwiSDR bash which skips index 0 due to HTML noise before the array.)
	for i := 0; i < b.nCh && i < len(bits); i++ {
		if bits[i] == 1 {
			state.Selected = append(state.Selected, i+1)
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
}

// NewAntSwitchRateLimiter creates a new rate limiter for ant-switch endpoints.
func NewAntSwitchRateLimiter() *AntSwitchRateLimiter {
	return &AntSwitchRateLimiter{
		limiters: make(map[string]map[string]*RateLimiter),
	}
}

// AllowRequest checks if a request is allowed for the given IP and endpoint.
func (rl *AntSwitchRateLimiter) AllowRequest(ip, endpoint string) bool {
	rl.mu.Lock()
	ipLimiters, exists := rl.limiters[ip]
	if !exists {
		ipLimiters = make(map[string]*RateLimiter)
		rl.limiters[ip] = ipLimiters
	}
	endpointLimiter, exists := ipLimiters[endpoint]
	if !exists {
		var refillRate, maxTokens float64
		if endpoint == "status" {
			refillRate = 5.0
			maxTokens = 5.0
		} else {
			refillRate = 1.0
			maxTokens = 1.0
		}
		endpointLimiter = &RateLimiter{
			tokens:     maxTokens,
			maxTokens:  maxTokens,
			refillRate: refillRate,
			lastRefill: time.Now(),
		}
		ipLimiters[endpoint] = endpointLimiter
	}
	rl.mu.Unlock()
	return endpointLimiter.Allow()
}

// ─── Handler ──────────────────────────────────────────────────────────────────

// AntSwitchHandler manages the antenna switch HTTP backend and HTTP API.
type AntSwitchHandler struct {
	config      *AntSwitchConfig
	backend     antSwitchBackend
	mu          sync.RWMutex
	state       AntSwitchState
	rateLimiter *AntSwitchRateLimiter
	changeLog   *AntSwitchChangeLog

	// Change callbacks — called after each antenna switch change is logged.
	changeHandlers []func(AntSwitchLogEntry)
	handlerMu      sync.RWMutex
}

// OnChange registers a callback that is called after each antenna switch change.
// Safe to call before the handler is started.
func (h *AntSwitchHandler) OnChange(fn func(AntSwitchLogEntry)) {
	if h == nil || fn == nil {
		return
	}
	h.handlerMu.Lock()
	h.changeHandlers = append(h.changeHandlers, fn)
	h.handlerMu.Unlock()
}

// logChange adds an entry to the change log and fires all registered callbacks.
func (h *AntSwitchHandler) logChange(entry AntSwitchLogEntry) {
	h.changeLog.Add(entry)
	h.handlerMu.RLock()
	handlers := make([]func(AntSwitchLogEntry), len(h.changeHandlers))
	copy(handlers, h.changeHandlers)
	h.handlerMu.RUnlock()
	if len(handlers) > 0 {
		go func() {
			for _, fn := range handlers {
				fn(entry)
			}
		}()
	}
}

// antSwitchMaxRetries is kept for API compatibility with admin.go callers.
// Since every HTTP command returns state directly, we always succeed in one
// attempt — this constant is passed through to buildCommandResult for display.
const antSwitchMaxRetries = 1

// NewAntSwitchHandler creates and initialises a new AntSwitchHandler.
func NewAntSwitchHandler(config *AntSwitchConfig) (*AntSwitchHandler, error) {
	if !config.Enabled {
		return nil, fmt.Errorf("antenna switch is not enabled in configuration")
	}
	if config.DeviceURL == "" {
		return nil, fmt.Errorf("antenna switch device_url is required")
	}
	if !strings.HasPrefix(config.DeviceURL, "http://") && !strings.HasPrefix(config.DeviceURL, "https://") {
		return nil, fmt.Errorf("antenna switch device_url must start with http:// or https:// (got %q)", config.DeviceURL)
	}
	if config.BackendType == "" {
		return nil, fmt.Errorf("antenna switch backend_type is required (ms-s7-web, ms-sNa-web, kmtronic, snaptekk)")
	}
	if config.TimeoutMs <= 0 {
		config.TimeoutMs = 2000
	}
	if config.NumAntennas < 0 || config.NumAntennas > 10 {
		return nil, fmt.Errorf("antenna switch num_antennas must be 1-10 (got %d)", config.NumAntennas)
	}
	if config.NumAntennas == 0 {
		config.NumAntennas = 8
		log.Printf("AntSwitch: num_antennas not set, defaulting to 8")
	}

	timeout := time.Duration(config.TimeoutMs) * time.Millisecond

	var backend antSwitchBackend
	switch strings.ToLower(config.BackendType) {
	case "ms-s7-web":
		backend = newMsS7WebBackend(config.DeviceURL, config.NumAntennas, timeout)
	case "ms-sna-web":
		backend = newMsSNaWebBackend(config.DeviceURL, config.NumAntennas, timeout)
	case "kmtronic":
		backend = newKmtronicBackend(config.DeviceURL, config.NumAntennas, timeout)
	case "snaptekk":
		backend = newSnaptekkBackend(config.DeviceURL, config.NumAntennas, timeout)
	default:
		return nil, fmt.Errorf("unknown antenna switch backend_type %q (valid: ms-s7-web, ms-sNa-web, kmtronic, snaptekk)", config.BackendType)
	}

	h := &AntSwitchHandler{
		config:      config,
		backend:     backend,
		rateLimiter: NewAntSwitchRateLimiter(),
		changeLog:   newAntSwitchChangeLog(100),
	}

	// Initial state query
	if state, err := h.queryState(); err != nil {
		log.Printf("AntSwitch: Warning: initial state query failed: %v", err)
	} else {
		h.mu.Lock()
		h.state = state
		h.mu.Unlock()
		log.Printf("AntSwitch: Initial state: selected=%v grounded=%v", state.Selected, state.Grounded)

		var startLabel string
		if state.Grounded {
			startLabel = "Startup: Grounded"
		} else if len(state.Selected) > 0 {
			names := make([]string, 0, len(state.Selected))
			for _, n := range state.Selected {
				names = append(names, h.antennaLabel(n))
			}
			startLabel = "Startup: " + strings.Join(names, ", ")
		} else {
			startLabel = "Startup: Unknown"
		}
		h.logChange(AntSwitchLogEntry{
			Time:     time.Now(),
			Action:   "startup",
			Antenna:  0,
			Label:    startLabel,
			Selected: state.Selected,
			Grounded: state.Grounded,
			Source:   "startup",
		})
	}

	// Select default antenna on startup if configured
	if config.DefaultAntenna > 0 {
		if config.DefaultAntenna > config.NumAntennas {
			log.Printf("AntSwitch: Warning: default_antenna %d exceeds num_antennas %d, ignoring",
				config.DefaultAntenna, config.NumAntennas)
		} else {
			log.Printf("AntSwitch: Selecting default antenna %d on startup", config.DefaultAntenna)
			if state, verified, err := h.selectAntenna(config.DefaultAntenna); err != nil {
				log.Printf("AntSwitch: Warning: failed to select default antenna %d: %v",
					config.DefaultAntenna, err)
			} else if verified {
				h.logChange(AntSwitchLogEntry{
					Time:     time.Now(),
					Action:   "default",
					Antenna:  config.DefaultAntenna,
					Label:    h.antennaLabel(config.DefaultAntenna),
					Selected: state.Selected,
					Grounded: state.Grounded,
					Source:   "startup",
				})
			}
		}
	}

	go h.backgroundPoller()

	return h, nil
}

// ─── State query ──────────────────────────────────────────────────────────────

// queryState queries the device for its current state.
func (h *AntSwitchHandler) queryState() (AntSwitchState, error) {
	return h.backend.GetState()
}

// ─── Background poller ────────────────────────────────────────────────────────

// backgroundPoller polls the device every 5 seconds to keep the state cache fresh.
// If thunderstorm mode is active and the device reports a non-grounded state
// (e.g. someone pressed the hardware button), it re-grounds the switch.
func (h *AntSwitchHandler) backgroundPoller() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		state, err := h.backend.GetState()
		if err != nil {
			h.mu.Lock()
			h.state.LastError = err.Error()
			h.mu.Unlock()
			continue
		}

		// Re-ground if thunderstorm is active but the device is not grounded.
		// This handles the case where someone physically pressed the hardware
		// button while thunderstorm mode was active.
		h.mu.RLock()
		thunderstorm := h.config.Thunderstorm
		h.mu.RUnlock()

		if thunderstorm && !state.Grounded {
			log.Printf("AntSwitch: thunderstorm mode active but device not grounded (selected=%v) — re-grounding", state.Selected)
			if groundedState, err := h.backend.GroundAll(); err != nil {
				log.Printf("AntSwitch: re-ground during thunderstorm failed: %v", err)
			} else {
				state = groundedState
			}
		}

		h.mu.Lock()
		h.state = state
		h.mu.Unlock()
	}
}

// ─── Command methods ──────────────────────────────────────────────────────────
//
// These return (AntSwitchState, bool, error) where the bool is "verified"
// (always true on HTTP success, false on error) to maintain API compatibility
// with admin.go callers that were written for the old TCP protocol.

// selectAntenna selects antenna n using the configured mixing mode.
func (h *AntSwitchHandler) selectAntenna(n int) (AntSwitchState, bool, error) {
	var (
		state AntSwitchState
		err   error
	)
	if h.config.AllowMixing {
		state, err = h.backend.ToggleAntenna(n)
	} else {
		state, err = h.backend.SelectAntenna(n)
	}
	if err != nil {
		log.Printf("AntSwitch: selectAntenna(%d): %v", n, err)
		return state, false, err
	}
	h.mu.Lock()
	h.state = state
	h.mu.Unlock()
	log.Printf("AntSwitch: selectAntenna(%d) ok, selected=%v grounded=%v", n, state.Selected, state.Grounded)
	return state, true, nil
}

// groundAll grounds all antennas.
func (h *AntSwitchHandler) groundAll() (AntSwitchState, bool, error) {
	state, err := h.backend.GroundAll()
	if err != nil {
		log.Printf("AntSwitch: groundAll: %v", err)
		return state, false, err
	}
	h.mu.Lock()
	h.state = state
	h.mu.Unlock()
	log.Printf("AntSwitch: groundAll ok, selected=%v grounded=%v", state.Selected, state.Grounded)
	return state, true, nil
}

// addAntenna adds antenna n without grounding others — admin only.
func (h *AntSwitchHandler) addAntenna(n int) (AntSwitchState, bool, error) {
	state, err := h.backend.AddAntenna(n)
	if err != nil {
		log.Printf("AntSwitch: addAntenna(%d): %v", n, err)
		return state, false, err
	}
	h.mu.Lock()
	h.state = state
	h.mu.Unlock()
	log.Printf("AntSwitch: addAntenna(%d) ok, selected=%v grounded=%v", n, state.Selected, state.Grounded)
	return state, true, nil
}

// removeAntenna removes antenna n without grounding others — admin only.
func (h *AntSwitchHandler) removeAntenna(n int) (AntSwitchState, bool, error) {
	state, err := h.backend.RemoveAntenna(n)
	if err != nil {
		log.Printf("AntSwitch: removeAntenna(%d): %v", n, err)
		return state, false, err
	}
	h.mu.Lock()
	h.state = state
	h.mu.Unlock()
	log.Printf("AntSwitch: removeAntenna(%d) ok, selected=%v grounded=%v", n, state.Selected, state.Grounded)
	return state, true, nil
}

// getState returns the current cached state (thread-safe).
func (h *AntSwitchHandler) getState() AntSwitchState {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.state
}

// GetInfo returns a compact summary suitable for /api/description and instance reporting.
func (h *AntSwitchHandler) GetInfo() map[string]interface{} {
	state := h.getState()

	info := map[string]interface{}{
		"enabled":  true,
		"grounded": state.Grounded,
	}

	selected := state.Selected
	if selected == nil {
		selected = []int{}
	}
	info["selected"] = selected

	activeLabels := make([]string, 0, len(selected))
	for _, n := range selected {
		activeLabels = append(activeLabels, h.antennaLabel(n))
	}
	info["active_labels"] = activeLabels

	return info
}

// antennaLabel returns the label for antenna n (1-based), or "Antenna N" if not configured.
func (h *AntSwitchHandler) antennaLabel(n int) string {
	if n >= 1 && n <= len(h.config.AntennaLabels) {
		if label := h.config.AntennaLabels[n-1]; label != "" {
			return label
		}
	}
	return fmt.Sprintf("Antenna %d", n)
}

// buildLabels returns the full label slice (always NumAntennas entries).
func (h *AntSwitchHandler) buildLabels() []string {
	labels := make([]string, h.config.NumAntennas)
	for i := 0; i < h.config.NumAntennas; i++ {
		labels[i] = h.antennaLabel(i + 1)
	}
	return labels
}

// ─── HTTP response helpers ────────────────────────────────────────────────────

// antSwitchCommandResult is the JSON response for control commands.
type antSwitchCommandResult struct {
	Success       bool     `json:"success"`
	Verified      bool     `json:"verified"`
	Attempts      int      `json:"attempts,omitempty"`
	Selected      []int    `json:"selected"`
	Grounded      bool     `json:"grounded"`
	AntennaLabels []string `json:"antenna_labels"`
	NumAntennas   int      `json:"num_antennas"`
	AllowMixing   bool     `json:"allow_mixing"`
	Thunderstorm  bool     `json:"thunderstorm"`
	Message       string   `json:"message,omitempty"`
	Error         string   `json:"error,omitempty"`
}

// writeAntSwitchResult writes a command result as JSON with the appropriate HTTP status:
//
//	200 = verified success
//	202 = command sent but hardware unverified
//	503 = HTTP connection failure
func writeAntSwitchResult(w http.ResponseWriter, result antSwitchCommandResult, httpErr bool) {
	w.Header().Set("Content-Type", "application/json")
	if httpErr {
		w.WriteHeader(http.StatusServiceUnavailable)
	} else if !result.Verified {
		w.WriteHeader(http.StatusAccepted)
	}
	if err := json.NewEncoder(w).Encode(result); err != nil {
		log.Printf("AntSwitch: error encoding command result: %v", err)
	}
}

// buildCommandResult builds a result struct from a completed command execution.
func (h *AntSwitchHandler) buildCommandResult(state AntSwitchState, verified bool, attempts int, err error, message string) antSwitchCommandResult {
	result := antSwitchCommandResult{
		Success:       verified,
		Verified:      verified,
		Attempts:      attempts,
		Selected:      state.Selected,
		Grounded:      state.Grounded,
		AntennaLabels: h.buildLabels(),
		NumAntennas:   h.config.NumAntennas,
		AllowMixing:   h.config.AllowMixing,
		Thunderstorm:  h.config.Thunderstorm,
		Message:       message,
	}
	if result.Selected == nil {
		result.Selected = []int{}
	}
	if err != nil {
		result.Error = err.Error()
	}
	if !verified && err == nil {
		result.Error = "command sent but hardware did not respond as expected"
	}
	return result
}

// ─── Public HTTP endpoints ────────────────────────────────────────────────────

// HandleGetStatus handles GET /api/ant-switch/status
func (h *AntSwitchHandler) HandleGetStatus(w http.ResponseWriter, r *http.Request) {
	clientIP := getClientIP(r)
	if !h.rateLimiter.AllowRequest(clientIP, "status") {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": "Rate limit exceeded"})
		return
	}

	state := h.getState()

	w.Header().Set("Content-Type", "application/json")
	resp := map[string]interface{}{
		"enabled":        true,
		"selected":       state.Selected,
		"grounded":       state.Grounded,
		"allow_mixing":   h.config.AllowMixing,
		"num_antennas":   h.config.NumAntennas,
		"antenna_labels": h.buildLabels(),
		"thunderstorm":   h.config.Thunderstorm,
		"last_update":    state.LastUpdate,
	}
	if state.Selected == nil {
		resp["selected"] = []int{}
	}
	if state.LastError != "" {
		resp["last_error"] = state.LastError
	}
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		log.Printf("AntSwitch: error encoding status: %v", err)
	}
}

// HandleGetStatusDisabled handles GET /api/ant-switch/status when disabled.
func HandleGetStatusDisabled(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusServiceUnavailable)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"enabled":  false,
		"error":    "Antenna switch is not enabled",
		"selected": []int{},
		"grounded": false,
	})
}

// antSwitchPublicCommandRequest is the JSON body for POST /api/ant-switch/command.
type antSwitchPublicCommandRequest struct {
	Password string `json:"password"`
	Command  string `json:"command"`
	Antenna  int    `json:"antenna,omitempty"`
}

// HandlePublicCommand handles POST /api/ant-switch/command
func (h *AntSwitchHandler) HandlePublicCommand(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	clientIP := getClientIP(r)
	if !h.rateLimiter.AllowRequest(clientIP, "command") {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   "Rate limit exceeded",
		})
		return
	}

	if h.config.Thunderstorm {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   "Thunderstorm mode active — antenna switching is disabled",
		})
		return
	}

	var req antSwitchPublicCommandRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("Invalid request body: %v", err), http.StatusBadRequest)
		return
	}

	if h.config.Password == "" || req.Password != h.config.Password {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   "Unauthorized — password required",
		})
		return
	}

	switch req.Command {
	case "select":
		if req.Antenna < 1 || req.Antenna > h.config.NumAntennas {
			http.Error(w, fmt.Sprintf("antenna must be 1-%d", h.config.NumAntennas), http.StatusBadRequest)
			return
		}
		state, verified, err := h.selectAntenna(req.Antenna)
		httpErr := err != nil && !verified && state.LastUpdate.IsZero()
		if verified {
			h.logChange(AntSwitchLogEntry{
				Time:     time.Now(),
				Action:   "select",
				Antenna:  req.Antenna,
				Label:    h.antennaLabel(req.Antenna),
				Selected: state.Selected,
				Grounded: state.Grounded,
				Source:   "public",
			})
		}
		result := h.buildCommandResult(state, verified, antSwitchMaxRetries, err,
			fmt.Sprintf("Selected antenna %d (%s)", req.Antenna, h.antennaLabel(req.Antenna)))
		writeAntSwitchResult(w, result, httpErr)

	case "ground":
		state, verified, err := h.groundAll()
		httpErr := err != nil && !verified && state.LastUpdate.IsZero()
		if verified {
			h.logChange(AntSwitchLogEntry{
				Time:     time.Now(),
				Action:   "ground",
				Antenna:  0,
				Label:    "Ground all",
				Selected: state.Selected,
				Grounded: state.Grounded,
				Source:   "public",
			})
		}
		result := h.buildCommandResult(state, verified, antSwitchMaxRetries, err, "Grounded all antennas")
		writeAntSwitchResult(w, result, httpErr)

	default:
		http.Error(w, fmt.Sprintf("Unknown command %q (valid: select, ground)", req.Command), http.StatusBadRequest)
	}
}

// HandleGetHistory handles GET /api/ant-switch/history
func (h *AntSwitchHandler) HandleGetHistory(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	entries := h.changeLog.Snapshot()
	if entries == nil {
		entries = []AntSwitchLogEntry{}
	}
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"history": entries,
		"count":   len(entries),
	}); err != nil {
		log.Printf("AntSwitch: error encoding history: %v", err)
	}
}

// HandleGetHistoryDisabled handles GET /api/ant-switch/history when disabled.
func HandleGetHistoryDisabled(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusServiceUnavailable)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"enabled": false,
		"history": []interface{}{},
		"count":   0,
	})
}

// HandlePublicCommandDisabled handles POST /api/ant-switch/command when disabled.
func HandlePublicCommandDisabled(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusServiceUnavailable)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": false,
		"error":   "Antenna switch is not enabled",
	})
}

// ─── Route registration ───────────────────────────────────────────────────────

// RegisterAntSwitchRoutes registers antenna switch API routes with the HTTP server.
func RegisterAntSwitchRoutes(mux *http.ServeMux, handler *AntSwitchHandler) {
	mux.HandleFunc("/api/ant-switch/status", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			handler.HandleGetStatus(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/api/ant-switch/command", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			handler.HandlePublicCommand(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/api/ant-switch/history", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			handler.HandleGetHistory(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})
}

// RegisterAntSwitchRoutesDisabled registers ant-switch API routes that return "not enabled" responses.
func RegisterAntSwitchRoutesDisabled(mux *http.ServeMux) {
	mux.HandleFunc("/api/ant-switch/status", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			HandleGetStatusDisabled(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/api/ant-switch/command", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			HandlePublicCommandDisabled(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/api/ant-switch/history", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			HandleGetHistoryDisabled(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})
}

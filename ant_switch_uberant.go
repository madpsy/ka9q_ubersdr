package main

// ─── UberANT backend ──────────────────────────────────────────────────────────
//
// UberANT (ESP8266 firmware — github.com/ka9q/ubersdr_switch)
//
// A rotary antenna switch with a clean JSON REST API. Direct port selection
// is supported — no step-loop needed unlike ms-sNa-web.
//
//   GET  /api/status              → status object (position, ground, max, locked, label)
//   POST /api/antenna?position=N  → select port N (0=GROUND, 1..max=ANT N)
//   POST /api/antenna/ground      → select GROUND (position 0)
//   GET  /api/names               → {"1":"40m Dipole","3":"80m Vertical"}
//   POST /api/name?position=N&name=... → set name for ANT N (max 16 chars)
//   POST /api/name?position=N&name=   → clear name for ANT N
//   POST /api/lock                → {"locked":true|false}
//
// The device returns HTTP 423 Locked when a change is attempted while locked.
// Every mutating endpoint returns the full status object — no separate verify
// query is needed.
//
// This backend implements three optional interfaces beyond antSwitchBackend:
//   - antSwitchRenamer  (SetName / ClearName)
//   - antSwitchLocker   (SetLock)
//   - antSwitchNamer    (Names)

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// uberantStatusResponse is the JSON shape returned by /api/status and most
// mutating endpoints on the UberANT device.
type uberantStatusResponse struct {
	Position int    `json:"position"`
	Ground   bool   `json:"ground"`
	Max      int    `json:"max"`
	Count    int    `json:"count"`
	Locked   bool   `json:"locked"`
	Label    string `json:"label"`
	Name     string `json:"name"`
}

// uberantBackend drives the UberANT ESP8266 antenna switch over its JSON REST API.
type uberantBackend struct {
	client  *http.Client
	baseURL string
	nCh     int
}

func newUberantBackend(deviceURL string, nCh int, timeout time.Duration) *uberantBackend {
	return &uberantBackend{
		client:  &http.Client{Timeout: timeout},
		baseURL: strings.TrimRight(deviceURL, "/"),
		nCh:     nCh,
	}
}

// doJSON performs an HTTP request and decodes the JSON response body.
// method may be GET, POST, DELETE, etc.
// body may be nil (no request body sent).
func (b *uberantBackend) doJSON(method, rawURL string, body interface{}, out interface{}) error {
	var reqBody io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal request body: %w", err)
		}
		reqBody = bytes.NewReader(data)
	}

	req, err := http.NewRequest(method, rawURL, reqBody)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := b.client.Do(req)
	if err != nil {
		return fmt.Errorf("%s %s: %w", method, rawURL, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusLocked {
		return fmt.Errorf("uberant: device is locked (HTTP 423)")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("uberant: %s %s returned HTTP %d: %s", method, rawURL, resp.StatusCode, strings.TrimSpace(string(respBody)))
	}

	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			return fmt.Errorf("decode response from %s: %w", rawURL, err)
		}
	}
	return nil
}

// parseStatus converts a uberantStatusResponse into an AntSwitchState.
func (b *uberantBackend) parseStatus(s uberantStatusResponse) AntSwitchState {
	state := AntSwitchState{LastUpdate: time.Now()}
	if s.Ground || s.Position == 0 {
		state.Grounded = true
	} else {
		state.Selected = []int{s.Position}
	}
	return state
}

// ─── antSwitchBackend interface ───────────────────────────────────────────────

// GetState queries GET /api/status and returns the current antenna state.
func (b *uberantBackend) GetState() (AntSwitchState, error) {
	var s uberantStatusResponse
	if err := b.doJSON(http.MethodGet, b.baseURL+"/api/status", nil, &s); err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	return b.parseStatus(s), nil
}

// SelectAntenna selects antenna n directly via POST /api/antenna?position=N.
func (b *uberantBackend) SelectAntenna(n int) (AntSwitchState, error) {
	u := fmt.Sprintf("%s/api/antenna?position=%d", b.baseURL, n)
	var s uberantStatusResponse
	if err := b.doJSON(http.MethodPost, u, nil, &s); err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	return b.parseStatus(s), nil
}

// GroundAll selects GROUND via POST /api/antenna/ground.
func (b *uberantBackend) GroundAll() (AntSwitchState, error) {
	var s uberantStatusResponse
	if err := b.doJSON(http.MethodPost, b.baseURL+"/api/antenna/ground", nil, &s); err != nil {
		return AntSwitchState{LastError: err.Error()}, err
	}
	return b.parseStatus(s), nil
}

// AddAntenna: rotary switch has no mixing — treat as SelectAntenna.
func (b *uberantBackend) AddAntenna(n int) (AntSwitchState, error) {
	return b.SelectAntenna(n)
}

// RemoveAntenna: rotary switch has no mixing — return current state unchanged.
func (b *uberantBackend) RemoveAntenna(_ int) (AntSwitchState, error) {
	return b.GetState()
}

// ToggleAntenna: if n is currently selected, ground; otherwise select it.
func (b *uberantBackend) ToggleAntenna(n int) (AntSwitchState, error) {
	state, err := b.GetState()
	if err != nil {
		return state, err
	}
	if len(state.Selected) == 1 && state.Selected[0] == n {
		return b.GroundAll()
	}
	return b.SelectAntenna(n)
}

// ─── antSwitchNamer optional interface ───────────────────────────────────────

// Names fetches all custom port names from the device via GET /api/names.
// Returns a map of port number (1-based) → name string.
// Ports with no custom name are absent from the map.
func (b *uberantBackend) Names() map[int]string {
	var raw map[string]string
	if err := b.doJSON(http.MethodGet, b.baseURL+"/api/names", nil, &raw); err != nil {
		log.Printf("AntSwitch uberant: failed to fetch port names: %v", err)
		return nil
	}
	out := make(map[int]string, len(raw))
	for k, v := range raw {
		var port int
		if _, err := fmt.Sscanf(k, "%d", &port); err == nil && port >= 1 && v != "" {
			out[port] = v
		}
	}
	return out
}

// ─── antSwitchRenamer optional interface ─────────────────────────────────────

// SetName pushes a custom name for port n to the device.
// POST /api/name?position=N&name=<url-encoded-name>
// The UberANT caps names at 16 characters; the caller should enforce this.
func (b *uberantBackend) SetName(port int, name string) error {
	u := fmt.Sprintf("%s/api/name?position=%d&name=%s", b.baseURL, port, url.QueryEscape(name))
	return b.doJSON(http.MethodPost, u, nil, nil)
}

// ClearName removes the custom name for port n from the device.
// POST /api/name?position=N&name= (empty name clears it)
func (b *uberantBackend) ClearName(port int) error {
	u := fmt.Sprintf("%s/api/name?position=%d&name=", b.baseURL, port)
	return b.doJSON(http.MethodPost, u, nil, nil)
}

// ─── antSwitchLocker optional interface ──────────────────────────────────────

// SetLock sets the hardware lock state on the device.
// POST /api/lock with body {"locked": true|false}
// When locked, physical button presses and API antenna changes return HTTP 423.
func (b *uberantBackend) SetLock(locked bool) error {
	body := map[string]bool{"locked": locked}
	return b.doJSON(http.MethodPost, b.baseURL+"/api/lock", body, nil)
}

// ─── antSwitchTester optional interface ──────────────────────────────────────

// ShowTestMessage sends a two-line test message to the UberANT OLED display.
// POST /api/display with {"text":"UberSDR\nSuccess","duration":5,"align":"center"}
// The message is shown for 5 seconds then the display resumes normal operation.
func (b *uberantBackend) ShowTestMessage() error {
	body := map[string]interface{}{
		"text":     "UberSDR\nSuccess",
		"duration": 5,
		"align":    "center",
	}
	return b.doJSON(http.MethodPost, b.baseURL+"/api/display", body, nil)
}

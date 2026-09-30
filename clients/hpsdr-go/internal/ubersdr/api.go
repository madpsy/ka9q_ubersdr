// Package ubersdr is the bridge's side of the UberSDR HTTP and WebSocket API:
// the /connection precheck, the receiver's description, the public directory,
// and the IQ socket itself.
package ubersdr

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// UserAgent identifies the bridge on every request, HTTP and WebSocket alike.
//
// It is part of the handshake rather than decoration: the server records the
// User-Agent a session presented to /connection and refuses a socket for a
// session ID it has never seen one from. The C bridge sends the same string, so
// an operator's logs read the same whichever one is running.
const UserAgent = "UberSDR_HPSDR/1.0"

// WideIQModes are the IQ modes the HPSDR protocol can carry, in rate order.
// They are exactly the four DDC rates both protocols define a code for. Plain
// "iq" (12 kHz) is not one of them.
var WideIQModes = []string{"iq48", "iq96", "iq192", "iq384"}

// ModeForKHz names the IQ mode for a rate in kHz, clamped into the range the
// server offers.
//
// The mode is named in two places -- the connect URL and every tune message --
// and they have to agree: the server changes a session's mode to whatever a
// tune tells it, so a tune carrying a different mode silently reconfigures the
// session. One function so there is one answer.
func ModeForKHz(khz int) string {
	if khz > 384 {
		khz = 384
	}
	if khz < 48 {
		khz = 48
	}
	return fmt.Sprintf("iq%d", khz)
}

// KHzForMode is the rate of a wide IQ mode, or 0 for anything else.
func KHzForMode(mode string) int {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "iq48":
		return 48
	case "iq96":
		return 96
	case "iq192":
		return 192
	case "iq384":
		return 384
	}
	return 0
}

// Server is one UberSDR instance as the bridge talks to it.
type Server struct {
	// Base is scheme://host[:port], with no path and no trailing slash.
	Base     string
	Password string

	// HTTP is the client for the API calls; nil uses a default with the
	// timeouts and TLS policy below.
	HTTP *http.Client
}

// NewServer normalises a URL as an operator might type it and returns the
// server it names.
func NewServer(rawURL, password string) (*Server, error) {
	base, err := NormalizeURL(rawURL)
	if err != nil {
		return nil, err
	}
	return &Server{Base: base, Password: password}, nil
}

// NormalizeURL accepts what an operator is likely to type -- "host:8080",
// "http://host:8080/", "wss://host" -- and returns the scheme://host[:port]
// base the API calls hang off.
//
// A path is refused rather than dropped. The C bridge appended /connection to
// the whole URL but opened the socket at /ws on the bare host, so a path worked
// for one and not the other; saying so beats reproducing that.
func NormalizeURL(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", fmt.Errorf("no server URL given")
	}
	if !strings.Contains(s, "://") {
		s = "http://" + s
	}
	u, err := url.Parse(s)
	if err != nil {
		return "", fmt.Errorf("%q is not a URL: %w", raw, err)
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "ws":
		u.Scheme = "http"
	case "https", "wss":
		u.Scheme = "https"
	default:
		return "", fmt.Errorf("%q: scheme must be http or https", raw)
	}
	if u.Host == "" || u.Hostname() == "" {
		return "", fmt.Errorf("%q names no host", raw)
	}
	if p := strings.TrimRight(u.Path, "/"); p != "" {
		return "", fmt.Errorf("%q: a path is not supported, give the receiver's address only", raw)
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("%q: a query string is not supported", raw)
	}
	return u.Scheme + "://" + u.Host, nil
}

// Secure reports whether the server is reached over TLS.
func (s *Server) Secure() bool { return strings.HasPrefix(s.Base, "https://") }

// Host is the host[:port] part of the base.
func (s *Server) Host() string {
	return strings.TrimPrefix(strings.TrimPrefix(s.Base, "https://"), "http://")
}

func (s *Server) client() *http.Client {
	if s.HTTP != nil {
		return s.HTTP
	}
	return defaultHTTP
}

// defaultHTTP skips certificate verification, as the C bridge does
// (LCCSCF_ALLOW_SELFSIGNED and no hostname check): receivers behind
// self-signed certificates are common in this project's deployments.
var defaultHTTP = &http.Client{
	Timeout: 10 * time.Second,
	Transport: &http.Transport{
		Proxy:           http.ProxyFromEnvironment,
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec
	},
}

// NewSessionID returns a random UUID v4.
//
// A fresh one is needed for every connect: the server invalidates a session
// when its socket closes, and reusing the ID answers "Invalid session".
func NewSessionID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err) // crypto/rand does not fail on any supported platform
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// ConnResult is the server's answer to /connection.
type ConnResult struct {
	Allowed bool
	Reason  string
	Status  int

	// Bypassed: the session's limits are lifted and every wide IQ mode is on
	// offer. Granted by a matching password OR by the address being on the
	// operator's list.
	Bypassed bool

	// AllowedIQModes is the wide IQ modes this session may use, in rate order.
	// ModesKnown is false when the server did not say (an older one), in which
	// case nothing can be concluded and the socket's own refusal is the answer.
	AllowedIQModes []string
	ModesKnown     bool

	// MaxSessionTime in seconds; zero means unlimited.
	MaxSessionTime int
}

// Check performs the /connection precheck for one session ID. It returns an
// error only when the server could not be asked; a refusal is a result.
func (s *Server) Check(ctx context.Context, sessionID string) (ConnResult, error) {
	body, _ := json.Marshal(map[string]string{
		"user_session_id": sessionID,
		"password":        s.Password,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.Base+"/connection", bytes.NewReader(body))
	if err != nil {
		return ConnResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", UserAgent)

	resp, err := s.client().Do(req)
	if err != nil {
		return ConnResult{}, fmt.Errorf("cannot reach %s: %w", s.Host(), err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return ConnResult{}, fmt.Errorf("reading /connection: %w", err)
	}
	return parseConnResult(raw, resp.StatusCode)
}

func parseConnResult(raw []byte, status int) (ConnResult, error) {
	var payload struct {
		Allowed        bool      `json:"allowed"`
		Reason         string    `json:"reason"`
		Bypassed       bool      `json:"bypassed"`
		AllowedIQModes *[]string `json:"allowed_iq_modes"`
		MaxSessionTime int       `json:"max_session_time"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return ConnResult{Status: status}, fmt.Errorf("bad /connection response (HTTP %d): %w", status, err)
	}
	r := ConnResult{
		Allowed:        payload.Allowed,
		Reason:         payload.Reason,
		Status:         status,
		Bypassed:       payload.Bypassed,
		MaxSessionTime: payload.MaxSessionTime,
	}
	if payload.AllowedIQModes != nil {
		r.ModesKnown = true
		r.AllowedIQModes = filterWideModes(*payload.AllowedIQModes)
	}
	return r, nil
}

// filterWideModes keeps the modes this bridge can serve, in rate order, so a
// receiver listing them in another order or naming one this build does not
// know changes nothing.
func filterWideModes(names []string) []string {
	named := map[string]bool{}
	for _, n := range names {
		named[strings.ToLower(strings.TrimSpace(n))] = true
	}
	out := []string{}
	for _, m := range WideIQModes {
		if named[m] {
			out = append(out, m)
		}
	}
	return out
}

// AllowsKHz reports whether a rate may be asked for. An older server that said
// nothing allows everything as far as this end can tell.
func (r ConnResult) AllowsKHz(khz int) bool {
	if !r.ModesKnown {
		return true
	}
	for _, m := range r.AllowedIQModes {
		if KHzForMode(m) == khz {
			return true
		}
	}
	return false
}

// RateLimited reports a refusal for opening too many sessions too quickly: the
// server allows an address about ten prechecks a minute unless its session is
// bypassed. It passes; nothing about the request needs changing.
func (r ConnResult) RateLimited() bool { return r.Status == http.StatusTooManyRequests }

// Refusal words a refused precheck for the operator. The server refuses a wrong
// password and a missing one with the same status, so which side needs fixing
// is worth naming.
func (r ConnResult) Refusal(passwordGiven bool) string {
	reason := r.Reason
	if reason == "" {
		reason = "connection refused by server"
	}
	if r.Status == http.StatusForbidden {
		switch {
		case passwordGiven:
			return reason + " (the password was not accepted)"
		case strings.Contains(strings.ToLower(reason), "password"):
			return reason + " (this receiver needs a password)"
		}
	}
	return reason
}

// PasswordState says what became of a password.
type PasswordState int

const (
	PasswordNone PasswordState = iota
	// PasswordAccepted: given, and the session is bypassed.
	PasswordAccepted
	// PasswordIgnored: given, allowed, and not bypassed -- which can only mean
	// the receiver has no bypass password configured, since one that has
	// refuses a mismatch outright.
	PasswordIgnored
)

// PasswordOutcome classifies an allowed result.
func (r ConnResult) PasswordOutcome(passwordGiven bool) PasswordState {
	switch {
	case !passwordGiven:
		return PasswordNone
	case r.Bypassed:
		return PasswordAccepted
	default:
		return PasswordIgnored
	}
}

func (p PasswordState) String() string {
	switch p {
	case PasswordAccepted:
		return "password accepted, session bypassed"
	case PasswordIgnored:
		return "password had no effect: this receiver uses no bypass password"
	default:
		return ""
	}
}

// Default tuning range: what a receiver that publishes nothing is assumed to
// cover, and what the C bridge assumed before the span became configurable.
const (
	DefaultMinHz = 10_000
	DefaultMaxHz = 30_000_000
)

// Description is what the bridge uses from /api/description.
type Description struct {
	Name     string
	Callsign string
	Location string
	Version  string

	// MinHz and MaxHz are the receiver's tuning range, defaulted when it
	// publishes none. RangeNote explains a fallback worth mentioning.
	MinHz, MaxHz int64
	RangeNote    string
}

// Describe fetches /api/description. The tuning range falls back to the
// defaults on any failure, so the error is informational.
func (s *Server) Describe(ctx context.Context) (Description, error) {
	d := Description{MinHz: DefaultMinHz, MaxHz: DefaultMaxHz}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.Base+"/api/description", nil)
	if err != nil {
		return d, err
	}
	req.Header.Set("User-Agent", UserAgent)
	resp, err := s.client().Do(req)
	if err != nil {
		return d, fmt.Errorf("cannot reach %s: %w", s.Host(), err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return d, fmt.Errorf("/api/description: HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return d, err
	}
	return parseDescription(raw)
}

func parseDescription(raw []byte) (Description, error) {
	d := Description{MinHz: DefaultMinHz, MaxHz: DefaultMaxHz}
	var payload struct {
		Receiver struct {
			Name     string `json:"name"`
			Callsign string `json:"callsign"`
			Location string `json:"location"`
		} `json:"receiver"`
		Version     string `json:"version"`
		TuningRange *struct {
			Min *float64 `json:"min_frequency"`
			Max *float64 `json:"max_frequency"`
		} `json:"tuning_range"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return d, fmt.Errorf("bad /api/description: %w", err)
	}
	d.Name = payload.Receiver.Name
	d.Callsign = payload.Receiver.Callsign
	d.Location = payload.Receiver.Location
	d.Version = payload.Version

	if tr := payload.TuningRange; tr != nil {
		// Each edge falls back on its own: they are independent facts, and a
		// receiver that states one must not reset the other.
		min, max := int64(DefaultMinHz), int64(DefaultMaxHz)
		if tr.Min != nil && *tr.Min > 0 {
			min = int64(*tr.Min)
		}
		if tr.Max != nil && *tr.Max > 0 {
			max = int64(*tr.Max)
		}
		// A max at or below the min is a misconfiguration, and adopting it
		// would invert every range check. Refused outright, both edges.
		if max > min {
			d.MinHz, d.MaxHz = min, max
		} else {
			d.RangeNote = fmt.Sprintf("receiver reports an inverted range (%d - %d Hz); assuming %d - %d",
				min, max, d.MinHz, d.MaxHz)
		}
	}
	return d, nil
}

// InRange reports whether a frequency is inside the tuning range. Zero -- a
// DDC nobody has tuned -- is never out of range.
func (d Description) InRange(hz int64) bool {
	return hz == 0 || (hz >= d.MinHz && hz <= d.MaxHz)
}

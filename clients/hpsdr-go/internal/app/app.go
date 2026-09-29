// Package app is what the headless mode and the TUI share: the settings an
// operator chooses, the probe that tells them what a receiver will allow, and
// turning the two into a running bridge.
package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ka9q/ubersdr/clients/hpsdr-go/internal/hpsdr"
	"github.com/ka9q/ubersdr/clients/hpsdr-go/internal/ubersdr"
)

// Settings are the operator's choices.
type Settings struct {
	URL      string `json:"url"`
	Password string `json:"password,omitempty"`
	// RememberPassword keeps the password in the settings file. Off by default:
	// the file is plain text, readable by anything running as this user.
	RememberPassword bool `json:"remember_password,omitempty"`

	Receivers int `json:"receivers"`
	Device    int `json:"device"`
	MinMargin int `json:"min_margin"`
	// Rates the operator wants offered, in kHz. Empty is every rate the
	// receiver allows.
	Rates []int `json:"rates,omitempty"`
	// Interface names the network interface, "" for the default route's.
	Interface string `json:"interface,omitempty"`

	Wideband     bool   `json:"wideband,omitempty"`
	WidebandFile string `json:"wideband_file,omitempty"`
	Debug        bool   `json:"debug,omitempty"`
}

// Defaults are what the C bridge started with, except the URL: it defaulted to
// localhost, which is right for a bridge on the receiver's own machine and
// nowhere else, so the TUI asks instead.
func Defaults() Settings {
	return Settings{
		URL:       "http://localhost:8080",
		Receivers: hpsdr.MaxReceivers,
		Device:    hpsdr.DeviceHermesLite,
		MinMargin: ubersdr.MinMarginDefaultDB,
	}
}

// Validate checks everything that can be checked without the network.
func (s Settings) Validate() error {
	if _, err := ubersdr.NormalizeURL(s.URL); err != nil {
		return err
	}
	if s.Receivers < 1 || s.Receivers > hpsdr.MaxReceivers {
		return fmt.Errorf("receivers must be 1-%d", hpsdr.MaxReceivers)
	}
	if s.Device != hpsdr.DeviceHermes && s.Device != hpsdr.DeviceHermesLite {
		return fmt.Errorf("device must be %d (Hermes) or %d (Hermes Lite)", hpsdr.DeviceHermes, hpsdr.DeviceHermesLite)
	}
	if s.MinMargin != 0 && (s.MinMargin < ubersdr.MinMarginMinDB || s.MinMargin > ubersdr.MinMarginMaxDB) {
		return fmt.Errorf("min-margin must be 0 (lossless) or %d-%d dB", ubersdr.MinMarginMinDB, ubersdr.MinMarginMaxDB)
	}
	for _, r := range s.Rates {
		if hpsdr.RateMask([]int{r}) == 0 {
			return fmt.Errorf("%d kHz is not an HPSDR rate (48, 96, 192, 384)", r)
		}
	}
	return nil
}

// ---- persistence ----------------------------------------------------------

// SettingsPath is where the TUI keeps its settings: the platform's own config
// directory (~/.config on Linux, ~/Library/Application Support on macOS,
// %AppData% on Windows).
func SettingsPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "ubersdr-hpsdr", "settings.json"), nil
}

// Load reads settings, returning the defaults when there are none.
func Load(path string) (Settings, error) {
	s := Defaults()
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return Defaults(), fmt.Errorf("%s: %w", path, err)
	}
	return s, nil
}

// Save writes settings, owner-only, leaving the password out unless asked.
func Save(path string, s Settings) error {
	if !s.RememberPassword {
		s.Password = ""
	}
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ---- probe ------------------------------------------------------------------

// Probe is what a receiver says about a would-be session: whether it is
// allowed, with what IQ modes, and how far it tunes.
type Probe struct {
	Server *ubersdr.Server

	// Reached is false when /connection could not be asked at all.
	Reached bool
	Err     error
	Conn    ubersdr.ConnResult

	Desc    ubersdr.Description
	DescErr error
}

// RunProbe asks the receiver, with a session ID of its own. The server keeps
// nothing that matters about a session that never opens a socket.
func RunProbe(ctx context.Context, rawURL, password string) (*Probe, error) {
	srv, err := ubersdr.NewServer(rawURL, password)
	if err != nil {
		return nil, err
	}
	p := &Probe{Server: srv}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	p.Conn, p.Err = srv.Check(ctx, ubersdr.NewSessionID())
	p.Reached = p.Err == nil
	p.Desc, p.DescErr = srv.Describe(ctx)
	return p, nil
}

// AllowedKHz is the rates the session may use, in order; all four when the
// receiver did not say or could not be asked.
func (p *Probe) AllowedKHz() []int {
	var out []int
	for _, m := range ubersdr.WideIQModes {
		k := ubersdr.KHzForMode(m)
		if !p.Reached || p.Conn.AllowsKHz(k) {
			out = append(out, k)
		}
	}
	return out
}

// Summary is the probe in a few lines for an operator.
func (p *Probe) Summary() []string {
	var out []string
	name := p.Server.Host()
	if p.Desc.Callsign != "" || p.Desc.Name != "" {
		name = strings.TrimSpace(p.Desc.Callsign + " " + p.Desc.Name)
		if p.Desc.Location != "" {
			name += ", " + p.Desc.Location
		}
	}
	out = append(out, "Receiver: "+name)
	switch {
	case !p.Reached:
		out = append(out, "Not reachable: "+p.Err.Error())
		return out
	case !p.Conn.Allowed:
		out = append(out, "Refused: "+p.Conn.Refusal(p.Server.Password != ""))
		return out
	}
	access := "public session"
	if p.Conn.Bypassed {
		access = "bypassed session (no time limit, all IQ modes)"
	}
	if note := p.Conn.PasswordOutcome(p.Server.Password != "").String(); note != "" {
		access += "; " + note
	}
	out = append(out, "Allowed: "+access)
	switch {
	case !p.Conn.ModesKnown:
		out = append(out, "IQ rates: not reported by this server (older version); offering all")
	case len(p.Conn.AllowedIQModes) == 0:
		out = append(out, "IQ rates: none open to this session. A password may be needed.")
	default:
		out = append(out, "IQ rates: "+strings.Join(p.Conn.AllowedIQModes, ", "))
	}
	out = append(out, fmt.Sprintf("Tunes %.3f kHz - %.3f MHz", float64(p.Desc.MinHz)/1e3, float64(p.Desc.MaxHz)/1e6))
	if p.Desc.RangeNote != "" {
		out = append(out, p.Desc.RangeNote)
	}
	return out
}

// OfferedKHz is what to offer clients: the operator's choice (or everything)
// cut down to what the session may use. When nothing is left, the choice is
// offered anyway and ok is false: the server's refusal is then the message the
// operator sees, rather than a bridge that silently advertises no rates.
func OfferedKHz(wanted, allowed []int) (offered []int, ok bool) {
	if len(wanted) == 0 {
		wanted = []int{48, 96, 192, 384}
	}
	in := map[int]bool{}
	for _, a := range allowed {
		in[a] = true
	}
	for _, w := range wanted {
		if in[w] {
			offered = append(offered, w)
		}
	}
	if len(offered) == 0 {
		return wanted, false
	}
	return offered, true
}

// ResolveInterface returns the named interface, or the default route's.
func ResolveInterface(name string) (hpsdr.Iface, error) {
	if name == "" {
		return hpsdr.DefaultInterface()
	}
	return hpsdr.FindInterface(name)
}

// Build makes a bridge from settings and a probe. The notes are worth showing
// the operator once, before the bridge starts logging.
func Build(s Settings, p *Probe, logf func(string)) (*hpsdr.Bridge, []string, error) {
	if err := s.Validate(); err != nil {
		return nil, nil, err
	}
	var notes []string
	notes = append(notes, p.Summary()...)

	offered, ok := OfferedKHz(s.Rates, p.AllowedKHz())
	if !ok {
		notes = append(notes, fmt.Sprintf("WARNING none of the chosen rates (%s kHz) is open to this session; offering them anyway",
			joinKHz(offered)))
	}

	ifc, err := ResolveInterface(s.Interface)
	if err != nil {
		return nil, notes, err
	}
	iface := hpsdr.Iface{}
	if s.Interface != "" {
		// Only an explicit choice restricts who is answered; the automatic one
		// supplies the MAC and nothing else, as the C bridge's did.
		iface = ifc
	}
	notes = append(notes, "Interface: "+ifc.String())

	if s.MinMargin > 0 {
		def := ""
		if s.MinMargin == ubersdr.MinMarginDefaultDB {
			def = " (the default; 0 for the lossless stream)"
		}
		notes = append(notes, fmt.Sprintf("Reduced-depth IQ: %d dB of margin under the noise floor%s", s.MinMargin, def))
	} else {
		notes = append(notes, "Reduced-depth IQ off: taking the lossless stream")
	}

	b, err := hpsdr.New(hpsdr.Config{
		Server:       p.Server,
		NumRx:        s.Receivers,
		Device:       byte(s.Device),
		MinMargin:    s.MinMargin,
		RatesKHz:     offered,
		MAC:          hpsdr.MACFor(ifc),
		Iface:        iface,
		MinHz:        p.Desc.MinHz,
		MaxHz:        p.Desc.MaxHz,
		Wideband:     s.Wideband,
		WidebandFile: s.WidebandFile,
		Debug:        s.Debug,
		Logf:         logf,
	})
	return b, notes, err
}

func joinKHz(v []int) string {
	parts := make([]string, len(v))
	for i, x := range v {
		parts[i] = fmt.Sprint(x)
	}
	return strings.Join(parts, "/")
}

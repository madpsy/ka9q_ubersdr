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
	"sync"
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

	// BandInstances are further receivers, each taking the DDCs tuned to its
	// bands, while URL takes everything else. None, the default, sends every
	// band to URL.
	BandInstances []BandInstance `json:"band_instances,omitempty"`
}

// BandInstance is a receiver for some bands.
type BandInstance struct {
	URL      string   `json:"url"`
	Password string   `json:"password,omitempty"`
	Bands    []string `json:"bands"`
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
	return ValidateBandInstances(s.URL, s.BandInstances)
}

// ValidateBandInstances checks band receivers against each other and the main
// one: each is a distinct receiver with at least one band, and no band is set
// for two.
func ValidateBandInstances(mainURL string, list []BandInstance) error {
	main, _ := ubersdr.NormalizeURL(mainURL)
	seen := map[string]bool{main: true}
	claimed := map[string]string{}
	for _, bi := range list {
		base, err := ubersdr.NormalizeURL(bi.URL)
		if err != nil {
			return fmt.Errorf("band receiver: %w", err)
		}
		if seen[base] {
			return fmt.Errorf("%s is listed twice; one receiver can have several bands", base)
		}
		seen[base] = true
		if len(bi.Bands) == 0 {
			return fmt.Errorf("%s has no bands", base)
		}
		for _, n := range bi.Bands {
			b, ok := hpsdr.BandNamed(n)
			if !ok {
				return fmt.Errorf("%s: %q is not a band (%s)", base, n, hpsdr.BandNames())
			}
			if other, dup := claimed[b.Name]; dup {
				return fmt.Errorf("%s is set for both %s and %s", b.Name, other, base)
			}
			claimed[b.Name] = base
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
		// A copy: the caller's slice is still in use.
		bis := make([]BandInstance, len(s.BandInstances))
		for i, bi := range s.BandInstances {
			bi.Password = ""
			bis[i] = bi
		}
		if len(bis) > 0 {
			s.BandInstances = bis
		}
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

// RunProbes checks the main receiver and every band receiver at once. The
// result is in that order.
func RunProbes(ctx context.Context, s Settings) ([]*Probe, error) {
	type target struct{ url, password string }
	targets := []target{{s.URL, s.Password}}
	for _, bi := range s.BandInstances {
		targets = append(targets, target{bi.URL, bi.Password})
	}
	out := make([]*Probe, len(targets))
	errs := make([]error, len(targets))
	var wg sync.WaitGroup
	for i, t := range targets {
		wg.Add(1)
		go func(i int, t target) {
			defer wg.Done()
			out[i], errs[i] = RunProbe(ctx, t.url, t.password)
		}(i, t)
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return nil, err
		}
	}
	return out, nil
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

// Build makes a bridge from settings and the probes RunProbes returns for them.
// The notes are worth showing the operator once, before the bridge starts
// logging.
func Build(s Settings, probes []*Probe, logf func(string)) (*hpsdr.Bridge, []string, error) {
	if err := s.Validate(); err != nil {
		return nil, nil, err
	}
	if len(probes) != 1+len(s.BandInstances) {
		return nil, nil, fmt.Errorf("%d receivers checked, %d configured", len(probes), 1+len(s.BandInstances))
	}
	p := probes[0]
	var notes []string
	notes = append(notes, p.Summary()...)
	for i, bp := range probes[1:] {
		lines := bp.Summary()
		lines[0] = strings.Replace(lines[0], "Receiver:", "Receiver for "+strings.Join(s.BandInstances[i].Bands, " ")+":", 1)
		notes = append(notes, lines...)
	}

	allowed, blocked := IntersectAllowed(probes)
	offered, ok := OfferedKHz(s.Rates, allowed)
	if !ok {
		notes = append(notes, fmt.Sprintf("WARNING none of the chosen rates (%s kHz) is open to this session; offering them anyway",
			joinKHz(offered)))
	}
	if len(probes) > 1 {
		for _, k := range wantedKHz(s.Rates) {
			if by := blocked[k]; len(by) > 0 {
				notes = append(notes, fmt.Sprintf("%d kHz not offered: %s does not allow it, and every receiver must", k, strings.Join(by, ", ")))
			}
		}
	}
	notes = append(notes, CoverageNotes(s, probes)...)

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

	// One route even for one receiver, so the status can name its callsign.
	routes := []*hpsdr.Route{{Server: p.Server, Callsign: p.Desc.Callsign, MinHz: p.Desc.MinHz, MaxHz: p.Desc.MaxHz}}
	for i, bp := range probes[1:] {
		routes = append(routes, &hpsdr.Route{Server: bp.Server, Callsign: bp.Desc.Callsign,
			Bands: append([]string(nil), s.BandInstances[i].Bands...), MinHz: bp.Desc.MinHz, MaxHz: bp.Desc.MaxHz})
	}

	b, err := hpsdr.New(hpsdr.Config{
		Server:       p.Server,
		Routes:       routes,
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

// IntersectAllowed is the rates every receiver allows, and for each rate one
// does not, which receivers refuse it.
func IntersectAllowed(probes []*Probe) (allowed []int, blocked map[int][]string) {
	blocked = map[int][]string{}
	for _, k := range wantedKHz(nil) {
		for _, p := range probes {
			if !contains(p.AllowedKHz(), k) {
				blocked[k] = append(blocked[k], p.Server.Host())
			}
		}
		if len(blocked[k]) == 0 {
			allowed = append(allowed, k)
		}
	}
	return allowed, blocked
}

// CoverageNotes warns about bands set for a receiver that cannot tune them,
// and about 6m behind a device most clients will not tune there.
func CoverageNotes(s Settings, probes []*Probe) []string {
	var notes []string
	for i, bi := range s.BandInstances {
		if i+1 >= len(probes) {
			break
		}
		d := probes[i+1].Desc
		host := probes[i+1].Server.Host()
		for _, n := range bi.Bands {
			b, ok := hpsdr.BandNamed(n)
			if !ok {
				continue
			}
			switch any, all := b.Covers(d.MinHz, d.MaxHz); {
			case !any:
				notes = append(notes, fmt.Sprintf("WARNING %s is set for %s, which tunes %s; it goes to a receiver that tunes it",
					b.Name, host, rangeText(d.MinHz, d.MaxHz)))
			case !all:
				notes = append(notes, fmt.Sprintf("%s is set for %s, which tunes only %s; the rest goes to a receiver that tunes it",
					b.Name, host, rangeText(d.MinHz, d.MaxHz)))
			}
		}
	}
	if s.Device == hpsdr.DeviceHermesLite {
		for _, p := range probes {
			if p.Desc.MaxHz > HL2MaxHz {
				notes = append(notes, fmt.Sprintf("%s tunes to %.0f MHz, but most HPSDR clients stop a Hermes Lite 2 at 38.4 MHz; "+
					"present as Hermes to tune above that", p.Server.Host(), float64(p.Desc.MaxHz)/1e6))
				break
			}
		}
	}
	return notes
}

// HL2MaxHz is where HPSDR clients stop tuning a Hermes Lite 2: half its 76.8
// MHz sample clock.
const HL2MaxHz = 38_400_000

func rangeText(lo, hi int64) string {
	return fmt.Sprintf("%.3f kHz - %.3f MHz", float64(lo)/1e3, float64(hi)/1e6)
}

func wantedKHz(rates []int) []int {
	if len(rates) == 0 {
		return []int{48, 96, 192, 384}
	}
	return rates
}

func contains(v []int, x int) bool {
	for _, y := range v {
		if y == x {
			return true
		}
	}
	return false
}

func joinKHz(v []int) string {
	parts := make([]string, len(v))
	for i, x := range v {
		parts[i] = fmt.Sprint(x)
	}
	return strings.Join(parts, "/")
}

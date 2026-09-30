// ubersdr-hpsdr is an openHPSDR radio (protocol 1 and 2) whose receivers are
// an UberSDR instance: point Thetis, SparkSDR, piHPSDR or anything written for a
// Hermes Lite 2 at it, and it tunes UberSDR IQ sessions on the client's behalf.
//
// It is the Go port of clients/hpsdr (the C ubersdr-hpsdr-bridge), pure Go so
// one machine builds it for Windows, macOS and Linux. Run in a terminal it
// opens a TUI to choose the receiver and settings; with --headless, or with no
// terminal (a systemd service), it behaves as the C bridge did, and takes the
// same options.
package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/pprof"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/term"

	"github.com/ka9q/ubersdr/clients/hpsdr-go/internal/app"
	"github.com/ka9q/ubersdr/clients/hpsdr-go/internal/hpsdr"
	"github.com/ka9q/ubersdr/clients/hpsdr-go/internal/ubersdr"
	"github.com/ka9q/ubersdr/clients/hpsdr-go/internal/ui"
)

// version is set at build time.
var version = "dev"

func main() {
	os.Exit(run())
}

func run() int {
	s := app.Defaults()
	var (
		marginArg string
		ratesArg  string
		discover  bool
		callsign  string
		headless  bool
		showVer   bool
		cpuProf   string
		deviceArg int
		numRx     int
		setFlags  = map[string]bool{}
	)
	fs := flag.NewFlagSet("ubersdr-hpsdr", flag.ContinueOnError)
	str := func(p *string, def, usage string, names ...string) {
		for _, n := range names {
			fs.StringVar(p, n, def, usage)
		}
	}
	boolean := func(p *bool, usage string, names ...string) {
		for _, n := range names {
			fs.BoolVar(p, n, false, usage)
		}
	}
	integer := func(p *int, def int, usage string, names ...string) {
		for _, n := range names {
			fs.IntVar(p, n, def, usage)
		}
	}
	str(&s.URL, s.URL, "UberSDR server URL", "url", "u")
	str(&s.Password, "", "UberSDR password (optional)", "password", "p")
	fs.Func("route", "send some bands to another receiver: BANDS=URL, e.g. 40m,20m=https://rx2 (repeatable)", func(v string) error {
		bi, err := parseRoute(v)
		if err == nil {
			s.BandInstances = append(s.BandInstances, bi)
		}
		return err
	})
	boolean(&discover, "pick a public instance from the directory", "discover", "D")
	str(&callsign, "", "select a public instance by callsign (implies --discover)", "callsign", "c")
	str(&s.Interface, "", "network interface to answer on (default: the default route's)", "interface", "i")
	integer(&numRx, s.Receivers, "number of receivers (DDCs), 1-10", "receivers", "n")
	integer(&deviceArg, s.Device, "device type: 1=Hermes, 6=Hermes Lite", "device", "d")
	str(&marginArg, strconv.Itoa(s.MinMargin), "reduced-depth IQ margin in dB, 15-60, or 0 for lossless", "min-margin", "m")
	str(&ratesArg, "", "IQ rates to offer in kHz, e.g. 48,96,192 (default: all the receiver allows)", "rates")
	boolean(&s.Wideband, "enable wideband data (bandscope) from --wideband-file", "wideband", "w")
	str(&s.WidebandFile, hpsdr.DefaultWidebandFile, "wideband sweep file", "wideband-file")
	boolean(&s.Debug, "log every DDC frequency request", "debug", "v")
	boolean(&headless, "run without the TUI, as the C bridge did", "headless")
	boolean(&showVer, "print the version and exit", "version")
	str(&cpuProf, "", "write a CPU profile to FILE until exit, for go tool pprof", "cpuprofile")
	fs.Usage = func() { usage(fs) }
	if err := fs.Parse(os.Args[1:]); err != nil {
		if err == flag.ErrHelp {
			return 0
		}
		return 2
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "unexpected argument %q\n", fs.Arg(0))
		return 2
	}
	fs.Visit(func(f *flag.Flag) { setFlags[f.Name] = true })
	if showVer {
		fmt.Println("ubersdr-hpsdr", version)
		return 0
	}
	if cpuProf != "" {
		stop, err := startCPUProfile(cpuProf)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 2
		}
		defer stop()
	}
	s.Receivers, s.Device = numRx, deviceArg
	dB, note, err := ubersdr.ParseMinMargin(marginArg)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	s.MinMargin = dB
	if ratesArg != "" {
		if s.Rates, err = parseRates(ratesArg); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 2
		}
	}
	if callsign != "" {
		discover = true
	}

	interactive := term.IsTerminal(int(os.Stdin.Fd())) && term.IsTerminal(int(os.Stdout.Fd()))
	if !headless && interactive {
		return runTUI(s, setFlags)
	}

	logf := newLogger()
	if note != "" {
		logf(note)
	}
	s, path, found, err := withSaved(s, setFlags)
	switch {
	case err != nil:
		logf("Settings file " + path + " could not be read, using the defaults and the command line: " + err.Error())
	case found:
		logf("Settings file: " + path + " (options on the command line override it)")
	case path != "":
		logf("Settings file: " + path + " (none yet: the setup screen saves one; using the defaults and the command line)")
	}
	if err := s.Validate(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if discover {
		inst, err := pickInstance(callsign, interactive)
		if err != nil {
			fmt.Fprintln(os.Stderr, "discover:", err)
			return 1
		}
		s.URL = inst.URL()
		logf(fmt.Sprintf("Selected: %s (%s)", inst.Label(), s.URL))
	}
	return runHeadless(s, logf)
}

func usage(fs *flag.FlagSet) {
	name := filepath.Base(os.Args[0])
	fmt.Fprintf(os.Stderr, `Usage: %s [options]

An openHPSDR radio (protocol 1 and 2) backed by an UberSDR receiver.
In a terminal it opens a setup screen; --headless runs as a service.

UberSDR connection:
  -u, --url URL          server URL (default http://localhost:8080)
  -p, --password PASS    server password, for bypassed sessions and wide IQ
  -D, --discover         pick a public instance from the directory
  -c, --callsign CALL    select a public instance by callsign
      --route BANDS=URL  send the DDCs tuned to BANDS to another receiver,
                         e.g. --route 40m,20m=https://rx2.example.org; the
                         receiver above takes everything else. Repeatable.
                         A password goes in the URL: https://:PASS@host
                         Bands: %[3]s

HPSDR emulation:
  -i, --interface IFACE  answer only clients on this interface's network
                         (default: the default route's, answering everyone)
  -n, --receivers N      receivers (DDCs), 1-10 (default 10)
  -d, --device N         1=Hermes, 6=Hermes Lite 2 (default 6)
      --rates LIST       IQ rates to offer in kHz, e.g. 48,96,192
                         (default: every rate the receiver allows this session)
  -m, --min-margin DB    reduced-depth IQ: keep the quantisation floor DB below
                         the band's noise floor, 15-60 (default 26); 0 asks for
                         the lossless stream. Needs UberSDR 0.1.64 or later
  -w, --wideband         send wideband data from --wideband-file
                         (default %[2]s)
  -v, --debug            log every DDC frequency request, and the IQ
                         throughput every 5 s

      --cpuprofile FILE  profile CPU use until exit, for go tool pprof
      --headless         no TUI, log to stdout (automatic without a terminal).
                         Starts from the settings the setup screen saved;
                         options given here override them
      --version          print the version

Examples:
  %[1]s
  %[1]s --headless --url https://sdr.example.com --password mypass
  %[1]s --headless --callsign M9PSY --receivers 4 --rates 48,96
  %[1]s --headless --url https://rx1 --route 40m,20m=https://rx2
`, name, hpsdr.DefaultWidebandFile, hpsdr.BandNames())
}

// parseRoute reads BANDS=URL. The password, if any, is the URL's userinfo:
// the one place in a URL that means "credentials", so it needs no new syntax
// and escapes as URLs do.
func parseRoute(v string) (app.BandInstance, error) {
	bands, raw, ok := strings.Cut(v, "=")
	if !ok || strings.TrimSpace(raw) == "" {
		return app.BandInstance{}, fmt.Errorf("want BANDS=URL, e.g. 40m,20m=https://rx2.example.org")
	}
	var bi app.BandInstance
	for _, b := range strings.Split(bands, ",") {
		if b = strings.TrimSpace(b); b != "" {
			bi.Bands = append(bi.Bands, b)
		}
	}
	raw = strings.TrimSpace(raw)
	withScheme := raw
	if !strings.Contains(raw, "://") {
		withScheme = "http://" + raw
	}
	if u, err := url.Parse(withScheme); err == nil && u.User != nil {
		if pw, set := u.User.Password(); set {
			bi.Password = pw
		} else {
			bi.Password = u.User.Username()
		}
		u.User = nil
		raw = u.String()
	}
	bi.URL = raw
	if err := app.ValidateBandInstances("", []app.BandInstance{bi}); err != nil {
		return app.BandInstance{}, err
	}
	return bi, nil
}

// startCPUProfile profiles until the returned stop is called. Written on a clean
// exit only -- q in the TUI, Ctrl-C or SIGTERM headless -- which is how a
// profile of the bridge under real load is taken.
func startCPUProfile(path string) (func(), error) {
	f, err := os.Create(path)
	if err != nil {
		return nil, fmt.Errorf("--cpuprofile: %w", err)
	}
	if err := pprof.StartCPUProfile(f); err != nil {
		f.Close()
		return nil, fmt.Errorf("--cpuprofile: %w", err)
	}
	return func() {
		pprof.StopCPUProfile()
		f.Close()
	}, nil
}

func parseRates(arg string) ([]int, error) {
	var out []int
	for _, f := range strings.Split(arg, ",") {
		v, err := strconv.Atoi(strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(f), "k")))
		if err != nil || hpsdr.RateMask([]int{v}) == 0 {
			return nil, fmt.Errorf("--rates: %q is not one of 48, 96, 192, 384", f)
		}
		out = append(out, v)
	}
	return out, nil
}

// newLogger timestamps lines in seconds since start, as the C bridge's t_print
// did, so logs from the two read the same.
func newLogger() func(string) {
	start := time.Now()
	var mu sync.Mutex
	return func(line string) {
		mu.Lock()
		fmt.Printf("%10.6f %s\n", time.Since(start).Seconds(), line)
		mu.Unlock()
	}
}

func runHeadless(s app.Settings, logf func(string)) int {
	probes, err := app.RunProbes(context.Background(), s)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	b, notes, err := app.Build(s, probes, logf)
	for _, n := range notes {
		logf(n)
	}
	if err != nil {
		logf("ERROR " + err.Error())
		return 1
	}
	// Carried on with even when the probe failed: under systemd the receiver
	// may simply not be up yet, and every receiver retries on its own.
	b.Start()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	got := <-sig
	logf(fmt.Sprintf("Signal %v caught, exiting", got))
	b.Close()
	return 0
}

// pickInstance is --discover: by callsign, or a numbered list and a prompt.
func pickInstance(callsign string, interactive bool) (ubersdr.Instance, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	list, err := ubersdr.FetchDirectory(ctx, "")
	if err != nil {
		return ubersdr.Instance{}, err
	}
	if len(list) == 0 {
		return ubersdr.Instance{}, fmt.Errorf("no public instance offers an HPSDR rate")
	}
	if callsign != "" {
		inst, ok := ubersdr.FindCallsign(list, callsign)
		if !ok {
			return inst, fmt.Errorf("callsign %q not found among public instances", callsign)
		}
		return inst, nil
	}
	fmt.Printf("\n%-4s %-12s %-35s %-38s %s\n", "No.", "Callsign", "Location", "URL", "Public modes")
	for i, inst := range list {
		name := inst.Callsign
		if name == "" {
			name = inst.Name
		}
		fmt.Printf("%-4d %-12s %-35s %-38s %s\n", i+1, clip(name, 12), clip(inst.Location, 35), clip(inst.URL(), 38),
			strings.Join(inst.PublicIQModes, " "))
	}
	if !interactive && !term.IsTerminal(int(os.Stdin.Fd())) {
		return ubersdr.Instance{}, fmt.Errorf("no terminal to choose from; use --callsign")
	}
	fmt.Printf("\nEnter number (1-%d) or 0 to cancel: ", len(list))
	line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	n, err := strconv.Atoi(strings.TrimSpace(line))
	if err != nil || n < 1 || n > len(list) {
		return ubersdr.Instance{}, fmt.Errorf("cancelled")
	}
	return list[n-1], nil
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-2]) + ".."
}

func runTUI(flags app.Settings, set map[string]bool) int {
	s, path, _, err := withSaved(flags, set)
	if err != nil {
		fmt.Fprintln(os.Stderr, "settings:", err)
	}
	if err := ui.Run(s, path, version); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

// withSaved is the saved settings with every option given on the command line
// laid over them. The setup screen and headless mode both start here, so a
// receiver set up on the screen runs headless as it was saved, and a flag
// changes only what it names. found is false when there is no settings file;
// err is a file that could not be read, in which case the defaults stand in.
func withSaved(flags app.Settings, set map[string]bool) (s app.Settings, path string, found bool, err error) {
	path, _ = app.SettingsPath()
	if path != "" {
		_, statErr := os.Stat(path)
		found = statErr == nil
	}
	s, err = app.Load(path)
	merge := map[string]func(){
		"url": func() { s.URL = flags.URL }, "password": func() { s.Password = flags.Password },
		"interface": func() { s.Interface = flags.Interface }, "receivers": func() { s.Receivers = flags.Receivers },
		"device": func() { s.Device = flags.Device }, "min-margin": func() { s.MinMargin = flags.MinMargin },
		"rates": func() { s.Rates = flags.Rates }, "wideband": func() { s.Wideband = flags.Wideband },
		"wideband-file": func() { s.WidebandFile = flags.WidebandFile }, "debug": func() { s.Debug = flags.Debug },
		"route": func() { s.BandInstances = flags.BandInstances },
	}
	aliases := map[string]string{"u": "url", "p": "password", "i": "interface", "n": "receivers", "d": "device",
		"m": "min-margin", "w": "wideband", "v": "debug"}
	for name := range set {
		if a, ok := aliases[name]; ok {
			name = a
		}
		if f, ok := merge[name]; ok {
			f()
		}
	}
	return s, path, found, err
}

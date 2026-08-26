package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Headless mode is the same receiver without a display: connect, tune, and put
// the audio wherever it was asked to go.
//
// It opens no spectrum socket at all — a session that nobody is watching has no
// use for one, and not asking for it saves the server a channel. Everything it
// says goes to stderr, because stdout may be carrying the audio.

// runHeadless tunes and streams until interrupted.
func runHeadless(opts options) error {
	host, secure := opts.target.Host, opts.target.TLS

	client, err := NewClient(host, secure, opts.password)
	if err != nil {
		return err
	}

	// What the receiver says about itself decides anything the command line
	// left out. A receiver that will not answer is one worth failing on here,
	// while there is still a terminal to say so.
	desc, err := client.FetchDescription()
	if err != nil {
		return fmt.Errorf("cannot reach %s: %w", host, err)
	}
	// No event loop here, so this is the only place the range is set — and it
	// runs before anything reads it.
	applyTuningRange(desc.TuningRange)
	freq, mode := desc.Defaults()
	if opts.initialFreq > 0 {
		freq = opts.initialFreq
		// Worth refusing rather than clamping: a -freq this receiver cannot
		// reach is a typo or the wrong receiver, and silently streaming the
		// band edge instead would look like it worked.
		if freq < minFreq || freq > maxFreq {
			return fmt.Errorf("%.6f MHz is outside this receiver's %g-%g MHz range",
				freq/1e6, minFreq/1e6, maxFreq/1e6)
		}
	}
	if opts.initialMode != "" {
		mode = opts.initialMode
	}

	m, ok := lookupMode(mode)
	if !ok {
		return fmt.Errorf("unknown mode %q", mode)
	}
	low, high := m.Low, m.High
	if opts.haveBandwidth {
		low, high = opts.bwLow, opts.bwHigh
	}
	low, high = clampBandwidth(mode, low, high)

	if err := client.CheckConnection(); err != nil {
		return fmt.Errorf("refused by %s: %w", host, err)
	}

	// Ctrl-C and a service stop both have to shut the outputs down properly:
	// that is what puts the real sizes into a WAV capture's header.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	out := NewAudioOutput()
	defer out.Close()

	sinks := make([]string, 0, 2)
	if opts.stdoutMode != StdoutOff {
		if err := out.SetStdout(opts.stdoutMode); err != nil {
			return fmt.Errorf("stdout: %w", err)
		}
		sinks = append(sinks, "stdout ("+opts.stdoutMode.String()+")")
	}
	if !opts.noDevice {
		if err := out.Start(opts.deviceID); err != nil {
			// One output short is survivable; none at all is not.
			if !out.StdoutOn() {
				return fmt.Errorf("audio output: %w", err)
			}
			warnf("audio output: %v", err)
		} else {
			sinks = append(sinks, "sound device"+deviceSuffix(opts.deviceID))
		}
	}
	if len(sinks) == 0 {
		return fmt.Errorf("nothing to play through: -no-device with no -stdout leaves the audio nowhere to go")
	}

	audio := NewAudioClient(host, secure, opts.password, client.sessionID)
	audio.SetTuning(freq, mode, low, high)
	if opts.squelch > 0 {
		audio.SetSquelch(opts.squelch)
	}
	go audio.Run(ctx)

	limit := "unlimited"
	if d := client.SessionLimit(); d > 0 {
		limit = formatCountdown(d)
	}
	warnf("%s — %.6f MHz %s, filter %+d/%+d Hz → %s, session %s",
		host, freq/1e6, strings.ToUpper(mode), low, high, strings.Join(sinks, " + "), limit)

	for {
		select {
		case <-ctx.Done():
			warnf("stopping")
			// Closing here rather than leaving it to the deferred call, so the
			// capture is finished before the process is.
			out.Close()
			return nil

		case pcm := <-audio.PCM:
			out.Push(pcm)

		case msg := <-audio.Status:
			warnf("%s", msg)

		case <-audio.Level:
			// Read and discarded: the meter is a display, and leaving these
			// unread would only drop them anyway.
		case <-audio.Silence:
		case <-audio.DSP:
		}
	}
}

// deviceSuffix names the chosen output in the startup line, so a run with
// -device says which one it took.
func deviceSuffix(id string) string {
	if id == "" {
		return ""
	}
	devices, err := listDevicesForTest()
	if err != nil {
		return ""
	}
	for _, d := range devices {
		if d.ID == id {
			return " (" + d.Name + ")"
		}
	}
	return ""
}

// warnf writes a line to stderr. Nothing headless ever writes to stdout except
// the audio itself.
func warnf(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
}

// parseBandwidth reads a filter as low:high in Hz, the same pair of edges the
// display and the server use. Both may be negative, which is how a lower
// sideband filter is expressed.
func parseBandwidth(spec string) (low, high int, err error) {
	parts := strings.Split(spec, ":")
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("a filter is low:high in Hz, e.g. 300:2700 or -2700:-300")
	}
	if low, err = strconv.Atoi(strings.TrimSpace(parts[0])); err != nil {
		return 0, 0, fmt.Errorf("filter low edge: %w", err)
	}
	if high, err = strconv.Atoi(strings.TrimSpace(parts[1])); err != nil {
		return 0, 0, fmt.Errorf("filter high edge: %w", err)
	}
	if low >= high {
		return 0, 0, fmt.Errorf("filter low edge %d must be below the high edge %d", low, high)
	}
	return low, high, nil
}

// looksLikeHost reports whether what the user typed is an address rather than
// the name of a receiver in the public directory.
//
// Anything with a scheme, a port or a dot is an address; so is localhost, which
// has none of those and is nobody's callsign. A bare word is looked up instead,
// which is what makes `-server m9psy` work.
func looksLikeHost(spec string) bool {
	spec = strings.ToLower(strings.TrimSpace(spec))
	return strings.Contains(spec, "://") ||
		strings.Contains(spec, ":") ||
		strings.Contains(spec, ".") ||
		strings.HasPrefix(spec, "localhost")
}

// resolveTarget turns what the user typed into a receiver to connect to: an
// address as given, or a name looked up in the public directory.
func resolveTarget(ctx context.Context, spec string, useTLS bool) (Instance, error) {
	if looksLikeHost(spec) {
		host, secure := parseServer(spec, useTLS)
		return Instance{Name: host, Host: host, TLS: secure, Available: -1}, nil
	}

	list, err := FetchPublicInstances(ctx)
	if err != nil {
		return Instance{}, fmt.Errorf("cannot look up %q: %w", spec, err)
	}

	var matches []Instance
	for _, inst := range list {
		if strings.EqualFold(inst.Callsign, spec) || strings.EqualFold(inst.Name, spec) {
			// An exact name or callsign is the receiver meant, whatever else
			// happens to contain those letters.
			return inst, nil
		}
		if inst.matches(spec) {
			matches = append(matches, inst)
		}
	}

	switch len(matches) {
	case 0:
		return Instance{}, fmt.Errorf("no public receiver matches %q — give a host:port or a URL instead", spec)
	case 1:
		return matches[0], nil
	default:
		names := make([]string, 0, len(matches))
		for _, inst := range matches {
			names = append(names, inst.Label())
		}
		sort.Strings(names)
		if len(names) > 8 {
			names = append(names[:8], "…")
		}
		return Instance{}, fmt.Errorf("%q matches %d receivers: %s",
			spec, len(matches), strings.Join(names, ", "))
	}
}

// directoryTimeout bounds the name lookup, so a slow directory delays a start
// rather than hanging it.
const directoryTimeout = 15 * time.Second

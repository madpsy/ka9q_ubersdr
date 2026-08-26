package main

import (
	"fmt"
	"math"
	"os"
	"sync"
)

// Receiver span: the one place that decides how much spectrum this receiver covers.
//
// The range used to be the literal 30000000, repeated in ~35 places across the server
// and ~15 more in the v2 frontend. It is really a property of the front end sample rate,
// so it is derived from that here and everything downstream reads the result.
//
// See RECEIVER_SPAN.md for the full design, including the tag numbers and the arithmetic
// tables this file is checked against.

const (
	// receiverNyquist mirrors NYQUIST in ka9q-radio src/rx888.c, where the front end's
	// usable top is set as max_IF = NYQUIST * samprate. It is duplicated here because
	// radiod only reports the resulting edges (FE_HIGH_EDGE) on a live status packet,
	// and the span has to be known at config load — before any channel exists to carry
	// one. verifyReceiverAgainstFrontend cross-checks the two once a channel is up.
	receiverNyquist = 0.47

	// receiverFallbackSamprate is what the RX888 runs at when the radiod config cannot
	// be read. Chosen to reproduce today's 0-30 MHz geometry exactly, so a receiver with
	// no readable radiod config behaves as it always has rather than failing to boot.
	receiverFallbackSamprate = 64_800_000

	// RadiodConfPath is the radiod config file, and the only place the receiver's
	// frequency range can be influenced from: set samprate there and everything else
	// follows.
	//
	// Deliberately a constant rather than a config.yaml key. The span is a property of
	// the hardware, not an operator preference, and a second place to say it is a second
	// place for it to be wrong. Shared with handleGetRadiodConfig / HandleRadiodValues in
	// admin.go, which already read this same file for the admin monitor.
	RadiodConfPath = "/etc/ka9q-radio/radiod@ubersdr.conf"

	// receiverMinFrequency is the bottom of the advertised tuning range.
	//
	// Deliberately not derived: radiod reports min_IF = 15000 for the RX888, so the
	// bottom 5 kHz of what we advertise is already outside what the front end claims.
	// That is true today, predates this change, and tightening it would break existing
	// VLF listeners for no gain here.
	receiverMinFrequency = 10_000

	// receiverTodaySpanHz is the span every fallback path resolves to — the value the
	// whole codebase used to hardcode. Referenced by name so the compatibility contract
	// is greppable.
	receiverTodaySpanHz = 30_000_000

	// nfWidebandBinBandwidth is the noise-floor wideband resolution, held constant as
	// the span changes so historical comparisons stay meaningful. 30 MHz / 4096.
	nfWidebandBinBandwidth = 7324.21875
)

// logOnce prints a line the first time it is seen and never again.
//
// LoadConfig is called for every YAML the server reads — config.yaml, bookmarks.yaml,
// bands.yaml, extensions.yaml, decoder.yaml, ui.yaml — and each call resolves the
// receiver and prunes its own Config. They all reach the same answer, so without this
// the startup log carries six identical copies of the sample-rate line and six of every
// skipped band, which buries the one thing an operator is looking for.
var (
	loggedOnceMu sync.Mutex
	loggedOnce   = map[string]bool{}
)

func logOnce(format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	loggedOnceMu.Lock()
	seen := loggedOnce[msg]
	loggedOnce[msg] = true
	loggedOnceMu.Unlock()
	if !seen {
		fmt.Print(msg)
	}
}

// ReceiverConfig is the resolved geometry. Populated by resolveReceiver during
// LoadConfig and then treated as immutable: it sizes the noise-floor FFT buffers, the
// spectrogram archives and every connected client's view, so re-deriving it mid-flight
// because a status packet disagreed would be worse than a loud warning.
type ReceiverConfig struct {
	// InputSamprate is the front end sample rate in force, Hz.
	InputSamprate int
	// SamprateSource is where InputSamprate came from: "radiod-conf" when it was read
	// from the radiod config, "fallback" when that file could not be read. Surfaced in
	// /api/description and the admin health panel so an operator can tell a discovered
	// value from an assumed one.
	SamprateSource string
	// SpanHz is the width of the spectrum display, starting at 0 Hz.
	SpanHz uint64
	// CenterHz is SpanHz/2 — the centre of the full-span spectrum channel.
	CenterHz uint64
	// MinFrequency and MaxFrequency bound tuning.
	MinFrequency uint64
	MaxFrequency uint64
}

// The accessors below are the Go half of the same fallback contract the frontend has
// (see radio/constants.js): a zero ReceiverConfig means "nobody said", and "nobody said"
// means exactly what this codebase did before the span became configurable — 10 kHz to
// 30 MHz. That matters beyond defensiveness: tests and tools build Config literals
// directly rather than going through LoadConfig, and a zero-valued struct read straight
// off the field would clamp every frequency to nothing.
//
// Read through these, not through the fields, everywhere outside this file.

// MinFreq is the bottom of the tuning range.
func (rc ReceiverConfig) MinFreq() uint64 {
	if rc.MinFrequency > 0 {
		return rc.MinFrequency
	}
	return receiverMinFrequency
}

// MaxFreq is the top of the tuning range.
func (rc ReceiverConfig) MaxFreq() uint64 {
	if rc.MaxFrequency > 0 {
		return rc.MaxFrequency
	}
	return receiverTodaySpanHz
}

// Span is the width of the full-span spectrum view, starting at 0 Hz.
func (rc ReceiverConfig) Span() uint64 {
	if rc.SpanHz > 0 {
		return rc.SpanHz
	}
	return receiverTodaySpanHz
}

// Centre is the centre of the full-span view — half the span, which is the only value
// that puts both of its edges where they belong.
func (rc ReceiverConfig) Centre() uint64 {
	if rc.CenterHz > 0 {
		return rc.CenterHz
	}
	return receiverTodaySpanHz / 2
}

// Samprate is the front end sample rate.
func (rc ReceiverConfig) Samprate() int {
	if rc.InputSamprate > 0 {
		return rc.InputSamprate
	}
	return receiverFallbackSamprate
}

// Source is where the sample rate came from. A ReceiverConfig that never went through
// resolveReceiver reports "fallback", because that is exactly what it is: the accessors
// above are handing out the built-in 64.8 Msps geometry.
func (rc ReceiverConfig) Source() string {
	if rc.SamprateSource != "" {
		return rc.SamprateSource
	}
	return "fallback"
}

// TuningRange is the receiver's frequency range as published to everything outside this
// process: /api/description, the v2 shell's inlined window.__UBERSDR__, and the instance
// reporter's periodic and startup reports.
//
// One builder for all of them on purpose. These are the same facts, and three hand-rolled
// copies of the same map is how a field ends up present in one place, stale in another and
// missing from the third.
//
// Consumers must treat a missing object, or any field of it that is absent or zero, as
// 10 kHz - 30 MHz — see the accessors above and radio/constants.js. Read through the
// accessors here too, so a zero-valued ReceiverConfig publishes today's numbers rather
// than a row of zeroes.
func (rc ReceiverConfig) TuningRange() map[string]interface{} {
	return map[string]interface{}{
		"min_frequency":      rc.MinFreq(),
		"max_frequency":      rc.MaxFreq(),
		"spectrum_span_hz":   rc.Span(),
		"spectrum_center_hz": rc.Centre(),
		"input_samprate":     rc.Samprate(),
		"samprate_source":    rc.Source(),
	}
}

// receiverSpanFor turns a front end sample rate into the spectrum span.
//
// The usable top is NYQUIST * samprate; the span is the largest whole megahertz that
// fits inside it. Rounding to whole MHz is what makes 64.8 Msps land on exactly the
// 30,000,000 the codebase used to hardcode, and it leaves the display edge a few hundred
// kHz clear of the anti-alias rolloff rather than riding it:
//
//	64.8 Msps -> 30,456,000 usable -> 30,000,000 span
//	129.6 Msps -> 60,912,000 usable -> 60,000,000 span
func receiverSpanFor(samprate int) uint64 {
	if samprate <= 0 {
		return receiverTodaySpanHz
	}
	usableTop := receiverNyquist * float64(samprate)
	span := uint64(math.Floor(usableTop/1e6)) * 1_000_000
	if span < 1_000_000 {
		// A front end too narrow to express in whole MHz is a misconfiguration, not a
		// receiver. Fall back rather than serve a degenerate geometry.
		return receiverTodaySpanHz
	}
	return span
}

// defaultSpectrumBinCount scales the bin count with the span so that Hz-per-bin at full
// zoom-out stays constant. 30 MHz -> 1024, 60 MHz -> 2048, both giving 29296.875 Hz/bin.
//
// The result is always one of the three counts LoadConfig accepts, because radiod is
// asked for it directly.
func defaultSpectrumBinCount(spanHz uint64) int {
	if spanHz == 0 {
		return 1024
	}
	scaled := int(math.Round(1024 * float64(spanHz) / float64(receiverTodaySpanHz)))
	switch {
	case scaled <= 724:
		return 512
	case scaled <= 1448:
		return 1024
	default:
		return 2048
	}
}

// widebandGeometry returns the bin count and bin bandwidth for the noise-floor wideband
// channel. Resolution is held at nfWidebandBinBandwidth and the bin count grows with the
// span, so a wider receiver gets more bins rather than coarser ones.
//
// The bin count is rounded up to a power of two, which keeps the exact
// 4096 x 7324.21875 = 30 MHz and 8192 x 7324.21875 = 60 MHz cases exact; for a span that
// is not a power-of-two multiple the bandwidth tightens slightly instead of the coverage
// falling short.
func widebandGeometry(spanHz uint64) (int, float64) {
	if spanHz == 0 {
		return 4096, nfWidebandBinBandwidth
	}
	want := math.Ceil(float64(spanHz) / nfWidebandBinBandwidth)
	bins := 1
	for float64(bins) < want {
		bins *= 2
	}
	return bins, float64(spanHz) / float64(bins)
}

// samprateFromRadiodConf reads [rx888] samprate out of a radiod .conf, reusing the
// parser the admin monitor already uses for the same file.
func samprateFromRadiodConf(path string) (int, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	return samprateFromRadiodConfBytes(data)
}

// samprateFromRadiodConfBytes is samprateFromRadiodConf over content already in hand —
// the admin config editor checks what it is about to write before writing it.
func samprateFromRadiodConfBytes(data []byte) (int, error) {
	sections := parseRadiodConf(data)
	// The section name is conventionally the device name, but "hardware = ..." in
	// [global] is what actually chooses it, so follow that before guessing.
	candidates := make([]string, 0, 3)
	if global, ok := sections["global"]; ok {
		if hw := global["hardware"]; hw != "" {
			candidates = append(candidates, hw)
		}
	}
	candidates = append(candidates, "rx888")

	for _, name := range candidates {
		section, ok := sections[name]
		if !ok {
			continue
		}
		raw, ok := section["samprate"]
		if !ok {
			continue
		}
		rate, err := parseRadiodFrequency(raw)
		if err != nil {
			return 0, fmt.Errorf("section [%s]: %w", name, err)
		}
		return rate, nil
	}
	return 0, fmt.Errorf("no front end samprate found")
}

// parseRadiodFrequency accepts the forms ka9q-radio's parse_frequency() does for a
// sample rate: a plain integer, or one with a k/m/g suffix.
func parseRadiodFrequency(s string) (int, error) {
	if s == "" {
		return 0, fmt.Errorf("empty value")
	}
	mult := 1.0
	switch s[len(s)-1] {
	case 'k', 'K':
		mult, s = 1e3, s[:len(s)-1]
	case 'm', 'M':
		mult, s = 1e6, s[:len(s)-1]
	case 'g', 'G':
		mult, s = 1e9, s[:len(s)-1]
	}
	var v float64
	if _, err := fmt.Sscanf(s, "%g", &v); err != nil {
		return 0, fmt.Errorf("not a frequency: %q", s)
	}
	if v <= 0 {
		return 0, fmt.Errorf("not positive: %q", s)
	}
	return int(math.Round(v * mult)), nil
}

// resolveReceiver decides the receiver geometry, once, at config load, from the radiod
// config file and nothing else.
//
// There is no config.yaml key for any of this, on purpose: `samprate` in radiod's own
// .conf is the single place the frequency range can be influenced from, because it is
// the single place that actually determines it.
//
// It never returns an error. A receiver that boots at 30 MHz beats one that does not boot
// because a config file was unreadable, and 30 MHz is what every install had before this
// was derived at all.
func resolveReceiver() ReceiverConfig {
	return resolveReceiverFrom(RadiodConfPath)
}

// resolveReceiverFrom is resolveReceiver with the path injected, for tests.
func resolveReceiverFrom(path string) ReceiverConfig {
	samprate, source := 0, ""

	if rate, err := samprateFromRadiodConf(path); err == nil {
		samprate, source = rate, "radiod-conf"
	} else {
		logOnce("Receiver: could not read sample rate from %s (%v), assuming %d Hz\n",
			path, err, receiverFallbackSamprate)
	}

	if samprate <= 0 {
		samprate, source = receiverFallbackSamprate, "fallback"
	}

	span := receiverSpanFor(samprate)
	rc := ReceiverConfig{
		InputSamprate:  samprate,
		SamprateSource: source,
		SpanHz:         span,
		CenterHz:       span / 2,
		MinFrequency:   receiverMinFrequency,
		MaxFrequency:   span,
	}

	logOnce("Receiver: %.4f Msps (%s) -> %.3f-%.3f MHz, spectrum span %.0f MHz centred on %.1f MHz\n",
		float64(samprate)/1e6, source,
		float64(rc.MinFrequency)/1e6, float64(rc.MaxFrequency)/1e6,
		float64(rc.SpanHz)/1e6, float64(rc.CenterHz)/1e6)

	return rc
}

// verifyReceiverAgainstFrontend cross-checks the resolved geometry against what radiod
// actually reports, once a channel exists to carry a status packet.
//
// It returns the issues found rather than changing anything: see the note on
// ReceiverConfig for why the geometry is frozen. An empty slice means agreement.
func verifyReceiverAgainstFrontend(rc ReceiverConfig, status *FrontendStatus) []string {
	if status == nil {
		return nil
	}
	var issues []string

	if status.InputSamprate > 0 && status.InputSamprate != rc.Samprate() {
		issues = append(issues, fmt.Sprintf(
			"radiod reports %.4f Msps but the server resolved %.4f Msps from %s — "+
				"the spectrum span (%.0f MHz) is wrong until this is reconciled",
			float64(status.InputSamprate)/1e6, float64(rc.Samprate())/1e6,
			rc.Source(), float64(rc.Span())/1e6))
	}

	// FE_LOW_EDGE/FE_HIGH_EDGE are the front end's own IF limits and FIRST_LO_FREQUENCY
	// the base they are measured from, so the usable RF range is the sum. max rather than
	// FE_HIGH_EDGE as named because for inverted Nyquist zones both edges are negative and
	// their order flips.
	//
	// Only the top is checked. The bottom is policy, not derivation: the RX888 reports a
	// 15 kHz min_IF and we have always advertised 10 kHz, deliberately, so flagging it
	// would put a standing warning on every healthy receiver. See receiverMinFrequency.
	if status.FeHighEdge != 0 || status.FeLowEdge != 0 {
		hi := status.FirstLOFrequency + math.Max(float64(status.FeLowEdge), float64(status.FeHighEdge))
		if hi > 0 && float64(rc.MaxFreq()) > hi {
			issues = append(issues, fmt.Sprintf(
				"tuning is advertised to %.3f MHz but radiod reports the front end usable "+
					"only to %.3f MHz", float64(rc.MaxFreq())/1e6, hi/1e6))
		}
	}

	return issues
}

// pruneOutOfRangeChannels disables the configured things that would otherwise ask radiod
// for a channel outside the receiver.
//
// Noise-floor bands, decoder bands and the frequency reference each create a real radiod
// channel at an operator-chosen frequency; band-plan entries do not, but a band button
// that cannot be tuned to is the same problem wearing a different hat. None of them is validated against the front
// end, because until the span was derived there was nothing to validate against — the
// answer was always 0-30 MHz. Now an operator who adds a 6 m FT8 decoder while running at
// 129.6 Msps and later drops back to 64.8 is left with a channel radiod cannot serve: no
// error, just a decoder that never decodes and a spectrum band that stays empty.
//
// Warn and skip rather than fail: a receiver that boots with one band disabled is far
// better than one that refuses to start because a config entry went out of reach. The
// entries stay in the file, so widening the front end again brings them back — the same
// contract bookmarks and VFOs have.
func pruneOutOfRangeChannels(config *Config) {
	rx := config.Receiver
	inRange := func(hz uint64) bool { return hz >= rx.MinFreq() && hz <= rx.MaxFreq() }

	if n := len(config.NoiseFloor.Bands); n > 0 {
		kept := config.NoiseFloor.Bands[:0]
		for _, b := range config.NoiseFloor.Bands {
			// The centre is what the channel is created at; the edges decide whether any
			// of the band is visible at all.
			if !inRange(b.CenterFrequency) || b.Start > rx.MaxFreq() || b.End < rx.MinFreq() {
				// A note, not a warning. The shipped band list covers more than any one
				// front end reaches — 6m is there for a receiver running at 129.6 Msps
				// and is expected to be skipped at 64.8 — so an alarming line here would
				// make the default config look broken on every boot. The decoder and
				// reference cases below are warnings because those are single, deliberate
				// choices rather than a list to pick from.
				logOnce("Noise floor: skipping band '%s' (%.3f-%.3f MHz) — outside this receiver's %.3f-%.3f MHz range\n",
					b.Name, float64(b.Start)/1e6, float64(b.End)/1e6,
					float64(rx.MinFreq())/1e6, float64(rx.MaxFreq())/1e6)
				continue
			}
			kept = append(kept, b)
		}
		config.NoiseFloor.Bands = kept
	}

	// Decoder bands are switched off in place rather than removed, and only when they
	// are switched *on*.
	//
	// Both halves matter. The shipped list carries every band this software knows about
	// with enabled: false, including 6m entries meant for a receiver at 129.6 Msps — a
	// disabled band spawns no decoder, so there is nothing to warn about and six warnings
	// per boot would be pure noise. An *enabled* band that has gone out of reach is a
	// different thing: it would spawn a decoder that can never hear anything, and the
	// operator chose it, so they are told.
	//
	// Disabling rather than deleting keeps the entry in the list, so it is still there to
	// be switched on again if the sample rate goes back up. The admin decoder tab reads
	// decoder.yaml from disk anyway, so it shows every band either way.
	// Recorded on the decoder config itself so GetEnabledBands can refuse an unreachable
	// band whatever route it took to being enabled — see there.
	config.Decoder.SetReceiverRange(rx.MinFreq(), rx.MaxFreq())

	for i := range config.Decoder.Bands {
		b := &config.Decoder.Bands[i]
		if b.Enabled && !inRange(b.Frequency) {
			logOnce("Warning: decoder band '%s' at %.3f MHz is outside the receiver's range (%.3f-%.3f MHz) — disabled\n",
				b.Name, float64(b.Frequency)/1e6,
				float64(rx.MinFreq())/1e6, float64(rx.MaxFreq())/1e6)
			b.Enabled = false
		}
	}

	// Band-plan entries (bands.yaml) are display only — they never create a channel —
	// but a band nobody can tune to is a button that silently retunes to the edge of the
	// receiver. Handled exactly as the admin API's validateAndClampBandFrequencies
	// handles an edit: dropped when wholly out of reach, trimmed when it overlaps.
	if len(config.Bands) > 0 {
		kept := config.Bands[:0]
		for _, b := range config.Bands {
			if b.End < rx.MinFreq() || b.Start > rx.MaxFreq() {
				logOnce("Bands: skipping '%s' (%.3f-%.3f MHz) — outside this receiver's %.3f-%.3f MHz range\n",
					b.Label, float64(b.Start)/1e6, float64(b.End)/1e6,
					float64(rx.MinFreq())/1e6, float64(rx.MaxFreq())/1e6)
				continue
			}
			if b.Start < rx.MinFreq() || b.End > rx.MaxFreq() {
				trimmed := b
				if trimmed.Start < rx.MinFreq() {
					trimmed.Start = rx.MinFreq()
				}
				if trimmed.End > rx.MaxFreq() {
					trimmed.End = rx.MaxFreq()
				}
				logOnce("Bands: trimming '%s' from %.3f-%.3f to %.3f-%.3f MHz to fit this receiver\n",
					b.Label, float64(b.Start)/1e6, float64(b.End)/1e6,
					float64(trimmed.Start)/1e6, float64(trimmed.End)/1e6)
				kept = append(kept, trimmed)
				continue
			}
			kept = append(kept, b)
		}
		config.Bands = kept
	}

	if config.FrequencyReference.Enabled && config.FrequencyReference.Frequency > 0 &&
		!inRange(config.FrequencyReference.Frequency) {
		logOnce("Warning: frequency reference at %.3f MHz is outside the receiver's range (%.3f-%.3f MHz) — disabled\n",
			float64(config.FrequencyReference.Frequency)/1e6,
			float64(rx.MinFreq())/1e6, float64(rx.MaxFreq())/1e6)
		config.FrequencyReference.Enabled = false
	}
}

// The only two front end sample rates this receiver accepts.
//
// ka9q-radio's rx888 driver will take anything between MIN_SAMPRATE and 130 MHz, but only
// these two divide cleanly from the 27 MHz reference with no fractional-N and good FFT
// factors — upstream's own comment on the samprate key names exactly this pair. A rate
// off this list gives worse phase noise, an FFT length radiod struggles with, or a
// frequency scale that is quietly wrong.
const (
	SamprateHalf = 64_800_000  // 64.8 MHz — 0-30 MHz, the safe default
	SamprateFull = 129_600_000 // 129.6 MHz — 0-60 MHz, needs thermal work first
)

// SamprateThermalWarning is what an operator has to agree to before the full rate is
// accepted. Deliberately blunt: the failure it describes is physical and permanent, and
// upstream ka9q-radio defaults to half speed *because* of it.
const SamprateThermalWarning = "Running the RX888 MkII at 129.6 MSPS makes it run very hot. " +
	"Without thermal modifications — heatsinking the ADC and adding forced airflow — it will " +
	"overheat and be permanently damaged. This is not a warning about performance: the hardware " +
	"physically breaks. Only continue if this receiver's RX888 has been modified for it."

// validateRadiodSamprate checks the [rx888] samprate in a radiod config about to be saved.
//
// currentRate is what the server resolved at startup, and thermalAck is the operator's
// explicit agreement to the warning above. Raising the rate without that agreement is
// refused; leaving it already-raised is not, because the agreement was given when it was
// set and asking again on every unrelated edit would train people to click through it.
func validateRadiodSamprate(content []byte, currentRate int, thermalAck bool) error {
	rate, err := samprateFromRadiodConfBytes(content)
	if err != nil {
		return fmt.Errorf("no [rx888] samprate found in this config — it is required, and must be %d (0-30 MHz) or %d (0-60 MHz)",
			SamprateHalf, SamprateFull)
	}
	if rate != SamprateHalf && rate != SamprateFull {
		return fmt.Errorf("samprate %d is not supported — it must be exactly %d (64.8 MSPS, 0-30 MHz) or %d (129.6 MSPS, 0-60 MHz). "+
			"Only these two divide cleanly from the RX888's 27 MHz reference",
			rate, SamprateHalf, SamprateFull)
	}
	if rate == SamprateFull && currentRate != SamprateFull && !thermalAck {
		return fmt.Errorf("%s", SamprateThermalWarning)
	}
	return nil
}

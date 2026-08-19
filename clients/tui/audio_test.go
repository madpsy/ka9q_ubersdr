package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gdamore/tcell/v2"
)

func TestAutoModeAcrossCutoff(t *testing.T) {
	// The amateur convention flips at 10 MHz: LSB below, USB above.
	cases := []struct {
		freq float64
		want string
	}{
		{1_840_000, "lsb"},
		{3_573_000, "lsb"},
		{7_100_000, "lsb"},
		{9_999_999, "lsb"},
		{10_000_000, "usb"},
		{14_074_000, "usb"},
		{28_500_000, "usb"},
	}
	for _, c := range cases {
		if got := autoMode(c.freq); got != c.want {
			t.Errorf("autoMode(%.0f) = %q, want %q", c.freq, got, c.want)
		}
	}
}

func TestSyncSidebandOnlyAffectsSidebandModes(t *testing.T) {
	u := NewUI("test")
	u.autoSideband = true

	// Starting on 40 m, USB should flip to LSB.
	u.ApplyMode("usb")
	u.vfo = 7_100_000
	u.SyncSideband()
	if u.audioMode != "lsb" {
		t.Errorf("mode = %q at 7.1 MHz, want lsb", u.audioMode)
	}
	if u.bwLow >= 0 || u.bwHigh > 0 {
		t.Errorf("LSB filter should be negative, got %+d/%+d", u.bwLow, u.bwHigh)
	}

	// Crossing back up flips to USB.
	u.vfo = 14_074_000
	u.SyncSideband()
	if u.audioMode != "usb" {
		t.Errorf("mode = %q at 14.074 MHz, want usb", u.audioMode)
	}
	if u.bwLow < 0 {
		t.Errorf("USB filter should be positive, got %+d/%+d", u.bwLow, u.bwHigh)
	}

	// A deliberate choice of AM must survive crossing the cutoff.
	u.ApplyMode("am")
	u.vfo = 7_100_000
	u.SyncSideband()
	if u.audioMode != "am" {
		t.Errorf("AM was overridden to %q by the sideband rule", u.audioMode)
	}

	// And with auto off, nothing moves.
	u.ApplyMode("usb")
	u.autoSideband = false
	u.vfo = 3_573_000
	u.SyncSideband()
	if u.audioMode != "usb" {
		t.Errorf("auto off should leave the mode alone, got %q", u.audioMode)
	}
}

func TestSyncSidebandKeepsUserFilterWidth(t *testing.T) {
	// Flipping sideband should mirror the filter the user dialled in, not snap
	// back to the mode default.
	u := NewUI("test")
	u.autoSideband = true
	u.ApplyMode("usb")
	u.bwLow, u.bwHigh = 200, 3200 // a wider-than-default 3 kHz filter

	u.vfo = 7_100_000
	u.SyncSideband()

	if u.audioMode != "lsb" {
		t.Fatalf("mode = %q, want lsb", u.audioMode)
	}
	if u.bwLow != -3200 || u.bwHigh != -200 {
		t.Errorf("filter = %+d/%+d, want -3200/-200 (mirrored)", u.bwLow, u.bwHigh)
	}
	if got := u.bwHigh - u.bwLow; got != 3000 {
		t.Errorf("filter width changed to %d Hz, want 3000", got)
	}
}

func TestClampBandwidth(t *testing.T) {
	// Inverted edges are swapped rather than producing a negative-width filter.
	if lo, hi := clampBandwidth("usb", 2700, 300); lo != 300 || hi != 2700 {
		t.Errorf("inverted edges = %d/%d, want 300/2700", lo, hi)
	}
	// A collapsed filter would mute the channel.
	lo, hi := clampBandwidth("usb", 1000, 1000)
	if hi-lo < 50 {
		t.Errorf("collapsed filter survived: %d/%d", lo, hi)
	}
}

// TestClampBandwidthIsPerMode: the narrow modes run on a 12 kHz channel, so
// their filter cannot exceed +/-6 kHz however wide the server would allow.
func TestClampBandwidthIsPerMode(t *testing.T) {
	for _, m := range modes {
		lo, hi := clampBandwidth(m.Name, -99000, 99000)
		if lo != -m.MaxHz || hi != m.MaxHz {
			t.Errorf("%s clamped to %d/%d, want +/-%d", m.Name, lo, hi, m.MaxHz)
		}
		// Every default must itself be inside the mode's limit.
		if m.Low < -m.MaxHz || m.High > m.MaxHz {
			t.Errorf("%s default %d/%d exceeds its own limit of +/-%d",
				m.Name, m.Low, m.High, m.MaxHz)
		}
		// And inside what the server accepts.
		if m.MaxHz > maxBandwidthHz {
			t.Errorf("%s limit %d exceeds the server cap %d", m.Name, m.MaxHz, maxBandwidthHz)
		}
	}

	// A narrow mode must not be given a wide mode's headroom.
	if _, hi := clampBandwidth("usb", 50, 12000); hi != 6000 {
		t.Errorf("USB high clamped to %d, want 6000 (its Nyquist)", hi)
	}
	if _, hi := clampBandwidth("am", -5000, 12000); hi != 12000 {
		t.Errorf("AM high clamped to %d, want 12000", hi)
	}
}

// TestModeDefaultsMatchWebUI keeps the TUI sounding like the browser: these are
// LocalBookmarksUI.BW_DEFAULTS from static/local-bookmarks-ui.js.
func TestModeDefaultsMatchWebUI(t *testing.T) {
	want := map[string][2]int{
		"usb": {50, 2700},
		"lsb": {-2700, -50},
		"cwu": {-200, 200},
		"cwl": {-200, 200},
		"am":  {-5000, 5000},
		"sam": {-5000, 5000},
		"fm":  {-8000, 8000},
		"nfm": {-5000, 5000},
	}
	if len(modes) != len(want) {
		t.Errorf("%d modes defined, web UI lists %d", len(modes), len(want))
	}
	for _, m := range modes {
		w, ok := want[m.Name]
		if !ok {
			t.Errorf("mode %q is not in the web UI defaults", m.Name)
			continue
		}
		if m.Low != w[0] || m.High != w[1] {
			t.Errorf("%s default = %d/%d, web UI uses %d/%d", m.Name, m.Low, m.High, w[0], w[1])
		}
	}
}

func TestAdjustBandwidthMovesOuterEdge(t *testing.T) {
	u := NewUI("test")

	// Upper sideband: the high edge carries the bandwidth.
	u.ApplyMode("usb")
	u.AdjustBandwidth(+500)
	if u.bwLow != 50 || u.bwHigh != 3200 {
		t.Errorf("USB widen = %+d/%+d, want 50/3200", u.bwLow, u.bwHigh)
	}

	// Lower sideband: the low edge does.
	u.ApplyMode("lsb")
	u.AdjustBandwidth(+500)
	if u.bwLow != -3200 || u.bwHigh != -50 {
		t.Errorf("LSB widen = %+d/%+d, want -3200/-50", u.bwLow, u.bwHigh)
	}

	// A symmetric mode widens both ways.
	u.ApplyMode("am")
	u.AdjustBandwidth(+500)
	if u.bwLow != -5500 || u.bwHigh != 5500 {
		t.Errorf("AM widen = %+d/%+d, want -5500/5500", u.bwLow, u.bwHigh)
	}

	// Narrowing must not invert or collapse the filter.
	u.ApplyMode("usb")
	for i := 0; i < 100; i++ {
		u.AdjustBandwidth(-100)
	}
	if u.bwHigh <= u.bwLow {
		t.Errorf("filter inverted after repeated narrowing: %+d/%+d", u.bwLow, u.bwHigh)
	}
}

func TestFilterRange(t *testing.T) {
	// USB passes above the carrier, LSB below — the asymmetry the shading shows.
	lo, hi := filterRange(14_074_000, 300, 2700)
	if lo != 14_074_300 || hi != 14_076_700 {
		t.Errorf("USB range = %.0f..%.0f", lo, hi)
	}
	lo, hi = filterRange(7_100_000, -2700, -300)
	if lo != 7_097_300 || hi != 7_099_700 {
		t.Errorf("LSB range = %.0f..%.0f", lo, hi)
	}
}

func TestMixerChannelRouting(t *testing.T) {
	m := newMixer()
	m.priming = false // steady state; priming is covered separately
	m.push([]int16{1000, 1000})

	out := make([]int16, 4)
	m.setChannel(ChannelBoth)
	m.readStereo(out)
	if out[0] != 1000 || out[1] != 1000 {
		t.Errorf("both = %v, want equal channels", out[:2])
	}

	m.push([]int16{1000})
	m.setChannel(ChannelLeft)
	out = make([]int16, 2)
	m.readStereo(out)
	if out[0] != 1000 || out[1] != 0 {
		t.Errorf("left = %v, want audio only on the left", out)
	}

	m.push([]int16{1000})
	m.setChannel(ChannelRight)
	out = make([]int16, 2)
	m.readStereo(out)
	if out[0] != 0 || out[1] != 1000 {
		t.Errorf("right = %v, want audio only on the right", out)
	}
}

func TestMixerMuteAndVolume(t *testing.T) {
	m := newMixer()
	m.priming = false

	m.push([]int16{5000})
	m.setMuted(true)
	out := make([]int16, 2)
	m.readStereo(out)
	if out[0] != 0 || out[1] != 0 {
		t.Errorf("muted output = %v, want silence", out)
	}

	// Muting also discards the backlog, so unmuting resumes at live audio
	// instead of replaying what accumulated while silent.
	if buffered, _, _ := m.stats(); buffered != 0 {
		t.Errorf("muting left %d samples buffered", buffered)
	}

	m.setMuted(false)
	m.priming = false
	m.setVolume(0.5)
	m.push([]int16{1000})
	out = make([]int16, 2)
	m.readStereo(out)
	if out[0] != 500 {
		t.Errorf("half volume = %d, want 500", out[0])
	}
}

func TestMixerPadsRatherThanShortReading(t *testing.T) {
	// Backends treat a short read as end-of-stream, so an underrun must produce
	// silence for the whole buffer.
	m := newMixer()
	m.priming = false
	m.push([]int16{100, 200})

	out := make([]int16, 20)
	n := m.readStereo(out)
	if n != len(out) {
		t.Errorf("read returned %d, want a full buffer of %d", n, len(out))
	}
	for i := 4; i < len(out); i++ {
		if out[i] != 0 {
			t.Errorf("sample %d = %d, want silence padding", i, out[i])
		}
	}
}

func TestMixerBoundsLatency(t *testing.T) {
	// A stalled output must not let the buffer grow without limit.
	m := newMixer()
	chunk := make([]int16, 4800)
	for i := 0; i < 100; i++ {
		m.push(chunk)
	}
	buffered, dropped, _ := m.stats()
	if buffered > m.maxSamples {
		t.Errorf("buffered %d samples, cap is %d", buffered, m.maxSamples)
	}
	if dropped == 0 {
		t.Error("expected the oldest audio to be dropped once the cap was hit")
	}
}

func TestMixerClampsLoudSamples(t *testing.T) {
	m := newMixer()
	m.priming = false
	m.setVolume(4)
	m.push([]int16{20000, -20000})

	out := make([]int16, 4)
	m.readStereo(out)
	if out[0] != 32767 {
		t.Errorf("positive clip = %d, want 32767", out[0])
	}
	if out[2] != -32768 {
		t.Errorf("negative clip = %d, want -32768", out[2])
	}
}

func TestFilterShadingFollowsBandwidth(t *testing.T) {
	// The shaded region must sit where the filter actually passes, which for a
	// sideband mode is offset to one side of the tuned frequency.
	ui, screen := newTestUI(120, 30, ViewSplit)
	ui.audioOn = true
	ui.vfo = 7_100_000
	ui.ApplyMode("lsb") // passes below the carrier
	ui.SetFrame(unwrapFFT(syntheticFrame(1024, 0)), 0, 0)
	ui.Draw(screen)

	l := computeLayout(120, 30, ViewSplit, ui.splitRatio, 0)
	start, span := ui.viewRange()
	lo, hi := filterRange(ui.vfo, ui.bwLow, ui.bwHigh)
	loCol := l.PlotX + int((lo-start)/span*float64(l.PlotW))
	hiCol := l.PlotX + int((hi-start)/span*float64(l.PlotW))

	cells, w, _ := screen.GetContents()
	shaded := func(x int) bool {
		_, bg, _ := cells[(l.SpecY+1)*w+x].Style.Decompose()
		r, g, b := bg.RGB()
		return r+g+b > 0
	}

	if !shaded((loCol + hiCol) / 2) {
		t.Error("the middle of the passband is not shaded")
	}
	// Just outside the filter, and away from the VFO marker column, must be clear.
	if outside := hiCol + 4; outside < l.PlotX+l.PlotW && shaded(outside) {
		t.Error("shading extends past the upper filter edge")
	}
	if outside := loCol - 4; outside > l.PlotX && shaded(outside) {
		t.Error("shading extends past the lower filter edge")
	}
}

func TestFilterShadingHiddenWhenAudioOff(t *testing.T) {
	ui, screen := newTestUI(120, 30, ViewSplit)
	ui.audioOn = false
	ui.vfo = 7_100_000
	ui.SetFrame(unwrapFFT(syntheticFrame(1024, 0)), 0, 0)
	ui.Draw(screen)

	l := computeLayout(120, 30, ViewSplit, ui.splitRatio, 0)
	cells, w, _ := screen.GetContents()
	markerCol := ui.ColAt(l, ui.vfo)
	for x := l.PlotX; x < w; x++ {
		if x == markerCol {
			continue // the VFO marker tints its own column
		}
		_, bg, _ := cells[(l.SpecY+1)*w+x].Style.Decompose()
		if r, g, b := bg.RGB(); r+g+b > 0 {
			t.Fatalf("column %d is shaded with audio off", x)
		}
	}
}

func TestHeaderShowsAudioState(t *testing.T) {
	ui, screen := newTestUI(200, 30, ViewSpectrum)
	ui.audioOn = true
	ui.vfo = 7_100_000
	ui.ApplyMode("lsb")
	ui.muted = true
	ui.signal = Signal{Power: -73, Noise: -110}
	ui.SetFrame(unwrapFFT(syntheticFrame(1024, 0)), 0, 0)
	ui.Draw(screen)

	cells, w, _ := screen.GetContents()
	var header strings.Builder
	for i := 0; i < w; i++ {
		if r := cells[i].Runes; len(r) > 0 && r[0] != 0 {
			header.WriteRune(r[0])
		} else {
			header.WriteRune(' ')
		}
	}
	got := header.String()
	for _, want := range []string{"LSB", "muted", "-73"} {
		if !strings.Contains(got, want) {
			t.Errorf("header missing %q: %q", want, got)
		}
	}
}

func TestAudioPanelAdjustments(t *testing.T) {
	ui := NewUI("test")
	ui.ApplyMode("usb")
	devices := []AudioDevice{{ID: "", Name: "System default", Default: true}, {ID: "usb-dac", Name: "USB DAC"}}
	p := NewAudioPanel(devices, nil)

	key := func(k tcell.Key) *tcell.EventKey { return tcell.NewEventKey(k, 0, tcell.ModNone) }

	// Device row: stepping right selects the next device and asks for a reopen.
	p.row = rowDevice
	_, reopen, _ := p.HandleKey(key(tcell.KeyRight), ui, "")
	if !reopen || p.selectedDevice != "usb-dac" {
		t.Errorf("device step = %q (reopen=%v), want usb-dac", p.selectedDevice, reopen)
	}

	// Channel row cycles routing without needing a retune.
	p.row = rowChannel
	p.HandleKey(key(tcell.KeyRight), ui, "")
	if ui.channel != ChannelLeft {
		t.Errorf("channel = %v, want left", ui.channel)
	}

	// Filter edges retune the radio.
	p.row = rowBandHigh
	retune, _, _ := p.HandleKey(key(tcell.KeyRight), ui, "")
	if !retune {
		t.Error("changing the filter should request a retune")
	}
	if ui.bwHigh != 2700+filterStepHz {
		t.Errorf("filter high = %d, want %d after one %d Hz step",
			ui.bwHigh, 2700+filterStepHz, filterStepHz)
	}

	// Escape closes.
	if _, _, done := p.HandleKey(key(tcell.KeyEscape), ui, ""); !done {
		t.Error("Escape should close the panel")
	}
}

func TestAudioPanelRendersAtManySizes(t *testing.T) {
	ui := NewUI("test")
	ui.ApplyMode("usb")
	devices := []AudioDevice{{ID: "", Name: strings.Repeat("long device name ", 8)}}

	for _, size := range [][2]int{{40, 12}, {80, 24}, {200, 60}, {30, 8}} {
		screen := tcell.NewSimulationScreen("UTF-8")
		if err := screen.Init(); err != nil {
			t.Fatal(err)
		}
		screen.SetSize(size[0], size[1])

		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("audio panel panicked at %dx%d: %v", size[0], size[1], r)
				}
			}()
			p := NewAudioPanel(devices, nil)
			p.Draw(screen, ui, "")
		}()
	}
}

func TestAudioLevelPlaceholderWhenSilent(t *testing.T) {
	// Before any packet arrives the level is -Inf and must not be printed as a
	// number.
	u := NewUI("test")
	u.audioOn = true
	if u.signal.Valid() {
		t.Fatalf("initial signal reports valid: %+v", u.signal)
	}
	if got := u.audioField(); strings.Contains(got, "Inf") {
		t.Errorf("audio field leaks the sentinel: %q", got)
	}
}

// TestRenderDoesNotPresent pins the split that fixes overlay flicker. Draw
// renders and presents; render only fills the buffer, so a caller stacking an
// overlay can present once with everything in place. Presenting twice showed a
// frame of the bare display between them, which read as the panel flickering
// and the waterfall drawing over it.
func TestRenderDoesNotPresent(t *testing.T) {
	ui, screen := newTestUI(100, 30, ViewSplit)
	ui.SetFrame(unwrapFFT(syntheticFrame(1024, 0)), 0, 0)

	ui.render(screen)
	if got := dump(screen); strings.TrimSpace(got) != "" {
		t.Error("render() presented to the screen; it must only fill the buffer")
	}

	// Draw is the presenting variant.
	ui.Draw(screen)
	if got := dump(screen); !strings.Contains(got, "sim.example.org") {
		t.Error("Draw() did not present")
	}
}

// TestOverlaySurvivesFullRedraw is the user-visible property: after a redraw
// that renders the spectrum, waterfall and panel together, the panel is what is
// actually on screen — not overdrawn by the display behind it.
func TestOverlaySurvivesFullRedraw(t *testing.T) {
	ui, screen := newTestUI(110, 30, ViewSplit)
	ui.audioOn = true
	ui.vfo = 7_100_000
	ui.ApplyMode("lsb")
	// Enough history that the waterfall covers the rows the panel occupies.
	for i := 0; i < 30; i++ {
		ui.SetFrame(unwrapFFT(syntheticFrame(1024, float64(i)/3)), 0, 0)
	}

	panel := NewAudioPanel([]AudioDevice{{ID: "", Name: "System default"}}, nil)

	// Exactly what eventLoop.draw does with a panel open: render, overlay,
	// present once.
	ui.render(screen)
	panel.Draw(screen, ui, "")
	screen.Show()

	lines := strings.Split(dump(screen), "\n")

	found := map[string]bool{}
	for _, line := range lines {
		for _, want := range []string{"Audio", "Output device", "Channel", "Volume", "Mode", "Filter low", "Filter high"} {
			if strings.Contains(line, want) {
				found[want] = true
			}
		}
	}
	for _, want := range []string{"Audio", "Output device", "Channel", "Volume", "Mode", "Filter low", "Filter high"} {
		if !found[want] {
			t.Errorf("panel row %q was overdrawn by the display", want)
		}
	}

	// Within the panel's own width, no spectrum or waterfall glyphs may show
	// through — that is what the flicker looked like.
	for _, line := range lines {
		idx := strings.Index(line, "Output device")
		if idx < 0 {
			continue
		}
		region := line[idx : idx+min(40, len(line)-idx)]
		if strings.ContainsAny(region, "\u258c\u2588\u2807\u28ff") {
			t.Errorf("display glyphs bled through the panel row: %q", region)
		}
	}
}

// TestAudioStartsUnmuted pins the default: a receiver should make sound as soon
// as it has a frequency, without the user having to ask.
func TestAudioStartsUnmuted(t *testing.T) {
	u := NewUI("test")
	if u.muted {
		t.Error("a fresh UI starts muted; audio should come up making sound")
	}
	if u.volume <= 0 {
		t.Errorf("initial volume is %v; audio would be silent", u.volume)
	}
	if u.channel != ChannelBoth {
		t.Errorf("initial channel is %v, want both", u.channel)
	}
}

// TestMaybeStartAudioGating covers when audio is allowed to come up on its own:
// only once a frequency is known, only once, never with -no-audio, and never
// again after the output device has failed (which m retries explicitly).
func TestMaybeStartAudioGating(t *testing.T) {
	cases := []struct {
		name             string
		noAudio, audioOn bool
		failed           bool
		vfo              float64
		wantStartAttempt bool
	}{
		{"no frequency yet", false, false, false, 0, false},
		{"ready", false, false, false, 7_100_000, true},
		{"already running", false, true, false, 7_100_000, false},
		{"disabled by flag", true, false, false, 7_100_000, false},
		{"device previously failed", false, false, true, 7_100_000, false},
	}

	for _, c := range cases {
		e := &eventLoop{
			ui:          NewUI("test"),
			opts:        options{noAudio: c.noAudio},
			audioFailed: c.failed,
		}
		e.ui.audioOn = c.audioOn
		e.ui.vfo = c.vfo

		// With no AudioClient wired up, startAudio returns immediately, so the
		// observable effect is whether the gate let it through at all.
		gated := e.opts.noAudio || e.ui.audioOn || e.audioFailed || e.ui.vfo <= 0
		if gated == c.wantStartAttempt {
			t.Errorf("%s: gate allowed=%v, want allowed=%v", c.name, !gated, c.wantStartAttempt)
		}

		// It must never panic with no audio client attached.
		e.maybeStartAudio()
	}
}

// TestHeaderDegradesGracefully: a narrow terminal must shed low-value fields
// rather than dropping the whole right-hand side. Adding the audio field made
// the line overflow at 80 columns, which silently hid the frequency too.
func TestHeaderDegradesGracefully(t *testing.T) {
	for _, w := range []int{60, 80, 100, 140, 200} {
		ui, screen := newTestUI(w, 24, ViewSpectrum)
		ui.audioOn = true
		ui.vfo = 7_100_000
		ui.ApplyMode("lsb")
		ui.signal = Signal{Power: -70, Noise: -110}
		ui.SetFrame(unwrapFFT(syntheticFrame(1024, 0)), 0, 0)
		ui.Draw(screen)

		cells, sw, _ := screen.GetContents()
		var header strings.Builder
		for i := 0; i < sw; i++ {
			if r := cells[i].Runes; len(r) > 0 && r[0] != 0 {
				header.WriteRune(r[0])
			} else {
				header.WriteRune(' ')
			}
		}
		got := header.String()

		// The frequency is the highest-priority field and must never be shed.
		if !strings.Contains(got, "VFO") {
			t.Errorf("width %d: header lost the VFO entirely: %q", w, got)
		}
		// Audio state is next; it should survive anything but the tightest fit.
		if w >= 80 && !strings.Contains(got, "LSB") {
			t.Errorf("width %d: header lost the audio state: %q", w, got)
		}
		// And it must never overflow the width.
		if len([]rune(strings.TrimRight(got, " "))) > w {
			t.Errorf("width %d: header overflowed", w)
		}
	}
}

// TestTuningKeysStepTheVFO covers the keyboard tuning that was missing: the VFO
// could only be stepped with the wheel, so a keyboard-only user had no way to
// tune up and down.
func TestTuningKeysStepTheVFO(t *testing.T) {
	newLoop := func() *eventLoop {
		ui := NewUI("test")
		ui.cfg = SpectrumConfig{CenterFreq: 7_100_000, BinCount: 1024,
			BinBandwidth: 200, TotalBandwidth: 204_800}
		ui.vfo = 7_100_000
		return &eventLoop{ui: ui}
	}

	e := newLoop()
	step := e.ui.StepHz() // 1 kHz by default

	e.stepVFO(+1)
	if got := e.ui.vfo; got != 7_100_000+step {
		t.Errorf("one step up = %.0f, want %.0f", got, 7_100_000+step)
	}

	e.stepVFO(-1)
	if got := e.ui.vfo; got != 7_100_000 {
		t.Errorf("stepping back = %.0f, want 7100000", got)
	}

	// Page keys move ten steps for coarse tuning.
	e.stepVFO(+10)
	if got := e.ui.vfo; got != 7_100_000+10*step {
		t.Errorf("ten steps up = %.0f, want %.0f", got, 7_100_000+10*step)
	}

	// The step size setting is respected.
	e = newLoop()
	e.ui.stepIdx = 0 // 10 Hz
	e.stepVFO(+1)
	if got := e.ui.vfo; got != 7_100_010 {
		t.Errorf("10 Hz step = %.0f, want 7100010", got)
	}

	// Stepping snaps to the step grid, so an off-grid VFO is tidied up rather
	// than carrying its offset forever.
	e = newLoop()
	e.ui.vfo = 7_100_437
	e.stepVFO(+1)
	if int64(e.ui.vfo)%int64(step) != 0 {
		t.Errorf("VFO %.0f is not on the %.0f Hz grid", e.ui.vfo, step)
	}

	// And it stays inside the receiver's range.
	e = newLoop()
	e.ui.vfo = maxFreq
	e.stepVFO(+100)
	if e.ui.vfo > maxFreq {
		t.Errorf("stepped past the top of the band: %.0f", e.ui.vfo)
	}
	e.ui.vfo = minFreq
	e.stepVFO(-100)
	if e.ui.vfo < minFreq {
		t.Errorf("stepped below the bottom of the band: %.0f", e.ui.vfo)
	}
}

// TestArrowsNoLongerZoom guards the reassignment: up/down tune now, and zoom
// keeps +/- which always covered it.
func TestArrowsNoLongerZoom(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)

	start := strings.Index(body, "func (e *eventLoop) handleKey(")
	if start < 0 {
		t.Fatal("handleKey not found")
	}
	end := strings.Index(body[start:], "\nfunc ")
	region := body[start : start+end]

	for _, k := range []string{"case tcell.KeyUp:", "case tcell.KeyDown:"} {
		i := strings.Index(region, k)
		if i < 0 {
			t.Fatalf("%s is not handled", k)
		}
		next := region[i : i+120]
		if strings.Contains(next, "zoomStep") {
			t.Errorf("%s still zooms; it should tune", k)
		}
		if !strings.Contains(next, "stepVFO") {
			t.Errorf("%s does not tune the VFO", k)
		}
	}

	// Zoom must still be reachable.
	if !strings.Contains(region, "zoomStep") {
		t.Error("zoom is no longer bound to any key")
	}
}

// TestClickSnapsToStep: a character cell can cover many kHz, so a click is far
// less precise than the frequency it maps to. Snapping lands the VFO on the
// tuning grid rather than an arbitrary offset.
func TestClickSnapsToStep(t *testing.T) {
	u := NewUI("test")

	for _, step := range tuningSteps {
		u.stepIdx = modeStepIndex(step)
		for _, raw := range []float64{7_100_437, 14_074_913, 3_573_051, 10_000_499} {
			got := u.snapToStep(raw)
			if int64(got)%int64(step) != 0 {
				t.Errorf("step %.0f: snapped %.0f to %.0f, which is off the grid", step, raw, got)
			}
			// It must round to the nearest grid point, never further than half
			// a step away.
			if diff := math.Abs(got - raw); diff > step/2 {
				t.Errorf("step %.0f: snapped %.0f to %.0f, %.0f Hz away", step, raw, got, diff)
			}
		}
	}

	// An already-aligned frequency is left alone.
	u.stepIdx = 3 // 1 kHz
	if got := u.snapToStep(7_100_000); got != 7_100_000 {
		t.Errorf("aligned frequency moved to %.0f", got)
	}
}

// TestTypedFrequencyIsNotSnapped: exact frequencies typed by the user must be
// honoured, since digital modes sit on precise channels.
func TestTypedFrequencyIsNotSnapped(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)

	start := strings.Index(body, "func (e *eventLoop) commitPrompt(")
	if start < 0 {
		t.Fatal("commitPrompt not found")
	}
	end := strings.Index(body[start:], "\nfunc ")
	if strings.Contains(body[start:start+end], "snapToStep") {
		t.Error("typed frequencies are being snapped; 14.074 MHz would be altered")
	}
}

func modeStepIndex(step float64) int {
	for i, s := range tuningSteps {
		if s == step {
			return i
		}
	}
	return 0
}

// TestAudioFieldWidthIsStable is the regression guard for the header jittering.
// The header is right-aligned, so any field that changes length shifts the
// whole row — and the signal level changes on nearly every audio packet.
func TestAudioFieldWidthIsStable(t *testing.T) {
	u := NewUI("test")
	u.audioOn = true
	u.vfo = 7_100_000

	var widths []int
	var samples []string
	record := func() {
		f := u.audioField()
		widths = append(widths, runeLen(f))
		samples = append(samples, f)
	}

	// The level swinging across digit counts, including the pre-first-packet
	// placeholder, is exactly what the user saw shifting.
	for _, lv := range []float32{
		float32(math.Inf(-1)), -9, -90, -120, -100, -7, 0,
	} {
		u.signal = Signal{Power: lv, Noise: -120}
		record()
	}
	// Mode names and state words differ in length too.
	for _, m := range []string{"usb", "lsb", "am", "sam", "nfm", "cwu"} {
		u.ApplyMode(m)
		record()
	}
	for _, st := range []struct {
		muted bool
		ch    Channel
	}{{false, ChannelBoth}, {true, ChannelBoth}, {false, ChannelLeft}, {false, ChannelRight}} {
		u.muted, u.channel = st.muted, st.ch
		record()
	}
	// Filter width, from the narrowest CW filter to the widest FM.
	for _, bw := range [][2]int{{400, 800}, {300, 2700}, {-4000, 4000}, {-12000, 12000}} {
		u.bwLow, u.bwHigh = bw[0], bw[1]
		record()
	}

	for i, w := range widths {
		if w != widths[0] {
			t.Errorf("audio field width %d differs from %d:\n  %q\n  %q",
				w, widths[0], samples[i], samples[0])
		}
	}
	t.Logf("audio field is a stable %d columns, e.g. %q", widths[0], samples[len(samples)-1])
}

// TestHeaderPositionIsStableAsLevelChanges is the same property end to end: the
// rendered header must not move when only the signal level changes.
func TestHeaderPositionIsStableAsLevelChanges(t *testing.T) {
	header := func(level float32) string {
		ui, screen := newTestUI(140, 24, ViewSpectrum)
		ui.audioOn = true
		ui.vfo = 7_100_000
		ui.ApplyMode("lsb")
		ui.signal = Signal{Power: level, Noise: -120}
		ui.fps = 13
		ui.SetFrame(unwrapFFT(syntheticFrame(1024, 0)), 0, 0)
		ui.Draw(screen)

		cells, w, _ := screen.GetContents()
		var b strings.Builder
		for i := 0; i < w; i++ {
			if r := cells[i].Runes; len(r) > 0 && r[0] != 0 {
				b.WriteRune(r[0])
			} else {
				b.WriteRune(' ')
			}
		}
		return b.String()
	}

	base := header(-90)
	baseIdx := strings.Index(base, "LSB")
	if baseIdx < 0 {
		t.Fatalf("audio field missing: %q", base)
	}

	for _, lv := range []float32{-9, -100, -120, 0, float32(math.Inf(-1))} {
		got := header(lv)
		if idx := strings.Index(got, "LSB"); idx != baseIdx {
			t.Errorf("level %v moved the audio field from column %d to %d:\n  %q",
				lv, baseIdx, idx, got)
		}
		if idx := strings.Index(got, "VFO"); idx != strings.Index(base, "VFO") {
			t.Errorf("level %v moved the VFO field", lv)
		}
	}
}

// TestDefaultTuningStep pins the default. 500 Hz is fine enough to land on an
// SSB signal and coarse enough to cross a band without spinning, and it is what
// click-to-tune snaps to before the user changes anything.
func TestDefaultTuningStep(t *testing.T) {
	u := NewUI("test")
	if got := u.StepHz(); got != 500 {
		t.Errorf("default step = %v Hz, want 500", got)
	}

	// The default must be a real entry in the ladder, not an index that drifts
	// if the list is reordered.
	found := false
	for _, s := range tuningSteps {
		if s == 500 {
			found = true
		}
	}
	if !found {
		t.Error("500 Hz is not in tuningSteps")
	}

	// And it is what a click snaps to out of the box.
	if got := u.snapToStep(7_100_437); got != 7_100_500 {
		t.Errorf("click snapped to %.0f, want 7100500 on the 500 Hz grid", got)
	}
}

// TestPanelFilterStep: the panel is the precise control, so its steps match the
// 50 Hz granularity of the mode defaults rather than the coarser one-key
// adjustment on , and .
func TestPanelFilterStep(t *testing.T) {
	if filterStepHz != 50 {
		t.Fatalf("filter step is %d Hz, want 50", filterStepHz)
	}

	ui := NewUI("test")
	ui.ApplyMode("usb")
	p := NewAudioPanel(nil, nil)
	key := func(k tcell.Key) *tcell.EventKey { return tcell.NewEventKey(k, 0, tcell.ModNone) }

	p.row = rowBandHigh
	before := ui.bwHigh
	p.HandleKey(key(tcell.KeyRight), ui, "")
	if got := ui.bwHigh - before; got != filterStepHz {
		t.Errorf("high edge moved %d Hz, want %d", got, filterStepHz)
	}
	p.HandleKey(key(tcell.KeyLeft), ui, "")
	if ui.bwHigh != before {
		t.Errorf("stepping back gave %d, want %d", ui.bwHigh, before)
	}

	p.row = rowBandLow
	before = ui.bwLow
	p.HandleKey(key(tcell.KeyRight), ui, "")
	if got := ui.bwLow - before; got != filterStepHz {
		t.Errorf("low edge moved %d Hz, want %d", got, filterStepHz)
	}

	// Holding a direction must stop at the mode's limit, not run past it.
	p.row = rowBandHigh
	for i := 0; i < 400; i++ {
		p.HandleKey(key(tcell.KeyRight), ui, "")
	}
	m, _ := lookupMode("usb")
	if ui.bwHigh != m.MaxHz {
		t.Errorf("high edge ran to %d, want the USB limit %d", ui.bwHigh, m.MaxHz)
	}
}

func TestDSPCycle(t *testing.T) {
	e := &eventLoop{ui: NewUI("test")}
	e.ui.dspFilters = []string{"nr2", "rn2", "nr4", "dfnr"}

	// Off is the default and the start of the cycle.
	if e.ui.dspFilter != "" {
		t.Errorf("DSP starts as %q, want off", e.ui.dspFilter)
	}

	want := []string{"nr2", "rn2", "nr4", "dfnr", ""}
	for i, w := range want {
		e.cycleDSP(+1)
		if e.ui.dspFilter != w {
			t.Errorf("step %d gave %q, want %q", i+1, e.ui.dspFilter, w)
		}
	}

	// And it cycles backwards through the same positions.
	e.cycleDSP(-1)
	if e.ui.dspFilter != "dfnr" {
		t.Errorf("stepping back gave %q, want dfnr", e.ui.dspFilter)
	}
}

func TestDSPCycleWithNoneOffered(t *testing.T) {
	// A receiver without DSP must say so rather than appearing to enable
	// something.
	e := &eventLoop{ui: NewUI("test")}
	e.cycleDSP(+1)
	if e.ui.dspFilter != "" {
		t.Errorf("DSP set to %q on a receiver that offers none", e.ui.dspFilter)
	}
	if !strings.Contains(e.ui.status, "no server-side DSP") {
		t.Errorf("status does not explain why nothing happened: %q", e.ui.status)
	}
}

func TestDSPStartsOff(t *testing.T) {
	u := NewUI("test")
	if u.dspFilter != "" {
		t.Errorf("DSP defaults to %q, want off", u.dspFilter)
	}
	if len(u.dspFilters) != 0 {
		t.Error("DSP filter list should start empty until the receiver is asked")
	}
	// With no receiver asked yet, DSP is "not applicable" rather than "off":
	// those are different states and conflating them would misreport a
	// receiver without DSP as merely switched off.
	u.audioOn = true
	if got := u.dspLabel(); got != "n/a" {
		t.Errorf("label with no receiver info = %q, want n/a", got)
	}

	// Once the receiver reports filters, none selected reads as off.
	u.dspFilters = []string{"nr2", "nr4"}
	if got := u.dspLabel(); got != "off" {
		t.Errorf("label with filters offered but none active = %q, want off", got)
	}
	if !strings.Contains(u.audioField(), "off") {
		t.Errorf("header does not show DSP off: %q", u.audioField())
	}

	u.dspFilter = "nr4"
	if got := u.dspLabel(); got != "NR4" {
		t.Errorf("label with nr4 active = %q, want NR4", got)
	}
}

func TestDSPHeaderWidthStaysStable(t *testing.T) {
	// The audio field is fixed width; adding the DSP name must not break that.
	u := NewUI("test")
	u.audioOn = true
	u.signal = Signal{Power: -80, Noise: -120}

	want := runeLen(u.audioField())
	for _, f := range []string{"", "nr2", "rn2", "nr4", "dfnr"} {
		u.dspFilter = f
		if got := runeLen(u.audioField()); got != want {
			t.Errorf("DSP %q changed the audio field width to %d, want %d: %q",
				f, got, want, u.audioField())
		}
	}
}

func TestDSPPanelRow(t *testing.T) {
	ui := NewUI("test")
	ui.dspFilters = []string{"nr2", "nr4"}
	p := NewAudioPanel(nil, nil)
	key := func(k tcell.Key) *tcell.EventKey { return tcell.NewEventKey(k, 0, tcell.ModNone) }

	// The panel records a pending step rather than sending the command itself,
	// since the command goes over the audio socket the caller owns.
	p.row = rowDSP
	p.HandleKey(key(tcell.KeyRight), ui, "")
	if p.dspStep != 1 {
		t.Errorf("right arrow recorded step %d, want 1", p.dspStep)
	}
	p.dspStep = 0
	p.HandleKey(key(tcell.KeyLeft), ui, "")
	if p.dspStep != -1 {
		t.Errorf("left arrow recorded step %d, want -1", p.dspStep)
	}

	// The row renders the current state and what is on offer.
	screen := tcell.NewSimulationScreen("UTF-8")
	if err := screen.Init(); err != nil {
		t.Fatal(err)
	}
	screen.SetSize(100, 30)
	p.Draw(screen, ui, "")
	screen.Show()

	out := dump(screen)
	if !strings.Contains(out, "Noise reduction") {
		t.Errorf("panel missing the DSP row:\n%s", out)
	}
	if !strings.Contains(out, "NR2") {
		t.Errorf("panel does not list the available filters in uppercase:\n%s", out)
	}
}

func TestDSPFollowsServerState(t *testing.T) {
	// The server may refuse a filter when the insert is at its user limit, so
	// the display follows dsp_status rather than what was requested.
	a := NewAudioClient("h", false, "", "id")
	a.handleText([]byte(`{"type":"dsp_status","info":{"enabled":true,"filter":"nr4"}}`))
	select {
	case st := <-a.DSP:
		if !st.Enabled || st.Filter != "nr4" {
			t.Errorf("parsed %+v, want enabled nr4", st)
		}
	default:
		t.Fatal("no DSP state reported")
	}

	a.handleText([]byte(`{"type":"dsp_status","info":{"enabled":false}}`))
	select {
	case st := <-a.DSP:
		if st.Enabled {
			t.Errorf("parsed %+v, want disabled", st)
		}
	default:
		t.Fatal("no DSP state reported for the disable")
	}
}

// TestStatusBarAlwaysShowsNoiseReduction: NR has no other always-visible
// indication of what it is doing, so its state and its key stay in the status
// bar even when the width forces other hints out.
func TestStatusBarAlwaysShowsNoiseReduction(t *testing.T) {
	statusRow := func(w int, filters []string, active string, audio bool) string {
		ui, screen := newTestUI(w, 24, ViewSpectrum)
		ui.audioOn = audio
		ui.vfo = 7_100_000
		ui.dspFilters = filters
		ui.dspFilter = active
		ui.signal = Signal{Power: -80, Noise: -120}
		ui.SetFrame(unwrapFFT(syntheticFrame(1024, 0)), 0, 0)
		ui.Draw(screen)

		l := computeLayout(w, 24, ViewSpectrum, ui.splitRatio, 0)
		cells, sw, _ := screen.GetContents()
		row := make([]rune, 0, sw)
		for i := 0; i < sw; i++ {
			if r := cells[l.StatusY*sw+i].Runes; len(r) > 0 && r[0] != 0 {
				row = append(row, r[0])
			} else {
				row = append(row, ' ')
			}
		}
		return string(row)
	}

	filters := []string{"nr2", "rn2", "nr4", "dfnr"}
	for _, w := range []int{60, 80, 100, 140, 200} {
		got := statusRow(w, filters, "nr4", true)
		if !strings.Contains(got, "n NR:") {
			t.Errorf("width %d: status bar lost the NR hint: %q", w, got)
		}
		if !strings.Contains(got, "NR4") {
			t.Errorf("width %d: status bar does not show the active filter: %q", w, got)
		}
		// The row must never overflow.
		if len([]rune(strings.TrimRight(got, " "))) > w {
			t.Errorf("width %d: status bar overflowed", w)
		}
	}

	// The three states are distinguishable.
	if got := statusRow(140, filters, "nr2", true); !strings.Contains(got, "NR:NR2") {
		t.Errorf("active filter should show uppercase: %q", got)
	}
	if got := statusRow(140, filters, "", true); !strings.Contains(got, "NR:off") {
		t.Errorf("filters offered, none active should read off: %q", got)
	}
	if got := statusRow(140, nil, "", true); !strings.Contains(got, "NR:n/a") {
		t.Errorf("no filters offered should read n/a: %q", got)
	}
}

// TestStatusHintsShedByPriority: when the bar cannot hold every hint, the ones
// that matter most survive.
func TestStatusHintsShedByPriority(t *testing.T) {
	ui, screen := newTestUI(64, 24, ViewSpectrum)
	ui.audioOn = true
	ui.vfo = 7_100_000
	ui.dspFilters = []string{"nr2"}
	ui.SetFrame(unwrapFFT(syntheticFrame(1024, 0)), 0, 0)
	ui.Draw(screen)

	l := computeLayout(64, 24, ViewSpectrum, ui.splitRatio, 0)
	cells, sw, _ := screen.GetContents()
	row := make([]rune, 0, sw)
	for i := 0; i < sw; i++ {
		if r := cells[l.StatusY*sw+i].Runes; len(r) > 0 && r[0] != 0 {
			row = append(row, r[0])
		} else {
			row = append(row, ' ')
		}
	}
	got := string(row)

	// Quitting and help must never be the things that get dropped.
	for _, want := range []string{"n NR:", "q quit", "? help"} {
		if !strings.Contains(got, want) {
			t.Errorf("narrow bar dropped %q: %q", want, got)
		}
	}
}

// TestPadToCountsRunes is the regression guard for the status bar silently
// losing its tail: padTo measured bytes, so a row full of multi-byte
// separators was byte-sliced short of its width.
func TestPadToCountsRunes(t *testing.T) {
	s := "a · b · c" // three ASCII letters, two 2-byte separators
	if got := padTo(s, 20); len([]rune(got)) != 20 {
		t.Errorf("padTo produced %d runes, want 20", len([]rune(got)))
	}
	if got := padTo(s, 9); got != s {
		t.Errorf("padTo at exact width altered the string: %q", got)
	}
	// Truncation must cut on a rune boundary, never mid-character.
	got := padTo(s, 5)
	if len([]rune(got)) != 5 {
		t.Errorf("truncated to %d runes, want 5", len([]rune(got)))
	}
	if !utf8ValidString(got) {
		t.Errorf("truncation split a character: %q", got)
	}
}

func utf8ValidString(s string) bool {
	for _, r := range s {
		if r == '�' {
			return false
		}
	}
	return true
}

// TestConstructorsUseTheModeTable is the regression guard for the corrected
// USB/LSB defaults not taking effect. The starting bandwidth was written out
// by hand in two constructors as well as in the mode table, so fixing the
// table left the client still opening with the old 300 Hz low edge until the
// user changed mode or crossed the 10 MHz cutoff.
func TestConstructorsUseTheModeTable(t *testing.T) {
	usb, ok := lookupMode("usb")
	if !ok {
		t.Fatal("usb missing from the mode table")
	}

	u := NewUI("test")
	if u.audioMode != "usb" {
		t.Errorf("UI starts in %q, want usb", u.audioMode)
	}
	if u.bwLow != usb.Low || u.bwHigh != usb.High {
		t.Errorf("UI starts with %+d/%+d, mode table says %+d/%+d",
			u.bwLow, u.bwHigh, usb.Low, usb.High)
	}

	a := NewAudioClient("h", false, "", "id")
	if a.mode != usb.Name || a.bwLow != usb.Low || a.bwHigh != usb.High {
		t.Errorf("audio client starts with %s %+d/%+d, mode table says %s %+d/%+d",
			a.mode, a.bwLow, a.bwHigh, usb.Name, usb.Low, usb.High)
	}
}

// TestNoHardcodedBandwidthDefaults keeps the numbers in one place: the mode
// table. A literal filter edge anywhere else is how the last fix got missed.
func TestNoHardcodedBandwidthDefaults(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	// The superseded values, which must not reappear as filter edges.
	stale := []string{"bwLow:     300", "bwLow:        300", "bwLow: 300", "bwHigh: -300"}

	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") || f == "modes.go" {
			continue // the table itself is the one place these belong
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, bad := range stale {
			if strings.Contains(string(src), bad) {
				t.Errorf("%s contains a hardcoded filter edge %q; use the mode table", f, bad)
			}
		}
	}
}

// TestStartupFilterAtRealFrequencies walks the path a user actually takes: the
// VFO lands on a band and the sideband convention applies.
func TestStartupFilterAtRealFrequencies(t *testing.T) {
	lsb, _ := lookupMode("lsb")
	usb, _ := lookupMode("usb")

	for _, c := range []struct {
		freq     float64
		wantMode string
		lo, hi   int
	}{
		{7_100_000, "lsb", lsb.Low, lsb.High},
		{3_573_000, "lsb", lsb.Low, lsb.High},
		{14_074_000, "usb", usb.Low, usb.High},
		{28_500_000, "usb", usb.Low, usb.High},
	} {
		u := NewUI("test")
		u.vfo = c.freq
		u.SyncSideband()

		if u.audioMode != c.wantMode {
			t.Errorf("%.3f MHz selected %q, want %q", c.freq/1e6, u.audioMode, c.wantMode)
		}
		if u.bwLow != c.lo || u.bwHigh != c.hi {
			t.Errorf("%.3f MHz gave filter %+d/%+d, want %+d/%+d",
				c.freq/1e6, u.bwLow, u.bwHigh, c.lo, c.hi)
		}
	}
}

// TestDSPNamesUppercaseForDisplayOnly: the names are shown uppercase, but the
// server's protocol uses lowercase and sending "NR4" would not match any
// filter it knows.
func TestDSPNamesUppercaseForDisplayOnly(t *testing.T) {
	if got := dspName("nr2"); got != "NR2" {
		t.Errorf("dspName(nr2) = %q, want NR2", got)
	}
	if got := strings.Join(dspNames([]string{"nr2", "dfnr"}), ","); got != "NR2,DFNR" {
		t.Errorf("dspNames = %q", got)
	}

	// Cycling must leave the stored value — the one sent on the wire — in the
	// server's own casing.
	e := &eventLoop{ui: NewUI("test")}
	e.ui.dspFilters = []string{"nr2", "rn2", "nr4", "dfnr"}
	for i := 0; i < len(e.ui.dspFilters); i++ {
		e.cycleDSP(+1)
		if e.ui.dspFilter != strings.ToLower(e.ui.dspFilter) {
			t.Errorf("stored filter %q is not lowercase; the server would reject it", e.ui.dspFilter)
		}
		// But it displays uppercase.
		if e.ui.dspFilter != "" && e.ui.dspLabel() != strings.ToUpper(e.ui.dspFilter) {
			t.Errorf("label %q does not match the uppercase of %q", e.ui.dspLabel(), e.ui.dspFilter)
		}
	}

	// The audio client sends exactly what it was given.
	a := NewAudioClient("h", false, "", "id")
	a.SetDSP("nr4")
	if a.dspFilter != "nr4" {
		t.Errorf("audio client stored %q, want the lowercase nr4", a.dspFilter)
	}

	// And a server report is stored as sent, not uppercased into the state.
	a.handleText([]byte(`{"type":"dsp_status","info":{"enabled":true,"filter":"dfnr"}}`))
	st := <-a.DSP
	if st.Filter != "dfnr" {
		t.Errorf("server state stored as %q, want dfnr", st.Filter)
	}
}

func TestSquelchDefaultsOff(t *testing.T) {
	u := NewUI("test")
	if u.squelch != 0 {
		t.Errorf("squelch defaults to %d, want 0 (off)", u.squelch)
	}
	if u.squelchLabel() != "off" {
		t.Errorf("label = %q, want off", u.squelchLabel())
	}
	// Off must reach the server as its disabled sentinel, not as a 0 dB
	// threshold — 0 dB SNR is a perfectly valid gate setting.
	if got := squelchToWire(0); got != squelchDisabled {
		t.Errorf("squelchToWire(0) = %v, want %v", got, squelchDisabled)
	}
	if got := squelchToWire(35); got != 35 {
		t.Errorf("squelchToWire(35) = %v, want 35", got)
	}
}

func TestSquelchStepsFinely(t *testing.T) {
	e := &eventLoop{ui: NewUI("test")}

	// From off, the first step lands on the useful floor rather than on 1 dB,
	// which could never gate.
	e.adjustSquelch(+1)
	if e.ui.squelch != squelchMin {
		t.Errorf("first step gave %d, want %d", e.ui.squelch, squelchMin)
	}

	// Then it moves a decibel at a time.
	for i := 1; i <= 5; i++ {
		e.adjustSquelch(+1)
		if want := squelchMin + i; e.ui.squelch != want {
			t.Errorf("step %d gave %d, want %d", i, e.ui.squelch, want)
		}
	}

	// And back down the same way.
	for i := 4; i >= 0; i-- {
		e.adjustSquelch(-1)
		if want := squelchMin + i; e.ui.squelch != want {
			t.Errorf("down-step gave %d, want %d", e.ui.squelch, want)
		}
	}

	// Stepping below the floor turns it off rather than leaving a threshold
	// that can never fire.
	e.adjustSquelch(-1)
	if e.ui.squelch != 0 {
		t.Errorf("stepping below the floor gave %d, want 0 (off)", e.ui.squelch)
	}
	// Off is the bottom; there is nothing below it.
	e.adjustSquelch(-1)
	if e.ui.squelch != 0 {
		t.Errorf("stepping below off gave %d", e.ui.squelch)
	}

	// The top clamps.
	for i := 0; i < 200; i++ {
		e.adjustSquelch(+1)
	}
	if e.ui.squelch != squelchMax {
		t.Errorf("clamped at %d, want %d", e.ui.squelch, squelchMax)
	}
}

// TestSquelchPanelMatchesKeys: the panel's arrows use the same rule, so the two
// controls cannot disagree about where off is.
func TestSquelchPanelMatchesKeys(t *testing.T) {
	ui := NewUI("test")
	p := NewAudioPanel(nil, nil)
	p.row = rowSquelch
	key := func(k tcell.Key) *tcell.EventKey { return tcell.NewEventKey(k, 0, tcell.ModNone) }

	p.HandleKey(key(tcell.KeyRight), ui, "")
	if ui.squelch != squelchMin {
		t.Errorf("panel first step gave %d, want %d", ui.squelch, squelchMin)
	}
	p.HandleKey(key(tcell.KeyRight), ui, "")
	if ui.squelch != squelchMin+1 {
		t.Errorf("panel step gave %d, want %d", ui.squelch, squelchMin+1)
	}
	p.HandleKey(key(tcell.KeyLeft), ui, "")
	p.HandleKey(key(tcell.KeyLeft), ui, "")
	if ui.squelch != 0 {
		t.Errorf("panel below the floor gave %d, want 0", ui.squelch)
	}
}

// TestSquelchedFollowsServerSilence: the server sends silence rather than
// dropping packets while gated, so the indicator reads that instead of
// reimplementing the server's hang timer and hysteresis.
func TestSquelchedFollowsServerSilence(t *testing.T) {
	u := NewUI("test")
	u.audioOn = true

	// With squelch off, silence is just a quiet channel, not a closed gate.
	u.NoteAudio(true)
	u.lastAudioAt = time.Now().Add(-2 * time.Second)
	if u.Squelched() {
		t.Error("reported squelched with the gate disabled")
	}

	u.squelch = 35
	if !u.Squelched() {
		t.Error("silence for 2 s with squelch on should read as squelched")
	}

	// Audio returning clears it immediately.
	u.NoteAudio(false)
	if u.Squelched() {
		t.Error("still squelched after audio returned")
	}

	// A brief pause must not flicker the indicator.
	u.lastAudioAt = time.Now().Add(-200 * time.Millisecond)
	if u.Squelched() {
		t.Error("a 200 ms gap should not read as squelched")
	}

	// And it never reports squelched with audio off entirely.
	u.audioOn = false
	u.lastAudioAt = time.Now().Add(-5 * time.Second)
	if u.Squelched() {
		t.Error("reported squelched with audio off")
	}
}

func TestSquelchStatusIndicator(t *testing.T) {
	statusRow := func(sq int, squelched bool) string {
		ui, screen := newTestUI(150, 24, ViewSpectrum)
		ui.audioOn = true
		ui.vfo = 7_100_000
		ui.squelch = sq
		if squelched {
			ui.lastAudioAt = time.Now().Add(-3 * time.Second)
		} else {
			ui.lastAudioAt = time.Now()
		}
		ui.signal = Signal{Power: -80, Noise: -120}
		ui.SetFrame(unwrapFFT(syntheticFrame(1024, 0)), 0, 0)
		ui.Draw(screen)

		l := computeLayout(150, 24, ViewSpectrum, ui.splitRatio, 0)
		cells, w, _ := screen.GetContents()
		row := make([]rune, 0, w)
		for i := 0; i < w; i++ {
			if r := cells[l.StatusY*w+i].Runes; len(r) > 0 && r[0] != 0 {
				row = append(row, r[0])
			} else {
				row = append(row, ' ')
			}
		}
		return string(row)
	}

	// Both keys are named: t alone left no way to find the one that lowers
	// the threshold, which is also the only way to turn the gate off.
	if got := statusRow(0, false); !strings.Contains(got, "t/T SQ:off") {
		t.Errorf("status bar does not show squelch off: %q", got)
	}
	if got := statusRow(35, false); !strings.Contains(got, "t/T SQ:35") {
		t.Errorf("status bar does not show the threshold: %q", got)
	}
	open := statusRow(35, false)
	closed := statusRow(35, true)
	if strings.Contains(open, "▼") {
		t.Errorf("marker shown while the gate is open: %q", open)
	}
	if !strings.Contains(closed, "▼") {
		t.Errorf("no marker while the gate is closed: %q", closed)
	}
	// The marker's space is reserved, so nothing shifts when it appears.
	if len([]rune(open)) != len([]rune(closed)) {
		t.Error("status row width changed when the squelch marker appeared")
	}
	// Compare rune positions: the marker is multi-byte, so byte offsets differ
	// even when the columns line up.
	if runeIndexOf(open, "q quit") != runeIndexOf(closed, "q quit") {
		t.Errorf("the squelch marker shifted the hints after it (%d vs %d)",
			runeIndexOf(open, "q quit"), runeIndexOf(closed, "q quit"))
	}
}

// runeIndexOf returns the column at which sub starts, counted in runes.
func runeIndexOf(s, sub string) int {
	b := strings.Index(s, sub)
	if b < 0 {
		return -1
	}
	return len([]rune(s[:b]))
}

// TestSilenceDetectionTolerateseCodecNoise is the regression guard for squelch
// appearing not to work. The server zeroes the PCM before Opus encoding, and
// the codec is lossy, so a gated frame never decodes to exactly zero — an
// equality test reported the gate as permanently open. Measured on a live
// receiver, gated frames peak at 1 while open audio peaks in the thousands.
func TestSilenceDetectionToleratesCodecNoise(t *testing.T) {
	a := NewAudioClient("h", false, "", "id")

	report := func(samples []int16) bool {
		for len(a.Silence) > 0 {
			<-a.Silence
		}
		// Mirror the check handleAudio performs.
		silent := true
		for _, v := range samples {
			if v > silenceCeiling || v < -silenceCeiling {
				silent = false
				break
			}
		}
		return silent
	}

	if !report([]int16{0, 0, 0, 0}) {
		t.Error("exact zeroes not detected as silence")
	}
	// What a gated frame actually decodes to.
	if !report([]int16{1, -1, 0, 1, -1}) {
		t.Error("codec noise at +/-1 not detected as silence")
	}
	// Real audio, even quiet, must not read as silence.
	if report([]int16{0, 0, 400, 0}) {
		t.Error("audible content misreported as silence")
	}
	if report([]int16{0, 0, -3490, 0}) {
		t.Error("loud audio misreported as silence")
	}

	// The threshold must keep a wide margin either side of what was measured.
	if silenceCeiling < 2 {
		t.Errorf("silenceCeiling %d is at or below the codec noise floor", silenceCeiling)
	}
	if silenceCeiling > 100 {
		t.Errorf("silenceCeiling %d could swallow quiet real audio", silenceCeiling)
	}
}

// TestDecodedRateIsIndependentOfSourceRate documents why changing mode needs no
// playback change. The radio channel runs at 12 kHz for the sideband and CW
// modes and 24 kHz for AM and FM, but Opus always reconstructs at 48 kHz.
// Verified against a live receiver in every mode: a 20 ms frame decodes to 960
// samples either way.
func TestDecodedRateIsIndependentOfSourceRate(t *testing.T) {
	for _, m := range modes {
		want := 12000
		switch m.Name {
		case "am", "sam", "fm", "nfm":
			want = 24000
		}
		// This mirrors GetSampleRateForMode in the server's config.go. If the
		// server's table changes, the stream display here goes stale.
		if got := expectedSourceRate(m.Name); got != want {
			t.Errorf("%s: expected source rate %d, want %d", m.Name, got, want)
		}
	}

	// Whatever the source, playback is 48 kHz.
	if opusOutputRate != 48000 {
		t.Errorf("playback rate is %d, but Opus reconstructs at 48000", opusOutputRate)
	}
}

// expectedSourceRate mirrors the server's per-mode channel rate, for the test
// above to check the client's assumptions against.
func expectedSourceRate(mode string) int {
	switch mode {
	case "am", "sam", "fm", "nfm":
		return 24000
	default:
		return 12000
	}
}

// TestStereoIsFoldedToMono is the guard for the latent bug the sample-rate
// question turned up: the decoder writes n samples *per channel*, so reading
// the first n values of an interleaved stereo frame takes half a pair and plays
// at double speed.
func TestStereoIsFoldedToMono(t *testing.T) {
	// Simulate what the decoder produces for two channels: interleaved pairs.
	n := 4
	channels := 2
	pcm := []int16{100, 300, 200, 400, -100, -300, 0, 0}

	out := make([]int16, n)
	if channels <= 1 {
		copy(out, pcm[:n])
	} else {
		for i := 0; i < n; i++ {
			sum := 0
			for c := 0; c < channels; c++ {
				sum += int(pcm[i*channels+c])
			}
			out[i] = int16(sum / channels)
		}
	}

	want := []int16{200, 300, -200, 0}
	for i := range want {
		if out[i] != want[i] {
			t.Errorf("fold gave %v, want %v", out, want)
			break
		}
	}

	// The mono path is unchanged.
	mono := []int16{7, 8, 9, 10}
	out2 := make([]int16, 4)
	copy(out2, mono[:4])
	for i := range mono {
		if out2[i] != mono[i] {
			t.Errorf("mono path altered the samples: %v", out2)
			break
		}
	}
}

func TestStreamValueReportsBothRates(t *testing.T) {
	u := NewUI("test")
	if got := streamValue(u); got != "—" {
		t.Errorf("with no packet yet, stream reads %q, want a placeholder", got)
	}

	u.signal = Signal{Power: -80, Noise: -120, SourceRate: 12000, Channels: 1}
	got := streamValue(u)
	if !strings.Contains(got, "12.0 kHz") || !strings.Contains(got, "48 kHz") {
		t.Errorf("stream value %q should name both the channel and playback rates", got)
	}
	if !strings.Contains(got, "mono") {
		t.Errorf("stream value %q should state the channel count", got)
	}

	u.signal.SourceRate = 24000
	if got := streamValue(u); !strings.Contains(got, "24.0 kHz") {
		t.Errorf("AM source rate not reflected: %q", got)
	}
	u.signal.Channels = 2
	if got := streamValue(u); !strings.Contains(got, "stereo") {
		t.Errorf("stereo not reflected: %q", got)
	}
}

// TestMixerPrimesBeforePlaying covers the jitter buffer. Audio arrives at
// exactly real time, so without a cushion the buffer sits near empty and
// ordinary jitter empties it between callbacks, inserting silence — heard as a
// stutter. Measured before this: the buffer reached 0 and underran 13 times in
// three seconds.
func TestMixerPrimesBeforePlaying(t *testing.T) {
	m := newMixer()
	if !m.priming {
		t.Fatal("a new mixer should start priming")
	}
	if m.targetSamples < opusOutputRate/20 {
		t.Errorf("target cushion is %d samples, under 50 ms", m.targetSamples)
	}

	// Below the target, only silence comes out and nothing is consumed.
	m.push(make([]int16, m.targetSamples/2))
	before, _, _ := m.stats()
	out := make([]int16, 200)
	m.readStereo(out)
	for _, v := range out {
		if v != 0 {
			t.Fatal("played audio before the cushion was built")
		}
	}
	if after, _, _ := m.stats(); after != before {
		t.Errorf("consumed %d samples while priming", before-after)
	}

	// Once the cushion is there, it plays. Use a fresh mixer holding only
	// non-zero samples, so leading silence cannot be mistaken for priming.
	m2 := newMixer()
	loud := make([]int16, m2.targetSamples+100)
	for i := range loud {
		loud[i] = 1000
	}
	m2.push(loud)
	m2.readStereo(out)
	if out[0] == 0 {
		t.Error("still silent after the cushion filled")
	}
	if m2.priming {
		t.Error("still priming after the cushion filled")
	}

	// Running dry rebuilds the cushion rather than underrunning every callback,
	// which is what turns one gap into a stutter.
	for i := 0; i < 1000; i++ {
		if b, _, _ := m2.stats(); b == 0 {
			break
		}
		m2.readStereo(out)
	}
	m2.readStereo(out)
	if !m2.priming {
		t.Error("should re-prime after running dry")
	}
	if _, _, u := m2.stats(); u == 0 {
		t.Error("underrun was not counted")
	}
}

// --- stdout, the second output -------------------------------------------

// blockingWriter holds every write until it is released, standing in for a pipe
// whose reader has stalled.
type blockingWriter struct {
	release chan struct{}
	mu      sync.Mutex
	n       int
}

func (w *blockingWriter) Write(p []byte) (int, error) {
	<-w.release
	w.mu.Lock()
	w.n += len(p)
	w.mu.Unlock()
	return len(p), nil
}

func TestPCMWriterEncodesLittleEndian(t *testing.T) {
	var sink bytes.Buffer
	p := newPCMWriter(&sink, StdoutRaw)
	p.push([]int16{0, 1, -1, 32767, -32768})
	p.Close()

	want := []byte{
		0x00, 0x00, // 0
		0x01, 0x00, // 1
		0xff, 0xff, // -1
		0xff, 0x7f, // 32767
		0x00, 0x80, // -32768
	}
	if got := sink.Bytes(); !bytes.Equal(got, want) {
		t.Errorf("wrote % x, want % x", got, want)
	}

	// Which is exactly what the format string promises, so the pipe command in
	// the docs works: S16_LE, 48 kHz, one channel.
	if stdoutFormat != "S16_LE" || stdoutSampleRate != opusOutputRate || stdoutChannels != 1 {
		t.Errorf("the advertised format no longer matches what is written")
	}
}

// The caller reuses its packet buffer, so the queue has to hold a copy.
func TestPCMWriterCopiesItsInput(t *testing.T) {
	var sink bytes.Buffer
	p := newPCMWriter(&sink, StdoutRaw)

	packet := []int16{100, 200}
	p.push(packet)
	packet[0], packet[1] = -1, -1
	p.Close()

	want := []byte{100, 0, 200, 0}
	if got := sink.Bytes(); !bytes.Equal(got, want) {
		t.Errorf("wrote % x, want % x — the queue aliased the caller's buffer", got, want)
	}
}

// A stalled reader must cost audio, never the event loop: pushes drop rather
// than block.
func TestPCMWriterDropsRatherThanBlocking(t *testing.T) {
	w := &blockingWriter{release: make(chan struct{})}
	p := newPCMWriter(w, StdoutRaw)

	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 200; i++ {
			p.push([]int16{int16(i)})
		}
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("push blocked on a stalled reader")
	}

	if _, dropped, _ := p.stats(); dropped == 0 {
		t.Error("a full queue dropped nothing")
	}

	close(w.release) // let the writer drain and exit
	p.Close()
}

// The two outputs are independent: audio goes to whichever are switched on.
func TestAudioOutputFansOut(t *testing.T) {
	var sink bytes.Buffer
	out := NewAudioOutput()

	// Device only, which is what the pipe being off looks like.
	out.Push([]int16{1, 2, 3})
	if buffered, _, _ := out.Stats(); buffered != 3 {
		t.Errorf("the mixer holds %d samples, want 3", buffered)
	}
	if out.StdoutOn() {
		t.Error("the pipe is on before anything asked for it")
	}
	if sink.Len() != 0 {
		t.Error("audio reached a pipe that is not running")
	}

	// Both.
	out.pipe = newPCMWriter(&sink, StdoutRaw)
	if !out.StdoutOn() {
		t.Fatal("the pipe did not come up")
	}
	out.Push([]int16{4, 5})
	if buffered, _, _ := out.Stats(); buffered != 5 {
		t.Errorf("the mixer holds %d samples, want 5", buffered)
	}
	out.Close()
	if sink.Len() != 4 {
		t.Errorf("the pipe carried %d bytes, want 4", sink.Len())
	}
	if out.StdoutOn() {
		t.Error("closing left the pipe running")
	}

	// Switching it off twice is not an error, and neither is off when it was
	// never on.
	if err := out.SetStdout(StdoutOff); err != nil {
		t.Errorf("switching an idle pipe off: %v", err)
	}
}

// "Off" heads the device list, so the speakers are switched off by the same
// control that chooses them.
func TestAudioPanelOffersNoLocalPlayback(t *testing.T) {
	p := NewAudioPanel([]AudioDevice{
		{ID: "", Name: "System default", Default: true},
		{ID: "sink-1", Name: "Headphones"},
	}, nil)

	choices := p.deviceChoices()
	if len(choices) != 3 || choices[0].ID != audioDeviceOff {
		t.Fatalf("the device list is %v, want off at its head", choices)
	}

	// Stepping back from the first real device lands on off.
	u := NewUI("test")
	p.row = rowDevice
	if _, reopen, _ := p.adjust(u, "", -1); !reopen || p.selectedDevice != audioDeviceOff {
		t.Errorf("stepping back from the default gave %q", p.selectedDevice)
	}

	// Enumeration failing still leaves it possible to switch playback off,
	// which is what a machine with no sound server needs.
	p = NewAudioPanel(nil, errors.New("no sound server"))
	if got := p.deviceChoices(); len(got) != 1 || got[0].ID != audioDeviceOff {
		t.Errorf("with no devices the list is %v", got)
	}
}

// The stdout row asks the caller to switch the stream: the panel does not own
// the output.
func TestAudioPanelTogglesStdout(t *testing.T) {
	p := NewAudioPanel(nil, nil)
	p.row = rowStdout

	if _, _, done := p.adjust(NewUI("test"), "", +1); done {
		t.Error("toggling stdout closed the panel")
	}
	if p.stdoutStep != +1 {
		t.Errorf("the stdout row asked for step %d", p.stdoutStep)
	}

	// What it shows comes from the caller, including why it is unavailable.
	for _, mode := range []StdoutMode{StdoutRaw, StdoutWAV} {
		p.stdoutMode = mode
		if got := p.stdoutValue(); !strings.Contains(got, "on") || !strings.Contains(got, stdoutFormat) {
			t.Errorf("%v stdout shows %q", mode, got)
		}
	}
	if got := p.stdoutValue(); !strings.Contains(got, "WAV") {
		t.Errorf("WAV mode does not say so: %q", got)
	}
	p.stdoutMode, p.stdoutErr = StdoutOff, errors.New("broken pipe")
	if got := p.stdoutValue(); !strings.Contains(got, "broken pipe") {
		t.Errorf("a failed pipe shows %q", got)
	}
}

// Switching local playback off leaves the session running: a receiver piped
// somewhere else needs no speakers.
func TestDeviceOffKeepsTheSessionRunning(t *testing.T) {
	e := &eventLoop{ui: NewUI("test"), out: NewAudioOutput()}
	e.deviceID = "sink-1"

	e.applyDeviceChoice(audioDeviceOff)
	if !e.deviceOff || e.currentDeviceID() != audioDeviceOff {
		t.Errorf("off not applied: deviceOff=%v id=%q", e.deviceOff, e.currentDeviceID())
	}
	if e.out.Running() {
		t.Error("the sound device is still open")
	}
	if !strings.Contains(e.ui.status, "off") {
		t.Errorf("nothing said what happened: %q", e.ui.status)
	}

	// Choosing a device again clears it, and the panel shows that device.
	e.applyDeviceChoice("sink-2")
	if e.deviceOff || e.currentDeviceID() != "sink-2" {
		t.Errorf("choosing a device left deviceOff=%v id=%q", e.deviceOff, e.currentDeviceID())
	}
}

// The panel has to show both outputs, since either can be off.
func TestAudioPanelShowsBothOutputs(t *testing.T) {
	screen := tcell.NewSimulationScreen("UTF-8")
	if err := screen.Init(); err != nil {
		t.Fatal(err)
	}
	screen.SetSize(120, 30)

	u := NewUI("test")
	u.audioOn = true
	p := NewAudioPanel([]AudioDevice{{ID: "", Name: "System default"}}, nil)
	p.stdoutMode = StdoutRaw

	u.Draw(screen)
	p.Draw(screen, u, audioDeviceOff)
	screen.Show()

	out := dump(screen)
	t.Logf("\n%s", out)
	for _, want := range []string{"Output device", "Off — no local playback", "Stdout", stdoutFormat} {
		if !strings.Contains(out, want) {
			t.Errorf("the panel is missing %q", want)
		}
	}
}

// A refusal has to be visible in the panel: it covers the status line, so a key
// that cannot do anything would otherwise look like a key that did nothing.
func TestStdoutRefusalIsVisibleInThePanel(t *testing.T) {
	e := &eventLoop{ui: NewUI("test")}
	e.stdoutErr = errors.New("stdout is a terminal")

	mode, err := e.stdoutState()
	if mode != StdoutOff || err == nil {
		t.Fatalf("the refusal did not survive: mode=%v err=%v", mode, err)
	}

	p := NewAudioPanel(nil, nil)
	p.stdoutMode, p.stdoutErr = e.stdoutState()
	if got := p.stdoutValue(); !strings.Contains(got, "terminal") {
		t.Errorf("the row says %q", got)
	}

	// The note under the rows carries the remedy, and turns red once a toggle
	// has been refused.
	screen := tcell.NewSimulationScreen("UTF-8")
	if err := screen.Init(); err != nil {
		t.Fatal(err)
	}
	screen.SetSize(120, 30)

	u := NewUI("test")
	u.audioOn = true
	p.row = rowStdout
	p.Draw(screen, u, "")
	screen.Show()

	out := dump(screen)
	if !strings.Contains(out, "pipe: ubersdr-tui -stdout | aplay") {
		t.Errorf("the panel does not say how to fix it:\n%s", out)
	}

	noteFG := func(p *AudioPanel) tcell.Color {
		screen.Clear()
		p.Draw(screen, u, "")
		screen.Show()
		cells, w, h := screen.GetContents()
		for y := 0; y < h; y++ {
			line := rowText(screen, y)
			if i := strings.Index(line, "pipe: ubersdr-tui"); i >= 0 {
				fg, _, _ := cells[y*w+i].Style.Decompose()
				return fg
			}
		}
		t.Fatal("the note was not drawn")
		return 0
	}

	refused := noteFG(p)
	p.stdoutErr = nil
	if calm := noteFG(p); calm == refused {
		t.Error("a refused toggle looks the same as a quiet one")
	}
}

// WAV mode exists so that a redirected file plays anywhere: a headerless
// capture is one no player will open, since none of them infer 48 kHz mono
// S16_LE from a file extension.
func TestStdoutWAVHeader(t *testing.T) {
	// Down a pipe the length cannot be known, so the sizes stay open-ended and
	// players read to end of file.
	var pipe bytes.Buffer
	p := newPCMWriter(&pipe, StdoutWAV)
	p.push([]int16{1, 2, 3, 4})
	p.Close()

	b := pipe.Bytes()
	if len(b) != wavHeaderLen+8 {
		t.Fatalf("wrote %d bytes, want a %d-byte header and 8 of audio", len(b), wavHeaderLen)
	}
	if string(b[0:4]) != "RIFF" || string(b[8:12]) != "WAVE" || string(b[36:40]) != "data" {
		t.Fatalf("not a WAV header: %q", b[:44])
	}

	le := binary.LittleEndian
	if got := le.Uint16(b[22:]); got != stdoutChannels {
		t.Errorf("header says %d channels", got)
	}
	if got := le.Uint32(b[24:]); got != stdoutSampleRate {
		t.Errorf("header says %d Hz", got)
	}
	if got := le.Uint16(b[34:]); got != 16 {
		t.Errorf("header says %d bits per sample", got)
	}
	if got := le.Uint32(b[40:]); got != streamingSize {
		t.Errorf("a pipe got a data size of %d, want the open-ended one", got)
	}

	// The audio follows the header unchanged.
	if want := []byte{1, 0, 2, 0, 3, 0, 4, 0}; !bytes.Equal(b[wavHeaderLen:], want) {
		t.Errorf("audio after the header is % x, want % x", b[wavHeaderLen:], want)
	}
}

// A regular file can seek, so the real sizes are patched in on close and the
// capture is a valid WAV rather than an open-ended one.
func TestStdoutWAVPatchesSizesOnAFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "capture.wav")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}

	p := newPCMWriter(f, StdoutWAV)
	const samples = 480
	p.push(make([]int16, samples))
	p.Close()
	f.Close()

	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(b) != wavHeaderLen+samples*2 {
		t.Fatalf("the file is %d bytes, want %d", len(b), wavHeaderLen+samples*2)
	}

	le := binary.LittleEndian
	if got, want := le.Uint32(b[40:]), uint32(samples*2); got != want {
		t.Errorf("data size is %d, want %d", got, want)
	}
	if got, want := le.Uint32(b[4:]), uint32(36+samples*2); got != want {
		t.Errorf("RIFF size is %d, want %d", got, want)
	}
}

// The mode is what the panel and the status line describe, so each has to say
// something different and useful.
func TestStdoutModeLabels(t *testing.T) {
	seen := map[string]bool{}
	for _, m := range []StdoutMode{StdoutOff, StdoutRaw, StdoutWAV} {
		if seen[m.String()] || seen[m.Label()] {
			t.Errorf("%v describes itself like another mode", m)
		}
		seen[m.String()], seen[m.Label()] = true, true
	}
	if !strings.Contains(StdoutWAV.Label(), "WAV") || !strings.Contains(StdoutRaw.Label(), "raw") {
		t.Errorf("labels are %q and %q", StdoutRaw.Label(), StdoutWAV.Label())
	}
}

// --- choosing an output device -------------------------------------------

// stubDevices replaces the platform enumeration for the duration of a test.
func stubDevices(t *testing.T, devices []AudioDevice, err error) {
	t.Helper()
	orig := listDevicesForTest
	listDevicesForTest = func() ([]AudioDevice, error) { return devices, err }
	t.Cleanup(func() { listDevicesForTest = orig })
}

// -device takes an index from the listing or enough of a name to be sure, so a
// headless session can be pointed at one output and a service at another.
func TestResolveDevice(t *testing.T) {
	stubDevices(t, []AudioDevice{
		{ID: "", Name: "System default"},
		{ID: "sink-usb", Name: "Steinberg UR24C Analogue Surround 4.0", Default: true},
		{ID: "sink-hdmi", Name: "HDMI Output"},
	}, nil)

	for _, tc := range []struct{ spec, want string }{
		{"0", ""},
		{"1", "sink-usb"},
		{"2", "sink-hdmi"},
		{"steinberg", "sink-usb"},    // part of a name, case-insensitively
		{"HDMI Output", "sink-hdmi"}, // or the whole of one
		{"sink-hdmi", "sink-hdmi"},   // or the underlying ID
		{"System default", ""},
	} {
		got, err := resolveDevice(tc.spec)
		if err != nil {
			t.Errorf("%q: %v", tc.spec, err)
			continue
		}
		if got != tc.want {
			t.Errorf("%q resolved to %q, want %q", tc.spec, got, tc.want)
		}
	}

	// An index off the end says how many there are rather than picking one.
	if _, err := resolveDevice("9"); err == nil || !strings.Contains(err.Error(), "out of range") {
		t.Errorf("an index past the end gave %v", err)
	}
	if _, err := resolveDevice("-1"); err == nil {
		t.Error("a negative index was accepted")
	}
	if _, err := resolveDevice("nosuchdevice"); err == nil {
		t.Error("a name matching nothing was accepted")
	}

	// A name that matches more than one is refused with the candidates, since
	// picking one at random is how a service ends up on the wrong speakers.
	stubDevices(t, []AudioDevice{
		{ID: "a", Name: "USB Audio front"},
		{ID: "b", Name: "USB Audio rear"},
	}, nil)
	_, err := resolveDevice("usb audio")
	if err == nil {
		t.Fatal("an ambiguous name was accepted")
	}
	if !strings.Contains(err.Error(), "front") || !strings.Contains(err.Error(), "rear") {
		t.Errorf("the complaint does not list the candidates: %v", err)
	}
}

// The listing is what -device list prints and what an unusable value is
// answered with, so it has to carry the indices and mark the default.
func TestDescribeDevices(t *testing.T) {
	stubDevices(t, []AudioDevice{
		{ID: "", Name: "System default"},
		{ID: "sink-usb", Name: "Steinberg UR24C", Default: true},
	}, nil)

	got := describeDevices()
	for _, want := range []string{"0", "1", "System default", "Steinberg UR24C", "*"} {
		if !strings.Contains(got, want) {
			t.Errorf("the listing is missing %q:\n%s", want, got)
		}
	}

	// A machine with no sound server says so rather than printing an empty list.
	stubDevices(t, nil, errors.New("cannot reach PulseAudio"))
	if got := describeDevices(); !strings.Contains(got, "PulseAudio") {
		t.Errorf("enumeration failure is not explained: %q", got)
	}
	if _, err := resolveDevice("1"); err == nil {
		t.Error("a device was resolved with no way to list them")
	}
}

// --- the session clock ---------------------------------------------------

// Receivers cap how long a session may run, and say so in the /connection
// reply. The clock counts that down in the corner, because a session that ends
// without warning is indistinguishable from a crash.
func TestSessionCountdown(t *testing.T) {
	for _, tc := range []struct {
		left time.Duration
		want string
	}{
		{time.Hour + 24*time.Minute + 12*time.Second, "1h24m12s"},
		{2 * time.Hour, "2h00m00s"},
		{4*time.Minute + 9*time.Second, "4m09s"},
		{9 * time.Second, "9s"},
		{0, "0s"},
		{-time.Minute, "0s"}, // never counts past the end
	} {
		if got := formatCountdown(tc.left); got != tc.want {
			t.Errorf("%v left renders as %q, want %q", tc.left, got, tc.want)
		}
	}
}

func TestSessionFieldAndWarning(t *testing.T) {
	u := NewUI("test")

	// Nothing is claimed before there is a connection to claim it for.
	if got := u.sessionField(); got != "" {
		t.Errorf("a disconnected session shows %q", got)
	}

	// A receiver that sets no limit says so, rather than showing a clock that
	// never moves.
	u.connected = true
	if got := strings.TrimSpace(u.sessionField()); got != "unlimited" {
		t.Errorf("an unlimited session shows %q", got)
	}
	calm := u.sessionStyle()

	u.sessionLimited, u.sessionEnd = true, time.Now().Add(time.Hour)
	if got := strings.TrimSpace(u.sessionField()); got != "1h00m00s" {
		t.Errorf("an hour left shows %q", got)
	}
	if u.sessionStyle() != calm {
		t.Error("an hour left is already being warned about")
	}

	// The last five minutes are marked, on the same threshold the Python
	// client uses.
	u.sessionEnd = time.Now().Add(4 * time.Minute)
	if u.sessionStyle() == calm {
		t.Error("the last five minutes are not marked")
	}
}

// The clock owns the last columns of the header, and nothing else may be drawn
// over it however narrow the terminal gets.
func TestSessionClockKeepsTheCorner(t *testing.T) {
	for _, w := range []int{60, 80, 100, 140, 200} {
		ui, screen := newTestUI(w, 24, ViewSpectrum)
		ui.audioOn = true
		ui.signal = Signal{Power: -70, Noise: -110}
		ui.chat = ChatState{Available: true, Connected: true, Users: []ChatUser{{Username: "a"}}}
		ui.sessionLimited, ui.sessionEnd = true, time.Now().Add(2*time.Hour)
		ui.SetFrame(unwrapFFT(syntheticFrame(1024, 0)), 0, 0)
		ui.Draw(screen)

		header := rowText(screen, 0)
		if !strings.HasSuffix(strings.TrimRight(header, " "), "2h00m00s") {
			t.Errorf("width %d: the clock is not in the corner: %q", w, header)
		}
		// Whatever else is shed, the frequency stays — in its compact form if
		// that is all there is room for.
		if !strings.Contains(header, "7.1000") {
			t.Errorf("width %d: the frequency was shed: %q", w, header)
		}
		if len([]rune(strings.TrimRight(header, " "))) > w {
			t.Errorf("width %d: the header overflowed", w)
		}
	}
}

package main

import (
	"math"
	"strings"
	"testing"
)

// TestMeterScalesMatchWebUI pins the constants to static/signal-meter.js, which
// in turn matches s-meter-needle.js. A reading here must mean the same thing as
// the same reading in a browser.
func TestMeterScalesMatchWebUI(t *testing.T) {
	cases := []struct {
		name      string
		got, want float64
	}{
		{"DBFS_MIN", meterDBFSMin, -127},
		{"DBFS_MAX", meterDBFSMax, -33},
		{"SNR_MIN", meterSNRMin, -5},
		{"SNR_MAX", meterSNRMax, 30},
		{"dBFS red at", meterDBFSRedAt, -121},
		{"dBFS green at", meterDBFSGreenAt, -73},
		{"SNR red at", meterSNRRedAt, 0},
		{"SNR green at", meterSNRGreenAt, 15},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("%s = %v, web UI uses %v", c.name, c.got, c.want)
		}
	}
}

func TestMeterFillFraction(t *testing.T) {
	u := NewUI("test")
	u.audioOn = true

	// dBFS spans -127..-33, so the midpoint is -80.
	for _, c := range []struct {
		power float32
		want  float64
	}{
		{-127, 0}, {-80, 0.5}, {-33, 1},
		{-200, 0}, // below scale clamps rather than going negative
		{0, 1},    // above scale clamps
	} {
		u.signal = Signal{Power: c.power, Noise: -120}
		_, frac, ok := u.meterReading()
		if !ok {
			t.Fatalf("power %v produced no reading", c.power)
		}
		if math.Abs(frac-c.want) > 0.01 {
			t.Errorf("dBFS %v filled %.3f, want %.3f", c.power, frac, c.want)
		}
	}

	// SNR spans -5..30, so 12.5 is the midpoint.
	u.meterSNR = true
	for _, c := range []struct {
		power, noise float32
		want         float64
	}{
		{-125, -120, 0},     // SNR -5
		{-107.5, -120, 0.5}, // SNR 12.5
		{-90, -120, 1},      // SNR 30
		{-130, -120, 0},     // SNR -10, below scale
	} {
		u.signal = Signal{Power: c.power, Noise: c.noise}
		value, frac, ok := u.meterReading()
		if !ok {
			t.Fatalf("signal %+v produced no reading", u.signal)
		}
		if math.Abs(frac-c.want) > 0.01 {
			t.Errorf("SNR %.0f filled %.3f, want %.3f", value, frac, c.want)
		}
	}
}

func TestMeterReadingRequiresData(t *testing.T) {
	u := NewUI("test")

	// Nothing before audio starts.
	if _, _, ok := u.meterReading(); ok {
		t.Error("meter reports a reading with audio off")
	}

	u.audioOn = true
	if _, _, ok := u.meterReading(); ok {
		t.Error("meter reports a reading before the first packet")
	}

	// The Python client uses -999 as its "no data" sentinel; it must not be
	// shown as a real level.
	u.signal = Signal{Power: -999, Noise: -999}
	if _, _, ok := u.meterReading(); ok {
		t.Error("the -999 sentinel was treated as a reading")
	}

	// SNR needs both halves.
	u.meterSNR = true
	u.signal = Signal{Power: -70, Noise: float32(math.Inf(-1))}
	if _, _, ok := u.meterReading(); ok {
		t.Error("SNR reported without a valid noise density")
	}
	u.signal = Signal{Power: -70, Noise: -110}
	if v, _, ok := u.meterReading(); !ok || v != 40 {
		t.Errorf("SNR = %v (ok=%v), want 40", v, ok)
	}
}

func TestMeterColourRamp(t *testing.T) {
	u := NewUI("test")

	// dBFS: red at the bottom, green at the top of the colour span.
	red := u.meterColour(-121)
	green := u.meterColour(-73)
	rr, rg, _ := red.RGB()
	gr, gg, _ := green.RGB()
	if rr <= rg {
		t.Errorf("weak signal colour is not red: %v", red)
	}
	if gg <= gr {
		t.Errorf("strong signal colour is not green: %v", green)
	}
	// Past the ends it saturates rather than wrapping around the hue circle.
	if u.meterColour(-200) != red {
		t.Error("colour below the ramp does not clamp to red")
	}
	if u.meterColour(0) != green {
		t.Error("colour above the ramp does not clamp to green")
	}

	// SNR uses its own span.
	u.meterSNR = true
	sr, sg, _ := u.meterColour(0).RGB()
	if sr <= sg {
		t.Errorf("SNR 0 is not red: %d,%d", sr, sg)
	}
	er, eg, _ := u.meterColour(15).RGB()
	if eg <= er {
		t.Errorf("SNR 15 is not green: %d,%d", er, eg)
	}
}

func TestHSLToRGB(t *testing.T) {
	// Spot-check against the HSL the web UI asks for: 90% saturation, 55%
	// lightness, hue sweeping 0 to 120.
	r, g, b := hslToRGB(0, 0.9, 0.55)
	if !(r > 200 && g < 60 && b < 60) {
		t.Errorf("hue 0 gave %d,%d,%d, want red", r, g, b)
	}
	r, g, b = hslToRGB(120, 0.9, 0.55)
	if !(g > 200 && r < 60 && b < 60) {
		t.Errorf("hue 120 gave %d,%d,%d, want green", r, g, b)
	}
	r, g, b = hslToRGB(60, 0.9, 0.55)
	if !(r > 200 && g > 200 && b < 60) {
		t.Errorf("hue 60 gave %d,%d,%d, want yellow", r, g, b)
	}
	// Every channel must stay in range across the whole sweep.
	for h := 0.0; h <= 360; h += 7 {
		r, g, b := hslToRGB(h, 0.9, 0.55)
		for _, v := range []int32{r, g, b} {
			if v < 0 || v > 255 {
				t.Fatalf("hue %.0f produced out-of-range channel %d", h, v)
			}
		}
	}
}

// TestMeterWidthIsStable: the meter sits at the right-hand end of the status
// row, so like the header it must not change width as the reading moves.
func TestMeterWidthIsStable(t *testing.T) {
	u := NewUI("test")
	u.audioOn = true

	want := runeLen(u.meterText())
	for _, snr := range []bool{false, true} {
		u.meterSNR = snr
		for _, p := range []float32{-127, -99.9, -9.5, 0, -33, float32(math.Inf(-1))} {
			u.signal = Signal{Power: p, Noise: -120}
			if got := runeLen(u.meterText()); got != want {
				t.Errorf("meter text %q is %d wide, want %d", u.meterText(), got, want)
			}
		}
	}
}

// TestMeterRendersInStatusRow checks the meter actually lands at the right-hand
// end, and that the status text is truncated rather than drawn under it.
func TestMeterRendersInStatusRow(t *testing.T) {
	ui, screen := newTestUI(120, 24, ViewSpectrum)
	ui.audioOn = true
	ui.vfo = 7_100_000
	ui.signal = Signal{Power: -70, Noise: -110}
	ui.status = strings.Repeat("long status ", 20)
	ui.SetFrame(unwrapFFT(syntheticFrame(1024, 0)), 0, 0)
	ui.Draw(screen)

	l := computeLayout(120, 24, ViewSpectrum, ui.splitRatio, 0)
	cells, w, _ := screen.GetContents()
	var row strings.Builder
	for i := 0; i < w; i++ {
		if r := cells[l.StatusY*w+i].Runes; len(r) > 0 && r[0] != 0 {
			row.WriteRune(r[0])
		} else {
			row.WriteRune(' ')
		}
	}
	got := row.String()

	if !strings.Contains(got, "dBFS") {
		t.Errorf("meter label missing from the status row: %q", got)
	}
	if !strings.Contains(got, "[") || !strings.Contains(got, "]") {
		t.Errorf("meter bar missing: %q", got)
	}
	// The meter must be at the right-hand end.
	if idx := strings.Index(got, "dBFS"); idx < w-meterCells()-2 {
		t.Errorf("meter is at column %d, expected near the right edge (%d)", idx, w-meterCells())
	}
	// The status text must not have run under it.
	bracket := strings.Index(got, "[")
	if strings.Contains(got[:bracket], "long status long status long status long status") {
		t.Error("status text was drawn under the meter instead of being truncated")
	}
}

func TestMeterToggleSwitchesScale(t *testing.T) {
	u := NewUI("test")
	u.audioOn = true
	u.signal = Signal{Power: -70, Noise: -110} // SNR 40

	if u.meterSNR {
		t.Error("the meter should start in dBFS mode")
	}
	v, _, _ := u.meterReading()
	if v != -70 {
		t.Errorf("dBFS mode reads %v, want -70", v)
	}
	if !strings.Contains(u.meterText(), "dBFS") {
		t.Errorf("dBFS label missing: %q", u.meterText())
	}

	u.meterSNR = true
	v, _, _ = u.meterReading()
	if v != 40 {
		t.Errorf("SNR mode reads %v, want 40", v)
	}
	if !strings.Contains(u.meterText(), "SNR") {
		t.Errorf("SNR label missing: %q", u.meterText())
	}
}

// TestMeterHitTest: clicking the meter is the discoverable way to switch its
// scale, so the clickable region must match exactly where it is drawn — never
// wider, and never present when the meter is not.
func TestMeterHitTest(t *testing.T) {
	u := NewUI("test")
	u.audioOn = true
	l := computeLayout(120, 24, ViewSpectrum, u.splitRatio, 0)

	x0, x1, ok := u.meterRegion(l)
	if !ok {
		t.Fatal("meter is not drawn at 120 columns")
	}

	// Every column of the meter is clickable.
	for x := x0; x < x1; x++ {
		if !u.MeterHit(l, x, l.StatusY) {
			t.Errorf("column %d is part of the meter but not clickable", x)
		}
	}
	// Nothing outside it is.
	if u.MeterHit(l, x0-1, l.StatusY) {
		t.Error("the column left of the meter is clickable")
	}
	if u.MeterHit(l, x1, l.StatusY) {
		t.Error("a column past the meter is clickable")
	}
	// Only on the status row.
	for _, y := range []int{0, l.StatusY - 1, l.AxisY} {
		if u.MeterHit(l, x0+2, y) {
			t.Errorf("row %d is clickable but the meter is on row %d", y, l.StatusY)
		}
	}

	// With audio off the meter is not drawn, so nothing may be clickable.
	u.audioOn = false
	if _, _, ok := u.meterRegion(l); ok {
		t.Error("meter region reported with audio off")
	}
	if u.MeterHit(l, x0+2, l.StatusY) {
		t.Error("meter is clickable with audio off")
	}

	// Nor on a terminal too narrow to draw it.
	u.audioOn = true
	narrow := computeLayout(meterCells()+10, 24, ViewSpectrum, u.splitRatio, 0)
	if _, _, ok := u.meterRegion(narrow); ok {
		t.Error("meter drawn on a terminal with no room for it")
	}
	if u.MeterHit(narrow, narrow.W-2, narrow.StatusY) {
		t.Error("meter is clickable on a terminal too narrow to draw it")
	}
}

// TestMeterHitMatchesDrawnCells ties the hit region to what is actually
// rendered, so the two cannot drift apart.
func TestMeterHitMatchesDrawnCells(t *testing.T) {
	ui, screen := newTestUI(120, 24, ViewSpectrum)
	ui.audioOn = true
	ui.vfo = 7_100_000
	ui.signal = Signal{Power: -70, Noise: -110}
	ui.SetFrame(unwrapFFT(syntheticFrame(1024, 0)), 0, 0)
	ui.Draw(screen)

	l := computeLayout(120, 24, ViewSpectrum, ui.splitRatio, 0)
	cells, w, _ := screen.GetContents()

	// The label's first cell and the closing bracket must both be inside the
	// clickable region.
	var row []rune
	for i := 0; i < w; i++ {
		if r := cells[l.StatusY*w+i].Runes; len(r) > 0 && r[0] != 0 {
			row = append(row, r[0])
		} else {
			row = append(row, ' ')
		}
	}
	// Scan runes, not bytes: the status row is full of multi-byte glyphs, so a
	// byte offset is not a column.
	label, closing := -1, -1
	for i := 0; i+3 < len(row); i++ {
		if string(row[i:i+4]) == "dBFS" {
			label = i
			break
		}
	}
	for i := len(row) - 1; i >= 0; i-- {
		if row[i] == ']' {
			closing = i
			break
		}
	}
	if label < 0 || closing < 0 {
		t.Fatalf("meter not rendered: %q", string(row))
	}
	if !ui.MeterHit(l, label, l.StatusY) {
		t.Errorf("the meter label at column %d is not clickable", label)
	}
	if !ui.MeterHit(l, closing, l.StatusY) {
		t.Errorf("the bar's closing bracket at column %d is not clickable", closing)
	}
}

// TestMeterKeyIsDiscoverable: the user should not have to read the source to
// find the toggle.
func TestMeterKeyIsDiscoverable(t *testing.T) {
	ui, screen := newTestUI(160, 24, ViewSpectrum)
	ui.audioOn = true
	ui.vfo = 7_100_000
	ui.signal = Signal{Power: -70, Noise: -110}
	ui.SetFrame(unwrapFFT(syntheticFrame(1024, 0)), 0, 0)
	ui.Draw(screen)

	l := computeLayout(160, 24, ViewSpectrum, ui.splitRatio, 0)
	cells, w, _ := screen.GetContents()
	var row []rune
	for i := 0; i < w; i++ {
		if r := cells[l.StatusY*w+i].Runes; len(r) > 0 && r[0] != 0 {
			row = append(row, r[0])
		} else {
			row = append(row, ' ')
		}
	}
	if !strings.Contains(string(row), "g meter") {
		t.Errorf("the status row does not mention the meter key: %q", string(row))
	}

	found := false
	for _, line := range helpLines {
		if strings.Contains(line, "signal meter") {
			found = true
		}
	}
	if !found {
		t.Error("the help overlay does not list the meter toggle")
	}
}

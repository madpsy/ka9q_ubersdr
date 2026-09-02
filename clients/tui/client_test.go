package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestParseFrequency(t *testing.T) {
	cases := []struct {
		in   string
		want float64
	}{
		{"7100", 7_100_000},      // bare numbers are kHz
		{"14074", 14_074_000},    //
		{"7.1M", 7_100_000},      // suffixes override
		{"7.1MHz", 7_100_000},    //
		{"7100k", 7_100_000},     //
		{"7100kHz", 7_100_000},   //
		{"7100000Hz", 7_100_000}, //
		{"1,234", 1_234_000},     // thousands separators are ignored
		{" 3573 ", 3_573_000},    // and surrounding space
	}
	for _, c := range cases {
		got, err := parseFrequency(c.in)
		if err != nil {
			t.Errorf("parseFrequency(%q) returned error: %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("parseFrequency(%q) = %v, want %v", c.in, got, c.want)
		}
	}

	for _, bad := range []string{"", "abc", "M", "7..1"} {
		if _, err := parseFrequency(bad); err == nil {
			t.Errorf("parseFrequency(%q) should have failed", bad)
		}
	}
}

func TestUnwrapFFT(t *testing.T) {
	// Raw FFT order is [positive freqs, negative freqs]; unwrapping must
	// rotate by half so the array reads low frequency to high.
	in := []float32{1, 2, 3, 4, 5, 6}
	want := []float32{4, 5, 6, 1, 2, 3}
	got := unwrapFFT(in)
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("unwrapFFT = %v, want %v", got, want)
		}
	}

	if n := len(unwrapFFT(nil)); n != 0 {
		t.Errorf("unwrapFFT(nil) length = %d, want 0", n)
	}
}

func TestSpectrumScale(t *testing.T) {
	// dB = refCentiDB/100 + code * stepCentiDB/100. Version 1 hardcoded
	// value-256; version 2 carries the scale so it cannot clip on a receiver
	// whose gain puts the bins somewhere else.
	s := spectrumScale{refCentiDB: -12000, stepCentiDB: 50} // -120 dB, 0.5 dB steps
	cases := []struct {
		code byte
		want float32
	}{{0, -120}, {2, -119}, {200, -20}, {255, -92.5 + 0}}
	for _, tc := range cases[:3] {
		if got := s.dB(tc.code); got != tc.want {
			t.Errorf("dB(%d) = %v, want %v", tc.code, got, tc.want)
		}
	}
	// The whole-frame conversion agrees with the per-code one.
	got := s.codesToDB([]uint8{0, 2, 200})
	for i, want := range []float32{-120, -119, -20} {
		if got[i] != want {
			t.Fatalf("codesToDB = %v, want -120 -119 -20", got)
		}
	}
}

func TestNiceStep(t *testing.T) {
	cases := []struct{ in, want float64 }{
		{0.9, 1}, {1.5, 2}, {3, 5}, {7, 10},
		{900, 1000}, {1500, 2000}, {30000, 50000},
	}
	for _, c := range cases {
		if got := niceStep(c.in); got != c.want {
			t.Errorf("niceStep(%v) = %v, want %v", c.in, got, c.want)
		}
	}
	if got := niceStep(0); got != 0 {
		t.Errorf("niceStep(0) = %v, want 0", got)
	}
}

func TestClampCenter(t *testing.T) {
	// A narrow span should be pushed fully inside the 10 kHz–30 MHz window.
	if got := clampCenter(5000, 100000); got != minFreq+50000 {
		t.Errorf("clampCenter low edge = %v, want %v", got, minFreq+50000)
	}
	if got := clampCenter(40e6, 100000); got != maxFreq-50000 {
		t.Errorf("clampCenter high edge = %v, want %v", got, maxFreq-50000)
	}
	// A span too wide to fit must centre on the middle of the receiver's range,
	// so the fully-zoomed-out view is symmetric rather than lopsided.
	mid := (minFreq + maxFreq) / 2
	if got := clampCenter(1e6, 40e6); got != mid {
		t.Errorf("clampCenter with oversized span = %v, want the range midpoint %v", got, mid)
	}
	// The exact full-span case is the one users hit by zooming all the way out.
	if got := clampCenter(7.5e6, maxSpan); got != mid {
		t.Errorf("clampCenter at full span = %v, want %v; the view would be lopsided", got, mid)
	}
}

func TestZoomRungs(t *testing.T) {
	// The ladder must extend past 5000 Hz/bin up to the receiver's full-span
	// bin bandwidth, which becomes the zoom-out limit.
	rungs := zoomRungs(14648.4375)
	last := rungs[len(rungs)-1]
	if last != 14648.4375 {
		t.Errorf("top rung = %v, want the full-span bin bandwidth", last)
	}
	for i := 1; i < len(rungs); i++ {
		if rungs[i] <= rungs[i-1] {
			t.Fatalf("rungs are not strictly increasing at %d: %v", i, rungs)
		}
	}
	// A receiver whose full span is already on the ladder gains no extra rungs.
	if got := zoomRungs(5000); len(got) != len(serverBinBWLadder) {
		t.Errorf("zoomRungs(5000) returned %d rungs, want %d", len(got), len(serverBinBWLadder))
	}
}

func TestNextRungAlwaysMoves(t *testing.T) {
	rungs := zoomRungs(14648.4375)

	// Every rung must step to a different value, in the right direction. This
	// is the regression guard for the 2000 Hz/bin trap, where a multiplicative
	// zoom asked for 3000 and the server rounded it back to 2000, pinning the
	// span while the centre kept moving.
	for i, r := range rungs {
		if out, ok := nextRung(rungs, r, +1); ok {
			if out <= r {
				t.Errorf("zooming out from %v gave %v, which does not widen", r, out)
			}
		} else if i != len(rungs)-1 {
			t.Errorf("zoom out failed at rung %v, which is not the top", r)
		}
		if in, ok := nextRung(rungs, r, -1); ok {
			if in >= r {
				t.Errorf("zooming in from %v gave %v, which does not narrow", r, in)
			}
		} else if i != 0 {
			t.Errorf("zoom in failed at rung %v, which is not the bottom", r)
		}
	}

	// The 2000 rung specifically must advance to 5000, never back to itself.
	if out, ok := nextRung(rungs, 2000, +1); !ok || out != 5000 {
		t.Errorf("nextRung(2000, out) = %v (ok=%v), want 5000", out, ok)
	}

	// A bin bandwidth between rungs snaps to the nearest before stepping.
	if out, ok := nextRung(rungs, 2100, +1); !ok || out != 5000 {
		t.Errorf("nextRung(2100, out) = %v (ok=%v), want 5000", out, ok)
	}
}

func TestZoomLadderWalksFullRange(t *testing.T) {
	// Walking out from the narrowest rung must reach the full-span rung without
	// ever repeating a value.
	full := 14648.4375
	rungs := zoomRungs(full)

	current := rungs[0]
	seen := map[float64]bool{current: true}
	for i := 0; i < 100; i++ {
		next, ok := nextRung(rungs, current, +1)
		if !ok {
			break
		}
		if seen[next] {
			t.Fatalf("zoom out revisited %v — the ladder loops", next)
		}
		seen[next] = true
		current = next
	}
	if current != full {
		t.Errorf("zooming out stopped at %v, want the full-span rung %v", current, full)
	}
}

func TestUUIDMatchesServerFormat(t *testing.T) {
	// The server rejects anything not matching its UUID regex, which requires a
	// version nibble of 1-5 and a variant nibble of 8/9/a/b.
	id, err := uuidV4()
	if err != nil {
		t.Fatal(err)
	}
	if len(id) != 36 {
		t.Fatalf("uuid %q has length %d, want 36", id, len(id))
	}
	if id[14] != '4' {
		t.Errorf("uuid %q version nibble = %c, want 4", id, id[14])
	}
	if v := id[19]; v != '8' && v != '9' && v != 'a' && v != 'b' {
		t.Errorf("uuid %q variant nibble = %c, want one of 89ab", id, v)
	}
}

// buildSpecFrame assembles a binary "SPEC" message for the decoder tests.
// buildSpecFrame assembles a version 2 frame with the given flags and body.
// seq lets a test drive the sequence number the gap detector watches.
func buildSpecFrame(flags byte, body []byte) []byte { return buildSpecFrameSeq(flags, 0, body) }

func buildSpecFrameSeq(flags byte, seq uint16, body []byte) []byte {
	msg := make([]byte, spectrumHeaderSize, spectrumHeaderSize+len(body))
	copy(msg, "SPEC")
	msg[4] = spectrumProtocolVersion
	msg[5] = flags
	binary.LittleEndian.PutUint16(msg[6:8], seq)
	binary.LittleEndian.PutUint64(msg[8:16], 1234)
	binary.LittleEndian.PutUint64(msg[16:24], 7_100_000)
	return append(msg, body...)
}

// buildFullBody prefixes codes with the scale a full frame carries.
func buildFullBody(refCentiDB int16, stepCentiDB uint8, codes ...byte) []byte {
	body := make([]byte, 3, 3+len(codes))
	binary.LittleEndian.PutUint16(body[0:2], uint16(refCentiDB))
	body[2] = stepCentiDB
	return append(body, codes...)
}

// buildDeltaBody builds a mask-and-values body for n bins, LSB-first per byte
// exactly as the server writes it.
func buildDeltaBody(n int, changes map[int]byte) []byte {
	maskLen := (n + 7) / 8
	body := make([]byte, maskLen)
	for i := 0; i < n; i++ {
		if _, ok := changes[i]; ok {
			body[i>>3] |= 1 << (uint(i) & 7)
		}
	}
	for i := 0; i < n; i++ {
		if v, ok := changes[i]; ok {
			body = append(body, v)
		}
	}
	return body
}

func TestBinaryFullAndDelta(t *testing.T) {
	c := &Client{Frames: make(chan Frame, 4), Status: make(chan string, 4)}

	// A full frame establishes both the codes and the scale they read against.
	// -120 dB reference, 0.5 dB steps.
	full := buildSpecFrame(spectrumFlagFull, buildFullBody(-12000, 50, 10, 20, 30, 40))
	if err := c.handleBinarySpectrum(full); err != nil {
		t.Fatalf("full frame: %v", err)
	}
	frame := <-c.Frames
	// unwrapFFT rotates by half, so the second half comes first.
	want := []float32{-120 + 15, -120 + 20, -120 + 5, -120 + 10}
	for i := range want {
		if frame.Bins[i] != want[i] {
			t.Fatalf("full frame bins = %v, want %v", frame.Bins, want)
		}
	}

	// A delta patches bin 0 only, leaving the others and the scale intact.
	delta := buildSpecFrameSeq(spectrumFlagDelta, 1, buildDeltaBody(4, map[int]byte{0: 200}))
	if err := c.handleBinarySpectrum(delta); err != nil {
		t.Fatalf("delta frame: %v", err)
	}
	frame = <-c.Frames
	want = []float32{-120 + 15, -120 + 20, -120 + 100, -120 + 10}
	for i := range want {
		if frame.Bins[i] != want[i] {
			t.Fatalf("delta frame bins = %v, want %v", frame.Bins, want)
		}
	}
}

// A delta that changes several non-adjacent bins exercises the mask walk, which
// is the part most easily got wrong: the bits are LSB-first within each byte.
func TestBinaryDeltaMaskWalk(t *testing.T) {
	c := &Client{Frames: make(chan Frame, 4), Status: make(chan string, 4)}

	codes := make([]byte, 20)
	for i := range codes {
		codes[i] = 10
	}
	if err := c.handleBinarySpectrum(buildSpecFrame(spectrumFlagFull,
		buildFullBody(0, 100, codes...))); err != nil {
		t.Fatal(err)
	}
	<-c.Frames

	// Bins 0, 7, 8 and 19: either side of a byte boundary, and the last bin,
	// where the mask's final byte is only partly used.
	changes := map[int]byte{0: 1, 7: 2, 8: 3, 19: 4}
	if err := c.handleBinarySpectrum(buildSpecFrameSeq(spectrumFlagDelta, 1,
		buildDeltaBody(20, changes))); err != nil {
		t.Fatalf("delta: %v", err)
	}
	<-c.Frames

	for i := 0; i < 20; i++ {
		want := byte(10)
		if v, ok := changes[i]; ok {
			want = v
		}
		if c.prevU8[i] != want {
			t.Fatalf("bin %d = %d, want %d", i, c.prevU8[i], want)
		}
	}
}

// The scale may only change on a full frame; a delta must leave it alone.
func TestBinaryDeltaKeepsScale(t *testing.T) {
	c := &Client{Frames: make(chan Frame, 4), Status: make(chan string, 4)}
	if err := c.handleBinarySpectrum(buildSpecFrame(spectrumFlagFull,
		buildFullBody(-9000, 25, 4, 4))); err != nil {
		t.Fatal(err)
	}
	<-c.Frames
	before := c.scale
	if err := c.handleBinarySpectrum(buildSpecFrameSeq(spectrumFlagDelta, 1,
		buildDeltaBody(2, map[int]byte{1: 8}))); err != nil {
		t.Fatal(err)
	}
	<-c.Frames
	if c.scale != before {
		t.Fatalf("scale changed on a delta: %+v -> %+v", before, c.scale)
	}
}

// A client joining mid-stream sees deltas before any full frame. That is not an
// error: the next keyframe restates everything, at most five seconds away.
func TestBinaryDeltaBeforeFullIsIgnored(t *testing.T) {
	c := &Client{Frames: make(chan Frame, 4), Status: make(chan string, 4)}
	if err := c.handleBinarySpectrum(buildSpecFrame(spectrumFlagDelta,
		buildDeltaBody(8, map[int]byte{0: 9}))); err != nil {
		t.Errorf("a delta before the first full frame should be ignored, got %v", err)
	}
	select {
	case f := <-c.Frames:
		t.Fatalf("a frame was emitted with no baseline: %v", f.Bins)
	default:
	}
}

// A body whose length disagrees with its mask is malformed. It must be refused
// whole rather than applied part way, which would leave bins half updated with
// nothing to indicate it.
func TestBinaryMalformedDeltaIsRejected(t *testing.T) {
	c := &Client{Frames: make(chan Frame, 4), Status: make(chan string, 4)}
	if err := c.handleBinarySpectrum(buildSpecFrame(spectrumFlagFull,
		buildFullBody(0, 50, 1, 2, 3, 4))); err != nil {
		t.Fatal(err)
	}
	<-c.Frames

	// Mask claims two changes, body carries one value.
	short := append(buildDeltaBody(4, map[int]byte{0: 7, 1: 8})[:1], 7)
	if err := c.handleBinarySpectrum(buildSpecFrameSeq(spectrumFlagDelta, 1, short)); err == nil {
		t.Error("expected an error for a delta whose values do not match its mask")
	}

	// Body shorter than the mask itself.
	if err := c.handleBinarySpectrum(buildSpecFrameSeq(spectrumFlagDelta, 2, nil)); err == nil {
		t.Error("expected an error for a delta with no mask")
	}
}

// A gap in the sequence means the server dropped frames for a slow reader.
// Noticing it is what tells an operator why the display stuttered; the keyframe
// is what repairs it.
func TestBinarySequenceGapIsCounted(t *testing.T) {
	c := &Client{Frames: make(chan Frame, 8), Status: make(chan string, 8)}
	body := buildFullBody(0, 50, 1, 2)
	for _, seq := range []uint16{1, 2, 5} {
		if err := c.handleBinarySpectrum(buildSpecFrameSeq(spectrumFlagFull, seq, body)); err != nil {
			t.Fatal(err)
		}
		<-c.Frames
	}
	if c.spectrumGaps != 1 {
		t.Errorf("spectrumGaps = %d, want 1 (2 -> 5 is the only gap)", c.spectrumGaps)
	}
}

func TestBinaryRejectsBadHeaders(t *testing.T) {
	c := &Client{Frames: make(chan Frame, 4), Status: make(chan string, 4)}

	if err := c.handleBinarySpectrum([]byte("SPEC")); err == nil {
		t.Error("expected an error for a short frame")
	}

	// Version 1 is no longer read: this client asks for 2 explicitly, so a
	// version 1 frame means the stream is not what it claims to be.
	v1 := buildSpecFrame(spectrumFlagFull, buildFullBody(0, 50, 1, 2))
	v1[4] = 0x01
	if err := c.handleBinarySpectrum(v1); err == nil {
		t.Error("expected an error for a version 1 frame")
	}

	if err := c.handleBinarySpectrum(buildSpecFrame(0x09, []byte{1, 2})); err == nil {
		t.Error("expected an error for unknown flags")
	}

	// A zero step would make every bin read as the reference.
	if err := c.handleBinarySpectrum(buildSpecFrame(spectrumFlagFull,
		buildFullBody(0, 0, 1, 2))); err == nil {
		t.Error("expected an error for a zero quantisation step")
	}
}

func TestColumnPeaksPreservesNarrowSignals(t *testing.T) {
	// A single strong bin among weak ones must survive decimation to fewer
	// columns, which is why the reducer takes a max rather than a mean.
	bins := make([]float32, 100)
	for i := range bins {
		bins[i] = -120
	}
	bins[42] = -30

	cols := columnPeaks(bins, 10)
	if cols[4] != -30 {
		t.Errorf("column 4 = %v, want -30 (the narrow signal was lost)", cols[4])
	}
}

func TestLayoutStaysValidWhenTiny(t *testing.T) {
	// Resize can transiently hand us absurd geometry; the layout must never
	// produce non-positive dimensions that would panic the renderer.
	modes := []ViewMode{ViewSpectrum, ViewWaterfall, ViewSplit}
	for _, dim := range [][2]int{{1, 1}, {8, 3}, {20, 6}, {24, 8}, {200, 60}} {
		for _, mode := range modes {
			l := computeLayout(dim[0], dim[1], mode, 0.45, 0)
			if l.PlotW < 1 {
				t.Errorf("computeLayout(%d,%d,%v, 0) gave PlotW=%d", dim[0], dim[1], mode, l.PlotW)
			}
			if l.SpecH < 0 || l.WfH < 0 {
				t.Errorf("computeLayout(%d,%d,%v, 0) gave SpecH=%d WfH=%d",
					dim[0], dim[1], mode, l.SpecH, l.WfH)
			}
			// Panes must not run past the frequency axis.
			if l.SpecH > 0 && l.SpecY+l.SpecH > l.AxisY {
				t.Errorf("spectrum pane overruns the axis at %dx%d %v", dim[0], dim[1], mode)
			}
			if l.WfH > 0 && l.WfY+l.WfH > l.AxisY {
				t.Errorf("waterfall pane overruns the axis at %dx%d %v", dim[0], dim[1], mode)
			}
		}
	}
}

func TestSplitShowsBothPanes(t *testing.T) {
	// Split view must never collapse to a single pane on a usable terminal,
	// whatever the ratio.
	for _, ratio := range []float64{0.05, 0.15, 0.45, 0.85, 0.99} {
		l := computeLayout(120, 40, ViewSplit, ratio, 0)
		if l.SpecH < 1 || l.WfH < 1 {
			t.Errorf("ratio %.2f collapsed the split: SpecH=%d WfH=%d", ratio, l.SpecH, l.WfH)
		}
	}
}

func TestWaterfallRingBuffer(t *testing.T) {
	w := NewWaterfall()
	if w.Len() != 0 {
		t.Fatalf("new waterfall has %d rows, want 0", w.Len())
	}

	for i := 0; i < 5; i++ {
		w.Push([]float32{float32(i)}, 0, 1000, -120, -20)
	}
	if w.Len() != 5 {
		t.Errorf("Len = %d, want 5", w.Len())
	}

	// Row 0 is the newest.
	row, ok := w.Row(0)
	if !ok || row.bins[0] != 4 {
		t.Errorf("Row(0) = %v (ok=%v), want the most recent push (4)", row.bins, ok)
	}
	row, ok = w.Row(4)
	if !ok || row.bins[0] != 0 {
		t.Errorf("Row(4) = %v (ok=%v), want the oldest push (0)", row.bins, ok)
	}
	if _, ok := w.Row(5); ok {
		t.Error("Row(5) should not exist with only 5 rows pushed")
	}

	// Overflowing the ring must evict the oldest rows, not grow or corrupt.
	for i := 0; i < maxWaterfallRows+50; i++ {
		w.Push([]float32{float32(i)}, 0, 1000, -120, -20)
	}
	if w.Len() != maxWaterfallRows {
		t.Errorf("Len after overflow = %d, want %d", w.Len(), maxWaterfallRows)
	}
	row, _ = w.Row(0)
	if row.bins[0] != float32(maxWaterfallRows+49) {
		t.Errorf("newest row = %v, want %v", row.bins[0], maxWaterfallRows+49)
	}
}

func TestWaterfallPushCopiesBins(t *testing.T) {
	// The caller reuses its frame buffer, so stored rows must not alias it.
	w := NewWaterfall()
	buf := []float32{1, 2, 3}
	w.Push(buf, 0, 1000, -120, -20)
	buf[0] = 99

	row, _ := w.Row(0)
	if row.bins[0] != 1 {
		t.Errorf("stored row aliased the caller's buffer: got %v", row.bins[0])
	}
}

func TestWaterfallRowValueAt(t *testing.T) {
	// A row samples by absolute frequency so history stays aligned after the
	// view pans or zooms.
	// Four bins across 4 kHz, so each bin spans exactly 1 kHz.
	r := wfRow{bins: []float32{-100, -50, -20, -80}, start: 7_000_000, span: 4000}

	if v, ok := r.ValueAt(7_000_500); !ok || v != -100 {
		t.Errorf("ValueAt(+500 Hz) = %v (ok=%v), want -100 (bin 0)", v, ok)
	}
	if v, ok := r.ValueAt(7_002_500); !ok || v != -20 {
		t.Errorf("ValueAt(+2500 Hz) = %v (ok=%v), want -20 (bin 2)", v, ok)
	}
	if v, ok := r.ValueAt(7_003_999); !ok || v != -80 {
		t.Errorf("ValueAt(+3999 Hz) = %v (ok=%v), want -80 (last bin)", v, ok)
	}
	if _, ok := r.ValueAt(6_999_000); ok {
		t.Error("frequency below the row's range should report not-found")
	}
	if _, ok := r.ValueAt(7_004_001); ok {
		t.Error("frequency above the row's range should report not-found")
	}
	if _, ok := (wfRow{}).ValueAt(7_000_000); ok {
		t.Error("an empty row should report not-found")
	}
}

func TestInterpolatePalette(t *testing.T) {
	stops := []colorStop{{0, 0, 0, 0}, {1, 100, 200, 255}}

	r, g, b := interpolate(stops, 0)
	if r != 0 || g != 0 || b != 0 {
		t.Errorf("interpolate(0) = %d,%d,%d, want 0,0,0", r, g, b)
	}
	r, g, b = interpolate(stops, 1)
	if r != 100 || g != 200 || b != 255 {
		t.Errorf("interpolate(1) = %d,%d,%d, want 100,200,255", r, g, b)
	}
	r, _, _ = interpolate(stops, 0.5)
	if r != 50 {
		t.Errorf("interpolate(0.5) red = %d, want 50", r)
	}
	// Out-of-range and NaN inputs must clamp rather than panic.
	if _, _, _ = interpolate(stops, -5); false {
		t.Fatal("unreachable")
	}
	interpolate(stops, math.NaN())
	interpolate(stops, 42)
}

func TestManualScaleKeepsUsableRange(t *testing.T) {
	u := NewUI("test")
	if !u.autoScale {
		t.Error("a new UI should start in auto-scale mode")
	}

	u.minDB, u.maxDB = -100, -20
	u.AdjustScale(0, -100) // drive the ceiling far below the floor
	if u.autoScale {
		t.Error("adjusting the scale should switch to manual mode")
	}
	if u.maxDB-u.minDB < 10 {
		t.Errorf("range collapsed to %.1f dB, want at least 10", u.maxDB-u.minDB)
	}
}

func TestAutoRangeIgnoredInManualMode(t *testing.T) {
	u := NewUI("test")
	u.autoScale = false
	u.minDB, u.maxDB = -90, -30
	u.bins = []float32{-150, -140, -10, -5}

	u.autoRange()
	if u.minDB != -90 || u.maxDB != -30 {
		t.Errorf("manual scale was overwritten: got %.1f/%.1f, want -90/-30", u.minDB, u.maxDB)
	}
}

func TestParseView(t *testing.T) {
	cases := map[string]ViewMode{
		"spectrum":  ViewSpectrum,
		"spec":      ViewSpectrum,
		"waterfall": ViewWaterfall,
		"WF":        ViewWaterfall,
		"split":     ViewSplit,
		"both":      ViewSplit,
	}
	for in, want := range cases {
		got, err := parseView(in)
		if err != nil {
			t.Errorf("parseView(%q) errored: %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("parseView(%q) = %v, want %v", in, got, want)
		}
	}
	if _, err := parseView("nonsense"); err == nil {
		t.Error("parseView should reject an unknown view name")
	}
}

func TestParseServer(t *testing.T) {
	cases := []struct {
		in       string
		inTLS    bool
		wantHost string
		wantTLS  bool
	}{
		{"localhost:8080", false, "localhost:8080", false},
		{"https://example.org/", false, "example.org", true},
		{"http://example.org:8080", false, "example.org:8080", false},
		{"example.org", true, "example.org", true},
	}
	for _, c := range cases {
		host, tls := parseServer(c.in, c.inTLS)
		if host != c.wantHost || tls != c.wantTLS {
			t.Errorf("parseServer(%q,%v) = (%q,%v), want (%q,%v)",
				c.in, c.inTLS, host, tls, c.wantHost, c.wantTLS)
		}
	}
}

// TestLiveServer exercises the real protocol end to end. It is skipped unless
// UBERSDR_TEST_SERVER is set, e.g.
//
//	UBERSDR_TEST_SERVER=https://example.org go test -run TestLiveServer -v
func TestLiveServer(t *testing.T) {
	target := os.Getenv("UBERSDR_TEST_SERVER")
	if target == "" {
		t.Skip("set UBERSDR_TEST_SERVER to run the live protocol test")
	}

	host, secure := parseServer(target, false)
	c, err := NewClient(host, secure, os.Getenv("UBERSDR_TEST_PASSWORD"))
	if err != nil {
		t.Fatal(err)
	}

	if err := c.CheckConnection(); err != nil {
		t.Fatalf("/connection precheck failed: %v", err)
	}
	t.Log("/connection accepted")

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	go c.Run(ctx, 0, 0)

	var cfg SpectrumConfig
	select {
	case cfg = <-c.Configs:
		t.Logf("config: centre=%.0f Hz bins=%d binBW=%.3f Hz span=%.0f Hz",
			cfg.CenterFreq, cfg.BinCount, cfg.BinBandwidth, cfg.TotalBandwidth)
	case <-ctx.Done():
		t.Fatal("timed out waiting for the config message")
	}
	if cfg.BinCount <= 0 || cfg.TotalBandwidth <= 0 {
		t.Fatalf("implausible config: %+v", cfg)
	}

	// Collect a few frames and confirm they decode to sane dBFS values.
	deadline := time.After(15 * time.Second)
	frames := 0
	for frames < 5 {
		select {
		case f := <-c.Frames:
			frames++
			if len(f.Bins) != cfg.BinCount {
				t.Errorf("frame %d has %d bins, want %d", frames, len(f.Bins), cfg.BinCount)
			}
			if frames == 1 {
				var lo, hi float32 = f.Bins[0], f.Bins[0]
				for _, v := range f.Bins {
					if v < lo {
						lo = v
					}
					if v > hi {
						hi = v
					}
				}
				t.Logf("first frame: %d bins, range %.1f to %.1f dBFS", len(f.Bins), lo, hi)
				if lo < -260 || hi > 0 {
					t.Errorf("bin values outside plausible dBFS range: %.1f to %.1f", lo, hi)
				}
			}
		case <-deadline:
			t.Fatalf("only received %d frames before the deadline", frames)
		}
	}
	t.Logf("received %d spectrum frames", frames)

	// Zooming must produce a new config echoing a narrower span.
	c.Zoom(7_100_000, 200_000)
	select {
	case newCfg := <-c.Configs:
		t.Logf("after zoom: centre=%.0f Hz span=%.0f Hz", newCfg.CenterFreq, newCfg.TotalBandwidth)
		if newCfg.TotalBandwidth >= cfg.TotalBandwidth {
			t.Errorf("zoom did not narrow the span: %.0f -> %.0f",
				cfg.TotalBandwidth, newCfg.TotalBandwidth)
		}
	case <-time.After(10 * time.Second):
		t.Error("no config message after the zoom command")
	}
}

// A receiver names where it wants a listener to start. Both fields are
// advisory, and both are re-checked here: an older or third-party receiver can
// report a frequency outside the band or a mode this client cannot demodulate,
// which is why the Python client re-checks them too.
func TestDescriptionDefaults(t *testing.T) {
	for _, tc := range []struct {
		name     string
		desc     Description
		wantFreq float64
		wantMode string
	}{
		{"as configured",
			Description{DefaultFrequency: 7_100_000, DefaultMode: "lsb"}, 7_100_000, "lsb"},
		{"upper case mode",
			Description{DefaultFrequency: 14_074_000, DefaultMode: "USB"}, 14_074_000, "usb"},
		{"nothing said",
			Description{}, defaultStartFrequency, "usb"},
		{"out of band",
			Description{DefaultFrequency: 145_500_000, DefaultMode: "nfm"}, defaultStartFrequency, "nfm"},
		{"below the receiver's range",
			Description{DefaultFrequency: 500, DefaultMode: "am"}, defaultStartFrequency, "am"},
		{"a mode we cannot demodulate",
			Description{DefaultFrequency: 7_100_000, DefaultMode: "iq48"}, 7_100_000, "usb"},
	} {
		freq, mode := tc.desc.Defaults()
		if freq != tc.wantFreq || mode != tc.wantMode {
			t.Errorf("%s: got %.0f Hz %s, want %.0f Hz %s",
				tc.name, freq, mode, tc.wantFreq, tc.wantMode)
		}
	}
}

// Priority is the same as the Python client's: what the user asked for, then
// what the receiver prefers, then the built-in fallback.
func TestReceiverDefaultsLoseToTheCommandLine(t *testing.T) {
	desc := Description{DefaultFrequency: 7_100_000, DefaultMode: "lsb"}

	e := &eventLoop{ui: NewUI("test")}
	e.applyDescription(desc)
	if e.ui.vfo != 7_100_000 || e.ui.audioMode != "lsb" {
		t.Errorf("receiver default not applied: %.0f Hz %s", e.ui.vfo, e.ui.audioMode)
	}
	// The sideband convention says USB below 10 MHz is wrong, but the receiver
	// said LSB and it is not for this client to argue before the user has
	// tuned anywhere.
	e.ui.SyncSideband()
	if e.ui.audioMode != "lsb" {
		t.Errorf("the convention overruled the receiver: %s", e.ui.audioMode)
	}

	// Tuning hands the convention back.
	e.setVFO(14_100_000)
	if e.ui.audioMode != "usb" {
		t.Errorf("after tuning above 10 MHz the mode is %s", e.ui.audioMode)
	}

	// What the user asked for wins outright.
	e = &eventLoop{ui: NewUI("test"), opts: options{initialFreq: 3_700_000, initialMode: "am"}}
	e.applyDescription(desc)
	if e.ui.vfo != 3_700_000 || e.ui.audioMode != "am" {
		t.Errorf("the command line lost: %.0f Hz %s", e.ui.vfo, e.ui.audioMode)
	}

	// A VFO the user has already moved is theirs, whatever the receiver says.
	e = &eventLoop{ui: NewUI("test")}
	e.ui.vfo = 10_000_000
	e.applyDescription(desc)
	if e.ui.vfo != 10_000_000 {
		t.Errorf("the receiver moved a VFO already in use: %.0f", e.ui.vfo)
	}
}

// Every mode the -mode flag accepts must be one the client can actually apply.
func TestModeNamesMatchTheModeTable(t *testing.T) {
	names := modeNames()
	if len(names) != len(modes) {
		t.Fatalf("listed %d modes for %d in the table", len(names), len(modes))
	}
	for _, name := range names {
		if _, ok := lookupMode(name); !ok {
			t.Errorf("%q is offered but cannot be applied", name)
		}
	}
}

// Every request this client makes identifies itself, HTTP and WebSocket alike.
// The server records the User-Agent a session presented to /connection and
// refuses sockets for a UUID it has never seen one from, so a call that forgets
// it is not merely impolite.
func TestUserAgentOnEveryRequest(t *testing.T) {
	if userAgent != "UberSDR_TUI/1.0" {
		t.Errorf("user agent is %q", userAgent)
	}

	seen := make(chan string, 8)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Get("User-Agent")
		switch r.URL.Path {
		case "/connection":
			json.NewEncoder(w).Encode(map[string]interface{}{"allowed": true})
		case "/api/bands":
			json.NewEncoder(w).Encode([]interface{}{})
		default:
			json.NewEncoder(w).Encode(map[string]interface{}{})
		}
	}))
	defer srv.Close()

	host := strings.TrimPrefix(srv.URL, "http://")
	c, err := NewClient(host, false, "")
	if err != nil {
		t.Fatal(err)
	}

	calls := map[string]func() error{
		"/connection":      c.CheckConnection,
		"/api/description": func() error { _, err := c.FetchDescription(); return err },
		"/api/bands":       func() error { var b []Band; return c.getJSON("/api/bands", &b) },
	}
	for name, call := range calls {
		if err := call(); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if got := <-seen; got != userAgent {
			t.Errorf("%s presented %q", name, got)
		}
	}

	// The public directory and the mDNS enrichment are the two that reach a
	// receiver without going through Client.
	stubbed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Get("User-Agent")
		json.NewEncoder(w).Encode(map[string]interface{}{"count": 0, "instances": []interface{}{}})
	}))
	defer stubbed.Close()

	orig := publicInstancesURLForTest
	publicInstancesURLForTest = stubbed.URL
	defer func() { publicInstancesURLForTest = orig }()

	if _, err := FetchPublicInstances(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := <-seen; got != userAgent {
		t.Errorf("the public directory saw %q", got)
	}

	d := NewLocalDiscovery()
	d.enrich("k", Instance{Host: strings.TrimPrefix(srv.URL, "http://")})
	if got := <-seen; got != userAgent {
		t.Errorf("local discovery saw %q", got)
	}
}

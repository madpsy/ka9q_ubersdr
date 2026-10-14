package main

// The spectrogram render path against its pre-optimisation copy in
// spectrogram_render_ref_test.go: the same decoded pixels, the same auto range
// and the same palette colour for every input, and a lazily rendered cached
// PNG identical to the one every tick used to render. The bytes are not
// compared: jet and plasma images are now written with indexed colour, which
// decodes to the same pixels from a smaller file.

import (
	"bytes"
	"fmt"
	"image/color"
	"image/png"
	"math"
	"math/rand"
	"sync"
	"testing"
)

// randomSpectrogramRows returns n rows of bins values: mostly a noise floor
// with carriers, plus no-data and NaN cells, whole no-data rows, and the odd
// row too short to render. No +Inf: the reference panics on it; see
// TestSpectrogramInfiniteBinsRender for what the current code does.
func randomSpectrogramRows(rng *rand.Rand, n, bins int) [][]float32 {
	rows := make([][]float32, n)
	for i := range rows {
		row := make([]float32, bins)
		switch {
		case rng.Intn(40) == 0:
			for j := range row {
				row[j] = noDataSentinel
			}
		case rng.Intn(60) == 0:
			row = row[:bins/2]
			fallthrough
		default:
			for j := range row {
				v := float32(-120 + rng.NormFloat64()*6)
				if rng.Intn(50) == 0 {
					v = float32(-90 + rng.Float64()*80) // carriers, some past 0 dB
				}
				switch rng.Intn(500) {
				case 0:
					v = noDataSentinel
				case 1:
					v = float32(math.NaN())
				}
				row[j] = v
			}
		}
		rows[i] = row
	}
	return rows
}

func TestSpectrogramRenderMatchesReference(t *testing.T) {
	rng := rand.New(rand.NewSource(5))
	palettes := []string{"jet", "viridis", "plasma", "", "unknown"}
	for trial := 0; trial < 40; trial++ {
		bins := 16 + rng.Intn(600)
		rows := randomSpectrogramRows(rng, 1+rng.Intn(120), bins)
		palette := palettes[trial%len(palettes)]

		startBin, endBin := 0, 0
		if trial%3 == 1 {
			startBin = rng.Intn(bins / 2)
			endBin = startBin + 1 + rng.Intn(bins-startBin)
		} else if trial%3 == 2 {
			startBin, endBin = -5, bins+7 // out-of-range bounds normalise
		}

		dbMin, dbMax := refAutoRangeRowsSlice(rows, startBin, endBin, -130, -60)
		gotMin, gotMax := autoRangeRowsSlice(rows, startBin, endBin, -130, -60)
		if gotMin != dbMin || gotMax != dbMax {
			t.Fatalf("trial %d: auto range %v..%v, reference %v..%v", trial, gotMin, gotMax, dbMin, dbMax)
		}
		if trial%4 == 3 {
			dbMin, dbMax = -100, -100+float32(rng.Intn(60)+5) // explicit range
		}

		want := refRenderRowsAsPNGSlice(rows, palette, dbMin, dbMax, bins, startBin, endBin)
		got := renderRowsAsPNGSlice(rows, palette, dbMin, dbMax, bins, startBin, endBin)
		if msg := samePNGPixels(got, want); msg != "" {
			t.Fatalf("trial %d (palette %q, bins %d, slice %d..%d): %s",
				trial, palette, bins, startBin, endBin, msg)
		}
	}
}

// TestSpectrogramAutoRangeAtSampleCap covers the 500k-sample cap, where the
// sort is largest.
func TestSpectrogramAutoRangeAtSampleCap(t *testing.T) {
	rng := rand.New(rand.NewSource(6))
	rows := randomSpectrogramRows(rng, 300, 2048)
	for _, sb := range [][2]int{{0, 0}, {100, 1900}} {
		a, b := refAutoRangeRowsSlice(rows, sb[0], sb[1], -130, -60)
		c, d := autoRangeRowsSlice(rows, sb[0], sb[1], -130, -60)
		if a != c || b != d {
			t.Fatalf("slice %v: auto range %v..%v, reference %v..%v", sb, c, d, a, b)
		}
	}
}

func TestSpectrogramPaletteMatchesReference(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	specials := []float32{-130, -60, -130.0001, -59.9999, -1e30, 1e30, 0,
		float32(math.Inf(1)), float32(math.Inf(-1))}
	for _, palette := range []string{"jet", "viridis", "plasma", "x"} {
		for i := 0; i < 200000; i++ {
			v := float32(-140 + rng.Float64()*90)
			if i < len(specials) {
				v = specials[i]
			}
			if paletteColour(palette, v, -130, -60) != refPaletteColour(palette, v, -130, -60) {
				t.Fatalf("palette %q value %v: colour differs", palette, v)
			}
		}
	}
}

// testRecorder is a recorder with rows and nothing behind them, enough to
// drive the cached PNG.
func testRecorder(bins int) *SpectrogramRecorder {
	sr := &SpectrogramRecorder{binCount: bins}
	for i := range sr.rows {
		sr.rows[i] = make([]float32, bins)
		for j := range sr.rows[i] {
			sr.rows[i][j] = noDataSentinel
		}
	}
	return sr
}

// TestSpectrogramCachedPNGIsLazyAndIdentical: a tick no longer renders, the
// first read does, and what it renders is what renderAndCache rendered on
// every tick before -- the reference auto range and the default palette over
// every row so far.
func TestSpectrogramCachedPNGIsLazyAndIdentical(t *testing.T) {
	rng := rand.New(rand.NewSource(8))
	const bins = 512
	sr := testRecorder(bins)
	if sr.GetCachedPNG() != nil {
		t.Fatal("cached PNG before any rows")
	}
	src := randomSpectrogramRows(rng, 30, bins)
	for i, row := range src {
		if len(row) < bins { // the recorder pads short rows with no-data
			full := make([]float32, bins)
			copy(full, row)
			for j := len(row); j < bins; j++ {
				full[j] = noDataSentinel
			}
			row = full
		}
		sr.mu.Lock()
		copy(sr.rows[i], row)
		sr.rowCount = i + 1
		sr.mu.Unlock()
		sr.markPNGStale()
		if sr.pngGen.Load() == sr.rowsGen.Load() {
			t.Fatalf("row %d: a tick rendered without a read", i)
		}
		if sr.LastModified().IsZero() {
			t.Fatalf("row %d: lastModified not set", i)
		}
		if i%7 != 6 {
			continue // most ticks nobody reads
		}

		// Several readers at once must all get the one current render.
		var wg sync.WaitGroup
		got := make([][]byte, 4)
		for k := range got {
			wg.Add(1)
			go func(k int) {
				defer wg.Done()
				got[k] = sr.GetCachedPNG()
			}(k)
		}
		wg.Wait()

		rows := make([][]float32, i+1)
		copy(rows, sr.rows[:i+1])
		dbMin, dbMax := refAutoRangeRowsSlice(rows, 0, 0, spectrogramDefaultDBMin, spectrogramDefaultDBMax)
		want := refRenderRowsAsPNGSlice(rows, spectrogramDefaultPalette, dbMin, dbMax, bins, 0, 0)
		for k := range got {
			if msg := samePNGPixels(got[k], want); msg != "" {
				t.Fatalf("row %d reader %d: cached PNG differs from the per-tick render: %s", i, k, msg)
			}
		}
		if sr.pngGen.Load() != sr.rowsGen.Load() {
			t.Fatalf("row %d: still stale after a read", i)
		}
	}
}

func BenchmarkSpectrogramRenderRef(b *testing.B) {
	rows := randomSpectrogramRows(rand.New(rand.NewSource(9)), 1160, 1024)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		lo, hi := refAutoRangeRowsSlice(rows, 0, 0, -130, -60)
		refRenderRowsAsPNGSlice(rows, "jet", lo, hi, 1024, 0, 0)
	}
}

func BenchmarkSpectrogramRender(b *testing.B) {
	rows := randomSpectrogramRows(rand.New(rand.NewSource(9)), 1160, 1024)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		lo, hi := autoRangeRowsSlice(rows, 0, 0, -130, -60)
		renderRowsAsPNGSlice(rows, "jet", lo, hi, 1024, 0, 0)
	}
}

// TestSpectrogramInfiniteBinsRender: a +Inf bin used to make the auto range
// infinite, the palette position NaN, and the render panic indexing the
// palette with int(NaN). Now the range ignores it, matching the reference over
// the same rows without it, and every palette lookup stays in range.
func TestSpectrogramInfiniteBinsRender(t *testing.T) {
	rng := rand.New(rand.NewSource(10))
	const bins = 256
	rows := randomSpectrogramRows(rng, 50, bins)
	clean := make([][]float32, len(rows))
	for i, row := range rows {
		clean[i] = append([]float32(nil), row...)
		if len(row) == bins && i%5 == 0 {
			row[rng.Intn(bins)] = float32(math.Inf(1))
			clean[i] = clean[i][:0:0]
			for _, v := range row {
				if !math.IsInf(float64(v), 1) {
					clean[i] = append(clean[i], v)
				}
			}
		}
	}
	lo, hi := autoRangeRowsSlice(rows, 0, 0, -130, -60)
	if math.IsInf(float64(lo), 0) || math.IsInf(float64(hi), 0) {
		t.Fatalf("auto range %v..%v is infinite", lo, hi)
	}
	// Dropping a value changes which row is short, so compare the range over
	// the flattened finite values rather than row by row.
	wantLo, wantHi := refAutoRangeRowsSlice([][]float32{flatten(clean)}, 0, 0, -130, -60)
	gotLo, gotHi := autoRangeRowsSlice([][]float32{flatten(rows)}, 0, 0, -130, -60)
	if gotLo != wantLo || gotHi != wantHi {
		t.Fatalf("auto range %v..%v, want %v..%v without the +Inf bins", gotLo, gotHi, wantLo, wantHi)
	}
	if png := renderRowsAsPNGSlice(rows, "jet", lo, hi, bins, 0, 0); len(png) == 0 {
		t.Fatal("render with +Inf bins failed")
	}
	inf, nan := float32(math.Inf(1)), float32(math.NaN())
	for _, c := range [][3]float32{{inf, -130, inf}, {inf, inf, inf}, {-100, -100, -100}, {nan, -130, -60}} {
		if i := paletteIndex(c[0], c[1], c[2]); i < 0 || i > 255 {
			t.Fatalf("paletteIndex(%v, %v, %v) = %d", c[0], c[1], c[2], i)
		}
	}
}

func flatten(rows [][]float32) []float32 {
	var out []float32
	for _, r := range rows {
		out = append(out, r...)
	}
	return out
}

// samePNGPixels decodes two PNGs and reports the first pixel that differs, or
// "" when every pixel is the same colour.
func samePNGPixels(a, b []byte) string {
	ia, err := png.Decode(bytes.NewReader(a))
	if err != nil {
		return "decode: " + err.Error()
	}
	ib, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		return "decode reference: " + err.Error()
	}
	if ia.Bounds() != ib.Bounds() {
		return fmt.Sprintf("bounds %v, reference %v", ia.Bounds(), ib.Bounds())
	}
	r := ia.Bounds()
	for y := r.Min.Y; y < r.Max.Y; y++ {
		for x := r.Min.X; x < r.Max.X; x++ {
			r1, g1, b1, a1 := ia.At(x, y).RGBA()
			r2, g2, b2, a2 := ib.At(x, y).RGBA()
			if r1 != r2 || g1 != g2 || b1 != b2 || a1 != a2 {
				return fmt.Sprintf("pixel (%d,%d) is %v, reference %v", x, y, ia.At(x, y), ib.At(x, y))
			}
		}
	}
	return ""
}

// pngColourType is the IHDR colour type: 2 RGB, 3 indexed, 6 RGBA.
func pngColourType(b []byte) byte { return b[25] }

// TestSpectrogramIndexedColour: every palette is written as an indexed PNG; the archived thumbnail made from the PNG is byte-identical
// either way; and on band-like data the indexed file is the smaller one.
func TestSpectrogramIndexedColour(t *testing.T) {
	rng := rand.New(rand.NewSource(11))
	const bins = 700
	rows := make([][]float32, 300)
	for i := range rows {
		row := make([]float32, bins)
		for j := range row {
			row[j] = float32(-118 + 4*math.Sin(float64(j)/40) + rng.NormFloat64()*1.5)
			if j%97 < 3 {
				row[j] += 30 // carriers
			}
		}
		if i%50 == 0 {
			for j := range row {
				row[j] = noDataSentinel
			}
		}
		rows[i] = row
	}
	lo, hi := autoRangeRowsSlice(rows, 0, 0, -130, -60)
	for _, c := range []struct {
		palette string
		indexed bool
	}{{"jet", true}, {"plasma", true}, {"viridis", true}, {"", true}} {
		got := renderRowsAsPNGSlice(rows, c.palette, lo, hi, bins, 0, 0)
		want := refRenderRowsAsPNGSlice(rows, c.palette, lo, hi, bins, 0, 0)
		if msg := samePNGPixels(got, want); msg != "" {
			t.Fatalf("palette %q: %s", c.palette, msg)
		}
		// Not indexed means RGB (2) or RGBA (6); the encoder writes an opaque
		// NRGBA image as RGB, as it always has.
		if ct := pngColourType(got); (ct == 3) != c.indexed {
			t.Fatalf("palette %q: colour type %d, indexed %v", c.palette, ct, c.indexed)
		}
		if !bytes.Equal(generateThumbnail(got), generateThumbnail(want)) {
			t.Fatalf("palette %q: archived thumbnail differs", c.palette)
		}
		if c.indexed && len(got) >= len(want) {
			t.Fatalf("palette %q: indexed PNG %d bytes, not smaller than RGBA's %d", c.palette, len(got), len(want))
		}
		t.Logf("palette %-8q %6d bytes, was %6d", c.palette, len(got), len(want))
	}
}

// TestSpectrogramEveryColourFits renders viridis densely enough to use every
// entry, clipped at both ends, with a no-data row and a skipped row: viridis
// rounds to fewer than 254 distinct colours, so even that fits the indexed
// table exactly, with no merging and every pixel as the reference renders it.
func TestSpectrogramEveryColourFits(t *testing.T) {
	// 80 dB over 3000 bins is 0.03 dB a bin against 0.24 dB an entry.
	const bins = 3000
	rows := make([][]float32, 40)
	for i := range rows {
		row := make([]float32, bins)
		for j := range row {
			row[j] = -140 + 80*float32(j)/bins // -140..-60 across a -130..-70 range
		}
		rows[i] = row
	}
	for j := range rows[5] {
		rows[5][j] = noDataSentinel
	}
	rows[9] = rows[9][:bins/2] // a skipped row

	for _, palette := range []string{"jet", "plasma", "viridis"} {
		var used [256]bool
		for i := range used {
			used[i] = true
		}
		if pc := newPNGColours(paletteLUT(palette), &used, true, true); pc.merged != 0 {
			t.Fatalf("%s: %d merges with every colour in use", palette, pc.merged)
		}
		got := renderRowsAsPNGSlice(rows, palette, -130, -70, bins, 0, 0)
		want := refRenderRowsAsPNGSlice(rows, palette, -130, -70, bins, 0, 0)
		if pngColourType(got) != 3 {
			t.Fatalf("%s: colour type %d, want indexed", palette, pngColourType(got))
		}
		if msg := samePNGPixels(got, want); msg != "" {
			t.Fatalf("%s: %s", palette, msg)
		}
	}
}

// TestPNGColoursMergeToFit covers the fallback no current palette needs: a
// LUT of 256 distinct colours, all in use, plus black and transparent, is two
// entries too many. The two closest neighbouring colours give way to their
// neighbours; nothing else moves.
func TestPNGColoursMergeToFit(t *testing.T) {
	var lut [256][3]uint8
	for i := range lut {
		lut[i] = [3]uint8{uint8(i), uint8(255 - i), uint8(i / 2)} // neighbours 1-2 apart
	}
	lut[100] = [3]uint8{100, 200, 30} // far from both neighbours: must not move
	var used [256]bool
	for i := range used {
		used[i] = true
	}
	pc := newPNGColours(&lut, &used, true, true)
	if len(pc.palette) != 256 || pc.merged != 2 {
		t.Fatalf("%d entries after %d merges, want 256 after 2", len(pc.palette), pc.merged)
	}
	moved := 0
	for i := range lut {
		c := pc.palette[pc.index[i]].(color.NRGBA)
		got := [3]uint8{c.R, c.G, c.B}
		if c.A != 255 {
			t.Fatalf("entry %d maps to a transparent colour", i)
		}
		if got == lut[i] {
			continue
		}
		moved++
		if i == 100 {
			t.Fatal("the outlying entry moved")
		}
		if (i == 0 || got != lut[i-1]) && (i == 255 || got != lut[i+1]) {
			t.Fatalf("entry %d became %v, not a neighbour's colour", i, got)
		}
	}
	if moved != 2 {
		t.Fatalf("%d entries moved, want 2", moved)
	}
	if pc.palette[pc.black] != (color.NRGBA{0, 0, 0, 255}) || pc.palette[pc.transparent] != (color.NRGBA{}) {
		t.Fatal("black or transparent entry wrong")
	}
}

// TestViridisTableIsViridis pins the viridis table to matplotlib's, rounded
// to 8 bits. From entry 35 up it used to drift away from viridis, reaching
// (194,255,28) at entry 254 before jumping to the real (253,231,37) at the
// end -- a green no viridis entry has, and a 59-unit step where neighbours
// are a few units apart.
func TestViridisTableIsViridis(t *testing.T) {
	for _, c := range []struct {
		i    int
		want [3]uint8
	}{{0, [3]uint8{68, 1, 84}}, {35, [3]uint8{70, 48, 126}}, {128, [3]uint8{33, 145, 140}},
		{254, [3]uint8{251, 231, 35}}, {255, [3]uint8{253, 231, 37}}} {
		if viridisLUT[c.i] != c.want {
			t.Fatalf("viridis[%d] = %v, want %v", c.i, viridisLUT[c.i], c.want)
		}
	}
	for i := 1; i < 256; i++ {
		for ch := 0; ch < 3; ch++ {
			d := int(viridisLUT[i][ch]) - int(viridisLUT[i-1][ch])
			if d > 3 || d < -3 {
				t.Fatalf("viridis[%d] channel %d steps %d from its neighbour", i, ch, d)
			}
		}
		if viridisLUT[i][1] > 231 {
			t.Fatalf("viridis[%d] green %d, past viridis's 231", i, viridisLUT[i][1])
		}
	}
}

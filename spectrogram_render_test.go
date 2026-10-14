package main

// The spectrogram render path against its pre-optimisation copy in
// spectrogram_render_ref_test.go: the same PNG bytes, the same auto range and
// the same palette colour for every input, and a lazily rendered cached PNG
// identical to the one every tick used to render.

import (
	"bytes"
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
		if !bytes.Equal(got, want) {
			t.Fatalf("trial %d (palette %q, bins %d, slice %d..%d): PNG differs (%d bytes, reference %d)",
				trial, palette, bins, startBin, endBin, len(got), len(want))
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
			if !bytes.Equal(got[k], want) {
				t.Fatalf("row %d reader %d: cached PNG differs from the per-tick render", i, k)
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

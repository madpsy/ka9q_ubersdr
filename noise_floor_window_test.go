package main

import (
	"math"
	"testing"
	"time"
)

// Regression tests for FFTBuffer's empty-window fallback.
//
// GetLatestFFT asks GetMaxHoldFFT for a window exactly one background poll
// period wide, and the ingest goroutine appends at that same nominal rate off
// an independent ticker. Jitter — or a few hundred ms of stall anywhere in the
// radiod → multicast → addBandSampleToBuffer path — therefore leaves the window
// empty on a small but steady fraction of ticks. The old fallback max-held the
// entire MaxAge buffer (a full minute, ~600 samples) in that case, lifting every
// bin to its 60-second peak: +7 to +11 dB band-wide, on every band at once,
// which is what made the band-activity charts jump and pulse.

// fftBufferWithRamp builds a buffer whose samples get quieter over time, so the
// newest sample is unambiguously distinguishable from a max-hold over the whole
// buffer: sample k (oldest first) sits at -100-k dB, the newest at -100-(n-1).
// Every sample is `spacing` older than the one after it, ending at `newest`.
func fftBufferWithRamp(t *testing.T, n int, spacing time.Duration, newest time.Time, bins int) *FFTBuffer {
	t.Helper()
	fb := NewFFTBuffer("test", 14000000, 14350000, 100, 60*time.Second)
	for k := 0; k < n; k++ {
		data := make([]float32, bins)
		for i := range data {
			data[i] = float32(-100 - k)
		}
		ts := newest.Add(-time.Duration(n-1-k) * spacing)
		fb.AddSample(ts, data)
	}
	return fb
}

func TestGetMaxHoldFFTEmptyWindowUsesNewestSampleOnly(t *testing.T) {
	const (
		bins    = 64
		samples = 600
		spacing = 100 * time.Millisecond
	)

	// Newest sample landed 250 ms ago; the window is 100 ms wide, so nothing
	// falls inside it — exactly the ingest-hiccup case.
	newest := time.Now().Add(-250 * time.Millisecond)
	fb := fftBufferWithRamp(t, samples, spacing, newest, bins)

	fft := fb.GetMaxHoldFFT(100 * time.Millisecond)
	if fft == nil {
		t.Fatal("GetMaxHoldFFT returned nil for a non-empty buffer")
	}
	if len(fft.Data) != bins {
		t.Fatalf("bin count = %d, want %d", len(fft.Data), bins)
	}

	// The newest sample is the quietest at -100-(samples-1); the oldest, which a
	// whole-buffer max-hold would surface, is -100.
	wantNewest := float32(-100 - (samples - 1))
	wantWholeBuffer := float32(-100)
	for i, v := range fft.Data {
		if v != wantNewest {
			t.Fatalf("bin %d = %.1f dB, want %.1f (the newest sample); "+
				"%.1f would mean the whole %v buffer was max-held",
				i, v, wantNewest, wantWholeBuffer, fb.MaxAge)
		}
	}
}

func TestGetMaxHoldFFTPopulatedWindowStillMaxHolds(t *testing.T) {
	const bins = 64

	// Three samples inside a 1 s window, the loudest in the middle: the window
	// path must keep max-holding, so the transient survives.
	fb := NewFFTBuffer("test", 14000000, 14350000, 100, 60*time.Second)
	now := time.Now()
	for k, db := range []float32{-120, -80, -118} {
		data := make([]float32, bins)
		for i := range data {
			data[i] = db
		}
		fb.AddSample(now.Add(-time.Duration(300*(2-k))*time.Millisecond), data)
	}

	fft := fb.GetMaxHoldFFT(1 * time.Second)
	if fft == nil {
		t.Fatal("GetMaxHoldFFT returned nil")
	}
	for i, v := range fft.Data {
		if v != -80 {
			t.Fatalf("bin %d = %.1f dB, want -80 (the in-window peak)", i, v)
		}
	}
}

func TestGetAveragedFFTEmptyWindowUsesNewestSampleOnly(t *testing.T) {
	const (
		bins    = 64
		samples = 600
		spacing = 100 * time.Millisecond
	)

	newest := time.Now().Add(-250 * time.Millisecond)
	fb := fftBufferWithRamp(t, samples, spacing, newest, bins)

	fft := fb.GetAveragedFFT(100 * time.Millisecond)
	if fft == nil {
		t.Fatal("GetAveragedFFT returned nil for a non-empty buffer")
	}

	// Averaging one sample reproduces it (within float32 → linear → float32
	// round-trip error). A whole-buffer average would be far louder, since the
	// linear-power mean is dominated by the oldest, loudest samples.
	wantNewest := float64(-100 - (samples - 1))
	for i, v := range fft.Data {
		if math.Abs(float64(v)-wantNewest) > 0.01 {
			t.Fatalf("bin %d = %.2f dB, want %.2f (the newest sample)", i, v, wantNewest)
		}
	}
}

func TestGetMaxHoldFFTNoSamplesReturnsNil(t *testing.T) {
	fb := NewFFTBuffer("test", 14000000, 14350000, 100, 60*time.Second)
	if got := fb.GetMaxHoldFFT(time.Second); got != nil {
		t.Fatalf("GetMaxHoldFFT on an empty buffer = %v, want nil", got)
	}
	if got := fb.GetAveragedFFT(time.Second); got != nil {
		t.Fatalf("GetAveragedFFT on an empty buffer = %v, want nil", got)
	}
}

// A single buffered sample must survive the empty-window path without an
// out-of-range index — the fallback slices fb.Samples[len-1:].
func TestGetMaxHoldFFTSingleStaleSample(t *testing.T) {
	const bins = 8
	fb := NewFFTBuffer("test", 14000000, 14350000, 100, 60*time.Second)
	data := make([]float32, bins)
	for i := range data {
		data[i] = -111
	}
	fb.AddSample(time.Now().Add(-5*time.Second), data)

	fft := fb.GetMaxHoldFFT(100 * time.Millisecond)
	if fft == nil {
		t.Fatal("GetMaxHoldFFT returned nil for a one-sample buffer")
	}
	for i, v := range fft.Data {
		if v != -111 {
			t.Fatalf("bin %d = %.1f dB, want -111", i, v)
		}
	}
}

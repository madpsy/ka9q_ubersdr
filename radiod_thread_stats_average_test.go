package main

import (
	"math"
	"testing"
)

// The point of the whole file: a thread whose true cost is 1.2% of a core is reported
// by thread-stats.py as 1.0% or 1.5%, because a 2-second window holds 200 jiffies and it
// can only ever return a whole number of them. The mean of those readings must land on
// the truth, not on either tick.
func TestThreadStatsAveragingBeatsTheJiffy(t *testing.T) {
	const truth = 1.2 // % of one core
	a := &threadStatsAverager{hist: map[string]*threadStatHistory{}}
	h := &threadStatHistory{}
	a.hist["lin 12345"] = h

	// Quantise the truth the way the sampler does, with the tick boundary landing in a
	// different place each window -- which is what an unsynchronised 2-second sampler
	// does to a thread doing steady work.
	for i := 0; i < threadStatsWindow; i++ {
		phase := float64(i) / float64(threadStatsWindow)
		h.add(0.5*math.Floor((truth/0.5)+phase), 3)
	}

	stats, samples, ok := a.Averaged()
	if !ok {
		t.Fatalf("averaged over %d samples but reported nothing", samples)
	}
	if samples != threadStatsWindow {
		t.Errorf("samples %d, want %d", samples, threadStatsWindow)
	}
	got := stats["lin 12345"].cpuPct
	if diff := math.Abs(got - truth); diff > 0.05 {
		t.Errorf("mean %.3f%%, want %.1f%% within 0.05 -- averaging is not removing the jiffy", got, truth)
	}
	// Every individual reading was one of the two ticks, so the mean is telling us
	// something no single sample could.
	if got == 1.0 || got == 1.5 {
		t.Errorf("mean landed exactly on a tick (%.3f%%), which means it is still quantised", got)
	}
}

// Too little history must not be dressed up as a measurement.
func TestThreadStatsWithholdsShortHistory(t *testing.T) {
	a := &threadStatsAverager{hist: map[string]*threadStatHistory{}}
	if _, _, ok := a.Averaged(); ok {
		t.Error("an empty averager offered an average")
	}

	h := &threadStatHistory{}
	a.hist["lin 1"] = h
	for i := 0; i < threadStatsMinSamples-1; i++ {
		h.add(1.5, 0)
	}
	if _, n, ok := a.Averaged(); ok {
		t.Errorf("offered an average over %d samples, below the %d minimum", n, threadStatsMinSamples)
	}
	h.add(1.5, 0)
	if _, _, ok := a.Averaged(); !ok {
		t.Errorf("withheld an average at the %d-sample minimum", threadStatsMinSamples)
	}

	// The count reported is the shortest history, not the longest: a band added a
	// moment ago must not borrow confidence from one that has been up for an hour.
	fresh := &threadStatHistory{}
	fresh.add(2.0, 0)
	a.hist["lin 2"] = fresh
	if _, n, ok := a.Averaged(); ok {
		t.Errorf("one 1-sample thread should hold the report back, got ok over %d", n)
	}
}

// The ring must forget, or a band whose cost changed would be averaged with its own
// history for the rest of the process's life.
func TestThreadStatsRingForgets(t *testing.T) {
	h := &threadStatHistory{}
	for i := 0; i < threadStatsWindow; i++ {
		h.add(4.0, 0)
	}
	if h.mean() != 4.0 {
		t.Fatalf("mean %.3f, want 4.0", h.mean())
	}
	for i := 0; i < threadStatsWindow; i++ {
		h.add(1.0, 0)
	}
	if h.n != threadStatsWindow {
		t.Errorf("history grew to %d, want it capped at %d", h.n, threadStatsWindow)
	}
	if diff := math.Abs(h.mean() - 1.0); diff > 1e-9 {
		t.Errorf("mean %.6f after a full window of new values, want 1.0 -- the ring is not forgetting", h.mean())
	}
}

// A threshold that only makes sense for one-sample readings must not be applied to
// averaged ones, or the fit keeps ignoring most of the bands.
func TestNoiseFloorCalibrationFloorFollowsTheSampleCount(t *testing.T) {
	if got := noiseFloorCalibrationFloor(1); got != noiseFloorCalibrationMinPct {
		t.Errorf("single sample: floor %.2f, want %.2f", got, noiseFloorCalibrationMinPct)
	}
	if got := noiseFloorCalibrationFloor(noiseFloorCalibrationAveragedSamples); got != noiseFloorCalibrationMinAveragedPct {
		t.Errorf("averaged: floor %.2f, want %.2f", got, noiseFloorCalibrationMinAveragedPct)
	}

	// The bands a real receiver reports: with one sample only the wide ones can be
	// fitted against, with an average all of them can.
	pct := func(v float64) *float64 { return &v }
	bands := []noiseFloorBandCost{
		{BinCount: 500, BinBandwidth: 5, MeasuredCPUPct: pct(0.4)},
		{BinCount: 500, BinBandwidth: 100, MeasuredCPUPct: pct(0.6)},
		{BinCount: 500, BinBandwidth: 200, MeasuredCPUPct: pct(0.8)},
		{BinCount: 1000, BinBandwidth: 200, MeasuredCPUPct: pct(1.2)},
		{BinCount: 2500, BinBandwidth: 200, MeasuredCPUPct: pct(2.5)},
	}
	if _, n := noiseFloorCalibration(bands, noiseFloorCalibrationFloor(1)); n != 1 {
		t.Errorf("one sample: fitted over %d bands, want 1", n)
	}
	if _, n := noiseFloorCalibration(bands, noiseFloorCalibrationFloor(threadStatsWindow)); n != len(bands) {
		t.Errorf("averaged: fitted over %d bands, want all %d", n, len(bands))
	}
}

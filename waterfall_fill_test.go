package main

import "testing"

// Exactly enough repeats to cover the operator's thinning, and no more. The count is
// what turns a thinned poll rate back into a full-rate scroll.
func TestWaterfallFillCoversExactlyTheThinning(t *testing.T) {
	for _, factor := range []int{1, 2, 3, 4, 8} {
		var f waterfallFill
		f.SetFactor(factor)
		f.Real()

		got := 0
		for i := 0; i < 20; i++ { // far more ticks than the gap can hold
			if f.Take() {
				got++
			}
		}
		if want := factor - 1; got != want {
			t.Errorf("factor %d: %d fills between real rows, want %d", factor, got, want)
		}
	}
}

// Divisor 1 means no thinning, so there is no gap and nothing to fill.
func TestWaterfallFillDoesNothingWithoutThinning(t *testing.T) {
	var f waterfallFill
	f.SetFactor(1)
	f.Real()
	if f.Take() {
		t.Error("filled a gap that does not exist at divisor 1")
	}
	// And a nonsense factor is not a licence to invent rows.
	for _, n := range []int{0, -1} {
		var g waterfallFill
		g.SetFactor(n)
		g.Real()
		if g.Take() {
			t.Errorf("factor %d: filled anyway", n)
		}
	}
}

// Nothing may be sent before a real row exists: there is nothing to repeat, and after
// a zoom the encoder state is reset so a stale row would decode against the wrong
// prediction.
func TestWaterfallFillWaitsForARealRow(t *testing.T) {
	var f waterfallFill
	f.SetFactor(4)
	for i := 0; i < 5; i++ {
		if f.Take() {
			t.Fatal("filled before any real row had been sent")
		}
	}
	f.Real()
	if !f.Take() {
		t.Error("did not fill once a real row was available")
	}
}

// The allowance is per gap, so every real row re-arms it.
func TestWaterfallFillResetsOnEveryRealRow(t *testing.T) {
	var f waterfallFill
	f.SetFactor(3)
	total := 0
	for gap := 0; gap < 4; gap++ {
		f.Real()
		for i := 0; i < 10; i++ {
			if f.Take() {
				total++
			}
		}
	}
	if want := 4 * 2; total != want {
		t.Errorf("%d fills across 4 gaps at factor 3, want %d", total, want)
	}
}

// The bound is what keeps a radiod stall visible. Without it the waterfall scrolls
// forever on a frozen spectrum, which reads as a working receiver showing dead air --
// worse than one that plainly stops.
func TestWaterfallFillStopsWhenRadiodStalls(t *testing.T) {
	var f waterfallFill
	f.SetFactor(2)
	f.Real()

	if !f.Take() {
		t.Fatal("no fill at all for the one-row gap")
	}
	// radiod has now gone quiet. Every later tick must be refused.
	for i := 0; i < 100; i++ {
		if f.Take() {
			t.Fatalf("still filling %d ticks into a stall; the waterfall would never stop", i)
		}
	}
}

// A config reload can move the divisor under a live connection.
func TestWaterfallFillFollowsAChangedFactor(t *testing.T) {
	var f waterfallFill
	f.SetFactor(2)
	f.Real()
	if got := countFills(&f, 10); got != 1 {
		t.Errorf("factor 2: %d fills, want 1", got)
	}
	f.SetFactor(4)
	f.Real()
	if got := countFills(&f, 10); got != 3 {
		t.Errorf("factor 4 after a reload: %d fills, want 3", got)
	}
	// Narrowing mid-gap must not hand out an allowance already spent.
	f.SetFactor(4)
	f.Real()
	_ = f.Take()
	_ = f.Take()
	f.SetFactor(2)
	if f.Take() {
		t.Error("narrowing the factor mid-gap allowed a fill already spent")
	}
}

func countFills(f *waterfallFill, ticks int) int {
	n := 0
	for i := 0; i < ticks; i++ {
		if f.Take() {
			n++
		}
	}
	return n
}

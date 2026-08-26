package ft8

import (
	"math"
	"testing"
)

// max_candidates arrives in the browser's attach message. It sizes the
// candidate slice and bounds the insert loop, and the code consuming it runs on
// a goroutine with no recover() — so before these guards existed, an attach of
// {"max_candidates": 0} or {"max_candidates": -1} did not merely fail the
// session, it panicked and took the whole server process down.
func TestFindCandidatesSurvivesHostileBounds(t *testing.T) {
	wf := &Waterfall{}
	for _, n := range []int{-1 << 62, -1, 0, 1, MaxMaxCandidates, 1 << 40} {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("FindCandidates(maxCandidates=%d) panicked: %v", n, r)
				}
			}()
			_ = FindCandidates(wf, n, 0)
		}()
	}
}

func TestInsertCandidateSurvivesHostileBounds(t *testing.T) {
	for _, n := range []int{-1 << 62, -1, 0} {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("insertCandidate(maxCandidates=%d) panicked: %v", n, r)
				}
			}()
			got := insertCandidate(make([]Candidate, 0), Candidate{Score: 5}, n)
			if len(got) == 0 {
				t.Errorf("maxCandidates=%d dropped the candidate entirely", n)
			}
		}()
	}
}

// And the attach itself refuses the value rather than relying on the guards
// downstream, so a client sending nonsense is told about it.
func TestAttachRejectsHostileMaxCandidates(t *testing.T) {
	params := AudioExtensionParams{SampleRate: 12000, Channels: 1, BitsPerSample: 16}

	bad := []float64{-1, 0, math.NaN(), math.Inf(1), math.Inf(-1), 1e300, MaxMaxCandidates + 1}
	for _, v := range bad {
		if _, err := NewFT8Extension(params, map[string]interface{}{"max_candidates": v}); err == nil {
			t.Errorf("max_candidates=%v was accepted, want refused", v)
		}
	}

	good := []float64{1, 140, MaxMaxCandidates}
	for _, v := range good {
		if _, err := NewFT8Extension(params, map[string]interface{}{"max_candidates": v}); err != nil {
			t.Errorf("max_candidates=%v refused (%v), want accepted", v, err)
		}
	}
}

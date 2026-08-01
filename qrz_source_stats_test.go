package main

import (
	"sync"
	"testing"
)

// recordSource is the only writer to the per-source tallies, and it runs on
// every lookup from every component — including the CW skimmer's per-spot
// goroutines and the voice-activity fill workers — so it must be safe under
// concurrency and must not lose counts.
func TestQRZSourceStatsConcurrent(t *testing.T) {
	s := NewQRZService(QRZConfig{}, 0)

	const (
		goroutinesPerSource = 50
		callsPerGoroutine   = 200
	)
	sources := []string{qrzSourceAPI, qrzSourceCWSkimmer, qrzSourceVoiceActivity}

	var wg sync.WaitGroup
	for _, src := range sources {
		for i := 0; i < goroutinesPerSource; i++ {
			wg.Add(1)
			go func(src string, i int) {
				defer wg.Done()
				for n := 0; n < callsPerGoroutine; n++ {
					// Alternate between a cache hit and an outbound fetch so
					// both sub-counters are exercised.
					s.recordSource(src, n%2 == 0, n%2 == 1)
				}
			}(src, i)
		}
	}
	wg.Wait()

	stats := s.SourceStats()
	if len(stats) != len(sources) {
		t.Fatalf("got %d sources, want %d: %+v", len(stats), len(sources), stats)
	}

	wantPerSource := int64(goroutinesPerSource * callsPerGoroutine)
	for _, st := range stats {
		if st.Lookups != wantPerSource {
			t.Errorf("source %q: lookups = %d, want %d", st.Source, st.Lookups, wantPerSource)
		}
		// Every lookup was recorded as exactly one of hit/fetch, so the two
		// sub-counters must account for the total with nothing double-counted.
		if st.CacheHits+st.APICalls != st.Lookups {
			t.Errorf("source %q: cache_hits(%d) + api_calls(%d) != lookups(%d)",
				st.Source, st.CacheHits, st.APICalls, st.Lookups)
		}
	}
}

// An unlabelled caller must be counted, not dropped — that is the whole point
// of routing Lookup() through LookupFrom with a qrzSourceUnknown default.
func TestQRZSourceStatsUnknownDefault(t *testing.T) {
	s := NewQRZService(QRZConfig{}, 0)
	s.recordSource("", false, false)

	stats := s.SourceStats()
	if len(stats) != 1 {
		t.Fatalf("got %d sources, want 1: %+v", len(stats), stats)
	}
	if stats[0].Source != qrzSourceUnknown {
		t.Errorf("empty source label recorded as %q, want %q", stats[0].Source, qrzSourceUnknown)
	}
	if stats[0].Lookups != 1 {
		t.Errorf("lookups = %d, want 1", stats[0].Lookups)
	}
}

// SourceStats drives a table in the admin UI that is meant to read busiest-first.
func TestQRZSourceStatsSortedByVolume(t *testing.T) {
	s := NewQRZService(QRZConfig{}, 0)
	for i := 0; i < 3; i++ {
		s.recordSource(qrzSourceAPI, true, false)
	}
	for i := 0; i < 10; i++ {
		s.recordSource(qrzSourceVoiceActivity, true, false)
	}
	s.recordSource(qrzSourceTelegram, true, false)

	stats := s.SourceStats()
	want := []string{qrzSourceVoiceActivity, qrzSourceAPI, qrzSourceTelegram}
	if len(stats) != len(want) {
		t.Fatalf("got %d sources, want %d", len(stats), len(want))
	}
	for i, w := range want {
		if stats[i].Source != w {
			t.Errorf("position %d: got %q, want %q (full: %+v)", i, stats[i].Source, w, stats)
		}
	}
}

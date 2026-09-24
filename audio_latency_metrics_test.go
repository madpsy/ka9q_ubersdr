package main

import (
	"math"
	"sync"
	"testing"
	"time"
)

// Every value must land in the bucket whose bounds contain it, and bounds must
// rise by about sqrt(2) per step so that percentiles stay within that factor.
func TestAudioLatencyBucketBounds(t *testing.T) {
	for us := uint64(0); us < 1<<21; us++ {
		idx := audioLatencyBucket(us)
		if lo := audioLatencyBucketLowerUs(idx); us < lo {
			t.Fatalf("%d µs in bucket %d below its lower bound %d", us, idx, lo)
		}
		if idx+1 < audioLatencyBuckets {
			if hi := audioLatencyBucketLowerUs(idx + 1); us >= hi {
				t.Fatalf("%d µs in bucket %d at or above the next bound %d", us, idx, hi)
			}
		}
	}
	for i := 2; i < audioLatencyBuckets; i++ {
		r := float64(audioLatencyBucketLowerUs(i)) / float64(audioLatencyBucketLowerUs(i-1))
		if r < 1.33 || r > 1.5 {
			t.Fatalf("bucket %d is %.2fx the previous, want about sqrt(2)", i, r)
		}
	}
	if got := audioLatencyBucket(math.MaxUint64); got != audioLatencyBuckets-1 {
		t.Fatalf("huge value in bucket %d, want the last", got)
	}
}

func TestAudioLatencyWindowsAndPercentiles(t *testing.T) {
	m := newAudioLatencyMetrics()
	base := time.Now().Unix()

	// 100 Opus packets at 100 µs and 5 slow ones at 10 ms, all this minute.
	for i := 0; i < 100; i++ {
		m.minutes.record(base, audioLatencyOpus, audioLatencyBucket(100), 100_000)
	}
	for i := 0; i < 5; i++ {
		m.minutes.record(base, audioLatencyOpus, audioLatencyBucket(10_000), 10_000_000)
	}
	// 61 minutes old: in a neighbouring slot but outside the 60-minute window.
	// (Exactly 60 would reuse this minute's slot and reset it.)
	m.minutes.record(base-3660, audioLatencyOpus, audioLatencyBucket(50), 50_000)

	a := m.minutes.sum(base, audioLatencyMinutes, audioLatencyOpus)
	if a.count != 105 {
		t.Fatalf("count = %d, want 105", a.count)
	}
	s := a.stats()
	if s.P50Us < 64 || s.P50Us > 128 {
		t.Fatalf("p50 = %.1f µs, want within the 100 µs bucket", s.P50Us)
	}
	if s.P99Us < 5000 || s.MaxUs != 10_000 {
		t.Fatalf("p99 = %.1f, max = %.1f; want the slow tail reflected", s.P99Us, s.MaxUs)
	}
	if want := (100*100.0 + 5*10_000.0) / 105; math.Abs(s.MeanUs-want) > 0.01 {
		t.Fatalf("mean = %.2f, want %.2f", s.MeanUs, want)
	}

	// Formats are kept apart.
	if p := m.minutes.sum(base, audioLatencyMinutes, audioLatencyPCMv4); p.count != 0 {
		t.Fatalf("pcmv4 picked up %d opus samples", p.count)
	}

	// The 5-minute window excludes a sample from 10 minutes ago.
	m.minutes.record(base-600, audioLatencyPCMv4, audioLatencyBucket(20), 20_000)
	if p := m.minutes.sum(base, 5, audioLatencyPCMv4); p.count != 0 {
		t.Fatalf("5m window counted a 10-minute-old sample")
	}
	if p := m.minutes.sum(base, audioLatencyMinutes, audioLatencyPCMv4); p.count != 1 {
		t.Fatalf("1h window missed a 10-minute-old sample")
	}
}

func TestAudioLatencySlotReuseResets(t *testing.T) {
	r := newAudioLatencyRing(60, audioLatencyMinutes)
	base := time.Now().Unix()
	r.record(base, audioLatencyOpus, 5, 1000)
	// Same slot index an hour later: the old sample must be gone.
	r.record(base+3600, audioLatencyOpus, 7, 2000)
	a := r.sum(base+3600, audioLatencyMinutes, audioLatencyOpus)
	if a.count != 1 || a.counts[7] != 1 || a.maxNs != 2000 {
		t.Fatalf("slot not reset on reuse: %+v", a)
	}
}

func TestAudioLatencyRecordDropsBadClocks(t *testing.T) {
	m := newAudioLatencyMetrics()
	now := time.Now()
	m.Record(audioLatencyOpus, now.Add(time.Second).UnixNano(), now) // in the future
	m.Record(audioLatencyOpus, 0, now)                               // unset
	if a := m.minutes.sum(time.Now().Unix(), 1, audioLatencyOpus); a.count != 0 {
		t.Fatalf("recorded %d samples with an unusable arrival time", a.count)
	}
	m.Record(audioLatencyOpus, now.Add(-300*time.Microsecond).UnixNano(), now)
	if a := m.minutes.sum(time.Now().Unix(), 1, audioLatencyOpus); a.count != 1 {
		t.Fatalf("valid sample not recorded")
	}
}

// Many sessions record at once; nothing may be lost within a minute.
func TestAudioLatencyConcurrentRecord(t *testing.T) {
	m := newAudioLatencyMetrics()
	var wg sync.WaitGroup
	for g := 0; g < 32; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 2000; i++ {
				now := time.Now()
				m.Record(audioLatencyPCMv4, now.Add(-50*time.Microsecond).UnixNano(), now)
			}
		}()
	}
	wg.Wait()
	snap := m.Snapshot()["windows"].(map[string]interface{})["1h"].(map[string]AudioLatencyStats)
	if got := snap["pcmv4"].Count; got != 64000 {
		t.Fatalf("count = %d, want 64000", got)
	}
}

// The chart series has one point per period, oldest first, and a period with
// no packets reads as zero rather than borrowing a stale slot's data.
func TestAudioLatencySeries(t *testing.T) {
	m := newAudioLatencyMetrics()
	now := time.Now()
	sec := now.Unix()
	m.minutes.record(sec, audioLatencyOpus, audioLatencyBucket(100), 100_000)
	m.minutes.record(sec-120, audioLatencyPCMv4, audioLatencyBucket(40), 40_000)
	m.minutes.record(sec-3660, audioLatencyOpus, audioLatencyBucket(9), 9_000) // too old

	pts := m.minutes.series(sec, audioLatencyMinutes)
	if len(pts) != audioLatencyMinutes {
		t.Fatalf("%d points, want %d", len(pts), audioLatencyMinutes)
	}
	if want := (sec / 60) * 60 * 1000; pts[59]["start_ms"] != want {
		t.Fatalf("last point starts at %v, want %d", pts[59]["start_ms"], want)
	}
	if p := pts[59]["opus"].(AudioLatencyPoint); p.Count != 1 || p.MaxUs != 100 {
		t.Fatalf("current minute opus = %+v", p)
	}
	if p := pts[57]["pcmv4"].(AudioLatencyPoint); p.Count != 1 {
		t.Fatalf("two minutes ago pcmv4 = %+v", p)
	}
	var total uint64
	for _, pt := range pts {
		total += pt["opus"].(AudioLatencyPoint).Count + pt["pcmv4"].(AudioLatencyPoint).Count
	}
	if total != 2 {
		t.Fatalf("series holds %d packets, want 2 (a stale slot leaked in)", total)
	}
}

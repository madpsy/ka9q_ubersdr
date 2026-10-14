package main

// Voice-activity detection against its pre-optimisation copy in
// voice_activity_ref_test.go. The noise floor is now selected rather than
// sorted for, and estimated once per frame rather than twice; neither may
// change a floor, a candidate or a reported activity.

import (
	"math"
	"math/rand"
	"reflect"
	"slices"
	"sort"
	"testing"
	"time"
)

// TestSelectFloat32MatchesSort checks the selection against a sort at every
// index of small arrays, which is where partitioning goes wrong if it does.
func TestSelectFloat32MatchesSort(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for trial := 0; trial < 3000; trial++ {
		n := 1 + rng.Intn(40)
		src := make([]float32, n)
		levels := 1 + rng.Intn(6) // few levels, many ties
		for i := range src {
			if trial%2 == 0 {
				src[i] = float32(rng.Intn(levels))
			} else {
				src[i] = float32(rng.NormFloat64())
			}
		}
		want := append([]float32(nil), src...)
		slices.Sort(want)
		for k := 0; k < n; k++ {
			s := append([]float32(nil), src...)
			if got := selectFloat32(s, k); got != want[k] {
				t.Fatalf("trial %d n=%d k=%d: got %v want %v (input %v)", trial, n, k, got, want[k], src)
			}
		}
	}
}

// bandFrame is one FFT frame of a band: a sloping noise floor, plus whatever
// the caller adds on top.
func bandFrame(rng *rand.Rand, bins int) []float32 {
	f := make([]float32, bins)
	for i := range f {
		f[i] = float32(-112 + 6*float64(i)/float64(bins) + rng.NormFloat64()*2)
	}
	return f
}

// TestNoiseFloorMatchesReference: the same floor, to the bit, over band-like
// frames and over the shapes that stress a selection -- every value equal,
// already sorted either way, a handful of levels, the no-data sentinel, and
// NaNs, which keep the old sort.
func TestNoiseFloorMatchesReference(t *testing.T) {
	rng := rand.New(rand.NewSource(2))
	for trial := 0; trial < 4000; trial++ {
		n := rng.Intn(3000)
		var d []float32
		switch trial % 8 {
		case 0, 1, 2:
			d = bandFrame(rng, n)
		case 3:
			d = make([]float32, n)
			for i := range d {
				d[i] = -100
			}
		case 4:
			d = bandFrame(rng, n)
			slices.Sort(d)
		case 5:
			d = bandFrame(rng, n)
			sort.Slice(d, func(i, j int) bool { return d[i] > d[j] })
		case 6:
			d = make([]float32, n)
			for i := range d {
				d[i] = float32(-120 + 0.5*float64(rng.Intn(8)))
				if rng.Intn(20) == 0 {
					d[i] = float32(math.Inf(-1))
				}
			}
		case 7:
			d = bandFrame(rng, n)
			for i := range d {
				if rng.Intn(100) == 0 {
					d[i] = float32(math.NaN())
				}
			}
		}
		want := refEstimateNoiseFloorMedianFilter(d, 1000, 3000, 200, 14000000)
		got := estimateNoiseFloorMedianFilter(d, 1000, 3000, 200, 14000000)
		if math.Float32bits(got) != math.Float32bits(want) {
			t.Fatalf("trial %d (shape %d, %d bins): floor %v, reference %v", trial, trial%8, n, got, want)
		}
	}
}

// voiceBuffer builds five seconds of a 20 m-like band at ten frames a second:
// SSB voice signals with formant ripple and syllabic level changes, a steady
// carrier, an FT8-like block of narrow tones and a flat wideband hump --
// signals the detector should report and signals it should reject, spaced so
// no candidate can overlap two tracked regions (where the tracker's choice
// between them depends on map order, in the reference as much as here).
func voiceBuffer(rng *rand.Rand, bins int, now time.Time) *FFTBuffer {
	const binWidth = 200.0
	buf := NewFFTBuffer("20m", 14000000, 14000000+uint64(bins)*binWidth, binWidth, 10*time.Second)
	voices := []int{bins / 8, bins / 3, bins / 2, 3 * bins / 4}
	for f := 0; f < 50; f++ {
		d := bandFrame(rng, bins)
		for _, v := range voices {
			level := []float32{0, 10, 18, 24, 14}[rng.Intn(5)] // syllables and pauses
			if level == 0 {
				continue
			}
			for b := 0; b < 14; b++ {
				ramp := float32(1)
				if b < 2 {
					ramp = 0.5
				}
				d[v+b] += ramp*level + float32(4*math.Sin(float64(b)*1.3)) + float32(rng.NormFloat64())
			}
		}
		d[bins/4] += 40 // carrier
		for b := 0; b < 10; b += 3 {
			d[5*bins/8+b] += 20 // narrow digital tones
		}
		for b := 0; b < 12; b++ {
			d[7*bins/8+b] += 12 // flat hump
		}
		buf.AddSample(now.Add(time.Duration(f-49)*100*time.Millisecond), d)
	}
	return buf
}

// candidateFields drops the wall-clock times a candidate is stamped with,
// which no two runs share.
func candidateFields(c []CandidateRegion) []CandidateRegion {
	out := append([]CandidateRegion(nil), c...)
	for i := range out {
		out[i].FirstSeen, out[i].LastSeen = time.Time{}, time.Time{}
	}
	return out
}

func TestCandidateRegionsMatchReference(t *testing.T) {
	rng := rand.New(rand.NewSource(3))
	params := DefaultDetectionParams()
	buf := voiceBuffer(rng, 1750, time.Now())
	found := 0
	for _, fr := range buf.Samples {
		floor := estimateNoiseFloorMedianFilter(fr.Data, 1000, 3000, buf.BinWidth, buf.StartFreq)
		thr := floor + params.ThresholdDB
		want := refDetectCandidateRegions(fr.Data, thr, buf.BinWidth, buf.StartFreq, params)
		got := detectCandidateRegionsWithFloor(fr.Data, thr, floor, buf.BinWidth, buf.StartFreq, params)
		if !reflect.DeepEqual(candidateFields(got), candidateFields(want)) {
			t.Fatalf("candidates differ:\n got %+v\nwant %+v", got, want)
		}
		found += len(got)
	}
	if found == 0 {
		t.Fatal("no candidates in the synthetic band; the comparison proves nothing")
	}
}

// TestVoiceActivityMatchesReference is the end-to-end check: the activities
// reported for the band, field for field, over many independent bands.
func TestVoiceActivityMatchesReference(t *testing.T) {
	rng := rand.New(rand.NewSource(4))
	params := DefaultDetectionParams()
	reported := 0
	for trial := 0; trial < 40; trial++ {
		// Frames stamped an hour ahead stay inside the scan's window however
		// long the two scans take; otherwise the oldest can age out between
		// them, as it did under the race detector.
		buf := voiceBuffer(rng, 1000+rng.Intn(1500), time.Now().Add(time.Hour))
		want := refDetectVoiceActivityMultiFrame(buf, params, 5*time.Second)
		got := detectVoiceActivityMultiFrame(buf, params, 5*time.Second)
		byStart := func(a []VoiceActivity) {
			sort.Slice(a, func(i, j int) bool { return a[i].StartBin < a[j].StartBin })
		}
		byStart(want)
		byStart(got)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("trial %d: activities differ:\n got %+v\nwant %+v", trial, got, want)
		}
		reported += len(got)
	}
	if reported == 0 {
		t.Fatal("no voice reported in any synthetic band; the comparison proves nothing")
	}
	t.Logf("%d activities reported across 40 bands, identical to the reference", reported)
}

// TestSingleFrameVoiceActivityMatchesReference covers detectVoiceActivity, the
// single-frame path, where the floor handed to candidate detection reaches
// the reported SNR.
func TestSingleFrameVoiceActivityMatchesReference(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	params := DefaultDetectionParams()
	reported := 0
	for trial := 0; trial < 40; trial++ {
		buf := voiceBuffer(rng, 1000+rng.Intn(1500), time.Now())
		for _, fr := range buf.Samples[len(buf.Samples)-5:] {
			fft := &BandFFT{Data: fr.Data, BinWidth: buf.BinWidth, StartFreq: buf.StartFreq, EndFreq: buf.EndFreq}
			want := refDetectVoiceActivity(fft, params)
			got := detectVoiceActivity(fft, params)
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("trial %d: activities differ:\n got %+v\nwant %+v", trial, got, want)
			}
			reported += len(got)
		}
	}
	if reported == 0 {
		t.Fatal("no voice reported in any frame; the comparison proves nothing")
	}
	t.Logf("%d single-frame activities, identical to the reference", reported)
}

// The two benchmarks are one band's scan as the MQTT publisher runs it every
// second for every band: five seconds of frames, 1750 bins (20 m at 200 Hz).
func benchVoiceScan(b *testing.B, scan func(*FFTBuffer, DetectionParams, time.Duration) []VoiceActivity) {
	buf := voiceBuffer(rand.New(rand.NewSource(5)), 1750, time.Now().Add(time.Hour))
	params := DefaultDetectionParams()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		scan(buf, params, 2*time.Hour)
	}
}

func BenchmarkVoiceActivityScanRef(b *testing.B) { benchVoiceScan(b, refDetectVoiceActivityMultiFrame) }
func BenchmarkVoiceActivityScan(b *testing.B)    { benchVoiceScan(b, detectVoiceActivityMultiFrame) }

func BenchmarkNoiseFloorRef(b *testing.B) {
	d := bandFrame(rand.New(rand.NewSource(6)), 1750)
	for i := 0; i < b.N; i++ {
		refEstimateNoiseFloorMedianFilter(d, 0, 0, 200, 0)
	}
}

func BenchmarkNoiseFloor(b *testing.B) {
	d := bandFrame(rand.New(rand.NewSource(6)), 1750)
	for i := 0; i < b.N; i++ {
		estimateNoiseFloorMedianFilter(d, 0, 0, 200, 0)
	}
}

package main

// Wire-identity guard for the v2 spectrum encoder.
//
// The encoder in user_spectrum_v2.go is optimised (one encode pass instead of
// three, integer delta comparison, reused scratch buffers). This file keeps the
// original, straightforward implementation as a reference and drives both in
// lockstep over generated streams -- drops, bin-count changes, gain jumps,
// non-finite bins, oversized deltas -- requiring byte-identical packets and
// identical encoder state on every frame. If an optimisation ever changes a
// single wire byte, this fails and names the frame.

import (
	"bytes"
	"encoding/binary"
	"math"
	"math/rand"
	"testing"
)

// ── reference implementation: the pre-optimisation encoder, verbatim ─────────

type spectrumV2RefState struct {
	scale     spectrumV2Scale
	previous  []uint8
	sequence  uint16
	sinceFull int
	forceFull bool
}

func (s spectrumV2Scale) fitsRef(db float32) bool {
	f := float64(db)
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return true
	}
	code := (f*100 - float64(s.refCentiDB)) / float64(s.stepCentiDB)
	return code >= 0 && code <= 255
}

func spectrumV2EncodeRef(st *spectrumV2RefState, data []float32, timestampNanos uint64, centreFreq uint64, deltaThresholdDB float64) (packet []byte, full bool, codes []uint8) {
	n := len(data)
	st.sequence++

	full = st.previous == nil || len(st.previous) != n ||
		st.forceFull || st.sinceFull >= spectrumV2KeyframeInterval

	scale := st.scale
	if full {
		scale = spectrumV2ChooseScale(data)
	}
	codes = make([]uint8, n)
	for i, v := range data {
		codes[i] = scale.encode(v)
	}

	if !full {
		for _, v := range data {
			if !scale.fitsRef(v) {
				full = true
				break
			}
		}
		if full {
			scale = spectrumV2ChooseScale(data)
			for i, v := range data {
				codes[i] = scale.encode(v)
			}
		}
	}

	var mask []byte
	var values []uint8
	if !full {
		maskLen := (n + 7) / 8
		mask = make([]byte, maskLen)
		values = make([]uint8, 0, n)
		thresholdCodes := deltaThresholdDB * 100 / float64(scale.stepCentiDB)
		for i := 0; i < n; i++ {
			if math.Abs(float64(codes[i])-float64(st.previous[i])) > thresholdCodes {
				mask[i>>3] |= 1 << (uint(i) & 7)
				values = append(values, codes[i])
			} else {
				codes[i] = st.previous[i]
			}
		}
		if maskLen+len(values) >= n {
			full = true
			scale = spectrumV2ChooseScale(data)
			for i, v := range data {
				codes[i] = scale.encode(v)
			}
		}
	}

	if full {
		packet = make([]byte, spectrumV2HeaderSize+3+n)
	} else {
		packet = make([]byte, spectrumV2HeaderSize+len(mask)+len(values))
	}
	copy(packet[0:4], []byte{'S', 'P', 'E', 'C'})
	packet[4] = SpectrumV2Version
	if full {
		packet[5] = SpectrumV2FlagFull
	} else {
		packet[5] = SpectrumV2FlagDelta
	}
	binary.LittleEndian.PutUint16(packet[6:8], st.sequence)
	binary.LittleEndian.PutUint64(packet[8:16], timestampNanos)
	binary.LittleEndian.PutUint64(packet[16:24], centreFreq)

	off := spectrumV2HeaderSize
	if full {
		binary.LittleEndian.PutUint16(packet[off:], uint16(scale.refCentiDB))
		packet[off+2] = scale.stepCentiDB
		copy(packet[off+3:], codes)
	} else {
		copy(packet[off:], mask)
		copy(packet[off+len(mask):], values)
	}

	st.scale = scale
	return packet, full, codes
}

func spectrumV2CommitRef(st *spectrumV2RefState, codes []uint8, full bool) {
	if len(st.previous) != len(codes) {
		st.previous = make([]uint8, len(codes))
	}
	copy(st.previous, codes)
	st.forceFull = false
	if full {
		st.sinceFull = 0
	} else {
		st.sinceFull++
	}
}

// ── lockstep test ────────────────────────────────────────────────────────────

// wireStreamFrame produces frame t of a synthetic stream exercising drift,
// fading carriers, gain jumps that force scale re-keys, occasional non-finite
// bins, and frames where the delta outgrows a full frame.
func wireStreamFrame(rng *rand.Rand, t int, n int) []float32 {
	data := realisticSpectrum(rng, n, t)
	if t%97 == 0 {
		for i := range data {
			data[i] += 25
		}
	}
	if t%53 == 0 {
		data[rng.Intn(n)] = float32(math.NaN())
		data[rng.Intn(n)] = float32(math.Inf(1))
		data[rng.Intn(n)] = float32(math.Inf(-1))
	}
	if t%211 == 0 {
		for i := range data {
			data[i] += float32(rng.NormFloat64() * 40)
		}
	}
	return data
}

func TestSpectrumV2WireIdenticalToReference(t *testing.T) {
	for _, seed := range []int64{1, 2, 3, 4, 5} {
		rng := rand.New(rand.NewSource(seed))
		drops := rand.New(rand.NewSource(seed + 100))
		var ref spectrumV2RefState
		var opt spectrumV2State
		n := 1024
		for frame := 0; frame < 3000; frame++ {
			if frame == 1500 {
				n = 512 // bin-count change mid-stream
			}
			data := wireStreamFrame(rng, frame, n)
			ts, cf := uint64(frame)*1e8, uint64(7_100_000)
			pa, fa, ca := spectrumV2EncodeRef(&ref, data, ts, cf, 2.0)
			pb, fb, cb := spectrumV2Encode(&opt, data, ts, cf, 2.0)
			if fa != fb {
				t.Fatalf("seed %d frame %d: full flag differs: ref %v got %v", seed, frame, fa, fb)
			}
			if !bytes.Equal(pa, pb) {
				t.Fatalf("seed %d frame %d: packet differs (ref %d bytes, got %d bytes)", seed, frame, len(pa), len(pb))
			}
			if !bytes.Equal(ca, cb) {
				t.Fatalf("seed %d frame %d: codes differ", seed, frame)
			}
			if drops.Intn(10) == 0 { // simulate the non-blocking write dropping
				ref.forceFull = true
				spectrumV2Dropped(&opt)
			} else {
				spectrumV2CommitRef(&ref, ca, fa)
				spectrumV2Commit(&opt, cb, fb)
			}
			if !bytes.Equal(ref.previous, opt.previous) {
				t.Fatalf("seed %d frame %d: previous state differs", seed, frame)
			}
			if ref.scale != opt.scale || ref.sequence != opt.sequence ||
				ref.sinceFull != opt.sinceFull || ref.forceFull != opt.forceFull {
				t.Fatalf("seed %d frame %d: encoder state differs", seed, frame)
			}
		}
	}
}

// ── benchmarks ───────────────────────────────────────────────────────────────

func wireBenchFrames(n, count int) [][]float32 {
	rng := rand.New(rand.NewSource(42))
	frames := make([][]float32, count)
	for t := 0; t < count; t++ {
		frames[t] = realisticSpectrum(rng, n, t)
	}
	return frames
}

func BenchmarkSpectrumV2Encode(b *testing.B) {
	frames := wireBenchFrames(1024, 256)
	var st spectrumV2State
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, full, codes := spectrumV2Encode(&st, frames[i%256], uint64(i), 7_100_000, 2.0)
		spectrumV2Commit(&st, codes, full)
	}
}

func BenchmarkSpectrumV2EncodeReference(b *testing.B) {
	frames := wireBenchFrames(1024, 256)
	var st spectrumV2RefState
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, full, codes := spectrumV2EncodeRef(&st, frames[i%256], uint64(i), 7_100_000, 2.0)
		spectrumV2CommitRef(&st, codes, full)
	}
}

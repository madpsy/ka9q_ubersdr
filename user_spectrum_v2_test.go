package main

import (
	"encoding/binary"
	"math"
	"math/rand"
	"testing"
)

// A decoder, mirroring what a client does, so the tests check the wire rather
// than the encoder's opinion of itself.
type spectrumV2Decoder struct {
	scale    spectrumV2Scale
	bins     []uint8
	haveFull bool
	lastSeq  uint16
	seenSeq  bool
	gaps     int
}

func (d *spectrumV2Decoder) decode(pkt []byte) ([]float32, error) {
	if len(pkt) < spectrumV2HeaderSize {
		return nil, errf("short packet: %d bytes", len(pkt))
	}
	if string(pkt[0:4]) != "SPEC" {
		return nil, errf("bad magic")
	}
	if pkt[4] != SpectrumV2Version {
		return nil, errf("version %d", pkt[4])
	}
	seq := binary.LittleEndian.Uint16(pkt[6:8])
	if d.seenSeq && seq != d.lastSeq+1 {
		d.gaps++
	}
	d.lastSeq, d.seenSeq = seq, true

	off := spectrumV2HeaderSize
	switch pkt[5] {
	case SpectrumV2FlagFull:
		if len(pkt) < off+3 {
			return nil, errf("truncated scale")
		}
		d.scale = spectrumV2Scale{
			refCentiDB:  int16(binary.LittleEndian.Uint16(pkt[off:])),
			stepCentiDB: pkt[off+2],
		}
		if d.scale.stepCentiDB == 0 {
			return nil, errf("zero step")
		}
		d.bins = append([]uint8(nil), pkt[off+3:]...)
		d.haveFull = true
	case SpectrumV2FlagDelta:
		if !d.haveFull {
			return nil, errf("delta before any full frame")
		}
		maskLen := (len(d.bins) + 7) / 8
		if len(pkt) < off+maskLen {
			return nil, errf("truncated mask")
		}
		mask := pkt[off : off+maskLen]
		vals := pkt[off+maskLen:]
		vi := 0
		for i := range d.bins {
			if mask[i>>3]&(1<<(uint(i)&7)) == 0 {
				continue
			}
			if vi >= len(vals) {
				return nil, errf("truncated values at bin %d", i)
			}
			d.bins[i] = vals[vi]
			vi++
		}
		if vi != len(vals) {
			return nil, errf("%d values left over", len(vals)-vi)
		}
	default:
		return nil, errf("unknown flags 0x%02x", pkt[5])
	}
	out := make([]float32, len(d.bins))
	for i, c := range d.bins {
		out[i] = d.scale.decode(c)
	}
	return out, nil
}

func errf(f string, a ...interface{}) error { return &sv2err{msgf(f, a...)} }

type sv2err struct{ s string }

func (e *sv2err) Error() string { return e.s }

func msgf(f string, a ...interface{}) string {
	return sprintf(f, a...)
}

// realisticSpectrum builds bins resembling a live receiver: a noise floor
// around -100 dBFS with a few signals on it, drifting slowly.
func realisticSpectrum(rng *rand.Rand, n int, t int) []float32 {
	out := make([]float32, n)
	for i := range out {
		v := -100 + rng.NormFloat64()*2
		if i%137 == 0 {
			v += 30 + 10*math.Sin(float64(t)/8)
		}
		out[i] = float32(v)
	}
	return out
}

// The encoding must land within half a step of the truth -- version 1
// truncated, which biased every reading a whole step low.
func TestSpectrumV2QuantisationAccuracy(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	data := realisticSpectrum(rng, 1024, 0)
	scale := spectrumV2ChooseScale(data)
	stepDB := float64(scale.stepCentiDB) / 100

	var worst, bias float64
	for _, v := range data {
		got := scale.decode(scale.encode(v))
		e := float64(got) - float64(v)
		bias += e
		if math.Abs(e) > worst {
			worst = math.Abs(e)
		}
	}
	bias /= float64(len(data))
	t.Logf("step %.2f dB, worst error %.4f dB, mean bias %.4f dB", stepDB, worst, bias)
	if worst > stepDB/2+1e-6 {
		t.Errorf("worst error %.4f dB exceeds half a step (%.4f)", worst, stepDB/2)
	}
	// Rounding leaves no systematic bias; truncation would show about half a
	// step of it.
	if math.Abs(bias) > stepDB/10 {
		t.Errorf("mean bias %.4f dB suggests truncation rather than rounding", bias)
	}
}

// Version 1 wrapped: uint8(0+256) is 0, so a bin at full scale decoded as
// -256 dB, the darkest possible output for the brightest possible input.
func TestSpectrumV2SaturatesRatherThanWraps(t *testing.T) {
	data := make([]float32, 64)
	for i := range data {
		data[i] = -100
	}
	scale := spectrumV2ChooseScale(data)
	for _, v := range []float32{0, 10, 1000, -1000, -100000} {
		code := scale.encode(v)
		got := scale.decode(code)
		// Whatever it does, a value above the range must not come back below
		// it, and vice versa.
		if v > 0 && float64(got) < float64(scale.refCentiDB)/100 {
			t.Errorf("%.0f dB encoded to %d, decoding as %.1f dB — that is the wrap version 1 had", v, code, got)
		}
		if v < -500 && code != 0 {
			t.Errorf("%.0f dB should saturate at the bottom, got code %d", v, code)
		}
	}
	// And explicitly: 0 dBFS must not read as the floor.
	if c := scale.encode(0); c != 255 {
		t.Errorf("0 dBFS encoded to %d, expected saturation at 255", c)
	}
}

// A stream must reconstruct within the delta threshold, and the error must not
// drift: the encoder compares against what the client holds, not the truth.
func TestSpectrumV2StreamStaysWithinThreshold(t *testing.T) {
	rng := rand.New(rand.NewSource(2))
	st := &spectrumV2State{}
	dec := &spectrumV2Decoder{}
	const threshold = 3.0

	var worst float64
	for f := 0; f < 400; f++ {
		data := realisticSpectrum(rng, 1024, f)
		pkt, full, codes := spectrumV2Encode(st, data, uint64(f)*100_000_000, 14_074_000, threshold)
		spectrumV2Commit(st, codes, full)
		got, err := dec.decode(pkt)
		if err != nil {
			t.Fatalf("frame %d: %v", f, err)
		}
		if len(got) != len(data) {
			t.Fatalf("frame %d: %d bins, want %d", f, len(got), len(data))
		}
		for i := range data {
			e := math.Abs(float64(got[i]) - float64(data[i]))
			if e > worst {
				worst = e
			}
		}
	}
	t.Logf("worst reconstruction error over 400 frames: %.2f dB (threshold %.1f)", worst, threshold)
	// The threshold plus a step of quantisation is the honest bound.
	if worst > threshold+1.0 {
		t.Errorf("error %.2f dB exceeds the threshold plus a step — it is drifting", worst)
	}
	if dec.gaps != 0 {
		t.Errorf("%d sequence gaps in a stream with no drops", dec.gaps)
	}
}

// The point of the change: a delta must never be larger than the full frame it
// replaces, which version 1's was about two thirds of the time.
func TestSpectrumV2DeltaNeverExceedsFullFrame(t *testing.T) {
	rng := rand.New(rand.NewSource(3))
	st := &spectrumV2State{}
	const bins = 1024
	fullSize := spectrumV2HeaderSize + 3 + bins
	worst := 0
	for f := 0; f < 300; f++ {
		// Deliberately churny: half the bins move a lot every frame.
		data := realisticSpectrum(rng, bins, f)
		if f%2 == 0 {
			for i := 0; i < bins/2; i++ {
				data[i] += float32(rng.NormFloat64() * 20)
			}
		}
		pkt, full, codes := spectrumV2Encode(st, data, uint64(f), 0, 3.0)
		spectrumV2Commit(st, codes, full)
		if len(pkt) > worst {
			worst = len(pkt)
		}
		if len(pkt) > fullSize {
			t.Fatalf("frame %d is %d bytes, larger than a full frame (%d)", f, len(pkt), fullSize)
		}
	}
	t.Logf("largest frame %d bytes against a full frame of %d", worst, fullSize)
}

// A dropped frame must self-heal. Version 1 recorded what the client held
// before sending, so a drop desynchronised those bins until something else
// forced a full frame -- which on a quiet band could be minutes.
func TestSpectrumV2DropIsSelfHealing(t *testing.T) {
	rng := rand.New(rand.NewSource(4))
	st := &spectrumV2State{}
	dec := &spectrumV2Decoder{}
	var worstAfterDrop float64

	for f := 0; f < 200; f++ {
		data := realisticSpectrum(rng, 512, f)
		pkt, full, codes := spectrumV2Encode(st, data, uint64(f), 0, 3.0)

		// Every eleventh frame never reaches the client.
		if f%11 == 5 {
			spectrumV2Dropped(st)
			continue
		}
		spectrumV2Commit(st, codes, full)
		got, err := dec.decode(pkt)
		if err != nil {
			t.Fatalf("frame %d: %v", f, err)
		}
		for i := range data {
			e := math.Abs(float64(got[i]) - float64(data[i]))
			if e > worstAfterDrop {
				worstAfterDrop = e
			}
		}
	}
	t.Logf("worst error with one frame in eleven dropped: %.2f dB", worstAfterDrop)
	if worstAfterDrop > 4.0 {
		t.Errorf("error %.2f dB after drops — the stream is not recovering", worstAfterDrop)
	}
}

// Even with nothing dropped and nothing changing, a full frame must reappear
// so that any disagreement has a bounded lifetime.
func TestSpectrumV2PeriodicKeyframe(t *testing.T) {
	st := &spectrumV2State{}
	data := make([]float32, 256)
	for i := range data {
		data[i] = -100
	}
	fulls, gapMax, gap := 0, 0, 0
	for f := 0; f < 300; f++ {
		_, full, codes := spectrumV2Encode(st, data, uint64(f), 0, 3.0)
		spectrumV2Commit(st, codes, full)
		if full {
			fulls++
			if gap > gapMax {
				gapMax = gap
			}
			gap = 0
		} else {
			gap++
		}
	}
	t.Logf("%d full frames in 300, longest run without one: %d", fulls, gapMax)
	if gapMax > spectrumV2KeyframeInterval {
		t.Errorf("went %d frames without a keyframe, interval is %d", gapMax, spectrumV2KeyframeInterval)
	}
	if fulls < 2 {
		t.Errorf("only %d full frames — a stuck stream would never resynchronise", fulls)
	}
}

// A bin count change must produce a full frame rather than a delta against the
// wrong length.
func TestSpectrumV2BinCountChange(t *testing.T) {
	st := &spectrumV2State{}
	dec := &spectrumV2Decoder{}
	// Powers of two, and the widths the band-activity SSE stream actually uses
	// (500-2500 per band, 4096 wideband). A non-power-of-two matters because the
	// change mask's last byte is then only partly used, and an off-by-one there
	// would corrupt the final bins rather than failing outright.
	for _, n := range []int{1024, 1024, 512, 512, 2048, 2048, 256, 1000, 1500, 4096, 999, 1001, 7} {
		data := make([]float32, n)
		for i := range data {
			data[i] = float32(-100 + i%20)
		}
		pkt, full, codes := spectrumV2Encode(st, data, 0, 0, 3.0)
		spectrumV2Commit(st, codes, full)
		got, err := dec.decode(pkt)
		if err != nil {
			t.Fatalf("%d bins: %v", n, err)
		}
		if len(got) != n {
			t.Fatalf("%d bins: decoded %d", n, len(got))
		}
	}
}

// The scale must cover whatever the receiver's gain settings produce -- a
// hardcoded window would clip on somebody's configuration.
func TestSpectrumV2ScaleAdaptsToGain(t *testing.T) {
	for _, offset := range []float32{0, -40, +40, -100, +60} {
		data := make([]float32, 512)
		for i := range data {
			data[i] = -100 + offset + float32(i%90)
		}
		scale := spectrumV2ChooseScale(data)
		var worst float64
		for _, v := range data {
			e := math.Abs(float64(scale.decode(scale.encode(v))) - float64(v))
			if e > worst {
				worst = e
			}
		}
		if worst > float64(scale.stepCentiDB)/100/2+1e-6 {
			t.Errorf("gain offset %.0f dB: worst error %.3f dB, step %.2f — the range clipped",
				offset, worst, float64(scale.stepCentiDB)/100)
		}
	}
}

// Non-finite readings must not corrupt the scale for every other bin.
func TestSpectrumV2HandlesNonFinite(t *testing.T) {
	data := make([]float32, 128)
	for i := range data {
		data[i] = -100
	}
	data[5] = float32(math.NaN())
	data[9] = float32(math.Inf(-1))
	data[11] = float32(math.Inf(1))
	scale := spectrumV2ChooseScale(data)
	if scale.stepCentiDB == 0 {
		t.Fatal("zero step")
	}
	for i, v := range data {
		if math.IsNaN(float64(v)) || math.IsInf(float64(v), 0) {
			continue
		}
		if e := math.Abs(float64(scale.decode(scale.encode(v))) - float64(v)); e > 1.0 {
			t.Errorf("bin %d: error %.2f dB — a non-finite reading distorted the scale", i, e)
		}
	}
}

// What it costs against version 1, on the same frames.
func TestSpectrumV2SizeAgainstV1(t *testing.T) {
	rng := rand.New(rand.NewSource(5))
	st := &spectrumV2State{}
	const bins = 1024
	var v2Bytes, v1Bytes int
	var prev []uint8

	for f := 0; f < 300; f++ {
		data := realisticSpectrum(rng, bins, f)
		pkt, full, codes := spectrumV2Encode(st, data, uint64(f), 0, 3.0)
		spectrumV2Commit(st, codes, full)
		v2Bytes += len(pkt)

		// version 1: 22-byte header, 1 B/bin full, 3 B/change delta with an
		// 80% fallback.
		cur := make([]uint8, bins)
		for i, v := range data {
			d := float64(v)
			if d < -256 {
				d = -256
			} else if d > 0 {
				d = 0
			}
			cur[i] = uint8(d + 256)
		}
		if prev == nil {
			v1Bytes += 22 + bins
		} else {
			changes := 0
			for i := range cur {
				if math.Abs(float64(cur[i])-float64(prev[i])) > 3 {
					changes++
				}
			}
			if changes > bins*4/5 {
				v1Bytes += 22 + bins
			} else {
				v1Bytes += 24 + 3*changes
			}
		}
		prev = cur
	}
	ratio := float64(v1Bytes) / float64(v2Bytes)
	t.Logf("300 frames of %d bins: version 1 %d bytes, version 2 %d bytes (%.2fx smaller)",
		bins, v1Bytes, v2Bytes, ratio)
	if ratio < 1.5 {
		t.Errorf("only %.2fx smaller than version 1, expected well over that", ratio)
	}
}

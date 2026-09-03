package main

import (
	"encoding/json"
	"math"
	"math/rand"
	"testing"
	"time"
)

// naiveDFT is the definition, for checking the fast transform against.
func naiveDFT(re, im []float64) ([]float64, []float64) {
	n := len(re)
	outRe := make([]float64, n)
	outIm := make([]float64, n)
	for k := 0; k < n; k++ {
		var sr, si float64
		for t := 0; t < n; t++ {
			ang := -2 * math.Pi * float64(k) * float64(t) / float64(n)
			c, s := math.Cos(ang), math.Sin(ang)
			sr += re[t]*c - im[t]*s
			si += re[t]*s + im[t]*c
		}
		outRe[k], outIm[k] = sr, si
	}
	return outRe, outIm
}

func TestLossyFFTMatchesDFT(t *testing.T) {
	lossyTables.Do(lossyInitTables)
	const n = 64
	// The table-driven transform indexes twiddles with a stride, so it must be
	// exercised at the real size too; 64 is only for the O(n^2) reference.
	rng := rand.New(rand.NewSource(1))
	re := make([]float64, n)
	im := make([]float64, n)
	for i := range re {
		re[i], im[i] = rng.NormFloat64(), rng.NormFloat64()
	}
	wantRe, wantIm := naiveDFT(re, im)

	gotRe := make([]float64, n)
	gotIm := make([]float64, n)
	copy(gotRe, re)
	copy(gotIm, im)
	// Build tables for this size, since lossyFFT reads the package tables.
	saveW, saveTR, saveTI, saveRev := lossyWindow, lossyTwRe, lossyTwIm, lossyRev
	lossyTwRe = make([]float64, n/2)
	lossyTwIm = make([]float64, n/2)
	for k := 0; k < n/2; k++ {
		ang := -2 * math.Pi * float64(k) / float64(n)
		lossyTwRe[k], lossyTwIm[k] = math.Cos(ang), math.Sin(ang)
	}
	lossyRev = make([]uint16, n)
	for i := 0; i < n; i++ {
		var r int
		for b := 0; b < 6; b++ {
			if i&(1<<b) != 0 {
				r |= 1 << (5 - b)
			}
		}
		lossyRev[i] = uint16(r)
	}
	lossyFFT(gotRe, gotIm)
	lossyWindow, lossyTwRe, lossyTwIm, lossyRev = saveW, saveTR, saveTI, saveRev

	for k := 0; k < n; k++ {
		if math.Abs(gotRe[k]-wantRe[k]) > 1e-9 || math.Abs(gotIm[k]-wantIm[k]) > 1e-9 {
			t.Fatalf("bin %d: got (%v,%v), want (%v,%v)", k, gotRe[k], gotIm[k], wantRe[k], wantIm[k])
		}
	}
}

// TestLossyQuantiseClampsAtFullScale is a regression test for a wrap that cost
// the reference experiment several arms: rounding carries a full-scale peak one
// step past the ceiling, and restoring that turns +32767 into -32768.
func TestLossyQuantiseClampsAtFullScale(t *testing.T) {
	for shift := uint(1); shift <= 8; shift++ {
		s := []int16{32767, -32768, 0, 1, -1}
		orig := append([]int16(nil), s...)
		lossyQuantise(s, shift)
		lossyRestore(s, shift)
		for i := range s {
			if (orig[i] > 0) != (s[i] > 0) && s[i] != 0 && orig[i] != 0 {
				t.Fatalf("shift %d: sample %d flipped sign, %d -> %d", shift, i, orig[i], s[i])
			}
			if d := int32(s[i]) - int32(orig[i]); d > int32(1)<<shift || d < -(int32(1)<<shift) {
				t.Fatalf("shift %d: sample %d moved by %d, more than one step", shift, i, d)
			}
		}
	}
}

func TestLossyMarginFromQuery(t *testing.T) {
	for _, tc := range []struct {
		in      float64
		present bool
		want    float64
		lossy   bool
	}{
		{0, false, 0, false},         // absent means lossless
		{0, true, 0, false},          // zero means lossless
		{-5, true, 0, false},         // nonsense means lossless
		{math.NaN(), true, 0, false}, // NaN is not a request
		{5, true, lossyMinMarginDB, true},
		{26, true, 26, true},
		{500, true, lossyMaxMarginDB, true},
		// Whole decibels only, on both sides of the wire.
		{26.4, true, 26, true},
		{26.5, true, 27, true},
		{19.7, true, lossyMinMarginDB, true},
	} {
		got, lossy := LossyMarginFromQuery(tc.in, tc.present)
		if got != tc.want || lossy != tc.lossy {
			t.Errorf("LossyMarginFromQuery(%v,%v) = (%v,%v), want (%v,%v)",
				tc.in, tc.present, got, lossy, tc.want, tc.lossy)
		}
	}
}

// iqNoise builds an interleaved I/Q packet of band-limited-ish noise.
func iqNoise(rng *rand.Rand, frames int, amp float64) []int16 {
	s := make([]int16, frames*2)
	for i := range s {
		v := rng.NormFloat64() * amp
		if v > 32767 {
			v = 32767
		} else if v < -32768 {
			v = -32768
		}
		s[i] = int16(v)
	}
	return s
}

// TestLossyColdStartIsConservative pins the behaviour that an earlier revision
// got backwards. Before enough samples have arrived to measure the band, the
// selector must assume the worst and send nearly all the bits -- assuming the
// best quantised the opening 100 ms of every stream to four bits.
func TestLossyColdStartIsConservative(t *testing.T) {
	sel := newLossyDepthSelector(20, 384000)
	rng := rand.New(rand.NewSource(2))
	first := sel.shiftFor(iqNoise(rng, 360, 3000))
	if first > 2 {
		t.Errorf("cold start shift = %d, want a near-lossless shift (<=2)", first)
	}
}

// TestLossySelectorSteadyStateIsAllocationFree guards the scratch buffers. A
// fresh slice per refresh is 8 kB of garbage a second per session for a value
// overwritten immediately, and it does not show up in a wall-clock budget.
func TestLossySelectorSteadyStateIsAllocationFree(t *testing.T) {
	sel := newLossyDepthSelector(26, 384000)
	rng := rand.New(rand.NewSource(3))
	pkt := iqNoise(rng, 360, 4000)
	for i := 0; i < 200; i++ { // settle past the cold start and a few refreshes
		sel.shiftFor(pkt)
	}
	if n := testing.AllocsPerRun(2000, func() { sel.shiftFor(pkt) }); n != 0 {
		t.Errorf("shiftFor allocates %v times per call, want 0", n)
	}
}

// TestLossyDepthSelectorCPUBudget is the throughput case: a 384 kHz IQ stream,
// which delivers 1098 packets a second and is what decides whether an encoder
// keeps up.
//
// The budget is 4 ms of CPU per second of stream, or 0.4% of one core, against
// about 1.4 ms measured. It is a guard against gross regressions only -- a wall
// clock cannot reliably separate 1.4 ms from the 2.1 ms that dropping the ring
// optimisation costs, so that specific regression is pinned by
// TestLossyRingWritesStayRare instead, which counts rather than times. For
// scale, the predictive codec itself spends roughly 30 us per packet, which is
// 33 ms per second of stream.
func TestLossyDepthSelectorCPUBudget(t *testing.T) {
	if testing.Short() {
		t.Skip("timing test")
	}
	const (
		rate    = 384000
		frames  = 360
		packets = rate / frames // one second of stream
		budget  = 4 * time.Millisecond
	)
	sel := newLossyDepthSelector(26, rate)
	rng := rand.New(rand.NewSource(4))
	// Several distinct packets so the loop cannot become a cache-resident
	// repetition of one buffer.
	pkts := make([][]int16, 16)
	for i := range pkts {
		pkts[i] = iqNoise(rng, frames, 4000)
	}
	for i := 0; i < 200; i++ {
		sel.shiftFor(pkts[i%len(pkts)])
	}

	// Best of three: this asserts a ceiling on the work done, and a scheduler
	// interruption should not be reported as a performance regression.
	best := time.Duration(math.MaxInt64)
	for try := 0; try < 3; try++ {
		start := time.Now()
		for i := 0; i < packets; i++ {
			sel.shiftFor(pkts[i%len(pkts)])
		}
		if d := time.Since(start); d < best {
			best = d
		}
	}
	t.Logf("384 kHz IQ: %v of CPU per second of stream (%.2f%% of a core), budget %v",
		best, 100*best.Seconds(), budget)
	if best > budget {
		t.Errorf("selector costs %v per second of stream, over the %v budget", best, budget)
	}
}

// TestLossyRingWritesStayRare pins the optimisation the timing test cannot.
//
// The trailing window only has to hold the last lossyFFTSize frames when a
// refresh falls due. At 384 kHz that is 1024 frames out of every 38400, so all
// but about 4% of the stream should never be copied at all. Maintaining the ring
// unconditionally still passes a wall-clock budget -- it is only 1.5x slower --
// but it shows up here as a thirtyfold increase.
func TestLossyRingWritesStayRare(t *testing.T) {
	const (
		rate    = 384000
		frames  = 360
		packets = rate / frames
	)
	sel := newLossyDepthSelector(26, rate)
	rng := rand.New(rand.NewSource(7))
	pkt := iqNoise(rng, frames, 4000)
	for i := 0; i < packets; i++ {
		sel.shiftFor(pkt)
	}

	// Ten refreshes a second, each needing the window plus up to one packet of
	// slop. Double that is generous and still nowhere near copying everything.
	refreshes := int64(1000 / lossyUpdateMillis)
	want := 2 * refreshes * (lossyFFTSize + frames)
	if sel.ringFrames > want {
		t.Errorf("copied %d frames into the window over one second of stream, want at most %d "+
			"(copying every frame would be %d)", sel.ringFrames, want, int64(packets)*frames)
	}
	if sel.ringFrames == 0 {
		t.Error("no frames copied at all: the window is never being filled")
	}
	t.Logf("copied %d of %d frames (%.1f%%)", sel.ringFrames, int64(packets)*frames,
		100*float64(sel.ringFrames)/float64(int64(packets)*frames))
}

func BenchmarkLossyShiftFor(b *testing.B) {
	sel := newLossyDepthSelector(26, 384000)
	rng := rand.New(rand.NewSource(5))
	pkt := iqNoise(rng, 360, 4000)
	for i := 0; i < 200; i++ {
		sel.shiftFor(pkt)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		sel.shiftFor(pkt)
	}
}

func BenchmarkLossyFFT(b *testing.B) {
	lossyTables.Do(lossyInitTables)
	re := make([]float64, lossyFFTSize)
	im := make([]float64, lossyFFTSize)
	rng := rand.New(rand.NewSource(6))
	for i := range re {
		re[i], im[i] = rng.NormFloat64(), rng.NormFloat64()
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		lossyFFT(re, im)
	}
}

// TestLossyStreamRoundTrip runs the whole path: quantise, code, decode, restore.
//
// The decoder must return exactly the values the encoder quantised to, on the
// int16 grid. That is the real contract of the mode -- it is lossy against the
// input and lossless against what it chose to send, and the predictor on both
// sides must agree bit for bit on the quantised values or everything after the
// first packet decodes wrongly.
func TestLossyStreamRoundTrip(t *testing.T) {
	const (
		rate   = 192000
		frames = 360
	)
	enc := NewPCMv4StreamEncoderWithMargin(26)
	dec := NewPCMv4StreamDecoder()
	rng := rand.New(rand.NewSource(11))

	ts := int64(0)
	sawShift := false
	for p := 0; p < 60; p++ {
		samples := iqNoise(rng, frames, 5000)
		// radiod delivers big-endian; the encoder expects that.
		raw := make([]byte, len(samples)*2)
		for i, v := range samples {
			raw[2*i] = byte(uint16(v) >> 8)
			raw[2*i+1] = byte(uint16(v))
		}
		ts += int64(frames) * 1e9 / rate

		pkt, err := enc.EncodePacket(raw, ts, rate, 2, -80, -110)
		if err != nil {
			t.Fatalf("packet %d: encode: %v", p, err)
		}
		cp := append([]byte(nil), pkt...)

		h, got, err := dec.DecodePacket(cp)
		if err != nil {
			t.Fatalf("packet %d: decode: %v", p, err)
		}
		if h.Profile != PredProfileIQScaled {
			t.Fatalf("packet %d: profile %d, want %d", p, h.Profile, PredProfileIQScaled)
		}
		if len(got) != len(samples) {
			t.Fatalf("packet %d: %d samples back, sent %d", p, len(got), len(samples))
		}
		for i := range got {
			// Whatever shift was chosen, the value returned must be the
			// quantised one restored -- a multiple of the step, within one step
			// of the input.
			if d := int32(got[i]) - int32(samples[i]); d > 1<<15 || d < -(1<<15) {
				t.Fatalf("packet %d sample %d: %d -> %d", p, i, samples[i], got[i])
			}
			if got[i] != samples[i] {
				sawShift = true
			}
		}
	}
	if !sawShift {
		t.Error("nothing was ever quantised; the lossy path did not engage")
	}
}

// TestLosslessPathUnchangedByLossyCode is the promise made to every existing
// client: an encoder that was not asked for the mode must behave exactly as it
// did before it existed, down to the bytes on the wire.
func TestLosslessPathUnchangedByLossyCode(t *testing.T) {
	const (
		rate   = 192000
		frames = 360
	)
	plain := NewPCMv4StreamEncoder()
	margin := NewPCMv4StreamEncoderWithMargin(0) // zero is not a request
	rng := rand.New(rand.NewSource(12))

	ts := int64(0)
	for p := 0; p < 20; p++ {
		samples := iqNoise(rng, frames, 5000)
		raw := make([]byte, len(samples)*2)
		for i, v := range samples {
			raw[2*i] = byte(uint16(v) >> 8)
			raw[2*i+1] = byte(uint16(v))
		}
		ts += int64(frames) * 1e9 / rate

		a, err := plain.EncodePacket(raw, ts, rate, 2, -80, -110)
		if err != nil {
			t.Fatalf("packet %d: %v", p, err)
		}
		aCopy := append([]byte(nil), a...)
		b, err := margin.EncodePacket(raw, ts, rate, 2, -80, -110)
		if err != nil {
			t.Fatalf("packet %d: %v", p, err)
		}
		if string(aCopy) != string(b) {
			t.Fatalf("packet %d differs between the two lossless encoders", p)
		}
		// And it must still be the profile released clients know.
		h, _, err := NewPCMv4StreamDecoder().DecodePacket(aCopy)
		if err == nil && h.Profile != PredProfileIQ {
			t.Fatalf("packet %d: profile %d, want %d", p, h.Profile, PredProfileIQ)
		}
	}
}

// TestLossyMarginChangesLive is the case a client hits when it moves the slider:
// the margin changes on a running stream, and must take effect on the next
// packet without a reconnect, a rebuild or a gap.
func TestLossyMarginChangesLive(t *testing.T) {
	const (
		rate   = 192000
		frames = 360
	)
	cell := NewLossyMarginCell(20)
	enc := NewPCMv4StreamEncoderWithMarginCell(cell)
	dec := NewPCMv4StreamDecoder()
	rng := rand.New(rand.NewSource(13))

	ts := int64(0)
	send := func() (PCMv4Header, int, error) {
		samples := iqNoise(rng, frames, 6000)
		raw := make([]byte, len(samples)*2)
		for i, v := range samples {
			raw[2*i] = byte(uint16(v) >> 8)
			raw[2*i+1] = byte(uint16(v))
		}
		ts += int64(frames) * 1e9 / rate
		pkt, err := enc.EncodePacket(raw, ts, rate, 2, -80, -110)
		if err != nil {
			return PCMv4Header{}, 0, err
		}
		n := len(pkt)
		h, _, err := dec.DecodePacket(append([]byte(nil), pkt...))
		return h, n, err
	}

	// Settle, then measure at a coarse margin.
	for i := 0; i < 80; i++ {
		if _, _, err := send(); err != nil {
			t.Fatalf("settle: %v", err)
		}
	}
	var coarse int
	for i := 0; i < 40; i++ {
		h, n, err := send()
		if err != nil {
			t.Fatalf("coarse: %v", err)
		}
		if h.Profile != PredProfileIQScaled {
			t.Fatalf("coarse: profile %d", h.Profile)
		}
		coarse += n
	}

	// Ask for much more fidelity, as a client moving the control would.
	cell.Set(60)
	var fine int
	for i := 0; i < 40; i++ {
		h, n, err := send()
		if err != nil {
			t.Fatalf("fine: %v", err)
		}
		if h.Profile != PredProfileIQScaled {
			t.Fatalf("fine: profile %d, want the stream to stay on the same profile", h.Profile)
		}
		fine += n
	}
	if fine <= coarse {
		t.Errorf("raising the margin did not cost more bytes: %d at 20 dB, %d at 60 dB", coarse, fine)
	}

	// And back to lossless, which is the one transition that does change the
	// profile. It must still decode, having rebuilt on both sides.
	cell.Set(0)
	for i := 0; i < 20; i++ {
		h, _, err := send()
		if err != nil {
			t.Fatalf("lossless: %v", err)
		}
		if h.Profile != PredProfileIQ {
			t.Fatalf("lossless: profile %d, want %d", h.Profile, PredProfileIQ)
		}
	}
}

// TestLossyMarginRangeIsPinned guards the clamp the browser mirrors.
//
// static/v2/src/radio/constants.js carries the same two numbers so the slider
// cannot ask for something that will be silently adjusted, and there is no
// build-time link between the two. A change here must fail marginclamp.test.js
// as well, which is the point of pinning it on both sides.
func TestLossyMarginRangeIsPinned(t *testing.T) {
	if lossyMinMarginDB != 20 {
		t.Errorf("lossyMinMarginDB = %v, want 20 (MARGIN_MIN_DB in constants.js)", lossyMinMarginDB)
	}
	if lossyMaxMarginDB != 60 {
		t.Errorf("lossyMaxMarginDB = %v, want 60 (MARGIN_MAX_DB in constants.js)", lossyMaxMarginDB)
	}
}

// TestLossyDecoderRejectsBadShift covers what arrives rather than what is asked
// for. A shift is one byte of attacker- or corruption-controlled input ahead of
// the body, and the decoder shifts by it, so an out-of-range value must be
// refused rather than used.
func TestLossyDecoderRejectsBadShift(t *testing.T) {
	const (
		rate   = 192000
		frames = 360
	)
	enc := NewPCMv4StreamEncoderWithMargin(26)
	rng := rand.New(rand.NewSource(14))

	// The FIRST packet, which is the stream's resynchronisation point: a fresh
	// decoder refuses a delta packet, so a later one could not be checked
	// standalone.
	var good []byte
	ts := int64(0)
	for p := 0; p < 40; p++ {
		samples := iqNoise(rng, frames, 6000)
		raw := make([]byte, len(samples)*2)
		for i, v := range samples {
			raw[2*i] = byte(uint16(v) >> 8)
			raw[2*i+1] = byte(uint16(v))
		}
		ts += int64(frames) * 1e9 / rate
		pkt, err := enc.EncodePacket(raw, ts, rate, 2, -80, -110)
		if err != nil {
			t.Fatalf("encode: %v", err)
		}
		if good == nil {
			good = append([]byte(nil), pkt...)
		}
	}

	// Find where the body starts by decoding the header off a fresh decoder.
	h, _, err := NewPCMv4StreamDecoder().DecodePacket(append([]byte(nil), good...))
	if err != nil {
		t.Fatalf("the unmutated packet does not decode: %v", err)
	}
	if h.Profile != PredProfileIQScaled {
		t.Fatalf("profile %d, want the scaled one", h.Profile)
	}

	// The shift is the first body byte. Walk the packet for it rather than
	// recomputing the header length: any byte above 15 must be refused wherever
	// it sits, and the only one the decoder reads as a shift is that one.
	for _, bad := range []byte{16, 17, 200, 255} {
		mutated := append([]byte(nil), good...)
		// Locate the shift byte by re-parsing the header the same way.
		hdr := NewPCMv4HeaderDecoder()
		_, off, err := hdr.Decode(mutated)
		if err != nil {
			t.Fatalf("header: %v", err)
		}
		mutated[off] = bad
		if _, _, err := NewPCMv4StreamDecoder().DecodePacket(mutated); err == nil {
			t.Errorf("shift %d was accepted; it must be refused", bad)
		}
	}

	// And a scaled packet with no body at all has no shift to read.
	hdr := NewPCMv4HeaderDecoder()
	_, off, err := hdr.Decode(good)
	if err != nil {
		t.Fatalf("header: %v", err)
	}
	if _, _, err := NewPCMv4StreamDecoder().DecodePacket(good[:off]); err == nil {
		t.Error("a scaled packet carrying no shift was accepted")
	}
}

// TestLossyRequestIgnoredOnDemodulatedAudio is the case a listener hits by
// simply having the control set: the v2 panel offers the margin whenever the
// stream is uncompressed, and uncompressed is a format an ordinary SSB or CW
// session can be in.
//
// The mode is IQ-only, so such a request must be inert -- not merely harmless,
// but byte-for-byte identical to no request at all, and still declaring the
// audio profile every released client already implements. "Uncompressed" has to
// mean uncompressed.
func TestLossyRequestIgnoredOnDemodulatedAudio(t *testing.T) {
	const (
		rate    = 12000
		samples = 240
	)
	asked := NewPCMv4StreamEncoderWithMargin(20) // the most aggressive request
	plain := NewPCMv4StreamEncoder()
	rng := rand.New(rand.NewSource(15))

	ts := int64(0)
	for p := 0; p < 40; p++ {
		mono := make([]int16, samples)
		for i := range mono {
			mono[i] = clampInt16(rng.NormFloat64() * 6000)
		}
		raw := make([]byte, len(mono)*2)
		for i, v := range mono {
			raw[2*i] = byte(uint16(v) >> 8)
			raw[2*i+1] = byte(uint16(v))
		}
		ts += int64(samples) * 1e9 / rate

		a, err := asked.EncodePacket(raw, ts, rate, 1, -80, -110)
		if err != nil {
			t.Fatalf("packet %d: %v", p, err)
		}
		aCopy := append([]byte(nil), a...)
		b, err := plain.EncodePacket(raw, ts, rate, 1, -80, -110)
		if err != nil {
			t.Fatalf("packet %d: %v", p, err)
		}
		if string(aCopy) != string(b) {
			t.Fatalf("packet %d: a margin request changed a mono audio packet", p)
		}
	}

	// And it decodes as ordinary audio, on a decoder that knows nothing of the
	// scaled profile's shift byte.
	dec := NewPCMv4StreamDecoder()
	enc2 := NewPCMv4StreamEncoderWithMargin(20)
	ts = 0
	for p := 0; p < 10; p++ {
		mono := make([]int16, samples)
		for i := range mono {
			mono[i] = clampInt16(rng.NormFloat64() * 6000)
		}
		raw := make([]byte, len(mono)*2)
		for i, v := range mono {
			raw[2*i] = byte(uint16(v) >> 8)
			raw[2*i+1] = byte(uint16(v))
		}
		ts += int64(samples) * 1e9 / rate
		pkt, err := enc2.EncodePacket(raw, ts, rate, 1, -80, -110)
		if err != nil {
			t.Fatalf("packet %d: %v", p, err)
		}
		h, got, err := dec.DecodePacket(append([]byte(nil), pkt...))
		if err != nil {
			t.Fatalf("packet %d: %v", p, err)
		}
		if h.Profile != PredProfileAudio {
			t.Fatalf("packet %d: profile %d, want %d", p, h.Profile, PredProfileAudio)
		}
		// Lossless, still: mono audio is never requantised.
		for i := range got {
			if got[i] != mono[i] {
				t.Fatalf("packet %d sample %d: %d != %d, audio was not lossless",
					p, i, got[i], mono[i])
			}
		}
	}
}

// TestLossyToLosslessIsTrulyLossless is the promise the top of the slider makes.
//
// Moving the control to its maximum must not mean "a very fine quantiser". It
// must mean the original 16-bit path: the profile released clients already
// implement, no shift byte on the wire, and samples that come back bit for bit.
// A stream that had been lossy for a while must get there too, mid-flight,
// without a reconnect.
func TestLossyToLosslessIsTrulyLossless(t *testing.T) {
	const (
		rate   = 192000
		frames = 360
	)
	cell := NewLossyMarginCell(20)
	enc := NewPCMv4StreamEncoderWithMarginCell(cell)
	dec := NewPCMv4StreamDecoder()
	rng := rand.New(rand.NewSource(16))

	ts := int64(0)
	run := func(n int, check func(p int, in []int16, h PCMv4Header, out []int16, pkt []byte)) {
		for p := 0; p < n; p++ {
			in := iqNoise(rng, frames, 7000)
			raw := make([]byte, len(in)*2)
			for i, v := range in {
				raw[2*i] = byte(uint16(v) >> 8)
				raw[2*i+1] = byte(uint16(v))
			}
			ts += int64(frames) * 1e9 / rate
			pkt, err := enc.EncodePacket(raw, ts, rate, 2, -80, -110)
			if err != nil {
				t.Fatalf("packet %d: %v", p, err)
			}
			pkt = append([]byte(nil), pkt...)
			h, out, err := dec.DecodePacket(pkt)
			if err != nil {
				t.Fatalf("packet %d: %v", p, err)
			}
			check(p, in, h, out, pkt)
		}
	}

	// While lossy, samples are expected to differ -- that is the whole point.
	lossyDiffered := false
	run(60, func(p int, in []int16, h PCMv4Header, out []int16, pkt []byte) {
		if h.Profile != PredProfileIQScaled {
			t.Fatalf("packet %d: profile %d while lossy", p, h.Profile)
		}
		for i := range in {
			if in[i] != out[i] {
				lossyDiffered = true
				break
			}
		}
	})
	if !lossyDiffered {
		t.Fatal("the lossy phase never actually quantised anything")
	}

	// The slider goes to the top.
	cell.Set(0)

	run(60, func(p int, in []int16, h PCMv4Header, out []int16, pkt []byte) {
		if h.Profile != PredProfileIQ {
			t.Fatalf("packet %d: profile %d after going lossless, want %d",
				p, h.Profile, PredProfileIQ)
		}
		for i := range in {
			if in[i] != out[i] {
				t.Fatalf("packet %d sample %d: %d came back as %d -- not lossless",
					p, i, in[i], out[i])
			}
		}
	})

	// And it is the same stream a client that never asked would have received:
	// profile 0 is what every released decoder implements, and there is no shift
	// byte in front of the body for one of them to trip over.
	fresh := NewPCMv4StreamEncoder()
	freshDec := NewPCMv4StreamDecoder()
	ts2 := int64(0)
	for p := 0; p < 5; p++ {
		in := iqNoise(rng, frames, 7000)
		raw := make([]byte, len(in)*2)
		for i, v := range in {
			raw[2*i] = byte(uint16(v) >> 8)
			raw[2*i+1] = byte(uint16(v))
		}
		ts2 += int64(frames) * 1e9 / rate
		pkt, err := fresh.EncodePacket(raw, ts2, rate, 2, -80, -110)
		if err != nil {
			t.Fatal(err)
		}
		h, out, err := freshDec.DecodePacket(append([]byte(nil), pkt...))
		if err != nil {
			t.Fatal(err)
		}
		if h.Profile != PredProfileIQ {
			t.Fatalf("a never-asked stream declares profile %d", h.Profile)
		}
		for i := range in {
			if in[i] != out[i] {
				t.Fatalf("never-asked stream is not lossless at sample %d", i)
			}
		}
	}
}

// TestSetMinMarginZeroSurvivesJSON is the sentinel, checked where it is most
// likely to be lost.
//
// Moving the slider to its top sends `{"min_margin": 0}`, and zero is the value
// that means "stop quantising". A plain float64 field would be indistinguishable
// from an absent one, and `omitempty` on a pointer applies to marshalling only
// -- but the two together are exactly the shape that silently swallows a zero,
// so the parse is pinned rather than assumed.
func TestSetMinMarginZeroSurvivesJSON(t *testing.T) {
	for _, tc := range []struct {
		body      string
		wantSet   bool
		wantValue float64
		wantLossy bool
	}{
		{`{"type":"set_min_margin","min_margin":0}`, true, 0, false},
		{`{"type":"set_min_margin","min_margin":26}`, true, 26, true},
		{`{"type":"set_min_margin","min_margin":26.4}`, true, 26, true},
		{`{"type":"set_min_margin"}`, false, 0, false},
	} {
		var msg ClientMessage
		if err := json.Unmarshal([]byte(tc.body), &msg); err != nil {
			t.Fatalf("%s: %v", tc.body, err)
		}
		if (msg.MinMargin != nil) != tc.wantSet {
			t.Errorf("%s: MinMargin present = %v, want %v", tc.body, msg.MinMargin != nil, tc.wantSet)
			continue
		}
		if !tc.wantSet {
			continue
		}
		applied, lossy := LossyMarginFromQuery(*msg.MinMargin, true)
		if applied != tc.wantValue || lossy != tc.wantLossy {
			t.Errorf("%s: got (%v,%v), want (%v,%v)",
				tc.body, applied, lossy, tc.wantValue, tc.wantLossy)
		}
	}
}

// TestMarginCellZeroReturnsToLossless closes the loop from the message to the
// wire: a cell set to zero must put the very next packet back on the profile
// released clients implement, with no shift byte.
func TestMarginCellZeroReturnsToLossless(t *testing.T) {
	const (
		rate   = 192000
		frames = 360
	)
	cell := NewLossyMarginCell(26)
	enc := NewPCMv4StreamEncoderWithMarginCell(cell)
	dec := NewPCMv4StreamDecoder()
	rng := rand.New(rand.NewSource(17))
	ts := int64(0)

	packet := func() (PCMv4Header, []int16, []int16) {
		in := iqNoise(rng, frames, 7000)
		raw := make([]byte, len(in)*2)
		for i, v := range in {
			raw[2*i] = byte(uint16(v) >> 8)
			raw[2*i+1] = byte(uint16(v))
		}
		ts += int64(frames) * 1e9 / rate
		pkt, err := enc.EncodePacket(raw, ts, rate, 2, -80, -110)
		if err != nil {
			t.Fatal(err)
		}
		h, out, err := dec.DecodePacket(append([]byte(nil), pkt...))
		if err != nil {
			t.Fatal(err)
		}
		return h, in, out
	}

	for i := 0; i < 30; i++ {
		packet()
	}

	// Exactly what the message handler does with `{"min_margin":0}`.
	var msg ClientMessage
	if err := json.Unmarshal([]byte(`{"min_margin":0}`), &msg); err != nil {
		t.Fatal(err)
	}
	applied, _ := LossyMarginFromQuery(*msg.MinMargin, true)
	cell.Set(applied)

	h, in, out := packet()
	if h.Profile != PredProfileIQ {
		t.Fatalf("the packet after the sentinel declares profile %d, want %d",
			h.Profile, PredProfileIQ)
	}
	for i := range in {
		if in[i] != out[i] {
			t.Fatalf("sample %d: %d came back as %d immediately after going lossless",
				i, in[i], out[i])
		}
	}
}

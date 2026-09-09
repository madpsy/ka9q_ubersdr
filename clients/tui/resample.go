package main

import "math"

// Rate conversion for the sound device.
//
// Opus hides this problem: it reconstructs at 48 kHz whatever it was encoded
// from, so a client that only ever played Opus could open the sound device once
// and never think about rates again. Everything else on the socket arrives at
// the radio channel's own rate — 12 kHz for the sideband and CW modes, 24 kHz
// for AM and FM, and 12 to 384 kHz for the IQ modes — and the device runs at
// one rate, so something has to convert.
//
// Converting here rather than reopening the device at the channel rate is the
// cheaper answer by a long way. The rate changes with MODE, so following it
// would mean tearing down and reopening the sound device on every mode change —
// audible, occasionally slow, and able to fail outright when something else has
// taken the device meanwhile. Converting costs a few hundred multiplies per
// packet and cannot fail.
//
// Only the sound device is converted. What goes to stdout is the stream exactly
// as the receiver sent it, rate and channels and all, because that is what a
// capture or a decoder wants — see audioout.go.
//
// Nothing about the lossless claim is weakened by this: the samples the server
// encoded are reconstructed bit for bit, which is what the codec promises and
// what pcmv4_test.go checks. What the device then hears is the same signal at
// its own rate, which is what a sound card's converter would have done to it
// anyway — only with a real filter rather than whatever the device happens to
// use.

// upTapsPerPhase sets the filter length: the prototype is this many taps for
// every factor of rate change, so the transition band stays the same fraction
// of the passband whichever conversion is in use.
//
// Sixteen puts the transition comfortably inside the guard between the
// channel's Nyquist and the top of what it carries — a 12 kHz audio channel
// carries at most 2.7 kHz of sideband — and costs 16 multiplies per output
// sample at 4:1, which is nothing measurable. Decimating 384 kHz IQ to 48 kHz
// is 128 taps per output sample, twice over for two channels: about 12 million
// multiplies a second, which is still under a percent of one core.
const upTapsPerPhase = 16

// upsampler converts one stream from the radio channel's rate to the output
// rate, carrying its filter history across packets so there is no discontinuity
// at packet boundaries.
//
// Both directions are needed. Audio channels run below the output rate and are
// interpolated; the wide IQ modes run above it — 384 kHz against 48 — and must
// be decimated, which without a low-pass in front would fold the whole of the
// band that cannot be represented back on top of the part that can.
//
// The two are the same filter. Conceptually the stream is upsampled by L, then
// low-passed, then downsampled by M, where L/M is the rate ratio in its lowest
// terms; the polyphase form below does that without ever materialising the
// intermediate rate. The cutoff is the lower of the two Nyquists, which is what
// makes one implementation cover both.
//
// Stateful and single-goroutine, like everything else on the receive path. A
// change of source rate rebuilds it, which resets the history: that costs one
// filter length of settling at a mode change, buried under the retune.
type upsampler struct {
	srcRate int
	dstRate int

	// l and m are the rate ratio in lowest terms: dstRate/srcRate == l/m. Zero
	// l marks the fractional path below, for a ratio these cannot express.
	l, m int

	// phases holds the polyphase decomposition of one low-pass prototype: one
	// set of taps per position within an input sample period, in Q15.
	// phases[p][k] weighs the input sample k back from the newest.
	phases [][]int32

	// hist is the newest tapsPerPhase input samples, newest last.
	hist []int16

	// phase is where the next output sample falls inside the current input
	// sample's period, in intermediate-rate steps; see process.
	phase int

	// The fractional path's state: the last sample of the previous block, and
	// where the next output sample falls relative to the start of the next one
	// (in [-1, 0), so -1 is exactly `prev`).
	pos  float64
	prev int16
}

// newUpsampler builds a converter from srcRate to dstRate.
func newUpsampler(srcRate, dstRate int) *upsampler {
	u := &upsampler{srcRate: srcRate, dstRate: dstRate}
	if srcRate <= 0 || dstRate <= 0 {
		return u
	}
	if srcRate == dstRate {
		u.l, u.m = 1, 1
		return u
	}

	g := gcd(srcRate, dstRate)
	l, m := dstRate/g, srcRate/g
	// Every rate pairing this client can meet reduces to small integers — the
	// audio channels are 12 and 24 kHz and the IQ ones 12, 48, 96, 192 and 384,
	// all against a 48 kHz output — so a ratio that does not is one nobody
	// anticipated, and the fractional path below carries it rather than
	// building a filter bank with thousands of phases.
	if l > 64 || m > 64 {
		return u
	}
	u.l, u.m = l, m
	u.phases = buildPolyphase(l, m, upTapsPerPhase)
	u.hist = make([]int16, len(u.phases[0]))
	return u
}

func gcd(a, b int) int {
	for b != 0 {
		a, b = b, a%b
	}
	return a
}

// matches reports whether this converter is the one for a stream at srcRate,
// so the caller can rebuild on a mode change and leave it alone otherwise.
func (u *upsampler) matches(srcRate int) bool { return u != nil && u.srcRate == srcRate }

// process converts one packet's worth of single-channel samples.
//
// The result is freshly allocated on every call because it is handed to another
// goroutine.
func (u *upsampler) process(in []int16) []int16 {
	switch {
	case len(in) == 0:
		return nil
	case u.l == 1 && u.m == 1:
		out := make([]int16, len(in))
		copy(out, in)
		return out
	case u.l > 0:
		return u.resample(in)
	default:
		return u.resampleLinear(in)
	}
}

// resample runs the polyphase filter.
//
// Each input sample covers l steps of the intermediate rate, and an output
// falls every m of those. phase tracks where the next output lands inside the
// current sample's l steps, so an interpolation emits several outputs per input
// and a decimation emits one every few — from the same two lines.
func (u *upsampler) resample(in []int16) []int16 {
	out := make([]int16, 0, len(in)*u.l/u.m+1)
	last := len(u.hist) - 1
	for _, s := range in {
		// Slide the history along and put the new sample at the end, so
		// hist[last-k] is the sample k back — the order the taps expect.
		copy(u.hist, u.hist[1:])
		u.hist[last] = s

		for u.phase < u.l {
			var acc int64
			for k, w := range u.phases[u.phase] {
				acc += int64(w) * int64(u.hist[last-k])
			}
			out = append(out, clampInt16((acc+1<<14)>>15))
			u.phase += u.m
		}
		u.phase -= u.l
	}
	return out
}

// resampleLinear is the fallback for a ratio the polyphase bank will not
// express; see newUpsampler for when that can happen. It keeps the speed right
// and does not band-limit, which is audible only on a conversion nothing here
// produces.
func (u *upsampler) resampleLinear(in []int16) []int16 {
	step := float64(u.srcRate) / float64(u.dstRate)
	out := make([]int16, 0, len(in)*u.dstRate/u.srcRate+2)
	n := len(in)
	for {
		i := int(math.Floor(u.pos))
		if i+1 >= n {
			break
		}
		f := u.pos - float64(i)
		a := u.prev
		if i >= 0 {
			a = in[i]
		}
		b := in[i+1]
		out = append(out, clampInt16(int64(math.Round(float64(a)+(float64(b)-float64(a))*f))))
		u.pos += step
	}
	// Carry the position into the next block's index space. The loop above
	// stops at the last sample it can interpolate from, which leaves pos in
	// [-1, 0) once the block length is taken off it.
	u.pos -= float64(n)
	u.prev = in[n-1]
	return out
}

func clampInt16(v int64) int16 {
	if v > math.MaxInt16 {
		return math.MaxInt16
	}
	if v < math.MinInt16 {
		return math.MinInt16
	}
	return int16(v)
}

// buildPolyphase returns the taps for an l-up, m-down converter, split by phase
// and scaled to Q15.
//
// The prototype is a windowed sinc cut off at the LOWER of the two Nyquists,
// which is 1/(2*max(l, m)) of the intermediate rate. That single choice covers
// both directions: interpolating, it removes the images the zero-stuffing
// creates; decimating, it removes everything that would fold back over the
// signal when samples are thrown away. A Blackman window puts the stopband
// below -74 dB, far under the noise on any signal this will carry.
//
// Each phase is then normalised to sum to exactly one. Every phase having unity
// DC gain is what stops a constant input coming back with a ripple on it at the
// phase rate, which is the one artefact of this arrangement that would be
// plainly audible.
func buildPolyphase(l, m, tapsPerFactor int) [][]int32 {
	factor := l
	if m > factor {
		factor = m
	}
	// One prototype tap per phase per factor of rate change, rounded up to a
	// whole number of phases so the decomposition below divides exactly.
	tapsPerPhase := (tapsPerFactor*factor + l - 1) / l
	n := tapsPerPhase * l
	centre := float64(n-1) / 2

	proto := make([]float64, n)
	for i := 0; i < n; i++ {
		x := (float64(i) - centre) / float64(factor)
		s := 1.0
		if x != 0 {
			s = math.Sin(math.Pi*x) / (math.Pi * x)
		}
		// Blackman, over the whole prototype.
		t := 2 * math.Pi * float64(i) / float64(n-1)
		w := 0.42 - 0.5*math.Cos(t) + 0.08*math.Cos(2*t)
		proto[i] = s * w
	}

	phases := make([][]int32, l)
	for p := 0; p < l; p++ {
		raw := make([]float64, tapsPerPhase)
		var sum float64
		for k := 0; k < tapsPerPhase; k++ {
			raw[k] = proto[p+k*l]
			sum += raw[k]
		}
		taps := make([]int32, tapsPerPhase)
		for k := range raw {
			if sum != 0 {
				raw[k] /= sum
			}
			taps[k] = int32(math.Round(raw[k] * 32768))
		}
		phases[p] = taps
	}
	return phases
}

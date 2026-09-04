package main

import (
	"encoding/binary"
	"fmt"
	"math/bits"
)

// Predictive lossless codec for PCM audio and IQ
// ==============================================
//
// This file implements the payload codec for protocol version 4. It replaces
// the zstd wrapper that versions 1-3 put around every pcm-zstd packet.
//
// WHY IT EXISTS
// -------------
// zstd does not compress this data at all. Measured against a live receiver,
// every IQ mode came back at 0.99x and every audio mode at 0.90-0.95x -- that
// is, the compressed stream was consistently LARGER than the samples it
// carried. Over 32,179 consecutive IQ packets not one was made smaller.
//
// The reason is structural rather than a matter of tuning. zstd is an LZ77
// matcher over bytes: it looks for repeated byte strings, and a band-limited
// RF signal has none. It correctly concludes the data is incompressible and
// emits a stored block, which costs a 14-15 byte frame header for nothing. The
// wasted CPU is the match search that could only ever return that answer.
//
// But "no repeated strings" is not "no redundancy". Consecutive samples of a
// band-limited signal are correlated -- measured |r(1)| of 0.78-0.90 on IQ,
// higher still on demodulated audio, which carries a ~2.65 kHz passband in a
// 12 kHz channel and is therefore ~4x oversampled. That correlation is worth
// 1.3x on IQ and 1.9-3.8x on audio, and a predictor plus an entropy coder
// suited to residuals extracts it where a byte matcher cannot.
//
// HOW IT WORKS
// ------------
// Each sample is predicted from those before it by an adaptive filter; only
// the prediction error is transmitted, Rice coded. The filter is BACKWARD
// adaptive: its taps are derived from samples already coded, so the decoder
// recomputes them independently and no coefficients are ever sent. All state
// is integer with shifts, never floating point, so encoder and decoder agree
// bit for bit on every platform -- which is what makes a lossless claim
// meaningful across a Go server, a Go client and a browser.
//
// The alternative considered was forward-adaptive linear prediction (Levinson
// per packet, coefficients in the packet). It measured worse: 1.29x against
// 1.32x on IQ, because refitting per packet loses the cross-packet adaptation
// and the coefficients cost bytes. It was also much more code.
//
// PROFILES: THE SERVER DECIDES
// ----------------------------
// A demodulated channel and an IQ channel want different predictors, and the
// difference is forced by the signal rather than chosen:
//
//   - IQ is complex baseband. A carrier in it is a single complex pole, which
//     one complex tap cancels exactly. Treating I and Q as two independent
//     real streams throws that away -- measured 1.29x against 1.89x on audio
//     when the wrong form is used.
//   - Demodulated audio is mono. There is no quadrature partner and no
//     frequency offset to rotate out, so the filter is the ordinary real one.
//
// The stage COUNT differs too, and only measurement settles it: audio gains
// enormously from a deep cascade of small filters (1.37x -> 1.89x on USB)
// because oversampling leaves structure at several scales, while IQ gains
// nothing from the same treatment at twice the CPU.
//
// Rather than let clients infer any of this, each packet DECLARES the profile
// it was coded with, in the flags byte that already carries the escape bit --
// so self-description costs no extra bytes. A client reads the declaration and
// obeys it; it never inspects the mode, the channel count or the sample rate.
//
// This keeps predictor choice a server-side policy question. ProfileForChannels
// can be retuned -- for instance to give carrier-heavy bands a deeper cascade,
// worth 1.89x -> 2.18x on a medium-wave capture -- without touching a single
// deployed client. Inferring the codec from the channel count would instead
// have frozen today's choice into every client permanently.
//
// Profile ids are therefore FIXED for the life of a protocol version. A client
// that negotiated version 4 is guaranteed to understand every profile a
// version 4 server emits. Adding a profile later requires a version bump or an
// explicit client-advertised capability; it must never be introduced silently,
// which is why decoding an unknown id is a hard error here rather than a
// fallback to profile 0 (that would decode noise and call it audio).
//
// PAYLOAD FORMAT
// --------------
// The codec produces the packet BODY. The metadata header is unchanged and
// still written by pcm_binary.go.
//
//	[flags u8][body...]
//
//	flags: bit 7    escape -- body is verbatim samples, not coded
//	       bits 6-4 reserved, must be zero
//	       bits 3-0 profile id
//
// Coded body:  [rice k u8][rice bitstream]
// Escape body: samples as little-endian int16, in order
//
// The escape exists because a predictor cannot help a full-entropy signal, and
// a saturated front end produces exactly that. Without it such a stream would
// EXPAND by about 3%; with it the worst case is 0.9997x. The predictor is
// still advanced across an escaped packet, on both sides, so the filter state
// stays in step through one.
//
// STREAM LIFETIME
// ---------------
// A codec instance IS the stream. Its taps carry the adaptation of every
// sample coded so far, so it must be created per connection, used by exactly
// one goroutine, and discarded when the socket closes. It must NOT be shared
// between sessions the way the zstd encoders in pcm_binary.go are -- those are
// stateless across calls and this deliberately is not.
//
// Nothing else needs to reset it. Packets dropped upstream (see the
// channel-full skip in audio.go) never reach the encoder, so both ends see the
// same sequence and simply re-adapt over the gap. A failed write closes the
// connection outright. WebSocket delivery is ordered and reliable, so the only
// boundary is a reconnect, which creates a fresh pair by construction. A
// profile change mid-session is handled by rebuilding, which the encoder does
// automatically and the decoder does when the declared id changes.
//
// Measured on a live receiver, versus what versions 1-3 send today:
//
//	CW 14.025      26.2 kB/s -> 6.3 kB/s   (76% less)
//	LSB voice      26.6 kB/s -> 10.9 kB/s  (59% less)
//	USB FT8        26.6 kB/s -> 12.7 kB/s  (52% less)
//	AM             50.6 kB/s -> 29.7 kB/s  (41% less)
//	NFM            50.6 kB/s -> 35.9 kB/s  (29% less)
//	IQ 12 kHz      50.5 kB/s -> 34.8 kB/s  (31% less)
//	IQ 384 kHz     1590 kB/s -> 1116 kB/s  (30% less)

var zzLeak uint

func zzLeakOf(w int64) int64 {
	m := w >> 63
	return ((((w ^ m) - m) >> zzLeak) ^ m) - m
}

const (
	// predTapShift is the fixed-point scale of the filter taps: they are
	// integers in Q16, so 65536 represents a tap of 1.0.
	predTapShift = 16

	// predTapLimit bounds |tap| to 2^24, a real-valued magnitude of 256.
	//
	// It serves two purposes. It caps the prediction sum far below int64
	// overflow no matter what the input does -- an order-16 filter at the
	// limit against full-scale samples reaches only about 2^45. And because
	// that same bound keeps every product and sum inside the range where a
	// float64 represents integers exactly (2^53), a JavaScript decoder can use
	// plain numbers and still be bit-exact, with no BigInt.
	//
	// With the leak below holding the taps near their equilibrium
	// the clamp is insurance that never fires in practice. It must nonetheless
	// be applied identically on both sides, since if it ever does fire the two
	// must agree.
	predTapLimit = 1 << 24

	// predLeakShiftComplex and predLeakShiftReal are the leakage of the tap
	// update: every adapt subtracts w/2^shift from each tap before adding the
	// gradient step.
	//
	// WHY LEAKAGE IS NOT OPTIONAL
	// ---------------------------
	// Sign-sign LMS has no restoring force of its own. The update is
	// mu*sign(e)*sign(x) whatever the taps already are, so in any direction the
	// input does not excite -- and a band whose energy sits in a few carriers
	// leaves most directions unexcited -- the taps are free to walk. On medium
	// wave they walk in one direction: measured on a 909 kHz iq384 stream the
	// mean |tap| grew linearly at about 1.5 per second until it reached
	// predTapLimit around ninety seconds in.
	//
	// Long before the clamp the prediction is worthless. That stream cost 10.65
	// bits per sample at five seconds, 14.26 at thirty and 15.85 at ninety, by
	// which point a third of packets were taking the raw escape and the
	// "compressed" stream was larger than the samples going into it. This is
	// what a client sees as a bitrate that climbs for minutes on a signal that
	// is not changing. Every capture in testdata/pcm_predictive is half a second
	// long, which is why nothing here caught it; TestPredictiveTapsDoNotDrift is
	// the test that does.
	//
	// Subtracting w/2^shift first bounds the walk at roughly mu*2^shift. Where
	// the taps were not walking it costs nothing -- on two minutes of a 40 m
	// capture it changes the coded size by 0.003%, in its favour -- and where
	// they were it is decisive: the medium-wave stream holds 8.45 bits per
	// sample for as long as it runs.
	//
	// WHY THE TWO PROFILES DIFFER
	// ---------------------------
	// The complex filter tracks a 384 kHz baseband where the useful taps are
	// small, and 14 is its measured optimum -- bits per sample over the last
	// five seconds of that ninety-second stream:
	//
	//	 8   13.35      14    8.45      18   11.19
	//	10    9.41      16    9.36      off  15.85
	//	12    8.81
	//
	// The real cascade is a different filter on a different signal: four stages
	// over a 12 kHz channel about four times oversampled, whose taps legitimately
	// reach 2. Leaking it as hard as the complex one throws that away. Measured
	// on usb-ft8-14074.bin, payload ratio over the capture against the largest
	// |tap| after 150 million samples:
	//
	//	14   1.671x  0.90      18   1.905x  4.00
	//	16   1.874x  1.57      off  1.905x  5.33
	//	17   1.906x  1.99
	//
	// 17 is where the compression is fully back -- fractionally ahead of no leak
	// at all, and identical on the other four audio captures -- while the taps
	// still settle, at 1.99 both after 29 million samples and after 150 million.
	//
	// Both are subtracted with the magnitude truncated, so a tap smaller than
	// 2^shift leaks nothing and small taps are not dragged to zero by rounding.
	predLeakShiftComplex = 14
	predLeakShiftReal    = 17

	// predEscapeFlag marks a body carrying verbatim samples.
	predEscapeFlag = 1 << 7

	// predProfileMask extracts the profile id from the flags byte.
	predProfileMask = 0x0f
)

// PredictorProfile describes one predictor configuration.
//
// A profile is data, not code. Both filter forms are the same sign-sign LMS
// algorithm -- the real one is the complex one with the imaginary terms
// dropped -- so a profile only chooses which form to instantiate and with what
// stage shapes.
type PredictorProfile struct {
	// ID is what travels on the wire. Fixed for the life of a protocol
	// version; see the note on profile stability above.
	ID byte

	// Name is for logs and diagnostics only. Nothing on the wire depends on it.
	Name string

	// Complex selects the filter form: true for interleaved I/Q, false for
	// mono. This is dictated by the signal, not a tuning choice.
	Complex bool

	// Orders and Mus define the cascade, one entry per stage. Each stage
	// predicts the residual left by the stage before it. Mu is the sign-sign
	// step size in Q16 tap units: larger adapts faster but tracks more
	// noisily.
	Orders []int
	Mus    []int64
}

// Profile ids. These values are part of the version 4 wire format and must not
// be reassigned.
const (
	// PredProfileIQ is a single complex filter of order 16.
	//
	// Deeper cascades were measured and rejected for IQ: 8/8/4/2 gave 1.391x
	// against this profile's 1.396x at roughly double the CPU, and 16/8/4/2
	// gave 1.403x at more than double. Order 32 alone gives 1.438x but costs
	// 75 us per packet against 37, which at the 1098 packets/second of a
	// 384 kHz stream is the difference between 2.2% and 8.2% of a core.
	PredProfileIQ byte = 0

	// PredProfileIQScaled is PredProfileIQ with a reduced-depth front end: the
	// body carries a shift byte before the Rice parameter, and the samples were
	// requantised by that shift before the predictor saw them. The predictor
	// itself is identical, because the scaling happens outside it.
	//
	// It is a separate id rather than a flag so that a client which has not
	// asked for the lossy mode cannot be handed one by accident: an unknown
	// profile is a hard error here and in every other decoder, where an
	// unrecognised flag bit might be ignored. See pcm_lossy.go.
	PredProfileIQScaled byte = 2

	// PredProfileAudio is a four-stage real cascade, orders 8/8/4/2.
	//
	// Depth matters far more here than filter length. On a USB capture the
	// progression was 1.370x for a single order-16 filter, 1.580x for 32/8,
	// 1.808x for 16/8/4 and 1.889x for this profile -- which is also the
	// cheapest of the deep configurations. A 12 kHz channel carrying a 2.65 kHz
	// passband is about 4x oversampled, leaving structure at several scales for
	// successive stages to remove.
	PredProfileAudio byte = 1
)

// predProfiles is the registry the wire format refers to.
var predProfiles = map[byte]PredictorProfile{
	PredProfileIQ: {
		ID: PredProfileIQ, Name: "iq-complex-o16", Complex: true,
		Orders: []int{16}, Mus: []int64{16},
	},
	PredProfileAudio: {
		ID: PredProfileAudio, Name: "audio-real-8/8/4/2", Complex: false,
		Orders: []int{8, 8, 4, 2}, Mus: []int64{16, 16, 32, 32},
	},
	PredProfileIQScaled: {
		ID: PredProfileIQScaled, Name: "iq-complex-o16-scaled", Complex: true,
		Orders: []int{16}, Mus: []int64{16},
	},
}

// ProfileForChannels is the server's policy for which predictor to use.
//
// This is the only place the decision is made, and nothing on the wire depends
// on it: the packet declares the result, so this can be changed freely --
// including per band or per mode -- without breaking any deployed client.
func ProfileForChannels(channels int) byte {
	return ProfileFor(channels, false)
}

// ProfileFor is ProfileForChannels with the reduced-depth mode taken into
// account. The lossy request is honoured for IQ only: a demodulated channel is
// already an order of magnitude cheaper, and the measurements that justify the
// mode were made on complex baseband.
func ProfileFor(channels int, lossy bool) byte {
	if channels >= 2 {
		if lossy {
			return PredProfileIQScaled
		}
		return PredProfileIQ
	}
	return PredProfileAudio
}

// PredictiveProfileID reports which profile a payload was coded with, so a
// receiver can build or rebuild its codec before decoding. It does not
// validate the id; NewPredictiveCodec does that.
func PredictiveProfileID(payload []byte) (byte, bool) {
	if len(payload) < 1 {
		return 0, false
	}
	return payload[0] & predProfileMask, true
}

// ---------------------------------------------------------------------------
// Adaptive filter stages
// ---------------------------------------------------------------------------

// predSign is a branchless sign, returning -1, 0 or +1.
func predSign(v int64) int64 {
	return (v >> 63) | int64(uint64(-v)>>63)
}

// predRoundShift divides by 2^shift, rounding to nearest and away from zero on
// ties. A plain arithmetic shift would round negative values towards negative
// infinity, biasing the predictor; more importantly the decoder must round
// identically, so this is the single definition both directions use.
//
// Branchless on purpose: the sign of a prediction sum is close to a coin flip,
// so a branch here mispredicts constantly -- it measured 8% of encode time.
// The mask form computes round(|v|) and restores the sign, which is the same
// value the branchy form produced for every input the filters can generate.
func predRoundShift(v int64, shift uint) int64 {
	m := v >> 63
	r := (((v ^ m) - m) + 1<<(shift-1)) >> shift
	return (r ^ m) - m
}

// predLeak is the amount the leakage removes from one tap, the magnitude
// divided by 2^shift and truncated towards zero.
//
// Truncating rather than rounding is what keeps the leak from fighting the
// gradient at small taps: below 2^shift it returns zero, so a tap the
// signal genuinely wants at a small value stays there instead of being pulled
// to zero and pushed back every sample.
//
// Branchless in the same form as predRoundShift, and for the same reason: it
// runs once per tap per sample, and the sign of a tap is not predictable.
func predLeak(w int64, shift uint) int64 {
	m := w >> 63
	return ((((w ^ m) - m) >> shift) ^ m) - m
}

// predClampTap applies predTapLimit. See the constant for why.
func predClampTap(w int64) int64 {
	if w > predTapLimit {
		return predTapLimit
	}
	if w < -predTapLimit {
		return -predTapLimit
	}
	return w
}

// predHistoryLen sizes the sliding history window for a given filter order.
//
// History is kept linear rather than circular so the tap loops walk contiguous
// memory with no index wrapping, which matters at 1098 packets a second. The
// cost is periodically sliding the newest `order` entries back to the front;
// making the window several times the order amortises that to negligible.
func predHistoryLen(order int) int {
	n := order * 8
	if n < 64 {
		n = 64
	}
	return n
}

// complexStage is one adaptive complex filter.
//
// Sign-sign LMS is used rather than true NLMS: the update needs only the signs
// of the error and of the history, so it costs two multiplies per tap with no
// division and no normalisation, and it is exactly reproducible in integers.
// Measured compression is within a fraction of a percent of a floating-point
// NLMS of the same order.
type complexStage struct {
	order int
	mu    int64

	// Taps in Q16, stored oldest-first: wr[i] weighs the history sample at
	// hr[idx-order+i], so predict and adapt walk taps and history forward
	// together and the compiler can drop the per-element bounds checks. The
	// pre-optimisation form indexed newest-first; the two are mirror images
	// and every tap trajectory is identical under the reversal.
	wr, wi []int64

	// fast is true while this packet provably cannot drive any tap past
	// predTapLimit, letting adapt skip the clamp; see beginPacket.
	fast bool

	// History of reconstructed samples, and their signs kept alongside so the
	// update loop does not recompute a sign per tap per sample. Newest entry
	// is at idx-1.
	hr, hi []int64
	sr, si []int64
	idx    int
}

func newComplexStage(order int, mu int64) *complexStage {
	n := predHistoryLen(order)
	return &complexStage{
		order: order, mu: mu,
		wr: make([]int64, order), wi: make([]int64, order),
		hr: make([]int64, n), hi: make([]int64, n),
		sr: make([]int64, n), si: make([]int64, n),
		idx: order,
	}
}

// predict returns the filter's estimate of the next sample.
func (f *complexStage) predict() (int64, int64) {
	wr := f.wr
	lo := f.idx - len(wr)
	hr := f.hr[lo:f.idx]
	hr = hr[:len(wr)]
	hi := f.hi[lo:f.idx]
	hi = hi[:len(wr)]
	wi := f.wi[:len(wr)]
	var pr, pi int64
	for j, w := range wr {
		br, bi := hr[j], hi[j]
		wiv := wi[j]
		pr += w*br - wiv*bi
		pi += w*bi + wiv*br
	}
	return predRoundShift(pr, predTapShift), predRoundShift(pi, predTapShift)
}

// adapt nudges each tap by mu in the direction that would have reduced this
// error, after leaking predLeakShiftComplex off it. The conjugate of the history is
// used, as the complex LMS gradient requires; here that is simply the negated
// sign of the imaginary part.
//
// A zero error is a genuine no-op -- both steps are zero and every tap is
// already inside the clamp -- so it returns without touching the taps. That
// costs nothing on live signal and turns the adapt pass over silence into a
// return.
func (f *complexStage) adapt(er, ei int64) {
	if er == 0 && ei == 0 {
		return
	}
	mr := f.mu * predSign(er)
	mi := f.mu * predSign(ei)
	wr := f.wr
	lo := f.idx - len(wr)
	sr := f.sr[lo:f.idx]
	sr = sr[:len(wr)]
	si := f.si[lo:f.idx]
	si = si[:len(wr)]
	wi := f.wi[:len(wr)]
	if zzLeak > 0 {
		for j := range wr {
			hrs := sr[j]
			his := -si[j]
			wr[j] += mr*hrs - mi*his - zzLeakOf(wr[j])
			wi[j] += mr*his + mi*hrs - zzLeakOf(wi[j])
		}
		return
	}
	if f.fast {
		for j := range wr {
			hrs := sr[j]
			his := -si[j]
			wr[j] += mr*hrs - mi*his - predLeak(wr[j], predLeakShiftComplex)
			wi[j] += mr*his + mi*hrs - predLeak(wi[j], predLeakShiftComplex)
		}
		return
	}
	for j := range wr {
		hrs := sr[j]
		his := -si[j]
		wr[j] = predClampTap(wr[j] + mr*hrs - mi*his - predLeak(wr[j], predLeakShiftComplex))
		wi[j] = predClampTap(wi[j] + mr*his + mi*hrs - predLeak(wi[j], predLeakShiftComplex))
	}
}

// beginPacket decides, once per packet, whether adapt may skip the tap clamp.
//
// One complex update moves a tap by at most 2*mu (each of the two sign terms
// contributes at most mu, and the leak only ever moves a tap towards zero), so
// if every tap starts further than 2*mu*steps from the limit, no update in this
// packet can reach it and the clamp is an identity. Taps settle around 2^16 against a limit of 2^24, so this is the
// path that always runs in practice; the clamped loop remains for the case
// the scan cannot rule out, and produces identical values when it does run.
func (f *complexStage) beginPacket(steps int) {
	var maxAbs int64
	for _, w := range f.wr {
		if w < 0 {
			w = -w
		}
		if w > maxAbs {
			maxAbs = w
		}
	}
	for _, w := range f.wi {
		if w < 0 {
			w = -w
		}
		if w > maxAbs {
			maxAbs = w
		}
	}
	f.fast = maxAbs+2*f.mu*int64(steps) <= predTapLimit
}

// push appends a reconstructed sample to the history, sliding the window when
// it fills.
func (f *complexStage) push(xr, xi int64) {
	f.hr[f.idx], f.hi[f.idx] = xr, xi
	f.sr[f.idx], f.si[f.idx] = predSign(xr), predSign(xi)
	f.idx++
	if f.idx == len(f.hr) {
		n := f.order
		copy(f.hr, f.hr[f.idx-n:f.idx])
		copy(f.hi, f.hi[f.idx-n:f.idx])
		copy(f.sr, f.sr[f.idx-n:f.idx])
		copy(f.si, f.si[f.idx-n:f.idx])
		f.idx = n
	}
}

// forward is the encoder direction: return the residual for a known sample.
func (f *complexStage) forward(xr, xi int64) (int64, int64) {
	pr, pi := f.predict()
	er, ei := xr-pr, xi-pi
	f.adapt(er, ei)
	f.push(xr, xi)
	return er, ei
}

// inverse is the decoder direction: reconstruct a sample from its residual.
// It performs the same prediction, adaptation and history update as forward,
// which is what keeps the two sides identical.
func (f *complexStage) inverse(er, ei int64) (int64, int64) {
	pr, pi := f.predict()
	xr, xi := er+pr, ei+pi
	f.adapt(er, ei)
	f.push(xr, xi)
	return xr, xi
}

// realStage is complexStage with the imaginary terms removed, for mono audio.
// Its taps are stored oldest-first and it carries the same per-packet fast
// flag; see complexStage for both.
type realStage struct {
	order int
	mu    int64
	w     []int64
	h     []int64
	s     []int64
	idx   int
	fast  bool
}

func newRealStage(order int, mu int64) *realStage {
	n := predHistoryLen(order)
	return &realStage{
		order: order, mu: mu,
		w:   make([]int64, order),
		h:   make([]int64, n),
		s:   make([]int64, n),
		idx: order,
	}
}

func (f *realStage) predict() int64 {
	w := f.w
	h := f.h[f.idx-len(w) : f.idx]
	h = h[:len(w)]
	var p int64
	for j, wv := range w {
		p += wv * h[j]
	}
	return predRoundShift(p, predTapShift)
}

func (f *realStage) adapt(e int64) {
	if e == 0 {
		return
	}
	m := f.mu * predSign(e)
	w := f.w
	s := f.s[f.idx-len(w) : f.idx]
	s = s[:len(w)]
	if f.fast {
		for j, sv := range s {
			w[j] += m*sv - predLeak(w[j], predLeakShiftReal)
		}
		return
	}
	for j, sv := range s {
		w[j] = predClampTap(w[j] + m*sv - predLeak(w[j], predLeakShiftReal))
	}
}

// beginPacket is the real form of complexStage.beginPacket: one update moves a
// tap by at most mu, so the bound is mu*steps.
func (f *realStage) beginPacket(steps int) {
	var maxAbs int64
	for _, w := range f.w {
		if w < 0 {
			w = -w
		}
		if w > maxAbs {
			maxAbs = w
		}
	}
	f.fast = maxAbs+f.mu*int64(steps) <= predTapLimit
}

func (f *realStage) push(x int64) {
	f.h[f.idx], f.s[f.idx] = x, predSign(x)
	f.idx++
	if f.idx == len(f.h) {
		n := f.order
		copy(f.h, f.h[f.idx-n:f.idx])
		copy(f.s, f.s[f.idx-n:f.idx])
		f.idx = n
	}
}

func (f *realStage) forward(x int64) int64 {
	p := f.predict()
	e := x - p
	f.adapt(e)
	f.push(x)
	return e
}

func (f *realStage) inverse(e int64) int64 {
	p := f.predict()
	x := e + p
	f.adapt(e)
	f.push(x)
	return x
}

// ---------------------------------------------------------------------------
// Rice coding of residuals
// ---------------------------------------------------------------------------
//
// A residual is coded as its zigzagged magnitude split at bit k: the high part
// in unary, then a stop bit, then the low k bits raw. k is chosen per packet
// from the mean magnitude, which for a Laplacian source is within a fraction
// of a bit of optimal.
//
// Alternatives were measured and rejected. A full adaptive arithmetic/rANS
// model over the residual alphabet came out level with this (1.35-1.39x either
// way) because the residual really is close to Laplacian, where Rice is nearly
// optimal. Adapting k continuously rather than per packet was slightly worse.
// FLAC-style partitioning changed nothing. Unary accounts for only 16-24% of
// the coded bits, so there is no escape-coding win hiding either.

// predZigzag folds a signed value onto the non-negative integers so small
// magnitudes of either sign get short codes.
func predZigzag(v int32) uint32 {
	return uint32((v << 1) ^ (v >> 31))
}

// riceEncodeResiduals appends the Rice bitstream for res to dst and returns it.
//
// dst must have capacity for the worst case, which the caller sizes; see
// predScratchLen.
func riceEncodeResiduals(res []int32, dst []byte) []byte {
	var sum uint64
	for _, v := range res {
		sum += uint64(predZigzag(v))
	}
	k := uint(0)
	if m := sum / uint64(len(res)); m > 0 {
		k = uint(bits.Len64(m)) - 1
		if k > 30 {
			k = 30
		}
	}

	start := len(dst)
	dst = append(dst, byte(k))
	buf := dst[start+1 : cap(dst)]
	buf = buf[:cap(buf)]

	// The bit accumulator lives in locals rather than behind a closure: a
	// closure containing a loop cannot inline, and the call per codeword was
	// measurable. The accumulator is flushed in 32-bit units, so nbits is
	// always below 32 at the top of each iteration and anything appended must
	// be at most 32 bits wide for its shift to stay inside a uint64.
	var acc uint64
	var nbits uint
	i := 0
	mask := uint32(1)<<k - 1

	for _, v := range res {
		u := predZigzag(v)
		q := uint(u >> k)

		// The whole codeword fits one write when it is short enough. The bound
		// is 24 and not something larger because nbits can already be 31: at
		// 24 the shift needs 55 bits, safely inside a uint64, whereas allowing
		// 40 here would need 71 and silently drop the top bits. That was a real
		// bug, and it only showed up on the large unpredicted samples of a
		// high-dynamic-range band, where the unary run gets long.
		if q+k+1 <= 24 {
			acc |= ((uint64(u&mask)<<1)<<q | (uint64(1)<<q - 1)) << nbits
			nbits += q + k + 1
		} else {
			// Long unary run: emit it in chunks, then the stop bit and
			// remainder.
			for r := q; r > 0; {
				c := r
				if c > 24 {
					c = 24
				}
				acc |= (uint64(1)<<c - 1) << nbits
				nbits += c
				for nbits >= 32 {
					binary.LittleEndian.PutUint32(buf[i:], uint32(acc))
					i += 4
					acc >>= 32
					nbits -= 32
				}
				r -= c
			}
			acc |= (uint64(u&mask) << 1) << nbits
			nbits += k + 1
		}
		for nbits >= 32 {
			binary.LittleEndian.PutUint32(buf[i:], uint32(acc))
			i += 4
			acc >>= 32
			nbits -= 32
		}
	}

	for nbits > 0 {
		buf[i] = byte(acc)
		i++
		acc >>= 8
		if nbits < 8 {
			break
		}
		nbits -= 8
	}
	return dst[:start+1+i]
}

// riceDecodeResiduals reverses riceEncodeResiduals into out, which must have
// length count.
func riceDecodeResiduals(src []byte, out []int32) error {
	if len(src) < 1 {
		return fmt.Errorf("rice: empty bitstream")
	}
	k := uint(src[0])
	if k > 30 {
		return fmt.Errorf("rice: invalid k %d", k)
	}
	src = src[1:]

	var acc uint64
	var nbits uint
	i := 0
	refill := func() {
		for nbits <= 56 && i < len(src) {
			acc |= uint64(src[i]) << nbits
			i++
			nbits += 8
		}
	}
	refill()
	mask := uint64(1)<<k - 1

	for j := range out {
		if nbits < 48 {
			refill()
		}
		// Count the run of 1 bits. Bits past nbits read as 0, so a run that
		// reaches the end of the accumulator is continued after a refill.
		var q uint
		for {
			c := uint(bits.TrailingZeros64(^acc))
			if c < nbits {
				q += c
				acc >>= c + 1
				nbits -= c + 1
				break
			}
			if i >= len(src) {
				return fmt.Errorf("rice: truncated at value %d", j)
			}
			q += nbits
			acc, nbits = 0, 0
			refill()
		}
		if nbits < k {
			refill()
		}
		if nbits < k {
			return fmt.Errorf("rice: truncated remainder at value %d", j)
		}
		u := uint32(q)<<k | uint32(acc&mask)
		acc >>= k
		nbits -= k
		// Undo the zigzag.
		out[j] = int32(u>>1) ^ -int32(u&1)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

// PredictiveCodec codes one direction of one stream.
//
// It is stateful across packets and NOT safe for concurrent use: create one per
// connection per direction, call it from a single goroutine, and drop it when
// the connection ends. See the stream lifetime note at the top of this file.
type PredictiveCodec struct {
	prof PredictorProfile
	cx   []*complexStage
	rl   []*realStage

	res []int32
	buf []byte
	hdr []byte // scratch for DecodeBody
}

// NewPredictiveCodec builds a codec for the given profile id, rejecting one it
// does not implement.
//
// The error is deliberate. Falling back to a default profile would decode a
// stream with the wrong predictor and return plausible-looking noise rather
// than failing, which is the worst possible behaviour for a codec whose entire
// promise is bit-exactness.
func NewPredictiveCodec(profileID byte) (*PredictiveCodec, error) {
	p, ok := predProfiles[profileID]
	if !ok {
		return nil, fmt.Errorf("predictive codec: unknown profile id %d", profileID)
	}
	c := &PredictiveCodec{prof: p}
	for i := range p.Orders {
		if p.Complex {
			c.cx = append(c.cx, newComplexStage(p.Orders[i], p.Mus[i]))
		} else {
			c.rl = append(c.rl, newRealStage(p.Orders[i], p.Mus[i]))
		}
	}
	return c, nil
}

// Profile reports the configuration in use, for logging.
func (c *PredictiveCodec) Profile() PredictorProfile { return c.prof }

// samplesPerStep is 2 for interleaved I/Q, 1 for mono.
func (c *PredictiveCodec) samplesPerStep() int {
	if c.prof.Complex {
		return 2
	}
	return 1
}

// predScratchLen sizes the working buffer. The escape body is 2 bytes per
// sample; the coded body cannot exceed that by more than the flag and k bytes
// because the escape is taken when it would, but the encoder writes the coded
// form first and so must have room for a pathological bitstream.
func predScratchLen(n int) int { return n*5 + 64 }

// beginPacket lets every stage decide once, from where its taps stand,
// whether this packet's adapt calls may skip the clamp. steps is how many
// times each stage will adapt: sample count for a real cascade, frame count
// for a complex one.
func (c *PredictiveCodec) beginPacket(steps int) {
	for _, s := range c.cx {
		s.beginPacket(steps)
	}
	for _, s := range c.rl {
		s.beginPacket(steps)
	}
}

// forward runs the cascade in the encoder direction over one sample position.
func (c *PredictiveCodec) forward(a, b int64) (int64, int64) {
	if c.prof.Complex {
		for _, s := range c.cx {
			a, b = s.forward(a, b)
		}
		return a, b
	}
	for _, s := range c.rl {
		a = s.forward(a)
	}
	return a, 0
}

// EncodeBody codes one packet and returns the body WITHOUT the leading flags
// byte, together with whether the escape was taken.
//
// This exists because version 4 carries the profile and the escape bit in the
// packet header (see pcm_v4_header.go), where they are needed anyway to tell a
// v4 packet from an Opus frame. Repeating them in the body would waste a byte
// on every packet. Encode wraps this for standalone use, where a payload that
// describes itself is more convenient than one that does not.
func (c *PredictiveCodec) EncodeBody(samples []int16) (body []byte, escape bool, err error) {
	full, err := c.Encode(samples)
	if err != nil {
		return nil, false, err
	}
	return full[1:], full[0]&predEscapeFlag != 0, nil
}

// DecodeBody reverses EncodeBody. The caller supplies the escape flag from
// wherever it was carried.
func (c *PredictiveCodec) DecodeBody(body []byte, count int, escape bool) ([]int16, error) {
	// Decode expects the flags byte in front. Rebuilding it here keeps one
	// decode path rather than two that could drift apart.
	if cap(c.hdr) < 1+len(body) {
		c.hdr = make([]byte, 1+len(body))
	}
	c.hdr = c.hdr[:1+len(body)]
	c.hdr[0] = c.prof.ID
	if escape {
		c.hdr[0] |= predEscapeFlag
	}
	copy(c.hdr[1:], body)
	return c.Decode(c.hdr, count)
}

// Encode codes one packet of samples and returns the payload body.
//
// For a complex profile, samples are interleaved I/Q and len(samples) must be
// even. The returned slice aliases an internal buffer that the next Encode
// call reuses, so copy it if it must outlive that.
func (c *PredictiveCodec) Encode(samples []int16) ([]byte, error) {
	n := len(samples)
	step := c.samplesPerStep()
	if n == 0 {
		return nil, fmt.Errorf("predictive codec: empty packet")
	}
	if n%step != 0 {
		return nil, fmt.Errorf("predictive codec: %d samples is not a whole number of %d-channel frames", n, step)
	}

	// Sized independently. Decode grows only res, so a codec that has decoded
	// before it encodes -- which happens when the silent path advances the
	// predictor over a packet it did not receive a body for -- would otherwise
	// reach a nil buf here.
	if cap(c.res) < n {
		c.res = make([]int32, n)
	}
	if cap(c.buf) < predScratchLen(n) {
		c.buf = make([]byte, predScratchLen(n))
	}
	c.res = c.res[:n]

	c.beginPacket(n / step)
	for i := 0; i < n; i += step {
		a := int64(int32(samples[i]))
		var b int64
		if step == 2 {
			b = int64(int32(samples[i+1]))
		}
		ra, rb := c.forward(a, b)
		c.res[i] = int32(ra)
		if step == 2 {
			c.res[i+1] = int32(rb)
		}
	}

	out := c.buf[:1]
	out = riceEncodeResiduals(c.res, out)

	// If prediction and coding did not pay for themselves, send the samples
	// as they are. The filters have already adapted over this packet above,
	// and the decoder adapts over the same verbatim samples, so state stays in
	// step through an escape.
	if len(out)-1 >= n*2 {
		out = c.buf[:1+n*2]
		out[0] = predEscapeFlag | c.prof.ID
		for i, v := range samples {
			binary.LittleEndian.PutUint16(out[1+2*i:], uint16(v))
		}
		return out, nil
	}
	out[0] = c.prof.ID
	return out, nil
}

// AdvanceSilence advances the filters over count zero-valued samples without
// producing a bitstream.
//
// The silent path in pcm_v4_stream.go needs the predictor to move exactly as
// if it had coded the zeros -- the decoder advances its own filters over the
// same zeros, and the two must agree sample for sample -- but it discards the
// body, so Rice coding the residuals was pure waste. A squelched session sends
// silent packets indefinitely, which made that waste permanent. Only the
// filter state changes here, and identically to Encode over a zero buffer:
// Rice coding never touches the filters and the escape decision reads only
// the coded length.
func (c *PredictiveCodec) AdvanceSilence(count int) error {
	step := c.samplesPerStep()
	if count <= 0 {
		return fmt.Errorf("predictive codec: empty packet")
	}
	if count%step != 0 {
		return fmt.Errorf("predictive codec: %d samples is not a whole number of %d-channel frames", count, step)
	}
	c.beginPacket(count / step)
	for i := 0; i < count; i += step {
		c.forward(0, 0)
	}
	return nil
}

// Decode reconstructs the samples of one packet body.
//
// count is the number of int16 samples the packet carries, which the caller
// derives from the packet length and header. The payload must have been coded
// with this codec's profile; check PredictiveProfileID first and rebuild if it
// has changed.
func (c *PredictiveCodec) Decode(payload []byte, count int) ([]int16, error) {
	step := c.samplesPerStep()
	if len(payload) < 1 {
		return nil, fmt.Errorf("predictive codec: empty payload")
	}
	if count <= 0 || count%step != 0 {
		return nil, fmt.Errorf("predictive codec: bad sample count %d for %d-channel profile", count, step)
	}
	if got := payload[0] & predProfileMask; got != c.prof.ID {
		return nil, fmt.Errorf("predictive codec: payload declares profile %d, codec is %d", got, c.prof.ID)
	}

	out := make([]int16, count)

	if payload[0]&predEscapeFlag != 0 {
		if len(payload) < 1+count*2 {
			return nil, fmt.Errorf("predictive codec: escape payload truncated (%d bytes for %d samples)", len(payload), count)
		}
		for i := 0; i < count; i++ {
			out[i] = int16(binary.LittleEndian.Uint16(payload[1+2*i:]))
		}
		// Advance the filters over these samples exactly as the encoder did,
		// discarding the residuals it produced.
		c.beginPacket(count / step)
		for i := 0; i < count; i += step {
			a := int64(int32(out[i]))
			var b int64
			if step == 2 {
				b = int64(int32(out[i+1]))
			}
			c.forward(a, b)
		}
		return out, nil
	}

	if cap(c.res) < count {
		c.res = make([]int32, count)
	}
	c.res = c.res[:count]
	if err := riceDecodeResiduals(payload[1:], c.res); err != nil {
		return nil, err
	}

	c.beginPacket(count / step)
	if c.prof.Complex {
		for i := 0; i < count; i += 2 {
			a, b := int64(c.res[i]), int64(c.res[i+1])
			// Stages are inverted in reverse order: the last stage to have
			// predicted is the first to be undone.
			for j := len(c.cx) - 1; j >= 0; j-- {
				a, b = c.cx[j].inverse(a, b)
			}
			out[i], out[i+1] = int16(a), int16(b)
		}
		return out, nil
	}
	for i := 0; i < count; i++ {
		a := int64(c.res[i])
		for j := len(c.rl) - 1; j >= 0; j-- {
			a = c.rl[j].inverse(a)
		}
		out[i] = int16(a)
	}
	return out, nil
}

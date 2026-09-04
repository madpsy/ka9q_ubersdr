package main

// FROZEN REFERENCE COPY of the version 4 predictive codec as it stood before
// the CPU optimisation pass, produced by mechanically prefixing every
// package-level identifier with "ref". It exists so the wire-identity test in
// pcm_predictive_wire_test.go can drive the optimised codec and this one in
// lockstep and require byte-identical output. Do not edit it to track
// pcm_predictive.go -- being left behind is its entire purpose.

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
// This keeps predictor choice a server-side policy question. refProfileForChannels
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

const (
	// refPredTapShift is the fixed-point scale of the filter taps: they are
	// integers in Q16, so 65536 represents a tap of 1.0.
	refPredTapShift = 16

	// refPredTapLimit bounds |tap| to 2^24, a real-valued magnitude of 256.
	//
	// It serves two purposes. It caps the prediction sum far below int64
	// overflow no matter what the input does -- an order-16 filter at the
	// limit against full-scale samples reaches only about 2^45. And because
	// that same bound keeps every product and sum inside the range where a
	// float64 represents integers exactly (2^53), a JavaScript decoder can use
	// plain numbers and still be bit-exact, with no BigInt.
	//
	// Normal adaptation settles around 2^16, so the clamp is insurance that
	// never fires in practice: across two hours of live IQ the largest tap
	// observed was 63 against the limit of 256. It must nonetheless be applied
	// identically on both sides, since if it ever does fire the two must agree.
	refPredTapLimit = 1 << 24

	// refPredEscapeFlag marks a body carrying verbatim samples.
	refPredEscapeFlag = 1 << 7

	// refPredProfileMask extracts the profile id from the flags byte.
	refPredProfileMask = 0x0f
)

// refPredictorProfile describes one predictor configuration.
//
// A profile is data, not code. Both filter forms are the same sign-sign LMS
// algorithm -- the real one is the complex one with the imaginary terms
// dropped -- so a profile only chooses which form to instantiate and with what
// stage shapes.
type refPredictorProfile struct {
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
	// refPredProfileIQ is a single complex filter of order 16.
	//
	// Deeper cascades were measured and rejected for IQ: 8/8/4/2 gave 1.391x
	// against this profile's 1.396x at roughly double the CPU, and 16/8/4/2
	// gave 1.403x at more than double. Order 32 alone gives 1.438x but costs
	// 75 us per packet against 37, which at the 1098 packets/second of a
	// 384 kHz stream is the difference between 2.2% and 8.2% of a core.
	refPredProfileIQ byte = 0

	// refPredProfileAudio is a four-stage real cascade, orders 8/8/4/2.
	//
	// Depth matters far more here than filter length. On a USB capture the
	// progression was 1.370x for a single order-16 filter, 1.580x for 32/8,
	// 1.808x for 16/8/4 and 1.889x for this profile -- which is also the
	// cheapest of the deep configurations. A 12 kHz channel carrying a 2.65 kHz
	// passband is about 4x oversampled, leaving structure at several scales for
	// successive stages to remove.
	refPredProfileAudio byte = 1
)

// refPredProfiles is the registry the wire format refers to.
var refPredProfiles = map[byte]refPredictorProfile{
	refPredProfileIQ: {
		ID: refPredProfileIQ, Name: "iq-complex-o16", Complex: true,
		Orders: []int{16}, Mus: []int64{16},
	},
	refPredProfileAudio: {
		ID: refPredProfileAudio, Name: "audio-real-8/8/4/2", Complex: false,
		Orders: []int{8, 8, 4, 2}, Mus: []int64{16, 16, 32, 32},
	},
}

// refProfileForChannels is the server's policy for which predictor to use.
//
// This is the only place the decision is made, and nothing on the wire depends
// on it: the packet declares the result, so this can be changed freely --
// including per band or per mode -- without breaking any deployed client.
func refProfileForChannels(channels int) byte {
	if channels >= 2 {
		return refPredProfileIQ
	}
	return refPredProfileAudio
}

// refPredictiveProfileID reports which profile a payload was coded with, so a
// receiver can build or rebuild its codec before decoding. It does not
// validate the id; refNewPredictiveCodec does that.
func refPredictiveProfileID(payload []byte) (byte, bool) {
	if len(payload) < 1 {
		return 0, false
	}
	return payload[0] & refPredProfileMask, true
}

// ---------------------------------------------------------------------------
// Adaptive filter stages
// ---------------------------------------------------------------------------

// refPredSign is a branchless sign, returning -1, 0 or +1.
func refPredSign(v int64) int64 {
	return (v >> 63) | int64(uint64(-v)>>63)
}

// refPredRoundShift divides by 2^shift, rounding to nearest and away from zero on
// ties. A plain arithmetic shift would round negative values towards negative
// infinity, biasing the predictor; more importantly the decoder must round
// identically, so this is the single definition both directions use.
func refPredRoundShift(v int64, shift uint) int64 {
	if v >= 0 {
		return (v + 1<<(shift-1)) >> shift
	}
	return -((-v + 1<<(shift-1)) >> shift)
}

// refPredClampTap applies refPredTapLimit. See the constant for why.
func refPredClampTap(w int64) int64 {
	if w > refPredTapLimit {
		return refPredTapLimit
	}
	if w < -refPredTapLimit {
		return -refPredTapLimit
	}
	return w
}

// refPredHistoryLen sizes the sliding history window for a given filter order.
//
// History is kept linear rather than circular so the tap loops walk contiguous
// memory with no index wrapping, which matters at 1098 packets a second. The
// cost is periodically sliding the newest `order` entries back to the front;
// making the window several times the order amortises that to negligible.
func refPredHistoryLen(order int) int {
	n := order * 8
	if n < 64 {
		n = 64
	}
	return n
}

// refComplexStage is one adaptive complex filter.
//
// Sign-sign LMS is used rather than true NLMS: the update needs only the signs
// of the error and of the history, so it costs two multiplies per tap with no
// division and no normalisation, and it is exactly reproducible in integers.
// Measured compression is within a fraction of a percent of a floating-point
// NLMS of the same order.
type refComplexStage struct {
	order int
	mu    int64

	// Taps in Q16.
	wr, wi []int64

	// History of reconstructed samples, and their signs kept alongside so the
	// update loop does not recompute a sign per tap per sample. Newest entry
	// is at idx-1.
	hr, hi []int64
	sr, si []int64
	idx    int
}

func refNewComplexStage(order int, mu int64) *refComplexStage {
	n := refPredHistoryLen(order)
	return &refComplexStage{
		order: order, mu: mu,
		wr: make([]int64, order), wi: make([]int64, order),
		hr: make([]int64, n), hi: make([]int64, n),
		sr: make([]int64, n), si: make([]int64, n),
		idx: order,
	}
}

// predict returns the filter's estimate of the next sample.
func (f *refComplexStage) predict() (int64, int64) {
	var pr, pi int64
	base := f.idx - 1
	for j := 0; j < f.order; j++ {
		br, bi := f.hr[base-j], f.hi[base-j]
		pr += f.wr[j]*br - f.wi[j]*bi
		pi += f.wr[j]*bi + f.wi[j]*br
	}
	return refPredRoundShift(pr, refPredTapShift), refPredRoundShift(pi, refPredTapShift)
}

// adapt nudges each tap by mu in the direction that would have reduced this
// error. The conjugate of the history is used, as the complex LMS gradient
// requires; here that is simply the negated sign of the imaginary part.
func (f *refComplexStage) adapt(er, ei int64) {
	// A zero error stops the update entirely, leak included. Without the leak
	// this was merely an optimisation the optimised copy could take and this
	// one need not; with it the two would part company on the first silent
	// packet, so it belongs in both.
	if er == 0 && ei == 0 {
		return
	}
	mr := f.mu * refPredSign(er)
	mi := f.mu * refPredSign(ei)
	base := f.idx - 1
	for j := 0; j < f.order; j++ {
		hrs := f.sr[base-j]
		his := -f.si[base-j]
		f.wr[j] = refPredClampTap(f.wr[j] + mr*hrs - mi*his - predLeak(f.wr[j], predLeakShiftComplex))
		f.wi[j] = refPredClampTap(f.wi[j] + mr*his + mi*hrs - predLeak(f.wi[j], predLeakShiftComplex))
	}
}

// push appends a reconstructed sample to the history, sliding the window when
// it fills.
func (f *refComplexStage) push(xr, xi int64) {
	f.hr[f.idx], f.hi[f.idx] = xr, xi
	f.sr[f.idx], f.si[f.idx] = refPredSign(xr), refPredSign(xi)
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
func (f *refComplexStage) forward(xr, xi int64) (int64, int64) {
	pr, pi := f.predict()
	er, ei := xr-pr, xi-pi
	f.adapt(er, ei)
	f.push(xr, xi)
	return er, ei
}

// inverse is the decoder direction: reconstruct a sample from its residual.
// It performs the same prediction, adaptation and history update as forward,
// which is what keeps the two sides identical.
func (f *refComplexStage) inverse(er, ei int64) (int64, int64) {
	pr, pi := f.predict()
	xr, xi := er+pr, ei+pi
	f.adapt(er, ei)
	f.push(xr, xi)
	return xr, xi
}

// refRealStage is refComplexStage with the imaginary terms removed, for mono audio.
type refRealStage struct {
	order int
	mu    int64
	w     []int64
	h     []int64
	s     []int64
	idx   int
}

func refNewRealStage(order int, mu int64) *refRealStage {
	n := refPredHistoryLen(order)
	return &refRealStage{
		order: order, mu: mu,
		w:   make([]int64, order),
		h:   make([]int64, n),
		s:   make([]int64, n),
		idx: order,
	}
}

func (f *refRealStage) predict() int64 {
	var p int64
	base := f.idx - 1
	for j := 0; j < f.order; j++ {
		p += f.w[j] * f.h[base-j]
	}
	return refPredRoundShift(p, refPredTapShift)
}

func (f *refRealStage) adapt(e int64) {
	if e == 0 {
		return
	}
	m := f.mu * refPredSign(e)
	base := f.idx - 1
	for j := 0; j < f.order; j++ {
		f.w[j] = refPredClampTap(f.w[j] + m*f.s[base-j] - predLeak(f.w[j], predLeakShiftReal))
	}
}

func (f *refRealStage) push(x int64) {
	f.h[f.idx], f.s[f.idx] = x, refPredSign(x)
	f.idx++
	if f.idx == len(f.h) {
		n := f.order
		copy(f.h, f.h[f.idx-n:f.idx])
		copy(f.s, f.s[f.idx-n:f.idx])
		f.idx = n
	}
}

func (f *refRealStage) forward(x int64) int64 {
	p := f.predict()
	e := x - p
	f.adapt(e)
	f.push(x)
	return e
}

func (f *refRealStage) inverse(e int64) int64 {
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

// refPredZigzag folds a signed value onto the non-negative integers so small
// magnitudes of either sign get short codes.
func refPredZigzag(v int32) uint32 {
	return uint32((v << 1) ^ (v >> 31))
}

// refRiceEncodeResiduals appends the Rice bitstream for res to dst and returns it.
//
// dst must have capacity for the worst case, which the caller sizes; see
// refPredScratchLen.
func refRiceEncodeResiduals(res []int32, dst []byte) []byte {
	var sum uint64
	for _, v := range res {
		sum += uint64(refPredZigzag(v))
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

	var acc uint64
	var nbits uint
	i := 0
	mask := uint32(1)<<k - 1

	// put writes w low bits of v. The accumulator is flushed in 32-bit units,
	// so nbits is always below 32 on entry and v must be at most 32 bits wide
	// for the shift to stay inside a uint64.
	put := func(v uint64, w uint) {
		acc |= v << nbits
		nbits += w
		for nbits >= 32 {
			binary.LittleEndian.PutUint32(buf[i:], uint32(acc))
			i += 4
			acc >>= 32
			nbits -= 32
		}
	}

	for _, v := range res {
		u := refPredZigzag(v)
		q := uint(u >> k)

		// The whole codeword fits one write when it is short enough. The bound
		// is 24 and not something larger because nbits can already be 31: at
		// 24 the shift needs 55 bits, safely inside a uint64, whereas allowing
		// 40 here would need 71 and silently drop the top bits. That was a real
		// bug, and it only showed up on the large unpredicted samples of a
		// high-dynamic-range band, where the unary run gets long.
		if q+k+1 <= 24 {
			put((uint64(u&mask)<<1)<<q|(uint64(1)<<q-1), q+k+1)
			continue
		}
		// Long unary run: emit it in chunks, then the stop bit and remainder.
		for r := q; r > 0; {
			c := r
			if c > 24 {
				c = 24
			}
			put(uint64(1)<<c-1, c)
			r -= c
		}
		put(uint64(u&mask)<<1, k+1)
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

// refRiceDecodeResiduals reverses refRiceEncodeResiduals into out, which must have
// length count.
func refRiceDecodeResiduals(src []byte, out []int32) error {
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

// refPredictiveCodec codes one direction of one stream.
//
// It is stateful across packets and NOT safe for concurrent use: create one per
// connection per direction, call it from a single goroutine, and drop it when
// the connection ends. See the stream lifetime note at the top of this file.
type refPredictiveCodec struct {
	prof refPredictorProfile
	cx   []*refComplexStage
	rl   []*refRealStage

	res []int32
	buf []byte
	hdr []byte // scratch for DecodeBody
}

// refNewPredictiveCodec builds a codec for the given profile id, rejecting one it
// does not implement.
//
// The error is deliberate. Falling back to a default profile would decode a
// stream with the wrong predictor and return plausible-looking noise rather
// than failing, which is the worst possible behaviour for a codec whose entire
// promise is bit-exactness.
func refNewPredictiveCodec(profileID byte) (*refPredictiveCodec, error) {
	p, ok := refPredProfiles[profileID]
	if !ok {
		return nil, fmt.Errorf("predictive codec: unknown profile id %d", profileID)
	}
	c := &refPredictiveCodec{prof: p}
	for i := range p.Orders {
		if p.Complex {
			c.cx = append(c.cx, refNewComplexStage(p.Orders[i], p.Mus[i]))
		} else {
			c.rl = append(c.rl, refNewRealStage(p.Orders[i], p.Mus[i]))
		}
	}
	return c, nil
}

// Profile reports the configuration in use, for logging.
func (c *refPredictiveCodec) Profile() refPredictorProfile { return c.prof }

// samplesPerStep is 2 for interleaved I/Q, 1 for mono.
func (c *refPredictiveCodec) samplesPerStep() int {
	if c.prof.Complex {
		return 2
	}
	return 1
}

// refPredScratchLen sizes the working buffer. The escape body is 2 bytes per
// sample; the coded body cannot exceed that by more than the flag and k bytes
// because the escape is taken when it would, but the encoder writes the coded
// form first and so must have room for a pathological bitstream.
func refPredScratchLen(n int) int { return n*5 + 64 }

// forward runs the cascade in the encoder direction over one sample position.
func (c *refPredictiveCodec) forward(a, b int64) (int64, int64) {
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
func (c *refPredictiveCodec) EncodeBody(samples []int16) (body []byte, escape bool, err error) {
	full, err := c.Encode(samples)
	if err != nil {
		return nil, false, err
	}
	return full[1:], full[0]&refPredEscapeFlag != 0, nil
}

// DecodeBody reverses EncodeBody. The caller supplies the escape flag from
// wherever it was carried.
func (c *refPredictiveCodec) DecodeBody(body []byte, count int, escape bool) ([]int16, error) {
	// Decode expects the flags byte in front. Rebuilding it here keeps one
	// decode path rather than two that could drift apart.
	if cap(c.hdr) < 1+len(body) {
		c.hdr = make([]byte, 1+len(body))
	}
	c.hdr = c.hdr[:1+len(body)]
	c.hdr[0] = c.prof.ID
	if escape {
		c.hdr[0] |= refPredEscapeFlag
	}
	copy(c.hdr[1:], body)
	return c.Decode(c.hdr, count)
}

// Encode codes one packet of samples and returns the payload body.
//
// For a complex profile, samples are interleaved I/Q and len(samples) must be
// even. The returned slice aliases an internal buffer that the next Encode
// call reuses, so copy it if it must outlive that.
func (c *refPredictiveCodec) Encode(samples []int16) ([]byte, error) {
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
	if cap(c.buf) < refPredScratchLen(n) {
		c.buf = make([]byte, refPredScratchLen(n))
	}
	c.res = c.res[:n]

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
	out = refRiceEncodeResiduals(c.res, out)

	// If prediction and coding did not pay for themselves, send the samples
	// as they are. The filters have already adapted over this packet above,
	// and the decoder adapts over the same verbatim samples, so state stays in
	// step through an escape.
	if len(out)-1 >= n*2 {
		out = c.buf[:1+n*2]
		out[0] = refPredEscapeFlag | c.prof.ID
		for i, v := range samples {
			binary.LittleEndian.PutUint16(out[1+2*i:], uint16(v))
		}
		return out, nil
	}
	out[0] = c.prof.ID
	return out, nil
}

// Decode reconstructs the samples of one packet body.
//
// count is the number of int16 samples the packet carries, which the caller
// derives from the packet length and header. The payload must have been coded
// with this codec's profile; check refPredictiveProfileID first and rebuild if it
// has changed.
func (c *refPredictiveCodec) Decode(payload []byte, count int) ([]int16, error) {
	step := c.samplesPerStep()
	if len(payload) < 1 {
		return nil, fmt.Errorf("predictive codec: empty payload")
	}
	if count <= 0 || count%step != 0 {
		return nil, fmt.Errorf("predictive codec: bad sample count %d for %d-channel profile", count, step)
	}
	if got := payload[0] & refPredProfileMask; got != c.prof.ID {
		return nil, fmt.Errorf("predictive codec: payload declares profile %d, codec is %d", got, c.prof.ID)
	}

	out := make([]int16, count)

	if payload[0]&refPredEscapeFlag != 0 {
		if len(payload) < 1+count*2 {
			return nil, fmt.Errorf("predictive codec: escape payload truncated (%d bytes for %d samples)", len(payload), count)
		}
		for i := 0; i < count; i++ {
			out[i] = int16(binary.LittleEndian.Uint16(payload[1+2*i:]))
		}
		// Advance the filters over these samples exactly as the encoder did,
		// discarding the residuals it produced.
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
	if err := refRiceDecodeResiduals(payload[1:], c.res); err != nil {
		return nil, err
	}

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

package pcmv4

import (
	"encoding/binary"
	"fmt"
	"math/bits"
)

// Predictive lossless codec for PCM audio and IQ (receive side)
// =============================================================
//
// The decoding half of the server's pcm_predictive.go, which is the payload
// codec for protocol version 4. It replaces the zstd wrapper that versions 1-3
// put around every pcm-zstd packet -- zstd made this data LARGER, because it is
// an LZ77 matcher over bytes and a band-limited RF signal has no repeated byte
// strings, only sample-to-sample correlation that a predictor extracts and a
// byte matcher cannot.
//
// HOW IT WORKS
// ------------
// Each sample is predicted from those before it by an adaptive filter; only
// the prediction error is transmitted, Rice coded. The filter is BACKWARD
// adaptive: its taps are derived from samples already decoded, so this side
// recomputes them independently and no coefficients are ever sent. All state
// is integer with shifts, never floating point, so server and client agree bit
// for bit on every platform -- which is what makes the lossless claim
// meaningful across a Go server, this Go client and the browser.
//
// Every arithmetic detail below therefore has to match the server EXACTLY:
// the rounding of the prediction sum, the sign convention, the tap clamp, the
// order in which stages are inverted, and the point at which the fast path
// skips the clamp. A difference in any of them does not fail loudly; it
// returns plausible-sounding noise.
//
// PROFILES: THE SERVER DECIDES
// ----------------------------
// Each packet DECLARES the profile it was coded with, in the header's flags
// byte. This client reads the declaration and obeys it; it never infers the
// predictor from the mode, the channel count or the sample rate. That is what
// lets the server retune its choice -- a deeper cascade for carrier-heavy
// bands, say -- without breaking a deployed client.
//
// Profile ids are fixed for the life of a protocol version, so a client that
// negotiated version 4 understands every profile a version 4 server emits. An
// unknown id is therefore a hard error rather than a fallback to profile 0,
// which would decode noise and call it audio.
//
// PAYLOAD FORMAT
// --------------
//	Coded body:  [rice k u8][rice bitstream]
//	Escape body: samples as little-endian int16, in order
//
// The escape exists because a predictor cannot help a full-entropy signal, and
// a saturated front end produces exactly that. The predictor is still advanced
// across an escaped packet, on both sides, so the filter state stays in step
// through one -- as it is across a silent packet, which carries no body at all.
//
// STREAM LIFETIME
// ---------------
// A codec instance IS the stream. Its taps carry the adaptation of every
// sample decoded so far, so it must be created per connection, used by exactly
// one goroutine, and discarded when the socket closes. A packet that never
// reaches this codec desynchronises it from the server, which is why the
// receive path decodes every frame it is handed even when the frame is then
// dropped for being late.

const (
	// predTapShift is the fixed-point scale of the filter taps: they are
	// integers in Q16, so 65536 represents a tap of 1.0.
	predTapShift = 16

	// predTapLimit bounds |tap| to 2^24, a real-valued magnitude of 256. It
	// caps the prediction sum far below int64 overflow no matter what the
	// input does. With the leak below holding the taps near their equilibrium
	// the clamp is insurance that never fires in practice -- but it must be applied
	// identically on both sides, since if it ever does fire the two must agree.
	predTapLimit = 1 << 24

	// predLeakShiftComplex and predLeakShiftReal are the leakage of the tap
	// update: every adapt subtracts w/2^shift from each tap before adding the
	// gradient step.
	//
	// Without it the taps have no restoring force and are free to walk in any
	// direction the input does not excite, which on a band whose energy sits in
	// a few carriers is most of them. Measured on a 909 kHz iq384 stream they
	// walked until the stream cost more than the samples going into it. The
	// server's pcm_predictive.go carries the full account and the measurements
	// behind these two values.
	//
	// This side reproduces the arithmetic exactly or the two ends part company
	// within a packet: the magnitude is truncated towards zero, so a tap
	// smaller than 2^shift leaks nothing, and a negative tap leaks the negation
	// of what its magnitude would -- NOT what an arithmetic shift of a negative
	// value gives.
	predLeakShiftComplex = 14
	predLeakShiftReal    = 16

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
	// version.
	ID byte

	// Name is for logs and diagnostics only. Nothing on the wire depends on it.
	Name string

	// Complex selects the filter form: true for interleaved I/Q, false for
	// mono. This is dictated by the signal, not a tuning choice -- a carrier in
	// complex baseband is a single complex pole that one complex tap cancels
	// exactly, which treating I and Q as two real streams throws away.
	Complex bool

	// Orders and Mus define the cascade, one entry per stage. Each stage
	// predicts the residual left by the stage before it. Mu is the sign-sign
	// step size in Q16 tap units.
	Orders []int
	Mus    []int64
}

// Profile ids. These values are part of the version 4 wire format and must not
// be reassigned.
const (
	// PredProfileIQ is a single complex filter of order 16.
	PredProfileIQ byte = 0

	// PredProfileIQScaled is PredProfileIQ with a reduced-depth front end, and
	// is what -min-margin asks the server for. The body carries a shift byte in
	// front of the coded payload and the samples were requantised by that shift
	// before the predictor saw them; the predictor itself is identical, because
	// the scaling happens outside it.
	//
	// A separate profile id rather than a flag, so that a client which did not
	// ask for the lossy mode cannot be handed one by accident: an unknown
	// profile is a hard error here, where an unrecognised flag bit might be
	// ignored and the samples then delivered several bits too quiet.
	PredProfileIQScaled byte = 2

	// PredProfileAudio is a four-stage real cascade, orders 8/8/4/2. Depth
	// matters far more than filter length on demodulated audio, which carries
	// a ~2.65 kHz passband in a 12 kHz channel and so leaves structure at
	// several scales for successive stages to remove.
	PredProfileAudio byte = 1
)

// predProfiles is the registry the wire format refers to. It must match the
// server's table exactly, entry for entry.
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

// ---------------------------------------------------------------------------
// Adaptive filter stages
// ---------------------------------------------------------------------------

// predSign is a branchless sign, returning -1, 0 or +1.
func predSign(v int64) int64 {
	return (v >> 63) | int64(uint64(-v)>>63)
}

// predRoundShift divides by 2^shift, rounding to nearest and away from zero on
// ties. A plain arithmetic shift would round negative values towards negative
// infinity, biasing the predictor; more importantly the server rounds this way,
// so this is the single definition both directions use.
func predRoundShift(v int64, shift uint) int64 {
	m := v >> 63
	r := (((v ^ m) - m) + 1<<(shift-1)) >> shift
	return (r ^ m) - m
}

// predLeak is the amount the leakage removes from one tap, the magnitude
// divided by 2^shift and truncated towards zero. See predLeakShiftComplex.
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
// memory with no index wrapping. The cost is periodically sliding the newest
// `order` entries back to the front; making the window several times the order
// amortises that to negligible.
func predHistoryLen(order int) int {
	n := order * 8
	if n < 64 {
		n = 64
	}
	return n
}

// complexStage is one adaptive complex filter, for interleaved I/Q.
//
// Sign-sign LMS is used rather than true NLMS: the update needs only the signs
// of the error and of the history, so it costs two multiplies per tap with no
// division and no normalisation, and it is exactly reproducible in integers.
type complexStage struct {
	order int
	mu    int64

	// Taps in Q16, stored oldest-first: wr[i] weighs the history sample at
	// hr[idx-order+i], so predict and adapt walk taps and history forward
	// together.
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
// error. The conjugate of the history is used, as the complex LMS gradient
// requires; here that is simply the negated sign of the imaginary part.
//
// A zero error is a genuine no-op -- both steps are zero and every tap is
// already inside the clamp -- so it returns without touching the taps. That
// turns the adapt pass over silence into a return.
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
// contributes at most mu), so if every tap starts further than 2*mu*steps from
// the limit, no update in this packet can reach it and the clamp is an
// identity. The server makes the same decision from the same taps, so the two
// take the same path -- and the clamped loop produces identical values anyway
// when it does run.
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
// The decoder needs it too, to advance the filters across an escaped or silent
// packet exactly as the encoder did.
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
// in unary, then a stop bit, then the low k bits raw. k is chosen per packet by
// the encoder and transmitted as the first byte of the body.

// riceDecodeResiduals reverses the server's riceEncodeResiduals into out, which
// must have length count.
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

// PredictiveCodec decodes one stream.
//
// It is stateful across packets and NOT safe for concurrent use: create one per
// connection, call it from a single goroutine, and drop it when the connection
// ends. See the stream lifetime note at the top of this file.
type PredictiveCodec struct {
	prof PredictorProfile
	cx   []*complexStage
	rl   []*realStage

	res []int32
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

// forward runs the cascade in the encoder direction over one sample position,
// which is how the filters are advanced across a packet whose samples are
// already known -- an escape, or the implied zeros of a silent packet.
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

// DecodeBody reconstructs one packet body, with the escape flag supplied from
// the header that carried it.
//
// Version 4 keeps the profile and the escape bit in the packet header, where
// they are needed anyway to tell a v4 packet from an Opus frame; repeating them
// in the body would waste a byte on every packet. Decode expects them in front
// all the same, so they are rebuilt here rather than grown into a second decode
// path that could drift from the first.
func (c *PredictiveCodec) DecodeBody(body []byte, count int, escape bool) ([]int16, error) {
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

// AdvanceSilence advances the filters over count zero-valued samples.
//
// A silent packet carries no body at all: Rice coding cannot get all-zero
// residuals below one bit per sample, and a squelched session sends nothing but
// zeros indefinitely, so the header says "all zero" and the body is omitted.
// The predictor still has to move exactly as the encoder's did over the same
// zeros, or every packet after this one decodes wrongly.
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
// count is the number of int16 samples the packet carries, which the header
// states outright -- a coded body has no length relationship to its sample
// count, which is what compression means. The payload must have been coded with
// this codec's profile.
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

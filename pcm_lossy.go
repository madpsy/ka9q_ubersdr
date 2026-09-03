package main

import (
	"math"
	"math/bits"
	"sync"
	"sync/atomic"
)

// Reduced-depth mode for IQ streams
// =================================
//
// An optional, client-requested mode that requantises each IQ packet before the
// predictor sees it. The body codec is untouched: the saving comes entirely from
// the numbers going into it being smaller, which shortens every Rice codeword.
// The scale is a power of two and travels in the packet, so both ends apply
// identical integer shifts and the predictor stays bit-exact on the quantised
// grid.
//
// WHAT THE CLIENT ASKS FOR
// ------------------------
// Not a bit depth -- a MARGIN. `min_margin` is how far below the band's own
// noise floor the quantisation floor must stay, in dB, and the depth needed to
// honour it is worked out per packet.
//
// A depth cannot be promised to anyone, because what it costs depends entirely
// on the signal: measured across seven live captures, ten bits left 50 dB of
// headroom on a quiet 6 m band and only 9 dB on medium wave. A margin means the
// same thing on every band, which is what lets an IQ client -- a waterfall, a
// skimmer, an external SDR program -- reason about the stream without knowing
// what it is tuned to.
//
// The saving therefore varies, and varies the right way. At a 20 dB request:
//
//	quiet 6 m           60.6%      medium wave        15.6%
//	40 m, 192 kHz       59.9%      20 m, 48 kHz       50.3%
//
// Medium wave spends the bytes because its carriers sit 60 dB over the noise and
// it genuinely needs the depth; a dead band gives them up because it does not.
// No fixed depth can do that, and picking one that is safe on medium wave wastes
// three quarters of the available saving everywhere else.
//
// HOW THE DEPTH IS CHOSEN
// -----------------------
// The achieved margin is predictable in closed form from two statistics:
//
//	margin(N) = 6.02*(N-1) + lossyCalibrationDB - crest - peakiness
//
// `crest` is the packet's peak over its RMS. `peakiness` is how far the median
// power-spectrum bin sits below the mean. Checked against seven live captures
// spanning 9 to 50 dB of measured margin, this predicts to within 0.7 dB.
//
// Crest alone will not do, and is worse than useless: per packet it spans only
// 1.6 to 7.3 dB across every capture measured, and medium wave -- the one band
// that cannot afford a coarse quantiser -- has the LOWEST crest of the set. What
// singles medium wave out is 47.9 dB of spectral peakiness against 1.3 dB on a
// quiet band, because carriers put the mean bin far above the median while the
// weak signals that must survive sit near the median.
//
// WHY THIS IS SAFE FOR EXISTING CLIENTS
// -------------------------------------
// The mode is reachable only by asking for it. A packet coded this way declares
// profile PredProfileIQScaled, which no released client implements, and both the
// Go and JavaScript decoders treat an unknown profile as a hard error rather
// than falling back -- see NewPredictiveCodec and _useProfile in pcm-v4.js. A
// client that does not send `min_margin` is never handed one, and one that
// somehow received it would fail loudly instead of playing noise.
//
// That is also why no protocol version bump is needed. SPEC.md 6.1 allows a new
// profile on "a version bump or an explicit client-advertised capability", and
// the query parameter is exactly such a capability.
//
// The estimator runs on the encoder only. Nothing the decoder does depends on
// reproducing it, so it may use floating point freely and may be replaced -- per
// band, per mode, or with readings taken from the receiver -- without any
// deployed client changing. Only the shift is on the wire, and a shift is not a
// policy.

const (
	// lossyMinMarginDB and lossyMaxMarginDB clamp what a client may ask for.
	//
	// The floor is where the quantisation noise starts to lift the noise floor a
	// client can actually see. Adding an uncorrelated floor `m` dB down raises
	// the total by 10*log10(1 + 10**(-m/10)):
	//
	//	20 dB   0.04 dB   invisible
	//	15 dB   0.14 dB   below the 0.1 dB a meter resolves
	//	10 dB   0.41 dB
	//	 6 dB   0.97 dB   an audible, measurable change
	//
	// 15 dB is the last step that stays under what a receiver's own readings can
	// resolve, so it is the floor. Above 60 dB the request buys nothing --
	// measured, 60 dB leaves under 8% on every capture -- and a client wanting
	// less than that should omit the parameter and get the lossless path, which
	// keeps archival streams honestly labelled rather than marked lossy and
	// shifted by zero.
	lossyMinMarginDB = 15.0
	lossyMaxMarginDB = 60.0

	// lossyCalibrationDB is the constant in the margin model above, fitted to
	// the live captures in ubersdr-iq/bitdepth-iq. It leaves the delivered
	// margin 2 to 5 dB above the request across every capture measured, which is
	// the direction to be wrong in.
	lossyCalibrationDB = 4.0

	// lossyMaxDepth bounds how fine the quantiser may go. At 17 the shift is
	// zero for any packet, so a high margin request degrades continuously to a
	// bit-exact stream rather than hitting a cliff.
	lossyMaxDepth = 17

	// lossyFFTSize is the transform used for the peakiness estimate, and
	// lossyUpdateMillis how often it runs -- the cadence the receiver already
	// refreshes its own readings at. Ten transforms a second against a codec
	// already spending tens of microseconds per packet is not measurable.
	lossyFFTSize      = 1024
	lossyUpdateMillis = 100

	// lossyPSDSmoothing is the weight given to each new spectrum. A tenth
	// averages over about a second, which stops one unrepresentative window
	// from setting the depth for the packets that follow it.
	lossyPSDSmoothing = 0.1

	// lossyColdPeakinessDB is assumed before enough samples have arrived for a
	// real estimate. It is deliberately pessimistic: it drives the depth deep,
	// so the opening packets of a stream are near-lossless rather than
	// near-destroyed. An earlier revision assumed the opposite and quantised the
	// first 100 ms of every stream to four bits, which on medium wave was 0.34%
	// of packets carrying 99.7% of the error.
	lossyColdPeakinessDB = 60.0
)

// Window, twiddle and bit-reversal tables for the fixed transform size.
//
// All three depend only on lossyFFTSize, so they are built once for the process
// rather than per session: they are read-only, and a receiver carrying many IQ
// sessions would otherwise hold an identical copy for each. Precomputing them
// also keeps every transcendental out of the hot path -- the earlier revision
// called math.Cos once per sample per refresh to build the window, which cost
// more than the transform it was preparing.
var (
	lossyTables sync.Once
	lossyWindow []float64
	lossyTwRe   []float64
	lossyTwIm   []float64
	lossyRev    []uint16
)

func lossyInitTables() {
	n := lossyFFTSize
	lossyWindow = make([]float64, n)
	for i := range lossyWindow {
		lossyWindow[i] = 0.5 - 0.5*math.Cos(2*math.Pi*float64(i)/float64(n))
	}
	lossyTwRe = make([]float64, n/2)
	lossyTwIm = make([]float64, n/2)
	for k := 0; k < n/2; k++ {
		ang := -2 * math.Pi * float64(k) / float64(n)
		lossyTwRe[k], lossyTwIm[k] = math.Cos(ang), math.Sin(ang)
	}
	lossyRev = make([]uint16, n)
	shift := uint(bits.TrailingZeros(uint(n)))
	for i := 0; i < n; i++ {
		lossyRev[i] = uint16(bits.Reverse64(uint64(i)) >> (64 - shift))
	}
}

// LossyMarginFromQuery clamps a client's requested margin, reporting whether the
// lossy path is wanted at all. A zero or unparseable request means lossless,
// which is the default for everything that does not ask.
//
// The result is a whole number of decibels. Nothing is gained by finer steps --
// one dB of margin is a sixth of a bit of depth, well under the 2 to 5 dB the
// delivered margin already sits above the request -- and rounding here means the
// value a client is told it asked for is the value it gets.
func LossyMarginFromQuery(v float64, present bool) (float64, bool) {
	if !present || !(v > 0) { // also rejects NaN
		return 0, false
	}
	v = math.Round(v)
	if v < lossyMinMarginDB {
		v = lossyMinMarginDB
	}
	if v > lossyMaxMarginDB {
		v = lossyMaxMarginDB
	}
	return v, true
}

// LossyMarginCell carries a margin that may change while a stream is running.
//
// Changing the margin needs no reconnect and no client change: the depth is
// chosen per packet and the shift already travels in the packet, so a new margin
// simply takes effect on the next one. Only crossing between lossy and lossless
// changes the profile, and that path rebuilds the codec exactly as a mode change
// does.
//
// It is an atomic because the value is written from the socket's read goroutine
// and read by the one driving the encoder, which is otherwise strictly single
// threaded.
type LossyMarginCell struct {
	bits atomic.Uint64
}

// NewLossyMarginCell returns a cell holding an initial margin in dB.
func NewLossyMarginCell(dB float64) *LossyMarginCell {
	c := &LossyMarginCell{}
	c.Set(dB)
	return c
}

// Set replaces the margin. Zero means lossless.
func (c *LossyMarginCell) Set(dB float64) {
	if c == nil {
		return
	}
	c.bits.Store(math.Float64bits(dB))
}

// Get reports the margin in dB, or zero for the lossless path.
func (c *LossyMarginCell) Get() float64 {
	if c == nil {
		return 0
	}
	return math.Float64frombits(c.bits.Load())
}

// setMargin retargets an existing selector.
//
// The smoothed spectrum is a property of the band, not of the margin, so it is
// kept: a client moving the slider gets the new depth on the very next packet
// rather than waiting for the estimate to settle again.
func (s *lossyDepthSelector) setMargin(dB float64) {
	s.marginDB = dB
}

// lossyDepthSelector chooses one shift per packet for one stream.
//
// Stateful across packets -- it carries the smoothed spectrum -- so it belongs
// to a single connection and a single goroutine, like the codec beside it.
type lossyDepthSelector struct {
	marginDB float64

	// ring holds the most recent lossyFFTSize complex frames, so a transform can
	// be taken without retaining a second of baseband.
	//
	// It is filled ONLY while a refresh is near. A 384 kHz stream delivers 38400
	// frames between refreshes and the transform needs the last 1024 of them, so
	// 97% of packets need not touch it at all -- and at that rate the copying was
	// costing far more than the ten transforms a second ever could.
	ringRe, ringIm []float64
	ringPos        int
	ringFilled     bool

	// psd is the smoothed power spectrum and framesSince counts down to the
	// next transform.
	psd         []float64
	psdValid    bool
	framesSince int
	updateEvery int

	peakinessDB float64

	// ringFrames counts frames actually copied into the window. It exists so a
	// test can assert the copying stays rare without timing anything: the
	// obvious regression here is a 1.5x slowdown, which is too small to pin down
	// with a wall clock but is unmistakable as a count.
	ringFrames int64

	// Scratch for the transform and for the median selection, kept to stay off
	// the allocator: a fresh slice per refresh was 8 kB of garbage a second per
	// session for a value that is overwritten immediately.
	fftRe, fftIm []float64
	sel          []float64
}

func newLossyDepthSelector(marginDB float64, sampleRate int) *lossyDepthSelector {
	lossyTables.Do(lossyInitTables)
	every := sampleRate * lossyUpdateMillis / 1000
	if every < 1 {
		every = 1
	}
	return &lossyDepthSelector{
		marginDB:    marginDB,
		ringRe:      make([]float64, lossyFFTSize),
		ringIm:      make([]float64, lossyFFTSize),
		psd:         make([]float64, lossyFFTSize),
		updateEvery: every,
		peakinessDB: lossyColdPeakinessDB,
		fftRe:       make([]float64, lossyFFTSize),
		fftIm:       make([]float64, lossyFFTSize),
		sel:         make([]float64, lossyFFTSize),
	}
}

// appendFrames copies one packet's frames into the trailing window.
//
// Only the last lossyFFTSize of them can matter, so a packet longer than the
// window is trimmed to its tail before anything is copied.
func (s *lossyDepthSelector) appendFrames(samples []int16) {
	frames := len(samples) / 2
	if frames > lossyFFTSize {
		samples = samples[2*(frames-lossyFFTSize):]
		frames = lossyFFTSize
	}
	s.ringFrames += int64(frames)
	for i := 0; i < frames; i++ {
		s.ringRe[s.ringPos] = float64(samples[2*i])
		s.ringIm[s.ringPos] = float64(samples[2*i+1])
		s.ringPos++
		if s.ringPos == lossyFFTSize {
			s.ringPos = 0
			s.ringFilled = true
		}
	}
}

// lossyMedian returns the median by quickselect, permuting buf.
//
// Selection rather than a full sort: only the middle element is wanted, and
// selection is linear where sorting 1024 bins is some ten thousand comparisons.
func lossyMedian(buf []float64) float64 {
	k := len(buf) / 2
	lo, hi := 0, len(buf)-1
	for lo < hi {
		pivot := buf[(lo+hi)/2]
		i, j := lo, hi
		for i <= j {
			for buf[i] < pivot {
				i++
			}
			for buf[j] > pivot {
				j--
			}
			if i <= j {
				buf[i], buf[j] = buf[j], buf[i]
				i++
				j--
			}
		}
		if k <= j {
			hi = j
		} else if k >= i {
			lo = i
		} else {
			break
		}
	}
	return buf[k]
}

// refresh recomputes the peakiness estimate from the trailing window.
//
// It does nothing until the window has filled. Latching a placeholder and
// holding it for a whole update period is precisely the mistake documented at
// lossyColdPeakinessDB, so an incomplete window leaves the pessimistic default
// standing and is retried on the next packet.
func (s *lossyDepthSelector) refresh() {
	if !s.ringFilled {
		return
	}
	// Copy out oldest-first and window it. A Hann window costs one multiply per
	// sample and keeps a strong carrier from smearing across every bin, which
	// would raise the median and hide the very peakiness being measured.
	// Oldest-first, windowed. The ring size is a power of two so the wrap is a
	// mask rather than a division.
	const mask = lossyFFTSize - 1
	for i := 0; i < lossyFFTSize; i++ {
		j := (s.ringPos + i) & mask
		w := lossyWindow[i]
		s.fftRe[i] = s.ringRe[j] * w
		s.fftIm[i] = s.ringIm[j] * w
	}
	lossyFFT(s.fftRe, s.fftIm)

	if !s.psdValid {
		for i := range s.psd {
			s.psd[i] = s.fftRe[i]*s.fftRe[i] + s.fftIm[i]*s.fftIm[i]
		}
		s.psdValid = true
	} else {
		for i := range s.psd {
			p := s.fftRe[i]*s.fftRe[i] + s.fftIm[i]*s.fftIm[i]
			s.psd[i] += lossyPSDSmoothing * (p - s.psd[i])
		}
	}

	// Peakiness is the mean bin over the median bin. Both are taken from the
	// same smoothed spectrum, so the window's own gain cancels and no absolute
	// calibration is needed -- which is what makes this immune to the operator
	// gain and AGC offsets that make the header's dBFS readings unusable here.
	copy(s.sel, s.psd)
	median := lossyMedian(s.sel)
	var sum float64
	for _, v := range s.psd {
		sum += v
	}
	mean := sum / float64(len(s.psd))
	if median <= 0 || mean <= 0 {
		return
	}
	s.peakinessDB = 10 * math.Log10(mean/median)
}

// shiftFor returns the shift for one packet of interleaved I/Q samples, and
// advances the trailing window over them.
func (s *lossyDepthSelector) shiftFor(samples []int16) uint {
	// Peak and power in one integer pass. Squares of int16 sum to at most
	// 2^30 per sample, so even a very long packet stays far inside an int64,
	// and integer arithmetic here is both faster and exact.
	var peak, power int64
	for _, v := range samples {
		x := int64(v)
		power += x * x
		if x < 0 {
			x = -x
		}
		if x > peak {
			peak = x
		}
	}
	frames := len(samples) / 2

	// Touch the ring only when the next refresh is close enough that these
	// frames could still be in the window when it happens.
	if s.updateEvery <= lossyFFTSize || s.framesSince+frames > s.updateEvery-lossyFFTSize {
		s.appendFrames(samples)
	}
	s.framesSince += frames
	if s.framesSince >= s.updateEvery {
		s.framesSince = 0
		s.refresh()
	}
	if peak == 0 || frames == 0 {
		return 0
	}

	rms := math.Sqrt(float64(power) / float64(frames))
	if rms <= 0 {
		return 0
	}
	crestDB := 20 * math.Log10(float64(peak)/rms)

	depth := (s.marginDB-lossyCalibrationDB+crestDB+s.peakinessDB)/6.02 + 1.0
	n := int(math.Ceil(depth))
	if n < 2 {
		n = 2
	}
	if n > lossyMaxDepth {
		n = lossyMaxDepth
	}

	width := bits.Len64(uint64(peak))
	shift := width - (n - 1)
	if shift < 0 {
		shift = 0
	}
	// Never so coarse that the peak stops being representable at all.
	if max := width - 1; shift > max {
		shift = max
	}
	return uint(shift)
}

// lossyQuantise applies a shift in place, rounding to nearest and clamping to
// the depth the shift implies.
//
// Rounding rather than truncating matters: at ten bits half a step of the coarse
// grid is not a rounding detail, it is 42 dB below the peak. Clamping matters
// because rounding can carry a full-scale peak one step past the ceiling, and
// restoring that wraps a full-scale positive sample to full-scale negative.
func lossyQuantise(samples []int16, shift uint) {
	if shift == 0 {
		return
	}
	half := int32(1) << (shift - 1)
	lo, hi := int32(-32768)>>shift, int32(32767)>>shift
	for i, v := range samples {
		q := (int32(v) + half) >> shift
		if q < lo {
			q = lo
		} else if q > hi {
			q = hi
		}
		samples[i] = int16(q)
	}
}

// lossyRestore is the decoder's half: back onto the int16 grid.
func lossyRestore(samples []int16, shift uint) {
	if shift == 0 {
		return
	}
	for i, v := range samples {
		r := int32(v) << shift
		if r > 32767 {
			r = 32767
		} else if r < -32768 {
			r = -32768
		}
		samples[i] = int16(r)
	}
}

// lossyFFT is an in-place iterative radix-2 complex transform.
//
// Written out rather than pulled in because the server has no FFT of its own --
// everything named FFT here handles spectrum data arriving from radiod -- and
// one transform of a fixed power-of-two size is far less code than a dependency.
// It runs on the encoder alone, so nothing about the wire format depends on it
// agreeing with anyone else's bit for bit.
func lossyFFT(re, im []float64) {
	n := len(re)
	rev := lossyRev
	for i := 0; i < n; i++ {
		if j := int(rev[i]); i < j {
			re[i], re[j] = re[j], re[i]
			im[i], im[j] = im[j], im[i]
		}
	}
	// Twiddles come from the table rather than a running complex multiply. The
	// recurrence the earlier revision used accumulated rounding across a stage
	// and cost two multiplies per butterfly to advance; a table lookup costs
	// neither.
	twRe, twIm := lossyTwRe, lossyTwIm
	for length := 2; length <= n; length <<= 1 {
		half := length >> 1
		stride := n / length
		for i := 0; i < n; i += length {
			for j, k := 0, 0; j < half; j, k = j+1, k+stride {
				wRe, wIm := twRe[k], twIm[k]
				lo, hi := i+j, i+j+half
				vRe := re[hi]*wRe - im[hi]*wIm
				vIm := re[hi]*wIm + im[hi]*wRe
				uRe, uIm := re[lo], im[lo]
				re[lo], im[lo] = uRe+vRe, uIm+vIm
				re[hi], im[hi] = uRe-vRe, uIm-vIm
			}
		}
	}
}

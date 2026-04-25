package main

// websdr_adpcm.go — WebSDR custom audio codec
//
// Implements the 20-tap adaptive linear predictor + Rice-like bitstream encoder
// described in the VertexSDR frontend-protocol-spec.md §3.5–3.6, plus the
// G.711 µ-law fallback (§3.4).
//
// The codec operates on blocks of 128 float32 samples (normalised ±1.0 range
// from radiod) and produces a variable-length byte slice per block.

import (
	"math"
)

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const (
	websdrBlockSamples = 128 // samples per audio block
	websdrPredTaps     = 20  // predictor taps

	// blockSize is the quantisation step used in the predictor update loop (§3.6).
	// The spec says this is driven by server config audioformat (40/128/256/512).
	// We use 128 as the default (audioformat index 1), which matches the block
	// sample count and is the most common WebSDR server setting.
	websdrPredBlockSize = 128
)

// quantisation mode table (mode index 1–5)
// quant_step, quotient_limit, reduced_mant_bits
var websdrQuantModes = [6]struct {
	step         int
	quotientLim  int
	reducedMant  int
	shrinkThresh [2]int // thresholds for first and second mantissa shrink
}{
	0: {}, // unused (mode 0 not valid)
	// Shrink thresholds derived from the browser decoder's s[] array:
	//   s = [999, 999, 8, 4, 2, 1, 99, 99]
	// For mode v: 1st threshold = s[v], 2nd threshold = s[v-1].
	1: {step: 1, quotientLim: 14, reducedMant: 0, shrinkThresh: [2]int{999, 999}},
	2: {step: 2, quotientLim: 13, reducedMant: 1, shrinkThresh: [2]int{8, 999}},
	3: {step: 4, quotientLim: 12, reducedMant: 2, shrinkThresh: [2]int{4, 8}},
	4: {step: 8, quotientLim: 11, reducedMant: 3, shrinkThresh: [2]int{2, 4}},
	5: {step: 16, quotientLim: 10, reducedMant: 4, shrinkThresh: [2]int{1, 2}},
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSDRAdpcmEncoder — per-client state
// ─────────────────────────────────────────────────────────────────────────────

// WebSDRAdpcmEncoder holds the per-connection codec state.
type WebSDRAdpcmEncoder struct {
	predH     [websdrPredTaps]int // predictor coefficients
	predX     [websdrPredTaps]int // predictor delay line
	predAccum int                 // running accumulator (× 16)

	// conv_type bit 4: if set, non-accumulating predictor (adpcm_shift=12)
	// if clear, accumulating predictor (adpcm_shift=14)
	convType int

	// AGC state
	agcGain float32

	// last quant mode (for mode-change detection in bitstream header)
	lastQuantMode int

	// Squelch state (§3.6)
	squelchCounter int // counts frames where squelch is closed; silence after >899
}

// NewWebSDRAdpcmEncoder creates a fresh encoder with all state zeroed.
func NewWebSDRAdpcmEncoder() *WebSDRAdpcmEncoder {
	return &WebSDRAdpcmEncoder{
		agcGain:       1.0,
		lastQuantMode: 0, // force mode byte on first frame
	}
}

// Reset clears predictor state (called after µ-law fallback or squelch silence).
func (e *WebSDRAdpcmEncoder) Reset() {
	for i := range e.predH {
		e.predH[i] = 0
	}
	for i := range e.predX {
		e.predX[i] = 0
	}
	e.predAccum = 0
	e.lastQuantMode = 0
	e.squelchCounter = 0
}

// adpcmShift returns the shift parameter based on conv_type bit 4.
func (e *WebSDRAdpcmEncoder) adpcmShift() int {
	if e.convType&0x10 != 0 {
		return 12
	}
	return 14
}

// ─────────────────────────────────────────────────────────────────────────────
// Encode — main entry point
// ─────────────────────────────────────────────────────────────────────────────

// SquelchResult is returned by Encode to indicate whether the squelch fired.
type SquelchResult int

const (
	SquelchOpen   SquelchResult = 0 // audio present, normal encode
	SquelchClosed SquelchResult = 1 // squelch closed, caller should send 0x84
)

// Encode encodes up to websdrBlockSamples float32 samples (normalised ±1.0)
// using AGC and the adaptive predictor.  Returns the complete binary payload
// (tag bytes are prepended by the caller) and a squelch result.
//
// scale is the linear gain factor (computed by caller from AGC or manual gain).
// squelchEnabled: if true, squelch evaluation is performed (§3.6).
// squelchThreshold: ratio threshold for squelch (e.g. 0.1).
func (e *WebSDRAdpcmEncoder) Encode(samples []float32, scale float32, squelchEnabled bool, squelchThreshold float64) ([]byte, SquelchResult) {
	if len(samples) > websdrBlockSamples {
		samples = samples[:websdrBlockSamples]
	}
	n := len(samples)

	// ── 1. Compute residuals and check for overflow ──────────────────────────
	residuals := make([]int, n)
	rawDeltas := make([]int, n)
	errors := make([]int, n)
	overflow := false

	shift := e.adpcmShift()
	blockSize := websdrPredBlockSize

	// Snapshot predictor state so we can roll back on overflow
	snapH := e.predH
	snapX := e.predX
	snapAccum := e.predAccum

	for i := 0; i < n; i++ {
		// Prediction: sum(h[j]*x[j]) / 4096
		predSum := 0
		for j := 0; j < websdrPredTaps; j++ {
			predSum += e.predH[j] * e.predX[j]
		}
		prediction := predSum / 4096

		// Input scaled to integer
		rawDelta := int(samples[i]*scale) - (e.predAccum >> 4)
		rawDeltas[i] = rawDelta

		// Residual
		err := rawDelta - prediction
		errors[i] = err

		// Quantise residual using blockSize as the quantisation step (§3.6)
		negHalf := -(blockSize / 2)
		blkShift := blockSize << 16
		wrapped := (negHalf+blkShift+err)/blockSize - 0x10000

		// Clamp magnitude
		aw := wrapped
		if aw < 0 {
			aw = -aw
		}
		mask := -1
		if aw > 16 {
			if aw <= 32 {
				mask = -2
			} else {
				mask = -4
			}
		}
		wrapped = mask & wrapped
		residuals[i] = wrapped

		// Overflow check
		absWrapped := wrapped
		if absWrapped < 0 {
			absWrapped = -absWrapped
		}
		if absWrapped > 1000 {
			overflow = true
		}

		// Adapt sample for coefficient update
		scaled := blockSize*wrapped + (blockSize / 2)
		adaptSample := scaled >> 4

		// Update delay line and coefficients (tap 19 down to 1)
		for j := websdrPredTaps - 1; j >= 1; j-- {
			newH := e.predH[j] + ((adaptSample * e.predX[j]) >> shift) - (e.predH[j] >> 7)
			e.predX[j] = e.predX[j-1]
			e.predH[j] = newH
		}
		// Tap 0
		newH0 := e.predH[0] + ((e.predX[0] * adaptSample) >> shift) - (e.predH[0] >> 7)
		e.predX[0] = prediction + scaled
		e.predH[0] = newH0

		// Update accumulator
		if e.convType&0x10 != 0 {
			e.predAccum = 0
		} else {
			e.predAccum = e.predAccum + ((16 * (prediction + scaled)) >> 3)
		}
	}

	// ── 2. Overflow → µ-law fallback ────────────────────────────────────────
	if overflow {
		// Restore predictor state and reset
		e.predH = snapH
		e.predX = snapX
		e.predAccum = snapAccum
		e.Reset()
		e.lastQuantMode = 0

		return encodeMulaw(samples, scale), SquelchOpen
	}

	// ── 3. Squelch evaluation (§3.6) ────────────────────────────────────────
	if squelchEnabled {
		var sumRaw, sumPred float64
		for i := 0; i < n; i++ {
			rd := float64(rawDeltas[i])
			er := float64(errors[i])
			sumRaw += rd * rd
			sumPred += er * er
		}
		sqOpen := sumRaw > 1e-10 && (sumPred/sumRaw) > squelchThreshold
		if !sqOpen {
			e.squelchCounter++
			if e.squelchCounter > 899 {
				e.Reset()
				return nil, SquelchClosed
			}
		} else {
			e.squelchCounter = 0
		}
	}

	// ── 4. Choose quantisation mode from avg_residual ────────────────────────
	sumAbs := 0
	for _, r := range residuals {
		if r < 0 {
			sumAbs += -r
		} else {
			sumAbs += r
		}
	}
	avgResidual := float64(sumAbs) / float64(n)

	quantMode := chooseQuantMode(avgResidual)

	// ── 5. Encode bitstream ──────────────────────────────────────────────────
	bs := &bitWriter{}

	modeChanged := quantMode != e.lastQuantMode
	if modeChanged {
		// Mode byte: (16 * (6 - quant_mode)) ^ 0x80, bitpos starts at 4
		modeByte := byte((16 * (6 - quantMode)) ^ 0x80)
		bs.writeByte(modeByte)
		bs.bitPos = 4 // first 4 bits of mode byte are used by the mode encoding
		e.lastQuantMode = quantMode
	} else {
		// Mode byte: 0x00, bitpos starts at 1
		bs.writeByte(0x00)
		bs.bitPos = 1
	}

	qm := websdrQuantModes[quantMode]

	for _, val := range residuals {
		// Spec §3.5: sign = val >> 31 (arithmetic shift: 0 for positive, 1 for negative)
		// abs_val = val ^ (val >> 31)  — this is NOT standard abs; for negative val it
		// gives |val| - 1 (sign-magnitude encoding where the sign bit is separate).
		// Using true |val| here would produce wrong quotient/mantissa values.
		signShift := val >> 31 // 0 for val>=0, -1 (all 1s) for val<0
		sign := signShift & 1  // 0 or 1
		absVal := val ^ signShift

		quotient := absVal / qm.step
		mantissa := absVal & (qm.step - 1)
		mantBits := quantMode

		// Mantissa shrink
		if quotient >= qm.shrinkThresh[0] {
			mantissa >>= 1
			mantBits = qm.reducedMant
		}
		if quotient >= qm.shrinkThresh[1] {
			mantissa >>= 1
			mantBits--
		}
		if mantBits < 1 {
			mantBits = 1
		}

		// Prefix coding
		var prefixLen, prefixVal int
		if quotient >= qm.quotientLim {
			prefixLen = 23 - quantMode
			prefixVal = quotient
		} else {
			prefixLen = quotient + 1 // unary: quotient zeros then a one
			prefixVal = 1
		}

		// Final code word
		code := (prefixVal << mantBits) | (2*mantissa + sign)
		codeLen := mantBits + prefixLen

		bs.writeBits(code, codeLen)
	}

	return bs.bytes(), SquelchOpen
}

// chooseQuantMode selects quantisation mode 1–5 based on avg_residual.
func chooseQuantMode(avg float64) int {
	switch {
	case avg < 1.65:
		return 1
	case avg < 3.81:
		return 2
	case avg < 8.0:
		return 3
	case avg < 16.3:
		return 4
	default:
		return 5
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// µ-law fallback (§3.4)
// ─────────────────────────────────────────────────────────────────────────────

// mulawLog2 maps byte values 0–255 to floor(log2) (0–7).
var mulawLog2 [256]int

func init() {
	for i := 0; i < 256; i++ {
		v := i
		l := 0
		for v > 1 {
			v >>= 1
			l++
		}
		mulawLog2[i] = l
	}
}

// pcm16ToMulaw encodes a 16-bit signed PCM sample to G.711 µ-law.
func pcm16ToMulaw(sample int16) byte {
	signBit := ((^int(sample)) >> 8) & 0x80
	magnitude := int(sample)
	if signBit == 0 {
		magnitude = -magnitude
	}
	if magnitude > 32635 {
		magnitude = 32635
	}
	if magnitude <= 255 {
		return byte(signBit ^ 0x55 ^ int(uint(magnitude)>>4))
	}
	// Use log2 table: exponent = floor(log2(magnitude >> 7)) + 1
	idx := magnitude >> 7
	if idx > 255 {
		idx = 255
	}
	exponent := mulawLog2[idx] + 1
	return byte(signBit ^ 0x55 ^
		(((magnitude >> (exponent + 3)) & 0xF) | (16 * exponent)))
}

// encodeMulaw encodes 128 samples as the µ-law fallback payload (§3.4).
// Returns [0x80][128 µ-law bytes] = 129 bytes.
func encodeMulaw(samples []float32, scale float32) []byte {
	out := make([]byte, 1+websdrBlockSamples)
	out[0] = 0x80
	for i := 0; i < websdrBlockSamples && i < len(samples); i++ {
		v := int32(samples[i] * scale)
		if v < -32768 {
			v = -32768
		}
		if v > 32767 {
			v = 32767
		}
		out[1+i] = pcm16ToMulaw(int16(v))
	}
	return out
}

// ─────────────────────────────────────────────────────────────────────────────
// bitWriter — MSB-first bit packing
// ─────────────────────────────────────────────────────────────────────────────

type bitWriter struct {
	buf    []byte
	bitPos int // bits written into current (last) byte (0 = byte not yet started)
}

// writeByte appends a full byte and sets bitPos to 8 (byte fully used).
func (bw *bitWriter) writeByte(b byte) {
	bw.buf = append(bw.buf, b)
	bw.bitPos = 0
}

// writeBits writes the lowest `n` bits of `val` MSB-first into the stream.
func (bw *bitWriter) writeBits(val, n int) {
	for n > 0 {
		// How many bits can we fit in the current byte?
		if bw.bitPos == 0 || bw.bitPos == 8 {
			bw.buf = append(bw.buf, 0)
			bw.bitPos = 0
		}
		avail := 8 - bw.bitPos
		take := n
		if take > avail {
			take = avail
		}
		// Extract the top `take` bits of val (from bit n-1 down to n-take)
		shift := n - take
		bits := (val >> shift) & ((1 << take) - 1)
		// Place them into the current byte at the correct position
		bw.buf[len(bw.buf)-1] |= byte(bits << (avail - take))
		bw.bitPos += take
		n -= take
	}
}

// bytes returns the packed byte slice (last byte zero-padded on right).
func (bw *bitWriter) bytes() []byte {
	return bw.buf
}

// ─────────────────────────────────────────────────────────────────────────────
// AGC helpers (used by the websocket handler)
// ─────────────────────────────────────────────────────────────────────────────

// UpdateAGC updates the AGC gain given the RMS power of the current block.
// Returns the new scale factor (agcGain * 32000).
func (e *WebSDRAdpcmEncoder) UpdateAGC(samples []float32) float32 {
	// Compute RMS power
	var sumSq float64
	for _, s := range samples {
		sumSq += float64(s) * float64(s)
	}
	sqrtPower := float32(math.Sqrt(sumSq / float64(len(samples))))

	newGain := float32(1.0) / (sqrtPower + 1e-30)
	if newGain > e.agcGain {
		// Slow attack: blend 1% new + 99% old
		newGain = newGain*0.01 + e.agcGain*0.99
	}
	e.agcGain = newGain
	return e.agcGain * 32000.0
}

// ManualScale returns the linear scale factor for a manual gain value in dB.
// gainDB is the value from the /~~param?gain= parameter.
// If gainDB >= 9999, AGC mode is implied (caller should use UpdateAGC instead).
func ManualScale(gainDB float64) float32 {
	return float32(math.Pow(10, (gainDB-120)/20) * 32000.0)
}

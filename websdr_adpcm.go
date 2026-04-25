package main

// websdr_adpcm.go — WebSDR custom audio codec
//
// Implements the 20-tap adaptive linear predictor + Rice-like bitstream encoder
// used by VertexSDR / WebSDR servers, as documented by the reference C
// implementation in VertexSDR/src/client.c (send_audio_compressed3).
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

	// blockSize is the quantisation step used in the predictor update loop.
	// The spec says this is driven by server config audioformat (40/128/256/512).
	// We use 128 as the default (audioformat index 1), which matches the block
	// sample count and is the most common WebSDR server setting.
	websdrPredBlockSize = 128
)

// ─────────────────────────────────────────────────────────────────────────────
// WebSDRAdpcmEncoder — per-client state
// ─────────────────────────────────────────────────────────────────────────────

// WebSDRAdpcmEncoder holds the per-connection codec state.
// All arithmetic-sensitive fields use int32 to match the C reference exactly
// (C uses plain 'int' which is 32-bit on all target platforms, and relies on
// natural 32-bit overflow in the predictor coefficient/delay-line products).
type WebSDRAdpcmEncoder struct {
	predH     [websdrPredTaps]int32 // predictor coefficients  (pred_h in C)
	predX     [websdrPredTaps]int32 // predictor delay line    (pred_x in C)
	predAccum int32                 // running accumulator     (pred_accum in C)

	// conv_type bit 4: if set, non-accumulating predictor (adpcm_shift=12)
	// if clear, accumulating predictor (adpcm_shift=14)
	convType int

	// AGC state
	agcGain float32

	// last quant mode (for mode-change detection in bitstream header)
	quantMode int

	// Squelch state
	squelchCounter int
}

// NewWebSDRAdpcmEncoder creates a fresh encoder with all state zeroed.
func NewWebSDRAdpcmEncoder() *WebSDRAdpcmEncoder {
	return &WebSDRAdpcmEncoder{
		agcGain:   1.0,
		quantMode: 0, // force mode byte on first frame
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
	e.quantMode = 0
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
// This is a direct port of send_audio_compressed3() from VertexSDR/src/client.c.
func (e *WebSDRAdpcmEncoder) Encode(samples []float32, scale float32, squelchEnabled bool, squelchThreshold float64) ([]byte, SquelchResult) {
	if len(samples) > websdrBlockSamples {
		samples = samples[:websdrBlockSamples]
	}
	n := len(samples)

	adpcmShift := e.adpcmShift()
	blk := int32(websdrPredBlockSize)
	negHalf := -(blk / 2) // = -64  (matches C: neg_half = -(blk/2))
	blkShift := blk << 16 // = 8388608

	residuals := make([]int32, n)
	overflow := false
	var sumAbs, sumPred, sumRaw float64

	// Compute pred_sum fresh at the start of each block, using int32 arithmetic
	// to match C's natural 32-bit overflow behaviour.
	// C reference lines 775-777:
	//   int pred_sum = 0;
	//   for (int j = 0; j < 20; j++)
	//       pred_sum += c->pred_h[j] * c->pred_x[j];
	var predSum int32
	for j := 0; j < websdrPredTaps; j++ {
		predSum += e.predH[j] * e.predX[j]
	}

	for i := 0; i < n; i++ {
		oldAccum := e.predAccum
		prediction := int(predSum) / 4096

		// Input scaled to integer, subtract DC accumulator
		rawDelta := int(samples[i]*scale) - int(oldAccum>>4)
		rawDeltaSq := rawDelta * rawDelta
		err := rawDelta - prediction

		sumRaw += float64(rawDeltaSq)
		sumPred += float64(err * err)

		// Quantise residual using neg_half (matches C reference exactly).
		// C line 799: wrapped = (neg_half + blk_shift + error) / blk - 0x10000
		// For err=0: (-64 + 8388608 + 0)/128 - 65536 = 65535 - 65536 = -1
		wrapped := int32((negHalf+blkShift+int32(err))/blk) - 0x10000

		// Clamp magnitude (matches C: mask = -1, -2, or -4)
		aw := wrapped
		if aw < 0 {
			aw = -aw
		}
		var mask int32 = -1
		if aw > 16 {
			if aw <= 32 {
				mask = -2
			} else {
				mask = -4
			}
		}
		wrapped = mask & wrapped
		residuals[i] = wrapped

		// abs_res = val ^ (val >> 31)  — sign-magnitude, NOT standard abs.
		// For negative val this gives |val|-1, matching C and browser decoder.
		// C line 806: int abs_res = wrapped ^ (wrapped >> 31);
		absRes := wrapped ^ (wrapped >> 31)
		sumAbs += float64(absRes)

		if absRes > 1000 {
			overflow = true
			break
		}

		// Dequantised residual (matches C: scaled = blk*wrapped + blk/2)
		scaled := blk*wrapped + (blk / 2)
		adaptSample := int32(scaled >> 4)

		// Update coefficients and delay line.
		// C reference lines 815-833:
		//   for j=19 down to 1:
		//     xprev  = pred_x[j-1]
		//     new_hj = h[j] + (adapt_sample * x[j] >> shift) - (h[j] >> 7)
		//     pred_h[j] = new_hj
		//     pred_x[j] = xprev
		//     partial += xprev * new_hj
		//   old_x0 = pred_x[0]
		//   new_h0 = h[0] + (old_x0 * adapt_sample >> shift) - (h[0] >> 7)
		//   pred_x[0] = prediction + scaled
		//   pred_h[0] = new_h0
		//   pred_sum = (prediction+scaled)*new_h0 + partial
		var partial int32
		for j := websdrPredTaps - 1; j >= 1; j-- {
			xprev := e.predX[j-1]
			hj := e.predH[j]
			xj := e.predX[j]
			newHj := hj + int32((int(adaptSample)*int(xj))>>adpcmShift) - (hj >> 7)
			e.predH[j] = newHj
			e.predX[j] = xprev
			partial += xprev * newHj
		}

		oldX0 := e.predX[0]
		h0 := e.predH[0]
		newH0 := h0 + int32((int(oldX0)*int(adaptSample))>>adpcmShift) - (h0 >> 7)
		predictedSample := int32(prediction) + scaled
		e.predX[0] = predictedSample
		e.predH[0] = newH0

		// Incremental pred_sum for next iteration (matches C line 833)
		predSum = predictedSample*newH0 + partial

		// Update accumulator (matches C lines 835-838)
		if e.convType&0x10 != 0 {
			e.predAccum = 0
		} else {
			e.predAccum = oldAccum + int32((16*int(predictedSample))>>3)
		}
	}

	// ── 2. Overflow → µ-law fallback ────────────────────────────────────────
	if overflow {
		e.Reset()
		return encodeMulaw(samples, scale), SquelchOpen
	}

	// ── 3. Squelch evaluation ────────────────────────────────────────────────
	// Matches C lines 843-872 (squelch_counter logic).
	if squelchEnabled {
		sqOpen := sumRaw > 1e-10 && (sumPred/sumRaw) > squelchThreshold
		if !sqOpen {
			sc := e.squelchCounter
			if sc <= 999 {
				e.squelchCounter = 0
			} else {
				e.squelchCounter = sc - 1
			}
		} else if e.squelchCounter <= 30 {
			e.squelchCounter++
		} else {
			e.squelchCounter = 1002
		}

		if e.squelchCounter > 899 {
			e.Reset()
			return nil, SquelchClosed
		}
	}

	// ── 4. Choose quantisation mode from avg_residual ────────────────────────
	// Matches C lines 898-918.
	// C: avg_residual = sum_abs * 0.0078125f  (= sum_abs / 128)
	avgResidual := float32(sumAbs) * 0.0078125

	var quantMode, quantStep, reducedMantBits, quotientLimit int
	if avgResidual >= 3.81 {
		if avgResidual < 8.0 {
			quotientLimit = 12
			quantStep = 4
			reducedMantBits = 2
			quantMode = 3
		} else if avgResidual < 16.3 {
			quotientLimit = 11
			quantStep = 8
			reducedMantBits = 3
			quantMode = 4
		} else {
			quotientLimit = 10
			quantStep = 16
			reducedMantBits = 4
			quantMode = 5
		}
	} else {
		if avgResidual < 1.65 {
			quotientLimit = 14
			quantStep = 1
			reducedMantBits = 0
			quantMode = 1
		} else {
			quotientLimit = 13
			quantStep = 2
			reducedMantBits = 1
			quantMode = 2
		}
	}

	// ── 5. Encode bitstream ──────────────────────────────────────────────────
	// Matches C lines 920-998.
	//
	// The C encoder uses a 32-bit shift register to pack bits MSB-first into
	// successive bytes.  We replicate that exactly.

	// Allocate output buffer (worst case: 128 samples × ~23 bits + header)
	out := make([]byte, 0, 400)

	// Mode byte and initial bitpos (matches C lines 924-930)
	var firstByte byte
	var bitpos int
	if e.quantMode == quantMode {
		firstByte = 0x00
		bitpos = 1
	} else {
		firstByte = byte((16 * (6 - quantMode)) ^ 0x80)
		bitpos = 4
	}
	out = append(out, firstByte)
	e.quantMode = quantMode

	// mantissa_shrink_thresholds[8] = {999, 999, 8, 4, 2, 1, 99, 99}
	// (matches C line 921)
	mantissaShrinkThresholds := [8]int{999, 999, 8, 4, 2, 1, 99, 99}

	bp := 0 // index into out[] of current byte being filled

	for i := 0; i < n; i++ {
		val := int(residuals[i])
		// sign = (unsigned)val >> 31  (0 for val>=0, 1 for val<0)
		// C line 937: int sign = (unsigned int)val >> 31;
		sign := (uint(val) >> 31) & 1
		// abs_val = val ^ (val >> 31)  — sign-magnitude (NOT standard abs)
		// C line 938: int abs_val = val ^ (val >> 31);
		absVal := val ^ (val >> 31)

		quotient := absVal / quantStep

		var prefixLen, prefixVal int
		if quotient >= quotientLimit {
			prefixLen = 23 - quantMode
			prefixVal = quotient
		} else {
			prefixLen = quotient + 1
			prefixVal = 1
		}

		mantissa := absVal & (quantStep - 1)
		mantBits := quantMode

		if quotient >= mantissaShrinkThresholds[quantMode] {
			mantissa >>= 1
			mantBits = reducedMantBits
		}
		if quotient >= mantissaShrinkThresholds[reducedMantBits] {
			mantissa >>= 1
			mantBits--
		}
		if mantBits <= 0 {
			mantBits = 1
		}

		code := (prefixVal << mantBits) | (2*mantissa + int(sign))
		codeLen := mantBits + prefixLen

		// Pack bits MSB-first using the same 32-bit shift approach as C.
		// C lines 967-980:
		//   shift_amt = 32 - code_len - bitpos
		//   shifted = code << shift_amt
		//   *bp |= (uint8_t)(shifted >> 24)
		//   bitpos += code_len
		//   if bitpos > 7:
		//     extra = bitpos - 8
		//     end = bp + 1 + (extra >> 3)
		//     while bp < end: shifted <<= 8; *(++bp) = shifted >> 24
		//     bitpos = extra - 8*(extra>>3)
		shiftAmt := 32 - codeLen - bitpos
		shifted := code << shiftAmt
		out[bp] |= byte(shifted >> 24)
		bitpos += codeLen
		if bitpos > 7 {
			extra := bitpos - 8
			endBp := bp + 1 + (extra >> 3)
			for bp < endBp {
				shifted <<= 8
				bp++
				out = append(out, byte(shifted>>24))
			}
			bitpos = extra - 8*(extra>>3)
		}
	}

	return out, SquelchOpen
}

// ─────────────────────────────────────────────────────────────────────────────
// µ-law fallback
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
// Matches C reference pcm16_to_mulaw() in client.c exactly.
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
	// C line 658: int exponent = mulaw_log2[(unsigned)magnitude >> 8] + 1;
	idx := magnitude >> 8
	if idx > 255 {
		idx = 255
	}
	exponent := mulawLog2[idx] + 1
	return byte(signBit ^ 0x55 ^
		(((magnitude >> (exponent + 3)) & 0xF) | (16 * exponent)))
}

// encodeMulaw encodes 128 samples as the µ-law fallback payload.
// Returns [0x80][128 µ-law bytes] = 129 bytes.
// Matches C reference overflow path in send_audio_compressed3().
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
// AGC helpers (used by the websocket handler)
// ─────────────────────────────────────────────────────────────────────────────

// UpdateAGC updates the AGC gain given the peak amplitude of the current block.
// Returns the new scale factor (agcGain * 32000).
// Matches C reference AGC logic in client_dispatch_audio():
//
//	sqrt_power = max(|sample|) * 2
//	new_gain = 1 / (sqrt_power + 1e-30)
//	if new_gain > old_gain: blend 1% new + 99% old
func (e *WebSDRAdpcmEncoder) UpdateAGC(samples []float32) float32 {
	var maxAbs float32
	for _, s := range samples {
		if s < 0 {
			s = -s
		}
		if s > maxAbs {
			maxAbs = s
		}
	}
	sqrtPower := maxAbs * 2.0

	newGain := float32(1.0) / (sqrtPower + 1e-30)
	if newGain > e.agcGain {
		// Slow attack: blend 1% new + 99% old (matches C)
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

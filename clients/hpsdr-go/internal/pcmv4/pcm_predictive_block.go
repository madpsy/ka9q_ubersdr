package pcmv4

// Whole-packet paths for the order-16 complex stage, the predictor of every IQ
// profile, as the server and the ubersdr-iq Go library have them. They compute
// exactly what forward and inverse compute frame by frame, only faster: where
// the machine has a SIMD kernel (pcm_predictive_amd64.s) the packet runs
// through it, and otherwise each frame's adapt is fused with the next frame's
// predict so the taps are walked once a frame rather than twice. The
// per-frame paths remain, for every other profile, and pcm_predictive_block_test.go
// holds these to them.

// block16 reports whether the codec is the single order-16 complex stage the
// block paths handle.
func (c *PredictiveCodec) block16() bool {
	return len(c.cx) == 1 && c.cx[0].order == 16
}

// forwardBlock16 is forward over a packet of interleaved I/Q, writing the
// residuals to res.
func (f *complexStage) forwardBlock16(samples []int16, res []int32) {
	if f.forwardSIMD(samples, res) {
		return
	}
	pr, pi := f.predict16()
	for k := 0; k+1 < len(samples); k += 2 {
		xr, xi := int64(samples[k]), int64(samples[k+1])
		er := xr - predRoundShift(pr, predTapShift)
		ei := xi - predRoundShift(pi, predTapShift)
		res[k], res[k+1] = int32(er), int32(ei)
		pr, pi = f.step16(xr, xi, er, ei)
	}
}

// inverseBlock16 is inverse over a packet of residuals, writing the
// reconstructed interleaved I/Q to out.
func (f *complexStage) inverseBlock16(res []int32, out []int16) {
	done := f.inverseSIMD(res, out)
	if done == len(res) {
		return
	}
	pr, pi := f.predict16()
	for k := done; k+1 < len(res); k += 2 {
		er, ei := int64(res[k]), int64(res[k+1])
		xr := er + predRoundShift(pr, predTapShift)
		xi := ei + predRoundShift(pi, predTapShift)
		out[k], out[k+1] = int16(xr), int16(xi)
		pr, pi = f.step16(xr, xi, er, ei)
	}
}

// predict16 is predict for an order-16 stage, before rounding.
func (f *complexStage) predict16() (int64, int64) {
	lo := f.idx - 16
	wr, wi := (*[16]int64)(f.wr), (*[16]int64)(f.wi)
	hr, hi := (*[16]int64)(f.hr[lo:]), (*[16]int64)(f.hi[lo:])
	var pr, pi int64
	for j := 0; j < 16; j++ {
		pr += wr[j]*hr[j] - wi[j]*hi[j]
		pi += wr[j]*hi[j] + wi[j]*hr[j]
	}
	return pr, pi
}

// step16 is adapt and push for one frame, returning the next frame's
// prediction before rounding. The sample is written into the history before
// the taps move, so h[lo:lo+16] is this frame's window and h[lo+1:lo+17] the
// next one's, and each updated tap goes straight into the next prediction.
func (f *complexStage) step16(xr, xi, er, ei int64) (int64, int64) {
	lo := f.idx - 16
	f.hr[f.idx], f.hi[f.idx] = xr, xi
	f.sr[f.idx], f.si[f.idx] = predSign(xr), predSign(xi)
	wr, wi := (*[16]int64)(f.wr), (*[16]int64)(f.wi)
	nr, ni := (*[16]int64)(f.hr[lo+1:]), (*[16]int64)(f.hi[lo+1:])

	var pr, pi int64
	if er == 0 && ei == 0 {
		for j := 0; j < 16; j++ {
			pr += wr[j]*nr[j] - wi[j]*ni[j]
			pi += wr[j]*ni[j] + wi[j]*nr[j]
		}
	} else {
		mr, mi := f.mu*predSign(er), f.mu*predSign(ei)
		sr, si := (*[16]int64)(f.sr[lo:]), (*[16]int64)(f.si[lo:])
		for j := 0; j < 16; j++ {
			a := wr[j] + mr*sr[j] + mi*si[j] - predLeak(wr[j], predLeakShiftComplex)
			b := wi[j] + mi*sr[j] - mr*si[j] - predLeak(wi[j], predLeakShiftComplex)
			if !f.fast {
				a, b = predClampTap(a), predClampTap(b)
			}
			wr[j], wi[j] = a, b
			pr += a*nr[j] - b*ni[j]
			pi += a*ni[j] + b*nr[j]
		}
	}

	f.idx++
	if f.idx == len(f.hr) {
		copy(f.hr, f.hr[f.idx-16:f.idx])
		copy(f.hi, f.hi[f.idx-16:f.idx])
		copy(f.sr, f.sr[f.idx-16:f.idx])
		copy(f.si, f.si[f.idx-16:f.idx])
		f.idx = 16
	}
	return pr, pi
}

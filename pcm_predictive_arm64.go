//go:build arm64 && cgo && !purego

package main

// The NEON kernel of complexStage.forwardBlock16; see pcm_predictive_simd.go
// for why int32 lanes are exact. It is C rather than Go assembly because the
// Go arm64 assembler has none of the signed multiply-long, absolute value or
// min/max instructions it is built from. cgo's per-call cost is paid once a
// packet, against hundreds of frames.
//
// Each 16-entry array is four registers of four int32 lanes, lane 0 oldest,
// held from the first frame to the last. Per frame, as forward: predict from
// the window, form the residual, adapt against the window's signs, then slide
// the window a lane with the sample in at the top.

/*
#cgo CFLAGS: -O2
#include <arm_neon.h>
#include <stdint.h>

typedef struct {
	int32_t wr[16], wi[16];
	int32_t hr[16], hi[16];
} cx16_state;

static void cx16_forward_neon(cx16_state *st, const int16_t *samples, int32_t *res,
                              long frames, long mu) {
	int32x4_t hr[4], hi[4], wr[4], wi[4];
	for (int k = 0; k < 4; ++k) {
		hr[k] = vld1q_s32(&st->hr[4 * k]);
		hi[k] = vld1q_s32(&st->hi[4 * k]);
		wr[k] = vld1q_s32(&st->wr[4 * k]);
		wi[k] = vld1q_s32(&st->wi[4 * k]);
	}
	const int32x4_t lim = vdupq_n_s32(1 << 24);
	const int32x4_t nlim = vdupq_n_s32(-(1 << 24));
	const uint64_t half = (uint64_t)1 << 15;
	for (long f = 0; f < frames; ++f) {
		// accR = sum wr*hr - wi*hi, accI = sum wr*hi + wi*hr, in int64
		// lanes. Two accumulators a part so the multiply-accumulates are not
		// all one dependency chain.
		int64x2_t ar0 = vmull_s32(vget_low_s32(wr[0]), vget_low_s32(hr[0]));
		int64x2_t ar1 = vmull_high_s32(wr[0], hr[0]);
		int64x2_t ai0 = vmull_s32(vget_low_s32(wr[0]), vget_low_s32(hi[0]));
		int64x2_t ai1 = vmull_high_s32(wr[0], hi[0]);
		ar0 = vmlsl_s32(ar0, vget_low_s32(wi[0]), vget_low_s32(hi[0]));
		ar1 = vmlsl_high_s32(ar1, wi[0], hi[0]);
		ai0 = vmlal_s32(ai0, vget_low_s32(wi[0]), vget_low_s32(hr[0]));
		ai1 = vmlal_high_s32(ai1, wi[0], hr[0]);
		for (int k = 1; k < 4; ++k) {
			ar0 = vmlal_s32(ar0, vget_low_s32(wr[k]), vget_low_s32(hr[k]));
			ar1 = vmlal_high_s32(ar1, wr[k], hr[k]);
			ai0 = vmlal_s32(ai0, vget_low_s32(wr[k]), vget_low_s32(hi[k]));
			ai1 = vmlal_high_s32(ai1, wr[k], hi[k]);
			ar0 = vmlsl_s32(ar0, vget_low_s32(wi[k]), vget_low_s32(hi[k]));
			ar1 = vmlsl_high_s32(ar1, wi[k], hi[k]);
			ai0 = vmlal_s32(ai0, vget_low_s32(wi[k]), vget_low_s32(hr[k]));
			ai1 = vmlal_high_s32(ai1, wi[k], hr[k]);
		}
		const int64_t pr = vaddvq_s64(vaddq_s64(ar0, ar1));
		const int64_t pi = vaddvq_s64(vaddq_s64(ai0, ai1));

		// predRoundShift(p, 16): |p| rounded, its sign put back. Unsigned so
		// nothing here is signed overflow.
		const uint64_t sgr = (uint64_t)(pr >> 63), sgi = (uint64_t)(pi >> 63);
		const int64_t qr = (int64_t)((((((uint64_t)pr ^ sgr) - sgr) + half) >> 16 ^ sgr) - sgr);
		const int64_t qi = (int64_t)((((((uint64_t)pi ^ sgi) - sgi) + half) >> 16 ^ sgi) - sgi);

		const int64_t xr = samples[2 * f], xi = samples[2 * f + 1];
		const int64_t er = xr - qr, ei = xi - qi;
		res[2 * f] = (int32_t)er;
		res[2 * f + 1] = (int32_t)ei;

		// A zero residual leaves every tap where it is.
		if (er != 0 || ei != 0) {
			const int32_t mr = (int32_t)(mu * ((er > 0) - (er < 0)));
			const int32_t mi = (int32_t)(mu * ((ei > 0) - (ei < 0)));
			for (int k = 0; k < 4; ++k) {
				// History signs as -1/0/+1: the (h < 0) mask less the (h > 0)
				// mask, each all ones where it holds.
				const int32x4_t sr = vsubq_s32(vreinterpretq_s32_u32(vcltzq_s32(hr[k])),
				                               vreinterpretq_s32_u32(vcgtzq_s32(hr[k])));
				const int32x4_t si = vsubq_s32(vreinterpretq_s32_u32(vcltzq_s32(hi[k])),
				                               vreinterpretq_s32_u32(vcgtzq_s32(hi[k])));
				// predLeak: |w| >> 14 with w's sign put back.
				const int32x4_t gr = vshrq_n_s32(wr[k], 31), gi = vshrq_n_s32(wi[k], 31);
				const int32x4_t lr = vsubq_s32(veorq_s32(vshrq_n_s32(vabsq_s32(wr[k]), 14), gr), gr);
				const int32x4_t li = vsubq_s32(veorq_s32(vshrq_n_s32(vabsq_s32(wi[k]), 14), gi), gi);
				// wr += mr*sr + mi*si, wi += mi*sr - mr*si, less the leak.
				const int32x4_t nr = vsubq_s32(vmlaq_n_s32(vmlaq_n_s32(wr[k], sr, mr), si, mi), lr);
				const int32x4_t ni = vsubq_s32(vmlsq_n_s32(vmlaq_n_s32(wi[k], sr, mi), si, mr), li);
				wr[k] = vmaxq_s32(vminq_s32(nr, lim), nlim);
				wi[k] = vmaxq_s32(vminq_s32(ni, lim), nlim);
			}
		}

		// Slide the window a lane: the oldest out, this frame in at the top.
		hr[0] = vextq_s32(hr[0], hr[1], 1);
		hr[1] = vextq_s32(hr[1], hr[2], 1);
		hr[2] = vextq_s32(hr[2], hr[3], 1);
		hr[3] = vextq_s32(hr[3], vdupq_n_s32((int32_t)xr), 1);
		hi[0] = vextq_s32(hi[0], hi[1], 1);
		hi[1] = vextq_s32(hi[1], hi[2], 1);
		hi[2] = vextq_s32(hi[2], hi[3], 1);
		hi[3] = vextq_s32(hi[3], vdupq_n_s32((int32_t)xi), 1);
	}
	for (int k = 0; k < 4; ++k) {
		vst1q_s32(&st->wr[4 * k], wr[k]);
		vst1q_s32(&st->wi[4 * k], wi[k]);
		vst1q_s32(&st->hr[4 * k], hr[k]);
		vst1q_s32(&st->hi[4 * k], hi[k]);
	}
}
*/
import "C"

import "unsafe"

// cx16SIMD selects the SIMD kernel for forwardBlock16, here NEON, which every
// arm64 core has. It is a variable so the tests can turn it off and hold the
// pure-Go block to the same reference.
var cx16SIMD = true

// cx16Forward runs forwardBlock16's arithmetic over frames interleaved I/Q
// samples, writing 2*frames residuals and leaving st at the state after the
// last frame.
func cx16Forward(st *cx16State, samples *int16, res *int32, frames int, mu int64) {
	C.cx16_forward_neon((*C.cx16_state)(unsafe.Pointer(st)),
		(*C.int16_t)(unsafe.Pointer(samples)), (*C.int32_t)(unsafe.Pointer(res)),
		C.long(frames), C.long(mu))
}

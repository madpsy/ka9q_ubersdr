package olivia

// The three small pieces of Pawel Jalocha's MFSK receiver that are shared
// between the demodulator and the FEC: the Hadamard transform, the Gray code,
// and the integrating low-pass used by the synchroniser.
//
// All three are ported from pj_fht.h, pj_gray.h and pj_lowpass3.h. They have to
// match the transmitter bit for bit — the Hadamard and the Gray mapping are
// part of the code, not part of the implementation — so they are kept in the
// shape the reference wrote them rather than tidied.

// fht runs the forward fast Hadamard transform in place over the first n
// elements of data. n must be a power of two.
//
// Note the ordering: the reference computes data[p] from b2+b1 and
// data[p+step] from b2-b1, which is *not* the more common (b1+b2, b1-b2)
// convention. Swapping them still produces a Hadamard transform, but a
// differently permuted one, and the FEC would stop decoding.
func fht(data []float64, n int) {
	for step := 1; step < n; step *= 2 {
		for ptr := 0; ptr < n; ptr += 2 * step {
			for p := ptr; p-ptr < step; p++ {
				b1, b2 := data[p], data[p+step]
				data[p] = b2 + b1
				data[p+step] = b2 - b1
			}
		}
	}
}

// grayCode maps a binary value to its Gray-coded form.
func grayCode(b uint8) uint8 { return b ^ (b >> 1) }

// binaryCode is the inverse of grayCode: it folds a Gray-coded value back to
// binary. The demodulator needs this one — the tones are transmitted in Gray
// order so that a tone slipped by one carrier costs a single bit.
func binaryCode(g uint8) uint8 {
	g ^= g >> 4
	g ^= g >> 2
	g ^= g >> 1
	return g
}

// lowPass3 is a three-pole IIR integrator, held as parallel arrays rather than
// as objects: the synchroniser runs one filter per (block phase, frequency
// offset) pair, which is a few thousand of them, and a slice of structs would
// cost a bounds check and a cache line per access on the hot path.
//
// out1, out2 and out are the three stages; i selects the filter.
//
// The order matters and is the reference's: all three differences are taken
// from the pre-update values before any stage is written back. Computing them
// as it goes — the obvious way to write this — gives a filter with a different
// impulse response and a visibly different sync threshold.
func lowPass3(out1, out2, out []float64, i int, inp, weight, feedback float64) {
	w := weight * 2.0
	diffI1 := (inp - out1[i]) * w
	diff12 := (out1[i] - out2[i]) * w
	diff23 := (out2[i] - out[i]) * w
	out1[i] += diffI1
	out2[i] += diff12
	out[i] += diff23
	out2[i] += diff23 * feedback
}

// The feedback the reference uses everywhere; overshoot is around 1e-6 at this
// value, against about 1% at 0.5.
const lowPass3Feedback = 0.1

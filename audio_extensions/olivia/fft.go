package olivia

import "math"

// Radix-2 complex FFT, in place, with the bit-reversal and twiddle tables
// cached per size.
//
// Olivia needs exactly one transform length for the whole life of a decoder —
// SymbolLen, which is always a power of two between 256 and 1024 — so a plan is
// built once in preset() and reused for every symbol. Nothing here allocates on
// the hot path.
//
// The demodulator packs two real slices into one complex transform (slice 0 in
// the real part, slice 1 in the imaginary part) and pulls the two spectra apart
// afterwards; see separEnergy. That halves the transform work per symbol
// relative to running the two slices separately, and it is what the reference
// implementation does.

type fftPlan struct {
	n   int
	rev []uint32
	cos []float64
	sin []float64
}

func newFFTPlan(n int) *fftPlan {
	bits := 0
	for 1<<bits < n {
		bits++
	}
	rev := make([]uint32, n)
	for i := 0; i < n; i++ {
		x, r := i, 0
		for b := 0; b < bits; b++ {
			r = (r << 1) | (x & 1)
			x >>= 1
		}
		rev[i] = uint32(r)
	}
	cs := make([]float64, n/2)
	sn := make([]float64, n/2)
	for i := 0; i < n/2; i++ {
		phase := -2 * math.Pi * float64(i) / float64(n)
		cs[i] = math.Cos(phase)
		sn[i] = math.Sin(phase)
	}
	return &fftPlan{n: n, rev: rev, cos: cs, sin: sn}
}

// transform runs an in-place decimation-in-time FFT over re/im, both of which
// must be exactly plan.n long.
func (p *fftPlan) transform(re, im []float64) {
	n := p.n
	for i := 0; i < n; i++ {
		j := int(p.rev[i])
		if j > i {
			re[i], re[j] = re[j], re[i]
			im[i], im[j] = im[j], im[i]
		}
	}
	for size := 2; size <= n; size <<= 1 {
		half := size >> 1
		step := n / size
		for i := 0; i < n; i += size {
			k := 0
			for j := i; j < i+half; j++ {
				c, s := p.cos[k], p.sin[k]
				l := j + half
				tr := re[l]*c - im[l]*s
				ti := re[l]*s + im[l]*c
				re[l] = re[j] - tr
				im[l] = im[j] - ti
				re[j] += tr
				im[j] += ti
				k += step
			}
		}
	}
}

// separEnergy pulls the two real spectra back out of one packed transform and
// returns the energy of bin k in each.
//
// The algebra is r2FFT::SeparTwoReals from the reference, kept factor for
// factor — including the missing halving, which leaves both spectra at twice
// their true amplitude. That is harmless here and deliberately not "fixed": the
// soft demapper divides every symbol by its own total energy and the sync
// filters compare signal against noise, so a constant scale cancels out of
// everything downstream. Correcting it would only move the arithmetic away from
// the implementation these vectors were captured from.
//
// Bin 0 is the packed DC/Nyquist slot rather than a frequency bin, and is
// special-cased the same way the reference does. It is only ever reached by the
// widest modes tuned low enough that the tone block runs into DC, where the
// decoder has already lost its frequency search — see preset's fit check.
func separEnergy(re, im []float64, n, k int) (e0, e1 float64) {
	if k == 0 {
		half := n / 2
		return re[0]*re[0] + re[half]*re[half], im[0]*im[0] + im[half]*im[half]
	}
	m := n - k
	r0 := re[k] + re[m]
	i0 := im[k] - im[m]
	r1 := im[k] + im[m]
	i1 := re[m] - re[k]
	return r0*r0 + i0*i0, r1*r1 + i1*i1
}

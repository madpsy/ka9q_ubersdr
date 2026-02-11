package navtex

import "math"

// BiQuadType represents the type of biquad filter
type BiQuadType int

const (
	BiQuadLowpass BiQuadType = iota
	BiQuadHighpass
	BiQuadBandpass
	BiQuadNotch
	BiQuadPeak
	BiQuadLowshelf
	BiQuadHighshelf
)

// BiQuadFilter implements a biquadratic IIR filter
type BiQuadFilter struct {
	a0, a1, a2 float64
	b0, b1, b2 float64
	x1, x2     float64
	y1, y2     float64
}

// NewBiQuadFilter creates a new biquad filter
func NewBiQuadFilter() *BiQuadFilter {
	return &BiQuadFilter{}
}

// Configure sets up the filter coefficients
func (f *BiQuadFilter) Configure(filterType BiQuadType, freq, sampleRate, q float64) {
	omega := 2.0 * math.Pi * freq / sampleRate
	sinOmega := math.Sin(omega)
	cosOmega := math.Cos(omega)
	alpha := sinOmega / (2.0 * q)

	switch filterType {
	case BiQuadLowpass:
		f.b0 = (1.0 - cosOmega) / 2.0
		f.b1 = 1.0 - cosOmega
		f.b2 = (1.0 - cosOmega) / 2.0
		f.a0 = 1.0 + alpha
		f.a1 = -2.0 * cosOmega
		f.a2 = 1.0 - alpha

	case BiQuadHighpass:
		f.b0 = (1.0 + cosOmega) / 2.0
		f.b1 = -(1.0 + cosOmega)
		f.b2 = (1.0 + cosOmega) / 2.0
		f.a0 = 1.0 + alpha
		f.a1 = -2.0 * cosOmega
		f.a2 = 1.0 - alpha

	case BiQuadBandpass:
		f.b0 = alpha
		f.b1 = 0.0
		f.b2 = -alpha
		f.a0 = 1.0 + alpha
		f.a1 = -2.0 * cosOmega
		f.a2 = 1.0 - alpha

	case BiQuadNotch:
		f.b0 = 1.0
		f.b1 = -2.0 * cosOmega
		f.b2 = 1.0
		f.a0 = 1.0 + alpha
		f.a1 = -2.0 * cosOmega
		f.a2 = 1.0 - alpha

	case BiQuadPeak:
		f.b0 = 1.0 + alpha
		f.b1 = -2.0 * cosOmega
		f.b2 = 1.0 - alpha
		f.a0 = 1.0 + alpha
		f.a1 = -2.0 * cosOmega
		f.a2 = 1.0 - alpha

	case BiQuadLowshelf:
		sqrtA := math.Sqrt(q)
		f.b0 = q * ((q + 1.0) - (q-1.0)*cosOmega + 2.0*sqrtA*alpha)
		f.b1 = 2.0 * q * ((q - 1.0) - (q+1.0)*cosOmega)
		f.b2 = q * ((q + 1.0) - (q-1.0)*cosOmega - 2.0*sqrtA*alpha)
		f.a0 = (q + 1.0) + (q-1.0)*cosOmega + 2.0*sqrtA*alpha
		f.a1 = -2.0 * ((q - 1.0) + (q+1.0)*cosOmega)
		f.a2 = (q + 1.0) + (q-1.0)*cosOmega - 2.0*sqrtA*alpha

	case BiQuadHighshelf:
		sqrtA := math.Sqrt(q)
		f.b0 = q * ((q + 1.0) + (q-1.0)*cosOmega + 2.0*sqrtA*alpha)
		f.b1 = -2.0 * q * ((q - 1.0) + (q+1.0)*cosOmega)
		f.b2 = q * ((q + 1.0) + (q-1.0)*cosOmega - 2.0*sqrtA*alpha)
		f.a0 = (q + 1.0) - (q-1.0)*cosOmega + 2.0*sqrtA*alpha
		f.a1 = 2.0 * ((q - 1.0) - (q+1.0)*cosOmega)
		f.a2 = (q + 1.0) - (q-1.0)*cosOmega - 2.0*sqrtA*alpha
	}

	// Normalize coefficients
	f.b0 /= f.a0
	f.b1 /= f.a0
	f.b2 /= f.a0
	f.a1 /= f.a0
	f.a2 /= f.a0
	f.a0 = 1.0
}

// Filter processes a single sample through the filter
func (f *BiQuadFilter) Filter(input float64) float64 {
	output := f.b0*input + f.b1*f.x1 + f.b2*f.x2 - f.a1*f.y1 - f.a2*f.y2

	// Shift delay line
	f.x2 = f.x1
	f.x1 = input
	f.y2 = f.y1
	f.y1 = output

	return output
}

// Reset clears the filter state
func (f *BiQuadFilter) Reset() {
	f.x1 = 0
	f.x2 = 0
	f.y1 = 0
	f.y2 = 0
}

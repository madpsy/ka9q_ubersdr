package sstv

import (
	"gonum.org/v1/gonum/dsp/fourier"
)

/*
 * FFT Helper Functions
 * Using gonum's proven FFT implementation
 *
 * Copyright (c) 2026, UberSDR project
 */

// fft performs a Fast Fourier Transform on real input data
// input: real-valued input samples (must be power of 2)
// output: complex-valued frequency domain output
func fft(input []float64, output []complex128) {
	n := len(input)

	// Ensure output is the right size
	if len(output) < n {
		panic("fft: output buffer too small")
	}

	// Check if n is power of 2
	if n&(n-1) != 0 {
		panic("fft: input length must be power of 2")
	}

	// Create FFT instance
	fftInstance := fourier.NewFFT(n)

	// Compute FFT
	coeffs := fftInstance.Coefficients(nil, input)

	// Copy to output
	copy(output, coeffs)
}

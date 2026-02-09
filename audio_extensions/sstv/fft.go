package sstv

import (
	"gonum.org/v1/gonum/dsp/fourier"
)

/*
 * FFT Helper Functions
 * Uses gonum.org/v1/gonum/dsp/fourier for FFT operations
 *
 * Copyright (c) 2026, UberSDR project
 */

// fft performs a Fast Fourier Transform on real input data
// input: real-valued input samples
// output: complex-valued frequency domain output
func fft(input []float64, output []complex128) {
	n := len(input)

	// Ensure output is the right size
	if len(output) < n {
		panic("fft: output buffer too small")
	}

	// Convert input to complex
	complexInput := make([]complex128, n)
	for i, v := range input {
		complexInput[i] = complex(v, 0)
	}

	// Perform FFT using radix-2 algorithm
	// Pad to power of 2 if needed
	paddedInput := fourier.PadRadix2(complexInput)
	coeffs := fourier.CoefficientsRadix2(paddedInput)

	// Copy first n coefficients to output
	copy(output, coeffs[:n])
}

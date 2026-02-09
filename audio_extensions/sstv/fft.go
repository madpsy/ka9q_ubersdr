package sstv

import (
	"math"
	"math/cmplx"
)

/*
 * FFT Helper Functions
 * Pure Go implementation to match KiwiSDR's exact FFT behavior
 *
 * Copyright (c) 2026, UberSDR project
 */

// fft performs a Fast Fourier Transform on real input data
// This is a radix-2 Cooley-Tukey FFT implementation
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

	// Convert input to complex
	complexInput := make([]complex128, n)
	for i, v := range input {
		complexInput[i] = complex(v, 0)
	}

	// Perform FFT
	fftRadix2(complexInput)

	// Copy to output
	copy(output, complexInput)
}

// fftRadix2 performs in-place radix-2 FFT
// This matches FFTW's behavior used by KiwiSDR
func fftRadix2(data []complex128) {
	n := len(data)

	// Bit-reversal permutation
	j := 0
	for i := 0; i < n-1; i++ {
		if i < j {
			data[i], data[j] = data[j], data[i]
		}
		k := n / 2
		for k <= j {
			j -= k
			k /= 2
		}
		j += k
	}

	// Cooley-Tukey FFT
	for size := 2; size <= n; size *= 2 {
		halfSize := size / 2
		step := 2 * math.Pi / float64(size)

		for i := 0; i < n; i += size {
			for j := 0; j < halfSize; j++ {
				// Twiddle factor
				angle := step * float64(j)
				w := cmplx.Exp(complex(0, -angle))

				// Butterfly operation
				t := w * data[i+j+halfSize]
				u := data[i+j]

				data[i+j] = u + t
				data[i+j+halfSize] = u - t
			}
		}
	}
}

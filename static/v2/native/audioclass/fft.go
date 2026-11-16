// fft.go — an in-place radix-2 FFT, for the mel spectrogram (efficientat.go).
package main

import "math"

// fftRadix2 computes the in-place DIT FFT of x (length must be a power of 2).
func fftRadix2(x []complex128) {
	n := len(x)
	if n <= 1 {
		return
	}
	// Bit-reversal permutation
	j := 0
	for i := 1; i < n; i++ {
		bit := n >> 1
		for ; j&bit != 0; bit >>= 1 {
			j ^= bit
		}
		j ^= bit
		if i < j {
			x[i], x[j] = x[j], x[i]
		}
	}
	// Butterfly stages
	for length := 2; length <= n; length <<= 1 {
		angle := -2 * math.Pi / float64(length)
		wlen := complex(math.Cos(angle), math.Sin(angle))
		for i := 0; i < n; i += length {
			w := complex(1, 0)
			half := length / 2
			for k := 0; k < half; k++ {
				u := x[i+k]
				v := x[i+k+half] * w
				x[i+k] = u + v
				x[i+k+half] = u - v
				w *= wlen
			}
		}
	}
}

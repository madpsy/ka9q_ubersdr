//go:build amd64 && !purego

package pcmv4

// pcmv4UseSIMD selects the AVX2 kernel. A variable so the tests can hold the
// pure-Go block to the same output.
var pcmv4UseSIMD = pcmv4HasAVX2()

// pcmv4HasAVX2 reports AVX2 support, OS state saving included.
func pcmv4HasAVX2() bool

//go:noescape
func pcmv4SIMDForward(st *pcmv4SIMDState, samples *int16, res *int32, frames int, mu int64)

// pcmv4SIMDInverse decodes up to frames I/Q frames, returning how many it did:
// it stops before a reconstructed sample that leaves int32.
//
//go:noescape
func pcmv4SIMDInverse(st *pcmv4SIMDState, res *int32, out *int16, frames int, mu int64) int

//go:build !amd64 || purego

package pcmv4

// No SIMD kernel on this platform; the block paths run in Go.
var pcmv4UseSIMD = false

func (f *complexStage) forwardSIMD(samples []int16, res []int32) bool { return false }

func (f *complexStage) inverseSIMD(res []int32, out []int16) int { return 0 }

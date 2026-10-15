package main

// No SIMD kernel in this client: Go does not allow assembly in a package that
// uses cgo, as this one does, so the block paths run in Go everywhere. That is
// the fused per-packet loop, not the per-frame one -- and this client is
// mostly audio, which the complex stage does not decode at all.
var pcmv4UseSIMD = false

func (f *complexStage) forwardSIMD(samples []int16, res []int32) bool { return false }

func (f *complexStage) inverseSIMD(res []int32, out []int16) int { return 0 }

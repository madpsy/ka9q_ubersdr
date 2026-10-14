//go:build !(amd64 && !purego) && !(arm64 && cgo && !purego)

package main

// cx16SIMD is never set without a kernel; see pcm_predictive_simd.go.
var cx16SIMD = false

func (f *complexStage) forwardBlock16Asm(samples []int16, res []int32) bool {
	return false
}

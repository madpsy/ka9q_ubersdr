//go:build amd64 && !purego

package main

import "golang.org/x/sys/cpu"

// cx16SIMD selects the SIMD kernel for forwardBlock16, here AVX2. It is a
// variable so the tests can turn it off and hold the pure-Go block to the same
// reference.
var cx16SIMD = cpu.X86.HasAVX2

// cx16Forward runs forwardBlock16's arithmetic over frames interleaved I/Q
// samples, writing 2*frames residuals and leaving st at the state after the
// last frame. See pcm_predictive_amd64.s.
//
//go:noescape
func cx16Forward(st *cx16State, samples *int16, res *int32, frames int, mu int64)

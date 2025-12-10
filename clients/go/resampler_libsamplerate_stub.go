//go:build !cgo
// +build !cgo

package main

import "fmt"

// LibsamplerateResampler stub for non-CGo builds
type LibsamplerateResampler struct{}

// NewLibsamplerateResampler returns an error when CGo is not available
func NewLibsamplerateResampler(inputRate, outputRate, channels int, quality int) (*LibsamplerateResampler, error) {
	return nil, fmt.Errorf("libsamplerate not available (CGo disabled)")
}

// Process stub
func (r *LibsamplerateResampler) Process(input []int16) []int16 {
	return input
}

// Reset stub
func (r *LibsamplerateResampler) Reset() {}

// Close stub
func (r *LibsamplerateResampler) Close() {}

// GetLatency stub
func (r *LibsamplerateResampler) GetLatency() int {
	return 0
}

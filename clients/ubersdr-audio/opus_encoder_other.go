//go:build !windows && !linux

package main

import "errors"

// opusEncoder is a no-op stub on platforms without Opus encoding support.
// Recording will fall back to WAV format automatically.
type opusEncoder struct{}

func newOpusEncoder(_, _ int) (*opusEncoder, error) {
	return nil, errors.New("Opus encoding not supported on this platform; recording will use WAV")
}

func (e *opusEncoder) encode(_ []int16) ([]byte, error) {
	return nil, errors.New("Opus encoding not supported on this platform")
}

func (e *opusEncoder) header() []byte        { return nil }
func (e *opusEncoder) commentHeader() []byte { return nil }
func (e *opusEncoder) close()                {}

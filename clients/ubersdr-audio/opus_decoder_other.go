//go:build !windows && !linux

package main

import "errors"

// opusDecoder is a no-op stub on platforms with no libopus binding.
//
// It still carries sampleRate and channels because the shared framing code in
// opus_frame.go reads them to decide whether the decoder has to be rebuilt.
// Nothing ever populates them here -- newOpusDecoder always fails, so the
// pointer stays nil -- but the field must exist for that file to compile.
type opusDecoder struct {
	sampleRate int
	channels   int
}

func newOpusDecoder(_, _ int) (*opusDecoder, error) {
	return nil, errors.New("Opus not supported on this platform")
}

func (d *opusDecoder) Decode(_ []byte) ([]byte, error) {
	return nil, errors.New("Opus not supported on this platform")
}

func (d *opusDecoder) Close() {}

// cleanupOpusDLL is a no-op on non-Windows platforms.
func cleanupOpusDLL() {}

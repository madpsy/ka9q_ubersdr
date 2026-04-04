//go:build !windows

package main

import "errors"

// opusDecoder is a no-op stub on non-Windows platforms.
type opusDecoder struct{}

func newOpusDecoder(_, _ int) (*opusDecoder, error) {
	return nil, errors.New("Opus not supported on this platform")
}

func (d *opusDecoder) Decode(_ []byte) ([]byte, error) {
	return nil, errors.New("Opus not supported on this platform")
}

func (d *opusDecoder) Close() {}

// decodeOpusFrame is a no-op stub on non-Windows platforms.
func decodeOpusFrame(data []byte, dec **opusDecoder) (pcm []byte, sampleRate, channels int, basebandPower, noiseDensity float32, err error) {
	err = errors.New("Opus not supported on this platform")
	return
}

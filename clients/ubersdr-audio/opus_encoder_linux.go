//go:build linux

package main

// opus_encoder_linux.go — CGo-based libopus encoder for Linux.
// Requires libopus development headers: apt install libopus-dev

/*
#cgo LDFLAGS: -lopus
#include <opus/opus.h>
#include <stdlib.h>

// opus_encoder_set_bitrate is a non-variadic C wrapper around opus_encoder_ctl
// so that CGo can call it without the "unexpected type: ..." variadic error.
static int opus_encoder_set_bitrate(OpusEncoder *enc, int bitrate) {
    return opus_encoder_ctl(enc, OPUS_SET_BITRATE(bitrate));
}
*/
import "C"

import (
	"fmt"
	"unsafe"
)

// opusEncoder wraps a libopus OpusEncoder via CGo.
type opusEncoder struct {
	enc        *C.OpusEncoder
	sampleRate int
	channels   int
}

// newOpusEncoder creates a new libopus encoder for the given sample rate and channel count.
// Uses OPUS_APPLICATION_AUDIO for best quality on voice/radio content.
func newOpusEncoder(sampleRate, channels int) (*opusEncoder, error) {
	var errCode C.int
	enc := C.opus_encoder_create(
		C.opus_int32(sampleRate),
		C.int(channels),
		C.OPUS_APPLICATION_AUDIO,
		&errCode,
	)
	if errCode != C.OPUS_OK || enc == nil {
		return nil, fmt.Errorf("opus_encoder_create failed: error code %d", int(errCode))
	}
	// Set bitrate to 32 kbps — good quality for voice/radio, small files.
	C.opus_encoder_set_bitrate(enc, 32000)
	return &opusEncoder{enc: enc, sampleRate: sampleRate, channels: channels}, nil
}

// encode encodes one frame of int16 PCM samples (interleaved channels) to an Opus packet.
// The number of samples per channel must be a valid Opus frame size (e.g. 960 for 20 ms at 48 kHz).
func (e *opusEncoder) encode(samples []int16) ([]byte, error) {
	if len(samples) == 0 {
		return nil, nil
	}
	samplesPerChannel := len(samples) / e.channels

	// Output buffer: 4000 bytes is more than enough for any Opus frame at 32 kbps.
	out := make([]byte, 4000)

	n := C.opus_encode(
		e.enc,
		(*C.opus_int16)(unsafe.Pointer(&samples[0])),
		C.int(samplesPerChannel),
		(*C.uchar)(unsafe.Pointer(&out[0])),
		C.opus_int32(len(out)),
	)
	if n < 0 {
		return nil, fmt.Errorf("opus_encode error: %d", int(n))
	}
	return out[:int(n)], nil
}

// header returns the OpusHead identification header bytes.
func (e *opusEncoder) header() []byte {
	return buildOpusHead(e.channels, e.sampleRate)
}

// commentHeader returns the OpusTags comment header bytes.
func (e *opusEncoder) commentHeader() []byte {
	return buildOpusTags()
}

// close destroys the libopus encoder and frees its memory.
func (e *opusEncoder) close() {
	if e.enc != nil {
		C.opus_encoder_destroy(e.enc)
		e.enc = nil
	}
}

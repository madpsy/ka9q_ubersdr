//go:build linux

package main

// opus_decoder_linux.go — CGo-based libopus decoder for Linux.
// Requires libopus development headers: apt install libopus-dev
// or equivalent (dnf install opus-devel, pacman -S opus, etc.)

/*
#cgo LDFLAGS: -lopus
#include <opus/opus.h>
#include <stdlib.h>
*/
import "C"

import (
	"encoding/binary"
	"fmt"
	"unsafe"
)

// cleanupOpusDLL is a no-op on Linux (no DLL to clean up).
func cleanupOpusDLL() {}

// opusDecoder wraps a libopus OpusDecoder via CGo.
type opusDecoder struct {
	dec        *C.OpusDecoder
	sampleRate int
	channels   int
}

// newOpusDecoder creates a new libopus decoder for the given sample rate and channel count.
func newOpusDecoder(sampleRate, channels int) (*opusDecoder, error) {
	var errCode C.int
	dec := C.opus_decoder_create(C.opus_int32(sampleRate), C.int(channels), &errCode)
	if errCode != C.OPUS_OK || dec == nil {
		return nil, fmt.Errorf("opus_decoder_create failed: error code %d", int(errCode))
	}
	return &opusDecoder{
		dec:        dec,
		sampleRate: sampleRate,
		channels:   channels,
	}, nil
}

// maxOpusFrameSamples is the maximum number of samples per channel per Opus frame
// (120 ms at 48 kHz = 5760 samples).
const maxOpusFrameSamples = 5760

// Decode decodes a single Opus packet and returns int16 LE PCM bytes.
func (d *opusDecoder) Decode(packet []byte) ([]byte, error) {
	// Allocate output buffer: maxFrameSamples * channels * 2 bytes per int16
	pcm := make([]C.opus_int16, maxOpusFrameSamples*d.channels)

	var dataPtr *C.uchar
	var dataLen C.opus_int32
	if len(packet) > 0 {
		dataPtr = (*C.uchar)(unsafe.Pointer(&packet[0]))
		dataLen = C.opus_int32(len(packet))
	}

	n := C.opus_decode(
		d.dec,
		dataPtr,
		dataLen,
		&pcm[0],
		C.int(maxOpusFrameSamples),
		0, // no FEC
	)
	samplesPerChannel := int(n)
	if samplesPerChannel <= 0 {
		return nil, fmt.Errorf("opus_decode error: %d", samplesPerChannel)
	}

	totalSamples := samplesPerChannel * d.channels
	out := make([]byte, totalSamples*2)
	for i := 0; i < totalSamples; i++ {
		binary.LittleEndian.PutUint16(out[i*2:], uint16(pcm[i]))
	}
	return out, nil
}

// Close destroys the libopus decoder and frees its memory.
func (d *opusDecoder) Close() {
	if d.dec != nil {
		C.opus_decoder_destroy(d.dec)
		d.dec = nil
	}
}

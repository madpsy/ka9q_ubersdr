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
	"math"
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

// decodeOpusFrame parses the server's v2 Opus binary frame and returns
// PCM bytes, sampleRate, channels, basebandPower, noiseDensity.
//
// Frame layout (v2):
//
//	[0:8]   uint64 LE  GPS timestamp (ignored)
//	[8:12]  uint32 LE  sample rate
//	[12]    uint8      channels
//	[13:17] float32 LE baseband power
//	[17:21] float32 LE noise density
//	[21:]   bytes      raw Opus packet
func decodeOpusFrame(data []byte, dec **opusDecoder) (pcm []byte, sampleRate, channels int, basebandPower, noiseDensity float32, err error) {
	const headerV2 = 21
	if len(data) < headerV2+1 {
		err = fmt.Errorf("opus frame too short: %d bytes", len(data))
		return
	}

	sampleRate = int(binary.LittleEndian.Uint32(data[8:12]))
	channels = int(data[12])
	basebandPower = math.Float32frombits(binary.LittleEndian.Uint32(data[13:17]))
	noiseDensity = math.Float32frombits(binary.LittleEndian.Uint32(data[17:21]))
	opusPacket := data[headerV2:]

	// (Re)create decoder if sample rate or channel count changed.
	if *dec == nil || (*dec).sampleRate != sampleRate || (*dec).channels != channels {
		if *dec != nil {
			(*dec).Close()
			*dec = nil
		}
		*dec, err = newOpusDecoder(sampleRate, channels)
		if err != nil {
			return
		}
	}

	pcm, err = (*dec).Decode(opusPacket)
	return
}

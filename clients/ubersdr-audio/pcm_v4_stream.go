package main

import (
	"encoding/binary"
	"fmt"
)

// Version 4 packet assembly (receive side)
// ========================================
//
// Ties the header (pcm_v4_header.go) to the payload codec (pcm_predictive.go)
// and presents the receive loop with one call, so handleBinary branches once
// rather than growing a copy of the unpacking logic.
//
// A stream decoder holds the adaptation state of its predictor and the record
// of what the peer has told it, so it belongs to exactly one connection and one
// goroutine, and must be discarded when the socket closes.

// PCMv4StreamDecoder reads version 4 packets for one connection.
type PCMv4StreamDecoder struct {
	header  *PCMv4HeaderDecoder
	codec   *PredictiveCodec
	profile byte
}

// NewPCMv4StreamDecoder returns a decoder with no state, which will reject
// packets until a resynchronisation point arrives.
func NewPCMv4StreamDecoder() *PCMv4StreamDecoder {
	return &PCMv4StreamDecoder{header: NewPCMv4HeaderDecoder(), profile: 0xff}
}

// DecodePacket returns the header and the samples as values. Samples are
// interleaved I/Q when the header reports two channels.
//
// The packet is self-contained: the header carries the sample count, so nothing
// has to be told out of band how long the body is.
func (d *PCMv4StreamDecoder) DecodePacket(pkt []byte) (PCMv4Header, []int16, error) {
	h, off, err := d.header.Decode(pkt)
	if err != nil {
		return h, nil, err
	}

	// The packet declares its own profile; nothing here infers it from the
	// mode or the channel count. A profile this build does not implement is an
	// error rather than a fallback -- decoding with the wrong predictor would
	// return plausible noise instead of failing.
	if d.codec == nil || h.Profile != d.profile {
		codec, err := NewPredictiveCodec(h.Profile)
		if err != nil {
			return h, nil, fmt.Errorf("pcm v4: %w", err)
		}
		d.codec = codec
		d.profile = h.Profile
	}

	if h.Silent {
		// No body was sent. Advance the predictor over the implied zeros
		// exactly as the encoder did.
		if len(pkt) != off {
			return h, nil, fmt.Errorf("pcm v4: silent packet carries %d bytes of body", len(pkt)-off)
		}
		if err := d.codec.AdvanceSilence(h.SampleCount); err != nil {
			return h, nil, fmt.Errorf("pcm v4: %w", err)
		}
		return h, make([]int16, h.SampleCount), nil
	}

	samples, err := d.codec.DecodeBody(pkt[off:], h.SampleCount, h.Escape)
	if err != nil {
		return h, nil, fmt.Errorf("pcm v4: %w", err)
	}
	return h, samples, nil
}

// DecodePacketLE is DecodePacket in the shape the rest of this client works in:
// little-endian int16 bytes plus the stream parameters, ready for the audio
// output.
//
// The returned slice is freshly allocated on every call because it is handed to
// another goroutine.
func (d *PCMv4StreamDecoder) DecodePacketLE(pkt []byte) (pcmLE []byte, sampleRate, channels int, basebandPower, noise float32, err error) {
	const noData = float32(-999)

	h, samples, err := d.DecodePacket(pkt)
	if err != nil {
		return nil, 0, 0, noData, noData, err
	}

	pcmLE = make([]byte, len(samples)*2)
	for i, s := range samples {
		binary.LittleEndian.PutUint16(pcmLE[i*2:], uint16(s))
	}
	return pcmLE, h.SampleRate, h.Channels, h.BasebandPower, h.Noise, nil
}

// zstdMagic is the zstd frame magic, 0xFD2FB528 little-endian on the wire.
//
// This client speaks protocol version 4 only, which never wraps a packet in
// zstd -- the predictive codec replaced that. A zstd frame therefore means the
// server is older than 0.1.63, which clamps the requested version to 1-3 and
// silently serves version 1 instead of refusing. Recognising it is what turns
// that into a message the operator can act on rather than a dead stream.
const zstdMagic uint32 = 0xFD2FB528

// isZstdFrame reports whether a binary frame came from a pre-version-4 server.
func isZstdFrame(pkt []byte) bool {
	return len(pkt) >= 4 && binary.LittleEndian.Uint32(pkt) == zstdMagic
}

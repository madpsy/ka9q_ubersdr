package main

import (
	"encoding/binary"
	"fmt"
	"log"
)

// Version 4 packet assembly
// =========================
//
// Ties the header (pcm_v4_header.go) to the payload codec
// (pcm_predictive.go) and presents streamAudio with one call that mirrors
// PCMBinaryEncoder.EncodePCMPacketWithSignalQuality, so the two send paths in
// websocket.go branch once each rather than growing a second copy of the
// packet-building logic.
//
// A stream encoder holds the adaptation state of its predictor and the record
// of what the peer has already been told, so it belongs to exactly one
// connection and one goroutine. That is unlike the shared zstd encoders in
// pcm_binary.go, which are stateless between calls -- and it is why an
// instance is created next to the session's other per-connection encoders
// rather than pooled.

// PCMv4StreamEncoder builds version 4 packets for one connection.
type PCMv4StreamEncoder struct {
	header *PCMv4HeaderEncoder
	codec  *PredictiveCodec

	// profile is the codec configuration in use. When the channel count
	// changes the predictor form must change with it, so the codec is rebuilt.
	profile byte

	// samples is reused across packets to keep the big-endian conversion off
	// the allocator at 1098 packets a second.
	samples []int16

	// packet is the assembled output, likewise reused.
	packet []byte
}

// NewPCMv4StreamEncoder returns an encoder that has told the peer nothing yet.
func NewPCMv4StreamEncoder() *PCMv4StreamEncoder {
	return &PCMv4StreamEncoder{
		header:  NewPCMv4HeaderEncoder(),
		profile: 0xff, // no codec yet; the first packet builds one
	}
}

// EncodePacket assembles one version 4 packet.
//
// pcmData is raw big-endian int16 samples as radiod delivers them, interleaved
// I/Q when channels is 2. basebandPower and noise are in dBFS, or -999 when
// radiod reported nothing.
//
// The returned slice is reused by the next call, so it must be written to the
// socket (or copied) before this is called again.
func (e *PCMv4StreamEncoder) EncodePacket(
	pcmData []byte,
	gpsTimeNs int64,
	sampleRate int,
	channels int,
	basebandPower float32,
	noise float32,
) ([]byte, error) {
	if channels <= 0 {
		channels = 1
	}
	if len(pcmData) < 2 {
		return nil, fmt.Errorf("pcm v4: packet carries %d bytes of samples", len(pcmData))
	}

	// The predictor form follows the channel count, so a mode change that
	// alters it has to rebuild the codec. Discarding the adaptation is correct
	// rather than merely acceptable: the new mode is a different signal, and
	// taps trained on the old one would predict it worse than a cold start.
	// The header notices the same change independently and re-sends metadata,
	// so the two stay consistent without talking to each other.
	want := ProfileForChannels(channels)
	if e.codec == nil || want != e.profile {
		codec, err := NewPredictiveCodec(want)
		if err != nil {
			return nil, fmt.Errorf("pcm v4: %w", err)
		}
		e.codec = codec
		e.profile = want
	}

	// radiod hands over big-endian samples; the codec works on values.
	n := len(pcmData) / 2
	if cap(e.samples) < n {
		e.samples = make([]int16, n)
	}
	e.samples = e.samples[:n]
	for i := 0; i < n; i++ {
		e.samples[i] = int16(binary.BigEndian.Uint16(pcmData[2*i:]))
	}

	// A complex profile consumes whole I/Q frames. A truncated final frame
	// would desynchronise the predictor against the decoder, so drop it rather
	// than code a half sample.
	if want == PredProfileIQ && n%2 != 0 {
		e.samples = e.samples[:n-1]
	}
	if len(e.samples) == 0 {
		return nil, fmt.Errorf("pcm v4: no whole frames in %d bytes", len(pcmData))
	}

	// A closed squelch, a muted session or a dead channel all produce nothing
	// but zeros, and a squelched session produces them indefinitely. Saying so
	// in the header costs no body at all, where coding them costs one bit per
	// sample however well the predictor does.
	//
	// The scan is worth its keep: measured at 0.18 us on a 480-byte packet and
	// 0.52 us on 1440, against roughly 30 us to encode one -- under 2%, and the
	// same when the first non-zero byte is the last one, so no input makes it
	// expensive. Detecting silence rather than being told about it also catches
	// the muted and dead-channel cases, not just the gate.
	silent := true
	for _, b := range pcmData {
		if b != 0 {
			silent = false
			break
		}
	}

	var body []byte
	var escape bool
	if silent {
		// The predictor still has to run. The decoder advances its own filters
		// over the same zeros, and the two must agree sample for sample or
		// everything after this packet decodes wrongly. Advancing without
		// coding skips the Rice bitstream a discarded body used to pay for.
		if err := e.codec.AdvanceSilence(len(e.samples)); err != nil {
			return nil, fmt.Errorf("pcm v4: %w", err)
		}
	} else {
		var err error
		body, escape, err = e.codec.EncodeBody(e.samples)
		if err != nil {
			return nil, fmt.Errorf("pcm v4: %w", err)
		}
	}

	e.packet = e.header.AppendHeader(e.packet[:0], PCMv4Header{
		TimestampNanos: uint64(gpsTimeNs),
		SampleRate:     sampleRate,
		Channels:       channels,
		SampleCount:    len(e.samples),
		BasebandPower:  basebandPower,
		Noise:          noise,
		Profile:        want,
		Escape:         escape,
		Silent:         silent,
	})
	e.packet = append(e.packet, body...)
	return e.packet, nil
}

// PCMv4StreamDecoder is the receiving half, kept here so the two halves are
// read together and cannot drift apart. The server does not use it; clients
// and the tests do.
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

// DecodePacket reverses EncodePacket, returning the header and the samples as
// values. Samples are interleaved I/Q when the header reports two channels.
//
// The packet is self-contained: the header carries the sample count, so
// nothing has to be told out of band how long the body is.
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
		out := make([]int16, h.SampleCount)
		return h, out, nil
	}

	samples, err := d.codec.DecodeBody(pkt[off:], h.SampleCount, h.Escape)
	if err != nil {
		return h, nil, fmt.Errorf("pcm v4: %w", err)
	}
	return h, samples, nil
}

// pcmv4LogOnce keeps the per-session startup line to one per connection.
func pcmv4LogSession(sessionID string, version int) {
	log.Printf("PCM v4 predictive codec initialised for session %s (protocol version %d)", sessionID, version)
}

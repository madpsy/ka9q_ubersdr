// Package v4enc is the server's version 4 encoder, for tests only.
//
// The bridge never encodes; it decodes what an UberSDR server sends. Its tests
// need a server, and a fake one that sent hand-rolled packets would only prove
// the decoder agrees with the fake. So predictive.go and header.go are the
// server's own files, copied verbatim, and this file is the thin stream wrapper
// the server builds around them (pcm_v4_stream.go), minus the adaptive depth
// selector: tests pick the reduced-depth shift themselves so they can assert
// on it.
package v4enc

import "fmt"

// Encoder produces one socket's packet stream, as the server does.
type Encoder struct {
	header  *PCMv4HeaderEncoder
	codec   *PredictiveCodec
	profile byte
	ts      uint64
}

// New returns an encoder whose first packet is a resynchronisation point.
func New() *Encoder {
	return &Encoder{header: NewPCMv4HeaderEncoder(), profile: 0xff}
}

// Encode codes one packet of interleaved samples (I/Q pairs when channels is 2).
// A shift above zero selects the reduced-depth profile and quantises exactly as
// the server's lossyQuantise does; zero is the lossless profile.
func (e *Encoder) Encode(samples []int16, sampleRate, channels int, shift uint) ([]byte, error) {
	if shift > 15 {
		return nil, fmt.Errorf("shift %d out of range", shift)
	}
	want := ProfileFor(channels, shift > 0)
	if e.codec == nil || want != e.profile {
		codec, err := NewPredictiveCodec(want)
		if err != nil {
			return nil, err
		}
		e.codec = codec
		e.profile = want
	}

	s := append([]int16(nil), samples...)
	silent := true
	for _, v := range s {
		if v != 0 {
			silent = false
			break
		}
	}
	if !silent {
		quantise(s, shift)
	}

	var body []byte
	var escape bool
	if silent {
		if err := e.codec.AdvanceSilence(len(s)); err != nil {
			return nil, err
		}
	} else {
		var err error
		body, escape, err = e.codec.EncodeBody(s)
		if err != nil {
			return nil, err
		}
	}

	pkt := e.header.AppendHeader(nil, PCMv4Header{
		TimestampNanos: e.ts,
		SampleRate:     sampleRate,
		Channels:       channels,
		SampleCount:    len(s),
		BasebandPower:  -999,
		Noise:          -999,
		Profile:        want,
		Escape:         escape,
		Silent:         silent,
	})
	e.ts += uint64(len(s)/channels) * 1_000_000_000 / uint64(sampleRate)
	if want == PredProfileIQScaled && !silent {
		pkt = append(pkt, byte(shift))
	}
	return append(pkt, body...), nil
}

// quantise is the server's lossyQuantise (pcm_lossy.go).
func quantise(samples []int16, shift uint) {
	if shift == 0 {
		return
	}
	half := int32(1) << (shift - 1)
	lo, hi := int32(-32768)>>shift, int32(32767)>>shift
	for i, v := range samples {
		q := (int32(v) + half) >> shift
		if q < lo {
			q = lo
		} else if q > hi {
			q = hi
		}
		samples[i] = int16(q)
	}
}

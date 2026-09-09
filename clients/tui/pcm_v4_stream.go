package main

import "fmt"

// Lossless packet assembly (receive side)
// =======================================
//
// Ties the header (pcm_v4_header.go) to the payload codec (pcm_predictive.go)
// so handleAudio branches once rather than growing a copy of the unpacking
// logic.
//
// A stream decoder holds the adaptation state of its predictor and the record
// of what the server has stopped repeating, so it belongs to exactly one
// socket and one goroutine, and must be discarded when that socket drops.

// pcmStreamDecoder reads lossless packets for one session.
type pcmStreamDecoder struct {
	header  *pcmHeaderDecoder
	codec   *PredictiveCodec
	profile byte
}

// newPCMStreamDecoder returns a decoder with no state, which will reject
// packets until a resynchronisation point arrives.
func newPCMStreamDecoder() *pcmStreamDecoder {
	return &pcmStreamDecoder{header: newPCMHeaderDecoder(), profile: 0xff}
}

// decode returns the header and the samples, interleaved when the header
// reports more than one channel.
//
// The packet is self-contained: the header carries the sample count, so nothing
// has to be told out of band how long the body is.
func (d *pcmStreamDecoder) decode(pkt []byte) (pcmHeader, []int16, error) {
	h, off, err := d.header.decode(pkt)
	if err != nil {
		return h, nil, err
	}

	// The packet declares its own profile; nothing here infers it from the
	// mode or the channel count. A profile this build does not implement is an
	// error rather than a fallback — decoding with the wrong predictor would
	// return plausible noise instead of failing.
	if d.codec == nil || h.Profile != d.profile {
		codec, err := NewPredictiveCodec(h.Profile)
		if err != nil {
			return h, nil, fmt.Errorf("pcm: %w", err)
		}
		d.codec = codec
		d.profile = h.Profile
	}

	if h.Silent {
		// No body was sent. Advance the predictor over the implied zeros
		// exactly as the encoder did.
		if len(pkt) != off {
			return h, nil, fmt.Errorf("pcm: silent packet carries %d bytes of body", len(pkt)-off)
		}
		if err := d.codec.AdvanceSilence(h.SampleCount); err != nil {
			return h, nil, fmt.Errorf("pcm: %w", err)
		}
		return h, make([]int16, h.SampleCount), nil
	}

	// The shift leads the body on a scaled packet — the reduced-depth IQ mode
	// that -min-margin asks for. The header's flags byte is full, and a silent
	// packet has no body at all, so carrying it here costs nothing on a dead
	// channel. It is read here rather than in the header decoder because it is
	// part of the payload, exactly as the server writes it.
	var shift uint
	if h.Profile == PredProfileIQScaled {
		if len(pkt) <= off {
			return h, nil, fmt.Errorf("pcm: scaled packet carries no shift")
		}
		shift = uint(pkt[off])
		if shift > lossyMaxShift {
			return h, nil, fmt.Errorf("pcm: shift %d out of range", shift)
		}
		off++
	}

	samples, err := d.codec.DecodeBody(pkt[off:], h.SampleCount, h.Escape)
	if err != nil {
		return h, nil, fmt.Errorf("pcm: %w", err)
	}
	// Undone only on the way out. The predictor above ran on the quantised
	// values, exactly as the server's did, and an escape carries the quantised
	// samples too — so this is the last thing that happens to a packet and no
	// codec state depends on it.
	lossyRestore(samples, shift)
	return h, samples, nil
}

// lossyMaxShift is the largest shift the wire format allows. Bounded because it
// comes off the wire like every other length here and is applied to an int16.
const lossyMaxShift = 15

// lossyRestore undoes the reduced-depth scale, saturating rather than wrapping:
// a value the shift carries past full scale must not come back with its sign
// inverted. It matches the server's lossyRestore in pcm_lossy.go.
func lossyRestore(samples []int16, shift uint) {
	if shift == 0 {
		return
	}
	for i, v := range samples {
		r := int32(v) << shift
		if r > 32767 {
			r = 32767
		} else if r < -32768 {
			r = -32768
		}
		samples[i] = int16(r)
	}
}

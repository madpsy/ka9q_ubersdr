package main

import (
	"encoding/binary"
	"fmt"
)

// The lossless packet header, protocol version 4.
//
// This is the second of the two headers that arrive on the audio socket. The
// first is in audioheader.go, which reads the Opus frames; the server chooses
// the format PER PACKET, so both shapes can reach one session and each is
// identified by the frame itself rather than by what was negotiated.
//
// Versions 1 to 3 sent a fixed 37-byte header on every packet, most of it
// unchanged from the packet before. Version 4 sends a magic, a flags byte, and
// then only what has actually moved:
//
//	[magic u32 = "PCM4"]                       4   always
//	[flags u8]                                 1   always
//	[timestamp]                            8 or ~2   full at a resync, else a delta
//	[sampleCount uvarint]                      2   if the count bit is set
//	[sampleRate uvarint][channels u8]         ~3   if the metadata bit is set
//	[power i16][noise i16]                     4   if the quality bit is set
//	[body]
//
//	flags: bit 7  escape     the body is verbatim samples, not coded
//	       bit 6  quality    power and noise follow
//	       bit 5  metadata   sample rate and channels follow, and the timestamp
//	                         is a full u64 rather than a delta
//	       bit 4  silent     every sample is zero; there is no body at all
//	       bit 3  count      the sample count follows
//	       bits 2-0  profile id for the payload codec
//
// Unlike the Opus header this one carries a sample count, because a coded body
// has no length relationship to the number of samples in it — that is what
// compression means, and the count is what tells the predictor when to stop.
//
// The server emits a resynchronisation point whenever the rate or the channel
// count changes and every five seconds regardless, so a decoder that joins the
// stream late becomes self-describing within that.
//
// The canonical form of this header is pcm_v4_header.go in the repository root
// (the encoder) and the identical decoder carried by the other Go clients. This
// file is the same format written in this client's idiom, so it can share the
// magic and the quality helper that audioheader.go already defines.
const (
	pcmFlagEscape   = 1 << 7
	pcmFlagQuality  = 1 << 6
	pcmFlagMetadata = 1 << 5
	pcmFlagSilent   = 1 << 4
	pcmFlagCount    = 1 << 3

	// Three bits, so eight payload codec profiles; see pcm_predictive.go.
	pcmProfileMask = 0x07
)

// pcmHeader is one lossless packet's metadata. Every field is filled in on
// every packet, carried forward from the last resynchronisation point when the
// packet itself did not repeat it.
type pcmHeader struct {
	// SourceRate is the radio channel's rate and Channels its channel count.
	// Unlike Opus, which always reconstructs at 48 kHz, these describe the
	// samples in this very packet: the body plays at SourceRate or not at all.
	SourceRate int
	Channels   int

	// SampleCount is how many int16 samples the body holds, counting both
	// channels of an interleaved frame.
	SampleCount int

	// Power and Noise are dBFS over the demodulator passband, so their
	// difference is an SNR in dB. Either is -999 when radiod reported nothing.
	Power float32
	Noise float32

	// Profile is the payload codec profile the body was coded with.
	Profile byte

	// Escape reports that the body holds verbatim samples, Silent that every
	// sample is zero and no body was sent at all. They are mutually exclusive.
	Escape bool
	Silent bool
}

// pcmHeaderDecoder reads lossless headers for one socket, carrying forward
// whatever the server chose not to repeat.
//
// Stateful, so it belongs to one session and must be discarded with it. It also
// cannot be shared with the Opus header decoder: the server tracks the two
// formats separately, holding one header encoder for each, so a shared decoder
// would apply one stream's deltas to the other's baseline.
type pcmHeaderDecoder struct {
	haveMetadata bool
	lastTS       uint64
	rate         int
	channels     int
	count        int
	power        int16
	noise        int16
}

func newPCMHeaderDecoder() *pcmHeaderDecoder { return &pcmHeaderDecoder{} }

// decode parses the header at the front of a lossless packet, returning it and
// the offset at which the body begins.
//
// A packet that arrives before any resynchronisation point is refused rather
// than guessed at, exactly as on the Opus path: nothing has said what the
// sample rate is, and the timestamp is a delta from a baseline that was never
// received.
func (d *pcmHeaderDecoder) decode(pkt []byte) (pcmHeader, int, error) {
	var h pcmHeader
	if len(pkt) < 5 {
		return h, 0, fmt.Errorf("pcm header: packet too short (%d bytes)", len(pkt))
	}
	if magic := binary.LittleEndian.Uint32(pkt); magic != losslessMagic {
		return h, 0, fmt.Errorf("pcm header: bad magic 0x%08x", magic)
	}
	flags := pkt[4]
	off := 5

	h.Profile = flags & pcmProfileMask
	h.Escape = flags&pcmFlagEscape != 0
	h.Silent = flags&pcmFlagSilent != 0
	if h.Escape && h.Silent {
		return h, 0, fmt.Errorf("pcm header: escape and silent are mutually exclusive")
	}
	// The metadata bit marks a resynchronisation point, which is also what
	// carries a full timestamp; the two never differ, so there is no separate
	// flag for the second.
	resync := flags&pcmFlagMetadata != 0

	if resync {
		if len(pkt) < off+8 {
			return h, 0, fmt.Errorf("pcm header: truncated timestamp")
		}
		d.lastTS = binary.LittleEndian.Uint64(pkt[off:])
		off += 8
	} else {
		if !d.haveMetadata {
			return h, 0, fmt.Errorf("pcm header: delta packet before any resynchronisation point")
		}
		delta, n := binary.Varint(pkt[off:])
		if n <= 0 {
			return h, 0, fmt.Errorf("pcm header: malformed timestamp delta")
		}
		off += n
		d.lastTS = uint64(int64(d.lastTS) + delta)
	}

	if flags&pcmFlagCount != 0 {
		count, n := binary.Uvarint(pkt[off:])
		if n <= 0 {
			return h, 0, fmt.Errorf("pcm header: malformed sample count")
		}
		off += n
		d.count = int(count)
	}

	if resync {
		rate, n := binary.Uvarint(pkt[off:])
		if n <= 0 {
			return h, 0, fmt.Errorf("pcm header: malformed sample rate")
		}
		off += n
		if len(pkt) < off+1 {
			return h, 0, fmt.Errorf("pcm header: truncated channel count")
		}
		d.rate = int(rate)
		d.channels = int(pkt[off])
		off++
		d.haveMetadata = true
	} else if !d.haveMetadata {
		return h, 0, fmt.Errorf("pcm header: payload before any metadata")
	}

	if flags&pcmFlagQuality != 0 {
		if len(pkt) < off+4 {
			return h, 0, fmt.Errorf("pcm header: truncated signal quality")
		}
		d.power = int16(binary.LittleEndian.Uint16(pkt[off:]))
		d.noise = int16(binary.LittleEndian.Uint16(pkt[off+2:]))
		off += 4
	}

	if d.rate <= 0 || d.channels <= 0 {
		return h, 0, fmt.Errorf("pcm header: implausible metadata (rate %d, channels %d)", d.rate, d.channels)
	}
	if d.count <= 0 {
		return h, 0, fmt.Errorf("pcm header: implausible sample count %d", d.count)
	}

	h.SourceRate = d.rate
	h.Channels = d.channels
	h.SampleCount = d.count
	h.Power = qualityToFloat(d.power)
	h.Noise = qualityToFloat(d.noise)
	return h, off, nil
}

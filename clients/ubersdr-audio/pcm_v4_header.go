package main

import (
	"encoding/binary"
	"fmt"
)

// Protocol version 4 packet header (receive side)
// ===============================================
//
// The decoding half of the server's pcm_v4_header.go. The encoder lives on the
// server only -- this client never produces PCM packets -- but the wire layout
// documented there is reproduced here because a decoder that cannot be read
// against the format it parses is a decoder nobody can check.
//
// Versions 1-3 sent a fixed 37-byte header on every packet, most of it either
// dead or unchanged from the packet before. Version 4 sends a 4-byte magic, a
// flags byte, and then only what has actually changed, which averages about 9
// bytes against 37.
//
// LAYOUT
// ------
//
//	[magic u32 = "PCM4"]                          4   always
//	[flags u8]                                    1   always
//	[timestamp]                               8 or ~2   see below
//	[sampleCount uvarint]                         2   if count present
//	[sampleRate uvarint][channels u8]            ~3   if metadata present
//	[power i16][noise i16]                        4   if quality present
//
//	flags: bit 7  escape        the body is verbatim samples, not coded
//	       bit 6  quality       power and noise follow
//	       bit 5  metadata      sample rate and channels follow, and the
//	                            timestamp is a full u64 rather than a delta
//	       bit 4  silent        every sample is zero; there is no body at all
//	       bit 3  count         the sample count follows
//	       bits 2-0  profile id for the payload codec
//
// A resynchronisation point -- marked by the metadata bit -- carries a full
// timestamp, the sample rate and the channel count. The server emits one
// whenever those change and every five seconds regardless, so a decoder that
// joins a stream late becomes self-describing within that.
//
// Opus frames use the same header with a smaller field set and no magic. They
// are told apart by elimination: a version 4 PCM magic, else a zstd magic,
// else Opus. That is safe rather than merely convenient -- PCMv4Magic's first
// byte is 0x50, which has bit 4 set, while an Opus header's first byte is a
// flags byte using only bits 0 and 1 and so never exceeds 0x03, so the two
// cannot collide at all.

const (
	// PCMv4Magic identifies a version 4 header. Little-endian on the wire it
	// reads "PCM4".
	PCMv4Magic uint32 = 0x344D4350

	// Flag bits in the header's flags byte.
	pcmv4FlagEscape   = 1 << 7
	pcmv4FlagQuality  = 1 << 6
	pcmv4FlagMetadata = 1 << 5
	pcmv4FlagSilent   = 1 << 4
	pcmv4FlagCount    = 1 << 3

	// Opus frames carry only these two flags, in the LOW bits, which is what
	// makes the magic unnecessary; see the note above.
	opusv4FlagQuality  = 1 << 0
	opusv4FlagMetadata = 1 << 1

	// Three bits, so eight payload codec profiles.
	pcmv4ProfileMask = 0x07

	// PCMQualityNoReading is the codepoint for "radiod reported nothing". It
	// stands in for the -999 sentinel, which cannot be represented in
	// centidecibels: -99900 overflows an int16.
	PCMQualityNoReading int16 = -32768
)

// PCMQualityToFloat converts signed centidecibels back to dB, returning the
// -999 sentinel the rest of this client already tests for with `v > -998`.
func PCMQualityToFloat(q int16) float32 {
	if q == PCMQualityNoReading {
		return -999
	}
	return float32(float64(q) / 100)
}

// PCMv4Header is one packet's metadata, in the terms callers use. Which fields
// were actually transmitted is the decoder's business; every field below is
// filled in on every packet, carried forward from the last resynchronisation
// point when the packet itself did not repeat it.
type PCMv4Header struct {
	// TimestampNanos is the GPS-synchronised time of the first sample.
	TimestampNanos uint64

	// SampleRate in Hz and Channels (1 for demodulated audio, 2 for IQ).
	SampleRate int
	Channels   int

	// SampleCount is how many int16 samples the body holds, counting both
	// channels of an interleaved IQ frame. A coded body cannot be measured, so
	// this is what tells the codec when to stop.
	SampleCount int

	// BasebandPower and Noise in dBFS, or -999 when radiod reported nothing.
	BasebandPower float32
	Noise         float32

	// Profile is the payload codec profile; see pcm_predictive.go.
	Profile byte

	// Escape reports that the body holds verbatim samples.
	Escape bool

	// Silent reports that every sample is zero and no body was transmitted.
	// Escape and Silent are mutually exclusive.
	Silent bool
}

// PCMv4HeaderDecoder reads headers for one stream, carrying forward whatever
// the encoder chose not to repeat.
//
// Stateful, per connection, and not safe for concurrent use: create one per
// socket and call it from a single goroutine. The lossless and Opus paths need
// SEPARATE instances, because the server tracks them separately -- it holds one
// header encoder for each -- and a shared decoder would apply one stream's
// deltas to the other's baseline.
type PCMv4HeaderDecoder struct {
	haveMetadata bool
	lastTS       uint64
	rate         int
	channels     int
	count        int
	power        int16
	noise        int16
}

// NewPCMv4HeaderDecoder returns a decoder that has not yet seen metadata and
// so will reject packets until a resynchronisation point arrives.
func NewPCMv4HeaderDecoder() *PCMv4HeaderDecoder { return &PCMv4HeaderDecoder{} }

// Decode parses the header at the front of pkt, returning it and the offset at
// which the payload body begins.
//
// A packet that arrives before any metadata has been seen is rejected rather
// than guessed at. On a WebSocket that is only the case if the socket somehow
// opened mid-stream; the server's periodic resynchronisation ends it either
// way.
func (d *PCMv4HeaderDecoder) Decode(pkt []byte) (PCMv4Header, int, error) {
	var h PCMv4Header
	if len(pkt) < 5 {
		return h, 0, fmt.Errorf("pcm v4 header: packet too short (%d bytes)", len(pkt))
	}
	if magic := binary.LittleEndian.Uint32(pkt); magic != PCMv4Magic {
		return h, 0, fmt.Errorf("pcm v4 header: bad magic 0x%08x", magic)
	}
	flags := pkt[4]
	off := 5

	h.Profile = flags & pcmv4ProfileMask
	h.Escape = flags&pcmv4FlagEscape != 0
	h.Silent = flags&pcmv4FlagSilent != 0
	if h.Escape && h.Silent {
		return h, 0, fmt.Errorf("pcm v4 header: escape and silent are mutually exclusive")
	}
	// A resynchronisation point carries a full timestamp; every other packet
	// carries a delta. The metadata bit marks the former, so it needs no
	// separate flag of its own.
	absolute := flags&pcmv4FlagMetadata != 0

	if absolute {
		if len(pkt) < off+8 {
			return h, 0, fmt.Errorf("pcm v4 header: truncated timestamp")
		}
		d.lastTS = binary.LittleEndian.Uint64(pkt[off:])
		off += 8
	} else {
		if !d.haveMetadata {
			return h, 0, fmt.Errorf("pcm v4 header: delta packet before any resynchronisation point")
		}
		delta, n := binary.Varint(pkt[off:])
		if n <= 0 {
			return h, 0, fmt.Errorf("pcm v4 header: malformed timestamp delta")
		}
		off += n
		d.lastTS = uint64(int64(d.lastTS) + delta)
	}
	h.TimestampNanos = d.lastTS

	if flags&pcmv4FlagCount != 0 {
		count, n := binary.Uvarint(pkt[off:])
		if n <= 0 {
			return h, 0, fmt.Errorf("pcm v4 header: malformed sample count")
		}
		off += n
		d.count = int(count)
	}

	if flags&pcmv4FlagMetadata != 0 {
		rate, n := binary.Uvarint(pkt[off:])
		if n <= 0 {
			return h, 0, fmt.Errorf("pcm v4 header: malformed sample rate")
		}
		off += n
		if len(pkt) < off+1 {
			return h, 0, fmt.Errorf("pcm v4 header: truncated channel count")
		}
		d.rate = int(rate)
		d.channels = int(pkt[off])
		off++
		d.haveMetadata = true
	} else if !d.haveMetadata {
		return h, 0, fmt.Errorf("pcm v4 header: payload before any metadata")
	}

	if flags&pcmv4FlagQuality != 0 {
		if len(pkt) < off+4 {
			return h, 0, fmt.Errorf("pcm v4 header: truncated signal quality")
		}
		d.power = int16(binary.LittleEndian.Uint16(pkt[off:]))
		d.noise = int16(binary.LittleEndian.Uint16(pkt[off+2:]))
		off += 4
	}

	if d.rate <= 0 || d.channels <= 0 {
		return h, 0, fmt.Errorf("pcm v4 header: implausible metadata (rate %d, channels %d)", d.rate, d.channels)
	}
	if d.count <= 0 {
		return h, 0, fmt.Errorf("pcm v4 header: implausible sample count %d", d.count)
	}

	h.SampleRate = d.rate
	h.Channels = d.channels
	h.SampleCount = d.count
	h.BasebandPower = PCMQualityToFloat(d.power)
	h.Noise = PCMQualityToFloat(d.noise)
	return h, off, nil
}

// DecodeOpus parses the header at the front of an Opus frame, returning it and
// the offset at which the Opus packet itself begins.
//
// Opus carries the same timestamp, metadata and signal quality as the lossless
// path, encoded identically. What it does not carry is everything specific to
// the predictive codec: no sample count, since an Opus body's length is
// implicit; no escape, silent or profile bits, since there is no predictor.
func (d *PCMv4HeaderDecoder) DecodeOpus(pkt []byte) (PCMv4Header, int, error) {
	var h PCMv4Header
	if len(pkt) < 2 {
		return h, 0, fmt.Errorf("opus v4 header: packet too short (%d bytes)", len(pkt))
	}
	flags := pkt[0]
	if flags&^byte(opusv4FlagQuality|opusv4FlagMetadata) != 0 {
		return h, 0, fmt.Errorf("opus v4 header: reserved flag bits set (0x%02x)", flags)
	}
	off := 1
	absolute := flags&opusv4FlagMetadata != 0

	if absolute {
		if len(pkt) < off+8 {
			return h, 0, fmt.Errorf("opus v4 header: truncated timestamp")
		}
		d.lastTS = binary.LittleEndian.Uint64(pkt[off:])
		off += 8
	} else {
		if !d.haveMetadata {
			return h, 0, fmt.Errorf("opus v4 header: delta packet before any resynchronisation point")
		}
		delta, n := binary.Varint(pkt[off:])
		if n <= 0 {
			return h, 0, fmt.Errorf("opus v4 header: malformed timestamp delta")
		}
		off += n
		d.lastTS = uint64(int64(d.lastTS) + delta)
	}
	h.TimestampNanos = d.lastTS

	if flags&opusv4FlagMetadata != 0 {
		rate, n := binary.Uvarint(pkt[off:])
		if n <= 0 {
			return h, 0, fmt.Errorf("opus v4 header: malformed sample rate")
		}
		off += n
		if len(pkt) < off+1 {
			return h, 0, fmt.Errorf("opus v4 header: truncated channel count")
		}
		d.rate = int(rate)
		d.channels = int(pkt[off])
		off++
		d.haveMetadata = true
	} else if !d.haveMetadata {
		return h, 0, fmt.Errorf("opus v4 header: payload before any metadata")
	}

	if flags&opusv4FlagQuality != 0 {
		if len(pkt) < off+4 {
			return h, 0, fmt.Errorf("opus v4 header: truncated signal quality")
		}
		d.power = int16(binary.LittleEndian.Uint16(pkt[off:]))
		d.noise = int16(binary.LittleEndian.Uint16(pkt[off+2:]))
		off += 4
	}

	if d.rate <= 0 || d.channels <= 0 {
		return h, 0, fmt.Errorf("opus v4 header: implausible metadata (rate %d, channels %d)", d.rate, d.channels)
	}
	h.SampleRate = d.rate
	h.Channels = d.channels
	h.BasebandPower = PCMQualityToFloat(d.power)
	h.Noise = PCMQualityToFloat(d.noise)
	return h, off, nil
}

// PCMv4IsHeader reports whether a binary frame is a version 4 PCM packet
// rather than an Opus frame. Both arrive on the same socket, because the
// server chooses the format per packet: a session negotiated as Opus receives
// PCM the moment it tunes to IQ.
func PCMv4IsHeader(pkt []byte) bool {
	return len(pkt) >= 4 && binary.LittleEndian.Uint32(pkt) == PCMv4Magic
}

package main

import (
	"encoding/binary"
	"fmt"
)

// The audio packet header, protocol version 4.
//
// Versions 1 to 3 put a fixed header on every frame — 21 bytes of timestamp,
// sample rate, channel count and two signal levels — and repeated all of it 50
// times a second whether or not any of it had changed. Version 4 sends a flags
// byte and then only what moved since the last frame:
//
//	[flags u8]                            1   always
//	[timestamp]                       8 or ~2   full at a resync, else a delta
//	[sampleRate uvarint][channels u8]    ~3   if the metadata bit is set
//	[power i16][noise i16]                4   if the quality bit is set
//	[opus packet]
//
//	flags: bit 0  quality    power and noise follow
//	       bit 1  metadata   sample rate and channels follow, and the timestamp
//	                         is a full u64 rather than a delta
//
// That averages about four bytes against 21, which at 50 frames a second is
// 0.84 kB/s — between 12% and 19% of an Opus stream, the frames being small
// enough that the old header was a sixth of one.
//
// Being variable-length, where the Opus packet starts has to be PARSED. Slicing
// at a fixed offset, as the version 3 reader did, would hand the decoder eight
// bytes of metadata as though they were audio.
//
// The header carries no magic and does not need one. Frames are identified by
// elimination — a lossless magic, else a zstd magic, else Opus — and the first
// byte of a lossless header is 0x50, which has bit 4 set, while a flags byte
// here uses only bits 0 and 1 and so never exceeds 0x03. The two cannot collide
// at all.
const (
	// audioProtocolVersion is what this client asks for at connect, and the
	// only version it reads.
	audioProtocolVersion = 4

	// losslessMagic is "PCM4" little-endian, the first four bytes of a version
	// 4 lossless packet. This client requests Opus and so should never see one,
	// but a server built without libopus serves lossless frames regardless of
	// what was asked for, and saying so beats feeding them to an Opus decoder.
	losslessMagic uint32 = 0x344D4350

	// zstdMagic identifies a version 1-3 lossless frame, which means a server
	// older than 0.1.63: those clamp the requested version to 1-3 and answer
	// with version 1 rather than refusing it.
	zstdMagic uint32 = 0xFD2FB528

	opusFlagQuality  = 1 << 0
	opusFlagMetadata = 1 << 1

	// qualityNoReading is the codepoint for "radiod reported nothing". It
	// stands in for the -999 sentinel, which cannot be represented in
	// centidecibels: -99900 overflows an int16.
	qualityNoReading int16 = -32768
)

// audioHeader is one frame's metadata. Every field is filled in on every frame,
// carried forward from the last resynchronisation point when the frame itself
// did not repeat it.
type audioHeader struct {
	// SourceRate is the radio channel's rate and Channels its channel count.
	// Opus reconstructs at 48 kHz whatever it was encoded from, so the rate
	// describes the channel rather than the PCM that comes back; the channel
	// count does matter, since a stereo stream decodes to interleaved pairs.
	SourceRate int
	Channels   int

	// Power and Noise are dBFS over the demodulator passband, so their
	// difference is an SNR in dB. Either is -999 when radiod reported nothing.
	Power float32
	Noise float32
}

// audioHeaderDecoder reads headers for one socket, carrying forward whatever
// the server chose not to repeat.
//
// Stateful, so it belongs to one session and must be discarded with it — the
// server starts a fresh header encoder on every connection.
type audioHeaderDecoder struct {
	haveMetadata bool
	lastTS       uint64
	rate         int
	channels     int
	power        int16
	noise        int16
}

func newAudioHeaderDecoder() *audioHeaderDecoder { return &audioHeaderDecoder{} }

// decode parses the header at the front of an Opus frame, returning it and the
// offset at which the Opus packet itself begins.
//
// A frame that arrives before any resynchronisation point is refused rather
// than guessed at: nothing has said what the sample rate is, and the timestamp
// is a delta from a baseline that was never received. The server re-sends
// metadata every five seconds, so that state does not last.
func (d *audioHeaderDecoder) decode(pkt []byte) (audioHeader, int, error) {
	var h audioHeader
	if len(pkt) < 2 {
		return h, 0, fmt.Errorf("audio header: frame too short (%d bytes)", len(pkt))
	}
	flags := pkt[0]
	if flags&^byte(opusFlagQuality|opusFlagMetadata) != 0 {
		return h, 0, fmt.Errorf("audio header: reserved flag bits set (0x%02x)", flags)
	}
	off := 1
	// The metadata bit marks a resynchronisation point, which is also what
	// carries a full timestamp; the two never differ, so there is no separate
	// flag for the second.
	resync := flags&opusFlagMetadata != 0

	if resync {
		if len(pkt) < off+8 {
			return h, 0, fmt.Errorf("audio header: truncated timestamp")
		}
		d.lastTS = binary.LittleEndian.Uint64(pkt[off:])
		off += 8

		rate, n := binary.Uvarint(pkt[off:])
		if n <= 0 {
			return h, 0, fmt.Errorf("audio header: malformed sample rate")
		}
		off += n
		if len(pkt) < off+1 {
			return h, 0, fmt.Errorf("audio header: truncated channel count")
		}
		d.rate = int(rate)
		d.channels = int(pkt[off])
		off++
		d.haveMetadata = true
	} else {
		if !d.haveMetadata {
			return h, 0, fmt.Errorf("audio header: delta frame before any resynchronisation point")
		}
		delta, n := binary.Varint(pkt[off:])
		if n <= 0 {
			return h, 0, fmt.Errorf("audio header: malformed timestamp delta")
		}
		off += n
		d.lastTS = uint64(int64(d.lastTS) + delta)
	}

	if flags&opusFlagQuality != 0 {
		if len(pkt) < off+4 {
			return h, 0, fmt.Errorf("audio header: truncated signal quality")
		}
		d.power = int16(binary.LittleEndian.Uint16(pkt[off:]))
		d.noise = int16(binary.LittleEndian.Uint16(pkt[off+2:]))
		off += 4
	}

	if d.rate <= 0 || d.channels <= 0 {
		return h, 0, fmt.Errorf("audio header: implausible metadata (rate %d, channels %d)", d.rate, d.channels)
	}
	if off >= len(pkt) {
		return h, 0, fmt.Errorf("audio header: consumed all %d bytes of the frame", len(pkt))
	}

	h.SourceRate = d.rate
	h.Channels = d.channels
	h.Power = qualityToFloat(d.power)
	h.Noise = qualityToFloat(d.noise)
	return h, off, nil
}

// qualityToFloat converts signed centidecibels to dB, returning the -999
// sentinel that isReportedLevel already tests for.
func qualityToFloat(q int16) float32 {
	if q == qualityNoReading {
		return -999
	}
	return float32(float64(q) / 100)
}

// frameIsLossless reports whether a binary frame carries lossless PCM rather
// than Opus, in either the version 4 or the older zstd shape. This client
// decodes neither; recognising them is what turns "no audio" into a reason.
func frameIsLossless(pkt []byte) (magic uint32, ok bool) {
	if len(pkt) < 4 {
		return 0, false
	}
	m := binary.LittleEndian.Uint32(pkt)
	return m, m == losslessMagic || m == zstdMagic
}

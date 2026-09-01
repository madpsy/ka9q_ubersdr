package main

import (
	"encoding/binary"
	"fmt"
	"math"
)

// Protocol version 4 packet header
// ================================
//
// Version 3 sends a fixed 37-byte header on every packet. Most of it is either
// dead or unchanged from the packet before:
//
//	wallClockMs (8 bytes)  gpsTimeNs/1e6, marked deprecated in pcm_binary.go
//	reserved    (4 bytes)  never carried anything
//	sampleRate  (4 bytes)  changes only on a mode change
//	channels    (1 byte)   likewise
//	power/noise (8 bytes)  float32 pair, but radiod updates them at about
//	                       10 Hz, so at 1098 packets a second the same values
//	                       are repeated ~100 times
//
// Version 4 sends a 4-byte magic, a flags byte, and then only what has
// actually changed. Measured against real captures this averages about 9
// bytes against 37, which is roughly 75% smaller -- 7.5 bytes on a 384 kHz IQ
// stream and 9.8 on 12/24 kHz audio.
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
// Version 4 originally carried a separate "absolute timestamp" bit. It was
// redundant -- it was only ever set together with the metadata bit, since both
// mark a resynchronisation point -- so the metadata bit now implies it and bit
// 4 carries the silent flag instead.
//
// WHY SILENCE GETS ITS OWN MODE
// -----------------------------
// A closed squelch substitutes all-zero PCM rather than dropping the packet,
// because the Web Audio and MediaSession APIs both need a continuous stream
// (see the gate in websocket.go). A session left squelched therefore sends
// nothing but zeros, indefinitely.
//
// Rice coding cannot get that below one bit per sample: a zero residual is a
// bare stop bit. On a 240-sample audio packet that is 30 bytes of stop bits
// however well the predictor does -- structural, not waste. Saying "all zero"
// in a flag removes the body entirely, taking such a packet from about 45
// bytes to the header alone.
//
// The predictor still runs over the zeros on both sides, exactly as it does
// across a verbatim escape, so the two ends stay in step. That costs the
// encoder nothing it was not already spending, and with sign-sign adaptation a
// zero history leaves the taps frozen rather than decaying -- so whatever the
// filter had learned before the squelch closed is still there when the signal
// comes back.
//
// WHY THE SAMPLE COUNT IS TRANSMITTED
// -----------------------------------
// Version 3 never needed it: the body was raw samples, so the packet length
// gave the count away. A coded body has no such relationship -- that is what
// compression means -- and the decoder must know how many samples to expect
// before it can run the predictor.
//
// It cannot be assumed constant. radiod does not deliver a fixed packet size:
// across the captures a 384 kHz stream carries 720 samples on 95% of packets
// and 240 on the rest. So the count is tracked and re-sent whenever it
// changes, like the other fields here, costing about 0.18 bytes per packet on
// IQ and effectively nothing on audio.
//
// WHY THE MAGIC IS FOUR BYTES
// ---------------------------
// It would be tempting to drop it, since a client that negotiated version 4
// knows what it asked for. It cannot: streamAudio picks the format PER PACKET,
// so a session that negotiated format=opus receives Opus frames for audio and
// switches to PCM the moment it tunes to IQ (see the isIQMode branch in
// websocket.go). Both kinds arrive as binary frames on the same socket, and
// only the frame itself can say which it is.
//
// Opus frames carry no magic at all -- they begin with a nanosecond timestamp,
// so their leading bytes are uniformly distributed. The width of the magic is
// therefore a false-positive rate, and each false positive corrupts one frame
// of audio:
//
//	1 byte   1 in 256      ~4 bad frames a second at 1098 packets/s
//	2 bytes  1 in 65536    one every 59 seconds
//	4 bytes  1 in 2^32     one every few years
//
// Two bytes looks sufficient until the rate is worked out; a click a minute is
// not acceptable. Four is what pcm-stream.js already settled on for the same
// reason when sniffing zstd frames, and two extra bytes against a packet of
// roughly a kilobyte costs nothing.
//
// The value differs from version 3's magic deliberately. Negotiation should
// already prevent a v4 packet reaching a v3 parser, but if one ever does, an
// unrecognised magic fails cleanly instead of being read as a 37-byte header
// and playing metadata as audio.
//
// PERIODIC RESYNCHRONISATION
// --------------------------
// Metadata is re-sent, with an absolute timestamp, whenever the sample rate or
// channel count changes -- and also every headerResyncInterval regardless.
//
// The periodic part is not needed for correctness on a WebSocket, which is
// ordered and reliable. It is there because a v4 stream may be written
// straight to a file (iq-recorder does exactly this) and a reader that opens
// such a file part-way through, or after a corrupt region, needs a point at
// which the stream becomes self-describing again. Costing about 0.02 bytes per
// packet, it is far cheaper than the alternative of a stream that can only
// ever be read from its very first byte.
//
// TIMESTAMPS
// ----------
// The GPS timestamp is sent in full at every resynchronisation point and as a
// zigzag varint delta otherwise. Deltas are not uniform -- radiod delivers in
// bursts, and measured gaps ranged from 2 microseconds to 28 milliseconds --
// but a varint absorbs that, averaging 2.5 bytes on IQ and 4 on audio, and is
// never worse than the 8 bytes an absolute value costs.
//
// SIGNAL QUALITY
// --------------
// See PCMQualityFromFloat. The pair is sent only when it changes, which is 1%
// of packets on a 384 kHz IQ stream and 20% on audio.

// pcmMaxProtocolVersion is the newest protocol version this build implements.
// The audio WebSocket refuses anything higher rather than silently serving an
// older one -- see the version negotiation in websocket.go.
const pcmMaxProtocolVersion = 4

const (
	// PCMv4Magic identifies a version 4 header. Little-endian on the wire it
	// reads "PCM4", which makes it findable in a hex dump. Distinct from
	// PCMBinaryMagicFull so a mis-routed packet fails rather than misparses.
	PCMv4Magic uint32 = 0x344D4350

	// Flag bits in the header's flags byte.
	pcmv4FlagEscape   = 1 << 7
	pcmv4FlagQuality  = 1 << 6
	pcmv4FlagMetadata = 1 << 5
	pcmv4FlagSilent   = 1 << 4
	pcmv4FlagCount    = 1 << 3

	// Opus frames use the same header with a smaller field set, and no magic.
	// Their two flags live in the LOW bits deliberately: see
	// AppendOpusHeader for why that placement is what makes the magic
	// unnecessary.
	opusv4FlagQuality  = 1 << 0
	opusv4FlagMetadata = 1 << 1

	// Three bits, so eight profiles. Two are defined and a ninth would need a
	// protocol version bump in any case -- see the note on profile stability
	// in pcm_predictive.go.
	pcmv4ProfileMask = 0x07

	// pcmv4HeaderResyncNanos is how often metadata is re-sent regardless of
	// change, in GPS nanoseconds. Five seconds is short enough that a reader
	// entering a recording at random waits a negligible time for a
	// self-describing point, and long enough that the cost disappears into
	// rounding.
	pcmv4HeaderResyncNanos = 5_000_000_000

	// PCMQualityNoReading is the codepoint for "radiod reported nothing". It
	// stands in for the -999 sentinel, which cannot be represented in
	// centidecibels: -99900 overflows an int16.
	PCMQualityNoReading int16 = -32768

	// Representable range in dB, given 0.01 dB steps in an int16.
	pcmQualityMinDB = -327.67
	pcmQualityMaxDB = 327.67
)

// PCMQualityFromFloat converts a dB reading to signed centidecibels.
//
// Resolution is 0.01 dB, which is 20 times finer than anything displayed --
// the v2 UI renders these with padReading(v, 3, 1) and toFixed(1) -- and keeps
// the error in a derived SNR under 0.01 dB. Two bytes per figure rather than
// four costs nothing worth measuring, because the pair is only transmitted
// when it changes; going down to one byte would put half a dB into the SNR,
// which a one-decimal readout would show.
//
// The server's -999 sentinel, and any non-finite value, become
// PCMQualityNoReading. A NaN takes that path because a NaN comparison is
// false, which is intended: a reading that is not a number is not a reading.
// Finite values outside the representable range are clamped, matching what
// version 3 conveys rather than second-guessing the measurement.
func PCMQualityFromFloat(v float32) int16 {
	d := float64(v)
	if !(d > -998) { // also catches NaN and -Inf
		return PCMQualityNoReading
	}
	if d < pcmQualityMinDB {
		d = pcmQualityMinDB
	}
	if d > pcmQualityMaxDB {
		d = pcmQualityMaxDB
	}
	return int16(math.Round(d * 100))
}

// PCMQualityToFloat reverses PCMQualityFromFloat, returning the -999 sentinel
// clients already test for with `value > -998`.
func PCMQualityToFloat(q int16) float32 {
	if q == PCMQualityNoReading {
		return -999
	}
	return float32(float64(q) / 100)
}

// PCMv4Header is one packet's metadata, in the terms callers use. The wire
// form is what the encoder and decoder below manage; nothing outside them
// needs to know which fields were actually transmitted.
type PCMv4Header struct {
	// TimestampNanos is the GPS-synchronised time of the first sample.
	TimestampNanos uint64

	// SampleRate in Hz and Channels (1 for demodulated audio, 2 for IQ).
	SampleRate int
	Channels   int

	// SampleCount is how many int16 samples the body holds, counting both
	// channels of an interleaved IQ frame. A coded body cannot be measured, so
	// this is what tells the decoder when to stop.
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

// PCMv4HeaderEncoder writes headers for one stream.
//
// It is stateful -- it tracks what the peer has already been told -- so it
// must be created per connection and used from a single goroutine, like the
// codec it accompanies.
type PCMv4HeaderEncoder struct {
	started    bool
	lastTS     uint64
	lastRate   int
	lastCh     int
	lastPower  int16
	lastNoise  int16
	lastCount  int
	lastResync uint64

	// resyncNanos is settable so tests need not fabricate five seconds of
	// timestamps.
	resyncNanos uint64
}

// NewPCMv4HeaderEncoder returns an encoder that has told the peer nothing, so
// its first packet carries a full resynchronisation.
func NewPCMv4HeaderEncoder() *PCMv4HeaderEncoder {
	return &PCMv4HeaderEncoder{resyncNanos: pcmv4HeaderResyncNanos}
}

// AppendHeader appends the wire header for h to dst and returns it.
// AppendOpusHeader writes the version 4 header for an Opus frame.
//
// Opus carries the same timestamp, metadata and signal quality as the lossless
// path, tracked the same way and encoded identically -- the readings come from
// the same signalQualityFor call, so encoding them two different ways would
// only be two places to get the -999 sentinel wrong. What it does not carry is
// everything specific to the predictive codec: no sample count, since an Opus
// body's length is implicit; no escape, silent or profile bits, since there is
// no predictor.
//
// It also carries no magic, and that is safe rather than merely convenient.
// The receiver identifies frames by elimination -- a version 4 PCM magic, else
// a zstd magic, else Opus -- so the only hazard is an Opus header being
// mistaken for PCM. That cannot happen here: PCMv4Magic's first byte is 0x50,
// which has bit 4 set, while an Opus header's first byte is a flags byte using
// only bits 0 and 1 and so never exceeds 0x03. The two cannot collide at all,
// where a shared magic would only have made it improbable.
//
// Saves about 16.7 bytes a packet against the fixed 21-byte version 3 header,
// which at 50 packets a second is 0.84 kB/s -- between 12% and 19% of an Opus
// stream, since its frames are small enough that the header was a sixth of
// them.
func (e *PCMv4HeaderEncoder) AppendOpusHeader(dst []byte, h PCMv4Header) []byte {
	power := PCMQualityFromFloat(h.BasebandPower)
	noise := PCMQualityFromFloat(h.Noise)
	resync := e.needsResync(h)

	var flags byte
	if resync {
		flags |= opusv4FlagMetadata
	}
	sendQuality := resync || power != e.lastPower || noise != e.lastNoise
	if sendQuality {
		flags |= opusv4FlagQuality
	}
	dst = append(dst, flags)
	dst = e.appendCommon(dst, h, resync, sendQuality, false, power, noise)
	return dst
}

// needsResync decides whether this packet re-sends metadata and a full
// timestamp. Shared so the two header shapes cannot drift apart on when a
// stream becomes self-describing again.
func (e *PCMv4HeaderEncoder) needsResync(h PCMv4Header) bool {
	metadataChanged := !e.started || h.SampleRate != e.lastRate || h.Channels != e.lastCh

	// A timestamp that moves backwards, or jumps further than the resync
	// interval, means the stream is not continuous where the delta assumed it
	// was; resynchronise rather than encode a delta nobody can sanity-check.
	discontinuous := e.started &&
		(h.TimestampNanos < e.lastTS || h.TimestampNanos-e.lastTS > e.resyncNanos)

	periodic := e.started && h.TimestampNanos >= e.lastResync &&
		h.TimestampNanos-e.lastResync >= e.resyncNanos

	return metadataChanged || discontinuous || periodic
}

// appendCommon writes the fields both header shapes share, and records what
// the peer has now been told.
func (e *PCMv4HeaderEncoder) appendCommon(dst []byte, h PCMv4Header, resync, sendQuality, sendCount bool, power, noise int16) []byte {
	var scratch [binary.MaxVarintLen64]byte

	if resync {
		dst = binary.LittleEndian.AppendUint64(dst, h.TimestampNanos)
	} else {
		delta := int64(h.TimestampNanos) - int64(e.lastTS)
		n := binary.PutVarint(scratch[:], delta)
		dst = append(dst, scratch[:n]...)
	}

	if sendCount {
		n := binary.PutUvarint(scratch[:], uint64(h.SampleCount))
		dst = append(dst, scratch[:n]...)
	}

	if resync {
		n := binary.PutUvarint(scratch[:], uint64(h.SampleRate))
		dst = append(dst, scratch[:n]...)
		dst = append(dst, byte(h.Channels))
	}

	if sendQuality {
		dst = binary.LittleEndian.AppendUint16(dst, uint16(power))
		dst = binary.LittleEndian.AppendUint16(dst, uint16(noise))
	}

	e.started = true
	e.lastTS = h.TimestampNanos
	e.lastRate = h.SampleRate
	e.lastCh = h.Channels
	e.lastPower = power
	e.lastNoise = noise
	e.lastCount = h.SampleCount
	if resync {
		e.lastResync = h.TimestampNanos
	}
	return dst
}

func (e *PCMv4HeaderEncoder) AppendHeader(dst []byte, h PCMv4Header) []byte {
	power := PCMQualityFromFloat(h.BasebandPower)
	noise := PCMQualityFromFloat(h.Noise)
	resync := e.needsResync(h)

	var flags byte = h.Profile & pcmv4ProfileMask
	if h.Escape {
		flags |= pcmv4FlagEscape
	}
	if h.Silent {
		flags |= pcmv4FlagSilent
	}
	if resync {
		flags |= pcmv4FlagMetadata
	}
	// Quality rides every resynchronisation so such a packet is completely
	// self-describing, and otherwise only when it has changed.
	sendQuality := resync || power != e.lastPower || noise != e.lastNoise
	if sendQuality {
		flags |= pcmv4FlagQuality
	}
	sendCount := resync || h.SampleCount != e.lastCount
	if sendCount {
		flags |= pcmv4FlagCount
	}

	dst = binary.LittleEndian.AppendUint32(dst, PCMv4Magic)
	dst = append(dst, flags)
	return e.appendCommon(dst, h, resync, sendQuality, sendCount, power, noise)
}

// DecodeOpus parses the header at the front of an Opus frame, returning it and
// the offset at which the Opus packet itself begins.
//
// The mirror of AppendOpusHeader. Like the lossless decoder it refuses a packet
// that arrives before any metadata has been seen, rather than guessing at a
// sample rate -- the periodic resynchronisation is what ends that.
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
	// The metadata bit marks a resynchronisation, which is also what carries a
	// full timestamp -- as on the lossless path, the two never differ.
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

// PCMv4HeaderDecoder reads headers for one stream, carrying forward whatever
// the encoder chose not to repeat.
//
// Stateful, per connection, single goroutine -- see the encoder.
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
// than guessed at. That is the normal case when opening a recording part-way
// through, and the periodic resynchronisation is what ends it.
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

// PCMv4IsHeader reports whether a binary frame is a version 4 PCM packet
// rather than an Opus frame. Both arrive on the same socket, because
// streamAudio chooses the format per packet.
func PCMv4IsHeader(pkt []byte) bool {
	return len(pkt) >= 4 && binary.LittleEndian.Uint32(pkt) == PCMv4Magic
}

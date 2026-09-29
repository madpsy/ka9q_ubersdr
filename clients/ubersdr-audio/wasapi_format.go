package main

// wasapi_format.go — the parts of the WASAPI output that are not WASAPI calls:
// the wave format a stream is offered in, which share mode it needs, and the
// conversion of our int16 frames into whatever sample format the device took.
//
// No build tag, so all of it is tested on any platform; audio_output_windows.go
// holds the COM side.
//
// The rule it implements is the one the Linux output follows: a stream reaches
// the device at its own rate or not at all. Windows' shared mode runs every
// stream at the endpoint's mix rate (usually 48 kHz), converting with its own
// filtered resampler when asked to. For a stream at or below the mix rate that
// loses nothing — USB at 12 kHz goes UP to 48 — so shared mode with Windows
// doing the conversion is right. A stream faster than the mix rate would be
// filtered down to it, which for a wide IQ mode throws most of the span away;
// those open in exclusive mode at their own rate, or fail.

import (
	"encoding/binary"
	"math"
)

// needsExclusive reports whether a stream must bypass the shared-mode mixer to
// reach the device whole: only when the mixer runs slower than the stream.
func needsExclusive(streamRate, mixRate int) bool {
	return streamRate > mixRate
}

// sampleKind is a sample format a device may accept in exclusive mode, where
// Windows converts nothing and the device takes only what its driver offers.
type sampleKind int

const (
	samplePCM16     sampleKind = iota
	samplePCM24In32            // 24 valid bits, left-justified in 32
	samplePCM32
	samplePCM24 // packed, three bytes
	sampleFloat32
)

// exclusiveKinds is the order formats are tried in: 16-bit first, since that
// is what the stream is and every wider one merely pads it.
var exclusiveKinds = []sampleKind{samplePCM16, samplePCM24In32, samplePCM32, samplePCM24, sampleFloat32}

func (k sampleKind) bytes() int {
	switch k {
	case samplePCM16:
		return 2
	case samplePCM24:
		return 3
	default:
		return 4
	}
}

func (k sampleKind) validBits() int {
	switch k {
	case samplePCM16:
		return 16
	case samplePCM24In32, samplePCM24:
		return 24
	default:
		return 32
	}
}

func (k sampleKind) String() string {
	return [...]string{"16-bit", "24-bit in 32", "32-bit", "packed 24-bit", "32-bit float"}[k]
}

// waveFormatExtensible is WAVEFORMATEXTENSIBLE laid out as C lays it out. The
// C header packs WAVEFORMATEX to 18 bytes, so Samples sits at offset 18 — a Go
// struct embedding wca.WAVEFORMATEX would pad that to 20 and put every later
// field in the wrong place. Flattened, the natural alignment is C's.
type waveFormatExtensible struct {
	FormatTag      uint16
	Channels       uint16
	SamplesPerSec  uint32
	AvgBytesPerSec uint32
	BlockAlign     uint16
	BitsPerSample  uint16
	CbSize         uint16
	ValidBits      uint16 // Samples.wValidBitsPerSample
	ChannelMask    uint32
	SubFormat      wfxGUID
}

type wfxGUID struct {
	Data1        uint32
	Data2, Data3 uint16
	Data4        [8]byte
}

const waveFormatExtensibleTag = 0xFFFE

var (
	subtypePCM   = wfxGUID{0x00000001, 0x0000, 0x0010, [8]byte{0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}}
	subtypeFloat = wfxGUID{0x00000003, 0x0000, 0x0010, [8]byte{0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}}
)

// Speaker masks for the layouts a stream can ask for itself; any other
// channel count borrows the mix format's mask.
const (
	speakerMono   = 0x4 // front centre
	speakerStereo = 0x3 // front left, front right
)

// newWaveFormat describes one candidate format. mask 0 picks the plain mono
// or stereo layout for those channel counts.
func newWaveFormat(k sampleKind, channels, rate int, mask uint32) waveFormatExtensible {
	if mask == 0 {
		switch channels {
		case 1:
			mask = speakerMono
		case 2:
			mask = speakerStereo
		}
	}
	sub := subtypePCM
	if k == sampleFloat32 {
		sub = subtypeFloat
	}
	block := channels * k.bytes()
	return waveFormatExtensible{
		FormatTag:      waveFormatExtensibleTag,
		Channels:       uint16(channels),
		SamplesPerSec:  uint32(rate),
		AvgBytesPerSec: uint32(rate * block),
		BlockAlign:     uint16(block),
		BitsPerSample:  uint16(k.bytes() * 8),
		CbSize:         22, // the extensible fields after the 18-byte header
		ValidBits:      uint16(k.validBits()),
		ChannelMask:    mask,
		SubFormat:      sub,
	}
}

// encodeFrames converts interleaved int16 frames (srcCh channels) into dst in
// the device's format (dstCh channels of kind k), applying volume and the
// channel mode. It returns the number of frames written.
//
// Mono goes to every output channel. A stereo stream fills the first two and
// leaves any others silent: an IQ pair spread onto a four-channel interface's
// rear outputs would be Q twice, which is no use to anything connected there.
func encodeFrames(dst, src []byte, srcCh, dstCh int, k sampleKind, vol float64, chMode int) int {
	frames := len(src) / (2 * srcCh)
	if room := len(dst) / (dstCh * k.bytes()); room < frames {
		frames = room
	}
	w := k.bytes()
	for f := 0; f < frames; f++ {
		for ch := 0; ch < dstCh; ch++ {
			var s int16
			src0 := -1
			switch {
			case srcCh == 1:
				src0 = 0
			case ch < srcCh:
				src0 = ch
			}
			if src0 >= 0 && !mutedChannel(chMode, ch) {
				s = int16(binary.LittleEndian.Uint16(src[(f*srcCh+src0)*2:]))
				if vol != 1.0 {
					s = int16(float64(s) * vol)
				}
			}
			putSample(dst[(f*dstCh+ch)*w:], s, k)
		}
	}
	return frames
}

// putSample writes one sample. Widening is a left shift, so full scale stays
// full scale and nothing is lost: the extra bits are zero.
func putSample(b []byte, s int16, k sampleKind) {
	switch k {
	case samplePCM16:
		binary.LittleEndian.PutUint16(b, uint16(s))
	case samplePCM24In32, samplePCM32:
		binary.LittleEndian.PutUint32(b, uint32(int32(s)<<16))
	case samplePCM24:
		v := uint32(int32(s) << 8)
		b[0], b[1], b[2] = byte(v), byte(v>>8), byte(v>>16)
	case sampleFloat32:
		binary.LittleEndian.PutUint32(b, math.Float32bits(float32(s)/32768))
	}
}

// mutedChannel reports whether the channel mode silences device channel ch.
func mutedChannel(chMode, ch int) bool {
	return (chMode == ChannelModeLeft && ch != 0) ||
		(chMode == ChannelModeRight && ch != 1)
}

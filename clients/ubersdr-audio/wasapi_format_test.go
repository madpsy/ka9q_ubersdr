package main

import (
	"encoding/binary"
	"math"
	"testing"
	"unsafe"
)

// WASAPI reads the format through a pointer, so the Go struct must have C's
// layout exactly: WAVEFORMATEX packed to 18 bytes, then the extensible fields.
// Offsets are the ones in mmreg.h.
func TestWaveFormatExtensibleLayout(t *testing.T) {
	var w waveFormatExtensible
	for _, tc := range []struct {
		name      string
		got, want uintptr
	}{
		{"size", unsafe.Sizeof(w), 40},
		{"nChannels", unsafe.Offsetof(w.Channels), 2},
		{"nSamplesPerSec", unsafe.Offsetof(w.SamplesPerSec), 4},
		{"nBlockAlign", unsafe.Offsetof(w.BlockAlign), 12},
		{"cbSize", unsafe.Offsetof(w.CbSize), 16},
		{"wValidBitsPerSample", unsafe.Offsetof(w.ValidBits), 18},
		{"dwChannelMask", unsafe.Offsetof(w.ChannelMask), 20},
		{"SubFormat", unsafe.Offsetof(w.SubFormat), 24},
	} {
		if tc.got != tc.want {
			t.Errorf("%s at %d, want %d", tc.name, tc.got, tc.want)
		}
	}
}

func TestNewWaveFormat(t *testing.T) {
	f := newWaveFormat(samplePCM24In32, 2, 384000, 0)
	if f.FormatTag != 0xFFFE || f.Channels != 2 || f.SamplesPerSec != 384000 ||
		f.BlockAlign != 8 || f.AvgBytesPerSec != 384000*8 || f.BitsPerSample != 32 ||
		f.ValidBits != 24 || f.CbSize != 22 || f.ChannelMask != speakerStereo || f.SubFormat != subtypePCM {
		t.Errorf("24-in-32 stereo at 384 kHz: %+v", f)
	}
	if f := newWaveFormat(sampleFloat32, 4, 192000, 0x33); f.SubFormat != subtypeFloat || f.ChannelMask != 0x33 {
		t.Errorf("float, four channels, given mask: %+v", f)
	}
}

// Shared mode, with Windows converting, for everything the mixer can carry;
// exclusive only for a stream the mixer would narrow.
func TestNeedsExclusive(t *testing.T) {
	for _, tc := range []struct {
		stream, mix int
		want        bool
	}{
		{12000, 48000, false},   // USB goes up to the mix rate: nothing lost
		{48000, 48000, false},   // iq48 at the mix rate: passes untouched
		{96000, 48000, true},    // iq96 would be filtered to ±24 kHz
		{384000, 48000, true},   // iq384 likewise
		{192000, 192000, false}, // a mixer already at the IQ rate
		{48000, 44100, true},    // even iq48 loses its edges at 44.1
	} {
		if got := needsExclusive(tc.stream, tc.mix); got != tc.want {
			t.Errorf("%d Hz stream, %d Hz mixer: exclusive %v, want %v", tc.stream, tc.mix, got, tc.want)
		}
	}
}

func pcm(samples ...int16) []byte {
	b := make([]byte, 2*len(samples))
	for i, s := range samples {
		binary.LittleEndian.PutUint16(b[2*i:], uint16(s))
	}
	return b
}

// Every format carries the sample exactly: widening is a shift, so the
// original comes back from the top bits with nothing added.
func TestEncodeFramesIsExact(t *testing.T) {
	src := pcm(1, -1, 32767, -32768, 12345, -54) // three stereo frames
	for _, k := range exclusiveKinds {
		dst := make([]byte, 3*2*k.bytes())
		if n := encodeFrames(dst, src, 2, 2, k, 1.0, ChannelModeBoth); n != 3 {
			t.Fatalf("%v: %d frames, want 3", k, n)
		}
		for i := 0; i < 6; i++ {
			want := int16(binary.LittleEndian.Uint16(src[2*i:]))
			b := dst[i*k.bytes():]
			var got int16
			switch k {
			case samplePCM16:
				got = int16(binary.LittleEndian.Uint16(b))
			case samplePCM24In32, samplePCM32:
				got = int16(int32(binary.LittleEndian.Uint32(b)) >> 16)
			case samplePCM24:
				v := int32(uint32(b[0])<<8|uint32(b[1])<<16|uint32(b[2])<<24) >> 8
				got = int16(v >> 8)
			case sampleFloat32:
				got = int16(math.Round(float64(math.Float32frombits(binary.LittleEndian.Uint32(b))) * 32768))
			}
			if got != want {
				t.Errorf("%v sample %d: %d came back as %d", k, i, want, got)
			}
		}
	}
}

// Mono to every channel; stereo to the first two and silence beyond; the
// channel mode mutes by output channel.
func TestEncodeFramesChannels(t *testing.T) {
	get := func(dst []byte, i int) int16 { return int16(binary.LittleEndian.Uint16(dst[2*i:])) }

	dst := make([]byte, 4*2)
	encodeFrames(dst, pcm(700), 1, 4, samplePCM16, 1.0, ChannelModeBoth)
	for ch := 0; ch < 4; ch++ {
		if get(dst, ch) != 700 {
			t.Errorf("mono to 4ch: channel %d is %d, want 700", ch, get(dst, ch))
		}
	}

	dst = make([]byte, 4*2)
	encodeFrames(dst, pcm(100, -200), 2, 4, samplePCM16, 1.0, ChannelModeBoth)
	if got := []int16{get(dst, 0), get(dst, 1), get(dst, 2), get(dst, 3)}; got[0] != 100 || got[1] != -200 || got[2] != 0 || got[3] != 0 {
		t.Errorf("IQ to 4ch: %v, want [100 -200 0 0]", got)
	}

	dst = make([]byte, 2*2)
	encodeFrames(dst, pcm(100, -200), 2, 2, samplePCM16, 1.0, ChannelModeRight)
	if get(dst, 0) != 0 || get(dst, 1) != -200 {
		t.Errorf("right only: %d/%d, want 0/-200", get(dst, 0), get(dst, 1))
	}

	dst = make([]byte, 2*2)
	encodeFrames(dst, pcm(1000, -1000), 2, 2, samplePCM16, 0.5, ChannelModeBoth)
	if get(dst, 0) != 500 || get(dst, 1) != -500 {
		t.Errorf("half volume: %d/%d, want 500/-500", get(dst, 0), get(dst, 1))
	}
}

// A short destination bounds the frames written.
func TestEncodeFramesStopsAtRoom(t *testing.T) {
	dst := make([]byte, 2*2*2) // two stereo 16-bit frames
	if n := encodeFrames(dst, pcm(1, 2, 3, 4, 5, 6), 2, 2, samplePCM16, 1.0, ChannelModeBoth); n != 2 {
		t.Errorf("wrote %d frames into room for 2", n)
	}
}

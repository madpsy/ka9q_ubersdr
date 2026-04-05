//go:build !windows

package main

// audio_output_other.go — oto v3 fallback for non-Windows platforms.
// On Windows the real WASAPI implementation in audio_output_windows.go is used.
//
// oto only allows ONE context for the lifetime of the process.  We therefore
// keep a package-level singleton context that is created on the first
// NewAudioOutput call and reused for every subsequent call.  The context is
// fixed to the sample rate and channel count of the first stream; if a later
// stream uses different parameters we resample in Push() before handing data
// to oto (nearest-neighbour, same strategy as the Windows WASAPI path).

import (
	"encoding/binary"
	"fmt"
	"sync"
	"time"

	"github.com/ebitengine/oto/v3"
)

// ── Singleton oto context ─────────────────────────────────────────────────────

var (
	otoCtx      *oto.Context
	otoRate     int // sample rate the context was created with
	otoCh       int // channel count the context was created with
	otoInitOnce sync.Once
	otoInitErr  error
)

// getOrCreateOtoContext returns the singleton oto context, creating it on the
// first call.  sampleRate and channels are only used on the first call; later
// calls return the already-created context regardless of the arguments.
func getOrCreateOtoContext(sampleRate, channels int, bufferDuration time.Duration) (*oto.Context, error) {
	otoInitOnce.Do(func() {
		opts := &oto.NewContextOptions{
			SampleRate:   sampleRate,
			ChannelCount: channels,
			Format:       oto.FormatSignedInt16LE,
			BufferSize:   bufferDuration,
		}
		ctx, ready, err := oto.NewContext(opts)
		if err != nil {
			otoInitErr = fmt.Errorf("oto.NewContext: %w", err)
			return
		}
		<-ready
		otoCtx = ctx
		otoRate = sampleRate
		otoCh = channels
	})
	return otoCtx, otoInitErr
}

// ── AudioOutput ───────────────────────────────────────────────────────────────

// AudioOutput manages audio playback via oto (non-Windows fallback).
type AudioOutput struct {
	player  *oto.Player
	reader  *pcmRingReader
	volume  float64
	srcRate int // sample rate of the incoming PCM stream
	srcCh   int // channel count of the incoming PCM stream
	mu      sync.Mutex
}

// EnumerateAudioDevices returns a stub list on non-Windows platforms.
// oto always uses the system default device.
func EnumerateAudioDevices() ([]AudioDevice, error) {
	return []AudioDevice{{ID: "", Name: "Default Device"}}, nil
}

// NewAudioOutput creates (or reuses) an oto context and opens a new player.
// deviceID is ignored on non-Windows (oto always uses the default device).
func NewAudioOutput(sampleRate, channels int, bufferDuration time.Duration, deviceID string) (*AudioOutput, error) {
	ctx, err := getOrCreateOtoContext(sampleRate, channels, bufferDuration)
	if err != nil {
		return nil, err
	}

	reader := newPCMRingReader(32)
	player := ctx.NewPlayer(reader)
	player.Play()

	return &AudioOutput{
		player:  player,
		reader:  reader,
		volume:  1.0,
		srcRate: sampleRate,
		srcCh:   channels,
	}, nil
}

// Push queues PCM audio data (little-endian int16) for playback.
// If the stream's sample rate or channel count differs from the oto context's,
// we resample/remix with nearest-neighbour interpolation before queuing.
func (a *AudioOutput) Push(pcmLE []byte) {
	a.mu.Lock()
	vol := a.volume
	a.mu.Unlock()

	// Resample / remix if the stream parameters differ from the oto context.
	if a.srcRate != otoRate || a.srcCh != otoCh {
		pcmLE = resamplePCM(pcmLE, a.srcRate, a.srcCh, otoRate, otoCh, vol)
		vol = 1.0 // volume already applied inside resamplePCM
	}

	if vol != 1.0 {
		scaled := make([]byte, len(pcmLE))
		for i := 0; i < len(pcmLE)/2; i++ {
			s := int16(binary.LittleEndian.Uint16(pcmLE[i*2:]))
			s = int16(float64(s) * vol)
			binary.LittleEndian.PutUint16(scaled[i*2:], uint16(s))
		}
		a.reader.Push(scaled)
	} else {
		cp := make([]byte, len(pcmLE))
		copy(cp, pcmLE)
		a.reader.Push(cp)
	}
}

// resamplePCM converts little-endian int16 PCM from (srcRate, srcCh) to
// (dstRate, dstCh) using nearest-neighbour interpolation and applies vol.
func resamplePCM(src []byte, srcRate, srcCh, dstRate, dstCh int, vol float64) []byte {
	srcFrames := len(src) / (srcCh * 2)
	if srcFrames == 0 {
		return nil
	}
	dstFrames := srcFrames
	if srcRate != dstRate {
		dstFrames = int(float64(srcFrames) * float64(dstRate) / float64(srcRate))
		if dstFrames < 1 {
			dstFrames = 1
		}
	}
	out := make([]byte, dstFrames*dstCh*2)
	for dstFrame := 0; dstFrame < dstFrames; dstFrame++ {
		srcFrame := dstFrame
		if srcRate != dstRate {
			srcFrame = int(float64(dstFrame) * float64(srcRate) / float64(dstRate))
		}
		if srcFrame >= srcFrames {
			srcFrame = srcFrames - 1
		}
		for ch := 0; ch < dstCh; ch++ {
			srcChan := ch
			if srcChan >= srcCh {
				srcChan = srcCh - 1
			}
			byteIdx := (srcFrame*srcCh + srcChan) * 2
			var s int16
			if byteIdx+1 < len(src) {
				s = int16(binary.LittleEndian.Uint16(src[byteIdx:]))
			}
			if vol != 1.0 {
				s = int16(float64(s) * vol)
			}
			dstOff := (dstFrame*dstCh + ch) * 2
			binary.LittleEndian.PutUint16(out[dstOff:], uint16(s))
		}
	}
	return out
}

// DoneC returns a channel that never closes on non-Windows (oto has no render
// loop that can die independently; the output is always considered alive).
func (a *AudioOutput) DoneC() <-chan struct{} {
	return make(chan struct{}) // never closed
}

// SetChannelMode is a no-op on non-Windows (oto doesn't support per-channel routing).
func (a *AudioOutput) SetChannelMode(_ int) {}

// SetVolume sets the playback volume (0.0–1.0).
func (a *AudioOutput) SetVolume(v float64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if v < 0 {
		v = 0
	}
	if v > 1 {
		v = 1
	}
	a.volume = v
}

// Close stops playback and releases the player.
// The underlying oto context is intentionally kept alive (it is a singleton).
func (a *AudioOutput) Close() {
	if a.player != nil {
		a.player.Close()
		a.player = nil
	}
	if a.reader != nil {
		a.reader.Close()
		a.reader = nil
	}
}

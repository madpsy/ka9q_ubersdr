//go:build !windows

package main

// audio_output_other.go — oto v3 fallback for non-Windows platforms.
// On Windows the real WASAPI implementation in audio_output_windows.go is used.

import (
	"encoding/binary"
	"fmt"
	"sync"
	"time"

	"github.com/ebitengine/oto/v3"
)

// AudioOutput manages audio playback via oto (non-Windows fallback).
type AudioOutput struct {
	ctx    *oto.Context
	player *oto.Player
	reader *pcmRingReader
	volume float64
	mu     sync.Mutex
}

// EnumerateAudioDevices returns a stub list on non-Windows platforms.
// oto always uses the system default device.
func EnumerateAudioDevices() ([]AudioDevice, error) {
	return []AudioDevice{{ID: "", Name: "Default Device"}}, nil
}

// NewAudioOutput creates an oto context and player.
// deviceID is ignored on non-Windows (oto always uses the default device).
func NewAudioOutput(sampleRate, channels int, bufferDuration time.Duration, deviceID string) (*AudioOutput, error) {
	reader := newPCMRingReader(64)

	opts := &oto.NewContextOptions{
		SampleRate:   sampleRate,
		ChannelCount: channels,
		Format:       oto.FormatSignedInt16LE,
		BufferSize:   bufferDuration,
	}

	ctx, ready, err := oto.NewContext(opts)
	if err != nil {
		return nil, fmt.Errorf("oto.NewContext: %w", err)
	}
	<-ready

	player := ctx.NewPlayer(reader)
	player.Play()

	return &AudioOutput{
		ctx:    ctx,
		player: player,
		reader: reader,
		volume: 1.0,
	}, nil
}

// Push queues PCM audio data (little-endian int16) for playback.
func (a *AudioOutput) Push(pcmLE []byte) {
	a.mu.Lock()
	vol := a.volume
	a.mu.Unlock()

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

// Close stops playback and releases resources.
func (a *AudioOutput) Close() {
	if a.player != nil {
		a.player.Close()
	}
	if a.reader != nil {
		a.reader.Close()
	}
}

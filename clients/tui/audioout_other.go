//go:build !linux

package main

import (
	"encoding/binary"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/ebitengine/oto/v3"
)

// oto backend for Windows and macOS. oto reaches WASAPI and CoreAudio through
// purego rather than CGO, so these targets also cross-compile with
// CGO_ENABLED=0. On Linux oto needs ALSA via CGO, which is why Linux uses the
// pure-Go PulseAudio backend instead.

type otoBackend struct {
	ctx    *oto.Context
	player *oto.Player
	once   sync.Once
}

// oto contexts are process-global and expensive, so one is created lazily and
// reused across device switches.
var (
	otoOnce  sync.Once
	otoCtx   *oto.Context
	otoErr   error
	otoReady chan struct{}
)

func ensureOtoContext() (*oto.Context, error) {
	otoOnce.Do(func() {
		ctx, ready, err := oto.NewContext(&oto.NewContextOptions{
			SampleRate:   opusOutputRate,
			ChannelCount: 2,
			Format:       oto.FormatSignedInt16LE,
			BufferSize:   100 * time.Millisecond,
		})
		otoCtx, otoReady, otoErr = ctx, ready, err
	})
	if otoErr != nil {
		return nil, otoErr
	}
	<-otoReady
	return otoCtx, nil
}

// mixerReader adapts the mixer to the io.Reader oto pulls from.
type mixerReader struct {
	mix *mixer
	buf []int16
}

func (r *mixerReader) Read(p []byte) (int, error) {
	frames := len(p) / 4 // 2 channels x 2 bytes
	if frames == 0 {
		return 0, nil
	}
	if cap(r.buf) < frames*2 {
		r.buf = make([]int16, frames*2)
	}
	r.buf = r.buf[:frames*2]

	n := r.mix.readStereo(r.buf)
	for i := 0; i < n; i++ {
		binary.LittleEndian.PutUint16(p[i*2:], uint16(r.buf[i]))
	}
	// Always a full buffer: the mixer pads with silence, and a short read
	// would be taken as end of stream.
	return n * 2, nil
}

func openBackend(deviceID string, mix *mixer) (audioBackend, error) {
	ctx, err := ensureOtoContext()
	if err != nil {
		return nil, fmt.Errorf("cannot open audio output: %w", err)
	}

	player := ctx.NewPlayer(&mixerReader{mix: mix})
	player.Play()

	return &otoBackend{ctx: ctx, player: player}, nil
}

func (b *otoBackend) Close() error {
	b.once.Do(func() {
		if b.player != nil {
			b.player.Pause()
			b.player.Close()
		}
		// The context is intentionally left open for reuse.
	})
	return nil
}

var _ io.Reader = (*mixerReader)(nil)

func listDevices() ([]AudioDevice, error) {
	// oto plays to whatever the system has selected and exposes no enumeration
	// API, so the only honest answer here is the default. Users pick their
	// output in the OS mixer on these platforms.
	return []AudioDevice{{
		ID:      "",
		Name:    "System default (choose in OS sound settings)",
		Default: true,
	}}, nil
}

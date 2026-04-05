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
//
// We always open the oto context with 2 output channels so that L/R channel
// muting works correctly even when the source stream is mono.  Mono streams
// are upmixed to stereo in Push() via the existing resamplePCM path.
//
// Device selection on Linux uses PulseAudio/PipeWire's `pactl move-sink-input`
// to redirect the existing audio stream to a different sink at runtime.
// This avoids recreating the oto context (which is not supported by oto).

import (
	"encoding/binary"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/ebitengine/oto/v3"
)

// ── Singleton oto context ─────────────────────────────────────────────────────

var (
	otoCtx      *oto.Context
	otoRate     int // sample rate the context was created with
	otoCh       int // channel count the context was created with
	otoMu       sync.Mutex
	otoInitOnce sync.Once
	otoInitErr  error
)

// getOrCreateOtoContext returns the singleton oto context, creating it on the
// first call.  sampleRate and channels are only used on the first call; later
// calls return the already-created context regardless of the arguments.
func getOrCreateOtoContext(sampleRate, channels int, bufferDuration time.Duration) (*oto.Context, error) {
	otoInitOnce.Do(func() {
		// Always use 2 output channels so we can independently mute L or R.
		// Mono source streams are upmixed to stereo in Push() before queuing.
		// Without this, oto creates a 1-channel context and the OS upmixes to
		// both speakers, making it impossible to silence one side.
		outChannels := channels
		if outChannels < 2 {
			outChannels = 2
		}
		opts := &oto.NewContextOptions{
			SampleRate:   sampleRate,
			ChannelCount: outChannels,
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
		otoCh = outChannels
	})
	return otoCtx, otoInitErr
}

// ── Device enumeration ────────────────────────────────────────────────────────

// EnumerateAudioDevices returns the list of available audio output sinks.
// On Linux it queries PulseAudio/PipeWire via `pactl list short sinks`.
// Falls back to a single "Default Device" entry if pactl is unavailable.
func EnumerateAudioDevices() ([]AudioDevice, error) {
	devices := []AudioDevice{{ID: "", Name: "Default Device"}}

	out, err := exec.Command("pactl", "list", "short", "sinks").Output()
	if err != nil {
		// pactl not available or failed — return just the default
		return devices, nil
	}

	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		// pactl list short sinks output format:
		//   <index>\t<name>\t<module>\t<sample-spec>\t<state>
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		name := fields[1] // sink name, e.g. "alsa_output.pci-0000_00_1f.3.analog-stereo"

		// Build a friendlier display name.
		display := name
		for _, prefix := range []string{"alsa_output.", "bluez_sink.", "bluez_output."} {
			if strings.HasPrefix(display, prefix) {
				display = strings.TrimPrefix(display, prefix)
				break
			}
		}
		display = strings.NewReplacer(".", " ", "_", " ").Replace(display)
		if len(display) > 0 {
			display = strings.ToUpper(display[:1]) + display[1:]
		}
		devices = append(devices, AudioDevice{ID: name, Name: display})
	}

	return devices, nil
}

// moveSinkInput uses `pactl move-sink-input` to redirect this process's audio
// stream(s) to the named sink at runtime, without recreating the oto context.
// sinkName="" moves to the default sink (@DEFAULT_SINK@).
func moveSinkInput(sinkName string) {
	target := sinkName
	if target == "" {
		target = "@DEFAULT_SINK@"
	}

	pid := fmt.Sprintf("%d", os.Getpid())

	// Use verbose `pactl list sink-inputs` to find sink-input indices that
	// belong to this process, then move each one.
	verboseOut, err := exec.Command("pactl", "list", "sink-inputs").Output()
	if err != nil {
		// Fallback: move all sink-inputs (may affect other apps, but better
		// than nothing when verbose listing fails).
		shortOut, err2 := exec.Command("pactl", "list", "short", "sink-inputs").Output()
		if err2 != nil {
			return
		}
		for _, line := range strings.Split(strings.TrimSpace(string(shortOut)), "\n") {
			fields := strings.Fields(line)
			if len(fields) >= 1 {
				exec.Command("pactl", "move-sink-input", fields[0], target).Run() //nolint:errcheck
			}
		}
		return
	}

	// Parse verbose output blocks:
	//   Sink Input #42
	//       ...
	//       application.process.id = "1234"
	currentIdx := ""
	for _, line := range strings.Split(string(verboseOut), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "Sink Input #") {
			currentIdx = strings.TrimPrefix(trimmed, "Sink Input #")
		} else if currentIdx != "" &&
			strings.Contains(trimmed, "application.process.id") &&
			strings.Contains(trimmed, `"`+pid+`"`) {
			exec.Command("pactl", "move-sink-input", currentIdx, target).Run() //nolint:errcheck
			currentIdx = ""                                                    // reset so we don't move it twice
		}
	}
}

// ── AudioOutput ───────────────────────────────────────────────────────────────

// AudioOutput manages audio playback via oto (non-Windows fallback).
type AudioOutput struct {
	player        *oto.Player
	reader        *pcmRingReader
	onChunkPlayed func(ChunkMeta)
	volume        float64
	channelMode   int // ChannelModeBoth / Left / Right
	srcRate       int // sample rate of the incoming PCM stream
	srcCh         int // channel count of the incoming PCM stream
	mu            sync.Mutex
}

// NewAudioOutput creates (or reuses) an oto context and opens a new player.
// deviceID is the PulseAudio/PipeWire sink name (empty = system default).
// The audio stream is moved to deviceID via pactl after the player starts.
func NewAudioOutput(sampleRate, channels int, bufferDuration time.Duration, deviceID string) (*AudioOutput, error) {
	ctx, err := getOrCreateOtoContext(sampleRate, channels, bufferDuration)
	if err != nil {
		return nil, err
	}

	reader := newPCMRingReader(32)
	player := ctx.NewPlayer(reader)
	player.Play()

	// Move the stream to the requested sink asynchronously.
	// We do this in a goroutine because pactl may take a moment to see the
	// new sink-input after Play() is called.
	if deviceID != "" {
		go func() {
			time.Sleep(200 * time.Millisecond)
			moveSinkInput(deviceID)
		}()
	}

	return &AudioOutput{
		player:  player,
		reader:  reader,
		volume:  1.0,
		srcRate: sampleRate,
		srcCh:   channels,
	}, nil
}

// SetOnChunkPlayed registers a callback that fires (in a goroutine) at
// approximately the moment each audio chunk begins playback.
func (a *AudioOutput) SetOnChunkPlayed(fn func(ChunkMeta)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.onChunkPlayed = fn
}

// Push queues PCM audio data (little-endian int16) for playback, along with
// the signal-quality metadata for that chunk.
// If the stream's sample rate or channel count differs from the oto context's,
// we resample/remix with nearest-neighbour interpolation before queuing.
func (a *AudioOutput) Push(pcmLE []byte, meta ChunkMeta) {
	a.mu.Lock()
	vol := a.volume
	chMode := a.channelMode
	fn := a.onChunkPlayed
	a.mu.Unlock()

	// Snapshot queue depth BEFORE pushing so we know how many chunks are
	// ahead of this one.  Each queued chunk takes chunkDuration to play,
	// plus the hardware buffer adds hardwareBufferDuration on top.
	queued := a.reader.Queued()

	// Resample / remix if the stream parameters differ from the oto context.
	if a.srcRate != otoRate || a.srcCh != otoCh {
		pcmLE = resamplePCM(pcmLE, a.srcRate, a.srcCh, otoRate, otoCh, vol)
		vol = 1.0 // volume already applied inside resamplePCM
	}

	// Apply channel mode and/or volume.
	// We always make a copy so we never mutate the caller's buffer.
	out := make([]byte, len(pcmLE))
	numCh := otoCh
	if numCh < 1 {
		numCh = 1
	}
	numSamples := len(pcmLE) / 2
	for i := 0; i < numSamples; i++ {
		ch := i % numCh
		mute := (chMode == ChannelModeLeft && ch != 0) ||
			(chMode == ChannelModeRight && ch != 1)
		if mute {
			binary.LittleEndian.PutUint16(out[i*2:], 0)
		} else {
			s := int16(binary.LittleEndian.Uint16(pcmLE[i*2:]))
			if vol != 1.0 {
				s = int16(float64(s) * vol)
			}
			binary.LittleEndian.PutUint16(out[i*2:], uint16(s))
		}
	}
	a.reader.Push(out)

	// Delay the callback by the time it will take for this chunk to reach
	// the hardware: (chunks ahead × 20 ms) + hardware buffer.
	if fn != nil {
		delay := time.Duration(queued)*chunkDuration + hardwareBufferDuration
		FireAfterDelay(delay, func() { fn(meta) })
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

// SetChannelMode sets which output channels receive audio (ChannelModeBoth/Left/Right).
// Channel muting is applied in Push() by zeroing the unwanted channel samples.
func (a *AudioOutput) SetChannelMode(mode int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.channelMode = mode
}

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

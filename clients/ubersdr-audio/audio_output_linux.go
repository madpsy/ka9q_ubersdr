//go:build linux

package main

// audio_output_linux.go — ALSA output that opens at each stream's own rate.
//
// This replaces oto on Linux. oto allows one context per process, fixed at the
// rate of the first stream, so everything after a mode change was squeezed to
// whatever that first rate happened to be — usually 12 kHz, since a session
// opens in USB — by a nearest-neighbour converter that folded everything it
// could not carry back into the passband. For the IQ modes that destroys the
// point of them: iq384 is 384 kHz of spectrum and must reach the device as
// 384 kHz, not a fraction of it.
//
// Each AudioOutput here is its own PCM handle, opened at the stream's rate and
// closed with it. client.go already builds a new output whenever the rate or
// channel count changes, so every mode plays at its native rate and nothing in
// this process converts rates at all.
//
// ALSA's own soft resampler is switched off, so a device that cannot run at
// the stream's rate fails to open rather than quietly narrowing it. On a
// PulseAudio/PipeWire desktop the "default" device always accepts the rate;
// whether it reaches the hardware unconverted is then up to the sound server
// (PipeWire's default.clock.allowed-rates).
//
// oto on Linux was itself a wrapper over this same library, so the build needs
// nothing it did not already have (libasound2-dev).

// #cgo pkg-config: alsa
// #include <stdlib.h>
// #include <alsa/asoundlib.h>
import "C"

import (
	"encoding/binary"
	"fmt"
	"log"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"
)

// alsaDevice is the PCM an output opens unless told otherwise. "default" goes
// through the sound server on a desktop, which is what makes pactl device
// selection work.
const alsaDevice = "default"

// alsaDevicePrefix marks a deviceID that names an ALSA PCM directly, e.g.
// "alsa:hw:UR24C" or "alsa:hw:Loopback,0,0", rather than a sound-server sink.
// That bypasses PipeWire/PulseAudio altogether, so the hardware runs at the
// stream's rate or the open fails — the reliable way to get a wide IQ mode to
// an interface at its full width.
const alsaDevicePrefix = "alsa:"

// alsaLatency is the device buffer asked for. The ring buffer in front of it
// is the jitter buffer; this only has to ride out scheduling.
const alsaLatency = 100 * time.Millisecond

// alsaPeriod is how long the write loop waits for a chunk before checking
// whether it has been closed.
const alsaPeriod = 10 * time.Millisecond

// AudioOutput plays one stream through its own ALSA PCM handle.
type AudioOutput struct {
	handle        *C.snd_pcm_t
	reader        *pcmRingReader
	onChunkPlayed func(ChunkMeta)
	volume        float64
	channelMode   int // ChannelModeBoth / Left / Right
	srcRate       int // sample rate of the incoming PCM stream, and the device's
	srcCh         int // channel count of the incoming PCM stream
	outCh         int // channel count the device was opened with
	stopCh        chan struct{}
	doneCh        chan struct{}
	closeOnce     sync.Once
	mu            sync.Mutex
}

// alsaErr renders an ALSA error code.
func alsaErr(op string, rc C.int) error {
	return fmt.Errorf("ALSA %s: %s", op, C.GoString(C.snd_strerror(rc)))
}

// NewAudioOutput opens the device at exactly sampleRate.
// deviceID is the PulseAudio/PipeWire sink name (empty = system default),
// moved to via pactl after the stream starts, or an ALSA PCM behind
// alsaDevicePrefix, opened directly.
func NewAudioOutput(sampleRate, channels int, bufferDuration time.Duration, deviceID string) (*AudioOutput, error) {
	if sampleRate <= 0 {
		return nil, fmt.Errorf("ALSA: implausible sample rate %d", sampleRate)
	}
	if channels < 1 {
		channels = 1
	}
	// Always at least two output channels so L or R can be muted on its own.
	// Mono is duplicated onto both in Push; without this the sound server
	// upmixes and there is no silencing one side.
	outCh := channels
	if outCh < 2 {
		outCh = 2
	}

	pcm := alsaDevice
	if strings.HasPrefix(deviceID, alsaDevicePrefix) {
		pcm = strings.TrimPrefix(deviceID, alsaDevicePrefix)
		deviceID = "" // not a sink: nothing for pactl to move
	}
	name := C.CString(pcm)
	defer C.free(unsafe.Pointer(name))

	var h *C.snd_pcm_t
	if rc := C.snd_pcm_open(&h, name, C.SND_PCM_STREAM_PLAYBACK, 0); rc < 0 {
		return nil, alsaErr("open "+pcm, rc)
	}
	// soft_resample = 0: never let alsa-lib convert the rate. A device that
	// cannot run at sampleRate is an error, not a narrower stream.
	if rc := C.snd_pcm_set_params(h, C.SND_PCM_FORMAT_S16_LE, C.SND_PCM_ACCESS_RW_INTERLEAVED,
		C.uint(outCh), C.uint(sampleRate), 0, C.uint(alsaLatency/time.Microsecond)); rc < 0 {
		C.snd_pcm_close(h)
		return nil, fmt.Errorf("%s does not accept %d Hz in %d channels (%w)", pcm, sampleRate, outCh, alsaErr("set_params", rc))
	}

	// Belt and braces: confirm the rate that was actually set. set_params asks
	// for it exactly, but a plugin that rounded it would play every sample at
	// the wrong speed.
	var hw *C.snd_pcm_hw_params_t
	C.snd_pcm_hw_params_malloc(&hw)
	defer C.snd_pcm_hw_params_free(hw)
	var got C.uint
	var dir C.int
	if C.snd_pcm_hw_params_current(h, hw) == 0 &&
		C.snd_pcm_hw_params_get_rate(hw, &got, &dir) == 0 && int(got) != sampleRate {
		C.snd_pcm_close(h)
		return nil, fmt.Errorf("ALSA: asked for %d Hz, device runs at %d Hz", sampleRate, int(got))
	}

	a := &AudioOutput{
		handle:  h,
		reader:  newPCMRingReader(32),
		volume:  1.0,
		srcRate: sampleRate,
		srcCh:   channels,
		outCh:   outCh,
		stopCh:  make(chan struct{}),
		doneCh:  make(chan struct{}),
	}
	go a.writeLoop()

	// Move the stream to the requested sink once the sound server has seen it.
	if deviceID != "" {
		go func() {
			time.Sleep(200 * time.Millisecond)
			moveSinkInput(deviceID)
		}()
	}
	return a, nil
}

// writeLoop hands the device each chunk as it arrives, whole. It never writes
// silence of its own: a chunk that is late but inside the device buffer plays
// with no gap, and one late enough to empty the buffer is an underrun that
// snd_pcm_recover restarts from — a gap either way, but never padding that
// sits in the buffer and adds to the latency from then on.
func (a *AudioOutput) writeLoop() {
	defer close(a.doneCh)
	defer C.snd_pcm_close(a.handle)

	frameBytes := a.outCh * 2
	for {
		select {
		case <-a.stopCh:
			C.snd_pcm_drop(a.handle)
			return
		default:
		}
		// Short enough that Close is prompt; nothing is written on a timeout.
		chunk, ok := a.reader.next(alsaPeriod)
		if !ok || len(chunk) < frameBytes {
			continue
		}

		frames := len(chunk) / frameBytes
		off := 0
		for off < frames {
			p := unsafe.Pointer(&chunk[off*frameBytes])
			n := C.snd_pcm_writei(a.handle, p, C.snd_pcm_uframes_t(frames-off))
			if n < 0 {
				// An underrun or a suspend; recover and carry on. Anything
				// recover cannot fix ends the loop, which closes DoneC so the
				// client opens a fresh output on the next packet.
				if rc := C.snd_pcm_recover(a.handle, C.int(n), 1); rc < 0 {
					log.Printf("ALSA: write failed: %v", alsaErr("writei", rc))
					return
				}
				continue
			}
			off += int(n)
		}
	}
}

// DoneC is closed when the write loop exits, whether by Close or by an error
// the device could not recover from; client.go opens a new output then.
func (a *AudioOutput) DoneC() <-chan struct{} {
	return a.doneCh
}

// SetOnChunkPlayed registers a callback that fires (in a goroutine) at
// approximately the moment each audio chunk begins playback.
func (a *AudioOutput) SetOnChunkPlayed(fn func(ChunkMeta)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.onChunkPlayed = fn
}

// Push queues PCM audio data (little-endian int16) for playback, along with
// the signal-quality metadata for that chunk. The stream is at the device's
// rate already; only mono is widened to the two output channels.
func (a *AudioOutput) Push(pcmLE []byte, meta ChunkMeta) {
	a.mu.Lock()
	vol := a.volume
	chMode := a.channelMode
	fn := a.onChunkPlayed
	a.mu.Unlock()

	// Snapshot queue depth BEFORE pushing so we know how many chunks are
	// ahead of this one.
	queued := a.reader.Queued()

	frames := len(pcmLE) / (2 * a.srcCh)
	out := make([]byte, frames*a.outCh*2)
	for f := 0; f < frames; f++ {
		for ch := 0; ch < a.outCh; ch++ {
			src := ch
			if src >= a.srcCh {
				src = a.srcCh - 1
			}
			var s int16
			mute := (chMode == ChannelModeLeft && ch != 0) ||
				(chMode == ChannelModeRight && ch != 1)
			if !mute {
				s = int16(binary.LittleEndian.Uint16(pcmLE[(f*a.srcCh+src)*2:]))
				if vol != 1.0 {
					s = int16(float64(s) * vol)
				}
			}
			binary.LittleEndian.PutUint16(out[(f*a.outCh+ch)*2:], uint16(s))
		}
	}
	if len(out) > 0 {
		a.reader.Push(out)
	}

	// Delay the callback by the time it will take for this chunk to reach
	// the hardware: (chunks ahead × 20 ms) + hardware buffer.
	if fn != nil {
		delay := time.Duration(queued)*chunkDuration + hardwareBufferDuration
		FireAfterDelay(delay, func() { fn(meta) })
	}
}

// SetChannelMode sets which output channels receive audio (ChannelModeBoth/Left/Right).
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

// Close stops playback and releases the device. The next stream, at whatever
// rate it runs, opens its own.
func (a *AudioOutput) Close() {
	a.closeOnce.Do(func() {
		close(a.stopCh)
		// writei returns within a period, so this is normally ~10 ms.
		select {
		case <-a.doneCh:
		case <-time.After(2 * time.Second):
			log.Printf("ALSA: Close timed out waiting for the write loop")
		}
		a.reader.Close()
	})
}

// ── Direct devices ────────────────────────────────────────────────────────────

// alsaCardLine matches a card's first line in /proc/asound/cards:
//
//	" 2 [UR24C          ]: USB-Audio - Steinberg UR24C"
var alsaCardLine = regexp.MustCompile(`^\s*(\d+)\s+\[(\S+)\s*\]:\s*.*?\s+-\s+(.+)$`)

// alsaDirectDevices lists every ALSA playback device as a direct output, next
// to the sound server's sinks. These are what a wide IQ mode needs: the sound
// server runs its sinks at one rate (48 kHz unless configured otherwise) and
// resamples everything to it, where a direct device runs at the stream's rate
// or refuses to open.
//
// They open as plughw, not hw. Interfaces often take only their own sample
// format and channel count — the UR24C accepts S32 in four channels and
// nothing else — which plughw converts to; the rate it is not allowed to touch,
// because NewAudioOutput turns resampling off.
func alsaDirectDevices() []AudioDevice {
	cardsRaw, err := os.ReadFile("/proc/asound/cards")
	if err != nil {
		return nil
	}
	pcmRaw, err := os.ReadFile("/proc/asound/pcm")
	if err != nil {
		return nil
	}
	return parseALSADevices(string(cardsRaw), string(pcmRaw))
}

// parseALSADevices is alsaDirectDevices' parsing, from the text of
// /proc/asound/cards and /proc/asound/pcm.
func parseALSADevices(cardsRaw, pcmRaw string) []AudioDevice {
	type card struct{ id, name string }
	cards := map[int]card{}
	for _, line := range strings.Split(cardsRaw, "\n") {
		if m := alsaCardLine.FindStringSubmatch(line); m != nil {
			n, _ := strconv.Atoi(m[1])
			cards[n] = card{id: m[2], name: strings.TrimSpace(m[3])}
		}
	}

	var devices []AudioDevice
	// "02-00: USB Audio : USB Audio : playback 1 : capture 1"
	for _, line := range strings.Split(pcmRaw, "\n") {
		fields := strings.Split(line, ":")
		if len(fields) < 3 || !strings.Contains(line, "playback") {
			continue
		}
		var cardN, devN int
		if _, err := fmt.Sscanf(strings.TrimSpace(fields[0]), "%d-%d", &cardN, &devN); err != nil {
			continue
		}
		c, ok := cards[cardN]
		if !ok {
			continue
		}
		devices = append(devices, AudioDevice{
			ID:   fmt.Sprintf("%splughw:CARD=%s,DEV=%d", alsaDevicePrefix, c.id, devN),
			Name: fmt.Sprintf("%s: %s (direct)", c.name, strings.TrimSpace(fields[1])),
		})
	}
	return devices
}

// ── Resampling check ──────────────────────────────────────────────────────────

// sinkInputSpec matches the rate in a `pactl list sink-inputs` block.
var sinkInputSpec = regexp.MustCompile(`Sample Specification:\s+\S+\s+\d+ch\s+(\d+)Hz`)

// outputPathWarning reports whether the sound server is narrowing this
// process's stream: playing it into a sink that runs below the stream's rate,
// which filters away everything the sink's rate cannot carry. For a demodulated
// mode that never happens — 12 and 24 kHz go up to the sink's rate, harmlessly
// — but a wide IQ mode through a 48 kHz sink keeps only ±24 kHz of its span.
//
// "" when nothing is lost, when the output is a direct device (which runs at
// the stream's rate or does not open), or when pactl cannot say.
func outputPathWarning(out *AudioOutput, deviceID string, rate int) string {
	if strings.HasPrefix(deviceID, alsaDevicePrefix) {
		return ""
	}
	inputs, err := exec.Command("pactl", "list", "sink-inputs").Output()
	if err != nil {
		return ""
	}
	sinks, err := exec.Command("pactl", "list", "short", "sinks").Output()
	if err != nil {
		return ""
	}
	return sinkRateWarning(string(inputs), string(sinks), os.Getpid(), rate)
}

// sinkRateWarning is outputPathWarning's parsing, apart from pactl so it can
// be tested against captured output.
func sinkRateWarning(inputs, sinks string, pid, rate int) string {
	// Our stream's sink. The newest block wins: the previous output's stream
	// can still be listed for a moment after it closes.
	sink := ""
	for _, block := range strings.Split(inputs, "Sink Input #")[1:] {
		if !strings.Contains(block, fmt.Sprintf(`application.process.id = "%d"`, pid)) {
			continue
		}
		m := sinkInputSpec.FindStringSubmatch(block)
		if m == nil || m[1] != strconv.Itoa(rate) {
			continue
		}
		for _, line := range strings.Split(block, "\n") {
			if s, ok := strings.CutPrefix(strings.TrimSpace(line), "Sink: "); ok {
				sink = s
			}
		}
	}
	if sink == "" {
		return ""
	}

	// "53  alsa_output.usb-…  PipeWire  s32le 4ch 48000Hz  IDLE"
	for _, line := range strings.Split(sinks, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 || fields[0] != sink {
			continue
		}
		for _, f := range fields[2:] {
			hz, ok := strings.CutSuffix(f, "Hz")
			if !ok {
				continue
			}
			sinkRate, err := strconv.Atoi(hz)
			if err != nil || sinkRate >= rate {
				return ""
			}
			return fmt.Sprintf("The sound server is resampling this %s stream to %s, so only ±%s of it reaches %s. "+
				"Choose a direct device, or add %d to PipeWire's default.clock.allowed-rates.",
				formatKHz(rate), formatKHz(sinkRate), formatKHz(sinkRate/2), sinkDisplayName(fields[1]), rate)
		}
	}
	return ""
}

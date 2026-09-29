//go:build windows

package main

// audio_output_windows.go — WASAPI audio output with device selection.
//
// A stream reaches the device at its own rate or not at all, as on Linux; see
// wasapi_format.go for the rule and the format handling. Concretely:
//
//   - A stream at or below the endpoint's mix rate — every demodulated mode,
//     and IQ that fits — opens in shared mode in its own format, and Windows
//     converts it to the mix rate with its own filtered resampler
//     (AUTOCONVERTPCM | SRC_DEFAULT_QUALITY). Going up in rate loses nothing.
//   - A stream faster than the mix rate — a wide IQ mode into a 48 kHz
//     endpoint — opens in exclusive mode at its own rate, in whichever sample
//     format the driver accepts. If the driver refuses, or Windows does not
//     allow exclusive use, the open fails and says why: filtering the stream
//     down to the mix rate would throw most of the span away.
//
// This replaces a render loop that always used the mix format and converted
// to it by nearest-neighbour, which folded a wide IQ mode's whole span back
// into the mix rate's passband.
//
// The open happens in NewAudioOutput's call, not after it: the render
// goroutine initialises the stream and reports back before NewAudioOutput
// returns, so a device that cannot play the stream is an error the client
// shows, not a render loop that dies in the background on every packet.
//
// COM is initialised as COINIT_MULTITHREADED in every goroutine that touches
// WASAPI objects.  Apartment-threaded mode requires a Windows message pump
// which Go goroutines do not provide.

import (
	"fmt"
	"log"
	"runtime"
	"sync"
	"time"
	"unsafe"

	"github.com/go-ole/go-ole"
	"github.com/moutend/go-wca/pkg/wca"
)

// AudioOutput manages WASAPI audio playback to a specific device.
type AudioOutput struct {
	reader        *pcmRingReader
	onChunkPlayed func(ChunkMeta)
	volume        float64
	channelMode   int // ChannelModeBoth / Left / Right
	srcRate       int
	srcCh         int
	// exclusive is whether the stream holds the device in exclusive mode.
	// Written by the render goroutine before it reports ready, so it is
	// settled by the time NewAudioOutput returns.
	exclusive bool
	stopCh    chan struct{}
	doneCh    chan struct{}
	closeOnce sync.Once
	mu        sync.Mutex
}

// DoneC returns a channel that is closed when the WASAPI render loop exits.
// Callers can select on this to detect unexpected render-loop death.
func (a *AudioOutput) DoneC() <-chan struct{} {
	return a.doneCh
}

// coInit initialises COM as COINIT_MULTITHREADED on the calling goroutine.
// Returns true if CoUninitialize should be called on exit.
func coInit() bool {
	err := ole.CoInitializeEx(0, ole.COINIT_MULTITHREADED)
	if err == nil {
		return true
	}
	// S_FALSE: this thread already has COM in the same mode. go-ole reports it
	// as an error ("Invalid function"), but it is a success, and one that must
	// still be balanced by CoUninitialize.
	if oleErr, ok := err.(*ole.OleError); ok && oleErr.Code() == 1 {
		return true
	}
	// 0x80010106 = RPC_E_CHANGED_MODE — already initialised in a different
	// apartment (e.g. Fyne's UI thread).  We can still use COM; just don't
	// call CoUninitialize for this goroutine.
	if oleErr, ok := err.(*ole.OleError); ok && oleErr.Code() == 0x80010106 {
		return false
	}
	log.Printf("WASAPI: CoInitializeEx failed: %v", err)
	return false
}

// EnumerateAudioDevices returns all active WASAPI render (output) endpoints.
// The first entry is always "Default Device" with ID="".
func EnumerateAudioDevices() ([]AudioDevice, error) {
	if uninit := coInit(); uninit {
		defer ole.CoUninitialize()
	}

	var mmde *wca.IMMDeviceEnumerator
	if err := wca.CoCreateInstance(
		wca.CLSID_MMDeviceEnumerator, 0,
		wca.CLSCTX_ALL, wca.IID_IMMDeviceEnumerator,
		&mmde,
	); err != nil {
		return nil, fmt.Errorf("CoCreateInstance IMMDeviceEnumerator: %w", err)
	}
	defer mmde.Release()

	var dc *wca.IMMDeviceCollection
	if err := mmde.EnumAudioEndpoints(wca.ERender, wca.DEVICE_STATE_ACTIVE, &dc); err != nil {
		return nil, fmt.Errorf("EnumAudioEndpoints: %w", err)
	}
	defer dc.Release()

	var count uint32
	if err := dc.GetCount(&count); err != nil {
		return nil, fmt.Errorf("GetCount: %w", err)
	}

	devices := make([]AudioDevice, 0, count+1)
	devices = append(devices, AudioDevice{ID: "", Name: "Default Device"})

	for i := uint32(0); i < count; i++ {
		var mmd *wca.IMMDevice
		if err := dc.Item(i, &mmd); err != nil {
			continue
		}

		var devID string
		if err := mmd.GetId(&devID); err != nil {
			mmd.Release()
			continue
		}

		name := devID
		var ps *wca.IPropertyStore
		if err := mmd.OpenPropertyStore(wca.STGM_READ, &ps); err == nil {
			var pv wca.PROPVARIANT
			if err := ps.GetValue(&wca.PKEY_Device_FriendlyName, &pv); err == nil {
				if s := pv.String(); s != "" {
					name = s
				}
			}
			ps.Release()
		}

		devices = append(devices, AudioDevice{ID: devID, Name: name})
		mmd.Release()
	}

	return devices, nil
}

// The AUDCLNT_E_* results the open reports in words. go-wca's constants are
// the low bits only; the HRESULT carries the facility too.
const (
	hrUnsupportedFormat    = 0x88890008
	hrDeviceInUse          = 0x8889000A
	hrExclusiveNotAllowed  = 0x8889000E
	hrBufferSizeNotAligned = 0x88890019
)

func hresult(err error) uintptr {
	if e, ok := err.(*ole.OleError); ok {
		return e.Code()
	}
	return 0
}

// wasapiStream is one initialised stream, ready to start.
type wasapiStream struct {
	ac        *wca.IAudioClient
	arc       *wca.IAudioRenderClient
	bufFrames uint32
	channels  int
	kind      sampleKind
	exclusive bool
	mixRate   int
}

// NewAudioOutput opens deviceID for a stream at sampleRate, in shared or
// exclusive mode as the rate requires, and starts playing. deviceID="" uses
// the system default device.
func NewAudioOutput(sampleRate, channels int, bufferDuration time.Duration, deviceID string) (*AudioOutput, error) {
	if channels < 1 {
		channels = 1
	}
	out := &AudioOutput{
		reader:  newPCMRingReader(32),
		volume:  1.0,
		srcRate: sampleRate,
		srcCh:   channels,
		stopCh:  make(chan struct{}),
		doneCh:  make(chan struct{}),
	}

	ready := make(chan error, 1)
	go out.renderLoop(deviceID, bufferDuration, ready)
	select {
	case err := <-ready:
		if err != nil {
			<-out.doneCh
			out.reader.Close()
			return nil, err
		}
		return out, nil
	case <-time.After(5 * time.Second):
		out.Close()
		return nil, fmt.Errorf("the audio device did not start within 5 s")
	}
}

// SetOnChunkPlayed registers a callback that fires (in a goroutine) at
// approximately the moment each audio chunk begins playback.
func (a *AudioOutput) SetOnChunkPlayed(fn func(ChunkMeta)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.onChunkPlayed = fn
}

// getDevice returns the IMMDevice for the given deviceID (or default if "").
// Caller must Release() the returned device.
func getDevice(mmde *wca.IMMDeviceEnumerator, deviceID string) (*wca.IMMDevice, error) {
	if deviceID == "" {
		var mmd *wca.IMMDevice
		if err := mmde.GetDefaultAudioEndpoint(wca.ERender, wca.EConsole, &mmd); err != nil {
			return nil, fmt.Errorf("GetDefaultAudioEndpoint: %w", err)
		}
		return mmd, nil
	}

	// Enumerate to find by ID
	var dc *wca.IMMDeviceCollection
	if err := mmde.EnumAudioEndpoints(wca.ERender, wca.DEVICE_STATE_ACTIVE, &dc); err != nil {
		return nil, fmt.Errorf("EnumAudioEndpoints: %w", err)
	}
	defer dc.Release()

	var count uint32
	_ = dc.GetCount(&count)
	for i := uint32(0); i < count; i++ {
		var d *wca.IMMDevice
		if err := dc.Item(i, &d); err != nil {
			continue
		}
		var id string
		if err := d.GetId(&id); err != nil {
			d.Release()
			continue
		}
		if id == deviceID {
			return d, nil
		}
		d.Release()
	}

	// Not found — fall back to default
	log.Printf("WASAPI: device %q not found, using default", deviceID)
	var mmd *wca.IMMDevice
	if err := mmde.GetDefaultAudioEndpoint(wca.ERender, wca.EConsole, &mmd); err != nil {
		return nil, fmt.Errorf("GetDefaultAudioEndpoint (fallback): %w", err)
	}
	return mmd, nil
}

// openStream activates the device and initialises a render stream for rate and
// srcCh channels. The returned release frees what it holds, newest first.
func openStream(deviceID string, rate, srcCh int, bufferDuration time.Duration) (*wasapiStream, func(), error) {
	var releases []func()
	release := func() {
		for i := len(releases) - 1; i >= 0; i-- {
			releases[i]()
		}
	}
	fail := func(err error) (*wasapiStream, func(), error) {
		release()
		return nil, nil, err
	}

	var mmde *wca.IMMDeviceEnumerator
	if err := wca.CoCreateInstance(
		wca.CLSID_MMDeviceEnumerator, 0,
		wca.CLSCTX_ALL, wca.IID_IMMDeviceEnumerator,
		&mmde,
	); err != nil {
		return fail(fmt.Errorf("CoCreateInstance IMMDeviceEnumerator: %w", err))
	}
	releases = append(releases, func() { mmde.Release() })

	mmd, err := getDevice(mmde, deviceID)
	if err != nil {
		return fail(err)
	}
	releases = append(releases, func() { mmd.Release() })

	var ac *wca.IAudioClient
	activate := func() error {
		if err := mmd.Activate(wca.IID_IAudioClient, wca.CLSCTX_ALL, nil, &ac); err != nil {
			ac = nil
			return fmt.Errorf("Activate IAudioClient: %w", err)
		}
		return nil
	}
	if err := activate(); err != nil {
		return fail(err)
	}
	// Released through the variable, which the exclusive path below may
	// replace with a fresh client.
	releases = append(releases, func() {
		if ac != nil {
			ac.Release()
		}
	})

	var mix *wca.WAVEFORMATEX
	if err := ac.GetMixFormat(&mix); err != nil {
		return fail(fmt.Errorf("GetMixFormat: %w", err))
	}
	mixRate, mixCh := int(mix.NSamplesPerSec), int(mix.NChannels)
	var mixMask uint32
	if mix.WFormatTag == waveFormatExtensibleTag {
		mixMask = (*waveFormatExtensible)(unsafe.Pointer(mix)).ChannelMask
	}
	ole.CoTaskMemFree(uintptr(unsafe.Pointer(mix)))

	// At least two channels, so L or R can be muted on its own.
	outCh := srcCh
	if outCh < 2 {
		outCh = 2
	}
	st := &wasapiStream{mixRate: mixRate}
	bufRT := wca.REFERENCE_TIME(bufferDuration.Nanoseconds() / 100)

	if !needsExclusive(rate, mixRate) {
		// Our own format; Windows converts it to the mix rate, upwards.
		f := newWaveFormat(samplePCM16, outCh, rate, 0)
		flags := uint32(wca.AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | wca.AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY)
		if err := ac.Initialize(wca.AUDCLNT_SHAREMODE_SHARED, flags, bufRT, 0,
			(*wca.WAVEFORMATEX)(unsafe.Pointer(&f)), nil); err != nil {
			return fail(fmt.Errorf("shared mode at %s: %w", formatKHz(rate), err))
		}
		st.channels, st.kind = outCh, samplePCM16
	} else {
		// The first format the driver takes at the stream's own rate: our
		// channel count, then the device's own, each in every sample width.
		var chosen *waveFormatExtensible
		chans := []int{outCh}
		if mixCh != outCh {
			chans = append(chans, mixCh)
		}
	search:
		for _, ch := range chans {
			for _, k := range exclusiveKinds {
				var mask uint32
				if ch == mixCh && ch > 2 {
					mask = mixMask
				}
				f := newWaveFormat(k, ch, rate, mask)
				if ac.IsFormatSupported(wca.AUDCLNT_SHAREMODE_EXCLUSIVE,
					(*wca.WAVEFORMATEX)(unsafe.Pointer(&f)), nil) == nil {
					chosen = &f
					st.channels, st.kind = ch, k
					break search
				}
			}
		}
		if chosen == nil {
			return fail(fmt.Errorf("the device does not accept %s in exclusive mode, and Windows mixes it at %s, "+
				"which would lose all but ±%s", formatKHz(rate), formatKHz(mixRate), formatKHz(mixRate/2)))
		}

		initExclusive := func() error {
			return ac.Initialize(wca.AUDCLNT_SHAREMODE_EXCLUSIVE, 0, bufRT, 0,
				(*wca.WAVEFORMATEX)(unsafe.Pointer(chosen)), nil)
		}
		err := initExclusive()
		if hresult(err) == hrBufferSizeNotAligned {
			// The documented recovery: take the buffer size the device
			// would have used, and retry with exactly that duration on a
			// fresh client.
			var frames uint32
			if e := ac.GetBufferSize(&frames); e != nil {
				return fail(fmt.Errorf("GetBufferSize: %w", e))
			}
			bufRT = wca.REFERENCE_TIME(float64(frames)*1e7/float64(rate) + 0.5)
			ac.Release()
			if e := activate(); e != nil {
				return fail(e)
			}
			err = initExclusive()
		}
		if err != nil {
			switch hresult(err) {
			case hrExclusiveNotAllowed:
				err = fmt.Errorf("Windows does not allow exclusive use of this device; turn on " +
					"\"Allow applications to take exclusive control of this device\" in its Sound properties, Advanced tab")
			case hrDeviceInUse:
				err = fmt.Errorf("another program is using this device; %s needs it exclusively", formatKHz(rate))
			case hrUnsupportedFormat:
				err = fmt.Errorf("the device does not accept %s %s in %d channels", formatKHz(rate), st.kind, st.channels)
			default:
				err = fmt.Errorf("exclusive mode at %s: %w", formatKHz(rate), err)
			}
			return fail(err)
		}
		st.exclusive = true
	}

	if err := ac.GetBufferSize(&st.bufFrames); err != nil {
		return fail(fmt.Errorf("GetBufferSize: %w", err))
	}
	if err := ac.GetService(wca.IID_IAudioRenderClient, &st.arc); err != nil {
		return fail(fmt.Errorf("GetService IAudioRenderClient: %w", err))
	}
	releases = append(releases, func() { st.arc.Release() })
	st.ac = ac
	return st, release, nil
}

// renderLoop opens the stream, reports the outcome on ready, and then feeds
// the device until Close.
func (a *AudioOutput) renderLoop(deviceID string, bufferDuration time.Duration, ready chan<- error) {
	defer close(a.doneCh)

	// COM is per OS thread, and a goroutine is not: pin this one so the
	// CoInitializeEx, every call on the stream and the CoUninitialize all
	// happen on the same thread.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	if uninit := coInit(); uninit {
		defer ole.CoUninitialize()
	}

	st, release, err := openStream(deviceID, a.srcRate, a.srcCh, bufferDuration)
	if err != nil {
		log.Printf("WASAPI: %v", err)
		ready <- err
		return
	}
	defer release()
	if err := st.ac.Start(); err != nil {
		ready <- fmt.Errorf("WASAPI Start: %w", err)
		return
	}
	defer st.ac.Stop()

	mode := "shared, converted by Windows to " + formatKHz(st.mixRate)
	if st.exclusive {
		mode = "exclusive"
	}
	log.Printf("WASAPI: %s x%d -> %s %s x%d, buffer %d frames",
		formatKHz(a.srcRate), a.srcCh, mode, st.kind, st.channels, st.bufFrames)
	a.exclusive = st.exclusive
	ready <- nil

	srcFrame := a.srcCh * 2
	devFrame := st.channels * st.kind.bytes()
	// pending holds source bytes taken from the ring but not yet written: a
	// chunk rarely matches the room the device has.
	var pending []byte

	ticker := time.NewTicker(bufferDuration / 2)
	defer ticker.Stop()

	for {
		select {
		case <-a.stopCh:
			return
		case <-ticker.C:
		}

		var padding uint32
		if err := st.ac.GetCurrentPadding(&padding); err != nil {
			log.Printf("WASAPI: GetCurrentPadding: %v", err)
			return
		}
		room := int(st.bufFrames - padding)
		if room == 0 {
			continue
		}
		for len(pending)/srcFrame < room {
			chunk, ok := a.reader.pop()
			if !ok {
				break
			}
			pending = append(pending, chunk...)
		}
		// Only what has arrived is written. Padding a late chunk's slot with
		// silence would sit in the buffer and add to the latency for good;
		// a device that truly runs dry glitches once and carries on.
		n := len(pending) / srcFrame
		if n > room {
			n = room
		}
		if n == 0 {
			continue
		}

		var pData *byte
		if err := st.arc.GetBuffer(uint32(n), &pData); err != nil {
			log.Printf("WASAPI: GetBuffer: %v", err)
			return
		}
		a.mu.Lock()
		vol, chMode := a.volume, a.channelMode
		a.mu.Unlock()
		encodeFrames(unsafe.Slice(pData, n*devFrame), pending[:n*srcFrame], a.srcCh, st.channels, st.kind, vol, chMode)
		if err := st.arc.ReleaseBuffer(uint32(n), 0); err != nil {
			log.Printf("WASAPI: ReleaseBuffer: %v", err)
			return
		}
		pending = append(pending[:0], pending[n*srcFrame:]...)
	}
}

// Push queues PCM audio data (little-endian int16) for playback, along with
// the signal-quality metadata for that chunk.
func (a *AudioOutput) Push(pcmLE []byte, meta ChunkMeta) {
	// Snapshot queue depth BEFORE pushing so we know how many chunks are
	// ahead of this one.
	queued := a.reader.Queued()

	cp := make([]byte, len(pcmLE))
	copy(cp, pcmLE)
	a.reader.Push(cp)

	// Delay the callback by the time it will take for this chunk to reach
	// the hardware: (chunks ahead × 20 ms) + hardware buffer.
	a.mu.Lock()
	fn := a.onChunkPlayed
	a.mu.Unlock()
	if fn != nil {
		delay := time.Duration(queued)*chunkDuration + hardwareBufferDuration
		FireAfterDelay(delay, func() { fn(meta) })
	}
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

// SetChannelMode sets which output channels receive audio (ChannelModeBoth/Left/Right).
func (a *AudioOutput) SetChannelMode(mode int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.channelMode = mode
}

// Close stops playback and releases resources.
// Uses a timeout so a stuck renderLoop doesn't block the caller forever.
func (a *AudioOutput) Close() {
	a.closeOnce.Do(func() {
		close(a.stopCh)
		select {
		case <-a.doneCh:
		case <-time.After(2 * time.Second):
			log.Printf("WASAPI: Close timed out waiting for renderLoop")
		}
		a.reader.Close()
	})
}

// outputPathWarning says when the stream holds the device exclusively. Nothing
// is lost — that is why it does — but every other program on the device goes
// silent until the mode or device changes, which is worth saying.
func outputPathWarning(out *AudioOutput, deviceID string, rate int) string {
	if out == nil || !out.exclusive {
		return ""
	}
	return fmt.Sprintf("Playing the %s stream in exclusive mode, so no other program can use this device "+
		"until you change mode or device.", formatKHz(rate))
}

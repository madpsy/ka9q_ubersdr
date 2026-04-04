//go:build windows

package main

// audio_output_windows.go — WASAPI audio output with device selection.
//
// Strategy: always use the device's native mix format (GetMixFormat) and
// convert our int16 PCM stream to float32 on the fly.  This avoids the
// WAVEFORMATEXTENSIBLE negotiation that causes Initialize to fail when the
// device is in float32 shared mode (which is the default on most Windows
// systems).
//
// COM is initialised as COINIT_MULTITHREADED in every goroutine that touches
// WASAPI objects.  Apartment-threaded mode requires a Windows message pump
// which Go goroutines do not provide.

import (
	"encoding/binary"
	"fmt"
	"log"
	"sync"
	"time"
	"unsafe"

	"github.com/go-ole/go-ole"
	"github.com/moutend/go-wca/pkg/wca"
)

// AudioOutput manages WASAPI audio playback to a specific device.
type AudioOutput struct {
	reader      *pcmRingReader
	volume      float64
	channelMode int // ChannelModeBoth / Left / Right
	srcRate     int
	srcCh       int
	stopCh      chan struct{}
	doneCh      chan struct{}
	mu          sync.Mutex
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

// NewAudioOutput creates a WASAPI audio output for the given device.
// deviceID="" uses the system default device.
func NewAudioOutput(sampleRate, channels int, bufferDuration time.Duration, deviceID string) (*AudioOutput, error) {
	reader := newPCMRingReader(128)

	out := &AudioOutput{
		reader:  reader,
		volume:  1.0,
		srcRate: sampleRate,
		srcCh:   channels,
		stopCh:  make(chan struct{}),
		doneCh:  make(chan struct{}),
	}

	go out.renderLoop(deviceID, bufferDuration)

	return out, nil
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

// renderLoop runs in its own goroutine and feeds PCM to WASAPI.
func (a *AudioOutput) renderLoop(deviceID string, bufferDuration time.Duration) {
	defer close(a.doneCh)

	if uninit := coInit(); uninit {
		defer ole.CoUninitialize()
	}

	var mmde *wca.IMMDeviceEnumerator
	if err := wca.CoCreateInstance(
		wca.CLSID_MMDeviceEnumerator, 0,
		wca.CLSCTX_ALL, wca.IID_IMMDeviceEnumerator,
		&mmde,
	); err != nil {
		log.Printf("WASAPI: CoCreateInstance IMMDeviceEnumerator: %v", err)
		return
	}
	defer mmde.Release()

	mmd, err := getDevice(mmde, deviceID)
	if err != nil {
		log.Printf("WASAPI: getDevice: %v", err)
		return
	}
	defer mmd.Release()

	var ac *wca.IAudioClient
	if err := mmd.Activate(wca.IID_IAudioClient, wca.CLSCTX_ALL, nil, &ac); err != nil {
		log.Printf("WASAPI: Activate IAudioClient: %v", err)
		return
	}
	defer ac.Release()

	// Always use the device's native mix format.
	// Most Windows devices use float32 at 44100 or 48000 Hz.
	var mixFmt *wca.WAVEFORMATEX
	if err := ac.GetMixFormat(&mixFmt); err != nil {
		log.Printf("WASAPI: GetMixFormat: %v", err)
		return
	}
	log.Printf("WASAPI: mix format: %d ch, %d Hz, %d bits/sample, tag=%d",
		mixFmt.NChannels, mixFmt.NSamplesPerSec, mixFmt.WBitsPerSample, mixFmt.WFormatTag)

	bufRT := wca.REFERENCE_TIME(bufferDuration.Nanoseconds() / 100)

	if err := ac.Initialize(
		wca.AUDCLNT_SHAREMODE_SHARED,
		0,
		bufRT,
		0,
		mixFmt,
		nil,
	); err != nil {
		log.Printf("WASAPI: Initialize: %v", err)
		return
	}

	var bufFrames uint32
	if err := ac.GetBufferSize(&bufFrames); err != nil {
		log.Printf("WASAPI: GetBufferSize: %v", err)
		return
	}
	log.Printf("WASAPI: buffer frames=%d", bufFrames)

	var arc *wca.IAudioRenderClient
	if err := ac.GetService(wca.IID_IAudioRenderClient, &arc); err != nil {
		log.Printf("WASAPI: GetService IAudioRenderClient: %v", err)
		return
	}
	defer arc.Release()

	if err := ac.Start(); err != nil {
		log.Printf("WASAPI: Start: %v", err)
		return
	}
	defer ac.Stop()

	log.Printf("WASAPI: render loop started (src %d Hz %dch → dev %d Hz %dch)",
		a.srcRate, a.srcCh, mixFmt.NSamplesPerSec, mixFmt.NChannels)

	devChannels := int(mixFmt.NChannels)
	devRate := int(mixFmt.NSamplesPerSec)
	isFloat := mixFmt.WFormatTag == 3 // WAVE_FORMAT_IEEE_FLOAT = 3
	// Also check for WAVEFORMATEXTENSIBLE (tag=0xFFFE) — treat as float32
	// since that's what Windows uses for its mix format.
	if mixFmt.WFormatTag == 0xFFFE {
		isFloat = true
	}

	ticker := time.NewTicker(bufferDuration / 2)
	defer ticker.Stop()

	for {
		select {
		case <-a.stopCh:
			log.Printf("WASAPI: render loop stopped")
			return
		case <-ticker.C:
		}

		var padding uint32
		if err := ac.GetCurrentPadding(&padding); err != nil {
			log.Printf("WASAPI: GetCurrentPadding: %v", err)
			return
		}
		available := bufFrames - padding
		if available == 0 {
			continue
		}

		var pData *byte
		if err := arc.GetBuffer(available, &pData); err != nil {
			log.Printf("WASAPI: GetBuffer: %v", err)
			return
		}

		a.mu.Lock()
		vol := a.volume
		chMode := a.channelMode
		a.mu.Unlock()

		// How many source frames do we need?
		// If device rate != source rate, we need to resample.
		// Simple nearest-neighbour resampling for now.
		srcFramesNeeded := int(available)
		if devRate != a.srcRate && a.srcRate > 0 {
			srcFramesNeeded = int(float64(available) * float64(a.srcRate) / float64(devRate))
			if srcFramesNeeded < 1 {
				srcFramesNeeded = 1
			}
		}

		srcBytes := srcFramesNeeded * a.srcCh * 2
		srcBuf := make([]byte, srcBytes)
		_, _ = a.reader.Read(srcBuf)

		// Convert source int16 frames → device format
		if isFloat {
			// float32 output
			devSamples := int(available) * devChannels
			dstF := unsafe.Slice((*float32)(unsafe.Pointer(pData)), devSamples)
			for devFrame := 0; devFrame < int(available); devFrame++ {
				// Map device frame → source frame (nearest neighbour)
				srcFrame := devFrame
				if devRate != a.srcRate && a.srcRate > 0 {
					srcFrame = int(float64(devFrame) * float64(a.srcRate) / float64(devRate))
				}
				if srcFrame >= srcFramesNeeded {
					srcFrame = srcFramesNeeded - 1
				}
				for ch := 0; ch < devChannels; ch++ {
					mute := (chMode == ChannelModeLeft && ch != 0) ||
						(chMode == ChannelModeRight && ch != 1)
					var f float32
					if !mute {
						srcCh := ch
						if srcCh >= a.srcCh {
							srcCh = a.srcCh - 1
						}
						byteIdx := (srcFrame*a.srcCh + srcCh) * 2
						var s int16
						if byteIdx+1 < len(srcBuf) {
							s = int16(binary.LittleEndian.Uint16(srcBuf[byteIdx:]))
						}
						f = float32(s) / 32768.0
						if vol != 1.0 {
							f *= float32(vol)
						}
					}
					dstF[devFrame*devChannels+ch] = f
				}
			}
		} else {
			// int16 output
			devFrameSize := devChannels * 2
			devBytes := int(available) * devFrameSize
			dst := unsafe.Slice(pData, devBytes)
			for devFrame := 0; devFrame < int(available); devFrame++ {
				srcFrame := devFrame
				if devRate != a.srcRate && a.srcRate > 0 {
					srcFrame = int(float64(devFrame) * float64(a.srcRate) / float64(devRate))
				}
				if srcFrame >= srcFramesNeeded {
					srcFrame = srcFramesNeeded - 1
				}
				for ch := 0; ch < devChannels; ch++ {
					mute := (chMode == ChannelModeLeft && ch != 0) ||
						(chMode == ChannelModeRight && ch != 1)
					var s int16
					if !mute {
						srcCh := ch
						if srcCh >= a.srcCh {
							srcCh = a.srcCh - 1
						}
						byteIdx := (srcFrame*a.srcCh + srcCh) * 2
						if byteIdx+1 < len(srcBuf) {
							s = int16(binary.LittleEndian.Uint16(srcBuf[byteIdx:]))
						}
						if vol != 1.0 {
							s = int16(float64(s) * vol)
						}
					}
					dstOff := (devFrame*devChannels + ch) * 2
					binary.LittleEndian.PutUint16(dst[dstOff:], uint16(s))
				}
			}
		}

		if err := arc.ReleaseBuffer(available, 0); err != nil {
			log.Printf("WASAPI: ReleaseBuffer: %v", err)
			return
		}
	}
}

// Push queues PCM audio data (little-endian int16) for playback.
func (a *AudioOutput) Push(pcmLE []byte) {
	cp := make([]byte, len(pcmLE))
	copy(cp, pcmLE)
	a.reader.Push(cp)
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
	select {
	case <-a.stopCh:
		// already closed
	default:
		close(a.stopCh)
	}
	// Wait for renderLoop to exit, but don't block forever
	select {
	case <-a.doneCh:
	case <-time.After(2 * time.Second):
		log.Printf("WASAPI: Close timed out waiting for renderLoop")
	}
	a.reader.Close()
}

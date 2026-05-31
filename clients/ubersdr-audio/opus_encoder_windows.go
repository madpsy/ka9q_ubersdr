//go:build windows

package main

// opus_encoder_windows.go — Opus encoder for Windows using the embedded opus.dll.
// The DLL is extracted once by extractOpusDLL() (defined in opus_decoder_windows.go).

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// opusEncoder wraps the libopus C encoder loaded from the embedded DLL.
type opusEncoder struct {
	dll        *windows.DLL
	procCreate *windows.Proc
	procEncode *windows.Proc
	procCtl    *windows.Proc
	procDestry *windows.Proc
	enc        uintptr // OpusEncoder*
	sampleRate int
	channels   int
}

// newOpusEncoder loads opus.dll and creates an OpusEncoder.
func newOpusEncoder(sampleRate, channels int) (*opusEncoder, error) {
	dllPath, err := extractOpusDLL()
	if err != nil {
		return nil, err
	}

	dll, err := windows.LoadDLL(dllPath)
	if err != nil {
		return nil, fmt.Errorf("loading opus.dll: %w", err)
	}

	create, err := dll.FindProc("opus_encoder_create")
	if err != nil {
		dll.Release()
		return nil, fmt.Errorf("opus_encoder_create not found: %w", err)
	}
	encode, err := dll.FindProc("opus_encode")
	if err != nil {
		dll.Release()
		return nil, fmt.Errorf("opus_encode not found: %w", err)
	}
	ctl, err := dll.FindProc("opus_encoder_ctl")
	if err != nil {
		dll.Release()
		return nil, fmt.Errorf("opus_encoder_ctl not found: %w", err)
	}
	destroy, err := dll.FindProc("opus_encoder_destroy")
	if err != nil {
		dll.Release()
		return nil, fmt.Errorf("opus_encoder_destroy not found: %w", err)
	}

	// OPUS_APPLICATION_AUDIO = 2049
	const opusApplicationAudio = 2049
	var opusErr int32
	enc, _, _ := create.Call(
		uintptr(sampleRate),
		uintptr(channels),
		uintptr(opusApplicationAudio),
		uintptr(unsafe.Pointer(&opusErr)),
	)
	if enc == 0 || opusErr != 0 {
		dll.Release()
		return nil, fmt.Errorf("opus_encoder_create failed: error code %d", opusErr)
	}

	// OPUS_SET_BITRATE_REQUEST = 4002; set 32 kbps.
	const opusSetBitrateRequest = 4002
	ctl.Call(enc, uintptr(opusSetBitrateRequest), uintptr(32000)) //nolint:errcheck

	return &opusEncoder{
		dll:        dll,
		procCreate: create,
		procEncode: encode,
		procCtl:    ctl,
		procDestry: destroy,
		enc:        enc,
		sampleRate: sampleRate,
		channels:   channels,
	}, nil
}

// encode encodes one frame of int16 PCM samples to an Opus packet.
func (e *opusEncoder) encode(samples []int16) ([]byte, error) {
	if len(samples) == 0 {
		return nil, nil
	}
	samplesPerChannel := len(samples) / e.channels
	out := make([]byte, 4000)

	// opus_encode(OpusEncoder *st, const opus_int16 *pcm, int frame_size,
	//             unsigned char *data, opus_int32 max_data_bytes) -> opus_int32
	n, _, _ := e.procEncode.Call(
		e.enc,
		uintptr(unsafe.Pointer(&samples[0])),
		uintptr(samplesPerChannel),
		uintptr(unsafe.Pointer(&out[0])),
		uintptr(len(out)),
	)
	written := int(int32(n))
	if written < 0 {
		return nil, fmt.Errorf("opus_encode error: %d", written)
	}
	return out[:written], nil
}

// header returns the OpusHead identification header bytes.
func (e *opusEncoder) header() []byte {
	return buildOpusHead(e.channels, e.sampleRate)
}

// commentHeader returns the OpusTags comment header bytes.
func (e *opusEncoder) commentHeader() []byte {
	return buildOpusTags()
}

// close destroys the encoder and releases the DLL.
func (e *opusEncoder) close() {
	if e.enc != 0 {
		e.procDestry.Call(e.enc)
		e.enc = 0
	}
	if e.dll != nil {
		e.dll.Release()
		e.dll = nil
	}
}

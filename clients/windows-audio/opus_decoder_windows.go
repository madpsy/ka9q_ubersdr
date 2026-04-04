//go:build windows

package main

import (
	_ "embed"
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

//go:embed opus.dll
var opusDLLBytes []byte

// opusDLLPath is the path to the extracted DLL (written once on first use).
var (
	opusDLLOnce sync.Once
	opusDLLPath string
	opusDLLErr  error
)

// extractOpusDLL writes the embedded opus.dll to a per-process temp file once
// and returns its path. Using the PID in the filename prevents write conflicts
// when multiple instances of the program run simultaneously — Windows holds a
// file lock on loaded DLLs, so a fixed shared path causes the second instance's
// os.WriteFile to fail with a sharing violation.
func extractOpusDLL() (string, error) {
	opusDLLOnce.Do(func() {
		tmp := filepath.Join(os.TempDir(), fmt.Sprintf("ubersdr_opus_%d.dll", os.Getpid()))
		if err := os.WriteFile(tmp, opusDLLBytes, 0600); err != nil {
			opusDLLErr = fmt.Errorf("extracting opus.dll: %w", err)
			return
		}
		opusDLLPath = tmp
	})
	return opusDLLPath, opusDLLErr
}

// cleanupOpusDLL removes the per-process DLL temp file. Call this at program exit.
func cleanupOpusDLL() {
	if opusDLLPath != "" {
		os.Remove(opusDLLPath)
	}
}

// opusDecoder wraps the libopus C decoder loaded from the embedded DLL.
type opusDecoder struct {
	dll        *windows.DLL
	procCreate *windows.Proc
	procDecode *windows.Proc
	procDestry *windows.Proc
	dec        uintptr // OpusDecoder*
	sampleRate int
	channels   int
}

// newOpusDecoder loads opus.dll (extracting it from the embedded bytes if needed)
// and creates an OpusDecoder for the given sample rate and channel count.
func newOpusDecoder(sampleRate, channels int) (*opusDecoder, error) {
	dllPath, err := extractOpusDLL()
	if err != nil {
		return nil, err
	}

	dll, err := windows.LoadDLL(dllPath)
	if err != nil {
		return nil, fmt.Errorf("loading opus.dll: %w", err)
	}

	create, err := dll.FindProc("opus_decoder_create")
	if err != nil {
		dll.Release()
		return nil, fmt.Errorf("opus_decoder_create not found: %w", err)
	}
	decode, err := dll.FindProc("opus_decode")
	if err != nil {
		dll.Release()
		return nil, fmt.Errorf("opus_decode not found: %w", err)
	}
	destroy, err := dll.FindProc("opus_decoder_destroy")
	if err != nil {
		dll.Release()
		return nil, fmt.Errorf("opus_decoder_destroy not found: %w", err)
	}

	// opus_decoder_create(opus_int32 Fs, int channels, int *error) -> OpusDecoder*
	var opusErr int32
	dec, _, _ := create.Call(
		uintptr(sampleRate),
		uintptr(channels),
		uintptr(unsafe.Pointer(&opusErr)),
	)
	if dec == 0 || opusErr != 0 {
		dll.Release()
		return nil, fmt.Errorf("opus_decoder_create failed: error code %d", opusErr)
	}

	return &opusDecoder{
		dll:        dll,
		procCreate: create,
		procDecode: decode,
		procDestry: destroy,
		dec:        dec,
		sampleRate: sampleRate,
		channels:   channels,
	}, nil
}

// maxOpusFrameSamples is the maximum number of samples per channel per Opus frame
// (120 ms at 48 kHz = 5760 samples).
const maxOpusFrameSamples = 5760

// Decode decodes a single Opus packet and returns int16 LE PCM bytes.
func (d *opusDecoder) Decode(packet []byte) ([]byte, error) {
	// Allocate output buffer: maxFrameSamples * channels * 2 bytes per int16
	pcm := make([]int16, maxOpusFrameSamples*d.channels)

	var dataPtr uintptr
	var dataLen uintptr
	if len(packet) > 0 {
		dataPtr = uintptr(unsafe.Pointer(&packet[0]))
		dataLen = uintptr(len(packet))
	}

	// opus_decode(OpusDecoder *st, const unsigned char *data, opus_int32 len,
	//             opus_int16 *pcm, int frame_size, int decode_fec) -> int (samples per channel)
	n, _, _ := d.procDecode.Call(
		d.dec,
		dataPtr,
		dataLen,
		uintptr(unsafe.Pointer(&pcm[0])),
		uintptr(maxOpusFrameSamples),
		0, // no FEC
	)
	samplesPerChannel := int(int32(n)) // opus returns negative on error
	if samplesPerChannel <= 0 {
		return nil, fmt.Errorf("opus_decode error: %d", samplesPerChannel)
	}

	totalSamples := samplesPerChannel * d.channels
	out := make([]byte, totalSamples*2)
	for i := 0; i < totalSamples; i++ {
		binary.LittleEndian.PutUint16(out[i*2:], uint16(pcm[i]))
	}
	return out, nil
}

// Close destroys the decoder and releases the DLL.
func (d *opusDecoder) Close() {
	if d.dec != 0 {
		d.procDestry.Call(d.dec)
		d.dec = 0
	}
	if d.dll != nil {
		d.dll.Release()
		d.dll = nil
	}
}

// decodeOpusFrame parses the server's v2 Opus binary frame and returns
// PCM bytes, sampleRate, channels, basebandPower, noiseDensity.
//
// Frame layout (v2):
//
//	[0:8]   uint64 LE  GPS timestamp (ignored)
//	[8:12]  uint32 LE  sample rate
//	[12]    uint8      channels
//	[13:17] float32 LE baseband power
//	[17:21] float32 LE noise density
//	[21:]   bytes      raw Opus packet
func decodeOpusFrame(data []byte, dec **opusDecoder) (pcm []byte, sampleRate, channels int, basebandPower, noiseDensity float32, err error) {
	const headerV2 = 21
	if len(data) < headerV2+1 {
		err = fmt.Errorf("opus frame too short: %d bytes", len(data))
		return
	}

	sampleRate = int(binary.LittleEndian.Uint32(data[8:12]))
	channels = int(data[12])
	basebandPower = math.Float32frombits(binary.LittleEndian.Uint32(data[13:17]))
	noiseDensity = math.Float32frombits(binary.LittleEndian.Uint32(data[17:21]))
	opusPacket := data[headerV2:]

	// (Re)create decoder if sample rate or channel count changed.
	if *dec == nil || (*dec).sampleRate != sampleRate || (*dec).channels != channels {
		if *dec != nil {
			(*dec).Close()
			*dec = nil
		}
		*dec, err = newOpusDecoder(sampleRate, channels)
		if err != nil {
			return
		}
	}

	pcm, err = (*dec).Decode(opusPacket)
	return
}

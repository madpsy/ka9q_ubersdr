package main

import "fmt"

// Opus binary frame framing, shared by every platform.
//
// The libopus binding differs per platform -- CGo on Linux, a loaded DLL on
// Windows, a stub elsewhere -- but the frame around the Opus packet does not,
// so it is parsed here once. Keeping it out of the platform files also means
// the version 4 header is not something three builds have to agree about
// separately.
//
// The header is PCMv4HeaderDecoder.DecodeOpus: a flags byte, then only the
// fields that changed since the last frame -- typically about four bytes,
// against the fixed 21 that versions 2 and 3 spent. At 50 frames a second that
// saves roughly 0.84 kB/s, which is between 12% and 19% of an Opus stream, the
// frames being small enough that the old header was a sixth of one.
//
// Being variable-length, where the Opus packet starts has to be PARSED rather
// than assumed. Slicing at a fixed offset would feed the decoder metadata as
// though it were audio.

// opusWireFrame is one binary frame with its header parsed off: the Opus packet
// and the stream parameters that describe it.
type opusWireFrame struct {
	// opus is a copy, not a view into the WebSocket read buffer, because the
	// frame is handed to the decode worker and that buffer is reused as soon as
	// the receive goroutine loops.
	opus []byte

	sampleRate    int
	channels      int
	basebandPower float32
	noise         float32
}

// parseOpusFrame reads the header off a binary Opus frame.
//
// v4 is the header decoder for this connection's Opus stream. It must be an
// instance of its own: the headers are change-tracked, and the server tracks
// the Opus and lossless streams separately, so sharing one decoder between them
// would apply one stream's deltas to the other's baseline.
//
// Parsing happens on the receive goroutine rather than in the decode worker
// precisely because it is stateful. A frame dropped for a full worker queue
// must still have had its header read, or the next delta has nothing to be a
// delta from.
func parseOpusFrame(data []byte, v4 *PCMv4HeaderDecoder) (opusWireFrame, error) {
	var f opusWireFrame

	h, off, err := v4.DecodeOpus(data)
	if err != nil {
		return f, err
	}
	if off >= len(data) {
		return f, fmt.Errorf("opus frame: header consumed all %d bytes", len(data))
	}
	f.sampleRate = h.SampleRate
	f.channels = h.Channels
	f.basebandPower = h.BasebandPower
	f.noise = h.Noise
	f.opus = append([]byte(nil), data[off:]...)
	return f, nil
}

// decodeOpusFrame decodes a parsed frame to little-endian int16 PCM, creating
// or recreating the decoder when the sample rate or channel count changes.
func decodeOpusFrame(f opusWireFrame, dec **opusDecoder) ([]byte, error) {
	if f.sampleRate <= 0 || f.channels <= 0 {
		return nil, fmt.Errorf("opus frame: implausible metadata (rate %d, channels %d)", f.sampleRate, f.channels)
	}

	if *dec == nil || (*dec).sampleRate != f.sampleRate || (*dec).channels != f.channels {
		if *dec != nil {
			(*dec).Close()
			*dec = nil
		}
		d, err := newOpusDecoder(f.sampleRate, f.channels)
		if err != nil {
			return nil, err
		}
		*dec = d
	}

	return (*dec).Decode(f.opus)
}

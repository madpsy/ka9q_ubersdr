package drm

import (
	"encoding/binary"
	"os"
	"testing"
	"time"
)

// TestDRMEndToEnd feeds a recorded DRM IQ capture through the real
// /opt/ubersdr-drm/ubersdr-drm subprocess and checks that the extension emits
// Opus frames on the wire protocol. Skipped if the binary or capture is absent.
func TestDRMEndToEnd(t *testing.T) {
	iqPath := os.Getenv("DRM_TEST_IQ")
	if iqPath == "" {
		t.Skip("DRM_TEST_IQ not set")
	}
	if _, err := os.Stat(binaryPath); err != nil {
		t.Skipf("%s not installed", binaryPath)
	}
	raw, err := os.ReadFile(iqPath)
	if err != nil {
		t.Fatalf("read %s: %v", iqPath, err)
	}

	rate := 48000
	if r := os.Getenv("DRM_TEST_RATE"); r != "" {
		if _, err := fmtSscan(r, &rate); err != nil {
			t.Fatalf("bad DRM_TEST_RATE: %v", err)
		}
	}

	ext, err := NewDRMExtension(
		AudioExtensionParams{SampleRate: rate, Channels: 2, BitsPerSample: 16},
		nil,
	)
	if err != nil {
		t.Fatalf("NewDRMExtension: %v", err)
	}

	audioChan := make(chan AudioSample, 64)
	resultChan := make(chan []byte, 4096)
	if err := ext.Start(audioChan, resultChan); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer ext.Stop()

	// Feed the capture in 20 ms chunks at real time, as a live session would.
	chunk := rate / 50 * 2 // stereo int16 samples per 20 ms
	go func() {
		defer close(audioChan)
		samples := make([]int16, len(raw)/2)
		for i := range samples {
			samples[i] = int16(binary.LittleEndian.Uint16(raw[i*2:]))
		}
		tick := time.NewTicker(20 * time.Millisecond)
		defer tick.Stop()
		for off := 0; off+chunk <= len(samples); off += chunk {
			<-tick.C
			audioChan <- AudioSample{PCMData: samples[off : off+chunk]}
		}
	}()

	var frames, bytesOut int
	deadline := time.After(45 * time.Second)
collect:
	for {
		select {
		case pkt := <-resultChan:
			if len(pkt) < 14 {
				t.Fatalf("short packet: %d bytes", len(pkt))
			}
			if pkt[0] != MessageTypeOpusFrame {
				t.Fatalf("unexpected message type 0x%02x", pkt[0])
			}
			if sr := binary.BigEndian.Uint32(pkt[9:13]); sr != outputSampleRate {
				t.Fatalf("sample rate %d, want %d", sr, outputSampleRate)
			}
			if pkt[13] != 1 {
				t.Fatalf("channels %d, want 1", pkt[13])
			}
			frames++
			bytesOut += len(pkt) - 14
			if frames >= 500 {
				break collect
			}
		case <-deadline:
			break collect
		}
	}

	t.Logf("received %d Opus frames, %d payload bytes (avg %d B/frame)",
		frames, bytesOut, safeDiv(bytesOut, frames))
	if frames < 200 {
		t.Fatalf("only %d Opus frames in 45s — expected a continuous stream", frames)
	}
	if avg := safeDiv(bytesOut, frames); avg < 10 {
		t.Fatalf("average Opus frame %d bytes — output looks like silence", avg)
	}
}

func safeDiv(a, b int) int {
	if b == 0 {
		return 0
	}
	return a / b
}

func fmtSscan(s string, v *int) (int, error) {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, os.ErrInvalid
		}
		n = n*10 + int(c-'0')
	}
	*v = n
	return 1, nil
}

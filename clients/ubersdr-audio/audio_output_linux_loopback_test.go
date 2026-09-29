//go:build linux

package main

import (
	"bytes"
	"encoding/binary"
	"os"
	"os/exec"
	"strconv"
	"testing"
	"time"
)

// TestALSALoopbackIsBitExact plays a counting pattern through NewAudioOutput
// into an snd-aloop loopback and records the other end. What comes back must be
// the pattern itself, frame for frame, at the rate it was sent: any resampling
// — the old oto path's nearest-neighbour, or a sound server's filter — breaks
// the count, and a device that ran at another rate would refuse the capture,
// since a loopback's two ends must agree on the rate.
//
// Skipped unless the snd-aloop module is loaded:
//
//	sudo modprobe snd-aloop
func TestALSALoopbackIsBitExact(t *testing.T) {
	if _, err := os.Stat("/proc/asound/Loopback"); err != nil {
		t.Skip("no ALSA loopback card; load it with: sudo modprobe snd-aloop")
	}
	if _, err := exec.LookPath("arecord"); err != nil {
		t.Skip("arecord not available")
	}

	for _, tc := range []struct {
		name     string
		rate, ch int
	}{
		{"usb", 12000, 1},
		{"am", 24000, 1},
		{"iq", 12000, 2},
		{"iq48", 48000, 2},
		{"iq96", 96000, 2},
		{"iq192", 192000, 2},
		{"iq384", 384000, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			checkLoopback(t, tc.rate, tc.ch)
		})
	}
}

func checkLoopback(t *testing.T, rate, ch int) {
	out, err := NewAudioOutput(rate, ch, 40*time.Millisecond, alsaDevicePrefix+"hw:Loopback,0,0")
	if err != nil {
		// snd-aloop stops at 192 kHz on current kernels. Refusing is the
		// right answer — aplay, told 384 kHz, quietly runs it at 192 — but it
		// leaves nothing here to capture.
		t.Skipf("the loopback cannot run at %d Hz, and the output refused it rather than narrowing: %v", rate, err)
	}
	defer out.Close()

	// Frame k carries k in the first channel and ^k in the second, so both
	// the count and the channel mapping are checked. Zero is skipped: it is
	// what the output plays while the ring is empty.
	next := uint16(1)
	chunk := func() []byte {
		frames := rate / 50 // 20 ms, as the server sends
		b := make([]byte, frames*ch*2)
		for f := 0; f < frames; f++ {
			if next == 0 {
				next = 1
			}
			binary.LittleEndian.PutUint16(b[(f*ch)*2:], next)
			if ch == 2 {
				binary.LittleEndian.PutUint16(b[(f*ch+1)*2:], ^next)
			}
			next++
		}
		return b
	}

	stop := make(chan struct{})
	defer close(stop)
	for i := 0; i < 5; i++ { // 100 ms ahead, so the device never waits on us
		out.Push(chunk(), ChunkMeta{})
	}
	go func() {
		tick := time.NewTicker(20 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tick.C:
				out.Push(chunk(), ChunkMeta{})
			}
		}
	}()

	// The output always opens two channels (mono is widened so L and R can be
	// muted apart), so the capture is stereo either way.
	frames := rate / 2
	cmd := exec.Command("arecord", "-q", "-D", "hw:Loopback,1,0", "-t", "raw",
		"-f", "S16_LE", "-c", "2", "-r", strconv.Itoa(rate), "-s", strconv.Itoa(frames))
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	raw, err := cmd.Output()
	if err != nil {
		t.Fatalf("arecord at %d Hz: %v: %s", rate, err, stderr.String())
	}
	if got := len(raw) / 4; got != frames {
		t.Fatalf("captured %d frames, want %d", got, frames)
	}

	var prev uint16
	checked, silent, lead := 0, 0, 0
	for f := 0; f < frames; f++ {
		l := binary.LittleEndian.Uint16(raw[f*4:])
		r := binary.LittleEndian.Uint16(raw[f*4+2:])
		if l == 0 && r == 0 {
			if checked == 0 {
				lead++
			} else {
				silent++
			}
			continue
		}
		wantR := ^l
		if ch == 1 {
			wantR = l // mono goes to both sides, unchanged
		}
		if r != wantR {
			t.Fatalf("frame %d: channels %d/%d, want %d/%d", f, l, r, l, wantR)
		}
		if prev != 0 && l != prev+1 && !(prev == 0xffff && l == 1) {
			t.Fatalf("frame %d: %d follows %d — samples were dropped, repeated or interpolated", f, l, prev)
		}
		prev = l
		checked++
	}
	t.Logf("%6d Hz x%d: %d frames exact, %d leading silence, %d silent after", rate, ch, checked, lead, silent)
	if silent > 0 {
		t.Errorf("%d silent frames inside the stream: the device ran dry", silent)
	}
}

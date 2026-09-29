//go:build windows

package main

import (
	"encoding/binary"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestWASAPIOpensEachRate opens the default device at every rate a mode
// produces and plays a moment of silence through each. Rates the mixer can
// carry must open in shared mode; faster ones must either hold the device
// exclusively or fail with a reason — never play narrowed.
//
// Touches a real device, so it is skipped unless UBERSDR_WASAPI_TEST is set.
// Build it anywhere with
//
//	GOOS=windows CGO_ENABLED=1 CC=x86_64-w64-mingw32-gcc go test -c -o wasapi.test.exe .
//
// and run wasapi.test.exe -test.v -test.run TestWASAPIOpensEachRate on Windows.
func TestWASAPIOpensEachRate(t *testing.T) {
	if os.Getenv("UBERSDR_WASAPI_TEST") == "" {
		t.Skip("set UBERSDR_WASAPI_TEST=1 to open the default audio device")
	}
	for _, tc := range []struct {
		mode     string
		rate, ch int
	}{
		{"usb", 12000, 1},
		{"am", 24000, 1},
		{"iq48", 48000, 2},
		{"iq96", 96000, 2},
		{"iq192", 192000, 2},
		{"iq384", 384000, 2},
	} {
		out, err := NewAudioOutput(tc.rate, tc.ch, 40*time.Millisecond, "")
		if err != nil {
			t.Logf("%-5s %6d Hz: refused: %v", tc.mode, tc.rate, err)
			if tc.rate <= 48000 {
				t.Errorf("%s: a %d Hz stream must open in shared mode on any mixer at 48 kHz or above", tc.mode, tc.rate)
			}
			continue
		}
		silence := make([]byte, tc.rate/50*tc.ch*2)
		for i := 0; i < 15; i++ { // 300 ms
			out.Push(silence, ChunkMeta{})
			time.Sleep(20 * time.Millisecond)
		}
		select {
		case <-out.DoneC():
			t.Errorf("%s: render loop died while playing", tc.mode)
		default:
		}
		t.Logf("%-5s %6d Hz: playing, exclusive=%v %s", tc.mode, tc.rate, out.exclusive, outputPathWarning(out, "", tc.rate))
		out.Close()
	}
}

// TestWASAPIPlaysPattern plays a counting pattern — frame k carries k on the
// left and ^k on the right — to the device whose name contains
// UBERSDR_WASAPI_DEVICE, at UBERSDR_WASAPI_RATE, for UBERSDR_WASAPI_SECONDS.
// Recording the other end (a loopback cable, or snd-aloop under Wine) and
// checking the count proves the samples arrive exactly, at the stream's rate.
//
// Skipped unless UBERSDR_WASAPI_DEVICE is set.
func TestWASAPIPlaysPattern(t *testing.T) {
	want := os.Getenv("UBERSDR_WASAPI_DEVICE")
	if want == "" {
		t.Skip("set UBERSDR_WASAPI_DEVICE to part of a device name")
	}
	rate, _ := strconv.Atoi(os.Getenv("UBERSDR_WASAPI_RATE"))
	if rate == 0 {
		rate = 192000
	}
	secs, _ := strconv.Atoi(os.Getenv("UBERSDR_WASAPI_SECONDS"))
	if secs == 0 {
		secs = 3
	}

	devices, err := EnumerateAudioDevices()
	if err != nil {
		t.Fatal(err)
	}
	id := ""
	for _, d := range devices {
		t.Logf("device %q", d.Name)
		if id == "" && d.ID != "" && strings.Contains(d.Name, want) {
			id = d.ID
		}
	}
	if id == "" {
		t.Fatalf("no device named like %q", want)
	}

	out, err := NewAudioOutput(rate, 2, 40*time.Millisecond, id)
	if err != nil {
		t.Fatalf("open at %d Hz: %v", rate, err)
	}
	defer out.Close()
	t.Logf("playing at %d Hz, exclusive=%v", rate, out.exclusive)

	next := uint16(1)
	chunk := func() []byte {
		b := make([]byte, rate/50*4)
		for f := 0; f < rate/50; f++ {
			if next == 0 {
				next = 1
			}
			binary.LittleEndian.PutUint16(b[f*4:], next)
			binary.LittleEndian.PutUint16(b[f*4+2:], ^next)
			next++
		}
		return b
	}
	for i := 0; i < 5; i++ {
		out.Push(chunk(), ChunkMeta{})
	}
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	for i := 0; i < secs*50; i++ {
		<-tick.C
		out.Push(chunk(), ChunkMeta{})
	}
	select {
	case <-out.DoneC():
		t.Fatal("render loop died while playing")
	default:
	}
}

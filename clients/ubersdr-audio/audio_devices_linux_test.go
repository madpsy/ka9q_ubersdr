//go:build linux

package main

import (
	"strings"
	"testing"
)

// Captured from a desktop with two HDA cards, a USB interface and snd-aloop.
const (
	testCards = ` 0 [Generic        ]: HDA-Intel - HD-Audio Generic
                      HD-Audio Generic at 0xfcbc8000 irq 90
 1 [Generic_1      ]: HDA-Intel - HD-Audio Generic
                      HD-Audio Generic at 0xfcbc0000 irq 91
 2 [UR24C          ]: USB-Audio - Steinberg UR24C
                      Yamaha Corporation Steinberg UR24C at usb-0000:05:00.3-2.1, high speed
 3 [Loopback       ]: Loopback - Loopback
                      Loopback 1
`
	testPCM = `00-03: HDMI 0 : HDMI 0 : playback 1
01-00: ALC256 Analog : ALC256 Analog : playback 1 : capture 1
02-00: USB Audio : USB Audio : playback 1 : capture 1
03-00: Loopback PCM : Loopback PCM : playback 8 : capture 8
04-00: Some Mic : Some Mic : capture 1
`
)

// Every playback device becomes a direct output, addressed by the card's id so
// the choice survives the cards being renumbered at the next boot. A
// capture-only device, or one on a card /proc/asound/cards does not list, is
// not an output.
func TestParseALSADevices(t *testing.T) {
	got := parseALSADevices(testCards, testPCM)
	want := []AudioDevice{
		{"alsa:plughw:CARD=Generic,DEV=3", "HD-Audio Generic: HDMI 0 (direct)"},
		{"alsa:plughw:CARD=Generic_1,DEV=0", "HD-Audio Generic: ALC256 Analog (direct)"},
		{"alsa:plughw:CARD=UR24C,DEV=0", "Steinberg UR24C: USB Audio (direct)"},
		{"alsa:plughw:CARD=Loopback,DEV=0", "Loopback: Loopback PCM (direct)"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d devices %v, want %d", len(got), got, len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("device %d: got %+v, want %+v", i, got[i], want[i])
		}
	}
}

// sinkInputs is `pactl list sink-inputs` trimmed to what matters, with our
// stream (pid 4242) on sink 53 at rate, and another program's on sink 60.
func sinkInputs(rate string) string {
	return `Sink Input #101
	Driver: PipeWire
	Sink: 60
	Sample Specification: float32le 2ch 44100Hz
	Properties:
		application.process.id = "999"
Sink Input #202
	Driver: PipeWire
	Sink: 53
	Sample Specification: s16le 2ch ` + rate + `Hz
	Properties:
		application.name = "ALSA plug-in [ubersdr-audio]"
		application.process.id = "4242"
`
}

const testSinks = "53\talsa_output.usb-Yamaha_Corporation_Steinberg_UR24C-00.analog-surround-40\tPipeWire\ts32le 4ch 48000Hz\tRUNNING\n" +
	"60\talsa_output.pci-0000_00_1f.3.analog-stereo\tPipeWire\ts32le 2ch 192000Hz\tRUNNING\n"

func TestSinkRateWarning(t *testing.T) {
	// iq384 into a 48 kHz sink: most of the span is gone, and the warning
	// says how much is left and where.
	msg := sinkRateWarning(sinkInputs("384000"), testSinks, 4242, 384000)
	for _, want := range []string{"384 kHz", "48 kHz", "±24 kHz", "Steinberg UR24C", "allowed-rates"} {
		if !strings.Contains(msg, want) {
			t.Errorf("warning %q does not mention %q", msg, want)
		}
	}

	// A sink at the stream's rate, or above it, loses nothing.
	if msg := sinkRateWarning(sinkInputs("48000"), testSinks, 4242, 48000); msg != "" {
		t.Errorf("iq48 into a 48 kHz sink: got %q, want no warning", msg)
	}
	if msg := sinkRateWarning(sinkInputs("12000"), testSinks, 4242, 12000); msg != "" {
		t.Errorf("USB into a 48 kHz sink: got %q, want no warning", msg)
	}

	// Not ours, or not yet listed at the new rate: nothing to say yet.
	if msg := sinkRateWarning(sinkInputs("384000"), testSinks, 1, 384000); msg != "" {
		t.Errorf("another process's stream: got %q, want no warning", msg)
	}
	if msg := sinkRateWarning(sinkInputs("12000"), testSinks, 4242, 384000); msg != "" {
		t.Errorf("stream still listed at its old rate: got %q, want no warning", msg)
	}
}

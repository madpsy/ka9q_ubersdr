//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestLiveALSAFollowsStreamRate walks a real receiver through the mode changes
// that used to break the output — USB first, which is what pinned the old oto
// context at 12 kHz, then the wide IQ modes, then back — and reads the rate our
// stream actually runs at from the sound server each time. Every one must be
// the mode's native rate: nothing may be resampled, and IQ least of all.
//
// Needs a PulseAudio/PipeWire session (pactl) and a receiver that offers the
// wide IQ modes. Skipped unless UBERSDR_TEST_SERVER is set, e.g.
//
//	UBERSDR_TEST_SERVER=https://m9psy-1.instance.ubersdr.org go test -run TestLiveALSAFollowsStreamRate -v
//
// The volume is zeroed: the stream is opened and paced for real, but silent.
func TestLiveALSAFollowsStreamRate(t *testing.T) {
	target := os.Getenv("UBERSDR_TEST_SERVER")
	if target == "" {
		t.Skip("set UBERSDR_TEST_SERVER to run the live ALSA rate test")
	}
	if _, err := exec.LookPath("pactl"); err != nil {
		t.Skip("pactl not available")
	}

	client := NewRadioClient()
	client.BaseURL = target
	client.Password = os.Getenv("UBERSDR_TEST_PASSWORD")
	client.Frequency = 14074000
	client.Mode = "usb"
	client.BandwidthLow = 50
	client.BandwidthHigh = 2700
	client.SetVolume(0)
	client.OnStateChange = func(st ConnectionState, msg string) {
		t.Logf("client %v %s", st, msg)
	}
	client.Connect()
	defer client.Disconnect()

	waitFor(t, 20*time.Second, "connect", func() bool { return client.State() == StateConnected })

	steps := []struct {
		mode string
		rate int
		ch   int
	}{
		{"usb", 12000, 1},
		{"iq384", 384000, 2},
		{"iq96", 96000, 2},
		{"iq192", 192000, 2},
		{"usb", 12000, 1},
	}
	prev := ""
	for _, st := range steps {
		if prev != "" {
			client.Mode = st.mode
			if isWideIQMode(st.mode) {
				client.BandwidthLow, client.BandwidthHigh = 0, 0
			} else {
				client.BandwidthLow, client.BandwidthHigh = 50, 2700
			}
			if isIQMode(st.mode) || isIQMode(prev) {
				client.ReconnectWS()
			} else if err := client.Tune(client.Frequency, st.mode, client.BandwidthLow, client.BandwidthHigh); err != nil {
				t.Fatalf("tune %s: %v", st.mode, err)
			}
		}
		prev = st.mode

		waitFor(t, 20*time.Second, st.mode+" stream", func() bool {
			return client.SampleRate() == st.rate && client.Channels() == st.ch
		})
		// The sound server needs a moment to list a freshly opened stream,
		// and the old one to go.
		var rates []int
		waitFor(t, 5*time.Second, st.mode+" sink input", func() bool {
			rates = ourSinkInputRates(t)
			return len(rates) == 1 && rates[0] == st.rate
		})
		t.Logf("%-6s stream %6d Hz x%d -> sound server sees %v Hz", st.mode, st.rate, st.ch, rates)
	}
}

// ourSinkInputRates returns the rate of every playback stream this process has
// open, from `pactl list sink-inputs`.
func ourSinkInputRates(t *testing.T) []int {
	out, err := exec.Command("pactl", "list", "sink-inputs").Output()
	if err != nil {
		t.Fatalf("pactl: %v", err)
	}
	pid := fmt.Sprintf(`"%d"`, os.Getpid())
	spec := regexp.MustCompile(`Sample Specification:\s+\S+\s+\d+ch\s+(\d+)Hz`)
	var rates []int
	for _, block := range strings.Split(string(out), "Sink Input #")[1:] {
		if !strings.Contains(block, "application.process.id = "+pid) {
			continue
		}
		if m := spec.FindStringSubmatch(block); m != nil {
			r, _ := strconv.Atoi(m[1])
			rates = append(rates, r)
		}
	}
	return rates
}

func waitFor(t *testing.T, d time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// TestLiveAudioWarning checks what the output says about itself, against a
// real receiver: a wide IQ mode into a sound-server sink slower than the
// stream is flagged, a direct device at the stream's rate is not, and a direct
// device that cannot run the rate says so instead of playing it narrowed.
//
// Expects PipeWire at its default allowed-rates of [ 48000 ], and snd-aloop
// loaded (sudo modprobe snd-aloop), which stops at 192 kHz. Skipped unless
// UBERSDR_TEST_SERVER is set.
func TestLiveAudioWarning(t *testing.T) {
	target := os.Getenv("UBERSDR_TEST_SERVER")
	if target == "" {
		t.Skip("set UBERSDR_TEST_SERVER to run the live audio warning test")
	}
	if _, err := exec.LookPath("pactl"); err != nil {
		t.Skip("pactl not available")
	}
	if _, err := os.Stat("/proc/asound/Loopback"); err != nil {
		t.Skip("no ALSA loopback card; load it with: sudo modprobe snd-aloop")
	}
	const loop = alsaDevicePrefix + "plughw:CARD=Loopback,DEV=0"

	client := NewRadioClient()
	client.BaseURL = target
	client.Password = os.Getenv("UBERSDR_TEST_PASSWORD")
	client.Frequency = 14074000
	client.Mode = "iq384"
	client.SetVolume(0)
	client.Connect()
	defer client.Disconnect()
	waitFor(t, 20*time.Second, "connect", func() bool { return client.State() == StateConnected })

	for _, st := range []struct {
		device, mode string
		want         string // substring of the warning; "" for none
	}{
		{"", "iq384", "resampling this 384 kHz stream to 48 kHz"},
		{loop, "iq192", ""},
		{loop, "iq384", "cannot play the 384 kHz stream"},
		{"", "iq48", ""},
	} {
		client.SetDevice(st.device)
		if client.Mode != st.mode {
			client.Mode = st.mode
			client.ReconnectWS()
		}
		// The check runs a second after the output opens.
		var got string
		waitFor(t, 8*time.Second, st.mode+" warning", func() bool {
			got = client.AudioWarning()
			if st.want == "" {
				return got == "" && client.SampleRate() > 0
			}
			return strings.Contains(got, st.want)
		})
		if st.want == "" {
			time.Sleep(1500 * time.Millisecond) // and it stays clear once checked
			got = client.AudioWarning()
			if got != "" {
				t.Fatalf("%s on %q: unexpected warning %q", st.mode, st.device, got)
			}
		}
		t.Logf("%-5s on %-35q -> %q", st.mode, st.device, got)
	}
}

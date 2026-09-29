package main

import (
	"net/url"
	"os"
	"regexp"
	"strconv"
	"testing"
	"time"
)

// The range and default must match what the server clamps to and what the v2
// UI offers. Read from the source rather than copied, so a change on either
// side fails here instead of drifting.
func TestMarginConstantsMatchServerAndV2(t *testing.T) {
	read := func(path, pattern string) int {
		t.Helper()
		src, err := os.ReadFile(path)
		if err != nil {
			t.Skipf("%s not found: %v", path, err)
		}
		m := regexp.MustCompile(pattern).FindSubmatch(src)
		if m == nil {
			t.Fatalf("%s: no match for %s", path, pattern)
		}
		v, _ := strconv.Atoi(string(m[1]))
		return v
	}
	for _, tc := range []struct {
		name      string
		got, want int
	}{
		{"server min", marginMinDB, read("../../pcm_lossy.go", `lossyMinMarginDB\s*=\s*(\d+)`)},
		{"server max", marginMaxDB, read("../../pcm_lossy.go", `lossyMaxMarginDB\s*=\s*(\d+)`)},
		{"v2 min", marginMinDB, read("../../static/v2/src/radio/constants.js", `MARGIN_MIN_DB = (\d+)`)},
		{"v2 max", marginMaxDB, read("../../static/v2/src/radio/constants.js", `MARGIN_MAX_DB = (\d+)`)},
	} {
		if tc.got != tc.want {
			t.Errorf("%s: this client has %d, the source says %d", tc.name, tc.got, tc.want)
		}
	}
	// v2 starts IQ at its minimum, as this client does.
	if marginDefaultDB != marginMinDB {
		t.Errorf("default %d dB, v2 starts IQ at its minimum %d", marginDefaultDB, marginMinDB)
	}
}

func TestMarginToWire(t *testing.T) {
	for _, tc := range []struct {
		mode   string
		margin int
		want   int
	}{
		{"iq384", 15, 15},
		{"iq96", 26, 26},
		{"iq", 40, 40},    // the narrow IQ mode is reduced too
		{"iq48", 5, 15},   // clamped up to what the server takes
		{"iq192", 90, 60}, // and down
		{"iq384", 0, 0},   // lossless: nothing sent
		{"usb", 15, 0},    // demodulated audio is always whole
		{"am", 30, 0},
	} {
		if got := marginToWire(tc.mode, tc.margin); got != tc.want {
			t.Errorf("%s at %d dB: sends %d, want %d", tc.mode, tc.margin, got, tc.want)
		}
	}
}

func TestMarginSlider(t *testing.T) {
	for v := float64(marginMinDB); v <= marginMaxDB; v++ {
		if got := sliderFromMargin(marginFromSlider(v)); got != v {
			t.Errorf("slider %v round-trips to %v", v, got)
		}
	}
	if m := marginFromSlider(marginSliderLossless); m != 0 {
		t.Errorf("top stop gives %d dB, want lossless", m)
	}
	if v := sliderFromMargin(0); v != marginSliderLossless {
		t.Errorf("lossless drawn at %v, want the top stop", v)
	}
	if marginLabel(0) != "Lossless" || marginLabel(26) != "26 dB" {
		t.Errorf("labels: %q, %q", marginLabel(0), marginLabel(26))
	}
}

// The connect URL carries min_margin for IQ and never for anything else.
func TestBuildWSURLCarriesMargin(t *testing.T) {
	for _, tc := range []struct {
		mode   string
		margin int
		want   string
	}{
		{"iq384", 15, "15"},
		{"iq192", 0, ""},
		{"usb", 15, ""},
	} {
		c := NewRadioClient()
		c.BaseURL = "http://example.invalid:8073"
		c.Mode = tc.mode
		c.SetMinMargin(tc.margin)
		raw, err := c.buildWSURL()
		if err != nil {
			t.Fatal(err)
		}
		u, _ := url.Parse(raw)
		if got := u.Query().Get("min_margin"); got != tc.want {
			t.Errorf("%s at %d dB: min_margin=%q, want %q", tc.mode, tc.margin, got, tc.want)
		}
	}
}

// TestLiveMinMargin runs a real IQ session through margin changes on a live
// socket: reduced at 15 dB from the connect URL, lossless, then 30 dB, each
// applied with set_min_margin and no reconnect. Every packet must decode --
// a profile or shift the decoder got wrong ends the session in an error --
// and the reduced stream must cost fewer bytes than the lossless one.
//
// Skipped unless UBERSDR_TEST_SERVER is set; needs a receiver that allows
// iq96, e.g. https://m9psy-1.instance.ubersdr.org.
func TestLiveMinMargin(t *testing.T) {
	target := os.Getenv("UBERSDR_TEST_SERVER")
	if target == "" {
		t.Skip("set UBERSDR_TEST_SERVER to run the live margin test")
	}
	c := NewRadioClient()
	c.BaseURL = target
	c.Password = os.Getenv("UBERSDR_TEST_PASSWORD")
	c.Frequency = 7074000
	c.Mode = "iq96"
	c.Format = FormatPCMZstd
	c.DeviceID = "alsa:null" // decoded and paced, never heard
	c.SetVolume(0)
	c.SetMinMargin(15)
	var failed string
	c.OnStateChange = func(st ConnectionState, msg string) {
		if st == StateError {
			failed = msg
		}
	}
	c.Connect()
	defer c.Disconnect()

	deadline := time.Now().Add(20 * time.Second)
	for c.SampleRate() != 96000 {
		if failed != "" || time.Now().After(deadline) {
			t.Fatalf("no iq96 stream (state %v): %s", c.State(), failed)
		}
		time.Sleep(50 * time.Millisecond)
	}

	rate := func(margin int) float64 {
		c.SetMinMargin(margin)
		time.Sleep(time.Second) // let the change reach the stream
		c.BytesReceivedAndReset()
		time.Sleep(4 * time.Second)
		bps := float64(c.BytesReceivedAndReset()) / 4
		if failed != "" || c.State() != StateConnected {
			t.Fatalf("at %d dB the session failed: %s", margin, failed)
		}
		t.Logf("%-8s %7.0f kB/s", marginLabel(margin), bps/1000)
		return bps
	}
	reduced := rate(15)
	lossless := rate(0)
	rate(30)
	if reduced >= lossless*0.9 {
		t.Errorf("15 dB costs %.0f B/s against %.0f lossless: the margin is not reaching the server", reduced, lossless)
	}
}

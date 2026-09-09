package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// TestLiveLossless streams both formats from a real receiver, checking that the
// lossless path decodes for as long as it is left running and reporting what
// each costs. Gated on UBERSDR_TEST_SERVER.
//
// Running it for a while is the point. The predictive codec is backward
// adaptive, so a decoder that disagrees with the server by a single bit does
// not fail on the packet that disagreed — it fails on every packet after it,
// and only once the taps have drifted far enough for the residuals to stop
// making sense. A packet or two proves nothing; ten seconds is 500 packets.
func TestLiveLossless(t *testing.T) {
	target := os.Getenv("UBERSDR_TEST_SERVER")
	if target == "" {
		t.Skip("set UBERSDR_TEST_SERVER to run the live lossless test")
	}
	host, secure := parseServer(target, false)

	sp, err := NewClient(host, secure, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := sp.CheckConnection(); err != nil {
		t.Fatalf("/connection: %v", err)
	}

	ac := NewAudioClient(host, secure, "", sp.sessionID)
	ac.SetFormat(FormatLossless)
	ac.SetTuning(7_100_000, "lsb", -2700, -300)

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	go ac.Run(ctx)

	var packets, samples int
	var last Signal
	deadline := time.After(12 * time.Second)
loop:
	for {
		select {
		case pcm := <-ac.PCM:
			packets++
			samples += pcm.Frames()
		case last = <-ac.Level:
		case msg := <-ac.Status:
			t.Logf("status: %s", msg)
		case <-ac.Silence:
		case <-ac.DSP:
		case <-deadline:
			break loop
		}
	}

	if packets == 0 {
		t.Fatal("no lossless audio arrived")
	}
	if !last.Lossless {
		t.Fatalf("the stream was not lossless: %+v", last)
	}
	// Ten seconds of audio at the output rate, allowing for the seconds either
	// side of the measurement window. Anything far off this is the rate
	// conversion playing at the wrong speed, which is the failure that a decode
	// error would not catch.
	if samples < 8*opusOutputRate || samples > 13*opusOutputRate {
		t.Errorf("%d samples in a twelve-second window, want about %d",
			samples, 10*opusOutputRate)
	}
	t.Logf("lossless: %d packets, %d samples, channel %d Hz, %.0f dBFS power",
		packets, samples, last.SourceRate, last.Power)

	// What each format costs, measured rather than assumed. Two channels,
	// because the lossless one costs what the signal costs: a quiet band
	// compresses to a fraction of a busy one, while Opus spends the same on
	// both.
	for _, ch := range []struct {
		what string
		freq int
		mode string
		low  int
		high int
	}{
		{"quiet 40 m", 7_100_000, "lsb", -2700, -300},
		{"FT8 20 m", 14_074_000, "usb", 300, 2700},
	} {
		for _, f := range []AudioFormat{FormatOpus, FormatLossless} {
			rate, err := measureWireRate(host, secure, f, ch.freq, ch.mode, ch.low, ch.high, 8*time.Second)
			if err != nil {
				t.Fatalf("%s %v: %v", ch.what, f, err)
			}
			t.Logf("%-10s %-8v %.1f kB/s", ch.what, f, rate/1000)
		}
	}
}

// measureWireRate opens its own session in the given format and reports the
// bytes per second the server sends on it.
func measureWireRate(host string, secure bool, f AudioFormat, freq int, mode string, low, high int, d time.Duration) (float64, error) {
	sp, err := NewClient(host, secure, "")
	if err != nil {
		return 0, err
	}
	if err := sp.CheckConnection(); err != nil {
		return 0, err
	}

	q := url.Values{}
	q.Set("user_session_id", sp.sessionID)
	q.Set("format", f.wireName())
	q.Set("version", fmt.Sprintf("%d", audioProtocolVersion))
	q.Set("frequency", fmt.Sprintf("%d", freq))
	q.Set("mode", mode)
	q.Set("bandwidthLow", fmt.Sprintf("%d", low))
	q.Set("bandwidthHigh", fmt.Sprintf("%d", high))

	scheme := "ws"
	if secure {
		scheme = "wss"
	}
	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = 15 * time.Second
	dialer.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	dialer.NetDialContext = dialFunc()

	conn, _, err := dialer.Dial(fmt.Sprintf("%s://%s/ws?%s", scheme, host, q.Encode()),
		http.Header{"User-Agent": []string{userAgent}})
	if err != nil {
		return 0, err
	}
	defer conn.Close()

	// Start the clock at the first binary frame, so the handshake and whatever
	// the server says before the audio starts are not counted as audio.
	var total int
	var start time.Time
	conn.SetReadDeadline(time.Now().Add(d + 20*time.Second))
	for start.IsZero() || time.Since(start) < d {
		typ, data, err := conn.ReadMessage()
		if err != nil {
			return 0, err
		}
		if typ != websocket.BinaryMessage {
			continue
		}
		if start.IsZero() {
			start = time.Now()
			continue
		}
		total += len(data)
	}
	return float64(total) / time.Since(start).Seconds(), nil
}

// TestLiveFormatToggle switches format on a running session against a real
// receiver, which is what the L key and the audio panel's format row do.
//
// The switch is a reconnect, so what this checks is that the reconnect happens
// promptly, keeps the same session, and comes back in the other format with the
// audio still flowing. Gated on UBERSDR_TEST_SERVER.
func TestLiveFormatToggle(t *testing.T) {
	target := os.Getenv("UBERSDR_TEST_SERVER")
	if target == "" {
		t.Skip("set UBERSDR_TEST_SERVER to run the live format toggle test")
	}
	host, secure := parseServer(target, false)

	sp, err := NewClient(host, secure, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := sp.CheckConnection(); err != nil {
		t.Fatalf("/connection: %v", err)
	}

	ac := NewAudioClient(host, secure, "", sp.sessionID)
	ac.SetTuning(7_100_000, "lsb", -2700, -300)

	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	go ac.Run(ctx)

	// play waits for audio in the given format, returning how long it took and
	// how many packets arrived.
	play := func(want bool, limit time.Duration) (time.Duration, int) {
		t.Helper()
		start := time.Now()
		deadline := time.After(limit)
		packets := 0
		var first time.Duration
		for {
			select {
			case <-ac.PCM:
				packets++
			case sig := <-ac.Level:
				if sig.Lossless != want {
					continue
				}
				if first == 0 {
					first = time.Since(start)
				}
				if packets > 25 {
					return first, packets
				}
			case msg := <-ac.Status:
				t.Logf("status: %s", msg)
			case <-ac.Silence:
			case <-ac.DSP:
			case <-deadline:
				t.Fatalf("no %s audio within %v (%d packets)",
					map[bool]string{true: "lossless", false: "Opus"}[want], limit, packets)
				return 0, 0
			}
		}
	}

	d, n := play(false, 20*time.Second)
	t.Logf("Opus playing after %v (%d packets)", d, n)

	ac.SetFormat(FormatLossless)
	d, n = play(true, 20*time.Second)
	t.Logf("lossless playing %v after the switch (%d packets)", d, n)
	if d > 5*time.Second {
		t.Errorf("the format switch took %v to produce audio", d)
	}
}

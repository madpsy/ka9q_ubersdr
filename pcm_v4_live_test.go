package main

import (
	"bytes"
	"crypto/rand"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/klauspost/compress/zstd"
)

// Live A/B test of protocol version 3 against version 4, against a running
// server. Gated on UBERSDR_V4_TEST_SERVER so it never runs in a normal build:
//
//	UBERSDR_V4_TEST_SERVER=host[:port] go test -run TestLiveV4 -v .
//
// Optional:
//	UBERSDR_V4_TEST_INSECURE=1   plain http/ws rather than https/wss
//	UBERSDR_V4_TEST_PASSWORD=x   receiver password
//	UBERSDR_V4_TEST_SECONDS=20   capture length per leg
//
// Everything up to here has been tested against captured traffic, which cannot
// exercise the decisions streamAudio makes per packet. This does.

const liveUserAgent = "UberSDR_TUI/1.0"

type liveTarget struct {
	host     string
	secure   bool
	password string
	seconds  int
}

func liveConfig(t *testing.T) liveTarget {
	t.Helper()
	host := os.Getenv("UBERSDR_V4_TEST_SERVER")
	if host == "" {
		t.Skip("set UBERSDR_V4_TEST_SERVER to run the live version 3 vs 4 comparison")
	}
	secs := 20
	if v := os.Getenv("UBERSDR_V4_TEST_SECONDS"); v != "" {
		fmt.Sscanf(v, "%d", &secs)
	}
	return liveTarget{
		host:     host,
		secure:   os.Getenv("UBERSDR_V4_TEST_INSECURE") == "",
		password: os.Getenv("UBERSDR_V4_TEST_PASSWORD"),
		seconds:  secs,
	}
}

func (tg liveTarget) scheme(secure, plain string) string {
	if tg.secure {
		return secure
	}
	return plain
}

func liveUUID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// liveConnection performs the /connection precheck the server requires before
// it will open a socket for a session id.
func liveConnection(tg liveTarget, session string) error {
	body, _ := json.Marshal(map[string]string{
		"user_session_id": session, "password": tg.password,
	})
	req, err := http.NewRequest(http.MethodPost,
		tg.scheme("https", "http")+"://"+tg.host+"/connection", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", liveUserAgent)
	cl := &http.Client{Timeout: 15 * time.Second,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	resp, err := cl.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var out struct {
		Allowed bool   `json:"allowed"`
		Reason  string `json:"reason"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return fmt.Errorf("HTTP %d: %w", resp.StatusCode, err)
	}
	if !out.Allowed {
		return fmt.Errorf("refused: %s", out.Reason)
	}
	return nil
}

// liveStats is what one leg of the comparison measures.
type liveStats struct {
	version     int
	packets     int
	wireBytes   int64
	sampleBytes int64 // samples actually delivered, uncompressed
	samples     int
	sampleRate  int
	channels    int
	rms         float64
	peak        int
	power       float32
	noise       float32
	qualitySeen int
	silent      int
	escaped     int
	decodeErrs  int
	firstErr    string
}

func (s liveStats) kbPerSec(seconds int) float64 {
	return float64(s.wireBytes) / float64(seconds) / 1000
}

// runLeg opens one session at the given protocol version and measures it.
func runLeg(t *testing.T, tg liveTarget, version int, freq int64, mode string, low, high int, minSNR string) (liveStats, error) {
	st := liveStats{version: version}

	session := liveUUID()
	if err := liveConnection(tg, session); err != nil {
		return st, fmt.Errorf("/connection: %w", err)
	}

	q := url.Values{}
	q.Set("user_session_id", session)
	q.Set("format", "pcm-zstd")
	q.Set("version", fmt.Sprintf("%d", version))
	q.Set("frequency", fmt.Sprintf("%d", freq))
	q.Set("mode", mode)
	q.Set("bandwidthLow", fmt.Sprintf("%d", low))
	q.Set("bandwidthHigh", fmt.Sprintf("%d", high))
	q.Set("min_snr", minSNR)
	if tg.password != "" {
		q.Set("password", tg.password)
	}

	d := *websocket.DefaultDialer
	d.HandshakeTimeout = 20 * time.Second
	d.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	conn, resp, err := d.Dial(tg.scheme("wss", "ws")+"://"+tg.host+"/ws?"+q.Encode(),
		http.Header{"User-Agent": {liveUserAgent}})
	if err != nil {
		if resp != nil {
			return st, fmt.Errorf("dial: %w (HTTP %d)", err, resp.StatusCode)
		}
		return st, fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	zdec, _ := zstd.NewReader(nil)
	defer zdec.Close()
	v4dec := NewPCMv4StreamDecoder()

	var sumSq float64
	deadline := time.Now().Add(time.Duration(tg.seconds) * time.Second)
	for time.Now().Before(deadline) {
		conn.SetReadDeadline(deadline.Add(5 * time.Second))
		mt, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if mt != websocket.BinaryMessage {
			continue
		}
		st.packets++
		st.wireBytes += int64(len(data))

		var samples []int16
		if version >= 4 {
			if !PCMv4IsHeader(data) {
				st.decodeErrs++
				if st.firstErr == "" {
					st.firstErr = fmt.Sprintf("packet %d is not a v4 frame (first bytes %x)", st.packets, data[:min(8, len(data))])
				}
				continue
			}
			h, s, err := v4dec.DecodePacket(data)
			if err != nil {
				st.decodeErrs++
				if st.firstErr == "" {
					st.firstErr = fmt.Sprintf("packet %d: %v", st.packets, err)
				}
				continue
			}
			samples = s
			st.sampleRate, st.channels = h.SampleRate, h.Channels
			st.power, st.noise = h.BasebandPower, h.Noise
			if float64(h.BasebandPower) > -998 {
				st.qualitySeen++
			}
			if h.Silent {
				st.silent++
			}
			if h.Escape {
				st.escaped++
			}
		} else {
			plain, err := zdec.DecodeAll(data, nil)
			if err != nil {
				st.decodeErrs++
				if st.firstErr == "" {
					st.firstErr = fmt.Sprintf("packet %d: zstd: %v", st.packets, err)
				}
				continue
			}
			hdr := PCMMinimalHeaderSize
			if binary.LittleEndian.Uint16(plain) == PCMBinaryMagicFull {
				hdr = PCMFullHeaderSizeV2
				st.sampleRate = int(binary.LittleEndian.Uint32(plain[20:24]))
				st.channels = int(plain[24])
				st.power = math.Float32frombits(binary.LittleEndian.Uint32(plain[25:29]))
				st.noise = math.Float32frombits(binary.LittleEndian.Uint32(plain[29:33]))
				if float64(st.power) > -998 {
					st.qualitySeen++
				}
			}
			body := plain[hdr:]
			samples = make([]int16, len(body)/2)
			for i := range samples {
				samples[i] = int16(binary.BigEndian.Uint16(body[2*i:]))
			}
		}

		st.samples += len(samples)
		st.sampleBytes += int64(len(samples) * 2)
		for _, v := range samples {
			sumSq += float64(v) * float64(v)
			a := int(v)
			if a < 0 {
				a = -a
			}
			if a > st.peak {
				st.peak = a
			}
		}
	}
	if st.samples > 0 {
		st.rms = math.Sqrt(sumSq / float64(st.samples))
	}
	return st, nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func reportLeg(t *testing.T, tg liveTarget, label string, st liveStats) {
	t.Helper()
	dbfs := func(v float64) float64 {
		if v <= 0 {
			return math.Inf(-1)
		}
		return 20 * math.Log10(v/32768)
	}
	t.Logf("  %-4s %6d pkts  %8.2f kB/s  %7d samples @ %d Hz x%d  rms %.0f (%.1f dBFS) peak %d",
		label, st.packets, st.kbPerSec(tg.seconds), st.samples,
		st.sampleRate, st.channels, st.rms, dbfs(st.rms), st.peak)
	extra := fmt.Sprintf("       power %.2f dBFS  noise %.2f dBFS  quality on %d pkts",
		st.power, st.noise, st.qualitySeen)
	if st.version >= 4 {
		extra += fmt.Sprintf("  silent %d  escaped %d", st.silent, st.escaped)
	}
	t.Log(extra)
	if st.decodeErrs > 0 {
		t.Errorf("       %d decode errors, first: %s", st.decodeErrs, st.firstErr)
	}
}

// TestLiveV4Comparison is the headline: the same band on both versions,
// measuring what each actually puts on the wire.
func TestLiveV4Comparison(t *testing.T) {
	tg := liveConfig(t)
	cases := []struct {
		name             string
		freq             int64
		mode             string
		low, high        int
		expectMinSavings float64 // percent, from the capture measurements
	}{
		{"USB 14.074 (FT8)", 14_074_000, "usb", 50, 2700, 35},
		{"IQ 12k 14.080", 14_080_000, "iq", -6000, 6000, 20},
		{"IQ 48k 14.080", 14_080_000, "iq48", -24000, 24000, 20},
	}

	t.Logf("server %s, %d seconds per leg", tg.host, tg.seconds)
	var totV3, totV4 float64
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// Both legs run at the same time, on the same band. Run one after
			// the other and a change in propagation between them shows up as a
			// difference in compression that has nothing to do with the codec.
			var v3, v4 liveStats
			var err3, err4 error
			done := make(chan struct{}, 2)
			go func() { v3, err3 = runLeg(t, tg, 3, c.freq, c.mode, c.low, c.high, "-999"); done <- struct{}{} }()
			go func() { v4, err4 = runLeg(t, tg, 4, c.freq, c.mode, c.low, c.high, "-999"); done <- struct{}{} }()
			<-done
			<-done
			if err3 != nil {
				t.Fatalf("version 3 leg: %v", err3)
			}
			if err4 != nil {
				t.Fatalf("version 4 leg: %v", err4)
			}
			reportLeg(t, tg, "v3", v3)
			reportLeg(t, tg, "v4", v4)

			if v4.packets == 0 {
				t.Fatal("version 4 delivered no packets")
			}
			k3, k4 := v3.kbPerSec(tg.seconds), v4.kbPerSec(tg.seconds)
			saved := 100 * (1 - k4/k3)
			t.Logf("  => %.2f -> %.2f kB/s, %.1f%% saved", k3, k4, saved)
			totV3 += k3
			totV4 += k4

			if saved < c.expectMinSavings {
				t.Errorf("saved only %.1f%%, expected at least %.0f%% from the capture measurements",
					saved, c.expectMinSavings)
			}
			// The two legs are separate sessions, so samples differ -- but the
			// signal statistics must agree, and a desynced predictor would show
			// up here as noise rather than the band.
			if v3.rms > 0 && v4.rms > 0 {
				ratio := v4.rms / v3.rms
				if ratio < 0.25 || ratio > 4 {
					t.Errorf("decoded level differs wildly between versions (rms %.0f vs %.0f) — a desynced predictor looks like this",
						v4.rms, v3.rms)
				}
			}
			if v4.sampleRate != v3.sampleRate || v4.channels != v3.channels {
				t.Errorf("metadata disagrees: v3 %d Hz x%d, v4 %d Hz x%d",
					v3.sampleRate, v3.channels, v4.sampleRate, v4.channels)
			}
		})
	}
	if totV3 > 0 {
		t.Logf("TOTAL across all modes: %.1f -> %.1f kB/s (%.1f%% saved)",
			totV3, totV4, 100*(1-totV4/totV3))
	}
}

// A squelched session sends nothing but zeros. This is where version 4 should
// win by the largest margin.
func TestLiveV4Squelched(t *testing.T) {
	tg := liveConfig(t)
	// A high SNR threshold on a quiet part of the band keeps the gate shut.
	const freq = 7_035_000
	v3, err := runLeg(t, tg, 3, freq, "lsb", -2700, -50, "30")
	if err != nil {
		t.Fatalf("version 3 leg: %v", err)
	}
	v4, err := runLeg(t, tg, 4, freq, "lsb", -2700, -50, "30")
	if err != nil {
		t.Fatalf("version 4 leg: %v", err)
	}
	reportLeg(t, tg, "v3", v3)
	reportLeg(t, tg, "v4", v4)
	k3, k4 := v3.kbPerSec(tg.seconds), v4.kbPerSec(tg.seconds)
	t.Logf("  squelched: %.2f -> %.2f kB/s (%.1f%% saved), %d of %d v4 packets were silent",
		k3, k4, 100*(1-k4/k3), v4.silent, v4.packets)

	if v4.peak != 0 {
		t.Logf("  note: the gate was not fully closed (peak %d), so this understates the saving", v4.peak)
	} else if v4.silent == 0 {
		t.Error("audio was silent but no packet used the silent mode")
	}
	// Signal quality must keep flowing while the gate is shut -- that is what
	// the client's meters run on.
	if v4.qualitySeen == 0 {
		t.Error("no signal quality delivered during silence; the meters would freeze")
	}
}

// A long run on one connection, which is where a predictor desynchronisation
// would eventually show up.
//
// Counting decode errors is not enough on its own: a desynced predictor still
// produces structurally valid packets, it just reconstructs the wrong sample
// values. So this runs a version 3 leg alongside and compares every
// overlapping sample, which is the only way to see a slow drift.
//
//	UBERSDR_V4_TEST_MINUTES=5     how long to run
//	UBERSDR_V4_TEST_MODE=iq       mode to hold
//	UBERSDR_V4_TEST_FREQ=14080000 frequency to hold
func TestLiveV4Endurance(t *testing.T) {
	tg := liveConfig(t)
	if testing.Short() {
		t.Skip("endurance test skipped in short mode")
	}
	minutes := 5
	if v := os.Getenv("UBERSDR_V4_TEST_MINUTES"); v != "" {
		fmt.Sscanf(v, "%d", &minutes)
	}
	mode := os.Getenv("UBERSDR_V4_TEST_MODE")
	if mode == "" {
		mode = "iq"
	}
	freq := int64(14_080_000)
	if v := os.Getenv("UBERSDR_V4_TEST_FREQ"); v != "" {
		fmt.Sscanf(v, "%d", &freq)
	}
	low, high := -6000, 6000
	if mode == "usb" {
		low, high = 50, 2700
	}

	long := tg
	long.seconds = minutes * 60
	t.Logf("holding %s at %.3f MHz for %d minutes on two parallel connections",
		mode, float64(freq)/1e6, minutes)

	var s3, s4 []int16
	var st4 liveStats
	var e3, e4, eStat error
	done := make(chan struct{}, 3)
	go func() { s3, e3 = collectSamples(long, 3, freq, mode, low, high); done <- struct{}{} }()
	go func() { s4, e4 = collectSamples(long, 4, freq, mode, low, high); done <- struct{}{} }()
	go func() { st4, eStat = runLeg(t, long, 4, freq, mode, low, high, "-999"); done <- struct{}{} }()
	<-done
	<-done
	<-done
	if e3 != nil {
		t.Fatalf("version 3 leg: %v", e3)
	}
	if e4 != nil {
		t.Fatalf("version 4 leg: %v", e4)
	}
	if eStat != nil {
		t.Fatalf("version 4 statistics leg: %v", eStat)
	}

	reportLeg(t, long, "v4", st4)
	t.Logf("  v3 %d samples, v4 %d samples over %d minutes", len(s3), len(s4), minutes)
	if st4.decodeErrs > 0 {
		t.Errorf("  %d decode errors over %d minutes: %s", st4.decodeErrs, minutes, st4.firstErr)
	}
	if len(s3) < 20000 || len(s4) < 20000 {
		t.Fatalf("not enough samples to align")
	}

	const anchor = 4096
	mid := len(s4)/2 - anchor/2
	off, found := findSubsequence(s3, s4[mid:mid+anchor])
	if !found {
		t.Fatalf("could not align the two streams; either they did not overlap or version 4 diverged")
	}
	back := off
	if mid < back {
		back = mid
	}
	n := len(s3) - off
	if m := len(s4) - mid; m < n {
		n = m
	}
	mismatch := -1
	for i := -back; i < n; i++ {
		if s3[off+i] != s4[mid+i] {
			mismatch = i
			break
		}
	}
	total := back + n
	t.Logf("  aligned at v3[%d] = v4[%d], compared %d overlapping samples", off, mid, total)
	if mismatch >= 0 {
		t.Errorf("  DRIFT at overlap offset %d of %d (%.1f%% through the run): v3 %d, v4 %d",
			mismatch, total, 100*float64(mismatch+back)/float64(total),
			s3[off+mismatch], s4[mid+mismatch])
	} else {
		t.Logf("  no drift: %d consecutive samples identical over %d minutes", total, minutes)
	}
}

// A version this build does not implement must be refused outright, not
// silently downgraded to version 1 the way it used to be.
func TestLiveV4VersionNegotiation(t *testing.T) {
	tg := liveConfig(t)
	for _, c := range []struct {
		version int
		accept  bool
	}{{1, true}, {3, true}, {4, true}, {5, false}, {99, false}} {
		session := liveUUID()
		if err := liveConnection(tg, session); err != nil {
			t.Fatalf("/connection: %v", err)
		}
		q := url.Values{}
		q.Set("user_session_id", session)
		q.Set("format", "pcm-zstd")
		q.Set("version", fmt.Sprintf("%d", c.version))
		q.Set("frequency", "14074000")
		q.Set("mode", "usb")
		if tg.password != "" {
			q.Set("password", tg.password)
		}
		d := *websocket.DefaultDialer
		d.HandshakeTimeout = 15 * time.Second
		d.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
		conn, resp, err := d.Dial(tg.scheme("wss", "ws")+"://"+tg.host+"/ws?"+q.Encode(),
			http.Header{"User-Agent": {liveUserAgent}})
		if conn != nil {
			conn.Close()
		}
		accepted := err == nil
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		t.Logf("version %-3d accepted=%-5v HTTP %d", c.version, accepted, status)
		if accepted != c.accept {
			t.Errorf("version %d: accepted=%v, want %v (HTTP %d)", c.version, accepted, c.accept, status)
		}
		if !c.accept && status != http.StatusBadRequest {
			t.Errorf("version %d: expected HTTP 400, got %d — a silent downgrade is what this replaced",
				c.version, status)
		}
	}
}

// Mode changes alter the channel count, which switches the predictor profile
// mid-connection. Captures cannot test this: it needs a live session.
func TestLiveV4ModeSwitching(t *testing.T) {
	tg := liveConfig(t)
	session := liveUUID()
	if err := liveConnection(tg, session); err != nil {
		t.Fatalf("/connection: %v", err)
	}
	q := url.Values{}
	q.Set("user_session_id", session)
	q.Set("format", "pcm-zstd")
	q.Set("version", "4")
	q.Set("frequency", "14074000")
	q.Set("mode", "usb")
	q.Set("bandwidthLow", "50")
	q.Set("bandwidthHigh", "2700")
	q.Set("min_snr", "-999")
	if tg.password != "" {
		q.Set("password", tg.password)
	}
	d := *websocket.DefaultDialer
	d.HandshakeTimeout = 20 * time.Second
	d.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	conn, _, err := d.Dial(tg.scheme("wss", "ws")+"://"+tg.host+"/ws?"+q.Encode(),
		http.Header{"User-Agent": {liveUserAgent}})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	dec := NewPCMv4StreamDecoder()
	// Only modes any session may select: the wide IQ variants (iq48 and up)
	// need a bypassed IP, so a plain client cannot switch to them.
	modes := []string{"usb", "am", "iq", "cwu", "nfm", "lsb", "usb"}
	seenProfiles := map[byte]int{}
	errs := 0
	var firstErr string

	for _, mode := range modes {
		// The control message is "tune", not "set_mode" -- an unknown type is
		// ignored, so getting this wrong would silently test nothing.
		msg := fmt.Sprintf(`{"type":"tune","mode":%q}`, mode)
		if err := conn.WriteMessage(websocket.TextMessage, []byte(msg)); err != nil {
			t.Fatalf("set_mode %s: %v", mode, err)
		}
		deadline := time.Now().Add(4 * time.Second)
		for time.Now().Before(deadline) {
			conn.SetReadDeadline(deadline.Add(2 * time.Second))
			mt, data, err := conn.ReadMessage()
			if err != nil {
				break
			}
			if mt != websocket.BinaryMessage || !PCMv4IsHeader(data) {
				continue
			}
			h, _, err := dec.DecodePacket(data)
			if err != nil {
				errs++
				if firstErr == "" {
					firstErr = fmt.Sprintf("mode %s: %v", mode, err)
				}
				continue
			}
			seenProfiles[h.Profile]++
		}
		t.Logf("  mode %-5s ok", mode)
	}
	if errs > 0 {
		t.Errorf("%d decode errors across mode changes, first: %s", errs, firstErr)
	}
	t.Logf("  profiles exercised: %v", seenProfiles)
	if len(seenProfiles) < 2 {
		t.Errorf("expected both predictor profiles across these modes, saw %v", seenProfiles)
	}
	if !strings.Contains(fmt.Sprint(seenProfiles), fmt.Sprint(PredProfileIQ)) {
		t.Log("  note: the IQ profile was not seen; the receiver may not permit IQ modes")
	}
}

// TestLiveV4BitExactAgainstV3 is the strongest check available: it decodes a
// version 3 and a version 4 stream of the same channel and compares them
// sample for sample.
//
// The two sessions get separate radiod channels with independent RTP
// timestamps, so packets cannot be matched on those -- an earlier attempt
// matched nothing. What they do carry is the same demodulated audio, which the
// comparison test showed by producing identical RMS and peak on both legs. So
// the streams are aligned on content: find where one stream's samples begin
// inside the other, then compare the overlap.
//
// The capture tests already prove the codec round-trips its own output. What
// this adds is that the SERVER's encoder, over a real socket, produces
// something that decodes back to exactly what an unmodified version 3 stream
// delivers -- the definition of lossless, verified end to end.
func TestLiveV4BitExactAgainstV3(t *testing.T) {
	tg := liveConfig(t)
	cases := []struct {
		name      string
		freq      int64
		mode      string
		low, high int
	}{
		{"USB 14.074", 14_074_000, "usb", 50, 2700},
		{"IQ 12k 14.080", 14_080_000, "iq", -6000, 6000},
		{"IQ 48k 14.080", 14_080_000, "iq48", -24000, 24000},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var s3, s4 []int16
			var e3, e4 error
			done := make(chan struct{}, 2)
			go func() { s3, e3 = collectSamples(tg, 3, c.freq, c.mode, c.low, c.high); done <- struct{}{} }()
			go func() { s4, e4 = collectSamples(tg, 4, c.freq, c.mode, c.low, c.high); done <- struct{}{} }()
			<-done
			<-done
			if e3 != nil {
				t.Fatalf("version 3 leg: %v", e3)
			}
			if e4 != nil {
				t.Fatalf("version 4 leg: %v", e4)
			}
			t.Logf("  v3 %d samples, v4 %d samples", len(s3), len(s4))
			if len(s3) < 20000 || len(s4) < 20000 {
				t.Fatalf("not enough samples to align")
			}

			// Anchor on a window from the middle of the v4 stream, well clear
			// of either end, and find it in v3.
			const anchor = 4096
			mid := len(s4)/2 - anchor/2
			off, found := findSubsequence(s3, s4[mid:mid+anchor])
			if !found {
				// Try the other direction before concluding anything: the
				// overlap may sit the other way round.
				mid3 := len(s3)/2 - anchor/2
				if off4, ok := findSubsequence(s4, s3[mid3:mid3+anchor]); ok {
					off, found = -off4, true
					mid = mid3
					s3, s4 = s4, s3
				}
			}
			if !found {
				t.Fatalf("could not align the two streams on content. Either they did not overlap in time, or version 4 is not reproducing version 3's samples — compare the RMS figures from TestLiveV4Comparison to tell which")
			}

			// Walk outwards from the anchor and compare every overlapping sample.
			startV4 := mid
			startV3 := off
			back := startV3
			if startV4 < back {
				back = startV4
			}
			n := len(s3) - startV3
			if m := len(s4) - startV4; m < n {
				n = m
			}
			total := back + n
			mismatch := -1
			for i := -back; i < n; i++ {
				if s3[startV3+i] != s4[startV4+i] {
					mismatch = i
					break
				}
			}
			t.Logf("  aligned at v3[%d] = v4[%d], compared %d overlapping samples", startV3, startV4, total)
			if mismatch >= 0 {
				i := mismatch
				t.Errorf("  MISMATCH at overlap offset %d: v3 %d, v4 %d — version 4 is NOT lossless",
					i, s3[startV3+i], s4[startV4+i])
			} else {
				t.Logf("  every one of %d overlapping samples identical: version 4 is bit-exact against version 3 on live data", total)
			}
		})
	}
}

// findSubsequence returns the index in hay where needle occurs exactly.
func findSubsequence(hay, needle []int16) (int, bool) {
	if len(needle) == 0 || len(hay) < len(needle) {
		return 0, false
	}
	first := needle[0]
	limit := len(hay) - len(needle)
	for i := 0; i <= limit; i++ {
		if hay[i] != first {
			continue
		}
		match := true
		for j := 1; j < len(needle); j++ {
			if hay[i+j] != needle[j] {
				match = false
				break
			}
		}
		if match {
			return i, true
		}
	}
	return 0, false
}

// collectSamples captures one leg and returns its decoded samples in order.
func collectSamples(tg liveTarget, version int, freq int64, mode string, low, high int) ([]int16, error) {
	var out []int16
	session := liveUUID()
	if err := liveConnection(tg, session); err != nil {
		return nil, fmt.Errorf("/connection: %w", err)
	}
	q := url.Values{}
	q.Set("user_session_id", session)
	q.Set("format", "pcm-zstd")
	q.Set("version", fmt.Sprintf("%d", version))
	q.Set("frequency", fmt.Sprintf("%d", freq))
	q.Set("mode", mode)
	q.Set("bandwidthLow", fmt.Sprintf("%d", low))
	q.Set("bandwidthHigh", fmt.Sprintf("%d", high))
	q.Set("min_snr", "-999")
	if tg.password != "" {
		q.Set("password", tg.password)
	}
	d := *websocket.DefaultDialer
	d.HandshakeTimeout = 20 * time.Second
	d.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	conn, resp, err := d.Dial(tg.scheme("wss", "ws")+"://"+tg.host+"/ws?"+q.Encode(),
		http.Header{"User-Agent": {liveUserAgent}})
	if err != nil {
		if resp != nil {
			return nil, fmt.Errorf("dial: %w (HTTP %d)", err, resp.StatusCode)
		}
		return nil, fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	zdec, _ := zstd.NewReader(nil)
	defer zdec.Close()
	v4dec := NewPCMv4StreamDecoder()

	deadline := time.Now().Add(time.Duration(tg.seconds) * time.Second)
	for time.Now().Before(deadline) {
		conn.SetReadDeadline(deadline.Add(5 * time.Second))
		mt, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if mt != websocket.BinaryMessage {
			continue
		}
		if version >= 4 {
			if !PCMv4IsHeader(data) {
				continue
			}
			_, s, err := v4dec.DecodePacket(data)
			if err != nil {
				return nil, fmt.Errorf("v4 decode: %w", err)
			}
			out = append(out, s...)
			continue
		}
		plain, err := zdec.DecodeAll(data, nil)
		if err != nil {
			return nil, fmt.Errorf("zstd: %w", err)
		}
		hdr := PCMMinimalHeaderSize
		if len(plain) >= 2 && binary.LittleEndian.Uint16(plain) == PCMBinaryMagicFull {
			hdr = PCMFullHeaderSizeV2
		}
		if len(plain) <= hdr {
			continue
		}
		body := plain[hdr:]
		for i := 0; i+1 < len(body); i += 2 {
			out = append(out, int16(binary.BigEndian.Uint16(body[i:])))
		}
	}
	return out, nil
}

// TestLiveOpusVsV4 compares the two formats a listener can actually choose.
//
// The expectation is that Opus is far smaller: a lossy voice codec at roughly
// 24 kbit/s against lossless PCM. If it is not, the reason will be per-packet
// overhead rather than the codecs -- both send a packet every 20 ms, and an
// Opus frame carries a fixed 21-byte header on top of whatever the WebSocket
// framing costs, which at 50 packets a second is a floor neither can go below.
// So the header is measured separately rather than the totals being compared
// and guessed at.
func TestLiveOpusVsV4(t *testing.T) {
	tg := liveConfig(t)
	cases := []struct {
		name      string
		freq      int64
		mode      string
		low, high int
	}{
		{"USB 14.074", 14_074_000, "usb", 50, 2700},
		{"LSB 7.150", 7_150_000, "lsb", -2700, -50},
		{"CW 14.025", 14_025_000, "cwu", -200, 200},
		// Two AM frequencies on purpose. The ratio depends on what is on the
		// band, not just the mode: a strong broadcast carrier predicts well and
		// a quiet channel is mostly noise, which does not. Quoting one figure
		// from one frequency is how the interface came to overstate this.
		{"AM 909 kHz (MW)", 909_000, "am", -5000, 5000},
		{"AM 14.074 (quiet)", 14_074_000, "am", -5000, 5000},
		{"NFM 14.074", 14_074_000, "nfm", -5000, 5000},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var op, v4 formatStats
			var eo, e4 error
			done := make(chan struct{}, 2)
			go func() {
				op, eo = measureFormat(tg, "opus", 4, c.freq, c.mode, c.low, c.high)
				done <- struct{}{}
			}()
			go func() {
				v4, e4 = measureFormat(tg, "pcm-zstd", 4, c.freq, c.mode, c.low, c.high)
				done <- struct{}{}
			}()
			<-done
			<-done
			if eo != nil {
				t.Fatalf("opus leg: %v", eo)
			}
			if e4 != nil {
				t.Fatalf("pcm leg: %v", e4)
			}

			t.Logf("%s, %d seconds, both legs at the same time", c.name, tg.seconds)
			t.Logf("  %-10s %7s %9s %10s %10s %9s %9s  %s",
				"format", "pkts", "kB/s", "hdr kB/s", "body kB/s", "B/pkt", "hdr B/pkt", "arrived as")
			for _, s := range []formatStats{op, v4} {
				if s.packets == 0 {
					t.Fatalf("%s leg received nothing", s.requested)
				}
				secs := float64(tg.seconds)
				t.Logf("  %-10s %7d %9.2f %10.2f %10.2f %9.1f %9.1f  %s",
					s.requested, s.packets,
					float64(s.wire)/secs/1000, float64(s.header)/secs/1000,
					float64(s.payload)/secs/1000,
					float64(s.wire)/float64(s.packets),
					float64(s.header)/float64(s.packets), s.kind)
			}
			ko := float64(op.wire) / float64(tg.seconds) / 1000
			k4 := float64(v4.wire) / float64(tg.seconds) / 1000
			switch {
			case op.kind == v4.kind:
				t.Logf("  => both legs carried %s; the server forces it in this mode", op.kind)
			case ko < k4:
				t.Logf("  => Opus is smaller: %.2f against %.2f kB/s (%.1f%% less)", ko, k4, 100*(1-ko/k4))
			default:
				t.Logf("  => LOSSLESS IS SMALLER: %.2f against Opus %.2f kB/s (%.1f%% less)", k4, ko, 100*(1-k4/ko))
			}
			if op.kind == "opus" && ko > 0 {
				// The figure the interface quotes in its warning.
				t.Logf("  => lossless costs %.2fx Opus", k4/ko)
			}
			if op.kind == "opus" {
				t.Logf("  Opus: %.0f%% of its bytes are header; the audio itself is %.2f kB/s (%.0f kbit/s)",
					100*float64(op.header)/float64(op.wire),
					float64(op.payload)/float64(tg.seconds)/1000,
					float64(op.payload)*8/float64(tg.seconds)/1000)
			}
		})
	}
}

type formatStats struct {
	requested string
	kind      string // what actually arrived
	packets   int
	wire      int64
	header    int64
	payload   int64
}

// measureFormat opens one session asking for a given format and records how
// much of what arrives is header rather than audio.
func measureFormat(tg liveTarget, format string, version int, freq int64, mode string, low, high int) (formatStats, error) {
	st := formatStats{requested: format}
	session := liveUUID()
	if err := liveConnection(tg, session); err != nil {
		return st, fmt.Errorf("/connection: %w", err)
	}
	q := url.Values{}
	q.Set("user_session_id", session)
	q.Set("format", format)
	q.Set("version", fmt.Sprintf("%d", version))
	q.Set("frequency", fmt.Sprintf("%d", freq))
	q.Set("mode", mode)
	q.Set("bandwidthLow", fmt.Sprintf("%d", low))
	q.Set("bandwidthHigh", fmt.Sprintf("%d", high))
	q.Set("min_snr", "-999")
	if tg.password != "" {
		q.Set("password", tg.password)
	}
	d := *websocket.DefaultDialer
	d.HandshakeTimeout = 20 * time.Second
	d.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	conn, resp, err := d.Dial(tg.scheme("wss", "ws")+"://"+tg.host+"/ws?"+q.Encode(),
		http.Header{"User-Agent": {liveUserAgent}})
	if err != nil {
		if resp != nil {
			return st, fmt.Errorf("dial: %w (HTTP %d)", err, resp.StatusCode)
		}
		return st, fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	// Version 2 and 3 Opus frames carry a fixed 21-byte header: timestamp(8)
	// rate(4) channels(1) power(4) noise(4). Version 4 replaces it with the
	// same change-tracked header the lossless path uses, minus the fields only
	// a predictor needs, so its length has to be parsed rather than assumed.
	const opusHeaderV3 = 21
	v4dec := NewPCMv4StreamDecoder()
	hdrProbe := NewPCMv4HeaderDecoder()
	opusProbe := NewPCMv4HeaderDecoder()

	deadline := time.Now().Add(time.Duration(tg.seconds) * time.Second)
	for time.Now().Before(deadline) {
		conn.SetReadDeadline(deadline.Add(5 * time.Second))
		mt, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if mt != websocket.BinaryMessage {
			continue
		}
		st.packets++
		st.wire += int64(len(data))
		if PCMv4IsHeader(data) {
			st.kind = "pcm v4"
			if _, _, err := v4dec.DecodePacket(data); err != nil {
				return st, fmt.Errorf("v4 decode: %w", err)
			}
			// The header decoder reports where the body starts, which is the
			// only way to split a variable-length header from its payload.
			if _, off, err := hdrProbe.Decode(data); err == nil {
				st.header += int64(off)
			}
			continue
		}
		st.kind = "opus"
		if version >= 4 {
			if _, off, err := opusProbe.DecodeOpus(data); err == nil {
				st.header += int64(off)
			}
		} else if len(data) >= opusHeaderV3 {
			st.header += opusHeaderV3
		}
	}
	if st.kind == "" {
		st.kind = "nothing"
	}
	st.payload = st.wire - st.header
	return st, nil
}

// TestLiveV4RawEquivalent states, for one stream, what the samples would cost
// uncompressed -- because "is this actually compressing anything?" is easy to
// get wrong by assuming the wrong sample rate.
//
// The AM family runs at 24 kHz, not the 12 kHz of the sideband and CW modes
// (see the presets in ../ubersdr-radiod). So raw mono AM is 48 kB/s, and a
// stream at 22 kB/s is compressed better than two to one -- while the same
// 22 kB/s would be barely any compression at all if the rate were 12 kHz.
// The rate the server reports is printed here so the arithmetic is checkable
// rather than assumed.
func TestLiveV4RawEquivalent(t *testing.T) {
	tg := liveConfig(t)
	cases := []struct {
		name      string
		freq      int64
		mode      string
		low, high int
	}{
		{"AM 909 kHz", 909_000, "am", -5000, 5000},
		{"USB 14.074", 14_074_000, "usb", 50, 2700},
	}
	t.Logf("%-14s %6s %4s | %10s %10s %10s | %8s %8s",
		"stream", "Hz", "ch", "raw kB/s", "v3 kB/s", "v4 kB/s", "v4 ratio", "vs raw")
	for _, c := range cases {
		var v3, v4 liveStats
		var e3, e4 error
		done := make(chan struct{}, 2)
		go func() { v3, e3 = runLeg(t, tg, 3, c.freq, c.mode, c.low, c.high, "-999"); done <- struct{}{} }()
		go func() { v4, e4 = runLeg(t, tg, 4, c.freq, c.mode, c.low, c.high, "-999"); done <- struct{}{} }()
		<-done
		<-done
		if e3 != nil || e4 != nil {
			t.Fatalf("legs: %v %v", e3, e4)
		}
		if v4.sampleRate == 0 {
			t.Fatalf("%s: no metadata received", c.name)
		}
		// What the samples themselves weigh, before any header or coding.
		rawKB := float64(v4.sampleRate*v4.channels*2) / 1000
		k3, k4 := v3.kbPerSec(tg.seconds), v4.kbPerSec(tg.seconds)
		t.Logf("%-14s %6d %4d | %10.2f %10.2f %10.2f | %7.2fx %7.2fx",
			c.name, v4.sampleRate, v4.channels, rawKB, k3, k4, k3/k4, rawKB/k4)

		if k4 >= rawKB {
			t.Errorf("%s: version 4 sends %.2f kB/s for samples worth %.2f raw — that is no compression at all",
				c.name, k4, rawKB)
		}
	}
}

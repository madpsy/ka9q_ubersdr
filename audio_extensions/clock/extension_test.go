package clock

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"
)

// The sample<->host mapping and the offset rewritten from it are the only
// original logic in this package — everything else is subprocess plumbing —
// and they are also the part where a mistake is invisible. A wrong sign here
// produces a panel that confidently reports a fast clock as slow; a broken
// ring produces an offset that is quietly anchored on the wrong second. Both
// look completely healthy on screen.

const testRate = 12000

func TestSampleClockNoMarksYet(t *testing.T) {
	c := newSampleClock(testRate)
	if _, ok := c.hostMsAt(0); ok {
		t.Fatal("an empty clock claimed to know when sample 0 happened")
	}
}

func TestSampleClockMapsABlockEndToItsArrival(t *testing.T) {
	c := newSampleClock(testRate)
	// One 20 ms block of 240 samples, arriving at t = 1_000_000 ms.
	const arrivalMs = 1_000_000
	c.advance(240, arrivalMs*int64(1e6))

	// A packet's arrival is taken as the time of its LAST sample: the audio was
	// captured before it was sent, so the end of the block is the closer edge.
	got, ok := c.hostMsAt(240)
	if !ok {
		t.Fatal("no anchor after a block was recorded")
	}
	if math.Abs(got-arrivalMs) > 1e-6 {
		t.Fatalf("end of block: got %.3f ms, want %d ms", got, arrivalMs)
	}

	// Half a block earlier is 10 ms earlier at 12 kHz.
	got, _ = c.hostMsAt(120)
	if math.Abs(got-(arrivalMs-10)) > 1e-6 {
		t.Fatalf("mid block: got %.3f ms, want %d ms", got, arrivalMs-10)
	}

	// And extrapolating forward past the last mark works the same way.
	got, _ = c.hostMsAt(360)
	if math.Abs(got-(arrivalMs+10)) > 1e-6 {
		t.Fatalf("past the last mark: got %.3f ms, want %d ms", got, arrivalMs+10)
	}
}

func TestSampleClockUsesTheNearestMark(t *testing.T) {
	c := newSampleClock(testRate)

	// Ten blocks, 240 samples each, 20 ms apart — and a deliberate 500 ms
	// stall before the last one, as if the receiver hiccupped. Anchoring on
	// the nearest mark rather than interpolating across the gap means the
	// stall does not smear the samples either side of it.
	base := int64(1_000_000)
	for i := 1; i <= 10; i++ {
		c.advance(240, (base+int64(i)*20)*int64(1e6))
	}
	c.advance(240, (base+200+500)*int64(1e6))

	// Sample 2400 is the end of the tenth block, whose mark is exact.
	got, ok := c.hostMsAt(2400)
	if !ok {
		t.Fatal("no anchor")
	}
	if math.Abs(got-float64(base+200)) > 1e-6 {
		t.Fatalf("got %.3f, want %d — it should have used the exact mark, not "+
			"interpolated across the stall", got, base+200)
	}
}

func TestSampleClockRingWrapsWithoutLosingTheRecentPast(t *testing.T) {
	c := newSampleClock(testRate)

	// Overfill the ring by half again. What must survive is the recent end:
	// the voter reaches back at most its 8-frame window, which is minutes,
	// and the ring holds far more than that.
	total := clockMarkCap + clockMarkCap/2
	base := int64(1_000_000)
	for i := 1; i <= total; i++ {
		c.advance(240, (base+int64(i)*20)*int64(1e6))
	}

	last := int64(total) * 240
	got, ok := c.hostMsAt(last)
	if !ok {
		t.Fatal("no anchor after the ring wrapped")
	}
	want := float64(base + int64(total)*20)
	if math.Abs(got-want) > 1e-6 {
		t.Fatalf("after wrap: got %.3f, want %.3f", got, want)
	}
}

func TestSampleClockIgnoresUnstampedBlocks(t *testing.T) {
	c := newSampleClock(testRate)

	// A block with no arrival time still advances the sample count — dropping
	// it would put every later mark at the wrong sample index — but must not
	// become an anchor at the epoch.
	c.advance(240, 0)
	if _, ok := c.hostMsAt(240); ok {
		t.Fatal("an unstamped block was used as an anchor")
	}

	c.advance(240, 1_000_000*int64(1e6))
	got, ok := c.hostMsAt(480)
	if !ok {
		t.Fatal("no anchor after a stamped block")
	}
	if math.Abs(got-1_000_000) > 1e-6 {
		t.Fatalf("got %.3f — the unstamped block should still have advanced the "+
			"sample count", got)
	}
}

// --- rewriteOffset -------------------------------------------------------

func TestRewriteOffsetPassesThroughEventsItDoesNotUnderstand(t *testing.T) {
	e := &ClockExtension{sampleRate: testRate, clock: newSampleClock(testRate)}
	e.clock.advance(240, 1_000_000*int64(1e6))

	// Returned byte-for-byte, not round-tripped through a map: this understands
	// the one field it rewrites and nothing else, so an event type added to the
	// binary later reaches the panel exactly as it was sent.
	for _, line := range []string{
		`{"type":"second","symbol":1}`,
		`{"type":"diag","anchored":true}`,
		`{"type":"state","state":"locked"}`,
		`{"type":"something_new","whatever":[1,2,3]}`,
		`{"type":"time"}`, // no utc_ms / last_edge_sample
	} {
		got, ok := e.rewriteOffset([]byte(line))
		if !ok {
			t.Fatalf("dropped a valid event: %s", line)
		}
		if string(got) != line {
			t.Fatalf("rewrote a line it should not have:\n  in  %s\n  out %s", line, got)
		}
	}
}

func TestRewriteOffsetDropsWhatIsNotAnEvent(t *testing.T) {
	e := &ClockExtension{sampleRate: testRate, clock: newSampleClock(testRate)}

	// The read loop drops on ok=false. Validating here rather than leaving it
	// to the panel means a decoder that starts printing rubbish cannot reach
	// the frontend at all.
	for _, line := range []string{
		`not json at all`,
		`{ broken json`,
		`null`,
		`[1,2,3]`,
		`"a string"`,
		`42`,
		``,
	} {
		if _, ok := e.rewriteOffset([]byte(line)); ok {
			t.Fatalf("forwarded something that is not an event: %q", line)
		}
	}
}

func TestRewriteOffsetWithNoAnchorLeavesTheLineAlone(t *testing.T) {
	e := &ClockExtension{sampleRate: testRate, clock: newSampleClock(testRate)}
	line := `{"type":"time","utc_ms":1000000,"last_edge_sample":240,"offset_ms":42}`
	got, ok := e.rewriteOffset([]byte(line))
	if !ok {
		t.Fatal("a valid time event was dropped")
	}
	if string(got) != line {
		t.Fatalf("with no anchor the binary's own offset must survive; got %s", got)
	}
}

func TestRewriteOffsetSign(t *testing.T) {
	// The sign convention is the decoder's: offset = broadcast - clock, so a
	// POSITIVE offset means the host clock reads earlier than the broadcast,
	// i.e. the clock is behind. The panel says "behind" on a positive number,
	// so getting this backwards mislabels every reading.
	cases := []struct {
		name        string
		broadcastMs int64
		hostMs      int64
		wantOffset  float64
	}{
		{"clock behind by 250 ms", 1_000_000_250, 1_000_000_000, 250},
		{"clock ahead by 250 ms", 1_000_000_000, 1_000_000_250, -250},
		{"in step", 1_000_000_000, 1_000_000_000, 0},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := &ClockExtension{sampleRate: testRate, clock: newSampleClock(testRate)}
			// One block ending at sample 240, arriving at the host time.
			e.clock.advance(240, tc.hostMs*int64(1e6))

			in, err := json.Marshal(map[string]interface{}{
				"type":             "time",
				"utc_ms":           tc.broadcastMs,
				"last_edge_sample": 240,
				"offset_ms":        99999.0, // the binary's own, to be replaced
			})
			if err != nil {
				t.Fatal(err)
			}

			rewritten, ok := e.rewriteOffset(in)
			if !ok {
				t.Fatal("a valid time event was dropped")
			}
			var out map[string]interface{}
			if err := json.Unmarshal(rewritten, &out); err != nil {
				t.Fatalf("the rewrite produced invalid JSON: %v", err)
			}

			got, ok := out["offset_ms"].(float64)
			if !ok {
				t.Fatalf("offset_ms missing or not a number: %v", out["offset_ms"])
			}
			if math.Abs(got-tc.wantOffset) > 1e-6 {
				t.Fatalf("offset_ms = %.3f, want %.3f", got, tc.wantOffset)
			}
			if out["offset_source"] != "packet" {
				t.Fatalf("offset_source = %v, want packet — the panel uses this to "+
					"say which clock the number is against", out["offset_source"])
			}
			// Everything else must survive the round trip.
			if out["type"] != "time" {
				t.Fatalf("type was lost: %v", out["type"])
			}
		})
	}
}

func TestRewriteOffsetPreservesTheRestOfTheEvent(t *testing.T) {
	e := &ClockExtension{sampleRate: testRate, clock: newSampleClock(testRate)}
	e.clock.advance(240, 1_000_000_000*int64(1e6))

	in := `{"type":"time","utc":"2026-09-07T07:01:59Z","utc_ms":1000000000000,` +
		`"minute":1,"hour":7,"doy":250,"year2":26,"quality":100,` +
		`"offset_ms":1,"last_edge_sample":240,"frame_start_sample":0,"station":"wwv"}`

	rewritten, ok := e.rewriteOffset([]byte(in))
	if !ok {
		t.Fatal("a valid time event was dropped")
	}
	var out map[string]interface{}
	if err := json.Unmarshal(rewritten, &out); err != nil {
		t.Fatalf("invalid JSON out: %v", err)
	}
	for _, k := range []string{"utc", "minute", "hour", "doy", "year2", "quality", "station", "frame_start_sample"} {
		if _, ok := out[k]; !ok {
			t.Fatalf("%q was dropped by the rewrite", k)
		}
	}
	if out["station"] != "wwv" {
		t.Fatalf("station = %v", out["station"])
	}
}

func TestRewriteOffsetKeepsTheDecodersOwnCorrections(t *testing.T) {
	// The binary folds its measured corrections into offset_ms before sending
	// it — the WWV decoder reports every second edge 13.645 ms early, and
	// --extra-delay-ms carries whatever path delay the caller modelled.
	// Re-anchoring replaces the RAW difference, so those corrections have to be
	// added back on or the rewrite quietly undoes them and the offset reads
	// 13.6 ms long for ever. That is a systematic, not noise: it never averages
	// out and nothing downstream can see it.
	const edge = 240
	const utcMs = 1_000_000_000_000
	// The mark puts the host clock exactly on the decoded time at that sample,
	// so the raw difference is 0 and whatever comes out IS the correction.
	e := &ClockExtension{sampleRate: testRate, clock: newSampleClock(testRate)}
	e.clock.advance(edge, utcMs*int64(1e6))

	for _, tc := range []struct {
		name    string
		applied string
		want    float64
	}{
		{"the WWV edge bias", `,"delay_applied_ms":-13.645`, -13.645},
		{"bias plus a modelled path", `,"delay_applied_ms":11.355`, 11.355},
		{"WWVB, which needs none", `,"delay_applied_ms":0`, 0},
		{"an older binary that reports none", "", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			line := fmt.Sprintf(
				`{"type":"time","utc_ms":%d,"offset_ms":999,"last_edge_sample":%d%s}`,
				utcMs, edge, tc.applied)
			rewritten, ok := e.rewriteOffset([]byte(line))
			if !ok {
				t.Fatal("a valid time event was dropped")
			}
			var out map[string]interface{}
			if err := json.Unmarshal(rewritten, &out); err != nil {
				t.Fatalf("invalid JSON out: %v", err)
			}
			got, _ := out["offset_ms"].(float64)
			if math.Abs(got-tc.want) > 1e-6 {
				t.Fatalf("offset_ms = %v, want %v — the decoder's correction was "+
					"lost in the re-anchoring", got, tc.want)
			}
		})
	}
}

// --- station selection ---------------------------------------------------

func TestStationComesFromTheDial(t *testing.T) {
	// The stations need genuinely different decoders, and the choice is made
	// before the subprocess starts — so it has to come from the dial, and it
	// has to agree with what the panel says it did (stationFor in
	// static/v2/src/extensions/clock/frames.js).
	fakeBinary(t, "cat >/dev/null")
	cases := []struct {
		dial uint64
		want string
	}{
		{59_000, "wwvb"},
		{wwvbCeilingHz - 1, "wwvb"},
		{wwvbCeilingHz, "wwv"},
		{9_999_000, "wwv"},
		{0, "wwv"}, // unknown dial: WWV is the safe default, WWVB is the special case
		// DCF77 sits below the WWVB ceiling, so it has to be checked first.
		{dcf77CarrierHz, "dcf77"},
		{dcf77CarrierHz - dcf77WindowHz, "dcf77"},
		{dcf77CarrierHz + dcf77WindowHz, "dcf77"},
		{dcf77CarrierHz - dcf77WindowHz - 1, "wwvb"},
		{dcf77CarrierHz + dcf77WindowHz + 1, "wwvb"},
	}

	for _, tc := range cases {
		if got := stationForDial(tc.dial); got != tc.want {
			t.Fatalf("dial %d Hz selected %q, want %q", tc.dial, got, tc.want)
		}
		ext, err := NewClockExtension(12000, channelsFor(tc.want), map[string]interface{}{
			"tuned_frequency_hz": float64(tc.dial),
		})
		if err != nil {
			t.Fatalf("dial %d Hz: %v", tc.dial, err)
		}
		if ext.station != tc.want {
			t.Fatalf("dial %d Hz built %q, want %q", tc.dial, ext.station, tc.want)
		}
	}
}

func TestChannelsMustMatchTheStation(t *testing.T) {
	// The mode can change under an attached extension without it being
	// rebuilt, so the attach is the one point a decoder can be refused the
	// wrong kind of samples: mono read as I/Q pairs, or I/Q read as audio,
	// acquires for ever with nothing to say why.
	fakeBinary(t, "cat >/dev/null")
	cases := []struct {
		dial     uint64
		channels int
		ok       bool
		mention  string
	}{
		{dcf77CarrierHz, 2, true, ""},
		{dcf77CarrierHz, 1, false, "IQ"},
		{9_999_000, 1, true, ""},
		{9_999_000, 2, false, "USB"},
		{59_000, 2, false, "USB"},
	}
	for _, tc := range cases {
		_, err := NewClockExtension(12000, tc.channels, map[string]interface{}{
			"tuned_frequency_hz": float64(tc.dial),
		})
		if tc.ok && err != nil {
			t.Fatalf("dial %d Hz, %d ch: refused: %v", tc.dial, tc.channels, err)
		}
		if !tc.ok {
			if err == nil {
				t.Fatalf("dial %d Hz, %d ch: accepted", tc.dial, tc.channels)
			}
			if !strings.Contains(err.Error(), tc.mention) {
				t.Fatalf("dial %d Hz, %d ch: %q does not say which mode to use (%s)",
					tc.dial, tc.channels, err, tc.mention)
			}
		}
	}
}

func TestDcf77PassesTheCarrierOffsetAndCountsFrames(t *testing.T) {
	// The binary is told where the carrier sits in the baseband, and the
	// sample clock counts I/Q frames rather than int16 values — the binary's
	// edge_sample counts frames, so counting values would put every offset
	// out by half the elapsed time.
	fakeBinary(t, `printf '{"type":"args","v":"%s"}\n' "$*"; cat >/dev/null`)
	ext, err := NewClockExtension(12000, 2, map[string]interface{}{
		"tuned_frequency_hz": float64(78_000),
	})
	if err != nil {
		t.Fatalf("constructor: %v", err)
	}
	audioChan := make(chan AudioSample, 4)
	resultChan := make(chan []byte, 4)
	if err := ext.Start(audioChan, resultChan); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer ext.Stop()

	select {
	case line := <-resultChan:
		var ev struct{ V string }
		if err := json.Unmarshal(line, &ev); err != nil {
			t.Fatalf("args line %q: %v", line, err)
		}
		if !strings.Contains(ev.V, "--station dcf77") || !strings.Contains(ev.V, "--carrier-offset-hz -500") {
			t.Fatalf("binary started with %q", ev.V)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the fake binary never reported its arguments")
	}

	audioChan <- AudioSample{PCMData: make([]int16, 480), GPSTimeNs: time.Now().UnixNano()}
	deadline := time.Now().Add(2 * time.Second)
	for {
		ext.clock.mu.Lock()
		total := ext.clock.total
		ext.clock.mu.Unlock()
		if total == 240 {
			break
		}
		if total != 0 || time.Now().After(deadline) {
			t.Fatalf("480 int16s of I/Q counted as %d samples, want 240 frames", total)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestUnevenSampleRateIsRefused(t *testing.T) {
	// 200 Hz is the WWV series rate; a rate that is not a multiple of it
	// decimates unevenly and drifts. Every UberSDR mode rate clears this, so
	// this is about failing loudly if one ever does not.
	if _, err := NewClockExtension(12345, 1, nil); err == nil {
		t.Fatal("an indivisible sample rate was accepted")
	}
}

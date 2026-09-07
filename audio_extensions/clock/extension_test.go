package clock

import (
	"encoding/json"
	"math"
	"testing"
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

// --- station selection ---------------------------------------------------

func TestStationComesFromTheDial(t *testing.T) {
	// The two stations need genuinely different decoders, and the choice is
	// made before the subprocess starts — so it has to come from the dial, and
	// it has to agree with what the panel says it did (stationFor in
	// static/v2/src/extensions/clock/frames.js).
	cases := []struct {
		dial uint64
		want string
	}{
		{59_000, "wwvb"},
		{wwvbCeilingHz - 1, "wwvb"},
		{wwvbCeilingHz, "wwv"},
		{9_999_000, "wwv"},
		{0, "wwv"}, // unknown dial: WWV is the safe default, WWVB is the special case
	}

	for _, tc := range cases {
		ext, err := NewClockExtension(12000, map[string]interface{}{
			"tuned_frequency_hz": float64(tc.dial),
		})
		if err != nil {
			t.Skipf("ubersdr-clock not installed: %v", err)
		}
		if ext.station != tc.want {
			t.Fatalf("dial %d Hz selected %q, want %q", tc.dial, ext.station, tc.want)
		}
	}
}

func TestUnevenSampleRateIsRefused(t *testing.T) {
	// 200 Hz is the WWV series rate; a rate that is not a multiple of it
	// decimates unevenly and drifts. Every UberSDR mode rate clears this, so
	// this is about failing loudly if one ever does not.
	if _, err := NewClockExtension(12345, nil); err == nil {
		t.Fatal("an indivisible sample rate was accepted")
	}
}

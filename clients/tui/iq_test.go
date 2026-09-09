package main

import (
	"bytes"
	"encoding/binary"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gdamore/tcell/v2"
	"github.com/gorilla/websocket"
)

// The wide IQ modes are gated per session: which of them a receiver offers
// depends on the caller's address and password, so the answer arrives with the
// /connection handshake and nowhere else. Plain iq is never listed because it
// is open to everyone.
func TestAllowedIQModesGateTheWideOnes(t *testing.T) {
	u := NewUI("test")

	// Before the handshake answers, no wide mode is available. That is the safe
	// direction: asking for one this session cannot have is refused at the
	// socket, and offering it in the cycle would be offering nothing.
	for _, name := range []string{"iq48", "iq96", "iq192", "iq384"} {
		if u.modeAvailable(name) {
			t.Errorf("%s was available before the handshake answered", name)
		}
	}
	for _, name := range []string{"usb", "lsb", "am", "fm", "iq"} {
		if !u.modeAvailable(name) {
			t.Errorf("%s was gated; only the wide IQ modes are", name)
		}
	}

	u.allowedIQ = []string{"iq48", "iq96"}
	if !u.modeAvailable("iq48") || !u.modeAvailable("iq96") {
		t.Error("a mode the receiver offered was not available")
	}
	if u.modeAvailable("iq192") || u.modeAvailable("iq384") {
		t.Error("a mode the receiver did not offer was available")
	}
}

// The list the server sends is filtered against the mode table and put back in
// the table's own order, so a newer receiver naming a mode this build cannot
// describe does not reach the cycle, and the cycle does not jump about because
// the receiver listed its modes in a different order.
func TestAllowedIQModesAreFilteredAndOrdered(t *testing.T) {
	got := filterKnownModes([]string{"iq384", "iq96", "iq768", "IQ48", " iq192 "})
	want := []string{"iq48", "iq96", "iq192", "iq384"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("got %v, want %v", got, want)
	}
	if filterKnownModes(nil) != nil {
		t.Error("an empty list should stay empty")
	}
	// Plain iq is not a wide mode and is never gated, so it must not appear
	// even if a receiver names it.
	if got := filterKnownModes([]string{"iq", "usb"}); got != nil {
		t.Errorf("got %v, want nothing: neither is a gated mode", got)
	}
}

// Cycling skips what this session cannot have. A cycle that stopped on a mode
// nothing could select would simply look broken.
func TestStepModeSkipsUnavailableModes(t *testing.T) {
	u := NewUI("test")
	u.ApplyMode("fm") // the last demodulated mode, so iq is next

	u.StepMode(+1)
	if u.audioMode != "iq" {
		t.Fatalf("stepping past the demodulators gave %q, want iq", u.audioMode)
	}
	// With no wide modes offered, the cycle wraps straight back to the top.
	u.StepMode(+1)
	if u.audioMode != "usb" {
		t.Errorf("stepping past iq with no wide modes gave %q, want usb", u.audioMode)
	}

	// Offered one, the cycle includes it and nothing else.
	u.allowedIQ = []string{"iq192"}
	u.ApplyMode("iq")
	u.StepMode(+1)
	if u.audioMode != "iq192" {
		t.Errorf("stepping to the one offered wide mode gave %q, want iq192", u.audioMode)
	}
	u.StepMode(+1)
	if u.audioMode != "usb" {
		t.Errorf("stepping past it gave %q, want usb", u.audioMode)
	}

	// And backwards.
	u.StepMode(-1)
	if u.audioMode != "iq192" {
		t.Errorf("stepping back gave %q, want iq192", u.audioMode)
	}
}

// Landing on a mode the receiver will not serve has to be recoverable: -mode is
// applied before the handshake can say whether it is allowed.
func TestUnavailableModeFallsBack(t *testing.T) {
	e := &eventLoop{ui: NewUI("test")}
	e.ui.ApplyMode("iq384")

	e.applyAllowedIQ([]string{"iq48"})
	if e.ui.audioMode != "usb" {
		t.Errorf("a refused mode left the client on %q, want usb", e.ui.audioMode)
	}
	if !strings.Contains(e.ui.status, "IQ384") || !strings.Contains(e.ui.status, "IQ48") {
		t.Errorf("the message says neither what was refused nor what is on offer: %q", e.ui.status)
	}

	// A mode that is allowed is left alone.
	e2 := &eventLoop{ui: NewUI("test")}
	e2.ui.ApplyMode("iq48")
	e2.applyAllowedIQ([]string{"iq48"})
	if e2.ui.audioMode != "iq48" {
		t.Errorf("an allowed mode was changed to %q", e2.ui.audioMode)
	}
}

// IQ bandwidth is fixed. The wide modes are never sent one at all, and plain iq
// is sent the preset's own edges — narrowing either would put a filter inside
// the quadrature baseband, so the top and bottom of every capture would come
// back empty with nothing to say why.
func TestIQFilterCannotBeMoved(t *testing.T) {
	for _, name := range []string{"iq", "iq48", "iq384"} {
		u := NewUI("test")
		u.ApplyMode(name)
		low, high := u.bwLow, u.bwHigh

		u.AdjustBandwidth(-100)
		u.AdjustBandwidth(+100)
		if u.bwLow != low || u.bwHigh != high {
			t.Errorf("%s: the filter moved to %+d/%+d from %+d/%+d", name, u.bwLow, u.bwHigh, low, high)
		}

		p := NewAudioPanel(nil, nil)
		key := func(k tcell.Key) *tcell.EventKey { return tcell.NewEventKey(k, 0, tcell.ModNone) }
		for _, row := range []int{rowBandLow, rowBandHigh} {
			p.row = row
			if retune, _, _ := p.HandleKey(key(tcell.KeyRight), u, ""); retune {
				t.Errorf("%s: the panel asked for a retune on a filter that cannot move", name)
			}
		}
		if u.bwLow != low || u.bwHigh != high {
			t.Errorf("%s: the panel moved the filter to %+d/%+d", name, u.bwLow, u.bwHigh)
		}
	}

	// A demodulated mode still moves, or the guard has caught everything.
	u := NewUI("test")
	u.ApplyMode("usb")
	u.AdjustBandwidth(+100)
	if u.bwHigh == 2700 {
		t.Error("the filter no longer moves on USB either")
	}
}

// What goes on the wire: the wide IQ modes carry no bandwidth, because the
// server keeps the radiod preset's and skips the filter command entirely.
// Everything else does, plain iq included — its edges ARE the preset's, which
// is what makes selecting it move no filter.
func TestWideIQSendsNoBandwidth(t *testing.T) {
	for _, tc := range []struct {
		mode      string
		wantEdges bool
	}{
		{"usb", true}, {"am", true}, {"iq", true},
		{"iq48", false}, {"iq96", false}, {"iq192", false}, {"iq384", false},
	} {
		m, _ := lookupMode(tc.mode)
		q := connectQuery(t, func(a *AudioClient) {
			a.SetTuning(7_100_000, tc.mode, m.Low, m.High)
		})
		if got := q.Get("mode"); got != tc.mode {
			t.Errorf("%s: connected as %q", tc.mode, got)
		}
		hasEdges := q.Get("bandwidthLow") != "" || q.Get("bandwidthHigh") != ""
		if hasEdges != tc.wantEdges {
			t.Errorf("%s: bandwidth on the wire = %v, want %v", tc.mode, hasEdges, tc.wantEdges)
		}
	}
}

// The reduced-depth request rides the query string, and only for IQ: the server
// never quantises a demodulated channel, so asking there would be asking for
// something that cannot happen.
func TestMinMarginIsSentForIQOnly(t *testing.T) {
	for _, tc := range []struct {
		mode   string
		margin int
		want   string
	}{
		{"iq", 15, "15"},
		{"iq384", 26, "26"},
		{"iq384", 0, ""},  // 0 asks for the lossless IQ stream
		{"usb", 26, ""},   // nothing to quantise
		{"iq", 200, "60"}, // clamped to what the server honours
		{"iq", 3, ""},     // under the floor is off, as the panel's step is
	} {
		q := connectQuery(t, func(a *AudioClient) {
			a.SetTuning(7_100_000, tc.mode, -6000, 6000)
			a.SetMinMargin(tc.margin)
		})
		if got := q.Get("min_margin"); got != tc.want {
			t.Errorf("%s at %d dB sent min_margin=%q, want %q", tc.mode, tc.margin, got, tc.want)
		}
	}
}

// The margin steps like the squelch: off, then the floor of the range, and
// stepping below the floor asks for the lossless stream rather than a margin
// the server would not honour.
func TestMinMarginSteps(t *testing.T) {
	u := NewUI("test")
	u.minMargin = 0

	u.StepMinMargin(+1)
	if u.minMargin != marginMin {
		t.Errorf("the first step gave %d, want %d", u.minMargin, marginMin)
	}
	u.StepMinMargin(+1)
	if u.minMargin != marginMin+1 {
		t.Errorf("stepping gave %d, want %d", u.minMargin, marginMin+1)
	}
	u.StepMinMargin(-1)
	u.StepMinMargin(-1)
	if u.minMargin != 0 {
		t.Errorf("stepping below the floor gave %d, want 0", u.minMargin)
	}
	u.StepMinMargin(-1)
	if u.minMargin != 0 {
		t.Errorf("stepping below off gave %d, want 0", u.minMargin)
	}
	for i := 0; i < 100; i++ {
		u.StepMinMargin(+1)
	}
	if u.minMargin != marginMax {
		t.Errorf("stepping up clamped at %d, want %d", u.minMargin, marginMax)
	}
}

// Switching into an IQ mode is what makes a margin set earlier take effect, and
// switching out withdraws it — so the mode change has to tell the server, and
// nothing else should: retuning goes through the same path on every dial step.
func TestMarginFollowsTheModeWithoutRepeating(t *testing.T) {
	sent := make(chan int, 8)
	queries := make(chan url.Values, 4)
	a, cancel := connectTo(t, func(w http.ResponseWriter, r *http.Request) {
		queries <- r.URL.Query()
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			var msg struct {
				Type      string   `json:"type"`
				MinMargin *float64 `json:"min_margin"`
			}
			if err := conn.ReadJSON(&msg); err != nil {
				return
			}
			if msg.Type == "set_min_margin" && msg.MinMargin != nil {
				sent <- int(*msg.MinMargin)
			}
		}
	}, func(a *AudioClient) {
		a.SetTuning(7_100_000, "usb", 50, 2700)
		a.SetMinMargin(26)
	})
	defer cancel()

	q := waitQuery(t, queries)
	if got := q.Get("min_margin"); got != "" {
		t.Fatalf("a USB session asked for min_margin=%q", got)
	}
	waitConnected(t, a)

	// Retuning inside the same mode must send nothing: the effective value has
	// not moved, and this path runs on every dial step. The gaps are the
	// client's own 10/s command budget, which would otherwise drop these.
	for i := 0; i < 3; i++ {
		a.Tune(7_100_000+float64(i*100), "usb", 50, 2700)
		time.Sleep(2 * minCommandDelay)
	}
	select {
	case got := <-sent:
		t.Fatalf("retuning inside one mode sent min_margin=%d", got)
	default:
	}

	a.Tune(14_074_000, "iq384", -192000, 192000)
	select {
	case got := <-sent:
		if got != 26 {
			t.Errorf("switching to IQ sent %d dB, want 26", got)
		}
	case <-timeoutAfter():
		t.Fatal("switching to an IQ mode never applied the margin")
	}

	time.Sleep(2 * minCommandDelay)
	a.Tune(14_074_000, "usb", 50, 2700)
	select {
	case got := <-sent:
		if got != 0 {
			t.Errorf("switching away from IQ sent %d dB, want 0", got)
		}
	case <-timeoutAfter():
		t.Fatal("switching away from IQ never withdrew the margin")
	}
}

func timeoutAfter() <-chan struct{} {
	ch := make(chan struct{})
	go func() {
		defer close(ch)
		<-time.After(10 * time.Second)
	}()
	return ch
}

// An IQ stream reaches the sinks as two channels at the receiver's own rate,
// and each sink takes what it needs: the sound device gets stereo at the output
// rate, stdout gets the samples exactly as they arrived.
func TestIQReachesBothSinksCorrectly(t *testing.T) {
	var sink bytes.Buffer
	out := NewAudioOutput()
	out.pipe = newPCMWriter(&sink, StdoutRaw)
	defer out.Close()

	// A 20 ms iq384 packet: 7680 interleaved I/Q pairs.
	const frames = 384000 / 50
	pkt := AudioPacket{Samples: make([]int16, frames*2), Rate: 384000, Channels: 2}
	for i := 0; i < frames; i++ {
		pkt.Samples[i*2] = 1000   // I
		pkt.Samples[i*2+1] = -500 // Q
	}
	out.Push(pkt)

	// The device gets 20 ms at the output rate, whatever the stream's rate was.
	buffered, _, _ := out.Stats()
	if want := opusOutputRate / 50; buffered < want-2 || buffered > want+2 {
		t.Errorf("the mixer holds %d frames, want about %d", buffered, want)
	}

	out.Close()
	// Stdout gets every sample, unconverted: decimating a capture to 48 kHz
	// would throw away seven eighths of the band it was taken for.
	if got, want := sink.Len(), frames*2*2; got != want {
		t.Errorf("the pipe carried %d bytes, want %d", got, want)
	}
}

// I on the left and Q on the right. Folding them together would destroy exactly
// what makes the stream IQ, and putting the same channel on both sides would
// silently throw one half away.
func TestIQKeepsBothChannelsApart(t *testing.T) {
	// 48 kHz needs no rate conversion, so the samples come through untouched
	// and the mapping is visible rather than filtered.
	const frames = 960
	pkt := AudioPacket{Samples: make([]int16, frames*2), Rate: opusOutputRate, Channels: 2}
	for i := 0; i < frames; i++ {
		pkt.Samples[i*2] = 4000
		pkt.Samples[i*2+1] = -4000
	}

	c := newDeviceConverter(pkt)
	stereo := c.convert(pkt)
	if len(stereo) != frames*2 {
		t.Fatalf("converted to %d values, want %d", len(stereo), frames*2)
	}
	for i := 0; i < frames; i++ {
		if stereo[i*2] != 4000 || stereo[i*2+1] != -4000 {
			t.Fatalf("frame %d is %d/%d, want 4000/-4000 — I left, Q right",
				i, stereo[i*2], stereo[i*2+1])
		}
	}

	// One channel still plays on both sides, which is what demodulated audio
	// has always done.
	mono := AudioPacket{Samples: []int16{1, 2, 3}, Rate: opusOutputRate, Channels: 1}
	c = newDeviceConverter(mono)
	got := c.convert(mono)
	want := []int16{1, 1, 2, 2, 3, 3}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("mono converted to %v, want %v", got, want)
		}
	}
}

// The converter is rebuilt when the stream changes shape, which is what a mode
// change looks like from the output's side.
func TestDeviceConverterFollowsTheStream(t *testing.T) {
	usb := AudioPacket{Samples: make([]int16, 240), Rate: 12000, Channels: 1}
	c := newDeviceConverter(usb)
	if !c.matches(usb) {
		t.Error("the converter did not match the stream it was built for")
	}
	for _, other := range []AudioPacket{
		{Rate: 24000, Channels: 1},  // a change of demodulated mode
		{Rate: 12000, Channels: 2},  // usb to iq, the same rate
		{Rate: 384000, Channels: 2}, // iq to iq384
	} {
		if c.matches(other) {
			t.Errorf("a converter for %d Hz / %d ch matched %d Hz / %d ch",
				usb.Rate, usb.Channels, other.Rate, other.Channels)
		}
	}
}

// The WAV header has to describe what was actually captured. A file that says
// 48 kHz mono over 384 kHz stereo IQ plays as noise at an eighth speed and
// gives no clue why.
func TestWAVHeaderFollowsTheStream(t *testing.T) {
	var sink bytes.Buffer
	p := newPCMWriter(&sink, StdoutWAV)
	p.push(AudioPacket{Samples: []int16{1, 2, 3, 4}, Rate: 384000, Channels: 2})
	p.Close()

	b := sink.Bytes()
	if len(b) < wavHeaderLen {
		t.Fatalf("wrote %d bytes, no header", len(b))
	}
	le := binary.LittleEndian
	if got := le.Uint16(b[22:]); got != 2 {
		t.Errorf("header says %d channels, want 2", got)
	}
	if got := le.Uint32(b[24:]); got != 384000 {
		t.Errorf("header says %d Hz, want 384000", got)
	}
	if got := le.Uint32(b[28:]); got != 384000*2*2 {
		t.Errorf("header says %d bytes per second, want %d", got, 384000*2*2)
	}
	if got := le.Uint16(b[32:]); got != 4 {
		t.Errorf("header says a block align of %d, want 4", got)
	}
}

// A WAV capture cannot follow a change of stream shape — the header is already
// written and cannot be rewritten — so it stops and says so rather than
// producing a file that lies about its own contents. Raw has no header, so it
// carries on and tells the reader instead.
func TestStdoutReportsAChangeOfStreamShape(t *testing.T) {
	for _, tc := range []struct {
		mode      StdoutMode
		wantBytes int
	}{
		{StdoutWAV, wavHeaderLen + 4}, // the header and the first packet only
		{StdoutRaw, 8},                // both packets
	} {
		var sink bytes.Buffer
		p := newPCMWriter(&sink, tc.mode)
		p.push(AudioPacket{Samples: []int16{1, 2}, Rate: 12000, Channels: 1})
		p.push(AudioPacket{Samples: []int16{3, 4}, Rate: 384000, Channels: 2})
		p.Close()

		_, _, err := p.stats()
		if err == nil {
			t.Errorf("%v: a change of stream shape went unreported", tc.mode)
		} else if !strings.Contains(err.Error(), "384 kHz stereo") {
			t.Errorf("%v: unhelpful message %q", tc.mode, err)
		}
		if got := sink.Len(); got != tc.wantBytes {
			t.Errorf("%v: wrote %d bytes, want %d", tc.mode, got, tc.wantBytes)
		}
	}
}

// Plain iq is always available. It is 12 kHz, it is not in the wide set the
// server gates, and it never appears in allowed_iq_modes at all — so a receiver
// that offers none of the wide modes, which is what a public one looks like,
// must still let a session select it.
//
// This walks every place the gate is applied, because the distinction it turns
// on is one letter: isWideIQMode gates, isIQMode does not.
func TestPlainIQIsAlwaysAvailable(t *testing.T) {
	if isWideIQMode("iq") {
		t.Fatal("iq is treated as a gated mode")
	}
	if !isIQMode("iq") {
		t.Fatal("iq is not treated as a quadrature mode")
	}

	// The receiver offers no wide modes — a public one, or a session before the
	// handshake has answered.
	u := NewUI("test")
	u.allowedIQ = nil
	if !u.modeAvailable("iq") {
		t.Error("iq was unavailable with an empty allowed list")
	}

	// It is reachable by cycling, with nothing else IQ in the way.
	u.ApplyMode("fm")
	u.StepMode(+1)
	if u.audioMode != "iq" {
		t.Errorf("cycling with no wide modes offered reached %q, want iq", u.audioMode)
	}

	// Landing on it is never overridden when the handshake answers with
	// nothing, which is what happens to a wide mode in the same position.
	e := &eventLoop{ui: NewUI("test")}
	e.ui.ApplyMode("iq")
	e.applyAllowedIQ(nil)
	if e.ui.audioMode != "iq" {
		t.Errorf("an empty allowed list moved the client off iq to %q", e.ui.audioMode)
	}

	// The server never lists it, so a receiver that did must not have it echoed
	// back as though it were a wide mode.
	if got := filterKnownModes([]string{"iq"}); got != nil {
		t.Errorf("iq reached the gated list as %v", got)
	}

	// A receiver naming it as its default is honoured, unlike a wide mode,
	// which is refused because it is gated and expensive.
	if _, mode := (Description{DefaultFrequency: 7_100_000, DefaultMode: "iq"}).Defaults(); mode != "iq" {
		t.Errorf("a receiver defaulting to iq opened on %q", mode)
	}

	// And on the wire it is a plain mode request: no gate to pass, and the
	// preset's own edges, which is what makes selecting it move no filter.
	m, _ := lookupMode("iq")
	q := connectQuery(t, func(a *AudioClient) { a.SetTuning(7_100_000, "iq", m.Low, m.High) })
	if q.Get("mode") != "iq" {
		t.Errorf("connected as %q", q.Get("mode"))
	}
	if q.Get("bandwidthLow") != "-6000" || q.Get("bandwidthHigh") != "6000" {
		t.Errorf("iq asked for %s/%s Hz, want the preset's -6000/6000",
			q.Get("bandwidthLow"), q.Get("bandwidthHigh"))
	}
}

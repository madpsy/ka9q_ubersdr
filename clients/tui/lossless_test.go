package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gdamore/tcell/v2"
	"github.com/gorilla/websocket"
)

// The format is negotiated in the query string at connect, so -lossless has to
// reach the server there or it does nothing at all. Version 4 is asked for
// either way: it is the only protocol this client reads.
func TestSessionRequestsTheChosenFormat(t *testing.T) {
	for _, tc := range []struct {
		format AudioFormat
		want   string
	}{
		{FormatOpus, "opus"},
		{FormatLossless, "pcm-zstd"},
	} {
		q := connectQuery(t, func(a *AudioClient) { a.SetFormat(tc.format) })
		if got := q.Get("format"); got != tc.want {
			t.Errorf("%v asked for format %q, want %q", tc.format, got, tc.want)
		}
		if got := q.Get("version"); got != "4" {
			t.Errorf("%v asked for version %q, want 4", tc.format, got)
		}
	}

	// The default is what a client with no -lossless flag sends.
	if got := connectQuery(t, func(*AudioClient) {}).Get("format"); got != "opus" {
		t.Errorf("default format is %q, want opus", got)
	}
}

// A lossless stream must decode all the way through to samples at the output
// rate: through the frame discrimination, the predictive codec, the fold to
// mono and the rate conversion, in the shapes the real socket delivers them.
//
// The fixture changes sample rate part-way, from the 12 kHz of the sideband
// modes to the 24 kHz of AM and FM, which is what a mode change looks like on
// the wire. Both must come back at the one rate the output path runs at, or a
// mode change plays at half or double speed.
func TestLosslessStreamPlaysAtTheOutputRate(t *testing.T) {
	packets := readV4Fixture(t)[:140] // 12 kHz throughout, then 24 kHz

	a, cancel := connectTo(t, serveFrames(t, packets), func(a *AudioClient) {
		a.SetFormat(FormatLossless)
	})
	defer cancel()

	// A 20 ms packet, which is 240 samples at 12 kHz and 480 at 24 — the
	// receiver's own rate, since nothing on this path converts.
	const want = 20
	deadline := time.After(10 * time.Second)
	rates := map[int]bool{}
	got := 0
	// Past the rate change at packet 120, with margin: 140 were sent.
	for got < 130 {
		select {
		case pcm := <-a.PCM:
			if ms := pcm.Frames() * 1000 / pcm.Rate; ms != want {
				t.Fatalf("delivery %d carried %d ms (%d frames at %d Hz), want %d ms",
					got, ms, pcm.Frames(), pcm.Rate, want)
			}
			got++
		case sig := <-a.Level:
			if !sig.Lossless {
				t.Fatal("a reading off a lossless packet was not marked as one")
			}
			rates[sig.SourceRate] = true
		case msg := <-a.Status:
			if strings.Contains(msg, "disconnected") {
				t.Fatalf("stream failed: %s", msg)
			}
		case <-deadline:
			t.Fatalf("only %d packets played in ten seconds", got)
		}
	}

	// Drain what the level channel still holds, so the rate change is seen
	// whichever order the two channels filled in.
	for len(a.Level) > 0 {
		rates[(<-a.Level).SourceRate] = true
	}
	for _, r := range []int{12000, 24000} {
		if !rates[r] {
			t.Errorf("no %d Hz reading seen; got %v", r, rates)
		}
	}
}

// A session that asked for Opus can be answered with lossless PCM: the server
// chooses per packet, and one built without libopus has nothing else to send.
// That used to drop the socket, which left such a receiver unlistenable. It now
// plays, and says once that it is not what was asked for.
func TestLosslessReachesAnOpusSession(t *testing.T) {
	a, cancel := connectTo(t, serveFrames(t, readV4Fixture(t)[:20]), func(*AudioClient) {})
	defer cancel()

	deadline := time.After(10 * time.Second)
	told := false
	for {
		select {
		case pcm := <-a.PCM:
			if len(pcm.Samples) == 0 {
				t.Fatal("empty delivery")
			}
			if !told {
				// The report is sent before the first packet is delivered, so
				// by now it must be waiting.
				for len(a.Status) > 0 {
					if strings.Contains(<-a.Status, "lossless") {
						told = true
					}
				}
				if !told {
					t.Fatal("nothing said about being sent lossless after asking for Opus")
				}
			}
			return
		case <-deadline:
			t.Fatal("no audio played in ten seconds")
		}
	}
}

// A server older than 0.1.63 clamps the requested version to 1-3 and answers
// with version 1 rather than refusing, so its lossless frames are zstd. Those
// are not decoded — the predictive codec replaced zstd outright — but they must
// be named, or the session looks like a receiver that simply has no audio.
func TestLegacyZstdServerIsNamed(t *testing.T) {
	zstd := []byte{0x28, 0xB5, 0x2F, 0xFD, 0x00, 0x11, 0x22}
	a := NewAudioClient("h", false, "", "id")
	err := a.handleAudio(zstd, newAudioDecoders(FormatLossless))
	if err == nil {
		t.Fatal("a zstd frame was accepted")
	}
	if !strings.Contains(err.Error(), "protocol version 4") {
		t.Fatalf("unhelpful error %q", err)
	}
}

// serveFrames returns a WebSocket handler that sends the given binary frames
// once and then holds the socket open, which is what the client expects of a
// live stream.
func serveFrames(t *testing.T, frames [][]byte) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for _, f := range frames {
			if err := conn.WriteMessage(websocket.BinaryMessage, f); err != nil {
				return
			}
		}
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}
}

// connectTo runs an audio client against a stub receiver until the returned
// cancel is called.
func connectTo(t *testing.T, h http.HandlerFunc, setup func(*AudioClient)) (*AudioClient, context.CancelFunc) {
	return connectToAs(t, "", h, setup)
}

func connectToAs(t *testing.T, password string, h http.HandlerFunc, setup func(*AudioClient)) (*AudioClient, context.CancelFunc) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)

	a := NewAudioClient(strings.TrimPrefix(srv.URL, "http://"), false, password, "id")
	setup(a)
	ctx, cancel := context.WithCancel(context.Background())
	go a.Run(ctx)
	return a, cancel
}

// connectQuery returns the query string one connect attempt sent.
func connectQuery(t *testing.T, setup func(*AudioClient)) url.Values {
	return connectQueryAs(t, "", setup)
}

// connectQueryWith is connectQuery for a session opened with a password.
func connectQueryWith(t *testing.T, password string) url.Values {
	return connectQueryAs(t, password, func(*AudioClient) {})
}

func connectQueryAs(t *testing.T, password string, setup func(*AudioClient)) url.Values {
	t.Helper()
	seen := make(chan url.Values, 1)
	_, cancel := connectToAs(t, password, func(w http.ResponseWriter, r *http.Request) {
		select {
		case seen <- r.URL.Query():
		default:
		}
		http.Error(w, "no", http.StatusForbidden)
	}, setup)
	defer cancel()

	select {
	case q := <-seen:
		return q
	case <-time.After(10 * time.Second):
		t.Fatal("the client never connected")
		return nil
	}
}

// A packet that arrives before the resynchronisation point describing it cannot
// be decoded — nothing has said what the sample rate is. That must not drop the
// socket: the server sends a resync on its first packet and every five seconds
// after, so reconnecting would only start the same wait again. Once the stream
// HAS started, the same failure means the opposite thing — the predictor has
// lost the server, and every packet after it would decode to noise — so then it
// must drop the socket.
func TestLosslessWaitsForResyncThenFailsHard(t *testing.T) {
	packets := readV4Fixture(t)
	a := NewAudioClient("h", false, "", "id")
	d := newAudioDecoders(FormatLossless)

	if err := a.handleAudio(packets[1], d); err != nil {
		t.Fatalf("a delta packet before the first resync dropped the socket: %v", err)
	}
	if len(a.PCM) != 0 {
		t.Fatal("audio was played from a packet that could not be decoded")
	}

	if err := a.handleAudio(packets[0], d); err != nil {
		t.Fatalf("the resynchronisation point was refused: %v", err)
	}
	if len(a.PCM) == 0 {
		t.Fatal("the resynchronisation point did not start the stream")
	}

	// A version 4 header with no metadata and a timestamp delta that is not
	// there: readable as framing, undecodable as a packet.
	broken := []byte{0x50, 0x43, 0x4D, 0x34, 0x00}
	if err := a.handleAudio(broken, d); err == nil {
		t.Fatal("a packet the codec could not decode was ignored mid-stream")
	}
}

// The format is settled in the query string, so switching it means a new
// socket. The session UUID must survive that: the server keys the seat and the
// radiod channel off it, so a reconnect that changed it would drop the user to
// the back of the queue on a busy receiver.
func TestFormatChangeReconnectsWithTheSameSession(t *testing.T) {
	queries := make(chan url.Values, 4)
	a, cancel := connectTo(t, func(w http.ResponseWriter, r *http.Request) {
		queries <- r.URL.Query()
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}, func(*AudioClient) {})
	defer cancel()

	first := waitQuery(t, queries)
	if got := first.Get("format"); got != "opus" {
		t.Fatalf("opened with format %q, want opus", got)
	}
	waitConnected(t, a)

	a.SetFormat(FormatLossless)
	if a.Format() != FormatLossless {
		t.Fatal("the format was not stored")
	}

	second := waitQuery(t, queries)
	if got := second.Get("format"); got != "pcm-zstd" {
		t.Errorf("reconnected with format %q, want pcm-zstd", got)
	}
	if first.Get("user_session_id") != second.Get("user_session_id") {
		t.Errorf("the reconnect changed session from %q to %q",
			first.Get("user_session_id"), second.Get("user_session_id"))
	}

	// A reconnect the user asked for is not a fault, so it must not be reported
	// as one — nor waited out: the backoff is for a receiver that has gone
	// away, and applying it here would make the toggle feel broken.
	for len(a.Status) > 0 {
		if msg := <-a.Status; strings.Contains(msg, "disconnected") {
			t.Errorf("a deliberate reconnect was reported as a failure: %s", msg)
		}
	}
}

// Setting the format it already has must not touch the socket. Otherwise every
// pass through the audio start-up path, which sets the format alongside the
// tuning and the squelch, would tear the stream down and rebuild it.
func TestSameFormatDoesNotReconnect(t *testing.T) {
	queries := make(chan url.Values, 4)
	a, cancel := connectTo(t, func(w http.ResponseWriter, r *http.Request) {
		queries <- r.URL.Query()
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}, func(*AudioClient) {})
	defer cancel()

	waitQuery(t, queries)
	waitConnected(t, a)

	a.SetFormat(FormatOpus)
	select {
	case q := <-queries:
		t.Fatalf("setting the format it already had reconnected: %v", q)
	case <-time.After(500 * time.Millisecond):
	}
}

func waitQuery(t *testing.T, ch chan url.Values) url.Values {
	t.Helper()
	select {
	case q := <-ch:
		return q
	case <-time.After(10 * time.Second):
		t.Fatal("no connection arrived")
		return nil
	}
}

func waitConnected(t *testing.T, a *AudioClient) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
		if a.Connected() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("the client never reported itself connected")
}

// The audio panel's format row and the L key are the same control and must not
// disagree. Both are a plain flip, since there are only two formats, and both
// leave the caller to apply it: the socket belongs to the event loop.
func TestFormatPanelRowToggles(t *testing.T) {
	ui := NewUI("test")
	p := NewAudioPanel(nil, nil)
	p.row = rowFormat
	key := func(k tcell.Key) *tcell.EventKey { return tcell.NewEventKey(k, 0, tcell.ModNone) }

	if ui.lossless {
		t.Fatal("the UI starts on lossless, want Opus")
	}
	if ui.audioFormat() != FormatOpus {
		t.Fatal("audioFormat disagrees with the flag it reads")
	}

	p.HandleKey(key(tcell.KeyRight), ui, "")
	if !ui.lossless || ui.audioFormat() != FormatLossless {
		t.Error("stepping the format row did not select lossless")
	}
	if !p.formatChanged {
		t.Error("the panel did not ask the caller to apply the change")
	}

	// Either direction flips it: with two states there is nothing else a step
	// could mean, and a left arrow that did nothing would look broken.
	p.formatChanged = false
	p.HandleKey(key(tcell.KeyLeft), ui, "")
	if ui.lossless || ui.audioFormat() != FormatOpus {
		t.Error("stepping back did not return to Opus")
	}
	if !p.formatChanged {
		t.Error("the panel did not ask the caller to apply the change back")
	}
}

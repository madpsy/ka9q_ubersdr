package main

import (
	"net/http/httptest"
	"testing"
	"time"
)

// testUUID is a syntactically valid UUID for the ?session= parameter.
const testUUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"

// newHTTPAudioTestSession registers a minimal non-spectrum audio session that
// HandleAudioStream will accept, at the given mode and sample rate.
func newHTTPAudioTestSession(t *testing.T, sm *SessionManager, mode string, sampleRate int) *Session {
	t.Helper()
	session := &Session{
		ID:            "audio-test",
		Mode:          mode,
		SampleRate:    sampleRate,
		Channels:      1,
		AudioChan:     make(chan AudioPacket, 4),
		Done:          make(chan struct{}),
		UserSessionID: testUUID,
	}
	sm.mu.Lock()
	sm.sessions[session.ID] = session
	sm.uuidAudioSessions[testUUID] = session.ID
	sm.mu.Unlock()
	return session
}

// startHTTPAudioStream runs HandleAudioStream in the background and waits for it
// to claim the session's httpAudioChan.  Returns the recorder and a channel that
// closes when the handler returns.
func startHTTPAudioStream(t *testing.T, sm *SessionManager, session *Session) (*httptest.ResponseRecorder, chan struct{}) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/audio/stream?session="+testUUID, nil)
	req.RemoteAddr = "192.0.2.1:1234"

	finished := make(chan struct{})
	go func() {
		defer close(finished)
		HandleAudioStream(sm, sm.config)(rec, req)
	}()

	deadline := time.Now().Add(5 * time.Second)
	for {
		session.httpAudioMu.Lock()
		claimed := session.httpAudioChan != nil
		session.httpAudioMu.Unlock()
		if claimed {
			return rec, finished
		}
		select {
		case <-finished:
			t.Fatalf("handler returned before claiming httpAudioChan: %d %s", rec.Code, rec.Body.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for the handler to claim httpAudioChan")
		}
		time.Sleep(time.Millisecond)
	}
}

// feedHTTPAudio pushes one 20 ms silent packet stamped at the given rate.
func feedHTTPAudio(t *testing.T, session *Session, sampleRate int) {
	t.Helper()
	session.httpAudioMu.Lock()
	hc := session.httpAudioChan
	session.httpAudioMu.Unlock()
	if hc == nil {
		t.Fatal("httpAudioChan is nil — the handler has already gone")
	}
	select {
	case hc <- AudioPacket{PCMData: make([]byte, (sampleRate/50)*2), SampleRate: sampleRate}:
	case <-time.After(time.Second):
		t.Fatal("timed out feeding the HTTP audio channel")
	}
}

// A mode change moves the sample rate under a stream whose WebM header and Opus
// encoder are both fixed at the rate it opened with.  Nothing downstream errors
// on the mismatch — a 24 kHz buffer is a valid 40 ms frame at 12 kHz — so the
// handler has to notice and end the response for the client to reconnect.
func TestAudioStreamEndsOnSampleRateChange(t *testing.T) {
	sm := newTestSessionManager(t)
	session := newHTTPAudioTestSession(t, sm, "usb", 12000)

	rec, finished := startHTTPAudioStream(t, sm, session)

	// A packet at the rate the stream opened with is streamed normally.
	feedHTTPAudio(t, session, 12000)
	// usb → am: 12 kHz becomes 24 kHz and the stream must end.
	feedHTTPAudio(t, session, 24000)

	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("handler did not return after the sample rate changed")
	}

	// Nilled so streamAudio() resumes sending audio over the WebSocket.
	session.httpAudioMu.Lock()
	defer session.httpAudioMu.Unlock()
	if session.httpAudioChan != nil {
		t.Error("httpAudioChan was left set after the handler returned")
	}

	// The header and at least the first packet's cluster went out before the
	// rate change ended it — this is a teardown, not a rejection.
	if rec.Code != 200 {
		t.Errorf("status = %d, want 200", rec.Code)
	}
	if n := rec.Body.Len(); n < 64 {
		t.Errorf("body = %d bytes, want the WebM header plus a cluster", n)
	}
}

// A packet stamped at the rate the stream opened with must not end it, however
// many arrive.  Guards against the rate check firing on the steady state.
func TestAudioStreamSurvivesSameRatePackets(t *testing.T) {
	sm := newTestSessionManager(t)
	session := newHTTPAudioTestSession(t, sm, "usb", 12000)

	_, finished := startHTTPAudioStream(t, sm, session)

	for i := 0; i < 4; i++ {
		feedHTTPAudio(t, session, 12000)
	}

	select {
	case <-finished:
		t.Fatal("handler ended on packets at its own sample rate")
	case <-time.After(200 * time.Millisecond):
	}

	close(session.Done)
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("handler did not return after the session was destroyed")
	}
}

// IQ modes carry raw stereo RF that a mono Opus encoder cannot represent — and
// at rates Opus does not accept at all above 48 kHz.  Refused outright so the
// audio stays on the WebSocket, where it falls back to lossless pcm-zstd.
func TestAudioStreamRejectsIQModes(t *testing.T) {
	for _, mode := range []string{"iq", "iq48", "iq96", "iq192", "iq384"} {
		t.Run(mode, func(t *testing.T) {
			sm := newTestSessionManager(t)
			session := newHTTPAudioTestSession(t, sm, mode, sm.config.Audio.GetSampleRateForMode(mode))

			rec := httptest.NewRecorder()
			req := httptest.NewRequest("GET", "/audio/stream?session="+testUUID, nil)
			req.RemoteAddr = "192.0.2.1:1234"
			HandleAudioStream(sm, sm.config)(rec, req)

			if rec.Code != 409 {
				t.Errorf("status = %d, want 409", rec.Code)
			}
			session.httpAudioMu.Lock()
			defer session.httpAudioMu.Unlock()
			if session.httpAudioChan != nil {
				t.Error("a refused stream claimed httpAudioChan")
			}
		})
	}
}

func TestIsIQAudioMode(t *testing.T) {
	for _, mode := range []string{"iq", "iq48", "iq96", "iq192", "iq384"} {
		if !isIQAudioMode(mode) {
			t.Errorf("isIQAudioMode(%q) = false, want true", mode)
		}
	}
	for _, mode := range []string{"usb", "lsb", "cwu", "cwl", "am", "sam", "fm", "nfm", ""} {
		if isIQAudioMode(mode) {
			t.Errorf("isIQAudioMode(%q) = true, want false", mode)
		}
	}
}

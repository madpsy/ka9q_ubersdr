package main

import (
	"testing"
	"time"
)

// The retune settling window, which is what stops a mode change from opening the
// squelch on its own transient.
//
// The reported symptom was a VFO scan halting on empty channels: every hop that
// changed mode produced a burst of preset-width audio through a reset AGC, the
// gate opened on it, and the scan called that a signal.  These tests pin the
// three things that have to hold for that not to happen -- the window opens on a
// mode change, it closes only once radiod has answered, and it can never stick.

func retuningSession() *Session {
	return &Session{
		AudioGateMinSNR:   -999,
		AudioGateMinPower: -999,
	}
}

func TestRetuneWindowOpensAndWaitsForRadiod(t *testing.T) {
	s := retuningSession()
	t0 := time.Now()

	if !s.settleRetune(nil, true, t0) {
		t.Fatal("a session that never retuned reports as unsettled")
	}

	s.beginRetune(t0)
	if !s.retuning() {
		t.Fatal("beginRetune did not open the window")
	}

	// Status that predates the command describes the channel we just left, so it
	// is not an acknowledgement of anything.
	stale := &ChannelStatus{LastUpdate: t0.Add(-50 * time.Millisecond)}
	if s.settleRetune(stale, true, t0.Add(10*time.Millisecond)) {
		t.Error("settled on a status packet older than the retune command")
	}

	// radiod answers every command it decodes with a status packet, so this is
	// the acknowledgement -- but the demod thread restarts after the answer, so
	// the tail still has to run.
	fresh := &ChannelStatus{LastUpdate: t0.Add(20 * time.Millisecond)}
	ack := t0.Add(25 * time.Millisecond)
	if s.settleRetune(fresh, true, ack) {
		t.Error("settled the instant radiod answered, before the filter was rebuilt")
	}
	if s.settleRetune(fresh, true, ack.Add(retuneSettleTail-time.Millisecond)) {
		t.Error("settled before the tail elapsed")
	}
	if !s.settleRetune(fresh, true, ack.Add(retuneSettleTail)) {
		t.Error("still unsettled after the tail elapsed")
	}
	if s.retuning() {
		t.Error("window stayed open after settling")
	}
}

func TestRetuneWindowCannotStick(t *testing.T) {
	// Silence a listener cannot explain is worse than a transient they can, so
	// both ways of losing sight of radiod end the window rather than extending it.
	t.Run("no status ever arrives", func(t *testing.T) {
		s := retuningSession()
		t0 := time.Now()
		s.beginRetune(t0)
		if s.settleRetune(nil, true, t0.Add(retuneSettleTimeout-time.Millisecond)) {
			t.Error("gave up before the timeout")
		}
		if !s.settleRetune(nil, true, t0.Add(retuneSettleTimeout)) {
			t.Error("window outlived its timeout")
		}
	})

	t.Run("status is not observable at all", func(t *testing.T) {
		// A version 1 client, or no radiod controller: nothing will ever report
		// the channel converging, so waiting the timeout out would only mute the
		// session for no reason.
		s := retuningSession()
		t0 := time.Now()
		s.beginRetune(t0)
		if !s.settleRetune(nil, false, t0.Add(time.Millisecond)) {
			t.Error("waited for an acknowledgement that could never come")
		}
		if s.retuning() {
			t.Error("window stayed open")
		}
	})
}

func TestRetuneClearsTheGateHangTimer(t *testing.T) {
	// The hang timer belongs to the channel that opened it.  Carried across a
	// mode change it holds the gate open for up to 500 ms on a channel that has
	// never been measured -- which is the same false stop by another route.
	s := retuningSession()
	s.AudioGateLastOpenAt = time.Now()
	s.beginRetune(time.Now())
	if !s.AudioGateLastOpenAt.IsZero() {
		t.Error("the previous channel's hang timer survived the mode change")
	}
}

func TestGateStaysShutWhileRetuning(t *testing.T) {
	// Ahead of every threshold, including "disabled": what is coming out during
	// the window is the old channel's audio and the new channel's transient, and
	// neither is something the listener asked for.
	s := retuningSession()
	if !audioGateAllows(s, -40, -90) {
		t.Fatal("a disabled gate blocked a packet")
	}

	s.beginRetune(time.Now())
	if audioGateAllows(s, -40, -90) {
		t.Error("gate passed audio during a retune with the squelch off")
	}

	s.AudioGateMinSNR = 10 // a squelch that this signal clears easily
	if audioGateAllows(s, -40, -90) {
		t.Error("gate opened on a signal measured on the previous channel")
	}

	// And reopens normally once the window closes.
	s.settleRetune(nil, false, time.Now())
	if !audioGateAllows(s, -40, -90) {
		t.Error("gate stayed shut after settling")
	}
}

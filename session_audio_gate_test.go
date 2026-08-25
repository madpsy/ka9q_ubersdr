package main

import "testing"

// A newly created audio session must have its gate disabled.
//
// The zero value of a threshold field is an *active* 0 dB threshold, which
// gates out everything at or below the noise floor. The native path assigns
// these from its connect parameters and so never noticed; the KiwiSDR
// emulation, which has no such parameters, was silent until the user moved the
// squelch slider far enough to send a real sentinel.
func TestNewSessionStartsWithAudioGateDisabled(t *testing.T) {
	cfg := &Config{}
	cfg.Audio.DefaultSampleRate = 12000
	cfg.Server.MaxSessions = 4

	sm := NewSessionManager(cfg, &stubRadiod{}, nil)

	session, err := sm.CreateSessionWithBandwidthAndPassword(
		7100000, "usb", 3000, "", "", "gate-test", "")
	if err != nil {
		t.Fatalf("CreateSessionWithBandwidthAndPassword: %v", err)
	}
	defer func() { _ = sm.DestroySession(session.ID) }()

	session.mu.RLock()
	minSNR, minPower := session.AudioGateMinSNR, session.AudioGateMinPower
	session.mu.RUnlock()

	if minSNR != audioGateDisabled {
		t.Errorf("AudioGateMinSNR = %v on a new session, want %v (disabled)", minSNR, audioGateDisabled)
	}
	if minPower != audioGateDisabled {
		t.Errorf("AudioGateMinPower = %v on a new session, want %v (disabled)", minPower, audioGateDisabled)
	}

	// The symptom that matters: audio has to flow before anyone sets a squelch.
	// -60 dBFS against a -90 dBFS noise floor is an ordinary signal; a session
	// that gates it is a silent receiver.
	if !audioGateAllows(session, -60, -90) {
		t.Error("a new session gates out ordinary audio; the receiver would be silent until squelched")
	}
	// Even a signal below the noise floor must pass while the gate is disabled.
	if !audioGateAllows(session, -95, -90) {
		t.Error("a new session gates out weak audio despite the gate being disabled")
	}
}

// The trap itself, so the reason for the constructor's explicit assignment does
// not get lost.
//
// A zero threshold is not harmless: it is an active gate, and an active gate
// closes whenever the SNR reading is unavailable. "An absent reading is not a
// loud one" is deliberate in audioGateAllows -- a missing noise figure must not
// hold the gate open -- but it means a session that never asked for a squelch
// goes silent the moment radiod has not supplied a filter bandwidth or channel
// status. Only the sentinel makes the gate genuinely inert.
func TestZeroValueAudioGateClosesOnUnknownSignal(t *testing.T) {
	zeroValue := &Session{} // AudioGateMinSNR and MinPower both 0
	disabled := &Session{
		AudioGateMinSNR:   audioGateDisabled,
		AudioGateMinPower: audioGateDisabled,
	}

	// radiod has not reported a usable figure yet.
	if audioGateAllows(zeroValue, SignalUnavailable, SignalUnavailable) {
		t.Error("zero-valued thresholds passed audio with no signal reading; " +
			"the constructor's sentinel may no longer be load-bearing")
	}
	if !audioGateAllows(disabled, SignalUnavailable, SignalUnavailable) {
		t.Error("a disabled gate blocked audio with no signal reading; it must be inert")
	}

	// A known but sub-zero SNR is the other way a zero threshold bites.
	if audioGateAllows(zeroValue, -95, -90) {
		t.Error("zero-valued thresholds passed audio at -5 dB SNR; 0 dB is an active threshold")
	}
	if !audioGateAllows(disabled, -95, -90) {
		t.Error("a disabled gate blocked weak audio; it must be inert")
	}
}

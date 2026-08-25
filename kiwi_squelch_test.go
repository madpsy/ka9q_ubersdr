package main

import "testing"

// The Kiwi slider's zero means "off" -- the readout renders it as "off" rather
// than "0 dB" -- so it must reach the gate's disabled sentinel. Mapping it to a
// literal 0 dB threshold instead would gate out everything at or below the
// noise floor, which is a silent receiver rather than a disabled squelch.
func TestKiwiSquelchToMinSNR(t *testing.T) {
	tests := []struct {
		name     string
		position float64
		nbfm     bool
		want     float32
	}{
		{name: "zero is off, not 0 dB", position: 0, want: audioGateDisabled},
		{name: "negative is off", position: -5, want: audioGateDisabled},
		{name: "zero is off in nbfm too", position: 0, nbfm: true, want: audioGateDisabled},

		// Non-NBFM: the slider is already in dB, so it passes through.
		{name: "1 dB", position: 1, want: 1},
		{name: "12 dB", position: 12, want: 12},
		{name: "40 dB is the slider maximum", position: 40, want: 40},
		{name: "beyond the maximum clamps", position: 99, want: 40},

		// NBFM: 0-99 with no unit, spread across the same useful dB range.
		{name: "nbfm midpoint", position: 49.5, nbfm: true, want: 20},
		{name: "nbfm maximum", position: 99, nbfm: true, want: 40},
		{name: "nbfm beyond maximum clamps", position: 150, nbfm: true, want: 40},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := kiwiSquelchToMinSNR(tc.position, tc.nbfm); got != tc.want {
				t.Errorf("kiwiSquelchToMinSNR(%v, nbfm=%v) = %v, want %v",
					tc.position, tc.nbfm, got, tc.want)
			}
		})
	}
}

// Whatever the slider sends must land inside the range set_audio_gate accepts,
// or the two front ends would be driving the same field on different terms.
func TestKiwiSquelchStaysInGateRange(t *testing.T) {
	for _, nbfm := range []bool{false, true} {
		for position := 0.0; position <= 120; position += 0.5 {
			got := kiwiSquelchToMinSNR(position, nbfm)
			if got == audioGateDisabled {
				continue
			}
			if got < -999 || got > 999 {
				t.Fatalf("position %v (nbfm=%v) gave min_snr %v, outside the gate's -999..999",
					position, nbfm, got)
			}
			// A live threshold must never sit at or below the disabled
			// sentinel's band, or turning the squelch up would switch it off.
			if got <= -998 {
				t.Fatalf("position %v (nbfm=%v) gave %v, which reads as disabled",
					position, nbfm, got)
			}
		}
	}
}

func TestApplySquelchSetsSessionGate(t *testing.T) {
	tests := []struct {
		name  string
		mode  string
		value string
		want  float32
	}{
		{name: "usb slider in dB", mode: "usb", value: "15", want: 15},
		{name: "am slider in dB", mode: "am", value: "6", want: 6},
		{name: "off", mode: "usb", value: "0", want: audioGateDisabled},
		{name: "nfm uses the 0-99 scale", mode: "nfm", value: "99", want: 40},
		{name: "fm uses the 0-99 scale", mode: "fm", value: "49.5", want: 20},
		{name: "fractional slider position", mode: "usb", value: "7.5", want: 7.5},
		{name: "surrounding whitespace", mode: "usb", value: " 9 ", want: 9},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			session := &Session{Mode: tc.mode, AudioGateMinSNR: audioGateDisabled}
			kc := &kiwiConn{session: session}

			kc.applySquelch(tc.value)

			session.mu.RLock()
			got := session.AudioGateMinSNR
			session.mu.RUnlock()
			if got != tc.want {
				t.Errorf("after SET squelch=%q in %s, AudioGateMinSNR = %v, want %v",
					tc.value, tc.mode, got, tc.want)
			}
		})
	}
}

// A malformed value must leave the threshold alone rather than reset it: the
// slider is a user's noise decision and dropping it silently opens the squelch.
func TestApplySquelchIgnoresGarbage(t *testing.T) {
	session := &Session{Mode: "usb", AudioGateMinSNR: 12}
	kc := &kiwiConn{session: session}

	for _, bad := range []string{"", "abc", "12dB", "--3"} {
		kc.applySquelch(bad)
		session.mu.RLock()
		got := session.AudioGateMinSNR
		session.mu.RUnlock()
		if got != 12 {
			t.Errorf("SET squelch=%q changed the threshold to %v, want 12 kept", bad, got)
		}
	}
}

// Squelch can arrive before the audio channel exists -- the client sends it
// during setup -- and must not panic. The client re-sends on every mode change,
// so nothing is lost by ignoring it here.
func TestApplySquelchWithoutSession(t *testing.T) {
	kc := &kiwiConn{}
	kc.applySquelch("20") // must not panic
}

// The squelch flag has to be the bit the client actually tests.
func TestKiwiSquelchFlagValue(t *testing.T) {
	// audio.js: SND_FLAG_SQUELCH_UI: 0x0040
	if kiwiSndFlagSquelchUI != 0x40 {
		t.Errorf("kiwiSndFlagSquelchUI = 0x%02x, want 0x40 to match SND_FLAG_SQUELCH_UI", kiwiSndFlagSquelchUI)
	}
	// It must not collide with the flags already in use.
	for _, other := range []int{kiwiSndFlagStereo, kiwiSndFlagCompressed} {
		if kiwiSndFlagSquelchUI&other != 0 {
			t.Errorf("kiwiSndFlagSquelchUI 0x%02x overlaps flag 0x%02x", kiwiSndFlagSquelchUI, other)
		}
	}
}

// The squelch flag must survive packet assembly alongside the others, since the
// client reads all of them out of the same byte.
func TestBuildKiwiSndPacketCarriesSquelchFlag(t *testing.T) {
	pkt := buildKiwiSndPacket(kiwiSndFlagCompressed|kiwiSndFlagSquelchUI, 1, 770, 0, []byte{0x11})
	if got := pkt[3]; got != kiwiSndFlagCompressed|kiwiSndFlagSquelchUI {
		t.Errorf("flags byte = 0x%02x, want 0x%02x", got, kiwiSndFlagCompressed|kiwiSndFlagSquelchUI)
	}
	// Squelch must not shift the payload: only the stereo flag adds a header.
	if len(pkt) != 10+1 {
		t.Errorf("packet length %d, want 11 -- squelch must not change the header size", len(pkt))
	}
}

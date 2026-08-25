package main

import (
	"math"
	"testing"
)

// An untouched decay slider must ask for exactly what the receiver would have
// done anyway. The client's default is 1000 ms and ubersdr's configured
// recovery rate defaults to 20 dB/s, and the mapping is anchored on that pair.
func TestKiwiDecayToRecoveryRateAnchoredOnDefaults(t *testing.T) {
	const operatorDefault float32 = 20
	if got := kiwiDecayToRecoveryRate(kiwiDecayDefaultMs, operatorDefault); got != operatorDefault {
		t.Errorf("decay %.0f ms gave %.1f dB/s, want the operator default %.1f unchanged",
			kiwiDecayDefaultMs, got, operatorDefault)
	}

	// The anchor must follow the operator's configuration, not a constant.
	const configured float32 = 8
	if got := kiwiDecayToRecoveryRate(kiwiDecayDefaultMs, configured); got != configured {
		t.Errorf("with a configured default of %.1f dB/s, the default decay gave %.1f", configured, got)
	}
}

// Decay and recovery rate are inverse quantities: a longer decay must always
// mean a slower recovery.
func TestKiwiDecayToRecoveryRateIsMonotonic(t *testing.T) {
	const operatorDefault float32 = 20

	prev := float32(math.MaxFloat32)
	// The client's slider range is 20..5000 ms.
	for decay := 20.0; decay <= 5000; decay += 20 {
		got := kiwiDecayToRecoveryRate(decay, operatorDefault)
		if got > prev {
			t.Fatalf("decay %.0f ms gave %.2f dB/s, faster than the %.2f at the shorter decay before it",
				decay, got, prev)
		}
		if got < kiwiAGCRecoveryMinDbS || got > kiwiAGCRecoveryMaxDbS {
			t.Fatalf("decay %.0f ms gave %.2f dB/s, outside the server's %.0f-%.0f range",
				decay, got, kiwiAGCRecoveryMinDbS, kiwiAGCRecoveryMaxDbS)
		}
		prev = got
	}
}

func TestKiwiDecayToRecoveryRateClamps(t *testing.T) {
	const operatorDefault float32 = 20

	// A very short decay would ask for far more than the server allows.
	if got := kiwiDecayToRecoveryRate(20, operatorDefault); got != kiwiAGCRecoveryMaxDbS {
		t.Errorf("decay 20 ms gave %.1f dB/s, want it clamped to %.1f", got, kiwiAGCRecoveryMaxDbS)
	}
	// A nonsense value falls back rather than dividing by zero.
	if got := kiwiDecayToRecoveryRate(0, operatorDefault); got != operatorDefault {
		t.Errorf("decay 0 gave %.1f dB/s, want the default %.1f", got, operatorDefault)
	}
	if got := kiwiDecayToRecoveryRate(-5, operatorDefault); got != operatorDefault {
		t.Errorf("negative decay gave %.1f dB/s, want the default %.1f", got, operatorDefault)
	}
}

// With AGC on, the enable, hang and recovery rate go out and nothing else.
func TestKiwiAGCParamsEnabled(t *testing.T) {
	params := map[string]string{
		"agc": "1", "hang": "1", "thresh": "-90", "slope": "6",
		"decay": "1000", "manGain": "50",
	}

	got, ok := kiwiAGCParams(params, nil)
	if !ok {
		t.Fatal("kiwiAGCParams returned false for a valid command")
	}
	if got.Enable == nil || !*got.Enable {
		t.Error("Enable not set true")
	}
	if got.HangTime == nil || *got.HangTime != 1.1 {
		t.Errorf("HangTime = %v, want the 1.1 s presets.conf default", got.HangTime)
	}
	if got.RecoveryRate == nil || *got.RecoveryRate != 20 {
		t.Errorf("RecoveryRate = %v, want 20 dB/s", got.RecoveryRate)
	}
	// Manual gain is meaningless while the AGC is running, and sending it would
	// switch the AGC off inside radiod.
	if got.Gain != nil {
		t.Errorf("Gain = %v with AGC on; sending it would clear radiod's AGC flag", *got.Gain)
	}
	// The two controls with no faithful equivalent must never be mapped.
	if got.Threshold != nil {
		t.Errorf("Threshold = %v; the client's dBm scale does not map onto radiod's", *got.Threshold)
	}
}

// hang is a toggle on the client and a duration in radiod.
func TestKiwiAGCParamsHangToggle(t *testing.T) {
	on, _ := kiwiAGCParams(map[string]string{"agc": "1", "hang": "1", "decay": "1000"}, nil)
	if on.HangTime == nil || *on.HangTime <= 0 {
		t.Errorf("hang=1 gave HangTime %v, want the configured hang time", on.HangTime)
	}

	off, _ := kiwiAGCParams(map[string]string{"agc": "1", "hang": "0", "decay": "1000"}, nil)
	if off.HangTime == nil || *off.HangTime != 0 {
		t.Errorf("hang=0 gave HangTime %v, want 0", off.HangTime)
	}
}

// With AGC off the manual gain is the whole point, and hang/recovery are not
// sent because nothing is riding the gain.
func TestKiwiAGCParamsManualGain(t *testing.T) {
	got, ok := kiwiAGCParams(map[string]string{
		"agc": "0", "hang": "1", "decay": "1000", "manGain": "42",
	}, nil)
	if !ok {
		t.Fatal("kiwiAGCParams returned false")
	}
	if got.Gain == nil || *got.Gain != 42 {
		t.Errorf("Gain = %v, want 42 dB", got.Gain)
	}
	if got.Enable == nil || *got.Enable {
		t.Error("Enable should be false when the client reports agc=0")
	}
	if got.HangTime != nil || got.RecoveryRate != nil {
		t.Errorf("HangTime=%v RecoveryRate=%v sent with the AGC off, want neither",
			got.HangTime, got.RecoveryRate)
	}
}

// A missing or malformed manGain must not become a zero-dB gain command.
func TestKiwiAGCParamsIgnoresBadManualGain(t *testing.T) {
	for _, bad := range []string{"", "loud", "--3"} {
		got, _ := kiwiAGCParams(map[string]string{"agc": "0", "manGain": bad}, nil)
		if got.Gain != nil {
			t.Errorf("manGain=%q produced Gain %v, want it left alone", bad, *got.Gain)
		}
	}
}

// The operator's configured values, not hardcoded constants, are the anchor.
func TestKiwiAGCParamsUsesOperatorDefaults(t *testing.T) {
	hang := float32(3.5)
	recovery := float32(50)
	cfg := &Config{}
	cfg.Server.SSBAgcDefaults.HangTimeS = &hang
	cfg.Server.SSBAgcDefaults.RecoveryRateDbS = &recovery

	got, _ := kiwiAGCParams(map[string]string{"agc": "1", "hang": "1", "decay": "1000"}, cfg)

	if got.HangTime == nil || *got.HangTime != hang {
		t.Errorf("HangTime = %v, want the operator's %v", got.HangTime, hang)
	}
	if got.RecoveryRate == nil || *got.RecoveryRate != recovery {
		t.Errorf("RecoveryRate = %v, want the operator's %v at the default decay",
			got.RecoveryRate, recovery)
	}
}

// buildAGCCommand must put GAIN before AGC_ENABLE. radiod decodes tags in
// packet order and GAIN clears the AGC flag, so the reverse order would
// silently undo an enable the caller asked for.
func TestBuildAGCCommandEncodesGainBeforeEnable(t *testing.T) {
	enable := true
	gain := float32(30)

	buf := buildAGCCommand(12345, AGCParams{Enable: &enable, Gain: &gain})

	gainAt := tagPosition(t, buf, tagGain)
	enableAt := tagPosition(t, buf, tagAgcEnable)
	if gainAt > enableAt {
		t.Errorf("GAIN at offset %d, after AGC_ENABLE at %d; radiod would clear the enable",
			gainAt, enableAt)
	}
}

// Nil fields must not reach the wire at all: radiod keeps the preset value for
// anything it is not told about, which is how "leave this alone" is expressed.
func TestBuildAGCCommandOmitsUnsetFields(t *testing.T) {
	enable := true

	buf := buildAGCCommand(12345, AGCParams{Enable: &enable})

	for _, tag := range []byte{tagGain, tagAgcHangtime, tagAgcRecoveryRate, tagAgcThreshold} {
		if pos := findTag(buf, tag); pos >= 0 {
			t.Errorf("tag %d present at offset %d despite being nil", tag, pos)
		}
	}
	if findTag(buf, tagAgcEnable) < 0 {
		t.Error("AGC_ENABLE missing although it was set")
	}
}

// findTag walks the TLV packet and returns the offset of a tag, or -1.
// Walking rather than scanning for the byte avoids matching a value that
// happens to equal a tag number.
func findTag(buf []byte, want byte) int {
	// buf[0] is the packet type; entries are tag, length, value...
	for i := 1; i < len(buf); {
		tag := buf[i]
		if tag == tagEOL {
			return -1
		}
		if i+1 >= len(buf) {
			return -1
		}
		length := int(buf[i+1])
		if tag == want {
			return i
		}
		i += 2 + length
	}
	return -1
}

func tagPosition(t *testing.T, buf []byte, tag byte) int {
	t.Helper()
	pos := findTag(buf, tag)
	if pos < 0 {
		t.Fatalf("tag %d not found in the command packet", tag)
	}
	return pos
}

// The tag numbers are radiod's, from ka9q-radio src/status.h.
func TestAGCTagNumbersMatchRadiod(t *testing.T) {
	tags := map[string]struct{ got, want byte }{
		"AGC_ENABLE":        {tagAgcEnable, 62},
		"AGC_HANGTIME":      {tagAgcHangtime, 64},
		"AGC_RECOVERY_RATE": {tagAgcRecoveryRate, 65},
		"AGC_THRESHOLD":     {tagAgcThreshold, 67},
		"GAIN":              {tagGain, 68},
	}
	for name, tc := range tags {
		if tc.got != tc.want {
			t.Errorf("%s = %d, want %d (status.h enum position)", name, tc.got, tc.want)
		}
	}
}

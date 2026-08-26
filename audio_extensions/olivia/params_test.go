package olivia

import (
	"math"
	"testing"
)

// Attach parameters arrive from the browser and are not to be trusted. Several
// of them size arrays in preset(), so the bounds below are resource limits
// rather than questions of taste: sync_integ_len at two million was accepted
// before these existed and spent twelve seconds trying to allocate about 13 GB.
func TestAttachParamsAreBounded(t *testing.T) {
	cases := []struct {
		name   string
		params map[string]interface{}
		refuse bool
	}{
		{"defaults", map[string]interface{}{}, false},
		{"what the interface offers", map[string]interface{}{
			"tones": 8.0, "bandwidth": 250.0, "center_frequency": 1000.0,
			"sync_margin": 8.0, "sync_integ_len": 4.0,
		}, false},

		{"sync_integ_len far too deep", map[string]interface{}{"sync_integ_len": 2000000.0}, true},
		{"sync_integ_len just over", map[string]interface{}{"sync_integ_len": float64(SyncIntegLenMax + 1)}, true},
		{"sync_integ_len at the limit", map[string]interface{}{"sync_integ_len": float64(SyncIntegLenMax)}, false},
		{"sync_margin far too wide", map[string]interface{}{"sync_margin": 100000.0}, true},
		{"sync_margin at the limit", map[string]interface{}{"sync_margin": float64(SyncMarginMax)}, false},

		// Beyond maxParamMagnitude the value is treated as absent and the
		// default applies, which is safe — the point is that int() never sees
		// it. TestNonFiniteParamsAreIgnored checks the default is what lands.
		{"tones absurd", map[string]interface{}{"tones": 1e18}, false},
		{"bandwidth absurd", map[string]interface{}{"bandwidth": 1e18}, false},
		// Inside that magnitude, the range checks in New() do the refusing.
		{"tones out of range", map[string]interface{}{"tones": 100000.0}, true},
		{"bandwidth out of range", map[string]interface{}{"bandwidth": 100000.0}, true},
		{"centre above Nyquist", map[string]interface{}{"center_frequency": 9000.0}, true},
		{"centre negative", map[string]interface{}{"center_frequency": -100.0}, true},
	}

	for _, c := range cases {
		_, err := NewExtension(12000, c.params)
		if c.refuse && err == nil {
			t.Errorf("%s: accepted, want refused", c.name)
		}
		if !c.refuse && err != nil {
			t.Errorf("%s: refused (%v), want accepted", c.name, err)
		}
	}
}

// A float64 outside the integer range converts with int() to an
// implementation-defined value, so these must be rejected before conversion
// rather than relied on to land outside the valid range by luck.
func TestNonFiniteParamsAreIgnored(t *testing.T) {
	for _, v := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), 1e300, -1e300} {
		if _, ok := numberParam(map[string]interface{}{"tones": v}, "tones"); ok {
			t.Errorf("numberParam accepted %v", v)
		}
	}
	// And the extension still builds, on its defaults.
	e, err := NewExtension(12000, map[string]interface{}{"tones": math.NaN(), "sync_integ_len": math.Inf(1)})
	if err != nil {
		t.Fatalf("non-finite params should fall back to defaults, got %v", err)
	}
	if got := e.decoder.Geometry().Tones; got != DefaultConfig().Tones {
		t.Errorf("tones = %d, want the default %d", got, DefaultConfig().Tones)
	}
}

// The live squelch setter has always clamped; construction must not be the one
// path that lets a wild value through.
func TestSyncThresholdClampedAtConstruction(t *testing.T) {
	for _, v := range []float64{-100, 0, 1e9, math.NaN()} {
		e, err := NewExtension(12000, map[string]interface{}{"sync_threshold": v})
		if err != nil {
			t.Fatalf("sync_threshold %v: %v", v, err)
		}
		got := e.decoder.SyncThreshold()
		if got < SyncThresholdMin || got > SyncThresholdMax {
			t.Errorf("sync_threshold %v became %g, outside %g..%g",
				v, got, SyncThresholdMin, SyncThresholdMax)
		}
	}
}

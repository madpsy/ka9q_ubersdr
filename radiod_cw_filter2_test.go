package main

import (
	"os"
	"path/filepath"
	"testing"

	"gopkg.in/yaml.v3"
)

// loadConfigWithCWFilter2 loads config.yaml.example with radiod.cw_filter2 set
// to v, or removed entirely when v is nil.
func loadConfigWithCWFilter2(t *testing.T, v interface{}) *Config {
	t.Helper()
	src, err := os.ReadFile("config/config.yaml.example")
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]interface{}
	if err := yaml.Unmarshal(src, &m); err != nil {
		t.Fatal(err)
	}
	radiod := m["radiod"].(map[string]interface{})
	if v == nil {
		delete(radiod, "cw_filter2")
	} else {
		radiod["cw_filter2"] = v
	}
	out, err := yaml.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(p, out, 0644); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(p)
	if err != nil {
		t.Fatalf("LoadConfig with cw_filter2 = %v: %v", v, err)
	}
	return cfg
}

// sentFilter2 returns the FILTER2 value in a radiod command packet, and whether
// the tag was there at all. A zero value is encoded with zero length, so
// "present with 0" and "absent" are different answers.
func sentFilter2(t *testing.T, buf []byte) (int, bool) {
	t.Helper()
	_, tlvs := parseCommandPacket(t, buf)
	e, ok := findTLV(tlvs, tagFilter2)
	if !ok {
		return 0, false
	}
	return decodeInt(e.value), true
}

// TestCWFilter2ConfigToRadiod follows radiod.cw_filter2 from config.yaml through
// LoadConfig and the controller to the FILTER2 tag in the packets sent to
// radiod, for channel create and for a mode change.
//
// 0 matters as much as the others: it must arrive as an explicit FILTER2 = 0,
// not be mistaken for "unset" and replaced by the default, and not be left out
// of the packet (which would leave a channel coming from CW on filter2).
func TestCWFilter2ConfigToRadiod(t *testing.T) {
	for _, c := range []struct {
		name   string
		config interface{} // nil = key absent
		wantCW int
	}{
		{"zero turns it off", 0, 0},
		{"one", 1, 1},
		{"two", 2, 2},
		{"three is invalid, default", 3, defaultCWFilter2},
		{"negative is invalid, default", -1, defaultCWFilter2},
		{"absent, default", nil, defaultCWFilter2},
	} {
		t.Run(c.name, func(t *testing.T) {
			cfg := loadConfigWithCWFilter2(t, c.config)
			if got := *cfg.Radiod.CWFilter2; got != c.wantCW {
				t.Fatalf("LoadConfig: radiod.cw_filter2 = %d, want %d", got, c.wantCW)
			}

			rc := &RadiodController{}
			rc.SetCWFilter2(*cfg.Radiod.CWFilter2)

			for _, mode := range []string{"cwu", "cwl", "usb", "lsb", "am", "iq"} {
				want := 0
				if mode == "cwu" || mode == "cwl" {
					want = c.wantCW
				}

				got, ok := sentFilter2(t, rc.createPacket(4242, 7_030_000, mode, nil, nil))
				if !ok {
					t.Errorf("create %s: no FILTER2 in the packet", mode)
				} else if got != want {
					t.Errorf("create %s: FILTER2 = %d, want %d", mode, got, want)
				}

				got, ok = sentFilter2(t, rc.updatePacket(4242, 7_030_000, mode, -200, 200, true, nil, nil, nil))
				if !ok {
					t.Errorf("mode change to %s: no FILTER2 in the packet; radiod would keep the previous mode's value", mode)
				} else if got != want {
					t.Errorf("mode change to %s: FILTER2 = %d, want %d", mode, got, want)
				}
			}

			// A retune with no mode change loads no preset, so it leaves
			// FILTER2 alone rather than resending it.
			if _, ok := sentFilter2(t, rc.updatePacket(4242, 7_031_000, "", 0, 0, false, nil, nil, nil)); ok {
				t.Error("retune without a mode carries FILTER2")
			}
		})
	}
}

// FILTER2 has to be decoded after PRESET: a preset that named filter2 would
// otherwise overwrite the configured value.
func TestCWFilter2FollowsPreset(t *testing.T) {
	rc := &RadiodController{}
	rc.SetCWFilter2(2)
	for name, buf := range map[string][]byte{
		"create": rc.createPacket(4242, 7_030_000, "cwu", nil, nil),
		"update": rc.updatePacket(4242, 7_030_000, "cwu", -200, 200, true, nil, nil, nil),
	} {
		_, tlvs := parseCommandPacket(t, buf)
		preset, filter2 := -1, -1
		for i, e := range tlvs {
			switch e.tag {
			case tagPreset:
				preset = i
			case tagFilter2:
				filter2 = i
			}
		}
		if preset < 0 || filter2 < 0 {
			t.Fatalf("%s: PRESET at %d, FILTER2 at %d", name, preset, filter2)
		}
		if filter2 < preset {
			t.Errorf("%s: FILTER2 is decoded before PRESET", name)
		}
	}
}

// A controller nobody configured (as in other tests) still gives CW the default.
func TestCWFilter2ZeroValueController(t *testing.T) {
	var rc RadiodController
	if got := rc.filter2ForMode("cwu"); got != defaultCWFilter2 {
		t.Errorf("zero-value controller: cwu FILTER2 = %d, want %d", got, defaultCWFilter2)
	}
	if got := rc.filter2ForMode("usb"); got != 0 {
		t.Errorf("zero-value controller: usb FILTER2 = %d, want 0", got)
	}
}

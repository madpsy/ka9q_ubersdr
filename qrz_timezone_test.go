package main

import "testing"

// The geoloc allowlist is the only thing separating a real operator position
// from a centroid: QRZ returns coordinates for nearly every callsign, falling
// back to a state or DXCC centre when it has nothing better.
func TestQRZGeoLocIsPrecise(t *testing.T) {
	cases := []struct {
		geoloc string
		want   bool
	}{
		{"user", true},
		{"geocode", true},
		{"grid", true},
		{"zip", true},
		{"state", false}, // US states spanning two zones would be coin-flips
		{"dxcc", false},  // country centre — the case this guard exists for
		{"none", false},
		{"", false},          // absent: fail closed
		{"something", false}, // unrecognised: fail closed
		{"USER", true},       // case/whitespace tolerant
		{"  Grid  ", true},
	}

	for _, tc := range cases {
		if got := qrzGeoLocIsPrecise(tc.geoloc); got != tc.want {
			t.Errorf("qrzGeoLocIsPrecise(%q) = %v, want %v", tc.geoloc, got, tc.want)
		}
	}
}

// A precise coordinate must resolve to the zone containing it, including the
// sub-hour offsets QRZ's own integer GMTOffset field cannot represent.
func TestTimezoneFromPreciseQRZPosition(t *testing.T) {
	loadTimezonesForTest(t)

	cases := []struct {
		name     string
		lat, lon float64
		want     string
	}{
		{"London", 51.5074, -0.1278, "Europe/London"},
		{"Kathmandu +5:45", 27.7172, 85.3240, "Asia/Kathmandu"},
		{"Newfoundland -3:30", 47.5615, -52.7126, "America/St_Johns"},
	}

	for _, tc := range cases {
		if got := TimezoneForLatLon(tc.lat, tc.lon); got != tc.want {
			t.Errorf("%s: TimezoneForLatLon(%g, %g) = %q, want %q", tc.name, tc.lat, tc.lon, got, tc.want)
		}
	}
}

// The dataset is land-only, so a maritime mobile position yields no zone rather
// than a wrong one.
func TestTimezoneAtSeaIsEmpty(t *testing.T) {
	loadTimezonesForTest(t)

	if got := TimezoneForLatLon(0, -30); got != "" {
		t.Errorf("mid-Atlantic: got %q, want empty", got)
	}
}

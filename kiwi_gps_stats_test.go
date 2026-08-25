package main

import (
	"net/url"
	"strconv"
	"strings"
	"testing"
)

func testKiwiConnWithGPSDO(snapshot *GPSDOSnapshot, fixes uint64) *kiwiConn {
	monitor := &GPSDOMonitor{snapshot: snapshot, fixCount: fixes}
	return &kiwiConn{
		config:  &Config{},
		handler: &KiwiWebSocketHandler{gpsdoMonitor: monitor},
	}
}

func usableGPSDOSnapshot() *GPSDOSnapshot {
	return &GPSDOSnapshot{
		Device:       "/dev/hidraw0",
		DeviceStatus: &GPSDODeviceStatus{GPSLock: true, PLLLock: true, FrequencyHz: 27_000_000},
		GPS: &GPSDOGPSStatus{
			Fix:         "3D",
			SatsUsed:    9,
			GPSInView:   11,
			GLOInView:   6,
			Latitude:    46.62,
			Longitude:   -114.028,
			AltitudeM:   1011,
			DatetimeUTC: "2026-08-25T09:17:37Z",
		},
	}
}

// With a GPSDO present, the satellite counts must be the real ones. gt is what
// the client prints as "track" and gg as "good".
func TestAddGPSStatsReportsRealSatellites(t *testing.T) {
	kc := testKiwiConnWithGPSDO(usableGPSDOSnapshot(), 4242)
	stats := map[string]interface{}{}

	kc.addGPSStats(stats)

	if got, want := stats["gt"], 17; got != want { // 11 GPS + 6 GLONASS in view
		t.Errorf("gt (tracked) = %v, want %v", got, want)
	}
	if got, want := stats["gg"], 9; got != want { // used in the fix
		t.Errorf("gg (good) = %v, want %v", got, want)
	}
	if got, want := stats["gf"], uint64(4242); got != want {
		t.Errorf("gf (fixes) = %v, want %v", got, want)
	}
	if got, want := stats["ga"], 1; got != want {
		t.Errorf("ga (acquiring) = %v, want %v", got, want)
	}
}

// The GPSDO knows the antenna's exact position; the operator's configured
// coordinates are what they chose to publish. The emulation must never put the
// real fix on the wire: leaving gr and gl unset keeps
// isNonEmptyString(kiwi.GPS_auto_latlon) false in the client, so it goes on
// showing rx_gps and rx_grid from the cfg.
func TestAddGPSStatsNeverPublishesTheRealPosition(t *testing.T) {
	snapshot := usableGPSDOSnapshot()
	kc := testKiwiConnWithGPSDO(snapshot, 1)
	// Configured coordinates deliberately differ from the GPS fix.
	kc.config.Admin.GPS.Lat = 51.5
	kc.config.Admin.GPS.Lon = -0.12

	stats := map[string]interface{}{}
	kc.addGPSStats(stats)

	if _, present := stats["gl"]; present {
		t.Errorf("gl = %v; the GPS-derived position must not be sent", stats["gl"])
	}
	if _, present := stats["gr"]; present {
		t.Errorf("gr = %v; the GPS-derived grid must not be sent", stats["gr"])
	}

	// Belt and braces: the real coordinates must not appear in any field, in
	// any format.
	realLat := strconv.FormatFloat(snapshot.GPS.Latitude, 'f', 2, 64)
	realLon := strconv.FormatFloat(snapshot.GPS.Longitude, 'f', 2, 64)
	realGrid := latLonToGridSquare(snapshot.GPS.Latitude, snapshot.GPS.Longitude)
	for key, value := range stats {
		rendered, ok := value.(string)
		if !ok {
			continue
		}
		decoded, err := url.PathUnescape(rendered)
		if err != nil {
			decoded = rendered
		}
		for _, secret := range []string{realLat, realLon, realGrid} {
			if strings.Contains(decoded, secret) {
				t.Errorf("stat %q = %q leaks the receiver's real position (%q)", key, decoded, secret)
			}
		}
	}
}

// No GPSDO: the row must fall back rather than invent telemetry.
func TestAddGPSStatsWithoutGPSDO(t *testing.T) {
	cases := []struct {
		name    string
		kc      *kiwiConn
		wantAcq int
	}{
		{
			name: "no handler at all",
			kc:   &kiwiConn{config: &Config{}},
		},
		{
			name: "handler with no monitor",
			kc:   &kiwiConn{config: &Config{}, handler: &KiwiWebSocketHandler{}},
		},
		{
			name: "monitor but container unreachable",
			kc:   testKiwiConnWithGPSDO(nil, 0),
		},
		{
			name: "monitor but no USB device present",
			kc:   testKiwiConnWithGPSDO(&GPSDOSnapshot{Device: ""}, 0),
		},
		{
			name: "device present but no GPS telemetry",
			kc:   testKiwiConnWithGPSDO(&GPSDOSnapshot{Device: "/dev/hidraw0"}, 0),
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stats := map[string]interface{}{}
			tc.kc.addGPSStats(stats)

			for _, key := range []string{"gt", "gg", "gf", "go"} {
				if got := stats[key]; got != 0 {
					t.Errorf("%s = %v with no GPSDO, want 0 rather than an invented figure", key, got)
				}
			}
			if got := stats["ga"]; got != tc.wantAcq {
				t.Errorf("ga = %v, want %v", got, tc.wantAcq)
			}
			// No fix means no position claim.
			if _, present := stats["gl"]; present {
				t.Errorf("gl was set to %v without a GPS fix", stats["gl"])
			}
			if _, present := stats["gr"]; present {
				t.Errorf("gr was set to %v without a GPS fix", stats["gr"])
			}
		})
	}
}

// Configured coordinates are all a receiver without GPS hardware has, and they
// should still show the row as something other than dead.
func TestAddGPSStatsUsesConfiguredCoordinates(t *testing.T) {
	kc := &kiwiConn{config: &Config{}}
	kc.config.Admin.GPS.Lat = 51.5
	kc.config.Admin.GPS.Lon = -0.12

	stats := map[string]interface{}{}
	kc.addGPSStats(stats)

	if got := stats["ga"]; got != 1 {
		t.Errorf("ga = %v with coordinates configured, want 1", got)
	}
}

// go gates the client's ADC clock line: it is only rendered when non-zero.
// Claiming corrections we have not made would put a made-up precision on
// screen, so it stays zero.
func TestAddGPSStatsClaimsNoClockCorrections(t *testing.T) {
	kc := testKiwiConnWithGPSDO(usableGPSDOSnapshot(), 10)
	stats := map[string]interface{}{}

	kc.addGPSStats(stats)

	if got := stats["go"]; got != 0 {
		t.Errorf("go = %v, want 0 so the client does not render an ADC clock average count", got)
	}
}

// A fix has to be real before it counts. "no fix", or a fix with no satellites
// behind it, is not a position.
func TestGPSFixUsable(t *testing.T) {
	tests := []struct {
		name     string
		snapshot *GPSDOSnapshot
		want     bool
	}{
		{name: "nil snapshot", snapshot: nil},
		{name: "no gps object", snapshot: &GPSDOSnapshot{Device: "/dev/hidraw0"}},
		{
			name:     "no fix",
			snapshot: &GPSDOSnapshot{GPS: &GPSDOGPSStatus{Fix: "no fix", SatsUsed: 4}},
		},
		{
			name:     "empty fix string",
			snapshot: &GPSDOSnapshot{GPS: &GPSDOGPSStatus{Fix: "", SatsUsed: 4}},
		},
		{
			name:     "fix claimed but no satellites",
			snapshot: &GPSDOSnapshot{GPS: &GPSDOGPSStatus{Fix: "3D", SatsUsed: 0}},
		},
		{
			name:     "3D fix",
			snapshot: &GPSDOSnapshot{GPS: &GPSDOGPSStatus{Fix: "3D", SatsUsed: 7}},
			want:     true,
		},
		{
			name:     "2D fix",
			snapshot: &GPSDOSnapshot{GPS: &GPSDOGPSStatus{Fix: "2D", SatsUsed: 3}},
			want:     true,
		},
		{
			name:     "case and spacing are not significant",
			snapshot: &GPSDOSnapshot{GPS: &GPSDOGPSStatus{Fix: "  No Fix  ", SatsUsed: 5}},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := gpsFixUsable(tc.snapshot); got != tc.want {
				t.Errorf("gpsFixUsable() = %v, want %v", got, tc.want)
			}
		})
	}
}

// The fix counter must only advance on usable fixes, since the client renders
// it as a cumulative count.
func TestGPSDOFixCountOnlyCountsUsableFixes(t *testing.T) {
	m := &GPSDOMonitor{}

	m.snapshot = &GPSDOSnapshot{GPS: &GPSDOGPSStatus{Fix: "3D", SatsUsed: 6}}
	if gpsFixUsable(m.snapshot) {
		m.fixCount++
	}
	m.snapshot = &GPSDOSnapshot{GPS: &GPSDOGPSStatus{Fix: "no fix"}}
	if gpsFixUsable(m.snapshot) {
		m.fixCount++
	}

	if got := m.FixCount(); got != 1 {
		t.Errorf("FixCount() = %d, want 1 (only the usable fix)", got)
	}
}

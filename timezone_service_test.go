package main

import (
	"os"
	"testing"
	"time"
)

const timezoneTestPath = "natural_earth/timezones.geojson"

func loadTimezonesForTest(t *testing.T) *TimezoneService {
	t.Helper()
	if _, err := os.Stat(timezoneTestPath); err != nil {
		t.Skipf("timezone dataset not present: %v", err)
	}
	if globalTimezones == nil {
		if err := InitTimezoneService(timezoneTestPath); err != nil {
			t.Fatalf("InitTimezoneService: %v", err)
		}
	}
	return globalTimezones
}

// Known points, including places where the zone is not the one a naive
// country-level guess would give: Kathmandu (UTC+5:45), the US mountain/central
// split, and Spain's mainland/Canaries split.
func TestTimezoneLookupKnownPoints(t *testing.T) {
	svc := loadTimezonesForTest(t)

	cases := []struct {
		name     string
		lat, lon float64
		want     string
	}{
		{"London", 51.5074, -0.1278, "Europe/London"},
		{"New York", 40.7128, -74.0060, "America/New_York"},
		{"Denver", 39.7392, -104.9903, "America/Denver"},
		{"Chicago", 41.8781, -87.6298, "America/Chicago"},
		{"Kathmandu", 27.7172, 85.3240, "Asia/Kathmandu"},
		{"Madrid", 40.4168, -3.7038, "Europe/Madrid"},
		{"Las Palmas", 28.1235, -15.4363, "Atlantic/Canary"},
		{"Sydney", -33.8688, 151.2093, "Australia/Sydney"},
		{"Adelaide", -34.9285, 138.6007, "Australia/Adelaide"},
		{"Tokyo", 35.6762, 139.6503, "Asia/Tokyo"},
	}

	for _, c := range cases {
		if got := svc.lookup(c.lat, c.lon); got != c.want {
			t.Errorf("%s (%.4f, %.4f): got %q, want %q", c.name, c.lat, c.lon, got, c.want)
		}
	}
}

// The shipped dataset is land only — a point at sea has no zone, and the API
// omits the field rather than inventing one.
func TestTimezoneLookupAtSea(t *testing.T) {
	svc := loadTimezonesForTest(t)

	for _, c := range []struct {
		name     string
		lat, lon float64
	}{
		{"mid-Atlantic", 30.0, -40.0},
		{"mid-Pacific", 0.0, -150.0},
	} {
		if got := svc.lookup(c.lat, c.lon); got != "" {
			t.Errorf("%s: got %q, want empty", c.name, got)
		}
	}
}

// Every name in the dataset must be loadable by Go's tz database, which is the
// same guarantee the browser's Intl needs to format a local time.
func TestTimezoneNamesAreLoadable(t *testing.T) {
	svc := loadTimezonesForTest(t)

	for _, z := range svc.zones {
		if _, err := time.LoadLocation(z.TZID); err != nil {
			t.Errorf("zone %q not in the tz database: %v", z.TZID, err)
		}
	}
}

// The country lookup should carry the timezone through for a land result.
func TestCountryResultCarriesTimezone(t *testing.T) {
	loadTimezonesForTest(t)
	if _, err := os.Stat(testGeoJSONPath); err != nil {
		t.Skipf("natural earth dataset not present: %v", err)
	}
	if globalNaturalEarth == nil {
		if err := InitNaturalEarthService(testGeoJSONPath); err != nil {
			t.Fatalf("InitNaturalEarthService: %v", err)
		}
	}

	res, err := GetCountryForLatLon(51.5074, -0.1278)
	if err != nil {
		t.Fatalf("GetCountryForLatLon: %v", err)
	}
	if res.Timezone != "Europe/London" {
		t.Errorf("timezone: got %q, want %q", res.Timezone, "Europe/London")
	}
}

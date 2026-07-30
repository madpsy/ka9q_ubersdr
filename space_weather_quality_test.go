package main

import (
	"math"
	"testing"
)

// London, the default receiver location (geomagnetic latitude ~53N).
const (
	londonLat = 51.507
	londonLon = -0.128
)

func TestGeomagneticLatitude(t *testing.T) {
	tests := []struct {
		name     string
		lat, lon float64
		want     float64
		tol      float64
	}{
		{"London", londonLat, londonLon, 53.4, 1.5},
		{"geomagnetic north pole", geomagPoleLat, geomagPoleLon, 90.0, 0.1},
		{"Singapore", 1.35, 103.8, -8.0, 3.0},
		// Same geographic latitude, very different geomagnetic latitude: the
		// pole offset puts North America closer to the auroral oval.
		{"Chicago 41N", 41.9, -87.6, 51.8, 2.0},
		{"Beijing 40N", 39.9, 116.4, 30.0, 2.5},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := geomagneticLatitude(tt.lat, tt.lon)
			if math.Abs(got-tt.want) > tt.tol {
				t.Errorf("geomagneticLatitude(%v, %v) = %.1f, want %.1f (+/-%.1f)",
					tt.lat, tt.lon, got, tt.want, tt.tol)
			}
		})
	}
}

// TestPropagationQualityRegressions covers the cases the previous additive
// scoring got wrong: neither input could hold the result down on its own.
func TestPropagationQualityRegressions(t *testing.T) {
	tests := []struct {
		name     string
		flux     float64
		kp       float64
		observed int
		forecast *ForecastData
		want     string
	}{
		// Deep solar minimum. 10m closed to F2 and 15m sporadic, but 20m still
		// opens daily and the low bands are excellent at night: a quiet field
		// does not make this "Good", and low flux alone does not make it "Poor".
		{"solar minimum, quiet field", 65, 1, 0, nil, "Fair"},
		{"very low flux, quiet field", 72, 1, 0, nil, "Fair"},
		{"solar minimum with an active field", 65, 4.33, 0, nil, "Poor"},

		// Severe storm. High flux must not rescue this.
		{"G5 storm, very high flux", 300, 9, 0, nil, "Poor"},
		{"G4 storm, high flux", 200, 8, 0, nil, "Poor"},
		{"G2 storm, high flux", 200, 6, 0, nil, "Fair"},

		// Healthy combinations.
		{"high flux, quiet field", 185, 1, 0, nil, "Excellent"},
		{"good flux, quiet field", 150, 2, 0, nil, "Good"},
		{"moderate flux, quiet field", 110, 1, 0, nil, "Good"},
		{"good flux, unsettled field", 150, 4, 0, nil, "Good"},
		{"good flux, G1 storm", 150, 5, 0, nil, "Fair"},

		// Radio blackouts. R3+ is a blackout, not a gradient.
		{"R3 blackout despite ideal indices", 200, 1, 3, nil, "Poor"},
		{"R1 costs one grade", 185, 1, 1, nil, "Good"},
		{"R2 costs two grades", 160, 1, 2, nil, "Fair"},

		// A forecast storm degrades; an in-progress storm is caught by Kp.
		{"forecast G3 with quiet measured Kp", 180, 1, 0,
			&ForecastData{GeomagneticStorm: "G3 - Strong", GScale: "3"}, "Poor"},
		{"no storm expected", 180, 1, 0,
			&ForecastData{GeomagneticStorm: "None expected", GScale: "0"}, "Excellent"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := calculatePropagationQuality(tt.flux, tt.kp, tt.observed, tt.forecast, londonLat, londonLon)
			if got != tt.want {
				t.Errorf("calculatePropagationQuality(flux=%v, kp=%v, R=%d) = %q, want %q",
					tt.flux, tt.kp, tt.observed, got, tt.want)
			}
		})
	}
}

// Both inputs must be able to hold the result down without help from the other.
func TestPropagationQualityBothInputsHaveFloorAuthority(t *testing.T) {
	// Low flux caps the result no matter how quiet the field.
	for kp := 0.0; kp <= 2.0; kp += 0.33 {
		got := calculatePropagationQuality(65, kp, 0, nil, londonLat, londonLon)
		if got == "Good" || got == "Excellent" {
			t.Errorf("SFI 65 at Kp %.2f returned %q; low flux must cap the result", kp, got)
		}
	}

	// High Kp caps the result no matter how high the flux.
	for flux := 100.0; flux <= 300.0; flux += 25 {
		got := calculatePropagationQuality(flux, 8, 0, nil, londonLat, londonLon)
		if got != "Poor" {
			t.Errorf("Kp 8 at SFI %.0f returned %q; a severe storm must read Poor", flux, got)
		}
	}
}

// The same Kp is far more damaging inside the auroral zone than near the
// geomagnetic equator.
func TestPropagationQualityLatitudeWeighting(t *testing.T) {
	const (
		flux = 150
		kp   = 5 // G1
	)

	high := calculatePropagationQuality(flux, kp, 0, nil, 64.1, -21.9) // Reykjavik
	low := calculatePropagationQuality(flux, kp, 0, nil, 1.35, 103.8)  // Singapore
	mid := calculatePropagationQuality(flux, kp, 0, nil, londonLat, londonLon)

	rank := map[string]int{"Poor": 0, "Fair": 1, "Good": 2, "Excellent": 3}

	if rank[high] >= rank[low] {
		t.Errorf("G1 storm: auroral-zone quality %q should be worse than equatorial %q", high, low)
	}
	if rank[mid] > rank[low] || rank[mid] < rank[high] {
		t.Errorf("G1 storm: mid-latitude %q should sit between auroral %q and equatorial %q", mid, high, low)
	}
}

// Kp arrives from NOAA in thirds; rounding before thresholding loses the step
// that separates an active field from a storm.
func TestPropagationQualityUsesUnroundedKp(t *testing.T) {
	lower := calculatePropagationQuality(150, 4.33, 0, nil, londonLat, londonLon)
	upper := calculatePropagationQuality(150, 4.67, 0, nil, londonLat, londonLon)

	if lower == upper {
		// Not strictly wrong, but the sub-step must at least be able to matter.
		scoreLo := fluxScore(150) - geomagneticPenalty(4.33, geomagneticLatitude(londonLat, londonLon))
		scoreHi := fluxScore(150) - geomagneticPenalty(4.67, geomagneticLatitude(londonLat, londonLon))
		if scoreLo == scoreHi {
			t.Error("Kp 4.33 and 4.67 produced identical scores; unrounded Kp is being discarded")
		}
	}
}

func TestFluxScoreIsMonotonic(t *testing.T) {
	prev := -1.0
	for flux := 0.0; flux <= 320.0; flux += 5 {
		got := fluxScore(flux)
		if got < prev {
			t.Fatalf("fluxScore not monotonic at SFI %.0f: %.3f after %.3f", flux, got, prev)
		}
		prev = got
	}

	// The ramp must actually discriminate across the operationally
	// significant range rather than saturating early.
	if fluxScore(80) >= fluxScore(120) || fluxScore(120) >= fluxScore(160) {
		t.Error("fluxScore fails to discriminate across 80-160 SFU")
	}
}

func TestGScaleToKp(t *testing.T) {
	tests := []struct {
		g    int
		want float64
	}{{0, 0}, {1, 5}, {2, 6}, {3, 7}, {4, 8}, {5, 9}, {9, 9}, {-1, 0}}
	for _, tt := range tests {
		if got := gScaleToKp(tt.g); got != tt.want {
			t.Errorf("gScaleToKp(%d) = %v, want %v", tt.g, got, tt.want)
		}
	}
}

func TestForecastGScale(t *testing.T) {
	tests := []struct {
		name     string
		forecast *ForecastData
		want     int
	}{
		{"nil", nil, 0},
		{"none expected", &ForecastData{GeomagneticStorm: "None expected"}, 0},
		{"from GScale field", &ForecastData{GeomagneticStorm: "G3 - Strong", GScale: "3"}, 3},
		{"parsed from display string", &ForecastData{GeomagneticStorm: "G2 - Moderate"}, 2},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := forecastGScale(tt.forecast); got != tt.want {
				t.Errorf("forecastGScale() = %d, want %d", got, tt.want)
			}
		})
	}
}

// A forecast storm must degrade the low bands during the day too — that branch
// previously used the raw K-index and skipped the storm adjustment entirely.
func TestBandConditionsDaytimeLowBandsHonourStormForecast(t *testing.T) {
	quiet := calculateBandConditions(120, 1, true, nil)
	storm := calculateBandConditions(120, 1, true,
		&ForecastData{GeomagneticStorm: "G4 - Severe", GScale: "4"})

	if quiet["80m"] != "Fair" {
		t.Errorf("quiet daytime 80m = %q, want Fair", quiet["80m"])
	}
	if storm["80m"] != "Poor" {
		t.Errorf("daytime 80m under G4 forecast = %q, want Poor", storm["80m"])
	}
}

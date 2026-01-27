package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"
)

// SunCalcResponse represents the API response with sun/moon data
type SunCalcResponse struct {
	Location    LocationInfo `json:"location"`
	CurrentTime string       `json:"current_time"`
	IsDaytime   bool         `json:"is_daytime"`
	Sun         SunInfo      `json:"sun"`
	Moon        MoonInfo     `json:"moon"`
	Timestamp   string       `json:"timestamp"`
}

// LocationInfo contains location details
type LocationInfo struct {
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
	Altitude  int     `json:"altitude_asl"` // Altitude above sea level in meters
}

// SunInfo contains sun position and times
type SunInfo struct {
	Position SunPositionInfo `json:"position"`
	Times    SunTimesInfo    `json:"times"`
}

// SunPositionInfo contains current sun position
type SunPositionInfo struct {
	Azimuth     float64 `json:"azimuth_rad"`
	AzimuthDeg  float64 `json:"azimuth_deg"`
	Altitude    float64 `json:"altitude_rad"`
	AltitudeDeg float64 `json:"altitude_deg"`
}

// SunTimesInfo contains sun times for the day
type SunTimesInfo struct {
	Sunrise       string `json:"sunrise"`
	SunriseEnd    string `json:"sunrise_end"`
	Sunset        string `json:"sunset"`
	SunsetStart   string `json:"sunset_start"`
	Dawn          string `json:"dawn"`
	Dusk          string `json:"dusk"`
	NauticalDawn  string `json:"nautical_dawn"`
	NauticalDusk  string `json:"nautical_dusk"`
	NightEnd      string `json:"night_end"`
	Night         string `json:"night"`
	GoldenHourEnd string `json:"golden_hour_end"`
	GoldenHour    string `json:"golden_hour"`
	SolarNoon     string `json:"solar_noon"`
	Nadir         string `json:"nadir"`
}

// MoonInfo contains moon position, illumination and times
type MoonInfo struct {
	Position     MoonPositionInfo     `json:"position"`
	Illumination MoonIlluminationInfo `json:"illumination"`
	Times        MoonTimesInfo        `json:"times"`
}

// MoonPositionInfo contains current moon position
type MoonPositionInfo struct {
	Azimuth          float64 `json:"azimuth_rad"`
	AzimuthDeg       float64 `json:"azimuth_deg"`
	Altitude         float64 `json:"altitude_rad"`
	AltitudeDeg      float64 `json:"altitude_deg"`
	Distance         float64 `json:"distance_km"`
	ParallacticAngle float64 `json:"parallactic_angle_rad"`
}

// MoonIlluminationInfo contains moon illumination data
type MoonIlluminationInfo struct {
	Fraction    float64 `json:"fraction"`
	FractionPct float64 `json:"fraction_percent"`
	Phase       float64 `json:"phase"`
	PhaseName   string  `json:"phase_name"`
	Angle       float64 `json:"angle_rad"`
}

// MoonTimesInfo contains moon rise/set times
type MoonTimesInfo struct {
	Rise       *string `json:"rise,omitempty"`
	Set        *string `json:"set,omitempty"`
	AlwaysUp   bool    `json:"always_up"`
	AlwaysDown bool    `json:"always_down"`
}

// getMoonPhaseName returns the name of the moon phase
func getMoonPhaseName(phase float64) string {
	if phase < 0.03 {
		return "New Moon"
	} else if phase < 0.22 {
		return "Waxing Crescent"
	} else if phase < 0.28 {
		return "First Quarter"
	} else if phase < 0.47 {
		return "Waxing Gibbous"
	} else if phase < 0.53 {
		return "Full Moon"
	} else if phase < 0.72 {
		return "Waning Gibbous"
	} else if phase < 0.78 {
		return "Last Quarter"
	} else if phase < 0.97 {
		return "Waning Crescent"
	}
	return "New Moon"
}

// handleSunCalcAPI handles the /api/suncalc endpoint
func handleSunCalcAPI(w http.ResponseWriter, r *http.Request, config *Config) {
	// Get current time
	now := time.Now().UTC()

	// Get location from config
	lat := config.Admin.GPS.Lat
	lon := config.Admin.GPS.Lon
	alt := config.Admin.ASL

	// Check if coordinates are set
	if lat == 0 && lon == 0 {
		http.Error(w, "GPS coordinates not configured", http.StatusServiceUnavailable)
		return
	}

	// Calculate sun position
	sunPos := GetPosition(now, lat, lon)

	// Calculate sun times for today
	sunTimes := GetTimes(now, lat, lon, float64(alt))

	// Determine if it's daytime
	isDaytime := now.After(sunTimes.Sunrise) && now.Before(sunTimes.Sunset)

	// Calculate moon position
	moonPos := GetMoonPosition(now, lat, lon)

	// Calculate moon illumination
	moonIllum := GetMoonIllumination(now)

	// Calculate moon times
	moonTimes := GetMoonTimes(now, lat, lon, true)

	// Build response
	response := SunCalcResponse{
		Location: LocationInfo{
			Latitude:  lat,
			Longitude: lon,
			Altitude:  alt,
		},
		CurrentTime: now.Format(time.RFC3339),
		IsDaytime:   isDaytime,
		Sun: SunInfo{
			Position: SunPositionInfo{
				Azimuth:     sunPos.Azimuth,
				AzimuthDeg:  sunPos.Azimuth / rad,
				Altitude:    sunPos.Altitude,
				AltitudeDeg: sunPos.Altitude / rad,
			},
			Times: SunTimesInfo{
				Sunrise:       sunTimes.Sunrise.Format(time.RFC3339),
				SunriseEnd:    sunTimes.SunriseEnd.Format(time.RFC3339),
				Sunset:        sunTimes.Sunset.Format(time.RFC3339),
				SunsetStart:   sunTimes.SunsetStart.Format(time.RFC3339),
				Dawn:          sunTimes.Dawn.Format(time.RFC3339),
				Dusk:          sunTimes.Dusk.Format(time.RFC3339),
				NauticalDawn:  sunTimes.NauticalDawn.Format(time.RFC3339),
				NauticalDusk:  sunTimes.NauticalDusk.Format(time.RFC3339),
				NightEnd:      sunTimes.NightEnd.Format(time.RFC3339),
				Night:         sunTimes.Night.Format(time.RFC3339),
				GoldenHourEnd: sunTimes.GoldenHourEnd.Format(time.RFC3339),
				GoldenHour:    sunTimes.GoldenHour.Format(time.RFC3339),
				SolarNoon:     sunTimes.SolarNoon.Format(time.RFC3339),
				Nadir:         sunTimes.Nadir.Format(time.RFC3339),
			},
		},
		Moon: MoonInfo{
			Position: MoonPositionInfo{
				Azimuth:          moonPos.Azimuth,
				AzimuthDeg:       moonPos.Azimuth / rad,
				Altitude:         moonPos.Altitude,
				AltitudeDeg:      moonPos.Altitude / rad,
				Distance:         moonPos.Distance,
				ParallacticAngle: moonPos.ParallacticAngle,
			},
			Illumination: MoonIlluminationInfo{
				Fraction:    moonIllum.Fraction,
				FractionPct: moonIllum.Fraction * 100,
				Phase:       moonIllum.Phase,
				PhaseName:   getMoonPhaseName(moonIllum.Phase),
				Angle:       moonIllum.Angle,
			},
			Times: MoonTimesInfo{
				AlwaysUp:   moonTimes.AlwaysUp,
				AlwaysDown: moonTimes.AlwaysDown,
			},
		},
		Timestamp: now.Format(time.RFC3339),
	}

	// Add moon rise/set times if available
	if moonTimes.Rise != nil {
		riseStr := moonTimes.Rise.Format(time.RFC3339)
		response.Moon.Times.Rise = &riseStr
	}
	if moonTimes.Set != nil {
		setStr := moonTimes.Set.Format(time.RFC3339)
		response.Moon.Times.Set = &setStr
	}

	// Set response headers
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")

	// Encode and send response
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding suncalc response: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
}

package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
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

// SunPathDataPoint represents a single point in the sun's path
type SunPathDataPoint struct {
	Time            string  `json:"time"`             // Time in RFC3339 format
	TimeLocal       string  `json:"time_local"`       // Time in HH:MM format
	Azimuth         float64 `json:"azimuth_rad"`      // Azimuth in radians
	AzimuthDeg      float64 `json:"azimuth_deg"`      // Azimuth in degrees (0-360)
	Altitude        float64 `json:"altitude_rad"`     // Altitude in radians
	AltitudeDeg     float64 `json:"altitude_deg"`     // Altitude in degrees
	IsDaytime       bool    `json:"is_daytime"`       // Whether sun is above horizon
	GreylineAzimuth float64 `json:"greyline_azimuth"` // Gray line bearing in degrees (perpendicular to sun)
}

// SunPathResponse represents the API response for sun path data
type SunPathResponse struct {
	Location    LocationInfo       `json:"location"`
	Date        string             `json:"date"`         // Date in YYYY-MM-DD format
	StepMinutes int                `json:"step_minutes"` // Time step in minutes
	DataPoints  []SunPathDataPoint `json:"data_points"`  // Array of sun positions
	SunTimes    SunTimesInfo       `json:"sun_times"`    // Sun times for the day
	Timestamp   string             `json:"timestamp"`    // When this data was generated
}

// handleSunPathAPI handles the /api/suncalc/path endpoint
// Returns sun positions throughout the day at specified intervals
// Query parameters:
//   - step: time step in minutes (default: 15, min: 1, max: 60)
//   - daytime_only: if "true", only return positions where sun is above horizon (default: false)
//   - overlap: minutes before sunrise/after sunset to extend daytime window (default: 0, only used if daytime_only=true)
//   - greyline: if "true", calculate gray line bearing (perpendicular to sun) instead of sun azimuth (default: false)
//   - sunrise_start: solar event name to start sunrise tracking (e.g., "nightEnd", "dawn")
//   - sunrise_end: solar event name to end sunrise tracking (e.g., "goldenHourEnd", "sunriseEnd")
//   - sunset_start: solar event name to start sunset tracking (e.g., "sunsetStart", "goldenHour")
//   - sunset_end: solar event name to end sunset tracking (e.g., "dusk", "nauticalDusk")
func handleSunPathAPI(w http.ResponseWriter, r *http.Request, config *Config) {
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

	// Parse step parameter (default 15 minutes)
	stepMinutes := 15
	if stepParam := r.URL.Query().Get("step"); stepParam != "" {
		if step, err := strconv.Atoi(stepParam); err == nil {
			// Validate step range (1-60 minutes)
			if step < 1 {
				stepMinutes = 1
			} else if step > 60 {
				stepMinutes = 60
			} else {
				stepMinutes = step
			}
		}
	}

	// Parse daytime_only parameter (default false)
	daytimeOnly := r.URL.Query().Get("daytime_only") == "true"

	// Parse greyline parameter (default false)
	greyline := r.URL.Query().Get("greyline") == "true"

	// Parse custom solar event parameters for two separate tracking windows
	sunriseStart := r.URL.Query().Get("sunrise_start")
	sunriseEnd := r.URL.Query().Get("sunrise_end")
	sunsetStart := r.URL.Query().Get("sunset_start")
	sunsetEnd := r.URL.Query().Get("sunset_end")

	// Parse overlap parameter (default 0 minutes)
	overlapMinutes := 0
	if overlapParam := r.URL.Query().Get("overlap"); overlapParam != "" {
		if overlap, err := strconv.Atoi(overlapParam); err == nil {
			// Validate overlap range (0-180 minutes)
			if overlap < 0 {
				overlapMinutes = 0
			} else if overlap > 180 {
				overlapMinutes = 180
			} else {
				overlapMinutes = overlap
			}
		}
	}

	// Calculate sun times for today
	sunTimes := GetTimes(now, lat, lon, float64(alt))

	// Calculate tracking window(s) with overlap or custom events if daytime_only is true
	var trackingStart, trackingEnd time.Time
	var hasTwoWindows bool
	var sunriseWindowStart, sunriseWindowEnd, sunsetWindowStart, sunsetWindowEnd time.Time

	if daytimeOnly {
		if sunriseStart != "" && sunriseEnd != "" && sunsetStart != "" && sunsetEnd != "" {
			// Use custom solar events for two separate tracking windows
			hasTwoWindows = true
			sunriseWindowStart = getSolarEventTimeFromSunTimes(&sunTimes, sunriseStart)
			sunriseWindowEnd = getSolarEventTimeFromSunTimes(&sunTimes, sunriseEnd)
			sunsetWindowStart = getSolarEventTimeFromSunTimes(&sunTimes, sunsetStart)
			sunsetWindowEnd = getSolarEventTimeFromSunTimes(&sunTimes, sunsetEnd)
		} else {
			// Use default overlap-based tracking window (single continuous window)
			overlapDuration := time.Duration(overlapMinutes) * time.Minute
			trackingStart = sunTimes.Sunrise.Add(-overlapDuration)
			trackingEnd = sunTimes.Sunset.Add(overlapDuration)
		}
	}

	// Start at midnight of the current day
	startOfDay := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())

	// Generate data points for the entire day (24 hours)
	dataPoints := []SunPathDataPoint{}
	for minutes := 0; minutes < 24*60; minutes += stepMinutes {
		currentTime := startOfDay.Add(time.Duration(minutes) * time.Minute)

		// Calculate sun position for this time
		sunPos := GetPosition(currentTime, lat, lon)

		// Determine if it's daytime (sun above horizon with overlap or in custom windows)
		var isDaytime bool
		if daytimeOnly {
			if hasTwoWindows {
				// Check if we're in either the sunrise or sunset window
				inSunriseWindow := currentTime.After(sunriseWindowStart) && currentTime.Before(sunriseWindowEnd)
				inSunsetWindow := currentTime.After(sunsetWindowStart) && currentTime.Before(sunsetWindowEnd)
				isDaytime = inSunriseWindow || inSunsetWindow
			} else {
				// Use single tracking window with overlap
				isDaytime = currentTime.After(trackingStart) && currentTime.Before(trackingEnd)
			}
		} else {
			// Use standard sunrise/sunset
			isDaytime = currentTime.After(sunTimes.Sunrise) && currentTime.Before(sunTimes.Sunset)
		}

		// Normalize azimuth to 0-360 degrees range
		// SunCalc returns azimuth in range -π to +π (south = 0, east = -π/2, west = π/2)
		// We need to convert to 0-360 range (north = 0, east = 90, south = 180, west = 270)
		azimuthDeg := sunPos.Azimuth / rad
		azimuthDeg = azimuthDeg + 180.0 // Shift from [-180,180] to [0,360] with south at 180
		if azimuthDeg < 0 {
			azimuthDeg += 360.0
		} else if azimuthDeg >= 360 {
			azimuthDeg -= 360.0
		}

		// Calculate gray line bearing (perpendicular to sun direction)
		// The gray line is the terminator between day and night, perpendicular to sun's bearing
		// Add 90° to point along the gray line (toward the evening terminator)
		greylineAzimuth := azimuthDeg + 90.0
		if greylineAzimuth >= 360.0 {
			greylineAzimuth -= 360.0
		}

		// If greyline mode is enabled, use gray line bearing as the primary azimuth
		displayAzimuth := azimuthDeg
		if greyline {
			displayAzimuth = greylineAzimuth
		}

		// Skip nighttime positions if daytime_only is true
		if daytimeOnly && !isDaytime {
			continue
		}

		dataPoint := SunPathDataPoint{
			Time:            currentTime.Format(time.RFC3339),
			TimeLocal:       currentTime.Format("15:04"),
			Azimuth:         sunPos.Azimuth,
			AzimuthDeg:      displayAzimuth,
			Altitude:        sunPos.Altitude,
			AltitudeDeg:     sunPos.Altitude / rad,
			IsDaytime:       isDaytime,
			GreylineAzimuth: greylineAzimuth,
		}

		dataPoints = append(dataPoints, dataPoint)
	}

	// Build response
	response := SunPathResponse{
		Location: LocationInfo{
			Latitude:  lat,
			Longitude: lon,
			Altitude:  alt,
		},
		Date:        now.Format("2006-01-02"),
		StepMinutes: stepMinutes,
		DataPoints:  dataPoints,
		SunTimes: SunTimesInfo{
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
		Timestamp: now.Format(time.RFC3339),
	}

	// Set response headers
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=3600") // Cache for 1 hour since sun path doesn't change much

	// Encode and send response
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding sun path response: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
}

// getSolarEventTimeFromSunTimes returns the time for a given solar event name
func getSolarEventTimeFromSunTimes(sunTimes *SunTimes, eventName string) time.Time {
	switch eventName {
	case "sunrise":
		return sunTimes.Sunrise
	case "sunset":
		return sunTimes.Sunset
	case "dawn":
		return sunTimes.Dawn
	case "dusk":
		return sunTimes.Dusk
	case "sunriseEnd":
		return sunTimes.SunriseEnd
	case "sunsetStart":
		return sunTimes.SunsetStart
	case "solarNoon":
		return sunTimes.SolarNoon
	case "nadir":
		return sunTimes.Nadir
	case "goldenHour":
		return sunTimes.GoldenHour
	case "goldenHourEnd":
		return sunTimes.GoldenHourEnd
	case "nauticalDawn":
		return sunTimes.NauticalDawn
	case "nauticalDusk":
		return sunTimes.NauticalDusk
	case "nightEnd":
		return sunTimes.NightEnd
	case "night":
		return sunTimes.Night
	default:
		// Default to sunrise for unknown events
		return sunTimes.Sunrise
	}
}

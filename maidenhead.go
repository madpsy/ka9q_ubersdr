package main

import (
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"math"
	"strings"
)

// MaidenheadToLatLon converts a Maidenhead locator to latitude and longitude
// Supports 4, 6, or 8 character precision
// Returns the center point of the grid square
func MaidenheadToLatLon(locator string) (lat, lon float64, err error) {
	locator = strings.ToUpper(locator)

	// Validate length (must be 4, 6, or 8 characters)
	if len(locator) != 4 && len(locator) != 6 && len(locator) != 8 {
		return 0, 0, fmt.Errorf("invalid Maidenhead locator length: %d (must be 4, 6, or 8)", len(locator))
	}

	// Validate format
	if len(locator) >= 2 {
		if locator[0] < 'A' || locator[0] > 'R' || locator[1] < 'A' || locator[1] > 'R' {
			return 0, 0, fmt.Errorf("invalid field characters (must be A-R)")
		}
	}
	if len(locator) >= 4 {
		if locator[2] < '0' || locator[2] > '9' || locator[3] < '0' || locator[3] > '9' {
			return 0, 0, fmt.Errorf("invalid square characters (must be 0-9)")
		}
	}
	if len(locator) >= 6 {
		if locator[4] < 'A' || locator[4] > 'X' || locator[5] < 'A' || locator[5] > 'X' {
			return 0, 0, fmt.Errorf("invalid subsquare characters (must be A-X)")
		}
	}
	if len(locator) == 8 {
		if locator[6] < '0' || locator[6] > '9' || locator[7] < '0' || locator[7] > '9' {
			return 0, 0, fmt.Errorf("invalid extended square characters (must be 0-9)")
		}
	}

	// Field (first 2 characters): 20° longitude × 10° latitude
	lon = float64(locator[0]-'A') * 20.0
	lat = float64(locator[1]-'A') * 10.0

	// Square (characters 3-4): 2° longitude × 1° latitude
	if len(locator) >= 4 {
		lon += float64(locator[2]-'0') * 2.0
		lat += float64(locator[3]-'0') * 1.0
	}

	// Subsquare (characters 5-6): 5' longitude × 2.5' latitude
	if len(locator) >= 6 {
		lon += float64(locator[4]-'A') * (2.0 / 24.0)
		lat += float64(locator[5]-'A') * (1.0 / 24.0)
	}

	// Extended square (characters 7-8): 0.5' longitude × 0.25' latitude
	if len(locator) == 8 {
		lon += float64(locator[6]-'0') * (2.0 / 240.0)
		lat += float64(locator[7]-'0') * (1.0 / 240.0)
	}

	// Adjust to center of grid square and convert to -180/+180, -90/+90
	switch len(locator) {
	case 4:
		lon += 1.0 // Center of 2° square
		lat += 0.5 // Center of 1° square
	case 6:
		lon += (2.0 / 48.0) // Center of 5' subsquare
		lat += (1.0 / 48.0) // Center of 2.5' subsquare
	case 8:
		lon += (2.0 / 480.0) // Center of 0.5' extended square
		lat += (1.0 / 480.0) // Center of 0.25' extended square
	}

	// Convert to standard coordinate system
	lon -= 180.0
	lat -= 90.0

	return lat, lon, nil
}

// MaidenheadToLatLonWithJitter converts a Maidenhead locator to latitude and longitude
// with random jitter within the grid square bounds to prevent overlapping markers
func MaidenheadToLatLonWithJitter(locator string) (lat, lon float64, err error) {
	// Get the center point
	centerLat, centerLon, err := MaidenheadToLatLon(locator)
	if err != nil {
		return 0, 0, err
	}

	// Calculate grid square size based on locator precision
	var latRange, lonRange float64
	switch len(locator) {
	case 4:
		// 2° longitude × 1° latitude square
		lonRange = 2.0
		latRange = 1.0
	case 6:
		// 5' longitude × 2.5' latitude subsquare
		lonRange = 2.0 / 24.0
		latRange = 1.0 / 24.0
	case 8:
		// 0.5' longitude × 0.25' latitude extended square
		lonRange = 2.0 / 240.0
		latRange = 1.0 / 240.0
	default:
		return centerLat, centerLon, nil
	}

	// Generate random offsets within ±40% of the grid square size
	// (80% of the square to avoid edges)
	latOffset := (randomFloat64() - 0.5) * latRange * 0.8
	lonOffset := (randomFloat64() - 0.5) * lonRange * 0.8

	return centerLat + latOffset, centerLon + lonOffset, nil
}

// randomFloat64 generates a cryptographically secure random float64 between 0 and 1
func randomFloat64() float64 {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		// Fallback to a simple pseudo-random if crypto/rand fails
		return 0.5
	}
	// Convert to uint64 and normalize to [0, 1)
	return float64(binary.BigEndian.Uint64(b[:])) / float64(1<<64)
}

// CalculateDistanceAndBearing calculates the great circle distance (in km) and bearing (in degrees)
// between two points specified by latitude and longitude using the Haversine formula
func CalculateDistanceAndBearing(lat1, lon1, lat2, lon2 float64) (distanceKm float64, bearingDeg float64) {
	const earthRadiusKm = 6371.0

	// Convert to radians
	lat1Rad := lat1 * math.Pi / 180.0
	lon1Rad := lon1 * math.Pi / 180.0
	lat2Rad := lat2 * math.Pi / 180.0
	lon2Rad := lon2 * math.Pi / 180.0

	// Haversine formula for distance
	dLat := lat2Rad - lat1Rad
	dLon := lon2Rad - lon1Rad

	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1Rad)*math.Cos(lat2Rad)*
			math.Sin(dLon/2)*math.Sin(dLon/2)
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	distanceKm = earthRadiusKm * c

	// Calculate bearing
	y := math.Sin(dLon) * math.Cos(lat2Rad)
	x := math.Cos(lat1Rad)*math.Sin(lat2Rad) -
		math.Sin(lat1Rad)*math.Cos(lat2Rad)*math.Cos(dLon)
	bearingRad := math.Atan2(y, x)
	bearingDeg = bearingRad * 180.0 / math.Pi

	// Normalize bearing to 0-360
	if bearingDeg < 0 {
		bearingDeg += 360.0
	}

	return distanceKm, bearingDeg
}

// CalculateDistanceAndBearingFromLocators calculates distance and bearing between two Maidenhead locators
func CalculateDistanceAndBearingFromLocators(locator1, locator2 string) (distanceKm float64, bearingDeg float64, err error) {
	lat1, lon1, err := MaidenheadToLatLon(locator1)
	if err != nil {
		return 0, 0, fmt.Errorf("invalid locator1: %w", err)
	}

	lat2, lon2, err := MaidenheadToLatLon(locator2)
	if err != nil {
		return 0, 0, fmt.Errorf("invalid locator2: %w", err)
	}

	distanceKm, bearingDeg = CalculateDistanceAndBearing(lat1, lon1, lat2, lon2)
	return distanceKm, bearingDeg, nil
}

// IsValidMaidenheadLocator checks if a string is a valid Maidenhead locator
func IsValidMaidenheadLocator(locator string) bool {
	_, _, err := MaidenheadToLatLon(locator)
	return err == nil
}

package ft8

import (
	"math"
	"regexp"
	"strings"
)

/*
 * FT8/FT4 Message Parsing Utilities
 * Extracts callsign and grid locator from decoded messages
 */

var (
	// Callsign pattern (basic validation)
	callsignPattern = regexp.MustCompile(`^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,3}[A-Z]$`)

	// Grid locator pattern (4 characters for FT8/FT4)
	gridPattern = regexp.MustCompile(`^[A-R]{2}[0-9]{2}$`)
)

// extractCallsignLocator extracts callsign and grid locator from FT8/FT4 message
// Uses position-based parsing to avoid ambiguity (some strings can be both callsign and grid)
// Examples:
//
//	CQ MM3NDH IO86       → TX = MM3NDH (field[1]), Grid = IO86 (field[2])
//	SV3AUW MM3NDH IO86   → TX = MM3NDH (field[1]), Grid = IO86 (field[2])
//	SV3AUW MM3NDH -15    → TX = MM3NDH (field[1]), Grid = ""
//	SV3AUW MM3NDH R-15   → TX = MM3NDH (field[1]), Grid = ""
//	SV3AUW MM3NDH RR73   → TX = MM3NDH (field[1]), Grid = ""
//	SV3AUW MM3NDH 73     → TX = MM3NDH (field[1]), Grid = ""
//	<...> DL9SFE JN48    → TX = DL9SFE (field[1]), Grid = JN48 (field[2])
func extractCallsignLocator(message string) (string, string) {
	fields := strings.Fields(message)
	if len(fields) < 2 {
		return "", ""
	}

	var transmitterCall string
	var locator string

	// Position-based parsing:
	// - If starts with "CQ" or "<...>": TX = field[1], Grid = field[2] (if valid)
	// - Otherwise: TX = field[1], Grid = field[2] (if valid)
	// This avoids ambiguity where strings like "HJ54FF" could be both callsign and grid

	if fields[0] == "CQ" || fields[0] == "CQ_" || fields[0] == "<...>" {
		// CQ or truncated message: transmitter is field[1]
		if len(fields) >= 2 && isValidCallsign(fields[1]) {
			transmitterCall = fields[1]
		}
		// Grid is field[2] if present and valid
		if len(fields) >= 3 && isValidGridLocator(fields[2]) {
			locator = fields[2]
		}
	} else {
		// Directed message: transmitter is field[1] (second field)
		if len(fields) >= 2 && isValidCallsign(fields[1]) {
			transmitterCall = fields[1]
		}
		// Grid is field[2] if present and valid
		if len(fields) >= 3 && isValidGridLocator(fields[2]) {
			locator = fields[2]
		}
	}

	return transmitterCall, locator
}

// isValidCallsign checks if a string looks like a valid amateur radio callsign
func isValidCallsign(s string) bool {
	// Strip angle brackets if present (some decoders output <CALLSIGN>)
	s = strings.Trim(s, "<>")

	if len(s) < 3 || len(s) > 15 {
		return false
	}
	// Convert to uppercase for pattern matching
	s = strings.ToUpper(s)
	return callsignPattern.MatchString(s)
}

// isValidGridLocator checks if a string looks like a valid Maidenhead grid locator
// FT8/FT4 only support 4-character locators
func isValidGridLocator(s string) bool {
	if len(s) != 4 {
		return false
	}

	// Exclude FT8 protocol messages that look like grid locators
	upper := strings.ToUpper(s)
	if upper == "RR73" || upper == "RRR" || strings.HasPrefix(upper, "R-") ||
		strings.HasPrefix(upper, "R+") || upper == "73" {
		return false
	}

	// Convert to proper case for pattern matching (uppercase letters, digits)
	s = strings.ToUpper(s[0:2]) + s[2:]
	return gridPattern.MatchString(s)
}

// MaidenheadToLatLon converts a Maidenhead locator to latitude and longitude
// Supports 4, 6, or 8 character precision
// Returns the center point of the grid square
func MaidenheadToLatLon(locator string) (lat, lon float64, err error) {
	if len(locator) < 4 {
		return 0, 0, nil
	}

	// Convert to uppercase
	locator = strings.ToUpper(locator)

	// Field (first 2 characters): 20° longitude × 10° latitude
	lon = float64(locator[0]-'A')*20.0 - 180.0
	lat = float64(locator[1]-'A')*10.0 - 90.0

	// Square (next 2 characters): 2° longitude × 1° latitude
	lon += float64(locator[2]-'0') * 2.0
	lat += float64(locator[3]-'0') * 1.0

	// Adjust to center of grid square
	lon += 1.0 // Center of 2° square
	lat += 0.5 // Center of 1° square

	return lat, lon, nil
}

// CalculateDistanceAndBearing calculates the great circle distance (in km) and bearing (in degrees)
// between two points specified by latitude and longitude using the Haversine formula
func CalculateDistanceAndBearing(lat1, lon1, lat2, lon2 float64) (distanceKm float64, bearingDeg float64) {
	const earthRadiusKm = 6371.0
	const toRad = 3.14159265358979323846 / 180.0

	// Convert to radians
	lat1Rad := lat1 * toRad
	lon1Rad := lon1 * toRad
	lat2Rad := lat2 * toRad
	lon2Rad := lon2 * toRad

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
	bearingDeg = bearingRad / toRad

	// Normalize bearing to 0-360
	if bearingDeg < 0 {
		bearingDeg += 360.0
	}

	return distanceKm, bearingDeg
}

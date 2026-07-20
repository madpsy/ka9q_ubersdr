package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
)

// maidenheadRateLimiter is the global rate limiter for /api/maidenhead/country.
// Initialised once in main() alongside other rate limiters.
var maidenheadRateLimiter = NewMaidenheadRateLimiter()

// maidenheadRequest is the JSON body accepted by POST /api/maidenhead/country.
// Provide either locator OR lat+lon — locator takes priority if both are present.
type maidenheadRequest struct {
	Locator string   `json:"locator"` // Maidenhead grid locator, 4/6/8 chars (e.g. "IO86ha")
	Lat     *float64 `json:"lat"`     // Latitude in decimal degrees, -90 to +90
	Lon     *float64 `json:"lon"`     // Longitude in decimal degrees, -180 to +180
}

// handleMaidenheadCountry handles POST /api/maidenhead/country
//
// Public endpoint — rate limited to 1 request per second per IP.
// Accepts a JSON body with either a Maidenhead grid locator or a lat/lon pair.
//
// Request body examples:
//
//	{"locator": "IO86ha"}
//	{"lat": 56.02, "lon": -3.375}
//
// Response (200 OK):
//
//	{
//	  "locator":      "IO86ha",   // empty string when resolved from lat/lon
//	  "lat":          56.0208,
//	  "lon":          -3.375,
//	  "grid_min_lat": 56.0,       // same as lat/lon when resolved from coordinates
//	  "grid_min_lon": -3.4167,
//	  "grid_max_lat": 56.0417,
//	  "grid_max_lon": -3.3333,
//	  "country":      "United Kingdom",
//	  "country_long": "United Kingdom",
//	  "iso_a2":       "GB",
//	  "iso_a3":       "GBR",
//	  "continent":    "Europe",
//	  "region":       "Europe",
//	  "subregion":    "Northern Europe",
//	  "sovereign":    "United Kingdom",
//	  "method":       "intersection"  // or "largest_overlap", "point_in_polygon", "nearest_land"
//	}
func handleMaidenheadCountry(w http.ResponseWriter, r *http.Request) {
	// Only allow POST
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeJSONError(w, "method not allowed — use POST", http.StatusMethodNotAllowed)
		return
	}

	// Rate limit: 1 request per second per IP
	clientIP := getClientIP(r)
	if !maidenheadRateLimiter.AllowRequest(clientIP) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(http.StatusTooManyRequests)
		if _, err := w.Write([]byte(`{"error":"rate limit exceeded — max 1 request per second per IP"}`)); err != nil {
			log.Printf("maidenhead_api: error writing rate limit response: %v", err)
		}
		return
	}

	// Check that the Natural Earth service is available
	if !NaturalEarthEnabled() {
		writeJSONError(w, "Natural Earth dataset not loaded — check server configuration", http.StatusServiceUnavailable)
		return
	}

	// Parse JSON body (limit to 1 KB — the request is tiny)
	body, err := io.ReadAll(io.LimitReader(r.Body, 1024))
	if err != nil {
		writeJSONError(w, "failed to read request body", http.StatusBadRequest)
		return
	}
	defer func() {
		if err := r.Body.Close(); err != nil {
			log.Printf("maidenhead_api: error closing request body: %v", err)
		}
	}()

	var req maidenheadRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSONError(w, "invalid JSON body: "+err.Error(), http.StatusBadRequest)
		return
	}

	var result *MaidenheadCountryResult
	var lookupErr error

	locator := strings.TrimSpace(req.Locator)

	switch {
	case locator != "":
		// Maidenhead locator lookup — uses full grid square polygon
		result, lookupErr = GetCountryForMaidenhead(locator)

	case req.Lat != nil && req.Lon != nil:
		// Lat/lon coordinate lookup — point-in-polygon, then nearest-land fallback
		result, lookupErr = GetCountryForLatLon(*req.Lat, *req.Lon)

	case req.Lat != nil || req.Lon != nil:
		writeJSONError(w, "both lat and lon are required for coordinate lookup", http.StatusBadRequest)
		return

	default:
		writeJSONError(w, `request body must contain "locator" (Maidenhead) or "lat" and "lon" (coordinates)`, http.StatusBadRequest)
		return
	}

	if lookupErr != nil {
		errMsg := lookupErr.Error()
		status := http.StatusInternalServerError
		if strings.Contains(errMsg, "invalid") || strings.Contains(errMsg, "length") ||
			strings.Contains(errMsg, "out of range") {
			status = http.StatusBadRequest
		}
		writeJSONError(w, errMsg, status)
		return
	}

	// Success
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=86400") // country boundaries don't change
	if err := json.NewEncoder(w).Encode(result); err != nil {
		log.Printf("maidenhead_api: error encoding response: %v", err)
	}
}

// writeJSONError writes a JSON error response with the given status code.
func writeJSONError(w http.ResponseWriter, msg string, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	resp := map[string]string{"error": msg}
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		log.Printf("maidenhead_api: error encoding error response: %v", err)
	}
}

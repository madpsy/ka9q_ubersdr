package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strconv"
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

	// NearestLand controls what happens when the query hits no land.  Omitted or
	// true (the default, and the historical behaviour) attributes the query to
	// the nearest coastline with method "nearest_land" — the right answer for a
	// station report, where the locator is known to be somewhere real.  Set it
	// false when a miss is meaningful, e.g. a click on a map: the response then
	// carries method "open_water" and no country.
	NearestLand *bool `json:"nearest_land"`
}

// wantsNearestLand reports whether the nearest-land fallback should be used.
// Absent field == true, preserving the behaviour of existing callers.
func (r *maidenheadRequest) wantsNearestLand() bool {
	return r.NearestLand == nil || *r.NearestLand
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
//	{"lat": 30.0, "lon": -40.0, "nearest_land": false}   // → method "open_water"
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
//	  "method":       "intersection"  // or "largest_overlap", "point_in_polygon",
//	                                  // "nearest_land", "open_water"
//	}
//
// When method is "open_water" every country field is empty — the query hit no
// land and the caller passed "nearest_land": false.
func handleMaidenheadCountry(w http.ResponseWriter, r *http.Request) {
	// GET returns the full country list with centre coordinates
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		handleCountryList(w, r)
		return
	}

	// Only allow POST
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeJSONError(w, "method not allowed — use GET or POST", http.StatusMethodNotAllowed)
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
		result, lookupErr = GetCountryForMaidenheadOpt(locator, req.wantsNearestLand())

	case req.Lat != nil && req.Lon != nil:
		// Lat/lon coordinate lookup — point-in-polygon, then nearest land unless declined
		result, lookupErr = GetCountryForLatLonOpt(*req.Lat, *req.Lon, req.wantsNearestLand())

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

// handleCountryList handles GET /api/maidenhead/country
//
// Returns every country in the Natural Earth dataset with its centre
// coordinates and bounding box.  The payload is serialised once at startup, so
// this handler does no geometry work and no JSON encoding — it writes a cached
// buffer and is safe to call at any rate the network can carry.
//
// Response (200 OK):
//
//	{
//	  "count": 258,
//	  "countries": [
//	    {
//	      "country":        "United Kingdom",
//	      "country_long":   "United Kingdom",
//	      "iso_a2":         "GB",
//	      "iso_a3":         "GBR",
//	      "continent":      "Europe",
//	      "continent_code": "EU",
//	      "region":         "Europe",
//	      "subregion":      "Northern Europe",
//	      "sovereign":      "United Kingdom",
//	      "lat":            52.14,      // Natural Earth label point (on the main landmass)
//	      "lon":            -1.48,
//	      "min_lat":        49.9,       // bounding box of all territory in the feature
//	      "min_lon":        -8.17,
//	      "max_lat":        60.86,
//	      "max_lon":        1.75
//	    }
//	  ]
//	}
func handleCountryList(w http.ResponseWriter, r *http.Request) {
	// Rate limit: 1 request per second per IP, same as the POST path
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

	payload, etag, ok := NaturalEarthCountryListJSON()
	if !ok {
		writeJSONError(w, "Natural Earth dataset not loaded — check server configuration", http.StatusServiceUnavailable)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=86400") // country boundaries don't change
	w.Header().Set("ETag", etag)

	// The payload only changes when the server restarts with a new dataset, so a
	// conditional request is normally answered with an empty 304.
	if match := r.Header.Get("If-None-Match"); match != "" && strings.Contains(match, etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	if r.Method == http.MethodHead {
		w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
		return
	}

	if _, err := w.Write(payload); err != nil {
		log.Printf("maidenhead_api: error writing country list: %v", err)
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

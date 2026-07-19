package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
)

// /api/sessions.geojson
// ----------------------
// Publishes the current active listeners as a GeoJSON FeatureCollection so that
// Home Assistant's built-in GeoJSON integration (geo_json_events) can render
// them as transient geo_location markers on a map — pins that appear and vanish
// as listeners come and go, with no entity-registry bloat.
//
// Each Feature:
//   - geometry: Point [lon, lat]   (approximate, from GeoIP — city level)
//   - id:       the session's stable id, so the same listener keeps the same
//               marker across polls (HA keys geo_location entities off this)
//   - properties.title: short human label used as the marker/entity name
//   - properties.*: country, city, frequency, mode, chat username for cards
//
// Opt-in: only served when server.sessions_geojson_enabled is true, because it
// exposes approximate visitor locations. The data is already available (coarse,
// GeoIP city-level) via the MCP active-sessions tool.

// geoJSONFeatureCollection is the top-level GeoJSON object.
type geoJSONFeatureCollection struct {
	Type     string           `json:"type"`
	Features []geoJSONFeature `json:"features"`
}

type geoJSONFeature struct {
	Type       string                 `json:"type"`
	ID         string                 `json:"id,omitempty"`
	Geometry   geoJSONGeometry        `json:"geometry"`
	Properties map[string]interface{} `json:"properties"`
}

type geoJSONGeometry struct {
	Type        string    `json:"type"`
	Coordinates []float64 `json:"coordinates"` // [longitude, latitude]
}

// handleSessionsGeoJSON serves the active-listener GeoJSON feed.
func handleSessionsGeoJSON(
	w http.ResponseWriter,
	r *http.Request,
	config *Config,
	sm *SessionManager,
	dxWsHandler *DXClusterWebSocketHandler,
	geoIPService *GeoIPService,
	rateLimiter *SessionStatsRateLimiter,
) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if !config.Server.SessionsGeoJSONEnabled {
		http.Error(w, "Not enabled", http.StatusServiceUnavailable)
		return
	}

	// Basic per-IP rate limiting (shared with the public session-stats feed).
	clientIP := getClientIP(r)
	if rateLimiter != nil && !rateLimiter.AllowRequest(clientIP) {
		w.Header().Set("Content-Type", "application/geo+json")
		w.WriteHeader(http.StatusTooManyRequests)
		json.NewEncoder(w).Encode(map[string]string{"error": "rate_limit_exceeded"})
		return
	}

	fc := buildSessionsGeoJSON(sm, dxWsHandler, geoIPService)

	w.Header().Set("Content-Type", "application/geo+json")
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(fc); err != nil {
		log.Printf("sessions.geojson: encode error: %v", err)
	}
}

// buildSessionsGeoJSON converts the enriched sessions payload into a GeoJSON
// FeatureCollection, one Feature per external (non-internal) listener that has a
// resolved GeoIP location.
func buildSessionsGeoJSON(sm *SessionManager, dxWsHandler *DXClusterWebSocketHandler, geoIPService *GeoIPService) geoJSONFeatureCollection {
	fc := geoJSONFeatureCollection{Type: "FeatureCollection", Features: []geoJSONFeature{}}

	payload := buildSessionsPayload(sm, dxWsHandler, geoIPService)
	rawSessions, ok := payload["sessions"].([]map[string]interface{})
	if !ok {
		return fc
	}
	return sessionsToGeoJSON(rawSessions)
}

// sessionsToGeoJSON is the pure transform from enriched session maps to a
// GeoJSON FeatureCollection. Split out from buildSessionsGeoJSON so it can be
// unit-tested without a live SessionManager.
func sessionsToGeoJSON(rawSessions []map[string]interface{}) geoJSONFeatureCollection {
	fc := geoJSONFeatureCollection{Type: "FeatureCollection", Features: []geoJSONFeature{}}

	for _, s := range rawSessions {
		// Skip internal / spectrum / shared-subscriber pseudo-sessions.
		if b, _ := s["is_internal"].(bool); b {
			continue
		}
		if b, _ := s["is_spectrum"].(bool); b {
			continue
		}
		if b, _ := s["is_shared_subscriber"].(bool); b {
			continue
		}

		lat, latOK := toFloat(s["latitude"])
		lon, lonOK := toFloat(s["longitude"])
		if !latOK || !lonOK || (lat == 0 && lon == 0) {
			continue // no usable location
		}

		props := map[string]interface{}{
			"title": geoJSONSessionTitle(s),
		}
		copyIfPresent(props, s, "country", "country")
		copyIfPresent(props, s, "country_code", "country_code")
		copyIfPresent(props, s, "city", "city")
		copyIfPresent(props, s, "region", "region")
		copyIfPresent(props, s, "mode", "mode")
		copyIfPresent(props, s, "chat_username", "chat_username")
		copyIfPresent(props, s, "accuracy_radius_km", "accuracy_radius_km")
		if f, ok := toFloat(s["frequency"]); ok {
			props["frequency_hz"] = f
			props["frequency_khz"] = f / 1000.0
		}

		// Stable feature id keeps the same listener on the same marker across
		// polls. Prefer the user session id, fall back to SSRC / channel id.
		id := firstNonEmpty(
			asString(s["user_session_id"]),
			asString(s["ssrc"]),
			asString(s["id"]),
		)

		fc.Features = append(fc.Features, geoJSONFeature{
			Type:       "Feature",
			ID:         id,
			Geometry:   geoJSONGeometry{Type: "Point", Coordinates: []float64{lon, lat}},
			Properties: props,
		})
	}

	return fc
}

// geoJSONSessionTitle builds a short human label for a listener marker, e.g.
// "20m USB · Germany" or "G0ABC · 40m".
func geoJSONSessionTitle(s map[string]interface{}) string {
	var parts []string
	if u := asString(s["chat_username"]); u != "" {
		parts = append(parts, u)
	}
	if f, ok := toFloat(s["frequency"]); ok && f > 0 {
		mode := strings.ToUpper(asString(s["mode"]))
		if mode != "" {
			parts = append(parts, fmt.Sprintf("%.1f kHz %s", f/1000.0, mode))
		} else {
			parts = append(parts, fmt.Sprintf("%.1f kHz", f/1000.0))
		}
	}
	if c := asString(s["country"]); c != "" {
		parts = append(parts, c)
	}
	if len(parts) == 0 {
		return "Listener"
	}
	return strings.Join(parts, " · ")
}

// --- small helpers -----------------------------------------------------------

func toFloat(v interface{}) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case uint64:
		return float64(n), true
	case uint32:
		return float64(n), true
	default:
		return 0, false
	}
}

func asString(v interface{}) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func copyIfPresent(dst map[string]interface{}, src map[string]interface{}, srcKey, dstKey string) {
	if v, ok := src[srcKey]; ok && v != nil {
		if s, isStr := v.(string); isStr && s == "" {
			return
		}
		dst[dstKey] = v
	}
}

package main

import (
	"net/http"
)

// lookup_stats_api.go — admin API for QRZ callsign-lookup volume/cache stats.
//
// Exposes GET /admin/lookup/stats (auth required), returning:
//   - hourly counts of REAL outbound QRZ.com API calls for the last 24 hours
//     (cache hits and singleflight-deduplicated waiters are NOT counted —
//     only genuine HTTP requests made to QRZ.com, see fetchCallsign in
//     qrz_lookup.go)
//   - the running 24h total
//   - current cache size / configured max size, for context
//
// This is intended for consumption by the admin UI (e.g. a small bar chart
// of hourly QRZ call volume) once that UI is built; the endpoint itself has
// no other side effects and is safe to poll.

// lookupStatsResponse is the JSON body returned by handleLookupStats.
type lookupStatsResponse struct {
	Enabled            bool            `json:"enabled"`                        // whether lookup_services + QRZ provider are active
	Provider           string          `json:"provider,omitempty"`             // configured provider name (e.g. "qrz")
	Hourly             []QRZHourlyStat `json:"hourly,omitempty"`               // last 24 hours, oldest first; each entry now includes cache_hits
	CurrentHourMinutes []QRZMinuteStat `json:"current_hour_minutes,omitempty"` // last 60 minutes (fixed window ending at the current minute), oldest first; each entry now includes cache_hits
	Total24h           int64           `json:"total_24h"`                      // sum of Hourly[].Calls (outbound API calls only)
	CacheHits24h       int64           `json:"cache_hits_24h"`                 // sum of Hourly[].CacheHits (Lookup() calls served from cache)
	CacheMisses24h     int64           `json:"cache_misses_24h"`               // same as Total24h — outbound API calls are the cache-miss proxy
	CacheSize          int             `json:"cache_size"`                     // current number of cached callsign entries
	CacheMaxSize       int             `json:"cache_max_size"`                 // configured cache size cap (0 = unlimited)
	ImageCacheSize     int             `json:"image_cache_size"`               // current number of cached proxied images
	ImageCacheMaxSize  int             `json:"image_cache_max_size"`           // configured image cache size cap (0 = unlimited)
}

// handleLookupStats handles GET /admin/lookup/stats.
// Returns hourly QRZ.com API call volume for the last 24 hours, plus cache
// size/limit context. This is an admin-only endpoint (auth enforced by the
// caller via AdminHandler.AuthMiddleware).
func handleLookupStats(w http.ResponseWriter, r *http.Request, cfg *Config) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	resp := lookupStatsResponse{
		Provider: cfg.LookupServices.Provider,
	}

	if globalQRZService == nil {
		// Lookup service not configured/enabled — return an empty-but-valid
		// response rather than an error, so the admin UI can render a
		// "disabled" state without special-casing HTTP failures.
		writeJSON(w, http.StatusOK, resp)
		return
	}

	resp.Enabled = true
	resp.Hourly = globalQRZService.HourlyAPICallStats()
	resp.CurrentHourMinutes = globalQRZService.CurrentHourMinuteStats()
	resp.Total24h = globalQRZService.TotalAPICalls24h()
	resp.CacheHits24h = globalQRZService.TotalCacheHits24h()
	resp.CacheMisses24h = globalQRZService.TotalCacheMisses24h()
	resp.CacheSize = globalQRZService.CacheSize()
	resp.CacheMaxSize = globalQRZService.CacheMaxSize()
	if globalImageProxy != nil {
		resp.ImageCacheSize = globalImageProxy.CacheSize()
		resp.ImageCacheMaxSize = globalImageProxy.CacheMaxSize()
	}

	writeJSON(w, http.StatusOK, resp)
}

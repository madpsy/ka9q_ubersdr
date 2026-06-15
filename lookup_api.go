package main

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

	"github.com/google/uuid"
)

// reValidCallsign matches a callsign that is 3–10 alphanumeric characters (after normalisation).
var reValidCallsign = regexp.MustCompile(`^[A-Z0-9]{3,10}$`)

// lookupErrorResponse is the JSON body returned on error.
type lookupErrorResponse struct {
	Error string `json:"error"`
}

// handleLookup is the handler for GET /api/lookup.
//
// Query parameters:
//
//	callsign  – the callsign to look up (required; normalised to uppercase, suffixes stripped)
//	uuid      – the caller's session UUID (required; must match an active session)
//
// Behaviour:
//  1. Reject if lookup services are disabled.
//  2. Validate uuid — must correspond to an active audio session (not spectrum-only).
//  3. Validate and normalise the callsign.
//  4. Apply per-UUID rate limiting (bypassed users are exempt).
//     Cache hits are granted 10× the normal rate (no outbound API call needed).
//  5. Delegate to the active lookup provider and return JSON.
func handleLookup(
	w http.ResponseWriter,
	r *http.Request,
	cfg *Config,
	sessions *SessionManager,
	rateLimiter *LookupRateLimiter,
) {
	// Only GET is supported.
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// ── 1. Service must be enabled ────────────────────────────────────────────
	if !cfg.LookupServices.Enabled {
		writeJSON(w, http.StatusServiceUnavailable, lookupErrorResponse{Error: "lookup service is disabled"})
		return
	}

	// ── 2. UUID validation — must have an active audio session ────────────────
	rawUUID := strings.TrimSpace(r.URL.Query().Get("uuid"))
	if rawUUID == "" {
		writeJSON(w, http.StatusBadRequest, lookupErrorResponse{Error: "uuid parameter is required"})
		return
	}

	// Validate UUID format before touching the session map.
	if _, err := uuid.Parse(rawUUID); err != nil {
		writeJSON(w, http.StatusBadRequest, lookupErrorResponse{Error: "uuid parameter is not a valid UUID"})
		return
	}

	// Require an active audio (non-spectrum) session for this UUID.
	// Spectrum-only viewers are not permitted to use the lookup endpoint.
	if !sessions.HasActiveAudioSession(rawUUID) {
		writeJSON(w, http.StatusUnauthorized, lookupErrorResponse{Error: "an active audio session is required to use this endpoint"})
		return
	}

	// ── 3. Callsign validation (before rate limiting so we can check the cache) ──
	rawCallsign := strings.TrimSpace(r.URL.Query().Get("callsign"))
	if rawCallsign == "" {
		writeJSON(w, http.StatusBadRequest, lookupErrorResponse{Error: "callsign parameter is required"})
		return
	}

	// NormaliseCallsign strips suffixes (/P, /M, …) and country prefixes (G/MM3NDH → MM3NDH).
	normalised := NormaliseCallsign(rawCallsign)
	if !reValidCallsign.MatchString(normalised) {
		writeJSON(w, http.StatusBadRequest, lookupErrorResponse{
			Error: "callsign must be 3–10 alphanumeric characters (after normalisation)",
		})
		return
	}

	// ── 4. Rate limiting (bypassed users are exempt) ──────────────────────────
	// If the callsign is already in the local cache, or a fetch for it is
	// already in flight (singleflight will share the result — no extra API
	// call), we allow 10× the normal rate.
	bypassed := sessions.IsUUIDBypassedByAnySession(rawUUID)
	if !bypassed && rateLimiter != nil {
		cheapRequest := globalQRZService != nil &&
			(globalQRZService.CacheHas(normalised) || globalQRZService.IsInFlight(normalised))
		var allowed bool
		if cheapRequest {
			allowed = rateLimiter.AllowCachedRequest(rawUUID)
		} else {
			allowed = rateLimiter.AllowRequest(rawUUID)
		}
		if !allowed {
			writeJSON(w, http.StatusTooManyRequests, lookupErrorResponse{Error: "rate limit exceeded; please slow down"})
			return
		}
	}

	// ── 5. Provider dispatch ──────────────────────────────────────────────────
	// The handler is intentionally provider-agnostic: it calls whichever global
	// service was initialised at startup.  Adding a new provider only requires
	// wiring it up in main.go — this file does not need to change.
	switch strings.ToLower(cfg.LookupServices.Provider) {
	case "qrz":
		if globalQRZService == nil {
			writeJSON(w, http.StatusServiceUnavailable, lookupErrorResponse{Error: "lookup provider is not configured"})
			return
		}
		result, err := globalQRZService.Lookup(normalised)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, lookupErrorResponse{Error: "lookup failed: " + err.Error()})
			return
		}
		if result == nil {
			writeJSON(w, http.StatusNotFound, lookupErrorResponse{Error: "callsign not found"})
			return
		}
		writeJSON(w, http.StatusOK, result)

	default:
		writeJSON(w, http.StatusServiceUnavailable, lookupErrorResponse{Error: "no supported lookup provider is configured"})
	}
}

// writeJSON serialises v as JSON and writes it to w with the given status code.
// The Content-Type header is set to application/json.
func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

package main

import (
	"encoding/json"
	"net"
	"net/http"
	"regexp"
	"strings"

	"github.com/google/uuid"
)

// CTYAugmentation holds CTY database fields added to every lookup response.
// All fields are omitempty so the object is absent when CTY is not loaded.
type CTYAugmentation struct {
	Country     string  `json:"country,omitempty"`
	CountryCode string  `json:"country_code,omitempty"` // ISO 3166-1 alpha-2
	Continent   string  `json:"continent,omitempty"`
	CQZone      int     `json:"cq_zone,omitempty"`
	ITUZone     int     `json:"itu_zone,omitempty"`
	Latitude    float64 `json:"latitude,omitempty"`
	Longitude   float64 `json:"longitude,omitempty"`
	TimeOffset  float64 `json:"time_offset,omitempty"`
	PrimaryPfx  string  `json:"primary_prefix,omitempty"`
}

// lookupResponse wraps the QRZ result with an optional CTY augmentation block.
type lookupResponse struct {
	*QRZCallsign
	CTY *CTYAugmentation `json:"cty,omitempty"`
}

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
//	uuid      – the caller's session UUID (required for normal callers; must match an active session)
//
// Behaviour:
//  1. Reject if lookup services are disabled.
//  2. Auth:
//     a. If the request comes directly from a trusted addon container
//     (lookup_services.trusted_containers, matched on the RAW source IP via
//     IsContainerIP), no session UUID is required.
//     b. Otherwise validate uuid — must correspond to an active audio session
//     (not spectrum-only).
//  3. Validate and normalise the callsign.
//  4. Apply rate limiting: per-UUID for normal callers (bypassed users exempt),
//     or per-container for trusted containers (never exempt).
//     Cache hits are granted 10× the normal rate (no outbound API call needed).
//  5. Delegate to the active lookup provider and return JSON.
//
// SECURITY: trusted-container detection deliberately uses the RAW source IP
// (r.RemoteAddr), NOT getClientIP(), because the container is the direct TCP
// peer. It also uses IsContainerIP (name→IP map) rather than IsTrustedProxy, so
// it grants ONLY lookup access and never confers X-Real-IP spoofing privileges.
func handleLookup(
	w http.ResponseWriter,
	r *http.Request,
	cfg *Config,
	sessions *SessionManager,
	rateLimiter *LookupRateLimiter,
	containerRateLimiter *LookupRateLimiter,
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

	// ── 2. Authentication ─────────────────────────────────────────────────────
	// Detect a trusted addon container calling directly on the internal network.
	// Use the RAW source IP (the container is the direct TCP peer) and match a
	// specific container name via IsContainerIP — this grants lookup access only,
	// never trusted-proxy / header-spoofing privileges.
	rawSourceIP := r.RemoteAddr
	if host, _, err := net.SplitHostPort(rawSourceIP); err == nil {
		rawSourceIP = host
	}
	trustedContainerName := ""
	for _, name := range cfg.LookupServices.TrustedContainers {
		if name != "" && cfg.Server.IsContainerIP(rawSourceIP, name) {
			trustedContainerName = name
			break
		}
	}
	isTrustedContainer := trustedContainerName != ""

	// rawUUID is only required for non-container callers.
	rawUUID := strings.TrimSpace(r.URL.Query().Get("uuid"))
	if !isTrustedContainer {
		// ── 2b. UUID validation — must have an active audio session ───────────
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

	// ── 4. Rate limiting ──────────────────────────────────────────────────────
	// If the callsign is already in the local cache, or a fetch for it is
	// already in flight (singleflight will share the result — no extra API
	// call), we allow 10× the normal rate.
	cheapRequest := globalQRZService != nil &&
		(globalQRZService.CacheHas(normalised) || globalQRZService.IsInFlight(normalised))

	if isTrustedContainer {
		// Trusted containers use their own limiter, keyed per container name.
		// They are never exempt (always rate-limited), matching the public
		// endpoint's behaviour with a dedicated per-container rate.
		if containerRateLimiter != nil {
			key := "container:" + trustedContainerName
			var allowed bool
			if cheapRequest {
				allowed = containerRateLimiter.AllowCachedRequest(key)
			} else {
				allowed = containerRateLimiter.AllowRequest(key)
			}
			if !allowed {
				writeJSON(w, http.StatusTooManyRequests, lookupErrorResponse{Error: "rate limit exceeded; please slow down"})
				return
			}
		}
	} else {
		// Normal callers: per-UUID limiter (bypassed users are exempt).
		bypassed := sessions.IsUUIDBypassedByAnySession(rawUUID)
		if !bypassed && rateLimiter != nil {
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

		// Rewrite the QRZ image URL to a same-origin proxy path so the browser
		// can cache it normally.  Cross-origin QRZ CDN URLs are always fetched
		// with Cache-Control: no-cache by Chrome, causing a network round-trip
		// on every hover.  The proxy serves the image from /dev/shm with
		// Cache-Control: public, max-age=86400, immutable.
		//
		// IMPORTANT: do NOT mutate result.Image — result points into the QRZ
		// cache and mutating it would store the proxy path in the cache, causing
		// subsequent lookups to pass the proxy path back to Register() instead
		// of the original QRZ CDN URL.  Instead, copy the struct and rewrite
		// only the copy's Image field.
		respCallsign := *result // shallow copy — safe; all fields are value types or immutable strings
		if respCallsign.Image != "" && globalImageProxy != nil {
			respCallsign.Image = globalImageProxy.Register(respCallsign.Image)
		}

		// Augment with CTY database information (always attempt, even if QRZ
		// already returned cqzone/ituzone — CTY provides continent, country_code
		// and primary prefix which QRZ does not supply).
		resp := &lookupResponse{QRZCallsign: &respCallsign}
		if globalCTY != nil {
			if ctyInfo := globalCTY.LookupCallsignFull(normalised); ctyInfo != nil {
				resp.CTY = &CTYAugmentation{
					Country:     ctyInfo.Country,
					CountryCode: ctyInfo.CountryCode,
					Continent:   ctyInfo.Continent,
					CQZone:      ctyInfo.CQZone,
					ITUZone:     ctyInfo.ITUZone,
					Latitude:    ctyInfo.Latitude,
					Longitude:   ctyInfo.Longitude,
					TimeOffset:  ctyInfo.TimeOffset,
				}
				// Look up primary prefix from the entity
				globalCTY.mu.RLock()
				for pfx, entity := range globalCTY.entities {
					if entity.Name == ctyInfo.Country {
						resp.CTY.PrimaryPfx = pfx
						break
					}
				}
				globalCTY.mu.RUnlock()
			}
		}
		writeJSON(w, http.StatusOK, resp)

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

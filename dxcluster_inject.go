package main

// dxcluster_inject.go — POST /api/dxcluster/inject
//
// Allows trusted local services (e.g. the "dxcluster" addon container) to push
// DX spots directly into the feed without going through an external cluster
// connection.  Injected spots are indistinguishable from real cluster spots:
// they appear in the SSE stream, WebSocket feed, spot buffer, and frequency
// index (used for voice-activity enrichment).
//
// Request:
//
//	POST /api/dxcluster/inject
//	Content-Type: application/json
//
//	{
//	  "spotter":   "MM3NDH",
//	  "frequency": 14074000,   // Hz
//	  "dx_call":   "DL1ABC",
//	  "comment":   "FT8 -12dB" // optional
//	}
//
// The band, country, country_code, continent, and time_offset fields are
// derived automatically from the frequency and dx_call using the same CTY
// lookup that processes real cluster spots.
//
// Authentication:
//
//	The caller's raw source IP must match one of the container names or IPs
//	listed in dxcluster.inject_trusted_hosts (default: ["dxcluster"]).
//	Container names are resolved via DNS the same way as trusted_containers.
//	The endpoint returns 403 Forbidden for any other caller.
//
// The endpoint is enabled by default (inject_enabled: true).  Set
// inject_enabled: false in the dxcluster config section to disable it.

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"time"
)

// injectSpotRequest is the JSON body accepted by the inject endpoint.
type injectSpotRequest struct {
	Spotter   string  `json:"spotter"`
	Frequency float64 `json:"frequency"` // Hz
	DXCall    string  `json:"dx_call"`
	Comment   string  `json:"comment"` // optional
}

// HandleDXSpotInject returns an HTTP handler for POST /api/dxcluster/inject.
// It feeds the submitted spot into the identical pipeline used by real cluster
// spots: spot buffer, frequency index, SSE hub, WebSocket broadcast, Prometheus,
// and MQTT.
func HandleDXSpotInject(client *DXClusterClient, dxConfig *DXClusterConfig, serverConfig *ServerConfig) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Only accept POST.
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		// Check whether the inject endpoint is enabled.
		if !dxConfig.IsInjectEnabled() {
			http.Error(w, "DX spot injection is disabled", http.StatusServiceUnavailable)
			return
		}

		// ── Trust check ───────────────────────────────────────────────────────
		// Use the RAW source IP (the container is the direct TCP peer) so that
		// container names resolve correctly via IsContainerIP.  We deliberately
		// do NOT use getClientIP() here because that function may substitute a
		// proxied IP from X-Real-IP / X-Forwarded-For, which would break the
		// container-name matching and could allow IP spoofing.
		rawSourceIP := r.RemoteAddr
		if host, _, err := net.SplitHostPort(rawSourceIP); err == nil {
			rawSourceIP = host
		}

		trusted := false
		for _, name := range dxConfig.InjectTrustedHosts {
			if name == "" {
				continue
			}
			if serverConfig.IsContainerIP(rawSourceIP, name) {
				trusted = true
				break
			}
		}
		if !trusted {
			log.Printf("DXClusterInject: rejected request from %s (not in inject_trusted_hosts)", rawSourceIP)
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}

		// ── Decode request body ───────────────────────────────────────────────
		var req injectSpotRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}

		if req.Spotter == "" || req.DXCall == "" || req.Frequency <= 0 {
			http.Error(w, "spotter, dx_call and frequency (Hz) are required", http.StatusBadRequest)
			return
		}

		// ── Build DXSpot — same enrichment path as real cluster spots ─────────
		spot := DXSpot{
			Spotter:   req.Spotter,
			Frequency: req.Frequency,
			DXCall:    req.DXCall,
			Comment:   req.Comment,
			Time:      time.Now().UTC(),
			Band:      frequencyToBand(req.Frequency),
		}
		if info := GetCallsignInfo(spot.DXCall); info != nil {
			spot.Country = info.Country
			spot.CountryCode = info.CountryCode
			spot.Continent = info.Continent
			spot.TimeOffset = info.TimeOffset
		}

		// ── Feed into the identical pipeline as real cluster spots ────────────
		client.addSpotToBuffer(spot)
		client.indexSpot(spot)

		client.mu.RLock()
		handlers := make([]func(DXSpot), len(client.spotHandlers))
		copy(handlers, client.spotHandlers)
		client.mu.RUnlock()

		for _, h := range handlers {
			go h(spot)
		}

		log.Printf("DXClusterInject: injected spot from %s — %s on %.1f kHz (spotter: %s)",
			rawSourceIP, spot.DXCall, spot.Frequency/1000, spot.Spotter)

		w.WriteHeader(http.StatusNoContent)
	}
}

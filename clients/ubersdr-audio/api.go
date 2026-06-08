package main

// api.go — REST API server setup, route registration, and shared helpers.
//
// The API is enabled by default and listens on --api-bind:--api-port
// (default 0.0.0.0:9770).  Pass --no-api to disable it.
// All endpoints are under /api/v1/.
//
// Shared helpers (JSON encode/decode, error responses, method routing) live
// here so the individual handler files stay focused on business logic.

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"strings"
	"time"

	"fyne.io/fyne/v2"
)

//go:embed web
var webFS embed.FS

// APIServer holds the HTTP server and all dependencies needed by handlers.
type APIServer struct {
	state        *AppState
	client       *RadioClient
	flrig        *FlrigSync
	mdns         *MDNSDiscovery
	prefs        fyne.Preferences
	broker       *SSEBroker
	sinkMgr      *APISinkManager
	audioWS      *AudioWSBroker
	recordingMgr *RecordingManager

	httpServer *http.Server
}

// NewAPIServer creates an APIServer.  Call Start() to begin listening.
func NewAPIServer(
	state *AppState,
	client *RadioClient,
	flrig *FlrigSync,
	mdns *MDNSDiscovery,
	prefs fyne.Preferences,
	broker *SSEBroker,
	sinkMgr *APISinkManager,
	audioWS *AudioWSBroker,
	recordingMgr *RecordingManager,
) *APIServer {
	return &APIServer{
		state:        state,
		client:       client,
		flrig:        flrig,
		mdns:         mdns,
		prefs:        prefs,
		broker:       broker,
		sinkMgr:      sinkMgr,
		audioWS:      audioWS,
		recordingMgr: recordingMgr,
	}
}

// Start registers all routes and begins listening on addr (e.g. "127.0.0.1:9770").
// It returns the actual address that was bound (useful when the port was chosen
// automatically via auto-increment).
func (s *APIServer) Start(addr string) (string, error) {
	mux := http.NewServeMux()
	s.registerRoutes(mux)

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return "", fmt.Errorf("API server: listen %s: %w", addr, err)
	}

	s.httpServer = &http.Server{
		Addr:         ln.Addr().String(),
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 0, // 0 = no timeout (SSE streams are long-lived)
		IdleTimeout:  120 * time.Second,
	}

	go func() {
		if err := s.httpServer.Serve(ln); err != nil && err != http.ErrServerClosed {
			fmt.Printf("API server error: %v\n", err)
		}
	}()

	return ln.Addr().String(), nil
}

// Stop gracefully shuts down the HTTP server.
func (s *APIServer) Stop() {
	if s.httpServer == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = s.httpServer.Shutdown(ctx)
}

// registerRoutes wires all API endpoints to the mux.
func (s *APIServer) registerRoutes(mux *http.ServeMux) {
	// Serve the embedded web UI at the root.
	webSub, err := fs.Sub(webFS, "web")
	if err == nil {
		mux.Handle("/", http.FileServer(http.FS(webSub)))
	}

	// Status
	mux.HandleFunc("/api/v1/status", s.handleStatus)

	// Bookmarks (proxy to connected SDR server)
	mux.HandleFunc("/api/v1/bookmarks", s.handleBookmarks)

	// Connection
	mux.HandleFunc("/api/v1/connect", s.handleConnect)
	mux.HandleFunc("/api/v1/disconnect", s.handleDisconnect)
	mux.HandleFunc("/api/v1/instances", s.handleInstances)
	mux.HandleFunc("/api/v1/instances/connect", s.handleInstancesConnect)

	// Connected instance description
	mux.HandleFunc("/api/v1/instance", s.handleInstance)

	// Tuning
	mux.HandleFunc("/api/v1/tune", s.handleTune)

	// Audio
	mux.HandleFunc("/api/v1/audio", s.handleAudio)
	mux.HandleFunc("/api/v1/audio/devices", s.handleAudioDevices)
	mux.HandleFunc("/api/v1/audio/gate", s.handleAudioGate)
	mux.HandleFunc("/api/v1/audio/stream", s.audioWS.ServeHTTP)

	// AGC
	mux.HandleFunc("/api/v1/agc", s.handleAGC)

	// DSP
	mux.HandleFunc("/api/v1/dsp", s.handleDSP)
	mux.HandleFunc("/api/v1/dsp/params", s.handleDSPParams)
	mux.HandleFunc("/api/v1/dsp/filters", s.handleDSPFilters)

	// Signal quality
	mux.HandleFunc("/api/v1/signal", s.handleSignal)
	mux.HandleFunc("/api/v1/signal/stream", s.broker.ServeHTTP)

	// Settings
	mux.HandleFunc("/api/v1/settings", s.handleSettings)

	// FLRig
	mux.HandleFunc("/api/v1/flrig", s.handleFlrig)

	// Profiles
	mux.HandleFunc("/api/v1/profiles", s.handleProfiles)
	mux.HandleFunc("/api/v1/profiles/", s.handleProfileByName) // /profiles/{name} and /profiles/{name}/load

	// Sinks
	mux.HandleFunc("/api/v1/sinks", s.handleSinks)
	mux.HandleFunc("/api/v1/sinks/stdout", s.handleSinksStdout)
	mux.HandleFunc("/api/v1/sinks/udp", s.handleSinksUDP)
	mux.HandleFunc("/api/v1/sinks/udp/", s.handleSinksUDPDelete) // DELETE /sinks/udp/{address}

	// Recording
	mux.HandleFunc("/api/v1/record", s.handleRecord)
	mux.HandleFunc("/api/v1/record/start", s.handleRecordStart)
	mux.HandleFunc("/api/v1/record/stop", s.handleRecordStop)
	mux.HandleFunc("/api/v1/record/download", s.handleRecordDownload)
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

// writeJSON encodes v as JSON and writes it to w with the given status code.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

// apiError writes a JSON error response.
func apiError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// apiFieldError writes a JSON 422 error with field/value/constraint detail.
func apiFieldError(w http.ResponseWriter, field string, value any, constraint string) {
	writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
		"error":      fmt.Sprintf("%s out of range: %s", field, constraint),
		"field":      field,
		"value":      value,
		"constraint": constraint,
	})
}

// apiConflict writes a JSON 409 error.
func apiConflict(w http.ResponseWriter, field, msg string) {
	writeJSON(w, http.StatusConflict, map[string]any{
		"error": msg,
		"field": field,
	})
}

// decodeBody decodes the JSON request body into v.
// Returns false and writes an error response if decoding fails.
func decodeBody(w http.ResponseWriter, r *http.Request, v any) bool {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1 MB limit
	if err != nil {
		apiError(w, http.StatusBadRequest, "failed to read request body")
		return false
	}
	if len(body) == 0 {
		return true // empty body is fine for endpoints that don't require one
	}
	if err := json.Unmarshal(body, v); err != nil {
		apiError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return false
	}
	return true
}

// methodOnly returns false and writes 405 if the request method is not one of
// the allowed methods.
func methodOnly(w http.ResponseWriter, r *http.Request, methods ...string) bool {
	for _, m := range methods {
		if r.Method == m {
			return true
		}
	}
	w.Header().Set("Allow", strings.Join(methods, ", "))
	http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	return false
}

// pathSuffix returns the part of the URL path after prefix.
// e.g. pathSuffix("/api/v1/profiles/", "/api/v1/profiles/My Profile") → "My Profile"
func pathSuffix(prefix, path string) string {
	return strings.TrimPrefix(path, prefix)
}

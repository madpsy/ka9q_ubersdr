package main

// api_handlers_sinks.go — handlers for PCM output sink endpoints:
//   GET    /api/v1/sinks
//   POST   /api/v1/sinks/stdout
//   DELETE /api/v1/sinks/stdout
//   POST   /api/v1/sinks/udp
//   DELETE /api/v1/sinks/udp/{address}
//
// APISinkManager manages the set of runtime-added sinks and wires them into
// the RadioClient.  It is separate from the CLI-flag sinks created at startup.

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
)

// APISinkManager manages PCM output sinks that can be added/removed at runtime
// via the REST API.  It implements StreamSink itself so it can be set as
// client.Sink alongside (or instead of) the CLI-flag sinks.
type APISinkManager struct {
	mu         sync.RWMutex
	stdoutSink *StdoutSink         // non-nil when stdout is active
	udpSinks   map[string]*UDPSink // keyed by address string
}

// NewAPISinkManager creates an empty APISinkManager.
func NewAPISinkManager() *APISinkManager {
	return &APISinkManager{
		udpSinks: make(map[string]*UDPSink),
	}
}

// WritePCM implements StreamSink — fans out to all active sinks.
func (m *APISinkManager) WritePCM(pcmLE []byte, sampleRate, channels int) {
	m.mu.RLock()
	stdout := m.stdoutSink
	udp := make([]*UDPSink, 0, len(m.udpSinks))
	for _, s := range m.udpSinks {
		udp = append(udp, s)
	}
	m.mu.RUnlock()

	if stdout != nil {
		stdout.WritePCM(pcmLE, sampleRate, channels)
	}
	for _, s := range udp {
		s.WritePCM(pcmLE, sampleRate, channels)
	}
}

// Close implements StreamSink — closes all active sinks.
func (m *APISinkManager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.stdoutSink != nil {
		m.stdoutSink.Close()
		m.stdoutSink = nil
	}
	for addr, s := range m.udpSinks {
		s.Close()
		delete(m.udpSinks, addr)
	}
}

// Status returns whether stdout is active and the list of UDP addresses.
func (m *APISinkManager) Status() (stdoutActive bool, udpAddrs []string) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	stdoutActive = m.stdoutSink != nil
	udpAddrs = make([]string, 0, len(m.udpSinks))
	for addr := range m.udpSinks {
		udpAddrs = append(udpAddrs, addr)
	}
	return
}

// EnableStdout activates the stdout sink.  No-op if already active.
func (m *APISinkManager) EnableStdout() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.stdoutSink == nil {
		m.stdoutSink = NewStdoutSink()
	}
}

// DisableStdout deactivates the stdout sink.
func (m *APISinkManager) DisableStdout() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.stdoutSink != nil {
		m.stdoutSink.Close()
		m.stdoutSink = nil
	}
}

// AddUDP adds a UDP sink for the given address.
// Returns an error if the address is invalid or already registered.
func (m *APISinkManager) AddUDP(addr string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.udpSinks[addr]; exists {
		return fmt.Errorf("UDP sink for %q already exists", addr)
	}
	sink, err := NewUDPSink(addr)
	if err != nil {
		return err
	}
	m.udpSinks[addr] = sink
	return nil
}

// RemoveUDP removes and closes the UDP sink for the given address.
func (m *APISinkManager) RemoveUDP(addr string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, exists := m.udpSinks[addr]
	if !exists {
		return fmt.Errorf("no UDP sink for %q", addr)
	}
	s.Close()
	delete(m.udpSinks, addr)
	return nil
}

// ── HTTP handlers ─────────────────────────────────────────────────────────────

func (s *APIServer) handleSinks(w http.ResponseWriter, r *http.Request) {
	if !methodOnly(w, r, http.MethodGet) {
		return
	}
	stdoutActive, udpAddrs := s.sinkMgr.Status()
	writeJSON(w, http.StatusOK, map[string]any{
		"stdout": stdoutActive,
		"udp":    udpAddrs,
	})
}

func (s *APIServer) handleSinksStdout(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		s.sinkMgr.EnableStdout()
		writeJSON(w, http.StatusOK, map[string]any{"stdout": true})
	case http.MethodDelete:
		s.sinkMgr.DisableStdout()
		writeJSON(w, http.StatusOK, map[string]any{"stdout": false})
	default:
		methodOnly(w, r, http.MethodPost, http.MethodDelete)
	}
}

func (s *APIServer) handleSinksUDP(w http.ResponseWriter, r *http.Request) {
	if !methodOnly(w, r, http.MethodPost) {
		return
	}

	var body struct {
		Address string `json:"address"`
	}
	if !decodeBody(w, r, &body) {
		return
	}

	addr := strings.TrimSpace(body.Address)
	if addr == "" {
		apiFieldError(w, "address", addr, "must be a non-empty host:port string")
		return
	}

	// Validate host:port and port range.
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil || host == "" || portStr == "" {
		apiFieldError(w, "address", addr, "must be a valid host:port (e.g. 127.0.0.1:5005)")
		return
	}
	portNum, err := strconv.Atoi(portStr)
	if err != nil || portNum < 1 || portNum > 65535 {
		apiFieldError(w, "address", addr, "port must be in range [1, 65535]")
		return
	}

	if err := s.sinkMgr.AddUDP(addr); err != nil {
		// Distinguish "already exists" (409) from other errors (422).
		if strings.Contains(err.Error(), "already exists") {
			apiConflict(w, "address", err.Error())
		} else {
			apiError(w, http.StatusUnprocessableEntity, err.Error())
		}
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"address": addr, "added": true})
}

func (s *APIServer) handleSinksUDPDelete(w http.ResponseWriter, r *http.Request) {
	if !methodOnly(w, r, http.MethodDelete) {
		return
	}

	// Path: /api/v1/sinks/udp/{address}
	encoded := pathSuffix("/api/v1/sinks/udp/", r.URL.Path)
	addr, err := url.PathUnescape(encoded)
	if err != nil || strings.TrimSpace(addr) == "" {
		apiError(w, http.StatusUnprocessableEntity, "invalid or missing address in path")
		return
	}
	addr = strings.TrimSpace(addr)

	if err := s.sinkMgr.RemoveUDP(addr); err != nil {
		apiError(w, http.StatusNotFound, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"address": addr, "removed": true})
}

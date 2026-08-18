package main

// mqtt_addon_ingest.go — lets addon containers publish their own events through
// UberSDR's MQTT connection.
//
// Addons run as separate containers on the sdr-network and have no MQTT
// credentials of their own. This listener gives them a way to publish into the
// receiver's existing MQTT feed (and, via mqtt_addon_ha.go, to appear in Home
// Assistant) without the operator configuring anything: install an addon and it
// can publish.
//
// Threat model and the three things that contain an addon:
//
//  1. Reachability. The listener binds a port that is deliberately NOT in the
//     docker-compose ports: list, so it is not reachable from outside the host.
//     That alone is not treated as sufficient — on Linux the Docker host can
//     route to the bridge subnet directly — so:
//
//  2. Identity. Every request is authenticated by matching the RAW TCP source
//     address against the container names of the installed addons, exactly as
//     dxcluster_inject.go does. getClientIP() is deliberately NOT used: it
//     honours X-Forwarded-For/X-Real-IP, which a caller controls. An addon's
//     identity therefore comes from the socket and can never be asserted in a
//     header or a request body.
//
//  3. Namespacing. Addons never supply a topic. They supply a validated
//     sub-topic tail which the server places under
//     {topic_prefix}/{namespace}/{addon}/, deriving {addon} from (2). One addon
//     cannot write to another addon's topics, to UberSDR's own topics, or to
//     the Home Assistant discovery tree.
//
// Endpoints (all on the ingest listener only, never on the public web server):
//
//	POST   /publish/{sub_topic}   body = payload            → publish data
//	POST   /discovery             body = entity declaration → declare an HA entity
//	DELETE /discovery/{sub_topic}                           → remove an HA entity
//	GET    /health                                          → addon self-test

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// ── Topic construction ────────────────────────────────────────────────────────

// addonSubTopicRe matches a validated sub-topic tail: lowercase alphanumeric
// segments separated by single slashes. The charset excludes the MQTT wildcards
// (+ #) and the dot, so wildcard injection and dot-segment traversal are
// impossible by construction rather than by blocklist.
var addonSubTopicRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*(/[a-z0-9][a-z0-9_-]*)*$`)

const (
	addonSubTopicMaxLen      = 64
	addonSubTopicMaxSegments = 4
)

// addonReservedSubTopics are sub-topics the server manages itself. An addon
// publishing to "status" would fight the staleness publisher for control of its
// own availability signal.
var addonReservedSubTopics = map[string]bool{
	"status": true,
}

// validateAddonSubTopic checks the sub-topic tail an addon supplied. It is the
// single validator used by both the data path and the Home Assistant
// declaration path, so an entity can never reference a topic the addon is not
// allowed to publish to.
func validateAddonSubTopic(sub string) error {
	if sub == "" {
		return fmt.Errorf("must not be empty")
	}
	if len(sub) > addonSubTopicMaxLen {
		return fmt.Errorf("must be %d characters or fewer", addonSubTopicMaxLen)
	}
	if !addonSubTopicRe.MatchString(sub) {
		return fmt.Errorf("must be lowercase alphanumeric segments separated by single slashes (a-z, 0-9, _, -), e.g. \"strikes\" or \"bands/40m\"")
	}
	if n := strings.Count(sub, "/") + 1; n > addonSubTopicMaxSegments {
		return fmt.Errorf("must have %d or fewer slash-separated segments", addonSubTopicMaxSegments)
	}
	if addonReservedSubTopics[sub] {
		return fmt.Errorf("%q is reserved by UberSDR", sub)
	}
	return nil
}

// AddonDataTopic returns the full topic an addon's event is published to.
// The addon name comes from the authenticated connection, never from input.
func (c *MQTTConfig) AddonDataTopic(addon, subTopic string) string {
	return fmt.Sprintf("%s/%s/%s/%s", c.TopicPrefix, c.AddonIngest.TopicNamespace, addon, subTopic)
}

// AddonStatusTopic returns the retained per-addon availability topic. UberSDR
// owns this topic: the staleness publisher writes online/offline to it, and
// addon Home Assistant entities list it as an availability source.
func (c *MQTTConfig) AddonStatusTopic(addon string) string {
	return fmt.Sprintf("%s/%s/%s/status", c.TopicPrefix, c.AddonIngest.TopicNamespace, addon)
}

// ── Server ────────────────────────────────────────────────────────────────────

// addonIngestStats tracks per-addon activity, for availability and diagnostics.
type addonIngestStats struct {
	Published   int64
	Rejected    int64
	LastPublish time.Time
	online      bool
	statusKnown bool // whether an online/offline status has been published yet
}

// AddonIngestServer is the docker-network-only HTTP listener addons publish to.
type AddonIngestServer struct {
	cfg       *MQTTAddonIngestConfig
	publisher *MQTTPublisher
	serverCfg *ServerConfig
	registry  *AddonHARegistry
	haEnabled bool

	// addonsFn returns the currently-enabled addon entries. Re-read on every
	// request so addons installed or removed at runtime take effect immediately.
	addonsFn func() []AddonProxyEntry

	limiter  *AddonProxyRateLimiter
	listener net.Listener
	server   *http.Server
	started  time.Time
	done     chan struct{}
	stopOnce sync.Once

	mu    sync.Mutex
	stats map[string]*addonIngestStats
}

// NewAddonIngestServer builds the ingest server. Call Start to bind and serve.
func NewAddonIngestServer(
	cfg *MQTTAddonIngestConfig,
	publisher *MQTTPublisher,
	serverCfg *ServerConfig,
	registry *AddonHARegistry,
	haEnabled bool,
	addonsFn func() []AddonProxyEntry,
) *AddonIngestServer {
	return &AddonIngestServer{
		cfg:       cfg,
		publisher: publisher,
		serverCfg: serverCfg,
		registry:  registry,
		haEnabled: haEnabled,
		addonsFn:  addonsFn,
		limiter:   NewAddonProxyRateLimiter(cfg.RateLimit),
		stats:     make(map[string]*addonIngestStats),
		started:   time.Now(),
		done:      make(chan struct{}),
	}
}

// Start binds the listener and serves in the background.
func (s *AddonIngestServer) Start() error {
	mux := http.NewServeMux()
	mux.HandleFunc("/publish/", s.handlePublish)
	mux.HandleFunc("/discovery", s.handleDiscovery)
	mux.HandleFunc("/discovery/", s.handleDiscovery)
	mux.HandleFunc("/health", s.handleHealth)

	addr := fmt.Sprintf(":%d", s.cfg.Port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("addon MQTT ingest: failed to listen on %s: %w", addr, err)
	}
	s.listener = ln
	s.server = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}

	go func() {
		if err := s.server.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("Addon MQTT ingest: server stopped: %v", err)
		}
	}()

	go s.runStatusPublisher()

	log.Printf("Addon MQTT ingest listening on %s (topics: %s/%s/{addon}/..., rate_limit=%d/min, max_payload=%dB, ha_discovery=%v)",
		addr, s.publisher.config.TopicPrefix, s.cfg.TopicNamespace, s.cfg.RateLimit, s.cfg.MaxPayloadBytes, s.haEnabled)
	return nil
}

// Stop shuts the listener and the staleness publisher down. Safe to call twice.
func (s *AddonIngestServer) Stop() {
	s.stopOnce.Do(func() {
		close(s.done)
		if s.server != nil {
			_ = s.server.Close()
		}
	})
}

// ── Authentication ────────────────────────────────────────────────────────────

// allowedAddons returns container hostname → addon name for every addon
// permitted to use the ingest port.
//
// By default this is every enabled entry in addons.yaml, which is what makes
// the feature zero-configuration: installing an addon is all the operator does.
// mqtt.addon_ingest.allowed_containers narrows it when an operator wants an
// explicit allowlist instead.
func (s *AddonIngestServer) allowedAddons() map[string]string {
	out := make(map[string]string)
	if s.addonsFn == nil {
		return out
	}

	var restrict map[string]bool
	if len(s.cfg.AllowedContainers) > 0 {
		restrict = make(map[string]bool, len(s.cfg.AllowedContainers))
		for _, h := range s.cfg.AllowedContainers {
			restrict[h] = true
		}
	}

	for _, e := range s.addonsFn() {
		if !e.Enabled || e.Host == "" || e.Name == "" {
			continue
		}
		if restrict != nil && !restrict[e.Host] {
			continue
		}
		out[e.Host] = e.Name
	}
	return out
}

// authenticate resolves the calling container to an addon name.
//
// It uses the RAW source address rather than getClientIP(): getClientIP honours
// X-Forwarded-For and X-Real-IP, which the caller controls, so trusting it here
// would let any addon impersonate any other by setting a header.
func (s *AddonIngestServer) authenticate(r *http.Request) (string, bool) {
	rawIP := r.RemoteAddr
	if host, _, err := net.SplitHostPort(rawIP); err == nil {
		rawIP = host
	}
	if s.serverCfg == nil {
		return "", false
	}
	for hostname, addonName := range s.allowedAddons() {
		if s.serverCfg.IsContainerIP(rawIP, hostname) {
			return addonName, true
		}
	}
	return "", false
}

// authorize performs the identity and rate-limit checks shared by every
// endpoint, writing the error response itself when it fails.
func (s *AddonIngestServer) authorize(w http.ResponseWriter, r *http.Request) (string, bool) {
	addon, ok := s.authenticate(r)
	if !ok {
		rawIP := r.RemoteAddr
		if host, _, err := net.SplitHostPort(rawIP); err == nil {
			rawIP = host
		}
		log.Printf("Addon MQTT ingest: rejected request from %s (not a recognised addon container)", rawIP)
		http.Error(w, "Forbidden — the source address does not belong to an installed addon container", http.StatusForbidden)
		return "", false
	}
	if !s.limiter.AllowRequest(addon) {
		s.recordReject(addon)
		http.Error(w, fmt.Sprintf("Too Many Requests — limit is %d publishes per minute", s.cfg.RateLimit), http.StatusTooManyRequests)
		return "", false
	}
	return addon, true
}

// ── Handlers ──────────────────────────────────────────────────────────────────

// handlePublish accepts POST /publish/{sub_topic} and forwards the body to MQTT.
// DELETE /publish/{sub_topic} clears a retained message the addon published
// earlier — publishing a JSON null does not do that, only a zero-length payload
// removes a retained topic from the broker.
func (s *AddonIngestServer) handlePublish(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		http.Error(w, "method not allowed — use POST to publish or DELETE to clear a retained topic", http.StatusMethodNotAllowed)
		return
	}
	addon, ok := s.authorize(w, r)
	if !ok {
		return
	}

	subTopic := strings.TrimPrefix(r.URL.Path, "/publish/")
	if err := validateAddonSubTopic(subTopic); err != nil {
		s.recordReject(addon)
		http.Error(w, fmt.Sprintf("invalid sub-topic: %v", err), http.StatusBadRequest)
		return
	}

	if r.Method == http.MethodDelete {
		topic := s.publisher.config.AddonDataTopic(addon, subTopic)
		if !s.publisher.clearRetained(topic) {
			s.recordReject(addon)
			http.Error(w, "could not clear the topic — the MQTT broker is unreachable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "cleared", "topic": topic})
		return
	}

	// Read at most one byte more than the cap so an oversized body is detected
	// rather than silently truncated.
	limit := int64(s.cfg.MaxPayloadBytes)
	body, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		s.recordReject(addon)
		http.Error(w, "failed to read request body", http.StatusBadRequest)
		return
	}
	if int64(len(body)) > limit {
		s.recordReject(addon)
		http.Error(w, fmt.Sprintf("payload too large — limit is %d bytes", s.cfg.MaxPayloadBytes), http.StatusRequestEntityTooLarge)
		return
	}
	if len(body) == 0 {
		s.recordReject(addon)
		http.Error(w, "empty payload — to clear a retained topic, send DELETE to this same URL", http.StatusBadRequest)
		return
	}

	// Payload must be either well-formed JSON or clean UTF-8 text. This keeps
	// binary junk and control sequences off the broker, and keeps payloads in a
	// shape Home Assistant value_templates can actually parse.
	if strings.HasPrefix(r.Header.Get("Content-Type"), "text/plain") {
		if !utf8.Valid(body) || hasControlChars(string(body)) {
			s.recordReject(addon)
			http.Error(w, "text/plain payloads must be valid UTF-8 with no control characters", http.StatusBadRequest)
			return
		}
	} else if !json.Valid(body) {
		s.recordReject(addon)
		http.Error(w, "payload must be valid JSON (or send Content-Type: text/plain)", http.StatusBadRequest)
		return
	}

	qos := s.parseQoS(r)
	retain := s.parseRetain(r)

	if err := s.publisher.PublishAddonEvent(addon, subTopic, body, qos, retain); err != nil {
		s.recordReject(addon)
		http.Error(w, fmt.Sprintf("publish failed: %v", err), http.StatusServiceUnavailable)
		return
	}

	s.recordPublish(addon)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "published",
		"topic":  s.publisher.config.AddonDataTopic(addon, subTopic),
		"qos":    qos,
		"retain": retain,
		"bytes":  len(body),
	})
}

// parseQoS reads the optional ?qos= parameter, clamped to the configured max.
func (s *AddonIngestServer) parseQoS(r *http.Request) byte {
	qos := s.cfg.MaxQoS
	if v := r.URL.Query().Get("qos"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 && n <= 2 {
			qos = n
		}
	}
	if qos > s.cfg.MaxQoS {
		qos = s.cfg.MaxQoS
	}
	if qos < 0 {
		qos = 0
	}
	return byte(qos)
}

// parseRetain reads the optional ?retain= parameter, subject to the operator's
// allow_retain setting.
func (s *AddonIngestServer) parseRetain(r *http.Request) bool {
	if !s.cfg.IsRetainAllowed() {
		return false
	}
	v := r.URL.Query().Get("retain")
	return v == "1" || strings.EqualFold(v, "true")
}

// handleDiscovery declares (POST) or removes (DELETE) a Home Assistant entity.
func (s *AddonIngestServer) handleDiscovery(w http.ResponseWriter, r *http.Request) {
	addon, ok := s.authorize(w, r)
	if !ok {
		return
	}
	if !s.haEnabled || s.registry == nil {
		http.Error(w, "Home Assistant discovery is not enabled on this receiver — data publishing still works", http.StatusServiceUnavailable)
		return
	}

	switch r.Method {
	case http.MethodPost:
		var decl AddonHADeclaration
		// Plain decode: fields not present on the struct are dropped rather than
		// forwarded, so an addon cannot smuggle state_topic, device or unique_id
		// into the discovery payload.
		if err := json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&decl); err != nil {
			s.recordReject(addon)
			http.Error(w, fmt.Sprintf("invalid JSON: %v", err), http.StatusBadRequest)
			return
		}
		if err := s.registry.Declare(addon, decl); err != nil {
			s.recordReject(addon)
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"status":      "declared",
			"state_topic": s.publisher.config.AddonDataTopic(addon, decl.SubTopic),
			"entity_id":   s.registry.EntityIDFor(addon, decl),
		})

	case http.MethodDelete:
		subTopic := strings.TrimPrefix(r.URL.Path, "/discovery/")
		if err := validateAddonSubTopic(subTopic); err != nil {
			s.recordReject(addon)
			http.Error(w, fmt.Sprintf("invalid sub-topic: %v", err), http.StatusBadRequest)
			return
		}
		// ?entity_key= selects one entity when several share this sub-topic.
		// Omitting it removes them all.
		if err := s.registry.Delete(addon, subTopic, r.URL.Query().Get("entity_key")); err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})

	default:
		http.Error(w, "method not allowed — use POST or DELETE", http.StatusMethodNotAllowed)
	}
}

// handleHealth lets an addon confirm what UberSDR thinks it is and what limits
// apply, which makes the ingest port self-documenting for addon authors.
func (s *AddonIngestServer) handleHealth(w http.ResponseWriter, r *http.Request) {
	addon, ok := s.authenticate(r)
	if !ok {
		http.Error(w, "Forbidden — the source address does not belong to an installed addon container", http.StatusForbidden)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"addon":             addon,
		"mqtt_connected":    s.publisher.isConnected(),
		"topic_prefix":      s.publisher.config.AddonDataTopic(addon, "{sub_topic}"),
		"status_topic":      s.publisher.config.AddonStatusTopic(addon),
		"ha_discovery":      s.haEnabled,
		"max_payload_bytes": s.cfg.MaxPayloadBytes,
		"rate_limit":        s.cfg.RateLimit,
		"max_qos":           s.cfg.MaxQoS,
		"retain_allowed":    s.cfg.IsRetainAllowed(),
		"max_entities":      s.cfg.MaxEntities,
		"offline_after_sec": s.cfg.OfflineAfterSec,
	})
}

// ── Per-addon availability ────────────────────────────────────────────────────

// recordPublish notes a successful publish and flips the addon online.
func (s *AddonIngestServer) recordPublish(addon string) {
	s.mu.Lock()
	st := s.statFor(addon)
	st.Published++
	st.LastPublish = time.Now()
	needsOnline := !st.online || !st.statusKnown
	st.online = true
	st.statusKnown = true
	s.mu.Unlock()

	if needsOnline {
		s.publishAddonStatus(addon, true)
	}
}

func (s *AddonIngestServer) recordReject(addon string) {
	s.mu.Lock()
	s.statFor(addon).Rejected++
	s.mu.Unlock()
}

// statFor returns the stats for an addon, creating them if needed.
// Caller must hold s.mu.
func (s *AddonIngestServer) statFor(addon string) *addonIngestStats {
	st, ok := s.stats[addon]
	if !ok {
		st = &addonIngestStats{}
		s.stats[addon] = st
	}
	return st
}

// publishAddonStatus writes the retained per-addon availability signal.
func (s *AddonIngestServer) publishAddonStatus(addon string, online bool) {
	payload := "offline"
	if online {
		payload = "online"
	}
	s.publisher.publishRetainedString(s.publisher.config.AddonStatusTopic(addon), payload)
	log.Printf("Addon MQTT ingest: addon %q is %s", addon, payload)
}

// runStatusPublisher marks an addon offline once it stops publishing.
//
// This is what closes the availability gap inherent in proxying: the broker's
// Last Will tracks UberSDR, not the addon, so without a staleness timer an addon
// that died would keep its last retained value looking live in Home Assistant.
//
// Addons are given a full grace period after startup before being marked
// offline, so restarting UberSDR does not flap every addon's entities.
func (s *AddonIngestServer) runStatusPublisher() {
	offlineAfter := time.Duration(s.cfg.OfflineAfterSec) * time.Second

	// Seed from the persisted registry so an addon that declared entities in a
	// previous run is tracked even before it publishes anything in this one.
	if s.registry != nil {
		s.mu.Lock()
		for _, addon := range s.registry.Addons() {
			st := s.statFor(addon)
			if st.LastPublish.IsZero() {
				st.LastPublish = s.started
			}
		}
		s.mu.Unlock()
	}

	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
		}
		now := time.Now()

		s.mu.Lock()
		var wentOffline []string
		for addon, st := range s.stats {
			last := st.LastPublish
			if last.IsZero() {
				last = s.started
			}
			if now.Sub(last) > offlineAfter && (st.online || !st.statusKnown) {
				st.online = false
				st.statusKnown = true
				wentOffline = append(wentOffline, addon)
			}
		}
		s.mu.Unlock()

		for _, addon := range wentOffline {
			s.publishAddonStatus(addon, false)
		}
	}
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

// GetStats returns a snapshot of ingest activity for the admin health endpoint.
func (s *AddonIngestServer) GetStats() map[string]interface{} {
	s.mu.Lock()
	addons := make([]map[string]interface{}, 0, len(s.stats))
	names := make([]string, 0, len(s.stats))
	for name := range s.stats {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		st := s.stats[name]
		entry := map[string]interface{}{
			"addon":     name,
			"published": st.Published,
			"rejected":  st.Rejected,
			"online":    st.online,
		}
		if !st.LastPublish.IsZero() {
			entry["last_publish"] = st.LastPublish.Format(time.RFC3339)
			entry["seconds_since_publish"] = int(time.Since(st.LastPublish).Seconds())
		}
		addons = append(addons, entry)
	}
	s.mu.Unlock()

	out := map[string]interface{}{
		"enabled":         true,
		"port":            s.cfg.Port,
		"topic_namespace": s.cfg.TopicNamespace,
		"ha_discovery":    s.haEnabled,
		"addons":          addons,
	}
	if s.registry != nil {
		entities := s.registry.Snapshot()
		declared := make([]map[string]interface{}, 0, len(entities))
		for _, e := range entities {
			declared = append(declared, map[string]interface{}{
				"addon":     e.Addon,
				"sub_topic": e.SubTopic,
				"component": e.Component,
				"name":      e.Name,
			})
		}
		out["ha_entities"] = declared
	}
	return out
}

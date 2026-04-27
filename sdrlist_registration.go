package main

// sdrlist_registration.go — sdr-list.xyz directory registration (§12.3)
//
// Implements the HTTPS/JSON POST registration protocol for sdr-list.xyz.
// Registration is opt-in via config flag:
//   websdr_register_sdrlist: true
//
// Connection details (hostname, port) are sourced from instance_reporting.instance.*
// so that sdr-list always advertises the same endpoint as the UberSDR instance
// reporter — no WebSDR-specific config fields are required.

import (
	"bytes"
	"crypto/tls"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"strings"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Constants (from spec §12.3)
// ─────────────────────────────────────────────────────────────────────────────

const (
	sdrListUpdateInterval = 60 * time.Second
	sdrListBackoffBase    = 30 * time.Second
	sdrListBackoffMax     = 3600 * time.Second
)

// Hardware frequency coverage is fixed for UberSDR: 10 kHz – 30 MHz.
// These constants are not user-configurable.
const (
	uberSDRRangeStartHz = int64(10_000)     // 10 kHz
	uberSDRRangeEndHz   = int64(30_000_000) // 30 MHz
)

// ─────────────────────────────────────────────────────────────────────────────
// SdrListRegistrar — standalone sdr-list.xyz registration goroutine
// ─────────────────────────────────────────────────────────────────────────────

// SdrListRegistrar registers this UberSDR instance with sdr-list.xyz.
// It is independent of the WebSDR protocol stack and derives all connection
// details from instance_reporting.instance.* config (the same values the
// instance reporter advertises to ubersdr.org).
type SdrListRegistrar struct {
	config           *Config
	sessions         *SessionManager
	instanceReporter *InstanceReporter // may be nil if instance reporting is disabled
	instanceID       string            // decimal string of (time ^ pid), used as sdr-list "id"
	stop             chan struct{}
}

// NewSdrListRegistrar creates a registrar. Call Start() to begin registration.
func NewSdrListRegistrar(config *Config, sessions *SessionManager, ir *InstanceReporter) *SdrListRegistrar {
	instanceID := fmt.Sprintf("%d",
		uint32(time.Now().Unix())^uint32(processID()),
	)
	return &SdrListRegistrar{
		config:           config,
		sessions:         sessions,
		instanceReporter: ir,
		instanceID:       instanceID,
		stop:             make(chan struct{}),
	}
}

// Start launches the registration goroutine (non-blocking).
func (r *SdrListRegistrar) Start() {
	go r.loop()
}

// Stop signals the registration goroutine to exit.
func (r *SdrListRegistrar) Stop() {
	close(r.stop)
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration loop
// ─────────────────────────────────────────────────────────────────────────────

func (r *SdrListRegistrar) loop() {
	sdrListHost := r.config.InstanceReporting.SdrListHost
	if sdrListHost == "" {
		sdrListHost = "sdr-list.xyz"
	}
	// Strip scheme for display purposes.
	displayName := sdrListHost
	if idx := strings.Index(displayName, "://"); idx >= 0 {
		displayName = displayName[idx+3:]
	}

	attempt := 0
	backoff := time.Duration(0) // first attempt immediately

	for {
		select {
		case <-r.stop:
			return
		case <-time.After(backoff):
		}

		err := r.update(sdrListHost, displayName)
		if err != nil {
			log.Printf("sdr-list: %s registration error: %v", displayName, err)
			shift := attempt
			if shift > 16 {
				shift = 16
			}
			backoff = time.Duration(math.Min(
				float64(sdrListBackoffBase)*(math.Pow(2, float64(shift))),
				float64(sdrListBackoffMax),
			))
			attempt++
		} else {
			attempt = 0
			backoff = sdrListUpdateInterval
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Single registration POST
// ─────────────────────────────────────────────────────────────────────────────

func (r *SdrListRegistrar) update(host, displayName string) error {
	// ── Hostname ──────────────────────────────────────────────────────────────
	// Use the instance reporter's effective host (handles use_myip auto-detection).
	// Fall back to the statically configured instance host.
	hostname := r.config.InstanceReporting.Instance.Host
	if r.instanceReporter != nil {
		if h := r.instanceReporter.GetEffectiveHost(); h != "" {
			hostname = h
		}
	}
	if hostname == "" {
		log.Printf("sdr-list: %s registration skipped: no hostname configured (set instance_reporting.instance.host)", displayName)
		return nil
	}

	// ── Port ──────────────────────────────────────────────────────────────────
	listenPort := r.config.InstanceReporting.Instance.Port
	if listenPort == 0 {
		listenPort = 8080 // UberSDR default
	}
	// When TLS is enabled, advertise port 80 so sdr-list.xyz constructs
	// http://hostname:80 — Caddy redirects HTTP→HTTPS via 308, so the user
	// lands on the correct HTTPS page. The sdr-list.xyz API has no scheme
	// field (VertexSDR protocol), so this is the only way to get a working link.
	if r.config.InstanceReporting.Instance.TLS {
		listenPort = 80
	}

	// ── Station metadata ──────────────────────────────────────────────────────
	description := r.config.Admin.Name
	qth := latLonToGridSquare(r.config.Admin.GPS.Lat, r.config.Admin.GPS.Lon)
	antenna := r.config.Admin.Antenna

	// ── User counts ───────────────────────────────────────────────────────────
	maxUsers := r.config.Server.MaxSessions
	numUsers := r.sessions.GetNonBypassedUserCount()

	// ── Fixed hardware range ──────────────────────────────────────────────────
	rangeStart := uberSDRRangeStartHz
	rangeEnd := uberSDRRangeEndHz
	bw := rangeEnd - rangeStart
	centerFreq := int64(15_000_000) // midpoint of 10 kHz–30 MHz HF band

	// ── Resolve scheme / bare host ────────────────────────────────────────────
	// The configured host may include an explicit scheme for non-HTTPS servers.
	scheme := "https"
	bareHost := host
	switch {
	case strings.HasPrefix(host, "http://"):
		scheme = "http"
		bareHost = strings.TrimPrefix(host, "http://")
	case strings.HasPrefix(host, "https://"):
		bareHost = strings.TrimPrefix(host, "https://")
	}

	var transport *http.Transport
	if scheme == "https" {
		transport = &http.Transport{
			TLSClientConfig: &tls.Config{
				ServerName: bareHost,
				MinVersion: tls.VersionTLS12,
			},
		}
	} else {
		transport = &http.Transport{}
	}
	httpClient := &http.Client{
		Timeout:   30 * time.Second,
		Transport: transport,
	}

	body := fmt.Sprintf(`{`+
		`"id":%s,`+
		`"name":%s,`+
		`"antenna":%s,`+
		`"bandwidth":%d,`+
		`"users":%d,`+
		`"center_frequency":%d,`+
		`"grid_locator":%s,`+
		`"hostname":%s,`+
		`"max_users":%d,`+
		`"port":%d,`+
		`"software":"UberSDR",`+
		`"backend":"ka9q-radio",`+
		`"version":%s,`+
		`"receiver_count":1,`+
		`"receiver_id":%s,`+
		`"range_start_hz":%d,`+
		`"range_end_hz":%d`+
		`}`,
		jsonStr(r.instanceID),
		jsonStr(description),
		jsonStr(antenna),
		bw,
		numUsers,
		centerFreq,
		jsonStr(qth),
		jsonStr(hostname),
		maxUsers,
		listenPort,
		jsonStr(Version),
		jsonStr("UberSDR-HF"),
		rangeStart,
		rangeEnd,
	)

	req, err := http.NewRequest("POST",
		fmt.Sprintf("%s://%s/api/update_websdr", scheme, bareHost),
		bytes.NewBufferString(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Host", bareHost)
	req.Header.Set("User-Agent", fmt.Sprintf("UberSDR/%s", Version))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connection", "close")
	req.ContentLength = int64(len(body))

	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("POST: %w", err)
	}

	// Read response body (up to 8192 bytes) before closing (§12.3)
	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
	resp.Body.Close()

	// Success criterion: 2xx status (§12.3)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet := string(bodyBytes)
		if len(snippet) > 120 {
			snippet = snippet[:120]
		}
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, snippet)
	}

	log.Printf("sdr-list: %s registered (host=%s port=%d, 10 kHz – 30 MHz)", displayName, hostname, listenPort)
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// jsonStr returns a JSON-encoded string value (with escaping per §12.3).
func jsonStr(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '\\':
			b.WriteString(`\\`)
		case '"':
			b.WriteString(`\"`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

package main

// kiwisdr_registration.go — rx.kiwisdr.com public directory registration
//
// Replicates the two-phase registration that KiwiSDR firmware performs

import (
	"crypto/sha256"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Constants (mirroring KiwiSDR net/services.cpp)
// ─────────────────────────────────────────────────────────────────────────────

const (
	kiwiSDRComHost       = "kiwisdr.com"
	kiwiSDRComUpdatePath = "/php/update.php"
	kiwiSDRComMyKiwiPath = "/php/my_kiwi.php"

	// RETRYTIME_KIWISDR_COM = 45 minutes (from KiwiSDR net/services.cpp line 939)
	kiwiSDRComRetryInterval = 45 * time.Minute
	// RETRYTIME_KIWISDR_COM_FAIL = 3 minutes (check frequently for re-enablement)
	kiwiSDRComFailInterval = 3 * time.Minute

	kiwiSDRComHTTPTimeout = 30 * time.Second

	// Hardcoded auth token used by all KiwiSDR firmware for my_kiwi.php
	// (from KiwiSDR net/services.cpp line 236 — it is a constant, not derived)
	kiwiSDRMyKiwiAuth = "308bb2580afb041e0514cd0d4f21919c"

	// Values captured from a live KiwiSDR v2 registration packet and hardcoded
	// here so we appear as a compatible, up-to-date receiver to the directory.
	kiwiSDRReportedVersion = "1.837" // KiwiSDR firmware version (major.minor)
	kiwiSDRReportedDeb     = "11.8"  // BeagleBone Debian Bullseye version
	kiwiSDRReportedModel   = "2"     // KiwiSDR v2 hardware model
)

// ─────────────────────────────────────────────────────────────────────────────
// KiwiSDRComRegistrar
// ─────────────────────────────────────────────────────────────────────────────

// KiwiSDRComRegistrar registers this UberSDR instance with the rx.kiwisdr.com
// public receiver directory. It is independent of all other subsystems and
// only needs the global Config.
//
// Public IP discovery: the real KiwiSDR learns its public IP from the source
// address of the reverse /status probe that kiwisdr.com makes after each
// update.php call. We replicate this by having the /status handler call
// NotifyReverseProbe with the remote IP, which unblocks the my_kiwi.php call
// and populates the pub IP for subsequent update.php calls.
type KiwiSDRComRegistrar struct {
	config *Config
	stop   chan struct{}

	// pubIP is the discovered public IP address.
	// Protected by mu. Empty string = not yet known (send pub=not_valid).
	mu    sync.RWMutex
	pubIP string

	// myKiwiDone tracks whether the one-shot my_kiwi.php call has been made.
	myKiwiDone bool
}

// NewKiwiSDRComRegistrar creates a registrar. Call Start() to begin.
func NewKiwiSDRComRegistrar(config *Config) *KiwiSDRComRegistrar {
	return &KiwiSDRComRegistrar{
		config: config,
		stop:   make(chan struct{}),
	}
}

// Start launches the registration goroutine (non-blocking).
func (k *KiwiSDRComRegistrar) Start() {
	go k.loop()
}

// Stop signals the registration goroutine to exit.
func (k *KiwiSDRComRegistrar) Stop() {
	close(k.stop)
}

// NotifyReverseProbe is called by the /status HTTP handler on every incoming
// request. kiwisdr.com connects back to probe our reachability immediately
// after receiving our update.php registration.
//
// remoteAddr is the remote address of the incoming connection (e.g. "50.116.2.70:53388").
// This is a no-op in the current implementation — the reverse probe is purely
// kiwisdr.com verifying reachability; my_kiwi.php is triggered independently
// once the public IP is known (mirroring KiwiSDR misc_NET task behaviour).
func (k *KiwiSDRComRegistrar) NotifyReverseProbe(remoteAddr string) {
	// No action needed — kept as a hook for future use (e.g. logging).
}

// GetPubIP returns the currently known public IP, or empty string if unknown.
func (k *KiwiSDRComRegistrar) GetPubIP() string {
	k.mu.RLock()
	defer k.mu.RUnlock()
	return k.pubIP
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration loop
// ─────────────────────────────────────────────────────────────────────────────

func (k *KiwiSDRComRegistrar) loop() {
	lastReg := false // tracks previous registration state for transition logging

	// Launch the one-shot my_kiwi.php goroutine immediately. It will wait
	// until the pub IP is known (mirrors KiwiSDR misc_NET task behaviour:
	// NET_WAIT_COND("my_kiwi", "misc_NET", net.pub_valid) then my_kiwi_register).
	go k.waitAndRegisterMyKiwi()

	// First update.php attempt immediately.
	sleep := time.Duration(0)

	for {
		select {
		case <-k.stop:
			return
		case <-time.After(sleep):
		}

		enabled := k.config.Server.KiwiSDRRegisterKiwiSDRCom

		// Log state transitions.
		if enabled && !lastReg {
			log.Printf("kiwisdr.com: registration enabled — will register with rx.kiwisdr.com")
		} else if !enabled && lastReg {
			log.Printf("kiwisdr.com: registration disabled — sending deregister")
		}

		if enabled {
			if err := k.updatePHP(true); err != nil {
				log.Printf("kiwisdr.com: update.php error: %v", err)
			}
			sleep = kiwiSDRComRetryInterval
		} else {
			// Send a one-shot deregister on the transition, then idle.
			if lastReg {
				if err := k.updatePHP(false); err != nil {
					log.Printf("kiwisdr.com: deregister error: %v", err)
				}
			}
			sleep = kiwiSDRComFailInterval
		}

		lastReg = enabled
	}
}

// waitAndRegisterMyKiwi waits until the public IP is known then calls my_kiwi.php once.
// This mirrors the KiwiSDR misc_NET task: NET_WAIT_COND("my_kiwi", net.pub_valid)
// followed by my_kiwi_register(). Runs in its own goroutine.
func (k *KiwiSDRComRegistrar) waitAndRegisterMyKiwi() {
	// Poll until pub IP is discovered or we're stopped.
	// discoverPubIP() uses a UDP dial toward kiwisdr.com to find the local
	// outbound address — this works as soon as the network is up.
	const pollInterval = 2 * time.Second
	const maxWait = 5 * time.Minute

	deadline := time.Now().Add(maxWait)
	for {
		select {
		case <-k.stop:
			return
		default:
		}

		pubIP := k.discoverPubIP()
		if pubIP != "" {
			k.mu.Lock()
			k.pubIP = pubIP
			k.mu.Unlock()
			break
		}

		if time.Now().After(deadline) {
			log.Printf("kiwisdr.com: could not determine public IP after %v; my_kiwi.php skipped", maxWait)
			return
		}
		time.Sleep(pollInterval)
	}

	if !k.config.Server.KiwiSDRRegisterKiwiSDRCom {
		return
	}

	if err := k.myKiwiPHP(); err != nil {
		log.Printf("kiwisdr.com: my_kiwi.php error: %v", err)
	} else {
		k.myKiwiDone = true
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// update.php — periodic registration GET (wget-style)
// ─────────────────────────────────────────────────────────────────────────────

func (k *KiwiSDRComRegistrar) updatePHP(register bool) error {
	cfg := k.config

	// ── Server URL ────────────────────────────────────────────────────────────
	serverURL := cfg.Server.KiwiSDRHost
	if serverURL == "" {
		log.Printf("kiwisdr.com: registration skipped — kiwisdr_host is not set (set server.kiwisdr_host to your public hostname)")
		return nil
	}

	instanceUUID := cfg.InstanceReporting.InstanceUUID
	if instanceUUID == "" {
		log.Printf("kiwisdr.com: registration skipped — instance_uuid not yet generated (instance_reporting must initialise first)")
		return nil
	}

	port := cfg.Server.KiwiSDRPort
	if port == 0 {
		port = 8073
	}

	uptime := int64(time.Since(StartTime).Seconds())

	regVal := 0
	if register {
		regVal = 1
	}

	hostname, _ := os.Hostname()

	// pub IP: use known value or "not_valid" if not yet discovered.
	pubIP := k.GetPubIP()
	if pubIP == "" {
		pubIP = "not_valid"
	}

	pvtIP := localIPv4()
	mac := stableMAC(instanceUUID)
	userToken := stableUserToken(instanceUUID)

	// ── Build query string ────────────────────────────────────────────────────
	// Mirrors the complete param set from KiwiSDR net/services.cpp reg_public().
	q := url.Values{}
	q.Set("url", fmt.Sprintf("http://%s:%d", serverURL, port))
	if mac != "" {
		q.Set("mac", mac)
	}
	q.Set("add_nat", "0")
	q.Set("hn", hostname)
	q.Set("pub", pubIP)
	if pvtIP != "" {
		q.Set("pvt", pvtIP)
	}
	q.Set("port", fmt.Sprintf("%d", port))
	q.Set("dhcp", "1")
	q.Set("jq", "1")
	q.Set("email", cfg.Admin.Email)
	q.Set("ver", kiwiSDRReportedVersion)
	q.Set("deb", kiwiSDRReportedDeb)
	q.Set("model", kiwiSDRReportedModel)
	q.Set("plat", "0")
	q.Set("dom", "0")
	q.Set("domNAM", "") // dom type string — real KiwiSDRs send domNAM with no value
	q.Set("dom_stat", "-1")
	q.Set("auto", "1")
	if userToken != "" {
		q.Set("user", userToken)
	}
	q.Set("host", "0")
	q.Set("dna", "0000000000000000")
	q.Set("apu", "0")
	q.Set("mtu", "1500")
	q.Set("serno", "0")
	q.Set("reg", fmt.Sprintf("%d", regVal))
	q.Set("vr", "0")
	q.Set("up", fmt.Sprintf("%d", uptime))

	rawURL := fmt.Sprintf("http://%s%s?%s", kiwiSDRComHost, kiwiSDRComUpdatePath, q.Encode())

	// ── HTTP GET (User-Agent matches real KiwiSDR wget invocation) ────────────
	client := &http.Client{Timeout: kiwiSDRComHTTPTimeout}
	req, err := http.NewRequest("GET", rawURL, nil)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	// Real KiwiSDR uses: wget --timeout=30 --tries=2 --inet4-only -qO-
	req.Header.Set("User-Agent", "Wget/1.21")
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Accept-Encoding", "identity")
	req.Header.Set("Connection", "Keep-Alive")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("GET: %w", err)
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	resp.Body.Close()

	bodyStr := strings.TrimSpace(string(body))

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet := bodyStr
		if len(snippet) > 120 {
			snippet = snippet[:120]
		}
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, snippet)
	}

	// Parse "status <N>" response (same as KiwiSDR _reg_public callback).
	var status int
	fmt.Sscanf(bodyStr, "status %d", &status)

	action := "registered"
	if !register {
		action = "deregistered"
	}
	log.Printf("kiwisdr.com: update.php %s (url=%s:%d, pub=%s, pvt=%s, status=%d)",
		action, serverURL, port, pubIP, pvtIP, status)

	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// my_kiwi.php — one-shot authenticated registration (curl-style)
// ─────────────────────────────────────────────────────────────────────────────

// myKiwiPHP sends the one-shot authenticated registration to my_kiwi.php.
// This is called once after the first successful update.php + reverse probe.
// The auth token is a hardcoded constant in KiwiSDR firmware (not derived).
func (k *KiwiSDRComRegistrar) myKiwiPHP() error {
	cfg := k.config

	serverURL := cfg.Server.KiwiSDRHost
	if serverURL == "" {
		return nil
	}

	instanceUUID := cfg.InstanceReporting.InstanceUUID
	if instanceUUID == "" {
		return nil
	}

	port := cfg.Server.KiwiSDRPort
	if port == 0 {
		port = 8073
	}

	uptime := int64(time.Since(StartTime).Seconds())
	hostname, _ := os.Hostname()

	pubIP := k.GetPubIP()
	if pubIP == "" {
		pubIP = "not_valid"
	}

	pvtIP := localIPv4()
	mac := stableMAC(instanceUUID)
	userToken := stableUserToken(instanceUUID)

	regVal := 1
	if !cfg.Server.KiwiSDRRegisterKiwiSDRCom {
		regVal = 0
	}

	// ── Build query string ────────────────────────────────────────────────────
	// Mirrors KiwiSDR net/services.cpp my_kiwi_register() exactly.
	q := url.Values{}
	q.Set("auth", kiwiSDRMyKiwiAuth)
	q.Set("url", fmt.Sprintf("http://%s:%d", serverURL, port))
	if mac != "" {
		q.Set("mac", mac)
	}
	q.Set("add_nat", "0")
	q.Set("hn", hostname)
	q.Set("pub", pubIP)
	if pvtIP != "" {
		q.Set("pvt", pvtIP)
	}
	q.Set("port", fmt.Sprintf("%d", port))
	q.Set("dhcp", "1")
	q.Set("jq", "1")
	q.Set("email", cfg.Admin.Email)
	q.Set("ver", kiwiSDRReportedVersion)
	q.Set("deb", kiwiSDRReportedDeb)
	q.Set("model", kiwiSDRReportedModel)
	q.Set("plat", "0")
	q.Set("dom", "0")
	q.Set("domNAM", "")
	q.Set("dom_stat", "-1")
	q.Set("auto", "1")
	if userToken != "" {
		q.Set("user", userToken)
	}
	q.Set("host", "0")
	q.Set("dna", "0000000000000000")
	q.Set("apu", "0")
	q.Set("mtu", "1500")
	q.Set("serno", "0")
	q.Set("reg", fmt.Sprintf("%d", regVal))
	q.Set("vr", "0")
	q.Set("up", fmt.Sprintf("%d", uptime))

	rawURL := fmt.Sprintf("http://%s%s?%s", kiwiSDRComHost, kiwiSDRComMyKiwiPath, q.Encode())

	// Real KiwiSDR uses: curl -Ls --show-error --ipv4 --connect-timeout 5
	client := &http.Client{Timeout: kiwiSDRComHTTPTimeout}
	req, err := http.NewRequest("GET", rawURL, nil)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("User-Agent", fmt.Sprintf("curl/7.74.0"))
	req.Header.Set("Accept", "*/*")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("GET: %w", err)
	}
	io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	log.Printf("kiwisdr.com: my_kiwi.php registered (url=%s:%d, pub=%s, auth=...%s)",
		serverURL, port, pubIP, kiwiSDRMyKiwiAuth[len(kiwiSDRMyKiwiAuth)-8:])
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Public IP discovery
// ─────────────────────────────────────────────────────────────────────────────

// discoverPubIP determines our public IP. Preference order:
//  1. kiwisdr_host config value (if it's a bare IP, use it directly)
//  2. instances.ubersdr.org/api/myip  → {"ip": "<public_ip>"}
//  3. ipapi.co/json                   → {"ip": "<public_ip>"}  (fallback)
func (k *KiwiSDRComRegistrar) discoverPubIP() string {
	// If kiwisdr_host is a bare IP address, use it directly (operator override).
	if h := k.config.Server.KiwiSDRHost; h != "" {
		if net.ParseIP(h) != nil {
			return h
		}
	}

	client := &http.Client{Timeout: 5 * time.Second}

	// Primary: UberSDR instance collector (already used by sdrlist_registration.go).
	if ip := fetchIPField(client, "https://instances.ubersdr.org/api/myip", "ip"); ip != "" {
		return ip
	}

	// Fallback: ipapi.co (same as KiwiSDR pub_NET first choice).
	if ip := fetchIPField(client, "https://ipapi.co/json", "ip"); ip != "" {
		return ip
	}

	return ""
}

// fetchIPField fetches a JSON URL and returns the value of the named string field,
// validated as an IP address. Returns empty string on any error.
func fetchIPField(client *http.Client, url, field string) string {
	resp, err := client.Get(url)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return ""
	}
	// Simple JSON field extraction without importing encoding/json.
	// Looks for: "field":"value" or "field": "value"
	needle := `"` + field + `"`
	idx := strings.Index(string(body), needle)
	if idx < 0 {
		return ""
	}
	rest := string(body)[idx+len(needle):]
	// Skip whitespace and colon.
	rest = strings.TrimLeft(rest, " \t\r\n:")
	rest = strings.TrimLeft(rest, " \t\r\n")
	if len(rest) == 0 || rest[0] != '"' {
		return ""
	}
	rest = rest[1:]
	end := strings.IndexByte(rest, '"')
	if end < 0 {
		return ""
	}
	candidate := rest[:end]
	if net.ParseIP(candidate) == nil {
		return ""
	}
	return candidate
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// localIPv4 returns the first non-loopback IPv4 address found on any local
// interface, or an empty string if none is available.
func localIPv4() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.IsLoopback() {
				continue
			}
			if ip4 := ip.To4(); ip4 != nil {
				return ip4.String()
			}
		}
	}
	return ""
}

// stableMAC returns a deterministic locally-administered unicast MAC address
// derived from the identity key. The 02: prefix marks it as locally
// administered so it cannot collide with real hardware MACs.
// Output is always exactly "02:xx:xx:xx:xx:xx" regardless of input length.
func stableMAC(key string) string {
	h := sha256.Sum256([]byte("ubersdr-mac:" + key))
	return fmt.Sprintf("02:%02x:%02x:%02x:%02x:%02x", h[0], h[1], h[2], h[3], h[4])
}

// stableUserToken derives a stable 28-character hex token from the identity key.
// This replaces the KiwiSDR MAC-derived unique_id so that the registry identity
// is stable across restarts and Docker container recreations.
// Output is always exactly 28 hex characters regardless of input length.
func stableUserToken(key string) string {
	h := sha256.Sum256([]byte("ubersdr-user:" + key))
	return fmt.Sprintf("%x", h)[:28]
}

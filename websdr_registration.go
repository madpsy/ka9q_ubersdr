package main

// websdr_registration.go — WebSDR directory registration
//
// Implements two outbound registration protocols:
//
//   §12.2  Legacy websdr.org registration (plain HTTP, ~60 s interval)
//   §12.3  sdr-list.xyz registration (HTTPS/JSON POST, ~60 s interval)
//
// Both are disabled by default and controlled by config flags:
//   websdr_register_websdrorg: true/false
//   websdr_register_sdrlist:   true/false

import (
	"bytes"
	"crypto/tls"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Constants (from spec §12.3)
// ─────────────────────────────────────────────────────────────────────────────

const (
	websdrOrgRegInterval  = 60 * time.Second
	sdrListUpdateInterval = 60 * time.Second
	sdrListBackoffBase    = 30 * time.Second
	sdrListBackoffMax     = 3600 * time.Second
)

// ─────────────────────────────────────────────────────────────────────────────
// WebSDRRegistrar — manages both registration threads
// ─────────────────────────────────────────────────────────────────────────────

// WebSDRRegistrar runs background registration goroutines.
type WebSDRRegistrar struct {
	config     *Config
	handler    *WebSDRHandler
	instanceID string // decimal string of (time ^ pid)
	stop       chan struct{}
}

// NewWebSDRRegistrar creates a registrar.  Call Start() to begin registration.
func NewWebSDRRegistrar(config *Config, handler *WebSDRHandler) *WebSDRRegistrar {
	// Instance ID: (uint32)(time.Now().Unix() ^ pid) as decimal string (§12.1)
	instanceID := strconv.FormatUint(
		uint64(uint32(time.Now().Unix())^uint32(processID())),
		10,
	)
	return &WebSDRRegistrar{
		config:     config,
		handler:    handler,
		instanceID: instanceID,
		stop:       make(chan struct{}),
	}
}

// Start launches the registration goroutines (non-blocking).
func (reg *WebSDRRegistrar) Start() {
	if reg.config.Server.WebSDRNoOrgServer {
		// De-registration mode: send /~~websdrNOorg notices instead of registering
		go reg.websdrOrgDeregLoop()
	} else if reg.config.Server.WebSDRRegisterWebSDROrg {
		go reg.websdrOrgLoop()
	}
	if reg.config.Server.WebSDRRegisterSdrList {
		go reg.sdrListLoop()
	}
}

// Stop signals the registration goroutines to exit.
func (reg *WebSDRRegistrar) Stop() {
	close(reg.stop)
}

// ─────────────────────────────────────────────────────────────────────────────
// §12.2 — Legacy websdr.org registration
// ─────────────────────────────────────────────────────────────────────────────

func (reg *WebSDRRegistrar) websdrOrgLoop() {
	serverSpec := reg.config.Server.WebSDRRegisterWebSDROrgServer
	if serverSpec == "" {
		serverSpec = "websdr.ewi.utwente.nl 80"
	}

	// Parse "hostname port"
	parts := strings.Fields(serverSpec)
	host := "websdr.ewi.utwente.nl"
	port := "80"
	if len(parts) >= 1 {
		host = parts[0]
	}
	if len(parts) >= 2 {
		port = parts[1]
	}
	addr := net.JoinHostPort(host, port)

	var conn net.Conn

	for {
		select {
		case <-reg.stop:
			if conn != nil {
				conn.Close()
			}
			return
		default:
		}

		// Build registration request
		listenPort := reg.publicPort()
		hostname := reg.publicHostname()

		var reqLine string
		if hostname != "" {
			reqLine = fmt.Sprintf("GET /~~websdrorg?host=%s&port=%d HTTP/1.1\r\n\r\n", hostname, listenPort)
		} else {
			reqLine = fmt.Sprintf("GET /~~websdrorg?port=%d HTTP/1.1\r\n\r\n", listenPort)
		}

		// (Re)connect if needed
		if conn == nil {
			var err error
			dialer := &net.Dialer{Timeout: 10 * time.Second}
			conn, err = dialer.Dial("tcp", addr)
			if err != nil {
				log.Printf("WebSDR: websdr.org registration connect error: %v", err)
				select {
				case <-reg.stop:
					return
				case <-time.After(60 * time.Second):
				}
				continue
			}
			_ = conn.(*net.TCPConn).SetKeepAlive(true)
		}

		// Set timeouts (§12.2: SO_RCVTIMEO / SO_SNDTIMEO = 10s)
		_ = conn.SetDeadline(time.Now().Add(10 * time.Second))

		_, err := fmt.Fprint(conn, reqLine)
		if err != nil {
			log.Printf("WebSDR: websdr.org registration write error: %v", err)
			conn.Close()
			conn = nil
			continue
		}

		// Sleep 10s, then read response, then sleep 50s (total ~60s cycle)
		select {
		case <-reg.stop:
			conn.Close()
			return
		case <-time.After(10 * time.Second):
		}

		// Read up to 1024 bytes of response and log it (sanitised).
		// If the server closed the connection (n==0, err==io.EOF or similar),
		// reset conn so the next iteration reconnects rather than writing on a
		// dead socket and wasting a full 60 s cycle.
		buf := make([]byte, 1024)
		_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
		n, readErr := conn.Read(buf)
		respSnippet := sanitiseLogString(buf[:n], 120)
		log.Printf("WebSDR: registered with websdr.org (host=%s, port=%d) response: %q", hostname, listenPort, respSnippet)
		if n == 0 || readErr != nil {
			// Server closed or errored — drop the connection so we reconnect next cycle.
			conn.Close()
			conn = nil
		}

		select {
		case <-reg.stop:
			conn.Close()
			return
		case <-time.After(50 * time.Second):
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// §12.2 (de-registration) — websdr.org de-registration loop (FEAT-13)
// ─────────────────────────────────────────────────────────────────────────────

// websdrOrgDeregLoop sends periodic /~~websdrNOorg de-registration notices.
// State 1: every 900 s (15 min).  After first send, transitions to state 2.
// State 2: every 86400 s (24 h).
func (reg *WebSDRRegistrar) websdrOrgDeregLoop() {
	serverSpec := reg.config.Server.WebSDRRegisterWebSDROrgServer
	if serverSpec == "" {
		serverSpec = "websdr.ewi.utwente.nl 80"
	}
	parts := strings.Fields(serverSpec)
	host := "websdr.ewi.utwente.nl"
	port := "80"
	if len(parts) >= 1 {
		host = parts[0]
	}
	if len(parts) >= 2 {
		port = parts[1]
	}
	addr := net.JoinHostPort(host, port)

	listenPort := reg.publicPort()
	reqLine := fmt.Sprintf("GET /~~websdrNOorg?port=%d HTTP/1.1\r\n\r\n", listenPort)

	// org_state: 1 = first send (900 s interval), 2 = subsequent (86400 s interval)
	orgState := 1

	for {
		// Connect, send de-registration, disconnect
		dialer := &net.Dialer{Timeout: 10 * time.Second}
		conn, err := dialer.Dial("tcp", addr)
		if err != nil {
			log.Printf("WebSDR: websdr.org de-registration connect error: %v", err)
		} else {
			_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
			if _, err = fmt.Fprint(conn, reqLine); err != nil {
				log.Printf("WebSDR: websdr.org de-registration write error: %v", err)
			} else {
				// Read response and log it (sanitised)
				buf := make([]byte, 1024)
				_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
				n, _ := conn.Read(buf)
				respSnippet := sanitiseLogString(buf[:n], 120)
				log.Printf("WebSDR: sent de-registration to websdr.org (port=%d, state=%d) response: %q", listenPort, orgState, respSnippet)
			}
			conn.Close()
		}

		// Transition to state 2 after first send
		var interval time.Duration
		if orgState == 1 {
			interval = 900 * time.Second
			orgState = 2
		} else {
			interval = 86400 * time.Second
		}

		select {
		case <-reg.stop:
			return
		case <-time.After(interval):
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// §12.3 — sdr-list.xyz HTTPS registration
// ─────────────────────────────────────────────────────────────────────────────

func (reg *WebSDRRegistrar) sdrListLoop() {
	sdrListHost := reg.config.Server.WebSDRSdrListHost
	if sdrListHost == "" {
		sdrListHost = "sdr-list.xyz"
	}

	attempt := 0
	// First attempt immediately
	backoff := time.Duration(0)

	for {
		select {
		case <-reg.stop:
			return
		case <-time.After(backoff):
		}

		err := reg.sdrListUpdate(sdrListHost)
		if err != nil {
			log.Printf("WebSDR: sdr-list.xyz registration error: %v", err)
			// Exponential backoff: 30 << min(attempt, 16), capped at 3600s
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

// Hardware frequency coverage is fixed for UberSDR: 10 kHz – 30 MHz.
// These constants are not user-configurable.
const (
	uberSDRRangeStartHz = int64(10_000)     // 10 kHz
	uberSDRRangeEndHz   = int64(30_000_000) // 30 MHz
)

func (reg *WebSDRRegistrar) sdrListUpdate(host string) error {
	hostname := reg.publicHostname()
	if hostname == "" {
		log.Printf("WebSDR: sdr-list.xyz registration skipped: no hostname configured")
		return nil
	}

	listenPort := reg.publicPort()
	maxUsers := reg.config.Server.WebSDRMaxUsers
	if maxUsers == 0 {
		maxUsers = reg.config.Server.MaxSessions
	}

	// Parse org_info for Description and Qth
	description := reg.orgInfoField("Description")
	if description == "" {
		description = reg.config.Admin.Name
	}
	qth := reg.orgInfoField("Qth")
	if qth == "" {
		// Fall back to Maidenhead grid from GPS
		qth = latLonToGridSquare(reg.config.Admin.GPS.Lat, reg.config.Admin.GPS.Lon)
	}
	antenna := reg.config.Admin.Antenna

	numUsers := int(atomic.LoadInt32(&reg.handler.audioUserCount))

	// Fixed hardware range: 10 kHz – 30 MHz (UberSDR limitation, not user-configurable)
	rangeStart := uberSDRRangeStartHz
	rangeEnd := uberSDRRangeEndHz
	bw := rangeEnd - rangeStart
	centerFreq := int64(15_000_000) // fixed centre for 10 kHz–30 MHz HF band

	tlsConfig := &tls.Config{
		ServerName: host,
		MinVersion: tls.VersionTLS12,
	}
	httpClient := &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: tlsConfig,
		},
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
		`"software":"WebSDR",`+
		`"backend":"ubersdr",`+
		`"version":%s,`+
		`"receiver_count":1,`+
		`"receiver_id":%s,`+
		`"range_start_hz":%d,`+
		`"range_end_hz":%d`+
		`}`,
		jsonStr(reg.instanceID),
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
		jsonStr("ubersdr-hf"),
		rangeStart,
		rangeEnd,
	)

	req, err := http.NewRequest("POST",
		fmt.Sprintf("https://%s/api/update_websdr", host),
		bytes.NewBufferString(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Host", host)
	req.Header.Set("User-Agent", "") // suppress Go's default User-Agent
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connection", "close")
	req.ContentLength = int64(len(body))

	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("POST: %w", err)
	}

	// Read response body (up to 8192 bytes) before closing (MINOR-23 / §12.3)
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

	log.Printf("WebSDR: sdr-list.xyz registered (10 kHz – 30 MHz, center %d Hz)", centerFreq)
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// publicHostname returns the configured public hostname for registration.
func (reg *WebSDRRegistrar) publicHostname() string {
	if reg.config.Server.WebSDRHostname != "" {
		return reg.config.Server.WebSDRHostname
	}
	// Fall back to admin.public_url host
	if reg.config.Admin.PublicURL != "" {
		u := reg.config.Admin.PublicURL
		// Strip scheme
		u = strings.TrimPrefix(u, "https://")
		u = strings.TrimPrefix(u, "http://")
		// Strip path
		if idx := strings.Index(u, "/"); idx >= 0 {
			u = u[:idx]
		}
		// Strip port
		if host, _, err := net.SplitHostPort(u); err == nil {
			return host
		}
		return u
	}
	return ""
}

// publicPort returns the TCP port for directory registration.
func (reg *WebSDRRegistrar) publicPort() int {
	if reg.config.Server.WebSDRTCPPort > 0 {
		return reg.config.Server.WebSDRTCPPort
	}
	listen := reg.config.Server.WebSDRListen
	if listen == "" {
		return 8901
	}
	_, portStr, err := net.SplitHostPort(listen)
	if err != nil {
		// listen might be just ":8901"
		portStr = strings.TrimPrefix(listen, ":")
	}
	p, _ := strconv.Atoi(portStr)
	if p == 0 {
		p = 8901
	}
	return p
}

// orgInfoField extracts a field value from the multi-line WebSDROrgInfo string.
// Looks for lines matching "<label>: <value>" (case-insensitive).
func (reg *WebSDRRegistrar) orgInfoField(label string) string {
	for _, line := range strings.Split(reg.config.Server.WebSDROrgInfo, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(strings.ToLower(line), strings.ToLower(label)+":") {
			val := line[len(label)+1:]
			return strings.TrimSpace(val)
		}
	}
	return ""
}

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

// processID returns the current process ID as an int.
func processID() int {
	return os.Getpid()
}

// sanitiseLogString converts raw bytes to a printable string safe for logging.
// Non-printable characters (< 0x20, except tab) and DEL (0x7f) are replaced
// with '?'. The result is trimmed of leading/trailing whitespace and capped at
// maxLen runes.
func sanitiseLogString(b []byte, maxLen int) string {
	var sb strings.Builder
	for _, c := range b {
		if c == 0 {
			break // stop at first NUL (end of unread buffer)
		}
		if (c < 0x20 && c != '\t' && c != '\n' && c != '\r') || c == 0x7f {
			sb.WriteByte('?')
		} else {
			sb.WriteByte(c)
		}
	}
	s := strings.TrimSpace(sb.String())
	// Collapse embedded newlines to spaces for single-line log output
	s = strings.ReplaceAll(s, "\r\n", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\r", " ")
	runes := []rune(s)
	if len(runes) > maxLen {
		runes = runes[:maxLen]
	}
	return string(runes)
}

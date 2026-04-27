package main

// websdr_registration.go — websdr.org directory registration (§12.2)
//
// Implements the legacy websdr.org registration protocol (plain HTTP, ~60 s interval).
// Disabled by default; opt-in via config flag:
//   websdr_register_websdrorg: true   — register with websdr.org

import (
	"fmt"
	"log"
	"net"
	"os"
	"strings"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Constants (from spec §12.2)
// ─────────────────────────────────────────────────────────────────────────────

const (
	websdrOrgRegInterval = 60 * time.Second
)

// ─────────────────────────────────────────────────────────────────────────────
// WebSDRRegistrar — manages websdr.org registration
// ─────────────────────────────────────────────────────────────────────────────

// WebSDRRegistrar runs the websdr.org background registration goroutine.
type WebSDRRegistrar struct {
	config *Config
	stop   chan struct{}
}

// NewWebSDRRegistrar creates a registrar. Call Start() to begin registration.
func NewWebSDRRegistrar(config *Config) *WebSDRRegistrar {
	return &WebSDRRegistrar{
		config: config,
		stop:   make(chan struct{}),
	}
}

// Start launches the registration goroutine (non-blocking).
func (reg *WebSDRRegistrar) Start() {
	if reg.config.Server.WebSDRRegisterWebSDROrg {
		go reg.websdrOrgLoop()
	}
}

// Stop signals the registration goroutine to exit.
func (reg *WebSDRRegistrar) Stop() {
	close(reg.stop)
}

// ─────────────────────────────────────────────────────────────────────────────
// §12.2 — Legacy websdr.org registration
// ─────────────────────────────────────────────────────────────────────────────

func (reg *WebSDRRegistrar) websdrOrgLoop() {
	// Wait 30 seconds before the first registration attempt so that the WebSDR
	// HTTP server is fully warmed up and ready to respond to the /~~orgstatus
	// callback that websdr.org makes immediately after receiving the registration.
	select {
	case <-reg.stop:
		return
	case <-time.After(30 * time.Second):
	}

	addr := net.JoinHostPort("websdr.ewi.utwente.nl", "80")

	for {
		select {
		case <-reg.stop:
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

		// Open a fresh TCP connection every cycle (mirrors VertexSDR orgserver.c).
		dialer := &net.Dialer{Timeout: 10 * time.Second}
		conn, err := dialer.Dial("tcp", addr)
		if err != nil {
			log.Printf("WebSDR: websdr.org registration connect error: %v", err)
			select {
			case <-reg.stop:
				return
			case <-time.After(60 * time.Second):
			}
			continue
		}

		// Set write deadline (10s).
		_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))

		_, err = fmt.Fprint(conn, reqLine)
		if err != nil {
			log.Printf("WebSDR: websdr.org registration write error: %v", err)
			conn.Close()
			select {
			case <-reg.stop:
				return
			case <-time.After(60 * time.Second):
			}
			continue
		}

		// Mirror VertexSDR orgserver.c exactly:
		//   1. Send the GET request.
		//   2. Hold the connection open for ~10 seconds — websdr.org uses this
		//      window to open its inbound callback connection to our SDR port
		//      and send GET /~~orgstatus.  Closing too quickly (before the
		//      callback completes) means websdr.org never lists the receiver.
		//   3. Read the response (websdr.org sends its ACK quickly).
		//   4. Close the connection.
		select {
		case <-reg.stop:
			conn.Close()
			return
		case <-time.After(10 * time.Second):
		}

		buf := make([]byte, 1024)
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		n, _ := conn.Read(buf)
		respSnippet := sanitiseLogString(buf[:n], 120)
		log.Printf("WebSDR: registered with websdr.org (host=%s, port=%d) response: %q", hostname, listenPort, respSnippet)

		conn.Close()

		select {
		case <-reg.stop:
			return
		case <-time.After(websdrOrgRegInterval):
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// publicHostname returns the configured public hostname for websdr.org registration.
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

// publicPort returns the TCP port for websdr.org registration.
func (reg *WebSDRRegistrar) publicPort() int {
	if reg.config.Server.WebSDRTCPPort > 0 {
		return reg.config.Server.WebSDRTCPPort
	}
	return 8901
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

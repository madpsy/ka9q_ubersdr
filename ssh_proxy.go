package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

// SSHProxy handles proxying requests to the GoTTY container
type SSHProxy struct {
	config      *SSHProxyConfig
	proxy       *httputil.ReverseProxy
	rateLimiter *SSHProxyRateLimiter
}

// NewSSHProxy creates a new SSH proxy instance
func NewSSHProxy(config *SSHProxyConfig) (*SSHProxy, error) {
	if !config.Enabled {
		return &SSHProxy{
			config:      config,
			rateLimiter: NewSSHProxyRateLimiter(),
		}, nil
	}

	// Construct target URL
	targetURL, err := url.Parse(fmt.Sprintf("http://%s:%d", config.Host, config.Port))
	if err != nil {
		return nil, fmt.Errorf("invalid SSH proxy target URL: %w", err)
	}

	// Create reverse proxy
	proxy := httputil.NewSingleHostReverseProxy(targetURL)

	// Customize the director to handle path stripping and WebSocket origin
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)

		// Capture the true client IP BEFORE stripping proxy headers.
		// getClientIP() reads X-Real-IP / X-Forwarded-For only when the request
		// arrives from a configured tunnel server or trusted proxy, and falls
		// back to RemoteAddr otherwise. It must be called while those headers
		// are still present on the request.
		clientIP := getClientIP(req)

		// Strip client-supplied proxy headers before we set our own authoritative
		// values. Without this a client can inject X-Forwarded-For, X-Real-IP,
		// X-Forwarded-Host, or X-Forwarded-Proto and have them forwarded verbatim
		// to GoTTY, bypassing IP-based controls, audit logs, and HTTPS checks.
		req.Header.Del("X-Forwarded-For")
		req.Header.Del("X-Forwarded-Host")
		req.Header.Del("X-Forwarded-Proto")
		req.Header.Del("X-Real-IP")

		// Strip the proxy path prefix so GoTTY receives the correct paths
		req.URL.Path = strings.TrimPrefix(req.URL.Path, "/terminal")
		if req.URL.Path == "" {
			req.URL.Path = "/"
		}
		req.Host = targetURL.Host

		// Set authoritative forwarding headers for GoTTY.
		req.Header.Set("X-Real-IP", clientIP)
		req.Header.Set("X-Forwarded-For", clientIP)

		// Forward the original Host and protocol so GoTTY can construct correct
		// absolute URLs. Set unconditionally — client-supplied values were deleted above.
		if origHost := req.Header.Get("Host"); origHost != "" {
			req.Header.Set("X-Forwarded-Host", origHost)
		}
		proto := "http"
		if req.TLS != nil {
			proto = "https"
		}
		req.Header.Set("X-Forwarded-Proto", proto)

		// Fix WebSocket origin for GoTTY's CheckOrigin validation.
		// Rewrite the Origin header to match the backend target URL so that
		// WebSocket upgrades pass GoTTY's origin check.
		if req.Header.Get("Upgrade") == "websocket" {
			req.Header.Set("Origin", fmt.Sprintf("http://%s:%d", config.Host, config.Port))
		}
	}

	// Add error handler
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("SSH proxy error: %v", err)
		http.Error(w, "SSH terminal service unavailable", http.StatusBadGateway)
	}

	log.Printf("SSH terminal proxy initialized: /terminal -> %s (rate limit: 100 req/min per IP)", targetURL.String())

	return &SSHProxy{
		config:      config,
		proxy:       proxy,
		rateLimiter: NewSSHProxyRateLimiter(),
	}, nil
}

// ServeHTTP handles the proxy request (authentication handled by middleware)
func (sp *SSHProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !sp.config.Enabled {
		http.Error(w, "SSH terminal proxy is disabled", http.StatusServiceUnavailable)
		return
	}

	// Use centralized IP detection function (same as all other endpoints)
	clientIP := getClientIP(r)

	// Check if client IP is allowed.
	// Bypass for requests whose raw TCP source is the tunnel-support-client container —
	// the support tunnel is trusted infrastructure and the admin auth check still applies.
	rawSourceIP := r.RemoteAddr
	if host, _, err := net.SplitHostPort(rawSourceIP); err == nil {
		rawSourceIP = host
	}
	isSupportTunnel := globalConfig != nil && globalConfig.Server.IsContainerIP(rawSourceIP, "tunnel-support-client")
	if !isSupportTunnel && !sp.config.IsIPAllowed(clientIP) {
		log.Printf("SSH proxy access denied for IP: %s (not in allowed_ips list)", clientIP)
		http.Error(w, "Access Denied - Your IP address is not authorized to access the SSH terminal", http.StatusForbidden)
		return
	}

	// Check rate limit (100 requests per minute per IP)
	if !sp.rateLimiter.AllowRequest(clientIP) {
		log.Printf("SSH proxy rate limit exceeded for IP: %s", clientIP)
		http.Error(w, "Too Many Requests - SSH proxy rate limit exceeded (100 requests per minute)", http.StatusTooManyRequests)
		return
	}

	// Proxy the request (including WebSocket upgrades)
	sp.proxy.ServeHTTP(w, r)
}

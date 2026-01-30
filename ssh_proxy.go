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
		// Strip the proxy path prefix so GoTTY receives the correct paths
		req.URL.Path = strings.TrimPrefix(req.URL.Path, config.Path)
		if req.URL.Path == "" {
			req.URL.Path = "/"
		}
		req.Host = targetURL.Host

		// Fix WebSocket origin for GoTTY's CheckOrigin validation
		// Rewrite the Origin header to match the backend target URL
		// This allows WebSocket upgrades to pass GoTTY's origin check
		if req.Header.Get("Upgrade") == "websocket" {
			// Set origin to match the target backend
			req.Header.Set("Origin", fmt.Sprintf("http://%s:%d", config.Host, config.Port))
			log.Printf("SSH proxy: Rewriting WebSocket origin for %s", req.URL.Path)
		}
	}

	// Add error handler
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("SSH proxy error: %v", err)
		http.Error(w, "SSH terminal service unavailable", http.StatusBadGateway)
	}

	log.Printf("SSH terminal proxy initialized: %s -> %s (rate limit: 100 req/min per IP)", config.Path, targetURL.String())

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

	// Get client IP for rate limiting
	clientIP := r.RemoteAddr
	if host, _, err := net.SplitHostPort(clientIP); err == nil {
		clientIP = host
	}

	// Check X-Forwarded-For header for true source IP (first IP in the list)
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		clientIP = strings.TrimSpace(xff)
		if commaIdx := strings.Index(clientIP, ","); commaIdx != -1 {
			clientIP = strings.TrimSpace(clientIP[:commaIdx])
		}
		if host, _, err := net.SplitHostPort(clientIP); err == nil {
			clientIP = host
		}
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

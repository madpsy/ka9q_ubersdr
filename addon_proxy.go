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

// AddonProxy handles proxying requests to a Docker addon container
type AddonProxy struct {
	entry       *AddonProxyEntry
	proxy       *httputil.ReverseProxy
	rateLimiter *AddonProxyRateLimiter // nil when rate_limit == 0 (unlimited)
}

// NewAddonProxy creates a new addon proxy instance for the given entry.
// The entry must be enabled and have a valid host/port before calling this.
func NewAddonProxy(entry *AddonProxyEntry) (*AddonProxy, error) {
	targetURL, err := url.Parse(fmt.Sprintf("http://%s:%d", entry.Host, entry.Port))
	if err != nil {
		return nil, fmt.Errorf("addon proxy %q: invalid target URL: %w", entry.Name, err)
	}

	// Parse allowed IPs now so IsIPAllowed is ready at request time
	if err := entry.parseAllowedIPs(); err != nil {
		return nil, fmt.Errorf("addon proxy %q: %w", entry.Name, err)
	}

	// Build the path prefix that will be stripped before forwarding
	// e.g. name="grafana" → prefix="/addon/grafana"
	prefix := "/addon/" + entry.Name

	// Create the stdlib reverse proxy
	proxy := httputil.NewSingleHostReverseProxy(targetURL)

	// Wrap the default Director to handle path stripping, IP headers, and
	// optional WebSocket origin rewriting
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)

		// Strip the /addon/{name} prefix so the backend sees the correct path
		if entry.StripPrefix {
			req.URL.Path = strings.TrimPrefix(req.URL.Path, prefix)
			if req.URL.Path == "" {
				req.URL.Path = "/"
			}
			// Also strip from RawPath if set (handles encoded characters)
			if req.URL.RawPath != "" {
				req.URL.RawPath = strings.TrimPrefix(req.URL.RawPath, prefix)
				if req.URL.RawPath == "" {
					req.URL.RawPath = "/"
				}
			}
		}

		// Set Host header to the backend target
		req.Host = targetURL.Host

		// Forward real client IP using the same logic as getClientIP() in main.go
		sourceIP := req.RemoteAddr
		if host, _, err := net.SplitHostPort(sourceIP); err == nil {
			sourceIP = host
		}

		clientIP := sourceIP

		if xff := req.Header.Get("X-Forwarded-For"); xff != "" {
			// X-Forwarded-For can contain multiple IPs: "client, proxy1, proxy2"
			// Extract the first IP (true client)
			clientIP = strings.TrimSpace(xff)
			if commaIdx := strings.Index(clientIP, ","); commaIdx != -1 {
				clientIP = strings.TrimSpace(clientIP[:commaIdx])
			}
			// Strip port if present
			if host, _, err := net.SplitHostPort(clientIP); err == nil {
				clientIP = host
			}
			req.Header.Set("X-Real-IP", clientIP)
			// X-Forwarded-For already set — leave as-is
		} else {
			// Direct connection — set both headers from source IP
			req.Header.Set("X-Forwarded-For", sourceIP)
			req.Header.Set("X-Real-IP", sourceIP)
		}

		// Optionally rewrite the WebSocket Origin header so backends that
		// validate Origin (e.g. GoTTY) accept the connection
		if entry.RewriteOrigin && req.Header.Get("Upgrade") == "websocket" {
			req.Header.Set("Origin", fmt.Sprintf("http://%s:%d", entry.Host, entry.Port))
		}
	}

	// Error handler — return a clean 502 instead of the default Go error page
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("Addon proxy %q error: %v", entry.Name, err)
		http.Error(w, fmt.Sprintf("Addon service %q is unavailable", entry.Name), http.StatusBadGateway)
	}

	// Build rate limiter (nil = unlimited)
	var rl *AddonProxyRateLimiter
	if entry.RateLimit > 0 {
		rl = NewAddonProxyRateLimiter(entry.RateLimit)
	}

	log.Printf("Addon proxy %q initialised: /addon/%s/ → http://%s:%d (strip_prefix=%v, require_admin=%v, rewrite_origin=%v, rate_limit=%d req/min)",
		entry.Name, entry.Name, entry.Host, entry.Port,
		entry.StripPrefix, entry.RequireAdmin, entry.RewriteOrigin, entry.RateLimit)

	return &AddonProxy{
		entry:       entry,
		proxy:       proxy,
		rateLimiter: rl,
	}, nil
}

// ServeHTTP handles an incoming request, enforcing IP allowlist and rate limit
// before delegating to the underlying reverse proxy.
// Authentication (if required) is enforced by the AuthMiddleware wrapper in main.go.
func (ap *AddonProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	clientIP := getClientIP(r)

	// Check IP allowlist
	if !ap.entry.IsIPAllowed(clientIP) {
		log.Printf("Addon proxy %q: access denied for IP %s (not in allowed_ips)", ap.entry.Name, clientIP)
		http.Error(w, "Access Denied — your IP address is not authorised to access this addon", http.StatusForbidden)
		return
	}

	// Check rate limit (skip when rateLimiter is nil, i.e. rate_limit == 0)
	if ap.rateLimiter != nil && !ap.rateLimiter.AllowRequest(clientIP) {
		log.Printf("Addon proxy %q: rate limit exceeded for IP %s", ap.entry.Name, clientIP)
		http.Error(w, fmt.Sprintf("Too Many Requests — addon proxy %q rate limit exceeded (%d requests per minute)", ap.entry.Name, ap.entry.RateLimit), http.StatusTooManyRequests)
		return
	}

	// Forward the request (handles both plain HTTP and WebSocket upgrades)
	ap.proxy.ServeHTTP(w, r)
}

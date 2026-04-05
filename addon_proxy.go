package main

import (
	"fmt"
	"log"
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

	// Create the stdlib reverse proxy.
	// FlushInterval=-1 means "flush immediately after every write" — required for
	// SSE (text/event-stream) endpoints so that each event frame is forwarded to
	// the browser as soon as the backend writes it, rather than being buffered.
	// Without this, ReverseProxy's internal io.Copy buffers the body and the
	// browser never receives the streamed events, causing the connection to be
	// interrupted. WebSocket upgrades are unaffected (they use http.Hijacker).
	proxy := httputil.NewSingleHostReverseProxy(targetURL)
	proxy.FlushInterval = -1

	// Wrap the default Director to handle path stripping, IP headers, and
	// optional WebSocket origin rewriting
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)

		// Strip client-supplied proxy headers before we set our own authoritative
		// values. Without this a client can inject X-Forwarded-For, X-Real-IP,
		// X-Forwarded-Host, or X-Forwarded-Proto and have them forwarded verbatim
		// to the backend, bypassing IP-based controls, audit logs, and HTTPS checks.
		req.Header.Del("X-Forwarded-For")
		req.Header.Del("X-Forwarded-Host")
		req.Header.Del("X-Forwarded-Proto")
		req.Header.Del("X-Real-IP")

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
			// Tell the backend what prefix was stripped so it can construct
			// correct absolute URLs (e.g. for <base> tags, redirects, etc.)
			req.Header.Set("X-Forwarded-Prefix", prefix)
		}

		// Set Host header to the backend target
		req.Host = targetURL.Host

		// Use the same trusted getClientIP() logic used everywhere else in
		// UberSDR: honours X-Real-IP / X-Forwarded-For only when the request
		// arrives from a configured tunnel server or trusted proxy, and falls
		// back to RemoteAddr otherwise.
		clientIP := getClientIP(req)

		// Set authoritative forwarding headers for the backend.
		req.Header.Set("X-Real-IP", clientIP)
		req.Header.Set("X-Forwarded-For", clientIP)

		// Forward the original Host and protocol so backends can construct
		// correct absolute URLs (redirects, CORS, cookie domains, etc.).
		// These are set unconditionally because the client-supplied values were
		// deleted above.
		if origHost := req.Header.Get("Host"); origHost != "" {
			req.Header.Set("X-Forwarded-Host", origHost)
		}
		proto := "http"
		if req.TLS != nil {
			proto = "https"
		}
		req.Header.Set("X-Forwarded-Proto", proto)

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

package main

import (
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
)

// GPSDOProxy handles proxying requests to the ubersdr-leobodnar container.
// The LBE-1420 dashboard serves a live HTML page, a JSON snapshot endpoint,
// and a Server-Sent Events stream (/events).  FlushInterval=-1 ensures SSE
// frames are forwarded to the browser immediately rather than being buffered.
// Access is restricted to authenticated admin sessions (enforced by the
// AuthMiddleware wrapper registered in main.go).
//
// The proxy supports live reconfiguration via Reconfigure: calling it with a
// new GPSDOConfig atomically replaces the inner httputil.ReverseProxy so that
// changes to host, port, or enabled take effect immediately without a restart.
type GPSDOProxy struct {
	mu      sync.RWMutex
	enabled bool
	inner   *httputil.ReverseProxy
}

// NewGPSDOProxy creates a new GPSDO proxy instance.
// The proxy is always created (never nil) so that the /gpsdo/ route can be
// registered once at startup and reconfigured live via Reconfigure.
func NewGPSDOProxy(config *GPSDOConfig) *GPSDOProxy {
	gp := &GPSDOProxy{}
	gp.applyConfig(config)
	return gp
}

// Reconfigure atomically replaces the inner proxy with one built from the new
// config.  Safe to call concurrently with ServeHTTP.
func (gp *GPSDOProxy) Reconfigure(config *GPSDOConfig) {
	gp.mu.Lock()
	defer gp.mu.Unlock()
	gp.applyConfig(config)
	if config.Enabled {
		log.Printf("GPSDO proxy reconfigured: /gpsdo/ → http://%s:%d", config.Host, config.Port)
	} else {
		log.Printf("GPSDO proxy disabled via config")
	}
}

// applyConfig rebuilds the inner proxy from config.
// Must be called with gp.mu held (write lock).
func (gp *GPSDOProxy) applyConfig(config *GPSDOConfig) {
	gp.enabled = config.Enabled
	if !config.Enabled {
		gp.inner = nil
		return
	}

	targetURL, err := url.Parse(fmt.Sprintf("http://%s:%d", config.Host, config.Port))
	if err != nil {
		log.Printf("GPSDO proxy: invalid target URL (host=%q port=%d): %v — proxy disabled", config.Host, config.Port, err)
		gp.enabled = false
		gp.inner = nil
		return
	}

	proxy := httputil.NewSingleHostReverseProxy(targetURL)

	// FlushInterval=-1: flush immediately after every write.
	// Required for the /events SSE endpoint so each GPS/PLL event frame is
	// forwarded to the browser as soon as the backend writes it.
	proxy.FlushInterval = -1

	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)

		// Strip client-supplied proxy headers before setting our own authoritative
		// values to prevent header injection / IP spoofing.
		req.Header.Del("X-Forwarded-For")
		req.Header.Del("X-Forwarded-Host")
		req.Header.Del("X-Forwarded-Proto")
		req.Header.Del("X-Real-IP")

		// Strip the /gpsdo prefix so the backend receives the correct paths.
		// e.g. /gpsdo/json → /json, /gpsdo/events → /events, /gpsdo/ → /
		req.URL.Path = strings.TrimPrefix(req.URL.Path, "/gpsdo")
		if req.URL.Path == "" {
			req.URL.Path = "/"
		}
		if req.URL.RawPath != "" {
			req.URL.RawPath = strings.TrimPrefix(req.URL.RawPath, "/gpsdo")
			if req.URL.RawPath == "" {
				req.URL.RawPath = "/"
			}
		}

		req.Host = targetURL.Host

		// Set authoritative forwarding headers.
		clientIP := getClientIP(req)
		req.Header.Set("X-Real-IP", clientIP)
		req.Header.Set("X-Forwarded-For", clientIP)

		if origHost := req.Header.Get("Host"); origHost != "" {
			req.Header.Set("X-Forwarded-Host", origHost)
		}
		proto := "http"
		if req.TLS != nil {
			proto = "https"
		}
		req.Header.Set("X-Forwarded-Proto", proto)

		// Tell the leobodnar C server what path prefix was stripped so it can
		// embed the correct prefix in the HTML dashboard's JS paths
		// (EventSource URL, fetch() calls for /config/* endpoints).
		req.Header.Set("X-Forwarded-Prefix", "/gpsdo")
	}

	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("GPSDO proxy error: %v", err)
		http.Error(w, "GPSDO dashboard service unavailable", http.StatusBadGateway)
	}

	gp.inner = proxy
}

// ServeHTTP forwards the request to the leobodnar container.
// Authentication is enforced by the AuthMiddleware wrapper in main.go.
func (gp *GPSDOProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	gp.mu.RLock()
	enabled := gp.enabled
	inner := gp.inner
	gp.mu.RUnlock()

	if !enabled || inner == nil {
		http.Error(w, "GPSDO proxy is disabled", http.StatusServiceUnavailable)
		return
	}
	inner.ServeHTTP(w, r)
}

package main

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"
)

// WeatherService fetches and caches weather data from the instance reporter.
// The reporter exposes an OpenWeatherMap-compatible JSON payload at:
//
//	GET {reporter}/api/weather/{private_uuid}
//
// The cached JSON is served verbatim at the local /api/weather endpoint.
// Fetching begins 1 minute after Start() is called and repeats every 15 minutes.
// HTTP 429 responses trigger exponential backoff (10 s → 120 s, max 5 retries).
type WeatherService struct {
	config *Config

	mu        sync.RWMutex
	cached    json.RawMessage // raw bytes from reporter, served verbatim
	lastFetch time.Time       // time of last successful fetch

	httpClient *http.Client
	stopChan   chan struct{}
}

// NewWeatherService creates a new WeatherService. Call Start() to begin fetching.
func NewWeatherService(config *Config) *WeatherService {
	return &WeatherService{
		config: config,
		httpClient: &http.Client{
			Timeout: 15 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{
					MinVersion: tls.VersionTLS12,
				},
			},
		},
		stopChan: make(chan struct{}),
	}
}

// Start launches the background fetch goroutine.
// It is a no-op (with a log message) when the required configuration
// (UUID, hostname, port) is not present.
func (ws *WeatherService) Start() {
	cfg := ws.config.InstanceReporting

	if cfg.InstanceUUID == "" {
		log.Println("[Weather] Not starting: instance_reporting.instance_uuid is not set")
		return
	}
	if cfg.Hostname == "" {
		log.Println("[Weather] Not starting: instance_reporting.hostname is not set")
		return
	}
	if cfg.Port == 0 {
		log.Println("[Weather] Not starting: instance_reporting.port is not set")
		return
	}

	log.Printf("[Weather] Starting weather service (first fetch in 1 minute, then every 15 minutes)")
	go ws.fetchLoop()
}

// Stop signals the fetch loop to exit.
func (ws *WeatherService) Stop() {
	close(ws.stopChan)
}

// GetCached returns the most recently cached weather JSON and the time it was
// fetched. Returns nil, zero-time when no data has been fetched yet.
func (ws *WeatherService) GetCached() (json.RawMessage, time.Time) {
	ws.mu.RLock()
	defer ws.mu.RUnlock()
	return ws.cached, ws.lastFetch
}

// reporterURL builds the URL used to fetch weather from the instance reporter.
func (ws *WeatherService) reporterURL() string {
	cfg := ws.config.InstanceReporting

	protocol := "https"
	defaultPort := 443
	if cfg.UseHTTPS == nil || !*cfg.UseHTTPS {
		protocol = "http"
		defaultPort = 80
	}

	if cfg.Port == defaultPort {
		return fmt.Sprintf("%s://%s/api/weather/%s",
			protocol, cfg.Hostname, cfg.InstanceUUID)
	}
	return fmt.Sprintf("%s://%s:%d/api/weather/%s",
		protocol, cfg.Hostname, cfg.Port, cfg.InstanceUUID)
}

// fetchLoop waits 1 minute, performs the first fetch, then repeats every 15 minutes.
func (ws *WeatherService) fetchLoop() {
	// Initial delay: 1 minute after startup.
	select {
	case <-time.After(1 * time.Minute):
	case <-ws.stopChan:
		return
	}

	ws.fetchWithBackoff()

	ticker := time.NewTicker(15 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			ws.fetchWithBackoff()
		case <-ws.stopChan:
			log.Println("[Weather] Weather service stopped")
			return
		}
	}
}

// fetchWithBackoff attempts to fetch weather data from the reporter.
// Transient errors (429, 503, network/timeout) are retried with exponential backoff:
//
//	attempt 1: wait 10 s
//	attempt 2: wait 20 s
//	attempt 3: wait 40 s
//	attempt 4: wait 80 s
//	attempt 5: wait 120 s (capped)
//
// After 5 retries it gives up until the next hourly tick.
// Permanent errors (404 — no weather data for this UUID) are logged and
// the function returns immediately without retrying.
func (ws *WeatherService) fetchWithBackoff() {
	const (
		maxRetries  = 5
		initialWait = 10 * time.Second
		maxWait     = 120 * time.Second
	)

	wait := initialWait

	for attempt := 1; attempt <= maxRetries; attempt++ {
		status, err := ws.fetch()
		if err == nil {
			// Success.
			return
		}

		// 404 is permanent — the reporter has no weather data for this UUID.
		// No point retrying within the hour.
		if status == http.StatusNotFound {
			log.Printf("[Weather] Reporter returned 404 (no weather data for this UUID); will retry next hour")
			return
		}

		// All other errors (429, 503, timeout, network) are treated as transient.
		switch status {
		case http.StatusTooManyRequests:
			log.Printf("[Weather] Reporter returned 429 (attempt %d/%d), retrying in %s",
				attempt, maxRetries, wait)
		case http.StatusServiceUnavailable:
			log.Printf("[Weather] Reporter returned 503 (attempt %d/%d), retrying in %s",
				attempt, maxRetries, wait)
		case 0:
			// Network error or timeout (no HTTP status).
			log.Printf("[Weather] Request failed (attempt %d/%d): %v, retrying in %s",
				attempt, maxRetries, err, wait)
		default:
			log.Printf("[Weather] Reporter returned %d (attempt %d/%d), retrying in %s",
				status, attempt, maxRetries, wait)
		}

		if attempt == maxRetries {
			break
		}

		select {
		case <-time.After(wait):
		case <-ws.stopChan:
			return
		}

		// Double the wait, capped at maxWait.
		wait *= 2
		if wait > maxWait {
			wait = maxWait
		}
	}

	log.Printf("[Weather] Giving up after %d retries; will retry next hour", maxRetries)
}

// fetch performs a single HTTP GET to the reporter's weather endpoint.
// Returns (httpStatusCode, error). On success the cache is updated and
// (0, nil) is returned. On failure the cache is left unchanged.
// A network error or timeout returns status 0.
func (ws *WeatherService) fetch() (int, error) {
	url := ws.reporterURL()

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return 0, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("User-Agent", fmt.Sprintf("UberSDR/%s", Version))

	resp, err := ws.httpClient.Do(req)
	if err != nil {
		// Network error or timeout — return status 0 so the caller treats it as transient.
		return 0, fmt.Errorf("request to %s failed: %w", url, err)
	}
	defer func() {
		if cerr := resp.Body.Close(); cerr != nil {
			log.Printf("[Weather] Error closing response body: %v", cerr)
		}
	}()

	if resp.StatusCode != http.StatusOK {
		return resp.StatusCode, fmt.Errorf("reporter returned status %d for %s", resp.StatusCode, url)
	}

	// Read and validate the JSON body.
	var raw json.RawMessage
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return 0, fmt.Errorf("failed to decode weather JSON from %s: %w", url, err)
	}

	// Store in cache.
	ws.mu.Lock()
	ws.cached = raw
	ws.lastFetch = time.Now()
	ws.mu.Unlock()

	log.Printf("[Weather] Weather data cached successfully from %s", url)
	return 0, nil
}

// handleWeather serves the cached weather JSON at GET /api/weather.
// Returns 404 when no data has been cached yet.
// Rate limited to 1 request per second per IP.
func handleWeather(w http.ResponseWriter, r *http.Request, ws *WeatherService, ipBanManager *IPBanManager, rateLimiter *WeatherRateLimiter) {
	// Only allow GET.
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	// Check IP ban.
	clientIP := getClientIP(r)
	if ipBanManager != nil && ipBanManager.IsBanned(clientIP) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	// Rate limit: 1 req/sec per IP.
	if !rateLimiter.Allow(clientIP) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(http.StatusTooManyRequests)
		if err := json.NewEncoder(w).Encode(map[string]string{
			"error": "Rate limit exceeded. Please wait before retrying.",
		}); err != nil {
			log.Printf("[Weather] Error encoding rate limit response: %v", err)
		}
		return
	}

	cached, _ := ws.GetCached()
	if cached == nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		if err := json.NewEncoder(w).Encode(map[string]string{
			"error": "Weather data not yet available.",
		}); err != nil {
			log.Printf("[Weather] Error encoding 404 response: %v", err)
		}
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if _, err := w.Write(cached); err != nil {
		log.Printf("[Weather] Error writing weather response: %v", err)
	}
}

// WeatherRateLimiter manages per-IP rate limiting for the /api/weather endpoint.
// Allows 1 request per second per IP using a token bucket.
type WeatherRateLimiter struct {
	limiters map[string]*RateLimiter
	mu       sync.Mutex
}

// NewWeatherRateLimiter creates a new WeatherRateLimiter.
func NewWeatherRateLimiter() *WeatherRateLimiter {
	return &WeatherRateLimiter{
		limiters: make(map[string]*RateLimiter),
	}
}

// Allow returns true if the given IP is within the rate limit (1 req/sec).
func (wrl *WeatherRateLimiter) Allow(ip string) bool {
	wrl.mu.Lock()
	rl, exists := wrl.limiters[ip]
	if !exists {
		rl = &RateLimiter{
			tokens:     1.0,
			maxTokens:  1.0,
			refillRate: 1.0, // 1 token per second
			lastRefill: time.Now(),
		}
		wrl.limiters[ip] = rl
	}
	wrl.mu.Unlock()

	return rl.Allow()
}

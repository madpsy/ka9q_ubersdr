package main

import (
	"context"
	"net/http"
	"sync"
	"time"
)

// RateLimiter implements a token bucket rate limiter
// Allows bursts up to maxTokens, refilling at refillRate tokens per second
type RateLimiter struct {
	tokens     float64
	maxTokens  float64
	refillRate float64 // tokens per second
	lastRefill time.Time
	mu         sync.Mutex
}

// NewRateLimiter creates a new rate limiter
// rate is the number of tokens per second (commands per second)
func NewRateLimiter(rate int) *RateLimiter {
	if rate <= 0 {
		// If rate is 0 or negative, create a limiter that always allows
		return &RateLimiter{
			tokens:     1,
			maxTokens:  1,
			refillRate: 0,
			lastRefill: time.Now(),
		}
	}

	return &RateLimiter{
		tokens:     float64(rate),
		maxTokens:  float64(rate),
		refillRate: float64(rate),
		lastRefill: time.Now(),
	}
}

// Allow checks if an action is allowed under the rate limit
// Returns true if allowed, false if rate limit exceeded
func (rl *RateLimiter) Allow() bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	// If refillRate is 0, always allow (unlimited)
	if rl.refillRate == 0 {
		return true
	}

	now := time.Now()
	elapsed := now.Sub(rl.lastRefill).Seconds()

	// Refill tokens based on elapsed time
	rl.tokens += elapsed * rl.refillRate
	if rl.tokens > rl.maxTokens {
		rl.tokens = rl.maxTokens
	}
	rl.lastRefill = now

	// Check if we have at least 1 token
	if rl.tokens >= 1.0 {
		rl.tokens -= 1.0
		return true
	}

	return false
}

// ChannelRateLimiters manages separate rate limiters for audio and spectrum channels per UUID
type ChannelRateLimiters struct {
	audio    *RateLimiter
	spectrum *RateLimiter
}

// RateLimiterManager manages rate limiters for all UUIDs
type RateLimiterManager struct {
	limiters map[string]*ChannelRateLimiters
	rate     int // commands per second per channel
	mu       sync.RWMutex
}

// NewRateLimiterManager creates a new rate limiter manager
func NewRateLimiterManager(rate int) *RateLimiterManager {
	return &RateLimiterManager{
		limiters: make(map[string]*ChannelRateLimiters),
		rate:     rate,
	}
}

// AllowAudio checks if an audio command is allowed for the given UUID
func (rlm *RateLimiterManager) AllowAudio(uuid string) bool {
	if rlm.rate <= 0 {
		return true // Rate limiting disabled
	}

	rlm.mu.Lock()
	limiters, exists := rlm.limiters[uuid]
	if !exists {
		limiters = &ChannelRateLimiters{
			audio:    NewRateLimiter(rlm.rate),
			spectrum: NewRateLimiter(rlm.rate),
		}
		rlm.limiters[uuid] = limiters
	}
	rlm.mu.Unlock()

	return limiters.audio.Allow()
}

// AllowSpectrum checks if a spectrum command is allowed for the given UUID
func (rlm *RateLimiterManager) AllowSpectrum(uuid string) bool {
	if rlm.rate <= 0 {
		return true // Rate limiting disabled
	}

	rlm.mu.Lock()
	limiters, exists := rlm.limiters[uuid]
	if !exists {
		limiters = &ChannelRateLimiters{
			audio:    NewRateLimiter(rlm.rate),
			spectrum: NewRateLimiter(rlm.rate),
		}
		rlm.limiters[uuid] = limiters
	}
	rlm.mu.Unlock()

	return limiters.spectrum.Allow()
}

// RemoveUUID removes rate limiters for a UUID (cleanup when user disconnects)
func (rlm *RateLimiterManager) RemoveUUID(uuid string) {
	rlm.mu.Lock()
	defer rlm.mu.Unlock()
	delete(rlm.limiters, uuid)
}

// GetStats returns the current number of tracked UUIDs
func (rlm *RateLimiterManager) GetStats() int {
	rlm.mu.RLock()
	defer rlm.mu.RUnlock()
	return len(rlm.limiters)
}

// IPConnectionRateLimiter manages rate limiters for WebSocket connections per IP address
type IPConnectionRateLimiter struct {
	limiters map[string]*RateLimiter
	rate     int // connections per second per IP
	mu       sync.RWMutex
}

// NewIPConnectionRateLimiter creates a new IP connection rate limiter
func NewIPConnectionRateLimiter(rate int) *IPConnectionRateLimiter {
	return &IPConnectionRateLimiter{
		limiters: make(map[string]*RateLimiter),
		rate:     rate,
	}
}

// AllowConnection checks if a new WebSocket connection is allowed for the given IP
func (icrl *IPConnectionRateLimiter) AllowConnection(ip string) bool {
	if icrl.rate <= 0 {
		return true // Rate limiting disabled
	}

	icrl.mu.Lock()
	limiter, exists := icrl.limiters[ip]
	if !exists {
		limiter = NewRateLimiter(icrl.rate)
		icrl.limiters[ip] = limiter
	}
	icrl.mu.Unlock()

	return limiter.Allow()
}

// Cleanup removes rate limiters for IPs that haven't been used recently
// This should be called periodically to prevent memory leaks
func (icrl *IPConnectionRateLimiter) Cleanup() {
	icrl.mu.Lock()
	defer icrl.mu.Unlock()

	now := time.Now()
	for ip, limiter := range icrl.limiters {
		limiter.mu.Lock()
		// Remove limiters that haven't been used in the last 5 minutes
		if now.Sub(limiter.lastRefill) > 5*time.Minute {
			delete(icrl.limiters, ip)
		}
		limiter.mu.Unlock()
	}
}

// GetStats returns the current number of tracked IPs
func (icrl *IPConnectionRateLimiter) GetStats() int {
	icrl.mu.RLock()
	defer icrl.mu.RUnlock()
	return len(icrl.limiters)
}

// AggregateRateLimiter manages rate limiters for aggregate endpoint requests per IP
// Limits to 2 requests per second per IP
type AggregateRateLimiter struct {
	limiters map[string]*RateLimiter
	mu       sync.RWMutex
}

// NewAggregateRateLimiter creates a new aggregate endpoint rate limiter
// Fixed at 2 requests per second
func NewAggregateRateLimiter() *AggregateRateLimiter {
	return &AggregateRateLimiter{
		limiters: make(map[string]*RateLimiter),
	}
}

// AllowRequest checks if an aggregate request is allowed for the given IP
// Returns true if allowed, false if rate limit exceeded
func (arl *AggregateRateLimiter) AllowRequest(ip string) bool {
	arl.mu.Lock()
	limiter, exists := arl.limiters[ip]
	if !exists {
		// Create a rate limiter with 2 tokens max, refilling at 2 tokens/sec (2 per second)
		limiter = &RateLimiter{
			tokens:     2.0,
			maxTokens:  2.0,
			refillRate: 2.0, // 2 requests per second
			lastRefill: time.Now(),
		}
		arl.limiters[ip] = limiter
	}
	arl.mu.Unlock()

	return limiter.Allow()
}

// FFTRateLimiter manages rate limiters for FFT endpoint requests per IP per band
// Limits to 1 request per 2 seconds per band per IP
type FFTRateLimiter struct {
	limiters map[string]map[string]*RateLimiter // map[ip]map[band]*RateLimiter
	mu       sync.RWMutex
}

// NewFFTRateLimiter creates a new FFT endpoint rate limiter
// Fixed at 1 request per 2 seconds per band (0.5 requests per second)
func NewFFTRateLimiter() *FFTRateLimiter {
	return &FFTRateLimiter{
		limiters: make(map[string]map[string]*RateLimiter),
	}
}

// AllowRequest checks if an FFT request is allowed for the given IP and band
// Returns true if allowed, false if rate limit exceeded
func (frl *FFTRateLimiter) AllowRequest(ip, band string) bool {
	frl.mu.Lock()
	ipLimiters, exists := frl.limiters[ip]
	if !exists {
		ipLimiters = make(map[string]*RateLimiter)
		frl.limiters[ip] = ipLimiters
	}

	bandLimiter, exists := ipLimiters[band]
	if !exists {
		// Determine rate based on band/endpoint
		var refillRate float64
		var maxTokens float64
		switch band {
		case "voice-activity":
			refillRate = 4.0 // 4 requests per second for voice activity
			maxTokens = 4.0
		case "noise-analysis":
			refillRate = 2.0 // 2 requests per second for noise analysis
			maxTokens = 2.0
		case "spectrogram", "spectrogram-palette", "spectrogram-latest":
			refillRate = 1.0 // 1 request per second for spectrogram PNG / re-renders / latest redirect
			maxTokens = 1.0
		case "spectrogram-meta":
			refillRate = 5.0 // 5 requests per second for metadata (JSON only, no PNG)
			maxTokens = 5.0
		case "spectrogram-timeslice":
			refillRate = 10.0 // 10 requests per second for time-slice JSON (lightweight)
			maxTokens = 10.0
		case "spectrogram-rowspectrum":
			refillRate = 2.0 // 2 requests per second for row spectrum JSON (lightweight)
			maxTokens = 2.0
		case "spectrogram-allrows":
			refillRate = 0.5 // 1 request per 2 seconds — preloaded on page load for tooltip data
			maxTokens = 2.0
		default:
			refillRate = 0.5 // 1 request per 2 seconds for FFT data
			maxTokens = 1.0
		}

		bandLimiter = &RateLimiter{
			tokens:     maxTokens,
			maxTokens:  maxTokens,
			refillRate: refillRate,
			lastRefill: time.Now(),
		}
		ipLimiters[band] = bandLimiter
	}
	frl.mu.Unlock()

	return bandLimiter.Allow()
}

// Cleanup removes rate limiters for IPs that haven't been used recently
func (frl *FFTRateLimiter) Cleanup() {
	frl.mu.Lock()
	defer frl.mu.Unlock()

	now := time.Now()
	for ip, ipLimiters := range frl.limiters {
		for band, limiter := range ipLimiters {
			limiter.mu.Lock()
			// Remove limiters that haven't been used in the last 15 minutes
			if now.Sub(limiter.lastRefill) > 15*time.Minute {
				delete(ipLimiters, band)
			}
			limiter.mu.Unlock()
		}
		// Remove IP entry if no bands left
		if len(ipLimiters) == 0 {
			delete(frl.limiters, ip)
		}
	}
}

// GetStats returns the current number of tracked IPs and total band limiters
func (frl *FFTRateLimiter) GetStats() (int, int) {
	frl.mu.RLock()
	defer frl.mu.RUnlock()

	totalBands := 0
	for _, ipLimiters := range frl.limiters {
		totalBands += len(ipLimiters)
	}
	return len(frl.limiters), totalBands
}

// Cleanup removes rate limiters for IPs that haven't been used recently
func (arl *AggregateRateLimiter) Cleanup() {
	arl.mu.Lock()
	defer arl.mu.Unlock()

	now := time.Now()
	for ip, limiter := range arl.limiters {
		limiter.mu.Lock()
		// Remove limiters that haven't been used in the last 10 minutes
		if now.Sub(limiter.lastRefill) > 10*time.Minute {
			delete(arl.limiters, ip)
		}
		limiter.mu.Unlock()
	}
}

// GetStats returns the current number of tracked IPs
func (arl *AggregateRateLimiter) GetStats() int {
	arl.mu.RLock()
	defer arl.mu.RUnlock()
	return len(arl.limiters)
}

// SpaceWeatherRateLimiter manages rate limiters for space weather endpoint requests per IP
// Different endpoints have different rate limits:
// - Current data: 1 request per second (1.0 requests/sec)
// - History/Dates/CSV: 1 request per 2.5 seconds (0.4 requests/sec)
type SpaceWeatherRateLimiter struct {
	limiters map[string]map[string]*RateLimiter // map[ip]map[endpoint]*RateLimiter
	mu       sync.RWMutex
}

// NewSpaceWeatherRateLimiter creates a new space weather endpoint rate limiter
func NewSpaceWeatherRateLimiter() *SpaceWeatherRateLimiter {
	return &SpaceWeatherRateLimiter{
		limiters: make(map[string]map[string]*RateLimiter),
	}
}

// AllowRequest checks if a space weather request is allowed for the given IP and endpoint
// endpoint should be "current", "history", "dates", or "csv"
// Returns true if allowed, false if rate limit exceeded
func (swrl *SpaceWeatherRateLimiter) AllowRequest(ip, endpoint string) bool {
	swrl.mu.Lock()
	ipLimiters, exists := swrl.limiters[ip]
	if !exists {
		ipLimiters = make(map[string]*RateLimiter)
		swrl.limiters[ip] = ipLimiters
	}

	endpointLimiter, exists := ipLimiters[endpoint]
	if !exists {
		// Determine rate based on endpoint
		var refillRate float64
		if endpoint == "current" {
			refillRate = 1.0 // 1 request per second
		} else {
			refillRate = 0.4 // 1 request per 2.5 seconds
		}

		endpointLimiter = &RateLimiter{
			tokens:     1.0,
			maxTokens:  1.0,
			refillRate: refillRate,
			lastRefill: time.Now(),
		}
		ipLimiters[endpoint] = endpointLimiter
	}
	swrl.mu.Unlock()

	return endpointLimiter.Allow()
}

// Cleanup removes rate limiters for IPs that haven't been used recently
func (swrl *SpaceWeatherRateLimiter) Cleanup() {
	swrl.mu.Lock()
	defer swrl.mu.Unlock()

	now := time.Now()
	for ip, ipLimiters := range swrl.limiters {
		for endpoint, limiter := range ipLimiters {
			limiter.mu.Lock()
			// Remove limiters that haven't been used in the last 10 minutes
			if now.Sub(limiter.lastRefill) > 10*time.Minute {
				delete(ipLimiters, endpoint)
			}
			limiter.mu.Unlock()
		}
		// Remove IP entry if no endpoints left
		if len(ipLimiters) == 0 {
			delete(swrl.limiters, ip)
		}
	}
}

// GetStats returns the current number of tracked IPs and total endpoint limiters
func (swrl *SpaceWeatherRateLimiter) GetStats() (int, int) {
	swrl.mu.RLock()
	defer swrl.mu.RUnlock()

	totalEndpoints := 0
	for _, ipLimiters := range swrl.limiters {
		totalEndpoints += len(ipLimiters)
	}
	return len(swrl.limiters), totalEndpoints
}

// SummaryRateLimiter manages rate limiters for metrics summary endpoint requests per IP
// Limits to 10 requests per second per IP
type SummaryRateLimiter struct {
	limiters map[string]*RateLimiter
	mu       sync.RWMutex
}

// NewSummaryRateLimiter creates a new summary endpoint rate limiter
// Fixed at 10 requests per second
func NewSummaryRateLimiter() *SummaryRateLimiter {
	return &SummaryRateLimiter{
		limiters: make(map[string]*RateLimiter),
	}
}

// AllowRequest checks if a summary request is allowed for the given IP
// Returns true if allowed, false if rate limit exceeded
func (srl *SummaryRateLimiter) AllowRequest(ip string) bool {
	srl.mu.Lock()
	limiter, exists := srl.limiters[ip]
	if !exists {
		// Create a rate limiter with 10 tokens max, refilling at 10 tokens/sec
		limiter = &RateLimiter{
			tokens:     10.0,
			maxTokens:  10.0,
			refillRate: 10.0, // 10 requests per second
			lastRefill: time.Now(),
		}
		srl.limiters[ip] = limiter
	}
	srl.mu.Unlock()

	return limiter.Allow()
}

// Cleanup removes rate limiters for IPs that haven't been used recently
func (srl *SummaryRateLimiter) Cleanup() {
	srl.mu.Lock()
	defer srl.mu.Unlock()

	now := time.Now()
	for ip, limiter := range srl.limiters {
		limiter.mu.Lock()
		// Remove limiters that haven't been used in the last 10 minutes
		if now.Sub(limiter.lastRefill) > 10*time.Minute {
			delete(srl.limiters, ip)
		}
		limiter.mu.Unlock()
	}
}

// GetStats returns the current number of tracked IPs
func (srl *SummaryRateLimiter) GetStats() int {
	srl.mu.RLock()
	defer srl.mu.RUnlock()
	return len(srl.limiters)
}

// ConnectionRateLimiter manages rate limiters for /connection endpoint requests per IP
// Limits to configurable requests per minute per IP (default 10 per 60 seconds)
type ConnectionRateLimiter struct {
	limiters map[string]*RateLimiter
	rate     int // requests per minute per IP
	mu       sync.RWMutex
}

// NewConnectionRateLimiter creates a new connection endpoint rate limiter
// rate is the number of requests per minute (e.g., 10 = 10 requests per 60 seconds)
func NewConnectionRateLimiter(rate int) *ConnectionRateLimiter {
	return &ConnectionRateLimiter{
		limiters: make(map[string]*RateLimiter),
		rate:     rate,
	}
}

// AllowRequest checks if a /connection request is allowed for the given IP
// Returns true if allowed, false if rate limit exceeded
func (crl *ConnectionRateLimiter) AllowRequest(ip string) bool {
	if crl.rate <= 0 {
		return true // Rate limiting disabled
	}

	crl.mu.Lock()
	limiter, exists := crl.limiters[ip]
	if !exists {
		// Create a rate limiter with rate tokens max, refilling at rate/60 tokens/sec
		// For example: 10 requests per minute = 10 tokens max, 0.1667 tokens/sec refill rate
		refillRate := float64(crl.rate) / 60.0
		limiter = &RateLimiter{
			tokens:     float64(crl.rate),
			maxTokens:  float64(crl.rate),
			refillRate: refillRate,
			lastRefill: time.Now(),
		}
		crl.limiters[ip] = limiter
	}
	crl.mu.Unlock()

	return limiter.Allow()
}

// Cleanup removes rate limiters for IPs that haven't been used recently
func (crl *ConnectionRateLimiter) Cleanup() {
	crl.mu.Lock()
	defer crl.mu.Unlock()

	now := time.Now()
	for ip, limiter := range crl.limiters {
		limiter.mu.Lock()
		// Remove limiters that haven't been used in the last 10 minutes
		if now.Sub(limiter.lastRefill) > 10*time.Minute {
			delete(crl.limiters, ip)
		}
		limiter.mu.Unlock()
	}
}

// GetStats returns the current number of tracked IPs
func (crl *ConnectionRateLimiter) GetStats() int {
	crl.mu.RLock()
	defer crl.mu.RUnlock()
	return len(crl.limiters)
}

// SessionCreateRateLimiter throttles how often new radio sessions may be created.
// It is keyed by user_session_id UUID, falling back to the client IP when no UUID
// is supplied, and catches reconnect loops that the per-second connection limiter
// is too coarse to see (e.g. a client that reconnects every few seconds forever,
// tearing down and re-creating a radiod channel each time).
//
// Audio and spectrum creations draw from separate buckets: a normal page load
// creates one of each, so a shared bucket would halve the reconnect budget a
// legitimate user gets.
//
// The underlying token bucket refills continuously, which gives sliding-window
// behaviour — there is no fixed minute boundary to game — with the burst as the
// bucket capacity.
type SessionCreateRateLimiter struct {
	limiters      map[string]*sessionCreateEntry
	mu            sync.Mutex
	ratePerMinute float64
	burst         float64
}

// sessionCreateEntry pairs a token bucket with violation bookkeeping, so a client
// hammering the server cannot flood the log with one line per rejected attempt.
type sessionCreateEntry struct {
	limiter    *RateLimiter
	violations int
	lastLogged time.Time
}

// NewSessionCreateRateLimiter creates a session creation rate limiter allowing
// ratePerMinute new sessions per minute per user, with up to burst back-to-back
// creations. A ratePerMinute of 0 or less disables the limiter (always allows).
func NewSessionCreateRateLimiter(ratePerMinute, burst int) *SessionCreateRateLimiter {
	if burst < 1 {
		burst = 1
	}
	return &SessionCreateRateLimiter{
		limiters:      make(map[string]*sessionCreateEntry),
		ratePerMinute: float64(ratePerMinute),
		burst:         float64(burst),
	}
}

// Allow reports whether a session of the given kind ("audio" or "spectrum") may be
// created for uuid, or for clientIP when uuid is empty.
//
// shouldLog is true the first time a key is rejected and at most once a minute
// after that, so callers can log rejections without handing an abusive client a
// log-flooding primitive. violations is the running rejection count for that key.
func (scrl *SessionCreateRateLimiter) Allow(kind, uuid, clientIP string) (allowed bool, shouldLog bool, violations int) {
	if scrl == nil || scrl.ratePerMinute <= 0 {
		return true, false, 0
	}

	key := kind + "|" + uuid
	if uuid == "" {
		key = kind + "|ip:" + clientIP
	}

	scrl.mu.Lock()
	defer scrl.mu.Unlock()

	entry, exists := scrl.limiters[key]
	if !exists {
		entry = &sessionCreateEntry{
			limiter: &RateLimiter{
				tokens:     scrl.burst,
				maxTokens:  scrl.burst,
				refillRate: scrl.ratePerMinute / 60.0, // convert per-minute to per-second
				lastRefill: time.Now(),
			},
		}
		scrl.limiters[key] = entry
	}

	if entry.limiter.Allow() {
		return true, false, entry.violations
	}

	entry.violations++
	now := time.Now()
	if entry.violations == 1 || now.Sub(entry.lastLogged) >= time.Minute {
		entry.lastLogged = now
		return false, true, entry.violations
	}
	return false, false, entry.violations
}

// Cleanup removes buckets that have not been used in the last 10 minutes.
func (scrl *SessionCreateRateLimiter) Cleanup() {
	if scrl == nil {
		return
	}

	scrl.mu.Lock()
	defer scrl.mu.Unlock()

	now := time.Now()
	for key, entry := range scrl.limiters {
		entry.limiter.mu.Lock()
		if now.Sub(entry.limiter.lastRefill) > 10*time.Minute {
			delete(scrl.limiters, key)
		}
		entry.limiter.mu.Unlock()
	}
}

// GetStats returns the current number of tracked buckets.
func (scrl *SessionCreateRateLimiter) GetStats() int {
	if scrl == nil {
		return 0
	}

	scrl.mu.Lock()
	defer scrl.mu.Unlock()
	return len(scrl.limiters)
}

// RotctlRateLimiter manages rate limiters for rotctl endpoint requests per IP
// Different endpoints have different rate limits:
// - Status endpoint: 5 requests per second
// - Command/Position endpoints: 1 request per second
type RotctlRateLimiter struct {
	limiters map[string]map[string]*RateLimiter // map[ip]map[endpoint]*RateLimiter
	mu       sync.RWMutex
}

// NewRotctlRateLimiter creates a new rotctl endpoint rate limiter
func NewRotctlRateLimiter() *RotctlRateLimiter {
	return &RotctlRateLimiter{
		limiters: make(map[string]map[string]*RateLimiter),
	}
}

// AllowRequest checks if a rotctl request is allowed for the given IP and endpoint
// endpoint should be "status", "command", or "position"
// Returns true if allowed, false if rate limit exceeded
func (rrl *RotctlRateLimiter) AllowRequest(ip, endpoint string) bool {
	rrl.mu.Lock()
	ipLimiters, exists := rrl.limiters[ip]
	if !exists {
		ipLimiters = make(map[string]*RateLimiter)
		rrl.limiters[ip] = ipLimiters
	}

	endpointLimiter, exists := ipLimiters[endpoint]
	if !exists {
		// Determine rate based on endpoint
		var refillRate float64
		var maxTokens float64
		if endpoint == "status" {
			refillRate = 5.0 // 5 requests per second
			maxTokens = 5.0
		} else {
			refillRate = 1.0 // 1 request per second
			maxTokens = 1.0
		}

		endpointLimiter = &RateLimiter{
			tokens:     maxTokens,
			maxTokens:  maxTokens,
			refillRate: refillRate,
			lastRefill: time.Now(),
		}
		ipLimiters[endpoint] = endpointLimiter
	}
	rrl.mu.Unlock()

	return endpointLimiter.Allow()
}

// Cleanup removes rate limiters for IPs that haven't been used recently
func (rrl *RotctlRateLimiter) Cleanup() {
	rrl.mu.Lock()
	defer rrl.mu.Unlock()

	now := time.Now()
	for ip, ipLimiters := range rrl.limiters {
		for endpoint, limiter := range ipLimiters {
			limiter.mu.Lock()
			// Remove limiters that haven't been used in the last 10 minutes
			if now.Sub(limiter.lastRefill) > 10*time.Minute {
				delete(ipLimiters, endpoint)
			}
			limiter.mu.Unlock()
		}
		// Remove IP entry if no endpoints left
		if len(ipLimiters) == 0 {
			delete(rrl.limiters, ip)
		}
	}
}

// GetStats returns the current number of tracked IPs and total endpoint limiters
func (rrl *RotctlRateLimiter) GetStats() (int, int) {
	rrl.mu.RLock()
	defer rrl.mu.RUnlock()

	totalEndpoints := 0
	for _, ipLimiters := range rrl.limiters {
		totalEndpoints += len(ipLimiters)
	}
	return len(rrl.limiters), totalEndpoints
}

// RMNoiseRateLimiter manages rate limiters for the RMNoise proxy endpoint per IP.
// Limits to 1 request per second per IP.
type RMNoiseRateLimiter struct {
	limiters map[string]map[string]*RateLimiter // map[ip]map[endpoint]*RateLimiter
	mu       sync.RWMutex
}

// NewRMNoiseRateLimiter creates a new RMNoise proxy rate limiter.
// Fixed at 1 request per second per endpoint per IP.
func NewRMNoiseRateLimiter() *RMNoiseRateLimiter {
	return &RMNoiseRateLimiter{
		limiters: make(map[string]map[string]*RateLimiter),
	}
}

// AllowRequest checks if an RMNoise proxy request is allowed for the given IP and endpoint.
// endpoint should be "login", "webrtc_token", or "turn_creds".
// Returns true if allowed, false if rate limit exceeded.
func (rnrl *RMNoiseRateLimiter) AllowRequest(ip, endpoint string) bool {
	rnrl.mu.Lock()
	ipLimiters, exists := rnrl.limiters[ip]
	if !exists {
		ipLimiters = make(map[string]*RateLimiter)
		rnrl.limiters[ip] = ipLimiters
	}

	endpointLimiter, exists := ipLimiters[endpoint]
	if !exists {
		// 1 request per second, burst of 1
		endpointLimiter = &RateLimiter{
			tokens:     1.0,
			maxTokens:  1.0,
			refillRate: 1.0, // 1 request per second
			lastRefill: time.Now(),
		}
		ipLimiters[endpoint] = endpointLimiter
	}
	rnrl.mu.Unlock()

	return endpointLimiter.Allow()
}

// Cleanup removes rate limiters for IPs that haven't been used recently.
func (rnrl *RMNoiseRateLimiter) Cleanup() {
	rnrl.mu.Lock()
	defer rnrl.mu.Unlock()

	now := time.Now()
	for ip, ipLimiters := range rnrl.limiters {
		for endpoint, limiter := range ipLimiters {
			limiter.mu.Lock()
			// Remove limiters that haven't been used in the last 10 minutes
			if now.Sub(limiter.lastRefill) > 10*time.Minute {
				delete(ipLimiters, endpoint)
			}
			limiter.mu.Unlock()
		}
		// Remove IP entry if no endpoints left
		if len(ipLimiters) == 0 {
			delete(rnrl.limiters, ip)
		}
	}
}

// GetStats returns the current number of tracked IPs and total endpoint limiters.
func (rnrl *RMNoiseRateLimiter) GetStats() (int, int) {
	rnrl.mu.RLock()
	defer rnrl.mu.RUnlock()

	totalEndpoints := 0
	for _, ipLimiters := range rnrl.limiters {
		totalEndpoints += len(ipLimiters)
	}
	return len(rnrl.limiters), totalEndpoints
}

// SSHProxyRateLimiter manages rate limiters for SSH proxy requests per IP
// Limits to 100 requests per minute per IP
type SSHProxyRateLimiter struct {
	limiters map[string]*RateLimiter
	mu       sync.RWMutex
}

// NewSSHProxyRateLimiter creates a new SSH proxy rate limiter
// Fixed at 100 requests per minute (1.667 requests per second)
func NewSSHProxyRateLimiter() *SSHProxyRateLimiter {
	return &SSHProxyRateLimiter{
		limiters: make(map[string]*RateLimiter),
	}
}

// AllowRequest checks if an SSH proxy request is allowed for the given IP
// Returns true if allowed, false if rate limit exceeded
func (sprl *SSHProxyRateLimiter) AllowRequest(ip string) bool {
	sprl.mu.Lock()
	limiter, exists := sprl.limiters[ip]
	if !exists {
		// Create a rate limiter with 100 tokens max, refilling at 100/60 tokens/sec
		// 100 requests per minute = 100 tokens max, 1.667 tokens/sec refill rate
		limiter = &RateLimiter{
			tokens:     100.0,
			maxTokens:  100.0,
			refillRate: 100.0 / 60.0, // 100 requests per minute
			lastRefill: time.Now(),
		}
		sprl.limiters[ip] = limiter
	}
	sprl.mu.Unlock()

	return limiter.Allow()
}

// Cleanup removes rate limiters for IPs that haven't been used recently
func (sprl *SSHProxyRateLimiter) Cleanup() {
	sprl.mu.Lock()
	defer sprl.mu.Unlock()

	now := time.Now()
	for ip, limiter := range sprl.limiters {
		limiter.mu.Lock()
		// Remove limiters that haven't been used in the last 10 minutes
		if now.Sub(limiter.lastRefill) > 10*time.Minute {
			delete(sprl.limiters, ip)
		}
		limiter.mu.Unlock()
	}
}

// GetStats returns the current number of tracked IPs
func (sprl *SSHProxyRateLimiter) GetStats() int {
	sprl.mu.RLock()
	defer sprl.mu.RUnlock()
	return len(sprl.limiters)
}

// SessionStatsRateLimiter manages rate limiters for session stats endpoint requests per IP
// Limits to 1 request per 3 seconds per IP
type SessionStatsRateLimiter struct {
	limiters map[string]*RateLimiter
	mu       sync.RWMutex
}

// NewSessionStatsRateLimiter creates a new session stats endpoint rate limiter
// Fixed at 1 request per 3 seconds (0.333 requests per second)
func NewSessionStatsRateLimiter() *SessionStatsRateLimiter {
	return &SessionStatsRateLimiter{
		limiters: make(map[string]*RateLimiter),
	}
}

// AllowRequest checks if a session stats request is allowed for the given IP
// Returns true if allowed, false if rate limit exceeded
func (ssrl *SessionStatsRateLimiter) AllowRequest(ip string) bool {
	ssrl.mu.Lock()
	limiter, exists := ssrl.limiters[ip]
	if !exists {
		// Create a rate limiter with 1 token max, refilling at 0.333 tokens/sec (1 per 3 seconds)
		limiter = &RateLimiter{
			tokens:     1.0,
			maxTokens:  1.0,
			refillRate: 1.0 / 3.0, // 1 request per 3 seconds
			lastRefill: time.Now(),
		}
		ssrl.limiters[ip] = limiter
	}
	ssrl.mu.Unlock()

	return limiter.Allow()
}

// AddonProxyRateLimiter manages per-IP rate limiters for addon proxy requests.
// The limit is configurable per proxy instance (rate_limit field in addons.yaml).
type AddonProxyRateLimiter struct {
	limiters      map[string]*RateLimiter
	mu            sync.RWMutex
	ratePerMinute float64 // tokens per minute
}

// NewAddonProxyRateLimiter creates a new addon proxy rate limiter with the given
// requests-per-minute limit. ratePerMinute must be > 0.
func NewAddonProxyRateLimiter(ratePerMinute int) *AddonProxyRateLimiter {
	return &AddonProxyRateLimiter{
		limiters:      make(map[string]*RateLimiter),
		ratePerMinute: float64(ratePerMinute),
	}
}

// AllowRequest checks if a request from the given IP is within the rate limit.
// Returns true if allowed, false if the limit has been exceeded.
func (rl *AddonProxyRateLimiter) AllowRequest(ip string) bool {
	rl.mu.Lock()
	limiter, exists := rl.limiters[ip]
	if !exists {
		rpm := rl.ratePerMinute
		limiter = &RateLimiter{
			tokens:     rpm,
			maxTokens:  rpm,
			refillRate: rpm / 60.0,
			lastRefill: time.Now(),
		}
		rl.limiters[ip] = limiter
	}
	rl.mu.Unlock()

	return limiter.Allow()
}

// Cleanup removes stale per-IP limiters that have not been used in the last 10 minutes.
func (rl *AddonProxyRateLimiter) Cleanup() {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	for ip, limiter := range rl.limiters {
		limiter.mu.Lock()
		if now.Sub(limiter.lastRefill) > 10*time.Minute {
			delete(rl.limiters, ip)
		}
		limiter.mu.Unlock()
	}
}

// GetStats returns the number of currently tracked IP addresses.
func (rl *AddonProxyRateLimiter) GetStats() int {
	rl.mu.RLock()
	defer rl.mu.RUnlock()
	return len(rl.limiters)
}

// Cleanup removes rate limiters for IPs that haven't been used recently
func (ssrl *SessionStatsRateLimiter) Cleanup() {
	ssrl.mu.Lock()
	defer ssrl.mu.Unlock()

	now := time.Now()
	for ip, limiter := range ssrl.limiters {
		limiter.mu.Lock()
		// Remove limiters that haven't been used in the last 10 minutes
		if now.Sub(limiter.lastRefill) > 10*time.Minute {
			delete(ssrl.limiters, ip)
		}
		limiter.mu.Unlock()
	}
}

// GetStats returns the current number of tracked IPs
func (ssrl *SessionStatsRateLimiter) GetStats() int {
	ssrl.mu.RLock()
	defer ssrl.mu.RUnlock()
	return len(ssrl.limiters)
}

// LookupRateLimiter manages per-UUID rate limiters for the /api/lookup endpoint.
// The limit is configurable (rate_limit_per_minute in lookup_services config).
// Keyed by session UUID rather than IP so each user gets their own bucket.
type LookupRateLimiter struct {
	limiters      map[string]*RateLimiter
	mu            sync.RWMutex
	ratePerMinute float64 // tokens per minute (converted to tokens/sec internally)
}

// NewLookupRateLimiter creates a new lookup rate limiter.
// ratePerMinute is the number of requests allowed per UUID per minute.
// Pass 0 to disable rate limiting (always allow).
func NewLookupRateLimiter(ratePerMinute int) *LookupRateLimiter {
	return &LookupRateLimiter{
		limiters:      make(map[string]*RateLimiter),
		ratePerMinute: float64(ratePerMinute),
	}
}

// AllowRequest returns true if the given UUID is allowed to make a lookup request.
// Returns true unconditionally when ratePerMinute is 0 (disabled).
func (lrl *LookupRateLimiter) AllowRequest(uuid string) bool {
	if lrl.ratePerMinute <= 0 {
		return true
	}

	lrl.mu.Lock()
	defer lrl.mu.Unlock()

	limiter, exists := lrl.limiters[uuid]
	if !exists {
		rpm := lrl.ratePerMinute
		refillRate := rpm / 60.0 // convert per-minute to per-second
		limiter = &RateLimiter{
			tokens:     rpm, // start with a full bucket
			maxTokens:  rpm,
			refillRate: refillRate,
			lastRefill: time.Now(),
		}
		lrl.limiters[uuid] = limiter
	}
	return limiter.Allow()
}

// AllowCachedRequest is like AllowRequest but applies a 10× higher effective
// rate limit.  It should be called when the requested callsign is already
// present in the local cache, because no outbound API call will be made and
// the cost of serving the request is negligible.
//
// Internally it draws from a separate per-UUID bucket (keyed as uuid+"__cached")
// whose capacity and refill rate are both 10× the base rate.
func (lrl *LookupRateLimiter) AllowCachedRequest(uuid string) bool {
	if lrl.ratePerMinute <= 0 {
		return true
	}

	key := uuid + "__cached"
	lrl.mu.Lock()
	defer lrl.mu.Unlock()

	limiter, exists := lrl.limiters[key]
	if !exists {
		rpm := lrl.ratePerMinute * 10
		refillRate := rpm / 60.0
		limiter = &RateLimiter{
			tokens:     rpm,
			maxTokens:  rpm,
			refillRate: refillRate,
			lastRefill: time.Now(),
		}
		lrl.limiters[key] = limiter
	}
	return limiter.Allow()
}

// Cleanup removes stale per-UUID limiters that have not been used in the last 10 minutes.
// Should be called periodically (e.g. from the main cleanup ticker).
func (lrl *LookupRateLimiter) Cleanup() {
	lrl.mu.Lock()
	defer lrl.mu.Unlock()

	now := time.Now()
	for uuid, limiter := range lrl.limiters {
		limiter.mu.Lock()
		if now.Sub(limiter.lastRefill) > 10*time.Minute {
			delete(lrl.limiters, uuid)
		}
		limiter.mu.Unlock()
	}
}

// GetStats returns the number of currently tracked UUIDs.
func (lrl *LookupRateLimiter) GetStats() int {
	lrl.mu.RLock()
	defer lrl.mu.RUnlock()
	return len(lrl.limiters)
}

// ImageProxyRateLimiter manages per-IP rate limiters for the /api/lookup/image
// endpoint.  Fixed at 3 requests per second per IP with a burst of 3.
// Images are cached by the browser for 24 h so legitimate clients only hit
// this endpoint once per callsign per session; 3 req/s is generous.
type ImageProxyRateLimiter struct {
	limiters map[string]*RateLimiter
	mu       sync.RWMutex
}

// NewImageProxyRateLimiter creates a new image proxy rate limiter.
func NewImageProxyRateLimiter() *ImageProxyRateLimiter {
	return &ImageProxyRateLimiter{
		limiters: make(map[string]*RateLimiter),
	}
}

// Allow returns true if the given IP is within the rate limit.
func (rl *ImageProxyRateLimiter) Allow(ip string) bool {
	rl.mu.Lock()
	limiter, exists := rl.limiters[ip]
	if !exists {
		limiter = &RateLimiter{
			tokens:     3.0,
			maxTokens:  3.0,
			refillRate: 3.0, // 3 requests per second
			lastRefill: time.Now(),
		}
		rl.limiters[ip] = limiter
	}
	rl.mu.Unlock()
	return limiter.Allow()
}

// Cleanup removes per-IP limiters that have not been used in the last 5 minutes.
func (rl *ImageProxyRateLimiter) Cleanup() {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	for ip, limiter := range rl.limiters {
		limiter.mu.Lock()
		if now.Sub(limiter.lastRefill) > 5*time.Minute {
			delete(rl.limiters, ip)
		}
		limiter.mu.Unlock()
	}
}

// GetStats returns the number of currently tracked IPs.
func (rl *ImageProxyRateLimiter) GetStats() int {
	rl.mu.RLock()
	defer rl.mu.RUnlock()
	return len(rl.limiters)
}

// defaultSSEMaxConnsPerIP is the cap every public SSE feed is created with.
//
// Three rather than two because a browser reconnecting legitimately holds two
// slots for a moment — see Acquire — and a client with a page open plus a
// reconnect in flight should not be at the limit.
const defaultSSEMaxConnsPerIP = 3

// SSEIPLimiter tracks the number of *concurrent* SSE connections per IP address.
// Unlike token-bucket limiters, this counts live connections rather than request rate.
// Each call to Acquire reserves a slot; the returned release func frees it.
// If the IP is already at maxConns, its oldest connection is displaced (or, for
// callers that opt out of displacement, Acquire returns (nil, false)).
type SSEIPLimiter struct {
	mu       sync.Mutex
	conns    map[string][]*sseSlot // per IP, oldest first
	maxConns int
}

// sseSlot is one live connection. evict makes its handler return; it is nil for
// callers that opted out of displacement.
type sseSlot struct {
	evict func()
}

// NewSSEIPLimiter creates a limiter that allows at most maxConns simultaneous
// SSE connections from the same IP address.
func NewSSEIPLimiter(maxConns int) *SSEIPLimiter {
	return &SSEIPLimiter{
		conns:    make(map[string][]*sseSlot),
		maxConns: maxConns,
	}
}

// Acquire attempts to reserve a connection slot for ip.
// On success it returns a release function and true.
// The release function is idempotent — it is safe to call multiple times
// (e.g. from both a goroutine watching the request context and a defer
// statement); the slot is freed exactly once regardless of how many times it is
// called. On failure it returns nil, false.
//
// evict is called when this connection is displaced by a newer one from the same
// IP, and must make its handler return — cancelling the context the stream loop
// selects on. Passing nil opts out: the connection can never be displaced, and a
// full IP is rejected instead.
//
// Displacement rather than rejection is what makes a reconnect work. A client
// that reopens a stream — a band toggle, a staleness watchdog, a tab waking up —
// opens the new one before the server has learned the old one is gone, and the
// news has to travel the whole way back through Caddy and the tunnel, which
// takes seconds. Rejecting there answers "too many connections from your IP" to
// a client that believes it has none, and its backoff then makes the next
// attempt race the same stale slot. Only ever the same IP's own oldest
// connection is displaced.
func (l *SSEIPLimiter) Acquire(ip string, evict func()) (release func(), ok bool) {
	l.mu.Lock()

	slots := l.conns[ip]
	var displaced *sseSlot
	if len(slots) >= l.maxConns {
		// Nothing to displace (maxConns == 0), the caller opted out, or the
		// oldest connection did — reject.
		if len(slots) == 0 || evict == nil || slots[0].evict == nil {
			l.mu.Unlock()
			return nil, false
		}
		displaced = slots[0]
		slots = slots[1:]
	}

	// Copy rather than append in place: slots may alias the array the displaced
	// entry still sits in.
	slot := &sseSlot{evict: evict}
	next := make([]*sseSlot, len(slots), len(slots)+1)
	copy(next, slots)
	l.conns[ip] = append(next, slot)

	l.mu.Unlock()

	// Outside the lock: the evicted handler frees its own slot, which takes it.
	// (The displaced entry is already out of the accounting, so its release is a
	// no-op and the count never exceeds maxConns while that handler unwinds.)
	if displaced != nil {
		displaced.evict()
	}

	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			cur := l.conns[ip]
			for i, s := range cur {
				if s == slot {
					cur = append(cur[:i], cur[i+1:]...)
					break
				}
			}
			if len(cur) == 0 {
				delete(l.conns, ip)
			} else {
				l.conns[ip] = cur
			}
		})
	}, true
}

// Count returns the current number of active connections from ip.
func (l *SSEIPLimiter) Count(ip string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.conns[ip])
}

// acquireSSEConn is the admission check every public SSE feed opens with:
// resolve the client, take a connection slot, and hand back the context the
// stream loop must select on.
//
// That context is the request's, cancelled additionally when a newer connection
// from the same IP displaces this one — so the loop has to use it rather than
// r.Context(), or a displaced stream would keep running with its slot already
// given away.
//
// On refusal it has already written 429 to w, and the handler should just
// return. Otherwise the returned func must be deferred: it frees the slot.
//
// Four feeds had their own copy of this, each resolving the IP straight from
// X-Forwarded-For without checking who sent it, which let any client choose the
// identity it was counted as.
func acquireSSEConn(
	w http.ResponseWriter,
	r *http.Request,
	limiter *SSEIPLimiter,
	serverConfig *ServerConfig,
) (ctx context.Context, ip string, done func(), ok bool) {
	ip = getClientIP(r)

	streamCtx, cancel := context.WithCancel(r.Context())

	// Bypassed IPs are exempt from the limit — and so from displacement.
	if serverConfig.IsIPTimeoutBypassed(ip) {
		return streamCtx, ip, cancel, true
	}

	release, acquired := limiter.Acquire(ip, cancel)
	if !acquired {
		cancel()
		http.Error(w, "too many connections from your IP", http.StatusTooManyRequests)
		return nil, ip, nil, false
	}

	// Free the slot as soon as the stream ends, even if the handler goroutine is
	// still unwinding. release() is idempotent, so the deferred call is safe too.
	go func() { <-streamCtx.Done(); release() }()

	return streamCtx, ip, func() { cancel(); release() }, true
}

// MaidenheadRateLimiter manages per-IP rate limiters for the /api/maidenhead/country endpoint.
// Fixed at 1 request per second per IP with a burst of 1.
type MaidenheadRateLimiter struct {
	limiters map[string]*RateLimiter
	mu       sync.RWMutex
}

// NewMaidenheadRateLimiter creates a new Maidenhead endpoint rate limiter.
func NewMaidenheadRateLimiter() *MaidenheadRateLimiter {
	return &MaidenheadRateLimiter{
		limiters: make(map[string]*RateLimiter),
	}
}

// AllowRequest returns true if the given IP is within the rate limit (1 req/sec).
func (mrl *MaidenheadRateLimiter) AllowRequest(ip string) bool {
	mrl.mu.Lock()
	limiter, exists := mrl.limiters[ip]
	if !exists {
		limiter = &RateLimiter{
			tokens:     1.0,
			maxTokens:  1.0,
			refillRate: 1.0, // 1 request per second
			lastRefill: time.Now(),
		}
		mrl.limiters[ip] = limiter
	}
	mrl.mu.Unlock()
	return limiter.Allow()
}

// Cleanup removes stale per-IP limiters that have not been used in the last 10 minutes.
func (mrl *MaidenheadRateLimiter) Cleanup() {
	mrl.mu.Lock()
	defer mrl.mu.Unlock()
	now := time.Now()
	for ip, limiter := range mrl.limiters {
		limiter.mu.Lock()
		if now.Sub(limiter.lastRefill) > 10*time.Minute {
			delete(mrl.limiters, ip)
		}
		limiter.mu.Unlock()
	}
}

// GetStats returns the number of currently tracked IPs.
func (mrl *MaidenheadRateLimiter) GetStats() int {
	mrl.mu.RLock()
	defer mrl.mu.RUnlock()
	return len(mrl.limiters)
}

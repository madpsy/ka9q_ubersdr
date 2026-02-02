package main

import (
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
// Limits to 1 request per 5 seconds per IP
type AggregateRateLimiter struct {
	limiters map[string]*RateLimiter
	mu       sync.RWMutex
}

// NewAggregateRateLimiter creates a new aggregate endpoint rate limiter
// Fixed at 1 request per 5 seconds (0.2 requests per second)
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
		// Create a rate limiter with 1 token max, refilling at 0.2 tokens/sec (1 per 5 seconds)
		limiter = &RateLimiter{
			tokens:     1.0,
			maxTokens:  1.0,
			refillRate: 0.2, // 1 request per 5 seconds
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
		if band == "noise-analysis" {
			refillRate = 2.0 // 2 requests per second for noise analysis
			maxTokens = 2.0
		} else {
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

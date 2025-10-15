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

package main

import (
	"testing"
	"time"
)

// TestSessionCreateRateLimiterBurst verifies that the configured burst is allowed
// back-to-back and that the next attempt is rejected.
func TestSessionCreateRateLimiterBurst(t *testing.T) {
	rl := NewSessionCreateRateLimiter(6, 3)

	for i := 0; i < 3; i++ {
		allowed, _, _ := rl.Allow("audio", "uuid-1", "1.2.3.4")
		if !allowed {
			t.Fatalf("creation %d should be allowed within burst of 3", i+1)
		}
	}

	allowed, shouldLog, violations := rl.Allow("audio", "uuid-1", "1.2.3.4")
	if allowed {
		t.Fatal("creation beyond the burst should be rejected")
	}
	if !shouldLog {
		t.Fatal("first rejection should be logged")
	}
	if violations != 1 {
		t.Fatalf("violations = %d, want 1", violations)
	}

	// Subsequent rejections within the same minute must not ask to be logged,
	// otherwise a hammering client becomes a log-flooding primitive.
	_, shouldLog, violations = rl.Allow("audio", "uuid-1", "1.2.3.4")
	if shouldLog {
		t.Fatal("repeat rejection within a minute should not be logged")
	}
	if violations != 2 {
		t.Fatalf("violations = %d, want 2", violations)
	}
}

// TestSessionCreateRateLimiterSeparateBuckets verifies that audio and spectrum
// creations, and different UUIDs, do not share an allowance.
func TestSessionCreateRateLimiterSeparateBuckets(t *testing.T) {
	rl := NewSessionCreateRateLimiter(6, 1)

	if allowed, _, _ := rl.Allow("audio", "uuid-1", "1.2.3.4"); !allowed {
		t.Fatal("first audio creation should be allowed")
	}
	if allowed, _, _ := rl.Allow("spectrum", "uuid-1", "1.2.3.4"); !allowed {
		t.Fatal("spectrum draws from its own bucket, so it should be allowed")
	}
	if allowed, _, _ := rl.Allow("audio", "uuid-2", "1.2.3.4"); !allowed {
		t.Fatal("a different UUID should have its own bucket")
	}
	if allowed, _, _ := rl.Allow("audio", "uuid-1", "1.2.3.4"); allowed {
		t.Fatal("second audio creation for the same UUID should be rejected")
	}
}

// TestSessionCreateRateLimiterRefill verifies the sliding refill: after enough
// simulated time has passed, a rejected key is allowed again.
func TestSessionCreateRateLimiterRefill(t *testing.T) {
	rl := NewSessionCreateRateLimiter(6, 1) // 6/min = 1 token per 10s

	if allowed, _, _ := rl.Allow("audio", "uuid-1", "1.2.3.4"); !allowed {
		t.Fatal("first creation should be allowed")
	}
	if allowed, _, _ := rl.Allow("audio", "uuid-1", "1.2.3.4"); allowed {
		t.Fatal("second creation should be rejected")
	}

	// Rewind the bucket's clock by 10s rather than sleeping.
	rl.mu.Lock()
	entry := rl.limiters["audio|uuid-1"]
	rl.mu.Unlock()
	entry.limiter.mu.Lock()
	entry.limiter.lastRefill = entry.limiter.lastRefill.Add(-10 * time.Second)
	entry.limiter.mu.Unlock()

	if allowed, _, _ := rl.Allow("audio", "uuid-1", "1.2.3.4"); !allowed {
		t.Fatal("creation should be allowed again after a token has refilled")
	}
}

// TestSessionCreateRateLimiterDisabled verifies that a non-positive rate disables
// the limiter, and that a nil limiter (as built by tests constructing a
// SessionManager literal) always allows.
func TestSessionCreateRateLimiterDisabled(t *testing.T) {
	rl := NewSessionCreateRateLimiter(-1, 3)
	for i := 0; i < 100; i++ {
		if allowed, _, _ := rl.Allow("audio", "uuid-1", "1.2.3.4"); !allowed {
			t.Fatalf("creation %d should be allowed when the limiter is disabled", i+1)
		}
	}

	var nilLimiter *SessionCreateRateLimiter
	if allowed, _, _ := nilLimiter.Allow("audio", "uuid-1", "1.2.3.4"); !allowed {
		t.Fatal("nil limiter should allow")
	}
	nilLimiter.Cleanup()
	if n := nilLimiter.GetStats(); n != 0 {
		t.Fatalf("nil limiter GetStats = %d, want 0", n)
	}
}

// TestSessionCreateRateLimiterIPFallback verifies that clients without a UUID are
// bucketed by IP instead.
func TestSessionCreateRateLimiterIPFallback(t *testing.T) {
	rl := NewSessionCreateRateLimiter(6, 1)

	if allowed, _, _ := rl.Allow("audio", "", "1.2.3.4"); !allowed {
		t.Fatal("first creation should be allowed")
	}
	if allowed, _, _ := rl.Allow("audio", "", "1.2.3.4"); allowed {
		t.Fatal("second creation from the same IP should be rejected")
	}
	if allowed, _, _ := rl.Allow("audio", "", "5.6.7.8"); !allowed {
		t.Fatal("a different IP should have its own bucket")
	}
}

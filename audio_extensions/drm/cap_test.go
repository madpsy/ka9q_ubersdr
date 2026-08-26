package drm

import "testing"

// The cap is the only thing standing between a public instance and one OFDM
// decoder per listener, so it is worth proving it counts down as well as up.
func TestMaxUsersCap(t *testing.T) {
	prev := GlobalConfig
	defer func() { GlobalConfig = prev; activeUserCount = 0 }()
	GlobalConfig = &GlobalConfigProvider{MaxUsers: 2}
	activeUserCount = 0

	p := AudioExtensionParams{SampleRate: 12000, Channels: 2, BitsPerSample: 16}

	a, err := NewDRMExtension(p, nil)
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	b, err := NewDRMExtension(p, nil)
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if _, err := NewDRMExtension(p, nil); err == nil {
		t.Fatal("third should have been refused")
	}

	// Stopping frees exactly one slot, and stopping twice must not free two.
	_ = a.Stop()
	_ = a.Stop()
	if activeUserCount != 1 {
		t.Fatalf("after double Stop, count = %d, want 1", activeUserCount)
	}
	if _, err := NewDRMExtension(p, nil); err != nil {
		t.Fatalf("slot should have been free: %v", err)
	}
	_ = b.Stop()
}

// A rejected session must not leak its slot, or a run of bad attaches exhausts
// the limit with nothing running.
func TestRejectedAttachReleasesSlot(t *testing.T) {
	prev := GlobalConfig
	defer func() { GlobalConfig = prev; activeUserCount = 0 }()
	GlobalConfig = &GlobalConfigProvider{MaxUsers: 1}
	activeUserCount = 0

	// Mono is refused: DRM needs a stereo IQ session.
	if _, err := NewDRMExtension(AudioExtensionParams{SampleRate: 12000, Channels: 1, BitsPerSample: 16}, nil); err == nil {
		t.Fatal("mono should have been refused")
	}
	if activeUserCount != 0 {
		t.Fatalf("rejected attach leaked a slot: count = %d", activeUserCount)
	}
}

package freedv

import "testing"

// A refused attach must not consume a max_users slot. It used to: the counter
// was incremented before validation, and because a failed constructor never
// reaches Stop() the slot was gone for the life of the process. Ten attaches
// from an IQ session locked every user out of FreeDV until a restart, and
// nothing rate-limits audio_extension_attach.
func TestRejectedAttachDoesNotLeakSlot(t *testing.T) {
	prev := GlobalConfig
	defer func() { GlobalConfig = prev; activeUserCount = 0 }()
	GlobalConfig = &GlobalConfigProvider{MaxUsers: 3}
	activeUserCount = 0

	params := map[string]interface{}{"tuned_mode": "usb", "session_id": "probe"}
	refusals := []AudioExtensionParams{
		{SampleRate: 8000, Channels: 2, BitsPerSample: 16}, // stereo IQ session
		{SampleRate: 8000, Channels: 1, BitsPerSample: 8},  // wrong sample width
	}
	for i := 0; i < 4; i++ {
		for _, p := range refusals {
			if _, err := NewFreeDVExtension(p, params); err == nil {
				t.Fatalf("attach %d should have been refused", i)
			}
		}
	}
	// And a wrong-mode refusal, which is the one a browser hits most easily.
	good := AudioExtensionParams{SampleRate: 8000, Channels: 1, BitsPerSample: 16}
	for i := 0; i < 4; i++ {
		if _, err := NewFreeDVExtension(good, map[string]interface{}{
			"tuned_mode": "am", "session_id": "probe",
		}); err == nil {
			t.Fatalf("AM attach %d should have been refused", i)
		}
	}

	if activeUserCount != 0 {
		t.Fatalf("after 12 refused attaches activeUserCount = %d, want 0", activeUserCount)
	}
	if _, err := NewFreeDVExtension(good, params); err != nil {
		t.Fatalf("legitimate attach refused after the refusals: %v", err)
	}
}

// The manager stops an extension whose Start() failed as well as on ordinary
// teardown, and soundmodem-style extensions stop themselves too — so Stop must
// be safe to call more than once. A double release would drift the count below
// the number of real users and quietly raise the limit.
func TestStopIsIdempotent(t *testing.T) {
	prev := GlobalConfig
	defer func() { GlobalConfig = prev; activeUserCount = 0 }()
	GlobalConfig = &GlobalConfigProvider{MaxUsers: 2}
	activeUserCount = 0

	params := map[string]interface{}{"tuned_mode": "usb", "session_id": "probe"}
	good := AudioExtensionParams{SampleRate: 8000, Channels: 1, BitsPerSample: 16}

	a, err := NewFreeDVExtension(good, params)
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	if activeUserCount != 1 {
		t.Fatalf("after one attach count = %d, want 1", activeUserCount)
	}
	for i := 0; i < 3; i++ {
		_ = a.Stop()
	}
	if activeUserCount != 0 {
		t.Fatalf("after three Stops count = %d, want 0", activeUserCount)
	}
}

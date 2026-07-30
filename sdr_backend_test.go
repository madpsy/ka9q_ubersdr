package main

import "testing"

func TestBuiltInRadiodBackendConfiguration(t *testing.T) {
	backend, ok := defaultSDRBackends.Lookup("ka9q-radiod")
	if !ok {
		t.Fatal("ka9q-radiod backend is not registered")
	}
	if err := backend.ValidateConfig(map[string]any{
		"status_group": "hf-status.local",
		"data_group":   "pcm.local",
		"interface":    "eth0",
	}); err != nil {
		t.Fatalf("valid radiod configuration rejected: %v", err)
	}
	if err := backend.ValidateConfig(map[string]any{"status_group": "hf-status.local"}); err == nil {
		t.Fatal("incomplete radiod configuration was accepted")
	}
}

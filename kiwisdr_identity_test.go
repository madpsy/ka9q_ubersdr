package main

import "testing"

// Values confirmed against rx.kiwisdr.com on 2026-09-07: a registration
// carrying these was listed, while the previous null-valued form never was.
func TestFabricatedIdentityMatchesVerifiedValues(t *testing.T) {
	const uuid = "3f15dad3-9082-4bc1-8d57-f397b5e74069"
	if got, want := stableMAC(uuid), "08:04:b4:4a:c4:f5"; got != want {
		t.Errorf("stableMAC = %q, want %q", got, want)
	}
	if got, want := stableDNA(uuid), "1a89856e7cebe73b"; got != want {
		t.Errorf("stableDNA = %q, want %q", got, want)
	}
	if got, want := stableSerno(uuid), 34028; got != want {
		t.Errorf("stableSerno = %d, want %d", got, want)
	}
	// Stability: same input must always give the same output.
	for i := 0; i < 3; i++ {
		if stableMAC(uuid) != "08:04:b4:4a:c4:f5" || stableDNA(uuid) != "1a89856e7cebe73b" || stableSerno(uuid) != 34028 {
			t.Fatal("derived identity is not deterministic")
		}
	}
}

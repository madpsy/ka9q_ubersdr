package main

import (
	"fmt"
	"testing"
)

// maxThreadNameLen is Linux's TASK_COMM_LEN (16) minus the NUL terminator.
// pthread_setname_np() returns ERANGE for anything longer -- it does not
// truncate -- and radiod ignores that error, so an over-long name leaves the
// thread called "radiod".
const maxThreadNameLen = 15

// radiodDemodNames are the demodulator names ka9q-radio builds thread names
// from, as "<demod> <ssrc>" (upstream src/modes.c, Demodtab).  A channel can
// move between these at runtime when the user changes mode, so an SSRC has to
// fit the longest of them, not the one it was created with.
var radiodDemodNames = []string{"linear", "fm", "wfm", "spectrum", "spectrum2", "idle"}

// TestAllocateSSRCFitsRadiodThreadName is the reason allocateSSRC uses a narrow
// range at all.  If this fails, per-channel CPU attribution in
// radiod_channels_api.go silently stops working: matchThreadToSSRC looks for
// the decimal SSRC as a token in the thread name, and an over-long name means
// there is no such token to find.
func TestAllocateSSRCFitsRadiodThreadName(t *testing.T) {
	free := func(uint32) bool { return false }

	for i := 0; i < 2000; i++ {
		ssrc, err := allocateSSRC(free)
		if err != nil {
			t.Fatalf("allocateSSRC on an empty map: %v", err)
		}
		for _, demod := range radiodDemodNames {
			name := fmt.Sprintf("%s %d", demod, ssrc)
			if len(name) > maxThreadNameLen {
				t.Fatalf("thread name %q is %d chars, exceeds the %d-char limit "+
					"(SSRC %d); pthread_setname_np would fail with ERANGE and the "+
					"thread would stay named \"radiod\"",
					name, len(name), maxThreadNameLen, ssrc)
			}
		}
	}
}

// TestAllocateSSRCRange pins the range itself, so a change to the bounds has to
// be deliberate rather than incidental.
func TestAllocateSSRCRange(t *testing.T) {
	free := func(uint32) bool { return false }

	for i := 0; i < 2000; i++ {
		ssrc, err := allocateSSRC(free)
		if err != nil {
			t.Fatalf("allocateSSRC: %v", err)
		}
		if ssrc < 10000 || ssrc > 99999 {
			t.Fatalf("SSRC %d outside [10000, 99999]", ssrc)
		}
		// The old implementation needed explicit guards against these; the
		// range now excludes them by construction.
		if ssrc == 0 || ssrc == 0xffffffff {
			t.Fatalf("SSRC %d is a reserved RTP value", ssrc)
		}
	}
}

// TestAllocateSSRCSkipsInUse checks the collision path actually consults inUse.
func TestAllocateSSRCSkipsInUse(t *testing.T) {
	taken := make(map[uint32]bool)
	inUse := func(c uint32) bool { return taken[c] }

	// Allocate a good number of distinct SSRCs, marking each as taken, and
	// confirm none is ever handed out twice.
	for i := 0; i < 500; i++ {
		ssrc, err := allocateSSRC(inUse)
		if err != nil {
			t.Fatalf("allocation %d failed: %v", i, err)
		}
		if taken[ssrc] {
			t.Fatalf("allocateSSRC returned %d, which is already in use", ssrc)
		}
		taken[ssrc] = true
	}
}

// TestAllocateSSRCExhaustionReturnsError covers the case the pre-refactor loop
// in decoder.go got wrong: with every candidate taken it spun forever instead
// of giving up.
func TestAllocateSSRCExhaustionReturnsError(t *testing.T) {
	allTaken := func(uint32) bool { return true }

	ssrc, err := allocateSSRC(allTaken)
	if err == nil {
		t.Fatalf("expected an error when every SSRC is in use, got %d", ssrc)
	}
	if ssrc != 0 {
		t.Errorf("expected zero SSRC alongside the error, got %d", ssrc)
	}
}

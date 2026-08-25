package main

import "testing"

// The bin ceiling is a backstop against a radiod abort, so it has to hold for
// any caller, not just the ones that know about it.
//
// radiod sizes a spectrum channel's bin_data buffer on first allocation and the
// guard meant to resize it can never fire (spectrum.c compares against a local
// the reinitialisation block has already updated). Asking a live channel for
// more bins than it was created with overruns that buffer and aborts the whole
// process with "corrupted size vs. prev_size in fastbins".
func TestSpectrumBinCeiling(t *testing.T) {
	rc := &RadiodController{}
	const ssrc = 0x1234

	// Nothing recorded: we did not create this channel, so there is no ceiling
	// to enforce and the caller is left alone.
	if got := rc.spectrumBinCeiling(ssrc); got != 0 {
		t.Errorf("ceiling for an unknown SSRC = %d, want 0 (unknown)", got)
	}

	rc.noteSpectrumBins(ssrc, 1024)
	if got := rc.spectrumBinCeiling(ssrc); got != 1024 {
		t.Errorf("ceiling = %d after creating with 1024 bins, want 1024", got)
	}

	// A different channel's count must not leak across.
	rc.noteSpectrumBins(0x5678, 512)
	if got := rc.spectrumBinCeiling(ssrc); got != 1024 {
		t.Errorf("ceiling = %d after another SSRC was recorded, want 1024", got)
	}

	// Teardown releases it, so the next channel on this SSRC is measured
	// against its own creation count rather than the dead one's.
	rc.forgetSpectrumBins(ssrc)
	if got := rc.spectrumBinCeiling(ssrc); got != 0 {
		t.Errorf("ceiling = %d after teardown, want 0", got)
	}
	rc.noteSpectrumBins(ssrc, 2048)
	if got := rc.spectrumBinCeiling(ssrc); got != 2048 {
		t.Errorf("ceiling = %d after recreating with 2048 bins, want 2048", got)
	}
}

// A zero or negative count is not a ceiling; recording one would pin every
// later update to it.
func TestSpectrumBinCeilingIgnoresNonPositive(t *testing.T) {
	rc := &RadiodController{}
	const ssrc = 0x99

	rc.noteSpectrumBins(ssrc, 0)
	if got := rc.spectrumBinCeiling(ssrc); got != 0 {
		t.Errorf("ceiling = %d after a zero count, want it not recorded", got)
	}
	rc.noteSpectrumBins(ssrc, -8)
	if got := rc.spectrumBinCeiling(ssrc); got != 0 {
		t.Errorf("ceiling = %d after a negative count, want it not recorded", got)
	}
}

// The shapes that matter in practice: v2 reduces its bin count from the
// configured default and restores it, which is why it never hit this; the
// KiwiSDR emulation asked for more than the default, which is why it did.
func TestSpectrumBinCeilingCoversKnownCallers(t *testing.T) {
	tests := []struct {
		name       string
		created    int
		asked      int
		wantCapped bool
	}{
		{name: "v2 reducing for deep zoom", created: 1024, asked: 512},
		{name: "v2 restoring to the default", created: 1024, asked: 1024},
		{name: "kiwi holding the count steady", created: 1024, asked: 1024},
		{name: "the crash: asking above the creation count", created: 1024, asked: 2232, wantCapped: true},
		{name: "a channel created large can be asked for it", created: 2048, asked: 2048},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rc := &RadiodController{}
			const ssrc = 0x4321
			rc.noteSpectrumBins(ssrc, tc.created)

			ceiling := rc.spectrumBinCeiling(ssrc)
			capped := ceiling > 0 && tc.asked > ceiling
			if capped != tc.wantCapped {
				t.Errorf("asking for %d bins on a channel created with %d: capped=%v, want %v",
					tc.asked, tc.created, capped, tc.wantCapped)
			}
		})
	}
}

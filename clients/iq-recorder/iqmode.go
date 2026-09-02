package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// IQ capture modes and the receiver's tuning range
// ================================================
//
// This recorder used to be an iq48-only tool: the mode was a string literal in
// the WebSocket URL and 48000 Hz was assigned to the decoder before the first
// packet arrived. Both are now chosen at startup, because a receiver that
// offers iq384 can be captured eight times wider and the alignment machinery
// that makes multi-instance recordings useful does not care which rate it is
// aligning.

// iqSampleRates is the sample rate each IQ mode delivers, mirroring
// GetSampleRateForMode in the server's config.go.
//
// The rate is NOT parsed out of the mode name: "iq" is 12 kHz and carries no
// number at all, and the server treats presets.conf as the truth for what a
// mode actually delivers. Reproducing that as a table means a preset that moves
// is a one-line change here rather than a decoder that silently writes a WAV
// header claiming the wrong rate -- which does not fail, it just plays back at
// the wrong speed.
var iqSampleRates = map[string]int{
	"iq":    12000,
	"iq48":  48000,
	"iq96":  96000,
	"iq192": 192000,
	"iq384": 384000,
}

// sampleRateForIQMode returns the rate for mode, and whether it is an IQ mode
// this recorder knows.
func sampleRateForIQMode(mode string) (int, bool) {
	rate, ok := iqSampleRates[mode]
	return rate, ok
}

// iqModeList is every mode above, ordered by rate, for help text and errors.
func iqModeList() []string {
	modes := make([]string, 0, len(iqSampleRates))
	for m := range iqSampleRates {
		modes = append(modes, m)
	}
	sort.Slice(modes, func(i, j int) bool { return iqSampleRates[modes[i]] < iqSampleRates[modes[j]] })
	return modes
}

// bytesPerIQFrame is one interleaved I/Q sample pair: two int16.
//
// Every IQ mode is two channels, so this is a constant rather than a function
// of the mode -- but it is named because the sample accounting divides by it in
// several places and a bare 4 there reads like a coincidence.
const bytesPerIQFrame = 4

// Default tuning range, used when a receiver does not publish one.
//
// These are the server's own fallbacks: receiverMinFrequency and
// receiverTodaySpanHz in receiver_span.go. A receiver that says nothing is
// assumed to be the RX888 span every instance had before tuning_range existed.
const (
	MinFrequencyHz int64 = 10_000     // 10 kHz
	MaxFrequencyHz int64 = 30_000_000 // 30 MHz
)

// TuningRange is how much spectrum a receiver covers, from /api/description's
// `tuning_range` object. Every field is optional, including the whole object.
type TuningRange struct {
	MinFrequency int64 `json:"min_frequency"`
	MaxFrequency int64 `json:"max_frequency"`
}

// descriptionTuning is the sliver of /api/description this recorder reads for
// the range. The rest of the document is stored verbatim and written out beside
// the WAV, so nothing else needs a struct.
type descriptionTuning struct {
	TuningRange *TuningRange `json:"tuning_range"`
}

// tuningRangeFrom reads the range out of an /api/description body.
//
// Each edge falls back on its own -- they are independent facts, and a receiver
// that states one must not reset the other. Anything at or below zero is "not
// said" rather than a limit, so a zero, a missing field, a null, or a body that
// does not parse all leave the default in place. A max at or below the min is a
// misconfigured receiver rather than a range, and is refused outright rather
// than adopted inverted.
func tuningRangeFrom(description []byte) (min, max int64) {
	min, max = MinFrequencyHz, MaxFrequencyHz
	if len(description) == 0 {
		return min, max
	}
	var desc descriptionTuning
	if err := json.Unmarshal(description, &desc); err != nil || desc.TuningRange == nil {
		return min, max
	}
	lo, hi := min, max
	if desc.TuningRange.MinFrequency > 0 {
		lo = desc.TuningRange.MinFrequency
	}
	if desc.TuningRange.MaxFrequency > 0 {
		hi = desc.TuningRange.MaxFrequency
	}
	if hi <= lo {
		return min, max
	}
	return lo, hi
}

// validateIQMode reports an error naming what is available when mode is not an
// IQ mode this recorder can record.
func validateIQMode(mode string) error {
	if _, ok := sampleRateForIQMode(mode); !ok {
		return fmt.Errorf("unknown IQ mode %q (supported: %s)", mode, strings.Join(iqModeList(), ", "))
	}
	return nil
}

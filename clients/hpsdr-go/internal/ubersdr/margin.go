package ubersdr

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// Reduced-depth IQ margin, in dB under the band's own noise floor.
//
// MinMarginMinDB and MinMarginMaxDB are the server's own limits (lossyMinMarginDB
// and lossyMaxMarginDB in pcm_lossy.go), repeated so a value outside them is
// refused with a reason rather than silently clamped by the server halfway
// through a session. 15 dB adds 0.14 dB to the noise floor, under what a
// receiver's readings resolve; past 60 dB the request buys nothing.
//
// MinMarginDefaultDB is the web client's default: the measured transparent
// point, where every FT8 decode survives with its reported strength intact, for
// about 0.01 dB of noise floor and roughly half the bytes. Zero asks for the
// lossless stream.
const (
	MinMarginMinDB     = 15
	MinMarginMaxDB     = 60
	MinMarginDefaultDB = 26
)

// ParseMinMargin parses a margin in dB. Strict on purpose: the server clamps
// and rounds whatever it is sent, so a typo would produce a working but
// different stream and nothing would ever say so. The note, when not empty,
// says a value was rounded, as the server would have.
func ParseMinMargin(arg string) (dB int, note string, err error) {
	s := strings.TrimSpace(arg)
	if s == "" {
		return 0, "", fmt.Errorf("min-margin: expected a value in dB")
	}
	v, perr := strconv.ParseFloat(s, 64)
	if perr != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, "", fmt.Errorf("min-margin: %q is not a number of dB", arg)
	}
	if v == 0 {
		return 0, "", nil
	}
	if v < MinMarginMinDB || v > MinMarginMaxDB {
		return 0, "", fmt.Errorf("min-margin: %g dB is outside %d-%d; the server would not honour it as asked. Use 0 for a lossless stream",
			v, MinMarginMinDB, MinMarginMaxDB)
	}
	dB = int(math.Round(v))
	if float64(dB) != v {
		note = fmt.Sprintf("min-margin: %g dB rounded to %d, which is what the server would have done with it", v, dB)
	}
	return dB, note, nil
}

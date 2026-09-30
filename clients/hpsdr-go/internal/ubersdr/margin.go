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
// through a session. 10 dB adds 0.41 dB to the noise floor on paper, and 0.2 to
// 0.3 dB as delivered since the server holds the real margin 2 to 5 dB above the
// request; past 60 dB the request buys nothing.
//
// MinMarginDefaultDB is the floor, for the bandwidth: measured on live captures
// it saves 65-74% against lossless where 26 dB saves about half, lifts the noise
// floor by 0.14-0.25 dB, and loses no FT8 decode that 15 dB keeps. 26 dB is the
// transparent point, for a client that wants the reported strengths intact too.
// Zero asks for the lossless stream.
const (
	MinMarginMinDB     = 10
	MinMarginMaxDB     = 60
	MinMarginDefaultDB = 10
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

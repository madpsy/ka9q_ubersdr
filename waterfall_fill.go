package main

// Waterfall gap filling, shared by the WebSDR and KiwiSDR emulations.
//
// The rate a waterfall scrolls at and the rate radiod is polled at are not the same
// number. Polling is thinned by kiwisdr_spectrum_divisor / websdr_spectrum_divisor so
// radiod is not asked to produce a whole spectrum response for every row -- above its
// crossover that is an FFT over the entire front end -- and the gap that leaves is
// filled by repeating the last row.
//
// The repeat carries nothing new, so each measurement occupies more than one row of
// waterfall and less history fits on screen. What it buys is the scroll rate: the real
// WebSDR and KiwiSDR servers run their waterfalls at the full rate, and a visibly
// slower one reads as a broken receiver rather than a cheaper one.
//
// Only the operator's thinning is filled. A WebSDR client's own Speed setting
// multiplies on top and is left alone -- someone who picked "slow" asked for a slow
// waterfall and gets one.

// waterfallFill decides when a repeated row may be sent.
//
// It is deliberately only the decision: what to repeat and how to put it on the wire
// differ between the two emulations (one caches pixels and re-encodes, the other
// caches the packet and rewrites its sequence number), but when to do it does not.
type waterfallFill struct {
	factor int  // rows the client should see per row radiod produces
	fills  int  // consecutive fills since the last real row
	primed bool // a real row has been sent, so there is something to repeat
}

// SetFactor records how many rows the client should see per real row. Read on every
// decision rather than stored once, because the operator can reload config.
func (f *waterfallFill) SetFactor(n int) {
	if n < 1 {
		n = 1
	}
	f.factor = n
}

// Real records that a real row has just been sent, which re-arms the filling.
func (f *waterfallFill) Real() {
	f.primed = true
	f.fills = 0
}

// Take reports whether a repeated row may be sent now, and counts it if so.
//
// False before the first real row: there is nothing to repeat, and after a zoom the
// encoder state has been reset so a stale row would decode against the wrong
// prediction.
//
// False once the operator's thinning has been covered. That bound is what keeps a
// radiod stall visible: without it the waterfall would scroll forever on a frozen
// spectrum, which reads as a working receiver showing dead air and is worse than one
// that plainly stops.
func (f *waterfallFill) Take() bool {
	if !f.primed || f.factor < 2 || f.fills >= f.factor-1 {
		return false
	}
	f.fills++
	return true
}

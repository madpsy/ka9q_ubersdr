// The spectrum's animation-frame counter, where more than one readout can see it.
//
// The count is a fact about the machine rather than about the spectrum — it is
// every frame the browser handed the loop, drawn or idle, and "well below the
// screen refresh" is what says this machine is struggling. Two things ask for
// it now: the readout in the corner of the waterfall, and the Stats panel's
// chart of the same figure over the last ten seconds.
//
// It lived on the spectrum's own gfx object, which is a ref inside SpectrumView
// and reachable from nothing else. Copying it into a second counter beside the
// first is the arrangement that drifts — one of them gets incremented on a path
// the other does not — so there is one counter and it lives here.
//
// Ever-increasing and never reset: both consumers difference it against their
// own previous reading, and a counter that went back to zero would be read as a
// second's worth of enormous negative rate. Initialised rather than left to
// `++` on an undefined, which gives NaN and then reads back through `|| 0` as a
// perfectly plausible zero — the bug this counter's predecessor shipped with.

let ticks = 0;

/** One animation frame, drawn or not. Called from the spectrum's paint loop. */
export function countFrame() {
    ticks += 1;
}

/** The count so far. Difference two readings to get a rate. */
export function frameTicks() {
    return ticks;
}

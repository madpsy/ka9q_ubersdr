// Only one thing demodulates the IQ stream on the page at a time.
//
// The IQ Demod panel's demodulators and the playground both need the receiver
// in IQ, both silence its own output while they run (the raw pair is broadband
// noise), and both would otherwise be heard on top of each other. So starting
// either stops the other.
//
// The one thing handed across is where to go back to. Whichever started first
// remembered the mode the operator was in before IQ, so that stopping could
// put them back; the one taking over inherits that, because the receiver is
// still in IQ for the same reason and the operator's way out has not changed.
//
// An owner is anything with `restoreMode` and `stop()`.

let owner = null;

/**
 * Become the one demodulating. Stops whoever was, and returns the mode they
 * would have restored, or null.
 */
export function claimIQ(next) {
    if (owner === next) return null;
    const prev = owner;
    owner = next;
    if (!prev) return null;
    const back = prev.restoreMode || null;
    prev.restoreMode = null;
    prev.stop();
    return back;
}

/** Stop being the one demodulating, if this is. */
export function releaseIQ(who) {
    if (owner === who) owner = null;
}

/** Testing seam. */
export function resetIQOwner() {
    owner = null;
}

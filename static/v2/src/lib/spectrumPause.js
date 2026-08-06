// Putting the spectrum socket to sleep, and knowing that it is asleep.
//
// Two different things want to do it. A hidden tab closes it after five seconds
// (VisibilityWatch) and brings it straight back when you look again. An idle
// session can close it after minutes and *not* bring it back on its own — that
// one is a data-saving choice, mostly for a phone, so it waits for the operator
// to ask rather than resuming on the first stray mousemove.
//
// The how is here so both do it identically, because the pair is easy to get
// subtly wrong: it is `disconnect()` and not a bare close, and the reopen has to
// name the view it left. Getting either of them wrong produces a reconnect loop
// or a spectrum that comes back at the wrong span, both of which look like
// something else's bug.
//
// The flag is here for the same reason it is not in RadioContext: the two things
// that need it are the watcher that sets it and the spectrum that draws itself
// dimmed, and a context is a re-render of the whole tree to say one boolean.

/**
 * Close the socket and stop the server producing for it.
 *
 * `disconnect()`, not `close()`: it is the one that sets closedByUser, which is
 * what stops _onClose scheduling the exponential-backoff reconnect. Without it
 * the socket comes straight back a second later and the pause is a reconnect
 * loop instead.
 */
export function suspendSpectrum(conn) {
    if (conn) conn.disconnect();
}

/**
 * Reopen it where it was.
 *
 * The server keeps nothing for a session that has gone, so the connection's own
 * idea of where it was pointed is the only thing that says where to come back
 * to — reconnecting without it lands on the default span, which after a pause
 * reads as the display having lost your place. Anything asked for while it was
 * closed is waiting in pendingView and goes out on open.
 */
export function resumeSpectrum(conn) {
    if (!conn) return;
    conn.connect({ frequency: conn.centerFreq, binBandwidth: conn.binBandwidth });
}

// --- was it us, and is it still asleep --------------------------------------
//
// Only ever true for the idle pause. A hidden tab's suspend is invisible by
// definition and resumes itself, so marking it would only put an overlay on a
// spectrum nobody was looking at, ready to be seen the instant they were.

let paused = false;
const listeners = new Set();

export function spectrumPaused() {
    return paused;
}

export function setSpectrumPaused(next) {
    const value = !!next;
    if (value === paused) return;
    paused = value;
    for (const fn of [...listeners]) {
        try { fn(paused); } catch (e) { console.error('spectrum pause listener threw', e); }
    }
}

export function onSpectrumPaused(fn) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

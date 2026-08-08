// SAM → AM when the carrier goes away.
//
// Synchronous AM locks a PLL to the carrier, which is better than envelope AM
// while there is a carrier to lock to and worse than useless when there is not:
// the loop wanders off and hunts, and what comes out is a warble that sounds
// like a fault in the receiver. So a SAM session that loses its signal falls
// back to ordinary AM, and says so.
//
// ── Why this watches a number rather than the packet flow ────────────────────
//
// The obvious test — "no audio has arrived for two seconds" — does not work.
// ka9q-radio does not stop sending when there is nothing to send; it sends
// silence, continuously, at the same rate. Packet arrival times are therefore
// identical with a strong carrier and with a dead band.
//
// What does change is `basebandPower` in each packet's header. On real signal it
// moves every packet; on silence the demodulator produces the same figure over
// and over. So the test is not "when did a packet last arrive" but "when did
// this number last *change*" — which is v1's rule (see the SAM silence watchdog
// in static/app.js), ported here with its reasoning intact.
//
// Exact float comparison is deliberate. Two consecutive packets of true digital
// silence give bit-identical floats; anything the demodulator is actually
// working on differs in the low bits even when it is quiet. A tolerance would
// turn "quiet" into "absent" and switch mode on a weak but perfectly good
// station, which is the failure worth avoiding.

/** How long the figure may sit unchanged before SAM gives up on the carrier. */
export const FALLBACK_MS = 2000;

/** How often the watch is asked. Fine against a two-second window. */
export const CHECK_MS = 500;

/** A watch that has seen nothing yet. */
export function createWatch() {
    return {
        // The last basebandPower seen, or null before the first packet.
        power: null,
        // When it last changed, or 0 if no packet has arrived since the last
        // reset. Zero is what stops the timer running from a stale reading.
        at: 0,
    };
}

/**
 * Record a reading. Only a *change* moves the clock.
 *
 * @returns {boolean} whether this reading was a change
 */
export function notePower(watch, power, now) {
    if (!watch || power == null || !Number.isFinite(power)) return false;
    if (power === watch.power) return false;
    watch.power = power;
    watch.at = now;
    return true;
}

/**
 * Forget everything seen so far.
 *
 * Called on every mode change, so that arriving in SAM requires a fresh reading
 * before the clock can start. Without it, switching into SAM after a spell of
 * silence would fall straight back out again on the strength of readings taken
 * in another mode entirely.
 */
export function resetWatch(watch) {
    if (!watch) return watch;
    watch.power = null;
    watch.at = 0;
    return watch;
}

/**
 * Whether SAM should give up now.
 *
 * @param mode the mode the receiver is in
 * @returns {boolean}
 */
export function shouldFallBack(watch, mode, now, ms = FALLBACK_MS) {
    if (!watch) return false;
    if (String(mode || '').toLowerCase() !== 'sam') return false;
    // Nothing seen since the last reset. Not "silent" — unknown — and switching
    // mode on no evidence is worse than waiting for some.
    if (!watch.at) return false;
    return now - watch.at >= ms;
}

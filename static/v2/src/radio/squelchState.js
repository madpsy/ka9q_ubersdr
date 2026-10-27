// Whether the squelch is open, as the server's audio gate would have it.
//
// One function, used by everything that shows a gate: the main receiver's
// badge (RadioContext) and every VFO listened to alongside it
// (radio/subReceivers.js), which share one threshold and so must agree about
// what it means. It used to be written inline in RadioContext, and a second
// copy for the extra VFOs would have been a second place for the hang or the
// IQ exception to be forgotten.
//
// It mirrors audioGateAllows() on the server, including its 500 ms hang timer —
// otherwise the indicator flickers closed on every syllable gap in speech.
//
// IQ is held open whatever the threshold says, because the server skips the
// gate entirely for it (see the isIQMode checks around audioGateAllows). The
// threshold itself survives a trip through IQ — the panel only hides its
// control — so without this the badge would read CLOSED over a stream nothing
// is gating.

import { SQUELCH_HANG_MS } from './constants.js';

/**
 * The gate after one signal reading.
 *
 * @param {object} p
 * @param {number|null} p.snr         the reading, dB; null when the packet had none.
 * @param {number|null} p.threshold   the gate's min SNR, or null when squelch is off.
 * @param {boolean}     [p.iq]        whether the stream is IQ, which nothing gates.
 * @param {number}      p.now         ms, any monotonic clock.
 * @param {number}      [p.lastOpenAt] when it was last open, on the same clock.
 * @returns {{open: boolean, lastOpenAt: number}}
 */
export function squelchState({ snr, threshold, iq = false, now, lastOpenAt = 0 }) {
    if (iq || threshold == null) return { open: true, lastOpenAt: now };
    if (snr != null && snr >= threshold) return { open: true, lastOpenAt: now };
    return { open: now - lastOpenAt < SQUELCH_HANG_MS, lastOpenAt };
}

/**
 * Whether a passband should be drawn brighter for its squelch: only while a
 * squelch is set and passing audio. With none set there is nothing to show —
 * "open" would be every moment — and in IQ nothing is gated.
 */
export function squelchBrightens({ enabled, open, iq = false }) {
    return !!enabled && !!open && !iq;
}

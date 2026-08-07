// The receiver's own frequency accuracy.
//
// /api/description carries a `frequency_reference` block when the operator has the
// monitor running: the receiver listens to a standard station on a known frequency and
// reports how far off its own oscillator turned out to be. A v1 widget put that in the
// corner of the page (widgets/frequency.widget.html); this is the same fact in the
// spectrum toolbar, where the frequencies it applies to are.
//
// It is worth having on screen because it qualifies everything else there. A receiver
// twenty hertz out will have you tuning a CW signal to the wrong note and logging a
// frequency nobody else measured, and none of that shows anywhere until something is
// compared with something.
//
// The block only carries an offset once the monitor has averaged some history — the
// server sends `enabled` alone until then — so "no badge" means either that the
// operator does not run it or that it has not measured anything yet. Neither is worth
// a placeholder.

// Where the bands are, in hertz of error.
//
// Zero is zero: the monitor reports a rounded average, and a receiver reading exactly
// its reference is the thing the badge exists to confirm. Up to five hertz is fine for
// voice and for finding a signal, which is what most listening is; beyond that a CW
// note is audibly wrong and a logged frequency is wrong with it.
export const FREQ_OK_HZ = 0;
export const FREQ_WARN_HZ = 5;

/** 'good' | 'warn' | 'bad', or '' when there is nothing to say. */
export function offsetBand(hz) {
    if (hz == null || !Number.isFinite(Number(hz))) return '';
    const v = Math.abs(Number(hz));
    if (v <= FREQ_OK_HZ) return 'good';
    if (v <= FREQ_WARN_HZ) return 'warn';
    return 'bad';
}

/**
 * The offset the receiver is reporting, or null.
 *
 * Null covers every way of not knowing: no monitor, a monitor with no history yet, and
 * a field that arrived as something other than a number. The badge is absent in all
 * three, because a frequency accuracy of "unknown" is what every receiver without this
 * has, and none of them says so.
 */
export function freqOffset(serverInfo) {
    const ref = serverInfo && serverInfo.frequency_reference;
    if (!ref || typeof ref !== 'object') return null;
    const hz = Number(ref.frequency_offset);
    return ref.frequency_offset == null || !Number.isFinite(hz) ? null : hz;
}

/** The badge's text: signed, and in whole hertz, which is the precision on offer. */
export function offsetLabel(hz) {
    if (hz == null) return '';
    const n = Math.round(hz);
    if (n === 0) return '0 Hz';
    return `${n > 0 ? '+' : ''}${n} Hz`;
}

/**
 * The sentence behind it, which is where the detail goes.
 *
 * A badge reading "+7 Hz" is a number without a claim attached; the tooltip is where it
 * says whose error it is and what it means for what is on screen.
 */
export function offsetTitle(serverInfo) {
    const hz = freqOffset(serverInfo);
    if (hz == null) return '';
    const ref = serverInfo.frequency_reference || {};
    const parts = [];
    const band = offsetBand(hz);
    if (band === 'good') {
        parts.push('The receiver is on frequency against its reference station.');
    } else {
        parts.push(`Everything on screen reads ${offsetLabel(hz)} away from where it actually is,`
            + ' measured against a reference station.');
    }
    const expected = Number(ref.expected_frequency);
    if (Number.isFinite(expected) && expected > 0) {
        parts.push(`Reference: ${(expected / 1e6).toFixed(3)} MHz.`);
    }
    const snr = Number(ref.snr);
    if (Number.isFinite(snr)) parts.push(`Reference SNR ${snr.toFixed(1)} dB.`);
    return parts.join(' ');
}

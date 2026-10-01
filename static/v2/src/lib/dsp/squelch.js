// The squelch: a level detector and the gate it drives.
//
// Two parts because they are two decisions taken at two places in a
// demodulator. The detector reads the power in the passband — after the filter,
// before the mode's own step and before the AGC, which is the only point at
// which the figure means "how much is arriving" rather than "how loud the mode
// made it" (see the squelch notes in lib/iqDemod.js). The gate then acts on the
// audio at the very end. Between them the detector's reading travels as a
// per-sample array, so the gate can be applied wherever the audio is.

// How far the level has to fall back before the gate shuts again. Without it a
// signal sitting on the threshold chops the audio into fragments at the rate the
// envelope wanders, which is the one failure that makes a squelch worse than no
// squelch.
export const SQUELCH_HYSTERESIS_DB = 3;

// And how long it stays open after the level has gone.
//
// Half a second, which is long by the standards of an FM repeater's tail and
// deliberately so: this is squelching SSB and CW as often as FM, where the gaps
// are the spaces between words and the spaces between characters. A tail short
// enough to go unnoticed on FM chops those into fragments, and a chopped signal
// is harder to copy than an open channel.
//
// The asymmetry with the opening below is the whole shape of the control:
// shutting is a decision that can afford to be wrong for half a second, and
// opening is one that cannot be late at all, because what it would be late for
// is the start of somebody's transmission.
export const SQUELCH_HANG_SEC = 0.5;

// The detector's own smoothing, asymmetric for the same reason.
//
// Three milliseconds up, so the level is at the signal within a syllable's
// onset and the gate opens on the first thing said rather than the second.
// Fifty down, so it does not follow the troughs of a modulated signal into the
// hysteresis and back out again between one word and the next.
export const SQUELCH_ATTACK_SEC = 0.003;
export const SQUELCH_DECAY_SEC = 0.05;

// And the gate's own edges, which exist only to keep it from clicking.
//
// Two milliseconds open — far below anything the ear places, so the gate is
// instant in every sense that matters and still not a step discontinuity —
// against fifteen shut, where there is no hurry and the slower fade is the
// quieter one.
export const SQUELCH_OPEN_SEC = 0.002;
export const SQUELCH_SHUT_SEC = 0.015;

/**
 * A power follower: fast up, slow down. In: instantaneous power per sample.
 * Out: the smoothed power per sample. `level` is the last of those.
 */
export class PowerDetector {
    constructor({ attackSec = SQUELCH_ATTACK_SEC, decaySec = SQUELCH_DECAY_SEC } = {}) {
        this.attackSec = attackSec;
        this.decaySec = decaySec;
        this.level = 0;
    }

    reset() {
        this.level = 0;
    }

    process(inPow, out, frames, rate) {
        const atk = 1 - Math.exp(-1 / (rate * this.attackSec));
        const dec = 1 - Math.exp(-1 / (rate * this.decaySec));
        let p = this.level;
        for (let k = 0; k < frames; k++) {
            const now = inPow[k];
            p += (now > p ? atk : dec) * (now - p);
            out[k] = p;
        }
        this.level = p;
    }
}

/**
 * The gate: open at `thresholdDb`, shut `hysteresisDb` below it once the hang
 * has run out. In: smoothed power per sample, in linear units against
 * full scale. Out: the gate's gain per sample, 0..1, ramped so it never steps.
 *
 * `enabled` false holds it open — the gain still ramps there from wherever it
 * was. Starts open, so starting never clips the first syllable; with a
 * threshold set and nothing arriving it shuts within a few tens of
 * milliseconds, which is the right way round for the two mistakes.
 */
export class SquelchGate {
    constructor({
        thresholdDb = -60,
        enabled = false,
        hysteresisDb = SQUELCH_HYSTERESIS_DB,
        hangSec = SQUELCH_HANG_SEC,
        openSec = SQUELCH_OPEN_SEC,
        shutSec = SQUELCH_SHUT_SEC,
    } = {}) {
        this.thresholdDb = thresholdDb;
        this.enabled = enabled;
        this.hysteresisDb = hysteresisDb;
        this.hangSec = hangSec;
        this.openSec = openSec;
        this.shutSec = shutSec;
        this.on = true;
        this.gain = 1;
        this.hang = 0;
    }

    reset() {
        this.on = true;
        this.gain = 1;
        this.hang = 0;
    }

    /** Whether it is letting anything through, as of the last sample. */
    get open() {
        return !this.enabled || this.on;
    }

    process(inPow, out, frames, rate) {
        const enabled = this.enabled;
        const openPow = 10 ** (this.thresholdDb / 10);
        const shutPow = 10 ** ((this.thresholdDb - this.hysteresisDb) / 10);
        const hangSamples = Math.round(rate * this.hangSec);
        const up = 1 - Math.exp(-1 / (rate * this.openSec));
        const down = 1 - Math.exp(-1 / (rate * this.shutSec));
        let on = this.on;
        let gain = this.gain;
        let hang = this.hang;
        for (let k = 0; k < frames; k++) {
            if (enabled) {
                const p = inPow[k];
                if (p >= openPow) {
                    // Instantly, and from wherever the gate was: a signal over
                    // the threshold opens it and hands it the whole hang again.
                    on = true;
                    hang = hangSamples;
                } else if (p < shutPow) {
                    // Between the two thresholds nothing is decided — that gap
                    // is the hysteresis — and below the lower one the hang has
                    // to run out before the gate shuts.
                    if (hang > 0) hang--;
                    else on = false;
                }
            }
            const want = enabled ? (on ? 1 : 0) : 1;
            gain += (want > gain ? up : down) * (want - gain);
            out[k] = gain;
        }
        this.on = on;
        this.gain = gain;
        this.hang = hang;
    }
}

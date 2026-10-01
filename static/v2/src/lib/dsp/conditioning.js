// What every demodulator's audio goes through on its way out: a DC block, FM's
// de-emphasis, and the automatic gain control.
//
// Each is a one-pole filter or follower with its time given in seconds or
// hertz, and converted to a per-sample coefficient for whatever rate it is run
// at — so one placed after a decimator means the same thing as one before it.

/**
 * DC blocker: a first-order high-pass.
 *
 * Removes the receiver's own centre offset from SSB, the carrier from AM, and
 * the tuning error from FM — where it is not a nicety but the thing that centres
 * the discriminator, so a few hundred hertz of mistuning stops being a DC step
 * that eats the headroom.
 */
export const DC_CORNER_HZ = 20;

export class DcBlock {
    constructor({ cornerHz = DC_CORNER_HZ } = {}) {
        this.cornerHz = cornerHz;
        this.x = 0;
        this.y = 0;
    }

    reset() {
        this.x = 0;
        this.y = 0;
    }

    /** In place. */
    process(buf, frames, rate) {
        const r = 1 - (2 * Math.PI * this.cornerHz) / rate;
        let x = this.x;
        let y = this.y;
        for (let k = 0; k < frames; k++) {
            const v = buf[k];
            y = v - x + r * y;
            x = v;
            buf[k] = y;
        }
        this.x = x;
        this.y = y;
    }
}

/**
 * De-emphasis: a one-pole low-pass with the transmitter's time constant.
 *
 * 750 µs for narrowband FM. Transmitters pre-emphasise, so this is a correction
 * rather than a tone control; without it narrowband FM is harsh in a way that
 * sounds like the demodulator is wrong. Broadcast FM is 50 or 75 µs.
 */
export const DEEMPHASIS_SEC = 750e-6;

export class Deemphasis {
    constructor({ tauSec = DEEMPHASIS_SEC } = {}) {
        this.tauSec = tauSec;
        this.y = 0;
    }

    reset() {
        this.y = 0;
    }

    /** In place. */
    process(buf, frames, rate) {
        const a = 1 - Math.exp(-1 / (rate * this.tauSec));
        let y = this.y;
        for (let k = 0; k < frames; k++) {
            y += a * (buf[k] - y);
            buf[k] = y;
        }
        this.y = y;
    }
}

// The output the AGC drives towards, well below full scale so a transient has
// somewhere to go before the clip at the end of the chain.
export const AGC_TARGET = 0.25;
// Fast enough that a loud signal does not blast, slow enough that speech is not
// flattened between syllables. Decay is what an operator hears as "the noise
// comes up between overs", and 600 ms is the usual compromise.
export const AGC_ATTACK_SEC = 0.005;
export const AGC_DECAY_SEC = 0.6;
// A ceiling on the gain, so silence does not wind up to full-scale hiss.
export const AGC_MAX_GAIN = 300;
// The carrier-referred level: one sideband of a 100% modulated tone comes out at
// half the carrier's amplitude, so at this gain full modulation peaks at 0.75 —
// louder than the audio AGC's target on typical programme, which sits well under
// full modulation, and still short of the clip.
export const AGC_CARRIER_LEVEL = 1.5;
export const AGC_REFERRED_SMOOTH_SEC = 0.02;

/**
 * Automatic gain control: a peak follower on the audio, and a gain that brings
 * it to `target`.
 *
 * The follower always runs, whether or not the gain is applied, so switching
 * the AGC on picks up from where the signal is rather than from silence.
 *
 * With a reference — processReferred — the gain is set against that instead
 * while it is non-zero: ECSS and SAM level against the carrier they have
 * locked to, which unlike the audio does not rise and fall with the programme.
 * Where the reference is zero (no lock), it falls back to the audio. That gain
 * is smoothed, so moving between the two is not a step.
 */
export class Agc {
    constructor({
        target = AGC_TARGET,
        attackSec = AGC_ATTACK_SEC,
        decaySec = AGC_DECAY_SEC,
        maxGain = AGC_MAX_GAIN,
        carrierLevel = AGC_CARRIER_LEVEL,
        referredSmoothSec = AGC_REFERRED_SMOOTH_SEC,
    } = {}) {
        this.target = target;
        this.attackSec = attackSec;
        this.decaySec = decaySec;
        this.maxGain = maxGain;
        this.carrierLevel = carrierLevel;
        this.referredSmoothSec = referredSmoothSec;
        this.env = 0;
        this.referredGain = 0;
    }

    reset() {
        this.env = 0;
        this.referredGain = 0;
    }

    /** Follow the level of `buf`, and level it in place if `apply`. */
    process(buf, frames, rate, apply = true) {
        const atk = 1 - Math.exp(-1 / (rate * this.attackSec));
        const dec = 1 - Math.exp(-1 / (rate * this.decaySec));
        const { target, maxGain } = this;
        let env = this.env;
        for (let k = 0; k < frames; k++) {
            const y = buf[k];
            const mag = y < 0 ? -y : y;
            env += (mag > env ? atk : dec) * (mag - env);
            if (apply) {
                const g = env > 0 ? Math.min(maxGain, target / env) : 0;
                buf[k] = y * g;
            }
        }
        this.env = env;
    }

    /**
     * Follow the level of `buf`, and level it in place against `ref` where that
     * is non-zero (to `carrierLevel`) and against the audio where it is not.
     */
    processReferred(buf, ref, frames, rate, apply = true) {
        const atk = 1 - Math.exp(-1 / (rate * this.attackSec));
        const dec = 1 - Math.exp(-1 / (rate * this.decaySec));
        const smooth = 1 - Math.exp(-1 / (rate * this.referredSmoothSec));
        const { target, maxGain, carrierLevel } = this;
        let env = this.env;
        let gain = this.referredGain;
        for (let k = 0; k < frames; k++) {
            const y = buf[k];
            const mag = y < 0 ? -y : y;
            env += (mag > env ? atk : dec) * (mag - env);
            if (apply) {
                const want = ref[k] > 0
                    ? Math.min(maxGain, carrierLevel / ref[k])
                    : (env > 0 ? Math.min(maxGain, target / env) : 0);
                gain += smooth * (want - gain);
                buf[k] = y * gain;
            }
        }
        this.env = env;
        this.referredGain = gain;
    }
}

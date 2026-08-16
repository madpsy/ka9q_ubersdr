// Client-side noise reduction: MMSE log-spectral-amplitude gains over a
// minima-tracked noise estimate.
//
// This replaced a copy of v1's NR2 (plain spectral subtraction), on the
// strength of forty years of literature and every serious SDR's practice:
//
//   * Spectral subtraction makes a hard, independent decision per bin per
//     frame, and bins flickering around the noise estimate are exactly the
//     "musical noise" it is notorious for. Here each bin gets a *gain* from
//     the MMSE-LSA estimator (Ephraim & Malah 1985), with the a-priori SNR
//     smoothed across frames by the decision-directed rule — gains evolve
//     instead of switching, and the twinkle never forms. This is the
//     algorithm in WDSP's EMNR, which is the NR in Thetis, PowerSDR and the
//     KiwiSDR — the sound most operators mean by "good SDR noise reduction".
//
//   * NR2 spent its first half second "learning", trusting that the moment
//     you tuned in was silence — tune onto a loud net and the voices became
//     the noise profile. Here the noise is tracked continuously from spectral
//     minima (MCRA, Cohen & Berdugo 2002): speech has pauses, so the running
//     minimum of each bin's smoothed power rides the noise floor whatever is
//     being said over it. No learning phase, no assumption about when you
//     arrived, drifting noise tracked as it drifts. resetLearning() survives
//     only as an accelerator — a retune converges within the minima window
//     anyway; the reset just skips the wait.
//
//   * NR2 used a 2048-point FFT — a 170 ms window at 12 kHz, which smears
//     syllables and is most of what "watery" meant. This uses 512 (43 ms),
//     the speech-enhancement standard. Narrowband modes that genuinely want
//     long windows have the server's inserts.
//
//   * Analysis and synthesis both use the square root of a periodic Hann at
//     50% overlap, which overlap-adds to exactly one — unity gain by
//     construction. (NR2 windowed once on the learning path and twice on the
//     processed path, so the level dropped ~2.5 dB the moment learning
//     finished.)
//
// One honest behaviour change worth knowing: a carrier that sits truly steady
// for longer than the minima window is indistinguishable from noise and fades
// toward the gain floor. That is EMNR's behaviour too, and it is usually the
// point — heterodynes and birdies melt away — but it is why a dead carrier
// "disappears" while anything modulated does not.
//
// Pure DSP: no AudioContext, Float32Arrays in and out, testable in node. The
// ScriptProcessor wrapping lives in radio/audio-player.js.

// Cooley-Tukey radix-2 FFT — static/fft.js verbatim, minus the windows nothing
// here uses.
export class FFT {
    constructor(size) {
        this.size = size;
        this.halfSize = size / 2;

        this.cosTable = new Float32Array(this.halfSize);
        this.sinTable = new Float32Array(this.halfSize);
        for (let i = 0; i < this.halfSize; i++) {
            const angle = -2 * Math.PI * i / size;
            this.cosTable[i] = Math.cos(angle);
            this.sinTable[i] = Math.sin(angle);
        }

        this.reverseTable = new Uint32Array(size);
        const bits = Math.log2(size);
        for (let i = 0; i < size; i++) {
            let x = i;
            let y = 0;
            for (let b = 0; b < bits; b++) {
                y = (y << 1) | (x & 1);
                x >>= 1;
            }
            this.reverseTable[i] = y;
        }
    }

    forward(real, imag) {
        for (let i = 0; i < this.size; i++) {
            const j = this.reverseTable[i];
            if (j > i) {
                let temp = real[i];
                real[i] = real[j];
                real[j] = temp;
                temp = imag[i];
                imag[i] = imag[j];
                imag[j] = temp;
            }
        }

        for (let size = 2; size <= this.size; size *= 2) {
            const halfSize = size / 2;
            const tableStep = this.size / size;
            for (let i = 0; i < this.size; i += size) {
                for (let j = i, k = 0; j < i + halfSize; j++, k += tableStep) {
                    const l = j + halfSize;
                    const tpre = real[l] * this.cosTable[k] - imag[l] * this.sinTable[k];
                    const tpim = real[l] * this.sinTable[k] + imag[l] * this.cosTable[k];
                    real[l] = real[j] - tpre;
                    imag[l] = imag[j] - tpim;
                    real[j] += tpre;
                    imag[j] += tpim;
                }
            }
        }
    }

    inverse(real, imag) {
        for (let i = 0; i < this.size; i++) imag[i] = -imag[i];
        this.forward(real, imag);
        const scale = 1.0 / this.size;
        for (let i = 0; i < this.size; i++) {
            real[i] *= scale;
            imag[i] *= -scale;
        }
    }
}

// The panel's controls. Strength is the depth of the cut — the floor the
// per-bin gain may fall to — because that is the one number whose effect is
// unmistakable on every band. The estimator's own constants are not offered:
// they interact, and every published implementation ships them fixed.
export const NR_DEFAULTS = {
    enabled: false,
    // 'lsa' is this file; 'nr2' is lib/nr2.js, the classic engine kept for
    // narrowband work and for A/B against this one.
    type: 'lsa',
    strength: 40,       // lsa: gain floor −6…−30 dB; nr2: over-subtraction
    makeupDb: 0,        // plain output gain; LSA loses little level, so 0
    // NR2's own knobs, unused by the LSA engine.
    floor: 10,
    adaptRate: 1.0,
};

// ---- estimator constants (Cohen & Berdugo 2002, Ephraim & Malah 1985) -------

const A_SMOOTH = 0.75;      // power spectrum smoothing across time
const MIN_WIN_S = 0.75;     // minima sub-window; effective window is 1–2×
const DELTA = 5;            // smoothed power this far over the minimum = speech
const A_PRESENCE = 0.3;     // speech-presence probability smoothing
const A_NOISE = 0.95;       // noise recursion when the bin looks like noise
const A_DD = 0.98;          // decision-directed a-priori SNR smoothing
const XI_MIN = 0.0032;      // a-priori SNR floor, −25 dB
const GAMMA_MAX = 1e4;      // a-posteriori SNR clamp, +40 dB

// E1(x), the exponential integral, as the LSA gain needs it. Abramowitz &
// Stegun 5.1.53 (series, x ≤ 1) and 5.1.56 (rational, x > 1) — the same pair
// every EMNR implementation carries.
export function expint(x) {
    if (x <= 0) return 30;                    // caller clamps; cap the blow-up
    if (x > 30) return 0;                     // exp(-30) — nothing left
    if (x <= 1) {
        return -Math.log(x) - 0.57721566
            + x * (0.99999193 + x * (-0.24991055 + x * (0.05519968
            + x * (-0.00976004 + x * 0.00107857))));
    }
    const num = x * x + 2.334733 * x + 0.250621;
    const den = x * x + 3.330657 * x + 1.681534;
    return (Math.exp(-x) / x) * (num / den);
}

export class NRProcessor {
    constructor(sampleRate = 12000, fftSize = 512) {
        this.sampleRate = sampleRate;
        this.fftSize = fftSize;
        this.hopSize = fftSize / 2;
        this.bins = fftSize / 2 + 1;

        this.fft = new FFT(fftSize);

        // √Hann (periodic) for analysis and synthesis both: their product is
        // a periodic Hann, which at 50% overlap sums to exactly 1.
        this.window = new Float32Array(fftSize);
        for (let i = 0; i < fftSize; i++) {
            this.window[i] = Math.sqrt(0.5 * (1 - Math.cos((2 * Math.PI * i) / fftSize)));
        }

        this.inputBuffer = new Float32Array(fftSize);
        this.outputBuffer = new Float32Array(fftSize);
        this.real = new Float32Array(fftSize);
        this.imag = new Float32Array(fftSize);

        // Frames per minima sub-window, scaled by the actual frame rate so
        // the window is the same *seconds* at 12 kHz and 24 kHz.
        this.minFrames = Math.max(8, Math.round((MIN_WIN_S * sampleRate) / this.hopSize));

        this._alloc();

        this.enabled = false;
        this.setParameters(NR_DEFAULTS.strength);
    }

    _alloc() {
        const n = this.bins;
        this.psmooth = new Float32Array(n);   // time-smoothed power
        this.minCur = new Float32Array(n);    // minima, current sub-window
        this.minLast = new Float32Array(n);   // minima, previous sub-window
        this.presence = new Float32Array(n);  // speech-presence probability
        this.noise = new Float32Array(n);     // the estimate itself
        this.prevGain = new Float32Array(n).fill(1);
        this.prevGamma = new Float32Array(n).fill(1);
        this.gain = new Float32Array(n);
        this.power = new Float32Array(n);
        this.frame = 0;
    }

    /** Strength 0–100 → the floor the per-bin gain may fall to. */
    setParameters(strength) {
        const s = Math.max(0, Math.min(100, Number(strength) || 0));
        const floorDb = -(6 + 0.24 * s);      // 0% → −6 dB, 100% → −30 dB
        this.gainFloor = Math.pow(10, floorDb / 20);
    }

    // A retune converges on its own inside the minima window; this skips the
    // wait by letting the next few frames re-seed the estimate.
    resetLearning() {
        this._alloc();
        this.inputBuffer.fill(0);
        this.outputBuffer.fill(0);
    }

    process(input, output) {
        if (!this.enabled) {
            output.set(input);
            return;
        }

        const inputLength = input.length;
        let inputPos = 0;
        let outputPos = 0;

        while (inputPos < inputLength) {
            const take = Math.min(this.hopSize, inputLength - inputPos);

            for (let i = 0; i < this.fftSize - take; i++) {
                this.inputBuffer[i] = this.inputBuffer[i + take];
            }
            for (let i = 0; i < take; i++) {
                this.inputBuffer[this.fftSize - take + i] = input[inputPos + i];
            }

            this.processFrame();

            const give = Math.min(this.hopSize, output.length - outputPos);
            for (let i = 0; i < give; i++) {
                output[outputPos + i] = this.outputBuffer[i];
            }

            for (let i = 0; i < this.fftSize - this.hopSize; i++) {
                this.outputBuffer[i] = this.outputBuffer[i + this.hopSize];
            }
            for (let i = this.fftSize - this.hopSize; i < this.fftSize; i++) {
                this.outputBuffer[i] = 0;
            }

            inputPos += take;
            outputPos += give;
        }
    }

    processFrame() {
        const N = this.fftSize;
        const bins = this.bins;

        for (let i = 0; i < N; i++) {
            this.real[i] = this.inputBuffer[i] * this.window[i];
            this.imag[i] = 0;
        }
        this.fft.forward(this.real, this.imag);

        for (let k = 0; k < bins; k++) {
            this.power[k] = this.real[k] * this.real[k] + this.imag[k] * this.imag[k];
        }

        // ---- noise tracking (MCRA) --------------------------------------
        //
        // Smooth the power over frequency (3 taps) and time, run each bin's
        // minimum over a sliding window, and call a bin "speech" while it
        // stands well over its own minimum. The noise recursion then averages
        // hard while the bin looks like noise and holds while it does not —
        // which is what lets voices sit *on top of* the estimate without ever
        // being pulled into it.
        const roll = this.frame > 0 && this.frame % this.minFrames === 0;
        for (let k = 0; k < bins; k++) {
            const lo = k > 0 ? this.power[k - 1] : this.power[k];
            const hi = k < bins - 1 ? this.power[k + 1] : this.power[k];
            const pf = 0.25 * lo + 0.5 * this.power[k] + 0.25 * hi;

            if (this.frame < 4) {
                // Seed everything from the first frames — a starting estimate
                // of zero would call the entire first second "speech".
                this.psmooth[k] = pf;
                this.noise[k] = pf;
                this.minCur[k] = pf;
                this.minLast[k] = pf;
                continue;
            }

            this.psmooth[k] = A_SMOOTH * this.psmooth[k] + (1 - A_SMOOTH) * pf;

            if (roll) {
                this.minLast[k] = this.minCur[k];
                this.minCur[k] = this.psmooth[k];
            } else if (this.psmooth[k] < this.minCur[k]) {
                this.minCur[k] = this.psmooth[k];
            }
            const smin = Math.min(this.minCur[k], this.minLast[k]);

            const speech = this.psmooth[k] > DELTA * Math.max(smin, 1e-20) ? 1 : 0;
            this.presence[k] = A_PRESENCE * this.presence[k] + (1 - A_PRESENCE) * speech;

            const ad = A_NOISE + (1 - A_NOISE) * this.presence[k];
            this.noise[k] = ad * this.noise[k] + (1 - ad) * this.power[k];
        }

        // ---- gains (decision-directed MMSE-LSA) -------------------------
        for (let k = 0; k < bins; k++) {
            const noise = Math.max(this.noise[k], 1e-20);
            let gamma = this.power[k] / noise;
            if (gamma > GAMMA_MAX) gamma = GAMMA_MAX;

            let xi = A_DD * this.prevGain[k] * this.prevGain[k] * this.prevGamma[k]
                + (1 - A_DD) * Math.max(gamma - 1, 0);
            if (xi < XI_MIN) xi = XI_MIN;

            const v = (xi / (1 + xi)) * gamma;
            let g = (xi / (1 + xi)) * Math.exp(0.5 * expint(v));
            if (!(g >= this.gainFloor)) g = this.gainFloor;  // NaN lands here too
            if (g > 1) g = 1;

            this.prevGain[k] = g;
            this.prevGamma[k] = gamma;
            this.gain[k] = g;
        }

        for (let k = 0; k < bins; k++) {
            this.real[k] *= this.gain[k];
            this.imag[k] *= this.gain[k];
        }
        // Mirror for negative frequencies (real FFT symmetry)
        for (let i = N / 2 + 1; i < N; i++) {
            const m = N - i;
            this.real[i] = this.real[m];
            this.imag[i] = -this.imag[m];
        }

        this.fft.inverse(this.real, this.imag);

        for (let i = 0; i < N; i++) {
            this.outputBuffer[i] += this.real[i] * this.window[i];
        }
        this.frame++;
    }
}

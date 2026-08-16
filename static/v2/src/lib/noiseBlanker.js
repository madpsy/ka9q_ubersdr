// Client-side noise blanker: impulse noise cut out before it reaches the ear.
//
// The target is short broadband clicks — power-line arcing, ignition, electric
// fences, static crashes — which are milliseconds wide but tens of dB proud of
// the band. A blanker's whole job is to remove exactly those samples and
// nothing else, which makes it orthogonal to noise *reduction*: NR models the
// steady noise floor and subtracts it, and an impulse is precisely what such a
// model must not learn. The two are therefore composable — blank first, reduce
// after — and the panel offers them as independent switches.
//
// This is the classic design, and deliberately nothing more than it:
//
//   1. a slow average of |x| — what the band sounds like;
//   2. a sample more than `thresholdDb` over that average is an impulse;
//   3. blank a fixed `widthMs` around it, and go back to watching.
//
// Step 3 is the part worth defending, because getting it wrong is what makes a
// blanker unusable. The blank is a **one-shot of fixed length**, not a gate
// held shut until things go quiet. An earlier version of this file held the
// cut until a short envelope fell back near the average, on the reasoning that
// a crash is audible for twenty milliseconds and not one. It did remove more
// of each crash — and it also meant that one trigger on a loud syllable held
// the audio shut for the rest of the word, which is not a blanker
// misbehaving, it is a downward expander working correctly. On a real 40 m
// voice channel it was unusable.
//
// With a fixed one-shot, an occasional false trigger costs two milliseconds
// and nobody hears it. That is the whole reason a blanker can afford to be
// sensitive, and it is why every hardware one works this way.
//
// Two other pieces earn their place:
//
//   * the audio runs through a short delay line, so a pulse is detected
//     *before* the delayed copy of it reaches the output — the cut covers the
//     whole click, leading edge included, where blanking forward from the
//     detection leaves the loudest part already played;
//   * each sample's contribution to the average is clamped, so a run of
//     pulses cannot inflate the average they are measured against — the
//     classic failure on pulse trains, where the first click raises the floor
//     and the rest walk through.
//
// Consecutive samples over the threshold extend the cut on their own, which is
// why the width wants to stay short: it is the *shortest* blank, not the
// length of every blank.
//
// Measured on 74 s of 10.125 MHz USB with static crashes every few seconds and
// 49 s of a 40 m voice channel, both from the same receiver, at 48 kHz. "Loud
// parts" is the energy in blocks standing more than 10 dB over the median —
// the crashes in one recording, the syllables in the other:
//
//   threshold  blank    crash loud parts   voice loud parts   the rest
//     12 dB     2 ms        -21.2 dB           -0.8 dB         -1.1 dB
//     15 dB     2 ms        -13.0 dB           -0.4 dB         -0.3 dB
//     18 dB     2 ms         -7.1 dB           -0.2 dB        -0.09 dB
//     21 dB     2 ms         -4.4 dB           -0.1 dB        -0.03 dB
//
// The default is deliberately at the quiet end of that — 19 dB and a 4 ms
// blank, chosen by ear on a live band rather than off the table. A blanker
// that has to be turned down to be liked is a better default than one that
// has to be turned down to be *usable*: the numbers say a low threshold takes
// more of the crash, and the ear says the cost of a wrong trigger is worth
// more than the table implies. 12 dB is there for a band where the crashes
// matter more than the last decibel of everything else.
//
// The honest limit, for anyone tempted to wind it further down: a blanker on
// demodulated, AGC'd, band-limited audio has already lost the wideband view
// that makes a hardware IF blanker work. Gaussian peaks alone reach about
// 12 dB over the mean of |x|, so below that it is gating the band rather than
// the noise on it.
//
// Pure DSP: no AudioContext, Float32Arrays in and out, testable in node. The
// ScriptProcessor wrapping lives in radio/audio-player.js.

export const NB_DEFAULTS = {
    enabled: false,
    thresholdDb: 19,    // how far over the running average an impulse must stand
    widthMs: 4,         // the shortest blank, ramps included
};

export const NB_THRESHOLD_MIN = 8;
export const NB_THRESHOLD_MAX = 24;
export const NB_WIDTH_MIN = 0.5;
export const NB_WIDTH_MAX = 10;

// The average: slow enough that speech rides on it rather than dragging it
// about, and long against any blank.
const ENV_TC_S = 0.05;
// A sample may contribute at most this multiple of the current average — the
// clamp that stops impulses raising their own threshold.
const ENV_CLAMP = 3;
// No detection while the average finds its feet, and it charges faster than it
// tracks while it does.
const WARMUP_S = 0.15;
const WARMUP_ALPHA = 1 / 32;
// No detection below this average (-60 dBFS). A threshold *relative* to the
// average is meaningless when the average is silence: with the squelch closed
// the stream is decoder residue around -100 dBFS, every flutter of which is
// "20 dB over", and the blanker sat there triggering on audio nobody could
// hear.
const SILENCE = 1e-3;
// Coming back from under that floor re-runs a short warmup. The average has to
// climb from nothing to the band's real level, and while it is on the way up
// every ordinary sample stands far over it — so each squelch opening blanked
// its own first syllable.
const RESUME_S = 0.025;
// Ramp either side of a blank, so the cut itself cannot click.
const RAMP_S = 0.0003;

// The trace behind the panel's chart: one bucket per TRACE_MS of audio, a few
// seconds of them. Each bucket keeps how far the loudest sample in it stood
// over the average, in dB, and what share of it was cut — a share rather than
// a flag, because a flag set by one sample in four hundred paints the whole
// bar red and says the burst was removed when almost none of it was.
export const TRACE_MS = 10;
export const TRACE_LEN = 300;      // 3 seconds
const TRACE_MIN_DB = -6;
const TRACE_MAX_DB = 40;

// Time constant for the "how much is being removed" readouts.
const CUT_TC_S = 3;

export class NoiseBlanker {
    constructor(sampleRate = 12000) {
        this.sampleRate = sampleRate;
        this.enabled = false;
        this.thresholdDb = NB_DEFAULTS.thresholdDb;
        this.widthMs = NB_DEFAULTS.widthMs;

        this.envAlpha = 1 / Math.max(1, Math.round(ENV_TC_S * sampleRate));
        this.warmupSamples = Math.round(WARMUP_S * sampleRate);
        this.resumeSamples = Math.round(RESUME_S * sampleRate);

        // Impulses blanked, the share of the audio being removed, and what
        // that costs in level — the last measured across the stage itself
        // rather than inferred from the gate, because a blanker that counts
        // pulses and reduces nothing reads 0.0 dB here.
        this.pulsesBlanked = 0;
        this.cutFraction = 0;
        this.reductionDb = 0;
        this._sumIn = 0;
        this._sumOut = 0;

        this.traceDb = new Float32Array(TRACE_LEN).fill(TRACE_MIN_DB);
        this.traceCut = new Uint8Array(TRACE_LEN);
        this.traceHead = 0;
        this._bucketSamples = Math.max(1, Math.round((TRACE_MS / 1000) * sampleRate));

        this._rebuild();
    }

    setParameters({ thresholdDb = null, widthMs = null } = {}) {
        if (thresholdDb !== null) this.thresholdDb = Number(thresholdDb);
        this._ratio = Math.pow(10, this.thresholdDb / 20);
        if (widthMs !== null && Number(widthMs) !== this.widthMs) {
            this.widthMs = Number(widthMs);
            this._rebuild();
        }
    }

    // Sized from the width: the blank spans a plateau with a cosine ramp either
    // side, the delay is exactly the reach-back it needs, and the rest of the
    // state hangs off those lengths.
    _rebuild() {
        const fs = this.sampleRate;
        const half = Math.max(1, Math.round((this.widthMs / 2000) * fs));
        const ramp = Math.max(2, Math.round(fs * RAMP_S));

        this._pre = half + ramp;                       // reach-back = latency
        this._post = half + ramp;
        const n = this._pre + this._post + 1;

        // The blank, hung centred on the sample that fired it. Precomputed:
        // firing is then a min() per entry rather than trigonometry.
        this._shape = new Float32Array(n);
        for (let j = 0; j < n; j++) {
            if (j < ramp) {
                this._shape[j] = 0.5 * (1 + Math.cos((Math.PI * (j + 1)) / (ramp + 1)));
            } else if (j >= n - ramp) {
                this._shape[j] = 0.5 * (1 + Math.cos((Math.PI * (n - j)) / (ramp + 1)));
            } else {
                this._shape[j] = 0;
            }
        }

        this._delay = this._pre;
        this._buf = new Float32Array(this._delay);
        // The gain each of the next n outputs will be multiplied by, consumed
        // and reset to 1 as each goes past. min()-merged when something fires,
        // so overlapping blanks join into one longer cut rather than fighting.
        this._sched = new Float32Array(n).fill(1);
        this._t = 0;

        this._ratio = Math.pow(10, this.thresholdDb / 20);
        this._env = 0;
        this._warm = 0;
        this._quiet = true;     // under the silence floor just now
        this._hold = 0;         // resume-warmup samples left
        this._openFor = 1e9;    // samples since the last trigger, for counting

        this._bucketLeft = this._bucketSamples;
        this._bucketPeak = 0;
        this._bucketRef = 0;
        this._bucketCut = 0;
    }

    reset() {
        this._rebuild();
        this.pulsesBlanked = 0;
        this.cutFraction = 0;
        this.reductionDb = 0;
        this._sumIn = 0;
        this._sumOut = 0;
        this.traceDb.fill(TRACE_MIN_DB);
        this.traceCut.fill(0);
        this.traceHead = 0;
    }

    process(input, output) {
        if (!this.enabled) {
            // Bypassed entirely — no delay, no average. The line picks up
            // fresh when re-enabled, which is what reset() guarantees.
            output.set(input);
            return;
        }

        const buf = this._buf;
        const sched = this._sched;
        const shape = this._shape;
        const L = this._delay;
        const L2 = sched.length;
        let cut = 0;

        for (let i = 0; i < input.length; i++) {
            const x = input[i];
            const ax = x < 0 ? -x : x;

            // Coming back from under the silence floor is a fresh start:
            // whatever the average held is a memory of a different signal.
            if (this._env < SILENCE) this._quiet = true;
            if (this._quiet && ax > SILENCE) {
                this._hold = this.resumeSamples;
                this._quiet = false;
            }

            const warm = this._warm < this.warmupSamples;
            const charging = warm || this._hold > 0;
            if (this._hold > 0) this._hold--;
            const c = charging ? ax : Math.min(ax, Math.max(ENV_CLAMP * this._env, 1e-4));
            this._env += (c - this._env) * (charging ? WARMUP_ALPHA : this.envAlpha);
            if (warm) this._warm++;

            // An impulse: blank a fixed width around it and carry on. Nothing
            // is left armed, nothing is held open, nothing has to be released.
            if (!charging && this._env > SILENCE && ax > this._env * this._ratio) {
                // One count per impulse rather than per sample over the
                // threshold: a single click crosses it several times.
                if (this._openFor > this._pre + this._post) this.pulsesBlanked++;
                this._openFor = 0;
                for (let j = 0; j < L2; j++) {
                    const at = (this._t + j) % L2;
                    if (shape[j] < sched[at]) sched[at] = shape[j];
                }
            } else if (this._openFor < 1e9) {
                this._openFor++;
            }

            const slot = this._t % L;
            const gslot = this._t % L2;
            const gain = sched[gslot];
            if (gain < 0.5) cut++;

            // The chart's bucket: the loudest sample, the average it stood
            // against, and how much of the bucket was cut.
            if (ax > this._bucketPeak) this._bucketPeak = ax;
            if (this._env > this._bucketRef) this._bucketRef = this._env;
            if (gain < 0.5) this._bucketCut++;
            if (--this._bucketLeft <= 0) {
                const ref = Math.max(this._bucketRef, 1e-9);
                const db = 20 * Math.log10(Math.max(this._bucketPeak, 1e-9) / ref);
                this.traceDb[this.traceHead] = Math.max(TRACE_MIN_DB, Math.min(TRACE_MAX_DB, db));
                this.traceCut[this.traceHead] = Math.round(
                    (255 * this._bucketCut) / this._bucketSamples,
                );
                this.traceHead = (this.traceHead + 1) % TRACE_LEN;
                this._bucketLeft = this._bucketSamples;
                this._bucketPeak = 0;
                this._bucketRef = 0;
                this._bucketCut = 0;
            }

            const out = buf[slot] * gain;
            this._sumIn += x * x;
            this._sumOut += out * out;
            output[i] = out;
            sched[gslot] = 1;
            buf[slot] = x;
            this._t++;
        }

        // Once per buffer rather than per sample: these are numbers on a
        // panel, and they settle over seconds either way.
        if (input.length) {
            const a = Math.min(1, input.length / (CUT_TC_S * this.sampleRate));
            this.cutFraction += (cut / input.length - this.cutFraction) * a;
            if (this._sumIn > 0) {
                const db = 10 * Math.log10(Math.max(this._sumOut, 1e-30) / this._sumIn);
                this.reductionDb += (Math.max(-60, db) - this.reductionDb) * a;
            }
            this._sumIn = 0;
            this._sumOut = 0;
        }
    }
}

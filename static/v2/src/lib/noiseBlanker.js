// Client-side noise blanker: impulse noise cut out before it reaches the ear.
//
// The target is short broadband clicks — power-line arcing, ignition, electric
// fences — which are milliseconds wide but tens of dB proud of the band. A
// blanker's whole job is to remove exactly those samples and nothing else,
// which makes it orthogonal to noise *reduction*: NR models the steady noise
// floor and subtracts it, and an impulse is precisely what such a model must
// not learn. The two are therefore composable — blank first, reduce after —
// and the panel offers them as independent switches.
//
// Not v1's design. That one detected a pulse and then attenuated *forward*
// from it, so the rising edge of every click — the part with the energy — had
// already been played by the time the gate closed; and it decided
// "is this broadband?" with an O(N²) DFT per loud sample. This one takes the
// standard hardware-blanker approach instead:
//
//   * the audio runs through a short delay line, so a pulse is detected
//     *before* the delayed copy of it reaches the output — the gate closes
//     over the whole click, leading edge included;
//   * detection is a threshold over a slow envelope of |x| whose update is
//     clamped, so the pulses being caught cannot inflate the average they are
//     measured against (the classic failure on pulse trains: the first click
//     raises the floor and the rest walk through);
//   * the gate is a raised-cosine notch written into a gain schedule, so
//     overlapping detections merge smoothly and the blanking itself cannot
//     click.
//
// The cost is the delay-line latency — around 1.5 ms at the default width —
// which is nothing against the audio buffer it sits inside.
//
// Pure DSP: no AudioContext, Float32Arrays in and out, testable in node. The
// ScriptProcessor wrapping lives in radio/audio-player.js.

export const NB_DEFAULTS = {
    enabled: false,
    thresholdDb: 10,    // how far above the running average a sample must poke
    widthMs: 2,         // total width of the cut, ramps included
};

// The scale is measured, not guessed. Against band noise plus filtered clicks
// at 12 kHz, sweeping the threshold gives (false triggers per second on clean
// noise, then the share of clicks caught at each height over the noise floor):
//
//    6 dB   198/s     — gating the noise itself
//    8 dB    20/s     20 dB: 72%   25 dB: 73%
//    9 dB   2.5/s     20 dB: 84%   25 dB: 97%
//   10 dB   0.1/s     20 dB: 68%   25 dB: 100%
//   12 dB     0/s     20 dB: 26%   25 dB: 99%
//   15 dB     0/s     20 dB:  0%   25 dB: 62%
//
// So the whole working range is 8–12 dB and the knee is at 10, which is the
// default. It shipped at 15 — where nothing but the rarest spike triggers at
// all, so the counter crept up and the audio was untouched, which is exactly
// what it sounded like. Above 14 dB is dead space and is not offered.
//
// The other half of that table is worth knowing before reaching for the
// slider: clicks less than ~15 dB over the floor are not reliably separable
// from the noise's own peaks by any amplitude test, because that is where
// Gaussian peaks live. A blanker on demodulated, AGC'd audio has already lost
// the wideband view that makes an IF blanker work; this catches what is
// plainly a click and leaves what is arguably noise.
export const NB_THRESHOLD_MIN = 4;
export const NB_THRESHOLD_MAX = 20;
export const NB_WIDTH_MIN = 0.5;
export const NB_WIDTH_MAX = 10;

// Time constant for the "how much audio is being removed" readout.
const CUT_TC_S = 3;

// Envelope time constants — asymmetric on purpose. The release (downward) is
// slow against speech syllables, so voice riding the reference does not drag
// it around; the attack (upward) is fast, so audio returning after a stretch
// of squelch-closed silence rebuilds the reference in tens of milliseconds
// rather than blanking the first word. Fast attack does not hand the envelope
// to the impulses — their contribution is clamped below.
const ENV_TC_S = 0.05;
const ENV_ATTACK_TC_S = 0.0125;
// A sample may contribute at most this multiple of the current envelope to the
// average — the clamp that keeps impulses from raising their own threshold.
const ENV_CLAMP = 3;
// Detection is off for the first stretch while the envelope finds the floor,
// and the envelope settles faster than it tracks. In seconds.
const WARMUP_S = 0.15;
const WARMUP_ALPHA = 1 / 32;
// No detection below this envelope (−60 dBFS). A threshold *relative* to the
// reference is meaningless when the reference is silence: with the squelch
// closed the stream is decoder residue around −100 dBFS, every flutter of
// which is "20 dB over the average", and the blanker sat there triggering
// constantly on audio nobody could hear. Below this level there is nothing to
// protect an ear from; a real signal is orders of magnitude above it, and the
// fast attack has the envelope over the bar within milliseconds of the
// squelch opening.
const SILENCE = 1e-3;
// How long detection stays off after audio returns from under the silence
// floor. The envelope has to climb from "nothing" back to the band's real
// level, and while it is still on the way up every ordinary sample is far
// "over the average" — so each squelch opening blanked its own first
// syllable and flashed the tag. The reference is simply stale at that
// moment; this re-runs a short warmup to rebuild it, the same answer the
// first samples of the session get.
const RESUME_S = 0.025;

export class NoiseBlanker {
    constructor(sampleRate = 12000) {
        this.sampleRate = sampleRate;
        this.enabled = false;
        this.thresholdDb = NB_DEFAULTS.thresholdDb;
        this.widthMs = NB_DEFAULTS.widthMs;

        this.envAlpha = 1 / Math.max(1, Math.round(ENV_TC_S * sampleRate));
        this.envAlphaUp = 1 / Math.max(1, Math.round(ENV_ATTACK_TC_S * sampleRate));
        this.warmupSamples = Math.round(WARMUP_S * sampleRate);
        this.resumeSamples = Math.round(RESUME_S * sampleRate);

        // How many pulses the gate has closed on, and what share of the audio
        // it is currently removing. The second is the one that answers "is
        // this doing anything" — a count can climb while the cut is nothing.
        this.pulsesBlanked = 0;
        this.cutFraction = 0;

        this._rebuild();
    }

    setParameters({ thresholdDb = null, widthMs = null } = {}) {
        if (thresholdDb !== null) {
            this.thresholdDb = Number(thresholdDb);
            this._ratio = Math.pow(10, this.thresholdDb / 20);
        }
        if (widthMs !== null && Number(widthMs) !== this.widthMs) {
            this.widthMs = Number(widthMs);
            this._rebuild();
        }
    }

    // Sized from the width: the notch spans a plateau of the full width with a
    // cosine ramp either side, the delay is exactly the reach-back the notch
    // needs, and all of the state hangs off those lengths.
    _rebuild() {
        const fs = this.sampleRate;
        const halfW = Math.max(1, Math.round((this.widthMs / 2000) * fs));
        const ramp = Math.max(2, Math.round(fs * 0.0005));   // 0.5 ms each side

        this._pre = halfW + ramp;                            // reach-back = latency
        this._post = halfW + ramp;
        const n = this._pre + this._post + 1;

        // The notch, hung centred on the detected sample: ramp down, zero
        // plateau, ramp up. Precomputed once — a detection is then a min()
        // per entry, not trig.
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
        // Gain for the output emitted at each of the next L2 steps; consumed
        // and reset to 1 as each step passes. min()-merged on detection, so
        // pulse trains extend the cut rather than fighting over it.
        this._sched = new Float32Array(this._delay + this._post + 1).fill(1);
        this._t = 0;

        this._ratio = Math.pow(10, this.thresholdDb / 20);
        this._env = 0;
        this._warm = 0;
        this._quiet = true;     // under the silence floor just now
        this._hold = 0;         // resume-warmup samples left
    }

    reset() {
        this._rebuild();
        this.pulsesBlanked = 0;
        this.cutFraction = 0;
    }

    process(input, output) {
        if (!this.enabled) {
            // Bypassed entirely — no delay, no envelope. The line picks up
            // fresh when re-enabled, which is what reset() guarantees.
            output.set(input);
            return;
        }

        let cut = 0;

        const buf = this._buf;
        const sched = this._sched;
        const shape = this._shape;
        const L = this._delay;
        const L2 = sched.length;
        const startK = L - this._pre;     // 0 by construction, kept for clarity

        for (let i = 0; i < input.length; i++) {
            const x = input[i];
            const ax = x < 0 ? -x : x;

            // Coming back from under the silence floor is a fresh start:
            // whatever the envelope held is a memory of a different signal,
            // so it is re-charged and detection waits — see RESUME_S.
            if (this._env < SILENCE) this._quiet = true;
            if (this._quiet && ax > SILENCE) {
                this._hold = this.resumeSamples;
                this._quiet = false;
            }

            // Envelope, clamped — except while (re)warming, where it charges
            // straight from the samples. The clamp has a floor besides: near
            // silence a pure multiple of the envelope could never climb.
            const warm = this._warm < this.warmupSamples;
            const charging = warm || this._hold > 0;
            if (this._hold > 0) this._hold--;
            const c = charging ? ax : Math.min(ax, Math.max(ENV_CLAMP * this._env, 1e-4));
            const alpha = charging ? WARMUP_ALPHA
                : (c > this._env ? this.envAlphaUp : this.envAlpha);
            this._env += (c - this._env) * alpha;
            if (warm) this._warm++;

            // A pulse: schedule the notch over the delayed stream.
            if (!charging && this._env > SILENCE && ax > this._env * this._ratio) {
                if (sched[(this._t + L) % L2] === 1) this.pulsesBlanked++;
                for (let j = 0; j < shape.length; j++) {
                    const at = (this._t + startK + j) % L2;
                    if (shape[j] < sched[at]) sched[at] = shape[j];
                }
            }

            // Emit the delayed sample through this step's gate, then recycle
            // both slots.
            const slot = this._t % L;
            const gslot = this._t % L2;
            if (sched[gslot] < 0.5) cut++;
            output[i] = buf[slot] * sched[gslot];
            sched[gslot] = 1;
            buf[slot] = x;
            this._t++;
        }

        // Once per buffer rather than per sample: the readout is a percentage
        // on a panel, and it settles over seconds either way.
        if (input.length) {
            const a = Math.min(1, input.length / (CUT_TC_S * this.sampleRate));
            this.cutFraction += (cut / input.length - this.cutFraction) * a;
        }
    }
}

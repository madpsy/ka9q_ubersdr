// Demodulating the quadrature stream in the browser.
//
// In `iq` mode the server stops demodulating and sends the raw baseband — 12 kHz
// of RF as a stereo pair, left I and right Q, lossless (websocket.go forces
// pcm-zstd on the mode whatever format the socket asked for, so the phase
// relationship survives). Until now the only things that read it were the
// recorder, which writes it to a file, and the DRM decoder, which hands it to a
// subprocess. This is the third: a demodulator that runs here.
//
// What that buys is the one thing the server cannot offer, because the server
// demodulates one channel at the dial: you can listen *anywhere inside the
// 12 kHz*, at a bandwidth of your own, without retuning and without asking the
// receiver for anything. The dial stays where it is, the stream stays as it is,
// and the demodulator moves. That is the whole point of the panel — see
// panels/IQPanel.jsx — and it is why the offset is a control rather than a
// setting.
//
// It is experimental in the honest sense: the arithmetic below is textbook and
// correct, but it is a few hundred lines of JavaScript against a receiver whose
// own demodulators are ka9q-radio's, and nobody should mistake the two.
//
// ── How it works ─────────────────────────────────────────────────────────────
//
// One structure serves every mode, because a complex baseband makes them all the
// same shape:
//
//   1. A complex NCO multiplies the pair by e^(-j2*pi*c*t), sliding the piece of
//      spectrum at IQ offset `c` down to zero.
//   2. A real-coefficient FIR low-pass runs over I and Q separately. On a
//      complex signal that is a *band*-pass centred on `c` — and, unlike a
//      band-pass on real audio, it keeps one side of the carrier and discards
//      the other rather than folding them together. That is what makes SSB
//      here easier than SSB from demodulated audio, not harder: the analytic
//      signal is given, so no Hilbert transform is needed anywhere.
//   3. The mode's own step: a second NCO and a real part (SSB and CW), a
//      magnitude (AM), or a phase difference (NFM).
//
// So each mode is three numbers — where to centre the filter, how wide to make
// it, and how far to translate what comes out — and planFor() is the whole of
// the difference between them. See there for the derivation of each.
//
// The cost is small enough not to need a worklet: 12 000 complex samples a
// second through a few hundred taps is a handful of megaflops, and it runs in
// the same tap callback the recorder uses (AudioPlayer.onAudio), which delivers
// the decoded planes before volume, mute and ducking at the stream's own rate.
//
// ── Why the engine is not in the panel ───────────────────────────────────────
//
// A collapsed dock section is unmounted. A demodulator that lived in the panel
// would stop the moment somebody folded it away — leaving the receiver in IQ,
// playing the broadband noise the duck was hiding, with no control on screen to
// explain it. So the engine is a plain object with the same lifetime as the
// page, exactly as lib/recorder.js and lib/measureTool.js are, and the panel is
// a view over it. components/IQDemodWatch.jsx is the piece that can see the
// mode and the volume, and it is mounted in App.jsx for the same reason.

import { Emitter } from '../radio/emitter.js';

// The plain `iq` preset is 12 kHz wide, centred on the dial: radiod's samprate
// is 12k and the passband is -6k..+6k (see MODES in radio/constants.js, which
// matches the preset exactly and explains why). Everything here is expressed as
// an offset from the dial in hertz, so this is the edge of what can be reached.
export const IQ_HALF_SPAN = 6000;
export const IQ_SPAN = IQ_HALF_SPAN * 2;

/**
 * The demodulators, and the filter widths each is offered.
 *
 * `widths` are the buttons; the slider between them reaches everything in
 * `min`..`max`, so the presets are a shortcut and never a limit. They are the
 * widths an operator actually asks for by name — 2.7 kHz for voice, 500 Hz for
 * CW — rather than a linear spread, because the point of a preset is that it is
 * the number you would have typed.
 *
 * `width` means the width of the *radio* passband in every mode, so 2.7 kHz of
 * USB is 2.7 kHz of spectrum above the offset and 6 kHz of AM is 3 kHz either
 * side of it. That is the figure a receiver's filter is named for, and making
 * one mode mean something else would make the number unreadable.
 */
export const DEMOD_MODES = [
    {
        id: 'usb',
        label: 'USB',
        summary: 'Upper sideband — the passband sits above the offset.',
        widths: [1800, 2400, 2700, 3200, 4000],
        min: 300,
        max: 6000,
        fallback: 2700,
    },
    {
        id: 'lsb',
        label: 'LSB',
        summary: 'Lower sideband — the passband sits below the offset.',
        widths: [1800, 2400, 2700, 3200, 4000],
        min: 300,
        max: 6000,
        fallback: 2700,
    },
    {
        id: 'cw',
        label: 'CW',
        summary: 'Narrow filter on the carrier, heard as a tone at the pitch you set.',
        widths: [100, 250, 500, 1000],
        min: 50,
        max: 2000,
        fallback: 500,
    },
    {
        id: 'am',
        label: 'AM',
        summary: 'Envelope detector — the passband straddles the carrier.',
        widths: [4000, 6000, 8000, 10000],
        min: 1000,
        max: 12000,
        fallback: 6000,
    },
    {
        id: 'nfm',
        label: 'NFM',
        summary: 'Narrowband FM discriminator, with 750 µs de-emphasis.',
        widths: [6000, 8000, 10000, 12000],
        min: 2000,
        max: 12000,
        fallback: 8000,
    },
];

export const DEMOD_BY_ID = Object.fromEntries(DEMOD_MODES.map((m) => [m.id, m]));

export const PITCH_MIN = 300;
export const PITCH_MAX = 1200;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** The mode record, falling back to USB rather than throwing on a stale setting. */
export function demodMode(id) {
    return DEMOD_BY_ID[id] || DEMOD_BY_ID.usb;
}

/** The width this mode will accept, for a stored or typed figure. */
export function clampWidth(modeId, widthHz) {
    const m = demodMode(modeId);
    const w = Number(widthHz);
    if (!Number.isFinite(w)) return m.fallback;
    return clamp(Math.round(w), m.min, m.max);
}

/**
 * Where the passband lands, as offsets from the dial.
 *
 * The asymmetry is the mode's own: a sideband receiver's filter hangs off the
 * carrier on one side, and everything else straddles it. This is what the panel
 * draws and what the offset limits below are derived from, so the two cannot
 * disagree about where the filter is.
 */
export function passbandFor(modeId, offsetHz, widthHz) {
    const w = clampWidth(modeId, widthHz);
    const off = Number(offsetHz) || 0;
    switch (demodMode(modeId).id) {
        case 'usb': return { lo: off, hi: off + w };
        case 'lsb': return { lo: off - w, hi: off };
        default: return { lo: off - w / 2, hi: off + w / 2 };
    }
}

/**
 * How far the offset may travel before the passband hangs off the end of the
 * stream.
 *
 * Refused rather than allowed-and-empty: outside the 12 kHz there is nothing at
 * all, so a filter half over the edge is a filter with half its noise and none
 * of its signal — and, worse, one whose readout still claims a bandwidth it is
 * not receiving. A width too wide for the span at any offset collapses this to a
 * single point at the centre, which is the honest answer.
 */
export function offsetLimits(modeId, widthHz) {
    const w = clampWidth(modeId, widthHz);
    let min;
    let max;
    switch (demodMode(modeId).id) {
        case 'usb': min = -IQ_HALF_SPAN; max = IQ_HALF_SPAN - w; break;
        case 'lsb': min = -IQ_HALF_SPAN + w; max = IQ_HALF_SPAN; break;
        default: min = -IQ_HALF_SPAN + w / 2; max = IQ_HALF_SPAN - w / 2; break;
    }
    if (min > max) {
        const mid = (min + max) / 2;
        return { min: mid, max: mid };
    }
    return { min, max };
}

export function clampOffset(modeId, offsetHz, widthHz) {
    const { min, max } = offsetLimits(modeId, widthHz);
    const off = Number(offsetHz);
    return clamp(Number.isFinite(off) ? Math.round(off) : 0, Math.round(min), Math.round(max));
}

/**
 * The three numbers a mode reduces to, and where the arithmetic is justified.
 *
 * Write `c` for the filter centre, `f` for a component's offset in the stream
 * and `s` for the post-filter translation. Stage 1 moves `f` to `f - c`; stage 3
 * multiplies by e^(+j2*pi*s*t) and takes the real part, which puts it at audio
 * frequency |f - c + s|. Every line below is that equation solved for the
 * mapping the mode is supposed to have.
 *
 *   USB  passband f in [off, off+w]. Want off -> 0 with audio rising as f does.
 *        c = off + w/2 puts the passband symmetrically about the filter, and
 *        s = +w/2 then gives |f - off|: 0 at the carrier, w at the top. The
 *        filter cutoff is w/2 because a complex low-pass of cutoff k passes
 *        k either side of the centre, which is w in total.
 *   LSB  passband [off-w, off]. Same c-and-s pair with s negated: the sign of
 *        the third-stage exponential is what mirrors the spectrum, so a real
 *        conjugation is never needed — Re{conj(z)*e^(jt)} == Re{z*e^(-jt)}.
 *   CW   c = off, s = +pitch. The filter is centred on the carrier and the
 *        carrier comes out at exactly the pitch. Note the consequence, which is
 *        real and deliberate: a symmetric filter passes both sides of the
 *        carrier, so a signal `d` below the offset is heard at pitch-d just as
 *        one `d` above is heard at pitch+d. That is what a direct-conversion CW
 *        receiver does and what a 500 Hz filter means; single-signal reception
 *        would need the filter hung off one side, which trades the image for
 *        putting the carrier on the filter's own skirt.
 *   AM   c = off, envelope. No translation: |z| is already real and already at
 *        baseband, and the DC block downstream is what removes the carrier.
 *   NFM  c = off, phase difference. Likewise.
 */
export function planFor({ mode, offsetHz, widthHz, pitchHz }) {
    const m = demodMode(mode);
    const w = clampWidth(m.id, widthHz);
    const off = clampOffset(m.id, offsetHz, w);
    const half = w / 2;
    switch (m.id) {
        case 'usb':
            return { kind: 'ssb', centreHz: off + half, cutoffHz: half, shiftHz: half };
        case 'lsb':
            return { kind: 'ssb', centreHz: off - half, cutoffHz: half, shiftHz: -half };
        case 'cw':
            return {
                kind: 'ssb',
                centreHz: off,
                cutoffHz: half,
                shiftHz: clamp(Math.round(Number(pitchHz) || 0), PITCH_MIN, PITCH_MAX),
            };
        case 'am':
            return { kind: 'am', centreHz: off, cutoffHz: half, shiftHz: 0 };
        default:
            return { kind: 'fm', centreHz: off, cutoffHz: half, shiftHz: 0 };
    }
}

// ── the filter ───────────────────────────────────────────────────────────────

// Bounds on the FIR length. The floor is what a 6 kHz AM filter needs to have
// any skirt at all; the ceiling is a cost limit, not a design one — 511 taps on
// a complex 12 kHz stream is about twelve million multiplies a second, which is
// a percent or two of one core and as far as this should go inside a WebSocket
// handler.
const TAPS_MIN = 31;
const TAPS_MAX = 511;

// Transition width, as a fraction of the cutoff, bounded either side.
//
// Proportional rather than fixed because the modes differ by two orders of
// magnitude: 400 Hz of skirt is nothing on a 6 kHz AM filter and is wider than
// the whole passband on a 250 Hz CW one. The floor stops a narrow filter asking
// for more taps than the ceiling above allows; the cap stops a wide one being
// needlessly soft.
const TRANSITION_FRACTION = 0.2;
const TRANSITION_MIN = 80;
const TRANSITION_MAX = 400;

/** How many taps a cutoff needs at this rate — odd, so the filter is symmetric. */
export function tapsFor(cutoffHz, rateHz) {
    const transition = clamp(Math.abs(cutoffHz) * TRANSITION_FRACTION, TRANSITION_MIN, TRANSITION_MAX);
    // The usual Blackman-window estimate: about 5.5 periods of the transition,
    // rounded here to 3.3 because the stopband this needs is the -74 dB the
    // window gives rather than anything tighter.
    const n = Math.round((3.3 * rateHz) / transition);
    return clamp(n | 1, TAPS_MIN, TAPS_MAX);
}

/**
 * A windowed-sinc low-pass, normalised to unity gain at DC.
 *
 * Blackman rather than Hamming: the stopband is 30 dB deeper for the same
 * length, and on a receiver the thing on the other side of the skirt is often
 * 40 dB louder than the thing being listened to. Normalising matters more than
 * it looks — without it the passband gain moves with the tap count, so changing
 * the filter width would change the volume.
 */
export function designLowpass(cutoffHz, rateHz) {
    const n = tapsFor(cutoffHz, rateHz);
    const taps = new Float32Array(n);
    const mid = (n - 1) / 2;
    // Never past Nyquist: a "cutoff" above it describes no filter at all, and
    // the sinc would alias into something that is not a low-pass.
    const fc = clamp(Math.abs(cutoffHz), 1, rateHz / 2 - 1) / rateHz;
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const x = i - mid;
        const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
        const w = 0.42
            - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
            + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
        const h = sinc * w;
        taps[i] = h;
        sum += h;
    }
    if (sum !== 0) for (let i = 0; i < n; i++) taps[i] /= sum;
    return taps;
}

// ── the chain ────────────────────────────────────────────────────────────────

// The output the AGC drives towards, well below full scale so a transient has
// somewhere to go before the clip at the end of the chain.
const AGC_TARGET = 0.25;
// Fast enough that a loud signal does not blast, slow enough that speech is not
// flattened between syllables. Decay is what an operator hears as "the noise
// comes up between overs", and 600 ms is the usual compromise.
const AGC_ATTACK_SEC = 0.005;
const AGC_DECAY_SEC = 0.6;
// A ceiling on the gain, so silence does not wind up to full-scale hiss.
const AGC_MAX_GAIN = 300;

// DC blocker corner. Removes the receiver's own centre offset from SSB, the
// carrier from AM, and the tuning error from FM — where it is not a nicety but
// the thing that centres the discriminator.
const DC_CORNER_HZ = 20;

// NFM de-emphasis, 750 us. Transmitters pre-emphasise, so this is a correction
// rather than a tone control; without it narrowband FM is harsh in a way that
// sounds like the demodulator is wrong.
const DEEMPHASIS_SEC = 750e-6;

/**
 * One demodulator's worth of state.
 *
 * Kept out of the engine so it can be tested on its own: hand it a plan, a rate
 * and two arrays, and it hands back audio. It holds phase and filter history
 * across calls, which is the whole reason it is an object — a packet boundary
 * must not be audible.
 */
export class DemodChain {
    constructor() {
        this.rate = 0;
        this.plan = null;
        this.taps = null;
        this.n = 0;
        this.bufI = null;
        this.bufQ = null;
        this.pos = 0;
        this.mixPhase = 0;
        this.shiftPhase = 0;
        this.lastI = 0;
        this.lastQ = 0;
        this.dcX = 0;
        this.dcY = 0;
        this.deY = 0;
        this.env = 0;
        this.out = new Float32Array(0);
        // Published for the meter, and for the panel to show that something is
        // arriving even when the audio is muted.
        this.level = 0;
    }

    /**
     * Point the chain at a new plan.
     *
     * The filter is redesigned only when the cutoff or the rate actually change:
     * dragging the offset slider re-plans sixty times a second and rebuilding
     * five hundred taps each time would be the one expensive thing here. The
     * delay line survives a re-plan for the same reason the phases do — a change
     * of offset should sound like tuning, not like a click.
     */
    configure(plan, rateHz) {
        const rate = rateHz > 0 ? rateHz : 12000;
        const same = this.plan
            && this.rate === rate
            && this.plan.cutoffHz === plan.cutoffHz;
        this.plan = plan;
        this.rate = rate;
        if (same && this.taps) return;
        this.taps = designLowpass(plan.cutoffHz, rate);
        const n = this.taps.length;
        if (n !== this.n) {
            this.n = n;
            // Doubled, and every sample written twice: the convolution is then a
            // straight forward scan of n contiguous elements with no index
            // wrapping inside the inner loop, which is the loop that runs
            // twelve thousand times a second.
            this.bufI = new Float32Array(n * 2);
            this.bufQ = new Float32Array(n * 2);
            this.pos = 0;
        }
    }

    /** Forget everything carried between blocks. Starting is not resuming. */
    reset() {
        if (this.bufI) this.bufI.fill(0);
        if (this.bufQ) this.bufQ.fill(0);
        this.pos = 0;
        this.mixPhase = 0;
        this.shiftPhase = 0;
        this.lastI = 0;
        this.lastQ = 0;
        this.dcX = 0;
        this.dcY = 0;
        this.deY = 0;
        this.env = 0;
        this.level = 0;
    }

    /**
     * One block of quadrature in, one block of audio out.
     *
     * The returned array is reused between calls and is only valid until the
     * next one — the caller copies it into an AudioBuffer immediately, which is
     * the only thing that reads it.
     */
    process(planeI, planeQ, frames, { agc = true, gain = 1 } = {}) {
        if (!this.plan || !this.taps || !frames) return null;
        if (this.out.length < frames) this.out = new Float32Array(frames);
        const out = this.out;

        const { kind, centreHz, shiftHz, cutoffHz } = this.plan;
        const rate = this.rate;
        const n = this.n;
        const taps = this.taps;
        const bufI = this.bufI;
        const bufQ = this.bufQ;

        const mixStep = (-2 * Math.PI * centreHz) / rate;
        const shiftStep = (2 * Math.PI * shiftHz) / rate;
        const dcR = 1 - (2 * Math.PI * DC_CORNER_HZ) / rate;
        const deA = 1 - Math.exp(-1 / (rate * DEEMPHASIS_SEC));
        const atk = 1 - Math.exp(-1 / (rate * AGC_ATTACK_SEC));
        const dec = 1 - Math.exp(-1 / (rate * AGC_DECAY_SEC));
        // Full deviation is half the filter width, which is the definition the
        // width control gives it: a 10 kHz NFM filter is +/-5 kHz of deviation.
        const fmScale = cutoffHz > 0 ? rate / (2 * Math.PI * cutoffHz) : 0;

        let { pos, mixPhase, shiftPhase, lastI, lastQ, dcX, dcY, deY, env } = this;
        let sumSq = 0;

        for (let k = 0; k < frames; k++) {
            // 1 — slide the wanted piece of spectrum down to zero.
            const mc = Math.cos(mixPhase);
            const ms = Math.sin(mixPhase);
            mixPhase += mixStep;
            const rawI = planeI[k];
            const rawQ = planeQ[k];
            const mi = rawI * mc - rawQ * ms;
            const mq = rawI * ms + rawQ * mc;

            // 2 — the complex band-pass, as two real convolutions.
            bufI[pos] = mi;
            bufI[pos + n] = mi;
            bufQ[pos] = mq;
            bufQ[pos + n] = mq;
            pos = pos + 1 === n ? 0 : pos + 1;
            let fi = 0;
            let fq = 0;
            for (let t = 0; t < n; t++) {
                const h = taps[t];
                fi += h * bufI[pos + t];
                fq += h * bufQ[pos + t];
            }

            // 3 — the mode's own step.
            let y;
            if (kind === 'ssb') {
                const sc = Math.cos(shiftPhase);
                const ss = Math.sin(shiftPhase);
                shiftPhase += shiftStep;
                y = fi * sc - fq * ss;
            } else if (kind === 'am') {
                y = Math.sqrt(fi * fi + fq * fq);
            } else {
                // z[k] * conj(z[k-1]): the argument is the phase advanced in one
                // sample, which is the instantaneous frequency. atan2 rather
                // than the small-angle shortcut because at 12 kHz a 3 kHz
                // deviation is a radian and a half per sample, where the
                // approximation is not small and not an approximation.
                const re = fi * lastI + fq * lastQ;
                const im = fq * lastI - fi * lastQ;
                lastI = fi;
                lastQ = fq;
                y = (re === 0 && im === 0) ? 0 : Math.atan2(im, re) * fmScale;
            }

            // DC block. On AM this is what strips the carrier; on FM it is what
            // centres the discriminator, so a few hundred hertz of mistuning
            // stops being a DC step that eats the headroom.
            dcY = y - dcX + dcR * dcY;
            dcX = y;
            y = dcY;

            if (kind === 'fm') {
                deY += deA * (y - deY);
                y = deY;
            }

            const mag = y < 0 ? -y : y;
            env += (mag > env ? atk : dec) * (mag - env);
            if (agc) {
                const g = env > 0 ? Math.min(AGC_MAX_GAIN, AGC_TARGET / env) : 0;
                y *= g;
            }
            y *= gain;

            sumSq += y * y;
            out[k] = y > 1 ? 1 : (y < -1 ? -1 : y);
        }

        this.pos = pos;
        // Wrapped once per block rather than per sample: unbounded phase loses
        // precision after an hour or two of listening, and Math.cos of a number
        // that large is no longer the cosine of the angle meant.
        this.mixPhase = mixPhase % (2 * Math.PI);
        this.shiftPhase = shiftPhase % (2 * Math.PI);
        this.lastI = lastI;
        this.lastQ = lastQ;
        this.dcX = dcX;
        this.dcY = dcY;
        this.deY = deY;
        this.env = env;
        this.level = Math.sqrt(sumSq / frames);
        return out;
    }
}

// ── settings ─────────────────────────────────────────────────────────────────

const KEY = 'ubersdr.v2.iqdemod';

export const DEMOD_DEFAULTS = {
    mode: 'usb',
    offsetHz: 0,
    // One width per mode rather than one width. The modes differ by two orders
    // of magnitude — 500 Hz of CW against 8 kHz of NFM — so a single figure
    // carried across a mode change would be wrong every time, and snapping it to
    // the new mode's default would throw away a choice that was deliberate.
    widths: {},
    pitchHz: 700,
    agc: true,
    gain: 1,
};

const listeners = new Set();
let current = null;
let writeTimer = null;

// The write to storage is deferred; the copy in memory and the notification are
// not.
//
// Every control in the panel is a slider, and a slider being dragged fires an
// event per frame. Persisting on each of those is sixty synchronous writes a
// second of the same two hundred bytes, which on the browsers that back
// localStorage with the disk is a visible stutter on the one control where
// smoothness is the whole point. So the value propagates immediately — the
// engine hears it on the next packet either way — and only the record of it
// waits for the drag to stop.
const WRITE_DELAY_MS = 250;

function persist(value) {
    clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
        writeTimer = null;
        try {
            localStorage.setItem(KEY, JSON.stringify(value));
        } catch (err) { /* private browsing, a full quota — not worth failing over */ }
    }, WRITE_DELAY_MS);
}

function sanitise(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const mode = demodMode(src.mode).id;
    const widths = {};
    for (const m of DEMOD_MODES) {
        const stored = src.widths && src.widths[m.id];
        widths[m.id] = Number.isFinite(Number(stored)) ? clampWidth(m.id, stored) : m.fallback;
    }
    const gain = Number(src.gain);
    return {
        mode,
        widths,
        offsetHz: clampOffset(mode, src.offsetHz, widths[mode]),
        pitchHz: clamp(Math.round(Number(src.pitchHz) || DEMOD_DEFAULTS.pitchHz), PITCH_MIN, PITCH_MAX),
        agc: src.agc !== false,
        gain: Number.isFinite(gain) ? clamp(gain, 0, 4) : 1,
    };
}

/** The stored settings, or the defaults. Read once and then kept in memory. */
export function demodSettings() {
    if (current) return current;
    let raw = null;
    try {
        raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    } catch (err) {
        raw = null;
    }
    current = sanitise(raw);
    return current;
}

/**
 * Merge a change in, persist it, and tell everyone.
 *
 * Through here rather than through the panel's own state because the panel can
 * be on screen twice — docked and floating, or docked and in a phone's sheet —
 * and the second copy has to see a change as it is made. Same shape as
 * lib/scannerSettings.js, for the same reason.
 */
export function saveDemodSettings(patch) {
    const before = demodSettings();
    const merged = sanitise({
        ...before,
        ...patch,
        widths: { ...before.widths, ...(patch && patch.widths) },
    });
    current = merged;
    persist(merged);
    for (const fn of Array.from(listeners)) {
        try { fn(merged); } catch (err) { /* one listener must not cost the others */ }
    }
    return merged;
}

export function onDemodSettings(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** The width in force for the mode currently selected. */
export function activeWidth(settings) {
    const s = settings || demodSettings();
    return clampWidth(s.mode, s.widths[s.mode]);
}

/** Testing seam: forget the cached copy so the next read goes to storage. */
export function resetDemodSettings() {
    clearTimeout(writeTimer);
    writeTimer = null;
    current = null;
}

// ── the engine ───────────────────────────────────────────────────────────────

// How far ahead the first buffer is scheduled. One packet is 20 ms; this is the
// figure DRM and FreeDV arrived at — far enough ahead for the Web Audio
// scheduler, short enough not to clip the first syllable.
const LEAD_IN_SEC = 0.02;
// And how far behind the clock the queue may fall before a block is dropped
// rather than played late. Without a ceiling a tab left in the background
// accumulates delay that never comes back.
const MAX_QUEUE_SEC = 0.5;

/**
 * The demodulator as a thing with a lifetime.
 *
 * Owns the tap on the player, the audio it produces, and the duck that keeps
 * the receiver's own quadrature noise out of the way while it runs. Emits
 * 'change' when any of that changes, which is what the panel re-renders on.
 */
export class IQDemod extends Emitter {
    constructor(player) {
        super();
        this.player = player;
        this.chain = new DemodChain();
        this.active = false;
        // Whether the stream arriving really is a quadrature pair.
        //
        // Separate from `active` because the two genuinely differ for a few
        // seconds at a time. Pressing Start while the receiver is in USB asks
        // for IQ, and asking puts up a confirmation (RadioContext's gateIQ) —
        // so between the press and the answer the demodulator is switched on
        // and the samples arriving are still demodulated audio. Reading those
        // as I and Q would produce a burst of noise over the top of whatever
        // the operator was listening to while they read the dialog.
        //
        // Pushed in from components/IQDemodWatch.jsx, which is the piece that
        // can see the mode.
        this._quad = false;
        // Whether *we* are the one holding the duck down. The player's duck is a
        // single flag several things reach for — the recorder's preview, the DRM
        // panel, this — so asserting `false` on a transition that was never ours
        // would silently un-duck somebody else's. Only our own changes are sent.
        this._ducking = false;
        this.rate = 0;
        this.frames = 0;
        // The mode the operator was in when they pressed Start, so stopping can
        // put them back rather than stranding them in a mode that plays noise.
        // Held here rather than in the panel because the panel is unmounted
        // whenever its dock is collapsed; the panel is what actually calls
        // setMode, since only it can reach the actions.
        this.restoreMode = null;
        this._untap = null;
        this._gain = null;
        this._ctx = null;
        this._nextPlayTime = 0;
        this._volume = 1;
        this._muted = false;
        this._settings = demodSettings();
        this._offSettings = onDemodSettings((s) => {
            this._settings = s;
            this.emit('change');
        });
    }

    get running() {
        return this.active;
    }

    /** Running *and* actually receiving quadrature — what the panel calls live. */
    get quadrature() {
        return this._quad;
    }

    get level() {
        return this.active && this._quad ? this.chain.level : 0;
    }

    get tapCount() {
        return this.chain.n;
    }

    get settings() {
        return this._settings;
    }

    /** The plan in force, for the panel's readouts. */
    get plan() {
        const s = this._settings;
        return planFor({
            mode: s.mode,
            offsetHz: s.offsetHz,
            widthHz: activeWidth(s),
            pitchHz: s.pitchHz,
        });
    }

    start() {
        if (this.active) return;
        this.active = true;
        this.chain.reset();
        this._nextPlayTime = 0;
        this._untap = this.player.onAudio((planes, frames, sampleRate) => {
            this._onAudio(planes, frames, sampleRate);
        });
        this._applyDuck();
        this.emit('change');
    }

    stop() {
        if (!this.active) return;
        this.active = false;
        if (this._untap) this._untap();
        this._untap = null;
        this._applyDuck();
        this.chain.reset();
        this.rate = 0;
        this.frames = 0;
        this._nextPlayTime = 0;
        if (this._gain) {
            try { this._gain.disconnect(); } catch (err) { /* context already gone */ }
            this._gain = null;
            this._ctx = null;
        }
        this.emit('change');
    }

    /**
     * Say whether the stream is quadrature, i.e. whether the receiver is in IQ.
     *
     * Flipping it on resets the chain: what came before was a different mode and
     * carrying its filter history into this one would be a click at best.
     */
    setQuadrature(on) {
        const next = !!on;
        if (next === this._quad) return;
        this._quad = next;
        if (next) {
            this.chain.reset();
            this._nextPlayTime = 0;
        }
        this._applyDuck();
        this.emit('change');
    }

    /**
     * Silence the receiver's own output for exactly as long as this is producing
     * something to hear instead.
     *
     * Required rather than polite once both are true: in IQ what the receiver
     * plays is the raw quadrature pair, which is broadband noise. Same reasoning
     * as the DRM panel's duck — and the same care on the way out, since a duck
     * left on is a receiver that has gone silent for no visible reason.
     */
    _applyDuck() {
        const want = this.active && this._quad;
        if (want === this._ducking) return;
        this._ducking = want;
        this.player.setDucked(want);
    }

    /**
     * The receiver's volume and mute, pushed in from the outside.
     *
     * The demodulated audio is not the receiver's audio and must not go through
     * its filter chain — but it *is* what is being listened to, so it follows the
     * same volume control. This is exactly what the DRM panel does with its own
     * gain node, and for the same reason.
     */
    setOutput(volume, muted) {
        this._volume = Number.isFinite(volume) ? volume : 1;
        this._muted = !!muted;
        const g = this._gain;
        if (g && this._ctx) {
            g.gain.setTargetAtTime(this._muted ? 0 : this._volume, this._ctx.currentTime, 0.015);
        }
    }

    /** Change a setting. Everything goes through the store, so both copies of
     *  the panel and the engine see it at once. */
    set(patch) {
        saveDemodSettings(patch);
    }

    _ensureGain() {
        const ctx = this.player && this.player.ctx;
        if (!ctx || ctx.state === 'closed') return null;
        if (this._gain && this._ctx === ctx) return this._gain;
        const g = ctx.createGain();
        g.gain.value = this._muted ? 0 : this._volume;
        g.connect(ctx.destination);
        this._gain = g;
        this._ctx = ctx;
        // The player rebuilds its context on a format or rate change, and the
        // old schedule is meaningless against the new clock.
        this._nextPlayTime = 0;
        return g;
    }

    _onAudio(planes, frames, sampleRate) {
        if (!this.active || !this._quad || !frames) return;
        // Not a quadrature pair. The mode changing out from under a collapsed
        // panel is what IQDemodWatch is for, but a stream that is not IQ must
        // never be demodulated as though it were even for the one packet it
        // takes to notice — a mono plane read as I with Q taken from the same
        // array is not a signal, it is an artefact of the mistake.
        if (planes.length < 2) return;

        const ctx = this.player.ctx;
        if (!ctx || ctx.state === 'closed') return;
        const gain = this._ensureGain();
        if (!gain) return;

        const rate = sampleRate > 0 ? sampleRate : this.rate || 12000;
        const s = this._settings;
        this.chain.configure(planFor({
            mode: s.mode,
            offsetHz: s.offsetHz,
            widthHz: activeWidth(s),
            pitchHz: s.pitchHz,
        }), rate);

        const audio = this.chain.process(planes[0], planes[1], frames, {
            agc: s.agc,
            gain: s.gain,
        });
        if (!audio) return;

        // Re-asserted rather than set once: the recorder's preview unducks on
        // the way out (see RecorderPanel), and a demodulator that went silently
        // back to hissing after somebody played a recording would be a bug
        // nobody could place. Only ever upwards, and only while this is the
        // thing making the sound — see _applyDuck for the other half of the rule.
        if (!this.player.ducked) this.player.setDucked(true);

        const buffer = ctx.createBuffer(1, frames, rate);
        buffer.copyToChannel(audio.subarray(0, frames), 0);

        const now = ctx.currentTime;
        if (this._nextPlayTime < now) this._nextPlayTime = now + LEAD_IN_SEC;
        else if (this._nextPlayTime - now > MAX_QUEUE_SEC) return;
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(gain);
        src.start(this._nextPlayTime);
        this._nextPlayTime += buffer.duration;

        // Read by the panel's meter. Latched here so the readouts can say what
        // the stream is without the panel having to ask the player.
        if (this.rate !== rate || this.frames !== frames) {
            this.rate = rate;
            this.frames = frames;
            this.emit('change');
        }
    }

    destroy() {
        this.stop();
        if (this._offSettings) this._offSettings();
    }
}

let engine = null;

/** The one demodulator. Built on first use, like the recorder's. */
export function getIQDemod(player) {
    if (!engine) engine = new IQDemod(player);
    return engine;
}

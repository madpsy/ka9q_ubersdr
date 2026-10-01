// FROZEN REFERENCE — do not edit.
//
// lib/iqDemod.js exactly as it was before DemodChain was split into the
// primitives in lib/dsp/. dspequiv.test.js runs this and the live module side by
// side on the same input and requires every output sample to be identical, so
// this file is the definition of "the refactor changed nothing". Only the import
// paths below differ from the original.

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
// SAM and ECSS are the exception, because their oscillator is not a setting: it
// is steered onto the carrier by a phase-locked loop. They share a front end in
// lib/ecss.js, which hands audio and passband power back to the same squelch,
// DC block and AGC every other mode ends in.
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

import { Emitter } from '../../src/radio/emitter.js';
import { fftInPlace, hannWindow } from '../../src/lib/iqSpectrum.js';
import { MIN_BLOCK_SEC } from '../../src/radio/constants.js';
import {
    ECSS_LOW_EDGE, ECSS_TRANSITION, EcssTracker, SIDEBANDS, TRACK_DEFAULT, TRACK_MAX, TRACK_MIN,
} from '../../src/lib/ecss.js';

// The plain `iq` preset is 12 kHz wide, centred on the dial: radiod's samprate
// is 12k and the passband is -6k..+6k (see MODES in radio/constants.js, which
// matches the preset exactly and explains why). Everything here is expressed as
// an offset from the dial in hertz, so this is the edge of what can be reached.
//
// It is the edge *until a stream says otherwise*. A complex stream covers its
// own sample rate, so the wide presets (iq48 upwards) reach ±24 kHz and beyond,
// and the engine moves the edge to match the first time it hears a rate — see
// setIQSpan. This is the starting point, and what is assumed before any packet.
export const IQ_HALF_SPAN = 6000;
export const IQ_SPAN = IQ_HALF_SPAN * 2;

let halfSpan = IQ_HALF_SPAN;

/** How far either side of the dial the stream currently reaches, in hertz. */
export function iqHalfSpan() {
    return halfSpan;
}

/**
 * Follow the stream's sample rate.
 *
 * A change republishes the settings, which runs every demodulator back through
 * sanitise and so clamps any offset the new span cannot reach — going from a
 * 48 kHz stream back to 12 kHz pulls a demodulator at +20 kHz in to the edge,
 * exactly as narrowing a filter does — and tells the panel its limits moved.
 * Returns whether anything changed.
 */
export function setIQSpan(rateHz) {
    const next = rateHz > 0 ? Math.round(rateHz / 2) : IQ_HALF_SPAN;
    if (next === halfSpan) return false;
    halfSpan = next;
    publish(demodSettings());
    return true;
}

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
// The AM family's widths, a sideband at a time — see the note in DEMOD_MODES.
// From 4.5 kHz: a broadcast's audio, which is what these modes are for. Anything
// narrower is still on the slider.
const SIDE_WIDTHS = [4500, 5000, 6000];
const SIDE_WIDE = [8000, 10000];
const SIDE_MIN = 1000;
const SIDE_MAX = 6000;
const SIDE_WIDE_MAX = 10000;
const SIDE_FALLBACK = 4500;

export const DEMOD_MODES = [
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
        id: 'usb',
        label: 'USB',
        summary: 'Upper sideband — the passband sits above the offset.',
        widths: [1800, 2400, 2700, 3200, 4000],
        min: 300,
        max: 6000,
        fallback: 2700,
    },
    {
        id: 'cwl',
        label: 'CW-L',
        summary: 'CW, heard at the pitch you set; a signal above the carrier sounds lower.',
        widths: [100, 250, 500, 1000],
        min: 50,
        max: 2000,
        fallback: 500,
    },
    {
        id: 'cwu',
        label: 'CW-U',
        summary: 'CW, heard at the pitch you set; a signal above the carrier sounds higher.',
        widths: [100, 250, 500, 1000],
        min: 50,
        max: 2000,
        fallback: 500,
    },
    // AM, SAM and ECSS share one scale: the width of a sideband, which is the
    // audio width and the figure a broadcast is described by. AM and SAM keep a
    // total underneath — their filter straddles the carrier — so `sides: 2`
    // says the panel shows half of it. Same buttons, same slider, in all three.
    {
        id: 'am',
        label: 'AM',
        summary: 'Envelope detector — the passband straddles the carrier.',
        widths: SIDE_WIDTHS.map((w) => w * 2),
        min: SIDE_MIN * 2,
        max: SIDE_MAX * 2,
        // On a stream wider than plain IQ's 12 kHz, 8 and 10 kHz a side — the
        // whole of a broadcast's sidebands, where the transmitter sends them.
        wideWidths: SIDE_WIDE.map((w) => w * 2),
        wideMax: SIDE_WIDE_MAX * 2,
        fallback: SIDE_FALLBACK * 2,
        sides: 2,
    },
    {
        id: 'sam',
        label: 'SAM',
        summary: 'Synchronous AM — both sidebands, detected against the tracked carrier.',
        widths: SIDE_WIDTHS.map((w) => w * 2),
        min: SIDE_MIN * 2,
        max: SIDE_MAX * 2,
        wideWidths: SIDE_WIDE.map((w) => w * 2),
        wideMax: SIDE_WIDE_MAX * 2,
        fallback: SIDE_FALLBACK * 2,
        sides: 2,
    },
    {
        id: 'ecss',
        label: 'ECSS',
        summary: 'Exalted-carrier SSB — AM tracked by its carrier, heard on one sideband.',
        // Per sideband already, so 4.5 kHz is the audio a broadcast actually
        // carries and 6 kHz the whole of one side of plain IQ's stream.
        widths: SIDE_WIDTHS,
        min: SIDE_MIN,
        max: SIDE_MAX,
        wideWidths: SIDE_WIDE,
        wideMax: SIDE_WIDE_MAX,
        fallback: SIDE_FALLBACK,
        sides: 1,
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

export { SIDEBANDS, TRACK_DEFAULT, TRACK_MAX, TRACK_MIN };

/** The sideband choices, as the panel offers them. */
export const SIDEBAND_OPTIONS = [
    { value: 'both', label: 'Both', title: 'Both sidebands, weighted frequency by frequency by how clean each is' },
    { value: 'auto', label: 'Auto', title: 'Use whichever sideband has less interference on it' },
    { value: 'lsb', label: 'LSB', title: 'Lower sideband only' },
    { value: 'usb', label: 'USB', title: 'Upper sideband only' },
];

const sidebandOf = (v) => (SIDEBANDS.includes(v) ? v : 'both');

export const DEMOD_BY_ID = Object.fromEntries(DEMOD_MODES.map((m) => [m.id, m]));

export const PITCH_MIN = 300;
export const PITCH_MAX = 1200;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Whether a plan runs through the carrier tracker: SAM and ECSS. */
const isTracked = (plan) => !!plan && (plan.kind === 'ecss' || plan.kind === 'sam');

/** A tracking window the tracker will accept, for a stored or typed figure. */
export function clampTrack(hz) {
    const v = Number(hz);
    return Number.isFinite(v) ? clamp(Math.round(v), TRACK_MIN, TRACK_MAX) : TRACK_DEFAULT;
}

/** The mode record, falling back to USB rather than throwing on a stale setting. */
export function demodMode(id) {
    return DEMOD_BY_ID[LEGACY_MODES[id] || id] || DEMOD_BY_ID.usb;
}

// Modes that have since been renamed, read as what they became. Plain CW was
// always CW-U by the definition below — the pitch rose with the signal — so a
// stored `cw` keeps sounding exactly as it did.
const LEGACY_MODES = { cw: 'cwu' };
// And where their filter widths went: plain CW's to both of its halves.
const LEGACY_WIDTHS = { cwl: 'cw', cwu: 'cw' };

// Whether the stream is wider than plain IQ's 12 kHz, which is what opens the
// AM family's wide widths: on 12 kHz there is no room for 8 kHz a side.
const wideSpan = () => halfSpan > IQ_HALF_SPAN;

/** The widest filter this mode takes on the stream in use. */
export function modeMax(modeId) {
    const m = demodMode(modeId);
    return wideSpan() && m.wideMax ? m.wideMax : m.max;
}

/** The width buttons this mode offers on the stream in use. */
export function modeWidths(modeId) {
    const m = demodMode(modeId);
    return wideSpan() && m.wideWidths ? [...m.widths, ...m.wideWidths] : m.widths;
}

/** The width this mode will accept, for a stored or typed figure. */
export function clampWidth(modeId, widthHz) {
    const m = demodMode(modeId);
    const w = Number(widthHz);
    if (!Number.isFinite(w)) return m.fallback;
    return clamp(Math.round(w), m.min, modeMax(modeId));
}

// The low cut on USB and LSB: where the filter starts, measured from the
// carrier, with the width as where it stops. 50 Hz by default — under the
// lowest voice, over the hum and the carrier leak that sit right on it — and
// never closer than SSB_MIN_SPAN to the top, so there is always a filter.
export const LOW_CUT_DEFAULT = 50;
export const LOW_CUT_MAX = 1000;
export const SSB_MIN_SPAN = 100;

/** A low cut that leaves at least SSB_MIN_SPAN of filter under `widthHz`. */
export function clampLowCut(lowCutHz, widthHz) {
    const v = Number(lowCutHz);
    const top = Math.max(0, Math.min(LOW_CUT_MAX, (Number(widthHz) || 0) - SSB_MIN_SPAN));
    return clamp(Number.isFinite(v) ? Math.round(v) : LOW_CUT_DEFAULT, 0, top);
}

/**
 * Where the passband lands, as offsets from the dial.
 *
 * The asymmetry is the mode's own: a sideband receiver's filter hangs off the
 * carrier on one side, and everything else straddles it. This is what the panel
 * draws and what the offset limits below are derived from, so the two cannot
 * disagree about where the filter is.
 */
export function passbandFor(modeId, offsetHz, widthHz, sideband, lowCutHz = 0) {
    const w = clampWidth(modeId, widthHz);
    const off = Number(offsetHz) || 0;
    const id = demodMode(modeId).id;
    // USB and LSB start their low cut away from the carrier.
    const lc = id === 'usb' || id === 'lsb' ? clampLowCut(lowCutHz, w) : 0;
    switch (id) {
        case 'usb': return { lo: off + lc, hi: off + w };
        case 'lsb': return { lo: off - w, hi: off - lc };
        // ECSS in a fixed sideband is that sideband; Both and Auto use either,
        // so both have to be inside the stream.
        case 'ecss':
            switch (sidebandOf(sideband)) {
                case 'usb': return { lo: off, hi: off + w };
                case 'lsb': return { lo: off - w, hi: off };
                default: return { lo: off - w, hi: off + w };
            }
        default: return { lo: off - w / 2, hi: off + w / 2 };
    }
}

/**
 * How far the offset may travel before the passband hangs off the end of the
 * stream.
 *
 * Refused rather than allowed-and-empty: outside the stream there is nothing at
 * all, so a filter half over the edge is a filter with half its noise and none
 * of its signal — and, worse, one whose readout still claims a bandwidth it is
 * not receiving. A width too wide for the span at any offset collapses this to a
 * single point at the centre, which is the honest answer.
 */
export function offsetLimits(modeId, widthHz, sideband) {
    const w = clampWidth(modeId, widthHz);
    // Derived from the passband rather than restated per mode, so the two
    // cannot disagree.
    const band = passbandFor(modeId, 0, w, sideband);
    let min = -halfSpan - band.lo;
    let max = halfSpan - band.hi;
    if (min > max) {
        const mid = (min + max) / 2;
        return { min: mid, max: mid };
    }
    return { min, max };
}

export function clampOffset(modeId, offsetHz, widthHz, sideband) {
    const { min, max } = offsetLimits(modeId, widthHz, sideband);
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
 *   CW-U c = off, s = +pitch. The filter is centred on the carrier and the
 *        carrier comes out at exactly the pitch; a signal `d` above it is heard
 *        at pitch+d and one `d` below at pitch-d. That is not an image: the
 *        filter is complex, so the two sides are different places and land on
 *        different pitches, and nothing folds over until |d| passes the pitch —
 *        which a filter narrower than twice the pitch never lets it.
 *   CW-L c = off, s = -pitch. Re{z·e^(-jpt)} puts `d` at pitch-d: the same
 *        tone for the carrier, the pitch running the other way. What that is
 *        for is an interferer inside the filter — flipping moves it to the
 *        other side of the wanted tone, which is sometimes further from it.
 *   AM   c = off, envelope. No translation: |z| is already real and already at
 *        baseband, and the DC block downstream is what removes the carrier.
 *   NFM  c = off, phase difference. Likewise.
 *   SAM  c = off is the nominal carrier, as for ECSS below; the tracker's
 *        own filter straddles the carrier it finds, and the chain's DC block
 *        takes the carrier off what comes out.
 *   ECSS c = off is the *nominal carrier*, not a filter centre: the tracker in
 *        lib/ecss.js moves its own oscillator from there onto the carrier it
 *        finds, and hangs its sideband filters off that. The cutoff is carried
 *        for the tap readout; the filter runs from ECSS_LOW_EDGE to w either
 *        side of the carrier.
 */
export function planFor({ mode, offsetHz, widthHz, pitchHz, sideband, trackHz, lowCutHz = 0 }) {
    const m = demodMode(mode);
    const w = clampWidth(m.id, widthHz);
    const off = clampOffset(m.id, offsetHz, w, sideband);
    const half = w / 2;
    // USB and LSB: a filter from the low cut to the width, so centred midway
    // between them and as wide as the gap, and the audio shifted by the same
    // midpoint — the carrier lands at 0 Hz of audio wherever the cut is.
    const lc = clampLowCut(lowCutHz, w);
    const mid = (lc + w) / 2;
    const span = (w - lc) / 2;
    switch (m.id) {
        case 'usb':
            return { kind: 'ssb', centreHz: off + mid, cutoffHz: span, shiftHz: mid };
        case 'lsb':
            return { kind: 'ssb', centreHz: off - mid, cutoffHz: span, shiftHz: -mid };
        case 'cwl':
        case 'cwu':
            return {
                kind: 'ssb',
                centreHz: off,
                cutoffHz: half,
                shiftHz: (m.id === 'cwl' ? -1 : 1)
                    * clamp(Math.round(Number(pitchHz) || 0), PITCH_MIN, PITCH_MAX),
            };
        case 'am':
            return { kind: 'am', centreHz: off, cutoffHz: half, shiftHz: 0 };
        case 'sam':
            return {
                kind: 'sam',
                centreHz: off,
                widthHz: w,
                cutoffHz: half,
                shiftHz: 0,
                trackHz: clampTrack(trackHz),
            };
        case 'ecss':
            return {
                kind: 'ecss',
                centreHz: off,
                widthHz: w,
                cutoffHz: (w - ECSS_LOW_EDGE) / 2,
                transitionHz: ECSS_TRANSITION,
                shiftHz: 0,
                sideband: sidebandOf(sideband),
                trackHz: clampTrack(trackHz),
            };
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

/**
 * How many taps a cutoff needs at this rate — odd, so the filter is symmetric.
 *
 * `transitionHz` overrides the proportional skirt, for a mode that needs a
 * particular one (ECSS, whose rejected sideband starts right at the carrier).
 */
export function tapsFor(cutoffHz, rateHz, transitionHz) {
    const transition = transitionHz > 0
        ? Math.max(TRANSITION_MIN, transitionHz)
        : clamp(Math.abs(cutoffHz) * TRANSITION_FRACTION, TRANSITION_MIN, TRANSITION_MAX);
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
export function designLowpass(cutoffHz, rateHz, transitionHz) {
    const n = tapsFor(cutoffHz, rateHz, transitionHz);
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
// ECSS's carrier-referred level: one sideband of a 100% modulated tone comes
// out at half the carrier's amplitude, so at this gain full modulation peaks
// at 0.75 — louder than the audio AGC's target on typical programme, which
// sits well under full modulation, and still short of the clip.
const ECSS_CARRIER_LEVEL = 1.5;
const ECSS_GAIN_SMOOTH_SEC = 0.02;

// DC blocker corner. Removes the receiver's own centre offset from SSB, the
// carrier from AM, and the tuning error from FM — where it is not a nicety but
// the thing that centres the discriminator.
const DC_CORNER_HZ = 20;

// NFM de-emphasis, 750 us. Transmitters pre-emphasise, so this is a correction
// rather than a tone control; without it narrowband FM is harsh in a way that
// sounds like the demodulator is wrong.
const DEEMPHASIS_SEC = 750e-6;

// ── squelch ──────────────────────────────────────────────────────────────────
//
// Measured on the filtered complex signal, between stages 2 and 3, and that
// choice is the whole design.
//
// It is the power *in this demodulator's passband*, which is the only quantity
// that means the same thing in all five modes: an SSB detector's output level
// says nothing about whether anything is there when the AGC has just wound the
// noise up to the same amplitude a voice would have, and an FM discriminator's
// output is loudest when there is no carrier at all. Taken before the mode's own
// step and before the AGC, the figure is simply how much energy is arriving
// between the filter's skirts — so one threshold behaves the same way whichever
// demodulator it is set on, and moving the offset onto a signal raises it.
//
// It is in dBFS, referred the same way lib/iqSpectrum.js refers the picture: the
// low-pass has unity gain at DC, so a full-scale carrier inside the passband
// reads 0 dB in both. That is what lets the panel draw the threshold as a line
// across the passband on the spectrum — see squelchLineDb there for the one
// correction that needs, which is a bandwidth one and not a reference one.
//
// The floor of the range is "off" rather than a threshold nothing can reach: an
// operator who has dragged the slider to the bottom means the squelch to be out
// of the way, and a control with a separate switch beside it would be two
// gestures for one decision.
//
// -60 dB is where that floor sits, and it is a statement about this stream
// rather than about decibels. What arrives here is 12 kHz of baseband at the
// receiver's own scaling, and everything a squelch is ever set between — the
// noise in a voice passband and the signals standing out of it — is in the top
// sixty decibels of full scale. A range reaching down to the quantisation floor
// would spend most of the slider's travel below anything that ever happens,
// which is most of its precision thrown away at exactly the place the control
// needs it.
export const SQUELCH_OFF = -60;
export const SQUELCH_MAX = 0;

// How far the level has to fall back before the gate shuts again. Without it a
// signal sitting on the threshold chops the audio into fragments at the rate the
// envelope wanders, which is the one failure that makes a squelch worse than no
// squelch.
const SQUELCH_HYSTERESIS_DB = 3;

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
const SQUELCH_HANG_SEC = 0.5;

// The detector's own smoothing, asymmetric for the same reason.
//
// Three milliseconds up, so the level is at the signal within a syllable's
// onset and the gate opens on the first thing said rather than the second.
// Fifty down, so it does not follow the troughs of a modulated signal into the
// hysteresis and back out again between one word and the next.
const SQUELCH_ATTACK_SEC = 0.003;
const SQUELCH_DECAY_SEC = 0.05;

// And the gate's own edges, which exist only to keep it from clicking.
//
// Two milliseconds open — far below anything the ear places, so the gate is
// instant in every sense that matters and still not a step discontinuity —
// against fifteen shut, where there is no hurry and the slower fade is the
// quieter one.
const SQUELCH_OPEN_SEC = 0.002;
const SQUELCH_SHUT_SEC = 0.015;

// What the level reads when there is nothing at all, rather than -Infinity —
// which is not a number a slider or a canvas can be given.
export const SQUELCH_SILENT_DB = -160;

// The bottom of the row's signal meter, in dBFS, and it is the squelch's floor
// on purpose rather than by coincidence.
//
// The threshold is drawn as a mark on this meter, so the two are one scale or
// they are nothing: a meter reaching further down than the slider could put a
// mark in only the top part of the bar, and one reaching less far would clamp
// thresholds an operator can still set. Sharing the figure makes the mark's
// travel and the fill's travel the same travel, which is what lets the bar be
// read as "how far over the threshold is it".
export const SIGNAL_FLOOR_DB = SQUELCH_OFF;

/**
 * A passband level as a fraction of the row's meter, 0..1.
 *
 * Exported and pure because it is used twice over and the two have to agree:
 * once for the bar itself, and once for the mark on it showing where the
 * squelch is set. A threshold drawn on a different scale from the level it is a
 * threshold for would be worse than no mark at all.
 */
export function signalMeter(db) {
    if (db == null || !Number.isFinite(db)) return 0;
    return clamp((db - SIGNAL_FLOOR_DB) / -SIGNAL_FLOOR_DB, 0, 1);
}

// ── the decimating front end ─────────────────────────────────────────────────
//
// The chain below was written for plain IQ's 12 kHz, where running its filter
// on every sample costs nothing. On a wide preset it runs on every sample of 48
// to 384 kHz instead, and at the 511-tap ceiling that is the whole budget: two
// AM demodulators on IQ 192 measured 27% of a core each in node and took the
// main thread with them in Chrome, so the audio played for a few seconds and
// stopped.
//
// Nothing a demodulator listens to is wider than 12 kHz, so on a wide stream
// each chain first mixes its own passband down to zero, low-passes it with a
// short filter, and keeps every Dth sample — evaluating the filter only at the
// samples it keeps. The chain proper then runs exactly as it did, at
// WORK_RATE_MIN or a little over. What comes out is demodulated audio at that
// rate, which Web Audio resamples to the context's; the IQ stream itself is
// untouched, and is what the recorder and the picture still see.

// The rate a chain works at, at least. 24 kHz rather than 12: up to plain IQ's
// widths the passband reaches ±7.2 kHz from its own centre at most (12 kHz of
// SAM, plus the tracker's 1.2 kHz of pull either way), and the front filter
// needs room to roll off between that and the alias of the next band down.
export const WORK_RATE_MIN = 24000;
// The front filter's pass edge, at least. Everything a chain reads is inside
// it; what folds back past the decimation lands between here and the working
// Nyquist, outside every chain's own passband, where its filter takes it away.
const FRONT_PASS_HZ = 8000;
// What the front filter is given to roll off in, beyond twice its pass edge.
const FRONT_ROLLOFF_HZ = 8000;

/**
 * How far from its own centre a plan's passband reaches, in Hz.
 *
 * What sets the front end's pass edge. Only the wide widths go past 8 kHz —
 * 10 kHz a side of AM, or of ECSS hung off a carrier the tracker may have
 * pulled 1.2 kHz away — and those are why the working rate is not fixed.
 */
export function reachOf(plan) {
    if (!plan) return 0;
    const pull = plan.trackHz ? plan.trackHz * 1.2 : 0;
    switch (plan.kind) {
        case 'ecss': return plan.widthHz + pull;
        case 'sam': return plan.widthHz / 2 + pull;
        default: return plan.cutoffHz;
    }
}

/** The front filter's pass edge for a plan. */
function frontPassFor(plan) {
    return Math.max(FRONT_PASS_HZ, Math.ceil(reachOf(plan) + 500));
}

/**
 * How many input samples each working sample stands for. 1 on plain IQ, and
 * wherever the rate leaves no room to keep fewer: the working rate has to hold
 * the plan's pass edge twice over, plus the front filter's roll-off.
 */
export function decimationFor(rateHz, plan) {
    const need = 2 * frontPassFor(plan) + FRONT_ROLLOFF_HZ;
    return Math.max(1, Math.floor(rateHz / need));
}

/** The rate a chain's demodulator actually runs at, for this stream and plan. */
export function workingRate(rateHz, plan) {
    const rate = rateHz > 0 ? rateHz : 12000;
    return rate / decimationFor(rate, plan);
}

// The audio spectrum's transform: 1024 points, so 11.7 Hz a bin at 12 kHz and
// 23 Hz at the 24 kHz a wide stream is demodulated at — fine enough to see the
// shape of a voice inside a 2.7 kHz filter, and 85 ms or less of history.
export const AUDIO_FFT_SIZE = 1024;
const AUDIO_WINDOW = hannWindow(AUDIO_FFT_SIZE);
const AUDIO_WINDOW_SUM = AUDIO_WINDOW.reduce((a, b) => a + b, 0);

/**
 * The audio a demodulator's filter lets through, in Hz of audio — what its row's
 * audio spectrum spans, so the picture follows the width as it is changed.
 *
 * Always from 0 Hz, so the left edge of every row's picture means the same
 * thing. A sideband mode hears up to the width; AM, SAM and NFM half of their
 * total, the audio each side carries; CW up to its pitch plus half the filter,
 * so the note sits where it sounds.
 */
export function audioBandOf(vfo) {
    const w = vfoWidth(vfo);
    switch (demodMode(vfo.mode).id) {
        case 'usb':
        case 'lsb':
        case 'ecss':
            return { lo: 0, hi: w };
        case 'cwl':
        case 'cwu': {
            const pitch = clamp(Math.round(Number(vfo.pitchHz) || 0), PITCH_MIN, PITCH_MAX);
            return { lo: 0, hi: pitch + w / 2 };
        }
        default:
            return { lo: 0, hi: w / 2 };
    }
}

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
        // The stream's own rate, and the front end's state. `rate` above is the
        // one the demodulator runs at; the two differ only on a wide preset.
        this.inRate = 0;
        this.D = 1;
        this.baseHz = 0;
        this.frontKey = '';
        this.frontTaps = null;
        this.frontN = 0;
        this.fbI = null;
        this.fbQ = null;
        this.fpos = 0;
        this.fcount = 0;
        this.rotRe = 1;
        this.rotIm = 0;
        this.dI = new Float32Array(0);
        this.dQ = new Float32Array(0);
        // How many samples the last block produced, at `rate`.
        this.outFrames = 0;
        // The last AUDIO_FFT_SIZE samples of what this demodulator put out, for
        // the open row's audio spectrum — see audioSpectrum.
        this.scope = new Float32Array(AUDIO_FFT_SIZE);
        this.scopePos = 0;
        this.scopeRe = null;
        this.scopeIm = null;
        this.scopeDb = null;
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
        this.sigPow = 0;
        this.gateOn = true;
        this.gateGain = 1;
        this.hang = 0;
        this.out = new Float32Array(0);
        // Published for the meter, and for the panel to show that something is
        // arriving even when the audio is muted. Taken before the squelch, for
        // the same reason: a gate that has shut is a thing to show, not a
        // reason to stop measuring.
        this.level = 0;
        // The squelch's own two readings — how much is in the passband, in
        // dBFS, and whether that is currently enough. Both are drawn by the
        // panel: the level as a marker on the threshold slider, and the gate
        // as the state of the row.
        this.sigDb = SQUELCH_SILENT_DB;
        this.gateOpen = true;
        // The ECSS tracker, built the first time the mode is chosen, and the
        // two per-sample arrays it hands back to the common back end.
        this.ecss = null;
        this.ecssY = new Float32Array(0);
        this.ecssP = new Float32Array(0);
        this.ecssR = new Float32Array(0);
        // ECSS levels against the carrier, and its gain is smoothed so moving
        // between that and the audio AGC (a lock gained or lost) is not a step.
        this.ecssGain = 0;
        this.tapsKey = '';
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
        const inRate = rateHz > 0 ? rateHz : 12000;
        const D = decimationFor(inRate, plan);
        const rate = inRate / D;
        const pass = frontPassFor(plan);
        // SAM and ECSS share the tracker, and moving between them keeps the
        // carrier: it is the same carrier either way.
        const entering = isTracked(plan) && !isTracked(this.plan);
        this.plan = plan;
        this.rate = rate;
        this.inRate = inRate;
        this.D = D;
        // The front end mixes the plan's centre to zero, so the rest of the
        // chain mixes by whatever is left — nothing, outside the tracker.
        this.baseHz = D > 1 ? plan.centreHz : 0;
        if (D > 1) {
            const fkey = `${inRate}/${D}/${pass}`;
            if (fkey !== this.frontKey || !this.frontTaps) {
                this.frontKey = fkey;
                // Cut off midway between the pass edge and where the next band
                // down folds onto it; the transition is the whole of that gap.
                const stop = rate - pass;
                this.frontTaps = designLowpass((pass + stop) / 2, inRate, stop - pass);
                this.frontN = this.frontTaps.length;
                this.fbI = new Float32Array(this.frontN * 2);
                this.fbQ = new Float32Array(this.frontN * 2);
                this.fpos = 0;
                this.fcount = 0;
            }
        }
        const key = `${plan.cutoffHz}/${plan.transitionHz || 0}/${rate}`;
        if (key !== this.tapsKey || !this.taps) {
            this.tapsKey = key;
            this.taps = designLowpass(plan.cutoffHz, rate, plan.transitionHz);
        }
        if (isTracked(plan)) {
            // The tracker keeps its own delay lines; arriving in the mode is a
            // fresh search, not the tail of a carrier found some time ago.
            if (!this.ecss) this.ecss = new EcssTracker();
            if (entering) this.ecss.reset();
            this.ecss.configure(plan, rate, (cutoffHz, transitionHz) => designLowpass(cutoffHz, rate, transitionHz), this.baseHz);
            return;
        }
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

    /**
     * The spectrum of what this demodulator has lately put out — the audio,
     * after the squelch, as heard. dBFS per bin from DC to the working Nyquist,
     * `binHz` apart. The array is reused between calls.
     *
     * Computed only when asked: the panel asks once a frame, and only for a row
     * that is open.
     */
    audioSpectrum() {
        const n = AUDIO_FFT_SIZE;
        if (!this.scopeRe) {
            this.scopeRe = new Float64Array(n);
            this.scopeIm = new Float64Array(n);
            this.scopeDb = new Float32Array(n / 2);
        }
        const re = this.scopeRe;
        const im = this.scopeIm;
        const win = AUDIO_WINDOW;
        let p = this.scopePos;
        for (let i = 0; i < n; i++) {
            re[i] = this.scope[p] * win[i];
            im[i] = 0;
            p = p + 1 === n ? 0 : p + 1;
        }
        fftInPlace(re, im);
        // A full-scale sine reads 0 dBFS: the window's coherent gain, and the
        // half of a real signal's power that lands in the negative bins.
        const norm = 2 / AUDIO_WINDOW_SUM;
        const db = this.scopeDb;
        for (let k = 0; k < n / 2; k++) {
            const m = Math.hypot(re[k], im[k]) * norm;
            db[k] = m > 1e-9 ? 20 * Math.log10(m) : -180;
        }
        return { db, binHz: (this.rate || 12000) / n };
    }

    /** Forget everything carried between blocks. Starting is not resuming. */
    reset() {
        this.scope.fill(0);
        this.scopePos = 0;
        if (this.fbI) this.fbI.fill(0);
        if (this.fbQ) this.fbQ.fill(0);
        this.fpos = 0;
        this.fcount = 0;
        this.rotRe = 1;
        this.rotIm = 0;
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
        this.sigPow = 0;
        // Open, so starting never clips the first syllable. With a squelch set
        // and nothing arriving it shuts again within a few tens of
        // milliseconds, which is the right way round for the two mistakes.
        this.gateOn = true;
        this.gateGain = 1;
        this.hang = 0;
        this.sigDb = SQUELCH_SILENT_DB;
        this.gateOpen = true;
        if (this.ecss) this.ecss.reset();
        this.ecssGain = 0;
    }

    /**
     * What the ECSS tracker is doing, for the panel's readout; null in every
     * other mode.
     */
    get ecssStatus() {
        const e = this.ecss;
        if (!e || !isTracked(this.plan)) return null;
        return {
            state: e.state,
            locked: e.locked,
            carrierHz: e.locked ? e.readoutHz : e.state === 'acquire' ? e.carrierHz : null,
            // SAM has no sideband to report: it always hears both, equally.
            side: this.plan.kind === 'sam' ? null
                : this.plan.sideband === 'both' ? 'both' : e.side,
        };
    }

    /**
     * Mix the plan's centre to zero, low-pass and keep every Dth sample, into
     * dI/dQ. Returns how many were kept.
     *
     * The oscillator is a rotating phasor rather than a cos and a sin per
     * sample — at 384 kHz the trigonometry alone would be most of the cost —
     * renormalised once a block so rounding cannot grow it. The decimation
     * count carries across blocks, since a packet need not be a multiple of D.
     */
    _front(planeI, planeQ, frames) {
        const D = this.D;
        const n = this.frontN;
        const taps = this.frontTaps;
        const bI = this.fbI;
        const bQ = this.fbQ;
        const max = Math.ceil(frames / D) + 1;
        if (this.dI.length < max) {
            this.dI = new Float32Array(max);
            this.dQ = new Float32Array(max);
        }
        const dI = this.dI;
        const dQ = this.dQ;
        const step = (-2 * Math.PI * this.baseHz) / this.inRate;
        const sRe = Math.cos(step);
        const sIm = Math.sin(step);
        let pr = this.rotRe;
        let pi = this.rotIm;
        let pos = this.fpos;
        let count = this.fcount;
        let m = 0;
        for (let k = 0; k < frames; k++) {
            const rawI = planeI[k];
            const rawQ = planeQ[k];
            const mi = rawI * pr - rawQ * pi;
            const mq = rawI * pi + rawQ * pr;
            const nr = pr * sRe - pi * sIm;
            pi = pr * sIm + pi * sRe;
            pr = nr;
            bI[pos] = mi;
            bI[pos + n] = mi;
            bQ[pos] = mq;
            bQ[pos + n] = mq;
            pos = pos + 1 === n ? 0 : pos + 1;
            if (++count < D) continue;
            count = 0;
            let fi = 0;
            let fq = 0;
            for (let t = 0; t < n; t++) {
                const h = taps[t];
                fi += h * bI[pos + t];
                fq += h * bQ[pos + t];
            }
            dI[m] = fi;
            dQ[m] = fq;
            m++;
        }
        const mag = Math.hypot(pr, pi) || 1;
        this.rotRe = pr / mag;
        this.rotIm = pi / mag;
        this.fpos = pos;
        this.fcount = count;
        return m;
    }

    /**
     * One block of quadrature in, one block of audio out.
     *
     * The returned array is reused between calls and is only valid until the
     * next one — the caller copies it into an AudioBuffer immediately, which is
     * the only thing that reads it.
     */
    process(planeI, planeQ, frames, { agc = true, gain = 1, squelchDb = SQUELCH_OFF } = {}) {
        this.outFrames = 0;
        if (!this.plan || !this.taps || !frames) return null;
        // On a wide stream, the front end first: everything below then reads
        // the decimated pair, at `rate`.
        if (this.D > 1) {
            frames = this._front(planeI, planeQ, frames);
            planeI = this.dI;
            planeQ = this.dQ;
            if (!frames) return null;
        }
        this.outFrames = frames;
        if (this.out.length < frames) this.out = new Float32Array(frames);
        const out = this.out;

        const { kind, centreHz, shiftHz, cutoffHz } = this.plan;
        const rate = this.rate;
        const n = this.n;
        const taps = this.taps;
        const bufI = this.bufI;
        const bufQ = this.bufQ;

        // ECSS runs its own front end — carrier tracking and the sideband
        // filters — and hands back audio and passband power per sample, which
        // then go through the same squelch, DC block and AGC as everything else.
        const ecss = isTracked(this.plan);
        if (ecss) {
            if (this.ecssY.length < frames) {
                this.ecssY = new Float32Array(frames);
                this.ecssP = new Float32Array(frames);
                this.ecssR = new Float32Array(frames);
            }
            this.ecss.process(planeI, planeQ, frames, this.ecssY, this.ecssP, this.ecssR);
        }
        const ey = this.ecssY;
        const ep = this.ecssP;
        const er = this.ecssR;
        const egA = 1 - Math.exp(-1 / (rate * ECSS_GAIN_SMOOTH_SEC));
        let ecssGain = this.ecssGain;

        const mixStep = (-2 * Math.PI * (centreHz - this.baseHz)) / rate;
        const shiftStep = (2 * Math.PI * shiftHz) / rate;
        const dcR = 1 - (2 * Math.PI * DC_CORNER_HZ) / rate;
        const deA = 1 - Math.exp(-1 / (rate * DEEMPHASIS_SEC));
        const atk = 1 - Math.exp(-1 / (rate * AGC_ATTACK_SEC));
        const dec = 1 - Math.exp(-1 / (rate * AGC_DECAY_SEC));
        // Full deviation is half the filter width, which is the definition the
        // width control gives it: a 10 kHz NFM filter is +/-5 kHz of deviation.
        const fmScale = cutoffHz > 0 ? rate / (2 * Math.PI * cutoffHz) : 0;

        // The squelch, in the units the inner loop can use: powers rather than
        // decibels, and per-sample coefficients rather than seconds. All of it
        // is computed here so the loop itself carries no logarithms.
        const squelching = squelchDb > SQUELCH_OFF;
        const openPow = 10 ** (squelchDb / 10);
        const shutPow = 10 ** ((squelchDb - SQUELCH_HYSTERESIS_DB) / 10);
        const hangSamples = Math.round(rate * SQUELCH_HANG_SEC);
        const sigAtk = 1 - Math.exp(-1 / (rate * SQUELCH_ATTACK_SEC));
        const sigDec = 1 - Math.exp(-1 / (rate * SQUELCH_DECAY_SEC));
        const gateUp = 1 - Math.exp(-1 / (rate * SQUELCH_OPEN_SEC));
        const gateDown = 1 - Math.exp(-1 / (rate * SQUELCH_SHUT_SEC));

        let { pos, mixPhase, shiftPhase, lastI, lastQ, dcX, dcY, deY, env } = this;
        let { sigPow, gateOn, gateGain, hang } = this;
        let sumSq = 0;

        for (let k = 0; k < frames; k++) {
            let y;
            let sigNow;
            if (ecss) {
                y = ey[k];
                sigNow = ep[k];
            } else {
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

                // The squelch's measurement, taken here because this is the only
                // point in the chain where the number means "how much is in the
                // passband" rather than "how loud the mode made it". Power rather
                // than magnitude: the comparison is against a squared threshold, so
                // the square root belongs once per block and not once per sample.
                sigNow = fi * fi + fq * fq;

                // 3 — the mode's own step.
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
            }

            // The squelch, on the passband power whichever front end measured it.
            sigPow += (sigNow > sigPow ? sigAtk : sigDec) * (sigNow - sigPow);
            if (squelching) {
                if (sigPow >= openPow) {
                    // Instantly, and from wherever the gate was: a signal over
                    // the threshold opens it and hands it the whole hang again.
                    gateOn = true;
                    hang = hangSamples;
                } else if (sigPow < shutPow) {
                    // Between the two thresholds nothing is decided — that gap
                    // is the hysteresis — and below the lower one the hang has
                    // to run out before the gate shuts.
                    if (hang > 0) hang--;
                    else gateOn = false;
                }
            }
            const want = squelching ? (gateOn ? 1 : 0) : 1;
            gateGain += (want > gateGain ? gateUp : gateDown) * (want - gateGain);

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
            if (agc && ecss) {
                // Against the carrier while there is one to trust, against the
                // audio otherwise — see CARRIER_LEVEL_SEC in lib/ecss.js.
                const want = er[k] > 0
                    ? Math.min(AGC_MAX_GAIN, ECSS_CARRIER_LEVEL / er[k])
                    : (env > 0 ? Math.min(AGC_MAX_GAIN, AGC_TARGET / env) : 0);
                ecssGain += egA * (want - ecssGain);
                y *= ecssGain;
            } else if (agc) {
                const g = env > 0 ? Math.min(AGC_MAX_GAIN, AGC_TARGET / env) : 0;
                y *= g;
            }
            y *= gain;

            // Measured before the gate and heard after it: the meter goes on
            // saying what the demodulator is producing while the squelch is
            // holding it back, which is what makes a threshold set by eye
            // possible at all.
            sumSq += y * y;
            y *= gateGain;
            out[k] = y > 1 ? 1 : (y < -1 ? -1 : y);
        }

        // Kept for the audio spectrum. A copy of a few hundred floats a block,
        // which is nothing beside the filter that made them.
        const ring = this.scope;
        const rn = ring.length;
        let rp = this.scopePos;
        for (let k = 0; k < frames; k++) {
            ring[rp] = out[k];
            rp = rp + 1 === rn ? 0 : rp + 1;
        }
        this.scopePos = rp;

        this.pos = pos;
        this.ecssGain = ecssGain;
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
        this.sigPow = sigPow;
        this.gateOn = gateOn;
        this.gateGain = gateGain;
        this.hang = hang;
        this.level = Math.sqrt(sumSq / frames);
        this.sigDb = sigPow > 0
            ? Math.max(SQUELCH_SILENT_DB, 10 * Math.log10(sigPow))
            : SQUELCH_SILENT_DB;
        this.gateOpen = !squelching || gateOn;
        return out;
    }
}

// ── settings ─────────────────────────────────────────────────────────────────

const KEY = 'ubersdr.v2.iqdemod';

/**
 * How many demodulators may run at once.
 *
 * Six, and the two limits it sits between are worth naming because neither is
 * where you would guess.
 *
 * The arithmetic is not the binding one. Six of the narrowest CW filter — the
 * most expensive case there is, at 511 taps — is about seventy million
 * multiplies a second over a 12 kHz complex stream, which is a few percent of
 * one core. Six is not close to the edge of that; sixty would be.
 *
 * The panel is. Six rows is as many as a dock column can hold and still be read
 * at a glance rather than scrolled, and that only became true once a row could
 * be collapsed: with every row's controls always showing, four was already a
 * list. So the limit is a judgement about how much of this a person can hold in
 * their head at once, not about what the machine will do.
 *
 * Raising it further would want more than a bigger number. Six distinct colours
 * is already at the point where the hues have to be helped along by the numbers
 * on the markers, and the mix would need a look — see the note on the graph
 * below about nothing scaling with the voice count.
 */
export const MAX_VFOS = 6;

/**
 * Numbered rather than lettered, unlike the receiver's own VFOs.
 *
 * A–D already means something on this receiver: the four frequency memories in
 * lib/vfos.js, which are places the *dial* can be, one at a time. These are not
 * those. They are demodulators inside one stream, all live together, and reusing
 * the letters would put two different four-item vocabularies on one screen.
 */
export const VFO_LABELS = ['1', '2', '3', '4', '5', '6'];

/**
 * Where each one is sent.
 *
 * The point of more than one demodulator is hearing them at once, and two voices
 * in the same ear is not hearing two voices — it is hearing neither. Putting one
 * left and one right is what makes a pair of them usable, and it is what an
 * operator with two receivers has always done.
 */
export const PANS = [
    { value: 'left', label: 'L', title: 'Left ear only' },
    { value: 'center', label: 'C', title: 'Both ears' },
    { value: 'right', label: 'R', title: 'Right ear only' },
];

const PAN_VALUES = PANS.map((p) => p.value);

const VFO_DEFAULTS = {
    mode: 'usb',
    offsetHz: 0,
    // One width per mode rather than one width. The modes differ by two orders
    // of magnitude — 500 Hz of CW against 8 kHz of NFM — so a single figure
    // carried across a mode change would be wrong every time, and snapping it to
    // the new mode's default would throw away a choice that was deliberate.
    widths: {},
    pitchHz: 700,
    // USB and LSB only: where the filter starts, from the carrier. See
    // LOW_CUT_DEFAULT.
    lowCutHz: LOW_CUT_DEFAULT,
    // ECSS only. Both sidebands and the window a click on the picture needs,
    // so the mode works on arrival and neither has to be touched.
    sideband: 'both',
    trackHz: TRACK_DEFAULT,
    agc: true,
    gain: 1,
    // Off, and deliberately: a squelch is a thing you reach for on a quiet
    // channel, and one set by default would be a demodulator that is silent on
    // arrival with nothing on screen saying why.
    squelchDb: SQUELCH_OFF,
    pan: 'center',
    // The output device, by the id the browser gives it, or '' to go wherever
    // the receiver's own audio goes. Pan still applies on a device of its own:
    // two demodulators can share one pair of headphones, one in each ear, while
    // a third plays on the speakers.
    sinkId: '',
    muted: false,
    // Whether its controls are showing. A view state, but a persisted one: which
    // rows somebody has left open is part of how they have arranged the panel,
    // the same way the dock's own collapsed sections are.
    open: true,
};

export const DEMOD_DEFAULTS = {
    vfos: [{ ...VFO_DEFAULTS }],
    active: 0,
};

const listeners = new Set();
let current = null;
let writeTimer = null;

// The write to storage is deferred; the copy in memory and the notification are
// not.
//
// Every control in the panel is a slider, and a slider being dragged fires an
// event per frame. Persisting on each of those is sixty synchronous writes a
// second of the same few hundred bytes, which on the browsers that back
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

function sanitiseVfo(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const mode = demodMode(src.mode).id;
    const widths = {};
    for (const m of DEMOD_MODES) {
        const saved = src.widths || {};
        // A width stored under a mode's old name serves each mode it became.
        const stored = saved[m.id] !== undefined ? saved[m.id] : saved[LEGACY_WIDTHS[m.id]];
        widths[m.id] = Number.isFinite(Number(stored)) ? clampWidth(m.id, stored) : m.fallback;
    }
    const gain = Number(src.gain);
    const squelchDb = Number(src.squelchDb);
    const sideband = sidebandOf(src.sideband);
    return {
        mode,
        widths,
        offsetHz: clampOffset(mode, src.offsetHz, widths[mode], sideband),
        pitchHz: clamp(Math.round(Number(src.pitchHz) || VFO_DEFAULTS.pitchHz), PITCH_MIN, PITCH_MAX),
        // Clamped against the widest a sideband filter can be rather than the
        // one in force, so a cut set under a wide filter survives a narrower
        // one being tried; the plan clamps it to the width that is there.
        lowCutHz: src.lowCutHz === undefined ? LOW_CUT_DEFAULT
            : clampLowCut(src.lowCutHz, modeMax('usb')),
        sideband,
        trackHz: src.trackHz === undefined ? TRACK_DEFAULT : clampTrack(src.trackHz),
        agc: src.agc !== false,
        gain: Number.isFinite(gain) ? clamp(gain, 0, 4) : 1,
        squelchDb: Number.isFinite(squelchDb)
            ? clamp(Math.round(squelchDb), SQUELCH_OFF, SQUELCH_MAX)
            : SQUELCH_OFF,
        pan: PAN_VALUES.includes(src.pan) ? src.pan : 'center',
        sinkId: typeof src.sinkId === 'string' ? src.sinkId.slice(0, 512) : '',
        muted: src.muted === true,
        open: src.open !== false,
    };
}

function sanitise(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    let list;
    if (Array.isArray(src.vfos) && src.vfos.length) {
        list = src.vfos.slice(0, MAX_VFOS).map(sanitiseVfo);
    } else if (src.mode || src.widths || src.offsetHz !== undefined) {
        // A settings record from before there was more than one demodulator.
        // Read as the first of them rather than discarded: somebody's filter
        // widths and their place in the stream are exactly the things worth not
        // losing, and this costs one branch.
        list = [sanitiseVfo(src)];
    } else {
        list = [sanitiseVfo(null)];
    }
    return {
        vfos: list,
        active: clamp(Math.round(Number(src.active) || 0), 0, list.length - 1),
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

function publish(next) {
    current = sanitise(next);
    persist(current);
    for (const fn of Array.from(listeners)) {
        try { fn(current); } catch (err) { /* one listener must not cost the others */ }
    }
    return current;
}

/**
 * Merge a change into the settings as a whole, persist it, and tell everyone.
 *
 * Through here rather than through the panel's own state because the panel can
 * be on screen twice — docked and floating, or docked and in a phone's sheet —
 * and the second copy has to see a change as it is made. Same shape as
 * lib/scannerSettings.js, for the same reason.
 *
 * Most changes are to one demodulator and should go through updateVfo.
 */
export function saveDemodSettings(patch) {
    return publish({ ...demodSettings(), ...patch });
}

export function onDemodSettings(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** Change one demodulator, leaving the others exactly as they were. */
export function updateVfo(index, patch) {
    const before = demodSettings();
    if (!before.vfos[index]) return before;
    const vfos = before.vfos.map((v, i) => (i === index
        ? { ...v, ...patch, widths: { ...v.widths, ...(patch && patch.widths) } }
        : v));
    return publish({ ...before, vfos });
}

/**
 * What a press on a row's header does.
 *
 * Two things, because a header is answering two questions at once — which
 * demodulator the picture is aimed at, and whether this row's controls are
 * showing — and which one a press means depends on where it lands:
 *
 *   a row that is not the current one   select it, and show it. Selecting a row
 *                                       and leaving it shut would look like the
 *                                       press had done nothing.
 *   the row that already is             open or close it. By then selecting is
 *                                       not on offer, so the press has only one
 *                                       thing left to mean.
 *
 * Expansion is per row and independent: two open at once is a comparison
 * somebody asked for, and closing one is a press away.
 */
export function toggleVfo(index) {
    const before = demodSettings();
    if (!before.vfos[index]) return before;
    if (index !== before.active) {
        const vfos = before.vfos.map((v, i) => (i === index ? { ...v, open: true } : v));
        return publish({ ...before, vfos, active: index });
    }
    const vfos = before.vfos.map((v, i) => (i === index ? { ...v, open: !v.open } : v));
    return publish({ ...before, vfos });
}

/**
 * Shut every row's controls at once.
 *
 * What the panel's minimal toggle does on its way in. Minimal is a request for
 * less of this panel, and with six demodulators open the rows are most of its
 * height — so trimming the gain and the prose off the bottom of each of them
 * and leaving all six expanded answers the request with the smaller half. One
 * publish rather than six: this is one action from the operator's side and
 * undoing it should be one press of the header, not six.
 */
export function collapseVfos() {
    const before = demodSettings();
    if (before.vfos.every((v) => v.open === false)) return before;
    return publish({ ...before, vfos: before.vfos.map((v) => ({ ...v, open: false })) });
}

/**
 * And open the one being edited, which is what the same toggle does on the way
 * back out.
 *
 * Only that one. Coming out of the minimal view is a request for more of the
 * panel and not for all of it — reopening six rows because six were open before
 * somebody made the panel small would undo their reason for making it small,
 * and there is no record of which of them mattered anyway. The selected row is
 * the one the picture is aimed at and the one every other control here acts on,
 * so it is the row a person is coming back for.
 */
export function expandActiveVfo() {
    const before = demodSettings();
    const at = before.active;
    const vfo = before.vfos[at];
    if (!vfo || vfo.open) return before;
    const vfos = before.vfos.map((v, i) => (i === at ? { ...v, open: true } : v));
    return publish({ ...before, vfos });
}

export function selectVfo(index) {
    const before = demodSettings();
    if (!before.vfos[index] || index === before.active) return before;
    return publish({ ...before, active: index });
}

/**
 * Add one, and make it the one being edited.
 *
 * Copied from the demodulator that was active rather than started from the
 * defaults, and placed immediately beside it: adding a second is nearly always
 * "another one like this, next to this", whether that is the other sideband of
 * the same signal or the station a couple of kilohertz up. Starting at the
 * defaults would put it on top of the first one in USB at the dial, which is
 * both invisible on the picture and the same audio twice.
 */
export function addVfo() {
    const before = demodSettings();
    if (before.vfos.length >= MAX_VFOS) return before;
    const from = before.vfos[before.active] || before.vfos[0];
    const w = clampWidth(from.mode, from.widths[from.mode]);
    // Above if there is room, below if there is not — at the top of the stream
    // there is nowhere further up to go, and stacking it back on the original
    // would look like the button had done nothing.
    let offsetHz = clampOffset(from.mode, from.offsetHz + w, w, from.sideband);
    if (offsetHz === from.offsetHz) offsetHz = clampOffset(from.mode, from.offsetHz - w, w, from.sideband);
    const vfos = [...before.vfos, {
        ...from, widths: { ...from.widths }, offsetHz, open: true,
    }];
    return publish({ ...before, vfos, active: vfos.length - 1 });
}

/** Remove one. The last one cannot go: the panel would have nothing to be. */
export function removeVfo(index) {
    const before = demodSettings();
    if (before.vfos.length <= 1 || !before.vfos[index]) return before;
    const vfos = before.vfos.filter((v, i) => i !== index);
    // Keep editing the same one where that still means something, and step back
    // rather than forward when the one removed was the last.
    const active = before.active > index ? before.active - 1
        : Math.min(before.active, vfos.length - 1);
    return publish({ ...before, vfos, active });
}

/** The width in force for a demodulator's current mode. */
export function vfoWidth(vfo) {
    return clampWidth(vfo.mode, vfo.widths[vfo.mode]);
}

/** The plan a demodulator's settings reduce to. */
export function planForVfo(vfo) {
    return planFor({
        mode: vfo.mode,
        offsetHz: vfo.offsetHz,
        widthHz: vfoWidth(vfo),
        pitchHz: vfo.pitchHz,
        sideband: vfo.sideband,
        trackHz: vfo.trackHz,
        lowCutHz: vfo.lowCutHz,
    });
}

/** Where a demodulator's passband lands, as offsets from the dial. */
export function vfoPassband(vfo) {
    return passbandFor(vfo.mode, vfo.offsetHz, vfoWidth(vfo), vfo.sideband, vfo.lowCutHz);
}

/** Testing seam: forget the cached copy so the next read goes to storage. */
export function resetDemodSettings() {
    clearTimeout(writeTimer);
    writeTimer = null;
    current = null;
    halfSpan = IQ_HALF_SPAN;
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

const PAN_POSITION = { left: -1, center: 0, right: 1 };

/**
 * The demodulators as a thing with a lifetime.
 *
 * Owns the tap on the player, the audio the demodulators produce, and the duck
 * that keeps the receiver's own quadrature noise out of the way while they run.
 * Emits 'change' when any of that changes, which is what the panel re-renders
 * on.
 *
 * ── The graph ────────────────────────────────────────────────────────────────
 *
 * Each demodulator gets its own voice, and they meet at one master:
 *
 *     buffer source ─► voice gain (mute) ─► panner (L/C/R) ─┐
 *     buffer source ─► voice gain (mute) ─► panner (L/C/R) ─┼─► master ─► out
 *                                                     …    ─┘
 *
 * The voice gain is mute and nothing else: the demodulator's own gain is applied
 * in the arithmetic, where it is followed by a clip that keeps a runaway AGC out
 * of Web Audio. The master carries the receiver's volume and mute, because
 * demodulated audio is not the receiver's audio and must not go through its
 * filter chain — but it is what is being listened to.
 *
 * Nothing scales with the number of voices, and that is deliberate rather than
 * an oversight. Four at the AGC's target sum to about full scale; six could
 * exceed it, and the master would clip on the rare moment they all peak
 * together. The alternative is dividing by the count, which would change the
 * loudness of a demodulator you are listening to because a *different* one was
 * switched on somewhere else — a worse fault than an occasional clip, and one
 * that happens every time rather than rarely. In practice signals do not peak
 * in step and panning a pair apart separates them further; the operator's volume
 * control is the right place to absorb what is left.
 */
export class IQDemod extends Emitter {
    constructor(player) {
        super();
        this.player = player;
        // One per demodulator, index-aligned with the settings' `vfos`.
        this.chains = [];
        this.voices = [];
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
        this._master = null;
        // One output per device a demodulator has been sent to, by sink id —
        // see _outFor. The receiver's own output is `_master`, not in here.
        this._sinks = new Map();
        this._ctx = null;
        this._volume = 1;
        this._muted = false;
        this._settings = demodSettings();
        this._offSettings = onDemodSettings((s) => {
            this._settings = s;
            this._sync();
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

    get settings() {
        return this._settings;
    }

    /** Output level of one demodulator, for its meter. */
    levelOf(index) {
        const chain = this.chains[index];
        return this.active && this._quad && chain ? chain.level : 0;
    }

    /**
     * How much is in one demodulator's passband, in dBFS, or null when there is
     * nothing to measure.
     *
     * Null rather than the silent floor while stopped: the panel draws this as a
     * marker against the squelch threshold, and a marker pinned to the bottom of
     * the slider would be a reading, when the truth is that there is none.
     */
    signalDbOf(index) {
        const chain = this.chains[index];
        return this.active && this._quad && chain ? chain.sigDb : null;
    }

    /** One demodulator's audio spectrum, or null while nothing is playing. */
    audioSpectrumOf(index) {
        const chain = this.chains[index];
        return this.active && this._quad && chain && chain.rate ? chain.audioSpectrum() : null;
    }

    /** What one demodulator's ECSS tracker is doing, or null. */
    ecssOf(index) {
        const chain = this.chains[index];
        return this.active && this._quad && chain ? chain.ecssStatus : null;
    }

    /** Whether a demodulator's squelch is letting anything through. */
    gateOpenOf(index) {
        const chain = this.chains[index];
        return this.active && this._quad && chain ? chain.gateOpen : true;
    }

    start() {
        if (this.active) return;
        this.active = true;
        for (const c of this.chains) c.reset();
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
        for (const c of this.chains) c.reset();
        this.rate = 0;
        this.frames = 0;
        this._teardown();
        this.emit('change');
    }

    /**
     * Say whether the stream is quadrature, i.e. whether the receiver is in IQ.
     *
     * Flipping it on resets the chains: what came before was a different mode
     * and carrying its filter history into this one would be a click at best.
     */
    setQuadrature(on) {
        const next = !!on;
        if (next === this._quad) return;
        this._quad = next;
        if (next) {
            for (const c of this.chains) c.reset();
            for (const v of this.voices) {
                v.nextPlayTime = 0;
                v.pendN = 0;
            }
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

    /** The receiver's volume and mute, pushed in from the outside. */
    setOutput(volume, muted) {
        this._volume = Number.isFinite(volume) ? volume : 1;
        this._muted = !!muted;
        if (!this._ctx) return;
        const level = this._muted ? 0 : this._volume;
        const outs = [this._master, ...Array.from(this._sinks.values(), (o) => o.gain)];
        for (const g of outs) {
            if (g) g.gain.setTargetAtTime(level, this._ctx.currentTime, 0.015);
        }
    }

    /**
     * Why a demodulator's chosen device is not being used, or null.
     *
     * A device that refuses — unplugged since it was chosen, or not one this
     * browser will hand to a page — falls back to the receiver's output rather
     * than going silent, and the row says so.
     */
    sinkErrorOf(index) {
        const vfo = this._settings.vfos[index];
        const out = vfo && vfo.sinkId ? this._sinks.get(vfo.sinkId) : null;
        return out ? out.error : null;
    }

    /**
     * Match the number of chains to the number of demodulators.
     *
     * Index-aligned with the settings rather than keyed by an id, because the
     * settings are a plain array and adding an identity to them would be a
     * second thing to keep in step. The cost is that removing the first of three
     * shifts the other two onto different chains — one packet of filter history
     * belonging to the wrong demodulator, which is inaudible, against an id that
     * would have to survive storage, migration and every patch above.
     */
    _sync() {
        const want = this._settings.vfos.length;
        while (this.chains.length < want) this.chains.push(new DemodChain());
        while (this.chains.length > want) this.chains.pop();
        while (this.voices.length > want) this._dropVoice(this.voices.pop());
    }

    _dropVoice(voice) {
        if (!voice) return;
        try { voice.gain.disconnect(); } catch (err) { /* context already gone */ }
        try { voice.panner.disconnect(); } catch (err) { /* context already gone */ }
    }

    _teardown() {
        for (const v of this.voices) this._dropVoice(v);
        this.voices = [];
        if (this._master) {
            try { this._master.disconnect(); } catch (err) { /* context already gone */ }
        }
        this._master = null;
        for (const id of Array.from(this._sinks.keys())) this._dropSink(id);
        this._ctx = null;
    }

    /**
     * The node a demodulator sent to `sinkId` connects to.
     *
     * '' is the receiver's own output. Anything else gets an output of its own:
     * a gain carrying the volume and mute, into a stream, played by a hidden
     * <audio> element pointed at the device — the route the player itself takes
     * on Firefox (see AudioPlayer._applyOutput), and the only one that can send
     * one context to several devices at once. The stream is stereo, so the pan
     * ahead of it still decides the ear.
     */
    _outFor(sinkId) {
        if (!sinkId) return this._master;
        const have = this._sinks.get(sinkId);
        if (have) return have.gain;
        const ctx = this._ctx;
        const gain = ctx.createGain();
        gain.gain.value = this._muted ? 0 : this._volume;
        const out = { gain, dest: null, el: null, error: null };
        this._sinks.set(sinkId, out);
        const fallBack = (err) => {
            // Back onto the receiver's output rather than into a stream nobody
            // is playing: a demodulator that went silent because its headphones
            // were unplugged would read as broken.
            out.error = (err && (err.message || err.name)) || 'the device refused';
            try { gain.disconnect(); } catch (e) { /* not connected */ }
            if (this._master) gain.connect(this._master);
            this.emit('change');
        };
        try {
            const dest = ctx.createMediaStreamDestination();
            const el = document.createElement('audio');
            // iOS plays nothing inline without it — see the player's element.
            el.setAttribute('playsinline', '');
            el.style.display = 'none';
            document.body.appendChild(el);
            el.srcObject = dest.stream;
            out.dest = dest;
            out.el = el;
            gain.connect(dest);
            // The device first and playback after, so a refusal is known before
            // anything has been sent to it.
            el.setSinkId(sinkId)
                .then(() => (this._sinks.get(sinkId) === out ? el.play() : null))
                .catch(fallBack);
        } catch (err) {
            fallBack(err);
        }
        return gain;
    }

    _dropSink(sinkId) {
        const out = this._sinks.get(sinkId);
        if (!out) return;
        this._sinks.delete(sinkId);
        try { out.gain.disconnect(); } catch (err) { /* context already gone */ }
        if (out.el) {
            try { out.el.pause(); } catch (err) { /* ignore */ }
            out.el.srcObject = null;
            if (out.el.parentNode) out.el.parentNode.removeChild(out.el);
        }
    }

    /** Connect a voice to its demodulator's output, if that has changed. */
    _route(voice, sinkId) {
        const want = sinkId || '';
        if (voice.sink === want) return;
        const node = voice.panner || voice.gain;
        try { node.disconnect(); } catch (err) { /* not connected */ }
        const to = this._outFor(want);
        if (to) node.connect(to);
        voice.sink = want;
    }

    _ensureMaster() {
        const ctx = this.player && this.player.ctx;
        if (!ctx || ctx.state === 'closed') return null;
        if (this._master && this._ctx === ctx) return this._master;
        // The player rebuilds its context on a format or rate change, and every
        // node hanging off the old one is now attached to a stopped clock.
        this._teardown();
        const master = ctx.createGain();
        master.gain.value = this._muted ? 0 : this._volume;
        // Into the receiver's own last node rather than straight to the
        // context's destination, so it goes wherever the receiver's audio is
        // routed — a chosen device on Firefox, the Media Session element — and
        // not to the default output beside it. See AudioPlayer.outputBus.
        const bus = this.player.outputBus;
        master.connect(bus && bus.context === ctx ? bus : ctx.destination);
        this._master = master;
        this._ctx = ctx;
        return master;
    }

    _voice(index) {
        const ctx = this._ctx;
        const master = this._master;
        if (!ctx || !master) return null;
        let v = this.voices[index];
        if (!v) {
            const gain = ctx.createGain();
            // A panner is not universal — a browser without one gets the audio
            // in both ears rather than no audio, which is the right way for a
            // stereo placement to degrade.
            const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
            if (panner) gain.connect(panner);
            v = {
                gain, panner, nextPlayTime: 0, pan: null, muted: null,
                // Which output it is connected to; null until _route says.
                sink: null,
                // Audio waiting to make up one block — see _playOne.
                pend: null, pendN: 0, pendRate: 0,
            };
            this.voices[index] = v;
        }
        return v;
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
        if (!this._ensureMaster()) return;

        // Re-asserted rather than set once: the recorder's preview unducks on
        // the way out (see RecorderPanel), and a demodulator that went silently
        // back to hissing after somebody played a recording would be a bug
        // nobody could place. Only ever upwards, and only while this is the
        // thing making the sound — see _applyDuck for the other half of the rule.
        if (!this.player.ducked) this.player.setDucked(true);

        const rate = sampleRate > 0 ? sampleRate : this.rate || 12000;
        const vfos = this._settings.vfos;
        this._sync();

        for (let i = 0; i < vfos.length; i++) {
            this._playOne(i, vfos[i], planes, frames, rate, ctx);
        }
        // A device nobody is sent to any more gives its element back.
        if (this._sinks.size) {
            const used = new Set(vfos.map((v) => v.sinkId || ''));
            for (const id of Array.from(this._sinks.keys())) if (!used.has(id)) this._dropSink(id);
        }

        // Read by the panel's readouts. Latched here so they can say what the
        // stream is without the panel having to ask the player.
        if (this.rate !== rate || this.frames !== frames) {
            this.rate = rate;
            this.frames = frames;
            // The reach follows the rate, so a wide IQ stream can be listened
            // to across the whole of it. Republishes, which re-renders the panel.
            setIQSpan(rate);
            this.emit('change');
        }
    }

    _playOne(index, vfo, planes, frames, rate, ctx) {
        const chain = this.chains[index];
        const voice = this._voice(index);
        if (!chain || !voice) return;
        this._route(voice, vfo.sinkId);

        chain.configure(planForVfo(vfo), rate);

        // Muted still demodulates. The level meter goes on reading, so the
        // picture and the meters still say what is on a demodulator you have
        // silenced to hear another one — which is most of why you would silence
        // it — and unmuting is instant rather than a filter refilling.
        const audio = chain.process(planes[0], planes[1], frames, {
            agc: vfo.agc,
            gain: vfo.gain,
            squelchDb: vfo.squelchDb,
        });
        if (!audio) return;

        const now = ctx.currentTime;
        if (voice.pan !== vfo.pan) {
            voice.pan = vfo.pan;
            if (voice.panner) {
                voice.panner.pan.setTargetAtTime(PAN_POSITION[vfo.pan] || 0, now, 0.015);
            }
        }
        if (voice.muted !== vfo.muted) {
            voice.muted = vfo.muted;
            voice.gain.gain.setTargetAtTime(vfo.muted ? 0 : 1, now, 0.015);
        }

        // At the chain's own rate and length, which on a wide preset are the
        // decimated ones; Web Audio resamples the buffer to the context's.
        //
        // Joined up to MIN_BLOCK_SEC first, as the player does with its own
        // packets and for the same reason: IQ 192's 1.8 ms packets decimate to
        // 44 samples, and a source node per one of those per voice was most of
        // what wore the browser down. See MIN_BLOCK_SEC in audio-player.js.
        const got = chain.outFrames;
        if (!got) return;
        const outRate = chain.rate;
        const want = Math.round(outRate * MIN_BLOCK_SEC);
        if (voice.pendRate !== outRate) {
            voice.pendRate = outRate;
            voice.pendN = 0;
        }
        if (!voice.pend || voice.pend.length < want + got) {
            const grown = new Float32Array((want + got) * 2);
            if (voice.pend && voice.pendN) grown.set(voice.pend.subarray(0, voice.pendN));
            voice.pend = grown;
        }
        voice.pend.set(audio.subarray(0, got), voice.pendN);
        voice.pendN += got;
        if (voice.pendN < want) return;
        const n = voice.pendN;
        voice.pendN = 0;
        const buffer = ctx.createBuffer(1, n, outRate);
        buffer.copyToChannel(voice.pend.subarray(0, n), 0);

        if (voice.nextPlayTime < now) voice.nextPlayTime = now + LEAD_IN_SEC;
        else if (voice.nextPlayTime - now > MAX_QUEUE_SEC) return;
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(voice.gain);
        src.start(voice.nextPlayTime);
        voice.nextPlayTime += buffer.duration;
    }

    destroy() {
        this.stop();
        if (this._offSettings) this._offSettings();
    }
}

let engine = null;

/** The one demodulator bank. Built on first use, like the recorder's. */
export function getIQDemod(player) {
    if (!engine) engine = new IQDemod(player);
    return engine;
}

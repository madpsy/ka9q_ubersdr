// Radio-side constants. Values mirror the server (websocket.go) so the UI and
// the backend agree on defaults without a round-trip.

// How much spectrum this receiver covers.
//
// One publisher: /api/description, whose `tuning_range` object is built by
// ReceiverConfig.TuningRange() in receiver_span.go. The same map reaches the instance
// reporter, so every consumer of these numbers is reading one fact from one place.
//
// It used to be inlined into the shell as well, as `window.__UBERSDR__`, so that these
// could be plain `const`s evaluated before anything read them. That is gone, and the
// reason is the bundled clients: the desktop and mobile apps serve their own copy of
// index.html and strip its Go template actions — an operator's injected HTML is the
// instance's business — which took the inlined range with it. Every app therefore fell
// back to 30 MHz on every receiver, so a 60 MHz instance drew 0-60 MHz of spectrum (that
// arrives over the websocket) while offering no 6 m button and refusing to centre above
// 30 MHz. Two delivery mechanisms for one fact, and the apps only ever had the one that
// was silently dropped.
//
// So these are live bindings rather than constants, set once by applyTuningRange when the
// description lands. ES module exports are live: `import { MAX_FREQ }` re-reads this
// variable on every access, and esbuild preserves that through the bundle — so the ~40
// consumers keep importing exactly what they imported before, and none of them became a
// context read. What that does *not* do is re-render anybody, so the caller applies the
// range immediately before the setState that publishes the description (see
// RadioContext) and the render that follows sees these values.
//
// Two consumers read too early for any of that and are fixed rather than papered over:
// FreqEntry's range hint is computed at render instead of at import, and initialTuning
// defers its clamp of the ?freq= share link until the range is known, because clamping
// a 6 m link to 30 MHz destroys the frequency it was sent to convey.
//
// ── The fallback is a contract, not padding ──────────────────────────────────
// A bundle cached in a visitor's browser will outlive the server it was built against,
// in both directions. Until the description answers — and for an older server that does
// not publish the object, a test harness, or a bundle loaded outside a page entirely —
// this must behave exactly as it did before the receiver span became configurable:
// 10 kHz to 30 MHz.
//
// `> 0` rather than `??` or `||` on purpose, so 0, null, "" and undefined all fall
// through to the default rather than 0 becoming a legitimate limit.
export let MIN_FREQ = 10000;              // 10 kHz
export let MAX_FREQ = 30000000;           // 30 MHz

// The full-span spectrum view, for the modules that need a span rather than a limit.
// Named RECEIVER_SPAN_HZ, not FULL_SPAN_HZ, because lib/ifSpectrum.js already exports
// that name as its own pure-module default.
// Same fallback rule, same reason.
export let RECEIVER_SPAN_HZ = 30000000;

/**
 * Adopt this receiver's tuning range, from /api/description's `tuning_range`.
 *
 * Every field is optional and each falls back on its own, because the three are
 * independent facts and a server that publishes one of them must not reset the others.
 * Returns true when anything actually moved, so the caller can tell a real change from
 * the common case of a receiver that is the 30 MHz default anyway.
 */
export function applyTuningRange(range) {
    const r = range || {};
    const pick = (v, was) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : was);
    const min = pick(r.min_frequency, MIN_FREQ);
    const max = pick(r.max_frequency, MAX_FREQ);
    const span = pick(r.spectrum_span_hz, RECEIVER_SPAN_HZ);
    // A max below the min is not a range, it is a misconfigured receiver, and taking it
    // would leave every clamp in the app inverted. Left as it was instead.
    if (max <= min) return false;
    const changed = min !== MIN_FREQ || max !== MAX_FREQ || span !== RECEIVER_SPAN_HZ;
    MIN_FREQ = min;
    MAX_FREQ = max;
    RECEIVER_SPAN_HZ = span;
    return changed;
}

// Mode table. `low`/`high` are the passband edges in Hz relative to the tuned
// frequency and match the server-side defaults in websocket.go.
export const MODES = [
    { id: 'lsb', label: 'LSB', group: 'voice', low: -2700, high: -50 },
    { id: 'usb', label: 'USB', group: 'voice', low: 50, high: 2700 },
    { id: 'am', label: 'AM', group: 'voice', low: -5000, high: 5000 },
    { id: 'sam', label: 'SAM', group: 'voice', low: -5000, high: 5000 },
    { id: 'nfm', label: 'NFM', group: 'voice', low: -5000, high: 5000 },
    { id: 'fm', label: 'FM', group: 'voice', low: -8000, high: 8000 },
    { id: 'cwl', label: 'CW-L', group: 'cw', low: -200, high: 200 },
    { id: 'cwu', label: 'CW-U', group: 'cw', low: -200, high: 200 },
    // Raw quadrature baseband, last because it is not a listening mode: the
    // server sends 12 kHz stereo where left is I and right is Q, and what comes
    // out of the speakers is 12 kHz of RF rather than anything demodulated.
    //
    // ±6 kHz rather than the ±5 kHz this said until 2026-08-26, which was
    // right when the stream was 10 kHz and quietly wrong after radiod's [iq]
    // preset settled at samprate = 12k, low = -6k, high = +6k: asking for ±5
    // put a filter *inside* the preset's own passband, so the top and bottom
    // kilohertz of every capture came back empty with nothing in the WAV to
    // say why. Matching the preset exactly means the mode change moves no
    // filter at all.
    //
    // The wide variants (iq48 upwards) are still absent. They need operator
    // authorisation, they refuse passband edges in favour of the radiod preset,
    // and at 48-384 kHz they are for feeding external tools, not a browser.
    { id: 'iq', label: 'IQ', group: 'iq', low: -6000, high: 6000 },
];

export const MODE_BY_ID = Object.fromEntries(MODES.map((m) => [m.id, m]));

// Whether a mode carries a stereo I/Q pair rather than demodulated audio.
//
// Only plain `iq` is offered here, but this is written as a prefix test so the
// wide variants answer true as well — everything gated on it (the DSP bypass,
// the format lock, the disabled squelch) is just as necessary for those, and a
// list that had to be extended in step with MODES is a list that would not be.
export function isIQ(mode) {
    return String(mode || '').toLowerCase().startsWith('iq');
}

// Whether the transmitter puts a carrier at the dial. True for everything the
// receiver demodulates except the suppressed-carrier modes; IQ is not
// demodulated at all and answers false.
//
// It matters to anything that measures a signal against its own peak. On these
// modes that peak is the carrier, and a carrier is not part of the modulation
// it carries: on a power average of several seconds an AM carrier stands 30 to
// 45 dB above any single bin of its own sidebands, because the carrier is a
// line landing in one bin while the sidebands are speech spread over kilohertz
// at whatever the average modulation depth happens to be. Take the peak as the
// reference and everything the station is actually saying falls below the gate.
export function hasCarrier(mode) {
    switch (String(mode || '').toLowerCase()) {
        // A keyed carrier *is* the signal, and SAM's is the one it locks to.
        case 'am': case 'sam': case 'cwu': case 'cwl':
        // FM's carrier moves rather than staying put, and at some modulation
        // indices it disappears entirely — but a quiet channel or a lightly
        // modulated one leaves a line at the dial just as plainly.
        case 'nfm': case 'fm':
            return true;
        default:
            return false;
    }
}

// Widest passband the bandwidth sliders will offer, per mode family.
//
// These are passband *edges* relative to the tuned frequency, so a symmetric
// mode's maximum filter width is twice the edge: ±6000 Hz gives a 12 kHz
// filter. Single-sideband modes only occupy one side, so their edge value is
// the width directly.
export function bandwidthLimits(mode) {
    switch (mode) {
        case 'usb': return { min: 0, max: 6000, sideband: 'upper' };
        case 'lsb': return { min: -6000, max: 0, sideband: 'lower' };
        // CW is symmetric about the carrier in both sidebands, not one-sided.
        // The name says which sideband the tone is on; the filter still sits
        // either side of the dial — v1's combinedValueToLowHigh returns [-v, v]
        // for cwu and cwl alike, and its sliders run -500..0 and 0..500.
        //
        // Declaring it 'upper'/'lower' clamped the mode's own ±200 default down
        // to 0..200, so tuning to a CW spot drew a narrow one-sided passband on
        // the spectrum instead of a symmetric one, and the width and shift
        // sliders edited the wrong edge.
        case 'cwu':
        case 'cwl':
            return { min: -500, max: 500, sideband: 'both' };
        // v1: minLow -8000, maxHigh 8000. The shared default below is ±6000,
        // which would clamp FM's own ±8000 default the same way CW's was.
        case 'fm': return { min: -8000, max: 8000, sideband: 'both' };
        // IQ streams at 12 kHz, so ±6 kHz *is* Nyquist — the server would take
        // a wider request (it clamps at ±12 kHz like every non-wide mode) and
        // the stream simply could not carry the result. Same figure as the
        // default branch below, kept as its own case because the two agree by
        // coincidence: one is the AM family's 12 kHz filter, this one is the
        // whole of the quadrature baseband.
        case 'iq': return { min: -6000, max: 6000, sideband: 'both' };
        // am, sam, nfm — 12 kHz maximum width.
        default: return { min: -6000, max: 6000, sideband: 'both' };
    }
}

// Widest filter the sliders allow for a mode, in Hz.
export function maxFilterWidth(mode) {
    const l = bandwidthLimits(mode);
    return Math.abs(l.max - l.min);
}

// Narrowest filter worth offering, and the grain the controls move in. The
// Receiver panel's width slider has always used these; they are named here
// because the spectrum's own filter editing has to agree with it.
export const FILTER_WIDTH_MIN = 100;
export const FILTER_WIDTH_STEP = 50;

/**
 * The passband a mode opens with, as edges.
 *
 * Taken from MODES rather than named again here, because that is what
 * `commitMode` applies when the mode is chosen — so "the mode's default" means
 * one thing whether it is arrived at by picking the mode or by pressing a reset.
 * The three functions below are all this one read differently, so a caller
 * asking for the default width and a caller asking for the default passband
 * cannot be told different things.
 *
 * An unknown mode has no default. The narrowest filter on the dial is the only
 * honest answer, and every caller clamps into its mode's limits anyway.
 */
export function defaultEdges(mode) {
    const def = MODE_BY_ID[mode];
    return def ? [def.low, def.high] : [-FILTER_WIDTH_MIN / 2, FILTER_WIDTH_MIN / 2];
}

/** The filter width a mode opens with. */
export function defaultFilterWidth(mode) {
    const [low, high] = defaultEdges(mode);
    return Math.abs(high - low);
}

const clampEdge = (v, l) => Math.max(l.min, Math.min(l.max, v));

/**
 * Passband edges for a width, keeping whatever shift is in force.
 *
 * Lower-sideband modes are edited as a positive width below the carrier and
 * upper as one above it, so a width control behaves the same way whichever
 * sideband is in use; symmetric modes grow either side of where they are.
 */
export function edgesForWidth(mode, width, tuning) {
    const l = bandwidthLimits(mode);
    const w = Math.max(FILTER_WIDTH_MIN, Math.min(maxFilterWidth(mode), width));
    if (l.sideband === 'lower') return [clampEdge(tuning.bandwidthHigh - w, l), tuning.bandwidthHigh];
    if (l.sideband === 'upper') return [tuning.bandwidthLow, clampEdge(tuning.bandwidthLow + w, l)];
    const mid = (tuning.bandwidthLow + tuning.bandwidthHigh) / 2;
    return [clampEdge(mid - w / 2, l), clampEdge(mid + w / 2, l)];
}

/**
 * Where a passband sits relative to the dial, in the terms the shift slider
 * uses: a lower-sideband filter's shift is measured down from the carrier, an
 * upper one's up from it, and a symmetric one's is simply its centre.
 *
 * Named here rather than derived in the Receiver panel, which is the only place
 * that edits a shift, because the reset beside that slider has to ask the same
 * question of the mode's *default* passband — and two spellings of "where is
 * this filter sitting" would be two answers waiting to differ.
 */
export function filterShift(mode, low, high) {
    const l = bandwidthLimits(mode);
    if (l.sideband === 'lower') return -high;
    if (l.sideband === 'upper') return low;
    return (low + high) / 2;
}

/** The shift a mode opens with — 50 Hz for SSB, nothing for the rest. */
export function defaultFilterShift(mode) {
    return filterShift(mode, ...defaultEdges(mode));
}

/**
 * Passband edges for a shift, keeping whatever width is in force.
 *
 * The mirror of edgesForWidth, and paired with it deliberately: the two sliders
 * in the Receiver panel each move one of these two numbers and leave the other
 * alone, which is only true if both are worked out from the same convention.
 */
export function edgesForShift(mode, shift, tuning) {
    const l = bandwidthLimits(mode);
    const w = Math.abs(tuning.bandwidthHigh - tuning.bandwidthLow);
    if (l.sideband === 'lower') return [clampEdge(-w - shift, l), clampEdge(-shift, l)];
    if (l.sideband === 'upper') return [clampEdge(shift, l), clampEdge(shift + w, l)];
    return [clampEdge(shift - w / 2, l), clampEdge(shift + w / 2, l)];
}

/**
 * Passband edges after dragging one of them to `offsetHz` from the dial.
 *
 * `minWidth` is how narrow the drag may make it, above the mode's own floor.
 * The spectrum passes the width of its own grab zone, so a drag cannot leave
 * the two edges closer together than they have to be to be grabbed again —
 * otherwise the gesture can reach a state it cannot undo, and the only way out
 * of a filter dragged shut is a control somewhere else.
 *
 * Single-sideband modes move the edge you grabbed and leave the other alone —
 * which changes the width and the shift together, and is what grabbing an edge
 * plainly means. Symmetric modes mirror instead: an AM or CW filter with one
 * side longer than the other is almost never what someone dragging an edge was
 * after, and the shift slider is there for when it is. Mirroring is about the
 * passband's own centre, so a shifted filter stays shifted.
 */
export function edgesForEdgeDrag(mode, which, offsetHz, tuning, minWidth = FILTER_WIDTH_MIN) {
    const l = bandwidthLimits(mode);
    const min = Math.max(FILTER_WIDTH_MIN, minWidth);
    if (l.sideband === 'both') {
        const mid = (tuning.bandwidthLow + tuning.bandwidthHigh) / 2;
        const half = Math.max(min / 2, Math.abs(offsetHz - mid));
        return [clampEdge(mid - half, l), clampEdge(mid + half, l)];
    }
    if (which === 'low') {
        const low = clampEdge(Math.min(offsetHz, tuning.bandwidthHigh - min), l);
        return [low, tuning.bandwidthHigh];
    }
    const high = clampEdge(Math.max(offsetHz, tuning.bandwidthLow + min), l);
    return [tuning.bandwidthLow, high];
}

// CW modes are tuned to the carrier, so the audible tone sits at the offset.
export const CW_TONE_OFFSET = 700;

export const TUNING_STEPS = [1, 10, 100, 500, 1000, 5000, 9000, 10000, 100000];

// The step a mode starts on, before anybody has chosen one for it.
//
// The step is one live figure shared by everything that tunes, and the *choice*
// is remembered per mode (tuneStepByMode in display/DisplayContext.jsx, put back
// by components/TuneStepWatch.jsx). Until this table existed, a mode with
// nothing on record simply kept whatever step was in force — which meant the
// first step you picked anywhere followed you into every mode you had not
// visited yet, and the only way out was to go round and set all of them by
// hand. That is the complaint this answers: an unvisited mode now starts on the
// step its own band plan is written in, not on the last one you happened to use.
//
// One entry per MODES id. Every figure is a member of TUNING_STEPS, because the
// panels' <select> has to be able to show it — a default outside the list would
// draw an empty box.
export const DEFAULT_STEP_BY_MODE = {
    // SSB is tuned by ear rather than to a channel; 500 Hz is the usual grid and
    // was the single default this whole interface used.
    lsb: 500,
    usb: 500,
    // CW is netted onto a signal within the width of the filter itself (±200 Hz),
    // so anything coarser than this overshoots the station you are aiming at.
    cwl: 100,
    cwu: 100,
    // HF broadcast is on 5 kHz channels. Medium wave is 9 or 10, both of which
    // are in the list a press away for anyone who works it.
    am: 5000,
    sam: 5000,
    // NBFM channel spacing.
    nfm: 5000,
    fm: 5000,
    // Not a listening mode — the dial is a capture centre, and IQ carries ±6 kHz
    // either side of it, so a kilohertz is fine enough to place the window with.
    iq: 1000,
};

// The step `mode` starts on, or null for a mode with no default of its own.
//
// Null rather than a fallback figure: the caller keeps the step in force, which
// is the right answer for a mode this table has not heard of — a server-side
// addition, say — and a wrong one for every mode it has.
export function defaultStepFor(mode) {
    const hz = DEFAULT_STEP_BY_MODE[String(mode || '').toLowerCase()];
    return Number.isFinite(hz) && hz > 0 ? hz : null;
}

export function stepLabel(hz) {
    if (hz >= 1000) return (hz / 1000) + ' kHz';
    return hz + ' Hz';
}

// Next frequency on a `step` boundary in the given direction.
//
// Stepping is a snap, not an add: from 7.100123 MHz with a 500 Hz step, up lands
// on 7.100500 and down on 7.100000, so the dial ends up on round numbers however
// it got to where it was. Already on a boundary, it moves a full step.
export function snapStep(frequency, step, dir) {
    if (!(step > 0)) return frequency;
    const f = frequency / step;
    // floor/ceil rather than round, so a press never moves the opposite way.
    return (dir > 0 ? Math.floor(f) + 1 : Math.ceil(f) - 1) * step;
}

// AGC.
//
// Only USB and LSB expose these — v1 keys them off a per-mode settings table
// containing just those two. There is deliberately no enable/disable switch:
// the server accepts `agcEnable` but v1 never sends it and never reports it
// back, so a toggle would show a state nothing else agrees with.
//
// Defaults match share/presets.conf. The server applies the operator's
// config.yaml `ssb_agc` values over them for every new SSB session and again on
// each mode change, then reports the result via `agc_state`, so the server is
// the authority and these are only a first guess.
export const AGC_CONTROLS = [
    { id: 'agcHangTime', label: 'Hang time', min: 0, max: 10, step: 0.1, default: 1.1, unit: 's', decimals: 1 },
    { id: 'agcRecoveryRate', label: 'Recovery', min: 1, max: 100, step: 1, default: 20, unit: 'dB/s', decimals: 0 },
    { id: 'agcThreshold', label: 'Threshold', min: -30, max: 0, step: 1, default: -15, unit: 'dB', decimals: 0 },
];

export function hasAGCSettings(mode) {
    return mode === 'usb' || mode === 'lsb';
}

export function defaultAGC() {
    return Object.fromEntries(AGC_CONTROLS.map((c) => [c.id, c.default]));
}

// Squelch.
//
// This is the server-side audio gate (`set_audio_gate` with `min_snr`), not
// radiod's `set_squelch`. v1 ships with `FM_SQUELCH_ENABLED = false` and only
// ever sends squelchOpen -999, so the gate is the control users actually have.
// The gate drops audio before encoding and keeps the signal-quality packets
// flowing, so SNR stays live on screen while muted.
// The range is in dB of SNR, and moved with protocol version 3: it used to be
// 24–80, which was calibrated against the server's old S/N0 figure in dB·Hz —
// roughly 34 dB higher than the true SNR on a 2.65 kHz filter, and different
// again on every other filter width, which is what made a threshold set on SSB
// gate wrongly on CW. -10 to 46 is the same span in the units that now arrive.
export const SQUELCH_MIN = -10;       // far-left slider position — means "off"
export const SQUELCH_MAX = 46;
export const SQUELCH_STEP = 0.5;
export const SQUELCH_SENTINEL = -999; // value the server reads as "disabled"

// Where the on/off toggle lands when switching the squelch back on: above the
// noise but below anything worth hearing. Was 40 when the scale was dB·Hz.
export const SQUELCH_DEFAULT_ON = 6;

// Server-side gate behaviour, mirrored so the open/closed indicator matches
// what the server is actually doing (see audioGateAllows in websocket.go).
export const SQUELCH_HANG_MS = 500;

// Slider position -> threshold to send. The floor doubles as the off switch.
export function squelchThreshold(sliderValue) {
    const v = Number(sliderValue);
    return v <= SQUELCH_MIN ? SQUELCH_SENTINEL : v;
}

export function squelchEnabled(sliderValue) {
    return squelchThreshold(sliderValue) > SQUELCH_SENTINEL + 1;
}

// Auto-set, mirroring v1: average the last few SNR readings and sit a few dB
// *above* them, so the threshold lands just over the noise the receiver is
// actually hearing. Sitting below it would leave the gate permanently open.
export const SQUELCH_AUTO_SAMPLES = 5;
export const SQUELCH_AUTO_HEADROOM_DB = 3;

// `snrHistory` is oldest-first. Returns a slider position, or null if there is
// nothing to measure yet.
export function autoSquelchValue(snrHistory) {
    if (!snrHistory || snrHistory.length === 0) return null;
    const recent = snrHistory.slice(-SQUELCH_AUTO_SAMPLES);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const stepped = Math.round((avg + SQUELCH_AUTO_HEADROOM_DB) / SQUELCH_STEP) * SQUELCH_STEP;
    // Never land on the floor, which would read as "off".
    return Math.max(SQUELCH_MIN + SQUELCH_STEP, Math.min(SQUELCH_MAX, stepped));
}

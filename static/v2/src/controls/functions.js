// The mappable-function catalogue, and the one place a control-surface event
// turns into a radio action.
//
// v1 ships this switch statement twice — once in the FlexControl extension and
// once in MIDI Control — as two near-identical copies that both reach into the
// v1 sliders by element id to discover their ranges (`bandwidth-low`.min and
// friends). There is one copy here and it goes through the same `actions` every
// other panel uses, so a mapped control and a click on screen take the same
// path.
//
// Hardware is normalised by its source into one of three events, so a function
// never has to care whether a dial, a fader or a button drove it:
//
//   { kind: 'relative', delta }   signed detents — encoder, jog dial
//   { kind: 'absolute', value }   0..1 — a fader or pot resting somewhere
//   { kind: 'trigger' }           a button going down
//
// Each function declares what it `accepts`. Learn mode uses that to refuse a
// pairing that cannot work — mapping a fader to "Next mode" would otherwise
// look mapped and do nothing.

import {
    MODES, MODE_BY_ID, bandwidthLimits,
    SQUELCH_MIN, SQUELCH_MAX, SQUELCH_STEP, squelchEnabled,
} from '../radio/constants.js';

// Band entry points. These are the digital-mode watering holes rather than the
// band edges, which is what v1 uses and what makes a band button useful: you
// land where there is something to hear.
export const BAND_FREQS = {
    band_160m: 1900000,
    band_80m: 3573000,
    band_60m: 5357000,
    band_40m: 7074000,
    band_30m: 10136000,
    band_20m: 14074000,
    band_17m: 18100000,
    band_15m: 21074000,
    band_12m: 24915000,
    band_10m: 28074000,
};

// Cycled in the order the mode selector shows them, so "next mode" walks the
// UI rather than a second order nothing else agrees with.
const MODE_CYCLE = MODES.map((m) => m.id);

const REL = 'relative';
const ABS = 'absolute';
const TRIG = 'trigger';

const PRESS = [TRIG, REL];        // a detent counts as a press for one-shot actions
const CONTINUOUS = [REL, ABS, TRIG];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Signed detents for this event. An absolute control has no direction of its
// own, so it is treated as a single step forward — which is what a pad or a
// button wired as a CC ends up sending.
function detents(ev) {
    if (ev.kind === REL) return ev.delta || 0;
    return 1;
}

// Maps an event onto a numeric range: absolute controls address it directly,
// relative ones walk it by `step` per detent from where the value is now.
function toRange(ev, current, min, max, step) {
    if (ev.kind === ABS) return min + clamp(ev.value, 0, 1) * (max - min);
    return clamp(current + step * detents(ev), min, max);
}

// A group of functions, in the order the learn dropdown lists them.
function group(name, items) {
    return items.map((f) => ({ group: name, ...f }));
}

const FREQUENCY = group('Frequency', [
    // Encoders are relative by definition; an absolute fader sweeping the whole
    // HF spectrum is not a control anyone wants, so they do not accept one.
    ...[10, 100, 500, 1000, 10000].map((hz) => ({
        id: `freq_enc_${hz === 1000 ? '1k' : hz === 10000 ? '10k' : hz}`,
        label: `Encoder (${hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`} steps)`,
        accepts: [REL, TRIG],
        run: (ev, ctx) => ctx.actions.nudge(hz * detents(ev)),
    })),
    {
        id: 'freq_step_up',
        label: 'Step up',
        hint: 'by the panel’s step size',
        accepts: PRESS,
        run: (ev, ctx) => ctx.actions.nudge(ctx.stepHz),
    },
    {
        id: 'freq_step_down',
        label: 'Step down',
        hint: 'by the panel’s step size',
        accepts: PRESS,
        run: (ev, ctx) => ctx.actions.nudge(-ctx.stepHz),
    },
]);

const MODE = group('Mode', [
    ...MODES.map((m) => ({
        id: `mode_${m.id}`,
        label: m.label,
        accepts: PRESS,
        run: (ev, ctx) => ctx.actions.setMode(m.id),
    })),
    {
        id: 'mode_next',
        label: 'Next mode',
        accepts: PRESS,
        run: (ev, ctx) => cycleMode(ctx, +1),
    },
    {
        id: 'mode_prev',
        label: 'Previous mode',
        accepts: PRESS,
        run: (ev, ctx) => cycleMode(ctx, -1),
    },
]);

function cycleMode(ctx, dir) {
    const cur = ctx.state().tuning.mode;
    const i = MODE_CYCLE.indexOf(cur);
    const next = MODE_CYCLE[(i + dir + MODE_CYCLE.length) % MODE_CYCLE.length];
    ctx.actions.setMode(next);
}

const BAND = group('Band', Object.entries(BAND_FREQS).map(([id, hz]) => ({
    id,
    label: `${id.slice(5)} (${(hz / 1e6).toFixed(3)} MHz)`,
    accepts: PRESS,
    run: (ev, ctx) => ctx.actions.setFrequency(hz),
})));

const AUDIO = group('Audio', [
    {
        id: 'volume_set',
        label: 'Volume',
        accepts: CONTINUOUS,
        run: (ev, ctx) => {
            const v = toRange(ev, ctx.state().audio.volume, 0, 1, 0.01);
            ctx.actions.setVolume(Math.round(v * 100) / 100);
        },
    },
    {
        id: 'mute_toggle',
        label: 'Mute toggle',
        accepts: PRESS,
        run: (ev, ctx) => ctx.actions.toggleMute(),
    },
    {
        // The passband edges are clamped to the mode's own limits rather than a
        // slider's DOM attributes — the limits move with the mode, and reading
        // them from `bandwidthLimits` is what the sliders themselves do.
        id: 'bw_low',
        label: 'Passband — low edge',
        accepts: CONTINUOUS,
        run: (ev, ctx) => {
            const { tuning } = ctx.state();
            const l = bandwidthLimits(tuning.mode);
            const step = (l.max - l.min) * 0.02;
            const low = toRange(ev, tuning.bandwidthLow, l.min, l.max, step);
            ctx.actions.setBandwidth(Math.round(low), tuning.bandwidthHigh);
        },
    },
    {
        id: 'bw_high',
        label: 'Passband — high edge',
        accepts: CONTINUOUS,
        run: (ev, ctx) => {
            const { tuning } = ctx.state();
            const l = bandwidthLimits(tuning.mode);
            const step = (l.max - l.min) * 0.02;
            const high = toRange(ev, tuning.bandwidthHigh, l.min, l.max, step);
            ctx.actions.setBandwidth(tuning.bandwidthLow, Math.round(high));
        },
    },
    {
        // The slider's floor doubles as "off", so a fader swept to the bottom
        // opens the gate rather than muting everything — same as the panel.
        id: 'squelch_set',
        label: 'Squelch threshold',
        accepts: CONTINUOUS,
        run: (ev, ctx) => {
            const v = toRange(ev, ctx.state().squelch.value, SQUELCH_MIN, SQUELCH_MAX, SQUELCH_STEP * 2);
            ctx.actions.setSquelch(Math.round(v / SQUELCH_STEP) * SQUELCH_STEP);
        },
    },
    {
        id: 'squelch_toggle',
        label: 'Squelch on/off',
        accepts: PRESS,
        run: (ev, ctx) => {
            const sq = ctx.state().squelch;
            // Off is the floor; turning it back on restores a usable threshold
            // rather than the floor it would otherwise sit on.
            ctx.actions.setSquelch(squelchEnabled(sq.value) ? SQUELCH_MIN : 40);
        },
    },
    {
        id: 'squelch_auto',
        label: 'Auto squelch',
        hint: 'set just above the current noise',
        accepts: PRESS,
        run: (ev, ctx) => ctx.actions.autoSquelch(),
    },
]);

const SPECTRUM = group('Spectrum', [
    {
        id: 'zoom_in',
        label: 'Zoom in',
        accepts: PRESS,
        run: (ev, ctx) => ctx.actions.zoomIn(ctx.state().tuning.frequency),
    },
    {
        id: 'zoom_out',
        label: 'Zoom out',
        accepts: PRESS,
        run: (ev, ctx) => ctx.actions.zoomOut(ctx.state().tuning.frequency),
    },
    {
        // One function for a dial: turn it either way to zoom. Steps are applied
        // one at a time because each is a halving or a doubling — see the zoom
        // ladder note in the README.
        id: 'zoom_dial',
        label: 'Zoom (dial)',
        accepts: [REL],
        run: (ev, ctx) => {
            const hz = ctx.state().tuning.frequency;
            const n = Math.min(4, Math.abs(detents(ev)));
            for (let i = 0; i < n; i += 1) {
                if (detents(ev) > 0) ctx.actions.zoomIn(hz);
                else ctx.actions.zoomOut(hz);
            }
        },
    },
    {
        id: 'spectrum_center',
        label: 'Centre on tuned',
        accepts: PRESS,
        run: (ev, ctx) => ctx.actions.centerOnTuned(),
    },
    {
        id: 'spectrum_reset',
        label: 'Reset zoom',
        accepts: PRESS,
        run: (ev, ctx) => ctx.actions.resetSpectrum(),
    },
]);

// Noise reduction is schema-driven — the server publishes which filters it has
// and v2 hardcodes none of them (see the DSP note in the README). So this group
// is generated from whatever `get_dsp_filters` returned, and a mapping made
// against a filter this receiver does not offer reports itself as unavailable
// instead of quietly doing nothing.
function dspGroup(schemas) {
    const names = (schemas || []).map((s) => s.name);
    const items = [
        {
            id: 'dsp_toggle',
            label: 'Noise reduction on/off',
            accepts: PRESS,
            run: (ev, ctx) => {
                const d = ctx.state().dsp;
                const filter = d.filter || names[0];
                if (!filter) return;
                ctx.actions.setDsp(filter, !d.enabled);
            },
        },
        {
            id: 'dsp_next',
            label: 'Next NR filter',
            accepts: PRESS,
            run: (ev, ctx) => cycleDsp(ctx, names, +1),
        },
        {
            id: 'dsp_prev',
            label: 'Previous NR filter',
            accepts: PRESS,
            run: (ev, ctx) => cycleDsp(ctx, names, -1),
        },
    ];
    for (const s of schemas || []) {
        items.push({
            id: `dsp_select_${s.name}`,
            label: `NR — ${s.name}`,
            hint: s.description || undefined,
            accepts: PRESS,
            run: (ev, ctx) => ctx.actions.setDsp(s.name, true),
        });
    }
    return group('Noise reduction', items);
}

function cycleDsp(ctx, names, dir) {
    if (!names.length) return;
    const d = ctx.state().dsp;
    const i = names.indexOf(d.filter);
    const next = names[(i + dir + names.length) % names.length];
    ctx.actions.setDsp(next, true);
}

// v1 ids whose function still exists here under a different name. v1 offers a
// single "CW" and sends cwu; v2 exposes both sidebands, so the old id has to
// keep resolving or an imported mapping quietly stops working.
const ALIAS = {
    mode_cw: 'mode_cwu',
};

// Functions v1 could map that v2 has no equivalent for. Kept by name so an
// imported v1 mapping file is reported honestly — the row shows as unavailable
// rather than being dropped on load, which would look like a corrupt import.
export const RETIRED = {
    nb_toggle: 'Noise blanker — v2 has no client-side blanker',
    vfo_ab_toggle: 'VFO A/B — v2 has no second VFO',
    nr2_toggle: 'Replaced by “Noise reduction on/off”',
};

// The full catalogue for the receiver we are connected to. `dspSchemas` comes
// from the radio's `dsp.schemas`, so it changes as the server reports them.
export function catalogue(dspSchemas) {
    return [...FREQUENCY, ...MODE, ...BAND, ...AUDIO, ...SPECTRUM, ...dspGroup(dspSchemas)];
}

export function findFunction(id, dspSchemas) {
    const wanted = ALIAS[id] || id;
    return catalogue(dspSchemas).find((f) => f.id === wanted) || null;
}

// Human-readable name for a function id, including ones this build retired.
export function functionLabel(id, dspSchemas) {
    const f = findFunction(id, dspSchemas);
    if (f) return f.label;
    if (RETIRED[id]) return id;
    return id;
}

// Runs a mapping. Returns false when the function is unknown to this build or
// cannot use this kind of event, so the caller can say so rather than leaving
// the operator wiggling a control that will never do anything.
export function runFunction(id, ev, ctx) {
    const fn = findFunction(id, ctx.state().dsp.schemas);
    if (!fn) return false;
    if (!fn.accepts.includes(ev.kind)) return false;
    fn.run(ev, ctx);
    return true;
}

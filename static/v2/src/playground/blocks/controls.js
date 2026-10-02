// Controls: blocks that put out a number for other blocks' settings to follow.
//
// A slider, a box, a switch and a list are knobs an operator turns — on the
// card itself, so a graph carries its own front panel, and a shared one
// arrives with it. Scale and Integrator do arithmetic on a control on its way:
// Scale to convert one quantity into another, Integrator to turn a stream of
// corrections into a position, which is what closing a loop needs — a
// counter's measured error, integrated, steering the shift in front of it, is
// a frequency lock.
//
// Wire one to any setting a block exposes as a control input (the ⊸ beside
// the setting in the inspector).

import { CONTROL, emitControl } from '../block.js';

const OUT = [{ name: 'out', kind: CONTROL }];
const BIG = 1e9;
const NUM = (label, def, extra = {}) => ({ kind: 'number', label, default: def, min: -BIG, max: BIG, step: 0.001, live: true, ...extra });

/** A control that puts out one value from its parameters, again whenever they change. */
function source(valueOf) {
    return () => {
        let value = null;
        let dirty = true;
        return {
            configure(p) {
                const v = valueOf(p);
                if (v !== value) {
                    value = v;
                    dirty = true;
                }
            },
            reset() { dirty = true; },
            read() { return { value }; },
            process(ins, outs) {
                if (dirty && value != null) {
                    emitControl(outs[0], value);
                    dirty = false;
                }
                return 0;
            },
        };
    };
}

export const SliderBlock = {
    type: 'slider',
    label: 'Slider',
    category: 'Control',
    summary: 'A knob on the canvas: drag it, and whatever it is wired to follows.',
    inputs: [],
    outputs: OUT,
    params: {
        value: NUM('Value', 0),
        min: NUM('Min', -1000),
        max: NUM('Max', 1000),
        step: NUM('Step', 1, { min: 0 }),
    },
    create: source((p) => Math.max(Math.min(p.min, p.max), Math.min(Math.max(p.min, p.max), p.value))),
};

export const NumberBlock = {
    type: 'number',
    label: 'Number',
    category: 'Control',
    summary: 'A value typed in, for a setting another block exposes.',
    inputs: [],
    outputs: OUT,
    params: { value: NUM('Value', 0) },
    create: source((p) => p.value),
};

export const ToggleBlock = {
    type: 'toggle',
    label: 'Toggle',
    category: 'Control',
    summary: 'A switch: puts out 1 when on and 0 when off.',
    inputs: [],
    outputs: OUT,
    params: { on: { kind: 'bool', label: 'On', default: false } },
    create: source((p) => (p.on ? 1 : 0)),
};

/** The numbers in a comma-separated list, ignoring anything that is not one. */
export function parseChoices(text) {
    const out = [];
    for (const part of String(text || '').split(/[,;\s]+/)) {
        if (part === '') continue;
        const v = Number(part);
        if (Number.isFinite(v) && !out.includes(v)) out.push(v);
    }
    return out;
}

export const DropdownBlock = {
    type: 'dropdown',
    label: 'Dropdown',
    category: 'Control',
    summary: 'A choice from a list of values — filter widths, say, or frequencies.',
    inputs: [],
    outputs: OUT,
    params: {
        choices: { kind: 'text', label: 'Choices', default: '500, 1000, 2700, 4000', max: 400 },
        index: { kind: 'number', label: 'Selected', default: 0, min: 0, max: 63, step: 1, live: true, control: false },
    },
    create: source((p) => {
        const list = parseChoices(p.choices);
        return list.length ? list[Math.max(0, Math.min(list.length - 1, Math.round(p.index)))] : null;
    }),
};

/** A control in, a control out, recomputed on each new value in. */
function transform(step) {
    return () => {
        let seen = -1;
        let value = null;
        let p = {};
        let state = {};
        return {
            configure(params) { p = params; },
            reset() { seen = -1; value = null; state = {}; },
            read() { return { value }; },
            command(name) { if (name === 'reset') { state = {}; seen = -1; value = null; } },
            process(ins, outs) {
                const input = ins[0];
                const fresh = input && input.seq !== seen && input.value != null;
                const v = step(p, fresh ? Number(input.value) : null, state, fresh);
                if (input) seen = input.seq;
                if (v != null && (fresh || value === null)) {
                    value = v;
                    emitControl(outs[0], v);
                }
                return 0;
            },
        };
    };
}

/** out = in × scale + offset. */
export const ScaleBlock = {
    type: 'control-scale',
    label: 'Scale & offset',
    category: 'Control',
    summary: 'out = in × scale + offset: turns one quantity into another, or flips a sign.',
    inputs: [{ name: 'in', kind: CONTROL }],
    outputs: OUT,
    params: { scale: NUM('Scale', 1), offset: NUM('Offset', 0) },
    create: transform((p, v) => (v == null ? null : v * p.scale + p.offset)),
};

// The functions Shape & round can put a value through, and what each does.
// Anything without an answer (the log of nothing, the root of a negative)
// gives no value, and nothing is sent for it.
export const SHAPE_FUNCTIONS = [
    { value: 'none', label: 'None', fn: (x) => x },
    { value: 'abs', label: 'Absolute value', fn: Math.abs },
    { value: 'negate', label: 'Negate', fn: (x) => -x },
    { value: 'reciprocal', label: '1 / x', fn: (x) => (x === 0 ? null : 1 / x) },
    { value: 'square', label: 'Square', fn: (x) => x * x },
    { value: 'sqrt', label: 'Square root', fn: (x) => (x < 0 ? null : Math.sqrt(x)) },
    { value: 'log10', label: 'log₁₀', fn: (x) => (x > 0 ? Math.log10(x) : null) },
    { value: 'ln', label: 'ln', fn: (x) => (x > 0 ? Math.log(x) : null) },
    { value: 'exp', label: 'eˣ', fn: Math.exp },
    { value: 'db-amp', label: 'To dB (amplitude, 20 log₁₀)', fn: (x) => (x > 0 ? 20 * Math.log10(x) : null) },
    { value: 'db-pow', label: 'To dB (power, 10 log₁₀)', fn: (x) => (x > 0 ? 10 * Math.log10(x) : null) },
    { value: 'from-db', label: 'From dB (amplitude)', fn: (x) => 10 ** (x / 20) },
];
const SHAPE_BY = Object.fromEntries(SHAPE_FUNCTIONS.map((f) => [f.value, f.fn]));

// How a value is rounded to a multiple of the step.
const ROUNDING = {
    'nearest': Math.round,
    'down': Math.floor,
    'up': Math.ceil,
    'toward-zero': Math.trunc,
};

// The most values Shape & round averages over.
const SHAPE_AVERAGE_MAX = 1000;

/**
 * A control's value, worked on in steps, each off until it is set:
 *
 *   average    the mean of the last N values — a jumpy reading, steadied
 *   function   abs, 1/x, a root, a log, to or from dB…
 *   scale      × scale + offset, as Scale & offset does
 *   clamp      held within min … max
 *   round      to a multiple of the step — 1 for whole numbers, 0.1 for one
 *              place, 5 or 100 for coarser — nearest, down, up or toward zero
 *   deadband   a change smaller than this is not passed on: a value sitting
 *              on a rounding boundary would otherwise flick between the two
 *              every time it wobbles
 *   only on change   nothing is sent while the result is what it was — so a
 *              rounded value goes out when it moves, not on every reading
 *
 * In that order, which is the order a reading wants: steadied, converted,
 * bounded, then made tidy to show or to set something by.
 */
export const ShapeBlock = {
    type: 'control-shape',
    label: 'Shape & round',
    category: 'Control',
    summary: 'Average, a function, scale, clamp, round, deadband — a control made the shape it needs to be.',
    inputs: [{ name: 'in', kind: CONTROL }],
    outputs: OUT,
    params: {
        average: { kind: 'number', label: 'Average of last', unit: 'values', default: 1, min: 1, max: SHAPE_AVERAGE_MAX, step: 1, live: true },
        fn: {
            kind: 'choice', label: 'Function', default: 'none',
            options: SHAPE_FUNCTIONS.map(({ value, label }) => ({ value, label })),
        },
        scale: NUM('Scale', 1),
        offset: NUM('Offset', 0),
        min: NUM('Min', -BIG),
        max: NUM('Max', BIG),
        rounding: {
            kind: 'choice', label: 'Round', default: 'none',
            options: [
                { value: 'none', label: 'No' },
                { value: 'nearest', label: 'To nearest' },
                { value: 'down', label: 'Down' },
                { value: 'up', label: 'Up' },
                { value: 'toward-zero', label: 'Toward zero' },
            ],
        },
        step: NUM('To a multiple of', 1, { min: 1e-9, showIf: (p) => p.rounding !== 'none' }),
        deadband: NUM('Ignore changes under', 0, { min: 0 }),
        onChange: { kind: 'bool', label: 'Send only when it changes', default: true, live: true },
    },
    create() {
        let p = {};
        let seen = -1;
        let value = null;
        let recent = [];
        return {
            configure(params) { p = params; },
            reset() { seen = -1; value = null; recent = []; },
            read() { return { value }; },
            process(ins, outs) {
                const input = ins[0];
                if (!input || input.seq === seen || input.value == null) return 0;
                seen = input.seq;
                let x = Number(input.value);
                if (!Number.isFinite(x)) return 0;
                const n = Math.max(1, Math.round(p.average || 1));
                recent.push(x);
                if (recent.length > n) recent = recent.slice(-n);
                if (n > 1) x = recent.reduce((a, b) => a + b, 0) / recent.length;
                x = (SHAPE_BY[p.fn] || SHAPE_BY.none)(x);
                if (x == null || !Number.isFinite(x)) return 0;
                x = x * p.scale + p.offset;
                x = Math.max(Math.min(p.min, p.max), Math.min(Math.max(p.min, p.max), x));
                const r = ROUNDING[p.rounding];
                if (r && p.step > 0) {
                    // Tidied, so 97 steps of 0.1 is 9.7 and not 9.700000000000001.
                    x = Number((r(x / p.step) * p.step).toPrecision(12));
                }
                if (value != null && p.deadband > 0 && Math.abs(x - value) < p.deadband) return 0;
                if (p.onChange && x === value) return 0;
                value = x;
                emitControl(outs[0], x);
                return 0;
            },
        };
    },
};

/**
 * Adds `gain × in` to its total on every new value in, within `min`..`max`,
 * starting at `initial`. A loop's integrator: fed an error, it moves its
 * output until the error is zero. With a counter's reading after a shift as
 * the error and a gain of −1 (or less, to settle gently), it holds a drifting
 * carrier at zero.
 */
export const IntegratorBlock = {
    type: 'integrator',
    label: 'Integrator',
    category: 'Control',
    summary: 'Adds gain × each new value to a running total — the heart of a lock loop.',
    inputs: [{ name: 'in', kind: CONTROL }],
    outputs: OUT,
    params: {
        gain: NUM('Gain', -0.5),
        initial: NUM('Start at', 0),
        min: NUM('Min', -100000),
        max: NUM('Max', 100000),
    },
    create: transform((p, v, st, fresh) => {
        if (st.acc === undefined) st.acc = p.initial;
        if (fresh) st.acc = Math.max(p.min, Math.min(p.max, st.acc + p.gain * v));
        return st.acc;
    }),
};

// How many values a plot keeps.
const PLOT_HISTORY = 240;

/** A control's value, and a trace of its recent past. */
export const ControlPlotBlock = {
    type: 'control-plot',
    label: 'Control plot',
    category: 'Viewers',
    summary: 'A control’s value and its recent history — watch a loop settle.',
    inputs: [{ name: 'in', kind: CONTROL }],
    outputs: [],
    // How the value is written on the card: rounded to so many places (or as
    // it comes, to seven figures), and a unit after it. The plot is drawn from
    // the values as they are either way.
    params: {
        decimals: {
            kind: 'choice', label: 'Decimals', default: 'auto',
            options: [{ value: 'auto', label: 'As it comes' }, ...[0, 1, 2, 3, 4].map((d) => ({ value: d, label: String(d) }))],
        },
        unit: { kind: 'text', label: 'Unit', default: '', max: 16 },
    },
    create() {
        const hist = new Float32Array(PLOT_HISTORY);
        let count = 0;
        let pos = 0;
        let seen = -1;
        let value = null;
        return {
            configure() {},
            reset() { count = 0; pos = 0; seen = -1; value = null; },
            read() {
                const n = Math.min(count, PLOT_HISTORY);
                const history = new Float32Array(n);
                for (let k = 0; k < n; k++) history[k] = hist[(pos - n + k + PLOT_HISTORY) % PLOT_HISTORY];
                return { value, history };
            },
            process(ins) {
                const input = ins[0];
                if (!input || input.seq === seen || input.value == null) return 0;
                seen = input.seq;
                value = Number(input.value);
                hist[pos] = value;
                pos = (pos + 1) % PLOT_HISTORY;
                count++;
                return 0;
            },
        };
    },
};

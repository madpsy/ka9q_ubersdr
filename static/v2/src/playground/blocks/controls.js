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
    params: {},
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

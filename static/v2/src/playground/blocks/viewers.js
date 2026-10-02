// Instruments: blocks that show what is on a wire without changing it.
//
// Every one is a sink — no outputs — so hanging one off an output adds a
// reader to that wire and nothing else: the signal carries on to wherever it
// was going. That is what makes them probes, and why the editor can attach one
// to any port in a press (see probes.js).
//
// The arithmetic is done here, in the worker; what goes back to the page is
// small and ready to draw — a spectrum's bins, a scope's trace as one min/max
// pair per column, a constellation's last few hundred points — and only for
// viewers the editor has asked about, at most a dozen times a second (see
// READ_EVERY_MS in workerCore.js).

import { COMPLEX, CONTROL, MESSAGE, REAL, emitControl } from '../block.js';
import { IQSpectrum } from '../../lib/iqSpectrum.js';

const DISPLAY = {
    kind: 'choice',
    label: 'Show',
    default: 'both',
    options: [
        { value: 'spectrum', label: 'Spectrum' },
        { value: 'waterfall', label: 'Waterfall' },
        { value: 'both', label: 'Both' },
    ],
};

/**
 * The two-sided spectrum of a complex signal: the picture at the top of the
 * IQ Demod panel, made by the same code (lib/iqSpectrum.js), so the two read
 * the same — same window, same 0 dBFS for a full-scale carrier, same
 * smoothing. Below zero on the left, above it on the right.
 */
export const IqSpectrumBlock = {
    type: 'iq-spectrum',
    label: 'IQ spectrum',
    category: 'Viewers',
    summary: 'Both sides of a complex signal, as the IQ Demod panel draws the stream — spectrum, waterfall or both.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [],
    params: {
        size: {
            kind: 'choice',
            label: 'Points',
            default: 1024,
            options: [512, 1024, 2048, 4096].map((v) => ({ value: v, label: String(v) })),
        },
        display: DISPLAY,
        peakHold: { kind: 'bool', label: 'Peak hold', default: true },
    },
    create() {
        let spec = null;
        let rate = 12000;
        let last = 0;
        return {
            configure(p, r) {
                rate = r;
                if (!spec || spec.size !== p.size) spec = new IQSpectrum(p.size);
            },
            reset() { if (spec) spec.reset(); last = 0; },
            read() {
                // The smoothing is per second, not per call, so how often the
                // page asks does not change how the picture moves.
                const now = typeof performance !== 'undefined' ? performance.now() : 0;
                const dt = last ? Math.min(1, (now - last) / 1000) : 0.08;
                last = now;
                const db = spec.frame(dt);
                return db ? { db, rate, size: spec.size, sided: 2 } : null;
            },
            process(ins, outs, n) {
                spec.push(ins[0].re, ins[0].im, n, rate);
                return 0;
            },
        };
    },
};

// The most points an X–Y figure is sent as.
const XY_POINTS = 2048;
// The most columns a trace is sent as. A card is three hundred pixels wide and
// the large view under a thousand, so this is already more than either draws.
const TRACE_COLUMNS = 1024;
// The most a scope keeps: 2^18 samples, which is two thirds of a second at
// 384 kHz and far more at any audio rate. A sweep may use a quarter of it, so
// there is always room to look back for a trigger.
const SCOPE_RING = 1 << 18;
// The channels, in order: the input names and the trigger's sources.
export const SCOPE_CHANNELS = ['a', 'b', 'c', 'd'];
// The colours a channel's trace can be, and what each channel starts as —
// four that are told apart at a glance, on the dark screen and the light.
export const SCOPE_COLOURS = [
    { value: 'blue', label: 'Blue', hex: '#08a2fb' },
    { value: 'violet', label: 'Violet', hex: '#a78bfa' },
    { value: 'green', label: 'Green', hex: '#34c77b' },
    { value: 'pink', label: 'Pink', hex: '#f472b6' },
    { value: 'yellow', label: 'Yellow', hex: '#e2b93b' },
    { value: 'orange', label: 'Orange', hex: '#f08a3c' },
    { value: 'red', label: 'Red', hex: '#f0646a' },
    { value: 'cyan', label: 'Cyan', hex: '#2fd0d8' },
    { value: 'grey', label: 'Grey', hex: '#9aa4b5' },
];
const SCOPE_DEFAULT_COLOURS = ['blue', 'violet', 'green', 'pink'];
// What a scope's control outputs can carry.
export const SCOPE_MEASURES = [
    { value: 'rms', label: 'RMS' },
    { value: 'vpp', label: 'Peak to peak' },
    { value: 'mean', label: 'Mean' },
    { value: 'min', label: 'Minimum' },
    { value: 'max', label: 'Maximum' },
    { value: 'hz', label: 'Frequency' },
];
// The most a scope has: its inputs, and an output for each beside the readings.
const SCOPE_INPUTS = SCOPE_CHANNELS.map((c, i) => ({ name: c, kind: REAL, ...(i ? { optional: true } : {}) }));
const SCOPE_OUTPUTS = [
    { name: 'readings', kind: MESSAGE },
    ...SCOPE_CHANNELS.map((c) => ({ name: `${c}-out`, kind: CONTROL })),
];
/** How many channels a scope's settings give it: 2 to 4. */
export const scopeChannels = (p) => Math.max(1, Math.min(SCOPE_CHANNELS.length, Number(p && p.channels) || 2));
// How many samples a slower channel may have waiting to be lined up.
const SCOPE_QUEUE = 1 << 16;

// The vertical ranges a scope offers, as ± full scale. "Auto" follows the
// trace; the rest pin the screen, which is what makes two captures comparable.
export const SCOPE_RANGES = [1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001];
// How long auto keeps a triggered sweep before free-running, in seconds.
const AUTO_HOLD_SEC = 0.25;

/**
 * An oscilloscope: up to four real signals on one screen, each in its own
 * colour, with the controls a scope has.
 *
 *   channels    A always, B to D where wired. They need not arrive at the same
 *               rate — a key level from an On-off detector at 500 Hz beside the
 *               audio it came from at 12 kHz — because the scope lines them up
 *               in time itself: it runs at the fastest input's rate, and each
 *               slower one holds its value until its next sample. Each keeps a
 *               little queue so that packets arriving a few samples apart, as
 *               decimating blocks deliver them, do not shift it.
 *
 *   time        `timebaseMs` is the sweep, `position` how far into it the
 *               trigger sits — 10% shows a little of what came before.
 *   amplitude   `range` is auto or a fixed ± full scale, `offset` moves the
 *               trace up and down, `coupling` AC takes the sweep's mean off.
 *   trigger     `mode`: auto (sweeps on a trigger, free-runs without one),
 *               normal (sweeps only on a trigger, holding the last until the
 *               next) or single (catches one sweep after it is armed and holds
 *               it). `source`, `slope` and `level` say what counts.
 *
 *   outputs     what it measures, every `reportMs`: `readings` as a message —
 *               p-p, RMS, mean, min, max and frequency for each wired channel,
 *               for a Message log to keep or save — and `a-out` to `d-out` as
 *               controls carrying the one measurement `measure` picks, to plot
 *               or to drive something with. Measured over the report interval
 *               (up to a quarter of what the scope keeps), not the sweep, so
 *               it runs whatever the trigger is doing.
 *
 * Arming a single sweep, and stopping or running the display, are commands
 * (see command()) rather than settings: they are things done once, not states
 * a saved graph should come back in.
 *
 * The trigger is searched for when the page asks — a dozen times a second —
 * over everything kept since the last ask, so nothing between two asks is
 * missed; and a single sweep is found from the moment of arming forwards, so
 * it is the first trigger after the press, not the latest.
 */
export const ScopeBlock = {
    type: 'scope',
    label: 'Oscilloscope',
    category: 'Viewers',
    summary: 'Real signals against time, with sweep, range, trigger and single-shot capture.',
    inputs: SCOPE_INPUTS,
    outputs: SCOPE_OUTPUTS,
    // Two channels to start with, up to four: the inputs and their outputs
    // follow `channels`, and the editor drops a wire to one that goes.
    inputsFor: (p) => SCOPE_INPUTS.slice(0, scopeChannels(p)),
    outputsFor: (p) => SCOPE_OUTPUTS.slice(0, 1 + scopeChannels(p)),
    // Its inputs at their own rates: see "channels" above, and compile().
    mixedRates: true,
    params: {
        channels: {
            kind: 'choice', label: 'Channels', default: 2,
            options: [{ value: 2, label: '2' }, { value: 3, label: '3' }, { value: 4, label: '4' }],
        },
        timebaseMs: { kind: 'number', label: 'Sweep', unit: 'ms', default: 10, min: 0.1, max: 500, step: 0.1, live: true },
        position: { kind: 'number', label: 'Trigger position', unit: '%', default: 10, min: 0, max: 90, step: 1, live: true },
        range: {
            kind: 'choice',
            label: 'Range',
            default: 'auto',
            options: [{ value: 'auto', label: 'Auto' }, ...SCOPE_RANGES.map((v) => ({ value: v, label: `±${v}` }))],
        },
        offset: { kind: 'number', label: 'Offset', default: 0, min: -1, max: 1, step: 0.01, live: true },
        coupling: {
            kind: 'choice', label: 'Coupling', default: 'dc',
            options: [{ value: 'dc', label: 'DC' }, { value: 'ac', label: 'AC' }],
        },
        mode: {
            kind: 'choice', label: 'Trigger', default: 'auto',
            options: [{ value: 'auto', label: 'Auto' }, { value: 'normal', label: 'Normal' }, { value: 'single', label: 'Single' }],
        },
        source: {
            kind: 'choice', label: 'Source', default: 'a',
            options: SCOPE_CHANNELS.map((c) => ({ value: c, label: c.toUpperCase() })),
        },
        slope: {
            kind: 'choice', label: 'Slope', default: 'rising',
            options: [{ value: 'rising', label: 'Rising' }, { value: 'falling', label: 'Falling' }],
        },
        level: { kind: 'number', label: 'Trigger level', default: 0, min: -1, max: 1, step: 0.001, live: true },
        // Against time, or A across and B up — a Lissajous figure, whose
        // shape is the phase between them: a line in phase, a circle at 90°.
        view: {
            kind: 'choice', label: 'View', default: 'time',
            options: [{ value: 'time', label: 'Time' }, { value: 'xy', label: 'X–Y' }],
        },
        reportMs: { kind: 'number', label: 'Report every', unit: 'ms', default: 500, min: 10, max: 60000, step: 10, control: false },
        measure: {
            kind: 'choice', label: 'Outputs carry', default: 'rms',
            options: SCOPE_MEASURES.map(({ value, label }) => ({ value, label })),
        },
        // Earlier sweeps left fading on the screen: an eye diagram, with the
        // sweep at two symbols and the trigger free-running.
        persistence: {
            kind: 'choice', label: 'Persistence', default: 'off',
            options: [{ value: 'off', label: 'Off' }, { value: 'short', label: 'Short' }, { value: 'long', label: 'Long' }],
        },
        // Each channel's trace colour.
        ...Object.fromEntries(SCOPE_CHANNELS.map((c, i) => [`colour${c.toUpperCase()}`, {
            kind: 'choice',
            label: `${c.toUpperCase()} colour`,
            default: SCOPE_DEFAULT_COLOURS[i],
            options: SCOPE_COLOURS.map(({ value, label }) => ({ value, label })),
            ...(i >= 2 ? { showIf: (p) => scopeChannels(p) > i } : {}),
        }])),
    },
    create() {
        const rings = SCOPE_CHANNELS.map(() => new Float32Array(SCOPE_RING));
        const [A, B] = rings;
        // Per channel: whether it is wired, its own rate, and — for one slower
        // than the scope's — its waiting samples, how far its next one is
        // due, and the value it is holding meanwhile.
        let wired = SCOPE_CHANNELS.map((c, i) => i === 0);
        let rates = SCOPE_CHANNELS.map(() => 12000);
        const queues = SCOPE_CHANNELS.map(() => ({ buf: new Float64Array(SCOPE_QUEUE), start: 0, count: 0 }));
        const due = SCOPE_CHANNELS.map(() => 0);
        const holding = SCOPE_CHANNELS.map(() => 0);
        // `pos` counts samples ever written; the ring holds the last
        // SCOPE_RING of them. Kept as a plain count (a double is exact far
        // past any session) so "the sample at count c" means one thing.
        let pos = 0;
        let rate = 12000;
        let p = {};
        let searched = 0;     // the trigger search has looked up to here
        let armedAt = null;   // single: the count when armed
        let state = 'running';
        let held = null;      // the sweep on screen while held or stopped
        let lastTrigger = -Infinity;
        const at = (ring, c) => ring[c % SCOPE_RING];
        const meanOf = (ring, start, n) => {
            let sum = 0;
            for (let c = 0; c < n; c++) sum += at(ring, start + c);
            return sum / n;
        };
        const oldest = () => Math.max(0, pos - SCOPE_RING);

        const crosses = (ring, c) => {
            const before = at(ring, c - 1);
            const now = at(ring, c);
            return p.slope === 'falling'
                ? before > p.level && now <= p.level
                : before < p.level && now >= p.level;
        };

        // A stretch of one channel, measured: what the readouts show, and what
        // the outputs report.
        const measureOf = (ring, start, n) => {
            let sum = 0;
            let sumSq = 0;
            let lo = Infinity;
            let hi = -Infinity;
            for (let c = 0; c < n; c++) {
                const v = at(ring, start + c);
                sum += v;
                sumSq += v * v;
                if (v < lo) lo = v;
                if (v > hi) hi = v;
            }
            const mean = sum / n;
            // Frequency: rising crossings of the mean, first to last, over the
            // time between them.
            let first = -1;
            let last = -1;
            let count = 0;
            for (let c = 1; c < n; c++) {
                if (at(ring, start + c - 1) < mean && at(ring, start + c) >= mean) {
                    if (first < 0) first = c;
                    last = c;
                    count++;
                }
            }
            return {
                mean,
                min: lo,
                max: hi,
                vpp: hi - lo,
                rms: Math.sqrt(Math.max(0, sumSq / n - (p.coupling === 'ac' ? mean * mean : 0))),
                hz: count >= 2 ? ((count - 1) * rate) / (last - first) : null,
            };
        };
        // Samples written since the last report.
        let sinceReport = 0;

        const sweep = (start, n, triggered) => {
            const cols = Math.min(TRACE_COLUMNS, n);
            const one = (ring) => {
                const m = measureOf(ring, start, n);
                const shift = p.coupling === 'ac' ? m.mean : 0;
                const min = new Float32Array(cols);
                const max = new Float32Array(cols);
                for (let k = 0; k < cols; k++) {
                    const c0 = Math.floor((k * n) / cols);
                    const c1 = Math.max(c0 + 1, Math.floor(((k + 1) * n) / cols));
                    let mn = Infinity;
                    let mx = -Infinity;
                    for (let c = c0; c < c1; c++) {
                        const v = at(ring, start + c);
                        if (v < mn) mn = v;
                        if (v > mx) mx = v;
                    }
                    min[k] = mn - shift;
                    max[k] = mx - shift;
                }
                return { min, max, vpp: m.vpp, rms: m.rms, mean: m.mean, hz: m.hz };
            };
            // X–Y wants the samples themselves, paired, not columns.
            let xy = null;
            if (p.view === 'xy' && wired[1]) {
                const m = Math.min(XY_POINTS, n);
                const x = new Float32Array(m);
                const y = new Float32Array(m);
                const ma = p.coupling === 'ac' ? meanOf(A, start, n) : 0;
                const mb = p.coupling === 'ac' ? meanOf(B, start, n) : 0;
                for (let k = 0; k < m; k++) {
                    const c = start + Math.floor((k * n) / m);
                    x[k] = at(A, c) - ma;
                    y[k] = at(B, c) - mb;
                }
                xy = { x, y };
            }
            const traces = {};
            SCOPE_CHANNELS.forEach((ch, i) => { traces[ch] = wired[i] ? one(rings[i]) : null; });
            return {
                ...traces,
                xy,
                rate, seconds: n / rate, triggered,
                pre: Math.round((p.position / 100) * n) / rate,
            };
        };

        return {
            configure(params, r, inRates) {
                p = params;
                rate = r;
                rates = SCOPE_CHANNELS.map((c, i) => (inRates && inRates[i] > 0 ? inRates[i] : r));
                // Leaving single lets go of what it caught.
                if (p.mode !== 'single' && (state === 'armed' || state === 'held')) {
                    state = 'running';
                    held = null;
                }
            },
            reset() {
                pos = 0; searched = 0; held = null; armedAt = null; state = 'running'; lastTrigger = -Infinity; sinceReport = 0;
                for (const q of queues) { q.start = 0; q.count = 0; }
                due.fill(0);
                holding.fill(0);
            },
            /** 'arm' a single sweep; 'stop' and 'run' the display. */
            command(cmd) {
                if (cmd === 'arm') {
                    armedAt = pos;
                    searched = pos;
                    state = 'armed';
                } else if (cmd === 'stop') {
                    state = 'stopped';
                } else if (cmd === 'run') {
                    state = 'running';
                    held = null;
                    searched = pos;
                }
            },
            read() {
                const n = Math.max(2, Math.min(SCOPE_RING >> 2, Math.round((p.timebaseMs / 1000) * rate)));
                const pre = Math.round((p.position / 100) * n);
                const si = SCOPE_CHANNELS.indexOf(p.source);
                const ring = si > 0 && wired[si] ? rings[si] : A;
                const out = (s) => ({ ...s, state, mode: p.mode });
                if (state === 'stopped' || state === 'held') return held ? out(held) : { state, mode: p.mode };
                if (pos - oldest() < n) return { state, mode: p.mode };

                // A trigger with `pre` samples before it and the rest of the
                // sweep after it, all still in the ring.
                const lo = Math.max(oldest() + pre + 1, searched);
                const hi = pos - (n - pre);
                let found = -1;
                if (state === 'armed') {
                    // The first after arming.
                    for (let c = Math.max(lo, armedAt + 1); c <= hi; c++) {
                        if (crosses(ring, c)) { found = c; break; }
                    }
                } else {
                    // The latest since last time.
                    for (let c = hi; c >= lo; c--) {
                        if (crosses(ring, c)) { found = c; break; }
                    }
                }
                // Next time, carry on from where a sweep could next start.
                searched = Math.max(searched, hi + 1);

                if (found >= 0) {
                    const s = sweep(found - pre, n, true);
                    if (state === 'armed') {
                        state = 'held';
                        held = s;
                        return out(s);
                    }
                    held = s;
                    lastTrigger = pos;
                    return out(s);
                }
                if (state === 'armed') return held ? out({ ...held, stale: true }) : { state, mode: p.mode };
                if (p.mode === 'normal') return held ? out({ ...held, stale: true }) : { state, mode: p.mode };
                // Auto, and nothing new: keep the last triggered sweep for a
                // moment — a 5 Hz tone triggers less often than the screen is
                // drawn, and flicking to free-run between triggers would make
                // it unreadable — then free-run, as a scope's auto does.
                if (held && pos - lastTrigger < AUTO_HOLD_SEC * rate) return out({ ...held, stale: true });
                return out(sweep(pos - n, n, false));
            },
            process(ins, outs, n) {
                wired = SCOPE_CHANNELS.map((c, i) => !!(ins[i] && ins[i].re));
                // The clock: the first wired channel at the scope's own rate
                // (the fastest). Its samples are written as they are; every
                // other channel is lined up against them.
                let clock = wired.findIndex((w, i) => w && rates[i] >= rate);
                if (clock < 0) clock = 0;
                const count = (i) => (ins[i].n != null ? ins[i].n : n);
                // Everything else into its queue first.
                SCOPE_CHANNELS.forEach((c, i) => {
                    if (!wired[i] || i === clock) return;
                    const q = queues[i];
                    const x = ins[i].re;
                    const m = count(i);
                    for (let k = 0; k < m; k++) {
                        if (q.count === SCOPE_QUEUE) { q.start = (q.start + 1) % SCOPE_QUEUE; q.count--; }
                        q.buf[(q.start + q.count) % SCOPE_QUEUE] = x[k];
                        q.count++;
                    }
                });
                const x = ins[clock] ? ins[clock].re : null;
                const m = x ? count(clock) : 0;
                for (let k = 0; k < m; k++) {
                    const at = (pos + k) % SCOPE_RING;
                    for (let i = 0; i < rings.length; i++) {
                        if (i === clock) { rings[i][at] = x[k]; continue; }
                        if (!wired[i]) { rings[i][at] = 0; continue; }
                        // This channel's next sample is due once its own
                        // period has passed in the clock's samples.
                        const q = queues[i];
                        due[i] += rates[i] / rate;
                        while (due[i] >= 1 && q.count > 0) {
                            holding[i] = q.buf[q.start];
                            q.start = (q.start + 1) % SCOPE_QUEUE;
                            q.count--;
                            due[i] -= 1;
                        }
                        // Ran dry — a packet late: hold, and do not bank the
                        // time, or it would rush to catch up when it comes.
                        if (due[i] > 1) due[i] = 1;
                        rings[i][at] = holding[i];
                    }
                }
                // A queue that keeps growing is a channel running ahead of the
                // clock (or the clock stalled): keep only its latest, so it
                // cannot drift further and further behind what it shows.
                SCOPE_CHANNELS.forEach((c, i) => {
                    const q = queues[i];
                    const most = Math.max(64, Math.round(rates[i] * 0.25));
                    if (q.count > most) {
                        const keep = Math.max(8, Math.round(rates[i] * 0.02));
                        q.start = (q.start + q.count - keep) % SCOPE_QUEUE;
                        q.count = keep;
                    }
                });
                pos += m;
                // Every report interval: what each channel measured over it.
                sinceReport += m;
                const every = Math.max(1, Math.round(((p.reportMs || 500) / 1000) * rate));
                if (sinceReport >= every && pos > 1) {
                    const span = Math.min(sinceReport, SCOPE_RING >> 2, pos);
                    sinceReport = 0;
                    const reading = { type: 'measure', at: pos / rate };
                    SCOPE_CHANNELS.forEach((ch, i) => {
                        if (!wired[i]) return;
                        const v = measureOf(rings[i], pos - span, span);
                        reading[ch] = v;
                        const out = outs && outs[1 + i];
                        const value = v[p.measure || 'rms'];
                        if (out && value != null && Number.isFinite(value)) emitControl(out, value);
                    });
                    if (outs && outs[0] && outs[0].list) outs[0].list.push(reading);
                }
                return 0;
            },
        };
    },
};

// How many columns a strip chart keeps: about a column a pixel on a large card.
export const STRIP_COLUMNS = 480;

/**
 * A strip chart: one signal, or two, scrolling — a chart recorder's paper, the
 * newest at the right. Each column is the minimum to maximum over its share of
 * the span, so a fast signal shows its envelope and nothing between samples is
 * lost. What a scope cannot do: a key, a level or a phase over the last half
 * minute, read off as it went. The two may arrive at different rates.
 */
export const StripChartBlock = {
    type: 'strip-chart',
    label: 'Strip chart',
    category: 'Viewers',
    summary: 'One or two signals scrolling past over a set span, a chart recorder’s paper — a key, a level, a phase, over the last few seconds or minutes.',
    // Any numbers, not audio: nothing here reaches a speaker, so nothing clips.
    inputs: [{ name: 'a', kind: REAL, audio: false }, { name: 'b', kind: REAL, optional: true, audio: false }],
    outputs: [],
    mixedRates: true,
    params: {
        spanSec: { kind: 'number', label: 'Span', unit: 's', default: 10, min: 0.5, max: 600, step: 0.5, control: false },
        range: { kind: 'choice', label: 'Range', default: 'auto', options: [{ value: 'auto', label: 'Auto' }, { value: 'fixed', label: 'Fixed' }] },
        min: { kind: 'number', label: 'Bottom', default: -1, min: -1e6, max: 1e6, step: 0.01, live: true, showIf: (p) => p.range === 'fixed' },
        max: { kind: 'number', label: 'Top', default: 1, min: -1e6, max: 1e6, step: 0.01, live: true, showIf: (p) => p.range === 'fixed' },
    },
    create() {
        let p = {};
        let rates = [12000, 12000];
        let span = 10;
        // Per channel: a ring of columns, and the column being filled.
        const make = () => ({ lo: new Float32Array(STRIP_COLUMNS).fill(NaN), hi: new Float32Array(STRIP_COLUMNS).fill(NaN), pos: 0, cLo: Infinity, cHi: -Infinity, got: 0 });
        let ch = [make(), make()];
        let wired = [true, false];
        return {
            configure(params, r, inRates) {
                p = params;
                rates = [0, 1].map((i) => (inRates && inRates[i] > 0 ? inRates[i] : r));
                if (params.spanSec !== span) { span = params.spanSec; ch = [make(), make()]; }
            },
            reset() { ch = [make(), make()]; },
            command(name) { if (name === 'clear') ch = [make(), make()]; },
            read() {
                const out = { span, columns: STRIP_COLUMNS, range: p.range === 'fixed' ? [p.min, p.max] : null };
                ['a', 'b'].forEach((name, i) => {
                    if (!wired[i]) { out[name] = null; return; }
                    const c = ch[i];
                    const lo = new Float32Array(STRIP_COLUMNS);
                    const hi = new Float32Array(STRIP_COLUMNS);
                    for (let k = 0; k < STRIP_COLUMNS; k++) {
                        lo[k] = c.lo[(c.pos + k) % STRIP_COLUMNS];
                        hi[k] = c.hi[(c.pos + k) % STRIP_COLUMNS];
                    }
                    out[name] = { lo, hi, last: c.got ? (c.cLo + c.cHi) / 2 : hi[STRIP_COLUMNS - 1] };
                });
                return out;
            },
            process(ins) {
                wired = [!!(ins[0] && ins[0].re), !!(ins[1] && ins[1].re)];
                for (let i = 0; i < 2; i++) {
                    if (!wired[i]) continue;
                    const x = ins[i].re;
                    const m = ins[i].n;
                    const c = ch[i];
                    const per = Math.max(1, (rates[i] * span) / STRIP_COLUMNS);
                    for (let k = 0; k < m; k++) {
                        const v = x[k];
                        if (v < c.cLo) c.cLo = v;
                        if (v > c.cHi) c.cHi = v;
                        if (++c.got >= per) {
                            c.lo[c.pos] = c.cLo;
                            c.hi[c.pos] = c.cHi;
                            c.pos = (c.pos + 1) % STRIP_COLUMNS;
                            c.cLo = Infinity; c.cHi = -Infinity; c.got = 0;
                        }
                    }
                }
                return 0;
            },
        };
    },
};

/**
 * A histogram: how a signal's values are spread — a key's two levels, a
 * slicer's eye opening, noise's bell. Counted for ever, or with older counts
 * fading so it follows a change. The range is set, or found from the first
 * second of the signal (Clear finds it again).
 */
export const HistogramBlock = {
    type: 'histogram',
    label: 'Histogram',
    category: 'Viewers',
    summary: 'How a signal’s values are spread — two clean levels, a bell of noise, a slicer’s margin — with its mean and spread.',
    inputs: [{ name: 'in', kind: REAL, audio: false }],
    outputs: [],
    params: {
        bins: { kind: 'number', label: 'Bins', default: 64, min: 8, max: 512, step: 1, control: false },
        range: { kind: 'choice', label: 'Range', default: 'auto', options: [{ value: 'auto', label: 'Found from the signal' }, { value: 'fixed', label: 'Fixed' }] },
        min: { kind: 'number', label: 'From', default: -1, min: -1e6, max: 1e6, step: 0.01, control: false, showIf: (p) => p.range === 'fixed' },
        max: { kind: 'number', label: 'To', default: 1, min: -1e6, max: 1e6, step: 0.01, control: false, showIf: (p) => p.range === 'fixed' },
        decaySec: { kind: 'number', label: 'Fade over', unit: 's', default: 0, min: 0, max: 3600, step: 1, live: true },
    },
    create() {
        let p = {};
        let rate = 12000;
        let counts = new Float64Array(64);
        let lo = -1;
        let hi = 1;
        let found = false;
        let probe = [];
        let sum = 0; let sumSq = 0; let total = 0;
        let wasFixed = false;
        const clear = () => { counts.fill(0); found = false; probe = []; sum = 0; sumSq = 0; total = 0; };
        const count = (x, n) => {
            const bins = counts.length;
            const scale = bins / (hi - lo);
            for (let k = 0; k < n; k++) {
                const v = x[k];
                counts[Math.max(0, Math.min(bins - 1, Math.floor((v - lo) * scale)))]++;
                sum += v; sumSq += v * v; total++;
            }
        };
        return {
            configure(params, r) {
                p = params;
                rate = r || rate;
                const bins = Math.max(8, Math.round(params.bins));
                if (bins !== counts.length) { counts = new Float64Array(bins); clear(); }
                const fixed = params.range === 'fixed';
                if (fixed) { lo = Math.min(params.min, params.max); hi = Math.max(params.min, params.max, lo + 1e-9); found = true; }
                // Back to found-from-the-signal: found afresh.
                else if (wasFixed) clear();
                wasFixed = fixed;
            },
            reset() { clear(); },
            command(name) { if (name === 'clear') clear(); },
            read() {
                const mean = total ? sum / total : null;
                return {
                    counts: Float32Array.from(counts), lo, hi, found, total,
                    mean, sd: total ? Math.sqrt(Math.max(0, sumSq / total - mean * mean)) : null,
                };
            },
            process(ins, outs, n) {
                const x = ins[0].re;
                if (!found) {
                    // The first second of signal sets the range: its 0.5 to
                    // 99.5 percentiles, a little wider.
                    for (let k = 0; k < n; k++) probe.push(x[k]);
                    if (probe.length < Math.min(rate, 48000)) return 0;
                    const a = probe.slice().sort((u, v) => u - v);
                    const pl = a[Math.floor(a.length * 0.005)];
                    const ph = a[Math.floor(a.length * 0.995)];
                    const pad = (ph - pl) * 0.1 || Math.abs(ph) * 0.1 || 1;
                    lo = pl - pad;
                    hi = ph + pad;
                    found = true;
                    count(probe, probe.length);
                    probe = [];
                    return 0;
                }
                if (p.decaySec > 0) {
                    const f = Math.exp(-n / (rate * p.decaySec));
                    for (let b = 0; b < counts.length; b++) counts[b] *= f;
                    sum *= f; sumSq *= f; total *= f;
                }
                count(x, n);
                return 0;
            },
        };
    },
};

const READOUT_MEASURES = [
    { value: 'last', label: 'Latest' },
    { value: 'mean', label: 'Mean' },
    { value: 'rms', label: 'RMS' },
    { value: 'peak', label: 'Peak (absolute)' },
    { value: 'min', label: 'Minimum' },
    { value: 'max', label: 'Maximum' },
    { value: 'pp', label: 'Peak to peak' },
];

/**
 * A number: a signal's value over a window — its mean, RMS, peak, extremes —
 * written large, and sent as a control every window to plot or to steer by.
 */
export const ReadoutBlock = {
    type: 'readout',
    label: 'Readout',
    category: 'Viewers',
    summary: 'A signal as a number — its latest, mean, RMS, peak or extremes over a window — written large, and as a control.',
    inputs: [{ name: 'in', kind: REAL, audio: false }],
    outputs: [{ name: 'value', kind: CONTROL }],
    params: {
        measure: { kind: 'choice', label: 'Shows', default: 'mean', options: READOUT_MEASURES },
        windowMs: { kind: 'number', label: 'Over', unit: 'ms', default: 500, min: 1, max: 60000, step: 1, live: true },
        decimals: {
            kind: 'choice', label: 'Decimals', default: 'auto',
            options: [{ value: 'auto', label: 'As it comes' }, ...[0, 1, 2, 3, 4, 5, 6].map((d) => ({ value: d, label: String(d) }))],
        },
        unit: { kind: 'text', label: 'Unit', default: '', max: 16 },
    },
    create() {
        let p = {};
        let rate = 12000;
        let got = 0; let sum = 0; let sumSq = 0; let lo = Infinity; let hi = -Infinity; let peak = 0; let last = 0;
        let value = null;
        const reset = () => { got = 0; sum = 0; sumSq = 0; lo = Infinity; hi = -Infinity; peak = 0; };
        return {
            configure(params, r) { p = params; rate = r || rate; },
            reset() { reset(); value = null; },
            read() { return { value, measure: p.measure }; },
            process(ins, outs, n) {
                const x = ins[0].re;
                const per = Math.max(1, Math.round((p.windowMs / 1000) * rate));
                for (let k = 0; k < n; k++) {
                    const v = x[k];
                    last = v;
                    sum += v; sumSq += v * v;
                    if (v < lo) lo = v;
                    if (v > hi) hi = v;
                    if (Math.abs(v) > peak) peak = Math.abs(v);
                    if (++got >= per) {
                        const mean = sum / got;
                        value = { last, mean, rms: Math.sqrt(sumSq / got), peak, min: lo, max: hi, pp: hi - lo }[p.measure] ?? mean;
                        if (outs[0]) emitControl(outs[0], value);
                        reset();
                    }
                }
                return 0;
            },
        };
    },
};

/**
 * A time interval counter, the instrument a timing lab measures with: the time
 * from an edge on `start` to the next edge on `stop`.
 *
 * An edge is where a signal crosses `level` the way its slope says, placed
 * between the two samples either side of it by straight-line interpolation —
 * so the reading is finer than a sample. Each start pairs with the first stop
 * after it, within `maxMs`; a stop with no start that recent is not counted.
 *
 * The two may arrive at different rates — a Clock's pulses at the stream's
 * rate beside a detector's output decimated far below it — and are timed
 * each on its own sample count, which every packet advances by the same span.
 *
 * What it is for: a Clock's `pps` on start and a time signal's ticks (an
 * envelope, a Threshold) on stop is the signal's propagation delay; a Morse
 * encoder's key on start and a decoder's on stop is a chain's latency.
 */
export const IntervalCounterBlock = {
    type: 'interval-counter',
    label: 'Time interval counter',
    category: 'Viewers',
    summary: 'The time from an edge on start to the next on stop, finer than a sample, with its mean and spread — a propagation delay, a latency.',
    inputs: [{ name: 'start', kind: REAL }, { name: 'stop', kind: REAL }],
    outputs: [{ name: 'interval', kind: CONTROL }],
    mixedRates: true,
    params: {
        level: { kind: 'number', label: 'Level', default: 0.5, min: -1000, max: 1000, step: 0.001, live: true },
        startSlope: { kind: 'choice', label: 'Start on', default: 'rising', options: [{ value: 'rising', label: 'Rising edge' }, { value: 'falling', label: 'Falling edge' }] },
        stopSlope: { kind: 'choice', label: 'Stop on', default: 'rising', options: [{ value: 'rising', label: 'Rising edge' }, { value: 'falling', label: 'Falling edge' }] },
        maxMs: { kind: 'number', label: 'Longest interval', unit: 'ms', default: 1000, min: 0.01, max: 60000, step: 0.01, live: true },
        average: { kind: 'number', label: 'Statistics over', unit: 'intervals', default: 20, min: 1, max: 1000, step: 1, live: true },
    },
    create() {
        let p = {};
        let rates = [12000, 12000];
        const count = [0, 0];
        const prev = [null, null];
        let starts = [];
        let recent = [];
        let history = [];
        let last = null;
        let total = 0;
        let missed = 0;
        const crossing = (a, b, slope, level) => (slope === 'falling' ? a > level && b <= level : a < level && b >= level);
        return {
            configure(params, r, inRates) {
                p = params;
                rates = [0, 1].map((i) => (inRates && inRates[i] > 0 ? inRates[i] : r));
            },
            reset() {
                count[0] = count[1] = 0; prev[0] = prev[1] = null;
                starts = []; recent = []; history = []; last = null; total = 0; missed = 0;
            },
            command(name) { if (name === 'clear') { recent = []; history = []; last = null; total = 0; missed = 0; } },
            read() {
                if (!recent.length) return { last: null, count: total, missed, history: Float32Array.from(history) };
                const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
                const sd = Math.sqrt(recent.reduce((a, b) => a + (b - mean) ** 2, 0) / recent.length);
                return {
                    last, mean, sd,
                    min: Math.min(...recent), max: Math.max(...recent),
                    count: total, missed,
                    history: Float32Array.from(history),
                };
            },
            process(ins, outs, n) {
                const level = p.level;
                const maxS = p.maxMs / 1000;
                // Start first, so a stop in the same packet finds the start before it.
                for (const i of [0, 1]) {
                    const x = ins[i];
                    if (!x || !x.re) continue;
                    const m = x.n != null ? x.n : n;
                    const slope = i === 0 ? p.startSlope : p.stopSlope;
                    for (let k = 0; k < m; k++) {
                        const v = x.re[k];
                        const a = prev[i];
                        prev[i] = v;
                        if (a === null || !crossing(a, v, slope, level)) continue;
                        const frac = v === a ? 0 : (level - a) / (v - a);
                        const at = (count[i] + k - 1 + frac) / rates[i];
                        if (i === 0) {
                            starts.push(at);
                            continue;
                        }
                        // The latest start before this stop, recent enough.
                        let j = starts.length - 1;
                        while (j >= 0 && starts[j] > at) j--;
                        if (j < 0 || at - starts[j] > maxS) { missed++; continue; }
                        const ms = (at - starts[j]) * 1000;
                        starts.splice(0, j + 1);
                        last = ms;
                        total++;
                        recent.push(ms);
                        const keep = Math.max(1, Math.round(p.average || 20));
                        if (recent.length > keep) recent = recent.slice(-keep);
                        history.push(ms);
                        if (history.length > 240) history = history.slice(-240);
                        if (outs[0]) emitControl(outs[0], ms);
                    }
                    count[i] += m;
                }
                // Starts too old to be paired with anything now.
                const nowS = count[0] / rates[0];
                starts = starts.filter((s) => nowS - s <= maxS + 1);
                return 0;
            },
        };
    },
};

/**
 * I against Q, point by point: the constellation. A carrier is a dot (or a
 * circle, if it is not quite at zero — it turns), AM is a line through the
 * middle, FM a ring, and PSK the clusters its name promises. `every` takes one
 * sample in so many, which on a wide stream spreads the points over more time.
 */
export const ConstellationBlock = {
    type: 'constellation',
    label: 'Constellation',
    category: 'Viewers',
    summary: 'I against Q: what the modulation does to the signal’s phase and amplitude.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [],
    params: {
        points: {
            kind: 'choice',
            label: 'Points',
            default: 512,
            options: [128, 256, 512, 1024, 2048].map((v) => ({ value: v, label: String(v) })),
        },
        every: { kind: 'number', label: 'Take every', default: 1, min: 1, max: 256, step: 1, live: true },
        normalise: { kind: 'bool', label: 'Scale to fit', default: true },
    },
    create() {
        let I = new Float32Array(512);
        let Q = new Float32Array(512);
        let pos = 0;
        let filled = 0;
        let skip = 0;
        let p = {};
        return {
            configure(params) {
                p = params;
                if (I.length !== params.points) {
                    I = new Float32Array(params.points);
                    Q = new Float32Array(params.points);
                    pos = 0;
                    filled = 0;
                }
            },
            reset() { pos = 0; filled = 0; skip = 0; },
            read() {
                if (!filled) return null;
                const n = filled;
                const i = new Float32Array(n);
                const q = new Float32Array(n);
                let peak = 0;
                // Oldest first, so the drawing can fade along the trail.
                for (let k = 0; k < n; k++) {
                    const at = (pos - n + k + I.length) % I.length;
                    i[k] = I[at];
                    q[k] = Q[at];
                    const m = Math.hypot(I[at], Q[at]);
                    if (m > peak) peak = m;
                }
                return { i, q, scale: p.normalise ? (peak > 0 ? 1 / peak : 1) : 1 };
            },
            process(ins, outs, n) {
                const step = Math.max(1, Math.round(p.every || 1));
                const re = ins[0].re;
                const im = ins[0].im;
                for (let k = 0; k < n; k++) {
                    if (++skip < step) continue;
                    skip = 0;
                    I[pos] = re[k];
                    Q[pos] = im[k];
                    pos = pos + 1 === I.length ? 0 : pos + 1;
                    if (filled < I.length) filled++;
                }
                return 0;
            },
        };
    },
};

// ── measuring instruments ────────────────────────────────────────────────────

// How many gates a counter remembers, for its drift and its spread.
const COUNTER_HISTORY = 20;

const GATES = [0.1, 0.5, 1, 2, 5, 10];

/**
 * A frequency counter for the strongest signal on a complex wire.
 *
 * Over each gate it sums z[k]·conj(z[k−1]): every term's angle is the phase
 * advanced in one sample, and the sum weights each by the signal's power, so
 * the angle of the total is the frequency of whatever dominates — a carrier
 * over noise reads to a small fraction of a hertz in a second. Two signals of
 * similar strength read as somewhere between them; filter first to pick one.
 *
 * Each gate's reading is relative to the wire's zero. The editor adds the
 * wire's place on the air (probes.js) to show the real frequency.
 */
export const FrequencyCounterBlock = {
    type: 'frequency-counter',
    label: 'Frequency counter',
    category: 'Viewers',
    summary: 'The strongest signal’s frequency to a fraction of a hertz, with its drift.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    // Each gate's reading, in Hz from the wire's zero, as a control — to
    // steer a shift with, through an integrator, and lock to a carrier.
    outputs: [{ name: 'hz', kind: CONTROL }],
    params: {
        gateSec: {
            kind: 'choice', label: 'Gate', default: 1,
            options: GATES.map((v) => ({ value: v, label: v < 1 ? `${v * 1000} ms` : `${v} s` })),
        },
    },
    create() {
        let rate = 12000;
        let gate = 1;
        let lastI = 0;
        let lastQ = 0;
        let sr = 0;
        let si = 0;
        let pow = 0;
        let count = 0;
        const history = [];
        let latest = null;
        let out = null;
        const finish = () => {
            const hz = (Math.atan2(si, sr) * rate) / (2 * Math.PI);
            const db = pow > 0 ? 10 * Math.log10(pow / count) : null;
            history.push(hz);
            if (history.length > COUNTER_HISTORY) history.shift();
            // Drift: the least-squares slope through the remembered gates.
            let drift = null;
            let spread = null;
            const n = history.length;
            if (n >= 3) {
                const mx = (n - 1) / 2;
                const my = history.reduce((a, b) => a + b, 0) / n;
                let num = 0;
                let den = 0;
                let ss = 0;
                history.forEach((y, x) => { num += (x - mx) * (y - my); den += (x - mx) ** 2; });
                const slope = num / den;
                history.forEach((y, x) => { ss += (y - (my + slope * (x - mx))) ** 2; });
                drift = slope / gate;
                spread = Math.sqrt(ss / (n - 2));
            }
            latest = { hz, db, drift, spread, gates: n };
            if (out && Number.isFinite(hz)) emitControl(out, hz);
            sr = 0; si = 0; pow = 0; count = 0;
        };
        return {
            configure(p, r) {
                if (r !== rate || p.gateSec !== gate) {
                    history.length = 0;
                    latest = null;
                    sr = 0; si = 0; pow = 0; count = 0;
                }
                rate = r;
                gate = p.gateSec;
            },
            reset() { history.length = 0; latest = null; sr = 0; si = 0; pow = 0; count = 0; lastI = 0; lastQ = 0; },
            read() {
                const need = Math.max(1, Math.round(gate * rate));
                return { ...(latest || {}), progress: Math.min(1, count / need), gateSec: gate, rate };
            },
            process(ins, outs, n) {
                out = outs[0];
                const I = ins[0].re;
                const Q = ins[0].im;
                const need = Math.max(1, Math.round(gate * rate));
                for (let k = 0; k < n; k++) {
                    const i = I[k];
                    const q = Q[k];
                    sr += i * lastI + q * lastQ;
                    si += q * lastI - i * lastQ;
                    pow += i * i + q * q;
                    lastI = i;
                    lastQ = q;
                    if (++count >= need) finish();
                }
                return 0;
            },
        };
    },
};

const WINDOWS = [50, 100, 200, 500, 1000, 2000];
const WINDOW_PARAM = {
    kind: 'choice', label: 'Window', default: 200,
    options: WINDOWS.map((v) => ({ value: v, label: v < 1000 ? `${v} ms` : `${v / 1000} s` })),
};

/** Phase in degrees, −180 to 180. */
const deg = (rad) => {
    let d = (rad * 180) / Math.PI;
    while (d > 180) d -= 360;
    while (d <= -180) d += 360;
    return d;
};

/**
 * Gain and phase from a reference `a` to a measured `b`, at the frequency
 * that dominates `a` — on two real signals.
 *
 * Over each window: the frequency from `a`'s crossings of its own mean, then
 * both signals projected onto that frequency (a single-bin DFT, Hann-windowed
 * so a neighbour does not leak in), and the ratio of the two projections is
 * the answer — its angle the phase, its size the gain. Wire `a` to a block's
 * input and `b` to its output and this is that block's response at the
 * frequency going through it, delay included: a filter's linear-phase delay
 * shows as phase that grows with frequency.
 */
export const PhaseMeterBlock = {
    type: 'phase-meter',
    label: 'Gain & phase (audio)',
    category: 'Viewers',
    summary: 'Gain and phase from a to b at a’s strongest frequency — a block’s response, across it.',
    inputs: [{ name: 'a', kind: REAL }, { name: 'b', kind: REAL }],
    outputs: [],
    params: { windowMs: WINDOW_PARAM },
    create() {
        let rate = 12000;
        let N = 2400;
        let A = new Float64Array(N);
        let B = new Float64Array(N);
        let fill = 0;
        let latest = null;
        const measure = () => {
            let mean = 0;
            for (let k = 0; k < N; k++) mean += A[k];
            mean /= N;
            let first = -1;
            let last = -1;
            let crossings = 0;
            for (let k = 1; k < N; k++) {
                if (A[k - 1] < mean && A[k] >= mean) {
                    if (first < 0) first = k;
                    last = k;
                    crossings++;
                }
            }
            if (crossings < 2) { latest = { hz: null }; return; }
            const hz = ((crossings - 1) * rate) / (last - first);
            const w = (2 * Math.PI * hz) / rate;
            let ar = 0; let ai = 0; let br = 0; let bi = 0;
            for (let k = 0; k < N; k++) {
                const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (N - 1));
                const c = Math.cos(w * k) * h;
                const s = -Math.sin(w * k) * h;
                ar += (A[k] - mean) * c; ai += (A[k] - mean) * s;
                br += B[k] * c; bi += B[k] * s;
            }
            const ma = Math.hypot(ar, ai);
            const mb = Math.hypot(br, bi);
            latest = {
                hz,
                phaseDeg: ma > 0 && mb > 0 ? deg(Math.atan2(bi, br) - Math.atan2(ai, ar)) : null,
                gainDb: ma > 0 && mb > 0 ? 20 * Math.log10(mb / ma) : null,
            };
        };
        return {
            configure(p, r) {
                const n = Math.max(16, Math.round((p.windowMs / 1000) * r));
                if (n !== N || r !== rate) {
                    N = n;
                    A = new Float64Array(N);
                    B = new Float64Array(N);
                    fill = 0;
                    latest = null;
                }
                rate = r;
            },
            reset() { fill = 0; latest = null; },
            read() { return { ...(latest || {}), rate }; },
            process(ins, outs, n) {
                const a = ins[0].re;
                const b = ins[1].re;
                for (let k = 0; k < n; k++) {
                    A[fill] = a[k];
                    B[fill] = b[k];
                    if (++fill === N) { measure(); fill = 0; }
                }
                return 0;
            },
        };
    },
};

/**
 * The same for two complex signals, and simpler for it: the average of
 * b·conj(a) over the window, against a's power, is the complex gain from a to
 * b — no frequency has to be found first. The frequency is reported anyway,
 * from a's phase advance, as the counter measures it.
 */
export const IqPhaseMeterBlock = {
    type: 'iq-phase-meter',
    label: 'Gain & phase (IQ)',
    category: 'Viewers',
    summary: 'Gain and phase from complex a to complex b — a block’s response, across it.',
    inputs: [{ name: 'a', kind: COMPLEX }, { name: 'b', kind: COMPLEX }],
    outputs: [],
    params: { windowMs: WINDOW_PARAM },
    create() {
        let rate = 12000;
        let need = 2400;
        let cr = 0; let ci = 0; let pa = 0; let fr = 0; let fi = 0;
        let lastI = 0; let lastQ = 0;
        let count = 0;
        let latest = null;
        const clear = () => { cr = 0; ci = 0; pa = 0; fr = 0; fi = 0; count = 0; };
        return {
            configure(p, r) {
                const n = Math.max(16, Math.round((p.windowMs / 1000) * r));
                if (n !== need || r !== rate) { clear(); latest = null; }
                need = n;
                rate = r;
            },
            reset() { clear(); latest = null; lastI = 0; lastQ = 0; },
            read() { return { ...(latest || {}), rate }; },
            process(ins, outs, n) {
                const { re: ar, im: ai } = ins[0];
                const { re: br, im: bi } = ins[1];
                for (let k = 0; k < n; k++) {
                    // b · conj(a)
                    cr += br[k] * ar[k] + bi[k] * ai[k];
                    ci += bi[k] * ar[k] - br[k] * ai[k];
                    pa += ar[k] * ar[k] + ai[k] * ai[k];
                    fr += ar[k] * lastI + ai[k] * lastQ;
                    fi += ai[k] * lastI - ar[k] * lastQ;
                    lastI = ar[k];
                    lastQ = ai[k];
                    if (++count >= need) {
                        const g = pa > 0 ? Math.hypot(cr, ci) / pa : 0;
                        latest = {
                            hz: (Math.atan2(fi, fr) * rate) / (2 * Math.PI),
                            phaseDeg: g > 0 ? deg(Math.atan2(ci, cr)) : null,
                            gainDb: g > 0 ? 20 * Math.log10(g) : null,
                        };
                        clear();
                    }
                }
                return 0;
            },
        };
    },
};

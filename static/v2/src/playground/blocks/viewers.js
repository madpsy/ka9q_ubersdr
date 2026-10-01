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

import { COMPLEX, CONTROL, REAL, emitControl } from '../block.js';
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

// The vertical ranges a scope offers, as ± full scale. "Auto" follows the
// trace; the rest pin the screen, which is what makes two captures comparable.
export const SCOPE_RANGES = [1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001];
// How long auto keeps a triggered sweep before free-running, in seconds.
const AUTO_HOLD_SEC = 0.25;

/**
 * An oscilloscope: one real signal, or two on one screen, with the controls a
 * scope has.
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
    inputs: [{ name: 'a', kind: REAL }, { name: 'b', kind: REAL, optional: true }],
    outputs: [],
    params: {
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
            options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
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
    },
    create() {
        const A = new Float32Array(SCOPE_RING);
        const B = new Float32Array(SCOPE_RING);
        // `pos` counts samples ever written; the ring holds the last
        // SCOPE_RING of them. Kept as a plain count (a double is exact far
        // past any session) so "the sample at count c" means one thing.
        let pos = 0;
        let two = false;
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

        const sweep = (start, n, triggered) => {
            const cols = Math.min(TRACE_COLUMNS, n);
            const one = (ring) => {
                const min = new Float32Array(cols);
                const max = new Float32Array(cols);
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
                const shift = p.coupling === 'ac' ? mean : 0;
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
                // Frequency from the sweep itself: rising crossings of its
                // mean, first to last, over the time between them.
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
                const hz = count >= 2 ? ((count - 1) * rate) / (last - first) : null;
                return {
                    min, max,
                    vpp: hi - lo,
                    rms: Math.sqrt(Math.max(0, sumSq / n - (p.coupling === 'ac' ? mean * mean : 0))),
                    mean,
                    hz,
                };
            };
            // X–Y wants the samples themselves, paired, not columns.
            let xy = null;
            if (p.view === 'xy' && two) {
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
            return {
                a: one(A),
                b: two ? one(B) : null,
                xy,
                rate, seconds: n / rate, triggered,
                pre: Math.round((p.position / 100) * n) / rate,
            };
        };

        return {
            configure(params, r) {
                p = params;
                rate = r;
                // Leaving single lets go of what it caught.
                if (p.mode !== 'single' && (state === 'armed' || state === 'held')) {
                    state = 'running';
                    held = null;
                }
            },
            reset() { pos = 0; searched = 0; held = null; armedAt = null; state = 'running'; lastTrigger = -Infinity; },
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
                const ring = p.source === 'b' && two ? B : A;
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
                two = !!ins[1];
                const x = ins[0].re;
                const y = two ? ins[1].re : null;
                for (let k = 0; k < n; k++) {
                    const i = (pos + k) % SCOPE_RING;
                    A[i] = x[k];
                    B[i] = y ? y[k] : 0;
                }
                pos += n;
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

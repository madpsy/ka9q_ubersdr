// Drawing the playground's instruments: spectrum and waterfall, oscilloscope,
// constellation. The same components draw the small picture on a card and the
// large one in the inspector; the large one adds a readout under the pointer
// and, for the scope, its front panel.
//
// Readings arrive from the worker about twelve times a second (workerCore.js)
// and each component draws when one does. Levels follow the signal the way the
// app's other spectra do — floor just under the quietest bin, ceiling over the
// loudest, eased — and waterfalls are painted in the operator's own palette.

import React, { useEffect, useReducer, useRef, useState } from '../../react.js';
import { cssVar, levelWindow, sizedCanvas } from '../../lib/audioWaterfall.js';
import { getPalette } from '../../lib/palettes.js';
import { Button, Icon, Readout } from '../../components/ui.jsx';
import { MARKER_H, SPECTRUM_H, SCALE_H, WATERFALL_H } from '../geometry.js';

// ── frequency labels ────────────────────────────────────────────────────────

/**
 * A frequency as an operator reads one, in MHz, kHz or Hz — with as many
 * decimals as `stepHz` (the gap between neighbouring labels) needs to tell
 * them apart. Without a step, kHz resolution in MHz and 0.1 kHz in kHz.
 */
export function freqLabel(hz, stepHz) {
    const a = Math.abs(hz);
    const places = (unit, min, max) => {
        if (!(stepHz > 0)) return min;
        return Math.max(min, Math.min(max, Math.ceil(-Math.log10(stepHz / unit) - 1e-9)));
    };
    if (a >= 1e6) return `${(hz / 1e6).toFixed(places(1e6, 3, 6))}M`;
    if (a >= 1000) return `${Number((hz / 1000).toFixed(places(1e3, a >= 1e5 ? 0 : 1, 3)))}k`;
    return `${Math.round(hz)}`;
}

/**
 * The span a spectrum covers, and how to name a point in it. Two-sided (a
 * complex signal) runs from −rate/2 to +rate/2 around its zero; one-sided (a
 * real signal) from 0 to rate/2. Where the zero is a known frequency on the
 * air (`zeroHz`, from probes.js), the labels are real frequencies; otherwise
 * offsets.
 */
export function spectrumAxis(reading, zeroHz, ticks = 5) {
    const rate = (reading && reading.rate) || 12000;
    const two = reading && reading.sided === 2;
    const lo = two ? -rate / 2 : 0;
    const hi = rate / 2;
    const absolute = two && zeroHz != null && zeroHz > 0;
    const step = (hi - lo) / Math.max(1, ticks - 1);
    const name = (f, at = step) => {
        if (absolute) return freqLabel(zeroHz + f, at);
        if (two && f > 0) return `+${freqLabel(f, at)}`;
        return freqLabel(f, at);
    };
    return { lo, hi, name, absolute };
}

function Scale({ axis, ticks = 5 }) {
    const items = [];
    for (let k = 0; k < ticks; k++) {
        const t = k / (ticks - 1);
        items.push(
            <span key={k} className={k === 0 ? 'is-start' : k === ticks - 1 ? 'is-end' : undefined} style={{ left: `${t * 100}%` }}>
                {axis.name(axis.lo + t * (axis.hi - axis.lo))}
            </span>,
        );
    }
    return <div className="pg-view__scale" style={{ height: `${SCALE_H}px` }}>{items}</div>;
}

// ── spectrum and waterfall ──────────────────────────────────────────────────

/**
 * What a spectrum says at a glance: its strongest bin and how strong, and the
 * floor — the median bin, which noise sets and a few signals cannot move —
 * with the gap between them.
 */
export function spectrumMarks(db) {
    if (!db || !db.length) return null;
    let peak = 0;
    for (let k = 1; k < db.length; k++) if (db[k] > db[peak]) peak = k;
    const sorted = Float32Array.from(db).sort();
    const floor = sorted[sorted.length >> 1];
    return { peak, peakDb: db[peak], floorDb: floor, snrDb: db[peak] - floor };
}

/** The peak-hold trace: up at once, then down a decibel or so a second. */
function holdPeaks(st, db) {
    if (!db) return null;
    if (!st.hold || st.hold.length !== db.length) st.hold = Float32Array.from(db);
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    const fall = st.at ? Math.min(5, ((now - st.at) / 1000) * 1.5) : 0;
    st.at = now;
    for (let k = 0; k < db.length; k++) st.hold[k] = Math.max(db[k], st.hold[k] - fall);
    return st.hold;
}

function drawSpectrum(canvas, h, db, level, hold, mark) {
    const { w, h: ph, dpr } = sizedCanvas(canvas, h);
    const c = canvas.getContext('2d');
    if (!c) return null;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = cssVar('--surface-3', '#1a2130');
    c.fillRect(0, 0, w, ph);
    if (!db || !db.length) return null;
    const { floor, range } = levelWindow(db, 0, db.length, level);
    // A faint grid every 10 dB, so a level can be read off by eye.
    c.strokeStyle = cssVar('--border', '#2a3242');
    c.lineWidth = 1;
    for (let d = Math.ceil(floor / 10) * 10; d < floor + range; d += 10) {
        const y = Math.round(ph - ((d - floor) / range) * ph) + 0.5;
        c.beginPath();
        c.moveTo(0, y);
        c.lineTo(w, y);
        c.stroke();
    }
    const yOf = (v) => ph - Math.max(0, Math.min(1, (v - floor) / range)) * ph;
    c.beginPath();
    c.moveTo(0, ph);
    for (let x = 0; x < w; x++) {
        const k0 = Math.floor((x / w) * db.length);
        const k1 = Math.max(k0 + 1, Math.floor(((x + 1) / w) * db.length));
        let v = -Infinity;
        for (let k = k0; k < k1; k++) if (db[k] > v) v = db[k];
        c.lineTo(x, yOf(v));
    }
    c.lineTo(w, ph);
    c.closePath();
    const accent = cssVar('--accent', '#08a2fb');
    c.globalAlpha = 0.28;
    c.fillStyle = accent;
    c.fill();
    c.globalAlpha = 1;
    c.lineWidth = Math.max(1, dpr);
    c.strokeStyle = accent;
    c.stroke();
    const xOf = (k) => ((k + 0.5) / db.length) * w;
    if (hold) {
        c.beginPath();
        for (let x = 0; x < w; x++) {
            const k0 = Math.floor((x / w) * hold.length);
            const k1 = Math.max(k0 + 1, Math.floor(((x + 1) / w) * hold.length));
            let v = -Infinity;
            for (let k = k0; k < k1; k++) if (hold[k] > v) v = hold[k];
            if (x === 0) c.moveTo(x, yOf(v));
            else c.lineTo(x, yOf(v));
        }
        c.globalAlpha = 0.7;
        c.lineWidth = Math.max(1, dpr);
        c.strokeStyle = cssVar('--warn', '#f2b544');
        c.stroke();
        c.globalAlpha = 1;
    }
    if (mark) {
        // A small marker over the strongest bin.
        const x = xOf(mark.peak);
        const y = Math.max(7 * dpr, yOf(mark.peakDb) - 3 * dpr);
        c.fillStyle = cssVar('--text', '#e6edf7');
        c.beginPath();
        c.moveTo(x, y);
        c.lineTo(x - 4 * dpr, y - 6 * dpr);
        c.lineTo(x + 4 * dpr, y - 6 * dpr);
        c.closePath();
        c.fill();
    }
    return { floor, range };
}

/** One new waterfall row at the top of `st`'s history, then the history drawn. */
function drawWaterfall(canvas, h, db, st, palette, fresh) {
    const { w, h: ph } = sizedCanvas(canvas, h);
    const c = canvas.getContext('2d', { alpha: false });
    if (!c || typeof document === 'undefined' || !document.createElement) return;
    if (!st.off || st.w !== w || st.h !== ph) {
        const off = document.createElement('canvas');
        if (!off.getContext) return;
        off.width = w;
        off.height = ph;
        st.off = off;
        st.octx = off.getContext('2d', { alpha: false });
        if (!st.octx) return;
        st.octx.fillStyle = '#05070c';
        st.octx.fillRect(0, 0, w, ph);
        st.w = w;
        st.h = ph;
        st.head = 0;
    }
    if (fresh && db && db.length) {
        const { floor, range } = levelWindow(db, 0, db.length, st.level);
        const lut = getPalette(palette);
        const img = st.octx.createImageData(w, 1);
        const d = img.data;
        for (let x = 0; x < w; x++) {
            const k0 = Math.floor((x / w) * db.length);
            const k1 = Math.max(k0 + 1, Math.floor(((x + 1) / w) * db.length));
            let v = -Infinity;
            for (let k = k0; k < k1; k++) if (db[k] > v) v = db[k];
            const t = Math.max(0, Math.min(1, (v - floor) / range));
            const i = (t * 255) | 0;
            d[x * 4] = lut[i * 3];
            d[x * 4 + 1] = lut[i * 3 + 1];
            d[x * 4 + 2] = lut[i * 3 + 2];
            d[x * 4 + 3] = 255;
        }
        st.head = (st.head - 1 + ph) % ph;
        st.octx.putImageData(img, 0, st.head);
    }
    c.imageSmoothingEnabled = false;
    const first = ph - st.head;
    c.drawImage(st.off, 0, st.head, w, first, 0, 0, w, first);
    if (first < ph) c.drawImage(st.off, 0, 0, w, ph - first, 0, first, w, ph - first);
}

/**
 * A spectrum, a waterfall, or both stacked, with a frequency scale under them.
 * `scale` multiplies the card heights for the large view.
 */
export function SpectrumView({ reading, display = 'spectrum', origin, palette, scale = 1, hover = false, peakHold = false }) {
    const specRef = useRef(null);
    const wfRef = useRef(null);
    const st = useRef({ level: { floor: -100, ceil: -30 }, wf: { level: { floor: -100, ceil: -30 } }, last: null, levels: null });
    const [tip, setTip] = useState(null);
    const showSpec = display !== 'waterfall';
    const showWf = display !== 'spectrum';
    const specH = Math.round(SPECTRUM_H * scale);
    const wfH = Math.round(WATERFALL_H * scale);
    const db = reading && reading.db;
    const axis = spectrumAxis(reading, origin, scale > 1 ? 7 : 5);

    const mark = spectrumMarks(db);
    useEffect(() => {
        const fresh = reading !== st.current.last;
        st.current.last = reading;
        const hold = peakHold && db ? (fresh ? holdPeaks(st.current, db) : st.current.hold) : null;
        if (showSpec && specRef.current) st.current.levels = drawSpectrum(specRef.current, specH, db, st.current.level, hold, mark);
        if (showWf && wfRef.current) drawWaterfall(wfRef.current, wfH, db, st.current.wf, palette || 'classic', fresh);
    });

    const onMove = hover ? (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
        const f = axis.lo + t * (axis.hi - axis.lo);
        const k = db ? Math.min(db.length - 1, Math.floor(t * db.length)) : -1;
        // To the bin under the pointer, not to the label spacing.
        const bin = db ? (axis.hi - axis.lo) / db.length : 1;
        setTip({ x: e.clientX - r.left, text: `${axis.name(f, bin)}Hz${k >= 0 ? ` · ${db[k].toFixed(1)} dBFS` : ''}` });
    } : undefined;

    return (
        <div className="pg-view" onPointerMove={onMove} onPointerLeave={hover ? () => setTip(null) : undefined}>
            {showSpec && <canvas ref={specRef} className="pg-view__canvas" style={{ height: `${specH}px` }} />}
            {showWf && <canvas ref={wfRef} className="pg-view__canvas" style={{ height: `${wfH}px` }} />}
            <Scale axis={axis} ticks={scale > 1 ? 7 : 5} />
            <div className="pg-view__marks" style={{ height: `${MARKER_H}px` }}>
                {mark ? (
                    <>
                        <span title="The strongest bin">{`▲ ${axis.name(axis.lo + ((mark.peak + 0.5) / db.length) * (axis.hi - axis.lo), (axis.hi - axis.lo) / db.length)}${axis.absolute ? 'Hz' : ' Hz'} ${mark.peakDb.toFixed(1)} dB`}</span>
                        <span title="The median bin: the noise">{`floor ${mark.floorDb.toFixed(0)}`}</span>
                        <span title="The strongest bin over the floor">{`SNR ${mark.snrDb.toFixed(0)} dB`}</span>
                    </>
                ) : null}
            </div>
            {!db && <div className="pg-view__empty">No signal yet</div>}
            {tip && <div className="pg-view__tip" style={{ left: `${tip.x}px` }}>{tip.text}</div>}
        </div>
    );
}

// ── oscilloscope ────────────────────────────────────────────────────────────

const DIVS_X = 10;
const DIVS_Y = 8;

/** A time in the unit it reads best in. */
export function timeLabel(sec) {
    const a = Math.abs(sec);
    if (a >= 1) return `${sec.toFixed(2)} s`;
    if (a >= 1e-3) return `${Number((sec * 1e3).toFixed(a >= 0.01 ? 1 : 2))} ms`;
    return `${Math.round(sec * 1e6)} µs`;
}

/** The ± full scale a scope draws at: its fixed range, or the trace's own. */
export function scopeRange(params, reading, held) {
    if (params.range !== 'auto') return Number(params.range);
    let peak = 0;
    for (const ch of [reading && reading.a, reading && reading.b]) {
        if (!ch) continue;
        for (let k = 0; k < ch.max.length; k++) peak = Math.max(peak, Math.abs(ch.max[k]), Math.abs(ch.min[k]));
    }
    // Round up to a 1-2-5 step, so the scale is a number worth reading and
    // does not breathe with every sweep.
    const want = peak > 0 ? peak * 1.1 : 1;
    const e = 10 ** Math.floor(Math.log10(want));
    const step = [1, 2, 5, 10].find((m) => m * e >= want) * e;
    // Grow at once, shrink only when well inside a smaller step.
    if (held.range && step < held.range && peak > held.range * 0.4) return held.range;
    held.range = step;
    return step;
}

function drawScope(canvas, h, reading, params, held) {
    const { w, h: ph, dpr } = sizedCanvas(canvas, h);
    const c = canvas.getContext('2d');
    if (!c) return null;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = cssVar('--surface-3', '#1a2130');
    c.fillRect(0, 0, w, ph);
    c.strokeStyle = cssVar('--border', '#2a3242');
    c.lineWidth = 1;
    for (let i = 1; i < DIVS_X; i++) {
        const x = Math.round((i * w) / DIVS_X) + 0.5;
        c.beginPath(); c.moveTo(x, 0); c.lineTo(x, ph); c.stroke();
    }
    for (let i = 1; i < DIVS_Y; i++) {
        const y = Math.round((i * ph) / DIVS_Y) + 0.5;
        c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
    }
    const range = scopeRange(params, reading, held);
    const yOf = (v) => ph / 2 - ((v + params.offset * range) / range) * (ph / 2);
    // The trigger: its level across, and where in the sweep it sits.
    if (params.mode !== undefined && params.view !== 'xy') {
        c.setLineDash([4 * dpr, 4 * dpr]);
        c.strokeStyle = cssVar('--warn', '#f2b544');
        const ty = Math.round(yOf(params.level)) + 0.5;
        c.beginPath(); c.moveTo(0, ty); c.lineTo(w, ty); c.stroke();
        const tx = Math.round((params.position / 100) * w) + 0.5;
        c.beginPath(); c.moveTo(tx, 0); c.lineTo(tx, ph); c.stroke();
        c.setLineDash([]);
    }
    const trace = (ch, colour) => {
        if (!ch) return;
        const n = ch.min.length;
        c.strokeStyle = colour;
        c.lineWidth = Math.max(1, dpr * 1.25);
        c.beginPath();
        for (let k = 0; k < n; k++) {
            const x = (k / Math.max(1, n - 1)) * w;
            const y0 = yOf(ch.min[k]);
            const y1 = yOf(ch.max[k]);
            if (k === 0) c.moveTo(x, y1);
            else c.lineTo(x, y1);
            if (y0 !== y1) c.lineTo(x, y0);
        }
        c.stroke();
    };
    if (reading && params.view === 'xy' && reading.xy) {
        // A across, B up, on the same scale both ways, oldest faintest.
        const { x, y } = reading.xy;
        const s = Math.min(w, ph) / 2;
        const cx = w / 2;
        const cy = ph / 2;
        c.fillStyle = cssVar('--accent', '#08a2fb');
        const dot = Math.max(1.5, 1.5 * dpr);
        for (let k = 0; k < x.length; k++) {
            c.globalAlpha = 0.2 + 0.8 * (k / x.length);
            c.fillRect(cx + (x[k] / range) * s - dot / 2, cy - (y[k] / range) * s - dot / 2, dot, dot);
        }
        c.globalAlpha = 1;
        return range;
    }
    if (reading) {
        trace(reading.b, cssVar('--violet', '#a78bfa'));
        trace(reading.a, cssVar('--accent', '#08a2fb'));
    }
    return range;
}

const SCOPE_STATE = {
    armed: 'Armed — waiting for a trigger',
    held: 'Captured',
    stopped: 'Stopped',
};

/** The oscilloscope's screen, with its scale and state, and in the large view its controls. */
export function ScopeView({ pg, id, reading, params, scale = 1, large = false }) {
    const ref = useRef(null);
    const held = useRef({});
    const [range, setRange] = useState(null);
    const [tip, setTip] = useState(null);
    const h = Math.round(130 * scale) - (large ? 0 : 16);
    useEffect(() => {
        if (!ref.current) return;
        const r = drawScope(ref.current, h, reading && reading.a ? reading : null, params, held.current);
        if (r !== range) setRange(r);
    });
    const secs = reading && reading.seconds ? reading.seconds : params.timebaseMs / 1000;
    const state = reading && reading.state;
    const status = SCOPE_STATE[state]
        || (reading && reading.a ? (reading.triggered || reading.stale ? 'Triggered' : 'No trigger — free running') : 'Waiting for signal');
    const onMove = large ? (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const tx = (e.clientX - r.left) / r.width;
        const ty = (e.clientY - r.top) / r.height;
        const t = tx * secs - (params.position / 100) * secs;
        const v = range ? (0.5 - ty) * 2 * range - params.offset * range : null;
        setTip({ x: e.clientX - r.left, y: e.clientY - r.top, text: `${timeLabel(t)} · ${v == null ? '—' : v.toPrecision(3)}` });
    } : undefined;
    const meas = (ch, name) => (ch ? (
        <>
            <Readout label={`${name} p-p`} value={ch.vpp.toPrecision(3)} />
            <Readout label={`${name} RMS`} value={ch.rms.toPrecision(3)} />
            <Readout label={`${name} freq`} value={ch.hz ? freqLabel(ch.hz) : '—'} unit={ch.hz ? 'Hz' : undefined} />
        </>
    ) : null);
    return (
        <div className="pg-view">
            <div className="pg-view__screen" onPointerMove={onMove} onPointerLeave={large ? () => setTip(null) : undefined}>
                <canvas ref={ref} className="pg-view__canvas" style={{ height: `${h}px` }} />
                {tip && <div className="pg-view__tip" style={{ left: `${tip.x}px`, top: `${tip.y}px` }}>{tip.text}</div>}
            </div>
            <div className="pg-view__legend">
                <span>{params.view === 'xy' ? (reading && reading.xy ? 'X–Y: A across, B up' : 'X–Y needs B wired') : `${timeLabel(secs / DIVS_X)}/div`}</span>
                <span>{range ? `${(range * 2 / DIVS_Y).toPrecision(2)}/div` : ''}</span>
                <span className={state === 'armed' ? 'is-warn' : ''}>{status}</span>
            </div>
            {large && (
                <>
                    <div className="pg-insp__row">
                        {state === 'stopped' || state === 'held' ? (
                            <Button size="sm" icon={<Icon.Play />} onClick={() => pg.command(id, 'run')}>Run</Button>
                        ) : (
                            <Button size="sm" icon={<Icon.Pause />} onClick={() => pg.command(id, 'stop')}>Stop</Button>
                        )}
                        {params.mode === 'single' && (
                            <Button size="sm" variant="primary" icon={<Icon.Target />} onClick={() => pg.command(id, 'arm')}>
                                {state === 'armed' ? 'Re-arm' : 'Arm single'}
                            </Button>
                        )}
                    </div>
                    {reading && reading.a && (
                        <div className="readout-grid">
                            {meas(reading.a, 'A')}
                            {meas(reading.b, 'B')}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

// ── constellation ───────────────────────────────────────────────────────────

function drawConstellation(canvas, size, reading) {
    const { w, h, dpr } = sizedCanvas(canvas, size);
    const c = canvas.getContext('2d');
    if (!c) return;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = cssVar('--surface-3', '#1a2130');
    c.fillRect(0, 0, w, h);
    const s = Math.min(w, h);
    const cx = w / 2;
    const cy = h / 2;
    const r = s * 0.44;
    c.strokeStyle = cssVar('--border', '#2a3242');
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(cx - r * 1.1, cy + 0.5); c.lineTo(cx + r * 1.1, cy + 0.5); c.stroke();
    c.beginPath(); c.moveTo(cx + 0.5, cy - r * 1.1); c.lineTo(cx + 0.5, cy + r * 1.1); c.stroke();
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
    if (!reading || !reading.i) return;
    const n = reading.i.length;
    const k = reading.scale * r;
    c.fillStyle = cssVar('--accent', '#08a2fb');
    const dot = Math.max(1.5, 1.5 * dpr);
    // Oldest faintest, so the newest points stand out and the trail shows
    // which way things are moving.
    for (let j = 0; j < n; j++) {
        c.globalAlpha = 0.15 + 0.85 * (j / n);
        c.fillRect(cx + reading.i[j] * k - dot / 2, cy - reading.q[j] * k - dot / 2, dot, dot);
    }
    c.globalAlpha = 1;
}

export function ConstellationView({ reading, scale = 1 }) {
    const ref = useRef(null);
    const size = Math.round(196 * scale);
    useEffect(() => {
        if (ref.current) drawConstellation(ref.current, size, reading);
    });
    return (
        <div className="pg-view">
            <canvas ref={ref} className="pg-view__canvas pg-view__canvas--square" style={{ height: `${size}px` }} />
            {reading && !reading.scale && <div className="pg-view__empty">No signal yet</div>}
        </div>
    );
}

// ── frequency counter ───────────────────────────────────────────────────────

/** Digits grouped in threes either side of the point, as a counter shows them. */
export function groupDigits(text) {
    const [whole, frac] = text.split('.');
    const sign = /^[+-]/.test(whole) ? whole[0] : '';
    const digits = sign ? whole.slice(1) : whole;
    const w = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009');
    const f = frac ? frac.replace(/(\d{3})(?=\d)/g, '$1\u2009') : '';
    return `${sign}${w}${f ? `.${f}` : ''}`;
}

/**
 * The counter's reading as it is shown: on the air in MHz where the wire's
 * place is known, as an offset in Hz where it is not. Decimals follow the gate
 * — a longer gate resolves finer.
 */
export function counterText(r, zeroHz) {
    if (!r || r.hz == null) return { big: '—', unit: '' };
    const places = r.gateSec >= 10 ? 3 : r.gateSec >= 1 ? 2 : 1;
    if (zeroHz != null && zeroHz > 0) {
        const hz = zeroHz + r.hz;
        return { big: groupDigits((hz / 1e6).toFixed(6 + places)), unit: 'MHz' };
    }
    return { big: groupDigits(`${r.hz >= 0 ? '+' : ''}${r.hz.toFixed(places)}`), unit: 'Hz' };
}

export function CounterView({ reading, origin, large = false }) {
    const t = counterText(reading, origin);
    const r = reading || {};
    return (
        <div className={`pg-counter${large ? ' is-large' : ''}`}>
            <div className="pg-counter__digits">
                <span>{t.big}</span>
                <small>{t.unit}</small>
            </div>
            <div className="pg-counter__meta">
                <span title="Change per second, fitted over the last gates">{r.drift == null ? 'drift —' : `drift ${r.drift >= 0 ? '+' : ''}${r.drift.toFixed(3)} Hz/s`}</span>
                <span title="Spread of the gates about that fit">{r.spread == null ? '' : `± ${r.spread.toFixed(3)} Hz`}</span>
                <span>{r.db == null ? '' : `${r.db.toFixed(0)} dBFS`}</span>
            </div>
            <div className="pg-counter__gate" title="This gate">
                <i style={{ width: `${Math.round((r.progress || 0) * 100)}%` }} />
            </div>
        </div>
    );
}

// ── gain and phase ──────────────────────────────────────────────────────────

function drawDial(canvas, size, phaseDeg) {
    const { w, h, dpr } = sizedCanvas(canvas, size);
    const c = canvas.getContext('2d');
    if (!c) return;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) / 2 - 10 * dpr;
    c.strokeStyle = cssVar('--border-strong', '#3a4458');
    c.lineWidth = 1.5 * dpr;
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
    // A tick every 30°, longer at the quarters; 0° to the right, +90° up.
    for (let d = 0; d < 360; d += 30) {
        const a = (d * Math.PI) / 180;
        const inner = d % 90 === 0 ? r - 9 * dpr : r - 5 * dpr;
        c.beginPath();
        c.moveTo(cx + Math.cos(a) * inner, cy - Math.sin(a) * inner);
        c.lineTo(cx + Math.cos(a) * r, cy - Math.sin(a) * r);
        c.stroke();
    }
    c.fillStyle = cssVar('--text-faint', '#7b8798');
    c.font = `${Math.round(9 * dpr)}px var(--mono), monospace`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (const [d, label] of [[0, '0'], [90, '+90'], [180, '±180'], [270, '−90']]) {
        const a = (d * Math.PI) / 180;
        c.fillText(label, cx + Math.cos(a) * (r - 18 * dpr), cy - Math.sin(a) * (r - 18 * dpr));
    }
    if (phaseDeg == null) return;
    const a = (phaseDeg * Math.PI) / 180;
    c.strokeStyle = cssVar('--accent', '#08a2fb');
    c.lineWidth = 3 * dpr;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(cx + Math.cos(a) * (r - 4 * dpr), cy - Math.sin(a) * (r - 4 * dpr));
    c.stroke();
    c.fillStyle = cssVar('--accent', '#08a2fb');
    c.beginPath(); c.arc(cx, cy, 4 * dpr, 0, Math.PI * 2); c.fill();
}

export function PhaseView({ reading, large = false }) {
    const ref = useRef(null);
    const size = large ? 220 : 112;
    const r = reading || {};
    useEffect(() => {
        if (ref.current) drawDial(ref.current, size, r.phaseDeg == null ? null : r.phaseDeg);
    });
    return (
        <div className={`pg-phase${large ? ' is-large' : ''}`}>
            <canvas ref={ref} className="pg-view__canvas pg-view__canvas--square pg-phase__dial" style={{ height: `${size}px` }} />
            <div className="pg-phase__nums">
                <span className="pg-phase__deg">{r.phaseDeg == null ? '—' : `${r.phaseDeg >= 0 ? '+' : ''}${r.phaseDeg.toFixed(1)}°`}</span>
                <span>{r.gainDb == null ? 'gain —' : `${r.gainDb >= 0 ? '+' : ''}${r.gainDb.toFixed(2)} dB`}</span>
                <span>{r.hz == null ? 'no tone on a' : `at ${freqLabel(r.hz, 0.1)} Hz`}</span>
            </div>
        </div>
    );
}

// ── signals and messages ────────────────────────────────────────────────────

/** A detector's frequency, on the air where the zero is known. */
function signalName(hz, zeroHz) {
    return zeroHz > 0 ? `${freqLabel(zeroHz + hz, 10)}Hz` : `${hz >= 0 ? '+' : ''}${freqLabel(hz, 10)} Hz`;
}

export function DetectorView({ reading, origin, large = false }) {
    const list = (reading && reading.signals) || [];
    const shown = large ? list : list.slice(0, 3);
    return (
        <div className="pg-list">
            {!list.length && <div className="pg-list__empty">{reading ? 'Nothing over the threshold' : 'Looking…'}</div>}
            {shown.map((s, k) => (
                <div key={k} className="pg-list__row">
                    <span>{signalName(s.hz, origin)}</span>
                    <span>{`${s.db.toFixed(0)} dB`}</span>
                    <span className="pg-list__dim">{`SNR ${s.snrDb.toFixed(0)}`}</span>
                    {large && <span className="pg-list__dim">{`${freqLabel(s.widthHz, 1)} Hz wide`}</span>}
                </div>
            ))}
            {!large && list.length > 3 && <div className="pg-list__dim">{`and ${list.length - 3} more`}</div>}
            {large && reading && reading.floorDb != null && <div className="pg-list__dim">{`Floor ${reading.floorDb.toFixed(0)} dBFS`}</div>}
        </div>
    );
}

/** One message as a line: what it is, and what it says. */
export function messageLine(m, zeroHz) {
    switch (m.type) {
        case 'appeared':
            return `${signalName(m.hz, zeroHz)} appeared · ${m.db.toFixed(0)} dB, SNR ${m.snrDb.toFixed(0)}`;
        case 'gone':
            return `${signalName(m.hz, zeroHz)} gone · after ${m.lastedSec.toFixed(1)} s`;
        default: {
            const { type, at, wall, ...rest } = m;
            return `${type || 'message'} ${JSON.stringify(rest)}`;
        }
    }
}

export function LogView({ pg, id, reading, origin, large = false }) {
    const lines = (reading && reading.lines) || [];
    const shown = large ? lines : lines.slice(0, 4);
    const time = (w) => {
        const d = new Date(w);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    };
    return (
        <div className={`pg-list pg-log${large ? ' is-large' : ''}`}>
            {!lines.length && <div className="pg-list__empty">No messages yet</div>}
            {shown.map((m, k) => (
                <div key={k} className={`pg-list__row pg-log__line is-${m.type || 'other'}`}>
                    <span className="pg-list__dim">{time(m.wall)}</span>
                    <span>{messageLine(m, origin)}</span>
                </div>
            ))}
            {large && (
                <div className="pg-insp__row">
                    <span className="pg-list__dim">{reading ? `${reading.count} in all` : ''}</span>
                    <Button size="sm" variant="ghost" icon={<Icon.Trash size={13} />} onClick={() => pg.command(id, 'clear')}>Clear</Button>
                </div>
            )}
        </div>
    );
}

// ── text and bits ───────────────────────────────────────────────────────────

/** A teleprinter's paper: the last few lines on a card, all of it large. */
export function ConsoleView({ pg, id, reading, large = false }) {
    const text = (reading && reading.text) || '';
    const lines = text.split('\n');
    const [copied, setCopied] = useState(false);
    if (!large) {
        const tail = lines.slice(-4);
        return (
            <pre className="pg-console">
                {text ? tail.join('\n') : <span className="pg-list__empty">Nothing decoded yet</span>}
            </pre>
        );
    }
    return (
        <div className="pg-view">
            <pre className="pg-console is-large">{text || 'Nothing decoded yet.'}</pre>
            <div className="pg-insp__row">
                <span className="pg-list__dim">{reading ? `${reading.count} characters` : ''}</span>
                <Button
                    size="sm"
                    variant="ghost"
                    icon={<Icon.Copy />}
                    disabled={!text}
                    onClick={() => {
                        Promise.resolve(navigator.clipboard && navigator.clipboard.writeText(text))
                            .then(() => setCopied(true), () => {});
                    }}
                >
                    {copied ? 'Copied' : 'Copy'}
                </Button>
                <Button size="sm" variant="ghost" icon={<Icon.Trash size={13} />} onClick={() => pg.command(id, 'clear')}>Clear</Button>
            </div>
        </div>
    );
}

/** The newest bits, as a row of cells: filled for 1, empty for 0. */
export function BitView({ reading, large = false }) {
    const bits = (reading && reading.bits) || [];
    const shown = large ? bits : bits.slice(-48);
    return (
        <div className="pg-bits">
            <div className={`pg-bits__row${large ? ' is-large' : ''}`}>
                {Array.from(shown, (b, k) => <i key={k} className={b ? 'is-one' : undefined} />)}
            </div>
            {large && reading && (
                <div className="pg-list__dim">
                    {`${reading.count} bits · ${reading.count ? Math.round((100 * reading.ones) / reading.count) : 0}% ones`}
                </div>
            )}
        </div>
    );
}

// ── one instrument, by type ─────────────────────────────────────────────────

/** Whether a block type is an instrument with a picture. */
export const INSTRUMENTS = new Set([
    'iq-spectrum', 'audio-spectrum', 'scope', 'constellation', 'frequency-counter', 'phase-meter', 'iq-phase-meter',
    'signal-detector', 'message-log', 'console', 'bit-view',
]);

/**
 * The picture for one instrument node. Listens for readings itself — see
 * CardVisual — so only it redraws when one arrives.
 */
export function Instrument({ pg, node, look, origin, large = false }) {
    const [, bump] = useReducer((n) => n + 1, 0);
    useEffect(() => pg.on('readings', bump), [pg]);
    const reading = pg.readings ? pg.readings[node.id] : null;
    const scale = large ? 2 : 1;
    switch (node.type) {
        case 'iq-spectrum':
        case 'audio-spectrum':
            return (
                <SpectrumView
                    reading={reading}
                    display={node.params.display}
                    origin={node.type === 'iq-spectrum' ? origin : null}
                    palette={look && look.palette}
                    scale={scale}
                    hover={large}
                    peakHold={!!node.params.peakHold}
                />
            );
        case 'scope':
            return <ScopeView pg={pg} id={node.id} reading={reading} params={node.params} scale={scale} large={large} />;
        case 'constellation':
            return <ConstellationView reading={reading} scale={large ? 1.4 : 1} />;
        case 'frequency-counter':
            return <CounterView reading={reading} origin={origin} large={large} />;
        case 'phase-meter':
        case 'iq-phase-meter':
            return <PhaseView reading={reading} large={large} />;
        case 'signal-detector':
            return <DetectorView reading={reading} origin={origin} large={large} />;
        case 'message-log':
            return <LogView pg={pg} id={node.id} reading={reading} origin={origin} large={large} />;
        case 'console':
            return <ConsoleView pg={pg} id={node.id} reading={reading} large={large} />;
        case 'bit-view':
            return <BitView reading={reading} large={large} />;
        default:
            return null;
    }
}

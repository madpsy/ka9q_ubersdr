// Spectrum + waterfall.
//
// Rendering deliberately bypasses React: the spectrum connection is subscribed
// to directly and frames are drawn on the canvas, so a 10–20 Hz data stream
// causes zero reconciliation. React only owns the surrounding chrome.
//
// The waterfall uses a ring-buffered offscreen canvas: each new row is written
// at a decrementing index and the visible canvas is painted from two slices of
// the ring. That is O(row) per frame and, unlike scrolling by blitting the
// canvas onto itself, never accumulates resampling artefacts.

import React, { useCallback, useEffect, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { getPalette } from '../lib/palettes.js';
import { formatFreqShort, formatSpan, clamp } from '../lib/format.js';
import { MAX_FREQ, MIN_FREQ } from '../radio/constants.js';
import { useDisplay } from '../display/DisplayContext.jsx';
import { Button, Icon } from './ui.jsx';

const SCALE_H = 26;       // frequency ruler height, CSS px
const MIN_SPECTRUM_H = 60;

export default function SpectrumView() {
    const radio = useRadio();
    const display = useDisplay();
    const { spectrumConn, tuning, actions, view } = radio;

    const wrapRef = useRef(null);
    const specRef = useRef(null);
    const wfRef = useRef(null);
    const scaleRef = useRef(null);

    // Everything the draw loop needs, kept out of React state.
    const gfx = useRef({
        bins: null,
        peak: null,
        smoothed: null,
        ring: null,          // offscreen canvas
        ringCtx: null,
        ringHead: 0,
        ringHeight: 0,
        ringWidth: 0,
        dirty: false,
        dpr: 1,
        rowsPending: 0,
        autoFloor: -110,
        autoCeil: -40,
        hover: null,         // {x, y} in CSS px
        drag: null,
    });

    // Mirrors of React values the draw loop reads; refs avoid re-subscribing.
    const cfgRef = useRef({ centerFreq: 0, span: 0, binCount: 0, binBandwidth: 0 });
    cfgRef.current = view;
    const tuneRef = useRef(tuning);
    tuneRef.current = tuning;
    const dispRef = useRef(display);
    dispRef.current = display;

    const [hoverInfo, setHoverInfo] = useState(null);
    const [sizes, setSizes] = useState({ w: 0, h: 0 });

    // Fraction of the centre area given to the spectrum; the rest is waterfall.
    const split = display.split;

    // ---- sizing ---------------------------------------------------------

    useEffect(() => {
        const el = wrapRef.current;
        if (!el) return undefined;
        const ro = new ResizeObserver(() => {
            const r = el.getBoundingClientRect();
            setSizes({ w: Math.max(1, Math.floor(r.width)), h: Math.max(1, Math.floor(r.height)) });
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const specH = Math.max(MIN_SPECTRUM_H, Math.round((sizes.h - SCALE_H) * split));
    const wfH = Math.max(0, sizes.h - SCALE_H - specH);

    // Size the backing stores for device pixels and rebuild the waterfall ring.
    useEffect(() => {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const g = gfx.current;
        g.dpr = dpr;

        for (const [ref, h] of [[specRef, specH], [wfRef, wfH], [scaleRef, SCALE_H]]) {
            const c = ref.current;
            if (!c) continue;
            c.width = Math.max(1, Math.round(sizes.w * dpr));
            c.height = Math.max(1, Math.round(h * dpr));
            c.style.width = sizes.w + 'px';
            c.style.height = h + 'px';
        }

        const w = Math.max(1, Math.round(sizes.w * dpr));
        const h = Math.max(1, Math.round(wfH * dpr));
        if (g.ringWidth !== w || g.ringHeight !== h) {
            const ring = document.createElement('canvas');
            ring.width = w;
            ring.height = h;
            const ctx = ring.getContext('2d', { alpha: false });
            ctx.fillStyle = '#05070c';
            ctx.fillRect(0, 0, w, h);
            g.ring = ring;
            g.ringCtx = ctx;
            g.ringWidth = w;
            g.ringHeight = h;
            g.ringHead = 0;
        }
        g.dirty = true;
    }, [sizes.w, sizes.h, specH, wfH]);

    // ---- data -----------------------------------------------------------

    useEffect(() => {
        const off = spectrumConn.on('frame', ({ bins }) => {
            const g = gfx.current;
            g.bins = bins;
            g.rowsPending++;
            g.dirty = true;
        });
        return off;
    }, [spectrumConn]);

    // ---- draw loop ------------------------------------------------------

    useEffect(() => {
        let raf = 0;
        let lastRow = 0;

        const loop = () => {
            raf = requestAnimationFrame(loop);
            const g = gfx.current;
            const d = dispRef.current;
            if (!g.bins || !g.dirty) return;

            const now = performance.now();
            // Waterfall speed throttles how often a row is committed, so a fast
            // server feed can still be shown as a slow-scrolling history.
            const rowInterval = 1000 / d.waterfallRate;
            const commitRow = g.rowsPending > 0 && now - lastRow >= rowInterval;
            if (commitRow) {
                lastRow = now;
                g.rowsPending = 0;
            }

            drawFrame(g, d, {
                spec: specRef.current,
                wf: wfRef.current,
                scale: scaleRef.current,
                cfg: cfgRef.current,
                tuning: tuneRef.current,
                width: sizes.w,
                specH,
                wfH,
                commitRow,
            });
            g.dirty = false;
        };

        raf = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(raf);
    }, [sizes.w, specH, wfH]);

    // Redraw when a display setting changes even if no new frame arrived.
    useEffect(() => { gfx.current.dirty = true; }, [display]);

    // ---- pointer interaction --------------------------------------------

    const freqAtX = useCallback((clientX) => {
        const el = wrapRef.current;
        const cfg = cfgRef.current;
        if (!el || !cfg.span) return null;
        const r = el.getBoundingClientRect();
        const frac = clamp((clientX - r.left) / r.width, 0, 1);
        return cfg.centerFreq - cfg.span / 2 + frac * cfg.span;
    }, []);

    const onPointerDown = useCallback((e) => {
        const el = wrapRef.current;
        if (!el) return;
        el.setPointerCapture(e.pointerId);
        gfx.current.drag = {
            startX: e.clientX,
            startCenter: cfgRef.current.centerFreq,
            moved: false,
            pointerId: e.pointerId,
        };
    }, []);

    const onPointerMove = useCallback((e) => {
        const el = wrapRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const g = gfx.current;
        g.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
        g.dirty = true;

        const cfg = cfgRef.current;
        const f = freqAtX(e.clientX);
        if (f != null) setHoverInfo({ freq: f, x: e.clientX - r.left });

        if (g.drag) {
            const dx = e.clientX - g.drag.startX;
            if (Math.abs(dx) > 3) g.drag.moved = true;
            if (g.drag.moved && cfg.span) {
                const hzPerPx = cfg.span / r.width;
                const center = clamp(g.drag.startCenter - dx * hzPerPx, MIN_FREQ, MAX_FREQ);
                actions.setSpectrumCenter(center);
            }
        }
    }, [actions, freqAtX]);

    const onPointerUp = useCallback((e) => {
        const g = gfx.current;
        const drag = g.drag;
        g.drag = null;
        if (!drag) return;
        try { wrapRef.current.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        if (drag.moved) return;
        const f = freqAtX(e.clientX);
        if (f != null) actions.setFrequency(dispRef.current.snapHz > 1 ? Math.round(f / dispRef.current.snapHz) * dispRef.current.snapHz : f);
    }, [actions, freqAtX]);

    const onPointerLeave = useCallback(() => {
        gfx.current.hover = null;
        gfx.current.dirty = true;
        setHoverInfo(null);
    }, []);

    const onWheel = useCallback((e) => {
        e.preventDefault();
        const f = freqAtX(e.clientX);
        actions.zoomBy(e.deltaY > 0 ? 1.25 : 0.8, f);
    }, [actions, freqAtX]);

    // React's onWheel is passive, so preventDefault there is a no-op — the
    // listener has to be registered explicitly as non-passive.
    useEffect(() => {
        const el = wrapRef.current;
        if (!el) return undefined;
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [onWheel]);

    const span = view.span || 0;

    return (
        <div className="spectrum">
            <div className="spectrum__toolbar">
                <div className="spectrum__meta">
                    <span className="tag tag--accent">{formatSpan(span)}</span>
                    <span className="tag">centre {formatFreqShort(view.centerFreq || 0)}</span>
                    {hoverInfo && <span className="tag tag--ghost">{formatFreqShort(hoverInfo.freq, span)}</span>}
                </div>
                <div className="spectrum__tools">
                    <Button size="sm" variant="ghost" icon={<Icon.ZoomOut />} title="Zoom out" onClick={() => actions.zoomBy(1.6)} />
                    <Button size="sm" variant="ghost" icon={<Icon.ZoomIn />} title="Zoom in" onClick={() => actions.zoomBy(0.625)} />
                    <Button size="sm" variant="ghost" icon={<Icon.Target />} title="Centre on tuned frequency" onClick={actions.centerOnTuned} />
                    <Button size="sm" variant="ghost" icon={<Icon.Reset />} title="Full span" onClick={actions.resetSpectrum} />
                </div>
            </div>

            <div
                className="spectrum__canvas"
                ref={wrapRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onPointerLeave={onPointerLeave}
            >
                <canvas ref={specRef} className="spectrum__pane" />
                <canvas ref={scaleRef} className="spectrum__pane spectrum__pane--scale" />
                <canvas ref={wfRef} className="spectrum__pane" />
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

// Theme colours, resolved once per theme. getComputedStyle forces a style
// recalculation, so calling it inside the draw loop would cost more than the
// rendering itself.
const THEME_VARS = [
    '--spec-bg', '--spec-grid', '--spec-trace', '--spec-fill-a', '--spec-fill-b',
    '--spec-band', '--spec-vfo', '--scale-bg', '--scale-text', '--scale-tick', '--accent',
];
let themeCache = null;

function colors() {
    const theme = document.documentElement.dataset.theme || 'dark';
    if (themeCache && themeCache.theme === theme) return themeCache;
    const css = getComputedStyle(document.documentElement);
    const out = { theme };
    for (const name of THEME_VARS) out[name] = css.getPropertyValue(name).trim();
    themeCache = out;
    return out;
}

// Collapses `bins` onto `width` pixels, taking the maximum of each pixel's bin
// range so narrow carriers survive downsampling.
function binsToPixels(bins, width, out) {
    const n = bins.length;
    if (!n) return out;
    const ratio = n / width;
    for (let x = 0; x < width; x++) {
        const lo = Math.floor(x * ratio);
        const hi = Math.max(lo + 1, Math.floor((x + 1) * ratio));
        let m = -Infinity;
        for (let i = lo; i < hi && i < n; i++) {
            const v = bins[i];
            if (v > m) m = v;
        }
        out[x] = m === -Infinity ? bins[Math.min(n - 1, lo)] : m;
    }
    return out;
}

function autoRange(px, g) {
    // Robust floor: a low percentile is immune to the strong carriers that
    // would drag a plain minimum or mean around.
    const n = px.length;
    if (!n) return;
    const sample = [];
    const stride = Math.max(1, Math.floor(n / 512));
    for (let i = 0; i < n; i += stride) sample.push(px[i]);
    sample.sort((a, b) => a - b);
    const floor = sample[Math.floor(sample.length * 0.25)];
    const ceil = sample[Math.floor(sample.length * 0.995)];
    const targetFloor = floor - 4;
    const targetCeil = Math.max(targetFloor + 25, ceil + 12);
    // Ease towards the target so the display does not flicker frame to frame.
    g.autoFloor += (targetFloor - g.autoFloor) * 0.08;
    g.autoCeil += (targetCeil - g.autoCeil) * 0.08;
}

function drawFrame(g, d, ctx) {
    const { spec, wf, scale, cfg, tuning, width, specH, wfH, commitRow } = ctx;
    if (!spec || !width) return;

    const dpr = g.dpr;
    const pxW = Math.max(1, Math.round(width * dpr));

    if (!g.px || g.px.length !== pxW) {
        g.px = new Float32Array(pxW);
        g.peak = new Float32Array(pxW).fill(-200);
        g.smoothed = null;
    }
    binsToPixels(g.bins, pxW, g.px);

    // Optional temporal smoothing of the trace.
    let trace = g.px;
    if (d.smoothing > 0) {
        if (!g.smoothed || g.smoothed.length !== pxW) g.smoothed = Float32Array.from(g.px);
        const a = d.smoothing;
        for (let i = 0; i < pxW; i++) g.smoothed[i] = g.smoothed[i] * a + g.px[i] * (1 - a);
        trace = g.smoothed;
    }

    if (d.autoRange) autoRange(g.px, g);
    const floor = d.autoRange ? g.autoFloor : d.floorDb;
    const ceil = d.autoRange ? g.autoCeil : d.ceilDb;
    const range = Math.max(1, ceil - floor);

    drawWaterfall(g, d, wf, wfH, pxW, floor, range, commitRow);
    drawSpectrum(g, d, spec, specH, pxW, trace, floor, range, cfg, tuning, width);
    drawScale(g, d, scale, pxW, cfg, tuning, width);
}

function drawWaterfall(g, d, wf, wfH, pxW, floor, range, commitRow) {
    if (!wf || wfH <= 0 || !g.ring) return;
    const ring = g.ring;
    const rctx = g.ringCtx;
    const H = g.ringHeight;
    const rowH = Math.max(1, Math.round(d.rowHeight * g.dpr));

    if (commitRow) {
        const lut = getPalette(d.palette);
        const img = rctx.createImageData(pxW, 1);
        const data = img.data;
        // A little extra contrast at the bottom of the range keeps weak signals
        // from disappearing into the noise floor colour.
        const gammaInv = 1 / d.contrast;
        for (let x = 0; x < pxW; x++) {
            let t = (g.px[x] - floor) / range;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            if (d.contrast !== 1) t = Math.pow(t, gammaInv);
            const idx = (t * 255) | 0;
            const o = x * 4;
            data[o] = lut[idx * 3];
            data[o + 1] = lut[idx * 3 + 1];
            data[o + 2] = lut[idx * 3 + 2];
            data[o + 3] = 255;
        }

        for (let r = 0; r < rowH; r++) {
            g.ringHead = (g.ringHead - 1 + H) % H;
            rctx.putImageData(img, 0, g.ringHead);
        }
    }

    const octx = wf.getContext('2d', { alpha: false });
    octx.imageSmoothingEnabled = false;
    const head = g.ringHead;
    const firstH = Math.min(H - head, H);
    // Newest row sits at `head`; time runs downward through increasing indices.
    octx.drawImage(ring, 0, head, pxW, firstH, 0, 0, pxW, firstH);
    if (firstH < H) {
        octx.drawImage(ring, 0, 0, pxW, H - firstH, 0, firstH, pxW, H - firstH);
    }
}

function drawSpectrum(g, d, spec, specH, pxW, trace, floor, range, cfg, tuning, cssW) {
    const c = spec.getContext('2d', { alpha: false });
    const H = Math.max(1, Math.round(specH * g.dpr));
    const dpr = g.dpr;

    const col = colors();
    const colBg = col['--spec-bg'] || '#0a0d14';
    const colGrid = col['--spec-grid'] || 'rgba(255,255,255,0.06)';
    const colTrace = col['--spec-trace'] || '#5fd8e8';
    const colFillA = col['--spec-fill-a'] || 'rgba(95,216,232,0.35)';
    const colFillB = col['--spec-fill-b'] || 'rgba(95,216,232,0.02)';
    const colBand = col['--spec-band'] || 'rgba(124,108,247,0.20)';
    const colVfo = col['--spec-vfo'] || '#ffd166';

    c.fillStyle = colBg;
    c.fillRect(0, 0, pxW, H);

    const yOf = (db) => H - ((db - floor) / range) * H;

    // dB gridlines every 10 dB, labelled on the left.
    if (d.grid) {
        c.strokeStyle = colGrid;
        c.lineWidth = 1;
        c.font = `${10 * dpr}px ui-monospace, monospace`;
        c.fillStyle = colGrid;
        c.textBaseline = 'bottom';
        const step = range > 80 ? 20 : 10;
        const startDb = Math.ceil(floor / step) * step;
        for (let db = startDb; db < floor + range; db += step) {
            const y = Math.round(yOf(db)) + 0.5;
            c.beginPath();
            c.moveTo(0, y);
            c.lineTo(pxW, y);
            c.stroke();
            c.fillText(`${db.toFixed(0)}`, 4 * dpr, y - 2 * dpr);
        }
    }

    // Passband shading around the tuned frequency.
    if (cfg.span) {
        const hzToX = (hz) => ((hz - (cfg.centerFreq - cfg.span / 2)) / cfg.span) * pxW;
        const x0 = hzToX(tuning.frequency + tuning.bandwidthLow);
        const x1 = hzToX(tuning.frequency + tuning.bandwidthHigh);
        if (x1 > 0 && x0 < pxW) {
            c.fillStyle = colBand;
            c.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), H);
        }
    }

    // Peak hold, drawn beneath the live trace.
    if (d.peakHold) {
        for (let x = 0; x < pxW; x++) {
            const v = trace[x];
            g.peak[x] = v > g.peak[x] ? v : g.peak[x] - d.peakDecay;
        }
        c.strokeStyle = 'rgba(255,255,255,0.35)';
        c.lineWidth = dpr;
        c.beginPath();
        for (let x = 0; x < pxW; x++) {
            const y = yOf(g.peak[x]);
            if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
        }
        c.stroke();
    } else if (g.peak) {
        g.peak.fill(-200);
    }

    // Filled trace.
    c.beginPath();
    c.moveTo(0, H);
    for (let x = 0; x < pxW; x++) c.lineTo(x, yOf(trace[x]));
    c.lineTo(pxW, H);
    c.closePath();
    const grad = c.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, colFillA);
    grad.addColorStop(1, colFillB);
    c.fillStyle = grad;
    c.fill();

    c.beginPath();
    for (let x = 0; x < pxW; x++) {
        const y = yOf(trace[x]);
        if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.strokeStyle = colTrace;
    c.lineWidth = 1.25 * dpr;
    c.stroke();

    // VFO marker.
    if (cfg.span) {
        const x = ((tuning.frequency - (cfg.centerFreq - cfg.span / 2)) / cfg.span) * pxW;
        if (x >= 0 && x <= pxW) {
            c.strokeStyle = colVfo;
            c.lineWidth = dpr;
            c.setLineDash([4 * dpr, 3 * dpr]);
            c.beginPath();
            c.moveTo(x, 0);
            c.lineTo(x, H);
            c.stroke();
            c.setLineDash([]);
        }
    }

    // Hover crosshair.
    if (g.hover && g.hover.y < specH) {
        const x = Math.round(g.hover.x * dpr) + 0.5;
        c.strokeStyle = 'rgba(255,255,255,0.25)';
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(x, 0);
        c.lineTo(x, H);
        c.stroke();
    }
}

function drawScale(g, d, scale, pxW, cfg, tuning, cssW) {
    if (!scale) return;
    const c = scale.getContext('2d', { alpha: false });
    const dpr = g.dpr;
    const H = Math.round(SCALE_H * dpr);
    const col = colors();
    c.fillStyle = col['--scale-bg'] || '#0e131c';
    c.fillRect(0, 0, pxW, H);

    if (!cfg.span) return;
    const lo = cfg.centerFreq - cfg.span / 2;
    const hi = cfg.centerFreq + cfg.span / 2;

    // Choose a tick step giving roughly one label per 110 CSS px.
    const targetTicks = Math.max(2, Math.floor(cssW / 110));
    const rough = cfg.span / targetTicks;
    const pow = Math.pow(10, Math.floor(Math.log10(rough)));
    const mult = [1, 2, 2.5, 5, 10].find((m) => pow * m >= rough) || 10;
    const step = pow * mult;

    const textCol = col['--scale-text'] || '#8a95a8';
    const tickCol = col['--scale-tick'] || 'rgba(255,255,255,0.18)';

    c.font = `${11 * dpr}px ui-monospace, SFMono-Regular, monospace`;
    c.textBaseline = 'middle';
    c.textAlign = 'center';

    const minor = step / 5;
    for (let f = Math.ceil(lo / minor) * minor; f <= hi; f += minor) {
        const x = Math.round(((f - lo) / cfg.span) * pxW) + 0.5;
        const isMajor = Math.abs(f / step - Math.round(f / step)) < 1e-6;
        c.strokeStyle = tickCol;
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(x, 0);
        c.lineTo(x, isMajor ? 8 * dpr : 4 * dpr);
        c.stroke();
        if (isMajor) {
            c.fillStyle = textCol;
            c.fillText(formatFreqShort(f, cfg.span), x, H * 0.65);
        }
    }

    // Tuned-frequency pip: a downward triangle hanging from the top edge.
    const x = ((tuning.frequency - lo) / cfg.span) * pxW;
    if (x >= 0 && x <= pxW) {
        c.fillStyle = col['--spec-vfo'] || '#ffd166';
        c.beginPath();
        c.moveTo(x - 5 * dpr, 0);
        c.lineTo(x + 5 * dpr, 0);
        c.lineTo(x, 7 * dpr);
        c.closePath();
        c.fill();
    }
}

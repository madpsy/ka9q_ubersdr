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

import React, { useCallback, useEffect, useMemo, useRef, useState } from '../react.js';
import { useMeters, useRadio } from '../radio/RadioContext.jsx';
import { getPalette } from '../lib/palettes.js';
import { formatFreqShort, formatSpan, clamp } from '../lib/format.js';
import { MAX_FREQ, MIN_FREQ } from '../radio/constants.js';
import { useDisplay } from '../display/DisplayContext.jsx';
import { bandwidthColor } from '../display/uiConfig.js';
import { Button, Icon } from './ui.jsx';
import MarkerBar from './MarkerBar.jsx';

const SCALE_H = 26;       // frequency ruler height, CSS px
const MIN_SPECTRUM_H = 60;
const MIN_WATERFALL_H = 40;

// Squelch state in the spectrum toolbar. Split into its own component so the
// 10 Hz meter sampling re-renders this tag alone — SpectrumView owns the draw
// loop and must not re-render at meter rate.
function SquelchTag() {
    const { squelch } = useRadio();
    const m = useMeters(10);
    if (!squelch.enabled) return null;
    const open = m.squelchOpen;
    return (
        <span
            className={`tag tag--${open ? 'good' : 'bad'}`}
            title={`Squelch ≥ ${squelch.value.toFixed(1)} dB SNR — ${open ? 'passing audio' : 'muted'}`}
        >
            SQ {open ? 'open' : 'closed'}
        </span>
    );
}

// Which noise-reduction filter is running, if any. `dsp.enabled` comes from the
// server's dsp_status echo, so this reflects what the server is actually doing
// rather than what was requested.
function NoiseReductionTag() {
    const { dsp } = useRadio();
    if (!dsp.enabled || !dsp.filter) return null;
    const schema = (dsp.schemas || []).find((f) => f.name === dsp.filter);
    return (
        <span className="tag tag--accent" title={schema ? schema.description : 'Noise reduction'}>
            NR {dsp.filter.toUpperCase()}
        </span>
    );
}

// The client-side audio filters that are on. Just their names — the settings
// live in the Audio filters panel; this is here so you can see at a glance that
// the audio is being shaped, without hunting for which panel did it.
function FilterTags() {
    const { filters } = useRadio();
    const on = [
        filters.gate.enabled && 'GATE',
        filters.eq.enabled && 'EQ',
        filters.notch.enabled && filters.notch.items.length > 0 && 'NOTCH',
        filters.bandpass.enabled && 'BPF',
        filters.compressor.enabled && 'COMP',
        filters.stereo.enabled && 'WIDE',
    ].filter(Boolean);
    if (!on.length) return null;
    return (
        <>
            {on.map((name) => (
                <span key={name} className="tag tag--accent" title={`${name} filter active`}>{name}</span>
            ))}
        </>
    );
}

// ---------------------------------------------------------------------------
// Station ID overlay
//
// The block v1 paints in the top-right of its spectrum, reproduced line for
// line so both UIs read identically:
//
//   1  bold 13px   "<callsign> - <name>"
//   2  11px, 75%   location (+ the receiver's UTC offset)
//   3  11px, 75%   local weather, when /api/weather is configured
//   4  11px, 75%   active antenna, when the antenna switch is enabled
//
// Colour and the on/off switch are the operator's station_id_color and
// station_id_overlay from /api/ui-config — the same values v1 reads.
const WIND_DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'N'];

function weatherLine(wd) {
    if (!wd || !wd.weather || !wd.weather.length) return null;
    const desc = String(wd.weather[0].description || '')
        .split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const temp = wd.main && wd.main.temp !== undefined
        ? `\u{1F321}️${Math.round(wd.main.temp)}°C` : '';
    let wind = '';
    if (wd.wind && wd.wind.speed !== undefined) {
        const kmh = Math.round(wd.wind.speed * 3.6);
        const dir = wd.wind.deg !== undefined ? WIND_DIRS[Math.round(wd.wind.deg / 45) % 8] : '';
        wind = `\u{1F4A8}${kmh} km/h${dir ? ' ' + dir : ''}`;
    }
    return [desc, temp, wind].filter(Boolean).join('  ') || null;
}

function antennaLine(ant) {
    if (!ant || !ant.enabled) return null;
    if (ant.grounded) return 'Grounded';
    if (ant.active_labels && ant.active_labels.length) return ant.active_labels.join(', ');
    if (ant.selected && ant.selected.length) {
        return ant.selected.map((n) => (ant.antenna_labels && ant.antenna_labels[n - 1]) || `Antenna ${n}`).join(', ');
    }
    return null;
}

// Only fetched while the overlay is actually on screen, so a waterfall-only
// session makes neither request.
function useStationOverlay(enabled) {
    const { serverInfo } = useRadio();
    const [weather, setWeather] = useState(null);
    const [antenna, setAntenna] = useState(null);

    const antEnabled = enabled && !!serverInfo?.ant_switch?.enabled;

    useEffect(() => {
        if (!enabled) return undefined;
        let cancelled = false;
        const load = () => fetch('/api/weather')
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (!cancelled) setWeather(weatherLine(d)); })
            .catch(() => { /* weather is optional — leave the line off */ });
        load();
        // 15 minutes, matching the server-side cache interval v1 tracks.
        const id = setInterval(load, 15 * 60 * 1000);
        return () => { cancelled = true; clearInterval(id); };
    }, [enabled]);

    useEffect(() => {
        if (!antEnabled) return undefined;
        let cancelled = false;
        setAntenna(antennaLine(serverInfo.ant_switch));   // seed from /api/description
        const load = () => fetch('/api/ant-switch/status')
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (!cancelled && d && d.enabled) setAntenna(antennaLine(d)); })
            .catch(() => { /* keep the last known label */ });
        load();
        const id = setInterval(load, 30000);
        return () => { cancelled = true; clearInterval(id); };
    }, [antEnabled, serverInfo]);

    // Memoised: SpectrumView re-renders on every pointer move, and the draw
    // loop only needs a new array when the text itself changes.
    const rx = serverInfo?.receiver;
    return useMemo(() => {
        if (!enabled || !rx) return null;

        const callsign = (rx.callsign || '').trim();
        const name = (rx.name || '').trim();
        if (!callsign && !name) return null;

        // "Dalgety Bay, Scotland, UK (UTC +1h)" — v1 appends the offset, in
        // hours and minutes, whenever the operator configured a timezone.
        let tzSuffix = '';
        if (typeof rx.timezone_offset === 'number') {
            const sign = rx.timezone_offset >= 0 ? '+' : '-';
            const abs = Math.abs(rx.timezone_offset);
            const h = Math.floor(abs / 60);
            const m = abs % 60;
            tzSuffix = m > 0 ? ` (UTC ${sign}${h}h${m}m)` : ` (UTC ${sign}${h}h)`;
        }
        const location = (rx.location || '').trim();
        const locationLine = location ? location + tzSuffix : tzSuffix.trim();

        return [
            { text: callsign && name ? `${callsign} - ${name}` : (callsign || name), bold: true, size: 13, alpha: 1 },
            ...[locationLine, weather, antenna]
                .filter(Boolean)
                .map((text) => ({ text, bold: false, size: 11, alpha: 0.75 })),
        ];
    }, [enabled, rx, weather, antenna]);
}

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
        peakAt: 0,
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
        bgImage: null,       // operator backdrop, split view only
        bgOpacity: 0,
        bgUrl: '',
    });

    // Mirrors of React values the draw loop reads; refs avoid re-subscribing.
    const cfgRef = useRef({ centerFreq: 0, span: 0, binCount: 0, binBandwidth: 0 });
    cfgRef.current = view;
    const tuneRef = useRef(tuning);
    tuneRef.current = tuning;
    const dispRef = useRef(display);
    dispRef.current = display;

    const [hoverInfo, setHoverInfo] = useState(null);
    const hovering = hoverInfo != null;
    const [sizes, setSizes] = useState({ w: 0, h: 0 });

    // How the centre area is divided. The scale sits between the two panes, so
    // in spectrum-only it ends up along the bottom and in waterfall-only along
    // the top — both the conventional placement — with no special casing.
    const viewMode = display.viewMode || 'split';

    // Station ID overlay: split view only, and only if the operator left it on.
    // The lines go into the gfx ref because the draw loop, not React, paints
    // them — they change every few minutes at most.
    const station = useStationOverlay(viewMode === 'split' && display.server.stationIdOverlay);
    useEffect(() => {
        gfx.current.station = station;
        gfx.current.stationColor = display.server.stationIdColor;
        gfx.current.dirty = true;
    }, [station, display.server.stationIdColor]);

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

    const avail = Math.max(0, sizes.h - SCALE_H);
    let specH;
    if (viewMode === 'spectrum') {
        specH = avail;
    } else if (viewMode === 'waterfall') {
        specH = 0;
    } else {
        // Keep both panes usable, but never demand more height than exists.
        const minSpec = Math.min(MIN_SPECTRUM_H, avail);
        const minWf = Math.min(MIN_WATERFALL_H, Math.max(0, avail - minSpec));
        specH = clamp(Math.round(avail * display.split), minSpec, avail - minWf);
    }
    const wfH = avail - specH;

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

    // Operator-supplied backdrop for the spectrum, behind the trace.
    //
    // Only fetched once split view is actually used — the image can be a
    // several-hundred-kilobyte PNG, and there is no reason to pull it for
    // someone who only ever looks at the waterfall. Once loaded it is kept, so
    // toggling view modes does not re-fetch it.
    const { bgImage: bgUrl, bgOpacity } = display.server;
    useEffect(() => {
        const g = gfx.current;
        g.bgOpacity = bgOpacity;
        g.dirty = true;
        if (viewMode !== 'split' || !bgUrl || g.bgUrl === bgUrl) return undefined;

        g.bgUrl = bgUrl;
        const img = new Image();
        img.onload = () => {
            if (gfx.current.bgUrl !== bgUrl) return;   // config changed mid-flight
            gfx.current.bgImage = img;
            gfx.current.dirty = true;
        };
        img.onerror = () => {
            console.warn('spectrum: background image failed to load', bgUrl);
            if (gfx.current.bgUrl === bgUrl) gfx.current.bgImage = null;
        };
        // Cache-bust so a freshly uploaded image is picked up, as v1 does.
        img.src = bgUrl + (bgUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
        return () => { img.onload = null; img.onerror = null; };
    }, [bgUrl, bgOpacity, viewMode]);

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
        if (f != null) {
            // v1's readout: what is under the cursor, and the strongest signal
            // in view (spectrum-display.js:3303). g.px is the per-pixel dB
            // column the trace is drawn from, so both come out of one array.
            const px = g.px;
            let db = null;
            let peakDb = null;
            let peakFreq = null;
            if (px && px.length) {
                const i = clamp(Math.round((e.clientX - r.left) * g.dpr), 0, px.length - 1);
                db = px[i];
                let best = 0;
                for (let k = 1; k < px.length; k++) if (px[k] > px[best]) best = k;
                peakDb = px[best];
                peakFreq = cfg.span
                    ? cfg.centerFreq - cfg.span / 2 + (best / px.length) * cfg.span
                    : null;
            }
            setHoverInfo({
                freq: f, db, peakDb, peakFreq,
                x: e.clientX - r.left,
                y: e.clientY - r.top,
            });
        }

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
        if (f == null) return;
        // Snap to whatever the Receiver panel's step is set to, so clicking the
        // spectrum and pressing +/- agree about where the channels are.
        const step = dispRef.current.tuneStep || 1;
        actions.setFrequency(step > 1 ? Math.round(f / step) * step : f);
    }, [actions, freqAtX]);

    // The readout has to follow the data, not the mouse: standing still over a
    // signal and watching it fade should change the numbers. Recomputed from
    // the last pointer position a few times a second — frame rate would be
    // pointless React churn for a two-line label.
    useEffect(() => {
        if (!hovering) return undefined;
        const id = setInterval(() => {
            const g = gfx.current;
            const cfg = cfgRef.current;
            if (!g.hover || !g.px || !g.px.length) return;
            const px = g.px;
            const i = clamp(Math.round(g.hover.x * g.dpr), 0, px.length - 1);
            let best = 0;
            for (let k = 1; k < px.length; k++) if (px[k] > px[best]) best = k;
            setHoverInfo((prev) => (prev ? {
                ...prev,
                db: px[i],
                peakDb: px[best],
                peakFreq: cfg.span
                    ? cfg.centerFreq - cfg.span / 2 + (best / px.length) * cfg.span
                    : null,
            } : prev));
        }, 150);
        return () => clearInterval(id);
    }, [hovering]);

    const onPointerLeave = useCallback(() => {
        gfx.current.hover = null;
        gfx.current.dirty = true;
        setHoverInfo(null);
    }, []);

    // Trackpads emit many small deltas per physical gesture, so accumulate to a
    // threshold — otherwise one flick would fire a dozen factor-of-two zooms.
    const wheelAcc = useRef(0);
    const onWheel = useCallback((e) => {
        e.preventDefault();
        const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        wheelAcc.current += step;
        if (Math.abs(wheelAcc.current) < 50) return;
        const dir = wheelAcc.current < 0 ? -1 : 1;
        wheelAcc.current = 0;

        // Wheel either zooms or tunes, per the Display panel. Tuning uses the
        // Receiver panel's step and its snapping, so it agrees with the +/-
        // buttons and with click-to-tune; scrolling up goes up in frequency,
        // matching the frequency dial's digits.
        if (dispRef.current.wheelAction === 'tune') {
            actions.stepBy(dispRef.current.tuneStep || 500, dir < 0 ? 1 : -1);
            return;
        }
        const f = freqAtX(e.clientX);
        if (dir < 0) actions.zoomIn(f); else actions.zoomOut(f);
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
                    <SquelchTag />
                    <NoiseReductionTag />
                    <FilterTags />
                </div>
                <div className="spectrum__tools">
                    <Button size="sm" variant="ghost" icon={<Icon.ZoomOut />} title="Zoom out" onClick={() => actions.zoomOut()} />
                    <Button size="sm" variant="ghost" icon={<Icon.ZoomIn />} title="Zoom in" onClick={() => actions.zoomIn()} />
                    <Button size="sm" variant="ghost" icon={<Icon.Target />} title="Centre on tuned frequency" onClick={actions.centerOnTuned} />
                    <Button size="sm" variant="ghost" icon={<Icon.Reset />} title="Full span" onClick={actions.resetSpectrum} />
                </div>
            </div>

            <MarkerBar width={sizes.w} />

            <div
                className="spectrum__canvas"
                ref={wrapRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onPointerLeave={onPointerLeave}
            >
                {hoverInfo && hoverInfo.db != null && (
                    <div
                        className="spec-tip"
                        style={{
                            // Sits right of the cursor, flipping left near the
                            // edge so it never leaves the canvas — as v1 does.
                            left: hoverInfo.x + (hoverInfo.x > sizes.w - 150 ? -14 : 14),
                            top: hoverInfo.y + 12,
                            transform: hoverInfo.x > sizes.w - 150 ? 'translateX(-100%)' : undefined,
                        }}
                    >
                        <div>Cursor: {formatFreqShort(hoverInfo.freq, span)} | {hoverInfo.db.toFixed(1)} dB</div>
                        {hoverInfo.peakFreq != null && (
                            <div>Peak: {formatFreqShort(hoverInfo.peakFreq, span)} | {hoverInfo.peakDb.toFixed(1)} dB</div>
                        )}
                    </div>
                )}
                {specH > 0 && <canvas ref={specRef} className="spectrum__pane" />}
                <canvas ref={scaleRef} className="spectrum__pane spectrum__pane--scale" />
                {wfH > 0 && <canvas ref={wfRef} className="spectrum__pane" />}
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
    '--spec-bg', '--spec-grid', '--spec-band', '--spec-vfo',
    '--scale-bg', '--scale-text', '--scale-tick', '--accent',
];
let themeCache = null;

// Vertical palette gradients for the spectrum, so the trace and its fill use
// the same colour-per-amplitude mapping as the waterfall: hot at the top of the
// dB range, cold at the bottom, with the same `contrast` gamma applied.
//
// The fill is opaque. A translucent wash reads as a tint rather than a filled
// spectrum, and leaving it solid is what makes the backdrop image work: the
// image shows in the open area above the trace, with the signal a solid block
// below it.
//
// The trace is drawn from a compressed slice of the palette (TRACE_FLOOR..1)
// because most palettes start at near-black, which would make weak signals
// invisible against the dark background.
const TRACE_FLOOR = 0.35;
const GRAD_STOPS = 24;

function paletteGradients(c, H, palette, contrast) {
    const lut = getPalette(palette);
    const gammaInv = 1 / contrast;
    const trace = c.createLinearGradient(0, 0, 0, H);
    const fill = c.createLinearGradient(0, 0, 0, H);

    for (let i = 0; i <= GRAD_STOPS; i++) {
        const offset = i / GRAD_STOPS;        // 0 = top of the range
        let amp = 1 - offset;                 // amplitude fraction at this height
        if (contrast !== 1) amp = Math.pow(amp, gammaInv);

        const fi = Math.round(amp * 255) * 3;
        fill.addColorStop(offset, `rgb(${lut[fi]},${lut[fi + 1]},${lut[fi + 2]})`);

        const ti = Math.round((TRACE_FLOOR + amp * (1 - TRACE_FLOOR)) * 255) * 3;
        trace.addColorStop(offset, `rgb(${lut[ti]},${lut[ti + 1]},${lut[ti + 2]})`);
    }
    return { trace, fill };
}

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

// Minimum dynamic range, v1's `autoMinSpan` (spectrum-display.js updateAutoRange).
//
// On a quiet band auto-levelling compresses the window until noise wobble fills
// the whole height and every ripple looks like a signal. This guarantees at
// least `minSpan` dB are shown, expanding 75% upward (headroom for signals) and
// 25% downward, and only re-commits when the new edges move more than 3 dB —
// without that dead-band the grid ticks jitter as the smoothed values drift.
const CLAMP_HYSTERESIS = 3;

function applyMinSpan(g, minSpan) {
    if (!(minSpan > 0)) {
        g.clampedFloor = null;
        return;
    }
    const range = g.autoCeil - g.autoFloor;
    if (range >= minSpan) {
        g.clampedFloor = null;
        return;
    }
    const deficit = minSpan - range;
    const ceil = Math.round(g.autoCeil + deficit * 0.75);
    const floor = Math.round(g.autoFloor - deficit * 0.25);
    if (g.clampedFloor == null
        || Math.abs(floor - g.clampedFloor) > CLAMP_HYSTERESIS
        || Math.abs(ceil - g.clampedCeil) > CLAMP_HYSTERESIS) {
        g.clampedFloor = floor;
        g.clampedCeil = ceil;
    }
    g.autoFloor = g.clampedFloor;
    g.autoCeil = g.clampedCeil;
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
    // Either pane may be absent — the view mode can hide one of them entirely.
    if (!width) return;

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

    if (d.autoRange) {
        autoRange(g.px, g);
        // null means "follow the operator's default"; 0 means no minimum.
        applyMinSpan(g, d.autoMinSpan != null ? d.autoMinSpan : d.server.autoMinSpan);
    }
    const floor = d.autoRange ? g.autoFloor : d.floorDb;
    const ceil = d.autoRange ? g.autoCeil : d.ceilDb;
    const range = Math.max(1, ceil - floor);

    // Soft enough to read as context beside the dial line; v1's colour name.
    const colEdge = bandwidthColor(d.server.bandwidthColorName, 0.38);
    const colVfoLine = colors()['--spec-vfo'] || '#ffd166';

    drawWaterfall(g, d, wf, wfH, pxW, floor, range, commitRow, cfg, tuning, colVfoLine, colEdge);
    drawSpectrum(g, d, spec, specH, pxW, trace, floor, range, cfg, tuning, width, colEdge);
    drawScale(g, d, scale, pxW, cfg, tuning, width);
}

// The tuned frequency and the edges of what is being demodulated, drawn on
// both panes so the waterfall shows what you are listening to rather than
// leaving you to line it up against the spectrum above.
//
// The dial line is the loud one — dashed, in the VFO colour. The passband edges
// are deliberately quieter: they are context, not the thing you are aiming
// with, and two more bright lines either side of the dial just adds noise.
// Their colour is the operator's bandwidth_indicator_color, as in v1.
function drawTuningMarks(c, pxW, H, cfg, tuning, dpr, edgeColor) {
    if (!cfg.span) return;
    const hzToX = (hz) => ((hz - (cfg.centerFreq - cfg.span / 2)) / cfg.span) * pxW;

    for (const edge of [tuning.frequency + tuning.bandwidthLow, tuning.frequency + tuning.bandwidthHigh]) {
        const x = hzToX(edge);
        if (x < 0 || x > pxW) continue;
        c.strokeStyle = edgeColor;
        c.lineWidth = dpr;
        c.setLineDash([2 * dpr, 4 * dpr]);
        c.beginPath();
        c.moveTo(Math.round(x) + 0.5, 0);
        c.lineTo(Math.round(x) + 0.5, H);
        c.stroke();
        c.setLineDash([]);
    }
}

function drawWaterfall(g, d, wf, wfH, pxW, floor, range, commitRow, cfg, tuning, colVfo, colEdge) {
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

    // Markers go on the visible canvas, never into the ring — otherwise they
    // would scroll away with the history instead of standing still.
    if (g.hover) {
        const hx = Math.round(g.hover.x * g.dpr) + 0.5;
        octx.strokeStyle = 'rgba(255,255,255,0.25)';
        octx.lineWidth = 1;
        octx.beginPath();
        octx.moveTo(hx, 0);
        octx.lineTo(hx, H);
        octx.stroke();
    }
    drawTuningMarks(octx, pxW, H, cfg, tuning, g.dpr, colEdge);
    if (cfg.span) {
        const x = ((tuning.frequency - (cfg.centerFreq - cfg.span / 2)) / cfg.span) * pxW;
        if (x >= 0 && x <= pxW) {
            octx.strokeStyle = colVfo;
            octx.lineWidth = g.dpr;
            octx.setLineDash([4 * g.dpr, 3 * g.dpr]);
            octx.beginPath();
            octx.moveTo(x, 0);
            octx.lineTo(x, H);
            octx.stroke();
            octx.setLineDash([]);
        }
    }
}

function drawSpectrum(g, d, spec, specH, pxW, trace, floor, range, cfg, tuning, cssW, colEdge) {
    if (!spec || specH <= 0) return;
    const c = spec.getContext('2d', { alpha: false });
    const H = Math.max(1, Math.round(specH * g.dpr));
    const dpr = g.dpr;

    const col = colors();
    const colBg = col['--spec-bg'] || '#0a0d14';
    const colGrid = col['--spec-grid'] || 'rgba(255,255,255,0.06)';
    const colBand = col['--spec-band'] || 'rgba(124,108,247,0.20)';
    const colVfo = col['--spec-vfo'] || '#ffd166';

    // Gradients depend only on palette, contrast and height — not on the live
    // dB range — so they survive auto-levelling and are rebuilt rarely. Keyed on
    // the canvas too: a CanvasGradient belongs to the context that made it, and
    // switching view modes can replace the element at the same height.
    const gradKey = `${d.palette}|${d.contrast}|${H}`;
    if (g.gradKey !== gradKey || g.gradCanvas !== spec) {
        const grads = paletteGradients(c, H, d.palette, d.contrast);
        g.traceGrad = grads.trace;
        g.fillGrad = grads.fill;
        g.gradKey = gradKey;
        g.gradCanvas = spec;
    }

    c.fillStyle = colBg;
    c.fillRect(0, 0, pxW, H);

    // Operator backdrop, stretched to the spectrum area and blended over the
    // background colour — split view only, where there is enough height for it
    // to read as anything other than a smear.
    const overImage = d.viewMode === 'split' && !!g.bgImage && g.bgOpacity > 0;
    if (overImage) {
        c.save();
        c.globalAlpha = Math.max(0, Math.min(1, g.bgOpacity));
        c.drawImage(g.bgImage, 0, 0, pxW, H);
        c.restore();
    }

    // Station block sits on the backdrop, under everything else: the trace, the
    // fill and the passband shading pass over it, so it reads as part of the
    // background rather than as a label floating above the signal.
    drawStationId(g, c, pxW, dpr);

    const yOf = (db) => H - ((db - floor) / range) * H;

    // dB gridlines every 10 dB, labelled on the left.
    //
    // Over a backdrop the usual near-transparent white is invisible on anything
    // but a dark image, so the lines are strengthened and the labels drawn solid
    // white with a dark shadow — which keeps them readable over a light image
    // too. Lines and labels are drawn in separate passes so the shadow applies
    // only to the text.
    if (d.grid) {
        const step = range > 80 ? 20 : 10;
        const startDb = Math.ceil(floor / step) * step;
        const ticks = [];
        for (let db = startDb; db < floor + range; db += step) ticks.push(db);

        c.strokeStyle = overImage ? 'rgba(255,255,255,0.32)' : colGrid;
        c.lineWidth = 1;
        for (const db of ticks) {
            const y = Math.round(yOf(db)) + 0.5;
            c.beginPath();
            c.moveTo(0, y);
            c.lineTo(pxW, y);
            c.stroke();
        }

        c.font = `${10 * dpr}px ui-monospace, monospace`;
        c.textBaseline = 'bottom';
        c.textAlign = 'left';
        c.fillStyle = overImage ? '#ffffff' : colGrid;
        if (overImage) {
            c.save();
            c.shadowColor = 'rgba(0,0,0,0.85)';
            c.shadowBlur = 3 * dpr;
        }
        for (const db of ticks) {
            const y = Math.round(yOf(db)) + 0.5;
            c.fillText(`${db.toFixed(0)}`, 4 * dpr, y - 2 * dpr);
        }
        if (overImage) c.restore();
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
    // Peak hold decays in dB per *second*, not per frame: the draw rate follows
    // the server's frame rate, so a per-frame decay made the hold time depend
    // on how fast the spectrum happened to be arriving. 0 holds indefinitely.
    if (d.peakHold) {
        const now = performance.now();
        const dt = g.peakAt ? Math.min(1, (now - g.peakAt) / 1000) : 0;
        g.peakAt = now;
        const drop = (d.peakDecay || 0) * dt;
        for (let x = 0; x < pxW; x++) {
            const v = trace[x];
            g.peak[x] = v > g.peak[x] ? v : g.peak[x] - drop;
        }
    } else if (g.peak) {
        g.peak.fill(-200);
        g.peakAt = 0;
    }

    // Solid area under the trace. Turning this off leaves a bare line, which
    // shows the whole backdrop and makes overlapping signals easier to separate.
    if (d.fill !== false) {
        c.beginPath();
        c.moveTo(0, H);
        for (let x = 0; x < pxW; x++) c.lineTo(x, yOf(trace[x]));
        c.lineTo(pxW, H);
        c.closePath();
        c.fillStyle = g.fillGrad;
        c.fill();
    }

    if (d.peakHold) {
        c.beginPath();
        for (let x = 0; x < pxW; x++) {
            const y = yOf(g.peak[x]);
            if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
        }
        c.strokeStyle = 'rgba(255,255,255,0.55)';
        c.lineWidth = dpr;
        c.stroke();
    }

    c.beginPath();
    for (let x = 0; x < pxW; x++) {
        const y = yOf(trace[x]);
        if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.strokeStyle = g.traceGrad;
    c.lineWidth = 1.25 * dpr;
    c.stroke();

    drawTuningMarks(c, pxW, H, cfg, tuning, dpr, colEdge);

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

    // Hover crosshair. Drawn whenever the pointer is anywhere over the view,
    // not only when it is over this pane: the two panes share one frequency
    // axis, and a line on just one of them makes you eyeball the other.
    if (g.hover) {
        const x = Math.round(g.hover.x * dpr) + 0.5;
        c.strokeStyle = 'rgba(255,255,255,0.25)';
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(x, 0);
        c.lineTo(x, H);
        c.stroke();
    }
}

// Top-right station block. Geometry is v1's: 6 px inset, 16 px line pitch, and
// a 1 px black drop shadow under every line so the text stays legible over a
// bright backdrop image or a strong signal.
function drawStationId(g, c, pxW, dpr) {
    const lines = g.station;
    if (!lines || !lines.length) return;

    const rightX = pxW - 6 * dpr;
    let y = 6 * dpr;
    const col = g.stationColor || '#ffffff';

    c.save();
    c.textAlign = 'right';
    c.textBaseline = 'top';
    for (const line of lines) {
        c.font = `${line.bold ? 'bold ' : ''}${line.size * dpr}px ui-sans-serif, system-ui, sans-serif`;
        c.globalAlpha = 1;
        c.fillStyle = 'rgba(0,0,0,0.55)';
        c.fillText(line.text, rightX + dpr, y + dpr);
        c.globalAlpha = line.alpha;
        c.fillStyle = col;
        c.fillText(line.text, rightX, y);
        y += 16 * dpr;
    }
    c.restore();
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

// Audio oscilloscope and audio waterfall — v1's "Audio visualization" section.
//
// Two views over the decoded audio, shown separately or together:
//
//   scope      time domain, with a timebase you can set and an auto-scaled
//              vertical axis, so a carrier or a CW note reads as a waveform
//   waterfall  the audio spectrum over time, in the same palette as the RF
//              waterfall, across the passband the current mode actually carries
//
// Both read one AnalyserNode from the audio player. Nothing here runs unless
// the panel is on screen: a collapsed section is not rendered at all, so the
// effect below never mounts, no getByteTimeDomainData/getFloatFrequencyData
// call is made — an AnalyserNode only transforms when it is read — and the
// node's FFT size drops back to its resting value on unmount.
//
// The x axis is the *useful* audio bandwidth, not Nyquist: see lib/audioBand.js
// for how the mode's passband maps onto FFT bins, which is where LSB (negative
// passband), AM (straddling zero) and CW (500 Hz tone offset) are handled.

import React, { useEffect, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import { Field, Segmented, Slider } from '../components/ui.jsx';
import { getPalette } from '../lib/palettes.js';
import { audioBins } from '../lib/audioBand.js';

const VIEWS = [
    { value: 'both', label: 'Both' },
    { value: 'scope', label: 'Scope' },
    { value: 'waterfall', label: 'Waterfall' },
];

const FFT_SIZES = [
    { value: 2048, label: 'Fast' },
    { value: 4096, label: 'Balanced' },
    { value: 8192, label: 'Detail' },
    { value: 16384, label: 'Max' },
];

const SCOPE_H = 96;
const WF_H = 120;
const RULER_H = 13;
const ROW_MS = 33;          // one waterfall row, ~30 fps as in v1

// Silence guards. With the squelch closed the server sends nothing, or sends
// dither a hundred dB down, and an unbounded auto-scale turns that into a
// full-height mess of quantisation noise and a boiling waterfall. Both views
// therefore refuse to magnify beyond a point, and fall back to a flat line and
// a dark waterfall — which is what "no audio" should look like.
const SCOPE_MIN_PEAK = 0.05;   // fraction of full scale; below this, no extra gain
const SCOPE_SILENT_LSB = 2;    // +/-2/128 or less is the gate closed, not a signal
const WF_FLOOR_DB = -110;      // never map anything quieter than this
const WF_MIN_SPAN_DB = 45;     // and never stretch a narrower range than this

function fmtHz(hz) {
    return hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 ? 1 : 0)}k` : `${Math.round(hz)}`;
}

export default function ScopePanel() {
    const { player, running, tuning } = useRadio();
    const display = useDisplay();

    const [view, setView] = useState(display.scopeView || 'both');
    const [fftSize, setFftSize] = useState(display.scopeFft || 4096);
    const [timebase, setTimebase] = useState(display.scopeTimebase || 20);   // ms across the scope
    const [contrast, setContrast] = useState(display.scopeContrast || 1);
    const [rate, setRate] = useState(null);   // audio sample rate, once known

    const scopeRef = useRef(null);
    const wfRef = useRef(null);
    const rulerRef = useRef(null);
    // Waterfall history, kept as an offscreen canvas so a row is one blit.
    const ring = useRef({ canvas: null, ctx: null, w: 0, h: 0, head: 0, at: 0 });
    const level = useRef({ floor: -100, ceil: -30 });
    // Latest FFT frame plus the window it covers, so the hover readout can be
    // answered from the pointer handler without running its own analysis.
    const last = useRef(null);
    const [tip, setTip] = useState(null);
    // Smoothed vertical gain for the scope, so the trace does not jump as the
    // gate opens and closes.
    const scope = useRef({ gain: 1 });

    const showScope = view !== 'waterfall';
    const showWf = view !== 'scope';

    // Persist the choices with the other display settings.
    useEffect(() => {
        display.set({
            scopeView: view, scopeFft: fftSize, scopeTimebase: timebase, scopeContrast: contrast,
        });
    }, [view, fftSize, timebase, contrast]);   // eslint-disable-line

    useEffect(() => {
        const analyser = player.acquireAnalyser(fftSize);
        if (!analyser) return () => player.releaseAnalyser();

        // Reallocated on demand: a mode change can rebuild the audio context at
        // a different sample rate, which replaces the analyser under us.
        let bins = new Float32Array(analyser.frequencyBinCount);
        let wave = new Uint8Array(analyser.fftSize);
        let raf = 0;

        const loop = () => {
            raf = requestAnimationFrame(loop);
            const a = player.analyser;
            if (!a) return;
            if (bins.length !== a.frequencyBinCount) bins = new Float32Array(a.frequencyBinCount);
            if (wave.length !== a.fftSize) wave = new Uint8Array(a.fftSize);
            const sr = player.sampleRate || 48000;
            if (sr !== rate) setRate(sr);

            if (showScope) drawScope(scopeRef.current, a, wave, sr, timebase, scope.current);
            if (showWf) {
                last.current = { bins, sampleRate: sr, binCount: a.frequencyBinCount, tuning };
                drawWaterfall(
                    wfRef.current, ring.current, a, bins, sr, tuning,
                    display.palette, contrast, level.current,
                );
                drawRuler(rulerRef.current, tuning, sr, a.frequencyBinCount);
            }
        };
        raf = requestAnimationFrame(loop);

        return () => {
            cancelAnimationFrame(raf);
            player.releaseAnalyser();
        };
    }, [player, fftSize, showScope, showWf, timebase, tuning, display.palette, contrast, rate]);

    const bins = audioBins(tuning.bandwidthLow, tuning.bandwidthHigh, rate || 48000, 1024);

    // Cursor and peak, the two lines v1 shows over its audio spectrum and
    // waterfall (app.js updateAudioSpectrumTooltip).
    const onHover = (e) => {
        const l = last.current;
        const el = e.currentTarget;
        if (!l) return;
        const r = el.getBoundingClientRect();
        const x = e.clientX - r.left;
        const frac = Math.max(0, Math.min(1, x / r.width));

        const { start, count, startFreq, endFreq } = audioBins(
            l.tuning.bandwidthLow, l.tuning.bandwidthHigh, l.sampleRate, l.binCount,
        );
        if (!count) return;

        const at = start + Math.min(count - 1, Math.floor(frac * count));
        let peak = start;
        for (let i = start; i < start + count; i++) if (l.bins[i] > l.bins[peak]) peak = i;

        const freqOf = (bin) => startFreq + ((bin - start) / count) * (endFreq - startFreq);
        setTip({
            x,
            y: e.clientY - r.top,
            w: r.width,
            freq: freqOf(at),
            db: l.bins[at],
            peakFreq: freqOf(peak),
            peakDb: l.bins[peak],
        });
    };

    const tipText = (hz, db) => `${fmtHz(hz)} Hz | ${Number.isFinite(db) ? db.toFixed(1) : '-∞'} dB`;

    return (
        <div className="stack">
            <Segmented options={VIEWS} value={view} onChange={setView} size="sm" />

            {showScope && (
                <div className="scope">
                    <canvas ref={scopeRef} className="scope__canvas" style={{ height: SCOPE_H }} />
                </div>
            )}

            {showWf && (
                <div className="scope scope--hover">
                    <canvas
                        ref={wfRef}
                        className="scope__canvas"
                        style={{ height: WF_H }}
                        onPointerMove={onHover}
                        onPointerLeave={() => setTip(null)}
                    />
                    <canvas ref={rulerRef} className="scope__canvas scope__ruler" style={{ height: RULER_H }} />
                    {tip && (
                        <div
                            className="spec-tip"
                            style={{
                                left: tip.x + (tip.x > tip.w - 150 ? -12 : 12),
                                top: tip.y + 10,
                                transform: tip.x > tip.w - 150 ? 'translateX(-100%)' : undefined,
                            }}
                        >
                            <div>Cursor: {tipText(tip.freq, tip.db)}</div>
                            <div>Peak: {tipText(tip.peakFreq, tip.peakDb)}</div>
                        </div>
                    )}
                </div>
            )}

            {showScope && (
                <Field label="Timebase" hint={`${timebase} ms`}>
                    <Slider value={timebase} min={2} max={200} step={1} onChange={setTimebase} />
                </Field>
            )}

            {showWf && (
                <Field label="Contrast" hint={contrast.toFixed(2)}>
                    <Slider value={contrast} min={0.4} max={2.5} step={0.05} onChange={setContrast} />
                </Field>
            )}

            {showWf && (
                <Field label="Resolution" hint={rate ? `${Math.round(rate / fftSize)} Hz/bin` : ''}>
                    <Segmented
                        options={FFT_SIZES.map((f) => ({ value: String(f.value), label: f.label }))}
                        value={String(fftSize)}
                        onChange={(v) => setFftSize(Number(v))}
                        size="sm"
                    />
                </Field>
            )}

            <div className="note note--tight">
                {!running
                    ? 'Start the receiver to see audio.'
                    : `${fmtHz(bins.startFreq)}–${fmtHz(bins.endFreq)} Hz of ${fmtHz((rate || 48000) / 2)} Hz available`}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function sized(canvas, cssH) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }
    return { w, h, dpr };
}

function css(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
}

function drawScope(canvas, analyser, wave, sampleRate, timebaseMs, state) {
    if (!canvas) return;
    if (wave.length !== analyser.fftSize) return;      // resized between frames
    analyser.getByteTimeDomainData(wave);

    const { w, h, dpr } = sized(canvas, canvas.clientHeight || 96);
    const c = canvas.getContext('2d');
    c.fillStyle = css('--spec-bg', '#0a0e15');
    c.fillRect(0, 0, w, h);

    // Grid: a line every 25% vertically, and one per millisecond-ish column.
    c.strokeStyle = css('--spec-grid', 'rgba(255,255,255,0.06)');
    c.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
        const y = Math.round((h * i) / 4) + 0.5;
        c.beginPath();
        c.moveTo(0, y);
        c.lineTo(w, y);
        c.stroke();
    }
    for (let i = 1; i < 8; i++) {
        const x = Math.round((w * i) / 8) + 0.5;
        c.beginPath();
        c.moveTo(x, 0);
        c.lineTo(x, h);
        c.stroke();
    }

    // How many samples the requested timebase covers, capped by what the
    // analyser holds.
    const want = Math.max(16, Math.round((timebaseMs / 1000) * sampleRate));
    const n = Math.min(wave.length, want);
    const first = wave.length - n;

    // Rising-edge trigger near the mid-line, so a periodic signal stands still
    // instead of sliding across the screen — v1's "auto sync".
    let start = first;
    for (let i = first; i < wave.length - 1 && i < first + n / 2; i++) {
        if (wave[i] < 128 && wave[i + 1] >= 128) { start = i; break; }
    }
    const count = Math.min(n, wave.length - start);

    // Auto-scale: fit the peak in this window to 90% of the height, but never
    // amplify a silent line — with the gate closed the only thing left is +/-1
    // LSB of quantisation noise, and full-scaling that looks like a fault.
    // The gain is eased so the trace settles rather than snapping.
    let peak = 0;
    for (let i = start; i < start + count; i++) {
        const d = Math.abs(wave[i] - 128);
        if (d > peak) peak = d;
    }
    // Flat line rather than magnified dither: a closed gate is silence, and
    // drawing it as a jagged full-height trace reads as a broken receiver.
    if (peak <= SCOPE_SILENT_LSB) {
        c.strokeStyle = css('--text-faint', '#5c6779');
        c.lineWidth = 1.4 * dpr;
        c.beginPath();
        c.moveTo(0, h / 2);
        c.lineTo(w, h / 2);
        c.stroke();
        state.gain = 0;
        return;
    }

    const usable = Math.max(peak / 128, SCOPE_MIN_PEAK) * 128;
    const target = (h / 2) * 0.9 / usable;
    state.gain = state.gain > 0 ? state.gain + (target - state.gain) * 0.15 : target;
    const gain = state.gain;

    c.beginPath();
    for (let i = 0; i < count; i++) {
        const x = (i / (count - 1)) * w;
        const y = h / 2 - (wave[start + i] - 128) * gain;
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.strokeStyle = css('--accent', '#3ddbe8');
    c.lineWidth = 1.4 * dpr;
    c.stroke();
}

function drawWaterfall(canvas, ring, analyser, bins, sampleRate, tuning, palette, contrast, level) {
    if (!canvas) return;
    if (bins.length !== analyser.frequencyBinCount) return;
    analyser.getFloatFrequencyData(bins);

    const { w, h } = sized(canvas, canvas.clientHeight || 120);

    if (!ring.canvas || ring.w !== w || ring.h !== h) {
        const off = document.createElement('canvas');
        off.width = w;
        off.height = h;
        const octx = off.getContext('2d', { alpha: false });
        octx.fillStyle = '#05070c';
        octx.fillRect(0, 0, w, h);
        ring.canvas = off;
        ring.ctx = octx;
        ring.w = w;
        ring.h = h;
        ring.head = 0;
    }

    const { start, count } = audioBins(
        tuning.bandwidthLow, tuning.bandwidthHigh, sampleRate, analyser.frequencyBinCount,
    );

    // Auto level, eased, so a loud signal does not wash the whole panel out.
    let min = Infinity;
    let max = -Infinity;
    for (let i = start; i < start + count; i++) {
        const v = bins[i];
        if (!Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
    }
    if (Number.isFinite(min)) {
        // Bounded: silence sits far below WF_FLOOR_DB and simply maps to the
        // bottom of the palette instead of being stretched across all of it.
        const targetFloor = Math.max(WF_FLOOR_DB, min - 3);
        const targetCeil = Math.max(targetFloor + WF_MIN_SPAN_DB, max + 5);
        level.floor += (targetFloor - level.floor) * 0.05;
        level.ceil += (targetCeil - level.ceil) * 0.05;
    }
    const range = Math.max(WF_MIN_SPAN_DB, level.ceil - level.floor);

    const now = performance.now();
    if (now - ring.at >= ROW_MS) {
        ring.at = now;
        const lut = getPalette(palette);
        const img = ring.ctx.createImageData(w, 1);
        const data = img.data;
        for (let x = 0; x < w; x++) {
            // Nearest bin for this column, taking the max over the span so a
            // narrow tone survives being squeezed into a panel-width canvas.
            const lo = start + Math.floor((x / w) * count);
            const hi = Math.max(lo + 1, start + Math.floor(((x + 1) / w) * count));
            let v = -Infinity;
            for (let i = lo; i < hi; i++) if (bins[i] > v) v = bins[i];
            let t = (v - level.floor) / range;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            // Same gamma the RF waterfall uses: above 1 lifts weak signals out
            // of the noise, below 1 pushes them back down.
            if (contrast !== 1) t = Math.pow(t, 1 / contrast);
            const idx = (t * 255) | 0;
            const o = x * 4;
            data[o] = lut[idx * 3];
            data[o + 1] = lut[idx * 3 + 1];
            data[o + 2] = lut[idx * 3 + 2];
            data[o + 3] = 255;
        }
        ring.head = (ring.head - 1 + h) % h;
        ring.ctx.putImageData(img, 0, ring.head);
    }

    const c = canvas.getContext('2d', { alpha: false });
    c.imageSmoothingEnabled = false;
    const firstH = Math.min(h - ring.head, h);
    c.drawImage(ring.canvas, 0, ring.head, w, firstH, 0, 0, w, firstH);
    if (firstH < h) c.drawImage(ring.canvas, 0, 0, w, h - firstH, 0, firstH, w, h - firstH);
}

function drawRuler(canvas, tuning, sampleRate, binCount) {
    if (!canvas) return;
    const { w, h, dpr } = sized(canvas, canvas.clientHeight || 13);
    const c = canvas.getContext('2d');
    c.fillStyle = css('--scale-bg', '#0d121b');
    c.fillRect(0, 0, w, h);

    const { startFreq, endFreq } = audioBins(tuning.bandwidthLow, tuning.bandwidthHigh, sampleRate, binCount);
    const span = endFreq - startFreq;
    if (!(span > 0)) return;

    const step = span > 4000 ? 1000 : span > 1500 ? 500 : span > 600 ? 200 : 100;
    c.font = `${8.5 * dpr}px ui-monospace, monospace`;
    c.textBaseline = 'middle';
    c.textAlign = 'center';
    for (let f = Math.ceil(startFreq / step) * step; f <= endFreq; f += step) {
        const x = ((f - startFreq) / span) * w;
        c.strokeStyle = css('--scale-tick', 'rgba(255,255,255,0.16)');
        c.beginPath();
        c.moveTo(Math.round(x) + 0.5, 0);
        c.lineTo(Math.round(x) + 0.5, 3 * dpr);
        c.stroke();
        c.fillStyle = css('--scale-text', '#8b96a9');
        c.fillText(fmtHz(f), x, h * 0.62);
    }
}

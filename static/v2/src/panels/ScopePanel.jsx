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
import { audioBins } from '../lib/audioBand.js';
import { subscribeAudioSpectrum } from '../lib/audioSpectrum.js';
import { cssVar, drawAudioRuler, drawAudioWaterfall, fmtHz, newRing, sizedCanvas } from '../lib/audioWaterfall.js';

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
// Silence guards. With the squelch closed the server sends nothing, or sends
// dither a hundred dB down, and an unbounded auto-scale turns that into a
// full-height mess of quantisation noise and a boiling waterfall. Both views
// therefore refuse to magnify beyond a point, and fall back to a flat line and
// a dark waterfall — which is what "no audio" should look like.
const SCOPE_MIN_PEAK = 0.05;   // fraction of full scale; below this, no extra gain
const SCOPE_SILENT_LSB = 2;    // +/-2/128 or less is the gate closed, not a signal

// `minimal` keeps the view switch and the two canvases and drops the settings
// under them — timebase, contrast, resolution — and the bandwidth line. The
// settings still apply; they are just not on show. See the registry's `minimal`.
export default function ScopePanel({ minimal }) {
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
    const ring = useRef(newRing());
    // Latest FFT frame plus the window it covers, so the hover readout can be
    // answered from the pointer handler without running its own analysis.
    const last = useRef(null);
    const hover = useRef(null);      // pointer position while over the waterfall
    const tipAt = useRef(0);
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
        // One shared FFT: the filter panel's preview reads the same node, and
        // whichever of them is open drives it (see lib/audioSpectrum.js).
        return subscribeAudioSpectrum(player, { fftSize, bins: showWf, wave: showScope }, (f) => {
            if (f.sampleRate !== rate) setRate(f.sampleRate);
            if (showScope) drawScope(scopeRef.current, f.wave, f.sampleRate, timebase, scope.current);
            if (showWf) {
                last.current = { bins: f.bins, sampleRate: f.sampleRate, binCount: f.binCount, tuning };
                refreshTip(hover.current, last.current, tipAt, setTip);
                drawAudioWaterfall({
                    canvas: wfRef.current,
                    ring: ring.current,
                    bins: f.bins,
                    binCount: f.binCount,
                    sampleRate: f.sampleRate,
                    tuning,
                    palette: display.palette,
                    contrast,
                });
                drawAudioRuler(rulerRef.current, tuning, f.sampleRate, f.binCount);
            }
        });
    }, [player, fftSize, showScope, showWf, timebase, tuning, display.palette, contrast, rate]);

    const bins = audioBins(tuning.bandwidthLow, tuning.bandwidthHigh, rate || 48000, 1024);

    // Cursor and peak, the two lines v1 shows over its audio spectrum and
    // waterfall (app.js updateAudioSpectrumTooltip). The pointer position is
    // only stored here — the numbers are refreshed from the draw loop, so they
    // track the audio while the mouse sits still.
    const onHover = (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        hover.current = { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width };
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
                        onPointerLeave={() => { hover.current = null; setTip(null); }}
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

            {!minimal && showScope && (
                <Field label="Timebase" hint={`${timebase} ms`}>
                    <Slider value={timebase} min={2} max={200} step={1} onChange={setTimebase} />
                </Field>
            )}

            {!minimal && showWf && (
                <Field label="Contrast" hint={contrast.toFixed(2)}>
                    <Slider value={contrast} min={0.4} max={2.5} step={0.05} onChange={setContrast} />
                </Field>
            )}

            {!minimal && showWf && (
                <Field label="Resolution" hint={rate ? `${Math.round(rate / fftSize)} Hz/bin` : ''}>
                    <Segmented
                        options={FFT_SIZES.map((f) => ({ value: String(f.value), label: f.label }))}
                        value={String(fftSize)}
                        onChange={(v) => setFftSize(Number(v))}
                        size="sm"
                    />
                </Field>
            )}

            {/* The bandwidth line goes with the settings, but "start the
                receiver" stays either way: without it two blank canvases are
                the only thing a stopped receiver shows here. */}
            {(!minimal || !running) && (
                <div className="note note--tight">
                    {!running
                        ? 'Start the receiver to see audio.'
                        : `${fmtHz(bins.startFreq)}–${fmtHz(bins.endFreq)} Hz of ${fmtHz((rate || 48000) / 2)} Hz available`}
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

// A few times a second, not per frame: the numbers must follow the audio while
// the pointer is still, but a two-line label does not need 60 Hz of React.
const TIP_MS = 150;

function refreshTip(at, l, tipAt, setTip) {
    if (!at || !l) return;
    const now = performance.now();
    if (now - tipAt.current < TIP_MS) return;
    tipAt.current = now;

    const { start, count, startFreq, endFreq } = audioBins(
        l.tuning.bandwidthLow, l.tuning.bandwidthHigh, l.sampleRate, l.binCount,
    );
    if (!count) return;

    const frac = Math.max(0, Math.min(1, at.x / at.w));
    const cursor = start + Math.min(count - 1, Math.floor(frac * count));
    let peak = start;
    for (let i = start; i < start + count; i++) if (l.bins[i] > l.bins[peak]) peak = i;

    const freqOf = (bin) => startFreq + ((bin - start) / count) * (endFreq - startFreq);
    setTip({
        x: at.x,
        y: at.y,
        w: at.w,
        freq: freqOf(cursor),
        db: l.bins[cursor],
        peakFreq: freqOf(peak),
        peakDb: l.bins[peak],
    });
}



function drawScope(canvas, wave, sampleRate, timebaseMs, state) {
    if (!canvas || !wave || !wave.length) return;
    const { w, h, dpr } = sizedCanvas(canvas);
    const c = canvas.getContext('2d');
    c.fillStyle = cssVar('--spec-bg', '#0a0e15');
    c.fillRect(0, 0, w, h);

    // Grid: a line every 25% vertically, and one per millisecond-ish column.
    c.strokeStyle = cssVar('--spec-grid', 'rgba(255,255,255,0.06)');
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
        c.strokeStyle = cssVar('--text-faint', '#5c6779');
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
    c.strokeStyle = cssVar('--accent', '#08a2fb');
    c.lineWidth = 1.4 * dpr;
    c.stroke();
}



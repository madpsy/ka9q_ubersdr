// Client-side audio filters: EQ, notches and a bandpass.
//
// These mirror v1's filter cards (static/filters.js) — same designs, same
// numbers, same presets — so a receiver sounds identical in both frontends.
// The parameter maths and the node building live in radio/audio-filters.js;
// this is the controls.

import React, { useEffect, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import { Button, Field, Icon, Segmented, Slider, Switch } from '../components/ui.jsx';
import { audioBins, audioWindow } from '../lib/audioBand.js';
import { subscribeAudioSpectrum } from '../lib/audioSpectrum.js';
import { cssVar, drawAudioRuler, drawAudioWaterfall, newRing } from '../lib/audioWaterfall.js';
import { bandLevels, bandWeights, meterFractions } from '../lib/eqLevels.js';
import {
    BP_WIDTH_MAX, BP_WIDTH_MIN, EQ_FREQUENCIES, EQ_GAIN_MAX, EQ_GAIN_MIN,
    FILTER_DEFAULTS, MAX_NOTCHES, bandpassRange, detectPreset, presetGains,
} from '../radio/audio-filters.js';

const PRESETS = [
    { value: 'flat', label: 'Flat' },
    { value: 'voice', label: 'Voice' },
    { value: 'cw', label: 'CW' },
    { value: 'music', label: 'Music' },
];

// v1 paints its EQ faders with a cut-to-boost ramp — red at full cut through
// amber at flat to green at full boost (style.css .eq-slider). Horizontal here,
// so the same ramp runs left to right, and each band is additionally tinted
// towards its own frequency: low bands warm, high bands cool, which makes a
// column of twelve identical rows readable at a glance.
const EQ_CUT = '#e74c3c';
const EQ_FLAT = '#f39c12';
const EQ_BOOST = '#2ecc71';

function bandTrack(i, total) {
    // 0 at 60 Hz to 1 at 8 kHz, used only to shift how saturated the ramp is,
    // so the cut/boost meaning still reads the same on every row.
    const t = total > 1 ? i / (total - 1) : 0;
    const alpha = (0.55 + 0.45 * (1 - t)).toFixed(2);
    const mix = (hex) => `color-mix(in srgb, ${hex} ${Math.round(alpha * 100)}%, var(--surface-3))`;
    return `linear-gradient(90deg, ${mix(EQ_CUT)} 0%, ${mix(EQ_FLAT)} 50%, ${mix(EQ_BOOST)} 100%)`;
}

// Meter refresh. Fast enough to feel live, slow enough that twelve bars are not
// twelve React renders a frame.
const METER_MS = 80;
const EQ_Q = 1.0;               // the Q the EQ's peaking filters are built with

const PREVIEW_H = 84;
const PREVIEW_FFT = 4096;

// Where each filter sits, for the preview's marker lines: the centre solid,
// the edges dashed and dimmer, so a notch reads as "here, this wide" at a
// glance rather than needing the numbers.
function filterMarks(notch, bandpass) {
    const marks = [];
    const notchColor = cssVar('--bad', '#f2646a');
    const bpColor = cssVar('--good', '#45d69a');

    if (notch.enabled) {
        notch.items.forEach((n, i) => {
            // Numbered to match the list below, so "notch 2" is one glance.
            marks.push({ hz: n.center, color: notchColor, label: String(i + 1) });
            marks.push({ hz: n.center - n.width / 2, color: notchColor, soft: true });
            marks.push({ hz: n.center + n.width / 2, color: notchColor, soft: true });
        });
    }
    if (bandpass.enabled) {
        marks.push({ hz: bandpass.center, color: bpColor, label: 'BPF' });
        marks.push({ hz: bandpass.center - bandpass.width / 2, color: bpColor, soft: true });
        marks.push({ hz: bandpass.center + bandpass.width / 2, color: bpColor, soft: true });
    }
    return marks;
}

// The audio waterfall, with the active filters drawn over it. Shown only when
// a notch or the bandpass is on: it exists to show you where they are sitting,
// and it shares the audio scope's FFT rather than starting a second one.
function Preview({ notch, bandpass, onBandpass, range }) {
    const { player, tuning } = useRadio();
    const display = useDisplay();
    const wfRef = useRef(null);
    const rulerRef = useRef(null);
    const ring = useRef(newRing());
    const marks = useRef([]);
    marks.current = filterMarks(notch, bandpass);

    // The window the canvas currently spans, so pointer x can be turned into
    // audio Hz. Written by the draw callback, read by the drag handlers.
    const frame = useRef(null);
    const drag = useRef(null);
    const [grab, setGrab] = useState(false);

    // Which bandpass line is under the pointer, if any. Edges are what you
    // reach for to set the width, the centre to move the whole filter.
    const hitTest = (clientX, el) => {
        const f = frame.current;
        if (!f || !bandpass.enabled) return null;
        const r = el.getBoundingClientRect();
        const { startFreq, endFreq } = f;
        if (!(endFreq > startFreq)) return null;
        const xOf = (hz) => ((hz - startFreq) / (endFreq - startFreq)) * r.width;
        const x = clientX - r.left;
        const targets = [
            { what: 'low', x: xOf(bandpass.center - bandpass.width / 2) },
            { what: 'high', x: xOf(bandpass.center + bandpass.width / 2) },
            { what: 'center', x: xOf(bandpass.center) },
        ];
        let best = null;
        for (const t of targets) {
            const d = Math.abs(t.x - x);
            if (d <= 7 && (!best || d < best.d)) best = { what: t.what, d };
        }
        return best ? best.what : null;
    };

    const hzAt = (clientX, el) => {
        const f = frame.current;
        const r = el.getBoundingClientRect();
        const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
        return f.startFreq + frac * (f.endFreq - f.startFreq);
    };

    const onDown = (e) => {
        const what = hitTest(e.clientX, e.currentTarget);
        if (!what) return;
        e.preventDefault();
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        drag.current = { what };
    };

    const onMove = (e) => {
        const el = e.currentTarget;
        if (!drag.current) {
            setGrab(!!hitTest(e.clientX, el));
            return;
        }
        const hz = hzAt(e.clientX, el);
        if (drag.current.what === 'center') {
            onBandpass({ center: Math.round(Math.max(range.min, Math.min(range.max, hz)) / 10) * 10 });
        } else {
            // Either edge sets the width symmetrically about the centre, which
            // is what the filter actually is — there is one centre and one Q.
            const width = Math.round(Math.abs(hz - bandpass.center) * 2 / 10) * 10;
            onBandpass({ width: Math.max(BP_WIDTH_MIN, Math.min(BP_WIDTH_MAX, width)) });
        }
    };

    const onUp = (e) => {
        drag.current = null;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    };

    useEffect(() => subscribeAudioSpectrum(player, { fftSize: PREVIEW_FFT, bins: true }, (f) => {
        const win = audioBins(tuning.bandwidthLow, tuning.bandwidthHigh, f.sampleRate, f.binCount);
        frame.current = { startFreq: win.startFreq, endFreq: win.endFreq };
        drawAudioWaterfall({
            canvas: wfRef.current,
            ring: ring.current,
            bins: f.bins,
            binCount: f.binCount,
            sampleRate: f.sampleRate,
            tuning,
            palette: display.palette,
            contrast: display.scopeContrast || 1,
            marks: marks.current,
        });
        drawAudioRuler(rulerRef.current, tuning, f.sampleRate, f.binCount);
    }), [player, tuning, display.palette, display.scopeContrast]);

    return (
        <div className="scope">
            <canvas
                ref={wfRef}
                className={`scope__canvas${bandpass.enabled ? ' is-draggable' : ''}${grab ? ' is-grabbing' : ''}`}
                style={{ height: PREVIEW_H }}
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onUp}
                onPointerLeave={() => setGrab(false)}
            />
            <canvas ref={rulerRef} className="scope__canvas scope__ruler" style={{ height: 13 }} />
            {bandpass.enabled && (
                <div className="scope__hint">Drag the green lines to move the bandpass or set its width</div>
            )}
        </div>
    );
}

// Live level per band, weighted by each band's own filter response — see
// lib/eqLevels.js. Runs whenever the EQ tab is open, on the shared FFT, so it
// costs nothing extra when the scope or the filter preview is already up.
function useBandLevels(active) {
    const { player } = useRadio();
    const [levels, setLevels] = useState(null);
    const state = useRef({ ceil: -40 });
    const at = useRef(0);
    const buf = useRef(null);

    useEffect(() => {
        if (!active) return undefined;
        return subscribeAudioSpectrum(player, { fftSize: PREVIEW_FFT, bins: true }, (f) => {
            const now = performance.now();
            if (now - at.current < METER_MS) return;
            at.current = now;
            const weights = bandWeights(EQ_FREQUENCIES, EQ_Q, f.sampleRate, f.binCount);
            buf.current = bandLevels(f.bins, weights, buf.current);
            setLevels(meterFractions(buf.current, state.current));
        });
    }, [player, active]);

    return levels;
}

const fmtGain = (g) => `${g > 0 ? '+' : ''}${g.toFixed(1)}`;
const fmtBand = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));

function Section({ title, enabled, onToggle, children, extra }) {
    return (
        <>
            <div className="section-label">
                <span>{title}</span>
                {extra}
            </div>
            <Field label={enabled ? 'On' : 'Off'} inline>
                <Switch checked={enabled} onChange={onToggle} />
            </Field>
            {enabled && children}
        </>
    );
}

export default function AudioFiltersPanel() {
    const { filters, actions, tuning } = useRadio();
    const [tab, setTab] = useState('eq');
    const levels = useBandLevels(tab === 'eq');

    const eq = filters.eq;
    const notch = filters.notch;
    const bp = filters.bandpass;
    const preset = detectPreset(eq.gains) || 'flat';

    // The bandpass can only sit inside the audio this mode carries, which is
    // what v1 recomputes whenever the passband changes.
    const range = bandpassRange(audioWindow(tuning.bandwidthLow, tuning.bandwidthHigh));
    const centre = Math.min(range.max, Math.max(range.min, bp.center));

    const setEq = (patch) => actions.setFilters({ eq: { ...eq, ...patch } });
    const setNotch = (patch) => actions.setFilters({ notch: { ...notch, ...patch } });
    const setBp = (patch) => actions.setFilters({ bandpass: { ...bp, ...patch } });

    const setBand = (i, value) => {
        const gains = eq.gains.slice();
        gains[i] = value;
        setEq({ gains });
    };

    const applyPreset = (name) => {
        if (name === 'flat') {
            setEq({ enabled: true, gains: EQ_FREQUENCIES.map(() => 0), makeup: 0 });
            return;
        }
        const p = presetGains(name);
        if (p) setEq({ enabled: true, ...p });
    };

    const addNotch = () => {
        if (notch.items.length >= MAX_NOTCHES) return;
        // v1 drops a new notch in the middle of the passband.
        const w = audioWindow(tuning.bandwidthLow, tuning.bandwidthHigh);
        const center = Math.round((w.startFreq + w.endFreq) / 2);
        setNotch({ enabled: true, items: notch.items.concat({ center, width: 50 }) });
    };

    const setNotchAt = (i, patch) => {
        const items = notch.items.slice();
        items[i] = { ...items[i], ...patch };
        setNotch({ items });
    };

    const showPreview = (notch.enabled && notch.items.length > 0) || bp.enabled;

    return (
        <div className="stack">
            {showPreview && (
                <Preview notch={notch} bandpass={{ ...bp, center: centre }} onBandpass={setBp} range={range} />
            )}

            <Segmented
                options={[
                    { value: 'eq', label: 'EQ' },
                    { value: 'notch', label: `Notch${notch.items.length ? ` ${notch.items.length}` : ''}` },
                    { value: 'bandpass', label: 'Bandpass' },
                ]}
                value={tab}
                onChange={setTab}
                size="sm"
            />

            {tab === 'eq' && (
                <Section
                    title="Equaliser"
                    enabled={eq.enabled}
                    onToggle={(v) => setEq({ enabled: v })}
                    extra={<span className="section-label__note">{preset}</span>}
                >
                    <Segmented options={PRESETS} value={preset} onChange={applyPreset} size="sm" />

                    {/* Twelve bands, 60 Hz to 8 kHz, ±12 dB — v1's set. */}
                    <div className="eqbands">
                        {EQ_FREQUENCIES.map((freq, i) => (
                            <div className="eqband" key={freq}>
                                <span className="eqband__hz">{fmtBand(freq)}</span>
                                {/* The track doubles as this band's level
                                    meter — see the `level` prop. */}
                                <Slider
                                    value={eq.gains[i] || 0}
                                    min={EQ_GAIN_MIN}
                                    max={EQ_GAIN_MAX}
                                    step={0.5}
                                    track={bandTrack(i, EQ_FREQUENCIES.length)}
                                    level={(levels && levels[i]) || 0}
                                    onChange={(v) => setBand(i, v)}
                                />
                                <span className="eqband__db">{fmtGain(eq.gains[i] || 0)}</span>
                            </div>
                        ))}
                    </div>

                    <Field label="Makeup gain" hint={`${fmtGain(eq.makeup || 0)} dB`}>
                        <Slider
                            value={eq.makeup || 0}
                            min={EQ_GAIN_MIN}
                            max={EQ_GAIN_MAX}
                            step={0.5}
                            onChange={(v) => setEq({ makeup: v })}
                        />
                    </Field>

                    <div className="row-end">
                        <Button size="sm" variant="ghost" onClick={() => applyPreset('flat')}>Reset</Button>
                    </div>
                </Section>
            )}

            {tab === 'notch' && (
                <Section
                    title="Notch filters"
                    enabled={notch.enabled}
                    onToggle={(v) => setNotch({ enabled: v })}
                    extra={<span className="section-label__note">{notch.items.length}/{MAX_NOTCHES}</span>}
                >
                    {notch.items.length === 0 && (
                        <div className="note note--tight">
                            Add a notch to pull down a carrier or a heterodyne.
                        </div>
                    )}

                    {notch.items.map((n, i) => (
                        <div className="notch" key={i}>
                            <div className="notch__head">
                                <span className="notch__name">Notch {i + 1}</span>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    icon={<Icon.Close size={12} />}
                                    title="Remove"
                                    onClick={() => setNotch({ items: notch.items.filter((_, k) => k !== i) })}
                                />
                            </div>
                            <Field label="Centre" hint={`${Math.round(n.center)} Hz`}>
                                <Slider
                                    value={n.center}
                                    min={range.min}
                                    max={range.max}
                                    step={5}
                                    onChange={(v) => setNotchAt(i, { center: v })}
                                />
                            </Field>
                            <Field label="Width" hint={`${n.width} Hz`}>
                                <Slider
                                    value={n.width}
                                    min={10}
                                    max={500}
                                    step={5}
                                    onChange={(v) => setNotchAt(i, { width: v })}
                                />
                            </Field>
                        </div>
                    ))}

                    <div className="row-end">
                        <Button
                            size="sm"
                            variant="primary"
                            icon={<Icon.Plus size={13} />}
                            disabled={notch.items.length >= MAX_NOTCHES}
                            onClick={addNotch}
                        >
                            Add notch
                        </Button>
                    </div>
                </Section>
            )}

            {tab === 'bandpass' && (
                <Section
                    title="Bandpass"
                    enabled={bp.enabled}
                    onToggle={(v) => setBp({ enabled: v })}
                >
                    <Field label="Centre" hint={`${centre} Hz`}>
                        <Slider
                            value={centre}
                            min={range.min}
                            max={range.max}
                            step={10}
                            onChange={(v) => setBp({ center: v })}
                        />
                    </Field>
                    <Field label="Width" hint={`${bp.width} Hz`}>
                        <Slider
                            value={bp.width}
                            min={BP_WIDTH_MIN}
                            max={BP_WIDTH_MAX}
                            step={10}
                            onChange={(v) => setBp({ width: v })}
                        />
                    </Field>
                    <Field label="Stages" hint={`${bp.stages} (${bp.stages * 12} dB/oct)`}>
                        <Slider value={bp.stages} min={1} max={6} step={1} onChange={(v) => setBp({ stages: v })} />
                    </Field>
                    <Field label="Auto Q" inline>
                        <Switch checked={bp.autoQ} onChange={(v) => setBp({ autoQ: v })} />
                    </Field>
                    {!bp.autoQ && (
                        <Field label="Q multiplier" hint={`${bp.qMultiplier.toFixed(1)}×`}>
                            <Slider
                                value={bp.qMultiplier}
                                min={0.1}
                                max={5}
                                step={0.1}
                                onChange={(v) => setBp({ qMultiplier: v })}
                            />
                        </Field>
                    )}
                    <div className="row-end">
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setBp({ ...FILTER_DEFAULTS.bandpass, enabled: bp.enabled })}
                        >
                            Reset
                        </Button>
                    </div>
                </Section>
            )}
        </div>
    );
}

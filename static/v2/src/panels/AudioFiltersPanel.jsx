// Client-side audio filters: EQ, notches and a bandpass.
//
// These mirror v1's filter cards (static/filters.js) — same designs, same
// numbers, same presets — so a receiver sounds identical in both frontends.
// The parameter maths and the node building live in radio/audio-filters.js;
// this is the controls.

import React, { useEffect, useRef, useState } from '../react.js';
import { useMeters, useRadio } from '../radio/RadioContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import { Button, Empty, Field, Icon, Segmented, Slider, Switch } from '../components/ui.jsx';
import { isIQ } from '../radio/constants.js';
import { audioBins, audioWindow } from '../lib/audioBand.js';
import { subscribeAudioSpectrum } from '../lib/audioSpectrum.js';
import { cssVar, drawAudioRuler, drawAudioWaterfall, newRing } from '../lib/audioWaterfall.js';
import { bandLevels, bandWeights, meterFractions } from '../lib/eqLevels.js';
import {
    BP_WIDTH_MAX, BP_WIDTH_MIN, COMP_LIMITS, EQ_FREQUENCIES, EQ_GAIN_MAX, EQ_GAIN_MIN,
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

// What the preview can be told to do right now, in words.
//
// Built from the same three facts the handlers use, so the line under the
// canvas cannot promise something the canvas will not do — a hint that offers a
// tap where a tap is ambiguous is worse than no hint at all.
function previewHint(notch, bandpass, tap) {
    const parts = [];
    if (tap === 'bp') parts.push('tap to move the bandpass centre');
    if (tap === 'notch') parts.push('tap to move notch 1');
    if (bandpass.enabled) parts.push('drag the green lines for the bandpass and its width');
    if (notch.enabled && notch.items.length > 0) {
        parts.push(notch.items.length > 1
            ? 'drag line 1 for notch 1 — the rest have sliders'
            : 'drag line 1 for the notch');
    }
    if (!parts.length) return '';
    // Capitalised as a sentence, however it was assembled.
    const text = parts.join(', or ');
    return text.charAt(0).toUpperCase() + text.slice(1);
}

// The audio waterfall, with the active filters drawn over it. Shown only when
// a notch or the bandpass is on: it exists to show you where they are sitting,
// and it shares the audio scope's FFT rather than starting a second one.
function Preview({ notch, bandpass, onBandpass, onNotch, range, tab }) {
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

    // How near a line counts as being on it.
    //
    // Seven pixels is a fair answer for a pointer whose tip is one pixel and
    // which the operator can see. It is the wrong answer for a finger: a
    // fingertip covers something like forty pixels of glass, the point it
    // reports is somewhere under the middle of that, and the line is hidden
    // while it is being touched. Seven pixels made this a control that
    // apparently did nothing on a phone — every press missed, and a miss looks
    // exactly like a control nobody wired up.
    //
    // Twenty is what the spectrum's own filter edges give a finger, for the
    // same reason (TOUCH_EDGE_MIN_PX there).
    const GRAB_PX = 7;
    const TOUCH_GRAB_PX = 20;

    // Which filter line is under the pointer, if any. Edges are what you reach
    // for to set a width, a centre to move the whole filter.
    //
    // The bandpass offers all three of its lines because there is only ever one
    // bandpass — a line here can only mean one thing. Notches offer the first
    // one's centre and no more, which is a deliberate limit rather than an
    // unfinished job: with four notches on a narrow preview their marks sit
    // within a few pixels of each other, and a finger-sized grab zone over that
    // is a guess. Guessing wrong moves the wrong filter, which is worse than
    // not moving one — the others have their sliders, where there is no doubt
    // about which is which.
    const hitTest = (clientX, el, touch) => {
        const f = frame.current;
        if (!f) return null;
        const r = el.getBoundingClientRect();
        const { startFreq, endFreq } = f;
        if (!(endFreq > startFreq)) return null;
        const xOf = (hz) => ((hz - startFreq) / (endFreq - startFreq)) * r.width;
        const x = clientX - r.left;
        const targets = [];
        if (bandpass.enabled) {
            targets.push({ what: 'low', x: xOf(bandpass.center - bandpass.width / 2) });
            targets.push({ what: 'high', x: xOf(bandpass.center + bandpass.width / 2) });
            targets.push({ what: 'center', x: xOf(bandpass.center) });
        }
        if (notch.enabled && notch.items.length > 0) {
            targets.push({ what: 'notch', x: xOf(notch.items[0].center) });
        }
        const near = touch ? TOUCH_GRAB_PX : GRAB_PX;
        let best = null;
        for (const t of targets) {
            const d = Math.abs(t.x - x);
            if (d <= near && (!best || d < best.d)) best = { what: t.what, d };
        }
        return best ? best.what : null;
    };

    const hzAt = (clientX, el) => {
        const f = frame.current;
        const r = el.getBoundingClientRect();
        const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
        return f.startFreq + frac * (f.endFreq - f.startFreq);
    };

    // Where a plain tap sends a centre.
    //
    // A press that grabs nothing still means something: "put it here" is the
    // obvious reading of pressing a waterfall with a filter drawn on it, and it
    // is the only reading available on a phone, where lining a fingertip up
    // with a line you cannot see while you touch it is a poor way to spend
    // somebody's afternoon.
    //
    // Which filter it means is decided by the tab, not by proximity. The
    // preview sits directly above the tabs, so what is open under it is what
    // the operator is working on — and where that says nothing (the EQ tab,
    // say), a tap acts only when there is exactly one filter it could mean.
    // Two enabled and no tab to break the tie is a guess, and a guess moves the
    // wrong filter.
    const tapTarget = () => {
        const bpOn = bandpass.enabled;
        const notchOn = notch.enabled && notch.items.length > 0;
        if (tab === 'bandpass' && bpOn) return 'bp';
        if (tab === 'notch' && notchOn) return 'notch';
        if (bpOn && !notchOn) return 'bp';
        if (notchOn && !bpOn) return 'notch';
        return null;
    };

    const onDown = (e) => {
        const touch = e.pointerType !== 'mouse';
        const what = hitTest(e.clientX, e.currentTarget, touch);
        // A press that grabbed nothing is still followed: it becomes a tap on
        // release, unless it turns into a drag first.
        if (!what && !tapTarget()) return;
        e.preventDefault();
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        drag.current = { what, startX: e.clientX, moved: false };
    };

    const onMove = (e) => {
        const el = e.currentTarget;
        if (!drag.current) {
            // Only a pointer that hovers gets the grab cursor. A finger arriving
            // here is already pressing, and there is no cursor to change.
            if (e.pointerType === 'mouse') setGrab(!!hitTest(e.clientX, el, false));
            return;
        }
        // Slop before a press counts as a drag, so a tap that wanders a pixel
        // is still a tap. A press that grabbed no line moves nothing while it
        // is down whatever it does — it is a tap or it is nothing.
        if (Math.abs(e.clientX - drag.current.startX) > 3) drag.current.moved = true;
        if (!drag.current.what) return;

        const hz = hzAt(e.clientX, el);
        if (drag.current.what === 'notch') {
            onNotch(0, { center: Math.round(Math.max(range.min, Math.min(range.max, hz)) / 10) * 10 });
            return;
        }
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
        const d = drag.current;
        drag.current = null;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        // A tap: pressed and let go without dragging, and without having taken
        // hold of a line. Grabbing a line and letting go without moving is not
        // a tap — it is a drag that changed nothing, and it must not then jump
        // the filter to wherever the finger was resting.
        if (!d || d.moved || d.what) return;
        const target = tapTarget();
        if (!target) return;
        const hz = Math.max(range.min, Math.min(range.max, hzAt(e.clientX, e.currentTarget)));
        const centre = Math.round(hz / 10) * 10;
        if (target === 'bp') onBandpass({ center: centre });
        else onNotch(0, { center: centre });
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
                // `is-draggable` is what turns the browser's own touch gestures
                // off over this canvas (touch-action: none in styles.css), so it
                // belongs on whenever there is something to drag. Keyed to the
                // bandpass alone, dragging notch 1 on a phone scrolled the dock
                // out from under the finger instead.
                className={`scope__canvas${bandpass.enabled || notch.items.length > 0 ? ' is-draggable' : ''}${grab ? ' is-grabbing' : ''}`}
                style={{ height: PREVIEW_H }}
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onUp}
                onPointerLeave={() => setGrab(false)}
            />
            <canvas ref={rulerRef} className="scope__canvas scope__ruler" style={{ height: 13 }} />
            {(bandpass.enabled || (notch.enabled && notch.items.length > 0)) && (
                // Says what the *next* press will do, which changes with the
                // tab: the tap has to name its target or it is a control you
                // find out about by moving the wrong filter.
                <div className="scope__hint">{previewHint(notch, bandpass, tapTarget())}</div>
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

// The live makeup gain when it is automatic — it follows the audio, so it has
// to be sampled rather than computed here.
function CompMakeup({ comp }) {
    const m = useMeters(6);
    const db = comp.autoMakeup ? (m.makeupDb || 0) : comp.makeup;
    return <span className="section-label__note">+{db.toFixed(1)} dB</span>;
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
    const gate = filters.gate;
    const comp = filters.compressor;
    const stereo = filters.stereo;
    // Flat is a preset like any other; anything else that matches no preset is
    // the user's own curve, so no button is lit and the label says so.
    const flat = eq.gains.every((g) => !g) && !eq.makeup;
    const preset = flat ? 'flat' : detectPreset(eq.gains);

    // The whole chain is wired out of the graph in IQ — see AudioPlayer.setIQ.
    // The stereo widener is the clearest reason why: it manufactures a stereo
    // pair from one signal, so on a genuine quadrature pair it would overwrite
    // Q outright. The rest are signal-dependent gain, which is no better.
    if (isIQ(tuning.mode)) {
        return (
            <Empty>
                Not available in IQ mode — the EQ, notches, bandpass, gate,
                compressor and widener are all bypassed so the quadrature pair
                passes through untouched. Your settings are kept.
            </Empty>
        );
    }

    // The bandpass can only sit inside the audio this mode carries, which is
    // what v1 recomputes whenever the passband changes.
    const range = bandpassRange(audioWindow(tuning.bandwidthLow, tuning.bandwidthHigh));
    const centre = Math.min(range.max, Math.max(range.min, bp.center));

    const setEq = (patch) => actions.setFilters({ eq: { ...eq, ...patch } });
    const setNotch = (patch) => actions.setFilters({ notch: { ...notch, ...patch } });
    const setBp = (patch) => actions.setFilters({ bandpass: { ...bp, ...patch } });
    const setGate = (patch) => actions.setFilters({ gate: { ...gate, ...patch } });
    const setComp = (patch) => actions.setFilters({ compressor: { ...comp, ...patch } });
    const setStereo = (patch) => actions.setFilters({ stereo: { ...stereo, ...patch } });

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
                <Preview
                    notch={notch}
                    bandpass={{ ...bp, center: centre }}
                    onBandpass={setBp}
                    onNotch={setNotchAt}
                    range={range}
                    tab={tab}
                />
            )}

            <Segmented
                options={[
                    { value: 'eq', label: 'EQ' },
                    { value: 'notch', label: `Notch${notch.items.length ? ` ${notch.items.length}` : ''}` },
                    { value: 'bandpass', label: 'BPF' },
                    { value: 'gate', label: 'Gate' },
                    { value: 'comp', label: 'Comp' },
                    { value: 'stereo', label: 'Wide' },
                ]}
                value={tab}
                onChange={setTab}
                size="sm"
                minItemWidth={64}
            />

            {tab === 'eq' && (
                <Section
                    title="Equaliser"
                    enabled={eq.enabled}
                    onToggle={(v) => setEq({ enabled: v })}
                    extra={<span className="section-label__note">{preset || 'custom'}</span>}
                >
                    {/* An empty value matches no option, so nothing is lit. */}
                    <Segmented options={PRESETS} value={preset || ''} onChange={applyPreset} size="sm" />

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

            {tab === 'gate' && (
                <Section title="Noise gate" enabled={gate.enabled} onToggle={(v) => setGate({ enabled: v })}>
                    <Field label="Threshold" hint={`${gate.threshold} dBFS`}>
                        <Slider
                            value={gate.threshold}
                            min={-80}
                            max={-10}
                            step={1}
                            onChange={(v) => setGate({ threshold: v })}
                        />
                    </Field>
                    <Field label="Depth" hint={gate.depth >= 60 ? 'silent' : `−${gate.depth} dB`}>
                        <Slider value={gate.depth} min={6} max={60} step={1} onChange={(v) => setGate({ depth: v })} />
                    </Field>
                    <Field label="Attack" hint={`${gate.attack} ms`}>
                        <Slider value={gate.attack} min={1} max={50} step={1} onChange={(v) => setGate({ attack: v })} />
                    </Field>
                    <Field label="Hold" hint={`${gate.hold} ms`}>
                        <Slider value={gate.hold} min={0} max={800} step={10} onChange={(v) => setGate({ hold: v })} />
                    </Field>
                    <Field label="Release" hint={`${gate.release} ms`}>
                        <Slider
                            value={gate.release}
                            min={20}
                            max={1500}
                            step={10}
                            onChange={(v) => setGate({ release: v })}
                        />
                    </Field>
                    <div className="note note--tight">
                        Ducks by the set depth rather than muting, which keeps the band
                        audible between words. The server squelch in the Audio panel is
                        the harder cut.
                    </div>
                    <div className="row-end">
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setGate({ ...FILTER_DEFAULTS.gate, enabled: gate.enabled })}
                        >
                            Reset
                        </Button>
                    </div>
                </Section>
            )}

            {tab === 'comp' && (
                <Section
                    title="Compressor"
                    enabled={comp.enabled}
                    onToggle={(v) => setComp({ enabled: v })}
                    extra={<CompMakeup comp={comp} />}
                >
                    <Field label="Threshold" hint={`${comp.threshold} dB`}>
                        <Slider
                            value={comp.threshold}
                            min={COMP_LIMITS.threshold.min}
                            max={COMP_LIMITS.threshold.max}
                            step={1}
                            onChange={(v) => setComp({ threshold: v })}
                        />
                    </Field>
                    <Field label="Ratio" hint={`${comp.ratio}:1`}>
                        <Slider
                            value={comp.ratio}
                            min={COMP_LIMITS.ratio.min}
                            max={COMP_LIMITS.ratio.max}
                            step={0.5}
                            onChange={(v) => setComp({ ratio: v })}
                        />
                    </Field>
                    <Field label="Knee" hint={comp.knee === 0 ? 'hard' : `${comp.knee} dB soft`}>
                        <Slider
                            value={comp.knee}
                            min={COMP_LIMITS.knee.min}
                            max={COMP_LIMITS.knee.max}
                            step={1}
                            onChange={(v) => setComp({ knee: v })}
                        />
                    </Field>
                    <Field label="Attack" hint={`${comp.attack} ms`}>
                        <Slider
                            value={comp.attack}
                            min={COMP_LIMITS.attack.min}
                            max={COMP_LIMITS.attack.max}
                            step={1}
                            onChange={(v) => setComp({ attack: v })}
                        />
                    </Field>
                    <Field label="Release" hint={`${comp.release} ms`}>
                        <Slider
                            value={comp.release}
                            min={COMP_LIMITS.release.min}
                            max={COMP_LIMITS.release.max}
                            step={10}
                            onChange={(v) => setComp({ release: v })}
                        />
                    </Field>
                    <Field label="Auto makeup" inline>
                        <Switch checked={comp.autoMakeup} onChange={(v) => setComp({ autoMakeup: v })} />
                    </Field>
                    {!comp.autoMakeup && (
                        <Field label="Makeup" hint={`+${comp.makeup} dB`}>
                            <Slider
                                value={comp.makeup}
                                min={COMP_LIMITS.makeup.min}
                                max={COMP_LIMITS.makeup.max}
                                step={0.5}
                                onChange={(v) => setComp({ makeup: v })}
                            />
                        </Field>
                    )}
                    <div className="row-end">
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setComp({ ...FILTER_DEFAULTS.compressor, enabled: comp.enabled })}
                        >
                            Reset
                        </Button>
                    </div>
                </Section>
            )}

            {tab === 'stereo' && (
                <Section title="Stereo widener" enabled={stereo.enabled} onToggle={(v) => setStereo({ enabled: v })}>
                    <Field label="Width" hint={`${stereo.width} %`}>
                        <Slider
                            value={stereo.width}
                            min={0}
                            max={100}
                            step={5}
                            onChange={(v) => setStereo({ width: v })}
                        />
                    </Field>
                    <Field label="Delay" hint={`${stereo.delay} ms`}>
                        <Slider
                            value={stereo.delay}
                            min={2}
                            max={40}
                            step={1}
                            onChange={(v) => setStereo({ delay: v })}
                        />
                    </Field>
                    <div className="note note--tight">
                        Spreads a mono signal across both ears. Around 15–20 ms reads as
                        space rather than echo; the two sides still sum back to the
                        original if anything downstream folds to mono. Headphones only —
                        on a single speaker it will thin the sound.
                    </div>
                    <div className="row-end">
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setStereo({ ...FILTER_DEFAULTS.stereo, enabled: stereo.enabled })}
                        >
                            Reset
                        </Button>
                    </div>
                </Section>
            )}
        </div>
    );
}

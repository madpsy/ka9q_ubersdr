// Demodulating the quadrature stream here, in the browser — up to four at once.
//
// Every other way of listening on this receiver asks the server for a
// demodulated channel at the dial: one mode, one passband, one frequency. In
// `iq` the server stops demodulating and sends 12 kHz of baseband instead, and
// this panel is what listens to it. Two things follow that nothing else here can
// do, and between them they are the reason the panel exists:
//
//   * You can listen somewhere other than the dial. The offset picks any point
//     in the twelve kilohertz, at a bandwidth of your own, without retuning and
//     without the receiver knowing.
//   * You can do it more than once. The same samples feed up to four
//     demodulators at the same time, each with its own mode, filter, ear and
//     level — so both sides of a split, or a net and the DX it is working, or
//     four CW signals across a contest pile-up, are one stream and one screen.
//
// ── The layout, and why it is this one ───────────────────────────────────────
//
// Six demodulators is two different jobs and they want opposite things. One is
// survey — where are they, what are they doing, which is muted — which wants
// every one of them visible at once and compact. The other is adjustment, which
// wants full-size controls and only ever concerns one of them.
//
// A row per demodulator, each opening in place, serves both. The list is the
// picture's legend, so every row carries the colour its passband is drawn in;
// a row you are working on expands where it sits, so there is never a question
// of which one the controls below belong to. With a single demodulator — the
// default — this reads as an ordinary panel with one header line above it. With
// six it is six lines and whichever of them you have left open.
//
// The two controls that do *not* wait to be selected are pan and mute, which sit
// on every row. Those are the ones you reach for while juggling several — which
// of these am I listening to, and in which ear — and having to select a
// demodulator before you could silence it would be the wrong way round.
//
// ── Experimental, and where the edges are ────────────────────────────────────
//
// The arithmetic is textbook and lib/iqDemod.js justifies every line of it, but
// these are a few hundred lines of JavaScript standing next to ka9q-radio's own
// demodulators and they should not be mistaken for them. Two things in
// particular are worth knowing before judging what comes out:
//
//   * IQ costs the receiver's owner about six times the bandwidth of Opus, on
//     somebody else's bill. That is what the confirmation in front of the mode
//     is about, and it is why this panel does not switch itself on.
//   * The filter is the only filter. In IQ the server's passband is fixed at
//     the full +/-6 kHz and the client DSP chain is out of circuit, so the
//     noise blanker, the noise reduction and the audio filters are all absent —
//     the bandwidth control here is doing the whole job.
//
// ── What is not in this file ─────────────────────────────────────────────────
//
// The demodulators themselves, and their lifetime. A collapsed dock section is
// unmounted, so a bank owned by this component would stop the moment somebody
// folded the panel away — leaving the receiver in IQ playing broadband noise
// with no control on screen to explain it. The engine is therefore a plain
// object living in lib/iqDemod.js, exactly as the recorder and the measure tool
// are, and components/IQDemodWatch.jsx is what pushes the mode and the volume
// into it. This file is a view over that object and a set of controls.

import React, { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { resolveMaxFps, useDisplay } from '../display/DisplayContext.jsx';
import { markColors } from '../display/uiConfig.js';
import { TOUCH_QUERY, useMediaQuery } from '../lib/useMediaQuery.js';
import { Button, Field, Icon, RangeSlider, Readout, Segmented, Slider, Switch } from '../components/ui.jsx';
import FreqEntry from '../components/FreqEntry.jsx';
import { WIDE_IQ_MODES, isIQ } from '../radio/constants.js';
import { IQWidths } from './ReceiverPanel.jsx';
import { formatFreqExact, formatSpan } from '../lib/format.js';
import { haptic } from '../lib/haptics.js';
import { useRoomFor } from '../lib/useRoomFor.js';
import { cssVar, sizedCanvas } from '../lib/audioWaterfall.js';
import { elementSinkSupport, sinkLabel } from '../lib/audioSinks.js';
import useOutputDevices from '../lib/useOutputDevices.js';
import { createLevels, updateLevels } from '../lib/ifSpectrum.js';
import { approachFor } from '../lib/timeConstant.js';
import {
    IQSpectrum, aimCancel, aimDown, aimMove, aimUp, binsToPixels, fractionOffset, markerAt,
    newAim, offsetFraction, scaleTicks, audioTicks, squelchLineDb,
} from '../lib/iqSpectrum.js';
import {
    DEMOD_MODES, MAX_VFOS, PANS, PITCH_MAX, PITCH_MIN, SIDEBAND_OPTIONS, SQUELCH_MAX, SQUELCH_OFF,
    TRACK_MAX, TRACK_MIN, VFO_LABELS, addVfo, collapseVfos, demodMode, expandActiveVfo, getIQDemod, iqHalfSpan, offsetLimits, onDemodSettings,
    planForVfo, removeVfo, selectVfo, signalMeter, tapsFor, toggleVfo, updateVfo, vfoPassband, workingRate, modeMax, modeWidths,
    audioBandOf, clampLowCut, SSB_MIN_SPAN,
    vfoWidth,
} from '../lib/iqDemod.js';

// How often the level meters are redrawn while running. Twelve a second, which
// is the rate the Signal panel's meters are sampled at and as fast as a bar is
// worth reading; the audio itself is not driven from here.
const METER_MS = 80;

// A row's own strip, as a share of the header above it.
//
// Two thirds rather than the whole. Matching the header exactly was the first
// answer and it made the picture the loudest thing in the row: a strip as tall
// as the line above it reads as a second row rather than as a band under one,
// and with six demodulators the column becomes a stack of spectra with names
// attached. At two thirds there is still room for thirty decibels to be worth
// looking at, and the row still reads as a row.
const STRIP_SHARE = 0.66;

// What the header measures as before it has been measured, in CSS pixels. Only
// ever what the strip is drawn at for the one frame before the real figure
// arrives — see useBoxHeight.
const HEAD_H = 26;

// Height of the spectrum, in CSS pixels. Tall enough for the thirty decibels
// between a signal and the noise it is sitting in to be worth looking at, short
// enough to leave room under it for four rows in a dock column.
const SCOPE_H = 96;

// What the two optional parts of a row header cost, before they have been on
// screen once to be measured. A twelve-character reading and a signed offset,
// at the row's font, each plus its gap.
const FREQ_TAG_W = 88;
const OFFSET_TAG_W = 62;
// ...and the two a collapsed row will also give up: three segmented buttons,
// and a width like "2.7k" plus its gap.
const PAN_TAG_W = 72;
const BW_TAG_W = 34;

const MODE_OPTIONS = DEMOD_MODES.map((m) => ({
    value: m.id, label: m.label, title: m.summary,
}));

/** A width in the unit it reads best in: hertz below a kilohertz, kHz above. */
function widthLabel(hz) {
    if (hz < 1000) return `${hz}`;
    const k = hz / 1000;
    return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`;
}

/**
 * An element's height in CSS pixels, kept up to date.
 *
 * For the strip, whose whole specification is "as tall as the header above it".
 * That height is not a constant anybody can write down: it follows the row's
 * font, the interface scale and whatever the pan control's buttons measure on
 * this platform. Asking the element is the only answer that stays right when
 * one of those changes, and an observer is the only way to hear about it — the
 * header can grow without this component rendering.
 */
function useBoxHeight(ref, fallback) {
    const [h, setH] = useState(fallback);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const read = () => {
            const box = Math.round(el.getBoundingClientRect().height);
            setH(box > 0 ? box : fallback);
        };
        read();
        const ro = new ResizeObserver(read);
        ro.observe(el);
        return () => ro.disconnect();
    }, [ref, fallback]);
    return h;
}

/**
 * The same picture, cropped to one demodulator's passband.
 *
 * What the minimal view has instead of the full scope, and it is a different
 * answer rather than a smaller one. Minimal is a dock column with something
 * else in it, so ninety-six pixels of shared spectrum is the first thing that
 * has to go — but what it was doing is not optional. Aiming a demodulator by
 * ear, at a passband you cannot see, is the state this panel exists to get an
 * operator out of.
 *
 * So each row keeps a picture of its own — two thirds the height of its own
 * header, see STRIP_SHARE — showing exactly the span between its filter's
 * skirts and nothing else. Where the full
 * scope answers "what else is in the twelve kilohertz", this answers "is my
 * signal still in my filter, and where in it" — which is the question you have
 * once you are listening rather than looking, and it is the one a row can
 * answer in twenty-six pixels.
 *
 * It is drawn in the same language as the big one, because it is the big one
 * cropped: the whole strip is tinted in this demodulator's colour, since the
 * whole strip *is* its passband; the trace is the same accent; and the squelch
 * sits at the same corrected height, over the width of the strip rather than
 * part of it.
 */
function VfoStrip({ source, vfo, index, armed, height }) {
    const ref = useRef(null);
    const st = useRef({ levels: createLevels(), px: null });
    // Read inside the draw, which must not resubscribe as a slider moves.
    st.current.vfo = vfo;
    st.current.index = index;
    st.current.h = height;
    st.current.rate = source.spec.rate;

    useEffect(() => {
        st.current.levels = createLevels();
        if (!armed) return undefined;
        // The rate re-read per frame, not only per render: it changes under the
        // panel when the IQ width does, and nothing re-renders a strip then.
        return source.subscribe((bins, dt) => {
            st.current.rate = source.spec.rate;
            drawStrip(ref.current, st.current, bins, dt);
        });
    }, [source, armed, height]);

    // Off air, there is no loop to redraw this and the last frame would sit
    // there looking like a signal. Drawn on every render instead, which while
    // stopped is only when something has actually changed — and drawn through
    // the same path, so a strip with nothing to show is a strip showing its
    // passband and no trace rather than a blank rectangle.
    useEffect(() => {
        if (!armed) drawStrip(ref.current, st.current, null, 0);
    });

    return (
        <canvas
            ref={ref}
            className="iq-vfo__strip"
            style={{ height: `${height}px` }}
            title="This demodulator’s passband"
        />
    );
}

// ── the audio spectrum ───────────────────────────────────────────────────────
//
// An open row shows what its demodulator is putting out as a spectrum rather
// than a level bar: across exactly the audio its filter passes (audioBandOf), so
// widening the filter widens the picture, and what is under it — the shape of a
// voice, a CW note, the hiss of an empty channel — is visible at a glance. A
// press swaps the filled area for bars and back; the choice is shared by every
// row and kept.

const AUDIO_STYLE_KEY = 'ubersdr.v2.iqAudioScope';
// How far each column moves towards a new reading per 50 ms (timeConstant.js's
// reference interval, which approachFor scales to the real one, so a capped or
// busy panel smooths over the same time): about a 0.15 s time constant. A
// single transform of 85 ms of audio is a noisy estimate, and without this the
// bars jitter on a steady tone; much longer and speech smears.
const AUDIO_SMOOTH_K = 0.3;
export const AUDIO_SCOPE_H = 22;
let audioStyle = null;
const audioStyleListeners = new Set();

function readAudioStyle() {
    try {
        // The filled area unless bars have been chosen: it reads as a shape at
        // this height where bars read as a row of separate readings.
        return localStorage.getItem(AUDIO_STYLE_KEY) === 'bars' ? 'bars' : 'area';
    } catch (err) {
        return 'area';
    }
}

/** The shared bars-or-area choice, and the press that flips it everywhere. */
export function useAudioStyle() {
    const [style, setStyle] = useState(() => {
        if (audioStyle == null) audioStyle = readAudioStyle();
        return audioStyle;
    });
    useEffect(() => {
        audioStyleListeners.add(setStyle);
        return () => audioStyleListeners.delete(setStyle);
    }, []);
    const flip = () => {
        audioStyle = (audioStyle || style) === 'bars' ? 'area' : 'bars';
        try { localStorage.setItem(AUDIO_STYLE_KEY, audioStyle); } catch (err) { /* private mode */ }
        for (const fn of Array.from(audioStyleListeners)) fn(audioStyle);
    };
    return [style, flip];
}

function AudioScope({ index, vfo, source, armed }) {
    const ref = useRef(null);
    const [style, flip] = useAudioStyle();
    // Its own width, for how many figures fit on the scale under it. 200px
    // until measured: about what a row's chart gets in a narrow dock.
    const box = useRef(null);
    const [boxW, setBoxW] = useState(200);
    useLayoutEffect(() => {
        const el = box.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(() => setBoxW(el.clientWidth || 200));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    const st = useRef({ levels: createLevels(), px: null });
    st.current.vfo = vfo;
    st.current.index = index;
    st.current.style = style;

    useEffect(() => {
        st.current.levels = createLevels();
        if (!armed) return undefined;
        // On the panel's own frame loop, at its rate cap: one transform per
        // open row per frame, and none at all for a row that is shut.
        return source.subscribe((bins, dt) => {
            drawAudio(ref.current, st.current, getIQDemod().audioSpectrumOf(st.current.index), dt);
        });
    }, [source, armed]);

    // Stopped, there is no loop: drawn on render so a style change still shows.
    useEffect(() => {
        if (!armed) drawAudio(ref.current, st.current, null, 0);
    });

    const band = audioBandOf(vfo);
    return (
        <button
            type="button"
            ref={box}
            className="iq-vfo__audio"
            title={`Audio, 0 Hz to ${formatSpan(band.hi)} — press for ${style === 'bars' ? 'a filled area' : 'bars'}`}
            onClick={flip}
        >
            <canvas ref={ref} style={{ height: `${AUDIO_SCOPE_H}px` }} />
            {/* 0 Hz at the left, the top of the filter's audio at the right. */}
            <span className="iq-vfo__audio-scale">
                {audioTicks(band.hi, boxW).map((t) => (
                    <span
                        key={t.hz}
                        className={t.align === 'center' ? undefined : `is-${t.align}`}
                        style={{ left: `${(t.frac * 100).toFixed(3)}%` }}
                    >
                        {t.label}
                    </span>
                ))}
            </span>
        </button>
    );
}

/** One frame of one row's audio spectrum. */
function drawAudio(canvas, s, spec, dt) {
    if (!canvas) return;
    const { w, h, dpr } = sizedCanvas(canvas, AUDIO_SCOPE_H);
    const c = canvas.getContext('2d');
    if (!c) return;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, w, h);
    c.fillStyle = cssVar('--surface-3', '#1a2130');
    c.fillRect(0, 0, w, h);
    if (!spec) return;

    // The bins the filter's audio covers, and nothing either side of it.
    const band = audioBandOf(s.vfo);
    const n = spec.db.length;
    const k0 = Math.max(0, Math.min(n - 1, Math.floor(band.lo / spec.binHz)));
    const k1 = Math.max(k0 + 1, Math.min(n, Math.ceil(band.hi / spec.binHz) + 1));
    if (!s.px || s.px.length !== w) s.px = new Float32Array(w);
    binsToPixels(spec.db.subarray(k0, k1), s.px);
    // Smoothed over a few frames, in decibels. Started again whenever the
    // columns stop meaning the same frequencies — the width changed, or the
    // picture did — rather than easing from one scale into another.
    const key = `${k0}/${k1}/${w}`;
    if (!s.avg || s.avgKey !== key) {
        s.avg = Float32Array.from(s.px, (v) => (Number.isFinite(v) ? v : -180));
        s.avgKey = key;
    } else {
        const a = approachFor(AUDIO_SMOOTH_K, dt > 0 ? dt : 1 / 60);
        for (let x = 0; x < w; x++) {
            const v = s.px[x];
            if (Number.isFinite(v)) s.avg[x] += a * (v - s.avg[x]);
        }
    }
    s.px.set(s.avg);
    const { floor, ceil } = updateLevels(s.levels, s.px, dt);
    const range = Math.max(1, ceil - floor);
    const hOf = (db) => (Number.isFinite(db) ? Math.max(0, Math.min(h, ((db - floor) / range) * h)) : 0);
    const colour = cssVar(`--iq-vfo-${(s.index % MAX_VFOS) + 1}`, VFO_FALLBACK[s.index % MAX_VFOS]);

    if (s.style === 'area') {
        // Filled to the floor, solidly enough to read as a shape at this
        // height, with its edge drawn over the top.
        c.beginPath();
        c.moveTo(0, h);
        for (let x = 0; x < w; x++) c.lineTo(x, h - hOf(s.px[x]));
        c.lineTo(w, h);
        c.closePath();
        c.globalAlpha = 0.55;
        c.fillStyle = colour;
        c.fill();
        c.globalAlpha = 1;
        c.lineWidth = Math.max(1, dpr);
        c.strokeStyle = colour;
        c.stroke();
        return;
    }
    // Bars: each the loudest column under it, a pixel apart.
    const bw = Math.max(2, Math.round(3 * dpr));
    const gap = Math.max(1, Math.round(dpr));
    c.fillStyle = colour;
    for (let x = 0; x + bw <= w; x += bw + gap) {
        let peak = -Infinity;
        for (let i = x; i < x + bw; i++) if (s.px[i] > peak) peak = s.px[i];
        const bh = hOf(peak);
        if (bh > 0) c.fillRect(x, h - bh, bw, bh);
    }
}

/** One frame of one strip. */
function drawStrip(canvas, s, bins, dt) {
    if (!canvas) return;
    const { w, h, dpr } = sizedCanvas(canvas, s.h || Math.round(HEAD_H * STRIP_SHARE));
    const c = canvas.getContext('2d');
    if (!c) return;

    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, w, h);
    c.fillStyle = cssVar('--surface-3', '#1a2130');
    c.fillRect(0, 0, w, h);

    const { vfo } = s;
    const colour = cssVar(`--iq-vfo-${(s.index % MAX_VFOS) + 1}`, VFO_FALLBACK[s.index % MAX_VFOS]);
    // The whole strip is the passband, so the shading the full scope draws over
    // part of its width covers all of this one. It is what makes a row's strip
    // recognisably that row's at a glance down the column.
    c.globalAlpha = 0.22;
    c.fillStyle = colour;
    c.fillRect(0, 0, w, h);
    c.globalAlpha = 1;

    const rate = s.rate || 12000;
    const band = vfoPassband(vfo);
    const span = Math.max(1, band.hi - band.lo);

    if (bins) {
        // The slice of the transform this passband covers. Taken by index
        // rather than resampled from the whole array: at a 500 Hz filter that
        // is forty bins of a thousand, and stretching the other nine hundred
        // and sixty across the same pixels first would cost as much as the
        // transform did.
        const n = bins.length;
        const at = (hz) => Math.round((hz / rate + 0.5) * n);
        const i0 = Math.max(0, Math.min(n - 1, at(band.lo)));
        const i1 = Math.max(i0 + 1, Math.min(n, at(band.hi)));
        if (!s.px || s.px.length !== w) s.px = new Float32Array(w);
        binsToPixels(bins.subarray(i0, i1), s.px);
        const { floor, ceil } = updateLevels(s.levels, s.px, dt);
        const range = Math.max(1, ceil - floor);
        const yOf = (db) => h - ((db - floor) / range) * h;

        c.beginPath();
        c.moveTo(0, h);
        for (let x = 0; x < w; x++) {
            const y = s.px[x];
            c.lineTo(x, Number.isFinite(y) ? Math.max(0, Math.min(h, yOf(y))) : h);
        }
        c.lineTo(w, h);
        c.closePath();
        const accent = cssVar('--accent', '#08a2fb');
        c.globalAlpha = 0.32;
        c.fillStyle = accent;
        c.fill();
        c.globalAlpha = 1;
        c.lineWidth = Math.max(1, dpr);
        c.strokeStyle = accent;
        c.stroke();

        // And the squelch across it, at the same corrected height as the line
        // on the full picture — one threshold, drawn the same way wherever the
        // spectrum is being shown.
        if (vfo.squelchDb > SQUELCH_OFF) {
            const y = Math.round(Math.max(1, Math.min(
                h - 1, yOf(squelchLineDb(vfo.squelchDb, span, rate)),
            ))) + 0.5;
            c.beginPath();
            c.moveTo(0, y);
            c.lineTo(w, y);
            c.lineWidth = Math.max(1, dpr * 1.5);
            c.strokeStyle = cssVar('--bad', '#f2646a');
            c.stroke();
        }
    }
}

/**
 * A meter's reading, or an em dash when there is nothing to read.
 *
 * A dash rather than a zero or a floor figure: "-100 dBFS" is a measurement and
 * a stopped receiver has not made one. Whole decibels, because the meter beside
 * it is three pixels tall and a tenth of a decibel is a digit that changes
 * twelve times a second and means nothing.
 */
function levelLabel(db) {
    return db == null || !Number.isFinite(db) ? '—' : `${Math.round(db)} dBFS`;
}

/** A signed offset from the dial, in the shape the Measure panel uses. */
function offsetLabel(hz) {
    const r = Math.round(hz);
    if (r === 0) return '0 Hz';
    return `${r > 0 ? '+' : '−'}${formatSpan(Math.abs(r))}`;
}

/**
 * What a row always says: which demodulator it is and how wide.
 *
 * Where it is listening is two further readings — the offset from the dial and
 * the frequency itself — and both are optional, because a dock column is not
 * always wide enough for either. See the header below.
 */
export function vfoSummary(vfo) {
    return `${demodMode(vfo.mode).label} ${widthLabel(vfoWidth(vfo))}`;
}

/**
 * The theme's demodulator colours, read once per draw rather than per mark.
 *
 * The fallbacks are the dark theme's, for the moment before the stylesheet has
 * resolved — a marker drawn in `undefined` is a marker drawn in black, which on
 * this canvas is a marker that is not drawn at all.
 */
export const VFO_FALLBACK = ['#f2b544', '#45d69a', '#f472b6', '#a78bfa', '#9ad64a', '#f0836b'];

function vfoColours() {
    return VFO_FALLBACK.slice(0, MAX_VFOS).map((f, i) => cssVar(`--iq-vfo-${i + 1}`, f));
}

/**
 * One transform of the stream, and everyone who draws it.
 *
 * There are two pictures of the same twelve kilohertz now — the full one above
 * the rows, and a strip inside each row showing only that demodulator's
 * passband — and only one of them is ever on screen at a time. That is still
 * not a reason to give each its own transform: the ring, the FFT and the
 * smoothing are the expensive part and none of it depends on who is looking, so
 * this owns them once and hands the same bins to whoever asked.
 *
 * `frame()` is the reason it has to be exactly once. It carries the smoothing
 * from one call to the next, so two consumers each calling it per frame would
 * be advancing one average twice as fast as it was written for — the noise
 * floor would stop boiling and a CW element would be gone before it was drawn.
 * Here the loop calls it, and the subscribers are handed what came back.
 *
 * It runs whenever the receiver is in IQ, not only while demodulating: looking
 * at what is in the twelve kilohertz before deciding where to listen is the
 * order somebody actually does this in, and a picture that only appeared after
 * Start would be a picture that arrived too late to be used.
 */
function useIQFrames(player, live, iq, maxFps) {
    const ref = useRef(null);
    if (!ref.current) {
        ref.current = {
            spec: new IQSpectrum(),
            subs: new Set(),
            subscribe(fn) {
                ref.current.subs.add(fn);
                return () => ref.current.subs.delete(fn);
            },
        };
    }
    const src = ref.current;

    useEffect(() => {
        if (!live || !iq) {
            src.spec.reset();
            return undefined;
        }

        const untap = player.onAudio((planes, frames, sampleRate) => {
            // A mono stream is not a quadrature pair, and reading one as though
            // it were would draw a plausible picture of nothing.
            if (planes.length < 2) return;
            src.spec.push(planes[0], planes[1], frames, sampleRate);
        });

        let raf = 0;
        let timer = 0;
        let last = 0;
        const capMs = maxFps > 0 ? 1000 / maxFps : 0;
        const frame = () => {
            const now = performance.now();
            const dt = last ? Math.min(1, (now - last) / 1000) : 0.05;
            last = now;
            const bins = src.spec.frame(dt);
            // A copy of the set, so a subscriber that unsubscribes on its way
            // out of the tree cannot alter what is being iterated.
            for (const fn of Array.from(src.subs)) fn(bins, dt);
            if (capMs) timer = setTimeout(() => { raf = requestAnimationFrame(frame); }, capMs);
            else raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);

        return () => {
            untap();
            cancelAnimationFrame(raf);
            clearTimeout(timer);
        };
    }, [player, live, iq, maxFps, src]);

    return src;
}

/**
 * The picture of the stream, and the way you aim inside it.
 *
 * This is the panel's reason for being a panel rather than a list of sliders:
 * a demodulator's offset is a place in a piece of spectrum, and a place in a
 * piece of spectrum is something you point at. Every demodulator's passband is
 * drawn here in its own colour, so the picture is the one view that shows all
 * all of them at once, and the rows below are its legend.
 *
 * Pressing has two meanings and the markers tell them apart: a press within a
 * few pixels of one picks *that* demodulator up and drags it — selecting it on
 * the way — and a press anywhere else moves the one already selected. That is
 * what makes every one of them directly draggable rather than only the
 * current one.
 *
 * The transform it draws is lib/iqSpectrum.js's, computed once per frame by
 * useIQFrames above from the same quadrature the demodulators are listening to
 * — see the note there about why a complex transform can show the two sides of
 * the dial apart when the audio analyser behind the Audio scope cannot.
 */
function IQScope({ source, live, iq, running, vfos, active, onOffset, onPick, marks, carriers, dialHz }) {
    const ref = useRef(null);
    // The scale's own width, for how many frequencies fit under the picture.
    // 300px until measured: a narrow dock's worth, so the first frame errs on
    // the side of fewer labels rather than more.
    const scaleRef = useRef(null);
    const [scaleW, setScaleW] = useState(300);
    useLayoutEffect(() => {
        const el = scaleRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(() => setScaleW(el.clientWidth || 300));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    const st = useRef({
        levels: createLevels(),
        px: null,
        aim: newAim(),
        target: -1,
    });
    // Read by the draw loop, which must not resubscribe on every render — a
    // fresh subscription each time an offset moved by ten hertz would blank the
    // picture on the one gesture it exists to serve.
    st.current.vfos = vfos;
    st.current.active = active;
    st.current.rate = source.spec.rate;
    st.current.carriers = carriers || [];
    st.current.dialHz = dialHz;
    // The readout that follows the pointer. Written straight into the element
    // by the draw loop rather than through state: its level changes every
    // frame, and re-rendering the panel sixty times a second to say so would
    // cost far more than the picture does.
    const tipRef = useRef(null);
    // Real frequencies across the whole stream — ±6 kHz of the dial on plain
    // IQ, further on the wide presets — as many as the width holds. See
    // scaleTicks.
    const ticks = scaleTicks(dialHz, iqHalfSpan() * 2, scaleW);

    useEffect(() => {
        st.current.levels = createLevels();
        if (!live || !iq) return undefined;
        // The rate re-read per frame, not only per render. Going from 12 kHz to
        // IQ 48 rescales the transform at once, and a rate copied on render
        // left every passband drawn — and every press placed — at the old
        // scale until something happened to re-render the panel.
        return source.subscribe((bins, dt) => {
            st.current.rate = source.spec.rate;
            draw(ref.current, st.current, bins, dt, marks);
            showTip(tipRef.current, st.current);
        });
    }, [source, live, iq, marks.dial, marks.edge]);
    // Nothing to read off a picture that is not running.
    useEffect(() => {
        if (!(live && iq)) {
            st.current.hover = null;
            showTip(tipRef.current, st.current);
        }
    }, [live, iq]);

    // Where in the picture the pointer is, in pixels from its left edge, or null
    // if it cannot be measured.
    const xOf = (e) => {
        const canvas = ref.current;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        if (!rect.width) return null;
        return { x: e.clientX - rect.left, w: rect.width };
    };

    const aim = (e) => {
        const at = xOf(e);
        if (!at) return;
        const s = st.current;
        // Committing the pick here rather than on the way down: a press that
        // turns out to be a scroll never reaches this, so a swipe past the
        // picture must not change which demodulator is selected either.
        if (s.target >= 0 && s.target !== s.active) onPick(s.target);
        const index = s.target >= 0 ? s.target : s.active;
        onOffset(index, Math.round(fractionOffset(at.x / at.w, s.rate)));
    };

    const grab = (e) => {
        if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId);
    };
    const release = (e) => {
        if (e.currentTarget.hasPointerCapture && e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
    };

    // What each of these means is in lib/iqSpectrum.js, under "Aiming" — the
    // rule is pure, and it is the part that cannot be seen without a touch
    // screen in hand.
    const act = (e, { tune, capture }) => {
        if (capture) grab(e);
        if (tune) aim(e);
    };

    const down = (e) => {
        if (!live || !iq) return;
        const s = st.current;
        const at = xOf(e);
        // Which demodulator this gesture is about, decided once at the start:
        // deciding it again on every move would let a drag hand itself over to
        // whichever marker it happened to pass.
        s.target = at
            ? markerAt(s.vfos.map((v) => v.offsetHz), at.x, at.w, s.rate)
            : -1;
        const r = aimDown(s.aim, e);
        act(e, r);
        if (r.tune) haptic('tune', 'spectrum');
    };
    // A mouse or a pen over the picture is somebody reading it; a finger on it
    // is somebody tuning, and has nothing to hover with.
    const move = (e) => {
        const s = st.current;
        if (e.pointerType !== 'touch' && live && iq) {
            const rect = ref.current && ref.current.getBoundingClientRect();
            s.hover = rect && rect.width
                ? { x: e.clientX - rect.left, y: e.clientY - rect.top, w: rect.width }
                : null;
            showTip(tipRef.current, s);
        }
        act(e, aimMove(s.aim, e));
    };
    const leave = () => {
        st.current.hover = null;
        showTip(tipRef.current, st.current);
    };
    const up = (e) => {
        const r = aimUp(st.current.aim, e);
        release(e);
        act(e, r);
        if (r.tune) haptic('tune', 'spectrum');
    };
    const cancel = (e) => {
        aimCancel(st.current.aim);
        st.current.target = -1;
        release(e);
    };

    return (
        <div className="iq-scope">
            {/* No title: the readout below follows the pointer, and a browser
                tooltip would sit on top of it. The instructions stay with the
                picture as its label. */}
            <canvas
                ref={ref}
                className={`iq-scope__canvas${running ? ' is-live' : ''}`}
                style={{ height: `${SCOPE_H}px` }}
                aria-label="Press or drag to move a demodulator; press a marker to pick that one up"
                onPointerDown={down}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={cancel}
                onPointerLeave={leave}
            />
            <div ref={tipRef} className="spec-tip iq-scope__tip" hidden />
            {!(live && iq) && (
                <div className="iq-scope__veil">
                    {live ? 'The receiver is not in IQ.' : 'The receiver is off.'}
                </div>
            )}
            <div className="iq-scope__scale" ref={scaleRef}>
                {ticks.map((t) => (
                    <span
                        key={t.hz}
                        className={t.dial ? 'is-dial' : t.align === 'center' ? undefined : `is-${t.align}`}
                        style={{ left: `${(t.frac * 100).toFixed(3)}%` }}
                    >
                        {t.label}
                    </span>
                ))}
            </div>
        </div>
    );
}

/**
 * The pointer's readout: the frequency under it and the level there, in dBFS.
 *
 * The level is the picture's own, the pixel column the pointer is over, so the
 * figure is what the trace is drawing at that point and moves with it. Before a
 * frame has drawn anything the frequency is still worth saying, so the level is
 * left off rather than the readout.
 */
function showTip(tip, s) {
    if (!tip) return;
    const at = s.hover;
    if (!at || !(at.w > 0) || !(s.rate > 0)) {
        tip.hidden = true;
        return;
    }
    const frac = Math.max(0, Math.min(1, at.x / at.w));
    const hz = (s.dialHz || 0) + fractionOffset(frac, s.rate);
    let text = formatFreqExact(Math.round(hz));
    if (s.px && s.px.length) {
        const db = s.px[Math.min(s.px.length - 1, Math.floor(frac * s.px.length))];
        if (Number.isFinite(db)) text += ` · ${db.toFixed(1)} dBFS`;
    }
    tip.textContent = text;
    tip.hidden = false;
    // Beside the pointer, and on its other side near the right edge so the
    // readout does not run off the picture.
    const flip = at.x > at.w - 160;
    tip.style.left = `${Math.round(at.x + (flip ? -12 : 12))}px`;
    tip.style.top = `${Math.round(Math.max(0, at.y - 22))}px`;
    tip.style.transform = flip ? 'translateX(-100%)' : 'none';
}

/**
 * One frame of the picture.
 *
 * Order matters and is the usual one: the passbands under everything so the
 * trace stays legible over them, the trace, then the marks on top. Among the
 * marks the selected demodulator goes last, so where two sit on the same
 * frequency the one you are working on is the one you can see.
 */
function draw(canvas, s, bins, dt, marks) {
    if (!canvas) return;
    const { w, h, dpr } = sizedCanvas(canvas, SCOPE_H);
    const c = canvas.getContext('2d');
    if (!c) return;

    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, w, h);
    c.fillStyle = cssVar('--surface-3', '#1a2130');
    c.fillRect(0, 0, w, h);

    const rate = s.rate || 12000;
    const xOf = (hz) => offsetFraction(hz, rate) * w;
    const vfos = s.vfos || [];
    const colours = vfoColours();

    // The filters that are actually running, at the offsets they are actually
    // running at. Drawn whether or not anything has been received yet: they are
    // a statement about the settings, not about the signal.
    for (let i = 0; i < vfos.length; i++) {
        const band = vfoPassband(vfos[i]);
        const x0 = xOf(band.lo);
        const x1 = xOf(band.hi);
        c.globalAlpha = i === s.active ? 0.30 : 0.16;
        c.fillStyle = colours[i % colours.length];
        c.fillRect(x0, 0, Math.max(dpr, x1 - x0), h);
    }
    c.globalAlpha = 1;

    // Set once the scale is known, and read afterwards by the squelch lines —
    // which are a level on this picture and cannot be placed until there is a
    // picture to place them on.
    let yOf = null;

    if (bins) {
        if (!s.px || s.px.length !== w) s.px = new Float32Array(w);
        binsToPixels(bins, s.px);
        const { floor, ceil } = updateLevels(s.levels, s.px, dt);
        const span = Math.max(1, ceil - floor);
        yOf = (db) => h - ((db - floor) / span) * h;

        // Filled to the floor rather than a bare line: at this height a stroke
        // on its own reads as a scribble, and the fill is what makes a carrier
        // look like a carrier.
        c.beginPath();
        c.moveTo(0, h);
        for (let x = 0; x < w; x++) {
            const y = s.px[x];
            c.lineTo(x, Number.isFinite(y) ? Math.max(0, Math.min(h, yOf(y))) : h);
        }
        c.lineTo(w, h);
        c.closePath();
        const accent = cssVar('--accent', '#08a2fb');
        c.globalAlpha = 0.28;
        c.fillStyle = accent;
        c.fill();
        c.globalAlpha = 1;
        c.lineWidth = Math.max(1, dpr);
        c.strokeStyle = accent;
        c.stroke();
    }

    // Every squelch that is set, drawn as a red line across the passband it
    // gates, at the height the trace has to reach for the gate to open.
    //
    // Across the passband rather than the whole width, because that is what it
    // is a statement about: with six demodulators there can be six of these and
    // a set of full-width lines would say nothing about which threshold belongs
    // to which filter. Over the trace rather than under it, so a signal poking
    // through the threshold is read the way it is meant to be — the line is the
    // question and the trace is the answer.
    if (yOf) {
        const red = cssVar('--bad', '#f2646a');
        for (let i = 0; i < vfos.length; i++) {
            const v = vfos[i];
            if (!(v.squelchDb > SQUELCH_OFF)) continue;
            const band = vfoPassband(v);
            const x0 = xOf(band.lo);
            const x1 = xOf(band.hi);
            // Clamped rather than dropped when it lands off the scale: a
            // threshold pinned to the top of the picture is the answer to why
            // nothing is being heard, and one at the bottom is the answer to
            // why everything is.
            const y = Math.round(Math.max(1, Math.min(h - 1, yOf(
                squelchLineDb(v.squelchDb, vfoWidth(v), rate),
            )))) + 0.5;
            c.beginPath();
            c.moveTo(x0, y);
            c.lineTo(Math.max(x0 + dpr, x1), y);
            c.lineWidth = Math.max(1, dpr * 1.5);
            c.strokeStyle = red;
            c.globalAlpha = i === s.active ? 0.95 : 0.5;
            c.stroke();
            c.globalAlpha = 1;
        }
    }

    const line = (hz, colour, dash, width) => {
        const x = Math.round(xOf(hz)) + 0.5;
        if (x < -1 || x > w + 1) return;
        c.beginPath();
        c.moveTo(x, 0);
        c.lineTo(x, h);
        c.setLineDash(dash.map((d) => d * dpr));
        c.lineWidth = width * dpr;
        c.strokeStyle = colour;
        c.stroke();
        c.setLineDash([]);
    };

    line(0, marks.dial, [4, 4], 1);

    // Each marker wears its number. With one demodulator that is a redundant
    // label; with six it is what carries the identity, since six hues that avoid
    // the trace's blue leave about thirty degrees between neighbours at the
    // closest. Drawn from the first demodulator rather than only once there is
    // more than one: the picture should not change shape as one is added.
    const tag = (i, x) => {
        const label = VFO_LABELS[i] || String(i + 1);
        const pad = 3 * dpr;
        c.font = `${Math.round(9 * dpr)}px var(--mono), monospace`;
        const tw = c.measureText(label).width;
        const bw = tw + pad * 2;
        const bh = 12 * dpr;
        // Kept inside the picture: a marker against either edge would otherwise
        // hang its label off the end.
        const bx = Math.max(0, Math.min(w - bw, x - bw / 2));
        c.fillStyle = colours[i % colours.length];
        c.fillRect(bx, 0, bw, bh);
        c.fillStyle = cssVar('--surface-3', '#1a2130');
        c.textBaseline = 'middle';
        c.fillText(label, bx + pad, bh / 2);
    };

    // Where each ECSS tracker has actually found its carrier — dashed, in the
    // demodulator's colour, because it is a measurement rather than a setting
    // and is usually a few tens of hertz from the marker that was set.
    const carriers = s.carriers || [];
    for (let i = 0; i < vfos.length; i++) {
        if (carriers[i] == null) continue;
        line(carriers[i], colours[i % colours.length], [2, 2], 1);
    }

    const order = vfos.map((v, i) => i).sort((a, b) => (a === s.active ? 1 : b === s.active ? -1 : 0));
    for (const i of order) {
        const x = xOf(vfos[i].offsetHz);
        line(vfos[i].offsetHz, colours[i % colours.length], [], i === s.active ? 1.6 : 1);
        if (x >= -1 && x <= w + 1) tag(i, x);
    }
}

/**
 * Where this demodulator is listening, as a reading and as a place to type one.
 *
 * A frequency you can read but not enter is half a control. The offset slider
 * and the picture are both relative — "somewhere left of the dial" — and the
 * number an operator actually has is absolute: a net on 7.1585, a beacon on
 * 14.1, something a friend has just given them over the air. Converting that to
 * an offset in their head, twice, is the friction this removes.
 *
 * It is the shared kHz box (components/FreqEntry.jsx), so it accepts exactly
 * what the dial does — a bare number is kHz, explicit units still work — and
 * commits and abandons the same way. What differs is the range: a demodulator
 * can only be moved within the twelve kilohertz the stream carries, and only as
 * far as leaves its passband inside that, so the window is narrower than the
 * dial's and moves with the dial. Out of it is refused rather than clamped, for
 * the reason FreqEntry gives: clamping turns a slip into a silent retune to
 * somewhere nobody asked for, and the number is still on screen to be corrected.
 */
export function ListeningCard({ listening, dialHz, limits, onTune }) {
    const [editing, setEditing] = useState(false);
    const lo = dialHz + Math.round(limits.min);
    const hi = dialHz + Math.round(limits.max);
    const inRange = (hz) => Number.isFinite(hz) && hz >= lo && hz <= hi;
    const hint = `Frequency in kHz, ${lo / 1000} to ${hi / 1000} — inside the stream`;

    return (
        <div className="readout">
            <div className="readout__label">Listening</div>
            {editing ? (
                <FreqEntry
                    frequency={listening}
                    className="readout__value iq-freq"
                    inRange={inRange}
                    hint={hint}
                    onDone={(hz) => {
                        setEditing(false);
                        if (hz != null) onTune(hz);
                    }}
                />
            ) : (
                <button
                    type="button"
                    className="readout__value iq-freq__open"
                    title={`${hint} — press to type one`}
                    onClick={() => setEditing(true)}
                >
                    <span className="readout__num">{formatFreqExact(listening)}</span>
                </button>
            )}
        </div>
    );
}

/**
 * What the ECSS tracker is doing, in words.
 *
 * The mode is meant to need no attention, so this is a report rather than a
 * control: whether there is a carrier, where it is, and which sideband is being
 * heard — which in Auto is the one thing the operator did not choose and may
 * want to know.
 */
export function ecssReport(ecss, vfo, dialHz) {
    if (!ecss) return { text: '—', tone: undefined, carrier: null, side: null };
    const side = ecss.side === 'both' ? 'both' : ecss.side === 'lsb' ? 'LSB' : 'USB';
    const carrier = ecss.carrierHz == null ? null : dialHz + vfo.offsetHz + ecss.carrierHz;
    switch (ecss.state) {
        case 'locked': return { text: 'Locked', tone: 'good', carrier, side };
        // Still locked in every sense the audio cares about: the carrier has
        // faded and the loop is coasting on the frequency it had.
        case 'hold': return { text: 'Holding', tone: 'ok', carrier, side };
        case 'acquire': return { text: 'Locking', tone: 'weak', carrier, side };
        // Plain sideband at the offset until a carrier turns up.
        default: return { text: 'Searching', tone: 'weak', carrier: null, side };
    }
}

// How far the carrier has to move from the figure on screen before the figure
// changes. Three quarters of a hertz: a carrier sitting on a half cannot flip
// the last digit back and forth, and a real move of a hertz still shows.
export const READING_HYSTERESIS_HZ = 0.75;

/**
 * The whole-hertz reading to show for `hz`, given what is on screen already.
 *
 * Kept while the measurement stays within the hysteresis of it, so the
 * reading changes when the carrier moves and not when the measurement
 * wobbles. Null in, null out: no carrier is no reading.
 */
export function holdReading(shown, hz, hysteresis = READING_HYSTERESIS_HZ) {
    if (hz == null || !Number.isFinite(hz)) return null;
    if (shown != null && Math.abs(hz - shown) < hysteresis) return shown;
    return Math.round(hz);
}

/**
 * ECSS's own controls: which sideband, how far to look for the carrier, and
 * what the tracker has found.
 *
 * Both controls have defaults that are right for a broadcast — Both, and a
 * window a click on the picture lands inside — so on arrival the mode works
 * without either being touched. The window is the one set-once control and
 * goes in the minimal view with the gain.
 *
 * SAM shares the tracker and so the readouts and the window, but not the
 * sideband: it always hears both, equally.
 */
function EcssControls({ vfo, ecss, dialHz, minimal, set }) {
    const report = ecssReport(ecss, vfo, dialHz);
    const shown = useRef(null);
    shown.current = holdReading(shown.current, report.carrier);
    return (
        <>
            {vfo.mode === 'ecss' && (
                <Field
                    label="Sideband"
                    hint={report.side ? `hearing ${report.side}` : undefined}
                >
                    <Segmented
                        options={SIDEBAND_OPTIONS}
                        value={vfo.sideband}
                        onChange={(sideband) => set({ sideband })}
                        size="sm"
                        columns={SIDEBAND_OPTIONS.length}
                    />
                </Field>
            )}
            <div className="readout-grid">
                <Readout label="Carrier" value={report.text} tone={report.tone} />
                <Readout
                    label="Carrier at"
                    value={shown.current == null ? '—' : formatFreqExact(shown.current)}
                />
            </div>
            {!minimal && (
                <Field label="Tracking range" hint={`±${vfo.trackHz} Hz of the offset`}>
                    <Slider
                        value={vfo.trackHz}
                        min={TRACK_MIN}
                        max={TRACK_MAX}
                        step={10}
                        onChange={(trackHz) => set({ trackHz })}
                    />
                </Field>
            )}
        </>
    );
}

/**
 * One demodulator: its row, and its controls when it is open.
 *
 * The head is a glance and two controls; the body is everything else. Pan and
 * mute live in the head rather than the body deliberately — see the note at the
 * top of this file.
 *
 * `active` and `open` are two different things and the row shows both. Active is
 * which demodulator the picture is aimed at — the one a press on the canvas
 * moves, and the one drawn brightest. Open is whether this row's controls are
 * showing, which is per row and independent: pressing the header of the active
 * row closes it without giving up the aim.
 */
/**
 * Where one demodulator is heard: the receiver's own output, or a device of its
 * own. Pan still applies on its own device — two demodulators can share a pair
 * of headphones, one in each ear, while a third plays on the speakers.
 *
 * Not drawn at all where the browser cannot send part of a page to one device
 * and the rest to another; the Audio panel's Output says why for the whole
 * receiver, and saying it again in every row would be six copies of the same
 * sentence.
 */
function VfoOutput({ vfo, set, error }) {
    const supported = useMemo(elementSinkSupport, []);
    const { devices, refresh } = useOutputDevices(supported);
    if (!supported) return null;
    const id = vfo.sinkId || '';
    const known = !id || devices.some((d) => d.deviceId === id);
    return (
        <>
            <Field label="Output">
                {/* Clicking it does what the Audio panel's Refresh does — re-read,
                    and ask for the microphone if the names are still hidden.
                    Focus from the keyboard re-reads quietly: names unlocked
                    elsewhere since this row was drawn are a devicechange the
                    browser does not always send. */}
                <select
                    className="select"
                    value={id}
                    onPointerDown={() => refresh(true)}
                    onFocus={() => refresh(false)}
                    onChange={(e) => set({ sinkId: e.target.value })}
                >
                    <option value="">Receiver output</option>
                    {devices
                        .filter((d) => d.deviceId)
                        .map((d) => (
                            <option key={d.deviceId} value={d.deviceId}>
                                {d.deviceId === 'default' ? 'System Default' : sinkLabel(d)}
                            </option>
                        ))}
                    {!known && <option value={id}>Saved device …{id.slice(-6)}</option>}
                </select>
            </Field>
            {error && (
                <div className="note note--tight note--warn">
                    That device could not be used ({error}) — playing on the receiver’s output instead.
                </div>
            )}
        </>
    );
}

function VfoRow({
    index, vfo, active, level, signalDb, gateOpen, taps, dialHz, minimal, canRemove, source, armed,
    ecss, sinkError,
}) {
    const mode = demodMode(vfo.mode);
    const width = vfoWidth(vfo);
    const limits = offsetLimits(vfo.mode, width, vfo.sideband);
    const band = vfoPassband(vfo);
    const set = (patch) => updateVfo(index, patch);
    const open = vfo.open !== false;
    const listening = dialHz + vfo.offsetHz;
    const squelched = vfo.squelchDb > SQUELCH_OFF;
    const shut = squelched && !gateOpen;
    // The audio meter's reading, in the same unit as the signal meter's so the
    // two lines can be read one after the other. The bar itself is linear in
    // amplitude and full at the AGC's target, which is a different scale from
    // this figure — the bar is for watching and the number is for reading, and
    // a decibel is what an operator would say either of them in.
    const audioDb = level > 0 ? 20 * Math.log10(level) : null;

    // What the head gives up as the dock narrows, in the order it gives it up.
    //
    // The frequency is the one to keep and everything here is arranged around
    // that. It is the number an operator has in their head and the one they
    // would read out to somebody, and on a *collapsed* row it is the only place
    // that number appears — an open row repeats it in the body, so this is a
    // question about rows that are shut.
    //
    // Which is why a shut row will give up more to hold on to it. In keep order,
    // last going first:
    //
    //   offset      a relative figure the picture already draws as a line, and
    //               the body repeats whenever the row is open.
    //   bandwidth   a readout. The mode beside it stays whatever happens — USB
    //               against LSB is not a detail — and the whole summary is on
    //               the mode's tooltip once the width has gone.
    //   pan         a control, and the reason it outlasts the bandwidth: it is
    //               half of what makes several demodulators usable at once. It
    //               is not lost with the row either — opening the row brings it
    //               back, since an open row never drops it.
    //   frequency   last, and only when the row cannot hold anything at all.
    //
    // An open row keeps the pan and the bandwidth at any width, so only the two
    // readings are optional there. That is the whole of the difference, and it
    // is why the spec list is built from `open`.
    //
    // Same mechanism as the top bar's optional tags; see lib/roomFor.js, whose
    // one rule this layout has to hold up: every child counted here is either
    // `flex: none` or discounted, which for the head means the button — it
    // grows to fill the row, and the spacer inside it is what roomFor takes off
    // to get back to its content.
    const headBox = useRef(null);
    const headH = useBoxHeight(headBox, HEAD_H);
    const room = useRoomFor(headBox, open ? [
        { key: 'freq', width: FREQ_TAG_W },
        { key: 'offset', width: OFFSET_TAG_W },
    ] : [
        { key: 'freq', width: FREQ_TAG_W },
        { key: 'pan', width: PAN_TAG_W },
        { key: 'bw', width: BW_TAG_W },
        { key: 'offset', width: OFFSET_TAG_W },
    ]);
    // Absent only when a measurement has actually said so. A key that has just
    // joined the list has not been measured yet, and a child that is never on
    // screen is a child whose real width is never learned — so the first answer
    // is always "show it", and the measurement that follows decides.
    const has = (key) => room[key] !== false;

    // Coarse enough that the slider crosses twelve kilohertz in a drag, fine
    // enough to land on a carrier: ten hertz is a fifth of the narrowest CW
    // filter offered and well inside any voice passband.
    const widthStep = mode.min < 500 ? 10 : 50;
    // 2 where the width is a total across the carrier and the panel shows a
    // sideband of it — AM and SAM. See DEMOD_MODES.
    const sides = mode.sides || 1;
    // USB and LSB have a low cut as well as a width: a filter from one to the
    // other, both measured from the carrier, set on one double-ended slider.
    const ssb = vfo.mode === 'usb' || vfo.mode === 'lsb';
    const lowCut = ssb ? clampLowCut(vfo.lowCutHz, width) : 0;
    // What the filter actually passes: the gap between the edges on a sideband
    // mode, the audio a side on the AM family, the width elsewhere.
    const passes = ssb ? width - lowCut : width / sides;

    return (
        <div
            className={`iq-vfo${active ? ' is-active' : ''}${open ? ' is-open' : ''}${vfo.muted ? ' is-muted' : ''}${shut ? ' is-shut' : ''}`}
            style={{ '--vfo': `var(--iq-vfo-${(index % MAX_VFOS) + 1})` }}
        >
            <div className="iq-vfo__head" ref={headBox}>
                <button
                    type="button"
                    className="iq-vfo__pick"
                    aria-expanded={open}
                    onClick={() => toggleVfo(index)}
                    title={active
                        ? (open ? 'Hide these controls' : 'Show this demodulator’s controls')
                        : 'Edit this demodulator'}
                >
                    {open ? <Icon.ChevronUp /> : <Icon.Chevron />}
                    <i className="iq-vfo__swatch" />
                    <span className="iq-vfo__name">{VFO_LABELS[index]}</span>
                    {/* The mode always, the width beside it while there is room.
                        The tooltip is the pair of them, so a row that has given
                        the width up can still be asked. */}
                    <span className="iq-vfo__sum" title={vfoSummary(vfo)}>{mode.label}</span>
                    {has('bw') && (
                        <span className="iq-vfo__bw" data-optional={open ? undefined : 'bw'}>
                            {widthLabel(width)}
                        </span>
                    )}
                    {has('offset') && (
                        <span className="iq-vfo__off" data-optional="offset">
                            {`· ${offsetLabel(vfo.offsetHz)}`}
                        </span>
                    )}
                    {has('freq') && (
                        <span className="iq-vfo__freq" data-optional="freq">
                            {formatFreqExact(listening)}
                        </span>
                    )}
                    <i className="iq-vfo__slack" data-slack />
                </button>
                {has('pan') && (
                    <span className="iq-vfo__panbox" data-optional={open ? undefined : 'pan'}>
                        <Segmented
                            className="iq-vfo__pan"
                            options={PANS}
                            value={vfo.pan}
                            onChange={(pan) => set({ pan })}
                            size="sm"
                        />
                    </span>
                )}
                <button
                    type="button"
                    className={`iq-vfo__mute${vfo.muted ? ' is-muted' : ''}`}
                    aria-pressed={vfo.muted}
                    title={vfo.muted ? 'Muted — press to hear it again' : 'Mute this demodulator'}
                    onClick={() => set({ muted: !vfo.muted })}
                >
                    {vfo.muted ? <Icon.Mute /> : <Icon.Volume />}
                </button>
                {/* Last, at the edge of the row, and set apart from the mute
                    beside it: the two are the same size and a thumb's width
                    apart, and one of them cannot be undone by pressing it
                    again. Disabled rather than hidden on the only demodulator —
                    a control that comes and goes as you add and remove is
                    harder to aim at than one that greys out. */}
                <button
                    type="button"
                    className="iq-vfo__del"
                    disabled={!canRemove}
                    title={canRemove
                        ? `Remove demodulator ${VFO_LABELS[index]}`
                        : 'The last demodulator cannot be removed'}
                    onClick={() => removeVfo(index)}
                >
                    <Icon.Trash size={13} />
                </button>
            </div>

            {/* And in the minimal view, where there is no shared picture above
                the rows, this row's own: the same spectrum cropped to this
                demodulator's passband, the height of the header it sits under.
                See VfoStrip. */}
            {minimal && (
                <VfoStrip
                    source={source}
                    vfo={vfo}
                    index={index}
                    armed={armed}
                    height={Math.max(1, Math.round(headH * STRIP_SHARE))}
                />
            )}

            {/* The row's own underline, and it is two meters rather than one:
                what is arriving and what is coming out.

                They are different questions and a single bar could only answer
                one of them. The audio level says what you are hearing, which
                goes to nothing when the row is muted or the squelch has shut —
                and at that point the first question, the one you ask of a
                demodulator you are not editing, has no meter left to answer it.
                So the signal meter sits above it, reading the passband before
                any of that is applied: something is on this one, and here is
                what is being done with it.

                In that order because it is the order the signal travels, and it
                is why the threshold mark is on the upper bar — the squelch is a
                decision about the input, so it belongs on the meter of the
                input. Every row has both, open or not.

                Named and read out only while the row is open, and that is the
                one difference between the two forms. Collapsed, these are an
                underline: six rows of them are a glance down a column, and six
                pairs of labels would be text where the point was that there is
                none. Open, the row is being worked on rather than scanned, and
                a bar whose units nobody can name is a bar nobody can act on —
                so each grows a name and the figure it is showing. */}
            <div className={`iq-vfo__meters${open ? ' is-labelled' : ''}`}>
                <div className="iq-vfo__meter">
                    {open && <span className="iq-vfo__meter-name">Signal</span>}
                    <div
                        className="iq-vfo__signal"
                        title={signalDb == null
                            ? 'Signal in this demodulator’s passband'
                            : `Signal in this demodulator’s passband: ${Math.round(signalDb)} dBFS`}
                    >
                        <i style={{ width: `${signalMeter(signalDb) * 100}%` }} />
                        {squelched && (
                            <b
                                style={{ left: `${signalMeter(vfo.squelchDb) * 100}%` }}
                                title={`Squelch at ${vfo.squelchDb} dBFS`}
                            />
                        )}
                    </div>
                    {open && <span className="iq-vfo__meter-val">{levelLabel(signalDb)}</span>}
                </div>
                <div className="iq-vfo__meter">
                    {open && <span className="iq-vfo__meter-name">Audio</span>}
                    {/* Open, the spectrum of the audio; shut, the bar it always was. */}
                    {open ? (
                        <AudioScope index={index} vfo={vfo} source={source} armed={armed} />
                    ) : (
                        <div className="iq-vfo__level" title="What this demodulator is putting out">
                            <i style={{ width: `${Math.min(100, level * 400)}%` }} />
                        </div>
                    )}
                    {open && <span className="iq-vfo__meter-val">{levelLabel(audioDb)}</span>}
                </div>
            </div>

            {open && (
                <div className="iq-vfo__body">
                    <Field label="Offset in stream" hint={offsetLabel(vfo.offsetHz)}>
                        <Slider
                            value={vfo.offsetHz}
                            min={Math.round(limits.min)}
                            max={Math.round(limits.max)}
                            step={10}
                            onChange={(offsetHz) => set({ offsetHz })}
                        />
                    </Field>

                    <Field label="Demodulator">
                        <Segmented
                            options={MODE_OPTIONS}
                            value={vfo.mode}
                            onChange={(m) => set({ mode: m })}
                            size="sm"
                            // Wraps as the receiver's own mode row does: seven
                            // abreast when there is room, two rows in a narrow
                            // dock rather than seven cramped labels.
                            minItemWidth={54}
                        />
                    </Field>

                    {/* The AM family is shown as the audio it carries — the
                        width of a sideband — so AM, SAM and ECSS have the same
                        buttons and the same slider and a figure means the same
                        thing in each. AM and SAM keep their total underneath
                        (see `sides` in DEMOD_MODES); the passband readout after
                        the dot is still where the filter actually sits. */}
                    <Field
                        label="Bandwidth"
                        hint={`${formatSpan(passes)}${sides === 2 || vfo.mode === 'ecss' ? ' audio' : ''} · ${offsetLabel(band.lo)} to ${offsetLabel(band.hi)}`}
                    >
                        <Segmented
                            options={modeWidths(vfo.mode).map((w) => ({ value: w, label: widthLabel(w / sides) }))}
                            value={width}
                            onChange={(w) => set({ widths: { [vfo.mode]: w } })}
                            size="sm"
                            // Wraps rather than squeezing: a wide stream adds two
                            // more to the AM family's five.
                            minItemWidth={44}
                        />
                    </Field>
                    {ssb ? (
                        // The left thumb is the low cut, the right one the
                        // width the buttons above set. The top edge is held at
                        // the mode's narrowest so it cannot be dragged below a
                        // filter the mode will take.
                        <RangeSlider
                            low={lowCut}
                            high={width}
                            min={0}
                            max={modeMax(vfo.mode)}
                            step={widthStep}
                            gap={SSB_MIN_SPAN}
                            format={(v) => `${formatSpan(v)} from the carrier`}
                            onChange={({ low, high }) => set({
                                lowCutHz: low,
                                widths: { [vfo.mode]: Math.max(mode.min, high) },
                            })}
                        />
                    ) : (
                        <Slider
                            value={width / sides}
                            min={mode.min / sides}
                            max={modeMax(vfo.mode) / sides}
                            step={widthStep}
                            onChange={(w) => set({ widths: { [vfo.mode]: w * sides } })}
                        />
                    )}
                    {(vfo.mode === 'cwl' || vfo.mode === 'cwu') && (
                        <Field label="CW pitch" hint={`${vfo.pitchHz} Hz`}>
                            <Slider
                                value={vfo.pitchHz}
                                min={PITCH_MIN}
                                max={PITCH_MAX}
                                step={10}
                                onChange={(pitchHz) => set({ pitchHz })}
                            />
                        </Field>
                    )}

                    {(vfo.mode === 'ecss' || vfo.mode === 'sam') && (
                        <EcssControls vfo={vfo} ecss={ecss} dialHz={dialHz} minimal={minimal} set={set} />
                    )}

                    {/* Per demodulator, and it has to be: the whole point of
                        six of them is that they are on six different signals,
                        and one threshold across the bank would be set by
                        whichever of them was quietest.

                        The marker is the level in this demodulator's passband
                        right now, in the slider's own units, so the threshold
                        is set by putting the thumb where the marker is not —
                        and the same two figures are the red line and the trace
                        on the picture above. Kept in the minimal view: a
                        squelch is something you adjust while listening, which
                        is the test that view applies. */}
                    <Field
                        label="Squelch"
                        hint={!squelched ? 'Off'
                            : `${vfo.squelchDb} dBFS${signalDb == null ? '' : shut ? ' · closed' : ' · open'}`}
                    >
                        <Slider
                            value={vfo.squelchDb}
                            min={SQUELCH_OFF}
                            max={SQUELCH_MAX}
                            step={1}
                            onChange={(squelchDb) => set({ squelchDb })}
                            marker={signalDb == null ? null : signalDb}
                            markerTone={shut ? 'closed' : 'open'}
                            markerTitle={signalDb == null ? undefined
                                : `In the passband now: ${Math.round(signalDb)} dBFS`}
                        />
                    </Field>

                    <div className="readout-grid">
                        <ListeningCard
                            listening={listening}
                            dialHz={dialHz}
                            limits={limits}
                            onTune={(hz) => set({ offsetHz: hz - dialHz })}
                        />
                        <Readout label="Filter" value={taps} unit="taps" />
                    </div>

                    {!minimal && (
                        <>
                            <Switch
                                checked={vfo.agc}
                                onChange={(agc) => set({ agc })}
                                label="Automatic gain"
                                title="Levels this demodulator. Without it the gain below is the only control; with it, that slider sets the level."
                            />
                            {/* Applied after the AGC as well as without it
                                (DemodChain.process), so with the AGC on it is
                                how loud the levelled audio is, not a gain. */}
                            <Field label={vfo.agc ? 'Level' : 'Gain'} hint={`${vfo.gain.toFixed(2)}×`}>
                                <Slider
                                    value={vfo.gain}
                                    min={0}
                                    max={4}
                                    step={0.05}
                                    onChange={(gain) => set({ gain })}
                                />
                            </Field>
                            <VfoOutput vfo={vfo} set={set} error={sinkError} />
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * `minimal` keeps what you operate — the picture, the rows, and for the open one
 * where it is listening, how wide and where the squelch is — and drops what you
 * set once: the gain and the AGC. See the registry's `minimal`.
 */
export default function IQPanel({ minimal }) {
    const { running, audioState, tuning, actions, player, allowedIQModes } = useRadio();
    // The wide IQ presets this visit may use. The row of widths under the
    // picture only appears when there is one: with plain IQ's 12 kHz alone
    // there is nothing to choose between.
    const allowed = allowedIQModes || [];
    const widths = WIDE_IQ_MODES.some((m) => allowed.includes(m.id));
    const display = useDisplay();
    const touch = useMediaQuery(TOUCH_QUERY);
    const maxFps = resolveMaxFps(display.maxFps, touch);
    // The same two colours the main spectrum marks the dial and the passband
    // edges with, so a mark means the same thing in both pictures.
    const marks = markColors(display);
    const demod = getIQDemod(player);
    const iq = isIQ(tuning.mode);
    const live = running && audioState === 'open';
    // One transform for whichever picture is on screen — the full scope, or a
    // strip in every row. See useIQFrames.
    const source = useIQFrames(player, live, iq, maxFps);

    // The engine is not React state, so a change on it has to be turned into a
    // render by hand — the recorder panel does the same over the same kind of
    // object.
    const [, bump] = useReducer((n) => n + 1, 0);
    useEffect(() => demod.on('change', bump), [demod]);
    useEffect(() => onDemodSettings(bump), []);

    // The header's minimal toggle works the rows as well as the panel, in both
    // directions.
    //
    // Going minimal is a request for less of this panel, and with several
    // demodulators open the rows are most of its height — so trimming the gain
    // and the AGC off the bottom of each of them and leaving all of them
    // expanded would answer that request with the smaller half of it. Every row
    // shuts.
    //
    // Coming back out is the same request in reverse and gets the same
    // treatment, but only for the selected row: that is the one the picture is
    // aimed at and the one every other control acts on, so it is the row a
    // person is coming back for. Reopening all of them would be restoring a
    // state nobody asked to have restored, and this does not remember which
    // were open anyway.
    //
    // Both fire on the *change* and not on the state, and that distinction is
    // the whole of the ref: the panel is unmounted and remounted whenever its
    // section is collapsed, or moved between docks, or drawn a second time in a
    // floating window, so an effect keyed on the value would work the rows on
    // every one of those — closing rows somebody had opened, or reopening one
    // they had just shut.
    const wasMinimal = useRef(minimal);
    useEffect(() => {
        const was = wasMinimal.current;
        wasMinimal.current = minimal;
        if (minimal === was) return;
        if (minimal) collapseVfos();
        else expandActiveVfo();
    }, [minimal]);

    const on = demod.running;
    useEffect(() => {
        if (!on) return undefined;
        const t = setInterval(bump, METER_MS);
        return () => clearInterval(t);
    }, [on]);

    const s = demod.settings;
    const { vfos, active } = s;
    const hearing = on && demod.quadrature;

    // Start remembers where the operator was, so stopping does not strand them
    // in a mode that plays broadband noise. Asking for IQ from a listening mode
    // puts a confirmation up rather than switching immediately — the engine will
    // not touch the stream until the mode has actually arrived, which is what
    // IQDemodWatch's quadrature flag is for.
    const start = () => {
        demod.restoreMode = iq ? null : tuning.mode;
        if (!iq) actions.setMode('iq');
        demod.start();
    };

    // Stopping puts the mode back, but only if the receiver is still where we
    // put it: if the operator has since chosen a mode themselves, that is the
    // one they want. Same rule as the DRM panel's.
    const stop = () => {
        const back = demod.restoreMode;
        demod.restoreMode = null;
        demod.stop();
        if (back && isIQ(tuning.mode)) actions.setMode(back);
    };

    return (
        <div className="stack">
            {!live && (
                <div className="note note--tight">
                    Start the receiver to demodulate its quadrature stream.
                </div>
            )}

            <div className="iq-run">
                <Button
                    size="sm"
                    variant={on ? 'default' : 'primary'}
                    icon={on ? <Icon.Stop /> : <Icon.Play />}
                    disabled={!live}
                    onClick={on ? stop : start}
                >
                    {on ? 'Stop' : 'Start'}
                </Button>
                <span className="iq-run__hint">
                    {!on ? (iq ? 'Ready — the receiver is in IQ.' : 'Starting will switch the receiver to IQ.')
                        : hearing ? `Demodulating ${vfos.length > 1 ? `${vfos.length} signals ` : ''}in the browser.`
                            : 'Waiting for the quadrature stream…'}
                </span>
            </div>

            {/* The picture first: it is the map every row below is a legend for,
                and the control the offsets are actually set with.

                Dropped in the minimal view, where a dock column has something
                else in it — but not simply dropped: each row grows a strip of
                its own passband instead, so the one thing this picture does
                that nothing else can, showing a demodulator where its filter is
                sitting, survives the trim. */}
            {!minimal && (
                <IQScope
                    dialHz={tuning.frequency}
                    source={source}
                    live={live}
                    iq={iq}
                    running={on}
                    vfos={vfos}
                    active={active}
                    onOffset={(index, offsetHz) => updateVfo(index, { offsetHz })}
                    onPick={selectVfo}
                    marks={marks}
                    carriers={vfos.map((v, i) => {
                        const e = hearing ? demod.ecssOf(i) : null;
                        return e && e.locked ? v.offsetHz + e.carrierHz : null;
                    })}
                />
            )}

            {/* The same row the Receiver panel's IQ button opens. A tune, so
                the picture, the reach and the passbands follow on the next
                packet; from a listening mode it goes through the IQ
                confirmation like any other way in. */}
            {!minimal && widths && (
                <IQWidths
                    mode={tuning.mode}
                    allowed={allowed}
                    onChoose={(id) => { if (id !== tuning.mode) actions.setMode(id); }}
                />
            )}

            <div className="iq-vfos">
                {vfos.map((vfo, i) => (
                    <VfoRow
                        key={i}
                        index={i}
                        vfo={vfo}
                        active={i === active}
                        level={hearing ? demod.levelOf(i) : 0}
                        signalDb={hearing ? demod.signalDbOf(i) : null}
                        gateOpen={hearing ? demod.gateOpenOf(i) : true}
                        taps={tapsFor(planForVfo(vfo).cutoffHz, workingRate(demod.rate || 12000, planForVfo(vfo)), planForVfo(vfo).transitionHz)}
                        ecss={hearing ? demod.ecssOf(i) : null}
                        sinkError={demod.sinkErrorOf(i)}
                        dialHz={tuning.frequency}
                        minimal={minimal}
                        canRemove={vfos.length > 1}
                        source={source}
                        armed={live && iq}
                    />
                ))}
                {vfos.length < MAX_VFOS && (
                    <Button
                        className="iq-add"
                        size="sm"
                        variant="ghost"
                        icon={<Icon.Plus />}
                        onClick={() => addVfo()}
                    >
                        Add demodulator
                    </Button>
                )}
            </div>
        </div>
    );
}

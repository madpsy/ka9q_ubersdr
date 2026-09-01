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

import React, { useEffect, useLayoutEffect, useReducer, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { resolveMaxFps, useDisplay } from '../display/DisplayContext.jsx';
import { markColors } from '../display/uiConfig.js';
import { TOUCH_QUERY, useMediaQuery } from '../lib/useMediaQuery.js';
import { Button, Field, Icon, Readout, Segmented, Slider, Switch } from '../components/ui.jsx';
import FreqEntry from '../components/FreqEntry.jsx';
import { isIQ } from '../radio/constants.js';
import { formatFreqExact, formatSpan } from '../lib/format.js';
import { haptic } from '../lib/haptics.js';
import { useRoomFor } from '../lib/useRoomFor.js';
import { cssVar, sizedCanvas } from '../lib/audioWaterfall.js';
import { createLevels, updateLevels } from '../lib/ifSpectrum.js';
import {
    IQSpectrum, aimCancel, aimDown, aimMove, aimUp, binsToPixels, fractionOffset, markerAt,
    newAim, offsetFraction, squelchLineDb,
} from '../lib/iqSpectrum.js';
import {
    DEMOD_MODES, MAX_VFOS, PANS, PITCH_MAX, PITCH_MIN, SQUELCH_MAX, SQUELCH_OFF, VFO_LABELS,
    addVfo, collapseVfos, demodMode, expandActiveVfo, getIQDemod, offsetLimits, onDemodSettings,
    planForVfo, removeVfo, selectVfo, signalMeter, tapsFor, toggleVfo, updateVfo, vfoPassband,
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
        return source.subscribe((bins, dt) => drawStrip(ref.current, st.current, bins, dt));
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
function IQScope({ source, live, iq, running, vfos, active, onOffset, onPick, marks }) {
    const ref = useRef(null);
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

    useEffect(() => {
        st.current.levels = createLevels();
        if (!live || !iq) return undefined;
        return source.subscribe((bins, dt) => draw(ref.current, st.current, bins, dt, marks));
    }, [source, live, iq, marks.dial, marks.edge]);

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
    const move = (e) => act(e, aimMove(st.current.aim, e));
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
            <canvas
                ref={ref}
                className={`iq-scope__canvas${running ? ' is-live' : ''}`}
                style={{ height: `${SCOPE_H}px` }}
                title="Press or drag to move a demodulator; press a marker to pick that one up"
                onPointerDown={down}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={cancel}
            />
            {!(live && iq) && (
                <div className="iq-scope__veil">
                    {live ? 'The receiver is not in IQ.' : 'The receiver is off.'}
                </div>
            )}
            <div className="iq-scope__scale">
                <span>−6 kHz</span>
                <span>dial</span>
                <span>+6 kHz</span>
            </div>
        </div>
    );
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
function VfoRow({
    index, vfo, active, level, signalDb, gateOpen, taps, dialHz, minimal, canRemove, source, armed,
}) {
    const mode = demodMode(vfo.mode);
    const width = vfoWidth(vfo);
    const limits = offsetLimits(vfo.mode, width);
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
                    <div className="iq-vfo__level" title="What this demodulator is putting out">
                        <i style={{ width: `${Math.min(100, level * 400)}%` }} />
                    </div>
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
                            columns={5}
                        />
                    </Field>

                    <Field
                        label="Bandwidth"
                        hint={`${formatSpan(width)} · ${offsetLabel(band.lo)} to ${offsetLabel(band.hi)}`}
                    >
                        <Segmented
                            options={mode.widths.map((w) => ({ value: w, label: widthLabel(w) }))}
                            value={width}
                            onChange={(w) => set({ widths: { [vfo.mode]: w } })}
                            size="sm"
                            columns={mode.widths.length}
                        />
                    </Field>
                    <Slider
                        value={width}
                        min={mode.min}
                        max={mode.max}
                        step={widthStep}
                        onChange={(w) => set({ widths: { [vfo.mode]: w } })}
                    />

                    {vfo.mode === 'cw' && (
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
                                title="Levels this demodulator. Without it the gain below is the only control."
                            />
                            <Field label="Gain" hint={`${vfo.gain.toFixed(2)}×`}>
                                <Slider
                                    value={vfo.gain}
                                    min={0}
                                    max={4}
                                    step={0.05}
                                    onChange={(gain) => set({ gain })}
                                />
                            </Field>
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
    const { running, audioState, tuning, actions, player } = useRadio();
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
                    source={source}
                    live={live}
                    iq={iq}
                    running={on}
                    vfos={vfos}
                    active={active}
                    onOffset={(index, offsetHz) => updateVfo(index, { offsetHz })}
                    onPick={selectVfo}
                    marks={marks}
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
                        taps={tapsFor(planForVfo(vfo).cutoffHz, demod.rate || 12000)}
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

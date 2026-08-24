// The few kilohertz either side of the dial, drawn five ways.
//
// A receiver's IF display is the close-up: the main waterfall says where in the
// band you are, and this says where in the *signal* you are — whether the
// carrier is centred, what is about to walk into the passband, how far off a CW
// note you have landed. It is deliberately not a second waterfall at a different
// zoom: it follows the dial, it is shaped like the mode you are listening in —
// AM's window straddles the carrier, USB's sits above it, LSB's below — and its
// scale is marked in offsets rather than in megahertz, so 0 means "what I am
// listening to" and stays there while you tune.
//
// It costs the receiver nothing. There is one spectrum stream per session and
// this pane reads the frames the main display is already receiving, cuts the
// window out of them and stretches it across the panel — see lib/ifSpectrum.js,
// which is where the window rule, the resampling and the level tracking live.
//
// The one thing that is not free is *resolution*: the window is a few kHz of a
// view whose bins are as wide as the main display's zoom makes them, so at full
// zoom-out there is a fraction of one bin inside it and all this could honestly
// draw is a smooth interpolation of a single measurement. So it does not — it
// draws the interpolation and puts a cover over it saying how much further the
// main display has to zoom, with the button that does it. Same for a main view
// panned off the dial, where there are no bins here at all. See paneState, and
// the Veil at the foot of this file.
//
// `minimal` is the picture on its own — no readout, no controls. Everything
// still applies, it is just not on show; the only text that survives is the line
// that explains a *blank* pane, because one that says nothing reads as a fault.

import React, { useCallback, useEffect, useMemo, useRef, useState } from '../react.js';
import {
    Button, Field, Icon, RangeSlider, Readout, Segmented, Slider, Switch,
} from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import { markColors } from '../display/uiConfig.js';
import { getPalette } from '../lib/palettes.js';
import { GRAD_STOPS, TRACE_FLOOR, TRACE_WIDTH, paletteGradients, themeColors } from '../lib/spectrumTrace.js';
import { RING_BG, RING_PAD, ringSlices, smoothInterval } from '../lib/waterfallRing.js';
import { retentionFor } from '../lib/timeConstant.js';
import { readoutClearsOn, tipPlacement } from '../lib/hoverTip.js';
import { haptic } from '../lib/haptics.js';
import {
    onSpectrumPaused, resumeSpectrum, setSpectrumPaused, spectrumPaused,
} from '../lib/spectrumPause.js';
import { throttle } from '../lib/throttle.js';
import { clamp, formatFreqExact, formatHz, formatSpan } from '../lib/format.js';
import { MAX_FREQ, MIN_FREQ } from '../radio/constants.js';
import {
    SHAPE_BINS, SHAPE_MIN_ROWS, SHAPE_SEC_MAX, SHAPE_SEC_MIN,
    bandBins, clampShapeSec, createShape, formatShape, measureShape, pushShapeRow, resetShape,
    shapeStats, shapeWantsZoom, shapeZoomSpan,
} from '../lib/ifShape.js';
import { FIT_WINDOW_MS, formatFit, rawFit, updateFit } from '../lib/ifFit.js';
import {
    IF_RATE_MAX, IF_RATE_MIN, IF_VIEWS, ZOOM_MIN, ZOOM_STEP,
    binWidthOf, binsInWindow, clampRate, clampZoom, coverageOf, createLevels, formatBinWidth,
    formatOffset, isZoomed, levelsOf, manualLevels, maxZoomFor, normaliseView, offsetTicks,
    paneState, sliceToPixels, updateLevels, viewHas, windowFor, zoomTargetSpan,
} from '../lib/ifSpectrum.js';

// The pane's proportions. Taller than the band panel's card because the window
// is narrow and the interesting axis here is the vertical one — a 60 px trace
// cannot show the 30 dB between a signal and the noise it is sitting in.
const ASPECT = 0.52;
const MIN_H = 130;
const MAX_H = 320;
const SPLIT_TRACE = 0.44;      // share of a split pane the trace takes

// The window is resampled to a fixed width for the history, independent of how
// wide the panel happens to be. That is what lets a dock being widened, a panel
// being floated or a phone being turned keep the waterfall: every stored row
// means the same offsets whatever the canvas is, and the ring is stretched onto
// the canvas as it is drawn. The trace is resampled again at the canvas's own
// device width, because there the sharpness is the point.
const ROW_BINS = 512;

// How often a drag may retune. Each tune reloads a radiod channel, so a pointer
// move per frame is sixty of them a second; forty milliseconds is fast enough
// that the picture tracks the finger and slow enough that the receiver keeps up.
const DRAG_TUNE_MS = 40;

// How often the measured readout is published into React. Four times a second
// reads as live without spending a render on every frame — the same reasoning
// as the hover tooltip's own refresh.
const STATS_MS = 250;

// Theme values this pane reads, through the same cached lookup the main
// spectrum uses — getComputedStyle inside a draw loop costs more than the
// drawing does.
const THEME_VARS = ['--spec-bg', '--spec-grid', '--spec-band', '--warn'];

// The Filter card's long wording, keyed by verdict — the card itself is a
// fixed cell and only has room for a couple of words (see formatFit).
const FIT_TIPS = {
    '': 'Whether the filter fits the signal — measured from the averaged spectrum once a signal is present',
    ok: 'The filter fits the signal',
    narrow: 'The signal continues past the filter edge — widening would stop it being clipped',
    wide: 'The filter is much wider than the signal — narrowing would shut out noise',
    neighbour: 'A second signal is inside the passband — narrowing or shifting would exclude it',
};

// A row with no measurement behind it, as packed ABGR — the waterfall's own
// background, so a window hanging off the end of the served view reads as
// nothing rather than as a floor-level noise that was never received.
const NO_DATA = (255 << 24)
    | (parseInt(RING_BG.slice(5, 7), 16) << 16)
    | (parseInt(RING_BG.slice(3, 5), 16) << 8)
    | parseInt(RING_BG.slice(1, 3), 16);

export default function IFSpectrumPanel({ minimal }) {
    const { tuning, running, spectrumConn, view, actions } = useRadio();
    const display = useDisplay();

    const viewMode = normaliseView(display.ifView);
    // The stored width, held against what the receiver is actually sending.
    //
    // Clamped on the way *out* rather than on the way in, so the operator's
    // choice survives the main display being zoomed in and comes back when it
    // is zoomed out again — the window narrows to follow the data and then
    // reopens, instead of the preference being quietly overwritten by whatever
    // the main view happened to be doing at the time. See maxZoomFor.
    const maxFactor = maxZoomFor(view, tuning);
    const factor = clampZoom(display.ifSpan, maxFactor);
    const has = viewHas(viewMode);
    // Which canvases exist, decided from the view rather than from the measured
    // heights: the measuring is what *sets* those heights, and it needs the
    // canvases to already be in the tree to do it.
    const showTrace = has.trace && !has.merged;

    const wrapRef = useRef(null);
    const specRef = useRef(null);
    const wfRef = useRef(null);
    const ovRef = useRef(null);

    const [size, setSize] = useState({ w: 0, specH: 0, wfH: 0 });
    const [at, setAt] = useState(null);          // the hover readout
    // The spectrum socket asleep — the idle saving, or the toolbar's toggle.
    // Mirrored into state because it changes what this draws: no frames arrive,
    // so the picture is whatever last landed, and saying so is the difference
    // between a paused display and a broken one. The main display carries the
    // same overlay; this offers the same way out of it, because a listener who
    // opened this panel should not have to find the other one to use it.
    const [paused, setPaused] = useState(spectrumPaused);
    useEffect(() => onSpectrumPaused(setPaused), []);
    // The measured numbers, sampled out of the draw loop a few times a second.
    // They are worked out per frame like everything else here, but a readout
    // that re-rendered React ten times a second to move a decimal is a readout
    // that costs more than it says.
    const [measured, setMeasured] = useState(null);

    // The window, recomputed whenever the dial or the filter moves. Memoised
    // only so the effects below can depend on its span without re-running on
    // every tune — the object itself is cheap.
    const win = useMemo(() => windowFor(tuning, factor), [
        tuning.frequency, tuning.bandwidthLow, tuning.bandwidthHigh, factor,   // eslint-disable-line
    ]);

    const binWidth = binWidthOf(view);
    const inWindow = binsInWindow(view, win);
    // Whether the frames arriving can answer the question this pane asks — see
    // paneState. Everything still draws when they cannot; the veil goes over it.
    const state = paneState(view, tuning, running, win, paused);

    // Everything the draw loop reads, on a mutable object rather than in state:
    // spectrum frames never reach React (see the note at the top of
    // components/SpectrumView.jsx) and neither does anything derived from them.
    const st = useRef({
        bins: null,              // the connection's frequency-ordered bins
        frames: 0,               // bumped per frame, so a row knows it is new
        rowFrames: -1,           // the frame the last committed row came from
        cfg: null,               // the served view geometry
        win: null,
        tuning: null,
        d: null,
        marks: { dial: '#ffd166', edge: '#00ff00' },

        px: null,                // the trace at canvas device width
        smoothed: null,
        row: null,               // the same window at ROW_BINS, for the history
        levels: createLevels(),
        drawnAt: 0,

        // The Shape view's own history and its last answer. Fed from the same
        // offset grid the waterfall's rows are on, and only while that view is
        // showing — see lib/ifShape.js.
        shape: createShape(SHAPE_BINS),
        shapeRow: null,
        shapeOut: {},
        stats: null,
        band: null,
        // The measured readout, and the state its peak hysteresis lives in.
        wantStats: false,
        measure: {},
        measured: null,
        measuredAt: 0,
        // The fit verdict's patience — see updateFit in lib/ifFit.js — and its
        // own averaging pass, which is longer and slower than the display's.
        fit: {},
        fitOut: {},
        fitAt: 0,
        fitVerdict: null,

        cmap: null,
        ring: null, ringCtx: null, ringH: 0,
        rowPx: null, rowBuf: null,
        head: 0,
        rowH: 2,
        lastRowAt: 0, rowDt: 0, lastGap: 0,
        smooth: true,
        scroll: null,
        scrolled: true,
        dpr: 1,
        gradKey: '', gradCanvas: null, traceGrad: null, fillGrad: null, mirrorGrad: null,
        raf: 0,
        ptr: null,
        moved: false,
    }).current;

    st.win = win;
    st.cfg = view;
    st.tuning = tuning;
    st.d = display;
    st.marks = markColors(display);
    st.rowH = Math.max(1, Math.round(display.rowHeight || 2));
    st.smooth = display.smoothScroll !== false;
    st.has = has;
    // The averaging runs for the readout as well as for the Shape view, which is
    // what lets the numbers be the same in all six.
    st.wantStats = display.ifStats === true;

    // One draw, on the next animation frame, however many things asked for it.
    //
    // No standing requestAnimationFrame loop. Frames arrive about ten times a
    // second and there is nothing to draw between them — the row slide is a
    // composited transform and runs without us — so a loop that re-armed every
    // frame would keep the browser's frame pipeline running at the display's
    // rate all session for nothing. See the long note in SpectrumView, which is
    // where that was measured.
    const schedule = useCallback(() => {
        if (st.raf) return;
        st.raf = requestAnimationFrame(() => {
            st.raf = 0;
            drawAll(st, specRef.current, wfRef.current, ovRef.current);
            if (st.ptr) {
                const v = readAt(st, wrapRef.current, st.ptr);
                if (v) setAt(v);
            }
            if (st.wantStats) {
                const now = performance.now();
                if (now - st.measuredAt >= STATS_MS) {
                    st.measuredAt = now;
                    setMeasured(st.measured);
                }
            }
        });
    }, [st]);

    useEffect(() => () => { if (st.raf) cancelAnimationFrame(st.raf); }, [st]);

    // ── Data ─────────────────────────────────────────────────────────────────
    //
    // The main display's own frames. Nothing is requested and nothing is sent:
    // this is a second reader of a stream that is already running, and closing
    // the panel simply stops reading it.
    useEffect(() => {
        const off = spectrumConn.on('frame', ({ bins }) => {
            st.bins = bins;
            st.frames++;
            schedule();
        });
        return off;
    }, [spectrumConn, schedule, st]);

    // Anything that moves the picture without a frame behind it: tuning, the
    // filter, the palette, the levels, a resize.
    useEffect(schedule, [
        schedule, tuning.frequency, tuning.bandwidthLow, tuning.bandwidthHigh, tuning.mode,
        viewMode, factor, size.w, size.specH, size.wfH,
        display.palette, display.contrast, display.fill, display.grid, display.smoothing,
        display.ifAuto, display.ifFloor, display.ifCeil, display.ifShapeSec,
    ]);

    // The palette as one packed pixel per level, which is what colouring a
    // waterfall row wants. The stored history keeps the colours it was painted
    // in — as the main waterfall's does — so a palette change starts a fresh
    // one rather than leaving two colour maps in the same picture.
    useEffect(() => {
        const lut = getPalette(display.palette);
        const cmap = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            cmap[i] = (255 << 24) | (lut[i * 3 + 2] << 16) | (lut[i * 3 + 1] << 8) | lut[i * 3];
        }
        st.cmap = cmap;
        st.gradKey = '';                 // the gradients belong to the old palette
        clearRing(st);
        schedule();
    }, [display.palette, display.contrast, schedule, st]);

    // A span change is a different x axis, so the history it was painted under
    // no longer means what the new scale says. Tuning is *not* such a change —
    // every column is an offset from the dial and stays true as the dial moves,
    // which is the whole reason this pane is worth a history at all. Both
    // histories are on that grid and both go.
    useEffect(() => {
        clearRing(st);
        resetShape(st.shape, SHAPE_BINS);
        st.stats = null;
        schedule();
    }, [win.span, schedule, st]);

    // Turning the slide off has to straighten the canvas at once: the next row
    // would do it, but on a stream that has gone quiet there may not be one.
    useEffect(() => {
        if (!st.smooth && wfRef.current) wfRef.current.style.transform = '';
    }, [st.smooth, st]);

    // ── Sizing ───────────────────────────────────────────────────────────────
    useEffect(() => {
        const wrap = wrapRef.current;
        if (!wrap) return undefined;

        const measure = () => {
            const w = wrap.clientWidth;
            if (!w) return;
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            const total = Math.max(MIN_H, Math.min(MAX_H, Math.round(w * ASPECT)));
            let specH = 0;
            let wfH = 0;
            if (viewMode === 'split') {
                specH = Math.round(total * SPLIT_TRACE);
                wfH = total - specH;
            } else if (has.merged || !has.trace) {
                wfH = total;
            } else {
                specH = total;
            }

            const spec = specRef.current;
            if (spec && specH) {
                spec.style.height = `${specH}px`;
                spec.width = Math.max(1, Math.round(w * dpr));
                spec.height = Math.max(1, Math.round(specH * dpr));
            }

            // The waterfall canvas is RING_PAD device pixels taller than the box
            // that clips it. That overhang is what the slide moves: the newest
            // row is painted above the top edge and travels down into view, so
            // the picture moves continuously instead of jumping when a row
            // lands.
            const wf = wfRef.current;
            const ringH = wfH ? Math.max(1, Math.round(wfH * dpr)) + RING_PAD : 0;
            if (wf && wfH) {
                wf.style.height = `${wfH + RING_PAD / dpr}px`;
                wf.width = Math.max(1, Math.round(w * dpr));
                wf.height = ringH;
            }
            // The marks ride on their own canvas over the waterfall, because
            // the waterfall itself is sliding: a dial line drawn into it would
            // travel down the panel with the history it was drawn on.
            const ov = ovRef.current;
            if (ov && wfH) {
                ov.style.height = `${wfH}px`;
                ov.width = Math.max(1, Math.round(w * dpr));
                ov.height = Math.max(1, Math.round(wfH * dpr));
            }

            st.dpr = dpr;
            const grew = ringH !== st.ringH;
            st.ringH = ringH;
            if (grew) clearRing(st);
            // Only when something actually moved. Sizing the canvases changes
            // the box being observed, so the observer fires again on the way
            // out; an unconditional setState would make every layout change a
            // pair of renders instead of one.
            setSize((s) => (s.w === w && s.specH === specH && s.wfH === wfH
                ? s : { w, specH, wfH }));
        };

        measure();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(measure);
        ro.observe(wrap);
        return () => ro.disconnect();
    }, [viewMode, has.merged, has.trace, st]);

    // ── Pointer ──────────────────────────────────────────────────────────────
    //
    // The gesture state is declared before the readout because the readout has
    // to know about it: a drag or a pinch is a statement about where you want to
    // be, not a question about the pixel under the finger, and answering it with
    // a tooltip leaves one behind in the middle of every gesture.
    const pinch = useRef(new Map()).current;
    const pinchRef = useRef(null);
    const drag = useRef(null);

    const read = useCallback((e) => {
        if (pinch.size >= 2 || (drag.current && drag.current.moved)) return;
        st.ptr = { x: e.clientX, y: e.clientY, type: e.pointerType };
        const v = readAt(st, wrapRef.current, st.ptr);
        if (v) setAt(v);
    }, [pinch, st]);

    const leave = useCallback((e) => {
        if (!readoutClearsOn(e.pointerType)) return;
        st.ptr = null;
        setAt(null);
    }, [st]);

    // ── Zoom and pan ─────────────────────────────────────────────────────────
    //
    // Zoom is the *span*: a wheel notch, or two fingers, open and close the
    // window about the dial. There is no anchor to zoom about, and that is not
    // an omission — a window that stayed anchored to the pointer would stop
    // being centred on the dial, which is the one thing this pane guarantees.
    // The stop at the fit is hard for the same reason (see ZOOM_MIN).
    //
    // Pan is *tuning*. On a view that is locked to the dial there is nothing
    // else a horizontal drag could mean, and it turns out to be the best control
    // on the panel: at the fit zoom a pixel is about ten hertz, so dragging the
    // spectrum under the dial line is a fine-tuning knob with the signal drawn
    // on it. Drag the carrier onto the centre line and you are on frequency.
    //
    // Both can be switched off together, as the band chart's can and for the
    // same reason: this is a picture inside a scrolling dock column, a wheel
    // over it has two plausible meanings, and somebody who would rather scroll
    // the column should be able to say so.
    const gestures = display.ifGestures !== false;
    // Off by default — see the note in DisplayContext. The drag is unaffected:
    // that one cannot be done by accident.
    const clickTune = !!display.ifClickTune;
    const zoomed = isZoomed(factor);

    // maxFactor through a ref for the same reason the zoom itself is: the
    // handlers outlive the render they were made in, and the main display can
    // zoom under them at any moment.
    const maxRef = useRef(maxFactor);
    maxRef.current = maxFactor;

    const setFactor = useCallback(
        (v) => display.set({ ifSpan: clampZoom(v, maxRef.current) }),
        [display],
    );

    // The live zoom, for the handlers to read rather than close over.
    //
    // A trackpad delivers wheel events faster than React re-renders, and every
    // one of them computes the next zoom from the current one — so a handler
    // holding the value from its own render multiplies the same number several
    // times over and all but the last notch of a fast spin is lost.
    const factorRef = useRef(factor);
    factorRef.current = factor;

    // Switched off while open: the reset button lives on the chart and would go
    // with the gestures, leaving a window nothing could close again.
    useEffect(() => {
        if (!gestures && zoomed) setFactor(ZOOM_MIN);
    }, [gestures, zoomed, setFactor]);

    // By hand rather than with onWheel: React registers that one passively, and
    // a passive listener cannot stop the dock column scrolling under the zoom.
    useEffect(() => {
        const wrap = wrapRef.current;
        if (!wrap || !gestures) return undefined;
        const onWheel = (e) => {
            e.preventDefault();
            setFactor(factorRef.current * (e.deltaY < 0 ? 1 / ZOOM_STEP : ZOOM_STEP));
        };
        wrap.addEventListener('wheel', onWheel, { passive: false });
        return () => wrap.removeEventListener('wheel', onWheel);
    }, [gestures, setFactor]);

    // Tuning while a finger is down, sent at a rate a receiver can answer.
    // Every pointer move would be sixty commands a second down a socket that
    // reloads a radiod channel for each one; the trailing edge means the
    // frequency the drag *ended* on is always the last one sent.
    const tuneTo = useMemo(() => throttle((hz) => actions.setFrequency(hz), DRAG_TUNE_MS), [actions]);
    useEffect(() => () => tuneTo.cancel(), [tuneTo]);

    const onPointerDown = useCallback((e) => {
        st.moved = false;
        if (e.target.closest && e.target.closest('button')) return;
        if (gestures) {
            pinch.set(e.pointerId, e.clientX);
            if (pinch.size === 2) {
                const xs = [...pinch.values()];
                pinchRef.current = { dist: Math.abs(xs[0] - xs[1]), factor: factorRef.current };
                drag.current = null;         // two fingers is a pinch, never a drag
                st.moved = true;             // ...and never a click
                return;
            }
            // The frequency is carried through the drag as a float and rounded
            // only on the way out: at a few hertz a pixel, rounding every step
            // would lose most of a slow drag to the rounding.
            drag.current = { id: e.pointerId, x: e.clientX, hz: win.dial, moved: false };
            if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId);
        }
        read(e);
    }, [gestures, pinch, win.dial, read, st]);

    const onPointerUp = useCallback((e) => {
        pinch.delete(e.pointerId);
        if (pinch.size < 2) pinchRef.current = null;
        if (drag.current && drag.current.id === e.pointerId) drag.current = null;
        if (wrapRef.current) wrapRef.current.style.cursor = '';
    }, [pinch]);

    // Moves come off the window rather than off the element. A capture is not
    // honoured the same way for touch in every browser, and a gesture that
    // crossed onto the ruler — or over a readout that unmounted from under it —
    // would otherwise stop dead. See the same note in BandSpectrumPanel.
    useEffect(() => {
        if (!gestures) return undefined;
        const onMove = (e) => {
            // Nothing in hand: this listener sees every pointer move on the
            // page, and measuring the chart on each one would force a layout
            // for every mousemove in the app.
            if (!drag.current && pinch.size < 2) return;
            const wrap = wrapRef.current;
            const r = wrap ? wrap.getBoundingClientRect() : null;
            if (!r || !r.width) return;

            if (pinch.has(e.pointerId)) pinch.set(e.pointerId, e.clientX);
            if (pinch.size === 2 && pinchRef.current) {
                const xs = [...pinch.values()];
                const dist = Math.abs(xs[0] - xs[1]);
                if (dist > 4 && pinchRef.current.dist > 4) {
                    // Spreading the fingers narrows the window, as spreading
                    // them enlarges a photograph.
                    setFactor(pinchRef.current.factor * (pinchRef.current.dist / dist));
                }
                return;
            }

            const d = drag.current;
            if (!d || d.id !== e.pointerId) return;
            if (e.pointerType === 'mouse' && !e.buttons) { drag.current = null; return; }
            const dx = e.clientX - d.x;
            if (!d.moved && Math.abs(dx) < 3) return;      // still a click, not a drag

            d.moved = true;
            st.moved = true;
            st.ptr = null;
            setAt(null);
            d.x = e.clientX;
            if (wrap) wrap.style.cursor = 'grabbing';
            // Dragging right carries the spectrum right, which means the dial
            // has moved down the band — the picture follows the finger.
            //
            // Clamped as it accumulates rather than only on the way out, so a
            // drag that runs past the end of the band does not build up travel
            // the way back has to spend before anything moves again.
            d.hz = clamp(d.hz - (dx / r.width) * win.span, MIN_FREQ, MAX_FREQ);
            tuneTo(Math.round(d.hz));
        };
        const onEnd = (e) => onPointerUp(e);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onEnd);
        window.addEventListener('pointercancel', onEnd);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onEnd);
            window.removeEventListener('pointercancel', onEnd);
        };
    }, [gestures, pinch, win.span, setFactor, tuneTo, onPointerUp, st]);

    // A press that neither dragged nor pinched tunes to where it landed —
    // which, because the window follows the dial, brings whatever you pressed to
    // the centre. That is the gesture this pane exists for: point at the carrier
    // you are 300 Hz off and it becomes the one you are on.
    //
    // Not snapped to the tuning step. Everywhere else a click lands on the
    // step's grid because the frequency is being *chosen*; here it is being
    // *corrected*, and a 500 Hz grid is wider than half of this window.
    const onClick = useCallback((e) => {
        if (st.moved) { st.moved = false; return; }
        if (!clickTune) return;
        if (e.target.closest && e.target.closest('button')) return;
        const wrap = wrapRef.current;
        const r = wrap ? wrap.getBoundingClientRect() : null;
        if (!r || !r.width) return;
        const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        actions.setFrequency(Math.round(win.lo + frac * win.span));
        haptic('tune', 'spectrum');
    }, [actions, clickTune, win, st]);

    // ── Controls ─────────────────────────────────────────────────────────────
    const rate = clampRate(display.ifRate);
    const shapeSec = clampShapeSec(display.ifShapeSec);
    const auto = display.ifAuto !== false;
    const wantStats = display.ifStats === true;
    // Nothing measured is worth reporting until the pane can draw at all: over
    // one spectrum bin there is no peak to find and no occupancy to count, and
    // a number there would be a confident answer to a question nobody could
    // have answered. The cover over the picture says why.
    const shown = wantStats && state.ok ? measured : null;
    const peak = shown ? shown.peak : null;
    const busy = shown ? shown.occupancy : null;
    const floor = shown ? shown.floorDb : NaN;
    const fit = formatFit(shown ? shown.fit : null);
    const floorDb = Number.isFinite(display.ifFloor) ? display.ifFloor : -110;
    const ceilDb = Number.isFinite(display.ifCeil) ? display.ifCeil : -20;

    const ticks = offsetTicks(win.offLo, win.offHi, size.w);
    // The main view is zoomed in far enough that the fitted window already fills
    // it — there is no more spectrum to open into.
    const spanFixed = maxFactor <= ZOOM_MIN * 1.05;

    // What the button offers: the main view zoomed to this window, so both panes
    // show the same thing and this one becomes the ruler for it. A little wider
    // than the window so the window is not sitting on the edges of the served
    // view — the server snaps the request to its own ladder anyway.
    // The Shape view asking the main display for the zoom it needs.
    //
    // Deliberately not a dependency on the served view: it runs when this view
    // is opened and when the window itself changes, and reads the current
    // geometry off `st` at that moment. Made to follow the view it is changing,
    // it would re-fire on its own result and could never be overruled — see the
    // note in lib/ifShape.js.
    //
    // `haveView` is in the list only so that opening the panel before the first
    // config arrives still gets its one chance once the geometry is known.
    const haveView = view.span > 0;
    useEffect(() => {
        if (!has.shape || display.ifShapeZoom === false || !running || !haveView) return;
        const cfg = st.cfg;
        const w = st.win;
        // As far in as the zoom will go, so a mode whose window is narrower than
        // that is recognised as already being there rather than asked to move to
        // a span it cannot have.
        const floor = spectrumConn.binCount
            ? spectrumConn.minBinBandwidthForUI() * spectrumConn.binCount
            : 0;
        if (!shapeWantsZoom(cfg, w, coverageOf(cfg, w), floor)) return;
        actions.setSpectrumView((w.lo + w.hi) / 2, shapeZoomSpan(w, floor));
    }, [has.shape, display.ifShapeZoom, running, haveView, win.span, actions, spectrumConn, st]);

    const resume = useCallback(() => {
        resumeSpectrum(spectrumConn);
        setSpectrumPaused(false);
    }, [spectrumConn]);

    const zoomMain = useCallback(() => {
        // Centred on the *fitted* window rather than on the dial: the two are
        // not the same once the mode puts the passband to one side, and
        // centring on the dial would leave the far end of a USB window nearer
        // the edge of the new view than the near end. The fit rather than the
        // current window for the reason given at zoomTargetSpan.
        const fit = windowFor(tuning, ZOOM_MIN);
        actions.setSpectrumView((fit.lo + fit.hi) / 2, zoomTargetSpan(view, tuning));
    }, [actions, tuning, view]);

    return (
        <div className="stack">
            {!minimal && (
                <Segmented
                    options={IF_VIEWS}
                    value={viewMode}
                    onChange={(v) => display.set({ ifView: v })}
                    size="sm"
                    minItemWidth={62}
                />
            )}

            <div
                className={`ifs__chart${zoomed ? ' ifs__chart--zoomed' : ''}`}
                ref={wrapRef}
                onPointerMove={read}
                onPointerDown={onPointerDown}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onPointerLeave={leave}
                onClick={onClick}
                onDoubleClick={() => setFactor(ZOOM_MIN)}
                title={chartHint(gestures, clickTune)}
            >
                {showTrace && <canvas className="ifs__spec" ref={specRef} />}

                {/* The offset ruler, between the two pictures where there are
                    two and above the waterfall where the trace is absent — in
                    both cases against the newest data, which is the top of the
                    waterfall. */}
                <div className="ifs__scale">
                    {ticks.map((k) => (
                        <React.Fragment key={k.hz}>
                            <span
                                className={`ifs__notch${k.major ? ' ifs__notch--major' : ''}${k.zero ? ' ifs__notch--zero' : ''}`}
                                style={{
                                    left: `${k.frac * 100}%`,
                                    ...(k.zero ? { background: st.marks.dial } : null),
                                }}
                            />
                            {k.label != null && (
                                <span
                                    className={`ifs__tick ifs__tick--${k.align}${k.zero ? ' ifs__tick--zero' : ''}`}
                                    style={{
                                        ...(k.align === 'end'
                                            ? { right: `${(1 - k.frac) * 100}%` }
                                            : { left: `${k.frac * 100}%` }),
                                        ...(k.zero ? { color: st.marks.dial } : null),
                                    }}
                                >
                                    {k.label}
                                </span>
                            )}
                        </React.Fragment>
                    ))}
                </div>

                {has.waterfall && (
                    <div className="ifs__wfclip" style={{ height: `${size.wfH}px` }}>
                        <canvas className="ifs__wf" ref={wfRef} />
                        <canvas className="ifs__ov" ref={ovRef} />
                    </div>
                )}

                {/* Only while the window is open past the fit: at the fit there
                    is nothing to reset, and a button sitting on a small picture
                    for no reason is a button covering part of it. */}
                {zoomed && (
                    <button
                        type="button"
                        className="ifs__reset"
                        title="Fit the window to the filter"
                        aria-label="Fit the window to the filter"
                        onClick={() => setFactor(ZOOM_MIN)}
                    >
                        <Icon.Reset size={13} />
                    </button>
                )}

                {/* Over the picture rather than under it, and last so it is
                    over the readout too. The chart still draws underneath: at a
                    wide zoom that is a smooth line, and watching it grow teeth
                    as the main display zooms in says what the words mean better
                    than the words do. */}
                {!state.ok && (
                    <Veil
                        state={state}
                        inWindow={inWindow}
                        onZoom={zoomMain}
                        onCentre={() => actions.centerOnTuned()}
                        onResume={resume}
                    />
                )}

                {at && state.ok && (
                    <>
                        <span className="ifs__cross" style={{ left: `${at.xPct}%` }} />
                        <span
                            className={`ifs__tip${at.left ? ' ifs__tip--left' : ''}${at.above ? ' ifs__tip--above' : ''}`}
                            style={{ left: `${at.xPct}%`, top: `${at.yPct}%` }}
                        >
                            <span className="ifs__tip-row">
                                <b>{at.offset}</b>
                                {at.db != null && <span className="ifs__tip-db">{at.db}</span>}
                            </span>
                            <span className="ifs__tip-freq">
                                {at.freq}
                                {at.peak != null && <span className="ifs__tip-peak">{at.peak}</span>}
                            </span>
                        </span>
                    </>
                )}
            </div>

            {/* What the averaging measured. Under the picture and above the
                controls, because it is a reading off the picture rather than a
                setting for it — and shown in the minimal view too, unlike the
                readout below: that one is always there and this one was asked
                for, which is the difference between clutter and a request. */}
            {wantStats && (
                <div className="readout-grid ifs__stats">
                    <Readout
                        label="Peak"
                        value={peak ? formatHz(win.dial + peak.offsetHz) : '—'}
                        unit={peak ? `${peak.db.toFixed(1)} dBFS` : ''}
                    />
                    <Readout
                        label="Occupancy"
                        value={busy == null ? '—' : Math.round(busy * 100)}
                        unit={busy == null ? '' : '%'}
                    />
                    <Readout
                        label="Noise"
                        value={Number.isFinite(floor) ? floor.toFixed(1) : '—'}
                        unit={Number.isFinite(floor) ? 'dBFS' : ''}
                    />
                    {/* Whether the passband fits the signal it is passing —
                        averaged, mode-aware and deliberately slow to change:
                        see lib/ifFit.js. A dash is "nothing to judge", which a
                        quiet channel is — the same moments Peak shows one. */}
                    <span className="ifs__fit" title={FIT_TIPS[shown && shown.fit ? shown.fit.kind : '']}>
                        <Readout label="Filter" value={fit.value} unit={fit.unit} tone={fit.tone} />
                    </span>
                </div>
            )}

            {/* The dial, the window and what it is costing in resolution.
                Dropped in the minimal view, which is the picture and nothing
                else: the ruler already says how wide the window is, the dial is
                on the top bar and in the Receiver panel above, and a line of
                figures under a picture somebody shrank to a glance is exactly
                the thing they shrank it to be rid of. */}
            {!minimal && (
                <div className="ifs__foot">
                    <span className="ifs__dial">{formatHz(win.dial)}</span>
                    <span className="ifs__span">{formatSpan(win.span)} wide</span>
                    {has.shape && state.ok && (
                        <span
                            className={`ifs__avg${st.stats && st.stats.rows < SHAPE_MIN_ROWS ? ' is-thin' : ''}`}
                            title="How much signal actually went into the average — the time it covers and the number of frames. A window the feed cannot fill is a shape drawn from very few readings, and this is where that shows."
                        >
                            {formatShape(st.stats, shapeSec)}
                        </span>
                    )}
                    <span className="ifs__res">{formatBinWidth(binWidth)}</span>
                </div>
            )}


            {/* The same value the wheel and the pinch move, so the control and
                the gesture are one setting rather than two. Logarithmic,
                because a multiplier is: a notch should mean the same *ratio*
                whether the window is a kilohertz or thirty. */}
            {!minimal && (
                <Field
                    label="Span"
                    hint={spanFixed
                        ? `${formatSpan(win.span)} — all the spectrum view has`
                        : `${formatSpan(win.span)} — ${zoomed ? `×${factor.toFixed(1)}` : 'fit'}`}
                >
                    {/* Disabled rather than absent where the main display is
                        zoomed in far enough that the fitted window already fills
                        it: there is nowhere to go, and a control that vanished
                        would look like the setting had. */}
                    <Slider
                        value={spanFixed ? 0 : Math.log2(factor)}
                        min={0}
                        max={spanFixed ? 1 : Math.log2(maxFactor)}
                        step={0.05}
                        disabled={spanFixed}
                        onChange={(v) => setFactor(2 ** v)}
                    />
                </Field>
            )}

            {!minimal && (
                <Field label="Levels" hint={auto ? 'follows the signal' : `${Math.round(floorDb)} to ${Math.round(ceilDb)} dBFS`}>
                    <Segmented
                        options={[
                            { value: 'auto', label: 'Auto' },
                            { value: 'manual', label: 'Manual' },
                        ]}
                        value={auto ? 'auto' : 'manual'}
                        onChange={(v) => display.set({ ifAuto: v === 'auto' })}
                        size="sm"
                    />
                </Field>
            )}

            {/* Both ends, because a manual scale with a fixed ceiling is not a
                manual scale — the point of turning auto off is usually that the
                *top* is moving, and a floor on its own cannot answer that. */}
            {!minimal && !auto && (
                <Field label="Scale" hint={`${Math.round(floorDb)} to ${Math.round(ceilDb)} dBFS`}>
                    <RangeSlider
                        low={floorDb}
                        high={ceilDb}
                        min={-140}
                        max={0}
                        step={1}
                        gap={10}
                        onChange={({ low, high }) => display.set({ ifFloor: low, ifCeil: high })}
                    />
                </Field>
            )}

            {/* Only in the Shape view, which is the only one that has a window
                to set. Seconds rather than a frame count, because that is what
                it actually is — see lib/ifShape.js. */}
            {!minimal && (has.shape || wantStats) && (
                <Field
                    label="Average"
                    hint={state.ok ? formatShape(st.stats, shapeSec) : `${shapeSec.toFixed(1)} s`}
                >
                    <Slider
                        value={shapeSec}
                        min={SHAPE_SEC_MIN}
                        max={SHAPE_SEC_MAX}
                        step={0.5}
                        onChange={(v) => display.set({ ifShapeSec: clampShapeSec(v) })}
                    />
                </Field>
            )}

            {!minimal && has.shape && (
                <Switch
                    checked={display.ifShapeZoom !== false}
                    onChange={(v) => display.set({ ifShapeZoom: v })}
                    label="Auto zoom"
                    title="Zoom the main spectrum in far enough to draw a shape from. Every bin averaged here is one of that display's, so at a wide zoom there is a fraction of one in the passband. It moves the main view when this panel is opened and when the filter changes, never while you are working it"
                />
            )}

            {!minimal && has.waterfall && (
                <Field label="Speed" hint={`${rate} rows/s`}>
                    <Slider
                        value={rate}
                        min={IF_RATE_MIN}
                        max={IF_RATE_MAX}
                        onChange={(v) => display.set({ ifRate: clampRate(v) })}
                    />
                </Field>
            )}

            {/* The two ways the picture answers a pointer, side by side because
                they are the same kind of choice: what a gesture over the chart
                is allowed to do to the receiver. */}
            {!minimal && (
                <div className="ifs__switches">
                    <Switch
                        checked={gestures}
                        onChange={(v) => display.set({ ifGestures: v })}
                        label="Drag"
                        title="Dragging the picture tunes, and the wheel or a pinch sets the span. Off gives the wheel back to the dock column it sits in — the span slider above still works"
                    />
                    <Switch
                        checked={clickTune}
                        onChange={(v) => display.set({ ifClickTune: v })}
                        label="Click tune"
                        title="A click on the picture tunes to it. Off by default: this pane is for looking at the signal you are already on, and most reasons to point at it are reasons to read it rather than to move"
                    />
                    <Switch
                        checked={wantStats}
                        onChange={(v) => display.set({ ifStats: v })}
                        label="Stats"
                        title="Measure the passband rather than only drawing it: the strongest signal in it and where, the noise under it, and how much of the filter is occupied. Averaged over the window below, in whichever view is showing"
                    />
                </div>
            )}
        </div>
    );
}

// What the picture will do if you touch it, in the order you would try it.
// Assembled rather than written out four times over: with both switches off the
// chart is a readout, and a tooltip promising to tune would be wrong.
function chartHint(gestures, clickTune) {
    const parts = [];
    if (gestures && clickTune) parts.push('Click or drag to tune.');
    else if (gestures) parts.push('Drag to tune.');
    else if (clickTune) parts.push('Click to tune here.');
    if (gestures) parts.push('Wheel or pinch to widen the window; double-click to fit it to the filter.');
    if (!parts.length) parts.push('Point at it to read the offset.');
    return parts.join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// What is in the way
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The cover that goes over the picture when the frames cannot answer for it.
 *
 * On the chart rather than under it, for three reasons. It is *about* the
 * picture, and a caption under a picture that is still being drawn reads as a
 * footnote rather than as "do not believe this". It survives the minimal view,
 * where there is deliberately nothing under the chart at all. And it leaves the
 * trace visible underneath, so zooming the main display in shows the smooth line
 * growing teeth and the cover lifting at the moment it becomes worth reading —
 * which teaches the rule in one gesture.
 *
 * One line, one action. Every case here is something the operator can fix from
 * this panel, except being stopped, which is not this panel's to fix.
 */
function Veil({ state, inWindow, onZoom, onCentre, onResume }) {
    let title = '';
    let detail = null;
    let action = null;

    if (state.kind === 'stopped') {
        title = 'Receiver stopped';
        detail = 'Start it to see the IF.';
    } else if (state.kind === 'paused') {
        title = 'Spectrum paused';
        // The same wording the main display's overlay uses, and it is the
        // useful half: what has stopped is one socket, and the audio, the
        // decoders and the session are all still running.
        detail = 'The audio carries on. This pane draws the spectrum\u2019s own frames, so it has none.';
        action = { label: 'Resume', onClick: onResume, icon: <Icon.Play size={13} /> };
    } else if (state.kind === 'waiting') {
        title = 'Waiting for the spectrum';
    } else if (state.kind === 'offdial') {
        title = 'No spectrum at the dial';
        detail = 'The main view has been panned off it, so there are no bins here.';
        action = { label: 'Show the dial', onClick: onCentre };
    } else if (state.kind === 'partial') {
        title = 'Part of this window is off the view';
        // As a proportion, because that is what you can see is wrong: the
        // shading and the ruler describe the whole window either way, so a gap
        // in it reads as a dead band rather than as missing data.
        detail = `The main spectrum reaches ${Math.round(state.cover * 100)}% of it — the rest `
            + 'has no bins.';
        // Recentring is the gentle fix and is enough whenever the view is wide
        // enough to hold the window at all. When it is not, only widening it is.
        action = state.canCentre
            ? { label: 'Centre the view', onClick: onCentre }
            : { label: 'Zoom here', onClick: onZoom };
    } else {
        title = 'Zoom the main spectrum in';
        // The bin count is the reason, in the terms the pane is drawn in: at a
        // wide zoom the whole window is a fraction of one measurement, and that
        // says it better than a step count does.
        detail = inWindow < 1
            ? `The whole window is less than one spectrum bin — ${state.short} more zoom `
                + `${state.short === 1 ? 'step' : 'steps'} to go.`
            : `Only ${Math.round(inWindow)} bins land in this window — ${state.short} more zoom `
                + `${state.short === 1 ? 'step' : 'steps'} to go.`;
        action = { label: 'Zoom here', onClick: onZoom };
    }

    return (
        <div className="ifs__veil">
            <div className="ifs__veil-title">{title}</div>
            {detail && <div className="ifs__veil-text">{detail}</div>}
            {action && (
                <Button size="sm" variant="primary" icon={action.icon} onClick={action.onClick}>
                    {action.label}
                </Button>
            )}
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the picture
// ─────────────────────────────────────────────────────────────────────────────

// The readout for a point, in the terms this pane is drawn in: how far off the
// dial, then the absolute frequency under it. The offset leads because it is
// the number the pane exists to show — a frequency is what the main scale is
// for.
function readAt(st, wrap, pt) {
    if (!wrap || !pt || !st.win) return null;
    const r = wrap.getBoundingClientRect();
    if (!r.width || !r.height) return null;

    const xFrac = Math.min(1, Math.max(0, (pt.x - r.left) / r.width));
    const xPct = xFrac * 100;
    const yPct = Math.min(100, Math.max(0, ((pt.y - r.top) / r.height) * 100));
    const off = Math.round(st.win.offLo + xFrac * st.win.span);

    // The level under the pointer, and only where there is something live to
    // read it off. Over a bare waterfall the pixel under the pointer is a
    // measurement from some seconds ago, and answering it with this frame's
    // number would be a readout for a row nobody is pointing at.
    //
    // In the Shape view it is the average rather than the last frame — the
    // average is what is drawn, and reporting the instantaneous value beside a
    // curve that deliberately is not it would be two different answers to the
    // same question. The peak goes with it, because the gap between them is
    // what the band's width means.
    let db = null;
    let peak = null;
    if (st.has && st.has.shape && st.stats) {
        const m = st.stats.mean;
        const i = Math.min(m.length - 1, Math.round(xFrac * (m.length - 1)));
        if (Number.isFinite(m[i])) {
            db = `${m[i].toFixed(1)} dBFS`;
            if (Number.isFinite(st.stats.max[i])) peak = `pk ${st.stats.max[i].toFixed(1)}`;
        }
    } else if (st.has && st.has.trace && st.px && st.px.length) {
        const i = Math.min(st.px.length - 1, Math.round(xFrac * (st.px.length - 1)));
        const v = st.px[i];
        if (Number.isFinite(v)) db = `${v.toFixed(1)} dBFS`;
    }

    return {
        offset: `${formatOffset(off)} Hz`,
        freq: formatFreqExact(st.win.dial + off),
        db,
        peak,
        xPct,
        yPct,
        ...tipPlacement(pt.type, xPct, yPct),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Drawing
// ─────────────────────────────────────────────────────────────────────────────

function drawAll(st, spec, wf, ov) {
    const width = spec ? spec.width : (wf ? wf.width : 0);
    if (!width) return;

    // The window across the canvas, and across the fixed history width. Two
    // resamples of the same frame: the trace wants the canvas's own pixels, the
    // history wants a width that does not change when the panel is resized.
    if (!st.px || st.px.length !== width) {
        st.px = new Float32Array(width);
        st.smoothed = null;
    }
    sliceToPixels(st.bins, st.cfg, st.win, st.px);

    const now = performance.now();
    const dt = st.drawnAt ? Math.min(1, (now - st.drawnAt) / 1000) : 0;
    st.drawnAt = now;

    // Temporal smoothing, per unit time rather than per frame — the receiver
    // sends fewer frames a second on a wide span than a narrow one, and a
    // per-frame factor would make one slider setting lag several times longer
    // purely because the main view had been zoomed out. See lib/timeConstant.js.
    let trace = st.px;
    const smoothing = st.d ? st.d.smoothing : 0;
    if (smoothing > 0) {
        if (!st.smoothed || st.smoothed.length !== width) st.smoothed = Float32Array.from(st.px);
        const a = retentionFor(smoothing, dt);
        for (let i = 0; i < width; i++) {
            const v = st.px[i];
            // NaN is "not measured", and it must not poison the average: a pixel
            // that comes back into the served view would otherwise stay NaN for
            // ever, since NaN * a + v * (1 - a) is NaN.
            st.smoothed[i] = Number.isFinite(v)
                ? (Number.isFinite(st.smoothed[i]) ? st.smoothed[i] * a + v * (1 - a) : v)
                : NaN;
        }
        trace = st.smoothed;
    }

    // The Shape view keeps a window of frames of its own, on the same offset
    // grid the waterfall's rows use — and it keeps it from the *raw* row, not
    // the smoothed one: smoothing before averaging is averaging twice, and the
    // second one has a length nobody chose.
    const stats = st.has.shape || st.wantStats ? updateShape(st, now) : null;
    st.stats = stats;
    st.measured = st.wantStats && stats
        ? measureShape(stats, st.win, st.band, st.measure)
        : null;
    // Whether the filter fits what it is passing. From the *unmasked* average
    // (`stats.open`) — clipping only shows in the margins the mask erases —
    // and through the little state machine that keeps it from flapping between
    // words. Carried on `measured` so it publishes at the same cadence.
    if (st.measured) {
        // The verdict gets its own average, and it is not the one on screen.
        //
        // Two reasons. The display's window is the operator's setting and can
        // be half a second, which is far too little signal to judge a filter
        // by; and this needs the *unmasked* spectrum, since whether a signal
        // continues past a filter edge is only visible outside the filter. So
        // it takes its own pass over the same rows — a longer window, and no
        // passband mask — off the ring the display is already filling.
        //
        // At the publish cadence rather than per frame: the card updates four
        // times a second whatever the frame rate, so a pass per frame would be
        // fifteen times the work for the same number on screen.
        if (now - st.fitAt >= STATS_MS) {
            st.fitAt = now;
            const fs = shapeStats(st.shape, FIT_WINDOW_MS, now, st.fitOut);
            st.fitVerdict = updateFit(
                st.fit,
                // The served bin width goes along so every threshold knows the
                // resolution actually behind the grid — at a wide span one bin
                // is hundreds of hertz, and without this the edge quantisation
                // alone read as clipping — and the row count so a thin average
                // is not asked for an opinion.
                rawFit(fs.mean, st.win, st.band, st.tuning, fs.floorDb, {
                    resHz: binWidthOf(st.cfg),
                    rows: fs.rows,
                    spanMs: fs.spanMs,
                }),
                now,
            );
        }
        st.measured.fit = st.fitVerdict;
    }

    let levels;
    if (st.d && st.d.ifAuto === false) {
        levels = manualLevels(
            Number.isFinite(st.d.ifFloor) ? st.d.ifFloor : -110,
            Number.isFinite(st.d.ifCeil) ? st.d.ifCeil : -20,
        );
    } else if (stats && st.has.shape) {
        // The floor from the average and the ceiling from the top of the
        // envelope — see updateLevels. The scale therefore fits the passband
        // rather than the window, which is all this view draws.
        updateLevels(st.levels, stats.mean, dt, stats.max);
        levels = levelsOf(st.levels);
    } else {
        updateLevels(st.levels, trace, dt);
        levels = levelsOf(st.levels);
    }

    commitRow(st, now, levels);

    if (spec && stats && st.has.shape) drawShape(st, spec, stats, levels);
    else if (spec) drawTrace(st, spec, trace, levels, { mirror: st.has.mirror, over: false });
    if (wf) drawWaterfall(st, wf);
    if (ov) drawOverlay(st, ov, trace, levels);
}

// One frame into the shape's window, and the answer back out.
//
// Resampled to the shape grid rather than reusing the trace: the trace is at the
// canvas's device width, which changes when the panel is resized, and a history
// whose columns moved with the layout would be describing several different
// windows at once.
function updateShape(st, now) {
    if (!st.shapeRow || st.shapeRow.length !== SHAPE_BINS) st.shapeRow = new Float32Array(SHAPE_BINS);
    sliceToPixels(st.bins, st.cfg, st.win, st.shapeRow);
    const windowMs = clampShapeSec(st.d && st.d.ifShapeSec) * 1000;
    // The ring keeps whichever window is longer. The display is unaffected —
    // shapeStats applies its own cutoff — but the fit's pass would otherwise
    // find its four seconds already thrown away by a half-second setting.
    pushShapeRow(st.shape, st.shapeRow, now, Math.max(windowMs, st.wantStats ? FIT_WINDOW_MS : 0));
    st.band = bandBins(SHAPE_BINS, st.win, st.tuning);
    return shapeStats(st.shape, windowMs, now, st.shapeOut, st.band);
}

// ── The history ──────────────────────────────────────────────────────────────

function clearRing(st) {
    st.ring = null;
    st.ringCtx = null;
    st.head = 0;
    st.lastRowAt = 0;
    st.rowDt = 0;
    st.lastGap = 0;
    st.scrolled = true;
}

function ensureRing(st) {
    if (st.ring && st.ring.height === st.ringH) return;
    if (!st.ringH) return;
    st.ring = document.createElement('canvas');
    st.ring.width = ROW_BINS;
    st.ring.height = st.ringH;
    st.ringCtx = st.ring.getContext('2d');
    st.ringCtx.fillStyle = RING_BG;
    st.ringCtx.fillRect(0, 0, ROW_BINS, st.ringH);
    st.rowPx = st.ringCtx.createImageData(ROW_BINS, 1);
    st.rowBuf = new Uint32Array(st.rowPx.data.buffer);
    st.head = 0;
}

// One row, if this frame is new and the chosen rate is ready for one.
//
// Tied to frames rather than to the clock: a row can only be as new as the data
// behind it, so a rate higher than the stream simply commits one row per frame
// and a lower one drops the frames in between. Which is why the speed control
// stops at the main waterfall's ceiling — past it every extra row would be a
// copy of the one above it.
function commitRow(st, now, levels) {
    if (!st.has || !st.has.waterfall || !st.cmap) return;
    if (st.frames === st.rowFrames) return;
    const period = 1000 / clampRate(st.d ? st.d.ifRate : 20);
    if (st.lastRowAt && now - st.lastRowAt < period) return;

    ensureRing(st);
    if (!st.ring) return;

    if (!st.row || st.row.length !== ROW_BINS) st.row = new Float32Array(ROW_BINS);
    sliceToPixels(st.bins, st.cfg, st.win, st.row);

    const span = (levels.ceil - levels.floor) || 1;
    for (let i = 0; i < ROW_BINS; i++) {
        const v = st.row[i];
        if (!Number.isFinite(v)) {
            st.rowBuf[i] = NO_DATA;
            continue;
        }
        const t = (v - levels.floor) / span;
        st.rowBuf[i] = st.cmap[t <= 0 ? 0 : t >= 1 ? 255 : Math.round(t * 255)];
    }
    for (let r = 0; r < st.rowH; r++) {
        st.head = (st.head - 1 + st.ringH) % st.ringH;
        st.ringCtx.putImageData(st.rowPx, 0, st.head);
    }

    const gap = st.lastRowAt ? now - st.lastRowAt : 0;
    st.rowDt = smoothInterval(st.rowDt, gap, st.lastGap);
    st.lastGap = gap;
    st.lastRowAt = now;
    st.rowFrames = st.frames;
    st.scrolled = false;
}

function drawWaterfall(st, canvas) {
    const w = canvas.width;
    if (!w) return;
    const c = canvas.getContext('2d', { alpha: false });
    c.imageSmoothingEnabled = false;
    if (!st.ring) {
        c.fillStyle = RING_BG;
        c.fillRect(0, 0, w, canvas.height);
        return;
    }
    // Newest row at the head, time running downward through increasing indices
    // and wrapping once — so the ring is one or two contiguous runs. Shared with
    // the main waterfall; see lib/waterfallRing.js.
    for (const s of ringSlices(st.head, st.ringH, st.ringH)) {
        c.drawImage(st.ring, 0, s.sy, ROW_BINS, s.sh, 0, s.dy, w, s.sh);
    }

    // The picture has just moved down a row inside the canvas, so putting the
    // canvas back up by the same amount leaves the screen where it was — and
    // sliding it from there to nothing is the row arriving, spread over the time
    // until the next one instead of landing in a single frame.
    if (!st.scrolled) {
        st.scrolled = true;
        scrollRow(st, canvas, st.smooth ? st.rowH / st.dpr : 0, st.rowDt);
    }
}

function scrollRow(st, wf, rowCss, duration) {
    if (st.scroll) {
        st.scroll.cancel();
        st.scroll = null;
    }
    if (!(rowCss > 0) || !(duration > 0) || typeof wf.animate !== 'function') {
        wf.style.transform = '';
        return;
    }
    st.scroll = wf.animate(
        [{ transform: `translateY(${-rowCss}px)` }, { transform: 'translateY(0px)' }],
        { duration, easing: 'linear', fill: 'forwards' },
    );
}

// ── The trace ────────────────────────────────────────────────────────────────

// The gradients this pane draws with, rebuilt only when the palette, the
// contrast or the height changes — never when the levels move, so auto-levelling
// costs nothing here.
//
// `mirror` is its own gradient rather than the trace one used twice: an envelope
// drawn from the centre has its amplitude at *both* ends of the canvas, so the
// colour has to run cold in the middle and hot at the top and the bottom.
// Keyed on the canvas as well as on the appearance: a CanvasGradient belongs to
// the context that made it, and switching view mode moves the trace from the
// spectrum canvas to the one over the waterfall. Reused across that move it
// silently paints nothing.
function ensureGradients(st, c, h, key, canvas) {
    if (st.gradKey === key && st.gradCanvas === canvas) return;
    st.gradCanvas = canvas;
    const d = st.d || {};
    const grads = paletteGradients(c, h, d.palette || 'classic', d.contrast || 1);
    st.traceGrad = grads.trace;
    st.fillGrad = grads.fill;

    const lut = getPalette(d.palette || 'classic');
    const gammaInv = 1 / (d.contrast || 1);
    const g = c.createLinearGradient(0, 0, 0, h);
    for (let i = 0; i <= GRAD_STOPS; i++) {
        const offset = i / GRAD_STOPS;
        let amp = Math.abs(offset - 0.5) * 2;
        if (d.contrast !== 1) amp = Math.pow(amp, gammaInv);
        const fi = Math.round((TRACE_FLOOR + amp * (1 - TRACE_FLOOR)) * 255) * 3;
        g.addColorStop(offset, `rgb(${lut[fi]},${lut[fi + 1]},${lut[fi + 2]})`);
    }
    st.mirrorGrad = g;
    st.gradKey = key;
}

function drawTrace(st, canvas, trace, levels, opts) {
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h) return;
    const d = st.d || {};
    const c = canvas.getContext('2d', { alpha: !!opts.over });
    const col = themeColors(THEME_VARS);

    ensureGradients(st, c, h, `${d.palette}|${d.contrast}|${h}|${opts.mirror ? 'm' : 't'}`, canvas);

    // Over a waterfall the caller owns the surface — it has already cleared it
    // and laid the marks down — so this only ever adds to it.
    if (!opts.over) {
        c.fillStyle = col['--spec-bg'] || '#0a0d14';
        c.fillRect(0, 0, w, h);
    }

    const span = (levels.ceil - levels.floor) || 1;
    const clampDb = (db) => Math.max(levels.floor, Math.min(levels.ceil, db));

    // The dB grid, on the same switch and at the same spacing as the main pane's.
    // Not in the mirror view: the axis there is symmetric about the middle and a
    // grid of absolute levels drawn across it would be a scale for one half.
    if (d.grid && !opts.mirror && !opts.over) {
        c.strokeStyle = col['--spec-grid'] || 'rgba(255,255,255,0.06)';
        c.lineWidth = 1;
        const step = span > 80 ? 20 : 10;
        for (let db = Math.ceil(levels.floor / step) * step; db < levels.ceil; db += step) {
            const y = Math.round(h - ((db - levels.floor) / span) * h) + 0.5;
            c.beginPath();
            c.moveTo(0, y);
            c.lineTo(w, y);
            c.stroke();
        }
    }

    // The passband under the trace, as the main spectrum draws it: the shading
    // never dims a signal, it sits behind one.
    if (!opts.over) drawMarks(st, c, w, h, col, false);

    const filled = d.fill !== false;

    if (opts.mirror) {
        // Up and down from the middle. The fill is one closed shape per run of
        // measured pixels rather than one path with gaps, so a window hanging
        // off the served view leaves a hole instead of a chord drawn across it.
        const mid = h / 2;
        const halfOf = (db) => ((clampDb(db) - levels.floor) / span) * (h / 2);
        eachRun(trace, (from, to) => {
            c.beginPath();
            for (let x = from; x <= to; x++) c.lineTo(x + 0.5, mid - halfOf(trace[x]));
            for (let x = to; x >= from; x--) c.lineTo(x + 0.5, mid + halfOf(trace[x]));
            c.closePath();
            c.fillStyle = st.mirrorGrad;
            c.globalAlpha = filled ? 1 : 0.35;
            c.fill();
            c.globalAlpha = 1;
            if (!filled) {
                c.strokeStyle = st.mirrorGrad;
                c.lineWidth = TRACE_WIDTH * st.dpr;
                c.stroke();
            }
        });
        // The centre line, so an empty window still reads as an axis rather
        // than as a blank pane.
        c.strokeStyle = col['--spec-grid'] || 'rgba(255,255,255,0.08)';
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(0, Math.round(mid) + 0.5);
        c.lineTo(w, Math.round(mid) + 0.5);
        c.stroke();
        return;
    }

    const yOf = (db) => h - ((clampDb(db) - levels.floor) / span) * h;

    eachRun(trace, (from, to) => {
        if (filled) {
            c.beginPath();
            c.moveTo(from + 0.5, h);
            for (let x = from; x <= to; x++) c.lineTo(x + 0.5, yOf(trace[x]));
            c.lineTo(to + 0.5, h);
            c.closePath();
            // Over a waterfall the fill is a wash rather than a block: the
            // history underneath is the same measurement a few seconds older,
            // and hiding it would make the fusion view a spectrum with a border.
            c.globalAlpha = opts.over ? 0.5 : 1;
            c.fillStyle = st.fillGrad;
            c.fill();
            c.globalAlpha = 1;
        }
        // The line, whenever the fill is off — and always over a waterfall,
        // where a translucent fill alone has no edge to read.
        if (!filled || opts.over) {
            c.beginPath();
            for (let x = from; x <= to; x++) {
                const y = yOf(trace[x]);
                if (x === from) c.moveTo(x + 0.5, y); else c.lineTo(x + 0.5, y);
            }
            c.strokeStyle = opts.over ? 'rgba(255,255,255,0.85)' : st.traceGrad;
            c.lineWidth = TRACE_WIDTH * st.dpr;
            c.stroke();
        }
    });
}

// ── The shape ────────────────────────────────────────────────────────────────

/**
 * The passband's sustained shape: an envelope, an average through it, and a peak.
 *
 * Three layers, drawn from the back so each reads over the one behind it:
 *
 *   the band     min to max over the window, filled. Its *width* is the whole
 *                point — that is how much this part of the passband moves, so a
 *                carrier is a ribbon and noise is a wide grey stripe.
 *   the average  the power mean, filled to the floor in the palette's own
 *                gradient so it reads as the same instrument as the other views,
 *                with a crisp line on top. This is the number.
 *   the peak     a hairline along the top of the band, because the loudest thing
 *                that happened is worth being able to point at.
 *
 * Nothing is drawn outside the filter. The shaded passband is therefore exactly
 * the extent of the picture, which is the tidiest thing about this view: the
 * shape sits *inside* the thing that produced it.
 */
function drawShape(st, canvas, stats, levels) {
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h) return;
    const d = st.d || {};
    const c = canvas.getContext('2d', { alpha: false });
    const col = themeColors(THEME_VARS);

    ensureGradients(st, c, h, `${d.palette}|${d.contrast}|${h}|s`, canvas);

    c.fillStyle = col['--spec-bg'] || '#0a0d14';
    c.fillRect(0, 0, w, h);

    const span = (levels.ceil - levels.floor) || 1;
    const yOf = (db) => h - ((Math.max(levels.floor, Math.min(levels.ceil, db)) - levels.floor) / span) * h;

    if (d.grid) {
        c.strokeStyle = col['--spec-grid'] || 'rgba(255,255,255,0.06)';
        c.lineWidth = 1;
        const step = span > 80 ? 20 : 10;
        for (let db = Math.ceil(levels.floor / step) * step; db < levels.ceil; db += step) {
            const y = Math.round(yOf(db)) + 0.5;
            c.beginPath();
            c.moveTo(0, y);
            c.lineTo(w, y);
            c.stroke();
        }
    }

    drawMarks(st, c, w, h, col, false);

    // The grid is a fixed width and the canvas is not, so a bin is a fraction of
    // a pixel or several — either way the mapping is the same one the ruler and
    // the passband shading use, which is what keeps the shape inside its own
    // filter edges to the pixel.
    const n = stats.mean.length;
    const xOf = (i) => ((i + 0.5) / n) * w;
    const { mean, min, max } = stats;

    // Palette hues for the two outer layers, so they belong to whatever colour
    // map is in force rather than being a fixed grey laid over it.
    const lut = getPalette(d.palette || 'classic');
    const rgb = (t) => {
        const k = Math.round(t * 255) * 3;
        return `${lut[k]},${lut[k + 1]},${lut[k + 2]}`;
    };
    const bandCol = rgb(0.55);
    const peakCol = rgb(0.92);

    eachRun(mean, (from, to) => {
        // A single sample has no run to draw and would leave a stray dot; the
        // band and the line both need two.
        if (to <= from) return;

        // ── the band ─────────────────────────────────────────────────────────
        c.beginPath();
        for (let i = from; i <= to; i++) c.lineTo(xOf(i), yOf(max[i]));
        for (let i = to; i >= from; i--) c.lineTo(xOf(i), yOf(min[i]));
        c.closePath();
        c.fillStyle = `rgba(${bandCol},0.22)`;
        c.fill();

        // ── the average ──────────────────────────────────────────────────────
        c.beginPath();
        c.moveTo(xOf(from), h);
        for (let i = from; i <= to; i++) c.lineTo(xOf(i), yOf(mean[i]));
        c.lineTo(xOf(to), h);
        c.closePath();
        // Under the band rather than over it, at a lower alpha than the other
        // views use: the fill here is context for the line, and a solid block
        // would swallow the bottom half of the envelope it is meant to sit in.
        c.globalAlpha = d.fill === false ? 0 : 0.55;
        c.fillStyle = st.fillGrad;
        c.fill();
        c.globalAlpha = 1;

        // ── the peak ─────────────────────────────────────────────────────────
        c.beginPath();
        for (let i = from; i <= to; i++) {
            const y = yOf(max[i]);
            if (i === from) c.moveTo(xOf(i), y); else c.lineTo(xOf(i), y);
        }
        c.strokeStyle = `rgba(${peakCol},0.5)`;
        c.lineWidth = Math.max(1, st.dpr);
        c.stroke();

        // ...and the average on top of everything, which is what is being read.
        c.beginPath();
        for (let i = from; i <= to; i++) {
            const y = yOf(mean[i]);
            if (i === from) c.moveTo(xOf(i), y); else c.lineTo(xOf(i), y);
        }
        c.strokeStyle = st.traceGrad;
        c.lineWidth = (TRACE_WIDTH + 0.35) * st.dpr;
        c.lineJoin = 'round';
        c.stroke();
    });
}

// The marks over a waterfall — and, in the fusion view, the trace with them.
function drawOverlay(st, canvas, trace, levels) {
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h) return;
    const c = canvas.getContext('2d');
    c.clearRect(0, 0, w, h);
    const col = themeColors(THEME_VARS);
    drawMarks(st, c, w, h, col, true);
    drawFitMarks(st, c, w, h, col);
    if (st.has && st.has.merged) drawTrace(st, canvas, trace, levels, { mirror: false, over: true });
}

// The fit verdict on the picture itself: chevrons at the filter edges, in the
// warn colour, saying which way to move them — outward where the signal is
// being clipped, inward where the filter is mostly passing noise — and a
// pointer at a neighbour sharing the passband. Nothing for "good": a chart
// wearing a tick would be clutter.
//
// Drawn from the settled verdict (lib/ifFit.js), never the instantaneous one,
// so the chevrons hold as steady as the readout does.
function drawFitMarks(st, c, w, h, col) {
    const v = st.measured && st.measured.fit;
    if (!v || v.kind === 'ok') return;
    const t = st.tuning;
    const win = st.win;
    if (!t || !win || !(win.span > 0)) return;
    const dpr = st.dpr || 1;
    const xOf = (hz) => ((hz - win.lo) / win.span) * w;
    const s = 5 * dpr;
    const y = 9 * dpr;

    // A dark halo first, as the mark lines have: these sit over the waterfall
    // views too, where a flat warn-coloured mark disappears into a bright row.
    const shape = (path) => {
        c.beginPath();
        path();
        c.closePath();
        c.lineWidth = 2 * dpr;
        c.strokeStyle = 'rgba(0,0,0,0.45)';
        c.stroke();
        c.fillStyle = col['--warn'] || '#f2b544';
        c.fill();
    };
    // Sideways chevron at an edge, pointing the way the edge should move.
    const tri = (x, dir) => shape(() => {
        c.moveTo(x + dir * s, y);
        c.lineTo(x, y - s);
        c.lineTo(x, y + s);
    });

    const lo = xOf(t.frequency + Math.min(t.bandwidthLow, t.bandwidthHigh));
    const hi = xOf(t.frequency + Math.max(t.bandwidthLow, t.bandwidthHigh));
    if (v.kind === 'narrow') {
        if (v.edge !== 'high') tri(lo, -1);
        if (v.edge !== 'low') tri(hi, 1);
    } else if (v.kind === 'wide') {
        if (v.edge !== 'high') tri(lo, 1);
        if (v.edge !== 'low') tri(hi, -1);
    } else if (v.kind === 'neighbour') {
        // Pointing down at the intruder, where the eye should go.
        const x = xOf(t.frequency + v.offsetHz);
        shape(() => {
            c.moveTo(x, y + s);
            c.lineTo(x - s, y - s);
            c.lineTo(x + s, y - s);
        });
    }
}

// The filter and the dial, the same three marks and the same colours the main
// spectrum carries — so a passband edge is one colour wherever it is drawn.
//
// Over a waterfall the shading is lighter and the lines keep a halo: there the
// marks sit *on* the picture rather than behind it, and a flat line the same
// weight as it is over a spectrum disappears into a bright row.
function drawMarks(st, c, w, h, col, over) {
    const t = st.tuning;
    const win = st.win;
    if (!t || !win || !(win.span > 0)) return;
    const xOf = (hz) => ((hz - win.lo) / win.span) * w;
    const dpr = st.dpr || 1;

    const x0 = xOf(t.frequency + Math.min(t.bandwidthLow, t.bandwidthHigh));
    const x1 = xOf(t.frequency + Math.max(t.bandwidthLow, t.bandwidthHigh));
    if (x1 > 0 && x0 < w) {
        c.fillStyle = col['--spec-band'] || 'rgba(124,108,247,0.20)';
        c.globalAlpha = over ? 0.55 : 1;
        c.fillRect(x0, 0, Math.max(1, x1 - x0), h);
        c.globalAlpha = 1;
    }

    const line = (x, colour, dash, width) => {
        if (x < -1 || x > w + 1) return;
        const px = Math.round(x) + 0.5;
        c.beginPath();
        c.moveTo(px, 0);
        c.lineTo(px, h);
        c.setLineDash([dash[0] * dpr, dash[1] * dpr]);
        if (over) {
            c.lineWidth = (width + 2) * dpr;
            c.strokeStyle = 'rgba(0,0,0,0.45)';
            c.stroke();
        }
        c.lineWidth = width * dpr;
        c.strokeStyle = colour;
        c.stroke();
        c.setLineDash([]);
    };

    for (const hz of [t.frequency + t.bandwidthLow, t.frequency + t.bandwidthHigh]) {
        line(xOf(hz), st.marks.edge, [4, 3], 1.2);
    }
    // Last, so where the passband collapses onto the dial the dial is what is
    // left on top.
    line(xOf(t.frequency), st.marks.dial, [6, 4], 1.6);
}

// Runs of consecutive measured pixels, so a gap in the data is a gap in the
// picture. `cb(from, to)` gets inclusive bounds and is not called for a run of
// one, which has no line to draw and would leave a stray dot.
function eachRun(trace, cb) {
    const n = trace.length;
    let from = -1;
    for (let x = 0; x < n; x++) {
        const ok = Number.isFinite(trace[x]);
        if (ok && from < 0) from = x;
        if (!ok && from >= 0) {
            if (x - 1 > from) cb(from, x - 1);
            from = -1;
        }
    }
    if (from >= 0 && n - 1 > from) cb(from, n - 1);
}

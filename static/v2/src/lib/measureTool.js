// The Measure tool's live state, and the settings behind it.
//
// Three things need to agree about one measurement and none of them can own it:
// the spectrum, which takes the gesture that draws the region and knows where
// the bins are; the overlay, which paints the region and its derived edges over
// the trace; and the panel, which reads the numbers out and offers the buttons.
// A React context would be a re-render of the whole tree to say a frequency
// changed, and the readout changes several times a second — so this is a store
// of its own, in the way lib/tuneLock.js and lib/spectrumPause.js are.
//
// ── Why the tool state and the reading are two stores ────────────────────────
//
// The state — running or not, where the region is — changes when somebody does
// something, a few times a minute. The reading changes at the rate the engine
// publishes, several times a second, for as long as the tool is on. Those are
// different subscriptions with different costs, and a component that only needs
// to know whether the tool is running (the spectrum, for its cursor and its
// gestures) must not be woken for every frame's SNR.
//
// ── Where the reading comes from ─────────────────────────────────────────────
//
// One computer, not one per reader: MeasureWatch. It is mounted for the life of
// the session rather than living in the panel, which is what lets the tool keep
// measuring on a phone with the sheet shut and the spectrum full-bleed — the
// case the whole gesture takeover exists for. See components/MeasureWatch.jsx.

import { DEFAULT_OBW, DEFAULT_OCCUPANCY_DB, DEFAULT_X_DB, OBW_PERCENTS, X_DB_LEVELS } from './measure.js';

// ── the tool ────────────────────────────────────────────────────────────────

const stateSubs = new Set();

let state = {
    // Whether the spectrum's presses belong to this tool. The one flag that
    // changes what a click on the display does, so it is deliberately the thing
    // the Start/Stop button sets and nothing else touches.
    active: false,
    // The region, in hertz. A frequency range and not a pixel range, so it
    // stays over the same signal when the view is zoomed or panned — which is
    // the whole point of being able to zoom in while a measurement is running.
    selection: null,
    // A drag is in progress. The panel says "drawing" rather than showing half
    // a measurement as final, and the run is not started until the drag ends.
    drawing: false,
    // The readout is being held still so it can be read. Stops the engine
    // publishing *and* accumulating: a frozen run that carried on counting
    // frames would report an occupancy for a period nobody was watching.
    frozen: false,
};

function notifyState() {
    for (const fn of [...stateSubs]) {
        try { fn(state); } catch (e) { console.error('measure state listener threw', e); }
    }
}

export function measureState() {
    return state;
}

export function onMeasureState(fn) {
    stateSubs.add(fn);
    return () => { stateSubs.delete(fn); };
}

/**
 * The one writer. Patches, and says nothing when nothing changed.
 *
 * The equality check earns its place: the spectrum writes `drawing` on every
 * move of a drag, and without it each of those would wake every subscriber to
 * be told what it already knew.
 */
export function setMeasureState(patch) {
    let changed = false;
    for (const k of Object.keys(patch)) {
        if (state[k] !== patch[k]) { changed = true; break; }
    }
    if (!changed) return state;
    state = { ...state, ...patch };
    notifyState();
    return state;
}

// ── the reading ─────────────────────────────────────────────────────────────

const resultSubs = new Set();
let result = null;

export function measureResult() {
    return result;
}

export function onMeasureResult(fn) {
    resultSubs.add(fn);
    return () => { resultSubs.delete(fn); };
}

export function setMeasureResult(next) {
    result = next;
    for (const fn of [...resultSubs]) {
        try { fn(result); } catch (e) { console.error('measure result listener threw', e); }
    }
}

// ── what the buttons do ─────────────────────────────────────────────────────
//
// Named actions rather than setMeasureState calls scattered over three files,
// because each of them is a small policy and the policies are the part that has
// to be the same wherever the button is — the panel has all of them, the badge
// over the spectrum has Stop, and a keyboard has Escape.

/**
 * Start measuring.
 *
 * Any region already drawn is kept: somebody who stopped to read the numbers
 * and pressed Start again meant "carry on", not "throw that away". What is
 * thrown away is the run — the min/max/occupancy figures are about a period,
 * and a period that was interrupted is two periods.
 */
export function startMeasure() {
    setMeasureResult(null);
    setMeasureState({ active: true, frozen: false, drawing: false });
}

/**
 * Stop.
 *
 * The region and the last reading stay on screen. Stopping is what an operator
 * does in order to *read* the thing, so clearing it would be the opposite of
 * what the press meant; Clear is a separate button for the separate intention.
 */
export function stopMeasure() {
    setMeasureState({ active: false, drawing: false, frozen: false });
}

/** Region gone, reading gone, tool left as it was. */
export function clearMeasure() {
    setMeasureResult(null);
    setMeasureState({ selection: null, drawing: false });
}

/**
 * Where the region is.
 *
 * Normalised on the way in so that everything downstream can assume lo ≤ hi,
 * and dropped entirely if it has no width — a zero-width region is a tap that
 * got as far as this function, not a measurement.
 */
export function setSelection(sel, { drawing = false } = {}) {
    if (!sel || !Number.isFinite(sel.loHz) || !Number.isFinite(sel.hiHz)) {
        setMeasureState({ selection: null, drawing: false });
        return;
    }
    const loHz = Math.min(sel.loHz, sel.hiHz);
    const hiHz = Math.max(sel.loHz, sel.hiHz);
    if (!(hiHz > loHz)) {
        setMeasureState({ drawing });
        return;
    }
    const cur = state.selection;
    if (cur && cur.loHz === loHz && cur.hiHz === hiHz && state.drawing === drawing) return;
    setMeasureState({ selection: { loHz, hiHz }, drawing });
}

export function setMeasureFrozen(frozen) {
    setMeasureState({ frozen: !!frozen });
}

// ── settings ────────────────────────────────────────────────────────────────
//
// Persisted per browser, in the shape the rest of this interface persists a
// panel's own preferences (lib/markerNavSettings.js): one key, read through a
// validator, written through the only setter, announced to whoever is listening
// so two copies of the panel cannot disagree.

const KEY = 'ubersdr.v2.measure';

/**
 * How long the trace is averaged for before anything is measured on it, in ms.
 *
 * Not a cosmetic smoother. Every level below the peak — the −20 dB points, the
 * floor, the occupied bandwidth — is measured on the noise as much as on the
 * signal, and on a single frame those readings move by decibels between one
 * frame and the next. A second of averaging turns them into numbers that can be
 * written down. It is the "video averaging" control of a bench analyser and it
 * is applied to a copy, so the trace on screen is untouched.
 *
 * Off is offered because averaging hides a signal that is changing fast, which
 * is sometimes the thing being looked at.
 */
export const AVERAGE_MS = [0, 500, 1000, 2000, 5000];

export const MEASURE_DEFAULTS = {
    xDb: DEFAULT_X_DB,
    obw: DEFAULT_OBW,
    occupancyDb: DEFAULT_OCCUPANCY_DB,
    averageMs: 1000,
    // The level-against-time strip. On by default: it is the half of the panel
    // that says something a single reading cannot, and it costs one small
    // canvas.
    chart: true,
};

const num = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

/** A stored settings object made safe, field by field. */
export function cleanSettings(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    let xDb = MEASURE_DEFAULTS.xDb;
    if (Array.isArray(s.xDb)) {
        const kept = [...new Set(s.xDb.filter((d) => X_DB_LEVELS.includes(d)))].sort((a, b) => a - b);
        // An empty list is a real choice — the widths are the busiest part of
        // the overlay and switching them all off is reasonable. A list this
        // build recognises *none* of is not: it was a real choice made against
        // a vocabulary that has since changed, and honouring it as "off" would
        // silently remove levels nobody removed. That falls back.
        if (kept.length || !s.xDb.length) xDb = kept;
    }
    return {
        xDb,
        obw: num(Number(s.obw), OBW_PERCENTS, MEASURE_DEFAULTS.obw),
        occupancyDb: Number.isFinite(Number(s.occupancyDb))
            ? Math.max(0, Math.min(40, Number(s.occupancyDb)))
            : MEASURE_DEFAULTS.occupancyDb,
        averageMs: num(Number(s.averageMs), AVERAGE_MS, MEASURE_DEFAULTS.averageMs),
        chart: s.chart !== false,
    };
}

let settings = null;
const settingSubs = new Set();

export function measureSettings() {
    if (settings) return settings;
    try {
        const rawText = localStorage.getItem(KEY);
        settings = cleanSettings(rawText == null ? null : JSON.parse(rawText));
    } catch (e) {
        settings = cleanSettings(null);
    }
    return settings;
}

export function saveMeasureSettings(patch) {
    const next = cleanSettings({ ...measureSettings(), ...patch });
    settings = next;
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (e) { /* private mode */ }
    for (const fn of [...settingSubs]) {
        try { fn(next); } catch (e) { console.error('measure settings listener threw', e); }
    }
    return next;
}

export function onMeasureSettings(fn) {
    settingSubs.add(fn);
    return () => { settingSubs.delete(fn); };
}

/** Tests only: forget everything, so one case cannot leak into the next. */
export function resetMeasure() {
    state = { active: false, selection: null, drawing: false, frozen: false };
    result = null;
    settings = null;
}

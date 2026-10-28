// What the spectrum draws, and answers to, for the VFOs listened to alongside
// the main receiver.
//
// Pure, so the questions that decide what the operator sees — which passbands
// are drawn, which one the pointer is on, how bright one is — can be tested
// without a canvas. SpectrumView and MarkerBar do the drawing.
//
// A listening VFO is drawn like the main receiver: a wash over its passband and
// the dial and edge lines, in its own colour (lib/vfoColours.js). The passband is
// the filter it is playing with about the VFO's own frequency — main's, until
// it is given one of its own (lib/vfos.js listenEdges) — never its saved slot's,
// which belongs to a mode it is not in and would show a passband nothing is
// demodulating.

import { VFO_IDS, cleanSlot, isListening, listenBlockedReason, listenEdges, listenOf } from './vfos.js';
import { vfoColour } from './vfoColours.js';
import { edgeHit } from './edgeHit.js';

/**
 * The listening VFOs as the spectrum draws them, in A–D order.
 *
 * @param state   the VFO store (lib/vfos.js)
 * @param snap    the engine's snapshot() (radio/subReceivers.js), or null. A VFO
 *                the server's limit leaves out (`overLimit`) is not playing and
 *                is not drawn.
 * @param tuning  the main receiver's, for the mode and main's filter. In IQ nothing is
 *                drawn: listening ends there (lib/vfos.js), and this answers so
 *                from the same render rather than a frame after the flags clear.
 * @param limit   the server's VFO count; at 1 nothing is listening.
 * @returns {Array<{id, frequency, low, high, own, colour, open, gated}>} —
 *          `own` when the filter is the VFO's own rather than main's, `gated`
 *          when it has a squelch on at all (its own or main's).
 */
export function listeningPassbands(state, snap, tuning, limit) {
    const out = [];
    if (!state || !tuning || listenBlockedReason(tuning.mode)) return out;
    for (const id of VFO_IDS) {
        if (!isListening(state, id, limit)) continue;
        const slot = cleanSlot(state.slots[id]);
        if (!slot) continue;
        const live = snap && snap.vfos ? snap.vfos[id] : null;
        if (live && live.overLimit) continue;
        const edges = listenEdges(listenOf(state, id), tuning);
        out.push({
            id,
            frequency: slot.frequency,
            low: edges.low,
            high: edges.high,
            own: edges.own,
            colour: vfoColour(id),
            open: !!(live && live.squelchOpen),
            gated: !!(live && live.threshold != null),
        });
    }
    return out;
}

/**
 * The listening passband under a pointer, or null.
 *
 * `x` and `width` are in the same units (CSS px); `cfg` is the view
 * ({centerFreq, span}). Where two passbands overlap the one whose dial is
 * nearer wins — it is the one the pointer is more plausibly aimed at. `grab`
 * widens each passband by a few pixels, as the main receiver's own hit test
 * does, so a filter collapsed to a line at a wide zoom can still be taken hold of.
 */
export function passbandAt(x, list, cfg, width, grab = 6) {
    if (!cfg || !cfg.span || !width || !list || !list.length) return null;
    const xAt = (hz) => ((hz - (cfg.centerFreq - cfg.span / 2)) / cfg.span) * width;
    let best = null;
    let bestD = Infinity;
    for (const v of list) {
        const dial = xAt(v.frequency);
        const a = xAt(v.frequency + v.low);
        const b = xAt(v.frequency + v.high);
        const lo = Math.min(a, b, dial) - grab;
        const hi = Math.max(a, b, dial) + grab;
        if (x < lo || x > hi) continue;
        const d = Math.abs(x - dial);
        if (d < bestD) { best = v.id; bestD = d; }
    }
    return best;
}

/**
 * The listening passband edge under a pointer, as `{id, which}`, or null —
 * dragging it gives that VFO a filter of its own. The same zones as the main
 * receiver's edges (lib/edgeHit.js), so a passband too narrow on screen to
 * grab has none and a drag there retunes instead; where two VFOs' edges are
 * both in reach the nearer edge wins.
 */
export function listenEdgeAt(x, list, cfg, width, grab, minPx) {
    if (!cfg || !cfg.span || !width || !list || !list.length) return null;
    const xAt = (hz) => ((hz - (cfg.centerFreq - cfg.span / 2)) / cfg.span) * width;
    let best = null;
    let bestD = Infinity;
    for (const v of list) {
        const t = { frequency: v.frequency, bandwidthLow: v.low, bandwidthHigh: v.high };
        const which = edgeHit(x, width, cfg.span, cfg.centerFreq, t, grab, minPx);
        if (!which) continue;
        const d = Math.abs(x - xAt(v.frequency + (which === 'low' ? v.low : v.high)));
        if (d < bestD) { best = { id: v.id, which }; bestD = d; }
    }
    return best;
}

// --- the squelch brighten ---------------------------------------------------
//
// A passband is drawn brighter while its squelch is open, so with three VFOs
// playing the eye goes to the one that is actually saying something — the
// spectrum shows where signals are, and this shows which of them is getting
// through. Main and listening VFOs alike (radio/squelchState.js squelchBrightens
// decides when); the change is eased rather than switched, because a gate that
// opens and shuts on every syllable would otherwise strobe.

/** How much brighter an open passband's wash is: 1 + this, i.e. ~1.7x. */
export const BRIGHTEN_GAIN = 0.7;
/** The ease's time constant, ms. */
export const BRIGHTEN_TAU_MS = 150;

/**
 * One step of the ease from `cur` toward `target` (both 0..1) after `dtMs`.
 * Exponential, so it is the same speed whatever the frame rate — the spectrum
 * repaints when frames arrive, and those come at whatever rate the server sends.
 */
export function easeLevel(cur, target, dtMs, tauMs = BRIGHTEN_TAU_MS) {
    const c = Number.isFinite(cur) ? cur : 0;
    if (!(dtMs > 0)) return c;
    const k = 1 - Math.exp(-dtMs / tauMs);
    const next = c + (target - c) * k;
    // Settle exactly, rather than approaching for ever and keeping the
    // waterfall-marks cache key changing by a millionth every frame.
    return Math.abs(next - target) < 0.01 ? target : next;
}

/** A wash's alpha at brighten `level` (0..1), from its resting alpha. */
export function washAlpha(base, level) {
    const l = Math.max(0, Math.min(1, Number(level) || 0));
    return Math.min(1, base * (1 + BRIGHTEN_GAIN * l));
}

/**
 * The alpha to draw a themed wash a *second* time with, over itself, so the two
 * together come out at washAlpha(base, level).
 *
 * The main receiver's wash is --spec-band, which a theme may set to any CSS
 * colour, and globalAlpha cannot go above 1 — so it is brightened by a second
 * pass rather than by a stronger colour. Source-over gives a + k·a·(1 − a),
 * and this is the k that makes that the target.
 */
export function overlayAlpha(base, level) {
    const a = Math.max(0, Math.min(0.99, Number(base) || 0));
    if (a === 0) return 0;
    const want = washAlpha(a, level);
    return Math.max(0, Math.min(1, (want - a) / (a * (1 - a))));
}

/** The alpha a CSS colour carries: rgba()/hsla()/#rrggbbaa, else 1. */
export function alphaOf(css) {
    const s = String(css || '').trim();
    const m = s.match(/^(?:rgba|hsla)\(([^)]*)\)$/i);
    if (m) {
        const parts = m[1].split(/[\s,/]+/).filter(Boolean);
        if (parts.length >= 4) {
            const v = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
            return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
        }
        return 1;
    }
    if (/^#[0-9a-f]{8}$/i.test(s)) return parseInt(s.slice(7, 9), 16) / 255;
    return 1;
}

/** The dial and edge lines are strengthened too, but only slightly: a width factor. */
export function markBoost(level) {
    const l = Math.max(0, Math.min(1, Number(level) || 0));
    return 1 + 0.3 * l;
}

// --- the shift-click target -------------------------------------------------
//
// A plain click on the spectrum tunes the main receiver, always. A shift-click
// tunes a listening VFO instead — the one the operator last laid a hand on, by
// dragging its passband, picking its row or retuning it from the menu. Kept here
// rather than in the spectrum so the panel and the menu can mark a VFO as
// touched too.

let touched = null;

/** Mark `id` as the listening VFO most recently handled. */
export function touchVfo(id) {
    if (VFO_IDS.includes(id)) touched = id;
}

/**
 * Which listening VFO a shift-click tunes: the last one touched if it is still
 * listening, else the first listening one, else null. `limit` as for
 * listeningPassbands.
 */
export function shiftTarget(state, limit) {
    if (touched && isListening(state, touched, limit)) return touched;
    for (const id of VFO_IDS) if (isListening(state, id, limit)) return id;
    return null;
}

/** For the tests. */
export function resetTouched() {
    touched = null;
}

/** A cache-key fragment for a set of listening passbands, for the waterfall marks. */
export function passbandsKey(list) {
    return (list || []).map((v) => `${v.id}${v.frequency}:${v.low}:${v.high}`).join(',');
}

/**
 * The VFO circles the marker bar draws, each with its `kind`:
 *
 *   'parked'     a VFO holding a frequency, not being heard — only when the
 *                operator has the VFO markers on (`showParked`).
 *   'listening'  a VFO being heard alongside the main receiver. Drawn whatever
 *                that setting says: it is playing, and a sound with no mark to
 *                say where it is coming from is the thing to avoid.
 *   'main'       the receiver itself, only while something else is listening —
 *                then there are several "where am I"s and this is the one the
 *                dial belongs to. Otherwise the dial says it and a circle would
 *                be one more thing on the bar.
 *
 * `limit` is the server's VFO count: at one, nothing is listening whatever the
 * store remembers.
 */
export function vfoMarkerItems(state, tuning, { showParked = true, limit = 1 } = {}) {
    const out = [];
    if (!state || !state.slots) return out;
    const live = Number(tuning && tuning.frequency);
    let any = false;
    for (const id of VFO_IDS) {
        if (id === state.active) continue;
        const slot = cleanSlot(state.slots[id]);
        if (!slot) continue;
        const listening = isListening(state, id, limit);
        if (listening) any = true;
        if (!listening && !showParked) continue;
        // A parked VFO sitting exactly on the dial is the dial; a listening one
        // there is still a second stream and keeps its mark.
        if (!listening && Number.isFinite(live) && slot.frequency === live) continue;
        out.push({ id, ...slot, kind: listening ? 'listening' : 'parked' });
    }
    if (any && live > 0) {
        out.push({
            id: state.active,
            frequency: live,
            mode: tuning.mode,
            kind: 'main',
        });
    }
    return out;
}

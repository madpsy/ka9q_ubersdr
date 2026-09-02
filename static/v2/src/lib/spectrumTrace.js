// How a spectrum trace is drawn, shared by the panes that draw one.
//
// The main spectrum and the band spectrum panel are the same picture of
// different data — one whole receiver, one band at the resolution it is
// recorded — and they looked different only because the second was written
// later. These are the parts that decide how a trace *reads*: how bins are
// collapsed onto pixels, and the palette gradients that colour it by level.
// Both panes import them, so a change to either shows up in both.

import { getPalette } from './palettes.js';

// The trace is drawn from a compressed slice of the palette (TRACE_FLOOR..1)
// because most palettes start at near-black, which would make weak signals
// invisible against the dark background.
export const TRACE_FLOOR = 0.35;
export const GRAD_STOPS = 24;

// Stroke weight of an unfilled trace, in CSS px.
export const TRACE_WIDTH = 1.25;

// Vertical palette gradients for the spectrum, so the trace and its fill use
// the same colour-per-amplitude mapping as the waterfall: hot at the top of the
// dB range, cold at the bottom, with the same `contrast` gamma applied.
//
// The fill is opaque. A translucent wash reads as a tint rather than a filled
// spectrum, and leaving it solid is what makes the backdrop image work: the
// image shows in the open area above the trace, with the signal a solid block
// below it.
//
export function paletteGradients(c, H, palette, contrast) {
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


// ── The dB scale ────────────────────────────────────────────────────────────
//
// The numbers down the left of a spectrum, drawn inside the picture rather than
// in a gutter beside it: these panes are a dock column wide and a couple of
// hundred pixels tall, and a margin wide enough for "-100" would cost an eighth
// of the passband. The cost is that the labels sit over the lowest part of the
// window, which is the emptiest part of an SSB passband.
//
// Here rather than in either panel because the audio scope and the IF pane both
// draw one and they have to read the same: same ladder, same notch, same
// placement. What differs is the window and the gamma, which are arguments.
//
// A ladder rather than a fixed step: these windows run from 45 dB at their
// narrowest to 120 at their widest — auto ranging picks it from the signal, and
// the level controls can put it anywhere — so a step that reads well in one is
// a wall of numbers or a single lonely label in another. The first step that
// leaves the labels far enough apart wins.
//
// 10/20/50 because those are the divisions a dB axis is read in. 25 would fit
// a 90 dB window more evenly than 20 does and was left out anyway: an axis
// counting in 25s costs more to read than the one wasted label saves.
const DB_STEPS = [10, 20, 50, 100];
// CSS px: the closest two labels may sit, and the most of them a scale may
// carry. The gap alone is not enough — these panes run from a 57 px split trace
// to a 320 px fusion, and on the tall one a 10 dB step clears the gap easily
// enough to put a dozen numbers down the side. A scale is read by glancing at
// it, so it wants to be sparse rather than complete.
const DB_LABEL_GAP = 18;
const DB_MAX_LABELS = 7;
const DB_TICK = 5;         // CSS px, the length of a notch

// Where a step's labels would land, top first, with the ones that would hang
// off an edge dropped: half a label is worse than none, because it reads as a
// different number.
function scaleTicks(step, floor, range, h, contrast, pad) {
    const out = [];
    for (let db = Math.floor((floor + range) / step) * step; db > floor; db -= step) {
        let t = (db - floor) / range;
        if (contrast && contrast !== 1) t = Math.pow(t, 1 / contrast);
        const y = h - t * h;
        if (y < pad || y > h - pad) continue;
        out.push({ db, y });
    }
    return out;
}

/**
 * The scale itself, over whatever has already been drawn.
 *
 * `floor` and `range` are the dB window the picture was drawn in, and
 * `contrast` the gamma the *geometry* was drawn with — 1 where the contrast
 * only colours, as it does in the trace panes. Get that wrong and the numbers
 * describe a scale nothing is drawn on: every label but the ends lands in the
 * wrong place, which is worse than no scale at all.
 *
 * `ink` is passed in rather than read here because the two callers keep their
 * theme colours in two different caches, and a third read would be a third
 * cache to remember to invalidate.
 *
 * Numbers alone, with no unit anywhere: negative numbers down the side of an
 * audio spectrum are dB and nothing else, and the word costs a third of the
 * label's width on a panel where the width is the passband.
 */
export function drawDbScale(c, { h, dpr, floor, range, contrast = 1, ink }) {
    const font = 8.5 * dpr;
    const pad = font * 0.75;                          // keeps a label off either edge
    const tick = Math.max(2, Math.round(DB_TICK * dpr));
    const x = tick + 3 * dpr;

    // The first step that is both far enough apart and few enough — measured on
    // the positions themselves, not on dB per pixel. Contrast bends the scale,
    // and it bends it hardest at the top, so a step that divides the window
    // evenly can still put its top two labels on each other.
    //
    // A step that leaves fewer than two labels in the window is too coarse to
    // be a scale at all, so the search stops before it and keeps the last one
    // that was: two tight labels say more than one comfortable one.
    const min = DB_LABEL_GAP * dpr;
    const spaced = (t) => t.every((v, i) => i === 0 || v.y - t[i - 1].y >= min);
    let ticks = [];
    for (const step of DB_STEPS) {
        const t = scaleTicks(step, floor, range, h, contrast, pad);
        if (t.length < 2) break;
        ticks = t;
        if (spaced(t) && t.length <= DB_MAX_LABELS) break;
    }
    // Not even the finest step put two labels in the window — a narrow window
    // with the contrast turned down does it, which pushes everything below the
    // bottom label off the panel. One label is still worth drawing: it is a
    // level, and a level is the thing being asked for.
    if (!ticks.length) ticks = scaleTicks(DB_STEPS[0], floor, range, h, contrast, pad);
    // If none of them passed, the kept set is the coarsest that had two labels
    // in it and is still crowded somewhere: drop the ones that crowd, measuring
    // from the last label kept rather than from the last one considered. A set
    // that did pass loses nothing here, so this needs no condition of its own.
    const kept = [];
    for (const t of ticks) if (!kept.length || t.y - kept[kept.length - 1].y >= min) kept.push(t);
    ticks = kept;

    c.font = `${font}px ui-monospace, monospace`;
    c.textBaseline = 'middle';
    c.textAlign = 'left';
    c.lineJoin = 'round';

    for (const { db, y } of ticks) {
        c.strokeStyle = ink;
        c.lineWidth = Math.max(1, Math.round(dpr));
        c.beginPath();
        c.moveTo(0, Math.round(y) + 0.5);
        c.lineTo(tick, Math.round(y) + 0.5);
        c.stroke();

        const label = String(Math.round(db));
        // Outlined, because what is behind a label changes: the black headroom,
        // the energy wash, and the top of a full-scale bar are three different
        // backgrounds, and white on its own is unreadable against the third.
        c.lineWidth = Math.max(2, Math.round(2 * dpr));
        c.strokeStyle = 'rgba(0,0,0,0.65)';
        c.strokeText(label, x, y);
        c.fillStyle = ink;
        c.fillText(label, x, y);
    }
}


// Theme colours, resolved once per theme. getComputedStyle forces a style
// recalculation, so calling it inside the draw loop would cost more than the
// rendering itself.
let themeCache = null;

// Drop it. The cache is keyed on the theme, which is enough while the values
// come only from the stylesheet — but the accent is settable now (see
// DisplayContext), and a colour changed without the theme changing has to reach
// the canvas too.
export function invalidateThemeColors() {
    themeCache = null;
}

export function themeColors(vars) {
    const theme = document.documentElement.dataset.theme || 'dark';
    if (themeCache && themeCache.theme === theme) return themeCache;
    const css = getComputedStyle(document.documentElement);
    const out = { theme };
    for (const name of vars) out[name] = css.getPropertyValue(name).trim();
    themeCache = out;
    return out;
}


// Collapses `bins` onto `width` pixels, taking the maximum of each pixel's bin
// range so narrow carriers survive downsampling.
export function binsToPixels(bins, width, out) {
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


// Tick positions for a frequency ruler: minors every fifth of a step, majors on
// the step itself, chosen for about one label per 110 CSS px.
//
// Shared by the two rulers, so the notches under the waterfall land on the same
// frequencies as the ones above it however the view is zoomed or panned — two
// scales that disagreed by a pixel would be worse than one.
export function frequencyTicks(cfg, cssW) {
    // A zero or missing span divides through to a zero step, and a loop stepping
    // by zero never ends — it hangs the tab rather than drawing a bad ruler.
    // Both callers guard already; a shared function should not need them to.
    if (!cfg || !(cfg.span > 0) || !(cssW > 0)) return { ticks: [], step: 0 };
    const lo = cfg.centerFreq - cfg.span / 2;
    const hi = cfg.centerFreq + cfg.span / 2;
    const targetTicks = Math.max(2, Math.floor(cssW / 110));
    const rough = cfg.span / targetTicks;
    const pow = Math.pow(10, Math.floor(Math.log10(rough)));
    const mult = [1, 2, 2.5, 5, 10].find((m) => pow * m >= rough) || 10;
    const step = pow * mult;

    const minor = step / 5;
    const out = [];
    for (let i = Math.ceil(lo / minor); i <= Math.floor(hi / minor); i++) {
        const f = i * minor;
        out.push({ hz: f, frac: (f - lo) / cfg.span, major: i % 5 === 0 });
    }
    return { ticks: out, step };
}


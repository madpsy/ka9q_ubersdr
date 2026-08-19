// Drawing for the audio waterfall, shared by the audio scope and the filter
// panel's preview so both read the same way: same palette, same auto level,
// same silence handling, same frequency window.
//
// The x axis is the audio the current mode actually carries — see audioBand.js
// — not Nyquist.

import { getPalette } from './palettes.js';
import { audioBins } from './audioBand.js';

// How fast the history scrolls, in rows a second. A setting rather than the
// fixed 33 ms v1 runs at: what it should be depends on what is being watched —
// a slow CW signal wants minutes on screen, and reading a digital burst wants
// the opposite.
//
// The maximum is also the default, and both are 60 deliberately. Frames arrive
// at the analyser's own cadence, which is a display frame — so one row per frame
// is as fast as this can go however high the number, and asking for more would
// be a slider with a dead top end. From there it only slows down.
const DEFAULT_ROWS_PER_SEC = 60;
export const AUDIO_WF_RATE_MIN = 2;
export const AUDIO_WF_RATE_MAX = 60;

/**
 * How long a committed row holds the top of the waterfall, in ms.
 *
 * Clamped rather than trusted. This divides, so a zero or a missing setting —
 * which is what a stored value from an older layout looks like — would come out
 * as Infinity and commit no rows at all: a waterfall frozen with no error and
 * nothing to suggest the speed slider caused it.
 */
export function audioRowMs(rowsPerSec) {
    const rate = Number(rowsPerSec);
    if (!Number.isFinite(rate) || rate <= 0) return 1000 / DEFAULT_ROWS_PER_SEC;
    return 1000 / Math.min(AUDIO_WF_RATE_MAX, Math.max(AUDIO_WF_RATE_MIN, rate));
}
export const WF_FLOOR_DB = -110;   // never map anything quieter than this
export const WF_MIN_SPAN_DB = 45;  // and never stretch a narrower range

export function fmtHz(hz) {
    return hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 ? 1 : 0)}k` : `${Math.round(hz)}`;
}

export function sizedCanvas(canvas, cssH) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round((cssH || canvas.clientHeight || 100) * dpr));
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }
    return { w, h, dpr };
}

// Cached per theme: these are read from inside draw loops — the audio
// waterfall's is per frame and the needle meters' is per meter sample — and
// getComputedStyle forces a style resolution every time. The tokens only ever
// change with the theme, which is stamped on the root element, so that is the
// key. An unknown theme (none set yet) caches under its own empty-string key
// and is dropped as soon as one is.
const VARS = { theme: null, seen: new Map() };

export function cssVar(name, fallback) {
    const theme = document.documentElement.dataset.theme || '';
    if (VARS.theme !== theme) {
        VARS.theme = theme;
        VARS.seen.clear();
    }
    const hit = VARS.seen.get(name);
    if (hit !== undefined) return hit || fallback;
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    VARS.seen.set(name, v);
    return v || fallback;
}

// The bottom of the manual scale, and how much of one a slider may ask for.
// -120 is below the noise of any receiver worth listening to; -30 is as high a
// floor as leaves room to see anything at all above it.
export const SCOPE_FLOOR_MIN = -120;
export const SCOPE_FLOOR_MAX = -30;
export const SCOPE_FLOOR_DEFAULT = -90;

// How wide a bar is, in CSS pixels, for each FFT size the Resolution control
// offers. This is what makes the resolution choice visible in the bar view.
//
// It has to be done by width rather than by bin count, because there is never a
// shortage of bins: even "Fast" puts several hundred across an SSB passband,
// which is already more than a panel-width canvas has room for. Every setting
// would therefore be pixel-limited to the same comb, and the control would look
// broken. Widths instead, so each step is a visibly different display: coarse
// and readable at one end, near-continuous at the other.
//
// Balanced keeps the 7 px the bars have always been drawn at, so the default
// look does not move.
const BAR_WIDTH_PX = { 2048: 14, 4096: 7, 8192: 4, 16384: 2 };
const BAR_WIDTH_DEFAULT = 7;

export function barWidth(fftSize) {
    return BAR_WIDTH_PX[fftSize] || BAR_WIDTH_DEFAULT;
}

/**
 * The dB window a frame is drawn in: where the bottom of the scale sits, and
 * how many dB it covers.
 *
 * Shared by the waterfall and the bars so the two cannot disagree about how
 * loud is loud — they are two views of one thing, and a colour that means -60
 * in one of them had better mean -60 in the other.
 *
 * **Auto** follows the frame: the floor eases to just under the quietest bin
 * and the ceiling to just over the loudest, bounded so that the gate closing
 * does not stretch a hundred dB of dither across the whole palette. It is the
 * right default and it has one cost, which is that it is *relative* — quiet
 * audio is magnified until it fills the display exactly as loud audio does, so
 * the picture cannot tell you which you have.
 *
 * **Manual** pins the floor where the operator put it and puts the ceiling at
 * full scale, which makes the display absolute: a quiet signal reads as low
 * because it is low. That is the whole reason for the switch.
 */
export function levelWindow(bins, start, count, level, floorDb) {
    if (Number.isFinite(floorDb)) {
        const floor = Math.min(SCOPE_FLOOR_MAX, Math.max(SCOPE_FLOOR_MIN, floorDb));
        // Up to 0 dBFS, which is what "full scale" means for audio that has
        // already been through the volume control. Never zero-width, however
        // the floor is clamped.
        return { floor, range: Math.max(6, -floor) };
    }

    let min = Infinity;
    let max = -Infinity;
    for (let i = start; i < start + count; i++) {
        const v = bins[i];
        if (!Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
    }
    if (Number.isFinite(min)) {
        const targetFloor = Math.max(WF_FLOOR_DB, min - 3);
        const targetCeil = Math.max(targetFloor + WF_MIN_SPAN_DB, max + 5);
        level.floor += (targetFloor - level.floor) * 0.05;
        level.ceil += (targetCeil - level.ceil) * 0.05;
    }
    return { floor: level.floor, range: Math.max(WF_MIN_SPAN_DB, level.ceil - level.floor) };
}

export function newRing() {
    return { canvas: null, ctx: null, w: 0, h: 0, head: 0, at: 0, level: { floor: -100, ceil: -30 } };
}

/**
 * Paint one frame. `marks` are vertical lines in audio Hz — the filter panel
 * uses them to show where its notches and bandpass sit — as
 * { hz, color, soft, label }. A label is drawn once at the top of its line, so
 * several notches can be told apart at a glance.
 */
export function drawAudioWaterfall({
    canvas, ring, bins, binCount, sampleRate, tuning, palette, contrast, marks, floorDb,
    rowsPerSec = DEFAULT_ROWS_PER_SEC,
}) {
    if (!canvas || !bins || bins.length !== binCount) return;
    const { w, h } = sizedCanvas(canvas);

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

    const { start, count, startFreq, endFreq } = audioBins(
        tuning.bandwidthLow, tuning.bandwidthHigh, sampleRate, binCount,
    );

    const { floor, range } = levelWindow(bins, start, count, ring.level, floorDb);

    // Frames arrive as fast as the analyser produces them; this decides how many
    // of them become history.
    const rowMs = audioRowMs(rowsPerSec);

    const now = performance.now();
    if (now - ring.at >= rowMs) {
        ring.at = now;
        const lut = getPalette(palette);
        const img = ring.ctx.createImageData(w, 1);
        const data = img.data;
        for (let x = 0; x < w; x++) {
            const lo = start + Math.floor((x / w) * count);
            const hi = Math.max(lo + 1, start + Math.floor(((x + 1) / w) * count));
            let v = -Infinity;
            for (let i = lo; i < hi; i++) if (bins[i] > v) v = bins[i];
            let t = (v - floor) / range;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            if (contrast && contrast !== 1) t = Math.pow(t, 1 / contrast);
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

    // Marker lines go on the visible canvas, never into the ring, or they would
    // scroll away with the history instead of standing still.
    if (marks && marks.length && endFreq > startFreq) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        for (const m of marks) {
            const x = ((m.hz - startFreq) / (endFreq - startFreq)) * w;
            if (x < 0 || x > w) continue;
            c.strokeStyle = m.color;
            c.lineWidth = m.soft ? 1 : 1.5;
            if (m.soft) c.setLineDash([2, 4]);
            c.beginPath();
            c.moveTo(Math.round(x) + 0.5, 0);
            c.lineTo(Math.round(x) + 0.5, h);
            c.stroke();
            c.setLineDash([]);

            if (!m.label) continue;
            // A small tag at the top of the line. Kept inside the canvas at
            // both edges, so a notch parked at the end of the passband is still
            // identifiable.
            c.font = `600 ${9 * dpr}px ui-sans-serif, system-ui, sans-serif`;
            c.textBaseline = 'top';
            const tw = c.measureText(m.label).width;
            const bw = tw + 6 * dpr;
            const bx = Math.max(0, Math.min(w - bw, x - bw / 2));
            c.fillStyle = m.color;
            c.fillRect(bx, 0, bw, 12 * dpr);
            c.fillStyle = '#0b1016';
            c.textAlign = 'center';
            c.fillText(m.label, bx + bw / 2, 2 * dpr);
        }
    }
}

/** State for the bar view's own auto-level, kept by whoever draws it. */
export function newBarLevel() {
    return { floor: -100, ceil: -30 };
}

/**
 * The audio spectrum as bars, the other thing the scope canvas can be.
 *
 * Same frame, same window and same auto-level as the waterfall above — which is
 * the point of it living here rather than in the panel. A bar view that
 * disagreed with the waterfall under it about where 1 kHz is, or about how loud
 * is loud, would be two instruments rather than two views.
 *
 * Bandwidth changes need no handling at all, and that is worth saying because
 * it looks like it should: `audioBins` answers with the window the *current*
 * mode carries, so the bars are re-laid across the passband on the first frame
 * after a mode or filter change, exactly as the waterfall's columns are.
 *
 * The colour is a gradient over height rather than per bar, so a given colour
 * always means the same level wherever it appears — a bar meter, in the same
 * palette as everything else here. Colouring each bar by its own peak was the
 * other option and reads worse: the whole display changes hue when one signal
 * arrives, and the eye reports that as everything having got louder.
 *
 * `fftSize` sets how many bars there are, via barWidth below.
 */
export function drawAudioBars({
    canvas, bins, binCount, sampleRate, tuning, palette, contrast, level, floorDb, fftSize,
}) {
    if (!canvas || !bins || bins.length !== binCount) return;
    const { w, h, dpr } = sizedCanvas(canvas);
    const c = canvas.getContext('2d', { alpha: false });
    c.fillStyle = '#05070c';
    c.fillRect(0, 0, w, h);

    const { start, count } = audioBins(
        tuning.bandwidthLow, tuning.bandwidthHigh, sampleRate, binCount,
    );
    if (!(count > 0)) return;

    const { floor, range } = levelWindow(bins, start, count, level, floorDb);

    // Bar width in device pixels, from a target in CSS pixels. Whole pixels, or
    // neighbouring bars round differently and the row develops a moiré of gaps
    // that looks like missing data.
    const target = Math.max(2, Math.round(barWidth(fftSize) * dpr));
    // The gap has to give way as the bars narrow. A fixed 2 px beside a 4 px bar
    // is a third of the row spent on nothing, and the display reads as sparse
    // rather than as fine.
    const gap = target >= 8 && dpr >= 2 ? 2 : 1;
    const step = target + gap;
    const bars = Math.max(1, Math.floor(w / step));

    const lut = getPalette(palette);
    const colour = (t) => {
        const i = Math.max(0, Math.min(255, (t * 255) | 0)) * 3;
        return `rgb(${lut[i]},${lut[i + 1]},${lut[i + 2]})`;
    };

    // One gradient for the whole canvas: bottom is the floor of the range, top
    // is the ceiling, and each bar is a window onto it.
    const grad = c.createLinearGradient(0, h, 0, 0);
    for (let i = 0; i <= 8; i++) grad.addColorStop(i / 8, colour(i / 8));
    c.fillStyle = grad;

    for (let b = 0; b < bars; b++) {
        const lo = start + Math.floor((b / bars) * count);
        const hi = Math.max(lo + 1, start + Math.floor(((b + 1) / bars) * count));
        let v = -Infinity;
        for (let i = lo; i < hi; i++) if (bins[i] > v) v = bins[i];
        let t = (v - floor) / range;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        if (contrast && contrast !== 1) t = Math.pow(t, 1 / contrast);
        // A floor of one pixel: a bar of no height reads as a gap in the
        // display rather than as silence, and silence is a thing to show.
        const bh = Math.max(1, Math.round(t * h));
        c.fillRect(b * step, h - bh, target, bh);
    }
}

export function drawAudioRuler(canvas, tuning, sampleRate, binCount) {
    if (!canvas) return;
    const { w, h, dpr } = sizedCanvas(canvas);
    const c = canvas.getContext('2d');
    c.fillStyle = cssVar('--scale-bg', '#0d121b');
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
        c.strokeStyle = cssVar('--scale-tick', 'rgba(255,255,255,0.16)');
        c.beginPath();
        c.moveTo(Math.round(x) + 0.5, 0);
        c.lineTo(Math.round(x) + 0.5, 3 * dpr);
        c.stroke();
        c.fillStyle = cssVar('--scale-text', '#8b96a9');
        c.fillText(fmtHz(f), x, h * 0.62);
    }
}

// Peak hold, kept on the frequency axis.
//
// The held trace is one value per screen pixel, so it only means anything
// against the view it was gathered in. Left alone through a pan it stays put
// while the signals slide out from under it; through a zoom it draws every
// held peak at a frequency it was never seen on. These move it with the view
// instead — the same transform the waterfall's history gets (panTransform), so
// the held line and the heat map below it cannot disagree about where a
// frequency went.

import { panTransform } from './waterfallRing.js';

/** What a pixel holds before anything has been seen there. */
export const PEAK_EMPTY = -200;

/**
 * `src` resampled into `width` pixels, where source pixel i lands at
 * destination x = offset + i * scale. Each destination pixel takes the highest
 * value from the source pixels it covers — a held carrier one pixel wide must
 * survive a zoom out rather than being averaged into the noise beside it. A
 * pixel the source does not reach gets PEAK_EMPTY, so the live trace fills it
 * on the next frame.
 */
export function resamplePeak(src, offset, scale, width, out) {
    const n = src.length;
    const dst = out && out.length === width && out !== src ? out : new Float32Array(width);
    for (let x = 0; x < width; x++) {
        const from = (x - offset) / scale;
        const to = (x + 1 - offset) / scale;
        if (to <= 0 || from >= n) { dst[x] = PEAK_EMPTY; continue; }
        let lo = Math.floor(from);
        if (lo < 0) lo = 0;
        const hi = Math.min(n, Math.max(lo + 1, Math.ceil(to)));
        let best = PEAK_EMPTY;
        for (let i = lo; i < hi; i++) if (src[i] > best) best = src[i];
        dst[x] = best;
    }
    return dst;
}

/**
 * Bring `hold` ({peak, centre, span}) onto `view` ({centre, span}), mutating it.
 *
 * A pan of under half a pixel leaves the buffer and the recorded centre alone so
 * the debt accumulates and a slow drag still moves it (see panTransform). Views
 * that do not overlap at all — a band change — clear it.
 */
export function alignPeakHold(hold, view) {
    if (!hold.peak || !view || !(view.span > 0)) return;
    if (!(hold.span > 0)) {
        hold.centre = view.centre;
        hold.span = view.span;
        return;
    }
    const width = hold.peak.length;
    const t = panTransform({ centre: hold.centre, span: hold.span }, view, width);
    if (!t) return;
    hold.centre = t.centre;
    hold.span = t.span;
    if (t.still) return;
    if (t.drop) { hold.peak.fill(PEAK_EMPTY); return; }
    hold.scratch = resamplePeak(hold.peak, t.offset, t.scale, width, hold.scratch);
    const prev = hold.peak;
    hold.peak = hold.scratch;
    hold.scratch = prev;
}

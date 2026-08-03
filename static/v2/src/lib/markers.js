// Layout maths for the marker bar. Pure functions, no canvas — the drawing in
// MarkerBar.jsx only turns these results into pixels.
//
// The logic mirrors v1's bookmark-manager.js, which matters because this server
// publishes 2450 bookmarks and 202 band allocations: at full span every one of
// them is "visible", so a naive draw is thousands of canvas calls per frame.

// First index whose frequency is >= target. The catalogue is sorted once, so
// slicing the visible window is O(log n) rather than a full scan per frame.
export function lowerBound(sorted, target) {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sorted[mid].frequency < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

export function visibleBookmarks(sorted, startFreq, endFreq) {
    if (!sorted || sorted.length === 0) return [];
    const i = lowerBound(sorted, startFreq);
    const out = [];
    for (let k = i; k < sorted.length && sorted[k].frequency <= endFreq; k++) out.push(sorted[k]);
    return out;
}

// Two rows, as in v1: a marker goes on row 0 unless it would collide, then row 1,
// and if both are taken it stays on row 0 (overlapping) rather than vanishing.
export const ROW_GAP_PX = 3;

export function assignRows(items) {
    const rows = [[], []];
    const clashes = (a, b) => {
        const aL = a.x - a.width / 2;
        const aR = a.x + a.width / 2;
        const bL = b.x - b.width / 2;
        const bR = b.x + b.width / 2;
        return !(aR + ROW_GAP_PX < bL || aL - ROW_GAP_PX > bR);
    };
    for (const item of items) {
        // Only the last placed marker in a row can overlap, since items arrive
        // sorted by x — so this stays O(n) instead of v1's O(n²) scan.
        const fits = (row) => {
            const last = rows[row][rows[row].length - 1];
            return !last || !clashes(item, last);
        };
        item.row = fits(0) ? 0 : fits(1) ? 1 : 0;
        rows[item.row].push(item);
    }
    return items;
}

// Density cap. Above `max`, sample evenly across the x-sorted list so the
// survivors stay spread over the whole width instead of bunching at one end.
export const MAX_MARKERS = 100;

export function capDensity(items, max = MAX_MARKERS) {
    if (items.length <= max) return items;
    const out = [];
    const step = items.length / max;
    for (let i = 0; i < max; i++) out.push(items[Math.round(i * step)]);
    return out;
}

// Full bookmark layout: window -> positions -> cap -> rows.
export function layoutBookmarks({ sorted, startFreq, endFreq, width, measure, max = MAX_MARKERS }) {
    const span = endFreq - startFreq;
    if (!(span > 0) || !(width > 0)) return [];

    const placed = visibleBookmarks(sorted, startFreq, endFreq).map((b) => ({
        item: b,
        x: ((b.frequency - startFreq) / span) * width,
        width: measure(b),
    }));
    placed.sort((a, b) => a.x - b.x);
    // Cap before stacking: rows assigned to markers that get dropped would be
    // wasted work, and dropping after stacking leaves gaps in row 1.
    return assignRows(capDensity(placed, max));
}

// Band colours, matching v1's generateBandColors so the two frontends agree.
// `intensity` is the operator's band_color_intensity (0.5–1.0).
export function bandColors(intensity) {
    const i = (typeof intensity === 'number' && isFinite(intensity))
        ? Math.max(0.5, Math.min(1, intensity))
        : 0.5;
    const alpha = +(0.20 + (i - 0.5) * 1.20).toFixed(3);
    const f = Math.round(100 - (i - 0.5) * 200);
    const c = (v) => Math.min(255, Math.max(0, v));
    return [
        `rgba(255, ${c(f)}, ${c(f)}, ${alpha})`,
        `rgba(255, ${c(f + 50)}, ${c(f)}, ${alpha})`,
        `rgba(255, ${c(f + 100)}, ${c(f)}, ${alpha})`,
        `rgba(255, 255, ${c(f)}, ${alpha})`,
        `rgba(${c(f + 100)}, 255, ${c(f)}, ${alpha})`,
        `rgba(${c(f)}, 255, ${c(f)}, ${alpha})`,
        `rgba(${c(f)}, 255, ${c(f + 100)}, ${alpha})`,
        `rgba(${c(f)}, ${c(f + 100)}, 255, ${alpha})`,
        `rgba(${c(f)}, ${c(f)}, 255, ${alpha})`,
        `rgba(${c(f + 50)}, ${c(f)}, 255, ${alpha})`,
    ];
}

// Visible bands as pixel spans, widest first so narrow allocations land on top.
export function layoutBands({ bands, startFreq, endFreq, width }) {
    const span = endFreq - startFreq;
    if (!bands || !(span > 0) || !(width > 0)) return [];
    const out = [];
    for (let i = 0; i < bands.length; i++) {
        const b = bands[i];
        if (b.end < startFreq || b.start > endFreq) continue;
        const x0 = Math.max(0, ((b.start - startFreq) / span) * width);
        const x1 = Math.min(width, ((b.end - startFreq) / span) * width);
        if (x1 - x0 <= 0) continue;
        out.push({ band: b, index: i, x0, x1, width: x1 - x0 });
    }
    out.sort((a, b) => (b.band.end - b.band.start) - (a.band.end - a.band.start));
    return out;
}

// Where to repeat a band's label across its width. v1's "intelligent spacing":
// never closer than the label itself plus a gap, so labels cannot overlap
// however long the name is. Bands narrower than `minWidth` get none.
export function bandLabelPositions({ x0, x1, labelWidth, baseSpacing = 220, minGap = 20, minWidth = 30 }) {
    const w = x1 - x0;
    if (w < minWidth || labelWidth > w) return [];

    const spacing = Math.max(baseSpacing, labelWidth + minGap);
    // Labels are spread across the range their *centres* can occupy, not the
    // full band. v1 spaced them over the whole band and then clamped strays
    // back inside, which squeezed the end pair closer than `spacing` and let
    // long names overlap after all.
    const inner = w - labelWidth;
    if (inner <= 0) return [x0 + w / 2];

    const n = Math.max(1, Math.floor(inner / spacing) + 1);
    if (n === 1) return [x0 + w / 2];

    const step = inner / (n - 1);
    const first = x0 + labelWidth / 2;
    const xs = [];
    for (let i = 0; i < n; i++) xs.push(first + i * step);
    return xs;
}

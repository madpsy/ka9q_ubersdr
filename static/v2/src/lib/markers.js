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

// Two rows. A marker takes row 0 unless it would collide, then row 1, and if it
// fits neither it is dropped.
//
// v1 keeps it and draws it on row 0 anyway, which is what makes its bar
// illegible when zoomed out: the density cap bounds how many are drawn but
// nothing bounds how many are drawn *on top of each other*. Dropping is what
// "don't overload" actually requires, and it is stable — placement is greedy
// left-to-right over an x-sorted list, so panning slides markers rather than
// reshuffling which ones survive.
export const ROW_GAP_PX = 3;

// `occupied` is space already taken by an earlier layer — the voice activity
// markers are placed after the bookmarks and must not land on top of them.
// Entries need only `{ x, width, row }`; they are seeded into the rows but
// never returned, since their own layer has already drawn them. v1 does the
// same thing by pre-seeding from the bookmark/DX/CW position arrays.
export function assignRows(items, occupied = []) {
    // Two rows, each holding its placed markers in x order.
    const rows = [[], []];
    const out = [];

    // Where `x` belongs in an x-ordered row.
    const seek = (row, x) => {
        let lo = 0;
        let hi = row.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (row[mid].x < x) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };

    // Placed markers never overlap, so only the neighbours either side of the
    // insertion point can collide — O(log n) per candidate, and unlike a
    // "compare with the last one placed" check it holds when markers are not
    // added strictly left to right.
    const fits = (row, item) => {
        const i = seek(row, item.x);
        const left = row[i - 1];
        const right = row[i];
        if (left && item.x - item.width / 2 - ROW_GAP_PX <= left.x + left.width / 2) return false;
        if (right && item.x + item.width / 2 + ROW_GAP_PX >= right.x - right.width / 2) return false;
        return true;
    };

    const place = (item) => {
        const row = fits(rows[0], item) ? 0 : fits(rows[1], item) ? 1 : -1;
        if (row < 0) return;
        item.row = row;
        rows[row].splice(seek(rows[row], item.x), 0, item);
        out.push(item);
    };

    for (const o of occupied) {
        const r = o.row === 1 ? 1 : 0;
        rows[r].splice(seek(rows[r], o.x), 0, { x: o.x, width: o.width });
    }

    // Local bookmarks claim their space first. They are yours and there are a
    // handful; a published bookmark 3 px away should be the one that gives way.
    for (const item of items) if (item.item && item.item.source === 'local') place(item);
    for (const item of items) if (!(item.item && item.item.source === 'local')) place(item);

    // Restore x order — callers draw in list order and the tests read it.
    return out.sort((a, b) => a.x - b.x);
}

// Density cap. Above `max`, sample evenly across the x-sorted list so the
// survivors stay spread over the whole width instead of bunching at one end.
export const MAX_MARKERS = 100;

// Local bookmarks are always kept and the server's are sampled around them, as
// v1 does: yours are a handful you chose deliberately, and losing one to a
// density cap driven by a couple of thousand published ones would look like the
// save had failed.
export function capDensity(items, max = MAX_MARKERS) {
    if (items.length <= max) return items;

    const local = items.filter((it) => it.item && it.item.source === 'local');
    const server = local.length ? items.filter((it) => !(it.item && it.item.source === 'local')) : items;
    const slots = Math.max(0, max - local.length);

    let sampled;
    if (server.length <= slots) {
        sampled = server;
    } else {
        sampled = [];
        const step = server.length / slots;
        for (let i = 0; i < slots; i++) sampled.push(server[Math.round(i * step)]);
    }
    // Back into x order, so the row assignment downstream stays a left-to-right
    // sweep.
    return local.length ? local.concat(sampled).sort((a, b) => a.x - b.x) : sampled;
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
    // Two stages: the even sample bounds the work and keeps the survivors
    // spread across the whole width; the row assignment then drops whatever
    // still will not fit, so the bar never overlaps itself.
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

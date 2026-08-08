// The waterfall as terrain: a perspective stack of recent FFT rows.
//
// The same history the waterfall draws, drawn as a receding surface instead of a
// heat map. The newest row spans the full width across the front; older rows
// recede up and inward into a narrower trapezoid, each filled down to the floor
// so nearer rows occlude farther ones. That occlusion is the whole trick — it is
// what makes it read as depth — and it is also why this does not replace the
// waterfall: a strong recent signal buries whatever was behind it, and the heat
// map hides nothing. They answer different questions about the same data, which
// is why the display setting offers both together as well as either alone.
//
// The geometry is AetherSDR's 3DSS (src/gui/DssRenderer.h), constants and all,
// because they are a set that has been looked at for a long time and a receding
// trapezoid tuned by eye is a week nobody needs to spend twice.
//
// ── What is deliberately not a port ─────────────────────────────────────────
//
// That renderer fills each row as one flat quad *per column* — 768 of them per
// row, 96 rows, ~74k polygons a rebuild. It can afford that: it is C++ painting
// into a QImage, with a GPU mesh path beside it for when it cannot. On a canvas
// 2D context that is thousands of times too slow to do while somebody drags the
// spectrum.
//
// So each row here is three calls, not 768: one path filled with a horizontal
// gradient, and the same path stroked with it for the ridge. The gradient
// carries the per-column amplitude colour that the per-column quads existed to
// carry, and a stop every few columns is indistinguishable at the width a ridge
// is actually drawn. 96 rows becomes ~300 canvas operations, which is a rebuild
// we can afford on every viewport change rather than only when a row arrives.

// ── Geometry ────────────────────────────────────────────────────────────────

/** Rows of visible depth, front to back. */
export const ROWS = 96;

/** Resampled columns per stored row. */
export const COLS = 256;

/** Back row width as a fraction of the front row's. */
export const BACK_WIDTH = 0.60;
/** How far up the pane the back row recedes, as a fraction of its height. */
export const DEPTH_SPAN = 0.58;
/** Tallest front ridge, as a fraction of pane height. */
export const FRONT_RIDGE = 0.46;
/** How far each row fades toward the background with depth. */
export const HAZE = 0.16;
/** Dimming at the back, before haze — the far rows are lit less. */
export const MIN_DIM = 0.45;
/** One gradient stop per this many columns. */
export const STOP_EVERY = 6;

/**
 * Perspective narrowing with depth. `depth` is 0 at the front (newest) and 1 at
 * the back. This is the only thing that places a frequency, so every overlay
 * that wants to stay attached to the surface goes through it.
 */
export function depthScale(depth) {
    const d = depth < 0 ? 0 : depth > 1 ? 1 : depth;
    return 1 - d * (1 - BACK_WIDTH);
}

/**
 * Frequency (0..1 across the pane) and depth (0..1) onto the pane, in unit
 * coordinates where y is 0 at the top and 1 at the floor.
 */
export function project(freqUnit, depth) {
    const d = depth < 0 ? 0 : depth > 1 ? 1 : depth;
    const w = depthScale(d);
    return { x: 0.5 + (freqUnit - 0.5) * w, y: 1 - d * DEPTH_SPAN };
}

/**
 * The inverse: a point on the pane back to the frequency under it.
 *
 * This is what makes the surface click-to-tune, and it is why the surface can
 * live in the waterfall pane at all — clicking a peak that is *behind* in the
 * terrain has to tune to the frequency it was on, exactly as clicking a signal
 * partway down the heat map does.
 *
 * The click is resolved against the baseline plane rather than the ridge tops:
 * a ridge is drawn *above* its own baseline, so resolving against the surface
 * would read a tall signal as a row further forward than it is, and the
 * frequency would come out narrower than it should be. Depth is taken from y
 * alone, which is exact on the plane and never more than one row out on a peak.
 *
 * @returns {{freqUnit: number, depth: number}} freqUnit may fall outside 0..1
 *          when the click is beside the trapezoid; callers clamp or ignore.
 */
export function unproject(x, y) {
    const yc = y < 0 ? 0 : y > 1 ? 1 : y;
    const depth = (1 - yc) / DEPTH_SPAN;
    const d = depth < 0 ? 0 : depth > 1 ? 1 : depth;
    return { freqUnit: 0.5 + (x - 0.5) / depthScale(d), depth: d };
}

/**
 * How tall a ridge stands above its own baseline, 0..1 of the pane height.
 *
 * `curve` below 1 lifts the floor region so weak signals are visible as relief
 * rather than as a flat plain — the same job the waterfall's contrast gamma
 * does for colour, and deliberately the same control.
 *
 * Scaled by the row's own width, so a ridge shrinks with depth along with
 * everything else and the surface keeps one vanishing point.
 */
export function ridgeHeight(dbm, floor, range, depth, curve = 1) {
    if (!Number.isFinite(dbm)) return 0;
    let s = (dbm - floor) / (range > 0 ? range : 1);
    s = s < 0 ? 0 : s > 1 ? 1 : s;
    if (curve !== 1) s = Math.pow(s, curve > 0.05 ? curve : 0.05);
    return s * FRONT_RIDGE * depthScale(depth);
}

// ── The magnitude ring ──────────────────────────────────────────────────────
//
// The waterfall's own ring holds colour-mapped *pixels*, which cannot be turned
// back into decibels: the palette clamps at both ends, so every value above the
// ceiling is the same colour. A surface needs the numbers, so it keeps its own.
//
// ── Depth in seconds, not in rows ───────────────────────────────────────────
//
// ROWS is how many ridges are *drawn*, and it is fixed: it is a drawing budget,
// and past about a hundred the far ones are a few pixels apart and add nothing
// but cost. How far back the surface reaches is a separate question, and it is
// the one an operator actually has — "show me the last half minute" — so that is
// what the setting says.
//
// The two are joined by aggregation. The ring stores rows at the waterfall's own
// rate, so `seconds x rate` of them; each drawn ridge is the peak over its share.
// Peak and not mean, for the reason pushRow gives: a carrier is one bin wide and
// one row long, and averaging thirty rows into one ridge would bury a burst that
// is the whole reason somebody switched this on.

/** Ridges drawn is a budget; rows stored is bounded so a slow speed cannot run away. */
export const MAX_STORE = 1200;

/** Seconds of history the setting may ask for. */
export const MIN_SECONDS = 5;
export const MAX_SECONDS = 120;

/**
 * How many rows to store for `seconds` of history at `rate` rows per second.
 * Never fewer than one per drawn ridge — below that the surface would repeat
 * rows rather than show more of them.
 */
export function storeRows(seconds, rate, rows = ROWS) {
    const want = Math.round((Number(seconds) || 0) * (Number(rate) || 0));
    if (!Number.isFinite(want)) return rows;
    return Math.max(rows, Math.min(MAX_STORE, want));
}

/** The seconds a ring of this size actually holds at `rate`. */
export function ringSeconds(ring, rate) {
    const r = Number(rate) || 0;
    return r > 0 ? ring.rows / r : 0;
}

/** A ring with no history in it. */
export function createRing(rows = ROWS, cols = COLS) {
    return {
        rows: Math.max(1, Math.round(rows)),
        cols,
        head: 0,
        // How many rows have actually been written. Until the ring fills, the
        // surface draws only what it has rather than a wall of floor values.
        count: 0,
        data: new Float32Array(Math.max(1, Math.round(rows)) * cols),
    };
}

/**
 * Add a row, resampling `px` (one value per screen column) to the ring's width.
 *
 * Peak-picked rather than averaged. A carrier is one bin wide and averaging four
 * columns into one buries it by 6 dB; on a display whose whole purpose is
 * finding narrow signals, the tallest thing in the interval is the honest
 * answer. Same rule the spectrum's own column collapse uses.
 */
export function pushRow(ring, px) {
    const { cols, data } = ring;
    const n = px.length;
    ring.head = (ring.head - 1 + ring.rows) % ring.rows;
    if (ring.count < ring.rows) ring.count++;
    const base = ring.head * cols;
    if (n <= 0) {
        data.fill(-Infinity, base, base + cols);
        return ring;
    }
    for (let c = 0; c < cols; c++) {
        const from = Math.floor((c * n) / cols);
        const to = Math.max(from + 1, Math.floor(((c + 1) * n) / cols));
        let best = px[from];
        for (let i = from + 1; i < to && i < n; i++) {
            if (px[i] > best) best = px[i];
        }
        data[base + c] = best;
    }
    return ring;
}

/** One stored row, `age` back from the newest, as a view. age 0 is the newest. */
export function storedRow(ring, age) {
    const i = (ring.head + age) % ring.rows;
    return ring.data.subarray(i * ring.cols, (i + 1) * ring.cols);
}

/** How many ridges are worth drawing: what has been stored, over the stride. */
export function ridgeCount(ring, rows = ROWS) {
    const stride = ring.rows / rows;
    return Math.min(rows, Math.max(0, Math.floor(ring.count / stride)));
}

/**
 * The peak of every stored row belonging to ridge `age`, into `out`.
 *
 * With one stored row per ridge this is a copy; with thirty it is what stops a
 * half-minute surface being thirty times blinder than a five-second one.
 */
export function ridgeInto(out, ring, age, rows = ROWS) {
    const { cols, data, count } = ring;
    const stride = ring.rows / rows;
    const from = Math.floor(age * stride);
    const to = Math.max(from + 1, Math.floor((age + 1) * stride));
    out.fill(-Infinity);
    for (let r = from; r < to && r < count; r++) {
        const base = ((ring.head + r) % ring.rows) * cols;
        for (let c = 0; c < cols; c++) {
            const v = data[base + c];
            if (v > out[c]) out[c] = v;
        }
    }
    return out;
}

// ── Drawing ─────────────────────────────────────────────────────────────────

/** Mixes two [r,g,b] toward `t`, 0..1. */
function mix(a, b, t) {
    return [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ];
}

const rgb = (c, k = 1) =>
    `rgb(${Math.round(c[0] * k)},${Math.round(c[1] * k)},${Math.round(c[2] * k)})`;

/**
 * Paint the surface.
 *
 * Back to front — the painter's algorithm — so nearer rows, which are wider and
 * sit lower and fill to the floor, cover the ones behind them.
 *
 * @param ctx        a 2D context, already sized to w x h device pixels
 * @param ring       from createRing/pushRow
 * @param o.floor    dBm at the baseline
 * @param o.range    dB from the floor to a full-height ridge
 * @param o.contrast the waterfall's own colour gamma, applied identically here
 *                   so a signal is the same colour in both halves of the pane
 * @param o.curve    relief gamma for *height*: below 1 lifts the floor region so
 *                   weak signals stand up as terrain. Separate from `contrast`
 *                   because colour and shape are read for different things
 * @param o.lut      the waterfall's palette, a 768-byte rgb table
 * @param o.bg       background [r,g,b], what the haze fades toward
 */
export function drawSurface(ctx, ring, w, h, o) {
    const { floor, range, contrast = 1, curve = 1, lut, bg = [5, 7, 12] } = o;
    ctx.fillStyle = rgb(bg);
    ctx.fillRect(0, 0, w, h);

    const n = ridgeCount(ring);
    if (n <= 0 || !lut || !(range > 0)) return;

    const cols = ring.cols;
    const gammaInv = contrast !== 1 ? 1 / contrast : 1;
    // Reused across every ridge: one allocation a rebuild, not ninety-six.
    if (!ctx._dssRidge || ctx._dssRidge.length !== cols) {
        ctx._dssRidge = new Float32Array(cols);
    }
    const ridge = ctx._dssRidge;

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    for (let age = n - 1; age >= 0; age--) {
        const depth = age / ROWS;
        const width = depthScale(depth);
        const inset = (w * (1 - width)) / 2;
        const rowW = w - 2 * inset;
        const baseY = h - depth * DEPTH_SPAN * h;
        const maxRidge = FRONT_RIDGE * h * width;
        const dim = MIN_DIM + (1 - MIN_DIM) * (1 - depth);
        const row = ridgeInto(ridge, ring, age);

        // Two gradients carry the whole row's amplitude colour, which is what
        // the per-column quads of the original exist to do: one dimmed for the
        // body, one at full brightness for the crest on top of it.
        const body = ctx.createLinearGradient(inset, 0, inset + rowW, 0);
        const crest = ctx.createLinearGradient(inset, 0, inset + rowW, 0);
        for (let c = 0; c < cols; c += STOP_EVERY) {
            let t = (row[c] - floor) / range;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            if (contrast !== 1) t = Math.pow(t, gammaInv);
            const i = ((t * 255) | 0) * 3;
            const hazed = mix([lut[i], lut[i + 1], lut[i + 2]], bg, depth * HAZE);
            const stop = Math.min(1, c / (cols - 1));
            body.addColorStop(stop, rgb(hazed, dim));
            crest.addColorStop(stop, rgb(hazed, Math.min(1.35, dim * 1.5)));
        }

        // The crest first, as an open polyline — stroked before the path is
        // taken down to the floor, or the two vertical drops and the floor
        // itself would be stroked as well and box every row in.
        ctx.beginPath();
        for (let c = 0; c < cols; c++) {
            const x = inset + (c / (cols - 1)) * rowW;
            let s = (row[c] - floor) / range;
            s = s < 0 ? 0 : s > 1 ? 1 : s;
            if (curve !== 1) s = Math.pow(s, curve > 0.05 ? curve : 0.05);
            const y = baseY - s * maxRidge;
            if (c === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        // Filled first so the crest sits on top of its own body rather than
        // being half-covered by it. The path is still the open ridge here, and
        // fill() closes it implicitly along the straight line back — which is
        // not what we want under it, so the floor corners go on first.
        ctx.lineTo(inset + rowW, h);
        ctx.lineTo(inset, h);
        ctx.closePath();
        ctx.fillStyle = body;
        ctx.fill();

        // Re-traced rather than stroked from the filled path, for the reason
        // above: the fill needs the floor in the path and the stroke must not
        // have it. Two passes over the same points, no branching inside either.
        ctx.beginPath();
        for (let c = 0; c < cols; c++) {
            const x = inset + (c / (cols - 1)) * rowW;
            let s = (row[c] - floor) / range;
            s = s < 0 ? 0 : s > 1 ? 1 : s;
            if (curve !== 1) s = Math.pow(s, curve > 0.05 ? curve : 0.05);
            const y = baseY - s * maxRidge;
            if (c === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = crest;
        // Thicker on the newest row, so "now" is findable in a stack of ninety-six.
        ctx.lineWidth = age === 0 ? 1.8 : 1;
        ctx.stroke();
    }
}

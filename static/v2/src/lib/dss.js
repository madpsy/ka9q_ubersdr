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

/** Ridges drawn, front to back.
 *
 * Halved from the 96 the original uses, and it costs nothing that shows. How far
 * back the surface reaches is set in seconds and delivered by aggregation, so
 * this is only how finely that span is sliced — while being the term that every
 * per-frame cost is multiplied by. At 48 the far ridges are still closer
 * together than the eye separates them at any pane height we have. */
export const ROWS = 48;

/** Widest a stored row gets, whatever the pane.
 *
 * The ring is sized to the pane's own device-pixel width so a carrier one pixel
 * wide in the waterfall is one column here too — see ringCols. At 256, which is
 * where this started, four or five waterfall pixels collapsed into one column
 * and every thin line came out as a wide mountain. The cap is where a pane stops
 * being a panel and starts being a wall. */
export const MAX_COLS = 1024;

/** Columns for a pane `pxW` device pixels wide. */
export function ringCols(pxW) {
    const w = Math.round(Number(pxW) || 0);
    return Math.max(64, Math.min(MAX_COLS, w));
}

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
export const STOP_EVERY = 8;

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
    const capped = Math.max(rows, Math.min(MAX_STORE, want));
    // Rounded to a whole number of stored rows per ridge. With a fractional
    // stride the ridge boundaries fall between stored rows and the phase that
    // drives the slide never quite closes, so the surface creeps out of step
    // with its own data — see ridgePhase.
    return Math.max(1, Math.round(capped / rows)) * rows;
}

/** The seconds a ring of this size actually holds at `rate`. */
export function ringSeconds(ring, rate) {
    const r = Number(rate) || 0;
    return r > 0 ? ring.rows / r : 0;
}

/** A ring with no history in it. */
export function createRing(rows = ROWS, cols = 256) {
    return {
        rows: Math.max(1, Math.round(rows)),
        cols,
        head: 0,
        // How many rows have actually been written. Until the ring fills, the
        // surface draws only what it has rather than a wall of floor values.
        count: 0,
        // Rows written ever, which is what ridgePhase counts in. Not `count`:
        // that stops at the ring size, and the phase has to keep going.
        pushed: 0,
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
    ring.pushed++;
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

/**
 * How far the surface has slid toward the back, 0..1 of one ridge.
 *
 * The correction for the bug that made this shudder. Geometry and content move at
 * different rates as soon as a ridge aggregates more than one stored row:
 * pushing a row shifts every aggregation window by one *stored row*, but the
 * depth was being advanced by a whole *ridge* over the same interval. At the
 * fifteen-second default that is six rows of content against one ridge of
 * geometry — so the terrain slid backwards faster than its own features and
 * snapped forward each time a row landed, which reads as going back and forth
 * rather than as sliding.
 *
 * So the slide is measured in ridges rather than rows: `stride` pushes move it
 * exactly one ridge, which is exactly when the windows have moved one ridge too.
 *
 * @param rowProgress 0..1 through the gap until the next row is committed
 */
export function ridgePhase(ring, rowProgress, rows = ROWS) {
    const stride = ring.rows / rows;
    const p = rowProgress < 0 ? 0 : rowProgress > 1 ? 1 : rowProgress;
    if (!(stride > 1)) return p;
    const phase = ((ring.pushed % stride) + p) / stride;
    return phase - Math.floor(phase);
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
    // Offset by where we are in the ridge, which is what keeps the *content*
    // still while the geometry glides over it.
    //
    // Without it the windows sat at fixed row-ages while the ridges slid, so a
    // given row changed ridge `stride` pushes after it arrived — at a moment set
    // by its own arrival, not by the glide. One row in six lined up; the other
    // five handed off mid-slide and jumped. That is the pulsing: the terrain
    // gliding backwards and its features stepping back inside it out of time.
    //
    // With the offset, ridge n covers one fixed block of rows for a whole cycle
    // and takes the next block exactly as the phase wraps — which is exactly
    // when that block's old ridge has reached where the next one starts.
    const skew = ring.pushed % stride;
    const from = Math.floor(age * stride) + skew;
    const to = Math.max(from + 1, Math.floor((age + 1) * stride) + skew);
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
 * @param o.progress 0..1 through the gap between rows. This is what makes the
 *                   surface move rather than step: every ridge is drawn at
 *                   (age + progress) / ROWS, so at progress 1 each one is
 *                   exactly where its successor starts and the motion is
 *                   continuous across the commit. Without it the surface jumps
 *                   once per row — twenty times a second at the default speed —
 *                   beside a heat map that slides at the refresh rate, and the
 *                   difference is the whole complaint.
 */
export function drawSurface(ctx, ring, w, h, o) {
    const {
        floor, range, contrast = 1, curve = 1, lut, bg = [5, 7, 12], progress = 0,
    } = o;
    ctx.fillStyle = rgb(bg);
    ctx.fillRect(0, 0, w, h);

    const n = ridgeCount(ring);
    if (n <= 0 || !lut || !(range > 0)) return;

    const cols = ring.cols;
    const gammaInv = contrast !== 1 ? 1 / contrast : 1;
    const p = progress < 0 ? 0 : progress > 1 ? 1 : progress;
    // Reused across every ridge: one allocation a frame, not forty-eight.
    if (!ctx._dssRidge || ctx._dssRidge.length !== cols) {
        ctx._dssRidge = new Float32Array(cols);
    }
    const ridge = ctx._dssRidge;

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    for (let age = n - 1; age >= 0; age--) {
        // The sub-row offset is what turns a step into a slide — see o.progress.
        const depth = (age + p) / ROWS;
        const width = depthScale(depth);
        const inset = (w * (1 - width)) / 2;
        const rowW = w - 2 * inset;
        const baseY = h - depth * DEPTH_SPAN * h;
        const maxRidge = FRONT_RIDGE * h * width;
        const dim = MIN_DIM + (1 - MIN_DIM) * (1 - depth);
        const row = ridgeInto(ridge, ring, age);

        // One point per device pixel of *this row's* on-screen width, and no
        // more. A front ridge spans the whole pane and gets every column it has;
        // a back one is 60% as wide, so two of its columns would land in a pixel
        // and the second is invisible work. Derived rather than fixed, because a
        // fixed decimation is how a carrier one column wide became a mountain
        // several pixels across.
        const step = Math.max(1, Math.round(cols / Math.max(1, rowW)));

        // Two gradients carry the whole row's amplitude colour, which is what
        // the per-column quads of the original exist to do: one dimmed for the
        // body, one brighter for the crest on top of it.
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

        // Traced once. The body is the same line taken down to the floor, and
        // Path2D copies it natively — so the fill costs no second pass through
        // the columns, which at sixty frames a second is the difference between
        // affordable and not.
        const line = new Path2D();
        for (let c = 0; c < cols; c += step) {
            const x = inset + (c / (cols - 1)) * rowW;
            let sv = (row[c] - floor) / range;
            sv = sv < 0 ? 0 : sv > 1 ? 1 : sv;
            if (curve !== 1) sv = Math.pow(sv, curve > 0.05 ? curve : 0.05);
            const y = baseY - sv * maxRidge;
            if (c === 0) line.moveTo(x, y);
            else line.lineTo(x, y);
        }

        const solid = new Path2D(line);
        solid.lineTo(inset + rowW, h);
        solid.lineTo(inset, h);
        solid.closePath();
        ctx.fillStyle = body;
        ctx.fill(solid);

        // The crest on top of its own body, and thicker on the newest ridge so
        // "now" is findable in the stack.
        ctx.strokeStyle = crest;
        ctx.lineWidth = age === 0 ? 1.8 : 1;
        ctx.stroke(line);
    }
}

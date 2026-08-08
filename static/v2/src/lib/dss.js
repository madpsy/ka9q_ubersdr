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
/** dB above the floor that fills the ridge height.
 *
 * Not the display's own range, and this is the difference between a surface that
 * shows what the waterfall shows and one that shows only the loudest thing on
 * the band. The auto-levelling range runs from the noise floor to the strongest
 * signal on screen, which on a busy band is seventy decibels or more — so a
 * carrier ten above the noise gets a seventh of the available height and reads
 * as flat, while the heat map beside it paints the same carrier bright cyan.
 *
 * Colour survives that and height does not, because in a stacked surface the
 * body of each row is occluded by the ones in front: the only part of a row that
 * is really visible is its ridge. So height is what has to carry a weak signal,
 * and it needs an aperture that does not collapse when something loud turns up.
 * Forty-five decibels is about the useful span of a receiver on a quiet band. */
export const HEIGHT_SPAN_DB = 45;

/** Gamma on the ridge height.
 *
 * Linear, and that is a correction. A gamma below one was here to lift weak
 * signals, and it does — but it lifts the *noise* by the same rule, and there is
 * far more noise than signal on any band. At 0.6 the noise plain stood at nearly
 * a third of full ridge height, which is not what the spectrum trace beside it
 * shows and not what the surface is for: the floor should be a floor.
 *
 * What weak signals needed was the bounded aperture above, not a curve. Linear
 * over 45 dB already gives a carrier fifteen decibels up a fifth of the height,
 * where linear over the display's own seventy-decibel range gave it a tenth. */
export const HEIGHT_CURVE = 1;

/** dB of the measured floor to treat as flat ground.
 *
 * `floor` from the auto-levelling is the 25th percentile less 4 dB — deliberately
 * *below* the noise, so the waterfall has somewhere dark to put it. Drawn as
 * terrain that headroom becomes a raised plain with the noise standing on top of
 * it, so the baseline is lifted back to where the noise actually is and the
 * plain is flat again. Anything under it is ground, which is what it is. */
export const HEIGHT_FLOOR_MARGIN_DB = 6;

/** The dB span the ridge heights are drawn against, for a display range of `range`. */
export const heightRange = (range) => Math.min(Number(range) || 0, HEIGHT_SPAN_DB);

/** Where the ground is, in dBm, for an auto-levelling floor of `floor`. */
export const heightFloor = (floor) => (Number(floor) || 0) + HEIGHT_FLOOR_MARGIN_DB;

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
 * How far a mark runs past the back of the baseline plane, as a multiple of the
 * front-to-back span.
 *
 * Derived, not picked. Ridges stand *above* the plane the marks are drawn on —
 * by up to a full ridge at back width — so a mark that stopped at the plane
 * stopped short of the terrain every time there was a signal at the back. This
 * is exactly the extra travel that takes it to the top of the box the surface
 * can occupy: descending by FRONT_RIDGE x BACK_WIDTH costs that much depth at
 * DEPTH_SPAN per unit.
 */
export const MARK_OVERRUN = (FRONT_RIDGE * BACK_WIDTH) / DEPTH_SPAN;

/**
 * A constant frequency drawn across the surface, in unit coordinates.
 *
 * Straight, and that is not an approximation: x and y are both linear in depth,
 * so a fixed frequency is a straight line converging on the vanishing point.
 * Two endpoints is the whole geometry, and it comes from the same projection the
 * terrain is built from, so a mark and the ridges under it cannot splay apart.
 *
 * The back end is the plane's, carried on by MARK_OVERRUN — the same line,
 * simply longer. Following the terrain instead was tried and is much worse to
 * read: a frequency reference that climbs over every signal it crosses stops
 * looking like a reference.
 *
 * @returns {{x0: number, y0: number, x1: number, y1: number}} front then back
 */
export function edgeLine(freqUnit) {
    const t = 1 + MARK_OVERRUN;
    const front = project(freqUnit, 0);
    // project() clamps depth to 1, which is the point being passed here, so the
    // far end is worked out from the same two formulas rather than through it.
    const width = 1 - t * (1 - BACK_WIDTH);
    return {
        x0: front.x,
        y0: front.y,
        x1: 0.5 + (freqUnit - 0.5) * width,
        y1: 1 - t * DEPTH_SPAN,
    };
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
export function ridgeHeight(dbm, floor, range, depth, curve = HEIGHT_CURVE) {
    if (!Number.isFinite(dbm)) return 0;
    const r = heightRange(range) || range;
    let s = (dbm - heightFloor(floor)) / (r > 0 ? r : 1);
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
// ── One row per ridge, and why the alternative failed ───────────────────────
//
// Every ridge drawn is exactly one row of FFT. There is no aggregation, and that
// is a correction rather than a simplification.
//
// The obvious way to offer "thirty seconds of history" on a fixed number of
// ridges is to merge several rows into each. It does not work, and it fails
// worst exactly where it shows most. A ridge holding six rows can only be their
// peak, so the front of the surface stops being *now* and becomes the strongest
// thing in the last six rows; and because a block only completes every six
// pushes, the front ridge rolls over a few times a second while the rest of the
// display moves continuously. The newest thing on screen ends up the stalest,
// which is the opposite of what a waterfall is for.
//
// So the ridge count *is* the history: seconds are bought by drawing more
// ridges, or by slowing the waterfall down. Both are honest and both are already
// controls. See ridgesFor, which turns the operator's seconds into whichever of
// those the machine can actually afford.

/** Ridges the surface may be asked to draw. */
export const MIN_RIDGES = 16;
export const MAX_RIDGES = 96;

/** Seconds of history the setting may ask for. */
export const MIN_SECONDS = 1;
export const MAX_SECONDS = 30;

/**
 * Ridges for `seconds` of history at `rate` rows per second.
 *
 * Clamped, so a long depth at a fast waterfall asks for more ridges than are
 * affordable and gets as many as there are. What that costs is honest and
 * visible: the panel shows the span actually being drawn, not the one asked for,
 * and the way to buy more of it is the waterfall speed slider above.
 */
export function ridgesFor(seconds, rate) {
    const want = Math.round((Number(seconds) || 0) * (Number(rate) || 0));
    if (!Number.isFinite(want)) return MIN_RIDGES;
    return Math.max(MIN_RIDGES, Math.min(MAX_RIDGES, want));
}

/** The seconds a ring of this many ridges actually shows at `rate`. */
export function ringSeconds(ring, rate) {
    const r = Number(rate) || 0;
    return r > 0 ? ring.rows / r : 0;
}

/** Widest a stored row gets, whatever the pane.
 *
 * The ring is as wide as the pane's own device pixels, so a carrier one pixel
 * wide in the waterfall is one column here too. At the 256 this started with,
 * four or five waterfall pixels collapsed into one column by peak and every thin
 * line came out as a wide, soft mountain. The cap is where a pane stops being a
 * panel and starts being a wall. */
export const MAX_COLS = 1024;

/** Columns for a pane `pxW` device pixels wide, so a one-pixel line stays one column. */
export function ringCols(pxW) {
    const w = Math.round(Number(pxW) || 0);
    return Math.max(64, Math.min(MAX_COLS, w));
}

/** A ring with no history in it. */
export function createRing(rows = MAX_RIDGES, cols = 256) {
    const n = Math.max(1, Math.round(rows));
    return {
        rows: n,
        cols,
        head: 0,
        // How many rows have actually been written. Until the ring fills, the
        // surface draws only what it has rather than a wall of floor values.
        count: 0,
        data: new Float32Array(n * cols),
    };
}

/**
 * Add a row, resampling `px` (one value per screen column) to the ring's width.
 *
 * Peak-picked rather than averaged, for the case the ring is narrower than the
 * pane: a carrier is one bin wide and averaging columns into one buries it by
 * 6 dB. Same rule the spectrum's own column collapse uses. At the sizes ringCols
 * gives it is usually one-to-one and this does nothing.
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

/** One row, `age` back from the newest, as a view. age 0 is the newest. */
export function storedRow(ring, age) {
    const i = (ring.head + age) % ring.rows;
    return ring.data.subarray(i * ring.cols, (i + 1) * ring.cols);
}

/** How many ridges are worth drawing: what has been written, at most the ring. */
export function ridgeCount(ring) {
    return Math.min(ring.count, ring.rows);
}

// ── Drawing ─────────────────────────────────────────────────────────────────
//
// A software rasteriser over an ImageData, not canvas paths.
//
// Paths were the obvious way and they are the wrong one. Filling a row needs a
// colour *per column* — that is what a spectral display is — and the only way to
// get that out of one path is a gradient, which means a stop every few columns
// and linear interpolation between them. A carrier one column wide then lands
// between two stops and never appears at all, and every colour that does get in
// is smeared across the gap. Both were visible against the waterfall beside it:
// lines missing entirely, and the ones that survived the wrong colour.
//
// Per-pixel also makes the occlusion cheap, which paths did not. Drawing
// front-to-back and keeping the topmost painted row per column means every
// screen pixel is written at most once — where painting back-to-front with
// filled paths overdraws the whole pane once per ridge. So the honest renderer
// is also the fast one: cost is the size of the pane, not the pane times the
// number of ridges.

/** How much brighter a ridge's crest is than its own body. */
const CREST_GAIN = 1.18;

/**
 * Paint the surface.
 *
 * @param ctx        a 2D context, already sized to w x h device pixels
 * @param ring       from createRing/pushRow
 * @param o.floor    dBm at the baseline
 * @param o.range    dB from the floor to the top of the display's range, used
 *                   for colour — the waterfall's own mapping, so a signal is the
 *                   same colour in both halves of the pane
 * @param o.contrast the waterfall's colour gamma, applied identically here
 * @param o.curve    gamma on height only; see HEIGHT_CURVE
 * @param o.lut      the waterfall's palette, a 768-byte rgb table
 * @param o.bg       background [r,g,b], what the haze fades toward
 * @param o.progress 0..1 through the gap between rows. This is what makes the
 *                   surface move rather than step: every ridge is drawn at
 *                   (age + progress) / ring.rows, so at progress 1 each one is
 *                   exactly where its successor starts and the motion is
 *                   continuous across the commit.
 */
export function drawSurface(ctx, ring, w, h, o) {
    const {
        floor, range, contrast = 1, curve = HEIGHT_CURVE, lut, bg = [5, 7, 12],
        progress = 0,
    } = o;
    if (w <= 0 || h <= 0) return;

    // Reused across frames: an ImageData and a horizon buffer per frame would be
    // two allocations sixty times a second.
    let buf = ctx._dssBuf;
    if (!buf || buf.w !== w || buf.h !== h) {
        buf = { w, h, img: ctx.createImageData(w, h), top: new Int32Array(w) };
        ctx._dssBuf = buf;
    }
    const { img, top } = buf;
    const px = img.data;

    const bg0 = bg[0];
    const bg1 = bg[1];
    const bg2 = bg[2];
    // Background, and the horizon reset to the floor of the pane.
    for (let i = 0; i < px.length; i += 4) {
        px[i] = bg0;
        px[i + 1] = bg1;
        px[i + 2] = bg2;
        px[i + 3] = 255;
    }
    top.fill(h);

    const n = ridgeCount(ring);
    if (n <= 0 || !lut || !(range > 0)) {
        ctx.putImageData(img, 0, 0);
        return;
    }

    const cols = ring.cols;
    const gammaInv = contrast !== 1 ? 1 / contrast : 1;
    const hRange = heightRange(range) || range;
    const hFloor = heightFloor(floor);
    const p = progress < 0 ? 0 : progress > 1 ? 1 : progress;

    // Front to back. Each ridge is drawn only where it rises above everything
    // already painted, so a pixel is written once and an occluded ridge costs
    // its columns and nothing else.
    for (let age = 0; age < n; age++) {
        const depth = (age + p) / ring.rows;
        const width = depthScale(depth);
        const inset = (w * (1 - width)) / 2;
        const rowW = w - 2 * inset;
        if (rowW < 1) continue;
        const baseY = h - depth * DEPTH_SPAN * h;
        const maxRidge = FRONT_RIDGE * h * width;
        const dim = MIN_DIM + (1 - MIN_DIM) * (1 - depth);
        const hazeT = depth * HAZE;
        const row = storedRow(ring, age);

        const x0 = Math.max(0, Math.ceil(inset));
        const x1 = Math.min(w - 1, Math.floor(inset + rowW));

        for (let x = x0; x <= x1; x++) {
            // Screen column back to the column of the stored row under it. The
            // ring is as wide as the pane, so at the front this is one-to-one
            // and a one-pixel line stays one pixel.
            let c = Math.round(((x - inset) / rowW) * (cols - 1));
            if (c < 0) c = 0;
            else if (c >= cols) c = cols - 1;
            const v = row[c];

            let sv = (v - hFloor) / hRange;
            sv = sv < 0 ? 0 : sv > 1 ? 1 : sv;
            if (curve !== 1) sv = Math.pow(sv, curve > 0.05 ? curve : 0.05);
            let y = Math.round(baseY - sv * maxRidge);
            if (y < 0) y = 0;

            const ceilY = top[x];
            if (y >= ceilY) continue;      // wholly behind what is already drawn

            // Colour on the waterfall's own mapping, then hazed toward the
            // background and dimmed with depth — the only two things that are
            // allowed to differ from the heat map, and both go to zero at the
            // front row.
            let t = (v - floor) / range;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            if (contrast !== 1) t = Math.pow(t, gammaInv);
            const li = ((t * 255) | 0) * 3;
            const r0 = (lut[li] + (bg0 - lut[li]) * hazeT) * dim;
            const g0 = (lut[li + 1] + (bg1 - lut[li + 1]) * hazeT) * dim;
            const b0 = (lut[li + 2] + (bg2 - lut[li + 2]) * hazeT) * dim;

            // The crest: one pixel, a little brighter than its own body so the
            // ridge reads as an edge. Deliberately a small gain — at the 1.7x
            // this had at first, every mid-tone clipped toward white and the
            // surface disagreed with the waterfall about what colour a signal is.
            let o1 = (y * w + x) * 4;
            const cr = r0 * CREST_GAIN;
            const cg = g0 * CREST_GAIN;
            const cb = b0 * CREST_GAIN;
            px[o1] = cr > 255 ? 255 : cr;
            px[o1 + 1] = cg > 255 ? 255 : cg;
            px[o1 + 2] = cb > 255 ? 255 : cb;

            // The body, down to whatever was already painted under it.
            for (let yy = y + 1; yy < ceilY; yy++) {
                o1 = (yy * w + x) * 4;
                px[o1] = r0;
                px[o1 + 1] = g0;
                px[o1 + 2] = b0;
            }
            top[x] = y;
        }
    }

    ctx.putImageData(img, 0, 0);
}

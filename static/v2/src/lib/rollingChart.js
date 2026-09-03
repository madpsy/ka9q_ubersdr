// The arithmetic behind a trace that scrolls, as against one that steps.
//
// A chart of live readings has two clocks in it: the rate the readings arrive
// at, and the rate the screen is drawn at. Tie the picture to the first — a
// sample per column, redrawn when a sample lands — and the trace hops sideways
// by a whole column at whatever rate the meters happen to tick, which is a
// tenth of a second here and reads as a stutter however good the data is. The
// meters cannot be asked to tick faster: they are the receiver's, and the
// answer to "make it smoother" must not be "measure it more often".
//
// So the picture is tied to the second clock instead. Each reading is kept with
// the time it arrived, x is a function of *time* rather than of position in an
// array, and the frame loop redraws whenever the display is ready. Between two
// readings the same points are simply drawn a fraction of a column further
// left, which is what motion is. Nothing is invented: every point on screen is
// a reading that happened, at the place its timestamp puts it.
//
// Separate from the panel, because the panel's job is what to draw and these
// are the parts that can be wrong in ways a screenshot will not show: what is
// still in view, where a moment sits, and how a curve is bent. The arithmetic
// above is pure; the two helpers at the foot take a canvas, and they are here
// rather than in a panel because more than one panel draws one of these traces
// — see SignalPanel's SNR and StatsPanel's buffer.

/** How much time the chart shows. Ten seconds, as the SNR trace always has. */
export const SPAN_MS = 10000;

/**
 * How far behind live to draw.
 *
 * The right-hand edge is "now", and a point cannot be drawn before it exists —
 * so with no allowance the newest reading pops into being at the edge and the
 * segment leading to it appears all at once, which is the stutter this file is
 * about, moved to the end of the line. Holding the picture one sample-interval
 * behind means the newest reading is already there when its stretch of trace
 * comes into view, and the line arrives at the edge instead of appearing at it.
 *
 * A tenth of a second of latency on a chart of the last ten seconds is not a
 * cost anybody can perceive; a trace that twitches at the edge is.
 */
export function drawLag(gapMs) {
    if (!(gapMs > 0)) return 100;
    return Math.max(60, Math.min(250, gapMs));
}

/**
 * The typical gap between readings, in ms.
 *
 * Median rather than mean: a tab that was in the background, a reconnect, a
 * garbage collection — any of them leaves one enormous gap in the series, and
 * an average that has swallowed it would hold the picture a second behind live
 * for as long as that sample is in view.
 */
export function medianGap(points) {
    if (!points || points.length < 2) return 0;
    const gaps = [];
    for (let i = 1; i < points.length; i++) gaps.push(points[i].t - points[i - 1].t);
    gaps.sort((a, b) => a - b);
    const mid = gaps.length >> 1;
    return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
}

/**
 * Drop what has scrolled off the left, in place.
 *
 * One point older than the cutoff is kept, and that is the whole subtlety: the
 * segment crossing the left edge is drawn from a point that is itself off
 * screen, so throwing it away as soon as it expires would leave a gap at the
 * edge that grows and shrinks with every sample. Trimming from the front only,
 * because the series is in time order and nothing arrives late.
 */
export function trimBefore(points, cutoff) {
    let keep = 0;
    while (keep + 1 < points.length && points[keep + 1].t < cutoff) keep += 1;
    if (keep > 0) points.splice(0, keep);
    return points;
}

/** Where a moment sits, with `now` at the right-hand edge. */
export function xAt(t, now, span, w) {
    return w - ((now - t) / span) * w;
}

/**
 * Control points for a Catmull-Rom segment from `a` to `b`, as a cubic Bézier.
 *
 * `prev` and `next` are the points either side, which is what lets a curve
 * through fixed points have a continuous tangent — pass a or b for them at the
 * ends of the series.
 *
 * Clamped so the curve cannot leave the range of the two points it joins. A
 * plain Catmull-Rom overshoots at a corner, and on this chart an overshoot is a
 * lie with a specific shape: a buffer trace that dips below the low point of
 * two readings has drawn a dropout that did not happen, and an SNR trace that
 * rings above a peak has invented a signal. Bending the line is a drawing
 * choice; putting ink outside the data is not.
 */
export function curveControl(prev, a, b, next, tension = 6) {
    const c1x = a.x + (b.x - prev.x) / tension;
    const c2x = b.x - (next.x - a.x) / tension;
    const lo = Math.min(a.y, b.y);
    const hi = Math.max(a.y, b.y);
    const clamp = (v) => Math.max(lo, Math.min(hi, v));
    return {
        c1x,
        c1y: clamp(a.y + (b.y - prev.y) / tension),
        c2x,
        c2y: clamp(b.y - (next.y - a.y) / tension),
    };
}

/**
 * Draw a smooth line through `pts`, one stroke per segment.
 *
 * Per segment because the SNR trace is coloured by its own value — the colour
 * is a reading of the signal, not decoration — so the segments cannot be one
 * path. `colour(i)` is asked for the colour of the segment ending at i, and
 * returning the same string every time is the ordinary single-colour case.
 *
 * Fewer than two points is not a line and draws nothing.
 */
export function strokeCurve(ctx, pts, colour) {
    if (!pts || pts.length < 2) return;
    for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const prev = pts[i - 2] || a;
        const next = pts[i + 1] || b;
        const c = curveControl(prev, a, b, next);
        ctx.strokeStyle = colour(i);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.bezierCurveTo(c.c1x, c.c1y, c.c2x, c.c2y, b.x, b.y);
        ctx.stroke();
    }
}

/**
 * Continue the current path smoothly through `pts`, from the second onward.
 *
 * The stroking version above is one path per segment, because the SNR trace is
 * coloured by its own value. A filled band cannot be: it is one closed shape —
 * out along the top, back along the bottom — so the curve has to be traced into
 * a path the caller opened and will close. Same control points, so a band's
 * edge and a stroke over it are the same line.
 *
 * The caller has already moved to `pts[0]`; this adds the rest.
 */
export function curveThrough(ctx, pts) {
    for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const prev = pts[i - 2] || a;
        const next = pts[i + 1] || b;
        const c = curveControl(prev, a, b, next);
        ctx.bezierCurveTo(c.c1x, c.c1y, c.c2x, c.c2y, b.x, b.y);
    }
}

/**
 * Ready a canvas for this frame: size it to its box and hand back a context
 * with the box's pixel dimensions. Returns null when there is nothing to draw
 * on — a collapsed dock leaves the canvas at zero, and a chart drawn into
 * nothing is a frame's work thrown away.
 *
 * Prefixed, as its neighbour is: a bare `surface` or `place` exported into a
 * namespace this flat collides with a parameter of the same name three panels
 * away, and test/unresolved.js reads such a collision as a missing import.
 */
export function chartSurface(c) {
    if (!c) return null;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(c.clientWidth * dpr);
    const ht = Math.round(c.clientHeight * dpr);
    if (!w || !ht) return null;
    if (c.width !== w || c.height !== ht) { c.width = w; c.height = ht; }
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, w, ht);
    return { ctx, w, ht, dpr };
}

/**
 * Where each reading sits on this frame's canvas.
 *
 * `now` is held one sample-interval back — see drawLag — so the right-hand edge
 * is a moment for which the trace is already known, and the newest reading
 * slides in from beyond the edge rather than appearing at it. Points either
 * side of the visible span are kept and simply drawn off it: the segments
 * crossing both edges have to come from somewhere, and the canvas clips.
 */
export function chartPoints(points, now, w, y, value = (p) => p.v) {
    const at = now - drawLag(medianGap(points));
    const out = [];
    for (const p of points) {
        const v = value(p);
        if (v == null) continue;
        out.push({ x: xAt(p.t, at, SPAN_MS, w), y: y(v), p });
    }
    return out;
}

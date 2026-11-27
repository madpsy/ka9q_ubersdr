// Geometry for the analogue needle meters — v1's s-meter-needle.js, flattened.
//
// v1 draws a half circle: the pivot sits inside the box and the needle sweeps
// the full 180°, which needs a panel about as tall as it is wide. A dock column
// cannot spare that, so the sweep here is ±SWEEP either side of vertical and the
// pivot is pushed below the bottom edge. What shows is the crown of a much
// larger circle, which is what makes the meter a wide, shallow rectangle rather
// than a square — the same instrument, cropped to the space there is.
//
// Nothing here knows about S-units or dB. Both meters hand in a 0..1 position
// from lib/format.js — the same numbers their bars use — so a needle and a bar
// can never disagree about where a reading sits.

// Half the sweep. 35° each way keeps the crown shallow: the arc's own height is
// (halfWidth × tan(SWEEP/2)), so widening the sweep costs height quickly.
export const SWEEP = (35 * Math.PI) / 180;

// Clearances, CSS px. LABEL_INSET is how far inside the arc the tick labels
// sit, and it is part of the fit: near the ends of the arc, "inwards" is mostly
// *downwards*, so labels reach lower than the arc itself does.
export const PAD_X = 10;
export const PAD_TOP = 8;
export const PAD_BOTTOM = 6;
export const LABEL_INSET = 17;
export const TICK_OUT = 3;    // tick starts this far inside the arc
export const TICK_IN = 9;     // ...and ends this far in
export const NEEDLE_GAP = 5;  // tip stops this short of the arc

const MIN_RADIUS = 20;

/**
 * Pivot and radius for a meter `w` × `h` CSS px.
 *
 * The radius wants to be whatever spans the width, but it is capped by what the
 * height can hold: past that the labels at the ends of the scale would fall out
 * of the box. A meter wider than its height allows simply draws a narrower arc,
 * centred — which looks deliberate, where a clipped scale looks broken.
 */
export function geometry(w, h) {
    const cos = Math.cos(SWEEP);
    const byWidth = (w / 2 - PAD_X) / Math.sin(SWEEP);
    const byHeight = (h - PAD_TOP - PAD_BOTTOM - LABEL_INSET * cos) / (1 - cos);
    const radius = Math.max(MIN_RADIUS, Math.min(byWidth, byHeight));
    // The crown of the circle is directly above the pivot, so fixing it PAD_TOP
    // from the top edge fixes the pivot: usually well below the box.
    return { cx: w / 2, cy: PAD_TOP + radius, radius };
}

/**
 * Angle for a 0..1 position, in canvas terms (0 = east, growing anticlockwise).
 * 0 is the left-hand end of the scale, 1 the right.
 */
export function angleAt(fraction) {
    const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
    return Math.PI / 2 + SWEEP - f * 2 * SWEEP;
}

/** A point `r` from the pivot, at position `fraction` along the scale. */
export function pointAt(g, fraction, r) {
    const a = angleAt(fraction);
    return { x: g.cx + Math.cos(a) * r, y: g.cy - Math.sin(a) * r };
}

/**
 * The same angle for ctx.arc(), which measures clockwise because canvas y grows
 * downwards — the opposite of angleAt's convention. Passing angleAt() straight
 * to arc() draws the meter upside down, below the box, where it is invisible.
 * Sweep from arcAngle(0) to arcAngle(f) with the default direction.
 */
export function arcAngle(fraction) {
    return -angleAt(fraction);
}

/**
 * Peak hold, in fractions of the scale rather than dB: rise at once, hold,
 * then fall away. `dt` is seconds since the last step, so a meter sampled at
 * 8 Hz decays at the same rate as one sampled at 30.
 *
 * Long enough to read. v1's 0.6 s hold and a fall of a third of the scale a
 * second put the hold back on the live needle within a second of the last
 * syllable, so on SSB it was barely slower than the reading it was meant to
 * summarise. Three seconds spans the gaps between phrases, so the hold sits on
 * the loudest of them; the fall is about 1.7 S-units, or 4 dB of SNR, a second,
 * slow enough to watch it come down.
 */
export const PEAK_HOLD_SEC = 3;
export const PEAK_FALL_PER_SEC = 0.12;   // of full scale

// `fall` is per second in whatever units `value` is in. A scale position by
// default; a reading carried in its own units — the SNR hold is kept in dB, so
// that one above the top of the scale still prints what it was — passes the
// same fall converted to them.
export function stepPeak(peak, value, dt, fall = PEAK_FALL_PER_SEC) {
    if (!peak || value >= peak.value) return { value, held: PEAK_HOLD_SEC };
    const held = peak.held - dt;
    if (held > 0) return { value: peak.value, held };
    return { value: Math.max(value, peak.value - fall * dt), held: 0 };
}

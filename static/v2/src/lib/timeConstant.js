// Making a per-frame smoothing factor mean the same thing at any frame rate.
//
// The usual way to ease a value towards a target is `v += (target - v) * k`, or
// equivalently `v = v * a + target * (1 - a)` with `a = 1 - k` the retention.
// Written like that, the speed is per *frame* — so how quickly the display
// settles depends on how often it is redrawn.
//
// That is a problem here, because this receiver's frame rate is not a constant:
// the spectrum arrives about twice as often on a narrow span as on a wide one.
// With a fixed per-frame retention, zooming out silently changes what the
// smoothing slider means — the same setting lags several times longer in
// seconds — and the auto-levels take correspondingly longer to settle. Both
// read as the display having gone sluggish, when nothing about it was meant to
// change but the span.
//
// Raising the retention to the power of elapsed-time-over-reference fixes it:
// applying it twice over half the interval each is then exactly applying it
// once over the whole, which is the property a per-frame factor lacks.

// The frame interval the stored factors are quoted at, in seconds. 20 Hz — the
// default waterfall rate, and about what a narrow span delivers — so the
// settings people already have keep the behaviour they already had, and only
// the slower spans change.
export const REF_DT = 0.05;

// Longest gap that is treated as real. A backgrounded tab or a stalled feed can
// leave minutes between frames, and a retention taken to that power underflows
// to zero anyway — this just makes the intent explicit: after a second away,
// snap most of the way to the truth rather than pretending to ease.
export const MAX_DT = 1;

/**
 * The retention to use for a frame that took `dt` seconds.
 *
 * `perFrame` is the factor as quoted at REF_DT: 0 keeps nothing (no smoothing),
 * 1 keeps everything (frozen). A `dt` of zero returns 1 — no time has passed,
 * so nothing should move.
 */
export function retentionFor(perFrame, dt) {
    if (!(dt > 0)) return 1;
    if (!(perFrame > 0)) return 0;
    if (perFrame >= 1) return 1;
    return Math.pow(perFrame, Math.min(MAX_DT, dt) / REF_DT);
}

/**
 * The same thing as an approach rate: what `(target - v) * k` wants for `k`.
 *
 * `perFrameK` is the rate as quoted at REF_DT, so `approachFor(0.08, 0.05)` is
 * 0.08 and a frame that took four times as long approaches four times as far.
 */
export function approachFor(perFrameK, dt) {
    return 1 - retentionFor(1 - perFrameK, dt);
}

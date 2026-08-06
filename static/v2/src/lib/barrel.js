// Barrel-wheel physics: the flick, the friction, and where the detents fall.
//
// A barrel is the phone's answer to a knob. There is no room on a handset for
// the Receiver panel's per-digit dial — a digit is a 12 px target and tuning
// means hitting it repeatedly — so the Multipad tunes by spinning a drum
// instead: one gesture, no target to hit, and a flick that carries on after the
// thumb has left the glass.
//
// The maths lives here rather than in the component for the usual reason: a
// drum that stops too early, overshoots, or drops a detent halfway through a
// spin is a bug you can only see with a thumb, and none of it needs a DOM.
//
// Everything below is in CSS pixels and seconds, and every function is pure.

// Fastest spin a flick can start, px/s. A thumb can flick far harder than this
// on glass, and without a cap one flustered swipe sends the dial across the
// band — the point of a spin is that it goes somewhere you can still read.
export const MAX_SPEED = 4200;

// Below this the spin is over, px/s. Left to decay on its own the tail takes
// several seconds to reach zero, all of it too slow to see and all of it still
// firing detents.
export const STOP_SPEED = 24;

// Friction, as an exponential rate per second. A spin travels v0 / FRICTION
// pixels in total, so a hard flick at the cap covers about 1600 px — roughly
// thirty detents at the sizes the Multipad uses, which is a band edge to band
// edge sort of gesture rather than a nudge.
export const FRICTION = 2.6;

// How much of the tail of a drag decides the throw speed, ms. Long enough to
// average out the jitter in a touchscreen's sampling, short enough that a drag
// which slowed to a stop before the finger lifted throws nothing.
export const FLING_WINDOW_MS = 90;

// How quickly the drum eases back onto the nearest detent once it has stopped,
// as an exponential rate per second. Parked between two detents it reads as a
// control that has jammed, so this is deliberately brisk — under a fifth of a
// second to close half a detent — rather than a lazy settle.
export const SETTLE_RATE = 22;

// Longest frame the physics will honour, seconds. A backgrounded tab resumes
// with a gap of whole seconds, and without this the first frame back would
// apply all of it at once and hurl the drum across the band.
export const MAX_DT = 0.1;

export function clampSpeed(v) {
    if (!Number.isFinite(v)) return 0;
    return Math.max(-MAX_SPEED, Math.min(MAX_SPEED, v));
}

/**
 * Throw speed from the tail of a drag, px/s.
 *
 * `samples` is {x, t} oldest-first, t in ms. `now` is the moment the finger
 * lifted: a finger that came to rest and *then* lifted has stopped sending move
 * events, so the samples still describe the movement before the pause and would
 * throw the drum on a gesture that plainly ended. Comparing the last sample
 * against the release is the only way to see that pause at all.
 */
export function flingVelocity(samples, now, windowMs = FLING_WINDOW_MS) {
    if (!samples || samples.length < 2) return 0;
    const last = samples[samples.length - 1];
    if (now != null && now - last.t > windowMs) return 0;

    // The oldest sample still inside the window, or the oldest there is.
    let first = samples[0];
    for (let i = samples.length - 2; i >= 0; i--) {
        first = samples[i];
        if (last.t - samples[i].t >= windowMs) break;
    }
    const dt = last.t - first.t;
    if (!(dt > 0)) return 0;
    return clampSpeed(((last.x - first.x) / dt) * 1000);
}

/** What is left of a spin after `dt` seconds. Zero once it is not worth drawing. */
export function decayVelocity(v, dt, friction = FRICTION) {
    if (!v) return 0;
    const next = v * Math.exp(-friction * Math.min(Math.max(dt, 0), MAX_DT));
    return Math.abs(next) < STOP_SPEED ? 0 : next;
}

/**
 * Splits an accumulated offset into whole detents and the remainder.
 *
 * The remainder is what the drum is drawn at, so a slow drag moves the strip
 * under the index line continuously and only *crosses* a detent — which is what
 * fires a step — when it has travelled a full one. Truncation rather than
 * rounding, so half a detent of travel is half a detent of movement and not a
 * step taken early and then owed back.
 */
export function takeDetents(offset, detent) {
    if (!(detent > 0)) return { steps: 0, rest: offset };
    const steps = Math.trunc(offset / detent);
    return { steps, rest: offset - steps * detent };
}

/** The remainder eased back toward the detent it is nearest. */
export function settleOffset(rest, dt, rate = SETTLE_RATE) {
    if (!rest) return 0;
    const next = rest * Math.exp(-rate * Math.min(Math.max(dt, 0), MAX_DT));
    return Math.abs(next) < 0.5 ? 0 : next;
}

/** How far a spin at `v0` will travel before friction stops it, px. */
export function spinDistance(v0, friction = FRICTION) {
    return v0 / friction;
}

// Was that a tap or the start of a spin?
//
// The drum's ends carry the prev/next marker buttons, and they sit *on* the drum
// rather than beside it: a press there has to be able to mean either "take me to
// that marker" or "spin from here", or the buttons would cost the scale a third
// of its width to start a gesture in. Nothing else can tell the two apart — by
// the time the drum has moved a whole detent it has already tuned, and a thumb
// that lands and lifts without moving has produced no other evidence at all.
//
// Deviation, not net displacement: a swipe out and back would end where it
// started, and that is emphatically not a tap.

// Farthest a finger may wander and still have been a tap, px. Generous, because
// this is a thumb on glass and a press that moves nothing at all is rare — but
// far below a detent (46 px on the frequency drum), so anything that has actually
// tuned is a spin by definition.
export const TAP_SLOP_PX = 12;

// Longest a tap may last, ms. A press held longer than this was a hold — most
// likely a finger parked on the drum to stop a spin, which is a gesture in its
// own right and must not also jump to a marker.
export const TAP_MS = 500;

export function isTap(deviationPx, elapsedMs) {
    return deviationPx <= TAP_SLOP_PX && elapsedMs >= 0 && elapsedMs <= TAP_MS;
}

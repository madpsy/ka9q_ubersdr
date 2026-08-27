// One wheel gesture, one step — whatever the pointing device is.
//
// A mouse wheel sends one event per detent, so a handler that stepped once per
// event was right for it and only for it. A trackpad sends a stream of small
// deltas instead, dozens a second for a single two-finger swipe, and the same
// handler ran away: the frequency dial's digits blurred past several kHz for a
// gesture the hand read as a nudge.
//
// So measure the scroll in pixels rather than in events. Deltas accumulate
// until they cross a detent's worth of travel, which fires one step and clears
// the total — never more than one step per event, so a mouse detent (100 px in
// Chrome, three lines in Firefox) still steps exactly once and a trackpad has
// to be pushed a real distance for each one.

// A detent, in pixels of scroll. Under every mouse's per-notch delta — Chrome
// reports 100, Firefox three lines — so no mouse ever needs two notches to move
// one step, and far enough that a trackpad swipe is counted rather than
// multiplied.
export const WHEEL_NOTCH = 40;

// Wheel deltas come in three units, and only pixels are comparable to a
// threshold. The line and page figures are the usual approximations; they only
// have to be close, since both are already well past one detent.
export function wheelPixels(e) {
    if (e.deltaMode === 1) return e.deltaY * 16;    // lines
    if (e.deltaMode === 2) return e.deltaY * 400;   // pages
    return e.deltaY || 0;
}

/**
 * Makes a per-element wheel accumulator.
 *
 * Call the returned function with each wheel event; it returns +1 (scroll up),
 * -1 (scroll down) or 0 for the events that have not yet added up to a step.
 * Direction follows the dial's digits — scrolling up means up — rather than the
 * sign of deltaY, which points the other way.
 *
 * State is per accumulator, so give each control its own.
 */
export function createWheelStep(notch = WHEEL_NOTCH) {
    let acc = 0;
    return (e) => {
        const px = wheelPixels(e);
        if (!px) return 0;
        // Reversing means the previous direction's leftovers are stale: kept,
        // they would make the first step back the other way come early.
        if ((px < 0) !== (acc < 0)) acc = 0;
        acc += px;
        if (Math.abs(acc) < notch) return 0;
        const dir = acc < 0 ? 1 : -1;
        acc = 0;
        return dir;
    };
}


// ---------------------------------------------------------------------------
// Acceleration: what a *spin* means, as against what a click means.
//
// The thing people actually want from a faster wheel is to get somewhere, and
// the obvious way to give it to them — a multiplier on the step — is the wrong
// one. That is what the tuning step already is, and a second setting multiplying
// into the same number leaves the wheel quietly working a coarser grid than the
// +/- buttons, click-to-tune and the Multipad, which all take the step at face
// value. It was tried here and it was wrong.
//
// So the multiplier comes from the gesture instead of from a setting. One click
// is one step and always will be, whatever this is set to; keep clicking quickly
// and the wheel spins up, the way a weighted VFO knob does and the way most rigs
// with a tuning encoder behave. Nothing else in the app has to know: the step is
// still the step, and a spin simply takes several of them at once.
//
// Three properties make it safe to tune with, and all three are worth keeping:
//
//   The first notch of any gesture is exactly one step. You can never land
//   somewhere unexpected by touching the wheel once, which is the case fine
//   tuning is made of.
//
//   It builds rather than jumping. The ramp is a function of how many notches
//   have arrived in a row, not of one measured gap — a single fast pair of
//   events, which trackpads produce constantly, must not fling the dial.
//
//   Pausing resets it. Stop for a moment and you are back to one step a notch,
//   so the way to tune precisely is the way you would do it anyway: slowly.
//
// The steps are *added*, not enlarged — see stepBy in RadioContext, which snaps
// once to the step grid and then counts whole steps from there. A spin therefore
// lands on the same round frequencies a slow turn would have passed through,
// which is the other half of not being a step-size setting.

// A notch arriving within this of the last one is part of a spin. Above it the
// hand is placing clicks deliberately and nothing is multiplied.
//
// 150 ms is a little over two notches a second, which is about as slow as a spin
// gets before it stops feeling like one — and comfortably above the gap a
// trackpad or a free-spinning wheel produces while it is actually moving.
export const SPIN_MS = 150;

// Notches per doubling. Four means the first three of a spin are single steps,
// the next four are doubles, and so on up to the ceiling — a second or so of
// spinning to reach the top, which is long enough to feel like a decision and
// short enough to be worth having.
export const SPIN_RAMP = 4;

// The ceilings offered. 1 is off — every notch is one step, whatever you do.
//
// The top of it is high, and safely so: the ramp gates it. Reaching 64 takes 25
// unbroken notches — a couple of seconds of deliberate spinning — by which point
// the dial has already moved 158 kHz at a 500 Hz step, so it is not somewhere a
// hand arrives without meaning to. 32 wants 21 and 16 wants 17.
//
// What the top rungs cost is overshoot: a notch at 64 is 32 kHz on that same
// step, so stopping late means winding back by that much. That is a real price
// and it is why the default is 4, which tops out at 2 kHz a notch.
//
// At a large tuning step the high rungs are largely academic — 100 kHz steps at
// 64 would be 6.4 MHz a notch, and the band edge arrives long before the ramp
// does. Nothing has to special-case that: the clamp in stepBy is the backstop.
export const WHEEL_ACCELS = [1, 2, 4, 8, 16, 32, 64];

// Fast enough to cross a band on a good spin, gentle enough that a careless one
// does not throw the dial into the next megahertz.
export const WHEEL_ACCEL_DEFAULT = 4;

/** A stored ceiling as one of the rungs, for anything that has drifted or is absent. */
export function nearestWheelAccel(max) {
    const v = Number(max);
    if (!Number.isFinite(v) || v <= 0) return WHEEL_ACCEL_DEFAULT;
    let best = WHEEL_ACCELS[0];
    // By ratio rather than difference: the rungs double, so 3 belongs with 4.
    for (const a of WHEEL_ACCELS) {
        if (Math.abs(Math.log(v / a)) < Math.abs(Math.log(v / best))) best = a;
    }
    return best;
}

/** What the setting is called where there is room to say it. */
export function wheelAccelLabel(max) {
    const a = nearestWheelAccel(max);
    return a === 1 ? 'Off — every notch is one step' : `One step a notch, up to ${a} spun fast`;
}

/**
 * How many steps this notch is worth, given how the ones before it arrived.
 *
 * Kept apart from the accumulator so the ramp can be tested as arithmetic — the
 * failure worth guarding is a gesture producing the wrong total, and that is a
 * sequence of notches and timestamps rather than anything about pixels.
 *
 * `run` is how many notches have arrived in a row without a pause or a reversal.
 */
export function spinSteps(run, max) {
    const ceiling = nearestWheelAccel(max);
    if (ceiling <= 1 || run < 1) return 1;
    return Math.min(ceiling, 2 ** Math.floor((run - 1) / SPIN_RAMP));
}

/**
 * A wheel accumulator that answers in steps, with the spin applied.
 *
 * Returns a signed count — +n for n steps up, -n down, 0 for an event that has
 * not yet added up to a notch. `getMax` is read per notch rather than captured,
 * so changing the setting takes effect under a hand already scrolling.
 *
 * Time comes from the event, not from a clock, so a whole gesture can be played
 * through this in a test and so the two agree about when it happened.
 */
export function createAcceleratedWheelStep(getMax, notch = WHEEL_NOTCH) {
    const step = createWheelStep(notch);
    let run = 0;
    let at = -Infinity;
    let was = 0;
    return (e) => {
        const dir = step(e);
        if (!dir) return 0;
        const now = Number.isFinite(e.timeStamp) ? e.timeStamp : 0;
        // A reversal is a new gesture even when it is quick. Winding back is
        // usually a correction, and a correction that arrives multiplied
        // overshoots the thing it was correcting.
        if (dir !== was || now - at > SPIN_MS) run = 0;
        run += 1;
        was = dir;
        at = now;
        return dir * spinSteps(run, getMax());
    };
}

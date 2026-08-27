// A wheel step is a distance, not an event count.
//
// The rule these pin: a mouse detent still steps exactly once, and a trackpad's
// stream of small deltas has to add up to a detent's worth of travel first.

const assert = require('assert');
const {
    SPIN_MS, SPIN_RAMP, WHEEL_ACCELS, WHEEL_ACCEL_DEFAULT, WHEEL_NOTCH,
    createAcceleratedWheelStep, createWheelStep, nearestWheelAccel, spinSteps,
    wheelPixels, wheelAccelLabel,
} = require('./.build/wheelstep.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const ev = (deltaY, deltaMode = 0) => ({ deltaY, deltaMode });
// Total steps a series of events produces, signed the way the dial reads them.
const run = (step, events) => events.reduce((n, e) => n + step(e), 0);

t('a Chrome mouse detent is one step, whichever way it turns', () => {
    const step = createWheelStep();
    assert.strictEqual(step(ev(-100)), 1);
    assert.strictEqual(step(ev(100)), -1);
});

t('a Firefox line-mode detent is one step too', () => {
    // Three lines, the usual figure — under the 100 px Chrome reports, so it
    // has to be the threshold that is under *it* rather than the other way.
    const step = createWheelStep();
    assert.strictEqual(step(ev(-3, 1)), 1);
    assert.strictEqual(step(ev(3, 1)), -1);
});

t('a page-mode scroll is still only one step', () => {
    const step = createWheelStep();
    assert.strictEqual(step(ev(-1, 2)), 1);
});

t('ten mouse detents are ten steps, not a hundred', () => {
    const step = createWheelStep();
    const detents = Array.from({ length: 10 }, () => ev(-100));
    assert.strictEqual(run(step, detents), 10);
});

t('a trackpad swipe steps by distance, not by event', () => {
    // Forty small deltas — one physical swipe — used to be forty steps.
    const step = createWheelStep();
    const swipe = Array.from({ length: 40 }, () => ev(-4));
    assert.strictEqual(run(step, swipe), Math.floor(40 * 4 / WHEEL_NOTCH));
});

t('a nudge below a detent moves nothing', () => {
    const step = createWheelStep();
    for (let i = 0; i < 9; i++) assert.strictEqual(step(ev(-4)), 0);
});

t('the leftovers of a detent do not shorten the next one', () => {
    // 100 px fires at 40 and the remaining 60 is dropped, so the second detent
    // needs its own full travel rather than arriving early.
    const step = createWheelStep();
    assert.strictEqual(step(ev(-100)), 1);
    assert.strictEqual(step(ev(-20)), 0);
    assert.strictEqual(step(ev(-20)), 1);
});

t('reversing drops the old direction leftovers', () => {
    const step = createWheelStep();
    // Most of a step up, then a full detent down: the down must not be delayed
    // by the up's leftovers, nor helped along by them.
    assert.strictEqual(step(ev(-30)), 0);
    assert.strictEqual(step(ev(30)), 0);
    assert.strictEqual(step(ev(10)), -1);
});

t('a zero delta is not a step', () => {
    const step = createWheelStep();
    assert.strictEqual(step(ev(0)), 0);
    assert.strictEqual(step({ deltaMode: 0 }), 0);
});

t('accumulators are independent', () => {
    const a = createWheelStep();
    const b = createWheelStep();
    assert.strictEqual(a(ev(-30)), 0);
    assert.strictEqual(b(ev(-30)), 0);
    assert.strictEqual(a(ev(-10)), 1);
    assert.strictEqual(b(ev(-10)), 1);
});

t('pixels are the unit the threshold is in', () => {
    assert.strictEqual(wheelPixels(ev(120)), 120);
    assert.strictEqual(wheelPixels(ev(3, 1)), 48);
    assert.ok(wheelPixels(ev(1, 2)) >= WHEEL_NOTCH);
});

// --- acceleration: what a spin means, as against a click ---------------------
//
// The property that has to hold whatever else changes: one deliberate click is
// one step. Everything else here is about a spin, and a spin is defined by
// notches arriving close together in the same direction.

// A detent at a given moment. Chrome's 100 px, so one event is one notch.
const at = (ms, down = false) => ({ deltaY: down ? 100 : -100, deltaMode: 0, timeStamp: ms });
const accel = (max) => createAcceleratedWheelStep(() => max);

t('a click on its own is one step, at every setting', () => {
    for (const max of WHEEL_ACCELS) {
        const step = accel(max);
        assert.strictEqual(step(at(0)), 1, `up at ${max}`);
        // And still one after a pause, however many came before it.
        assert.strictEqual(step(at(5000)), 1, `after a pause at ${max}`);
    }
});

t('deliberate clicks never accelerate, however many there are', () => {
    // Slower than a spin: SPIN_MS apart and a hair more.
    const step = accel(16);
    for (let i = 0; i < 30; i++) {
        assert.strictEqual(step(at(i * (SPIN_MS + 20))), 1, `click ${i}`);
    }
});

t('a spin builds, a notch at a time, and stops at the ceiling', () => {
    const step = accel(4);
    const got = [];
    for (let i = 0; i < 20; i++) got.push(step(at(i * 30)));
    // The first SPIN_RAMP are single steps — you cannot be flung by starting.
    assert.deepStrictEqual(got.slice(0, SPIN_RAMP), Array(SPIN_RAMP).fill(1));
    assert.strictEqual(got[SPIN_RAMP], 2);
    assert.strictEqual(got[SPIN_RAMP * 2], 4);
    // And no further, because 4 is the ceiling asked for.
    assert.ok(got.slice(SPIN_RAMP * 2).every((n) => n === 4), String(got));
});

t('the ceiling is the ceiling, whichever one is chosen', () => {
    for (const max of WHEEL_ACCELS) {
        const step = accel(max);
        let top = 0;
        for (let i = 0; i < 60; i++) top = Math.max(top, step(at(i * 20)));
        assert.strictEqual(top, max, `ceiling ${max}`);
    }
});

t('off means off — every notch is one step however hard it is spun', () => {
    const step = accel(1);
    for (let i = 0; i < 40; i++) assert.strictEqual(step(at(i * 10)), 1, `notch ${i}`);
});

t('a pause drops it back to single steps', () => {
    const step = accel(8);
    let t0 = 0;
    for (let i = 0; i < 16; i++) { step(at(t0)); t0 += 20; }
    // Wound up by now — check it really was, or the rest proves nothing.
    assert.ok(step(at(t0)) > 1);
    // Hand off the wheel, then one more click.
    assert.strictEqual(step(at(t0 + SPIN_MS + 1)), 1);
});

t('turning back is a new gesture, even when it is quick', () => {
    // Winding back is a correction, and a correction that arrives multiplied
    // overshoots the thing it was correcting.
    const step = accel(8);
    let t0 = 0;
    for (let i = 0; i < 16; i++) { step(at(t0)); t0 += 20; }
    assert.ok(step(at(t0)) > 1);
    assert.strictEqual(step(at(t0 + 20, true)), -1);
});

t('the direction is carried through the multiplier', () => {
    const step = accel(4);
    let n = 0;
    for (let i = 0; i < 12; i++) n = step(at(i * 20, true));
    assert.ok(n < 0, `expected a downward count, got ${n}`);
});

t('a trackpad spins up too, on travel rather than on events', () => {
    // Four pixels an event, so ten events to the notch — a real swipe. The
    // notches it produces are close together, so it accelerates like a wheel.
    const step = accel(4);
    let total = 0;
    for (let i = 0; i < 200; i++) {
        total += step({ deltaY: -4, deltaMode: 0, timeStamp: i * 3 });
    }
    // 200 events of 4 px is 20 notches. Unaccelerated that is 20 steps; with a
    // ceiling of 4 it is well past that, and nothing like 200.
    assert.ok(total > 20, `expected acceleration, got ${total}`);
    assert.ok(total < 20 * 4, `expected the ramp, not the ceiling throughout: ${total}`);
});

t('the ramp is arithmetic, and testable as such', () => {
    // spinSteps is the whole of the shape: run length in, multiplier out.
    assert.strictEqual(spinSteps(1, 16), 1);
    assert.strictEqual(spinSteps(SPIN_RAMP, 16), 1);
    assert.strictEqual(spinSteps(SPIN_RAMP + 1, 16), 2);
    assert.strictEqual(spinSteps(SPIN_RAMP * 2 + 1, 16), 4);
    // Never below one, whatever it is asked.
    assert.strictEqual(spinSteps(0, 16), 1);
    assert.strictEqual(spinSteps(-5, 16), 1);
    assert.strictEqual(spinSteps(100, 1), 1);
});

t('a ceiling off the ladder is snapped to a rung', () => {
    assert.strictEqual(nearestWheelAccel(4), 4);
    assert.strictEqual(nearestWheelAccel(3), 4);      // ratio, not difference
    assert.strictEqual(nearestWheelAccel(100), 64);
    assert.strictEqual(nearestWheelAccel(0.01), 1);
    for (const bad of [0, -2, undefined, null, 'rubbish', {}]) {
        assert.strictEqual(nearestWheelAccel(bad), WHEEL_ACCEL_DEFAULT, String(bad));
    }
    for (const a of WHEEL_ACCELS) assert.strictEqual(nearestWheelAccel(a), a);
});

t('the default is on the ladder, and the ladder ascends', () => {
    assert.ok(WHEEL_ACCELS.includes(WHEEL_ACCEL_DEFAULT));
    assert.strictEqual(WHEEL_ACCELS[0], 1, 'off must be the bottom rung');
    assert.ok(WHEEL_ACCELS.every((a, i) => i === 0 || a > WHEEL_ACCELS[i - 1]));
});

t('the label says off when it is off, and the ceiling when it is not', () => {
    assert.ok(/off/i.test(wheelAccelLabel(1)));
    assert.ok(/\b4\b/.test(wheelAccelLabel(4)));
    // Always says a notch is one step, which is the part people mistrust.
    assert.ok(/one step/i.test(wheelAccelLabel(4)), wheelAccelLabel(4));
});

console.log(`\n${pass} passed`);
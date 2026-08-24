// A wheel step is a distance, not an event count.
//
// The rule these pin: a mouse detent still steps exactly once, and a trackpad's
// stream of small deltas has to add up to a detent's worth of travel first.

const assert = require('assert');
const { WHEEL_NOTCH, createWheelStep, wheelPixels } = require('./.build/wheelstep.cjs');

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

console.log(`\n${pass} passed`);

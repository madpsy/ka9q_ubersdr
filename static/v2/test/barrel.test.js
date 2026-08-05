// Barrel-wheel physics.
//
// All of it is felt rather than seen, which is exactly why it is pinned here: a
// drum that throws when the thumb had stopped, keeps firing detents after the
// spin is over, or loses half a detent on every crossing is a bug nobody can
// point at from a screenshot.

const assert = require('assert');
const {
    clampSpeed, decayVelocity, flingVelocity, settleOffset, spinDistance, takeDetents,
    FLING_WINDOW_MS, FRICTION, MAX_DT, MAX_SPEED, STOP_SPEED,
} = require('./.build/barrel.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// --- the throw ---------------------------------------------------------------

t('a steady drag throws at the speed it was moving', () => {
    // 300 px in 100 ms.
    const s = [{ x: 0, t: 0 }, { x: 100, t: 33 }, { x: 200, t: 66 }, { x: 300, t: 100 }];
    assert.ok(Math.abs(flingVelocity(s, 100) - 3000) < 60);
});

t('a drag that stopped before the finger lifted throws nothing', () => {
    // Fast, then held still for 200 ms with no further move events.
    const s = [{ x: 0, t: 0 }, { x: 200, t: 50 }, { x: 400, t: 100 }];
    assert.strictEqual(flingVelocity(s, 300), 0);
});

t('a drag that slowed to a crawl throws almost nothing', () => {
    // The tail is what counts, not the whole gesture: this one covered 400 px
    // but the last window barely moved.
    const s = [
        { x: 0, t: 0 }, { x: 300, t: 100 }, { x: 395, t: 200 },
        { x: 398, t: 250 }, { x: 400, t: 300 },
    ];
    assert.ok(Math.abs(flingVelocity(s, 300)) < 100);
});

t('a throw is capped', () => {
    const s = [{ x: 0, t: 0 }, { x: 5000, t: 20 }];
    assert.strictEqual(flingVelocity(s, 20), MAX_SPEED);
    assert.strictEqual(clampSpeed(-1e6), -MAX_SPEED);
    assert.strictEqual(clampSpeed(NaN), 0);
});

t('a tap throws nothing', () => {
    assert.strictEqual(flingVelocity([{ x: 4, t: 0 }], 0), 0);
    assert.strictEqual(flingVelocity([], 0), 0);
    assert.strictEqual(flingVelocity(null, 0), 0);
});

t('only the tail of a long drag decides the throw', () => {
    // Two seconds of dawdling, then a flick: the flick is the gesture.
    const s = [{ x: 0, t: 0 }, { x: 20, t: 2000 }, { x: 320, t: 2000 + FLING_WINDOW_MS }];
    assert.ok(flingVelocity(s, 2000 + FLING_WINDOW_MS) > 2500);
});

// --- the spin ----------------------------------------------------------------

t('a spin decays and then stops outright', () => {
    let v = 2000;
    let frames = 0;
    while (v && frames < 600) { v = decayVelocity(v, 1 / 60); frames++; }
    assert.strictEqual(v, 0);
    // A hard flick is over in a couple of seconds, not ten.
    assert.ok(frames < 180, `took ${frames} frames`);
});

t('a spin below the floor is over immediately', () => {
    assert.strictEqual(decayVelocity(STOP_SPEED - 1, 1 / 60), 0);
    assert.strictEqual(decayVelocity(0, 1 / 60), 0);
});

t('a backgrounded tab does not resume by hurling the drum', () => {
    // Eight seconds between frames. Honouring it would decay to nothing, which
    // is harmless — the danger is the *caller* multiplying velocity by dt, so
    // what matters is that the same clamp is applied on both sides.
    assert.strictEqual(decayVelocity(3000, 8), decayVelocity(3000, MAX_DT));
    assert.strictEqual(settleOffset(20, 8), settleOffset(20, MAX_DT));
});

t('the distance a spin travels is v0 over the friction', () => {
    // Integrating the decay numerically must land on the closed form, or the
    // detent sizes were chosen against a drum that goes somewhere else.
    let v = 3000;
    let x = 0;
    for (let i = 0; i < 2000 && v; i++) { x += v * (1 / 240); v = decayVelocity(v, 1 / 240); }
    const predicted = spinDistance(3000, FRICTION);
    assert.ok(Math.abs(x - predicted) / predicted < 0.05, `${x} vs ${predicted}`);
});

// --- detents -----------------------------------------------------------------

t('a detent is crossed only once it has been travelled in full', () => {
    assert.deepStrictEqual(takeDetents(45, 46), { steps: 0, rest: 45 });
    assert.deepStrictEqual(takeDetents(46, 46), { steps: 1, rest: 0 });
    assert.deepStrictEqual(takeDetents(70, 46), { steps: 1, rest: 24 });
});

t('detents are symmetric about zero', () => {
    const up = takeDetents(70, 46);
    const down = takeDetents(-70, 46);
    assert.strictEqual(down.steps, -up.steps);
    assert.strictEqual(down.rest, -up.rest);
});

t('a fast frame takes every detent it crossed', () => {
    // 200 px in one frame is three detents, not one — dropping the rest is how
    // a spin ends up somewhere other than where it was thrown.
    assert.deepStrictEqual(takeDetents(200, 46), { steps: 4, rest: 200 - 184 });
});

t('nothing is owed after a crossing', () => {
    // Walk a drum through a spin and check the accounting closes: every pixel
    // is either a whole detent taken or a remainder still on the drum.
    let rest = 0;
    let steps = 0;
    let moved = 0;
    for (let i = 0; i < 200; i++) {
        const dx = 7.3;
        moved += dx;
        const r = takeDetents(rest + dx, 46);
        rest = r.rest;
        steps += r.steps;
    }
    assert.ok(Math.abs(steps * 46 + rest - moved) < 1e-9);
});

t('a detent of zero is refused rather than dividing by it', () => {
    assert.deepStrictEqual(takeDetents(30, 0), { steps: 0, rest: 30 });
});

// --- the settle --------------------------------------------------------------

t('the drum eases onto the detent and gets there', () => {
    let rest = 22;
    let frames = 0;
    while (rest && frames < 600) { rest = settleOffset(rest, 1 / 60); frames++; }
    assert.strictEqual(rest, 0);
    // Brisk: parked between detents reads as a jam, so this is well under a
    // fifth of a second.
    assert.ok(frames < 14, `took ${frames} frames`);
});

t('settling never crosses a detent of its own', () => {
    // It only ever shrinks the remainder, so it cannot fire a step on the way.
    let rest = -45;
    for (let i = 0; i < 60 && rest; i++) {
        const next = settleOffset(rest, 1 / 60);
        assert.ok(Math.abs(next) <= Math.abs(rest));
        assert.ok(next * rest >= 0, 'must not overshoot past zero');
        rest = next;
    }
});

console.log(`\n${pass} passed`);

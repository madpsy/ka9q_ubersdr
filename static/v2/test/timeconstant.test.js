// Smoothing that means the same thing at any frame rate.
//
// The spectrum arrives about twice as often on a narrow span as on a wide one,
// and both the trace smoothing and the auto-levels ease towards their target a
// fixed fraction per redraw. So the wall-clock time either takes to settle used
// to depend on the zoom: the same slider setting lagged several times longer
// once you zoomed out, and the levels crawled. Nothing looked broken — it just
// felt sluggish on a wide span, which is the hardest kind of bug to notice.
//
// The property being tested is the one a per-frame factor does not have:
// applying the smoothing twice over half an interval each must equal applying
// it once over the whole. Everything else here follows from that.

const assert = require('assert');

const { MAX_DT, REF_DT, approachFor, retentionFor } = require('./.build/timeconstant.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) < eps, `${what}: ${a} vs ${b}`);

// One step of `v = v * a + target * (1 - a)`, the trace smoothing.
const ease = (v, target, a) => v * a + target * (1 - a);

t('a frame at the reference rate is unchanged', () => {
    // The stored settings are quoted at 20 Hz, so anything already tuned there
    // has to keep behaving exactly as it did.
    near(retentionFor(0.5, REF_DT), 0.5, 1e-12, 'retention');
    near(approachFor(0.08, REF_DT), 0.08, 1e-12, 'approach');
});

t('splitting an interval gives the same answer as not splitting it', () => {
    // The whole point. A per-frame factor fails this, which is why the frame
    // rate used to leak into how the display behaved.
    for (const perFrame of [0.2, 0.5, 0.92]) {
        for (const dt of [0.05, 0.1, 0.2, 0.35]) {
            const once = retentionFor(perFrame, dt);
            const half = retentionFor(perFrame, dt / 2);
            near(half * half, once, 1e-12, `${perFrame} over ${dt}s`);
        }
    }
});

t('a slow feed reaches the same place at the same time as a fast one', () => {
    // The observable version of the property above: two receivers on the same
    // signal, one sending 20 frames a second and one sending 5, must show the
    // same trace one second later.
    for (const smoothing of [0.3, 0.5, 0.8]) {
        let fast = 0;
        for (let i = 0; i < 20; i++) fast = ease(fast, 100, retentionFor(smoothing, 0.05));
        let slow = 0;
        for (let i = 0; i < 5; i++) slow = ease(slow, 100, retentionFor(smoothing, 0.2));
        near(fast, slow, 1e-9, `smoothing ${smoothing} after 1s`);
    }
});

t('the auto-levels settle in the same time at either rate', () => {
    const step = (v, target, k) => v + (target - v) * k;
    let fast = -110;
    for (let i = 0; i < 20; i++) fast = step(fast, -70, approachFor(0.08, 0.05));
    let slow = -110;
    for (let i = 0; i < 5; i++) slow = step(slow, -70, approachFor(0.08, 0.2));
    near(fast, slow, 1e-9, 'auto-range after 1s');
});

t('the old per-frame behaviour really was rate-dependent', () => {
    // Guards the premise: if this ever stops holding, the fix above is solving
    // a problem that no longer exists.
    let fast = 0;
    for (let i = 0; i < 20; i++) fast = ease(fast, 100, 0.5);
    let slow = 0;
    for (let i = 0; i < 5; i++) slow = ease(slow, 100, 0.5);
    // A quarter of the frames left the old trace far short of the target.
    assert.ok(fast > 99.9, `fast reached ${fast}`);
    assert.ok(slow < 97, `slow reached ${slow}`);
});

t('no time passed means nothing moves', () => {
    // Two draws in the same millisecond — a display setting changing right
    // after a frame — must not advance the smoothing by a whole step.
    assert.strictEqual(retentionFor(0.5, 0), 1);
    assert.strictEqual(retentionFor(0.5, -1), 1);
    assert.strictEqual(approachFor(0.08, 0), 0);
    assert.strictEqual(ease(42, 100, retentionFor(0.5, 0)), 42);
});

t('smoothing off keeps nothing, whatever the interval', () => {
    for (const dt of [0.01, 0.05, 0.5]) assert.strictEqual(retentionFor(0, dt), 0);
});

t('a long gap snaps rather than easing from stale data', () => {
    // A backgrounded tab or a stalled feed. Holding on to a minute-old trace
    // and easing away from it would show a signal that had long since gone.
    const a = retentionFor(0.5, 60);
    assert.ok(a < 1e-5, `retention after a minute: ${a}`);
    // Clamped, so the exponent cannot run away into a denormal.
    assert.strictEqual(retentionFor(0.5, 60), retentionFor(0.5, MAX_DT));
});

t('a frozen factor stays frozen and never exceeds its bounds', () => {
    assert.strictEqual(retentionFor(1, 0.2), 1);
    assert.strictEqual(retentionFor(1.5, 0.2), 1);
    for (const perFrame of [0, 0.1, 0.5, 0.92, 1]) {
        for (const dt of [0.001, 0.05, 0.2, 5]) {
            const a = retentionFor(perFrame, dt);
            assert.ok(a >= 0 && a <= 1, `${perFrame} over ${dt}s gave ${a}`);
        }
    }
});

t('a faster-than-reference frame smooths less, not more', () => {
    // Monotonic in dt: a shorter frame must keep more of the old value, or a
    // burst of frames would race past the target.
    let prev = -1;
    for (const dt of [0.005, 0.02, 0.05, 0.1, 0.4]) {
        const a = retentionFor(0.5, dt);
        assert.ok(prev < 0 || a < prev, `retention rose from ${prev} to ${a} at dt=${dt}`);
        prev = a;
    }
});

console.log(`\n${pass} passed`);

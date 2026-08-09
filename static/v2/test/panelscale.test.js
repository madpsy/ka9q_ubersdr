// Per-panel text size, on top of the global one.
//
// The behaviour that matters is what an offset means when the global size
// moves under it, and what happens at the ends of the range — where a control
// that stores presses it could not act on comes back with a button that does
// nothing for the first few clicks.

const assert = require('assert');
const { canScale, cleanScale, nudgeScale, panelScale } = require('./.build/panelscale.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// The display settings' own range: UI_SCALE_MIN/MAX/STEP.
const R = { min: 0.75, max: 1.6, step: 0.05 };

t('a panel with no offset is the global size', () => {
    assert.strictEqual(panelScale(1, 0, R), 1);
    assert.strictEqual(panelScale(1.1, 0, R), 1.1);
});

t('the case this was asked for: 110% global, one panel taken to 100%', () => {
    let delta = 0;
    delta = nudgeScale(1.1, delta, -1, R);
    assert.strictEqual(panelScale(1.1, delta, R), 1.05);
    delta = nudgeScale(1.1, delta, -1, R);
    assert.strictEqual(panelScale(1.1, delta, R), 1);
});

t('the offset follows the global control rather than being stranded by it', () => {
    // Two steps down at 110%...
    let delta = nudgeScale(1.1, nudgeScale(1.1, 0, -1, R), -1, R);
    assert.strictEqual(panelScale(1.1, delta, R), 1);
    // ...is still two steps down when everything is made bigger.
    assert.strictEqual(panelScale(1.3, delta, R), 1.2);
    // ...and two steps down when everything is made smaller.
    assert.strictEqual(panelScale(0.95, delta, R), 0.85);
});

t('the effective size is clamped, and the offset survives the clamp', () => {
    // Two steps below the floor is the floor...
    const delta = -0.2;
    assert.strictEqual(panelScale(R.min, delta, R), R.min);
    // ...and the two steps are still there when there is room for them again.
    assert.strictEqual(panelScale(1, delta, R), 0.8);
});

t('a press at the end of the range stores nothing to press back out', () => {
    // The bug this pins: an offset that grew on every click would need the same
    // number of clicks back before the panel moved at all.
    let delta = 0;
    for (let i = 0; i < 40; i += 1) delta = nudgeScale(1, delta, 1, R);
    assert.strictEqual(panelScale(1, delta, R), R.max);
    assert.strictEqual(canScale(1, delta, 1, R), false, 'should be at the top');
    // One press back is one step, not forty.
    delta = nudgeScale(1, delta, -1, R);
    assert.strictEqual(panelScale(1, delta, R), Math.round((R.max - R.step) * 100) / 100);
});

t('a press is offered exactly when it would do something', () => {
    assert.strictEqual(canScale(1, 0, 1, R), true);
    assert.strictEqual(canScale(1, 0, -1, R), true);
    assert.strictEqual(canScale(R.max, 0, 1, R), false);
    assert.strictEqual(canScale(R.min, 0, -1, R), false);
    // At the floor with room above it.
    assert.strictEqual(canScale(R.min, 0, 1, R), true);
});

t('every step lands on a round percentage', () => {
    let delta = 0;
    for (let i = 0; i < 12; i += 1) {
        delta = nudgeScale(1, delta, 1, R);
        // Within floating-point noise of one: the values are rounded to two
        // decimals as they are made, so 1.1 is 1.1 — but 1.1 * 100 is not
        // exactly 110 in binary, and the readout rounds on the way out anyway.
        const s = panelScale(1, delta, R);
        assert.ok(Math.abs(s * 100 - Math.round(s * 100)) < 1e-6, `${s} is not a whole percent`);
    }
});

t('nonsense out of a stored layout is no offset at all', () => {
    assert.strictEqual(cleanScale(undefined), 0);
    assert.strictEqual(cleanScale('big'), 0);
    assert.strictEqual(cleanScale(NaN), 0);
    assert.strictEqual(cleanScale(Infinity), 0);
    // ...and something merely daft is brought back into range rather than
    // scaling a panel off the screen.
    assert.strictEqual(cleanScale(40), 1);
    assert.strictEqual(cleanScale(-40), -1);
    assert.strictEqual(cleanScale(-0.15), -0.15);
});

console.log(`\n${pass} panel scale checks passed`);

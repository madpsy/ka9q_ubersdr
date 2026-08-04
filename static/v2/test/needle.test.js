// The needle meters' geometry.
//
// The arc is the crown of a circle whose pivot is off the bottom of the box, so
// "fits in the box" is not obvious by looking at the numbers — and a scale that
// runs off the edge is exactly the kind of thing that only shows up on someone
// else's dock width. These pin it at the sizes the panel actually uses.

const assert = require('assert');
const {
    SWEEP, PAD_TOP, PAD_BOTTOM, PAD_X, LABEL_INSET,
    angleAt, arcAngle, geometry, pointAt, stepPeak,
} = require('./.build/needle.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const H = 74;
// A narrow side dock, the default dock, and a wide floating window.
const WIDTHS = [200, 300, 520];

t('the whole scale stays inside the box at every dock width', () => {
    for (const w of WIDTHS) {
        const g = geometry(w, H);
        for (const f of [0, 0.25, 0.5, 0.75, 1]) {
            for (const r of [g.radius, g.radius - LABEL_INSET]) {
                const p = pointAt(g, f, r);
                assert.ok(p.y >= 0, `w=${w} f=${f} above the top: ${p.y}`);
                assert.ok(p.y <= H - PAD_BOTTOM + 0.001, `w=${w} f=${f} below the bottom: ${p.y}`);
                assert.ok(p.x >= 0 && p.x <= w, `w=${w} f=${f} off the side: ${p.x}`);
            }
        }
    }
});

t('the crown of the arc sits at the top padding, whatever the width', () => {
    for (const w of WIDTHS) {
        const g = geometry(w, H);
        assert.ok(Math.abs(pointAt(g, 0.5, g.radius).y - PAD_TOP) < 1e-9, `w=${w}`);
    }
});

t('a meter too wide for its height narrows the arc instead of clipping it', () => {
    const narrow = geometry(300, H);
    const wide = geometry(520, H);
    // Same radius: the wide one is capped by the height, not the width.
    assert.strictEqual(wide.radius, narrow.radius > 0 ? wide.radius : 0);
    assert.ok(wide.radius <= (520 / 2 - PAD_X) / Math.sin(SWEEP));
    // ...and it is still centred, with room to spare at the sides.
    const end = pointAt(wide, 1, wide.radius);
    assert.ok(end.x < 520 - PAD_X, 'a height-capped arc must not reach the edge');
    assert.ok(Math.abs((wide.cx - pointAt(wide, 0, wide.radius).x) - (end.x - wide.cx)) < 1e-9);
});

t('the scale runs left to right, and 0.5 is straight up', () => {
    const g = geometry(300, H);
    assert.ok(pointAt(g, 0, g.radius).x < pointAt(g, 0.5, g.radius).x);
    assert.ok(pointAt(g, 0.5, g.radius).x < pointAt(g, 1, g.radius).x);
    assert.ok(Math.abs(pointAt(g, 0.5, g.radius).x - g.cx) < 1e-9);
    // The ends are level with each other, and lower than the crown.
    assert.ok(Math.abs(pointAt(g, 0, g.radius).y - pointAt(g, 1, g.radius).y) < 1e-9);
    assert.ok(pointAt(g, 0, g.radius).y > pointAt(g, 0.5, g.radius).y);
});

t('a reading off either end is pinned to the end, not swung past it', () => {
    assert.strictEqual(angleAt(-3), angleAt(0));
    assert.strictEqual(angleAt(4), angleAt(1));
    assert.strictEqual(angleAt(NaN), angleAt(0));
    assert.strictEqual(angleAt(null), angleAt(0));
});

t('canvas arc angles are the mirror of the drawing angles', () => {
    // Canvas y grows downwards, so arc() sweeps the other way. Getting this
    // wrong draws the meter below the box, where nothing is visible at all.
    assert.strictEqual(arcAngle(0), -angleAt(0));
    assert.ok(arcAngle(0) < arcAngle(1), 'arc() must sweep forwards from 0 to 1');
});

t('peak hold rises at once, holds, then falls', () => {
    let p = stepPeak(null, 0.8, 0);
    assert.strictEqual(p.value, 0.8);
    // Still held a moment later, even though the reading has dropped.
    p = stepPeak(p, 0.2, 0.3);
    assert.strictEqual(p.value, 0.8);
    // Past the hold it decays...
    p = stepPeak(p, 0.2, 0.5);
    assert.ok(p.value < 0.8 && p.value > 0.2, `decaying, got ${p.value}`);
    // ...and never below the live reading.
    p = stepPeak(p, 0.2, 10);
    assert.strictEqual(p.value, 0.2);
});

t('a louder reading takes the peak with it immediately', () => {
    const p = stepPeak({ value: 0.4, held: 0 }, 0.9, 0.1);
    assert.strictEqual(p.value, 0.9);
});

console.log(`\n${pass} needle checks passed`);

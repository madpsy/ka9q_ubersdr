// A trace that scrolls rather than steps.
//
// The properties worth pinning down are the ones a screenshot cannot show: that
// the segment crossing the left edge still has a point to be drawn from, that a
// single enormous gap in the series does not drag the whole picture behind
// live, and that a smoothed curve never puts ink outside the readings it joins
// — a buffer trace dipping below two equal samples has drawn a dropout that did
// not happen.

const assert = require('assert');
const { curveControl, drawLag, medianGap, trimBefore, xAt, SPAN_MS } = require('./.build/rollingchart.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const series = (...ts) => ts.map((t) => ({ t, v: 0 }));

// --- what is still in view ---------------------------------------------------

t('the point before the cutoff is kept, so the edge segment can be drawn', () => {
    const pts = series(0, 100, 200, 300);
    trimBefore(pts, 250);
    assert.deepStrictEqual(pts.map((p) => p.t), [200, 300]);
});

t('nothing is dropped while everything is still in view', () => {
    const pts = series(0, 100, 200);
    trimBefore(pts, 0);
    assert.strictEqual(pts.length, 3);
});

t('the last point is never trimmed away, however old it is', () => {
    const pts = series(0);
    trimBefore(pts, 10_000);
    assert.deepStrictEqual(pts.map((p) => p.t), [0]);
});

t('an empty series survives being trimmed', () => {
    const pts = [];
    trimBefore(pts, 500);
    assert.deepStrictEqual(pts, []);
});

// --- where a moment sits -----------------------------------------------------

t('now is the right-hand edge and a span ago is the left', () => {
    assert.strictEqual(xAt(1000, 1000, 1000, 300), 300);
    assert.strictEqual(xAt(0, 1000, 1000, 300), 0);
    assert.strictEqual(xAt(500, 1000, 1000, 300), 150);
});

t('a point older than the span is off the left, not clamped to it', () => {
    assert.ok(xAt(-1000, 1000, 1000, 300) < 0);
});

// --- how far behind live to draw ---------------------------------------------

t('one huge gap does not drag the picture behind live', () => {
    // Four ordinary tenths and one two-second stall, as a backgrounded tab
    // leaves behind.
    const pts = series(0, 100, 200, 2200, 2300, 2400);
    assert.strictEqual(medianGap(pts), 100);
    assert.strictEqual(drawLag(medianGap(pts)), 100);
});

t('the lag is bounded at both ends', () => {
    assert.strictEqual(drawLag(5), 60);       // a fast meter still gets a frame's grace
    assert.strictEqual(drawLag(4000), 250);   // a stalled one does not freeze the chart
    assert.strictEqual(drawLag(0), 100);      // nothing measured yet
});

t('a series too short to have a gap reports none', () => {
    assert.strictEqual(medianGap(series(0)), 0);
    assert.strictEqual(medianGap([]), 0);
});

// --- how a curve is bent -----------------------------------------------------

const bezierY = (y0, c1y, c2y, y1, s) => {
    const u = 1 - s;
    return u * u * u * y0 + 3 * u * u * s * c1y + 3 * u * s * s * c2y + s * s * s * y1;
};

t('a curve stays within the two readings it joins', () => {
    // A spike either side of a flat pair: unclamped Catmull-Rom dips under it.
    const prev = { x: 0, y: 100 };
    const a = { x: 10, y: 10 };
    const b = { x: 20, y: 10 };
    const next = { x: 30, y: 100 };
    const c = curveControl(prev, a, b, next);
    for (let s = 0; s <= 1.0001; s += 0.05) {
        const y = bezierY(a.y, c.c1y, c.c2y, b.y, s);
        assert.ok(y >= 10 - 1e-9 && y <= 10 + 1e-9, `overshot to ${y} at ${s}`);
    }
});

t('a rising pair curves without leaving its own range', () => {
    const c = curveControl({ x: 0, y: 50 }, { x: 10, y: 40 }, { x: 20, y: 20 }, { x: 30, y: 15 });
    for (let s = 0; s <= 1.0001; s += 0.05) {
        const y = bezierY(40, c.c1y, c.c2y, 20, s);
        assert.ok(y >= 20 - 1e-9 && y <= 40 + 1e-9, `left [20,40] at ${y}`);
    }
});

t('the ends of the series, where prev is a and next is b, are still smooth', () => {
    const a = { x: 0, y: 10 };
    const b = { x: 10, y: 30 };
    const c = curveControl(a, a, b, b);
    assert.ok(Number.isFinite(c.c1x) && Number.isFinite(c.c1y));
    assert.ok(c.c1y >= 10 && c.c1y <= 30);
});

t('the span is the ten seconds the trace has always shown', () => {
    assert.strictEqual(SPAN_MS, 10000);
});

console.log(`${pass} ok`);

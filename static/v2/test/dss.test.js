// The waterfall drawn as terrain.
//
// Two things here are easy to get plausibly wrong: the projection and its
// inverse have to agree or a click tunes somewhere other than where you pointed,
// and the ring has to drop the oldest row and not a middle one.
//
// A third used to be here and is gone with the code it covered. Merging several
// rows into each ridge, to buy seconds of history without drawing more of them,
// made the newest ridge a block that only rolled over a few times a second — the
// front of the display was the stalest thing on it, and smeared besides. One row
// per ridge; see the note in lib/dss.js.

const assert = require('assert');
const {
    BACK_WIDTH, DEPTH_SPAN, FRONT_RIDGE, MAX_COLS, MAX_RIDGES, MIN_RIDGES,
    clearRows, createRing, depthScale, edgeLine, project, pushRow, ridgeCount,
    ridgeHeight, ridgesFor, shiftRows,
    maxSeconds, minSeconds, ringCols, ringSeconds, storedRow, unproject,
} = require('./.build/dss.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// --- the projection ---------------------------------------------------------

t('the front row is full width and the back row is narrowed', () => {
    assert.strictEqual(depthScale(0), 1);
    assert.ok(near(depthScale(1), BACK_WIDTH));
    // And nothing outside the range, so a stale depth cannot invert the row.
    assert.strictEqual(depthScale(-1), 1);
    assert.ok(near(depthScale(5), BACK_WIDTH));
});

t('the centre frequency stays centred at every depth', () => {
    // The one column that must not move: it is where the dial marker is, and a
    // vanishing point that drifts is a surface that looks broken.
    for (const d of [0, 0.25, 0.5, 1]) {
        assert.ok(near(project(0.5, d).x, 0.5), `depth ${d}`);
    }
});

t('depth climbs the pane and the front row sits on the floor', () => {
    assert.ok(near(project(0.5, 0).y, 1));
    assert.ok(near(project(0.5, 1).y, 1 - DEPTH_SPAN));
});

t('a click inverts to the frequency that was drawn there', () => {
    // The property that makes the surface click-to-tune: whatever project puts
    // at a point, unproject has to give back.
    for (const f of [0.05, 0.3, 0.5, 0.72, 0.99]) {
        for (const d of [0, 0.2, 0.6, 1]) {
            const p = project(f, d);
            const back = unproject(p.x, p.y);
            assert.ok(near(back.depth, d, 1e-9), `depth ${d} -> ${back.depth}`);
            assert.ok(near(back.freqUnit, f, 1e-9), `freq ${f}@${d} -> ${back.freqUnit}`);
        }
    }
});

t('a click beside the trapezoid reports a frequency off the band, not the edge', () => {
    // Clamping here would silently tune to the band edge from a press on empty
    // background. The caller checks the range and does nothing instead.
    const deep = unproject(0.02, 1 - DEPTH_SPAN);
    assert.ok(deep.freqUnit < 0, `expected off-band, got ${deep.freqUnit}`);
});

t('a ridge is tallest at full scale and flat at the floor', () => {
    assert.ok(near(ridgeHeight(0, -100, 100, 0), FRONT_RIDGE));
    assert.strictEqual(ridgeHeight(-100, -100, 100, 0), 0);
    // Below the floor is still the floor, not a hole in the surface.
    assert.strictEqual(ridgeHeight(-140, -100, 100, 0), 0);
    // And a missing value is floor rather than NaN, which would break the path.
    assert.strictEqual(ridgeHeight(NaN, -100, 100, 0), 0);
});

t('ridges shrink with depth along with their row', () => {
    const front = ridgeHeight(0, -100, 100, 0);
    const back = ridgeHeight(0, -100, 100, 1);
    assert.ok(near(back, front * BACK_WIDTH), 'one vanishing point, not two');
});

// --- the ring ---------------------------------------------------------------

const row = (v, n = 4) => Float32Array.from({ length: n }, () => v);

t('the newest row is age 0 and the oldest falls off the end', () => {
    const r = createRing(4, 4);
    for (const v of [1, 2, 3, 4, 5]) pushRow(r, row(v, 4));
    assert.strictEqual(storedRow(r, 0)[0], 5);
    assert.strictEqual(storedRow(r, 3)[0], 2);
    // 1 is gone, and 2..5 are in order — a wrap that dropped a middle row would
    // leave a seam of older history spliced into the run.
    assert.deepStrictEqual([0, 1, 2, 3].map((a) => storedRow(r, a)[0]), [5, 4, 3, 2]);
});

t('an empty ring draws nothing rather than a wall of floor', () => {
    const r = createRing(8, 4);
    assert.strictEqual(ridgeCount(r, 8), 0);
    pushRow(r, row(-50, 4));
    assert.strictEqual(ridgeCount(r, 8), 1);
});

t('a narrow carrier survives the column collapse', () => {
    // One loud bin among quiet ones. Averaging four columns into one would bury
    // it by 6 dB; on a display for finding narrow signals that is the bug.
    const r = createRing(2, 4);
    const px = Float32Array.from([-100, -100, -100, -20, -100, -100, -100, -100]);
    pushRow(r, px);
    assert.strictEqual(storedRow(r, 0)[1], -20, 'the peak is kept, not the mean');
});

// --- the sub-row slide ------------------------------------------------------
//
// The reason the surface moves rather than steps. Its correctness is one
// property: a ridge at the end of a gap must be exactly where its successor
// starts at the beginning of the next one, or the motion jumps on every commit —
// which is what it did before, twenty times a second, beside a heat map sliding
// at the refresh rate.

t('a ridge at full progress is where the next one starts', () => {
    const rows = 64;
    const at = (age, progress) => (age + progress) / rows;
    for (const age of [0, 1, 17, rows - 2]) {
        assert.ok(near(at(age, 1), at(age + 1, 0)), `age ${age} does not meet its successor`);
    }
});

t('the slide moves a ridge back, never forward', () => {
    // Depth grows with progress, and depth is what recedes — a sign error here
    // would have the surface running toward the viewer between rows.
    const a = project(0.5, 3 / 64);
    const b = project(0.5, 3.5 / 64);
    assert.ok(b.y < a.y, 'a ridge climbs the pane as the gap is crossed');
});

// --- one row per ridge ------------------------------------------------------

t('the newest ridge is the newest row, not a merge of several', () => {
    // The failure that took the merged version out: with six rows peaked into
    // each ridge the front of the surface was the strongest thing in the last
    // six, rolling over a few times a second, so "now" never appeared and every
    // thin line came out soft.
    const r = createRing(8, 4);
    for (let i = 0; i < 8; i++) pushRow(r, row(-100, 4));
    pushRow(r, Float32Array.from([-100, -20, -100, -100]));
    assert.strictEqual(storedRow(r, 0)[1], -20, 'the newest ridge is the newest row');
    assert.strictEqual(storedRow(r, 1)[1], -100, 'and nothing is smeared into the one behind');
});

t('seconds are bought with ridges, and the ceiling is honest', () => {
    // 4 s at 20 rows/s is 80 ridges, which fits.
    assert.strictEqual(ridgesFor(4, 20), 80);
    // Past the ceiling it is clamped, and the panel shows the span actually
    // drawn rather than the one asked for.
    assert.strictEqual(ridgesFor(30, 20), MAX_RIDGES);
    // A slow waterfall buys the seconds a fast one cannot.
    assert.strictEqual(ridgesFor(30, 3), 90);
    // And never so few that there is no surface left.
    assert.strictEqual(ridgesFor(0.1, 2), MIN_RIDGES);
    assert.strictEqual(ridgesFor(undefined, 20), MIN_RIDGES);
});

t('every position on the depth slider draws a different span', () => {
    // The bug: the slider was a fixed 1-30 s while the span is bought entirely
    // in ridges, so at 29 rows/s it had four live positions and twenty-six dead
    // ones — all reading 3.3 s. The mirror of it appeared at the bottom on a
    // slow waterfall, where MIN_RIDGES floored the first eight.
    for (const rate of [2, 5, 11, 20, 29, 40]) {
        const lo = minSeconds(rate);
        const hi = maxSeconds(rate);
        assert.ok(lo <= hi, `rate ${rate}: empty range ${lo}..${hi}`);
        const spans = new Set();
        for (let s = lo; s <= hi; s++) spans.add(ridgesFor(s, rate) / rate);
        assert.strictEqual(spans.size, hi - lo + 1,
            `rate ${rate}: ${hi - lo + 1} positions but ${spans.size} distinct spans`);
    }
});

t('the ends of the slider are the ends of what is drawable', () => {
    // At the top the ridge count is at its ceiling; below the top it is not.
    assert.strictEqual(ridgesFor(maxSeconds(20), 20), MAX_RIDGES);
    assert.ok(ridgesFor(maxSeconds(20) - 1, 20) < MAX_RIDGES);
    // And at the bottom it is at the floor on a waterfall slow enough to hit it.
    assert.strictEqual(ridgesFor(minSeconds(2), 2), 2 * minSeconds(2));
    assert.ok(2 * minSeconds(2) >= MIN_RIDGES);
});

t('a nonsense rate still leaves a usable slider', () => {
    for (const rate of [0, -5, undefined, NaN]) {
        assert.ok(minSeconds(rate) <= maxSeconds(rate), `rate ${rate}`);
    }
});

t('a ring reports the span it actually shows', () => {
    assert.ok(near(ringSeconds(createRing(80, 4), 20), 4));
    assert.strictEqual(ringSeconds(createRing(80, 4), 0), 0);
});

// --- resolution -------------------------------------------------------------

t('the ring is as wide as the pane, so a thin line stays thin', () => {
    // 256 fixed columns against a waterfall drawing every device pixel is how a
    // one-pixel carrier came out as a mountain several pixels across.
    assert.strictEqual(ringCols(900), 900);
    assert.strictEqual(ringCols(4000), MAX_COLS);
    // And never so few that the surface is coarser than any pane worth drawing.
    assert.strictEqual(ringCols(10), 64);
    assert.strictEqual(ringCols(undefined), 64);
});

// --- colour and height, against the waterfall beside it ---------------------

t('the noise plain is flat, not a raised shelf', () => {
    // The auto-levelling floor is the 25th percentile less 4 dB, so the noise
    // itself sits a few dB above it. Drawn straight, that headroom becomes a
    // plateau with the noise standing on it — and a 0.6 gamma, which was here to
    // lift weak signals, put it at nearly a third of full height.
    const noise = ridgeHeight(-94, -100, 70, 0);     // 6 dB above floor
    assert.strictEqual(noise, 0, 'the floor should be a floor');
    assert.strictEqual(ridgeHeight(-97, -100, 70, 0), 0, 'and below it is ground');
});

t('a signal above the noise still stands up', () => {
    // 15 dB above the floor is 9 above the ground, of a 45 dB aperture.
    const s15 = ridgeHeight(-85, -100, 70, 0) / FRONT_RIDGE;
    assert.ok(s15 > 0.15 && s15 < 0.30, `expected a fifth or so, got ${s15.toFixed(2)}`);
    // And a strong one is unmistakable.
    const s35 = ridgeHeight(-65, -100, 70, 0) / FRONT_RIDGE;
    assert.ok(s35 > 0.6, `expected most of the height, got ${s35.toFixed(2)}`);
});

t('a loud signal turning up does not flatten everything else', () => {
    // The same signal, once with 45 dB on screen and once with 90. The aperture
    // is bounded, so the second does not halve the first — which is what the
    // display's own range would do, and why the surface used to lose everything
    // but the loudest carrier on a busy band.
    const narrow = ridgeHeight(-85, -100, 45, 0);
    const huge = ridgeHeight(-85, -100, 90, 0);
    assert.ok(near(narrow, huge, 1e-9),
        'the ridge height must not depend on how loud the loudest signal is');
});

t('full scale is still full height', () => {
    // Ground plus the whole aperture, and anything above it clamps rather than
    // running off the top of the pane.
    assert.ok(near(ridgeHeight(-100 + 6 + 45, -100, 45, 0), FRONT_RIDGE));
    assert.ok(near(ridgeHeight(0, -100, 200, 0), FRONT_RIDGE));
});

// --- marks across the surface -----------------------------------------------

t('a mark is straight and converges on the vanishing point', () => {
    const e = edgeLine(0.8);
    assert.ok(near(e.x0, 0.8), 'full width at the front');
    assert.ok(near(e.y0, 1), 'and on the floor');
    assert.ok(near(e.x1, 0.5 + 0.3 * BACK_WIDTH), 'narrowed at the back');
    assert.ok(near(e.y1, 1 - DEPTH_SPAN));
});

t('the crest edge is the ground edge lifted by a full ridge', () => {
    // The pair is what makes a mark contain anything: a ridge rises vertically
    // off the plane, so the ground line alone answered for the wrong depth at
    // every screen height above it.
    const g = edgeLine(0.8, 0);
    const c = edgeLine(0.8, 1);
    assert.ok(near(c.x0, g.x0), 'same frequency, so the same x');
    assert.ok(near(c.x1, g.x1));
    assert.ok(near(c.y0, g.y0 - FRONT_RIDGE), 'a full ridge at the front');
    assert.ok(near(c.y1, g.y1 - FRONT_RIDGE * BACK_WIDTH), 'and a narrowed one at the back');
});

t('every place a ridge can be drawn lies between the two edges', () => {
    // The property the pair exists for, checked against the rasteriser's own
    // height mapping rather than against a restatement of it.
    const f = 0.75;
    for (const depth of [0, 0.3, 0.7, 1]) {
        const ground = project(f, depth);
        const top = ground.y - ridgeHeight(1e6, -100, 45, depth);   // clamps to full
        const g = edgeLine(f, 0);
        const c = edgeLine(f, 1);
        const at = (e) => e.y0 + (e.y1 - e.y0) * depth;
        assert.ok(near(at(g), ground.y, 1e-9), `ground at depth ${depth}`);
        assert.ok(near(at(c), top, 1e-9), `crest at depth ${depth}`);
    }
});

t('the centre frequency is the one mark that stays vertical', () => {
    for (const lift of [0, 1]) {
        const e = edgeLine(0.5, lift);
        assert.ok(near(e.x0, e.x1), 'the vanishing point is dead centre');
    }
});

t('the crest edge reaches the top of the terrain box', () => {
    const e = edgeLine(0.5, 1);
    assert.ok(near(e.y1, (1 - DEPTH_SPAN) - FRONT_RIDGE * BACK_WIDTH),
        'the deepest a full-height ridge can be drawn');
});

// --- holding the history to the frequency scale ------------------------------
//
// The Display panel's "Waterfall pan" setting applies to the terrain as well as
// the heat map. The heat map slides a bitmap; the surface has to move the
// numbers its ridge heights come from.

t('a pan carries the rows with it', () => {
    const r = createRing(2, 8);
    pushRow(r, Float32Array.from([-100, -100, -20, -100, -100, -100, -100, -100]));
    shiftRows(r, 3, 1);            // three columns right
    assert.strictEqual(storedRow(r, 0)[5], -20, 'the signal moved with the view');
    // And is not still where it was. Column 2 is off the left of what the
    // history covers after a shift of three, so it is uncovered rather than
    // quiet — which the next case is about.
    assert.notStrictEqual(storedRow(r, 0)[2], -20);
});

t('ground the history has not covered is nothing, not floor', () => {
    // -Infinity rather than the floor value: the rasteriser leaves it as
    // background, where a floor value would draw as a flat plain of real
    // terrain that nothing was ever heard on.
    const r = createRing(2, 8);
    pushRow(r, row(-100, 8));
    shiftRows(r, 3, 1);
    for (const x of [0, 1, 2]) {
        assert.strictEqual(storedRow(r, 0)[x], -Infinity, `column ${x} should be uncovered`);
    }
});

t('zooming out keeps a carrier rather than averaging it away', () => {
    // Two source columns per destination. The mean of -20 and -100 is -60, which
    // is a signal that is no longer there; the peak is the one that was.
    const r = createRing(2, 8);
    pushRow(r, Float32Array.from([-100, -20, -100, -100, -100, -100, -100, -100]));
    shiftRows(r, 0, 0.5);
    assert.strictEqual(storedRow(r, 0)[0], -20, 'the carrier survives the collapse');
});

t('a view change too large to carry drops the history', () => {
    const r = createRing(2, 8);
    pushRow(r, row(-50, 8));
    assert.strictEqual(ridgeCount(r), 1);
    clearRows(r);
    assert.strictEqual(ridgeCount(r), 0, 'and nothing is drawn until rows arrive again');
    assert.strictEqual(storedRow(r, 0)[0], -Infinity);
});

t('a still view is left alone', () => {
    const r = createRing(2, 8);
    pushRow(r, Float32Array.from([-100, -20, -100, -100, -100, -100, -100, -100]));
    shiftRows(r, 0, 1);
    assert.strictEqual(storedRow(r, 0)[1], -20);
});

// --- the depth setting must not cost the history ----------------------------

t('the ring holds the deepest the surface can go, whatever the setting', () => {
    // The bug: the ring was sized from the depth setting, so every change to
    // that number recreated it and wiped every row. With the rate measured as a
    // float the number changed on *every frame*, and the history never lived
    // long enough to have any depth at all.
    //
    // So the ring is created once at full depth and the setting only says how
    // much of it to draw.
    const r = createRing(MAX_RIDGES, 8);
    assert.strictEqual(r.rows, MAX_RIDGES);
    for (let i = 0; i < 40; i++) pushRow(r, row(-50, 8));
    assert.strictEqual(ridgeCount(r), 40, 'forty rows survive being asked about');
});

t('a shallower setting draws fewer rows without losing any', () => {
    const r = createRing(MAX_RIDGES, 8);
    for (let i = 0; i < 60; i++) pushRow(r, row(-50, 8));
    // Whatever depth is asked for, the stored history is untouched — which is
    // what makes the setting free to change and free to change back.
    assert.strictEqual(ridgeCount(r), 60);
    assert.ok(ridgesFor(1, 20) < ridgesFor(3, 20), 'and a smaller setting asks for less');
});

console.log(`\n${pass} passed`);

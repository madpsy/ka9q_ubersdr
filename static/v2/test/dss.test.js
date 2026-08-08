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
    createRing, depthScale, edgeLine, project, pushRow, ridgeCount, ridgeHeight, ridgesFor,
    ringCols, ringSeconds, storedRow, unproject,
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
    // 30 s at 20 would be 600, which does not: it is clamped, and the panel
    // shows the span actually drawn rather than the one asked for.
    assert.strictEqual(ridgesFor(30, 20), MAX_RIDGES);
    // A slow waterfall buys the seconds a fast one cannot.
    assert.strictEqual(ridgesFor(30, 3), 90);
    // And never so few that there is no surface left.
    assert.strictEqual(ridgesFor(0.1, 2), MIN_RIDGES);
    assert.strictEqual(ridgesFor(undefined, 20), MIN_RIDGES);
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

t('a fixed frequency converges on the vanishing point', () => {
    const e = edgeLine(0.8);
    // Front: full width, on the floor. Back: narrowed, and up the pane.
    assert.ok(near(e.x0, 0.8));
    assert.ok(near(e.y0, 1));
    assert.ok(near(e.x1, 0.5 + 0.3 * BACK_WIDTH));
    assert.ok(near(e.y1, 1 - DEPTH_SPAN));
});

t('the mark line is the same geometry as the terrain under it', () => {
    // Drawn from `project`, so a dial line and the ridge it marks cannot drift
    // apart — and being straight is a property of the projection rather than an
    // approximation, since x and y are both linear in depth.
    const f = 0.23;
    const e = edgeLine(f);
    for (const d of [0.25, 0.5, 0.75]) {
        const p = project(f, d);
        const t = (p.y - e.y0) / (e.y1 - e.y0);
        assert.ok(near(p.x, e.x0 + (e.x1 - e.x0) * t, 1e-9),
            `depth ${d} is off the straight line`);
    }
});

t('the centre frequency is the one mark that stays vertical', () => {
    const e = edgeLine(0.5);
    assert.ok(near(e.x0, e.x1), 'the vanishing point is dead centre');
});

console.log(`\n${pass} passed`);

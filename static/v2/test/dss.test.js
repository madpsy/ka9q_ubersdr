// The waterfall drawn as terrain.
//
// Three things here are easy to get plausibly wrong: the projection and its
// inverse have to agree or a click tunes somewhere other than where you pointed;
// the ring has to drop the oldest row and not a middle one; and a half-minute
// surface has to be no blinder than a five-second one, which is what the peak
// aggregation is for.

const assert = require('assert');
const {
    BACK_WIDTH, COLS, DEPTH_SPAN, FRONT_RIDGE, MAX_STORE, ROWS,
    createRing, depthScale, project, pushRow, ridgeCount, ridgeHeight, ridgeInto,
    ridgePhase, ringSeconds, storeRows, storedRow, unproject,
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

const row = (v, n = COLS) => Float32Array.from({ length: n }, () => v);

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

// --- depth in seconds -------------------------------------------------------

t('seconds and rate decide how many rows are stored', () => {
    // Rounded to a whole number of stored rows per ridge: 15 s at 20 rows/s is
    // 300, which is 6.25 ridges' worth, and the quarter is what made the slide
    // creep out of step with its own data. 288 is six exactly.
    assert.strictEqual(storeRows(15, 20), 6 * ROWS);
    assert.strictEqual(storeRows(15, 20) % ROWS, 0);
    // Never fewer than one per drawn ridge, or the surface would repeat rows
    // rather than show more of them.
    assert.strictEqual(storeRows(1, 2), ROWS);
    // And bounded, so a slow speed and a long depth cannot run away.
    assert.ok(storeRows(120, 40) <= MAX_STORE);
    assert.strictEqual(storeRows(120, 40) % ROWS, 0);
});

t('the stride is always whole, so a ridge boundary lands on a stored row', () => {
    for (const secs of [5, 7, 13, 15, 23, 60, 120]) {
        for (const rate of [2, 7, 20, 33, 40]) {
            const n = storeRows(secs, rate);
            assert.strictEqual(n % ROWS, 0, `${secs}s at ${rate}/s gives ${n}`);
        }
    }
});

// --- the slide, measured in ridges ------------------------------------------

t('with one row per ridge the slide is the row gap', () => {
    const r = createRing(ROWS, 4);
    pushRow(r, row(-50, 4));
    assert.ok(near(ridgePhase(r, 0.4), 0.4));
});

t('with six rows per ridge, six pushes make one ridge of travel', () => {
    // The bug this exists for: the geometry used to advance a whole ridge per
    // push while the content advanced one row, so the surface outran its own
    // features and snapped back — "going back and forth".
    const r = createRing(ROWS * 6, 4);
    const seen = [];
    for (let i = 0; i < 6; i++) {
        seen.push(ridgePhase(r, 0));
        pushRow(r, row(-50, 4));
    }
    assert.deepStrictEqual(seen.map((v) => Math.round(v * 6)), [0, 1, 2, 3, 4, 5]);
    // And the sixth push brings it back to the start of the next ridge.
    assert.ok(near(ridgePhase(r, 0), 0));
});

t('the phase never runs backwards within a ridge', () => {
    const r = createRing(ROWS * 4, 4);
    let last = -1;
    for (let i = 0; i < 4; i++) {
        for (const p of [0, 0.25, 0.5, 0.75, 0.999]) {
            const v = ridgePhase(r, p);
            assert.ok(v >= last - 1e-9 || last > 0.9, `phase went back: ${last} -> ${v}`);
            last = v;
        }
        pushRow(r, row(-50, 4));
    }
});

t('a ring reports the span it actually holds', () => {
    assert.ok(near(ringSeconds(createRing(300, 4), 20), 15));
    assert.strictEqual(ringSeconds(createRing(300, 4), 0), 0);
});

t('a long depth is no blinder than a short one', () => {
    // Thirty stored rows per drawn ridge, and the signal is present in exactly
    // one of them. Taking every Nth row would lose it; taking the peak keeps it,
    // which is the whole point of aggregating rather than decimating.
    const rows = 96 * 3;
    const r = createRing(rows, 4);
    // Age counts back from the newest, so the burst is pushed fifth from last
    // to land at age 4 — inside ridge 1, which covers ages 3, 4 and 5.
    const burstAt = rows - 1 - 4;
    for (let i = 0; i < rows; i++) {
        pushRow(r, i === burstAt ? Float32Array.from([-100, -20, -100, -100])
            : Float32Array.from([-100, -100, -100, -100]));
    }
    const out = new Float32Array(4);
    ridgeInto(out, r, 1, 96);      // rows 3,4,5 back
    assert.strictEqual(out[1], -20, 'the burst survives the aggregation');
    ridgeInto(out, r, 0, 96);
    assert.strictEqual(out[1], -100, 'and it is not smeared into its neighbours');
});

t('one stored row per ridge is a straight copy', () => {
    const r = createRing(96, 4);
    for (let i = 0; i < 96; i++) pushRow(r, row(-i, 4));
    const out = new Float32Array(4);
    ridgeInto(out, r, 5, 96);
    assert.strictEqual(out[0], -90, 'age 5 back from the newest');
});

t('a part-filled ring draws only what it has', () => {
    // Three stored rows per ridge and ten rows in: three whole ridges, not ten.
    const r = createRing(96 * 3, 4);
    for (let i = 0; i < 10; i++) pushRow(r, row(-50, 4));
    assert.strictEqual(ridgeCount(r, 96), 3);
});

// --- the sub-row slide ------------------------------------------------------
//
// The reason the surface moves rather than steps. Its correctness is one
// property: a ridge at the end of a gap must be exactly where its successor
// starts at the beginning of the next one, or the motion jumps on every commit —
// which is what it did before, twenty times a second, beside a heat map sliding
// at the refresh rate.

t('a ridge at full progress is where the next one starts', () => {
    const at = (age, progress) => (age + progress) / ROWS;
    for (const age of [0, 1, 17, ROWS - 2]) {
        assert.ok(near(at(age, 1), at(age + 1, 0)), `age ${age} does not meet its successor`);
    }
});

t('the slide moves a ridge back, never forward', () => {
    // Depth grows with progress, and depth is what recedes — a sign error here
    // would have the surface running toward the viewer between rows.
    const a = project(0.5, (3 + 0) / ROWS);
    const b = project(0.5, (3 + 0.5) / ROWS);
    assert.ok(b.y < a.y, 'a ridge climbs the pane as the gap is crossed');
});

console.log(`\n${pass} passed`);

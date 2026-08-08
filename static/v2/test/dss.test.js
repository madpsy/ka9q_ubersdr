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
    ringSeconds, storeRows, storedRow, unproject,
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
    assert.strictEqual(storeRows(15, 20), 300);
    // Never fewer than one per drawn ridge, or the surface would repeat rows
    // rather than show more of them.
    assert.strictEqual(storeRows(1, 2), ROWS);
    // And bounded, so a slow speed and a long depth cannot run away.
    assert.strictEqual(storeRows(120, 40), MAX_STORE);
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

console.log(`\n${pass} passed`);

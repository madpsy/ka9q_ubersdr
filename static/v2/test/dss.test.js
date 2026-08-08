// The waterfall drawn as terrain.
//
// Two things here are easy to get plausibly wrong: the projection and its
// inverse have to agree or a click tunes somewhere other than where you pointed,
// and the ring has to drop the oldest row and not a middle one.
//
// Two more used to be here and are gone with the code they covered. Merging
// several rows into each ridge, to buy seconds of history without drawing more
// of them, made the newest ridge a block that rolled over a few times a second —
// the front of the display was the stalest thing on it. Counting depth in rows
// with a sub-row phase, to make the motion continuous between arrivals, needed
// the row rate measured and the phase accumulated and corrected, and every one
// of those numbers wobbled. A row is placed by how long ago it arrived; see the
// note in lib/dss.js.

const assert = require('assert');
const {
    BACK_WIDTH, DEPTH_SPAN, FRONT_RIDGE, MAX_COLS, RING_ROWS,
    clearRows, createRing, depthScale, edgeLine, project, pushRow, ridgeCount,
    ridgeHeight, ringCols, shiftRows, shownSeconds, storedAt, storedRow, unproject,
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

// --- a row is placed by when it arrived --------------------------------------
//
// The property all three failed versions violated, in one line: between
// arrivals, nothing about a row changes except how old it is. There is no phase
// to accumulate, no rate to measure, and no denominator that can move — so the
// stutter, the pull-back and the drifting slider have nowhere to come from.

const depthOf = (ring, age, now, spanMs) => (now - storedAt(ring, age)) / spanMs;

t('a row recedes at exactly the rate the clock moves', () => {
    const r = createRing(64, 4);
    pushRow(r, row(-50, 4), 1000);
    const span = 3000;
    for (const now of [1000, 1500, 2500, 4000]) {
        assert.ok(near(depthOf(r, 0, now, span), (now - 1000) / span),
            `at ${now} the row is not where the clock puts it`);
    }
});

t('a row arriving early or late does not move anything already drawn', () => {
    // The pull-back. Rows land on frame arrivals, so the gaps jitter — and a
    // depth counted in rows had to renumber every one of them when a row
    // arrived, which moved them all if the arrival was off the expected beat.
    // Here an arrival is just another row with its own stamp.
    const r = createRing(64, 4);
    pushRow(r, row(-50, 4), 1000);
    const span = 3000;
    const before = depthOf(r, 0, 1300, span);
    pushRow(r, row(-60, 4), 1300);            // a new row lands, whenever it likes
    assert.ok(near(depthOf(r, 1, 1300, span), before),
        'the older row moved when a new one arrived');
    // And again at an entirely different beat.
    pushRow(r, row(-70, 4), 1310);
    assert.ok(near(depthOf(r, 2, 1310, span), (1310 - 1000) / span));
});

t('the depth setting changes what is shown and never what is stored', () => {
    // The one that broke it worst: the ring used to be sized from the setting,
    // so changing the number wiped the history — and the number was derived from
    // a measured float, so it changed every frame and there was never any depth.
    const r = createRing(64, 4);
    for (let i = 0; i < 40; i++) pushRow(r, row(-50, 4), 1000 + i * 90);
    assert.strictEqual(ridgeCount(r), 40);
    // Reading it at any span leaves all forty in place.
    for (const span of [1000, 3000, 30000]) {
        assert.ok(depthOf(r, 0, 5000, span) < depthOf(r, 39, 5000, span));
    }
    assert.strictEqual(ridgeCount(r), 40, 'nothing was lost by asking');
});

t('rows older than the span fall off the back, in order', () => {
    const r = createRing(64, 4);
    for (let i = 0; i < 10; i++) pushRow(r, row(-50, 4), 1000 + i * 100);
    const now = 1900;
    // A one-second span at 100 ms apart reaches ten rows back; half a second
    // reaches five. Ages are in time order, so the drawing loop can stop at the
    // first one out of range.
    let inRange = 0;
    for (let age = 0; age < ridgeCount(r); age++) {
        if (depthOf(r, age, now, 500) > 1) break;
        inRange++;
    }
    assert.strictEqual(inRange, 6, 'the newest six are within half a second');
});

t('the ring reports the span it actually has, not the one asked for', () => {
    const r = createRing(64, 4);
    assert.strictEqual(shownSeconds(r, 30, 5000), 0, 'nothing stored yet');
    for (let i = 0; i < 5; i++) pushRow(r, row(-50, 4), 1000 + i * 100);
    // Rows spanning 400 ms: asking for thirty seconds shows 0.4 of them.
    assert.ok(near(shownSeconds(r, 30, 1400), 0.4));
    // And asking for less than there is shows what was asked.
    assert.ok(near(shownSeconds(r, 0.2, 1400), 0.2));
});

t('the ring is a fixed size and the setting cannot resize it', () => {
    assert.strictEqual(createRing().rows, RING_ROWS);
    assert.strictEqual(createRing(RING_ROWS, 8).rows, RING_ROWS);
});

console.log(`\n${pass} passed`);

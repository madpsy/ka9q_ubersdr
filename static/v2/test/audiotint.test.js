// The bar scope's background — energy as a proportion of the band.
//
// Two properties carry the whole feature and both are pinned hardest here:
// regions of equal energy get an identical colour, and a band whose energy is
// evenly spread is one flat colour rather than a rainbow of noise.

const assert = require('assert');
const {
    TINT_EVEN, TINT_SPAN_MAX_DB, TINT_SPAN_MIN_DB, TINT_ZONES,
    centreOf, easeZones, rankTint, smoothZones, spreadOf, tintColour, tintZones, zoneShares,
} = require('./.build/audiotint.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const BINS = 480;
// A band at `db`, with optional { from, to, db } regions laid over it.
const band = (db, regions = []) => {
    const a = new Float32Array(BINS).fill(db);
    for (const r of regions) for (let i = r.from; i < r.to; i++) a[i] = r.db;
    return a;
};
const shares = (bins, zones = TINT_ZONES) => zoneShares(bins, 0, BINS, new Float32Array(zones));
// What the drawing actually calls.
const tint = (bins, zones = TINT_ZONES) => tintZones({}, bins, 0, BINS, 0, zones);
const red = (c) => Number(c.match(/rgb\((\d+),/)[1]);
const blue = (c) => Number(c.match(/,(\d+)\)$/)[1]);
const EVEN = `rgb(${TINT_EVEN[0]},${TINT_EVEN[1]},${TINT_EVEN[2]})`;

// ── the flat case, which is the whole point ──────────────────────────────────

t('evenly spread audio is exactly zero everywhere', () => {
    const { rel } = shares(band(-40));
    for (const v of rel) assert.ok(Math.abs(v) < 1e-6, `${v}`);
});

t('...and therefore one colour, the balanced one', () => {
    const { pos, quiet } = tint(band(-40));
    for (const v of pos) assert.strictEqual(tintColour(v, quiet), EVEN);
});

t('volume does not change the picture — it is a share, not a level', () => {
    const quietBand = shares(band(-70)).rel;
    const loudBand = shares(band(-20)).rel;
    for (let i = 0; i < quietBand.length; i++) {
        assert.ok(Math.abs(quietBand[i] - loudBand[i]) < 1e-6);
    }
});

// ── same energy, same colour ─────────────────────────────────────────────────

t('two regions of equal energy get an identical colour, wherever they are', () => {
    const { pos, quiet } = tint(band(-75, [
        { from: 0, to: BINS / 8, db: -25 },
        { from: BINS - BINS / 8, to: BINS, db: -25 },
    ]));
    assert.strictEqual(tintColour(pos[0], quiet), tintColour(pos[pos.length - 1], quiet));
    assert.notStrictEqual(tintColour(pos[0], quiet), tintColour(pos[pos.length >> 1], quiet));
});

t('ties share a rank exactly, so equal zones are the same colour', () => {
    const rel = new Float32Array([-20, 5, 5, 5, 30]);
    const out = rankTint(rel, new Float32Array(5));
    assert.strictEqual(out[1], out[2]);
    assert.strictEqual(out[2], out[3]);
    assert.strictEqual(tintColour(out[1]), tintColour(out[3]));
});

t('more energy is always warmer — the mapping never doubles back', () => {
    const a = new Float32Array(BINS);
    const steps = 8;
    for (let i = 0; i < BINS; i++) a[i] = -80 + Math.floor((i / BINS) * steps) * 6;
    const { pos } = tint(a, steps);
    for (let i = 1; i < steps; i++) assert.ok(pos[i] > pos[i - 1], `step ${i}`);
});

t('a near-equal band stays near neutral rather than being amplified', () => {
    // Two decibels of drift is "roughly equal": the ranks still order it, but
    // the strength comes up with the spread, so it stays a flat background.
    const a = new Float32Array(BINS);
    for (let i = 0; i < BINS; i++) a[i] = -50 + (i / BINS) * 2;
    const { pos, quiet } = tint(a);
    for (const v of pos) assert.ok(Math.abs(v) < 0.25, `position ${v}`);
    for (const v of pos) assert.ok(Math.abs(red(tintColour(v, quiet)) - TINT_EVEN[0]) < 30);
});

// ── the complaint this was rewritten for ─────────────────────────────────────

t('a bimodal spectrum is a graduation, not two saturated ends', () => {
    // What audio really is: a busy region well above the analyser's floor, the
    // rest of the band near it with the ordinary ripple of a real floor.
    // Mapped by distance from a centre, every zone landed at one end or the
    // other — red and blue and little else.
    const a = new Float32Array(BINS);
    for (let i = 0; i < BINS; i++) a[i] = -100 + ((i * 37) % 11) * 0.7;
    for (let i = 40; i < 140; i++) a[i] = -30 - ((i * 13) % 17) * 0.5;
    const { pos, quiet } = tint(a);
    const cols = new Set(Array.from(pos, (v) => tintColour(v, quiet)));
    assert.ok(cols.size >= TINT_ZONES - 6, `only ${cols.size} of ${TINT_ZONES} distinct`);
    const mids = Array.from(pos).filter((v) => Math.abs(v) < 0.35);
    assert.ok(mids.length >= 4, `only ${mids.length} zones near neutral`);
});

t('a dead-flat floor beside a signal is one colour, not a gradient of noise', () => {
    // The other half of the same case, and the promise made everywhere here:
    // zones with identical energy share a rank exactly, so an idealised floor
    // gets one colour however many zones it spans.
    const a = new Float32Array(BINS).fill(-100);
    for (let i = 40; i < 140; i++) a[i] = -30;
    const { pos, quiet } = tint(a);
    const floorCols = new Set(Array.from(pos.slice(10), (v) => tintColour(v, quiet)));
    assert.strictEqual(floorCols.size, 1, 'the floor is one colour');
});

t('the typical part of the band keeps the middle of the ramp', () => {
    const a = new Float32Array(BINS).fill(-70);
    for (let i = 0; i < BINS / 8; i++) a[i] = -25;
    const { pos, quiet } = tint(a);
    assert.ok(red(tintColour(pos[0], quiet)) > TINT_EVEN[0] + 40, 'the voice is hot');
    const mids = Array.from(pos).filter((v) => Math.abs(v) < 0.5);
    assert.ok(mids.length >= 6, `only ${mids.length} zones in the middle`);
});

t('a sloped spectrum is graduated across the whole ramp', () => {
    const a = new Float32Array(BINS);
    for (let i = 0; i < BINS; i++) a[i] = -30 - 55 * (i / BINS) ** 1.4;
    const { pos, quiet } = tint(a);
    const cols = new Set(Array.from(pos, (v) => tintColour(v, quiet)));
    assert.ok(cols.size >= TINT_ZONES - 4, `only ${cols.size} of ${TINT_ZONES} distinct`);
    assert.ok(pos[0] > 0.8 && pos[pos.length - 1] < -0.8, 'the ends are the ends');
});

t('a bigger imbalance is the same picture, more strongly coloured', () => {
    // Ranks give the order and the spread gives the strength, so doubling the
    // tilt keeps every zone in its place on the ramp and pushes them further
    // along it. Order is what the display means; strength is how loudly it
    // says it.
    const tilt = (k) => {
        const a = new Float32Array(BINS);
        for (let i = 0; i < BINS; i++) a[i] = -60 + (i / BINS) * 12 * k;
        return tint(a);
    };
    const one = tilt(1);
    const two = tilt(2);
    for (let i = 1; i < one.pos.length; i++) {
        assert.ok(one.pos[i] > one.pos[i - 1], 'order holds at one');
        assert.ok(two.pos[i] > two.pos[i - 1], 'and at two');
    }
    assert.ok(Math.abs(two.pos[0]) > Math.abs(one.pos[0]), 'and it is stronger');
});

// ── hot and cold ─────────────────────────────────────────────────────────────

t('energy at the bottom reads hot low and cold high', () => {
    const { rel } = shares(band(-70, [{ from: 0, to: BINS / 6, db: -20 }]));
    assert.ok(rel[0] > 5, `low ${rel[0]}`);
    assert.ok(rel[rel.length - 1] < -5, `high ${rel[rel.length - 1]}`);
});

t('hiss at the top is the mirror of it', () => {
    const { rel } = shares(band(-70, [{ from: BINS - BINS / 6, to: BINS, db: -20 }]));
    assert.ok(rel[rel.length - 1] > 5);
    assert.ok(rel[0] < -5);
});

t('the shares are a proper decomposition — mean power is the reference', () => {
    const a = new Float32Array(BINS).fill(-200);
    for (let i = 0; i < BINS / TINT_ZONES; i++) a[i] = 0;
    const { rel } = shares(a);
    assert.ok(Math.abs(rel[0] - 10 * Math.log10(TINT_ZONES)) < 0.5, `${rel[0]}`);
});

t('cold is reachable — a genuine notch reads blue', () => {
    const a = band(-40, [{ from: BINS / 2, to: BINS / 2 + BINS / 12, db: -95 }]);
    const { pos, quiet } = tint(a);
    assert.ok(blue(tintColour(Math.min(...pos), quiet)) > TINT_EVEN[2] + 20);
});

t('colour runs cold below and hot above, and saturates', () => {
    const cold = tintColour(-1);
    const hot = tintColour(1);
    assert.ok(blue(cold) > blue(hot));
    assert.ok(red(hot) > red(cold));
    assert.strictEqual(tintColour(3), hot);
});

t('a moderate position is already visibly coloured', () => {
    const reach = (red(tintColour(0.5)) - TINT_EVEN[0]) / (red(tintColour(1)) - TINT_EVEN[0]);
    assert.ok(reach > 0.5, `only ${(reach * 100) | 0}% of the way`);
});

// ── the scale is the band's own spread ───────────────────────────────────────

t('a wide spread scales to itself', () => {
    const rel = new Float32Array([-30, -20, -10, 0, 10, 20, 30]);
    assert.ok(spreadOf(rel, new Float32Array(7)) > 25);
});

t('a narrow spread reports the floor, which is what damps the colours', () => {
    const rel = new Float32Array([-0.4, 0.2, -0.1, 0.3, 0.1, -0.2, 0]);
    assert.strictEqual(spreadOf(rel, new Float32Array(7)), TINT_SPAN_MIN_DB);
});

t('one freak notch cannot set the scale for everything else', () => {
    const rel = new Float32Array([-60, -2, -1, 0, 1, 2, 3]);
    const mid = centreOf(rel, new Float32Array(7));
    assert.ok(spreadOf(rel, new Float32Array(7), mid) < 20);
});

t('the scale is bounded at the top', () => {
    const huge = Float32Array.from({ length: 8 }, (_, i) => (i % 2 ? -90 : 90));
    const mid = centreOf(huge, new Float32Array(8));
    assert.strictEqual(spreadOf(huge, new Float32Array(8), mid), TINT_SPAN_MAX_DB);
});

t('the centre is the median zone, not the mean share', () => {
    const rel = new Float32Array([-8, -7, -6, -6, -5, -4, 30]);
    assert.strictEqual(centreOf(rel, new Float32Array(7)), -6);
});

// ── silence ──────────────────────────────────────────────────────────────────

t('a closed gate is flat, not colourful', () => {
    const a = new Float32Array(BINS);
    for (let i = 0; i < BINS; i++) a[i] = -120 + (i % 7);
    const { pos, quiet } = tint(a);
    assert.strictEqual(quiet, 0);
    for (const v of pos) assert.strictEqual(tintColour(v, quiet), EVEN);
});

t('audible audio is not faded', () => {
    assert.strictEqual(shares(band(-40)).quiet, 1);
});

t('a real spectrum is not mistaken for silence', () => {
    // The shape that broke this: a busy few hundred hertz over a band that is
    // otherwise near the analyser's floor. The mean of those bins is well under
    // any silence line while the audio is plainly audible, so the gate reads
    // the peak — see TINT_SILENCE_DB.
    assert.strictEqual(shares(band(-100, [{ from: 20, to: 90, db: -35 }])).quiet, 1);
});

t('the fade is gradual, not a switch', () => {
    const q = shares(band(-80)).quiet;
    assert.ok(q > 0 && q < 1, `${q}`);
    assert.ok(shares(band(-78)).quiet > q, 'and it is monotonic');
});

// ── smoothing and easing ─────────────────────────────────────────────────────

t('a single spiky zone is spread across its neighbours', () => {
    const v = new Float32Array([0, 0, 12, 0, 0]);
    smoothZones(v, new Float32Array(5));
    assert.ok(v[2] < 12 && v[2] > 4);
    assert.ok(v[1] > 0 && v[3] > 0);
    assert.strictEqual(v[0], 0);
});

t('smoothing conserves a flat run', () => {
    const v = new Float32Array([5, 5, 5, 5, 5]);
    smoothZones(v, new Float32Array(5));
    for (const x of v) assert.ok(Math.abs(x - 5) < 1e-6);
});

t('easing is frame-rate independent', () => {
    const one = { rel: new Float32Array([0]) };
    easeZones(one, new Float32Array([10]), 400, 400);
    const many = { rel: new Float32Array([0]) };
    for (let i = 0; i < 8; i++) easeZones(many, new Float32Array([10]), 50, 400);
    assert.ok(Math.abs(one.rel[0] - many.rel[0]) < 0.2);
});

t('the first frame is taken whole, not eased up from zero', () => {
    const out = easeZones({}, new Float32Array([7, -7]), 16);
    assert.strictEqual(out[0], 7);
    assert.strictEqual(out[1], -7);
});

t('a change of signal is eased, not snapped', () => {
    const st = {};
    const settled = tintZones(st, band(-70, [{ from: 0, to: BINS / 6, db: -20 }]), 0, BINS, 1000).rel[0];
    const next = tintZones(st, band(-70, [{ from: BINS - BINS / 6, to: BINS, db: -20 }]), 0, BINS, 1050);
    assert.ok(next.rel[0] < settled, 'moved');
    assert.ok(next.rel[0] > settled - 6, 'but not all the way');
});

t('a resize of the zone count starts again rather than mixing two grids', () => {
    const st = {};
    tintZones(st, band(-40), 0, BINS, 0, 8);
    assert.strictEqual(tintZones(st, band(-40), 0, BINS, 16, 16).pos.length, 16);
});

console.log(`\n${pass} passed`);

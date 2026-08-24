// The bar scope's background — energy as a proportion of the band.
//
// The property worth pinning hardest is the one that makes it readable: evenly
// spread audio must come out one flat colour, whatever its volume. Everything
// else is a deviation from that.

const assert = require('assert');
const {
    TINT_EVEN, TINT_SPAN_DB, TINT_ZONES,
    easeZones, smoothZones, tintColour, tintZones, zoneShares,
} = require('./.build/audiotint.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const BINS = 480;
// A band of `db`, with optional { from, to, db } regions laid over it.
const band = (db, regions = []) => {
    const a = new Float32Array(BINS).fill(db);
    for (const r of regions) for (let i = r.from; i < r.to; i++) a[i] = r.db;
    return a;
};
const shares = (bins, zones = TINT_ZONES) => {
    const out = new Float32Array(zones);
    return zoneShares(bins, 0, BINS, out);
};

// ── the flat case, which is the whole point ──────────────────────────────────

t('evenly spread audio is exactly zero everywhere', () => {
    const { rel } = shares(band(-40));
    for (const v of rel) assert.ok(Math.abs(v) < 1e-6, `${v}`);
});

t('...and therefore one colour, the balanced one', () => {
    const { rel, quiet } = shares(band(-40));
    const first = tintColour(rel[0], quiet);
    for (const v of rel) assert.strictEqual(tintColour(v, quiet), first);
    assert.strictEqual(first, `rgb(${TINT_EVEN[0]},${TINT_EVEN[1]},${TINT_EVEN[2]})`);
});

t('volume does not change the picture — it is a share, not a level', () => {
    const quietBand = shares(band(-70)).rel;
    const loudBand = shares(band(-20)).rel;
    for (let i = 0; i < quietBand.length; i++) {
        assert.ok(Math.abs(quietBand[i] - loudBand[i]) < 1e-6);
    }
});

t('a tilt in level is a tilt in share, at any volume', () => {
    // The same 20 dB tilt, 40 dB apart in absolute level.
    const tilt = (base) => {
        const a = new Float32Array(BINS);
        for (let i = 0; i < BINS; i++) a[i] = base + (i / BINS) * 20;
        return shares(a).rel;
    };
    const lo = tilt(-70);
    const hi = tilt(-30);
    for (let i = 0; i < lo.length; i++) assert.ok(Math.abs(lo[i] - hi[i]) < 1e-6);
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

t('the shares are a proper decomposition — the mean power is the reference', () => {
    // One zone holding all the energy is 10log10(zones) above even.
    const a = new Float32Array(BINS).fill(-200);
    for (let i = 0; i < BINS / TINT_ZONES; i++) a[i] = 0;
    const { rel } = shares(a);
    assert.ok(Math.abs(rel[0] - 10 * Math.log10(TINT_ZONES)) < 0.5, `${rel[0]}`);
});

t('colour runs cold below and hot above, and saturates', () => {
    const cold = tintColour(-TINT_SPAN_DB);
    const hot = tintColour(TINT_SPAN_DB);
    const blueOf = (s) => Number(s.match(/,(\d+)\)$/)[1]);
    const redOf = (s) => Number(s.match(/rgb\((\d+),/)[1]);
    assert.ok(blueOf(cold) > blueOf(hot));
    assert.ok(redOf(hot) > redOf(cold));
    // Past the span it does not keep going.
    assert.strictEqual(tintColour(TINT_SPAN_DB * 3), hot);
});

// ── silence ──────────────────────────────────────────────────────────────────

t('a closed gate is flat, not colourful', () => {
    // Dither: random, and a hundred dB down. Its shares are meaningless.
    const a = new Float32Array(BINS);
    for (let i = 0; i < BINS; i++) a[i] = -120 + (i % 7);
    const { rel, quiet } = shares(a);
    assert.strictEqual(quiet, 0);
    const flat = tintColour(rel[0], quiet);
    for (const v of rel) assert.strictEqual(tintColour(v, quiet), flat);
});

t('audible audio is not faded', () => {
    assert.strictEqual(shares(band(-40)).quiet, 1);
});

t('the fade is gradual, not a switch', () => {
    // Between the silence line and TINT_FADE_DB above it the tint washes out
    // rather than snapping off, so a gate closing is not a visible event.
    const q = shares(band(-80)).quiet;
    assert.ok(q > 0 && q < 1, `${q}`);
    assert.ok(shares(band(-78)).quiet > q, 'and it is monotonic');
});

// ── smoothing ────────────────────────────────────────────────────────────────

t('a single spiky zone is spread across its neighbours', () => {
    const v = new Float32Array([0, 0, 12, 0, 0]);
    smoothZones(v, new Float32Array(5));
    assert.ok(v[2] < 12 && v[2] > 4);
    assert.ok(v[1] > 0 && v[3] > 0);
    // ...and nothing is invented at the far ends.
    assert.strictEqual(v[0], 0);
});

t('smoothing conserves the middle of a flat run', () => {
    const v = new Float32Array([5, 5, 5, 5, 5]);
    smoothZones(v, new Float32Array(5));
    for (const x of v) assert.ok(Math.abs(x - 5) < 1e-6);
});

t('easing is frame-rate independent', () => {
    // One 400 ms step and eight 50 ms ones land in the same place.
    const one = { rel: new Float32Array([0]) };
    easeZones(one, new Float32Array([10]), 400, 400);
    const many = { rel: new Float32Array([0]) };
    for (let i = 0; i < 8; i++) easeZones(many, new Float32Array([10]), 50, 400);
    assert.ok(Math.abs(one.rel[0] - many.rel[0]) < 0.2, `${one.rel[0]} vs ${many.rel[0]}`);
});

t('the first frame is taken whole, not eased up from zero', () => {
    const st = {};
    const out = easeZones(st, new Float32Array([7, -7]), 16);
    assert.strictEqual(out[0], 7);
    assert.strictEqual(out[1], -7);
});

// ── the one call the drawing makes ───────────────────────────────────────────

t('tintZones eases toward the answer over successive frames', () => {
    const st = {};
    const hot = band(-70, [{ from: 0, to: BINS / 6, db: -20 }]);
    const first = tintZones(st, hot, 0, BINS, 1000);
    const settled = first.rel[0];
    // Now flip the energy to the top and watch the low zone cool, but not
    // instantly: a syllable must not repaint the panel.
    const other = band(-70, [{ from: BINS - BINS / 6, to: BINS, db: -20 }]);
    const next = tintZones(st, other, 0, BINS, 1050);
    assert.ok(next.rel[0] < settled, 'moved');
    assert.ok(next.rel[0] > settled - 6, 'but not all the way');
});

t('a resize of the zone count starts again rather than mixing two grids', () => {
    const st = {};
    tintZones(st, band(-40), 0, BINS, 0, 8);
    const a = tintZones(st, band(-40), 0, BINS, 16, 16);
    assert.strictEqual(a.rel.length, 16);
});

console.log(`\n${pass} passed`);

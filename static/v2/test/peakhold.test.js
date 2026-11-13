// Peak hold kept on the frequency axis through pans, zooms and resizes.
//
// The held line is per pixel, so every view change has to move it. These pin
// where a held carrier lands afterwards: the same frequency, not the same pixel.

const assert = require('assert');
const ph = require('./.build/peakhold.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); pass++; } catch (e) { console.error(`FAIL ${name}`); throw e; }
};

const W = 100;
// A hold over 0..1000 Hz (centre 500, span 1000): 10 Hz per pixel.
const holdWith = (marks) => {
    const peak = new Float32Array(W).fill(ph.PEAK_EMPTY);
    for (const [x, v] of marks) peak[x] = v;
    return { peak, centre: 500, span: 1000, scratch: null };
};
const argmax = (a) => a.reduce((b, v, i) => (v > a[b] ? i : b), 0);

t('first view is recorded, nothing moves', () => {
    const h = { peak: new Float32Array(W).fill(-50), centre: 0, span: 0 };
    ph.alignPeakHold(h, { centre: 500, span: 1000 });
    assert.strictEqual(h.centre, 500);
    assert.strictEqual(h.span, 1000);
    assert.ok(h.peak.every((v) => v === -50));
});

t('pan right: the carrier moves left by the pan', () => {
    const h = holdWith([[40, -20]]);          // 405 Hz
    ph.alignPeakHold(h, { centre: 600, span: 1000 });
    assert.strictEqual(argmax(h.peak), 30);
    assert.strictEqual(h.peak[30], -20);
    // Ground the hold never saw is empty, not a copy of something.
    for (let x = 90; x < W; x++) assert.strictEqual(h.peak[x], ph.PEAK_EMPTY);
});

t('sub-pixel pans accumulate rather than vanish', () => {
    const h = holdWith([[40, -20]]);
    for (let i = 0; i < 10; i++) ph.alignPeakHold(h, { centre: 500 + (i + 1) * 3, span: 1000 });
    // 30 Hz is three pixels.
    assert.strictEqual(argmax(h.peak), 37);
});

t('zoom out 2x about the centre: the carrier keeps its frequency', () => {
    const h = holdWith([[40, -20]]);          // 400..410 Hz
    ph.alignPeakHold(h, { centre: 500, span: 2000 });   // now 20 Hz per pixel, starts at -500
    assert.strictEqual(argmax(h.peak), 45);   // (405 + 500) / 20
    assert.strictEqual(h.peak[45], -20);
});

t('zoom out keeps a one-pixel carrier at full height', () => {
    const h = holdWith([[41, -20]]);
    ph.alignPeakHold(h, { centre: 500, span: 4000 });
    assert.strictEqual(Math.max(...h.peak), -20);
});

t('zoom in 2x: the carrier widens, still at its frequency', () => {
    const h = holdWith([[40, -20]]);          // 400..410 Hz
    ph.alignPeakHold(h, { centre: 500, span: 500 });    // 5 Hz per pixel from 250
    assert.strictEqual(h.peak[30], -20);      // 400..405
    assert.strictEqual(h.peak[31], -20);      // 405..410
    assert.strictEqual(h.peak[29], ph.PEAK_EMPTY);
    assert.strictEqual(h.peak[32], ph.PEAK_EMPTY);
});

t('a band change with no overlap clears it', () => {
    const h = holdWith([[40, -20]]);
    ph.alignPeakHold(h, { centre: 50000, span: 1000 });
    assert.ok(h.peak.every((v) => v === ph.PEAK_EMPTY));
});

t('zoom out then back in returns the carrier to its pixel', () => {
    const h = holdWith([[40, -20]]);
    ph.alignPeakHold(h, { centre: 500, span: 2000 });
    ph.alignPeakHold(h, { centre: 500, span: 1000 });
    assert.strictEqual(h.peak[40], -20);
});

t('resize: same frequencies across a different pixel count', () => {
    const src = new Float32Array(W).fill(ph.PEAK_EMPTY);
    src[40] = -20;
    const out = ph.resamplePeak(src, 0, 2, 200);
    assert.strictEqual(out[80], -20);
    assert.strictEqual(out[81], -20);
    const back = ph.resamplePeak(out, 0, 0.5, W);
    assert.strictEqual(back[40], -20);
});

console.log(`peakhold: ${pass} passed`);

// Spectrum zoom geometry.
//
// The two callers want different things and the difference is invisible until
// you are panned away from the dial, so both are pinned here.

const assert = require('assert');
const { clampCenter, zoomCenter } = require('./.build/zoom.cjs');
const { MAX_FREQ, MIN_FREQ } = require('./.build/constants.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// A 1 MHz view centred on 10 MHz: 1024 bins at 976.5625 Hz each.
const BINS = 1024;
const view = (centerFreq, spanHz) => ({ centerFreq, span: spanHz, binCount: BINS });
const binBW = (spanHz) => spanHz / BINS;

const HALF = 500e3;
const V = view(10e6, 1e6);

// --- toolbar buttons: no anchor, so centre on the dial ----------------------

t('a button zoom centres on the tuned frequency, not the view centre', () => {
    // Dial well off to one side of a view that is not following it.
    assert.strictEqual(zoomCenter(V, binBW(500e3), null, 9.8e6), 9.8e6);
    assert.strictEqual(zoomCenter(V, binBW(2e6), null, 9.8e6), 9.8e6);
});

t('a button zoom brings an off-screen dial into view in one step', () => {
    // 12 MHz is outside the 9.5–10.5 MHz view entirely.
    const center = zoomCenter(V, binBW(500e3), null, 12e6);
    assert.strictEqual(center, 12e6);
    // ...and the dial is inside the new span, which is the whole point: the
    // old "hold the view centre" behaviour left it off screen for ever.
    assert.ok(Math.abs(12e6 - center) < 250e3, 'dial must land inside the new span');
});

t('zooming about the dial repeatedly is a fixed point', () => {
    let c = 10e6;
    for (let span = 1e6; span > 10e3; span /= 2) {
        c = zoomCenter(view(c, span), binBW(span / 2), null, 10e6);
        assert.strictEqual(c, 10e6);
    }
});

// --- wheel: anchored to the pointer ----------------------------------------

t('a wheel zoom holds the frequency under the pointer in place', () => {
    // Pointer at 10.25 MHz — a quarter-span right of centre, so 3/4 across.
    const about = 10.25e6;
    const newSpan = 500e3;
    const center = zoomCenter(V, binBW(newSpan), about, 7.1e6);

    // Same fractional position across the new span as across the old one.
    const before = (about - (V.centerFreq - HALF)) / V.span;
    const after = (about - (center - newSpan / 2)) / newSpan;
    assert.ok(Math.abs(before - after) < 1e-9, `${before} vs ${after}`);
});

t('the wheel ignores the dial entirely', () => {
    const a = zoomCenter(V, binBW(500e3), 10.25e6, 7.1e6);
    const b = zoomCenter(V, binBW(500e3), 10.25e6, 29e6);
    assert.strictEqual(a, b);
});

t('a wheel zoom about the exact centre does not move the view', () => {
    assert.strictEqual(zoomCenter(V, binBW(500e3), 10e6, 7.1e6), 10e6);
});

// --- band edges -------------------------------------------------------------

t('a span is never allowed off the bottom of the band', () => {
    const span = 1e6;
    assert.strictEqual(clampCenter(0, span), span / 2);
    assert.strictEqual(clampCenter(MIN_FREQ, span), span / 2);
    // Tuning near the bottom pins the view, rather than showing negative Hz.
    assert.strictEqual(zoomCenter(view(1e6, 2e6), binBW(span), null, 20e3), span / 2);
});

t('a span is never allowed off the top of the band', () => {
    const span = 1e6;
    assert.strictEqual(clampCenter(MAX_FREQ, span), MAX_FREQ - span / 2);
    assert.strictEqual(zoomCenter(view(29e6, 2e6), binBW(span), null, 29.9e6), MAX_FREQ - span / 2);
});

t('a span wider than the band collapses to a single valid centre', () => {
    const span = 2 * MAX_FREQ;
    // lo wins over hi, so the result is the low clamp rather than NaN or a
    // reversed range.
    assert.strictEqual(clampCenter(15e6, span), span / 2);
});

// --- degenerate input -------------------------------------------------------

t('a zero-width current span falls back to holding the view centre', () => {
    // Before the first frame arrives `span` is 0, and the ratio would be
    // Infinity — the anchored branch must not be taken.
    assert.strictEqual(zoomCenter(view(10e6, 0), binBW(1e6), 10.25e6, 7.1e6), 10e6);
});

if (process.exitCode) console.log('\nzoom tests FAILED');
else console.log(`\nall ${pass} zoom tests passed`);

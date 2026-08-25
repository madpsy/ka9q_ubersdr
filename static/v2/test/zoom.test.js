// Spectrum zoom geometry.
//
// The two callers want different things and the difference is invisible until
// you are panned away from the dial, so both are pinned here.

const assert = require('assert');
const {
    BIN_BW_LADDER, BIN_BW_PASSTHROUGH, clampCenter, needsRecenter, resumeView, rungOfSpan,
    spanAtRung, zoomCenter, zoomLadder,
} = require('./.build/zoom.cjs');
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

// --- following the dial: the passband is what must stay on screen -----------
//
// A symmetric threshold cannot express this, and the old one (35% of the span,
// whichever way you were going) made the outer 15% of the spectrum unclickable
// on the side the filter does not occupy.

// A 100 kHz view centred on 14.100 MHz: edges at 14.050 and 14.150.
const FOLLOW = { center: 14.1e6, span: 100e3 };
const LO = FOLLOW.center - FOLLOW.span / 2;   // 14.050 MHz
const HI = FOLLOW.center + FOLLOW.span / 2;   // 14.150 MHz
const at = (frequency, mode) => ({ frequency, ...mode });
const USB = { bandwidthLow: 50, bandwidthHigh: 2700 };
const LSB = { bandwidthLow: -2700, bandwidthHigh: -50 };
const AM = { bandwidthLow: -5000, bandwidthHigh: 5000 };

t('USB can be tuned hard against the left edge, because the filter opens right', () => {
    // The passband runs from +50 to +2700 of the dial, so at the left edge it
    // is entirely on screen and there is nothing to move for.
    assert.strictEqual(needsRecenter(at(LO, USB), FOLLOW.center, FOLLOW.span), false);
    assert.strictEqual(needsRecenter(at(LO + 1, USB), FOLLOW.center, FOLLOW.span), false);
});

t('USB stops 2.7 kHz short of the right edge, where the filter would run off', () => {
    // The last frequency whose passband still ends on the edge.
    assert.strictEqual(needsRecenter(at(HI - 2700, USB), FOLLOW.center, FOLLOW.span), false);
    // One hertz further out and 1 Hz of it is off screen.
    assert.strictEqual(needsRecenter(at(HI - 2699, USB), FOLLOW.center, FOLLOW.span), true);
});

t('LSB is the mirror image of USB', () => {
    // Hard against the right edge is fine; it is the left that needs the room.
    assert.strictEqual(needsRecenter(at(HI, LSB), FOLLOW.center, FOLLOW.span), false);
    assert.strictEqual(needsRecenter(at(LO + 2700, LSB), FOLLOW.center, FOLLOW.span), false);
    assert.strictEqual(needsRecenter(at(LO + 2699, LSB), FOLLOW.center, FOLLOW.span), true);
});

t('AM needs the same room at both edges, because its filter is symmetric', () => {
    assert.strictEqual(needsRecenter(at(LO + 5000, AM), FOLLOW.center, FOLLOW.span), false);
    assert.strictEqual(needsRecenter(at(HI - 5000, AM), FOLLOW.center, FOLLOW.span), false);
    assert.strictEqual(needsRecenter(at(LO + 4999, AM), FOLLOW.center, FOLLOW.span), true);
    assert.strictEqual(needsRecenter(at(HI - 4999, AM), FOLLOW.center, FOLLOW.span), true);
});

t('the middle of the view never moves it, whatever the mode', () => {
    for (const mode of [USB, LSB, AM]) {
        assert.strictEqual(needsRecenter(at(FOLLOW.center, mode), FOLLOW.center, FOLLOW.span), false);
    }
});

t('a filter wider than the span falls back to keeping the dial visible', () => {
    // FM at 16 kHz on a 10 kHz view can never fit, and demanding it would move
    // the view on every single tune.
    const FM = { bandwidthLow: -8000, bandwidthHigh: 8000 };
    const span = 10e3;
    const centre = 14.1e6;
    assert.strictEqual(needsRecenter(at(centre, FM), centre, span), false);
    assert.strictEqual(needsRecenter(at(centre + 4999, FM), centre, span), false, 'dial still on screen');
    assert.strictEqual(needsRecenter(at(centre + 5001, FM), centre, span), true, 'dial off screen');
});

t('no span yet means nothing to be outside of', () => {
    // Before the spectrum has connected there is no view to move.
    assert.strictEqual(needsRecenter(at(14.1e6, USB), 0, 0), false);
});

// --- resuming the view a reload came back to -------------------------------

// 200 kHz wide, centred on 14.1 MHz.
const SAVED = { spectrumCenter: 14.1e6, spectrumBinBandwidth: 100, spectrumSpan: 200e3 };

t('nothing saved asks for nothing, so the server picks the default', () => {
    assert.deepStrictEqual(resumeView({}, at(14.1e6, USB)), {});
    assert.deepStrictEqual(resumeView({ spectrumCenter: 14.1e6 }, at(14.1e6, USB)), {},
        'a centre with no zoom would land on the full-span default');
    assert.deepStrictEqual(resumeView({ spectrumBinBandwidth: 100 }, at(14.1e6, USB)), {});
});

t('a saved view is resumed whole when the dial is inside it', () => {
    assert.deepStrictEqual(resumeView(SAVED, at(14.1e6, USB)),
        { frequency: 14.1e6, binBandwidth: 100 });
    assert.deepStrictEqual(resumeView(SAVED, at(14.19e6, USB)),
        { frequency: 14.1e6, binBandwidth: 100 }, 'off centre but still on screen');
});

t('a dial outside the saved view keeps the zoom and centres on the dial', () => {
    // What a shared ?freq= link does to someone whose saved view is elsewhere:
    // 20 m on screen, the dial on 40 m, and nothing to explain it.
    assert.deepStrictEqual(resumeView(SAVED, at(7.1e6, USB)),
        { frequency: 7.1e6, binBandwidth: 100 });
});

t('the same rule as the auto-recentre, passband included', () => {
    // The dial itself is inside the view, but its passband is not — and that
    // is the case needsRecenter exists for, so resuming must agree with it.
    const edge = 14.1e6 + 100e3 - 1000;   // 1 kHz inside the right edge
    assert.strictEqual(needsRecenter(at(edge, USB), 14.1e6, 200e3), true);
    assert.strictEqual(resumeView(SAVED, at(edge, USB)).frequency, edge,
        'resumed a view the passband hangs out of');
});

t('a saved zoom with no span is trusted for the zoom but not the centre', () => {
    // Written by a build before the span was stored. The zoom is still good;
    // whether the dial is inside it cannot be known, so the dial wins.
    const old = { spectrumCenter: 14.1e6, spectrumBinBandwidth: 100 };
    assert.deepStrictEqual(resumeView(old, at(14.1e6, USB)),
        { frequency: 14.1e6, binBandwidth: 100 });
});

// --- the ladder, as the Multipad's zoom barrel reads it ---------------------

// A stock receiver: 1024 bins over 0-30 MHz, so 29296.875 Hz/bin at full span,
// and v2's 2.048 kHz floor — 2 Hz/bin over those bins.
const LADDER_BINS = 1024;
const FULL_BW = 30e6 / LADDER_BINS;
const FLOOR_BW = 2;
const L = zoomLadder(FULL_BW, LADDER_BINS, FLOOR_BW);

// What repeated zoomIn actually produces, worked through the server's snapping
// (user_spectrum_websocket.go). This is the list the drum has to draw: get it
// wrong and a detent either does nothing or is missing.
const REACHABLE = [30e6, 15e6, 5.12e6, 2.048e6, 1.024e6, 512e3, 307.2e3, 204.8e3, 102.4e3, 51.2e3,
    20.48e3, 10.24e3, 5.12e3, 2.048e3];

t('the ladder is the spans the server actually serves', () => {
    assert.deepStrictEqual(L.map((s) => Math.round(s)), REACHABLE.map((s) => Math.round(s)));
});

t('the ladder reaches the floor, not half a rung above it', () => {
    // The regression this exists for: the floor is 11.5 doublings below full
    // span, so a powers-of-two ladder floored to 11 stopped at 14.6 kHz — one
    // detent short of where the zoom buttons and a pinch both stop.
    assert.strictEqual(L[L.length - 1], FLOOR_BW * LADDER_BINS);
    assert.strictEqual(L.length, 14);
});

t('every rung round-trips', () => {
    for (let k = 0; k < L.length; k++) {
        assert.strictEqual(rungOfSpan(spanAtRung(k, L), L), k, `rung ${k}`);
    }
});

t('a span the server rounded lands on the rung it meant', () => {
    // The confirmed span is exact for every rung on this receiver, but a view
    // set from elsewhere — a band button asking for 350 kHz — is not.
    assert.strictEqual(rungOfSpan(350e3, L), 6);        // snapped to 307.2 kHz
    assert.strictEqual(rungOfSpan(20.48e3 * 1.04, L), 10);
    assert.strictEqual(rungOfSpan(20.48e3 * 0.96, L), 10);
});

t('nearest is measured as a ratio, not a difference', () => {
    // 15 kHz lies between the 20.48 and 10.24 kHz rungs. By difference it is
    // nearer the lower one (4.8 kHz against 5.5); by ratio — which is how a
    // geometric ladder is read, and how it looks on a screen where each rung is
    // one detent — it is nearer the upper. The boundary is the geometric mean.
    assert.strictEqual(rungOfSpan(15e3, L), 10);
    assert.strictEqual(rungOfSpan(Math.sqrt(20.48e3 * 10.24e3) * 0.99, L), 11);
    // Same rule at the wide end, where the rungs are megahertz apart.
    assert.strictEqual(rungOfSpan(12e6, L), 1);
    assert.strictEqual(rungOfSpan(8e6, L), 2, 'past the geometric mean of 8.76 MHz');
});

t('neither end runs off the ladder', () => {
    // Zoomed out past the default — which the reset path can produce — is rung
    // 0, not a negative one that would draw detents off the top.
    assert.strictEqual(rungOfSpan(FULL_BW * LADDER_BINS * 4, L), 0);
    assert.strictEqual(spanAtRung(-3, L), L[0]);
    assert.strictEqual(spanAtRung(99, L), L[L.length - 1]);
});

t('the wide end halves and the narrow end is the server\'s list', () => {
    // Above the passthrough the server takes what it is given, so those rungs
    // are exact halvings; below it, only the listed bandwidths exist.
    assert.strictEqual(L[1], L[0] / 2);
    assert.ok(L[1] / LADDER_BINS > BIN_BW_PASSTHROUGH);
    for (const span of L.slice(2)) {
        assert.ok(BIN_BW_LADDER.includes(span / LADDER_BINS), `${span / LADDER_BINS} Hz/bin is not on the server ladder`);
    }
});

t('a coarser receiver gets a shallower ladder, still reaching its own floor', () => {
    // 512 bins: the floor works out at 4 Hz/bin, and the nearest rung at or
    // above it on the server's ladder is 5 — so this receiver stops at 2.56 kHz
    // and the 1024-bin ladder's last rungs simply do not exist here.
    const l512 = zoomLadder(30e6 / 512, 512, Math.max(0.5, 2048 / 512));
    assert.strictEqual(l512[0], 30e6);
    assert.strictEqual(l512[l512.length - 1], 2560);
    assert.ok(l512.every((s, i) => i === 0 || s < l512[i - 1]), 'must descend');
});

t('a receiver already at its floor still has one rung', () => {
    const one = zoomLadder(10, 1024, 10);
    assert.deepStrictEqual(one, [10240]);
});

t('an unconnected spectrum has no ladder rather than a NaN one', () => {
    // The defaults are all zero until the first config message.
    assert.deepStrictEqual(zoomLadder(0, 0, 10), []);
    assert.strictEqual(rungOfSpan(1e6, []), 0);
    assert.strictEqual(spanAtRung(0, []), 0);
    assert.strictEqual(rungOfSpan(0, L), 0);
});

if (process.exitCode) console.log('\nzoom tests FAILED');
else console.log(`\nall ${pass} zoom tests passed`);

// The filter-fit verdict, pinned per mode.
//
// Every scenario is a synthetic averaged spectrum — a floor with shapes added —
// because the judgements are exactly the kind of threshold logic that reads
// plausibly in code and is wrong by one bin in practice. The state machine is
// tested under its own clock: patience is the feature, so time is an input.

const assert = require('assert');
const {
    FIT_PERSIST_MS, FIT_SILENCE_MS, findIslands, formatFit, rawFit, updateFit,
} = require('./.build/iffit.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const FLOOR = -120;
const BINS = 512;

// A window `offLo..offHi` Hz about the dial, and a mean holding the floor plus
// whatever `shapes` add: { lo, hi, db } rectangles in offset Hz.
function scene(offLo, offHi, shapes) {
    const win = { offLo, offHi, span: offHi - offLo };
    const perBin = win.span / BINS;
    const mean = new Float32Array(BINS).fill(FLOOR);
    for (const s of shapes) {
        for (let i = 0; i < BINS; i++) {
            const mid = offLo + (i + 0.5) * perBin;
            if (mid >= s.lo && mid <= s.hi) mean[i] = Math.max(mean[i], FLOOR + s.db);
        }
    }
    return { win, mean, perBin };
}

// The passband as grid bins, the same outward rounding bandBins uses.
function bandOf(win, perBin, lo, hi) {
    return {
        first: Math.max(0, Math.floor((lo - win.offLo) / perBin)),
        last: Math.min(BINS - 1, Math.ceil((hi - win.offLo) / perBin) - 1),
    };
}

const fit = (mode, offLo, offHi, bandLo, bandHi, shapes) => {
    const { win, mean, perBin } = scene(offLo, offHi, shapes);
    const band = bandOf(win, perBin, bandLo, bandHi);
    const tuning = { mode, bandwidthLow: bandLo, bandwidthHigh: bandHi };
    return rawFit(mean, win, band, tuning, FLOOR);
};

// ── islands ──────────────────────────────────────────────────────────────────

t('a gap narrower than the tolerance is inside the signal', () => {
    const mean = new Float32Array(20).fill(FLOOR);
    for (const i of [5, 6, 7, 10, 11]) mean[i] = FLOOR + 20;   // hole at 8..9
    const is = findIslands(mean, FLOOR, 6, 2);
    assert.strictEqual(is.length, 1);
    assert.strictEqual(is[0].first, 5);
    assert.strictEqual(is[0].last, 11);
});

t('a wider gap is two signals', () => {
    const mean = new Float32Array(20).fill(FLOOR);
    for (const i of [5, 6, 10, 11]) mean[i] = FLOOR + 20;
    assert.strictEqual(findIslands(mean, FLOOR, 6, 2).length, 2);
});

t('a gap in the data is not bridged', () => {
    const mean = new Float32Array(20).fill(FLOOR);
    for (const i of [5, 6, 8, 9]) mean[i] = FLOOR + 20;
    mean[7] = NaN;
    assert.strictEqual(findIslands(mean, FLOOR, 6, 3).length, 2);
});

// ── SSB ──────────────────────────────────────────────────────────────────────

t('USB speech inside the filter is a good fit', () => {
    const v = fit('usb', -800, 3400, 50, 2700, [{ lo: 300, hi: 2400, db: 25 }]);
    assert.strictEqual(v.kind, 'ok');
});

t('USB speech past the high edge is narrow, at that edge', () => {
    const v = fit('usb', -800, 3400, 50, 2700, [{ lo: 300, hi: 3100, db: 25 }]);
    assert.strictEqual(v.kind, 'narrow');
    assert.strictEqual(v.edge, 'high');
    assert.ok(v.spillHz > 300 && v.spillHz < 500, `spill ${v.spillHz}`);
});

t('USB energy past the near edge is a mistune, not a narrow filter', () => {
    // The signal runs below the dial: widening would only let the mistake in
    // louder, so the advice is the tuning knob — negative means tune down.
    const v = fit('usb', -800, 3400, 50, 2700, [{ lo: -300, hi: 2400, db: 25 }]);
    assert.strictEqual(v.kind, 'offcentre');
    assert.ok(v.offsetHz < -250 && v.offsetHz > -450, `off ${v.offsetHz}`);
});

t('LSB is the mirror: near-edge spill says tune up', () => {
    const v = fit('lsb', -3400, 800, -2700, -50, [{ lo: -2400, hi: 300, db: 25 }]);
    assert.strictEqual(v.kind, 'offcentre');
    assert.ok(v.offsetHz > 250 && v.offsetHz < 450, `off ${v.offsetHz}`);
});

t('spill at both SSB edges is narrow at the far edge, the filter\'s own fault', () => {
    const v = fit('usb', -1200, 3800, 50, 2700, [{ lo: -300, hi: 3100, db: 25 }]);
    assert.strictEqual(v.kind, 'narrow');
    assert.strictEqual(v.edge, 'high');
});

t('a CW carrier pressing through the filter edge is a mistune, never "narrow"', () => {
    // Straddling the edge — still audible, badly tuned. Wholly outside the
    // passband there is nothing being heard and rawFit rightly says nothing.
    const v = fit('cwu', -650, 650, -500, 500, [{ lo: 460, hi: 560, db: 30 }]);
    assert.strictEqual(v.kind, 'offcentre');
    assert.ok(v.offsetHz > 400, `off ${v.offsetHz}`);
    assert.strictEqual(fit('cwu', -650, 650, -500, 500, [{ lo: 540, hi: 590, db: 30 }]), null);
});

t('empty low end of a USB filter is speech, not slack', () => {
    // Nothing below 300 Hz — normal — and the top nearly reached: no verdict.
    const v = fit('usb', -800, 3400, 50, 2700, [{ lo: 300, hi: 2500, db: 25 }]);
    assert.strictEqual(v.kind, 'ok');
});

t('a USB filter far wider than the speech is wide, at the far edge', () => {
    const v = fit('usb', -800, 3400, 50, 2700, [{ lo: 300, hi: 1200, db: 25 }]);
    assert.strictEqual(v.kind, 'wide');
    assert.strictEqual(v.edge, 'high');
    assert.ok(v.slackHz > 1300, `slack ${v.slackHz}`);
});

t('LSB is the mirror: slack lives at the low edge', () => {
    const v = fit('lsb', -3400, 800, -2700, -50, [{ lo: -1200, hi: -300, db: 25 }]);
    assert.strictEqual(v.kind, 'wide');
    assert.strictEqual(v.edge, 'low');
});

t('an adjacent station outside the filter, with a cold gap, is nobody\'s problem', () => {
    const v = fit('usb', -800, 3400, 50, 2700, [
        { lo: 300, hi: 2400, db: 25 },
        { lo: 2950, hi: 3300, db: 30 },     // louder, but out of band and detached
    ]);
    assert.strictEqual(v.kind, 'ok');
});

t('a second signal inside the filter is a neighbour, at its peak', () => {
    const v = fit('usb', -800, 3400, 50, 2700, [
        { lo: 300, hi: 1600, db: 25 },
        { lo: 2100, hi: 2500, db: 15 },
    ]);
    assert.strictEqual(v.kind, 'neighbour');
    assert.ok(v.offsetHz > 2100 && v.offsetHz < 2500, `at ${v.offsetHz}`);
});

// ── symmetric voice ──────────────────────────────────────────────────────────

t('AM sized to its sidebands is a good fit', () => {
    const v = fit('am', -6500, 6500, -5000, 5000, [{ lo: -4200, hi: 4200, db: 20 }]);
    assert.strictEqual(v.kind, 'ok');
});

t('AM in a filter twice its width is wide, both edges', () => {
    const v = fit('am', -6500, 6500, -5000, 5000, [{ lo: -2500, hi: 2500, db: 20 }]);
    assert.strictEqual(v.kind, 'wide');
    assert.strictEqual(v.edge, 'both');
    assert.ok(v.extentHz > 4500 && v.extentHz < 5500, `extent ${v.extentHz}`);
});

t('a faded sideband does not shrink the verdict onto the healthy one', () => {
    // Lower sideband gone: the wider (upper) side governs, and it fits.
    const v = fit('am', -6500, 6500, -5000, 5000, [{ lo: -1000, hi: 4200, db: 20 }]);
    assert.strictEqual(v.kind, 'ok');
});

t('AM spilling both edges is narrow at both', () => {
    const v = fit('am', -8000, 8000, -5000, 5000, [{ lo: -5700, hi: 5700, db: 20 }]);
    assert.strictEqual(v.kind, 'narrow');
    assert.strictEqual(v.edge, 'both');
});

t('the same slack that moves AM leaves FM alone', () => {
    // ±5 kHz occupied in a ±8 kHz filter: 3 kHz slack. AM's threshold is
    // 1.6 kHz; FM's tapering sidebands push its own to 3.2 kHz.
    const shapes = [{ lo: -5000, hi: 5000, db: 20 }];
    assert.strictEqual(fit('fm', -10000, 10000, -8000, 8000, shapes).kind, 'ok');
    assert.strictEqual(fit('am', -10000, 10000, -8000, 8000, shapes).kind, 'wide');
});

// ── CW ───────────────────────────────────────────────────────────────────────

t('a centred carrier never earns "wide"', () => {
    const v = fit('cwu', -650, 650, -500, 500, [{ lo: -20, hi: 20, db: 30 }]);
    assert.strictEqual(v.kind, 'ok');
});

t('a carrier far off the middle is off-centre, signed', () => {
    const v = fit('cwu', -650, 650, -500, 500, [{ lo: 280, hi: 320, db: 30 }]);
    assert.strictEqual(v.kind, 'offcentre');
    assert.ok(v.offsetHz > 250 && v.offsetHz < 350, `off ${v.offsetHz}`);
});

t('a second carrier in the passband is the neighbour verdict, not off-centre', () => {
    const v = fit('cwu', -650, 650, -500, 500, [
        { lo: -220, hi: -180, db: 30 },
        { lo: 230, hi: 270, db: 22 },
    ]);
    assert.strictEqual(v.kind, 'neighbour');
    assert.ok(v.offsetHz > 200 && v.offsetHz < 300, `at ${v.offsetHz}`);
});

t('two CW stations 100 Hz apart are two islands, not one wide signal', () => {
    // The voice gap tolerance (150 Hz) would weld these; CW's own must not.
    const v = fit('cwu', -650, 650, -500, 500, [
        { lo: -20, hi: 20, db: 30 },
        { lo: 100, hi: 140, db: 25 },
    ]);
    assert.strictEqual(v.kind, 'neighbour');
});

// ── nothing to judge ─────────────────────────────────────────────────────────

t('a quiet channel has no verdict', () => {
    assert.strictEqual(fit('usb', -800, 3400, 50, 2700, []), null);
});

t('IQ gets no opinion', () => {
    assert.strictEqual(fit('iq', -6000, 6000, -5000, 5000, [{ lo: -3000, hi: 3000, db: 20 }]), null);
});

t('a signal only outside the passband is not ours to judge', () => {
    const v = fit('usb', -800, 3400, 50, 2700, [{ lo: 2900, hi: 3300, db: 30 }]);
    assert.strictEqual(v, null);
});

// ── patience ─────────────────────────────────────────────────────────────────

t('a verdict is not shown until it has held', () => {
    const st = {};
    const wide = { kind: 'wide', slackHz: 800 };
    assert.strictEqual(updateFit(st, wide, 0), null);
    assert.strictEqual(updateFit(st, wide, FIT_PERSIST_MS - 1), null);
    const shown = updateFit(st, wide, FIT_PERSIST_MS);
    assert.strictEqual(shown.kind, 'wide');
});

t('changing your mind resets the clock', () => {
    const st = {};
    updateFit(st, { kind: 'wide' }, 0);
    updateFit(st, { kind: 'narrow' }, 1000);
    assert.strictEqual(updateFit(st, { kind: 'narrow' }, 1000 + FIT_PERSIST_MS - 1), null);
    assert.strictEqual(updateFit(st, { kind: 'narrow' }, 1000 + FIT_PERSIST_MS).kind, 'narrow');
});

t('a settled verdict tracks its numbers without re-earning its place', () => {
    const st = {};
    updateFit(st, { kind: 'wide', slackHz: 800 }, 0);
    updateFit(st, { kind: 'wide', slackHz: 800 }, FIT_PERSIST_MS);
    const v = updateFit(st, { kind: 'wide', slackHz: 650 }, FIT_PERSIST_MS + 100);
    assert.strictEqual(v.slackHz, 650);
});

t('silence holds the verdict — a pause is not a bandwidth change', () => {
    const st = {};
    updateFit(st, { kind: 'narrow' }, 0);
    updateFit(st, { kind: 'narrow' }, FIT_PERSIST_MS);
    const during = updateFit(st, null, FIT_PERSIST_MS + FIT_SILENCE_MS - 1);
    assert.strictEqual(during.kind, 'narrow');
});

t('silence long enough to mean "gone" lets go', () => {
    const st = {};
    updateFit(st, { kind: 'narrow' }, 0);
    updateFit(st, { kind: 'narrow' }, FIT_PERSIST_MS);
    updateFit(st, null, FIT_PERSIST_MS + 10);
    assert.strictEqual(updateFit(st, null, FIT_PERSIST_MS + 10 + FIT_SILENCE_MS), null);
});

t('speech resuming cancels the silence clock', () => {
    const st = {};
    updateFit(st, { kind: 'narrow' }, 0);
    updateFit(st, { kind: 'narrow' }, FIT_PERSIST_MS);
    updateFit(st, null, FIT_PERSIST_MS + 10);
    updateFit(st, { kind: 'narrow' }, FIT_PERSIST_MS + 3000);          // back
    const v = updateFit(st, null, FIT_PERSIST_MS + 3000 + FIT_SILENCE_MS - 1);
    assert.strictEqual(v.kind, 'narrow');
});

// ── wording ──────────────────────────────────────────────────────────────────

t('the readout wording covers every verdict', () => {
    assert.strictEqual(formatFit(null).value, '—');
    assert.strictEqual(formatFit({ kind: 'ok' }).value, 'good');
    assert.strictEqual(formatFit({ kind: 'narrow', edge: 'high' }).unit, 'clipping high edge');
    assert.strictEqual(formatFit({ kind: 'wide', slackHz: 1240 }).unit, '~1.2 kHz slack');
    assert.strictEqual(formatFit({ kind: 'offcentre', offsetHz: -82 }).value, 'off-centre');
    assert.ok(formatFit({ kind: 'neighbour', offsetHz: 340 }).unit.includes('+340 Hz'));
});

console.log(`\n${pass} passed`);

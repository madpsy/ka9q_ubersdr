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

const fit = (mode, offLo, offHi, bandLo, bandHi, shapes, resHz = 0) => {
    const { win, mean, perBin } = scene(offLo, offHi, shapes);
    const band = bandOf(win, perBin, bandLo, bandHi);
    const tuning = { mode, bandwidthLow: bandLo, bandwidthHigh: bandHi };
    return rawFit(mean, win, band, tuning, FLOOR, resHz);
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

t('USB energy past the near edge is not the filter\'s fault — silence', () => {
    // The signal runs below the dial: a mistune, which is the tuning knob's
    // business and not this card's. No verdict at all beats a nagging one.
    const v = fit('usb', -800, 3400, 50, 2700, [{ lo: -300, hi: 2400, db: 25 }]);
    assert.strictEqual(v.kind, 'ok');
});

t('LSB is the mirror: near-edge spill is ignored there too', () => {
    const v = fit('lsb', -3400, 800, -2700, -50, [{ lo: -2400, hi: 300, db: 25 }]);
    assert.strictEqual(v.kind, 'ok');
});

t('spill at both SSB edges is narrow at the far edge, the filter\'s own fault', () => {
    const v = fit('usb', -1200, 3800, 50, 2700, [{ lo: -300, hi: 3100, db: 25 }]);
    assert.strictEqual(v.kind, 'narrow');
    assert.strictEqual(v.edge, 'high');
});

t('a CW carrier pressing through the filter edge is never "narrow"', () => {
    // Straddling the edge — badly tuned, which is not this card's business.
    const v = fit('cwu', -650, 650, -500, 500, [{ lo: 460, hi: 560, db: 30 }]);
    assert.strictEqual(v.kind, 'ok');
    // Wholly outside the passband nothing is being heard: no verdict at all.
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

t('a carrier off the middle is still just a carrier — no nagging', () => {
    const v = fit('cwu', -650, 650, -500, 500, [{ lo: 280, hi: 320, db: 30 }]);
    assert.strictEqual(v.kind, 'ok');
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

t('silence shows nothing — no signal, no verdict beside a dashed Peak', () => {
    const st = {};
    updateFit(st, { kind: 'narrow' }, 0);
    updateFit(st, { kind: 'narrow' }, FIT_PERSIST_MS);
    assert.strictEqual(updateFit(st, null, FIT_PERSIST_MS + 500), null);
});

t('...but a pause is not a bandwidth change: the verdict returns instantly', () => {
    const st = {};
    updateFit(st, { kind: 'narrow' }, 0);
    updateFit(st, { kind: 'narrow' }, FIT_PERSIST_MS);
    updateFit(st, null, FIT_PERSIST_MS + 500);
    const back = updateFit(st, { kind: 'narrow' }, FIT_PERSIST_MS + 3000);
    assert.strictEqual(back.kind, 'narrow');       // no re-earning
});

t('silence long enough to mean "gone" clears the memory too', () => {
    const st = {};
    updateFit(st, { kind: 'narrow' }, 0);
    updateFit(st, { kind: 'narrow' }, FIT_PERSIST_MS);
    updateFit(st, null, FIT_PERSIST_MS + 10);
    updateFit(st, null, FIT_PERSIST_MS + 10 + FIT_SILENCE_MS);
    // A new station must earn its verdict from scratch.
    assert.strictEqual(updateFit(st, { kind: 'narrow' }, FIT_PERSIST_MS + 9000), null);
});

// ── the false alarms this exists not to raise ────────────────────────────────

t('a strong station\'s leakage skirts are not clipping', () => {
    // The skirts clear the floor gate for a kilohertz either side, but sit
    // 35 dB under the peak — the relative gate keeps them out of the width.
    const v = fit('am', -8000, 8000, -5000, 5000, [
        { lo: -5600, hi: 5600, db: 10 },        // skirts, past both edges
        { lo: -4200, hi: 4200, db: 45 },        // the actual signal, inside
    ]);
    assert.notStrictEqual(v.kind, 'narrow');
});

t('coarse served bins cannot read as spill', () => {
    // 400 Hz of apparent spill under 300 Hz bins is edge quantisation.
    const shapes = [{ lo: 300, hi: 3100, db: 25 }];
    assert.strictEqual(fit('usb', -800, 3400, 50, 2700, shapes).kind, 'narrow');
    assert.strictEqual(fit('usb', -800, 3400, 50, 2700, shapes, 300).kind, 'ok');
});

t('a weak fragment of the same speech is not a neighbour', () => {
    // Sibilance: detached from the voiced energy, but far below it and barely
    // out of the noise. Both neighbour guards refuse it.
    const v = fit('usb', -800, 3400, 50, 2700, [
        { lo: 300, hi: 1800, db: 25 },
        { lo: 2300, hi: 2500, db: 8 },
    ]);
    assert.notStrictEqual(v.kind, 'neighbour');
});

t('a real second station still is one', () => {
    const v = fit('usb', -800, 3400, 50, 2700, [
        { lo: 300, hi: 1600, db: 25 },
        { lo: 2100, hi: 2500, db: 15 },
    ]);
    assert.strictEqual(v.kind, 'neighbour');
});

// ── wording ──────────────────────────────────────────────────────────────────

t('the readout wording covers every verdict', () => {
    assert.strictEqual(formatFit(null).value, '—');
    assert.strictEqual(formatFit({ kind: 'ok' }).value, 'good');
    assert.strictEqual(formatFit({ kind: 'narrow', edge: 'high' }).unit, 'clips high');
    assert.strictEqual(formatFit({ kind: 'wide', slackHz: 1240 }).unit, '~1.2 kHz');
    assert.strictEqual(formatFit({ kind: 'neighbour', offsetHz: 340 }).unit, '+340 Hz');
    // Nothing the cell cannot hold — the card is a fixed grid column.
    for (const v of [
        null, { kind: 'ok' }, { kind: 'narrow', edge: 'both' }, { kind: 'wide', slackHz: 12400 },
        { kind: 'neighbour', offsetHz: -1340 },
    ]) {
        const f = formatFit(v);
        assert.ok(f.value.length <= 8 && f.unit.length <= 10, `${f.value} ${f.unit}`);
    }
});

console.log(`\n${pass} passed`);

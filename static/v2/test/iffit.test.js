// The filter-fit verdict, pinned per mode.
//
// Every scenario is a synthetic averaged spectrum — a floor with shapes added —
// because the judgements are exactly the kind of threshold logic that reads
// plausibly in code and is wrong by one bin in practice. The state machine is
// tested under its own clock: patience is the feature, so time is an input.

const assert = require('assert');
const {
    FIT_MIN_ROWS, FIT_MIN_SPAN_MS, FIT_PERSIST_MS, FIT_SILENCE_MS,
    findIslands, formatFit, rawFit, updateFit,
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

// Plenty of evidence unless a test says otherwise — the evidence bar has its
// own tests below.
const PLENTY = { rows: 40, spanMs: 4000 };
const fit = (mode, offLo, offHi, bandLo, bandHi, shapes, opts = {}) => {
    const { win, mean, perBin } = scene(offLo, offHi, shapes);
    const band = bandOf(win, perBin, bandLo, bandHi);
    const tuning = { mode, bandwidthLow: bandLo, bandwidthHigh: bandHi };
    return rawFit(mean, win, band, tuning, FLOOR, { ...PLENTY, ...opts });
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
    const v = fit('usb', -800, 3400, 50, 2700, [{ lo: 300, hi: 1000, db: 25 }]);
    assert.strictEqual(v.kind, 'wide');
    assert.strictEqual(v.edge, 'high');
    assert.ok(v.slackHz > 1600, `slack ${v.slackHz}`);
});

t('a 4 kHz USB filter over 3 kHz of speech is wide', () => {
    // The case from the field: a 100-4200 Hz filter with speech reaching about
    // 3.1 kHz, so more than a kilohertz of the passband is carrying nothing but
    // noise. Scaling the threshold by the filter width wanted 2.3 kHz of slack
    // here and called this a good fit — see FIT_SLACK_FRAC_SSB.
    const v = fit('usb', -1000, 5300, 100, 4200, [{ lo: 200, hi: 3100, db: 25 }]);
    assert.strictEqual(v.kind, 'wide');
    assert.strictEqual(v.edge, 'high');
    assert.ok(v.slackHz > 1000, `slack ${v.slackHz}`);
});

t('...but a few hundred hertz of empty top is not worth a verdict', () => {
    // 450 Hz of slack on a 2.7 kHz filter: inside the floor, and nothing an
    // operator would thank the card for pointing out. A voice measures short
    // of what was transmitted anyway — see FIT_SLACK_MIN_HZ.
    const v = fit('usb', -800, 3400, 50, 2700, [{ lo: 300, hi: 2250, db: 25 }]);
    assert.strictEqual(v.kind, 'ok');
});

t('...and wide audio in a wide filter is what that filter is for', () => {
    // 6 kHz of eSSB carrying 5.1 kHz of audio. The slack is a kilohertz again,
    // but in proportion to the filter, which is what the fraction is left in
    // to protect: this one was chosen wide on purpose.
    const v = fit('usb', -1500, 7500, 50, 6000, [{ lo: 100, hi: 5100, db: 25 }]);
    assert.strictEqual(v.kind, 'ok');
});

t('LSB is the mirror: slack lives at the low edge', () => {
    const v = fit('lsb', -3400, 800, -2700, -50, [{ lo: -1000, hi: -300, db: 25 }]);
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
        { lo: 2100, hi: 2500, db: 18 },
    ]);
    assert.strictEqual(v.kind, 'neighbour');
    assert.ok(v.offsetHz > 2100 && v.offsetHz < 2500, `at ${v.offsetHz}`);
});

// ── symmetric voice ──────────────────────────────────────────────────────────

t('AM sized to its sidebands is a good fit', () => {
    const v = fit('am', -6500, 6500, -5000, 5000, [{ lo: -4200, hi: 4200, db: 20 }]);
    assert.strictEqual(v.kind, 'ok');
});

t('AM in a filter nearly three times its width is wide, both edges', () => {
    const v = fit('am', -6500, 6500, -5000, 5000, [{ lo: -1800, hi: 1800, db: 20 }]);
    assert.strictEqual(v.kind, 'wide');
    assert.strictEqual(v.edge, 'both');
    assert.ok(v.extentHz > 3200 && v.extentHz < 4000, `extent ${v.extentHz}`);
});

t('a kilohertz of empty passband either side is worth saying', () => {
    // The case from the field: a 12 kHz filter over a 9.7 kHz signal. Not a
    // wild mis-setting — which is the point, because the old symmetric
    // threshold wanted 3.3 kHz of slack a side and called this a good fit.
    const v = fit('am', -8000, 8000, -6000, 6000, [{ lo: -4850, hi: 4850, db: 20 }]);
    assert.strictEqual(v.kind, 'wide');
    assert.ok(v.slackHz > 1000 && v.slackHz < 1300, `slack ${v.slackHz}`);
});

t('...and a few hundred hertz either side is not', () => {
    // The same 12 kHz filter over 10.2 kHz. The measured width already reads
    // short of the transmitted one and an AM signal breathes with the
    // modulation, so this is inside the tolerance rather than a filter worth
    // touching. The two tests together are where the line is.
    const v = fit('am', -8000, 8000, -6000, 6000, [{ lo: -5100, hi: 5100, db: 20 }]);
    assert.strictEqual(v.kind, 'ok');
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
    // ±3 kHz occupied in a ±8 kHz filter: 5 kHz of slack, and inside the
    // 5.2 kHz that FM's tapering sidebands earn it.
    const shapes = [{ lo: -3000, hi: 3000, db: 20 }];
    assert.strictEqual(fit('fm', -10000, 10000, -8000, 8000, shapes).kind, 'ok');
    assert.strictEqual(fit('am', -10000, 10000, -8000, 8000, shapes).kind, 'wide');
});

t('NFM is FM, and gets FM\'s allowance rather than AM\'s', () => {
    // A lightly modulated channel: the deviation, and so the occupied width,
    // falls with the audio, and telling the operator to narrow a filter that
    // fits the loud parts is bad advice. ±2 kHz in a ±5 kHz filter.
    const shapes = [{ lo: -2000, hi: 2000, db: 20 }];
    assert.strictEqual(fit('nfm', -6500, 6500, -5000, 5000, shapes).kind, 'ok');
    assert.strictEqual(fit('am', -6500, 6500, -5000, 5000, shapes).kind, 'wide');
});

// ── the carrier is not the signal ────────────────────────────────────────────
//
// Every scene here is a carrier line plus sidebands well below it, which is what
// a multi-second power average of AM actually looks like. Judged against the
// carrier, the sidebands fall under the relative gate and the station measures a
// couple of hundred hertz wide — see FIT_CARRIER_DROP_DB.

// A carrier at the dial: two bins of the 512-bin grid at these spans.
const CARRIER = { lo: -30, hi: 30, db: 79 };

t('an AM broadcast filling its filter is not "wide" because of its carrier', () => {
    // The case from the field: peak −39 dBFS over a −118 floor, sidebands out
    // to ±4.5 kHz in a ±5 kHz filter, occupancy reading 100 %. It reported
    // "wide ~5.4 kHz", which is the carrier's width subtracted from the
    // filter's half — advice to throw away everything being listened to.
    const v = fit('am', -6500, 6500, -5000, 5000, [
        CARRIER,
        { lo: -4500, hi: 4500, db: 34 },
    ]);
    assert.strictEqual(v.kind, 'ok');
});

t('...and the sidebands are what "wide" is measured from when it is true', () => {
    const v = fit('am', -6500, 6500, -5000, 5000, [
        CARRIER,
        { lo: -1200, hi: 1200, db: 34 },
    ]);
    assert.strictEqual(v.kind, 'wide');
    assert.strictEqual(v.edge, 'both');
    // The occupied width is the modulation's, not the carrier's — which is the
    // whole of the fix: this figure used to come back under 200 Hz.
    assert.ok(v.extentHz > 2000 && v.extentHz < 2900, `extent ${v.extentHz}`);
});

t('...and a carriered signal past the edges is still clipped', () => {
    const v = fit('am', -8000, 8000, -5000, 5000, [
        CARRIER,
        { lo: -5700, hi: 5700, db: 34 },
    ]);
    assert.strictEqual(v.kind, 'narrow');
    assert.strictEqual(v.edge, 'both');
});

t('SAM is AM: its carrier is excluded the same way', () => {
    const shapes = [CARRIER, { lo: -4500, hi: 4500, db: 34 }];
    assert.strictEqual(fit('sam', -6500, 6500, -5000, 5000, shapes).kind, 'ok');
});

t('NFM and FM carry a line at the dial too', () => {
    assert.strictEqual(fit('nfm', -6500, 6500, -5000, 5000, [
        CARRIER, { lo: -4000, hi: 4000, db: 34 },
    ]).kind, 'ok');
    assert.strictEqual(fit('fm', -10000, 10000, -8000, 8000, [
        CARRIER, { lo: -6500, hi: 6500, db: 34 },
    ]).kind, 'ok');
});

t('a bare carrier has no sideband to measure, and reads wide as it always did', () => {
    // A het, or an unmodulated broadcast. Nothing to hang the gate from, so the
    // reference falls back to the peak and the verdict is the old one — which
    // is the honest answer when the carrier really is all there is.
    const v = fit('am', -6500, 6500, -5000, 5000, [CARRIER]);
    assert.strictEqual(v.kind, 'wide');
});

t('the gate does not reach down into a loud carrier\'s skirts', () => {
    // 79 dB of carrier with a phase-noise skirt 20 dB over the floor running
    // past both filter edges, and 3 kHz of real modulation between them. The
    // skirt is 59 dB under the carrier: FIT_CARRIER_DROP_DB refuses to look
    // that far down, so this is not clipping.
    const v = fit('am', -8000, 8000, -5000, 5000, [
        { lo: -7000, hi: 7000, db: 20 },
        { lo: -3000, hi: 3000, db: 34 },
        CARRIER,
    ]);
    assert.notStrictEqual(v.kind, 'narrow');
});

t('coarse served bins widen the carrier guard', () => {
    // At 300 Hz bins the carrier is 300 Hz wide on any grid, so a 200 Hz guard
    // would take a bin of carrier as the loudest "sideband" and put the gate
    // back where it was. 2 × resHz is what stops that.
    const shapes = [CARRIER, { lo: -4500, hi: 4500, db: 34 }];
    assert.strictEqual(fit('am', -6500, 6500, -5000, 5000, shapes, { resHz: 300 }).kind, 'ok');
});

t('SSB is untouched: no carrier, so the peak stays the reference', () => {
    // A strong low formant with the rest of the voice 25 dB under it. On a
    // carrier mode this would now measure the quiet part as signal; on USB the
    // peak is part of the modulation and the old reading is the right one.
    const v = fit('usb', -800, 3400, 50, 2700, [
        { lo: 300, hi: 600, db: 45 },
        { lo: 600, hi: 2400, db: 19 },
    ]);
    assert.strictEqual(v.kind, 'wide');
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

// ── the evidence bar ─────────────────────────────────────────────────────────

t('a thin average is not asked for an opinion', () => {
    const shapes = [{ lo: 300, hi: 3100, db: 25 }];     // plainly clipped
    assert.strictEqual(fit('usb', -800, 3400, 50, 2700, shapes).kind, 'narrow');
    assert.strictEqual(fit('usb', -800, 3400, 50, 2700, shapes, { rows: FIT_MIN_ROWS - 1 }), null);
    assert.strictEqual(fit('usb', -800, 3400, 50, 2700, shapes, { spanMs: FIT_MIN_SPAN_MS - 1 }), null);
});

t('a fast feed still has to cover the time, and a slow one the frames', () => {
    const shapes = [{ lo: 300, hi: 3100, db: 25 }];
    // Forty frames inside a second: plenty of samples, not enough signal.
    assert.strictEqual(fit('usb', -800, 3400, 50, 2700, shapes, { rows: 40, spanMs: 900 }), null);
    // Four seconds covered by three frames: plenty of time, too few samples.
    assert.strictEqual(fit('usb', -800, 3400, 50, 2700, shapes, { rows: 3, spanMs: 4000 }), null);
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
    assert.strictEqual(fit('usb', -800, 3400, 50, 2700, shapes, { resHz: 300 }).kind, 'ok');
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
        { lo: 2100, hi: 2500, db: 18 },
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

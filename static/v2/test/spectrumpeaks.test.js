// Peak markers: the estimators, and the label layout.
//
// This is the part of the feature that cannot be checked by looking at a screenshot. A
// marker in roughly the right place looks correct; the tests below are about the cases
// where "roughly" is a bug — a plateau, a shoulder of a bigger signal, a peak between
// two samples, two labels that collide, a band with nothing on it.
//
// Where a test asserts a number it is one the maths pins down (a parabola's vertex, a
// median, the alpha of an RC filter), not one read off the implementation.

const assert = require('assert');
const pk = require('./.build/spectrumpeaks.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// A flat noise floor with signals added, which is what all of this is for.
const band = (n, floor, peaks) => {
    const a = new Float32Array(n).fill(floor);
    for (const [at, height, width = 2] of peaks) {
        for (let i = -width; i <= width; i++) {
            const v = floor + height * Math.exp(-((i / (width / 1.5 || 1)) ** 2));
            if (a[at + i] < v) a[at + i] = v;
        }
    }
    return a;
};

// --- the noise floor ---------------------------------------------------------

t('the floor is the median, so signals do not lift it', () => {
    // The point of the median: a mean would be dragged up by exactly the signals being
    // looked for, and on a band with three carriers it would report a floor above the
    // weak ones — which then stop being found at all.
    const a = band(200, -100, [[50, 60], [120, 55], [160, 40]]);
    const { floor } = pk.noiseStats(a);
    assert.strictEqual(floor, -100);
});

t('sigma is MAD scaled to a Gaussian, and zero on a flat trace', () => {
    assert.strictEqual(pk.noiseStats(new Float32Array(64).fill(-90)).sigma, 0);
    // ±2 dB about the floor: half the samples deviate by 2, so the MAD is 2 and sigma
    // is 2 × 1.4826. That factor is 1/Φ⁻¹(0.75) and is not ours to choose.
    const a = new Float32Array(64);
    for (let i = 0; i < 64; i++) a[i] = -90 + (i % 2 ? 2 : -2);
    assert.strictEqual(pk.noiseStats(a).floor, -90);
    assert.ok(Math.abs(pk.noiseStats(a).sigma - 2 * 1.4826) < 1e-6);
});

t('an empty trace has no opinion rather than throwing', () => {
    assert.deepStrictEqual(pk.noiseStats(new Float32Array(0)), { floor: 0, sigma: 0 });
    assert.deepStrictEqual(pk.findPeaks(new Float32Array(0), { count: 5 }), []);
});

// --- where the peak actually is ----------------------------------------------

t('a symmetric peak interpolates to exactly the sample it is on', () => {
    const { delta, db } = pk.interpolatePeak(-10, 0, -10);
    assert.strictEqual(delta, 0);
    assert.strictEqual(db, 0);
});

t('a lopsided peak leans towards the higher neighbour, and reads higher than the sample', () => {
    // The whole point of interpolating: the true maximum of a signal between two bins
    // is higher than either of them, and a marker on the sample is up to half a bin out.
    const { delta, db } = pk.interpolatePeak(-2, 0, -8);
    assert.ok(delta < 0, 'leans left, towards the -2');
    assert.ok(db > 0, 'and the vertex is above the sampled level');
    // The vertex of the parabola through (-1,-2), (0,0), (1,-8): delta = (yl-yr)/(2(yl-2y+yr)).
    assert.ok(Math.abs(delta - ((-2 + 8) / (2 * (-2 - 0 + -8)))) < 1e-12);
});

t('three equal samples say nothing about where between them the peak is', () => {
    const { delta, db } = pk.interpolatePeak(5, 5, 5);
    assert.strictEqual(delta, 0);
    assert.strictEqual(db, 5);
});

t('the fit never runs further than half a sample', () => {
    // A fit on three points that are not a maximum can produce anything; half a sample
    // is as far as a vertex between neighbours can legitimately be.
    for (const [a, b, c] of [[0, 1, 0.999], [10, 10.0001, 0], [-5, -4.9, -5.1]]) {
        const { delta } = pk.interpolatePeak(a, b, c);
        assert.ok(delta >= -0.5 && delta <= 0.5, `${a},${b},${c} -> ${delta}`);
    }
});

t('a peak is found off-sample, between the two bins it straddles', () => {
    const a = new Float32Array(64).fill(-100);
    a[30] = -60; a[31] = -58; a[32] = -59;      // true maximum between 31 and 32
    const [p] = pk.findPeaks(a, { count: 1, minAbove: 10, minProminence: 3 });
    assert.ok(p.x > 31 && p.x < 32, `x=${p.x}`);
    assert.strictEqual(p.bin, 31, 'the winning sample is still reported');
});

// --- what counts as a signal -------------------------------------------------

t('a quiet band gets no markers, however many were asked for', () => {
    // The answer the operator wants: five markers over noise would claim five signals
    // on a band with nothing on it.
    const a = new Float32Array(256);
    for (let i = 0; i < a.length; i++) a[i] = -100 + Math.sin(i) * 0.8;
    assert.deepStrictEqual(pk.findPeaks(a, { count: 5, minAbove: 10 }), []);
});

t('the count is a ceiling: two signals give two markers out of five', () => {
    const a = band(300, -100, [[80, 40], [200, 35]]);
    assert.strictEqual(pk.findPeaks(a, { count: 5, minAbove: 10 }).length, 2);
});

t('the threshold is in dB above the floor, and it is obeyed', () => {
    const a = band(300, -100, [[80, 40], [200, 12]]);
    assert.strictEqual(pk.findPeaks(a, { count: 5, minAbove: 10 }).length, 2, 'both clear 10 dB');
    assert.strictEqual(pk.findPeaks(a, { count: 5, minAbove: 20 }).length, 1, 'only one clears 20');
    assert.strictEqual(pk.findPeaks(a, { count: 5, minAbove: 45 }).length, 0);
});

t('each marker carries its SNR, measured from the same floor as the threshold', () => {
    const a = band(300, -100, [[80, 40]]);
    const [p] = pk.findPeaks(a, { count: 3, minAbove: 10 });
    assert.ok(Math.abs(p.snr - 40) < 1.5, `snr=${p.snr}`);
    assert.ok(Math.abs(p.db - (-60)) < 1.5, `db=${p.db}`);
});

t('markers come back strongest first', () => {
    const a = band(400, -100, [[100, 20], [200, 45], [300, 32]]);
    const got = pk.findPeaks(a, { count: 3, minAbove: 10 });
    assert.deepStrictEqual(got.map((p) => p.rank), [1, 2, 3]);
    assert.ok(got[0].db > got[1].db && got[1].db > got[2].db);
    assert.ok(Math.abs(got[0].x - 200) < 2, 'the 45 dB one leads');
});

t('a shoulder of a big signal is not a second signal', () => {
    // Prominence is what decides this, and it is the reason for having it: a bump on the
    // side of a carrier is that carrier, at any zoom.
    const a = new Float32Array(200).fill(-100);
    for (let i = 60; i <= 100; i++) a[i] = -100 + 40 - Math.abs(80 - i) * 0.5;
    a[90] += 1.5;       // a 1.5 dB bump on the skirt
    const got = pk.findPeaks(a, { count: 5, minAbove: 10, minProminence: 4, gap: 1 });
    assert.strictEqual(got.length, 1, 'one signal, not two');
});

t('two real carriers with a valley between them are two signals', () => {
    const a = band(300, -100, [[100, 40, 3], [140, 38, 3]]);
    const got = pk.findPeaks(a, { count: 5, minAbove: 10, minProminence: 4, gap: 10 });
    assert.strictEqual(got.length, 2);
});

t('a flat-topped signal is one marker, not one per sample', () => {
    // A strong smoothed carrier is a plateau. A strict `>` on both sides finds nothing
    // there at all; `>=` on both finds every sample of it.
    const a = new Float32Array(120).fill(-100);
    for (let i = 50; i <= 58; i++) a[i] = -55;
    const got = pk.findPeaks(a, { count: 5, minAbove: 10, minProminence: 4, gap: 1 });
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].bin, 50, 'the first sample of the plateau');
});

t('signals closer than the gap share one marker', () => {
    const a = band(300, -100, [[100, 40, 2], [104, 39, 2]]);
    assert.strictEqual(pk.findPeaks(a, { count: 5, minAbove: 10, gap: 14 }).length, 1);
    assert.strictEqual(pk.findPeaks(a, { count: 5, minAbove: 10, gap: 2 }).length, 2);
});

t('a signal at the very edge of the view is not marked', () => {
    // Its real maximum is outside the view, its label would be clipped, and the dial
    // moving a hair will bring it in properly.
    const a = new Float32Array(64).fill(-100);
    a[0] = -50;
    a[63] = -50;
    assert.deepStrictEqual(pk.findPeaks(a, { count: 5, minAbove: 10 }), []);
});

// --- holding still -----------------------------------------------------------

t('the average is an RC low-pass, and its alpha comes from the frame interval', () => {
    // One time constant of a step from 0 to 1 lands at 1 - 1/e. That is the whole
    // definition, and it is what makes the smoothing independent of the frame rate.
    const avg = new Float32Array(1);
    const trace = new Float32Array([1]);
    pk.averageTrace(avg, new Float32Array([0]), 0, 500, true);
    pk.averageTrace(avg, trace, 500, 500);
    assert.ok(Math.abs(avg[0] - (1 - Math.exp(-1))) < 1e-6, `${avg[0]}`);
});

t('the same total time in small steps reaches the same place', () => {
    // The property a dt/tau approximation loses, and the reason for the exponential: a
    // late frame must not smooth differently from two early ones.
    const one = new Float32Array(1);
    const many = new Float32Array(1);
    const trace = new Float32Array([10]);
    pk.averageTrace(one, new Float32Array([0]), 0, 400, true);
    pk.averageTrace(many, new Float32Array([0]), 0, 400, true);
    pk.averageTrace(one, trace, 400, 400);
    for (let i = 0; i < 8; i++) pk.averageTrace(many, trace, 50, 400);
    assert.ok(Math.abs(one[0] - many[0]) < 0.02, `${one[0]} vs ${many[0]}`);
});

t('a reset starts at the trace rather than sweeping up to it', () => {
    // What a zoom does: the old levels belong to other frequencies, and sweeping from
    // them would drag every marker across the screen for a second.
    const avg = new Float32Array([-100, -100]);
    pk.averageTrace(avg, new Float32Array([-40, -60]), 16, 700, true);
    assert.deepStrictEqual([...avg], [-40, -60]);
});

t('a bin with no reading holds its average instead of collapsing', () => {
    const avg = new Float32Array([-50]);
    pk.averageTrace(avg, [NaN], 100, 700);
    assert.strictEqual(avg[0], -50);
});

t('hysteresis keeps a marker on the signal that already had one', () => {
    // Two signals a decibel apart, five markers between six candidates: without this
    // they hand the last marker back and forth several times a second.
    const a = band(400, -100, [[60, 40], [120, 38], [180, 36], [240, 34], [300, 32.5], [360, 32]]);
    const first = pk.findPeaks(a, { count: 5, minAbove: 10 });
    const held = new Set(first.map((p) => p.bin));
    // The sixth signal creeps up to a hair under the fifth.
    const b = Float32Array.from(a);
    for (let i = 357; i <= 363; i++) b[i] += 0.4;
    const next = pk.findPeaks(b, { count: 5, minAbove: 10, prev: first });
    assert.ok(next.every((p) => held.has(p.bin) || Math.abs(p.x - 360) < 6),
        'the incumbent five keep their markers');
    // ...and a decisive newcomer does take one.
    const c = Float32Array.from(a);
    for (let i = 357; i <= 363; i++) c[i] += 8;
    const after = pk.findPeaks(c, { count: 5, minAbove: 10, prev: first });
    assert.ok(after.some((p) => Math.abs(p.x - 360) < 6), '8 dB is not a tie');
});

// --- the labels --------------------------------------------------------------

t('a label is centred on its peak', () => {
    const [p] = pk.layoutPeakLabels([{ x: 100 }], [40], 500);
    assert.strictEqual(p.left, 80);
    assert.strictEqual(p.label, true);
});

t('a label at either edge is clamped inside the view, not half off it', () => {
    const [l] = pk.layoutPeakLabels([{ x: 2 }], [40], 500);
    assert.strictEqual(l.left, 0);
    const [r] = pk.layoutPeakLabels([{ x: 498 }], [40], 500);
    assert.strictEqual(r.left, 460);
});

t('the weaker of two colliding labels is dropped, and keeps its marker', () => {
    // Dropped rather than nudged: a label moved clear of its neighbour points at
    // nothing, and two frequencies shifted off their own marks are both wrong with
    // nothing to say so.
    const got = pk.layoutPeakLabels([{ x: 100 }, { x: 110 }], [40, 40], 500);
    assert.strictEqual(got[0].label, true);
    assert.strictEqual(got[1].label, false);
});

t('a third label clear of both survives the pair that collided', () => {
    const got = pk.layoutPeakLabels([{ x: 100 }, { x: 110 }, { x: 300 }], [40, 40, 40], 500);
    assert.deepStrictEqual(got.map((p) => p.label), [true, false, true]);
});

t('a chain of labels alternates rather than dropping everything after the first', () => {
    // Each is judged against what has actually been placed, not against its neighbour:
    // three labels 45 px apart at 40 px wide fit as first, skip, third.
    const got = pk.layoutPeakLabels(
        [{ x: 100 }, { x: 145 }, { x: 190 }], [40, 40, 40], 500, { pad: 4 },
    );
    assert.deepStrictEqual(got.map((p) => p.label), [true, false, true]);
});

t('a zero-width label is never placed and never blocks one', () => {
    const got = pk.layoutPeakLabels([{ x: 100 }, { x: 100 }], [0, 40], 500);
    assert.strictEqual(got[0].label, false);
    assert.strictEqual(got[1].label, true);
});

// --- the settings ------------------------------------------------------------

t('not chosen resolves per device, and 0 is a choice of its own', () => {
    // The distinction that matters: absent means "this device's default", which is not
    // the same as somebody having turned the markers off.
    assert.strictEqual(pk.peakCount(null, false), pk.PEAK_DEFAULT_DESKTOP);
    assert.strictEqual(pk.peakCount(null, true), pk.PEAK_DEFAULT_MOBILE);
    assert.strictEqual(pk.peakCount(undefined, true), pk.PEAK_DEFAULT_MOBILE);
    assert.strictEqual(pk.peakCount(0, false), 0, 'off stays off on any screen');
    assert.strictEqual(pk.peakCount('5'), 5, 'a number from a <select> is a string');
});

t('the defaults are fewer on a phone, and both are on the list', () => {
    assert.ok(pk.PEAK_DEFAULT_MOBILE < pk.PEAK_DEFAULT_DESKTOP);
    assert.ok(pk.PEAK_COUNTS.includes(pk.PEAK_DEFAULT_MOBILE));
    assert.ok(pk.PEAK_COUNTS.includes(pk.PEAK_DEFAULT_DESKTOP));
    assert.strictEqual(pk.PEAK_COUNTS[0], 0, 'None is the first thing in the list');
});

t('a value that is not on the list is off, not a guess', () => {
    for (const v of ['', 'lots', 7, -3, 1e9, NaN]) {
        assert.strictEqual(pk.peakCount(v), 0, String(v));
    }
});

t('the threshold falls back to ten, which is a signal you can hear', () => {
    assert.strictEqual(pk.PEAK_SNR_DEFAULT, 10);
    assert.strictEqual(pk.peakSnr(undefined), 10);
    assert.strictEqual(pk.peakSnr(4), 10, 'not on the list');
    assert.strictEqual(pk.peakSnr('20'), 20);
});

t('the marks default to the fixed row, and an unknown place is that too', () => {
    // Fixed is the default because a row of labels at one height reads as a list and
    // never covers a peak; riding the trace is the choice for a quiet band.
    assert.strictEqual(pk.PEAK_PLACES[0], 'top');
    assert.strictEqual(pk.peakPlace(undefined), 'top');
    assert.strictEqual(pk.peakPlace('somewhere'), 'top');
    assert.strictEqual(pk.peakPlace('signal'), 'signal');
});

if (process.exitCode) console.log('\npeak marker tests FAILED');
else console.log(`\nall ${pass} peak marker tests passed`);

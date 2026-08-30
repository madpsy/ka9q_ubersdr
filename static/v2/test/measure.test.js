// The Measure tool: the estimators, and the store the three readers share.
//
// This is the part of the feature nothing else can check. A shaded box on a
// spectrum looks right whatever number is under it, and every figure the panel
// prints is a claim about a signal that somebody may write down — so the tests
// below pin the arithmetic to values the maths decides (a triangle's −6 dB
// points, ninety per cent of twenty equal bins, the flatness of a two-level
// trace, Welford's σ) rather than to whatever the code happened to return.
//
// The traces are built so the answers are exact. Real spectra are not, but a
// test that asserts "about 118 Hz" cannot tell a correct interpolation from one
// that is half a bin out, which is precisely the bug worth catching here.

const assert = require('assert');

// measureTool reads localStorage at first use, and node has none.
const store = {};
globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
};

const m = require('./.build/measure.cjs');
const tool = require('./.build/measuretool.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const near = (a, b, eps, what) => assert.ok(
    Math.abs(a - b) <= eps, `${what || ''}: ${a} is not within ${eps} of ${b}`,
);

// 100 bins of 10 Hz, centred on 14.200 MHz: bin 0 at 14 199 500, bin 50 at
// 14 200 000. Small enough to reason about by hand, which is the point.
const VIEW = { centerFreq: 14_200_000, binCount: 100, binBandwidth: 10 };
const N = 100;
const BASE = 14_199_500;
const all = { loHz: BASE - 100, hiHz: BASE + N * 10 + 100 };

const flat = (db) => new Float32Array(N).fill(db);

/** A peak `height` dB above `floor`, dropping `slope` dB per bin either side. */
const wedge = (at, height, slope, floorDb = -100) => {
    const a = flat(floorDb);
    for (let i = 0; i < N; i++) {
        const v = floorDb + height - Math.abs(i - at) * slope;
        if (v > a[i]) a[i] = v;
    }
    return a;
};

// --- where a bin is ----------------------------------------------------------

t('bin 0 is half a span below the centre, and the mapping inverts', () => {
    assert.strictEqual(m.binToHz(VIEW, N, 0), BASE);
    assert.strictEqual(m.binToHz(VIEW, N, 50), 14_200_000);
    assert.strictEqual(m.binToHz(VIEW, N, 99), BASE + 990);
    // The same mapping the trace is drawn with, so a measurement lands where
    // the picture says it should.
    assert.strictEqual(m.hzToBin(VIEW, N, 14_200_000), 50);
    near(m.hzToBin(VIEW, N, m.binToHz(VIEW, N, 33.25)), 33.25, 1e-9, 'round trip');
});

t('a bin is in the range when its centre is, and a reversed drag is the same region', () => {
    const r = m.binRange(VIEW, N, { loHz: BASE + 100, hiHz: BASE + 200 });
    // Centres 14 199 600 … 14 199 700 inclusive: eleven bins, not ten.
    assert.deepStrictEqual({ lo: r.lo, hi: r.hi, bins: r.bins }, { lo: 10, hi: 21, bins: 11 });
    const back = m.binRange(VIEW, N, { loHz: BASE + 200, hiHz: BASE + 100 });
    assert.deepStrictEqual(back, r);
});

t('a region hanging off the end of the view is clamped, not wrapped', () => {
    const low = m.binRange(VIEW, N, { loHz: BASE - 5000, hiHz: BASE + 50 });
    assert.strictEqual(low.lo, 0);
    assert.strictEqual(low.hi, 6);
    const high = m.binRange(VIEW, N, { loHz: BASE + 950, hiHz: BASE + 99999 });
    assert.strictEqual(high.hi, N);
    // Entirely outside is no bins rather than a negative count.
    const off = m.binRange(VIEW, N, { loHz: BASE - 9000, hiHz: BASE - 8000 });
    assert.strictEqual(off.bins, 0);
});

// --- the reading, on one frame -----------------------------------------------

t('a region too narrow to say anything about says nothing', () => {
    // Three bins: below a median, below a parabola, below the resolution the
    // widths would be quoted at. Null rather than a shape full of NaN.
    const s = m.selectionStats(flat(-100), VIEW, { loHz: BASE, hiHz: BASE + 20 });
    assert.strictEqual(s, null);
    assert.strictEqual(m.selectionStats(flat(-100), VIEW, null), null);
    assert.strictEqual(m.selectionStats(new Float32Array(0), VIEW, all), null);
});

t('on a flat trace every level is the same one and the shape figures are zero', () => {
    const s = m.selectionStats(flat(-100), VIEW, all);
    assert.strictEqual(s.bins, N);
    assert.strictEqual(s.peakDb, -100);
    assert.strictEqual(s.floorDb, -100);
    assert.strictEqual(s.sigmaDb, 0);
    assert.strictEqual(s.snrDb, 0);
    assert.strictEqual(s.crestDb, 0);
    // Flatness is the geometric mean over the arithmetic one: identical on a
    // trace with one value in it, and that is the top of its range.
    near(s.flatnessDb, 0, 1e-9, 'flatness');
    // A hundred equal bins hold a hundred times one bin's power.
    near(s.powerDb, -100 + 10 * Math.log10(N), 1e-9, 'integrated power');
    // Density must not depend on how wide the region is, only on how loud.
    near(s.densityDb, -100 - 10 * Math.log10(10), 1e-9, 'density');
    // Nothing stands above the floor, so there is no centre of energy to report.
    assert.strictEqual(s.centroidHz, null);
});

t('density is the same reading however much of the same trace is selected', () => {
    const a = m.selectionStats(flat(-80), VIEW, all);
    const b = m.selectionStats(flat(-80), VIEW, { loHz: BASE + 200, hiHz: BASE + 400 });
    near(a.densityDb, b.densityDb, 1e-9, 'density over two spans');
    // ...whereas the integrated power is not, and should not be.
    assert.ok(a.powerDb > b.powerDb + 5, 'a wider region holds more total power');
});

t('flatness is the mean of the decibels less the decibel of the mean power', () => {
    // Half the bins 10 dB above the other half. Geometric mean −95 dB;
    // arithmetic mean power (1e-10 + 1e-9)/2, i.e. −92.5964 dB. The difference
    // is the flatness, and it is negative because a spread trace is not flat.
    const a = new Float32Array(N);
    for (let i = 0; i < N; i++) a[i] = i % 2 ? -90 : -100;
    const s = m.selectionStats(a, VIEW, all);
    const expected = -95 - 10 * Math.log10((1e-10 + 1e-9) / 2);
    near(s.flatnessDb, expected, 1e-6, 'flatness');
    assert.ok(s.flatnessDb < 0);
});

t('a carrier is far less flat than noise, which is the whole use of the figure', () => {
    const noiseLike = new Float32Array(N);
    for (let i = 0; i < N; i++) noiseLike[i] = -100 + ((i * 37) % 11) - 5;
    const carrier = flat(-100);
    carrier[50] = -40;
    const a = m.selectionStats(noiseLike, VIEW, all);
    const b = m.selectionStats(carrier, VIEW, all);
    assert.ok(b.flatnessDb < a.flatnessDb - 10,
        `carrier ${b.flatnessDb} should be far below noise ${a.flatnessDb}`);
});

t('a symmetric peak reads at its own bin, and off-centre it leans to the tall side', () => {
    const a = wedge(50, 40, 2);
    const s = m.selectionStats(a, VIEW, all);
    assert.strictEqual(s.peakHz, 14_200_000);
    assert.strictEqual(s.peakDb, -60);
    assert.strictEqual(s.snrDb, 40);
    assert.strictEqual(s.peakAtEdge, false);

    // One neighbour higher than the other: the true maximum is between the
    // samples, so the reading must not be on the sample.
    const b = wedge(50, 40, 2);
    b[51] = b[49] + 1;
    const t2 = m.selectionStats(b, VIEW, all);
    assert.ok(t2.peakHz > 14_200_000, 'should lean towards the taller neighbour');
    assert.ok(t2.peakHz < 14_200_000 + 5, 'and by less than half a bin');
    assert.ok(t2.peakDb > -60, 'the interpolated peak is above the sample');
});

t('SNR is measured against the view\'s noise floor, not the region\'s own median', () => {
    // The failure this prevents: a region drawn tightly round a signal is
    // mostly signal, so its own median sits a few decibels under the peak and
    // the SNR reads as a property of how the box was drawn.
    const a = wedge(50, 40, 4);
    const tight = m.selectionStats(a, VIEW, { loHz: m.binToHz(VIEW, N, 47), hiHz: m.binToHz(VIEW, N, 53) });
    const loose = m.selectionStats(a, VIEW, all);
    assert.strictEqual(tight.floorDb, -100);
    assert.strictEqual(loose.floorDb, -100);
    assert.strictEqual(tight.snrDb, 40);
    assert.strictEqual(tight.snrDb, loose.snrDb, 'the same signal is the same SNR either way');
    // The region's own median is still reported, because it says something the
    // floor does not: how much of the box is full.
    assert.ok(tight.medianDb > loose.medianDb + 10,
        `a tight box has a high median (${tight.medianDb}) and a loose one does not (${loose.medianDb})`);
});

t('a peak on the edge of the region says so, because every width is then a bound', () => {
    const a = wedge(50, 40, 2);
    // A region that starts exactly on the peak.
    const s = m.selectionStats(a, VIEW, { loHz: m.binToHz(VIEW, N, 50), hiHz: m.binToHz(VIEW, N, 70) });
    assert.strictEqual(s.peakBin, 50);
    assert.strictEqual(s.peakAtEdge, true);
});

t('the centroid follows the energy, not the middle of the box', () => {
    const a = wedge(30, 40, 2);
    const s = m.selectionStats(a, VIEW, all);
    // The signal is at bin 30; the box is centred on bin 50. A plain spectral
    // centroid would be dragged towards the middle by the noise either side,
    // which is the reason the floor is subtracted first.
    near(s.centroidHz, m.binToHz(VIEW, N, 30), 2, 'centroid');
    assert.ok(Math.abs(s.centroidHz - s.centreHz) > 150, 'and not the centre of the region');
});

t('the region reported is the one drawn, with the resolution beside it', () => {
    const sel = { loHz: BASE + 137, hiHz: BASE + 462 };
    const s = m.selectionStats(flat(-90), VIEW, sel);
    assert.strictEqual(s.loHz, sel.loHz);
    assert.strictEqual(s.hiHz, sel.hiHz);
    assert.strictEqual(s.widthHz, 325);
    assert.strictEqual(s.centreHz, BASE + 299.5);
    assert.strictEqual(s.rbw, 10);
    // 14 bins: centres 140 … 460 above the base.
    assert.strictEqual(s.bins, 33);
});

// --- bandwidths --------------------------------------------------------------

t('an x-dB width is measured where the trace crosses, not at the nearest bin', () => {
    // A wedge falling 1 dB per bin: the −6 dB points land exactly on bins 44
    // and 56, twelve bins apart.
    const a = wedge(50, 40, 1);
    const s = m.selectionStats(a, VIEW, all);
    const r = m.binRange(VIEW, N, all);
    const w6 = m.xDbBandwidth(a, VIEW, r, s.peakBin, s.peakDb, 6);
    near(w6.widthHz, 120, 1e-9, '−6 dB width');
    assert.strictEqual(w6.clipped, false);
    const w3 = m.xDbBandwidth(a, VIEW, r, s.peakBin, s.peakDb, 3);
    near(w3.widthHz, 60, 1e-9, '−3 dB width');
});

t('a crossing between two bins is interpolated, so the reading does not jump by a bin', () => {
    // 2 dB per bin: the −3 dB point is one and a half bins out either side.
    // Rounding to bins would give 20 or 40 Hz; the answer is 30.
    const a = wedge(50, 40, 2);
    const s = m.selectionStats(a, VIEW, all);
    const r = m.binRange(VIEW, N, all);
    const w = m.xDbBandwidth(a, VIEW, r, s.peakBin, s.peakDb, 3);
    near(w.widthHz, 30, 1e-9, '−3 dB width across a 2 dB/bin slope');
    near(w.loHz, m.binToHz(VIEW, N, 48.5), 1e-9, 'low crossing');
    near(w.hiHz, m.binToHz(VIEW, N, 51.5), 1e-9, 'high crossing');
});

t('a width that ran out of region is flagged rather than reported as a value', () => {
    const a = wedge(50, 40, 1);
    // Ten bins wide: the −20 dB points are twenty bins out and cannot be seen.
    const sel = { loHz: m.binToHz(VIEW, N, 45), hiHz: m.binToHz(VIEW, N, 55) };
    const s = m.selectionStats(a, VIEW, sel);
    const r = m.binRange(VIEW, N, sel);
    const w = m.xDbBandwidth(a, VIEW, r, s.peakBin, s.peakDb, 20);
    assert.strictEqual(w.clipped, true);
    // The bound is the region itself, which is the most that can be said.
    near(w.widthHz, 100, 1e-9, 'the clipped width is the region');
    // ...while a level it can see is not flagged.
    assert.strictEqual(m.xDbBandwidth(a, VIEW, r, s.peakBin, s.peakDb, 3).clipped, false);
});

t('the first crossing wins, so a two-humped signal is not read as one wide one', () => {
    // Two peaks 20 bins apart, with a deep notch between them. Measured from
    // the taller one, the −3 dB width is that hump's, not the pair's.
    const a = flat(-100);
    for (const [at, height] of [[40, 40], [60, 38]]) {
        for (let i = -4; i <= 4; i++) a[at + i] = Math.max(a[at + i], -100 + height - Math.abs(i) * 4);
    }
    const s = m.selectionStats(a, VIEW, all);
    const r = m.binRange(VIEW, N, all);
    const w = m.xDbBandwidth(a, VIEW, r, s.peakBin, s.peakDb, 3);
    assert.ok(w.widthHz < 60, `one hump, not both: ${w.widthHz} Hz`);
});

t('shape factor is the far skirt over the near one, and carries a clipped width forward', () => {
    const near6 = { widthHz: 100, clipped: false };
    const far60 = { widthHz: 250, clipped: false };
    assert.deepStrictEqual(m.shapeFactor(near6, far60), { ratio: 2.5, clipped: false });
    // A clipped far skirt understates the ratio: the shape looks better than it
    // is, so the flag has to travel with the number.
    assert.strictEqual(m.shapeFactor(near6, { widthHz: 250, clipped: true }).clipped, true);
    assert.strictEqual(m.shapeFactor(null, far60), null);
    assert.strictEqual(m.shapeFactor(near6, { widthHz: 0 }), null);
});

t('occupied bandwidth is the share of the power, exactly', () => {
    // Twenty equal bins above the floor and nothing else: 90 % of them is
    // eighteen bins, 99 % is 19.8. Both are answers arithmetic decides.
    const a = flat(-100);
    for (let i = 40; i < 60; i++) a[i] = -70;
    const r = m.binRange(VIEW, N, all);
    near(m.occupiedBandwidth(a, VIEW, r, -100, 90).widthHz, 180, 1e-6, 'OBW 90');
    near(m.occupiedBandwidth(a, VIEW, r, -100, 99).widthHz, 198, 1e-6, 'OBW 99');
    // Centred on the signal, not on the region.
    near(m.occupiedBandwidth(a, VIEW, r, -100, 90).loHz, m.binToHz(VIEW, N, 40.5), 1e-6, 'low edge');
});

t('occupied bandwidth is a property of the signal, not of how wide the box was drawn', () => {
    // The failure the floor subtraction exists to prevent: with raw power, a
    // generous region puts most of the total in the noise either side and the
    // answer converges on the width of the box.
    const a = flat(-100);
    for (let i = 45; i < 55; i++) a[i] = -60;
    const tight = m.binRange(VIEW, N, { loHz: m.binToHz(VIEW, N, 40), hiHz: m.binToHz(VIEW, N, 60) });
    const wide = m.binRange(VIEW, N, all);
    const x = m.occupiedBandwidth(a, VIEW, tight, -100, 99);
    const y = m.occupiedBandwidth(a, VIEW, wide, -100, 99);
    near(x.widthHz, y.widthHz, 1e-6, 'same signal, two regions');
});

t('an empty patch of band has no occupied bandwidth', () => {
    const r = m.binRange(VIEW, N, all);
    assert.strictEqual(m.occupiedBandwidth(flat(-100), VIEW, r, -100, 99), null);
    // And a nonsense percentage is refused rather than divided by.
    const a = flat(-100); a[50] = -40;
    assert.strictEqual(m.occupiedBandwidth(a, VIEW, r, -100, 100), null);
    assert.strictEqual(m.occupiedBandwidth(a, VIEW, r, -100, 0), null);
});

// --- two tones ---------------------------------------------------------------

t('two tones give their shift, and a standard one is named', () => {
    const a = flat(-110);
    // 170 Hz apart at 10 Hz per bin: seventeen bins.
    for (const at of [40, 57]) {
        for (let i = -2; i <= 2; i++) a[at + i] = -110 + 45 - Math.abs(i) * 8;
    }
    const r = m.binRange(VIEW, N, all);
    const f = m.fskShift(a, VIEW, r);
    near(f.hz, 170, 1e-6, 'shift');
    assert.strictEqual(f.standard.hz, 170);
    assert.strictEqual(f.standard.name, 'RTTY');
    assert.strictEqual(f.tones.length, 2);
    assert.ok(f.tones[0].hz < f.tones[1].hz, 'tones come back in frequency order');
});

t('a shift nobody standardised is reported as itself', () => {
    const a = flat(-110);
    for (const at of [30, 60]) {
        for (let i = -2; i <= 2; i++) a[at + i] = -110 + 45 - Math.abs(i) * 8;
    }
    const f = m.fskShift(a, VIEW, m.binRange(VIEW, N, all));
    near(f.hz, 300, 1e-6, 'shift');
    assert.strictEqual(f.standard, null);
});

t('one tone is not a shift', () => {
    const a = wedge(50, 45, 8, -110);
    assert.strictEqual(m.fskShift(a, VIEW, m.binRange(VIEW, N, all)), null);
    assert.strictEqual(m.fskShift(flat(-110), VIEW, m.binRange(VIEW, N, all)), null);
});

// --- what a chart is drawn from ----------------------------------------------

/** A run whose history holds a known series, one point per second. */
const runOf = (values, key = 'snrDb') => {
    const run = m.newRun(0);
    values.forEach((v, i) => {
        m.accumulate(run, {
            snrDb: key === 'snrDb' ? v : 20,
            powerDb: -50,
            peakDb: -40,
            floorDb: -100,
            medianDb: -90,
            crestDb: 6,
            flatnessDb: -3,
            peakHz: key === 'peakHz' ? v : 14_200_000,
        }, i * 1000, { width: key === 'widthHz' ? { widthHz: v } : null });
    });
    return run;
};

t('a series is one reading out of the history, in time order', () => {
    const run = runOf([1, 2, 3]);
    assert.deepStrictEqual(m.seriesOf(run, 'snrDb').map((p) => p.v), [1, 2, 3]);
    assert.deepStrictEqual(m.seriesOf(run, 'snrDb').map((p) => p.t), [0, 1000, 2000]);
    // Every reading a card can chart is kept, not just the two that had one.
    assert.deepStrictEqual(m.seriesOf(run, 'floorDb').map((p) => p.v), [-100, -100, -100]);
});

t('a reading that could not be taken is missing from its series, not zero', () => {
    // A width that was unmeasurable for a second must not draw a line down to
    // zero and back — that is a picture of something that did not happen.
    const run = m.newRun(0);
    const frame = { snrDb: 20, powerDb: -50, peakDb: -40, floorDb: -100, medianDb: -90, crestDb: 6, flatnessDb: -3, peakHz: 1 };
    m.accumulate(run, frame, 0, { width: { widthHz: 2400 } });
    m.accumulate(run, frame, 1000, { width: null });
    m.accumulate(run, frame, 2000, { width: { widthHz: 2600 } });
    assert.deepStrictEqual(m.seriesOf(run, 'widthHz').map((p) => p.v), [2400, 2600]);
    assert.strictEqual(m.seriesOf(run, 'widthHz').length, 2);
    assert.strictEqual(m.seriesOf(null, 'widthHz').length, 0);
});

t('an axis never draws weather: a steady reading gets the floor, not its own noise', () => {
    // The failure: auto-scaling a line that has moved by a tenth of a decibel
    // fills the box with what looks like a fade.
    const steady = m.axisFor([20, 20.05, 19.95], 10);
    assert.ok(steady.hi - steady.lo >= 10, `axis collapsed to ${steady.hi - steady.lo}`);
    assert.ok(Math.abs((steady.lo + steady.hi) / 2 - 20) < 1e-9, 'centred on the reading');
    // A reading that does move gets its own range, with a little air.
    const moving = m.axisFor([0, 100], 10);
    assert.ok(moving.lo < 0 && moving.hi > 100);
    assert.strictEqual(moving.mid, null, 'no reference line unless one was asked for');
});

t('a deviation axis is symmetric about its reference, so up and down read alike', () => {
    // 30 Hz above the mean and 5 below: the axis has to reach 30 either way, or
    // the same excursion drawn downwards would look smaller than upwards.
    const ax = m.axisFor([970, 1030, 995], 20, 1000);
    assert.strictEqual(ax.mid, 1000);
    assert.strictEqual(ax.hi - 1000, 1000 - ax.lo);
    assert.ok(ax.hi - 1000 >= 30);
    // Nothing to draw still gives a usable axis rather than a divide by zero.
    const empty = m.axisFor([], 20, 1000);
    assert.ok(empty.hi > empty.lo);
});

t('a histogram buckets every value, top one included', () => {
    const h = m.histogram([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 10);
    assert.strictEqual(h.lo, 0);
    assert.strictEqual(h.hi, 10);
    // Eleven values into ten buckets: the 10 lands in the last one rather than
    // in an eleventh that does not exist.
    assert.strictEqual(h.counts.reduce((a, b) => a + b, 0), 11);
    assert.strictEqual(h.counts.length, 10);
    assert.strictEqual(h.counts[9], 2, '9 and 10 share the top bucket');
    assert.strictEqual(h.max, 2);
});

t('a histogram of one value is one bar, not a divide by zero', () => {
    const h = m.histogram([7, 7, 7], 8);
    assert.ok(h.hi > h.lo, 'widened so there is something to bucket into');
    assert.strictEqual(h.counts.reduce((a, b) => a + b, 0), 3);
    assert.strictEqual(m.histogram([]), null);
    assert.strictEqual(m.histogram([1, 2], 0), null);
});

t('a histogram tells a fading signal from an intermittent one', () => {
    // The whole reason this chart kind exists. These two have the same min, the
    // same max and nearly the same mean — the spread figures beside the card
    // describe them identically — and one is a signal that was there throughout
    // and faded, the other a signal that was there half the time.
    const fading = [];
    const onOff = [];
    for (let i = 0; i < 111; i++) {
        fading.push(2 + (i % 37));
        onOff.push(i % 2 ? 38 : 2);
    }
    const a = m.histogram(fading, 8);
    const b = m.histogram(onOff, 8);
    assert.strictEqual(a.lo, b.lo);
    assert.strictEqual(a.hi, b.hi);

    const filled = (h) => h.counts.filter((n) => n > 0).length;
    assert.strictEqual(filled(a), 8, `a fade fills the range: ${a.counts}`);
    assert.strictEqual(filled(b), 2, `on and off is two spikes: ${b.counts}`);
});

t('busy runs say when it was busy, which a percentage cannot', () => {
    // Busy, clear, busy — one long transmission and a keyed carrier are the same
    // percentage and not the same signal.
    const run = runOf([20, 20, 1, 1, 20]);
    const segs = m.busyRuns(run, 6, 5000);
    assert.deepStrictEqual(segs.map((r) => r.busy), [true, false, true]);
    assert.deepStrictEqual(segs.map((r) => [r.from, r.to]), [[0, 2000], [2000, 4000], [4000, 5000]]);
});

t('a run of one point still covers the interval it stands for', () => {
    // Each reading is a sample of a period up to the next one, and the last runs
    // to now — a zero-width block would flicker the newest state in and out.
    const segs = m.busyRuns(runOf([20]), 6, 1000);
    assert.deepStrictEqual(segs, [{ from: 0, to: 1000, busy: true }]);
    assert.deepStrictEqual(m.busyRuns(m.newRun(0), 6, 1000), []);
});

t('the occupancy threshold decides the runs, so changing it redraws them', () => {
    const run = runOf([4, 4, 4]);
    assert.deepStrictEqual(m.busyRuns(run, 6, 3000).map((r) => r.busy), [false]);
    assert.deepStrictEqual(m.busyRuns(run, 3, 3000).map((r) => r.busy), [true]);
});

// --- the gesture -------------------------------------------------------------

t('a press near an edge takes that edge, anchored on the far one', () => {
    const sel = { loHz: 1000, hiHz: 2000 };
    // Dragging an edge past the other must invert the region rather than
    // collapse it, which is what anchoring on the far edge gives.
    assert.deepStrictEqual(m.grabMode(sel, 1005, 20), { mode: 'edge', anchor: 2000 });
    assert.deepStrictEqual(m.grabMode(sel, 1995, 20), { mode: 'edge', anchor: 1000 });
    // Just outside the threshold is the inside of the region, not the edge.
    assert.strictEqual(m.grabMode(sel, 1030, 20).mode, 'move');
});

t('a press inside the region moves it rather than replacing it', () => {
    const sel = { loHz: 1000, hiHz: 2000 };
    assert.deepStrictEqual(m.grabMode(sel, 1500, 20), { mode: 'move', lo: 1000, hi: 2000 });
    // Which is the whole point: without it a region a pixel out could only be
    // redrawn from scratch, and a measurement could be started but never
    // adjusted.
    assert.strictEqual(m.grabMode(sel, 3000, 20).mode, 'new');
    assert.deepStrictEqual(m.grabMode(null, 3000, 20), { mode: 'new', anchor: 3000 });
});

t('a region narrower than two thresholds still has two edges', () => {
    // Both edges are inside each other's grab zone. The nearer one has to win,
    // or one edge would answer for every press and the region could only ever
    // be stretched one way.
    const sel = { loHz: 1000, hiHz: 1020 };
    assert.strictEqual(m.grabMode(sel, 1002, 50).anchor, 1020, 'near the low edge');
    assert.strictEqual(m.grabMode(sel, 1018, 50).anchor, 1000, 'near the high edge');
});

t('a region stored the other way round is the same region', () => {
    const sel = { loHz: 2000, hiHz: 1000 };
    assert.deepStrictEqual(m.grabMode(sel, 1005, 20), { mode: 'edge', anchor: 2000 });
    assert.strictEqual(m.grabMode(sel, 1500, 20).mode, 'move');
});

// --- over the run ------------------------------------------------------------

t('a spread is min, max, mean and a population sigma', () => {
    const s = m.newSpread();
    for (const v of [2, 4, 4, 4, 5, 5, 7, 9]) m.addSpread(s, v);
    const out = m.spreadOf(s);
    assert.strictEqual(out.n, 8);
    assert.strictEqual(out.min, 2);
    assert.strictEqual(out.max, 9);
    assert.strictEqual(out.mean, 5);
    assert.strictEqual(out.range, 7);
    // The textbook set: population sigma is exactly 2.
    near(out.sigma, 2, 1e-9, 'sigma');
});

t('a spread with nothing in it has no opinion, and ignores what is not a number', () => {
    assert.strictEqual(m.spreadOf(m.newSpread()), null);
    assert.strictEqual(m.spreadOf(null), null);
    const s = m.newSpread();
    m.addSpread(s, NaN);
    m.addSpread(s, Infinity);
    assert.strictEqual(m.spreadOf(s), null);
});

t('a run folds in each frame and counts the busy ones against the threshold', () => {
    const run = m.newRun(1000);
    const frame = (snrDb, powerDb = -50) => ({
        snrDb, powerDb, peakDb: -40, peakHz: 14_200_000, floorDb: -100,
    });
    m.accumulate(run, frame(2), 1000, { occupancyDb: 6 });
    m.accumulate(run, frame(9), 1100, { occupancyDb: 6 });
    m.accumulate(run, frame(20), 1200, { occupancyDb: 6 });
    assert.strictEqual(run.frames, 3);
    assert.strictEqual(run.occupied, 2);
    near(m.occupancyOf(run), 2 / 3, 1e-9, 'occupancy');
    assert.strictEqual(m.spreadOf(run.snr).max, 20);
});

t('nothing measured is not the same as a clear frequency', () => {
    // Zero would say "the band was empty the whole time", which is a claim; no
    // frames is the absence of one.
    assert.strictEqual(m.occupancyOf(m.newRun(0)), null);
    assert.strictEqual(m.occupancyOf(null), null);
    assert.strictEqual(m.drift(m.newRun(0)), null);
});

t('drift is how far the peak went, which is not how variable it was', () => {
    const run = m.newRun(0);
    for (const hz of [14_200_000, 14_200_010, 14_200_030, 14_200_020]) {
        m.accumulate(run, {
            snrDb: 20, powerDb: -50, peakDb: -40, peakHz: hz, floorDb: -100,
        }, 0, {});
    }
    const d = m.drift(run);
    assert.strictEqual(d.range, 30);
    assert.strictEqual(d.min, 14_200_000);
    assert.strictEqual(d.max, 14_200_030);
});

t('the headline width is only counted when there is one', () => {
    const run = m.newRun(0);
    const frame = { snrDb: 20, powerDb: -50, peakDb: -40, peakHz: 1, floorDb: -100 };
    m.accumulate(run, frame, 0, { width: null });
    m.accumulate(run, frame, 0, { width: { widthHz: 2400 } });
    m.accumulate(run, frame, 0, { width: { widthHz: 2600 } });
    assert.strictEqual(m.spreadOf(run.width).n, 2);
    assert.strictEqual(m.spreadOf(run.width).mean, 2500);
});

t('the chart\'s history is thinned, while the spreads are not', () => {
    // Every frame counts towards the min, the max and the occupancy — a maximum
    // that missed frames would not be one. The chart is a few hundred pixels
    // wide and does not need eight points per pixel.
    const run = m.newRun(0);
    const frame = { snrDb: 3, powerDb: -50, peakDb: -40, peakHz: 1, floorDb: -100 };
    for (let i = 0; i < 100; i++) m.accumulate(run, frame, i * 50, {});
    assert.strictEqual(run.frames, 100);
    assert.strictEqual(m.spreadOf(run.snr).n, 100);
    // Five seconds of frames, one point every 250 ms: t = 0, 250 … 4750.
    assert.strictEqual(run.history.length, 20);
});

t('history keeps one point past the window, so the trace has an edge to arrive from', () => {
    const run = m.newRun(0);
    const frame = { snrDb: 1, powerDb: -50, peakDb: -40, peakHz: 1, floorDb: -100 };
    for (let i = 0; i <= 10; i++) m.accumulate(run, frame, i * 1000, {});
    m.trimHistory(run, 10_000, 5000);
    // The cutoff is t = 5000. Points at 5000..10000 are in view; the one at
    // 4000 is kept because the segment crossing the edge starts there.
    assert.strictEqual(run.history[0].t, 4000);
    assert.strictEqual(run.history[run.history.length - 1].t, 10_000);
});

// --- one published reading ---------------------------------------------------

// A signal worth measuring: a wedge on a floor, in a region drawn round it.
// Slope 1 dB/bin, so it fills most of the view and the −60 dB skirt cannot be
// seen inside the region — which is the interesting case for the flags.
const SIGNAL = wedge(50, 40, 1);
const AROUND = { loHz: m.binToHz(VIEW, N, 30), hiHz: m.binToHz(VIEW, N, 70) };

// And one narrow enough to leave a real noise floor either side of it, for the
// figures that are measured against one.
const NARROW = wedge(50, 40, 4);
const CLOSE = { loHz: m.binToHz(VIEW, N, 40), hiHz: m.binToHz(VIEW, N, 60) };

t('a reading carries the frame, the widths, and what the settings asked for', () => {
    const r = m.readingOf(SIGNAL, VIEW, AROUND, { xDb: [3, 6], obw: 99, averageMs: 1000 }, null, 5);
    assert.strictEqual(r.reason, 'ok');
    assert.strictEqual(r.at, 5);
    assert.strictEqual(r.rbw, 10);
    assert.strictEqual(r.averageMs, 1000);
    assert.deepStrictEqual(r.widths.map((w) => w.downDb), [3, 6]);
    assert.ok(r.obw, 'the occupied bandwidth was asked for');
    assert.strictEqual(r.obw.percent, 99);
    // The shape factor's pair is measured whether or not it is being drawn —
    // neither 6 nor 60 has to be in xDb for the ratio to be a number in the
    // panel. Here the −60 dB skirt runs out of the region, so it is a bound.
    assert.ok(r.shape, 'a shape factor even though 60 is not in xDb');
    assert.strictEqual(r.shape.clipped, true);
});

t('the headline width is the narrowest asked for, and −6 dB when none are', () => {
    const three = m.readingOf(SIGNAL, VIEW, AROUND, { xDb: [6, 20, 3] }, null, 0);
    assert.strictEqual(three.headline.downDb, 3);
    // Every level switched off is a decision about the picture. The run still
    // has to follow *a* width, or a line in the panel disappears with the lines
    // on the spectrum.
    const none = m.readingOf(SIGNAL, VIEW, AROUND, { xDb: [] }, null, 0);
    assert.deepStrictEqual(none.widths, []);
    assert.strictEqual(none.headline.downDb, 6);
});

t('there is an entry for every level asked for, measurable or not', () => {
    // The panel draws a row per entry, so a level that dropped out of this list
    // on one frame and came back on the next took its row's height with it and
    // jumped everything below. Whoever draws callipers filters the list; the
    // list itself keeps a place.
    for (const xDb of [[3], [3, 6, 20], [3, 6, 20, 26, 60]]) {
        const r = m.readingOf(SIGNAL, VIEW, AROUND, { xDb }, null, 0);
        assert.deepStrictEqual(r.widths.map((w) => w.downDb), xDb);
    }
    // ...on an empty patch of band as much as on a signal.
    const quiet = m.readingOf(flat(-100), VIEW, all, { xDb: [3, 6, 20] }, null, 0);
    assert.deepStrictEqual(quiet.widths.map((w) => w.downDb), [3, 6, 20]);
});

t('an unmeasurable width is a null, not a zero', () => {
    // formatSpan(null) is "0 Hz", so a missing width that reached the readout as
    // a null field would print as a measurement of nothing at all. The report
    // says it in words for the same reason.
    const entry = { downDb: 60, loHz: null, hiHz: null, widthHz: null, clipped: false };
    const r = { ...m.readingOf(SIGNAL, VIEW, AROUND, { xDb: [] }, null, 0), widths: [entry] };
    const text = m.reportLines(r, { at: 0 }).join('\n');
    assert.ok(/−60 dB width: not measurable/.test(text), text);
    assert.ok(!/−60 dB width: 0 Hz/.test(text), 'a null width must never read as zero');
});

t('each way of having no reading says which one it is', () => {
    const off = m.readingOf(SIGNAL, VIEW, { loHz: BASE - 9000, hiHz: BASE - 8000 }, {}, null, 0);
    assert.strictEqual(off.reason, 'outside');
    assert.strictEqual(off.stats, null);
    assert.deepStrictEqual(off.widths, []);

    const tiny = m.readingOf(SIGNAL, VIEW, { loHz: BASE, hiHz: BASE + 10 }, {}, null, 0);
    assert.strictEqual(tiny.reason, 'narrow');
    assert.strictEqual(tiny.bins, 2);

    assert.strictEqual(m.readingOf(null, VIEW, AROUND, {}, null, 0).reason, 'nodata');
    assert.strictEqual(m.readingOf(SIGNAL, VIEW, null, {}, null, 0).reason, 'nodata');
});

t('the frame half and the whole reading agree, and handing one on changes nothing', () => {
    const settings = { xDb: [3, 6], obw: 90 };
    const frame = m.frameStats(SIGNAL, VIEW, AROUND, settings);
    const a = m.readingOf(SIGNAL, VIEW, AROUND, settings, null, 7);
    const b = m.readingOf(SIGNAL, VIEW, AROUND, settings, null, 7, frame);
    assert.deepStrictEqual(b.stats, a.stats);
    assert.deepStrictEqual(b.headline, a.headline);
    assert.deepStrictEqual(b.widths, a.widths);
    // ...and the frame half is the same measurement the whole one reports.
    assert.strictEqual(frame.headline.downDb, 3);
    assert.deepStrictEqual(frame.stats, a.stats);
});

t('a frame with nothing to measure still says what the range was', () => {
    const f = m.frameStats(SIGNAL, VIEW, { loHz: BASE, hiHz: BASE + 10 }, {});
    assert.strictEqual(f.stats, null);
    assert.strictEqual(f.headline, null);
    assert.strictEqual(f.range.bins, 2);
});

// --- the reading, as text ----------------------------------------------------

t('the report says nothing when there is nothing to say', () => {
    assert.deepStrictEqual(m.reportLines(null), []);
    assert.deepStrictEqual(m.reportLines({ stats: null }), []);
});

t('the report carries its units, its caveats and its sample size', () => {
    const run = m.newRun(1000);
    const r = m.readingOf(NARROW, VIEW, CLOSE, { xDb: [3, 6, 60], obw: 99 }, run, 61_000);
    for (let i = 0; i < 10; i++) m.accumulate(run, r.stats, 1000 + i * 100, { width: r.headline });
    const text = m.reportLines(r, {
        tuning: { frequency: 14_199_990 }, at: 61_000,
    }).join('\n');

    assert.ok(/^Measure 1970-01-01 00:01:01Z$/m.test(text), `no stable header:\n${text}`);
    assert.ok(/Width: /.test(text), 'no width');
    assert.ok(/SNR: 40\.0 dB/.test(text), `SNR should be the wedge's 40 dB:\n${text}`);
    // An uncalibrated level must never be printed as though it were absolute.
    assert.ok(/Peak level|dB rel/.test(text), 'levels must be marked relative');
    assert.ok(/uncalibrated/.test(text), 'the caveat has to travel with the numbers');
    // The dial is 10 Hz below the peak.
    assert.ok(/Peak vs dial: \+10 Hz/.test(text), `offset wrong:\n${text}`);
    // A −60 dB skirt that ran out of the region is a bound, not a value.
    assert.ok(/−60 dB width: >/.test(text), `a clipped width must be marked:\n${text}`);
    assert.ok(/Run: 60 s, 10 frames/.test(text), `no sample size:\n${text}`);
    assert.ok(/Occupancy: 100%/.test(text), `no occupancy:\n${text}`);
});

t('the report is the same text for the same reading', () => {
    const r = m.readingOf(SIGNAL, VIEW, AROUND, {}, null, 42);
    const a = m.reportLines(r, { at: 42 }).join('\n');
    const b = m.reportLines(r, { at: 42 }).join('\n');
    assert.strictEqual(a, b);
});

// --- the store ---------------------------------------------------------------

t('the state store tells its listeners once, and only when something changed', () => {
    tool.resetMeasure();
    let calls = 0;
    const off = tool.onMeasureState(() => { calls++; });
    tool.setMeasureState({ active: true });
    assert.strictEqual(calls, 1);
    tool.setMeasureState({ active: true });
    assert.strictEqual(calls, 1, 'writing the same value should say nothing');
    tool.setMeasureState({ drawing: true });
    assert.strictEqual(calls, 2);
    off();
    tool.setMeasureState({ active: false });
    assert.strictEqual(calls, 2, 'an unsubscribed listener stays unsubscribed');
});

t('a region is normalised, and a zero-width one is not a region', () => {
    tool.resetMeasure();
    tool.setSelection({ loHz: 200, hiHz: 100 });
    assert.deepStrictEqual(tool.measureState().selection, { loHz: 100, hiHz: 200 });
    tool.setSelection({ loHz: 100, hiHz: 100 });
    assert.deepStrictEqual(tool.measureState().selection, { loHz: 100, hiHz: 200 },
        'a tap must not destroy the region');
    tool.setSelection(null);
    assert.strictEqual(tool.measureState().selection, null);
    tool.setSelection({ loHz: NaN, hiHz: 5 });
    assert.strictEqual(tool.measureState().selection, null);
});

t('starting keeps the region and drops the run; stopping keeps both', () => {
    tool.resetMeasure();
    tool.setSelection({ loHz: 100, hiHz: 200 });
    tool.setMeasureResult({ stats: { snrDb: 12 } });
    tool.startMeasure();
    assert.strictEqual(tool.measureState().active, true);
    assert.deepStrictEqual(tool.measureState().selection, { loHz: 100, hiHz: 200 },
        'Start again should carry on, not throw the region away');
    assert.strictEqual(tool.measureResult(), null, 'a new run starts with no reading');

    tool.setMeasureResult({ stats: { snrDb: 12 } });
    tool.stopMeasure();
    assert.strictEqual(tool.measureState().active, false);
    assert.ok(tool.measureResult(), 'stopping is how you read it, so the reading stays');
    assert.ok(tool.measureState().selection);

    tool.clearMeasure();
    assert.strictEqual(tool.measureState().selection, null);
    assert.strictEqual(tool.measureResult(), null);
});

t('freezing is a flag on the state, so the engine can stop counting too', () => {
    tool.resetMeasure();
    tool.setMeasureFrozen(true);
    assert.strictEqual(tool.measureState().frozen, true);
    // Starting again unfreezes: a frozen tool that had just been started would
    // look broken.
    tool.startMeasure();
    assert.strictEqual(tool.measureState().frozen, false);
});

// --- settings ----------------------------------------------------------------

t('settings fall back field by field rather than all at once', () => {
    const d = tool.cleanSettings(null);
    assert.deepStrictEqual(d.xDb, m.DEFAULT_X_DB);
    assert.strictEqual(d.obw, m.DEFAULT_OBW);
    assert.strictEqual(d.expanded, 'snr');
    // One bad field must not take the good ones with it.
    const s = tool.cleanSettings({ obw: 12345, xDb: [6, 3], expanded: 'width' });
    assert.strictEqual(s.obw, m.DEFAULT_OBW);
    assert.deepStrictEqual(s.xDb, [3, 6], 'kept, sorted');
    assert.strictEqual(s.expanded, 'width');
});

t('the open card is whatever was stored, including nothing', () => {
    // No vocabulary is enforced: the ids are the panel's, and a stored answer to
    // a question that no longer exists should open nothing rather than being
    // corrected into a default nobody chose.
    assert.strictEqual(tool.cleanSettings({ expanded: '' }).expanded, '');
    assert.strictEqual(tool.cleanSettings({ expanded: 'a-card-this-build-dropped' }).expanded,
        'a-card-this-build-dropped');
    assert.strictEqual(tool.cleanSettings({ expanded: 7 }).expanded, 'snr', 'not a string, so not an answer');
});

t('somebody who had switched the old strip off gets no card open', () => {
    // The chart used to be one strip along the bottom with a switch. "Off" was a
    // real choice and its honest translation is "no card open", not the default.
    assert.strictEqual(tool.cleanSettings({ chart: false }).expanded, '');
    assert.strictEqual(tool.cleanSettings({ chart: true }).expanded, 'snr');
    // ...and only where nothing newer has been stored.
    assert.strictEqual(tool.cleanSettings({ chart: false, expanded: 'snr' }).expanded, 'snr');
});

t('no widths at all is a choice; a vocabulary this build has none of is not', () => {
    assert.deepStrictEqual(tool.cleanSettings({ xDb: [] }).xDb, []);
    assert.deepStrictEqual(tool.cleanSettings({ xDb: [7, 13] }).xDb, m.DEFAULT_X_DB);
    assert.deepStrictEqual(tool.cleanSettings({ xDb: [3, 3, 6] }).xDb, [3, 6], 'deduped');
    assert.deepStrictEqual(tool.cleanSettings({ xDb: 'three' }).xDb, m.DEFAULT_X_DB);
});

t('the occupancy threshold is clamped to something a receiver could mean', () => {
    assert.strictEqual(tool.cleanSettings({ occupancyDb: -5 }).occupancyDb, 0);
    assert.strictEqual(tool.cleanSettings({ occupancyDb: 900 }).occupancyDb, 40);
    assert.strictEqual(tool.cleanSettings({ occupancyDb: 'x' }).occupancyDb, m.DEFAULT_OCCUPANCY_DB);
});

t('settings persist and reach the other copy of the panel', () => {
    tool.resetMeasure();
    let seen = null;
    const off = tool.onMeasureSettings((s) => { seen = s; });
    tool.saveMeasureSettings({ obw: 90 });
    assert.strictEqual(seen.obw, 90);
    assert.strictEqual(tool.measureSettings().obw, 90);
    assert.strictEqual(JSON.parse(store['ubersdr.v2.measure']).obw, 90);
    off();
    tool.saveMeasureSettings({ obw: 99 });
    assert.strictEqual(seen.obw, 90, 'unsubscribed');
});

console.log(`\n${pass} passed`);

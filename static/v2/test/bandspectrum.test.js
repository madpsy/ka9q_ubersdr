// The band spectrum panel's arithmetic: the wire format, and the auto range.
//
// The frames are real ones, captured from a receiver's
// /api/noisefloor/spectrum/stream for 40m — a format this side only reads, so a
// fixture from the thing that writes it is worth more than one I made up.
//
// The auto range is the part with teeth. Fitting a scale to a frame is two
// percentiles; the work here is all about *not* moving it — a scale that
// re-fits every frame makes the display breathe and recolours the waterfall
// several times a second, which is unreadable. So the tests are mostly about
// what does not happen.

const assert = require('assert');
const {
    AUTO_DEADBAND, AUTO_MIN_INTERVAL, AUTO_RESEED_DB, AUTO_SPAN_DEFAULT, AUTO_STEP,
    FT8_SPAN_HZ, applyFrame, bandsFromConfig, binAt, clampDb, createAutoRange, dbFromByte,
    decodeFrame, formatAgeSec, formatDb, formatMHz, fracOfHz, ft8Window, hzAt, rangeOf,
    rowAt, savedPrefs, scaleDecimals, scaleTickCount, scaleTicks, updateAutoRange,
    validValues, SCALE_LABEL_PX, SCALE_MAX_TICKS,
    FULL_ZOOM, ZOOM_FACTOR, ZOOM_MIN_SPAN, bandFrac, dialWindow, isZoomed, panByFraction,
    viewFrac, zoomAt, zoomBins, zoomHz,
} = require('./.build/bandspectrum.cjs');
const SAMPLE = require('./bandspectrum.sample.json');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// ── Wire format ──────────────────────────────────────────────────────────────

t('a full frame carries one byte per bin, behind a 22-byte header', () => {
    const f = decodeFrame(SAMPLE.full);
    assert.strictEqual(f.flags, 0x03);
    assert.strictEqual(f.payload.length, SAMPLE.bin_count);
});

t('the bytes are dBFS with 256 subtracted, and read as a noise floor', () => {
    const f = decodeFrame(SAMPLE.full);
    const db = Array.from(f.payload).map(dbFromByte);
    // A real 40m frame: everything below 0 dBFS, nothing at the encoder's floor,
    // and a noise floor somewhere sane for an HF receiver.
    assert.ok(Math.max(...db) < 0, `peak ${Math.max(...db)}`);
    assert.ok(Math.min(...db) > -180, `floor ${Math.min(...db)}`);
    const sorted = [...db].sort((a, b) => a - b);
    const median = sorted[Math.floor(db.length / 2)];
    assert.ok(median > -140 && median < -80, `median ${median}`);
});

t('a delta frame changes only the bins it names', () => {
    const bins = applyFrame(null, decodeFrame(SAMPLE.full), SAMPLE.bin_count);
    const before = Uint8Array.from(bins);
    const after = applyFrame(bins, decodeFrame(SAMPLE.delta), SAMPLE.bin_count);
    assert.strictEqual(after, bins, 'applied in place');

    let changed = 0;
    for (let i = 0; i < after.length; i++) if (after[i] !== before[i]) changed++;
    // The count in the frame is an upper bound: a delta may resend a bin with
    // the value it already had.
    const payload = decodeFrame(SAMPLE.delta).payload;
    const named = payload[0] | (payload[1] << 8);
    assert.ok(changed > 0, 'a delta that changed nothing is not a useful fixture');
    assert.ok(changed <= named, `${changed} changed, ${named} named`);
    assert.ok(named < SAMPLE.bin_count, 'a delta smaller than a full frame is the point');
});

t('a delta arriving before any full frame is dropped, not applied to nothing', () => {
    assert.strictEqual(applyFrame(null, decodeFrame(SAMPLE.delta), SAMPLE.bin_count), null);
});

t('a full frame of the wrong width is refused', () => {
    // The band was reconfigured under a live stream: better to hold the last
    // good frame than to draw half a band.
    assert.strictEqual(applyFrame(null, decodeFrame(SAMPLE.full), 512), null);
});

t('rubbish on the wire decodes to nothing rather than throwing', () => {
    assert.strictEqual(decodeFrame(''), null);
    assert.strictEqual(decodeFrame('not base64 at all!!'), null);
    assert.strictEqual(decodeFrame(Buffer.from('NOPE' + 'x'.repeat(30)).toString('base64')), null);
});

t('the bands are the ones with a dedicated FFT', () => {
    const bands = bandsFromConfig({
        bands: [{ name: '40m', bin_count: 400 }, { name: '20m', bin_count: 700 }],
        wideband: { bin_count: 4096 },
    });
    assert.deepStrictEqual(Object.keys(bands), ['40m', '20m']);
    assert.strictEqual(bands['40m'].bin_count, 400);
    // Wideband is not one of them: it is the main waterfall's own view.
    assert.strictEqual(bands.wideband, undefined);
    assert.deepStrictEqual(bandsFromConfig(null), {});
});

// ── Auto range ───────────────────────────────────────────────────────────────

// A frame of `n` bins at the noise floor with a few signals on top of it.
const frame = (floorDb, peakDb, n = 400) => {
    const bins = new Uint8Array(n);
    for (let i = 0; i < n; i++) bins[i] = floorDb + 256 + (i % 3);
    for (let i = 0; i < 4; i++) bins[10 + i * 40] = peakDb + 256;
    return bins;
};
const feed = (st, bins, now) => updateAutoRange(st, validValues(bins), validValues(bins).length, now);

t('the first frame seeds the range rather than ramping to it', () => {
    // Switching auto on should not show a settling slide.
    const st = createAutoRange();
    assert.strictEqual(feed(st, frame(-120, -60), 1000), true);
    assert.ok(st.min <= -120 && st.min >= -132, `floor ${st.min}`);
    assert.ok(st.max >= -60 && st.max <= -40, `ceiling ${st.max}`);
    // Number.isInteger rather than %: -126 % 2 is -0, which is not 0 to
    // strictEqual and has nothing to do with the lattice.
    assert.ok(Number.isInteger(st.min / AUTO_STEP), `floor off the step lattice: ${st.min}`);
    assert.ok(Number.isInteger(st.max / AUTO_STEP), `ceiling off the step lattice: ${st.max}`);
});

t('the scale does not move for an unchanged band', () => {
    const st = createAutoRange();
    feed(st, frame(-120, -60), 0);
    const { min, max } = st;
    let moves = 0;
    for (let i = 1; i <= 400; i++) if (feed(st, frame(-120, -60), i * 250)) moves++;
    assert.strictEqual(moves, 0, 'a steady band re-fitted its scale');
    assert.strictEqual(st.min, min);
    assert.strictEqual(st.max, max);
});

t('a burst of traffic does not drag the scale with it', () => {
    // The failure this prevents: a strong signal appears, the ceiling chases it,
    // the whole waterfall recolours, and it all comes back when the signal
    // stops. The ceiling may rise; the floor must not follow.
    const st = createAutoRange();
    feed(st, frame(-120, -60), 0);
    const floor = st.min;
    for (let i = 1; i <= 40; i++) feed(st, frame(-120, -20), i * 250);
    assert.strictEqual(st.min, floor, 'the floor moved under traffic');
});

t('nothing moves faster than one step per interval', () => {
    const st = createAutoRange();
    feed(st, frame(-120, -60), 0);
    const before = st.min;
    // Same instant, many frames: the interval alone must hold it.
    for (let i = 0; i < 50; i++) feed(st, frame(-90, -30), 10);
    assert.strictEqual(st.min, before);
});

t('a genuine shift is walked to, a step at a time', () => {
    const st = createAutoRange();
    feed(st, frame(-120, -60), 0);
    const start = st.min;
    let now = 0;
    // Long enough for the floor EMA (≈50 s at 4 Hz) to have travelled.
    for (let i = 0; i < 4000; i++) { now += 250; feed(st, frame(-100, -60), now); }
    assert.ok(st.min > start, `floor did not follow the band: ${start} → ${st.min}`);
    assert.ok(st.min <= -100 + 1, `floor overshot the new noise: ${st.min}`);
});

t('a scale that is simply wrong re-seeds instead of walking for minutes', () => {
    const st = createAutoRange();
    feed(st, frame(-120, -60), 0);
    // A shift bigger than AUTO_RESEED_DB, sustained.
    let now = 0;
    let jumped = false;
    for (let i = 0; i < 2000 && !jumped; i++) {
        now += 250;
        const before = st.min;
        feed(st, frame(-60, -20), now);
        if (Math.abs(st.min - before) > AUTO_STEP) jumped = true;
    }
    assert.ok(jumped, `no re-seed within ${AUTO_RESEED_DB} dB of drift`);
});

t('the deadband is wider than the step, so a move cannot re-trigger itself', () => {
    // This is the property that makes the walk settle rather than oscillate.
    assert.ok(AUTO_DEADBAND > AUTO_STEP);
    assert.ok(AUTO_MIN_INTERVAL >= 1000);
});

t('bins at the encoder floor are not measurements', () => {
    // They appear when the source has no data and when a full-scale signal wraps
    // the encoder. Averaging them in is what sent the range on a walk to −256.
    const bins = frame(-120, -60);
    for (let i = 0; i < 40; i++) bins[i] = 0;          // 10% at the hard floor
    const valid = validValues(bins);
    assert.strictEqual(valid.length, bins.length - 40);
    assert.ok(valid[0] > -200, `floor bins survived: ${valid[0]}`);

    // A frame that is almost all floor updates nothing at all.
    const dead = new Uint8Array(400);
    assert.strictEqual(validValues(dead), null);
    assert.strictEqual(validValues(null), null);
});

// ── The applied range ────────────────────────────────────────────────────────

t('manual mode is the operator\'s two numbers, whichever way round', () => {
    const st = createAutoRange();
    assert.deepStrictEqual(rangeOf(false, st, { min: -120, max: -60 }), { lo: -120, hi: -60 });
    assert.deepStrictEqual(rangeOf(false, st, { min: -60, max: -120 }), { lo: -120, hi: -60 });
});

t('auto falls back to the manual pair until it has a frame', () => {
    assert.deepStrictEqual(rangeOf(true, createAutoRange(), { min: -120, max: -60 }),
        { lo: -120, hi: -60 });
});

t('the guaranteed span widens upward, never lifting the floor', () => {
    // A dead-quiet band would otherwise be drawn on a 4 dB scale, which is a
    // waterfall of pure noise texture.
    const st = createAutoRange();
    feed(st, frame(-120, -118), 0);
    const r = rangeOf(true, st, { min: -120, max: -60 });
    assert.strictEqual(r.lo, st.min, 'the floor is the anchor');
    assert.strictEqual(r.hi - r.lo, AUTO_SPAN_DEFAULT);
});

t('preferences survive having nowhere to store them', () => {
    // No localStorage in node, and none in a private window either.
    const p = savedPrefs();
    assert.strictEqual(p.auto, true);
    assert.ok(p.min < p.max);
    assert.strictEqual(clampDb(-999), -160);
    assert.strictEqual(clampDb(50), 0);
    assert.strictEqual(clampDb('-73.4'), -73);
    assert.strictEqual(clampDb('rubbish'), 0);
});

// ── Reading the chart ────────────────────────────────────────────────────────

const META40 = { name: '40m', start: 7000000, end: 7200000, bin_count: 400, ft8_frequency: 7074000 };

t('frequency comes from the band edges, not from a bin index', () => {
    // A reading taken as binIndex x bin_bandwidth drifts further off the further
    // across the band you are — the two conventions disagree by a bin.
    assert.strictEqual(hzAt(META40, 0), 7000000);
    assert.strictEqual(hzAt(META40, 0.5), 7100000);
    assert.strictEqual(hzAt(META40, 1), 7200000);
    assert.strictEqual(hzAt(META40, 0.37), 7074000);
});

t('a pointer off either end of the chart still reads a frequency in the band', () => {
    assert.strictEqual(hzAt(META40, -3), 7000000);
    assert.strictEqual(hzAt(META40, 4), 7200000);
    assert.strictEqual(binAt(400, -1), 0);
    assert.strictEqual(binAt(400, 2), 399);
    assert.strictEqual(binAt(400, 0.5), 200);
});

t('the waterfall reads the row under the pointer, newest at the top', () => {
    // Rows are held oldest-first and drawn newest-first, and getting that
    // backwards reads a value from 20 minutes ago as if it were now.
    const rows = 100;
    assert.strictEqual(rowAt(rows, 0, rows), rows - 1, 'the top row is the newest');
    assert.strictEqual(rowAt(rows, 0.999, rows), 0, 'the bottom row is the oldest');
    // A part-full history is drawn from the top, so the visible span is the
    // ring's, not the history's.
    assert.strictEqual(rowAt(10, 0, 220), 9);
    assert.strictEqual(rowAt(0, 0.5, 220), -1);
});

t('the FT8 window is the dial frequency and the 3 kHz above it', () => {
    const w = ft8Window(META40);
    assert.strictEqual(w.hz, 7074000);
    assert.ok(Math.abs(w.start - 0.37) < 1e-9, `${w.start}`);
    assert.ok(Math.abs(w.end - fracOfHz(META40, 7074000 + FT8_SPAN_HZ)) < 1e-12);
    assert.ok(w.end > w.start);
});

t('a band with no FT8 frequency configured gets no marker', () => {
    // 2200m and 630m on a real receiver report 0.
    assert.strictEqual(ft8Window({ ...META40, ft8_frequency: 0 }), null);
    assert.strictEqual(ft8Window({ ...META40, ft8_frequency: undefined }), null);
    assert.strictEqual(ft8Window(null), null);
});

t('an FT8 frequency outside the recorded span is not drawn at the edge', () => {
    // The recorder covers 7.0-7.2; a marker at 7.25 belongs to nothing on
    // screen, and clamping it would put a green line on a signal it is not.
    assert.strictEqual(ft8Window({ ...META40, ft8_frequency: 7250000 }), null);
    assert.strictEqual(ft8Window({ ...META40, ft8_frequency: 6900000 }), null);
});

t('the readout reads as a measurement', () => {
    // Four decimals: the bins are 500 Hz apart on this band, and 7.074 MHz
    // would round two of them onto the same reading.
    assert.strictEqual(formatMHz(7074000), '7.0740 MHz');
    assert.strictEqual(formatMHz(7074500), '7.0745 MHz');
    assert.strictEqual(formatDb(-117.25), '-117.3 dBFS');
    assert.strictEqual(formatAgeSec(0), 'now');
    assert.strictEqual(formatAgeSec(1), '1 s ago');
    assert.strictEqual(formatAgeSec(59), '59 s ago');
    assert.strictEqual(formatAgeSec(60), '1 min ago');
    assert.strictEqual(formatAgeSec(95), '1 min 35 s ago');
});

// ── The frequency strip ──────────────────────────────────────────────────────

t('the strip has as many labels as it has room for, and no more', () => {
    assert.strictEqual(scaleTickCount(0), 2, 'before it has been measured');
    assert.strictEqual(scaleTickCount(120), 2);
    assert.strictEqual(scaleTickCount(300), 4);
    assert.strictEqual(scaleTickCount(2000), SCALE_MAX_TICKS, 'a wide panel is not a ruler');
    // Whatever the width, no two labels are closer than one label's width.
    for (const w of [90, 140, 210, 300, 480, 900]) {
        const ticks = scaleTicks(META40, w);
        const gapPx = (w * (ticks[1].pct - ticks[0].pct)) / 100;
        assert.ok(gapPx >= SCALE_LABEL_PX - 1, `${w}px: labels ${gapPx.toFixed(0)}px apart`);
    }
});

t('both ends of the band are labelled, and pushed inward to stay readable', () => {
    const ticks = scaleTicks(META40, 300);
    assert.strictEqual(ticks[0].hz, 7000000);
    assert.strictEqual(ticks[ticks.length - 1].hz, 7200000);
    assert.strictEqual(ticks[0].align, 'start');
    assert.strictEqual(ticks[ticks.length - 1].align, 'end');
    assert.ok(ticks.slice(1, -1).every((k) => k.align === 'center'));
    assert.strictEqual(ticks[0].pct, 0);
    assert.strictEqual(ticks[ticks.length - 1].pct, 100);
});

t('the labels carry enough decimals to be different numbers', () => {
    // 40m's ticks are whole hundreds of kHz, so one decimal states them exactly
    // and there is no reason to print three.
    assert.deepStrictEqual(scaleTicks(META40, 210).map((k) => k.label),
        ['7.0', '7.1', '7.2']);
    // 20m's middle tick lands on 14.175, which one decimal would print as a
    // frequency that is not there.
    assert.deepStrictEqual(scaleTicks({ start: 14000000, end: 14350000 }, 210).map((k) => k.label),
        ['14.000', '14.175', '14.350']);
    // ...and 30m is 50 kHz wide, where two decimals would print 10.10 twice.
    const m30 = { start: 10100000, end: 10150000 };
    assert.deepStrictEqual(scaleTicks(m30, 210).map((k) => k.label),
        ['10.100', '10.125', '10.150']);
    // 2200m is 2.1 kHz wide and still gets distinct labels rather than a unit
    // change nobody asked for.
    const m2200 = { start: 135700, end: 137800 };
    const labels = scaleTicks(m2200, 210).map((k) => k.label);
    assert.strictEqual(new Set(labels).size, labels.length, labels.join(' '));
});

t('every band the receiver records gets a strip that reads', () => {
    const bands = [
        [135700, 137800], [472000, 479000], [1800000, 2000000], [3500000, 4000000],
        [5250000, 5450000], [7000000, 7200000], [10100000, 10150000], [14000000, 14350000],
        [18068000, 18168000], [21000000, 21450000], [24890000, 24990000], [28000000, 28300000],
    ];
    for (const [start, end] of bands) {
        for (const w of [140, 300, 520]) {
            const labels = scaleTicks({ start, end }, w).map((k) => k.label);
            assert.strictEqual(new Set(labels).size, labels.length,
                `${start}-${end} at ${w}px: ${labels.join(' ')}`);
            assert.ok(labels.every((l) => !/[A-Za-z]/.test(l)), 'no unit on the strip');
        }
    }
});

t('a label never states a frequency the tick is not on', () => {
    // Distinctness alone would print this band as 7.0 / 7.1 / 7.2, and its top
    // end is 7.199 — a band edge that does not exist.
    // The middle tick of this odd band is 7.0995, and the labels say so rather
    // than rounding three real frequencies onto 7.0 / 7.1 / 7.2.
    assert.deepStrictEqual(scaleTicks({ start: 7000000, end: 7199000 }, 210).map((k) => k.label),
        ['7.0000', '7.0995', '7.1990']);

    // In general: every label is its tick to within half of the last place it
    // prints, so it can be read as a frequency rather than as an approximation.
    for (const [start, end] of [[7000000, 7199000], [3500000, 3999000], [28000000, 28299000]]) {
        for (const w of [140, 300, 520]) {
            for (const k of scaleTicks({ start, end }, w)) {
                const dp = (k.label.split('.')[1] || '').length;
                const unit = 1e6 / (10 ** dp);
                assert.ok(Math.abs(parseFloat(k.label) * 1e6 - k.hz) <= unit / 2 + 1e-6,
                    `${k.label} is not ${k.hz} to ${dp} places`);
            }
        }
    }
});

t('a band with no span at all gets no strip', () => {
    assert.deepStrictEqual(scaleTicks({ start: 7e6, end: 7e6 }, 300), []);
    assert.deepStrictEqual(scaleTicks(null, 300), []);
    assert.strictEqual(scaleDecimals([7e6, 7e6]), 5);
});

// ── Zoom ─────────────────────────────────────────────────────────────────────

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

t('the whole band is not a zoom', () => {
    assert.strictEqual(isZoomed(FULL_ZOOM), false);
    assert.strictEqual(isZoomed(zoomAt(FULL_ZOOM, 0.5, ZOOM_FACTOR)), true);
    assert.strictEqual(isZoomed(null), false);
});

t('the frequency under the pointer does not move', () => {
    // The whole point of zooming about a point: rolling the wheel over a signal
    // pulls that signal closer instead of scrolling the band past it.
    const meta = { start: 7000000, end: 7200000 };
    for (const at of [0.1, 0.25, 0.5, 0.9]) {
        let z = FULL_ZOOM;
        const before = zoomHz(meta, z);
        const hz = before.start + at * (before.end - before.start);
        for (let i = 0; i < 3; i++) {
            z = zoomAt(z, at, ZOOM_FACTOR);
            const w = zoomHz(meta, z);
            near(w.start + at * (w.end - w.start), hz, 1e-6);
        }
    }
});

t('zooming at an edge stays inside the band', () => {
    let z = FULL_ZOOM;
    for (let i = 0; i < 20; i++) z = zoomAt(z, 0, ZOOM_FACTOR);
    assert.ok(z.start >= 0 && z.end <= 1, `${z.start}-${z.end}`);
    assert.strictEqual(z.start, 0, 'zooming at the left edge stays pinned to it');

    let y = FULL_ZOOM;
    for (let i = 0; i < 20; i++) y = zoomAt(y, 1, ZOOM_FACTOR);
    assert.strictEqual(y.end, 1);
});

t('there is a limit to how far in it goes, and back out is the whole band', () => {
    let z = FULL_ZOOM;
    for (let i = 0; i < 50; i++) z = zoomAt(z, 0.5, ZOOM_FACTOR);
    near(z.end - z.start, ZOOM_MIN_SPAN);
    for (let i = 0; i < 50; i++) z = zoomAt(z, 0.5, 1 / ZOOM_FACTOR);
    assert.deepStrictEqual(z, { start: 0, end: 1 });
});

t('a pan moves by the same distance on screen however far in you are', () => {
    // Zoomed enough that a quarter-width step has room either side of it — a
    // window that is already against an edge is the next test's business.
    for (const factor of [ZOOM_FACTOR ** 2, ZOOM_FACTOR ** 3]) {
        const z = zoomAt(FULL_ZOOM, 0.5, factor);
        const span = z.end - z.start;
        const p = panByFraction(z, 0.25);
        near(p.start - z.start, span * 0.25);
        near(p.end - p.start, span, 1e-12);       // and keeps its width
    }
});

t('a pan that runs off the end stops there rather than shrinking', () => {
    let z = zoomAt(FULL_ZOOM, 0.5, ZOOM_FACTOR);
    const span = z.end - z.start;
    for (let i = 0; i < 20; i++) z = panByFraction(z, 0.25);
    assert.strictEqual(z.end, 1);
    near(z.end - z.start, span, 1e-12);
    for (let i = 0; i < 40; i++) z = panByFraction(z, -0.25);
    assert.strictEqual(z.start, 0);
    near(z.end - z.start, span, 1e-12);
});

t('the window names its own bins, and never fewer than two', () => {
    const b = zoomBins(400, { start: 0.25, end: 0.5 });
    assert.strictEqual(b.first, 100);
    assert.strictEqual(b.last, 200);
    assert.strictEqual(b.count, 101);
    // The tightest zoom on a coarse band must still be a range, not a point.
    const tight = zoomBins(400, { start: 0.5, end: 0.5 + ZOOM_MIN_SPAN });
    assert.ok(tight.count >= 2, `${tight.count} bins`);
    assert.deepStrictEqual(zoomBins(0, FULL_ZOOM), { first: 0, last: 0, count: 0 });
});

t('view and band fractions are each other\'s inverse', () => {
    const z = panByFraction(zoomAt(FULL_ZOOM, 0.3, ZOOM_FACTOR ** 2), 0.1);
    for (const f of [0, 0.25, 0.5, 1]) {
        near(viewFrac(z, bandFrac(z, f)), f);
    }
    // A signal outside the window is outside the picture, not clamped onto its
    // edge — that is what keeps the FT8 marker off screen when it should be.
    assert.ok(viewFrac(z, 0) < 0 || z.start === 0);
    assert.ok(viewFrac(z, 1) > 1 || z.end === 1);
});

// ── Where the receiver is listening ──────────────────────────────────────────

t('the dial and its passband are placed across the band', () => {
    // 7.100 MHz USB, 50–2800 Hz, on a 7.0–7.2 recorder: halfway across, with
    // the passband entirely above the dial.
    const d = dialWindow(META40, { frequency: 7.1e6, bandwidthLow: 50, bandwidthHigh: 2800 });
    near(d.at, 0.5);
    near(d.start, (7.10005e6 - 7e6) / 200e3);
    near(d.end, (7.1028e6 - 7e6) / 200e3);
    assert.ok(d.start > d.at && d.end > d.start, 'USB sits above the dial');
});

t('a lower-sideband passband is below the dial, not around it', () => {
    // The bug this avoids: adding and subtracting half a width puts an LSB
    // filter on both sides of the dial, which is not where it is.
    const d = dialWindow(META40, { frequency: 7.1e6, bandwidthLow: -2800, bandwidthHigh: -50 });
    assert.ok(d.end < d.at, 'LSB sits below the dial');
    near(d.at - d.start, 2800 / 200e3);
});

t('a passband that straddles the dial still comes out in order', () => {
    // AM, and whichever way round the two edges arrive.
    const am = dialWindow(META40, { frequency: 7.1e6, bandwidthLow: -4000, bandwidthHigh: 4000 });
    assert.ok(am.start < am.at && am.end > am.at);
    const swapped = dialWindow(META40, { frequency: 7.1e6, bandwidthLow: 2800, bandwidthHigh: 50 });
    assert.ok(swapped.start < swapped.end, 'edges are sorted, not assumed');
});

t('a dial outside the band has no marker', () => {
    // The panel follows the dial, so this is the moment between tuning away and
    // the panel switching bands — better nothing than a line clamped to an edge.
    const pb = { bandwidthLow: 50, bandwidthHigh: 2800 };
    assert.strictEqual(dialWindow(META40, { frequency: 14.074e6, ...pb }), null);
    assert.strictEqual(dialWindow(META40, { frequency: 6.999e6, ...pb }), null);
    // The edges themselves are inside it.
    assert.ok(dialWindow(META40, { frequency: 7e6, ...pb }));
    assert.ok(dialWindow(META40, { frequency: 7.2e6, ...pb }));
});

t('no tuning, no marker', () => {
    assert.strictEqual(dialWindow(META40, null), null);
    assert.strictEqual(dialWindow(null, { frequency: 7.1e6 }), null);
    assert.strictEqual(dialWindow(META40, { frequency: NaN }), null);
    // A mode with no passband yet is still a dial worth marking.
    const d = dialWindow(META40, { frequency: 7.1e6 });
    near(d.at, 0.5);
    near(d.start, 0.5);
    near(d.end, 0.5);
});

console.log(`\n${pass} passed`);

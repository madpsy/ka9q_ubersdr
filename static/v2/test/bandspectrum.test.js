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
    applyFrame, bandsFromConfig, clampDb, createAutoRange, dbFromByte, decodeFrame,
    rangeOf, savedPrefs, updateAutoRange, validValues,
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

console.log(`\n${pass} passed`);

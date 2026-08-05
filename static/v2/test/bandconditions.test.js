// Band conditions: the buckets, the averaging, and what an absence means.
//
// Two panels colour the same ten buttons from this, so a disagreement here is
// two parts of one screen saying different things about the same band. The
// thresholds are v1's and are pinned so they cannot drift apart.

const assert = require('assert');
const {
    bandTip, bandTone, classify, requestBody, summarise, WINDOW_MIN,
} = require('./.build/bandconditions.cjs');
const { BAND_NAMES } = require('./.build/bands.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// --- buckets ----------------------------------------------------------------

t('v1 thresholds, including on the boundaries', () => {
    assert.strictEqual(classify(5.9), 'POOR');
    assert.strictEqual(classify(6), 'FAIR');
    assert.strictEqual(classify(19.9), 'FAIR');
    assert.strictEqual(classify(20), 'GOOD');
    assert.strictEqual(classify(29.9), 'GOOD');
    assert.strictEqual(classify(30), 'EXCELLENT');
});

t('a negative SNR is poor, not off the scale', () => {
    assert.strictEqual(classify(-12), 'POOR');
});

// --- averaging --------------------------------------------------------------

const at = (v) => ({ values: { ft8_snr: v } });

t('a band is the mean of its readings', () => {
    const out = summarise({ '20m': [at(10), at(20), at(30)] });
    assert.strictEqual(out['20m'].snr, 20);
    assert.strictEqual(out['20m'].status, 'GOOD');
});

t('gaps in the series are skipped, not counted as zero', () => {
    // The endpoint returns a point per minute whether or not anything was
    // heard, so counting the blanks would drag every band toward POOR.
    const out = summarise({ '40m': [at(30), { values: {} }, at(30), { values: { ft8_snr: null } }] });
    assert.strictEqual(out['40m'].snr, 30);
});

t('every band gets an entry, heard or not', () => {
    const out = summarise({ '20m': [at(25)] });
    assert.deepStrictEqual(Object.keys(out).sort(), [...BAND_NAMES].sort());
    assert.deepStrictEqual(out['10m'], { status: 'UNKNOWN', snr: null });
});

t('a reply with nothing in it is not a crash', () => {
    const out = summarise(null);
    assert.strictEqual(out['20m'].status, 'UNKNOWN');
    assert.strictEqual(summarise({})['20m'].snr, null);
});

// --- what a button shows ----------------------------------------------------

t('a band nobody has heard reads as open, not as broken', () => {
    // v1 draws it green rather than greying it out: an instance with no FT8
    // history is still a set of bands you can go to.
    assert.strictEqual(bandTone({ status: 'UNKNOWN', snr: null }, true), 'excellent');
    assert.strictEqual(bandTone(undefined, true), 'excellent');
});

t('a receiver with no monitor has no colours at all', () => {
    assert.strictEqual(bandTone({ status: 'GOOD', snr: 25 }, false), 'none');
    assert.strictEqual(bandTip('20m', { status: 'GOOD', snr: 25 }, false), '20m');
});

t('the tone is the status in lower case, so the class name follows the bucket', () => {
    for (const s of ['POOR', 'FAIR', 'GOOD', 'EXCELLENT']) {
        assert.strictEqual(bandTone({ status: s, snr: 1 }, true), s.toLowerCase());
    }
});

t('the tooltip carries the reading when there is one', () => {
    assert.match(bandTip('20m', { status: 'GOOD', snr: 24.567 }, true), /20m: GOOD/);
    assert.match(bandTip('20m', { status: 'GOOD', snr: 24.567 }, true), /24\.57 dB/);
    assert.match(bandTip('20m', { status: 'UNKNOWN', snr: null }, true), /No data/);
});

// --- the request ------------------------------------------------------------

t('the window asked for is the window advertised', () => {
    const to = new Date('2026-08-05T12:00:00Z');
    const body = requestBody(to);
    assert.strictEqual(body.primary.to, to.toISOString());
    assert.strictEqual(body.primary.from, new Date('2026-08-05T11:50:00Z').toISOString());
    assert.strictEqual(WINDOW_MIN, 10);
    assert.deepStrictEqual(body.fields, ['ft8_snr']);
    assert.deepStrictEqual(body.bands, BAND_NAMES);
    assert.strictEqual(body.interval, 'minute');
});

console.log(`\n${pass} passed`);

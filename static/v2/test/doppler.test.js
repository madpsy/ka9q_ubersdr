// The doppler addon panel's arithmetic.
//
// Two sources again, and this time they disagree by design: a station's configuration
// and its hour-long baseline come from a poll a minute old, while its reading arrives
// every second on a stream. Most of what is below is about keeping those apart — and
// about the one thing this panel exists to show, which is not the Doppler figure but
// its departure from the baseline.

const assert = require('assert');
const dp = require('./.build/doppler.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const NOW = Date.UTC(2026, 7, 6, 14, 30, 0);
const iso = (ms) => new Date(ms).toISOString();

// A station as /api/stations sends it.
const station = (over = {}, cur = {}, top = {}) => ({
    config: {
        id: 'wwv10', label: 'WWV-10', freq_hz: 10000000, enabled: true, is_reference: false, ...over,
    },
    current: {
        timestamp: iso(NOW - 1000), doppler_hz: 12.4, snr_db: 31.2, valid: true, ...cur,
    },
    baseline_mean_hz: 12.1,
    baseline_n: 47,
    corrected_doppler_hz: null,
    ...top,
});

// --- is the addon there? -----------------------------------------------------

t('the addon is found in the list by name, whatever its case', () => {
    assert.strictEqual(dp.dopplerAvailable({ addons: ['Doppler'] }), true);
    assert.strictEqual(dp.dopplerAvailable({ addons: ['sstv', 'doppler'] }), true);
});

t('no addon, no panel — and nothing throws on a receiver that says nothing', () => {
    assert.strictEqual(dp.dopplerAvailable({ addons: ['packet'] }), false);
    assert.strictEqual(dp.dopplerAvailable({}), false);
    assert.strictEqual(dp.dopplerAvailable(null), false);
});

t('the stream carries a client token, which is how the addon finds this connection', () => {
    // Not a secret and not an identity: it exists so the panel can ask for slower
    // spectrum frames, which it does not draw.
    const tok = dp.clientToken();
    assert.ok(tok.length > 4);
    assert.notStrictEqual(dp.clientToken(), tok, 'and a fresh one each time');
    assert.ok(dp.streamUrl('a b&c').includes(encodeURIComponent('a b&c')), 'and it is escaped');
    assert.strictEqual(dp.addonUrl(), '/addon/doppler/');
});

// --- one station ---------------------------------------------------------------

t('a station keeps its configuration, its reading and its baseline', () => {
    const s = dp.normaliseStation(station());
    assert.strictEqual(s.label, 'WWV-10');
    assert.strictEqual(s.mhz, '10.000');
    assert.strictEqual(s.doppler, 12.4);
    assert.strictEqual(s.baseline, 12.1);
    assert.strictEqual(s.snr, 31.2);
    assert.strictEqual(s.at, NOW - 1000);
});

t('a corrected reading is the one shown, and says so', () => {
    // With a reference station configured the clock drift has been subtracted, and that
    // figure means something absolutely rather than only against its own baseline.
    const s = dp.normaliseStation(station({}, {}, { corrected_doppler_hz: 0.22 }));
    assert.strictEqual(s.corrected, 0.22);
    assert.strictEqual(s.doppler, 0.22, 'the corrected figure is what the panel shows');
    assert.strictEqual(s.raw, 12.4, 'and the raw one is still there');
});

t('a station with no label is not a station', () => {
    assert.strictEqual(dp.normaliseStation(station({ label: '  ' })), null);
    assert.strictEqual(dp.normaliseStation(null), null);
});

t('a missing number is null, not zero — no reading is not a reading of nothing', () => {
    const s = dp.normaliseStation(station({}, { doppler_hz: null, snr_db: null }, {
        baseline_mean_hz: null,
    }));
    assert.strictEqual(s.doppler, null);
    assert.strictEqual(s.snr, null);
    assert.strictEqual(s.baseline, null);
});

t('a reference station is marked as one', () => {
    assert.strictEqual(dp.normaliseStation(station({ is_reference: true })).reference, true);
});

// --- the stream folded into the poll ----------------------------------------------

t('a reading updates its station and leaves the configuration alone', () => {
    // The stream is keyed by label and carries no configuration: the frequency and the
    // baseline come from the poll and have to survive a reading arriving.
    const before = [dp.normaliseStation(station())];
    const after = dp.applyReading(before, {
        station: 'WWV-10',
        reading: { timestamp: iso(NOW), doppler_hz: 13.9, snr_db: 28, valid: true },
    });
    assert.strictEqual(after[0].doppler, 13.9);
    assert.strictEqual(after[0].at, NOW);
    assert.strictEqual(after[0].baseline, 12.1, 'the baseline is the poll\'s');
    assert.strictEqual(after[0].mhz, '10.000');
});

t('a reading for a station the panel has never heard of is ignored', () => {
    // Without its configuration there is no frequency to show and no baseline to
    // compare against; the next station poll brings it in properly.
    const before = [dp.normaliseStation(station())];
    const after = dp.applyReading(before, { station: 'CHU-7', reading: { doppler_hz: 1 } });
    assert.strictEqual(after, before, 'and the list is not even rebuilt');
});

t('a message that is not a reading changes nothing', () => {
    const before = [dp.normaliseStation(station())];
    assert.strictEqual(dp.applyReading(before, {}), before);
    assert.strictEqual(dp.applyReading(before, null), before);
    assert.strictEqual(dp.applyReading(before, { station: 'WWV-10' }), before);
});

t('a reading with an unusable timestamp is placed when it arrived', () => {
    const before = [dp.normaliseStation(station())];
    const after = dp.applyReading(before, {
        station: 'WWV-10', reading: { doppler_hz: 1, valid: true },
    }, NOW);
    assert.strictEqual(after[0].at, NOW);
});

// --- the measurement -------------------------------------------------------------

t('the shift is the reading against its own baseline', () => {
    // The whole point of the panel on a receiver without a GPSDO: the absolute figure
    // is an arbitrary clock offset, and the movement is the ionosphere.
    const s = dp.normaliseStation(station({}, { doppler_hz: 12.9 }));
    assert.ok(Math.abs(dp.baselineShift(s) - 0.8) < 1e-9);
});

t('no baseline yet means no shift, rather than a shift from zero', () => {
    // A departure from a mean of two samples is not a departure from anything, and
    // "+12.40" against nothing would read as a flare.
    const s = dp.normaliseStation(station({}, {}, { baseline_mean_hz: null }));
    assert.strictEqual(dp.baselineShift(s), null);
    assert.strictEqual(dp.baselineShift(null), null);
});

t('the colour bands are what the phenomena look like', () => {
    assert.strictEqual(dp.shiftBand(0.05), 'calm');
    assert.strictEqual(dp.shiftBand(-0.05), 'calm', 'and it is the size that matters, not the sign');
    assert.strictEqual(dp.shiftBand(0.5), 'warn');
    assert.strictEqual(dp.shiftBand(-1.4), 'big');
    assert.strictEqual(dp.shiftBand(null), '');
});

t('a reading is live only while it is recent, and only while it is valid', () => {
    const fresh = dp.normaliseStation(station({}, { timestamp: iso(NOW - 2000) }));
    assert.strictEqual(dp.isLive(fresh, NOW), true);
    const old = dp.normaliseStation(station({}, { timestamp: iso(NOW - 120000) }));
    assert.strictEqual(dp.isLive(old, NOW), false);
    const bad = dp.normaliseStation(station({}, { valid: false }));
    assert.strictEqual(dp.isLive(bad, NOW), false, 'an invalid reading is not a reading');
});

// --- how it reads -----------------------------------------------------------------

t('a shift is signed, because the direction is half of what it says', () => {
    assert.strictEqual(dp.formatShift(0.34), '+0.34');
    assert.strictEqual(dp.formatShift(-0.34), '-0.34');
    assert.strictEqual(dp.formatShift(null), '—');
});

t('a shift too small to show is zero, and never a signed zero', () => {
    // "+0.00" reads as an instrument fault rather than as a carrier on frequency.
    assert.strictEqual(dp.formatShift(0.0004), '0.00');
    assert.strictEqual(dp.formatShift(-0.0004), '0.00');
    assert.strictEqual(dp.formatShift(0), '0.00');
});

// --- the summary --------------------------------------------------------------------

t('the summary counts what is enabled and what is actually being heard', () => {
    const list = [
        station({ label: 'WWV-10' }),
        station({ label: 'WWV-15' }, { timestamp: iso(NOW - 300000) }),
        station({ label: 'CHU-7', enabled: false }),
    ].map(dp.normaliseStation);
    const s = dp.dopplerSummary(list, NOW);
    assert.strictEqual(s.watching, 2, 'the disabled one is not being watched');
    assert.strictEqual(s.live, 1, 'and the stale one is not being heard');
});

t('the headline shift is the biggest departure anywhere, sign and all', () => {
    // A flare moves every path at once, so the largest movement on the receiver is the
    // figure that says something is happening.
    const list = [
        station({ label: 'A' }, { doppler_hz: 12.2 }),
        station({ label: 'B' }, { doppler_hz: 10.1 }, { baseline_mean_hz: 12.1 }),
    ].map(dp.normaliseStation);
    assert.ok(Math.abs(dp.dopplerSummary(list, NOW).biggest - -2) < 1e-9);
});

t('a receiver hearing nothing has no figures rather than zeroes', () => {
    assert.deepStrictEqual(dp.dopplerSummary([], NOW), {
        watching: 0, live: 0, biggest: null, bestSnr: null,
    });
});

if (process.exitCode) console.log('\ndoppler tests FAILED');
else console.log(`\nall ${pass} doppler tests passed`);

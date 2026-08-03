// Band lookup and voice-activity grouping.
//
// The panel is thin; everything with an edge case is in lib/bands.js and
// lib/voiceActivity.js, and those are what this covers.

const assert = require('assert');
const { HAM_BANDS, BAND_NAMES, bandForFrequency, bandOrder } = require('./.build/bands.cjs');
const va = require('./.build/voice.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// --- bands ------------------------------------------------------------------

t('the band table is v1\'s, in ascending frequency order', () => {
    assert.strictEqual(HAM_BANDS.length, 10);
    for (let i = 1; i < HAM_BANDS.length; i++) {
        assert.ok(HAM_BANDS[i][1] > HAM_BANDS[i - 1][2], `${HAM_BANDS[i][0]} overlaps its predecessor`);
    }
    assert.deepStrictEqual(BAND_NAMES[0], '160m');
    assert.deepStrictEqual(BAND_NAMES[9], '10m');
});

t('a frequency inside a band resolves to it', () => {
    assert.strictEqual(bandForFrequency(7100000), '40m');
    assert.strictEqual(bandForFrequency(14175000), '20m');
    assert.strictEqual(bandForFrequency(28500000), '10m');
});

t('band edges are inclusive, matching v1\'s active-badge test', () => {
    assert.strictEqual(bandForFrequency(7000000), '40m');
    assert.strictEqual(bandForFrequency(7300000), '40m');
});

t('a frequency between bands resolves to nothing', () => {
    assert.strictEqual(bandForFrequency(6999999), null);
    assert.strictEqual(bandForFrequency(7300001), null);
    assert.strictEqual(bandForFrequency(198000), null);   // LF broadcast
    assert.strictEqual(bandForFrequency(0), null);
});

t('bandOrder puts known bands up the spectrum and strangers last', () => {
    assert.ok(bandOrder('160m') < bandOrder('20m'));
    assert.ok(bandOrder('20m') < bandOrder('10m'));
    assert.ok(bandOrder('10m') < bandOrder('MW'));
    assert.strictEqual(bandOrder('MW'), bandOrder('anything else'));
});

// --- dial frequency ---------------------------------------------------------

t('the estimated dial frequency wins over the band edge', () => {
    assert.strictEqual(va.dialFreq({ estimated_dial_freq: 7150000, start_freq: 7148000 }), 7150000);
});

t('a missing estimate falls back to the lower edge, as v1 does', () => {
    assert.strictEqual(va.dialFreq({ start_freq: 7148000 }), 7148000);
    assert.strictEqual(va.dialFreq({ estimated_dial_freq: 0, start_freq: 7148000 }), 7148000);
});

t('an activity with no frequency at all is 0, not NaN', () => {
    assert.strictEqual(va.dialFreq({}), 0);
    assert.strictEqual(va.dialFreq(null), 0);
});

// --- confidence -------------------------------------------------------------

t('confidence tones are v1\'s bands', () => {
    assert.strictEqual(va.confidenceTone(0.95), 'high');
    assert.strictEqual(va.confidenceTone(0.7), 'high');      // boundary
    assert.strictEqual(va.confidenceTone(0.69), 'medium');
    assert.strictEqual(va.confidenceTone(0.5), 'medium');    // boundary
    assert.strictEqual(va.confidenceTone(0.49), 'low');
    assert.strictEqual(va.confidenceTone(0.3), 'low');       // boundary
    assert.strictEqual(va.confidenceTone(0.29), '');
    assert.strictEqual(va.confidenceTone(undefined), '');
});

// --- grouping ---------------------------------------------------------------

const sample = {
    '10m': [{ estimated_dial_freq: 28400000 }],
    '160m': [{ estimated_dial_freq: 1850000 }, { estimated_dial_freq: 1860000 }],
    '20m': [{ estimated_dial_freq: 14200000 }],
    '17m': [],                                  // band present, nothing on it
};

t('groups come back up the spectrum, not alphabetically', () => {
    const groups = va.groupByBand(sample);
    assert.deepStrictEqual(groups.map((g) => g.band), ['160m', '20m', '10m']);
});

t('a band with no activities is dropped rather than shown empty', () => {
    assert.ok(!va.groupByBand(sample).some((g) => g.band === '17m'));
});

t('every activity is tagged with the band it came from', () => {
    const flat = va.flatten(va.groupByBand(sample));
    assert.deepStrictEqual(flat.map((a) => a.band), ['160m', '160m', '20m', '10m']);
});

t('tagging does not mutate the response objects', () => {
    const input = { '20m': [{ estimated_dial_freq: 14200000 }] };
    va.groupByBand(input);
    assert.strictEqual(input['20m'][0].band, undefined);
});

t('bands the client does not know about still appear, after the ones it does', () => {
    const groups = va.groupByBand({ MW: [{ start_freq: 900000 }], '40m': [{ start_freq: 7100000 }] });
    assert.deepStrictEqual(groups.map((g) => g.band), ['40m', 'MW']);
});

t('unknown bands are ordered among themselves alphabetically', () => {
    const groups = va.groupByBand({ zulu: [{}], alpha: [{}] });
    assert.deepStrictEqual(groups.map((g) => g.band), ['alpha', 'zulu']);
});

t('an empty or missing payload is an empty list, not a throw', () => {
    assert.deepStrictEqual(va.groupByBand({}), []);
    assert.deepStrictEqual(va.groupByBand(null), []);
    assert.deepStrictEqual(va.groupByBand(undefined), []);
    assert.strictEqual(va.countActivities([]), 0);
});

t('the count is across every group', () => {
    assert.strictEqual(va.countActivities(va.groupByBand(sample)), 4);
});

// --- endpoint ---------------------------------------------------------------

t('the endpoint carries v1\'s confidence filter', () => {
    assert.strictEqual(va.MIN_CONFIDENCE, 0.7);
    assert.strictEqual(va.endpoint(), '/api/noisefloor/voice-activity/all?min_confidence=0.7');
});

if (process.exitCode) console.log('\nvoice activity tests FAILED');
else console.log(`\nall ${pass} voice activity tests passed`);

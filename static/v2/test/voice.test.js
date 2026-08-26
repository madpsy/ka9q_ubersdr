// Band lookup and voice-activity grouping.
//
// The panel is thin; everything with an edge case is in lib/bands.js and
// lib/voiceActivity.js, and those are what this covers.

const assert = require('assert');
const { HAM_BANDS, BAND_NAMES, bandForFrequency, bandOrder, bandsInRange } = require('./.build/bands.cjs');
const va = require('./.build/voice.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// --- bands ------------------------------------------------------------------

t('the band table is v1\'s ten, plus 6m, in ascending frequency order', () => {
    // v1 had ten because its receiver stopped at 30 MHz. 6m is here unconditionally so
    // bandForFrequency can name a 6m frequency whatever the front end is; whether it is
    // *offered* is bandsInRange's job, tested below.
    assert.strictEqual(HAM_BANDS.length, 11);
    for (let i = 1; i < HAM_BANDS.length; i++) {
        assert.ok(HAM_BANDS[i][1] > HAM_BANDS[i - 1][2], `${HAM_BANDS[i][0]} overlaps its predecessor`);
    }
    assert.deepStrictEqual(BAND_NAMES[0], '160m');
    assert.deepStrictEqual(BAND_NAMES[9], '10m');
    assert.deepStrictEqual(BAND_NAMES[10], '6m');
});

t('band buttons are offered only for bands the receiver can reach', () => {
    // A 6m key on a 30 MHz receiver would clamp to the band edge and look like it worked,
    // which is worse than not being there.
    const hf = bandsInRange(10000, 30000000).map(([n]) => n);
    assert.strictEqual(hf.length, 10, 'a 30 MHz receiver gets v1\'s ten');
    assert.ok(!hf.includes('6m'));

    const vhf = bandsInRange(10000, 60000000).map(([n]) => n);
    assert.strictEqual(vhf.length, 11);
    assert.strictEqual(vhf[10], '6m');

    // The default is what a receiver was before the span became configurable.
    assert.deepStrictEqual(bandsInRange().map(([n]) => n), hf);

    // A band only counts when it fits entirely — half a band has no centre to tune to.
    assert.ok(!bandsInRange(10000, 51000000).map(([n]) => n).includes('6m'));
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

// --- marker labels ----------------------------------------------------------

t('a correlated spot is labelled with its callsign', () => {
    assert.strictEqual(va.activityLabel({ dx_callsign: 'DK7DX', band: '40m' }), 'DK7DX');
});

t('an uncorrelated one says Voice, with the band to tell them apart', () => {
    // Zoomed out the spectrum spans several bands, and a row of identical
    // "Voice" pills would say nothing about which is which.
    assert.strictEqual(va.activityLabel({ band: '20m' }), 'Voice 20m');
    assert.strictEqual(va.activityLabel({}), 'Voice');
    assert.strictEqual(va.activityLabel(null), 'Voice');
});

// --- endpoint ---------------------------------------------------------------

t('the endpoint carries v1\'s confidence filter', () => {
    assert.strictEqual(va.MIN_CONFIDENCE, 0.7);
    assert.strictEqual(va.endpoint(), '/api/noisefloor/voice-activity/all?min_confidence=0.7');
});

// --- the shared poll --------------------------------------------------------
//
// The panel and the marker bar both want this data, and the endpoint is rate
// limited per IP — so there must be exactly one loop however many are watching,
// and none at all when nobody is.

// The service is a module singleton, so these must not overlap.
const ta = (name, fn) => {
    chain = chain.then(() => fn().then(
        () => { console.log('ok    ' + name); pass++; },
        (e) => { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; },
    ));
};
let chain = Promise.resolve();

// Lets the service's promise chain settle without waiting on real timers.
const settle = () => new Promise((r) => setImmediate(r));

function stubFetch(payload) {
    const state = { calls: 0 };
    global.fetch = () => {
        state.calls++;
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
    };
    return state;
}

ta('two subscribers share one request, not one each', async () => {
    va._resetVoiceActivity();
    const f = stubFetch({ bands: sample });
    const a = [];
    const b = [];
    const offA = va.subscribeVoiceActivity((s) => a.push(s));
    const offB = va.subscribeVoiceActivity((s) => b.push(s));
    await settle();
    assert.strictEqual(f.calls, 1, `${f.calls} requests for two subscribers`);
    assert.strictEqual(a.length, 1);
    assert.strictEqual(b.length, 1);
    assert.deepStrictEqual(a[0].groups.map((g) => g.band), ['160m', '20m', '10m']);
    offA(); offB();
});

ta('a late subscriber gets the last state at once', async () => {
    va._resetVoiceActivity();
    stubFetch({ bands: sample });
    const offA = va.subscribeVoiceActivity(() => {});
    await settle();
    let replayed = null;
    const offB = va.subscribeVoiceActivity((s) => { replayed = s; });
    // Synchronously, not on the next poll — otherwise a panel opening
    // mid-cycle shows "Loading…" for five seconds.
    assert.ok(replayed, 'no replay to the late subscriber');
    assert.strictEqual(va.countActivities(replayed.groups), 4);
    offA(); offB();
});

ta('nothing is fetched until something subscribes', async () => {
    va._resetVoiceActivity();
    const f = stubFetch({ bands: sample });
    await settle();
    assert.strictEqual(f.calls, 0);
    const off = va.subscribeVoiceActivity(() => {});
    await settle();
    assert.strictEqual(f.calls, 1);
    off();
});

ta('a failed request keeps the last data and reports alongside it', async () => {
    va._resetVoiceActivity();
    stubFetch({ bands: sample });
    const off = va.subscribeVoiceActivity(() => {});
    await settle();

    // Dropping the last subscriber stops the loop but keeps the data, so
    // resubscribing drives a fresh request without waiting on the 5 s timer —
    // and is a real path anyway (the panel being closed and reopened).
    off();
    global.fetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) });

    const seen = [];
    const off2 = va.subscribeVoiceActivity((s) => seen.push(s));
    await settle();

    const last = seen[seen.length - 1];
    assert.ok(/500/.test(last.error), `expected the error to be reported, got ${last.error}`);
    // The detector holds each frequency for 90 s, so one bad poll must not
    // blank the panel and the markers.
    assert.strictEqual(va.countActivities(last.groups), 4);
    off2();
});

ta('a rate-limited reply is not an error and changes nothing', async () => {
    va._resetVoiceActivity();
    global.fetch = () => Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve(null) });
    const seen = [];
    const off = va.subscribeVoiceActivity((s) => seen.push(s));
    await settle();
    assert.deepStrictEqual(seen, [], 'a 429 should leave the display alone');
    off();
});

chain.then(() => {
    va._resetVoiceActivity();
    if (process.exitCode) console.log('\nvoice activity tests FAILED');
    else console.log(`\nall ${pass} voice activity tests passed`);
});

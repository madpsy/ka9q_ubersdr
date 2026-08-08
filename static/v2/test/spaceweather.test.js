// Space weather grading and shaping.
//
// The panel and the top bar are both thin — everything with a rule in it is in
// lib/spaceWeather.js, and that is what this covers. The thresholds matter more
// than they look: several of them are inverted out of the server's own model
// (space_weather.go fluxScore), so a change there without a change here would
// have the panel colouring a flux "good" that the server grades "fair".

const assert = require('assert');
const sw = require('./.build/spaceweather.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// A live reply from m9psy, verbatim — the shape the panel is actually fed,
// including the parts NOAA leaves out (no r_scale, no s_scale).
const LIVE = {
    solar_flux: 136,
    k_index: 2,
    kp: 2.33,
    k_index_status: 'Quiet',
    a_index: 9,
    solar_wind_bz: 8.56,
    observed_r_scale: 0,
    band_conditions_day: {
        '10m': 'Fair', '12m': 'Fair', '15m': 'Good', '160m': 'Poor', '17m': 'Good',
        '20m': 'Excellent', '30m': 'Good', '40m': 'Good', '60m': 'Good', '80m': 'Fair',
    },
    band_conditions_night: {
        '10m': 'Poor', '12m': 'Poor', '15m': 'Poor', '160m': 'Excellent', '17m': 'Poor',
        '20m': 'Poor', '30m': 'Good', '40m': 'Excellent', '60m': 'Excellent', '80m': 'Excellent',
    },
    propagation_quality: 'Good',
    forecast: {
        geomagnetic_storm: 'None expected',
        radio_blackout: '20% chance of R1+ events, 1% chance of R3+',
        solar_radiation: '1% chance of S1+ event',
        g_scale: '0',
        g_text: 'none',
        r_minor_prob: '20',
        r_major_prob: '1',
        s_prob: '1',
    },
    last_update: '2026-08-04T13:09:32.41738718Z',
    timestamp: '2026-08-04T13:09:32Z',
};

// --- grades -----------------------------------------------------------------

t('the four grades map to the band-chip classes, and nothing else does', () => {
    assert.strictEqual(sw.gradeClass('Excellent'), 'excellent');
    assert.strictEqual(sw.gradeClass('Poor'), 'poor');
    // A band the server did not grade is absent, not a fifth grade.
    assert.strictEqual(sw.gradeClass(''), 'none');
    assert.strictEqual(sw.gradeClass(undefined), 'none');
    assert.strictEqual(sw.gradeClass('good'), 'none', 'the server capitalises; a lower-case grade is not one');
});

t('Excellent and Good share a tone — both mean the band is open', () => {
    assert.strictEqual(sw.gradeTone('Excellent'), 'good');
    assert.strictEqual(sw.gradeTone('Good'), 'good');
    assert.strictEqual(sw.gradeTone('Fair'), 'warn');
    assert.strictEqual(sw.gradeTone('Poor'), 'bad');
    assert.strictEqual(sw.gradeTone(''), 'idle');
});

// --- indices ----------------------------------------------------------------

t('the flux bands are the ones the server\'s own score implies', () => {
    // fluxScore(sfi) = 1.35 + (sfi - 65) * 0.017, Excellent at 2.95, Good at 1.90.
    const score = (sfi) => 1.35 + (sfi - 65) * 0.017;
    assert.ok(score(sw.FLUX_VERY_HIGH) >= 2.95, 'FLUX_VERY_HIGH must clear the Excellent score');
    assert.ok(score(sw.FLUX_VERY_HIGH - 1) < 2.95, 'and be the lowest flux that does');
    assert.ok(score(sw.FLUX_HIGH) >= 1.90, 'FLUX_HIGH must clear the Good score');
    assert.ok(score(sw.FLUX_HIGH - 1) < 1.90, 'and be the lowest flux that does');
});

t('flux reads high or low in the same direction the grade does', () => {
    assert.strictEqual(sw.fluxLabel(200), 'Very high');
    assert.strictEqual(sw.fluxLabel(136), 'High');
    assert.strictEqual(sw.fluxLabel(70), 'Moderate');
    assert.strictEqual(sw.fluxLabel(60), 'Low');
    assert.strictEqual(sw.fluxLabel(null), '');

    assert.strictEqual(sw.fluxTone(136), 'good');
    assert.strictEqual(sw.fluxTone(70), 'warn');
    assert.strictEqual(sw.fluxTone(60), 'bad');
    assert.strictEqual(sw.fluxTone(null), 'idle');
});

t('the K fallback is the server\'s own wording, at the server\'s own steps', () => {
    // space_weather.go getKIndexStatus: <=2 Quiet, <=4 Unsettled, <=6 Active.
    assert.strictEqual(sw.kStatus(0), 'Quiet');
    assert.strictEqual(sw.kStatus(2), 'Quiet');
    assert.strictEqual(sw.kStatus(3), 'Unsettled');
    assert.strictEqual(sw.kStatus(4), 'Unsettled');
    assert.strictEqual(sw.kStatus(5), 'Active');
    assert.strictEqual(sw.kStatus(6), 'Active');
    assert.strictEqual(sw.kStatus(7), 'Storm');
    assert.strictEqual(sw.kStatus(null), '');
});

t('K turns red at Kp 5, where NOAA\'s G scale starts', () => {
    assert.strictEqual(sw.kTone(2), 'good');
    assert.strictEqual(sw.kTone(4), 'warn');
    assert.strictEqual(sw.kTone(5), 'bad');
});

t('the A-index is graded on its own linear scale', () => {
    assert.strictEqual(sw.aTone(4), 'good');
    assert.strictEqual(sw.aTone(9), 'warn');
    assert.strictEqual(sw.aTone(40), 'bad');
    assert.strictEqual(sw.aTone(null), 'idle');
});

t('Bz is read by sign, so a large northward field is not a large hazard', () => {
    assert.strictEqual(sw.bzTone(8.56), 'good');
    assert.strictEqual(sw.bzTone(0), 'good');
    assert.strictEqual(sw.bzTone(-2), 'good');
    assert.strictEqual(sw.bzTone(-5), 'warn');
    assert.strictEqual(sw.bzTone(-12), 'bad');

    assert.strictEqual(sw.bzLabel(8.56), 'Northward');
    assert.strictEqual(sw.bzLabel(-2), 'Slightly south');
    assert.strictEqual(sw.bzLabel(-6), 'Southward');
    assert.strictEqual(sw.bzLabel(-12), 'Strongly south');
});

// --- NOAA scales ------------------------------------------------------------

t('a missing scale is unknown, and unknown is not quiet', () => {
    assert.strictEqual(sw.scaleLevel('0'), 0);
    assert.strictEqual(sw.scaleLevel('3'), 3);
    assert.strictEqual(sw.scaleLevel(2), 2);
    assert.strictEqual(sw.scaleLevel(''), null);
    assert.strictEqual(sw.scaleLevel(undefined), null);
    assert.strictEqual(sw.scaleLevel('none'), null);
    // Out of range is clamped rather than dropped — a level is still a level.
    assert.strictEqual(sw.scaleLevel('9'), 5);
});

t('level zero is spelled out, because NOAA does not print "G0"', () => {
    assert.strictEqual(sw.scaleLabel('G', 0), 'None');
    assert.strictEqual(sw.scaleLabel('G', 3), 'G3');
    assert.strictEqual(sw.scaleLabel('R', null), '—');

    assert.strictEqual(sw.scaleTone(0), 'good');
    assert.strictEqual(sw.scaleTone(2), 'warn');
    assert.strictEqual(sw.scaleTone(3), 'bad');
    assert.strictEqual(sw.scaleTone(null), 'idle');
});

t('R and S forecasts arrive as probabilities, and the live reply has no levels', () => {
    assert.strictEqual(sw.scaleLevel(LIVE.forecast.r_scale), null);
    assert.strictEqual(sw.scaleLevel(LIVE.forecast.s_scale), null);
    assert.strictEqual(sw.probPercent(LIVE.forecast.r_minor_prob), 20);
    assert.strictEqual(sw.probPercent(LIVE.forecast.r_major_prob), 1);
    assert.strictEqual(sw.probPercent(LIVE.forecast.s_prob), 1);
    assert.strictEqual(sw.probPercent(''), null);
    assert.strictEqual(sw.probPercent(undefined), null);
});

t('a one-in-five chance of a minor flare is still an ordinary day', () => {
    assert.strictEqual(sw.probTone(1), 'good');
    assert.strictEqual(sw.probTone(20), 'warn');
    assert.strictEqual(sw.probTone(60), 'bad');
    assert.strictEqual(sw.probTone(null), 'idle');
});

// --- band table -------------------------------------------------------------

t('band rows read up the spectrum, not alphabetically as the JSON keys do', () => {
    const rows = sw.bandRows(LIVE);
    assert.deepStrictEqual(
        rows.map((r) => r.band),
        ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'],
    );
    assert.deepStrictEqual(rows[0], { band: '160m', day: 'Poor', night: 'Excellent' });
    assert.deepStrictEqual(rows[9], { band: '10m', day: 'Fair', night: 'Poor' });
});

t('a band graded in only one map still gets a row', () => {
    const rows = sw.bandRows({
        band_conditions_day: { '20m': 'Good' },
        band_conditions_night: { '40m': 'Excellent' },
    });
    assert.deepStrictEqual(rows, [
        { band: '40m', day: '', night: 'Excellent' },
        { band: '20m', day: 'Good', night: '' },
    ]);
});

t('an operator\'s own band sorts after the amateur ones rather than vanishing', () => {
    const rows = sw.bandRows({ band_conditions_day: { '20m': 'Good', 'MW': 'Poor', '40m': 'Fair' } });
    assert.deepStrictEqual(rows.map((r) => r.band), ['40m', '20m', 'MW']);
});

t('no conditions at all is an empty table, not a crash', () => {
    assert.deepStrictEqual(sw.bandRows(null), []);
    assert.deepStrictEqual(sw.bandRows({}), []);
});

// --- freshness --------------------------------------------------------------

t('the age comes from the server\'s timestamp, not from when we fetched it', () => {
    const at = sw.updatedAt(LIVE);
    assert.strictEqual(at, Date.parse('2026-08-04T13:09:32.41738718Z'));
    // timestamp is the fallback for a reply with no last_update.
    assert.strictEqual(sw.updatedAt({ timestamp: '2026-08-04T13:09:32Z' }), Date.parse('2026-08-04T13:09:32Z'));
    // An unusable date must not become 1970 and read as "20955 d ago".
    assert.strictEqual(sw.updatedAt({ last_update: 'not a date' }), null);
    assert.strictEqual(sw.updatedAt({}), null);
    assert.strictEqual(sw.updatedAt(null), null);
});

t('the age reads in the largest unit that fits, and never goes negative', () => {
    const now = Date.parse('2026-08-04T14:00:00Z');
    assert.strictEqual(sw.ageLabel(now - 30000, now), 'just now');
    assert.strictEqual(sw.ageLabel(now - 5 * 60000, now), '5 min ago');
    assert.strictEqual(sw.ageLabel(now - 3 * 3600000, now), '3 h ago');
    assert.strictEqual(sw.ageLabel(now - 50 * 3600000, now), '2 d ago');
    // A browser clock ahead of the server's is "just now", not a negative age.
    assert.strictEqual(sw.ageLabel(now + 60000, now), 'just now');
    assert.strictEqual(sw.ageLabel(null, now), '');
});

// --- the shared poll --------------------------------------------------------
//
// Sequential: each of these swaps global.fetch for its own stub, and the module
// under test holds one set of subscribers between them.

function withFetch(impl, fn) {
    const prev = global.fetch;
    global.fetch = impl;
    // Reset on the way in as well as out: the seam is also what opens the server-feed
    // gate, which starts closed, and the first case in the file would otherwise be the
    // only one that ran with the store switched off. See src/lib/serverFeeds.js.
    sw._resetSpaceWeather();
    return Promise.resolve(fn()).finally(() => { global.fetch = prev; sw._resetSpaceWeather(); });
}

let chain = Promise.resolve();
const ta = (name, fn) => {
    chain = chain.then(() => fn().then(
        () => { console.log('ok    ' + name); pass++; },
        (e) => { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; },
    ));
};

const settle = () => new Promise((r) => setImmediate(r));

ta('subscribers share one request, and a late one is replayed rather than refetching', () => {
    const calls = [];
    return withFetch(
        (url) => {
            calls.push(url);
            return Promise.resolve({ ok: true, json: () => Promise.resolve(LIVE) });
        },
        async () => {
            const seen = [];
            const offA = sw.subscribeSpaceWeather((s) => seen.push(s));
            const offB = sw.subscribeSpaceWeather(() => {});
            assert.strictEqual(calls.length, 1, 'the second subscriber joins the first request');
            assert.strictEqual(calls[0], sw.ENDPOINT);

            await settle();
            assert.strictEqual(seen.length, 1);
            assert.strictEqual(seen[0].data.solar_flux, 136);
            assert.strictEqual(seen[0].error, '');

            let replayed = null;
            const offC = sw.subscribeSpaceWeather((s) => { replayed = s; });
            assert.ok(replayed && replayed.data.solar_flux === 136, 'a late subscriber gets the reply in hand');
            assert.strictEqual(calls.length, 1, 'and triggers no fetch of its own');

            offA(); offB(); offC();
        },
    );
});

ta('dropping the last subscriber stops the poll; the next one restarts it', () => {
    let calls = 0;
    return withFetch(
        () => {
            calls++;
            return Promise.resolve({ ok: true, json: () => Promise.resolve(LIVE) });
        },
        async () => {
            const off = sw.subscribeSpaceWeather(() => {});
            await settle();
            assert.strictEqual(calls, 1);
            off();
            // The panel is unmounted while its section is collapsed, so this is
            // the ordinary case and not an edge one.
            sw.subscribeSpaceWeather(() => {});
            assert.strictEqual(calls, 2, 'a fresh subscription starts the loop again');
        },
    );
});

ta('a failed refresh keeps the last good reading and reports alongside it', () => {
    let fail = false;
    return withFetch(
        () => (fail
            ? Promise.resolve({ ok: false, status: 503 })
            : Promise.resolve({ ok: true, json: () => Promise.resolve(LIVE) })),
        async () => {
            const off = sw.subscribeSpaceWeather(() => {});
            await settle();
            // Unsubscribing stops the timer but keeps the cached reply, so
            // resubscribing is a clean way to provoke the next request without
            // waiting a minute for the interval.
            off();

            fail = true;
            const seen = [];
            sw.subscribeSpaceWeather((s) => seen.push(s));
            await settle();

            const last = seen[seen.length - 1];
            assert.strictEqual(last.data.solar_flux, 136, 'the previous reading survives the failure');
            assert.ok(/503/.test(last.error), `expected the status in the error, got ${last.error}`);
        },
    );
});

ta('a failure with nothing cached reports the error and no data', () => withFetch(
    () => Promise.resolve({ ok: false, status: 429 }),
    async () => {
        const seen = [];
        sw.subscribeSpaceWeather((s) => seen.push(s));
        await settle();
        assert.strictEqual(seen[seen.length - 1].data, null);
        assert.ok(/429/.test(seen[seen.length - 1].error));
    },
));

chain.then(() => {
    if (process.exitCode) console.log('\nspace weather tests FAILED');
    else console.log(`\nall ${pass} space weather checks passed`);
});

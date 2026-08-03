// Callsign normalisation, grid decoding, distance/bearing and the lookup call.

const assert = require('assert');
const cs = require('./.build/callsign.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) < eps, `${what}: ${a} vs ${b}`);

// --- normalisation ----------------------------------------------------------

t('a portable suffix is stripped to the callsign', () => {
    assert.strictEqual(cs.normaliseCallsign('GB4XYZ/P'), 'GB4XYZ');
    assert.strictEqual(cs.normaliseCallsign('GB4XYZ/MM'), 'GB4XYZ');
});

t('a DXCC prefix is stripped to the callsign', () => {
    assert.strictEqual(cs.normaliseCallsign('F/GB4XYZ'), 'GB4XYZ');
    assert.strictEqual(cs.normaliseCallsign('PA/M0ABC/P'), 'M0ABC');
});

t('input is upper-cased and trimmed', () => {
    assert.strictEqual(cs.normaliseCallsign('  m0abc '), 'M0ABC');
});

t('nothing in, nothing out — never a throw', () => {
    assert.strictEqual(cs.normaliseCallsign(''), '');
    assert.strictEqual(cs.normaliseCallsign(null), '');
    assert.strictEqual(cs.normaliseCallsign(undefined), '');
});

t('validation matches what the server will accept', () => {
    assert.ok(cs.isValidCallsign('M0ABC'));
    assert.ok(cs.isValidCallsign('GB4XYZ'));
    assert.ok(cs.isValidCallsign('VP2MDX'));
    assert.ok(!cs.isValidCallsign('M0'));           // too short
    assert.ok(!cs.isValidCallsign('ABCDEFGHIJK'));  // too long
    assert.ok(!cs.isValidCallsign('M0-ABC'));       // punctuation
    assert.ok(!cs.isValidCallsign(''));
});

// --- Maidenhead -------------------------------------------------------------

t('a 6-character locator decodes to the centre of its subsquare', () => {
    // IO91wm is central London.
    const p = cs.maidenheadToLatLon('IO91wm');
    near(p.lat, 51.5208, 0.001, 'lat');
    near(p.lon, -0.125, 0.001, 'lon');
});

// The authority is v1's static/maidenhead.js, which has been decoding these
// for years — so compare against it directly rather than against numbers
// worked out by hand here.
t('decoding agrees with v1\'s maidenhead.js', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'maidenhead.js'), 'utf8');
    // eslint-disable-next-line no-eval
    const v1 = eval(`${src.replace(/export\s+/g, '')}; maidenheadToLatLon`);
    for (const g of ['IO91wm', 'IO91', 'AA00', 'RR99xx', 'JJ00aa', 'FN31pr', 'JO65', 'PM95tq']) {
        const a = v1(g);
        const b = cs.maidenheadToLatLon(g);
        near(a.lat, b.lat, 1e-6, `${g} lat`);
        near(a.lon, b.lon, 1e-6, `${g} lon`);
    }
});

t('a 4-character locator decodes to the centre of its square', () => {
    const p = cs.maidenheadToLatLon('IO91');
    near(p.lat, 51.5, 0.01, 'lat');
    near(p.lon, -1.0, 0.01, 'lon');
});

t('the locator origin decodes to the south-west corner of the world', () => {
    const p = cs.maidenheadToLatLon('AA00');
    near(p.lat, -89.5, 0.01, 'lat');
    near(p.lon, -179, 0.01, 'lon');
});

t('case does not matter', () => {
    assert.deepStrictEqual(cs.maidenheadToLatLon('io91WM'), cs.maidenheadToLatLon('IO91wm'));
});

t('malformed locators are null rather than an exception', () => {
    // Fed straight from a provider field that is often blank or wrong, so this
    // must not throw the way v1's maidenhead.js does.
    assert.strictEqual(cs.maidenheadToLatLon('ZZ99'), null);
    assert.strictEqual(cs.maidenheadToLatLon('IO9'), null);
    assert.strictEqual(cs.maidenheadToLatLon('IO91wm12'), null);
    assert.strictEqual(cs.maidenheadToLatLon(''), null);
    assert.strictEqual(cs.maidenheadToLatLon(null), null);
    assert.strictEqual(cs.maidenheadToLatLon(51.5), null);
});

// --- distance and bearing ---------------------------------------------------

const LONDON = [51.5074, -0.1278];
const NEW_YORK = [40.7128, -74.006];

t('London to New York is about 5570 km on a bearing near 288 degrees', () => {
    const db = cs.distanceBearing(...LONDON, ...NEW_YORK);
    near(db.distKm, 5570, 25, 'distance');
    near(db.bearing, 288, 2, 'bearing');
});

t('the reverse path is the same distance but a different bearing', () => {
    const there = cs.distanceBearing(...LONDON, ...NEW_YORK);
    const back = cs.distanceBearing(...NEW_YORK, ...LONDON);
    assert.strictEqual(there.distKm, back.distKm);
    near(back.bearing, 51, 2, 'return bearing');
});

t('due north is 0 degrees and due south is 180', () => {
    near(cs.distanceBearing(0, 0, 10, 0).bearing, 0, 0.5, 'north');
    near(cs.distanceBearing(0, 0, -10, 0).bearing, 180, 0.5, 'south');
    near(cs.distanceBearing(0, 0, 0, 10).bearing, 90, 0.5, 'east');
    near(cs.distanceBearing(0, 0, 0, -10).bearing, 270, 0.5, 'west');
});

t('a bearing is never negative — the antenna cannot turn to -72 degrees', () => {
    for (let lon = -180; lon <= 180; lon += 15) {
        const db = cs.distanceBearing(51.5, -0.1, 40, lon);
        assert.ok(db.bearing >= 0 && db.bearing < 360, `bearing ${db.bearing} at lon ${lon}`);
    }
});

t('the same point is zero distance', () => {
    assert.strictEqual(cs.distanceBearing(51.5, -0.1, 51.5, -0.1).distKm, 0);
});

t('missing coordinates give null, not NaN', () => {
    assert.strictEqual(cs.distanceBearing(51.5, -0.1, null, 10), null);
    assert.strictEqual(cs.distanceBearing(undefined, 0, 0, 0), null);
    assert.strictEqual(cs.distanceBearing(51.5, -0.1, NaN, 0), null);
});

// --- position selection -----------------------------------------------------

t('a precise position beats the grid square', () => {
    const p = cs.positionOf({ lat: 51.5, lon: -0.1, grid: 'IO91wm' });
    assert.strictEqual(p.lat, 51.5);
    assert.strictEqual(p.fromGrid, false);
});

t('with no position the grid square is used, and flagged as such', () => {
    const p = cs.positionOf({ grid: 'IO91wm' });
    assert.strictEqual(p.fromGrid, true);
    near(p.lat, 51.48, 0.05, 'lat');
});

t('lat/lon of 0,0 is treated as absent, not as null island', () => {
    // The provider returns 0,0 for "unknown", and a 5500 km bearing to the Gulf
    // of Guinea is worse than showing nothing.
    assert.strictEqual(cs.positionOf({ lat: 0, lon: 0, grid: 'IO91wm' }).fromGrid, true);
    assert.strictEqual(cs.positionOf({ lat: 0, lon: 0 }), null);
});

t('no position at all is null', () => {
    assert.strictEqual(cs.positionOf({}), null);
    assert.strictEqual(cs.positionOf(null), null);
    assert.strictEqual(cs.positionOf({ grid: 'nonsense' }), null);
});

// --- display name -----------------------------------------------------------

t('the provider\'s formatted name wins', () => {
    assert.strictEqual(cs.displayName({ name_fmt: 'John Q. Smith', fname: 'John', name: 'Smith' }), 'John Q. Smith');
});

t('otherwise the parts are joined, nickname in quotes', () => {
    assert.strictEqual(cs.displayName({ fname: 'John', nickname: 'Jack', name: 'Smith' }), 'John "Jack" Smith');
    assert.strictEqual(cs.displayName({ fname: 'John', name: 'Smith' }), 'John Smith');
    assert.strictEqual(cs.displayName({ name: 'Smith' }), 'Smith');
    assert.strictEqual(cs.displayName({}), '');
    assert.strictEqual(cs.displayName(null), '');
});

// --- error messages ---------------------------------------------------------

t('a 401 explains what to do, not just what went wrong', () => {
    // The server says "an active audio session is required to use this
    // endpoint", which is true but not actionable.
    const m = cs.lookupError(401, { error: 'an active audio session is required to use this endpoint' });
    assert.ok(/start the receiver/i.test(m), m);
});

t('rate limiting and a disabled service read differently', () => {
    assert.ok(/wait/i.test(cs.lookupError(429, null)));
    assert.ok(/disabled/i.test(cs.lookupError(503, null)));
    assert.ok(/not found/i.test(cs.lookupError(404, null)));
});

t('an unrecognised failure falls back to the server text, then the status', () => {
    assert.strictEqual(cs.lookupError(500, { error: 'upstream exploded' }), 'upstream exploded');
    assert.strictEqual(cs.lookupError(500, null), 'Lookup failed (HTTP 500).');
});

// --- the lookup call --------------------------------------------------------

function withFetch(impl, fn) {
    const prev = global.fetch;
    global.fetch = impl;
    return Promise.resolve(fn()).finally(() => { global.fetch = prev; });
}

// Sequential: each of these swaps global.fetch for its own stub.
const ta = (name, fn) => {
    chain = chain.then(() => fn().then(
        () => { console.log('ok    ' + name); pass++; },
        (e) => { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; },
    ));
};
let chain = Promise.resolve();

ta('the request carries the callsign and the session UUID', () => withFetch(
    (url) => {
        assert.ok(url.startsWith('/api/lookup?'), url);
        assert.ok(url.includes('callsign=M0ABC'), url);
        assert.ok(url.includes('uuid=sess-1'), url);
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ call: 'M0ABC' }) });
    },
    async () => {
        const d = await cs.lookupCallsignData('M0ABC', 'sess-1');
        assert.strictEqual(d.call, 'M0ABC');
    },
));

ta('no session means no request at all', () => withFetch(
    () => { throw new Error('should not have been called'); },
    async () => {
        await assert.rejects(() => cs.lookupCallsignData('M0ABC', ''), /start the receiver/i);
    },
));

ta('an HTTP failure becomes the friendly message', () => withFetch(
    () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: 'nope' }) }),
    async () => {
        await assert.rejects(() => cs.lookupCallsignData('M0ABC', 'u'), /start the receiver/i);
    },
));

ta('a 200 carrying an error field is still an error', () => withFetch(
    // The provider can answer "not found" without an HTTP failure.
    () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ error: 'not found' }) }),
    async () => {
        await assert.rejects(() => cs.lookupCallsignData('M0ABC', 'u'), /not found/);
    },
));

ta('a body that is not JSON does not crash the panel', () => withFetch(
    () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('bad json')) }),
    async () => {
        await assert.rejects(() => cs.lookupCallsignData('M0ABC', 'u'), /returned nothing/);
    },
));

// --- the in-app request bus -------------------------------------------------

t('a request reaches every listener, normalised', () => {
    const seen = [];
    const off = cs.onLookupRequest((c) => seen.push(c));
    assert.strictEqual(cs.requestLookup('f/gb4xyz/p'), true);
    assert.deepStrictEqual(seen, ['GB4XYZ']);
    off();
});

t('with nothing listening the caller is told, so it can fall back', () => {
    // The voice activity panel uses this to decide between the in-app panel and
    // the v1 popup.
    assert.strictEqual(cs.requestLookup('M0ABC'), false);
});

t('unsubscribing really stops delivery', () => {
    const seen = [];
    const off = cs.onLookupRequest((c) => seen.push(c));
    off();
    assert.strictEqual(cs.requestLookup('M0ABC'), false);
    assert.deepStrictEqual(seen, []);
});

t('a throwing listener does not stop the others', () => {
    const seen = [];
    const offA = cs.onLookupRequest(() => { throw new Error('boom'); });
    const offB = cs.onLookupRequest((c) => seen.push(c));
    const prev = console.error;
    console.error = () => {};
    try {
        assert.strictEqual(cs.requestLookup('M0ABC'), true);
    } finally {
        console.error = prev;
        offA(); offB();
    }
    assert.deepStrictEqual(seen, ['M0ABC']);
});

t('an empty callsign is never dispatched', () => {
    const seen = [];
    const off = cs.onLookupRequest((c) => seen.push(c));
    assert.strictEqual(cs.requestLookup(''), false);
    assert.strictEqual(cs.requestLookup(null), false);
    assert.deepStrictEqual(seen, []);
    off();
});

chain.then(() => {
    if (process.exitCode) console.log('\ncallsign tests FAILED');
    else console.log(`\nall ${pass} callsign tests passed`);
});

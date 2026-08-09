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

// --- the great-circle path -------------------------------------------------

t('the path starts where it is told and ends where it is told', () => {
    const pts = cs.geodesicPoints(51.5, -0.1, 40.7, -74, 64);
    assert.strictEqual(pts.length, 65, 'steps + 1 vertices');
    near(pts[0][0], 51.5, 1e-6, 'first lat');
    near(pts[0][1], -0.1, 1e-6, 'first lon');
    near(pts[64][0], 40.7, 1e-6, 'last lat');
    near(pts[64][1], -74, 1e-6, 'last lon');
});

t('it is a great circle, not the straight line a flat map would draw', () => {
    // London to New York bows north of the rhumb line by a few degrees — that
    // bow is the whole reason the path is drawn as a curve rather than as two
    // points joined up.
    const pts = cs.geodesicPoints(51.5, -0.1, 40.7, -74, 64);
    const mid = pts[32];
    const flat = (51.5 + 40.7) / 2;
    assert.ok(mid[0] > flat + 2, `midpoint ${mid[0]} should bow north of ${flat}`);
});

t('the same point twice is one vertex, not a division by zero', () => {
    const pts = cs.geodesicPoints(51.5, -0.1, 51.5, -0.1, 64);
    assert.deepStrictEqual(pts, [[51.5, -0.1]]);
    for (const p of pts) assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]));
});

t('every vertex is a real coordinate, however long the path', () => {
    // Antipodal-ish is where a naive interpolation produces NaN.
    for (const [a, b, c, d] of [[0, 0, 0, 179.9], [90, 0, -90, 0], [-33.9, 151.2, 51.5, -0.1]]) {
        for (const p of cs.geodesicPoints(a, b, c, d, 32)) {
            assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]), `${a},${b} → ${c},${d}`);
            assert.ok(p[0] >= -90.001 && p[0] <= 90.001, `lat ${p[0]}`);
        }
    }
});

// --- the lookup call --------------------------------------------------------

// The stub is handed to the body as well as installed, so a test can ask it how
// many times it was called.
function withFetch(impl, fn) {
    const prev = global.fetch;
    global.fetch = impl;
    return Promise.resolve(fn(impl)).finally(() => { global.fetch = prev; });
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

// The channel the announcer listens on. What matters is that it fires for lookups
// nobody in a panel asked for — a marker the dial landed on, the media session — and
// that it stays quiet when the lookup did not find anybody.

ta('an answered lookup is reported once, with what it found', () => withFetch(
    () => Promise.resolve({
        ok: true, status: 200, json: () => Promise.resolve({ call: 'M0ABC', name: 'Somebody' }),
    }),
    async () => {
        const heard = [];
        const off = cs.onLookupAnswer((call, data) => heard.push([call, data.name]));
        await cs.lookupCallsignData('m0abc', 'sess-1');
        off();
        assert.deepStrictEqual(heard, [['M0ABC', 'Somebody']], 'normalised, and once');
    },
));

ta('two callers sharing one request are one answer, not two', () => withFetch(
    () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ name: 'Somebody' }) }),
    async () => {
        // The panel and the Markers panel asking together is the common case, and
        // announcing the same callsign twice over itself is what the sharing prevents.
        let n = 0;
        const off = cs.onLookupAnswer(() => { n += 1; });
        await Promise.all([
            cs.lookupCallsignData('G0RDH', 'u'),
            cs.lookupCallsignData('G0RDH', 'u'),
        ]);
        off();
        assert.strictEqual(n, 1);
    },
));

ta('a failed lookup is not an answer', () => withFetch(
    () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }),
    async () => {
        let n = 0;
        const off = cs.onLookupAnswer(() => { n += 1; });
        await cs.lookupCallsignData('QQ9ZZZ', 'u').catch(() => {});
        off();
        assert.strictEqual(n, 0);
    },
));

ta('a listener that throws does not break the lookup', () => withFetch(
    () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ name: 'Somebody' }) }),
    async () => {
        const off = cs.onLookupAnswer(() => { throw new Error('bad listener'); });
        const d = await cs.lookupCallsignData('W1AW', 'u');
        off();
        assert.strictEqual(d.name, 'Somebody', 'the caller still gets its record');
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

ta('two callers asking at once share one request', () => withFetch(
    // The bug: clicking a marker had the Markers panel ask so it could show the
    // operator's name, while the same click drove the Callsign panel, which
    // asked again. Two requests and two rate-limit slots for one answer.
    (() => {
        let calls = 0;
        const fn = () => {
            calls++;
            return new Promise((resolve) => setTimeout(() => resolve({
                ok: true, status: 200, json: () => Promise.resolve({ call: 'M0ABC' }),
            }), 5));
        };
        fn.count = () => calls;
        return fn;
    })(),
    async (fetchFn) => {
        cs._resetInFlight();
        const [a, b] = await Promise.all([
            cs.lookupCallsignData('M0ABC', 'u'),
            cs.lookupCallsignData('m0abc', 'u'),
        ]);
        assert.strictEqual(a.call, 'M0ABC');
        assert.strictEqual(b.call, 'M0ABC');
        assert.strictEqual(fetchFn.count(), 1, 'asked twice');
    },
));

ta('both callers get the failure, not just the one who sent it', () => withFetch(
    () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ error: 'not found' }) }),
    async () => {
        cs._resetInFlight();
        const both = [cs.lookupCallsignData('M0ABC', 'u'), cs.lookupCallsignData('M0ABC', 'u')];
        await assert.rejects(() => both[0], /not found/);
        await assert.rejects(() => both[1], /not found/);
    },
));

ta('a later request is a new one, not the finished one handed back', () => withFetch(
    (() => {
        let calls = 0;
        const fn = () => {
            calls++;
            return Promise.resolve({
                ok: true, status: 200, json: () => Promise.resolve({ call: 'M0ABC', n: calls }),
            });
        };
        fn.count = () => calls;
        return fn;
    })(),
    async (fetchFn) => {
        // Sharing is only for the moment they overlap: this is not a cache, and
        // the server keeps one of its own.
        cs._resetInFlight();
        await cs.lookupCallsignData('M0ABC', 'u');
        await cs.lookupCallsignData('M0ABC', 'u');
        assert.strictEqual(fetchFn.count(), 2);
    },
));

ta('different callsigns are never shared', () => withFetch(
    (() => {
        const seen = [];
        const fn = (url) => {
            seen.push(url);
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ call: 'x' }) });
        };
        fn.seen = () => seen;
        return fn;
    })(),
    async (fetchFn) => {
        cs._resetInFlight();
        await Promise.all([
            cs.lookupCallsignData('M0ABC', 'u'),
            cs.lookupCallsignData('G4XYZ', 'u'),
        ]);
        assert.strictEqual(fetchFn.seen().length, 2);
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

// --- retryable failures -----------------------------------------------------
//
// The bug these pin down: powerOn() sets `running` and then registers the audio
// session, so the Markers panel's automatic lookup fires into the gap and gets a
// 401. Nothing about that is a fact about the callsign, but it was being cached
// as one — leaving the operator's name blank for the rest of the page.

// --- did the lookup actually find anybody? -----------------------------------
//
// The announcer acts on a result rather than merely showing it, so "the provider
// replied" is not good enough: an empty record would have it sending a mistyped
// callsign in Morse. See identified() and the announcer in CallsignPanel.

t('a record with any identifying field is somebody', () => {
    for (const data of [
        { name: 'Nathan' },
        { name_fmt: 'N. Somebody' },
        { country: 'England' },
        { cty: { country: 'Scotland' } },
        { grid: 'IO87' },
        { class: 'Full' },
        { qth: 'Glasgow' },
        { image: 'https://example.invalid/op.jpg' },
    ]) {
        assert.strictEqual(cs.identified(data), true, JSON.stringify(data));
    }
});

t('an empty answer is not somebody, however it arrived', () => {
    // A 200 carrying {} is the case that matters: the transport is happy, there is
    // nothing in it, and nothing should be announced.
    for (const data of [null, undefined, {}, '', 'G0RDH', 42, { callsign: 'G0RDH' }]) {
        assert.strictEqual(cs.identified(data), false, JSON.stringify(data) || String(data));
    }
});

t('a blank field is not a field', () => {
    // Providers pad their answers: empty strings for what they do not know.
    assert.strictEqual(cs.identified({ name: '', country: '', grid: '', cty: {} }), false);
});

t('only a 404 says anything about the callsign', () => {
    assert.strictEqual(cs.lookupRetryable(404), false, 'no such callsign is a fact');
    for (const status of [401, 429, 500, 502, 503]) {
        assert.strictEqual(cs.lookupRetryable(status), true, `HTTP ${status}`);
    }
});

ta('a 401 is flagged retryable — the session is not registered yet', () => withFetch(
    () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve(null) }),
    async () => {
        const err = await cs.lookupCallsignData('M0ABC', 'sess-401').then(
            () => null, (e) => e,
        );
        assert.ok(err, 'expected a rejection');
        assert.strictEqual(err.retryable, true);
        assert.match(err.message, /active audio session/);
    },
));

ta('a 404 is not retryable — asked, and there is no such station', () => withFetch(
    () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) }),
    async () => {
        const err = await cs.lookupCallsignData('QQQ9ZZ', 'sess-404').then(
            () => null, (e) => e,
        );
        assert.strictEqual(err.retryable, false);
    },
));

ta('a 200 carrying the provider\'s "never heard of it" is not retryable', () => withFetch(
    () => Promise.resolve({
        ok: true, status: 200, json: () => Promise.resolve({ error: 'Not found' }),
    }),
    async () => {
        const err = await cs.lookupCallsignData('QQQ9ZZ', 'sess-200').then(
            () => null, (e) => e,
        );
        assert.strictEqual(err.retryable, false, 'the provider answered');
    },
));

ta('a dropped connection is retryable', () => withFetch(
    () => Promise.reject(new TypeError('Failed to fetch')),
    async () => {
        const err = await cs.lookupCallsignData('M0ABC', 'sess-net').then(
            () => null, (e) => e,
        );
        assert.strictEqual(err.retryable, true);
    },
));

ta('an empty body is retryable rather than a verdict', () => withFetch(
    () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(null) }),
    async () => {
        const err = await cs.lookupCallsignData('M0ABC', 'sess-empty').then(
            () => null, (e) => e,
        );
        assert.strictEqual(err.retryable, true);
    },
));

t('having no session at all is retryable — one is about to exist', () => {
    return cs.lookupCallsignData('M0ABC', '').then(
        () => { throw new Error('expected a rejection'); },
        (err) => { assert.strictEqual(err.retryable, true); },
    );
});

// --- automatic requests -----------------------------------------------------

t('a request carries whether anybody asked for it', () => {
    const seen = [];
    const off = cs.onLookupRequest((c, opts) => seen.push([c, opts.auto]));
    cs.requestLookup('M0ABC');
    cs.requestLookup('G4XYZ', { auto: true });
    off();
    assert.deepStrictEqual(seen, [['M0ABC', false], ['G4XYZ', true]]);
});

t('a listener written before the flag existed still works', () => {
    // Nothing may break by taking one argument: the options object is always
    // passed, never undefined, so an old listener simply ignores it.
    const seen = [];
    const off = cs.onLookupRequest((c) => seen.push(c));
    cs.requestLookup('M0ABC', { auto: true });
    off();
    assert.deepStrictEqual(seen, ['M0ABC']);
});

chain.then(() => {
    if (process.exitCode) console.log('\ncallsign tests FAILED');
    else console.log(`\nall ${pass} callsign tests passed`);
});

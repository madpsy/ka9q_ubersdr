// The lock-screen lookup cache.
//
// This cache exists to stop the dial re-asking about the same station every time
// it crosses the spot, and it caches negative results for exactly that reason.
// The distinction it has to get right is between "asked, and there is no such
// station" — worth remembering — and "could not ask", which is worth nothing.
//
// Getting that wrong is not subtle from the operator's seat: powerOn() flips
// `running` and then registers the audio session, so the first automatic lookup
// after Start reliably 401s, and caching that as a miss blanked the operator's
// name and photo for that callsign for the life of the page.

const assert = require('assert');
const ml = require('./.build/medialookup.cjs');

let pass = 0;
let chain = Promise.resolve();
const t = (name, fn) => {
    chain = chain.then(() => Promise.resolve(fn())).then(
        () => { console.log('ok    ' + name); pass++; },
        (e) => { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; },
    );
};

// Installs a fetch stub for one test and counts the calls.
function withFetch(impl, fn) {
    const prev = global.fetch;
    let calls = 0;
    global.fetch = (...args) => { calls++; return impl(...args); };
    const count = () => calls;
    return Promise.resolve(fn(count)).finally(() => { global.fetch = prev; });
}

// startLookup resolves through a listener, so waiting means waiting for that.
function settled() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

// The one retry is on a two-second timer. Tests drive it rather than wait for
// it: setTimeout is swapped for something that records the callback.
function withClock(fn) {
    const prev = global.setTimeout;
    const queued = [];
    global.setTimeout = (cb, ms) => {
        // The zero-delay ticks in settled() are the test's own, not the retry's.
        if (!ms) return prev(cb, ms);
        queued.push(cb);
        return { unref() {} };
    };
    const tick = async () => {
        const due = queued.splice(0);
        for (const cb of due) cb();
        await new Promise((r) => prev(r, 0));
    };
    return Promise.resolve(fn(tick, () => queued.length))
        .finally(() => { global.setTimeout = prev; });
}

const ok = (body) => () => Promise.resolve({
    ok: true, status: 200, json: () => Promise.resolve(body),
});
const status = (code) => () => Promise.resolve({
    ok: false, status: code, json: () => Promise.resolve(null),
});

t('a result is cached, and asked for only once', () => withFetch(
    ok({ fname: 'Nathan', country: 'England', image: '/api/lookup/image/abc' }),
    async (calls) => {
        ml._resetLookups();
        ml.startLookup('M0ABC', 'sess-1');
        await settled();
        assert.deepStrictEqual(ml.peekLookup('M0ABC'), {
            firstName: 'Nathan', country: 'England', photo: '/api/lookup/image/abc',
        });
        ml.startLookup('M0ABC', 'sess-1');
        await settled();
        assert.strictEqual(calls(), 1, 'a cached callsign was asked about again');
    },
));

t('a 401 is not cached — the session was not ready, the callsign is fine', () => withFetch(
    status(401),
    async (calls) => {
        ml._resetLookups();
        await withClock(async () => {
            ml.startLookup('M0ABC', 'sess-1');
            await settled();
            assert.strictEqual(ml.peekLookup('M0ABC'), null, 'nothing to show yet');
            assert.strictEqual(calls(), 1);

            // The session is registered a moment later. This is the whole point:
            // the second attempt must actually go out.
            global.fetch = ok({ fname: 'Nathan', country: 'England', image: '' });
            ml.startLookup('M0ABC', 'sess-1');
            await settled();
            assert.strictEqual(
                ml.peekLookup('M0ABC').firstName, 'Nathan',
                'the 401 was cached as a miss and the retry never happened',
            );
        });
    },
));

t('the lost lookup retries itself — nobody else is going to', () => withFetch(
    status(401),
    async (calls) => {
        ml._resetLookups();
        await withClock(async (tick, queued) => {
            // The Markers panel asks once, keyed on which marker is selected,
            // and does not ask again while the operator sits on that station.
            ml.startLookup('M0ABC', 'sess-1');
            await settled();
            assert.strictEqual(calls(), 1);
            assert.strictEqual(queued(), 1, 'no retry was scheduled');

            global.fetch = ok({ fname: 'Nathan', country: 'England', image: '' });
            await tick();
            assert.strictEqual(
                ml.peekLookup('M0ABC').firstName, 'Nathan',
                'the retry did not happen, so the name stays blank',
            );
        });
    },
));

t('it retries once, not forever', () => withFetch(
    status(401),
    async (calls) => {
        ml._resetLookups();
        await withClock(async (tick, queued) => {
            ml.startLookup('M0ABC', 'sess-1');
            await settled();
            await tick();
            assert.strictEqual(calls(), 2, 'expected the original and one retry');
            assert.strictEqual(queued(), 0, 'the retry scheduled another retry');
        });
    },
));

t('a verdict is never retried', () => withFetch(
    status(404),
    async () => {
        ml._resetLookups();
        await withClock(async (tick, queued) => {
            ml.startLookup('QQQ9ZZ', 'sess-1');
            await settled();
            assert.strictEqual(queued(), 0, 'a 404 scheduled a pointless retry');
        });
    },
));

t('a pending retry does not outlive a reset', () => withFetch(
    status(401),
    async () => {
        ml._resetLookups();
        await withClock(async (tick, queued) => {
            ml.startLookup('M0ABC', 'sess-1');
            await settled();
            assert.strictEqual(queued(), 1);
            ml._resetLookups();
            assert.strictEqual(ml.peekLookup('M0ABC'), null);
        });
    },
));

t('a 404 is cached — there is no such station and asking again is waste', () => withFetch(
    status(404),
    async (calls) => {
        ml._resetLookups();
        ml.startLookup('QQQ9ZZ', 'sess-1');
        await settled();
        assert.strictEqual(ml.peekLookup('QQQ9ZZ'), null);
        ml.startLookup('QQQ9ZZ', 'sess-1');
        await settled();
        assert.strictEqual(calls(), 1, 'a known-absent callsign was asked about twice');
    },
));

t('a dropped connection is not cached', () => withFetch(
    () => Promise.reject(new TypeError('Failed to fetch')),
    async (calls) => {
        ml._resetLookups();
        await withClock(async () => {
            ml.startLookup('M0ABC', 'sess-1');
            await settled();
            ml.startLookup('M0ABC', 'sess-1');
            await settled();
            assert.strictEqual(calls(), 2, 'a network failure was treated as a verdict');
        });
    },
));

t('a retryable failure leaves nothing pending', () => withFetch(
    status(503),
    async () => {
        ml._resetLookups();
        await withClock(async () => {
            ml.startLookup('M0ABC', 'sess-1');
            await settled();
            // If the pending entry survived, this would be dropped on the floor
            // and the callsign would never resolve however often it was asked for.
            global.fetch = ok({ fname: 'Nathan', country: 'England', image: '' });
            ml.startLookup('M0ABC', 'sess-1');
            await settled();
            assert.strictEqual(ml.peekLookup('M0ABC').firstName, 'Nathan');
        });
    },
));

t('listeners hear results, and a failed one does not fire a false answer', () => withFetch(
    status(401),
    async () => {
        ml._resetLookups();
        const seen = [];
        const off = ml.onLookupResolved((call, value) => seen.push([call, value]));
        await withClock(async () => {
            ml.startLookup('M0ABC', 'sess-1');
            await settled();
        });
        off();
        assert.deepStrictEqual(seen, [], 'a 401 announced itself as a resolved lookup');
    },
));

t('no session means no request at all', () => withFetch(
    ok({ fname: 'Nathan' }),
    async (calls) => {
        ml._resetLookups();
        ml.startLookup('M0ABC', '');
        await settled();
        assert.strictEqual(calls(), 0);
    },
));

t('peeking is pure and safe on every render', () => {
    ml._resetLookups();
    assert.strictEqual(ml.peekLookup('M0ABC'), null);
    assert.strictEqual(ml.peekLookup(''), null);
    assert.strictEqual(ml.peekLookup(null), null);
});

chain.then(() => {
    if (process.exitCode) console.log('\nmedia lookup tests FAILED');
    else console.log(`\nall ${pass} media lookup tests passed`);
});

// Confirmed voice callsigns as markers.
//
// The store is thin, so what is worth pinning is the part that differs from the
// panel it shares an addon with: the bar asks for every band, and it asks once for
// the whole page however many things are drawing it.

const assert = require('assert');
const cv = require('./.build/voiceconfirmed.cjs');

let pass = 0;
const t = (name, fn) => {
    cv._resetConfirmedVoice();
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const ta = (name, fn) => {
    cv._resetConfirmedVoice();
    return Promise.resolve()
        .then(fn)
        .then(() => { console.log('ok    ' + name); pass++; },
            (e) => { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; });
};

const ROW = {
    callsign: 'mm3ndh', frequency: 14205000, band: '20m', mode: 'usb',
    last_heard: 1700000000, country: 'Scotland', country_code: 'GB', snr: 12,
};

function withFetch(impl, fn) {
    const prev = global.fetch;
    global.fetch = impl;
    return Promise.resolve(fn()).finally(() => { global.fetch = prev; cv._resetConfirmedVoice(); });
}

const settle = () => new Promise((r) => setTimeout(r, 0));

t('nothing is known until something subscribes', () => {
    assert.deepStrictEqual(cv.confirmedVoice(), []);
});

let chain = Promise.resolve();
const q = (name, fn) => { chain = chain.then(() => ta(name, fn)); };

q('the bar asks for every band, not the panel\'s chosen one', () => {
    const urls = [];
    return withFetch(
        (url) => { urls.push(url); return Promise.resolve({ ok: true, json: () => Promise.resolve({ spots: [] }) }); },
        async () => {
            const off = cv.subscribeConfirmedVoice(() => {});
            await settle();
            assert.strictEqual(urls.length, 1);
            // A band filter here would blank the bar the moment the operator tuned
            // somewhere the panel's picker was not pointed at.
            assert.ok(!/[?&]band=/.test(urls[0]), `no band filter, got ${urls[0]}`);
            assert.ok(urls[0].includes(`limit=${cv.MARKER_ROWS}`), `asks for MARKER_ROWS, got ${urls[0]}`);
            off();
        },
    );
});

q('two subscribers share one request, not one each', () => {
    let calls = 0;
    return withFetch(
        () => { calls++; return Promise.resolve({ ok: true, json: () => Promise.resolve({ spots: [ROW] }) }); },
        async () => {
            const offA = cv.subscribeConfirmedVoice(() => {});
            const offB = cv.subscribeConfirmedVoice(() => {});
            await settle();
            assert.strictEqual(calls, 1);
            offA();
            offB();
        },
    );
});

q('rows arrive normalised, so a marker has a callsign and a frequency', () => {
    return withFetch(
        () => Promise.resolve({ ok: true, json: () => Promise.resolve({ spots: [ROW] }) }),
        async () => {
            const seen = [];
            const off = cv.subscribeConfirmedVoice((list) => seen.push(list));
            await settle();
            assert.strictEqual(seen.length, 1);
            const [sp] = seen[0];
            assert.strictEqual(sp.callsign, 'MM3NDH');
            assert.strictEqual(sp.hz, 14205000);
            // Seconds at the addon, milliseconds everywhere here — mixing the two
            // reads as 1970 in the tooltip.
            assert.strictEqual(sp.at, 1700000000000);
            off();
        },
    );
});

q('a late subscriber gets what is already known rather than an empty bar', () => {
    return withFetch(
        () => Promise.resolve({ ok: true, json: () => Promise.resolve({ spots: [ROW] }) }),
        async () => {
            const offA = cv.subscribeConfirmedVoice(() => {});
            await settle();
            let replayed = null;
            const offB = cv.subscribeConfirmedVoice((list) => { replayed = list; });
            assert.ok(replayed && replayed.length === 1, 'the second subscriber is replayed at once');
            offA();
            offB();
        },
    );
});

q('a failed poll keeps the markers that are up', () => {
    let first = true;
    return withFetch(
        () => {
            if (first) { first = false; return Promise.resolve({ ok: true, json: () => Promise.resolve({ spots: [ROW] }) }); }
            return Promise.resolve({ ok: false, status: 502 });
        },
        async () => {
            const off = cv.subscribeConfirmedVoice(() => {});
            await settle();
            assert.strictEqual(cv.confirmedVoice().length, 1);
            // These are stations that were heard, and they were still heard whatever
            // the addon is doing now.
            await settle();
            assert.strictEqual(cv.confirmedVoice().length, 1);
            off();
        },
    );
});

chain.then(() => {
    if (process.exitCode) console.log('\nconfirmed voice tests FAILED');
    else console.log(`\nall ${pass} confirmed voice tests passed`);
});

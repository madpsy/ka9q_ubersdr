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

// --- a callsign nobody has heard before ----------------------------------------

// Two stores in one bundle, so a poll here really does push into the notification store
// the assertions read. See voiceconfirmed.entry.js.
const CALL = (callsign, frequency, extra) => ({ ...ROW, callsign, frequency, ...extra });

// The source ships off, so every one of these has to ask for it — which is the point.
function withNotices(fn) {
    cv._resetNotificationStore();
    cv.setSourceEnabled('voice-callsign', true);
    return Promise.resolve(fn()).finally(() => cv._resetNotificationStore());
}

const reply = (spots) => Promise.resolve({ ok: true, json: () => Promise.resolve({ spots }) });

// One poll. feedInterval fires immediately on the first subscriber and then every 30 s,
// so a second poll inside a test is a second subscribe rather than a wait — the store's
// own state survives the gap, which is exactly what these are about.
const poll = async () => {
    const off = cv.subscribeConfirmedVoice(() => {});
    await settle();
    off();
};

q('the first list is a baseline, not fifty toasts', () => {
    // It is what the skimmer heard before the page was opened. Greeting somebody with a
    // wall of notifications about things that happened while they were away is the whole
    // failure this guards.
    return withNotices(() => withFetch(
        () => reply([CALL('mm3ndh', 14205000), CALL('g0rql', 7150000)]),
        async () => {
            await poll();
            assert.strictEqual(cv.notificationState().history.length, 0);
        },
    ));
});

q('a callsign that was not in the last list is announced, with flag and frequency', () => {
    let n = 0;
    return withNotices(() => withFetch(
        () => (++n === 1
            ? reply([CALL('mm3ndh', 14205000)])
            : reply([CALL('g0rql', 7150000, { country: 'England', country_code: 'GB', band: '40m' }),
                CALL('mm3ndh', 14205000)])),
        async () => {
            await poll();
            await poll();
            const { history } = cv.notificationState();
            // The one that is new, and only that one.
            assert.strictEqual(history.length, 1);
            assert.strictEqual(history[0].title, '\u{1F1EC}\u{1F1E7} G0RQL');
            assert.ok(history[0].body.includes('7.150 MHz'), history[0].body);
            assert.ok(history[0].body.includes('40m'), history[0].body);
            assert.ok(history[0].body.includes('England'), history[0].body);
            // And pressing it goes there. A notification that names a frequency and then
            // makes you type it into the dial has done half a job.
            assert.deepStrictEqual(history[0].action,
                { kind: 'tune', frequency: 7150000, mode: 'usb' });
        },
    ));
});

q('a burst has no action, because it names no one frequency', () => {
    let n = 0;
    const many = ['g0rql', 'dl1abc', 'f5xyz', 'ea1def'].map((c, i) => CALL(c, 7150000 + i * 1000));
    return withNotices(() => withFetch(
        () => (++n === 1 ? reply([CALL('mm3ndh', 14205000)]) : reply(many)),
        async () => {
            await poll();
            await poll();
            assert.strictEqual(cv.notificationState().history[0].action, null);
        },
    ));
});

q('the same station heard again is not news, on any frequency', () => {
    // Deduplicated by callsign rather than by the sighting's key, which carries the
    // frequency: a station that drifts 200 Hz between polls has not arrived twice.
    let n = 0;
    return withNotices(() => withFetch(
        () => { n++; return reply([CALL('mm3ndh', 14205000 + (n - 1) * 200)]); },
        async () => {
            await poll();
            await poll();
            await poll();
            assert.strictEqual(cv.notificationState().history.length, 0);
        },
    ));
});

q('a burst is a count, not a wall the toast layer would truncate', () => {
    let n = 0;
    const many = ['g0rql', 'dl1abc', 'f5xyz', 'ea1def', 'i0ghi'].map((c, i) => CALL(c, 7150000 + i * 1000));
    return withNotices(() => withFetch(
        () => (++n === 1 ? reply([CALL('mm3ndh', 14205000)]) : reply(many)),
        async () => {
            await poll();
            await poll();
            const { history } = cv.notificationState();
            // Five at once, three toasts on screen: announcing each would be announcing
            // three of them and silently dropping the rest.
            assert.strictEqual(history.length, 1);
            assert.strictEqual(history[0].title, '5 new callsigns');
            assert.ok(history[0].body.includes('and 2 more'), history[0].body);
        },
    ));
});

q('switched off, the poll still moves the baseline', () => {
    // Otherwise switching it on would fire a burst about everything heard while it was
    // off — which is the same wall, just deferred.
    let n = 0;
    return withNotices(() => withFetch(
        () => (++n === 1 ? reply([CALL('mm3ndh', 14205000)]) : reply([CALL('g0rql', 7150000)])),
        async () => {
            cv.setSourceEnabled('voice-callsign', false);
            await poll();
            await poll();
            assert.strictEqual(cv.notificationState().history.length, 0);
            // Now it is wanted, and G0RQL is old news rather than the first thing said.
            cv.setSourceEnabled('voice-callsign', true);
            await poll();
            assert.strictEqual(cv.notificationState().history.length, 0);
        },
    ));
});

chain.then(() => {
    if (process.exitCode) console.log('\nconfirmed voice tests FAILED');
    else console.log(`\nall ${pass} confirmed voice tests passed`);
});

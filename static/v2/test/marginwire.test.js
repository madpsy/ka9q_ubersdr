// What the client actually asks the server for, at each end of the slider.
//
// The promise the top of the control makes is not "a very fine quantiser" but
// the original 16-bit path, and on the wire that means asking for NOTHING: no
// `min_margin` in the connect URL at all, so the request is byte-for-byte the
// one every client sent before the mode existed. A default that quietly
// requested 60 dB would look identical in the panel and be a different stream.
//
// The other half is the live move. Dragging to the top on a running stream must
// send the sentinel rather than wait for a reconnect that may never come.

const assert = require('assert');
const {
    AudioConnection, MARGIN_LOSSLESS, MARGIN_DEFAULT_DB, marginFromSlider,
} = require('./.build/marginwire.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};
const at = async (name, fn) => {
    try { await fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// Enough of a browser to reach the URL. The connection check reports "allowed"
// when its fetch does not complete, which is what lets this run offline.
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};
const loc = { protocol: 'http:', host: 'test.invalid', hostname: 'test.invalid', href: 'http://test.invalid/' };
globalThis.location = loc;
globalThis.window = { location: loc, localStorage: globalThis.localStorage };
globalThis.fetch = () => Promise.reject(new Error('offline'));

let lastUrl = null;
class StubSocket {
    constructor(url) { lastUrl = url; throw new Error('no socket in this test'); }
}
StubSocket.OPEN = 1;
globalThis.WebSocket = StubSocket;

const TUNING = { frequency: 14074000, mode: 'iq48', bandwidthLow: -6000, bandwidthHigh: 6000 };

async function urlFor(minMargin) {
    const conn = new AudioConnection();
    conn.setFormat('pcm-zstd');
    conn.setMinMargin(minMargin);
    lastUrl = null;
    await conn.connect(TUNING);
    conn.disconnect();   // a failed connect schedules a retry; stop it
    assert.ok(lastUrl, 'no URL was built');
    return new URL(lastUrl.replace(/^ws/, 'http'));
}

t('a fresh connection asks for nothing', () => {
    assert.strictEqual(new AudioConnection().minMargin, 0);
});

t('the top of the slider is not a margin request', () => {
    const conn = new AudioConnection();
    conn.setMinMargin(MARGIN_LOSSLESS);
    assert.strictEqual(conn.minMargin, 0, 'the lossless position asked for a margin');
    // And anything past it, so a stale saved position cannot turn the mode on.
    conn.setMinMargin(MARGIN_LOSSLESS + 20);
    assert.strictEqual(conn.minMargin, 0);
});

t('a real position is kept', () => {
    const conn = new AudioConnection();
    conn.setMinMargin(MARGIN_DEFAULT_DB);
    assert.strictEqual(conn.minMargin, MARGIN_DEFAULT_DB);
});

(async () => {
    await at('the connect URL omits min_margin entirely when lossless', async () => {
        const u = await urlFor(marginFromSlider(MARGIN_LOSSLESS));
        assert.strictEqual(u.searchParams.has('min_margin'), false,
            `min_margin=${u.searchParams.get('min_margin')} was requested for a lossless stream`);
        // The rest of the request must look exactly as it always did.
        assert.strictEqual(u.searchParams.get('format'), 'pcm-zstd');
        assert.strictEqual(u.searchParams.get('version'), '4');
    });

    await at('the connect URL carries the margin when one is asked for', async () => {
        const u = await urlFor(MARGIN_DEFAULT_DB);
        assert.strictEqual(u.searchParams.get('min_margin'), String(MARGIN_DEFAULT_DB));
    });

    await at('moving to the top on a live stream sends the sentinel', async () => {
        const conn = new AudioConnection();
        const sent = [];
        conn.ws = { readyState: StubSocket.OPEN, send: (s) => sent.push(JSON.parse(s)) };
        conn.setMinMargin(MARGIN_DEFAULT_DB);
        conn.setMinMargin(MARGIN_LOSSLESS);
        assert.deepStrictEqual(sent.map((m) => m.type),
            ['set_min_margin', 'set_min_margin']);
        assert.strictEqual(sent[0].min_margin, MARGIN_DEFAULT_DB);
        assert.strictEqual(sent[1].min_margin, 0,
            'the top of the slider did not send 0; the stream would stay lossy');
    });

    console.log(`\n${pass} passing`);
    // Nothing here should hold the loop open, but a stray reconnect timer would;
    // exit on the result rather than waiting to find out.
    process.exit(process.exitCode || 0);
})();

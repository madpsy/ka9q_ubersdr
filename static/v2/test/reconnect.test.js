// What the audio and spectrum sockets do when the server says no.
//
// This is the "I have to shift-refresh to get the audio/waterfall running" bug,
// pinned. Three separate ways the pair used to strand themselves, all of which
// leave a page that looks connected and is not:
//
//   * a refusal that clears itself — a full receiver, a rate limit — was
//     treated as final. The spectrum scheduled no reconnect for *any* refusal,
//     and the audio only for one whose text happened to contain "maximum".
//   * a refusal delivered over the socket (the session is created after the
//     upgrade, so that is where a creation rate limit lands) was followed by a
//     clean close, and a clean close meant "the operator asked for this".
//   * the reconnect budget was refilled on the open event, which a refused
//     connection also fires — so the backoff reset on precisely the failure it
//     exists for, and the client retried once a second indefinitely.
//
// The sockets are driven directly rather than through the context: what is
// under test is the connection's own decision, and a React tree between the
// assertion and the thing being asserted would only make failures harder to
// read.

const assert = require('assert');

const sockets = [];

class FakeSocket {
    constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.sent = [];
        this.closed = null;
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.onclose = null;
        sockets.push(this);
    }

    send(d) { this.sent.push(d); }

    close(code, reason) {
        if (this.closed) return;
        this.closed = { code, reason };
        this.readyState = 2;
    }

    open() { this.readyState = 1; if (this.onopen) this.onopen(); }

    /** A text frame — the server's `error` messages arrive this way. */
    deliver(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }

    /** The close event, with whatever code the server chose. */
    land(code) {
        this.readyState = 3;
        if (this.onclose) this.onclose({ code: code != null ? code : 1006, reason: '' });
    }
}
FakeSocket.OPEN = 1;

global.WebSocket = FakeSocket;
global.location = { protocol: 'http:', host: 'rx.test', search: '' };
global.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
Object.defineProperty(global, 'crypto', {
    value: {
        randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        getRandomValues: (b) => b,
    },
    configurable: true,
});
global.window = global;

// What /connection answers. Steered per test.
let reply = { allowed: true, reason: '', status: 200 };

global.fetch = async () => ({
    status: reply.status,
    json: async () => ({
        allowed: reply.allowed,
        reason: reply.reason,
        client_ip: '10.0.0.9',
        session_timeout: 0,
        max_session_time: 0,
    }),
});

const { AudioConnection } = require('./.build/audio.cjs');
const { SpectrumConnection } = require('./.build/spectrum.cjs');

const TUNING = { frequency: 7100000, mode: 'lsb', bandwidthLow: 200, bandwidthHigh: 2800 };

let pass = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);

const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

// Both sockets are built the same way, so almost every case below is the same
// case twice. Named rather than duplicated, so a fix to one that misses the
// other fails here instead of in somebody's browser.
const KINDS = [
    ['audio', () => new AudioConnection(), (c) => c.connect(TUNING)],
    ['spectrum', () => new SpectrumConnection(), (c) => c.connect({ frequency: 7100000, binBandwidth: 100 })],
];

async function run() {
    for (const [name, fn] of queue) {
        sockets.length = 0;
        reply = { allowed: true, reason: '', status: 200 };
        try {
            await fn();
            console.log('ok    ' + name);
            pass++;
        } catch (e) {
            console.log('FAIL  ' + name + '\n      ' + (e && e.message));
            process.exitCode = 1;
        }
    }
    if (!process.exitCode) console.log(`\n${pass} passed`);
}

// --- a refusal from /connection ---------------------------------------------

for (const [kind, make, open] of KINDS) {
    t(`${kind}: a full receiver is waited out, not given up on`, async () => {
        reply = { allowed: false, reason: 'Maximum unique users reached (2 of 2)', status: 503 };
        const conn = make();
        const seen = [];
        conn.on('error', (e) => seen.push(e));
        await open(conn);
        assert.strictEqual(sockets.length, 0, 'no socket while refused');
        assert.strictEqual(conn.state, 'reconnecting', 'it is going to try again');
        assert.strictEqual(seen[0].failure, 'retry');
        conn.disconnect();
    });

    t(`${kind}: a rate limit is waited out too`, async () => {
        // The one the old audio test missed: "Rate limit exceeded" does not
        // contain "maximum", so the socket gave up for good on a refusal that
        // clears in seconds. The spectrum gave up on everything.
        reply = {
            allowed: false,
            reason: 'Rate limit exceeded. Please wait before trying again.',
            status: 429,
        };
        const conn = make();
        await open(conn);
        assert.strictEqual(conn.state, 'reconnecting');
        conn.disconnect();
    });

    t(`${kind}: an ended session is not retried, and says why`, async () => {
        reply = {
            allowed: false,
            reason: 'Your session has been terminated. Please refresh the page.',
            status: 410,
        };
        const conn = make();
        const seen = [];
        conn.on('error', (e) => seen.push(e));
        await open(conn);
        assert.strictEqual(conn.state, 'rejected');
        assert.strictEqual(conn.reconnectTimer, null, 'a blacklisted id is not worth retrying');
        assert.strictEqual(seen[0].failure, 'identity');
        conn.disconnect();
    });

    t(`${kind}: a ban is not retried`, async () => {
        reply = { allowed: false, reason: 'Your IP address has been banned', status: 403 };
        const conn = make();
        const seen = [];
        conn.on('error', (e) => seen.push(e));
        await open(conn);
        assert.strictEqual(conn.reconnectTimer, null);
        assert.strictEqual(seen[0].failure, 'blocked');
        conn.disconnect();
    });
}

// --- a refusal over the socket, after the upgrade ----------------------------

t('audio: a creation rate limit closed cleanly is still retried', async () => {
    // The server upgrades, fails to create the session, sends its error and
    // closes. A clean close used to mean "deliberate", so the audio stopped for
    // good on something that clears in ten seconds.
    const conn = new AudioConnection();
    await conn.connect(TUNING);
    sockets[0].open();
    sockets[0].deliver({
        type: 'error',
        error: 'Failed to create session: too many session attempts; please wait a moment before reconnecting',
    });
    sockets[0].land(1000);
    assert.strictEqual(conn.state, 'reconnecting');
    conn.disconnect();
});

t('spectrum: a creation rate limit closed cleanly is still retried', async () => {
    const conn = new SpectrumConnection();
    await conn.connect({ frequency: 7100000, binBandwidth: 100 });
    sockets[0].open();
    sockets[0].deliver({
        type: 'error',
        error: 'Failed to create spectrum session: too many session attempts; please wait a moment before reconnecting',
    });
    sockets[0].land(1000);
    assert.strictEqual(conn.state, 'reconnecting');
    conn.disconnect();
});

t('audio: a session the server has ended stops rather than looping', async () => {
    const conn = new AudioConnection();
    const seen = [];
    conn.on('error', (e) => seen.push(e));
    await conn.connect(TUNING);
    sockets[0].open();
    sockets[0].deliver({ type: 'error', error: 'Your session has been terminated.', status: 410 });
    sockets[0].land(1006);
    assert.strictEqual(conn.state, 'idle');
    assert.strictEqual(conn.reconnectTimer, null);
    assert.ok(seen.some((e) => e.failure === 'identity'), 'and it said so');
    conn.disconnect();
});

t('spectrum: a session the server has ended stops rather than looping', async () => {
    const conn = new SpectrumConnection();
    await conn.connect({ frequency: 7100000, binBandwidth: 100 });
    sockets[0].open();
    sockets[0].deliver({ type: 'error', error: 'Invalid session. Please refresh the page and try again.' });
    sockets[0].land(1006);
    assert.strictEqual(conn.state, 'idle');
    assert.strictEqual(conn.reconnectTimer, null);
    conn.disconnect();
});

t('an ordinary drop is still retried, with nothing said about it', async () => {
    const conn = new AudioConnection();
    await conn.connect(TUNING);
    sockets[0].open();
    sockets[0].land(1006);                     // the network, not the server
    assert.strictEqual(conn.state, 'reconnecting');
    conn.disconnect();
});

// --- the reconnect budget ----------------------------------------------------

t('audio: being refused after the upgrade does not refill the budget', async () => {
    const conn = new AudioConnection();
    await conn.connect(TUNING);
    for (let i = 0; i < 3; i++) {
        const ws = sockets[sockets.length - 1];
        ws.open();                              // upgraded...
        ws.deliver({ type: 'error', error: 'too many session attempts' });
        ws.land(1000);                          // ...and refused
        assert.strictEqual(conn.attempts, i + 1, 'the count keeps climbing');
        conn.reconnectTimer = null;
        await conn.connect(TUNING);
    }
    conn.disconnect();
});

t('audio: a packet refills the budget', async () => {
    const conn = new AudioConnection();
    conn.attempts = 6;
    await conn.connect(TUNING);
    sockets[0].open();
    assert.strictEqual(conn.attempts, 6, 'opening proves nothing');
    // v2 header: timestamp(8) sampleRate(4) channels(1) power(4) noise(4).
    const buf = new ArrayBuffer(21 + 4);
    const v = new DataView(buf);
    v.setUint32(8, 48000, true);
    v.setUint8(12, 1);
    v.setFloat32(13, -60, true);
    v.setFloat32(17, -120, true);
    sockets[0].onmessage({ data: buf });
    assert.strictEqual(conn.attempts, 0, 'audio arriving does');
    conn.disconnect();
});

t('spectrum: a frame refills the budget, an open event does not', async () => {
    const conn = new SpectrumConnection();
    conn.attempts = 6;
    await conn.connect({ frequency: 7100000, binBandwidth: 100 });
    sockets[0].open();
    assert.strictEqual(conn.attempts, 6, 'opening proves nothing');

    // A SPEC frame with a full 8-bit payload — flags 0x03, four bins.
    const n = 4;
    const buf = new ArrayBuffer(22 + n);
    const v = new DataView(buf);
    v.setUint8(0, 0x53); v.setUint8(1, 0x50); v.setUint8(2, 0x45); v.setUint8(3, 0x43);
    v.setUint8(4, 0x01);
    v.setUint8(5, 0x03);
    v.setBigUint64(6, BigInt(1700000000000), true);
    v.setUint32(14, 7100000, true);
    v.setUint32(18, 0, true);
    for (let i = 0; i < n; i++) v.setUint8(22 + i, 100 + i);
    sockets[0].onmessage({ data: buf });
    assert.strictEqual(conn.attempts, 0, 'bins on the wire do');
    conn.disconnect();
});

run();

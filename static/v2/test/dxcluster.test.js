// The spot/chat socket's lifecycle — the part of it that is a race.
//
// Everything worth testing here is invisible when you get it wrong. A socket
// replaced while the old one is still closing looks fine for a second and then
// starts flapping; a socket opened under the wrong session id looks connected
// and carries nothing; a connection refused after the upgrade resets the very
// backoff it should be feeding. All three produce "Reconnecting…" appearing and
// clearing on a loop, and none of them produce an error anybody can read.
//
// There is no WebSocket in node, so one is supplied. It is deliberately not
// instant: `open()` and `land()` are called by the test, because *when* the
// events arrive relative to each other is the whole subject.

const assert = require('assert');

// --- a WebSocket that does nothing until told -------------------------------

const sockets = [];

class FakeSocket {
    constructor(url) {
        this.url = url;
        this.readyState = 0;            // CONNECTING
        this.sent = [];
        this.closed = null;             // { code, reason }
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.onclose = null;
        sockets.push(this);
    }

    send(data) { this.sent.push(data); }

    close(code, reason) {
        if (this.closed) return;
        this.closed = { code, reason };
        this.readyState = 2;            // CLOSING — the event has not landed yet
    }

    /** The server accepted the upgrade. */
    open() {
        this.readyState = 1;
        if (this.onopen) this.onopen();
    }

    /** The close event finally arrives, however long after close() was called. */
    land() {
        this.readyState = 3;
        if (this.onclose) this.onclose({ code: this.closed ? this.closed.code : 1006 });
    }

    /** A text frame from the server. */
    deliver(obj) {
        if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
    }
}
FakeSocket.OPEN = 1;

global.WebSocket = FakeSocket;
global.location = { protocol: 'http:', host: 'rx.test', search: '' };
global.sessionStorage = {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
};

// The session id the page is currently on, and the /connection answer that goes
// with it. Both are steered by the tests.
let currentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let allowed = true;
let checks = 0;

global.fetch = async () => {
    checks += 1;
    return {
        status: 200,
        json: async () => ({
            allowed,
            reason: allowed ? '' : 'Maximum unique users reached (2 of 2)',
            client_ip: '10.0.0.9',
            session_timeout: 0,
            max_session_time: 0,
        }),
    };
};

// defineProperty, not assignment: node 20 defines globalThis.crypto as a
// non-writable accessor, so `global.crypto = …` fails silently in a CJS bundle
// and the connection quietly gets node's real WebCrypto — which mints a genuine
// UUID and makes every assertion about *which* id was used look like a bug in
// the code under test.
Object.defineProperty(global, 'crypto', {
    value: { randomUUID: () => currentId, getRandomValues: (b) => b },
    configurable: true,
});
global.window = global;

// One bundle, so the connection and the session id it reads are the same copies —
// see dxcluster.entry.js.
const dxmod = require('./.build/dxclustertest.cjs');
const sessionmod = dxmod;

// Lets a test move the page onto a new session id, as powerOn does.
const restart = (id) => { currentId = id; sessionmod.newSessionId(); };

// Queued rather than fired off, because every case here shares one `sockets`
// list and one module-level session id: run concurrently they read each other's
// sockets, which is a confusing way to fail a test about confusing failures.
//
// The connection is made here and disconnected here too. An open socket runs a
// 20 s ping interval, which is enough to keep node alive for ever after the
// last assertion has passed — a green run that never exits.
let pass = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);

async function run() {
    for (const [name, fn] of queue) {
        sockets.length = 0;
        checks = 0;
        allowed = true;
        currentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        sessionmod.newSessionId();
        const conn = new dxmod.DXClusterConnection();
        try {
            await fn(conn);
            console.log('ok    ' + name);
            pass++;
        } catch (e) {
            console.log('FAIL  ' + name + '\n      ' + (e && e.message));
            process.exitCode = 1;
        }
        conn.disconnect();
    }
    if (!process.exitCode) console.log(`\n${pass} passed`);
}

// connect() awaits a fetch, so settling the microtask queue is how a test waits
// for a socket to exist. Two turns: the fetch, then its .json().
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

const idOf = (ws) => new URL(ws.url.replace('ws:', 'http:')).searchParams.get('user_session_id');

// --- opening ----------------------------------------------------------------

t('a stream is what opens the socket, and the last release closes it', async (conn) => {
    const release = conn.acquire('dx_spots');
    await settle();
    assert.strictEqual(sockets.length, 1, 'one socket');
    sockets[0].open();
    assert.strictEqual(conn.state, 'open');
    assert.ok(sockets[0].sent.some((s) => JSON.parse(s).type === 'subscribe_dx_spots'));

    release();
    assert.strictEqual(conn.state, 'idle');
    assert.deepStrictEqual(sockets[0].closed, { code: 1000, reason: 'client' });
});

t('the socket opens under the id the connection check registered', async (conn) => {
    conn.acquire('dx_spots');
    await settle();
    assert.strictEqual(idOf(sockets[0]), sessionmod.getSessionId());
});

t('a session restarted mid-check is not opened under either stale id', async (conn) => {
    // powerOn mints a new id while the POST is in flight. The reply describes
    // the id that has just been replaced, and the socket must carry neither
    // that one nor an id the server has not been told about — it starts again.
    conn.acquire('dx_spots');
    await Promise.resolve();                     // the fetch is away
    restart('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    await settle();

    assert.strictEqual(sockets.length, 1, 'one socket, not one per attempt');
    assert.strictEqual(idOf(sockets[0]), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    assert.ok(checks >= 2, 'the new id was registered before it was used');
});

// --- replacing --------------------------------------------------------------

t('a late close from the socket being replaced cannot touch its replacement', async (conn) => {
    // The bug this exists for: refresh() closed one socket and opened another,
    // and on a fast link the first close event landed *after* the second was
    // live. _onClose then nulled the live socket, stopped its pings and booked
    // a reconnect — "Reconnecting…" over a socket that was working.
    conn.acquire('dx_spots');
    await settle();
    const first = sockets[0];
    first.open();

    restart('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    assert.strictEqual(conn.stale, true);
    assert.strictEqual(conn.refresh(), true);
    await settle();

    assert.strictEqual(sockets.length, 2, 'exactly one replacement');
    const second = sockets[1];
    second.open();
    assert.strictEqual(conn.state, 'open');

    // Now the first socket's close finally arrives.
    first.land();

    assert.strictEqual(conn.state, 'open', 'still open, not reconnecting');
    assert.strictEqual(conn.connected, true, 'the live socket is still the live socket');
    assert.strictEqual(conn.send({ type: 'ping' }), true);
    assert.strictEqual(sockets.length, 2, 'no third socket was opened');
});

t('a replacement never passes through idle or reconnecting', async (conn) => {
    const seen = [];
    conn.on('state', (s) => seen.push(s));
    conn.acquire('dx_spots');
    await settle();
    sockets[0].open();
    seen.length = 0;

    restart('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    conn.refresh();
    await settle();
    sockets[1].open();

    assert.ok(!seen.includes('idle'), `no idle in ${seen.join(',')}`);
    assert.ok(!seen.includes('reconnecting'), `no reconnecting in ${seen.join(',')}`);
});

t('a replacement reports the closure once, and resubscribes on the new socket', async (conn) => {
    let closes = 0;
    conn.on('close', () => { closes += 1; });
    conn.acquire('dx_spots');
    await settle();
    sockets[0].open();

    restart('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    conn.refresh();
    await settle();
    sockets[1].open();
    sockets[0].land();                            // the late one, already abandoned

    assert.strictEqual(closes, 1, 'one close, from the replacement itself');
    assert.ok(sockets[1].sent.some((s) => JSON.parse(s).type === 'subscribe_dx_spots'),
        'the subscription survived the move');
});

t('refresh is a no-op, and says so, when the id has not moved', async (conn) => {
    conn.acquire('dx_spots');
    await settle();
    sockets[0].open();
    assert.strictEqual(conn.refresh(), false);
    assert.strictEqual(sockets.length, 1);
});

// --- backoff ----------------------------------------------------------------

t('a connection refused after the upgrade does not refill the backoff', async (conn) => {
    // The server upgrades first and only then decides — a reclaimed session, a
    // creation rate limit — so a refusal arrives as open-then-close. Clearing
    // `attempts` on the open event reset the backoff on exactly that failure,
    // and the socket retried once a second for as long as the page was up.
    conn.acquire('dx_spots');
    await settle();

    for (let i = 0; i < 4; i++) {
        const ws = sockets[sockets.length - 1];
        ws.open();
        ws.land();                                 // refused, inside a round trip
        assert.strictEqual(conn.state, 'reconnecting');
        assert.strictEqual(conn.attempts, i + 1, 'the count keeps climbing');
        conn.reconnectTimer = null;                // fire the timer by hand
        conn.connect();
        await settle();
    }
});

t('a socket that stays up earns its budget back', async (conn) => {
    conn.attempts = 7;
    conn.acquire('dx_spots');
    await settle();
    sockets[0].open();
    assert.strictEqual(conn.attempts, 7, 'not yet — it has only just opened');
    await new Promise((r) => setTimeout(r, 5100));
    assert.strictEqual(conn.attempts, 0, 'settled, so the next drop starts from scratch');
});

// --- refusal ----------------------------------------------------------------

t('a refused connection check opens no socket', async (conn) => {
    allowed = false;
    const errors = [];
    conn.on('error', (e) => errors.push(e.message));
    conn.acquire('dx_spots');
    await settle();
    assert.strictEqual(sockets.length, 0);
    assert.strictEqual(conn.state, 'rejected');
    assert.ok(/Maximum/.test(errors[0]), errors[0]);
});

run();

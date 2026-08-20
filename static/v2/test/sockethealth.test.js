// The three ways a socket can be dead without anything saying so.
//
// Every reconnect path in this client hangs off `onclose`, which is fine for
// the failures that produce one and useless for the ones that do not. These are
// the ones that do not, and all three of them end at the same place — a page
// showing a connected receiver that is not connected to anything:
//
//   * a socket replaced by a second connect() and left running. The browser
//     keeps a handshake in CONNECTING for ever unless it is closed, which is
//     the pile of Pending rows with no status and no bytes in devtools.
//   * a handshake nothing ever answers. No open, so no close, so no reconnect.
//   * a socket that was open when the machine went to sleep and is half-open
//     now. readyState is still OPEN and send() still succeeds; only a round
//     trip can tell the difference, and only something outside the connection
//     knows when to ask for one.
//
// Driven directly rather than through React, like reconnect.test.js next door:
// what is under test is the connection's own decision.

const assert = require('assert');

const sockets = [];

class FakeSocket {
    constructor(url) {
        this.url = url;
        this.readyState = 0;        // CONNECTING
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
        this.readyState = 2;        // CLOSING
    }

    open() { this.readyState = 1; if (this.onopen) this.onopen(); }

    deliver(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }

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

let now = 1700000000000;
Date.now = () => now;

global.fetch = async () => ({
    status: 200,
    json: async () => ({
        allowed: true, reason: '', client_ip: '10.0.0.9', session_timeout: 0, max_session_time: 0,
    }),
});

const { AudioConnection } = require('./.build/audio.cjs');
const { SpectrumConnection } = require('./.build/spectrum.cjs');
const health = require('./.build/sockethealth.cjs');

// Timers under the test's control, so a probe that is meant to expire in six
// seconds does not cost six seconds to find out about.
const pending = [];
const timers = {
    set: (fn) => { pending.push(fn); return pending.length; },
    clear: () => {},
};
const expire = () => { const q = pending.splice(0); for (const fn of q) fn(); };

const TUNING = { frequency: 7100000, mode: 'lsb', bandwidthLow: 200, bandwidthHigh: 2800 };

// Both sockets are the same shape, so every case below is the same case twice —
// named rather than duplicated, so a fix to one that misses the other fails
// here rather than in somebody's browser.
const KINDS = [
    ['audio', () => new AudioConnection(), (c) => c.connect(TUNING)],
    ['spectrum', () => new SpectrumConnection(), (c) => c.connect({ frequency: 7100000, binBandwidth: 100 })],
];

let pass = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

// --- one socket at a time ----------------------------------------------------

for (const [kind, make, open] of KINDS) {
    t(`${kind}: a second connect during the check does not open a second socket`, async () => {
        const conn = make();
        // Both calls made before either can get past `await connectionCheck()`,
        // which is exactly what two clicks on the power button do, and what the
        // idle pause and a hidden tab do to the spectrum between them.
        const a = open(conn);
        const b = open(conn);
        await a; await b;
        await settle();
        assert.strictEqual(sockets.length, 1, 'one socket, not two');
        assert.strictEqual(conn.ws, sockets[0]);
        conn.disconnect();
    });

    t(`${kind}: connecting while one is already up is a no-op`, async () => {
        const conn = make();
        await open(conn);
        await settle();
        sockets[0].open();
        await open(conn);
        await settle();
        assert.strictEqual(sockets.length, 1, 'the live socket is left alone');
        conn.disconnect();
    });

    t(`${kind}: a connect that is refused leaves nothing holding the door`, async () => {
        // The guard is only any use if it is released on every path out of
        // connect(), including the ones that never reach `new WebSocket`.
        const conn = make();
        conn.closedByUser = false;
        const p = open(conn);
        conn.disconnect();          // let go while the check is in flight
        await p;
        await settle();
        assert.strictEqual(conn.opening, false, 'not left half-open');
        assert.strictEqual(sockets.length, 0);
        // And a later connect still works.
        conn.closedByUser = false;
        await open(conn);
        await settle();
        assert.strictEqual(sockets.length, 1);
        conn.disconnect();
    });
}

// --- a handshake nothing answers ---------------------------------------------

for (const [kind, make, open] of KINDS) {
    t(`${kind}: an unanswered handshake is given up on and retried`, async () => {
        const conn = make();
        const closes = [];
        conn.on('close', (e) => closes.push(e));
        await open(conn);
        await settle();
        const ws = sockets[0];
        assert.strictEqual(ws.closed, null, 'still waiting');

        // Long enough that the deadline has passed. checkAlive is the same
        // decision the deadline's own timer makes, without the fifteen seconds.
        now += 20000;
        assert.strictEqual(conn.checkAlive(timers), 'handshake');

        assert.ok(ws.closed, 'the orphan is closed, not just forgotten');
        assert.strictEqual(ws.onclose, null, 'and detached, so it cannot report back');
        assert.strictEqual(conn.ws, null);
        assert.strictEqual(closes.length, 1, 'the close is reported by hand');
        assert.strictEqual(closes[0].reason, 'handshake');
        assert.strictEqual(conn.state, 'reconnecting', 'and it tries again');
        conn.disconnect();
    });

    t(`${kind}: a handshake still inside its deadline is left alone`, async () => {
        const conn = make();
        await open(conn);
        await settle();
        now += 2000;
        assert.strictEqual(conn.checkAlive(timers), 'connecting');
        assert.strictEqual(sockets[0].closed, null);
        conn.disconnect();
    });
}

// --- a socket that died while the tab was away --------------------------------

for (const [kind, make, open] of KINDS) {
    t(`${kind}: a socket that answers a probe is kept`, async () => {
        const conn = make();
        await open(conn);
        await settle();
        const ws = sockets[0];
        ws.open();

        now += 600000;              // ten minutes in the background
        assert.strictEqual(conn.checkAlive(timers), 'probing');
        assert.deepStrictEqual(JSON.parse(ws.sent[ws.sent.length - 1]), { type: 'ping' });

        now += 100;
        ws.deliver({ type: 'pong' });
        expire();

        assert.strictEqual(conn.ws, ws, 'still ours');
        assert.strictEqual(ws.closed, null, 'and still open');
        conn.disconnect();
    });

    t(`${kind}: a socket that ignores a probe is replaced`, async () => {
        const conn = make();
        const closes = [];
        conn.on('close', (e) => closes.push(e));
        await open(conn);
        await settle();
        const ws = sockets[0];
        ws.open();

        // Silence is not the test — a squelched audio socket is silent and
        // healthy. What settles it is that the ping went unanswered.
        now += 600000;
        conn.checkAlive(timers);
        now += 6000;
        expire();

        assert.ok(ws.closed, 'let go of');
        assert.strictEqual(conn.ws, null);
        assert.strictEqual(closes[0].reason, 'silent');
        assert.strictEqual(conn.state, 'reconnecting');
        conn.disconnect();
    });

    t(`${kind}: several wake events do not mean several probes`, async () => {
        // A tab regaining focus is a visibilitychange and a focus and sometimes
        // a pageshow, and three sockets pinging on each is the kind of burst the
        // server's connection rate limit exists to stop.
        const conn = make();
        await open(conn);
        await settle();
        const ws = sockets[0];
        ws.open();
        const before = ws.sent.length;

        now += 600000;
        conn.checkAlive(timers);
        conn.checkAlive(timers);
        conn.checkAlive(timers);
        assert.strictEqual(ws.sent.length - before, 1, 'one ping');
        conn.disconnect();
    });

    t(`${kind}: a connection with no socket has nothing to check`, async () => {
        const conn = make();
        assert.strictEqual(conn.checkAlive(timers), 'idle');
        assert.strictEqual(conn.state, 'idle', 'and no reconnect is invented for it');
    });
}

// --- the wake wiring ----------------------------------------------------------

t('every live connection is asked, and one that throws does not stop the rest', async () => {
    const asked = [];
    const off = [
        health.reviveOnWake({ checkAlive: () => { asked.push('a'); throw new Error('nope'); } }),
        health.reviveOnWake({ checkAlive: () => asked.push('b') }),
    ];
    const err = console.error;
    console.error = () => {};
    try { health.wakeCheck(); } finally { console.error = err; }
    off.forEach((fn) => fn());
    assert.deepStrictEqual(asked, ['a', 'b']);
    health.wakeCheck();
    assert.strictEqual(asked.length, 2, 'and a released connection is not asked again');
});

async function run() {
    for (const [name, fn] of queue) {
        sockets.length = 0;
        pending.length = 0;
        now += 3600000;
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
    // Explicitly: the connections left behind are holding handshake deadlines
    // and reconnect timers, which is what they are supposed to do.
    process.exit(process.exitCode || 0);
}

run();

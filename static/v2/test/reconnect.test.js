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

// Every POST to /connection, by the id it registered. The count is the point:
// a retry is not allowed to make one, and the recovery from a lapsed
// registration is allowed exactly one — under the id already in use, because a
// new id would be a new session and the server's clock for this one runs from
// the first time it saw the old one.
let posts = [];

// A registration is cached for the life of the id, with a floor under how often
// a re-registration may be attempted, so the clock has to be steerable: the
// alternative is a test that waits fifteen seconds to find out.
let now = 1700000000000;
Date.now = () => now;

global.fetch = async (url, opts) => {
    posts.push(JSON.parse(opts.body).user_session_id);
    return {
        status: reply.status,
        json: async () => ({
            allowed: reply.allowed,
            reason: reply.reason,
            client_ip: '10.0.0.9',
            session_timeout: 0,
            max_session_time: 0,
        }),
    };
};

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
        posts = [];
        // Far enough on that nothing is inside the re-registration floor left
        // over from the last test.
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
    sockets[0].deliver({ type: 'error', error: 'Your session has been terminated. Please refresh the page.', status: 410 });
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

// --- what a retry costs, and the one request it may make ---------------------
//
// /connection is not part of the backoff. It registers the id both websocket
// endpoints check for, and that registration lasts as long as the session does
// — so a socket coming back after a drop has nothing to ask it, and asking
// anyway spends a rate-limit budget (ten a minute, per IP, shared by all three
// sockets) at exactly the moment the connection is already in trouble.
//
// The exception is the case where the server has *forgotten* the id: five
// minutes after this session's last socket ended, or the instant it restarts.
// Then one POST under the same id is the whole recovery. The same id matters —
// a new one would be a new session, and the server's `max_session_time` runs
// from the first time it saw the id it is measuring.

const REGISTERED_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

for (const [kind, make, open] of KINDS) {
    t(`${kind}: a drop that comes back asks /connection nothing`, async () => {
        const conn = make();
        await open(conn);
        sockets[0].open();
        const before = posts.length;
        sockets[0].land(1006);                  // the network, not the server
        assert.strictEqual(conn.needsRegistration, false, 'nothing to re-register');
        conn.reconnectTimer = null;
        await open(conn);                       // what the backoff would do
        assert.strictEqual(posts.length, before, 'the retry made no request');
        assert.strictEqual(sockets.length, 2, 'and still opened a socket');
        conn.disconnect();
    });

    t(`${kind}: a handshake that never opened re-registers, once`, async () => {
        // This is what a refused upgrade looks like from a browser: 1006, no
        // status, no reason — the same event as a pulled cable. One of the two
        // is ours to mend, so the next attempt asks which it was.
        const conn = make();
        await open(conn);
        sockets[0].land(1006);                  // refused before it ever opened
        assert.strictEqual(conn.needsRegistration, true);

        const before = posts.length;
        now += 20000;                           // past the floor
        conn.reconnectTimer = null;
        await open(conn);
        assert.strictEqual(posts.length, before + 1, 'one POST');
        assert.strictEqual(posts[posts.length - 1], REGISTERED_ID, 'under the same id');
        assert.strictEqual(conn.needsRegistration, false, 'and it is spent');

        // Spent, so the attempt after it does not ask again — the socket that
        // failed a second time is what asks again, not the backoff itself.
        sockets[1].open();
        const after = posts.length;
        sockets[1].land(1006);
        conn.reconnectTimer = null;
        await open(conn);
        assert.strictEqual(posts.length, after, 'no second POST');
        conn.disconnect();
    });

    t(`${kind}: re-registering is not attempted twice in fifteen seconds`, async () => {
        // Three sockets discover the same lapse at the same moment. Between the
        // floor and the shared cache that is one request, not three — and the
        // one that is blocked still retries, it just retries without asking.
        const conn = make();
        await open(conn);
        sockets[0].land(1006);
        now += 20000;
        conn.reconnectTimer = null;
        await open(conn);                       // asks
        const before = posts.length;

        sockets[1].land(1006);                  // and fails again, at once
        assert.strictEqual(conn.needsRegistration, true);
        now += 1000;                            // inside the floor
        conn.reconnectTimer = null;
        await open(conn);
        assert.strictEqual(posts.length, before, 'held off');
        assert.strictEqual(sockets.length, 3, 'but it still tried the socket');
        conn.disconnect();
    });
}

t('audio: a forgotten registration is put back rather than ending the session', async () => {
    // The audio endpoint upgrades first and refuses afterwards, so this arrives
    // as a message. It used to be read as 'identity' — the same answer as a
    // kicked id — which stopped the receiver and left a notice telling the
    // operator to press Listen. A receiver that restarts under a listener now
    // comes back on its own.
    const conn = new AudioConnection();
    const seen = [];
    conn.on('error', (e) => seen.push(e));
    await conn.connect(TUNING);
    sockets[0].open();
    sockets[0].deliver({ type: 'error', error: 'Invalid session. Please refresh the page and try again.' });
    sockets[0].land(1006);
    assert.strictEqual(conn.state, 'reconnecting', 'it is going to try again');
    assert.strictEqual(conn.needsRegistration, true);
    assert.ok(seen.some((e) => e.failure === 'reregister'), 'and said which kind it was');

    const before = posts.length;
    now += 20000;
    conn.reconnectTimer = null;
    await conn.connect(TUNING);
    assert.strictEqual(posts.length, before + 1, 'one POST, under the same id');
    assert.strictEqual(posts[posts.length - 1], REGISTERED_ID);
    conn.disconnect();
});

t('audio: a re-registration the server refuses ends the session honestly', async () => {
    // The other half of it. Asking again is only worth doing while the answer
    // can change; a kicked id answers 410 whatever asks, and that has to reach
    // the operator rather than becoming a loop with a POST in it.
    const conn = new AudioConnection();
    const seen = [];
    conn.on('error', (e) => seen.push(e));
    await conn.connect(TUNING);
    sockets[0].open();
    sockets[0].deliver({ type: 'error', error: 'Invalid session. Please refresh the page and try again.' });
    sockets[0].land(1006);

    reply = { allowed: false, reason: 'Your session has been terminated. Please refresh the page.', status: 410 };
    now += 20000;
    conn.reconnectTimer = null;
    await conn.connect(TUNING);
    assert.strictEqual(conn.state, 'rejected');
    assert.strictEqual(conn.reconnectTimer, null, 'and stops');
    assert.ok(seen.some((e) => e.failure === 'identity'), 'with the kind that ends a session');
    conn.disconnect();
});

// --- letting go while the check is in flight ---------------------------------

for (const [kind, make, open] of KINDS) {
    t(`${kind}: pausing during the check does not open a socket anyway`, async () => {
        // connect() awaits /connection before it opens anything, and disconnect()
        // sets closedByUser on a connection that has already cleared it. Without
        // a second look after the await, the pause button pressed at that moment
        // leaves a spectrum that is paused on screen and streaming on the wire —
        // and the next resume opens a second socket beside the first.
        const conn = make();
        const p = open(conn);
        conn.disconnect();                      // the pause button, mid-check
        await p;
        await settle();
        assert.strictEqual(sockets.length, 0, 'nothing was opened');
        assert.strictEqual(conn.state, 'idle');
    });
}

t('spectrum: a late close from a replaced socket leaves the live one alone', async () => {
    // Closing is not instant, so a pause and a resume inside one round trip
    // lands the old socket's close after the new one is up. Unguarded, that
    // close takes the live socket's place away — `this.ws = null` — and books a
    // reconnect beside it: two sockets, one of them unreachable. The audio
    // socket has always guarded this; the spectrum did not.
    const conn = new SpectrumConnection();
    await conn.connect({ frequency: 7100000, binBandwidth: 100 });
    const first = sockets[0];
    first.open();

    conn.disconnect();                          // pause
    await conn.connect({ frequency: 7100000, binBandwidth: 100 });   // and resume
    const second = sockets[1];
    second.open();

    first.land(1006);                           // the old one, catching up
    assert.strictEqual(conn.ws, second, 'the live socket is still the live socket');
    assert.strictEqual(conn.reconnectTimer, null, 'and nothing was booked on top of it');
    assert.strictEqual(conn.needsRegistration, false, 'nor a registration spent on it');
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

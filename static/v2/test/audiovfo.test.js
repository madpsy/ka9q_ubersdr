// The audio socket as a secondary VFO, and the VFO count /connection reports.
//
// Two things a secondary must do differently from the main stream, and both are
// invisible when they go wrong: it must say which VFO it is (`vfo=` on the
// connect URL — without it the server takes it for a reconnect of the main
// stream and *replaces* that), and it must leave the server session id alone,
// which is the main stream's and is what /stats hoists your row by.

const assert = require('assert');

const sockets = [];
class FakeSocket {
    constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.sent = [];
        sockets.push(this);
    }

    send(d) { this.sent.push(JSON.parse(d)); }

    close() { this.readyState = 3; }

    open() { this.readyState = 1; if (this.onopen) this.onopen(); }

    deliver(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }

    land(code = 1006) { this.readyState = 3; if (this.onclose) this.onclose({ code, reason: '' }); }
}
FakeSocket.OPEN = 1;

global.WebSocket = FakeSocket;
global.location = { protocol: 'http:', host: 'rx.test', search: '' };
global.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
Object.defineProperty(global, 'crypto', {
    value: { randomUUID: () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', getRandomValues: (b) => b },
    configurable: true,
});
global.window = global;

let reply = {};
global.fetch = async () => ({
    status: 200,
    json: async () => ({ allowed: true, reason: '', client_ip: '10.0.0.9', ...reply }),
});

const {
    AudioConnection, connectionCheck, getServerSessionId, getVfoLimit, newSessionId, onVfoLimit,
    parseVfoLimit, setServerSessionId,
} = require('./.build/audiovfo.cjs');

const TUNING = { frequency: 7100000, mode: 'lsb', bandwidthLow: -2700, bandwidthHigh: -50 };

let pass = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

const query = (ws) => new URL(ws.url).searchParams;

t('the main stream asks exactly as it always did', async () => {
    const c = new AudioConnection();
    assert.strictEqual(c.vfo, 0);
    assert.strictEqual(c.primary, true);
    await c.connect(TUNING);
    const q = query(sockets[0]);
    assert.strictEqual(q.get('vfo'), null, 'no vfo parameter on the main stream');
    assert.strictEqual(q.get('min_snr'), null);
    c.disconnect();
});

t('a secondary says which VFO it is', async () => {
    const c = new AudioConnection({ vfo: 2, primary: false });
    await c.connect(TUNING);
    assert.strictEqual(query(sockets[0]).get('vfo'), '2');
    assert.strictEqual(query(sockets[0]).get('format'), 'opus');
    c.disconnect();
});

t('a secondary carries its squelch on the connect URL', async () => {
    const c = new AudioConnection({ vfo: 1, primary: false });
    c.setAudioGate({ minSnr: 12 });
    await c.connect(TUNING);
    assert.strictEqual(query(sockets[0]).get('min_snr'), '12');
    c.disconnect();
    // Disabled is no parameter rather than the sentinel.
    sockets.length = 0;
    const d = new AudioConnection({ vfo: 1, primary: false });
    d.setAudioGate({ minSnr: -999 });
    await d.connect(TUNING);
    assert.strictEqual(query(sockets[0]).get('min_snr'), null);
    d.disconnect();
});

t('a secondary never writes the server session id', async () => {
    setServerSessionId('main-session');
    const c = new AudioConnection({ vfo: 1, primary: false });
    await c.connect(TUNING);
    const ws = sockets[0];
    ws.open();
    ws.deliver({ type: 'status', sessionId: 'secondary-session', frequency: 7100000 });
    assert.strictEqual(getServerSessionId(), 'main-session', 'status');
    ws.land(1006);
    assert.strictEqual(getServerSessionId(), 'main-session', 'close');
    c.disconnect();
});

t('...and is not cleared by a secondary being revived', async () => {
    setServerSessionId('main-session');
    const c = new AudioConnection({ vfo: 1, primary: false });
    await c.connect(TUNING);
    c._revive('handshake');
    assert.strictEqual(getServerSessionId(), 'main-session');
    c.disconnect();
});

t('the main stream still does', async () => {
    setServerSessionId(null);
    const c = new AudioConnection();
    await c.connect(TUNING);
    sockets[0].open();
    sockets[0].deliver({ type: 'status', sessionId: 'main-session' });
    assert.strictEqual(getServerSessionId(), 'main-session');
    sockets[0].land(1006);
    assert.strictEqual(getServerSessionId(), null);
    c.disconnect();
});

t('the VFO count: absent is one, and a real answer is kept', async () => {
    assert.strictEqual(parseVfoLimit({}), 1);
    assert.strictEqual(parseVfoLimit({ vfos: 0 }), 1);
    assert.strictEqual(parseVfoLimit({ vfos: 'x' }), 1);
    assert.strictEqual(parseVfoLimit({ vfos: 3 }), 3);
    assert.strictEqual(getVfoLimit(), 1, 'nothing has answered yet');
    let heard = null;
    const off = onVfoLimit((n) => { heard = n; });
    newSessionId();
    reply = { vfos: 4 };
    const r = await connectionCheck();
    assert.strictEqual(r.vfos, 4);
    assert.strictEqual(getVfoLimit(), 4);
    assert.strictEqual(heard, 4);
    // An older server says nothing, which is one.
    newSessionId();
    reply = {};
    await connectionCheck();
    assert.strictEqual(getVfoLimit(), 1);
    off();
});

t('an unanswered check leaves the count alone', async () => {
    newSessionId();
    reply = { vfos: 2 };
    await connectionCheck();
    const real = global.fetch;
    global.fetch = async () => { throw new Error('offline'); };
    newSessionId();
    const r = await connectionCheck();
    global.fetch = real;
    assert.strictEqual(r.vfos, 1, 'the reply itself grants nothing');
    assert.strictEqual(getVfoLimit(), 2, 'but what the server said stands');
});

(async () => {
    for (const [name, fn] of queue) {
        sockets.length = 0;
        reply = {};
        try {
            await fn();
            await settle();
            console.log('ok    ' + name);
            pass++;
        } catch (e) {
            console.log('FAIL  ' + name + '\n      ' + (e && e.message));
            process.exitCode = 1;
        }
    }
    if (!process.exitCode) console.log(`\n${pass} passed`);
    // Connections register with the wake watcher and hold timers.
    process.exit(process.exitCode || 0);
})();

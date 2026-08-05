// The client library, against a real host over a real event target.
//
// The client is what `window.UberSDR` is and what an extension's content script
// will be, so these run both halves end to end: nothing is stubbed but the
// receiver itself. If this file passes, an extension built on the same client
// works.

const assert = require('assert');
const { createClient } = require('./.build/bridgeclient.cjs');
const { createHost } = require('./.build/bridgehost.cjs');
const {
    API_VERSION, ERR, EVENT_FROM_PAGE, EVENT_TO_PAGE, MSG, PROTOCOL, BridgeError, encodeMessage,
} = require('./.build/bridgeprotocol.cjs');

let pass = 0;
const results = [];
const t = (name, fn) => results.push([name, fn]);

// CustomEvent that an EventTarget will accept.
class CE extends Event {
    constructor(type, init) {
        super(type);
        this.detail = init && init.detail;
    }
}

function wired(over = {}) {
    const target = new EventTarget();
    const state = {
        tuning: { frequency: 7100000, mode: 'usb' },
        signal: { dbfs: -90 },
        audio: { volume: 0.7, muted: false },
        spectrum: {}, session: {}, page: {},
        modes: [{ id: 'usb' }], bands: [], functions: [],
    };
    const calls = [];
    let clock = 0;
    const host = createHost({
        send: (msg) => target.dispatchEvent(new CE(EVENT_FROM_PAGE, { detail: encodeMessage(msg) })),
        now: () => clock,
        enabled: over.enabled || (() => true),
        describe: () => ({ app: 'ubersdr', ui: 'v2', api: API_VERSION, receiver: { id: 'uuid-1' } }),
        snapshot: (topic) => state[topic],
        command: over.command || ((name, args) => { calls.push([name, args]); return { did: name }; }),
        run: (fn) => { calls.push(['run', fn]); return { fn }; },
    });
    target.addEventListener(EVENT_TO_PAGE, (e) => host.handle(e.detail));
    const client = createClient(target, { CustomEvent: CE, timeoutMs: 50, ...(over.client || {}) });
    return { target, host, client, state, calls, advance: (ms) => { clock += ms; } };
}

// --- handshake ---------------------------------------------------------------

t('hello resolves with the descriptor', async () => {
    const w = wired();
    const d = await w.client.hello();
    assert.strictEqual(d.app, 'ubersdr');
    assert.strictEqual(d.receiver.id, 'uuid-1');
    assert.deepStrictEqual(w.client.describe(), d);
});

t('hello rejects on a page that is not one of ours', async () => {
    // How a content script concludes "not an UberSDR tab" — there is nothing
    // to poll, and no timer left running afterwards.
    const client = createClient(new EventTarget(), { CustomEvent: CE, timeoutMs: 20 });
    await assert.rejects(() => client.hello(), (e) => e.code === 'timeout');
    client.close();
});

t('a spontaneous announce reaches a client that never said hello', async () => {
    const w = wired();
    const seen = [];
    w.client.on('announce', (d) => seen.push(d));
    w.host.announce();
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].receiver.id, 'uuid-1');
});

// --- state -------------------------------------------------------------------

t('subscribe returns the current state and keeps it merged from patches', async () => {
    const w = wired();
    const first = await w.client.subscribe(['tuning']);
    assert.deepStrictEqual(first.tuning, w.state.tuning);

    const seen = [];
    w.client.on('tuning', (s) => seen.push(s));
    w.advance(1000);
    w.host.publish('tuning', { frequency: 7100000, mode: 'lsb' });

    // The page sent only the changed field; the client holds the whole topic.
    assert.deepStrictEqual(seen[0], { frequency: 7100000, mode: 'lsb' });
    assert.deepStrictEqual(w.client.state('tuning'), { frequency: 7100000, mode: 'lsb' });
});

t('an announce clears what the client thought it knew', async () => {
    // A fresh announce means the page restarted; its old state is from a
    // previous life and merging onto it would invent a mixture of the two.
    const w = wired();
    await w.client.subscribe(['tuning']);
    assert.ok(w.client.state('tuning'));
    w.host.announce();
    assert.strictEqual(w.client.state('tuning'), null);
});

t('unsubscribing stops the patches', async () => {
    const w = wired();
    await w.client.subscribe(['tuning']);
    await w.client.unsubscribe(['tuning']);
    const seen = [];
    w.client.on('tuning', (s) => seen.push(s));
    w.advance(1000);
    w.host.publish('tuning', { frequency: 1 });
    assert.deepStrictEqual(seen, []);
});

// --- commands ----------------------------------------------------------------

t('a command resolves with what the page did', async () => {
    const w = wired();
    assert.deepStrictEqual(await w.client.command('tune', { frequency: 14074000 }), { did: 'tune' });
    assert.deepStrictEqual(w.calls[0], ['tune', { frequency: 14074000 }]);
});

t('a refused command rejects with its code, not a generic failure', async () => {
    const w = wired({ command: () => { throw new BridgeError(ERR.BAD_ARGS, 'frequency 40000000 is outside'); } });
    await assert.rejects(
        () => w.client.command('tune', { frequency: 40000000 }),
        (e) => e.code === ERR.BAD_ARGS && /40000000/.test(e.message),
    );
});

t('run reaches the function catalogue', async () => {
    const w = wired();
    await w.client.run('freq_step_up');
    assert.deepStrictEqual(w.calls[0], ['run', 'freq_step_up']);
});

t('get fetches one topic or all of them', async () => {
    const w = wired();
    assert.deepStrictEqual(await w.client.get('tuning'), w.state.tuning);
    const all = await w.client.get();
    assert.deepStrictEqual(all.tuning, w.state.tuning);
    assert.ok('signal' in all);
});

t('a request that is never answered rejects instead of hanging', async () => {
    const target = new EventTarget();          // nothing is listening
    const client = createClient(target, { CustomEvent: CE, timeoutMs: 20 });
    await assert.rejects(() => client.command('tune', {}), (e) => e.code === 'timeout');
    client.close();
});

// --- several clients ---------------------------------------------------------

t('two clients on one page do not read each other post', async () => {
    const w = wired();
    const other = createClient(w.target, { CustomEvent: CE, timeoutMs: 50 });
    const mine = [];
    const theirs = [];
    w.client.on('tuning', (s) => mine.push(s));
    other.on('tuning', (s) => theirs.push(s));

    await w.client.subscribe(['tuning']);
    w.advance(1000);
    w.host.publish('tuning', { frequency: 7100000, mode: 'lsb' });

    assert.strictEqual(mine.length, 1);
    assert.strictEqual(theirs.length, 0, 'a patch for one subscriber reached another client');

    // And a result addressed to one is not resolved by the other.
    const [a, b] = await Promise.all([
        w.client.command('tune', { frequency: 1 }),
        other.command('mode', { mode: 'am' }),
    ]);
    assert.deepStrictEqual(a, { did: 'tune' });
    assert.deepStrictEqual(b, { did: 'mode' });
    other.close();
});

// --- lifecycle ---------------------------------------------------------------

t('closing tells the client, which then knows the page has gone', async () => {
    const w = wired();
    await w.client.hello();
    let closed = 0;
    w.client.on('closing', () => { closed++; });
    w.host.closing();
    assert.strictEqual(closed, 1);
    assert.strictEqual(w.client.describe(), null);
});

t('a disabled bridge rejects with "disabled", which a client can explain', async () => {
    const w = wired({ enabled: () => false });
    await assert.rejects(() => w.client.command('tune', {}), (e) => e.code === ERR.DISABLED);
});

t('closing a client abandons what it was waiting for, and refuses more', async () => {
    // Against a live host the reply is synchronous, so this needs a page that
    // never answers — which is also the case that matters: the tab navigated
    // away mid-question.
    const client = createClient(new EventTarget(), { CustomEvent: CE, timeoutMs: 5000 });
    const pending = client.command('tune', {});
    client.close();
    await assert.rejects(() => pending, /closed/);
    await assert.rejects(() => client.command('tune', {}), /closed/);
});

t('the client ignores traffic that is not the protocol', async () => {
    const w = wired();
    const seen = [];
    w.client.on('announce', (d) => seen.push(d));
    w.target.dispatchEvent(new CE(EVENT_FROM_PAGE, { detail: 'nonsense' }));
    w.target.dispatchEvent(new CE(EVENT_FROM_PAGE, {
        detail: encodeMessage({ v: 99, from: 'page', type: MSG.ANNOUNCE }),
    }));
    w.target.dispatchEvent(new CE(EVENT_FROM_PAGE, {
        detail: encodeMessage({ v: PROTOCOL, from: 'client', type: MSG.ANNOUNCE }),
    }));
    assert.deepStrictEqual(seen, []);
});

(async () => {
    for (const [name, fn] of results) {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
    }
    console.log(`\n${pass} ok`);
})();

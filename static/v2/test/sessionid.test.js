// The page's session id, and how many times registering it costs a request.
//
// /connection does two jobs at once: it answers "is there room for me" and it
// *registers* the id it was asked about, binding it to this IP and User-Agent.
// Both websocket endpoints refuse an id that has not been through it. So every
// id the page invents has to be paid for with a POST, and the endpoint allows
// ten a minute per IP.
//
// That is why the count below is asserted rather than left to judgement. The
// Start overlay asks on load to find out whether the receiver is full; if
// pressing Start then mints a *different* id, the first registration is paid
// for and thrown away — two requests per page load, one of them for an id
// nothing ever uses, and a reloading operator hitting a rate limit twice as
// fast as they should.
//
// The exception is the one case where a new id is the only way forward: the
// server reclaims an idle session by blacklisting its UUID for an hour, and
// reusing a blacklisted id gives a receiver that cannot be started at all.

const assert = require('assert');

global.location = { protocol: 'http:', host: 'rx.test', search: '' };
global.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

let minted = 0;
Object.defineProperty(global, 'crypto', {
    value: {
        randomUUID: () => {
            minted += 1;
            const n = String(minted).padStart(12, '0');
            return `aaaaaaaa-aaaa-4aaa-8aaa-${n}`;
        },
        getRandomValues: (b) => b,
    },
    configurable: true,
});
global.window = global;

let posts = [];
let allowed = true;
global.fetch = async (url, opts) => {
    posts.push(JSON.parse(opts.body).user_session_id);
    return {
        status: allowed ? 200 : 410,
        json: async () => ({
            allowed,
            reason: allowed ? '' : 'Your session has been terminated. Please refresh the page.',
            client_ip: '10.0.0.9',
            session_timeout: 300,
            max_session_time: 0,
        }),
    };
};

const s = require('./.build/sessionid.cjs');

let pass = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);

async function run() {
    for (const [name, fn] of queue) {
        posts = [];
        allowed = true;
        s.newSessionId();                  // a fresh page load
        posts = [];
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

// What a page load does, in order: the Start overlay's capacity check on mount,
// then powerOn settling the identity and the sockets sharing that answer. Two
// calls, one registration — which is the whole point.
const pageLoad = async () => {
    await s.connectionCheck();             // StartOverlay, on mount
    s.startSessionId();                    // powerOn
    await s.connectionCheck();             // powerOn, then shared by the sockets
};

// --- the count ---------------------------------------------------------------

t('a page load registers one id, once', async () => {
    await pageLoad();
    assert.strictEqual(posts.length, 1, `one POST, got ${posts.length}`);
    assert.deepStrictEqual([...new Set(posts)], [s.getSessionId()],
        'and it is the id the session actually runs under');
});

t('the sockets add nothing — they share the registration', async () => {
    await pageLoad();
    await s.connectionCheck();             // audio
    await s.connectionCheck();             // spectrum
    await s.connectionCheck();             // spots
    assert.strictEqual(posts.length, 1, `still one POST, got ${posts.length}`);
});

t('stopping and starting again reuses the id', async () => {
    // The server reads a repeat as a reconnection and replaces the old session
    // rather than stacking a second one, so there is nothing to re-register.
    await pageLoad();
    const first = s.getSessionId();
    s.startSessionId();                    // powerOff, then powerOn
    await s.connectionCheck();
    assert.strictEqual(s.getSessionId(), first, 'same identity');
    assert.strictEqual(posts.length, 1, `no second registration, got ${posts.length}`);
});

// --- when a new id is the only way forward ------------------------------------

t('a spent id is replaced on the next start', async () => {
    await pageLoad();
    const first = s.getSessionId();

    // The server has reclaimed the session and blacklisted the UUID.
    s.markSessionSpent();
    assert.strictEqual(s.sessionSpent(), true);

    const next = s.startSessionId();
    assert.notStrictEqual(next, first, 'a blacklisted id cannot be reused');
    assert.strictEqual(s.sessionSpent(), false, 'and the new one is not spent');

    await s.connectionCheck();
    assert.strictEqual(posts.length, 2, 'the replacement is registered');
    assert.strictEqual(posts[1], next);
});

t('a spent id is replaced once, not on every start after it', async () => {
    await pageLoad();
    s.markSessionSpent();
    const next = s.startSessionId();
    await s.connectionCheck();
    s.startSessionId();                    // stop, start again
    await s.connectionCheck();
    assert.strictEqual(s.getSessionId(), next, 'still the replacement');
    assert.strictEqual(posts.length, 2, `no third registration, got ${posts.length}`);
});

t('minting a new id drops the cached registration', async () => {
    // Or the sockets would open under an id the server has never been told
    // about, which every endpoint refuses.
    await pageLoad();
    s.markSessionSpent();
    const next = s.startSessionId();
    const check = await s.connectionCheck();
    assert.strictEqual(check.sessionId, next, 'the check registered the new id');
});

// --- what the reply carries ---------------------------------------------------

t('the check reports which id it registered', async () => {
    // The sockets open after awaiting this, and the id can move during the
    // await — so they read it from the answer rather than from the global.
    const check = await s.connectionCheck();
    assert.strictEqual(check.sessionId, s.getSessionId());
});

t('a refusal is not cached, so the next attempt asks again', async () => {
    allowed = false;
    const a = await s.connectionCheck();
    assert.strictEqual(a.allowed, false);
    await s.connectionCheck();
    assert.strictEqual(posts.length, 2, 'asked again rather than replaying the no');
});

run();

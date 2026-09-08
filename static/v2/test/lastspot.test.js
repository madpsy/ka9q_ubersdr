// The callsign panel's last-heard line: the query behind it, and what it says.
//
// The line answers "have we heard this station, and when" from the DX cluster
// addon's spot archive, in one row under the QRZ details. Three things here
// that nothing else can reach.
//
// The QUERY is a contract with somebody else's server — ubersdr_dxcluster's
// /api/search — and it is deliberately not the one the search modal builds. It
// matches the callsign exactly rather than as a prefix, and getting that wrong
// does not fail: a prefix search for M0AB finds M0ABC's spots and the panel
// reports them under M0AB, which reads as an answer.
//
// The STATES are three and they must not collapse into two. A station heard
// three weeks ago, a station never heard, and an addon that did not answer are
// different facts, and the last of them has to look like silence rather than
// like "never heard".
//
// And the RENDER, for the reason hookStub.js exists: a component referenced
// before it is imported builds cleanly and blanks the panel.

const assert = require('assert');

const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};
globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
    body: {},
    addEventListener: () => {},
    removeEventListener: () => {},
};
globalThis.navigator = { userAgent: 'node' };
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.location = { protocol: 'https:', host: 'rx.example' };
globalThis.window = globalThis;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.AbortController = globalThis.AbortController || class {
    constructor() { this.signal = { aborted: false }; }

    abort() { this.signal.aborted = true; }
};

// Every URL asked for, so a test can assert on the query rather than on what
// came back from it.
const asked = [];
const SPOT = {
    stream: 'cwskimmer', timestamp: '2026-09-07T13:51:46Z', band: '15m',
    callsign: 'ZA1RR', freq_hz: 21016700, snr: 24, country: 'Albania',
    country_code: 'AL', mode: 'CW', spotter: 'MM9PSY', wpm: 27, comment: 'CQ',
};

let answer = { spots: [SPOT] };
globalThis.fetch = (url) => {
    asked.push(String(url));
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({ ok: true, json: () => Promise.resolve(answer) });
};

const {
    deep, render, reset, walk, words,
    LastSpot, LAST_SPOT_DAYS, dxClusterAvailable, fetchLastSpot, lastSpotUrl, spotAge,
} = require('./.build/lastspot.cjs');

let pass = 0;
const pending = [];
function mount(Component, props, ctx) {
    const out = render(Component, props, ctx);
    pending.push(...out.cleanups);
    return out;
}
function drain() {
    while (pending.length) {
        const off = pending.pop();
        try { off(); } catch (e) { /* a cleanup that throws is its own failure */ }
    }
}

const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
    finally { drain(); }
};

// The fetch is real time, so the render tests are async.
const at = [];
const ta = (name, fn) => at.push([name, fn]);

const query = (call) => new URLSearchParams(lastSpotUrl(call).split('?')[1]);

// ── The query ───────────────────────────────────────────────────────────────

t('the callsign matches exactly, never as a prefix', () => {
    // The difference from the search modal, and the reason this builds its own
    // query. `callsign=M0AB` is LIKE 'M0AB%' server-side: it finds M0ABC and
    // the panel would print M0ABC's spot under the heading M0AB.
    const q = query('M0AB');
    assert.strictEqual(q.get('callsign_exact'), 'M0AB');
    assert.strictEqual(q.get('callsign'), null);
});

t('the window is the whole retention, not the modal’s day', () => {
    // "Not heard" is only worth saying over everything the archive keeps, and a
    // station heard three weeks ago is the answer that makes the line worth
    // having.
    assert.strictEqual(query('M0AB').get('days'), String(LAST_SPOT_DAYS));
    assert.strictEqual(query('M0AB').get('hours'), null);
});

t('one row, newest first, and no count', () => {
    const q = query('M0AB');
    assert.strictEqual(q.get('limit'), '1');
    assert.strictEqual(q.get('sort'), 'ts');
    assert.strictEqual(q.get('order'), 'desc');
    // The row is the answer. The total is what the count costs, and the addon
    // documents count=none as the cheapest form.
    assert.strictEqual(q.get('count'), 'none');
});

t('the anonymous voice callsign is excluded here too', () => {
    // N0CALL is this receiver noticing that somebody was talking, not a
    // station. A lookup of it would otherwise answer with itself.
    assert.strictEqual(query('M0AB').get('callsign_exclude'), 'N0CALL');
});

t('the callsign is trimmed and upper-cased', () => {
    assert.strictEqual(query(' za1rr ').get('callsign_exact'), 'ZA1RR');
});

t('the URL is the addon proxy path, not the addon host', () => {
    assert.ok(lastSpotUrl('ZA1RR').startsWith('/addon/dxcluster/api/search?'), lastSpotUrl('ZA1RR'));
});

t('the addon has to be listed before any of this is asked for', () => {
    assert.ok(dxClusterAvailable({ addons: ['sstv', 'DXCluster'] }));
    assert.ok(!dxClusterAvailable({ addons: ['sstv'] }));
    assert.ok(!dxClusterAvailable({}));
    assert.ok(!dxClusterAvailable(null));
});

// ── The age ─────────────────────────────────────────────────────────────────

t('the age carries days, which the spots panels do not', () => {
    const now = Date.parse('2026-09-08T12:00:00Z');
    assert.strictEqual(spotAge('2026-09-08T11:59:31Z', now), 'just now');
    assert.strictEqual(spotAge('2026-09-08T11:20:00Z', now), '40m ago');
    assert.strictEqual(spotAge('2026-09-08T04:00:00Z', now), '8h ago');
    // lib/spots.js stops at hours because nothing in those lists is older. This
    // window is a month, and "504h ago" is not an answer anybody reads.
    assert.strictEqual(spotAge('2026-08-18T12:00:00Z', now), '21d ago');
    assert.strictEqual(spotAge('nonsense', now), '');
});

// ── The fetch ───────────────────────────────────────────────────────────────

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

ta('an empty callsign asks nothing', async () => {
    asked.length = 0;
    assert.strictEqual(await fetchLastSpot(''), null);
    assert.deepStrictEqual(asked, []);
});

ta('nothing found is null, which is an answer', async () => {
    // Not a throw: "we have never heard this station" is a fact worth printing,
    // and only a failure is worth staying quiet about.
    answer = { spots: [] };
    assert.strictEqual(await fetchLastSpot('ZA1RR'), null);
    answer = { spots: [SPOT] };
});

ta('the addon’s own error is a rejection', async () => {
    const was = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve({
        ok: false, status: 503, json: () => Promise.resolve({ error: 'search is busy' }),
    });
    await assert.rejects(() => fetchLastSpot('ZA1RR'), /search is busy/);
    globalThis.fetch = was;
});

// ── The render ──────────────────────────────────────────────────────────────

ta('without the addon there is no row and no request', async () => {
    reset();
    asked.length = 0;
    const { tree } = mount(LastSpot, { call: 'ZA1RR', enabled: false });
    await settle();
    assert.strictEqual(tree, null);
    assert.deepStrictEqual(asked, [], asked.join('\n'));
    drain();
});

ta('a spot reads as an age, a frequency and a mode', async () => {
    reset();
    asked.length = 0;
    answer = { spots: [SPOT] };
    mount(LastSpot, { call: 'ZA1RR', enabled: true });
    await settle();

    assert.strictEqual(asked.length, 1, asked.join('\n'));
    assert.ok(/callsign_exact=ZA1RR/.test(asked[0]), asked[0]);

    // A second call with the hook state kept: the promise that resolved above
    // wrote into the same slots, so this render is the one showing the answer.
    // hookStub is not a renderer and does not do this for us.
    const { tree } = mount(LastSpot, { call: 'ZA1RR', enabled: true });
    const text = words(tree);
    assert.ok(/Last spot/.test(text), text);
    assert.ok(/ago|just now/.test(text), text);
    assert.ok(/21016\.7/.test(text), text);
    assert.ok(/CW/.test(text), text);

    // The rest of the row is on the tooltip rather than in the line — the panel
    // is about the operator and this is a footnote to it.
    const cell = deep(tree).find((n) => n.props && n.props.title);
    assert.ok(cell, 'the row carried no tooltip');
    assert.ok(/15m/.test(cell.props.title), cell.props.title);
    assert.ok(/de MM9PSY/.test(cell.props.title), cell.props.title);
    drain();
});

ta('never heard is said, not left blank', async () => {
    reset();
    answer = { spots: [] };
    mount(LastSpot, { call: 'ZZ9ZZZ', enabled: true });
    await settle();
    const { tree } = mount(LastSpot, { call: 'ZZ9ZZZ', enabled: true });
    const text = words(tree);
    assert.ok(new RegExp(`not heard in ${LAST_SPOT_DAYS} days`).test(text), text);
    answer = { spots: [SPOT] };
    drain();
});

ta('an addon that did not answer says nothing at all', async () => {
    // The state that must not collapse into "never heard". A search that failed
    // knows nothing about the station, and printing "not heard in 30 days" for
    // it would be inventing a fact about this receiver.
    reset();
    const was = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve({
        ok: false, status: 503, json: () => Promise.resolve({ error: 'search is busy' }),
    });
    mount(LastSpot, { call: 'ZA1RR', enabled: true });
    await settle();
    const { tree } = mount(LastSpot, { call: 'ZA1RR', enabled: true });
    assert.strictEqual(tree, null);
    assert.strictEqual(walk(tree).length, 0);
    globalThis.fetch = was;
    drain();
});

(async () => {
    for (const [name, fn] of at) {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
        finally { drain(); }
    }
    console.log(`\n${pass} passed`);
})();

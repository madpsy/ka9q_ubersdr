// The DX cluster spot search: the query it builds, the mode it tunes to, and
// the fact that it renders.
//
// Three things here that nothing else can reach.
//
// The QUERY is the contract with somebody else's server — ubersdr_dxcluster's
// /api/search — reached through the addon proxy. Every parameter name in it is
// spelled out in one place and checked nowhere else, and a misspelling does not
// fail: the addon ignores a filter it does not recognise and answers with the
// whole window, which looks exactly like a search that found a lot.
//
// The MODE is the one piece of radio judgement in the feature. A digital mode is
// upper sideband on every band, so the sideband split that is right for CW and
// SSB is wrong for FT8 — and 40 m FT8 tuned to LSB is silent in a way that reads
// as a broken receiver rather than as a wrong constant.
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

// A socket that connects and says nothing. Enough to put the session into the
// state where the panel draws its command row, which is the only row the
// magnifier is in.
globalThis.WebSocket = class FakeSocket {
    constructor(url) {
        this.url = url;
        this.readyState = 1;
        setTimeout(() => { if (this.onopen) this.onopen(); }, 0);
    }

    send() {}

    close() {
        this.readyState = 3;
        if (this.onclose) this.onclose({ wasClean: true, code: 1000 });
    }
};
globalThis.WebSocket.OPEN = 1;

// Every URL the component asked for, so a test can assert on the query rather
// than on what came back from it.
const asked = [];
const META = {
    bands: ['160m', '80m', '40m', '20m'],
    streams: ['decoder', 'cwskimmer', 'voice', 'dxcluster', 'localspot'],
    stream_labels: {
        decoder: 'Digital', cwskimmer: 'CW', voice: 'Voice',
        dxcluster: 'DX cluster', localspot: 'Local spots',
    },
    // Still in the document, and deliberately not used: see sourcesFrom for why
    // filtering on these would drop the two streams that have no mode column.
    mode_groups: [
        { label: 'Digital', modes: ['FT8', 'FT4', 'WSPR'], stream: 'decoder' },
        { label: 'CW', modes: ['CW'], stream: 'cwskimmer' },
        { label: 'Voice', modes: ['USB', 'LSB'], stream: 'voice' },
    ],
};
const SPOTS = [
    {
        stream: 'cwskimmer', timestamp: '2026-09-07T13:51:46Z', band: '15m',
        callsign: 'ZA1RR', freq_hz: 21016700, snr: 24, country: 'Albania',
        country_code: 'AL', mode: 'CW', spotter: 'MM9PSY', wpm: 27,
    },
    {
        stream: 'decoder', timestamp: '2026-09-07T13:48:00Z', band: '40m',
        callsign: 'G3WPD', freq_hz: 7038600, snr: -13, country: 'England',
        country_code: 'GB', mode: 'WSPR', locator: 'IO91', message: 'G3WPD IO91 20',
    },
];

let answer = { spots: SPOTS, total: 3957, total_capped: false, took_ms: 82, has_more: true, next_cursor: 'CUR1' };
globalThis.fetch = (url) => {
    asked.push(String(url));
    if (/\/meta$/.test(String(url))) return Promise.resolve({ ok: true, json: () => Promise.resolve(META) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve(answer) });
};

const {
    deep, render, reset, walk, words,
    DXClusterSearch, DXClusterPanel, _resetDxSession, dxConnect, dxDisconnect,
    ANON_CALLSIGN, DEFAULT_PERIOD, PERIODS, bandsFrom, khzLabel, modeLabel,
    receiverMode, resultSummary, searchQuery, searchUrl, snrLabel, sourcesFrom,
    spotKey, spotNote, tuneFreq, utcLabel,
} = require('./.build/dxsearch.cjs');

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

// The debounce is real time, and so is the fetch, so the render tests are async.
const at = [];
const ta = (name, fn) => at.push([name, fn]);

const query = (params) => new URLSearchParams(searchQuery(params));

// ── The query ───────────────────────────────────────────────────────────────

t('the default query is the last day, newest first', () => {
    const q = query({});
    assert.strictEqual(q.get('hours'), '24');
    assert.strictEqual(q.get('sort'), 'ts');
    assert.strictEqual(q.get('order'), 'desc');
    assert.strictEqual(q.get('days'), null);
});

t('a period chip picks the parameter as well as the number', () => {
    // 7 and 30 days go out as `days`, not as 168 and 720 `hours` — both work,
    // but the addon caps and describes them differently and the URL is one a
    // user can be shown.
    assert.strictEqual(query({ period: '7d' }).get('days'), '7');
    assert.strictEqual(query({ period: '30d' }).get('days'), '30');
    assert.strictEqual(query({ period: '7d' }).get('hours'), null);
    // An unknown key falls back to the first period rather than dropping the
    // window entirely, which would ask for the whole retention.
    assert.strictEqual(query({ period: 'nonsense' }).get('hours'), '24');
});

t('a callsign searches as a prefix, upper-cased', () => {
    const q = query({ callsign: ' g3abc ' });
    assert.strictEqual(q.get('callsign'), 'G3ABC');
    // Not callsign_exact: the prefix finds G3ABC and G3ABC/P together, which is
    // what somebody typing a callsign meant.
    assert.strictEqual(q.get('callsign_exact'), null);
});

t('an empty callsign sends no callsign filter at all', () => {
    assert.strictEqual(query({ callsign: '   ' }).get('callsign'), null);
});

t('bands and sources go out as one comma-separated value each', () => {
    const q = query({ bands: ['20m', '40m'], streams: ['decoder', 'cwskimmer'] });
    assert.strictEqual(q.get('band'), '20m,40m');
    assert.strictEqual(q.get('stream'), 'decoder,cwskimmer');
});

t('the source filter is a stream, never a mode', () => {
    // The bug this replaced. `mode` cannot express the upstream cluster or the
    // local spots — neither has a mode column, they keep it in the comment — so
    // a mode filter silently dropped forty-four thousand rows and returned an
    // answer that looked like an answer.
    const q = query({ streams: ['dxcluster', 'localspot'] });
    assert.strictEqual(q.get('stream'), 'dxcluster,localspot');
    assert.strictEqual(q.get('mode'), null);
});

t('the anonymous voice callsign is excluded from every query', () => {
    // 70,000 of the 250,000 rows in a week are the voice detector noticing that
    // somebody was talking. They are not a station and they swamp a bare
    // band+mode search, so this is not a control — it is always on.
    for (const params of [{}, { callsign: 'G3ABC' }, { bands: ['20m'] }]) {
        assert.strictEqual(query(params).get('callsign_exclude'), ANON_CALLSIGN);
    }
});

t('a cursor pages without an offset', () => {
    const q = query({ cursor: 'MTc4ODc4' });
    assert.strictEqual(q.get('cursor'), 'MTc4ODc4');
    // Keyset paging only: OFFSET makes the server walk and discard every skipped
    // row, and sending both would be asking for the page after the page after.
    assert.strictEqual(q.get('offset'), null);
});

t('the URL is the addon proxy path, not the addon host', () => {
    const url = searchUrl({ callsign: 'G3ABC' });
    assert.ok(url.startsWith('/addon/dxcluster/api/search?'), url);
});

// ── The mode ────────────────────────────────────────────────────────────────

t('CW takes the sideband split', () => {
    assert.strictEqual(receiverMode({ mode: 'CW', freq_hz: 7020000 }), 'cwl');
    assert.strictEqual(receiverMode({ mode: 'CW', freq_hz: 14020000 }), 'cwu');
});

t('a digital mode is upper sideband on every band', () => {
    // The whole reason DIGITAL_MODES exists. FT8 on 40 m is 7074 USB; the split
    // that is right for CW would put it on LSB and it would be silent.
    assert.strictEqual(receiverMode({ mode: 'FT8', freq_hz: 7074000 }), 'usb');
    assert.strictEqual(receiverMode({ mode: 'WSPR', freq_hz: 3568600 }), 'usb');
    assert.strictEqual(receiverMode({ mode: 'FT8', freq_hz: 28074000 }), 'usb');
});

t('a voice spot takes the sideband it was heard on', () => {
    assert.strictEqual(receiverMode({ voice_mode: 'LSB', freq_hz: 7150000 }), 'lsb');
    assert.strictEqual(receiverMode({ voice_mode: 'USB', freq_hz: 14250000 }), 'usb');
});

t('a cluster spot with no mode column reads its comment', () => {
    // The upstream stream has no mode at all — it is in the text, which is what
    // the transcript's own parser was written for.
    assert.strictEqual(
        receiverMode({ freq_hz: 28074000, comment: 'FT8 -13dB 1607Hz 1351Z' }), 'usb',
    );
    assert.strictEqual(
        receiverMode({ freq_hz: 7074000, comment: 'FT8 -13dB 1607Hz 1351Z' }), 'usb',
        'a digital comment must beat the sideband split, the same as a mode column does',
    );
    assert.strictEqual(receiverMode({ freq_hz: 7143000, comment: '[Voice] Radio Team' }), 'lsb');
    assert.strictEqual(receiverMode({ freq_hz: 14200000, comment: 'CQ DX' }), 'usb');
});

t('a voice spot tunes to the dial it was decided on', () => {
    assert.strictEqual(tuneFreq({ freq_hz: 5449100, est_dial_freq: 5449000 }), 5449000);
    assert.strictEqual(tuneFreq({ freq_hz: 7038600 }), 7038600);
    assert.strictEqual(tuneFreq({}), 0);
});

// ── The row ─────────────────────────────────────────────────────────────────

t('a frequency reads in kHz to one decimal', () => {
    assert.strictEqual(khzLabel(14095600), '14095.6');
    assert.strictEqual(khzLabel(7038600), '7038.6');
    assert.strictEqual(khzLabel(0), '');
});

t('the time reads as the cluster prints it', () => {
    assert.strictEqual(utcLabel('2026-09-07T13:48:00Z'), '1348Z');
    assert.strictEqual(utcLabel('2026-09-07T03:05:00Z'), '0305Z');
    assert.strictEqual(utcLabel('nonsense'), '');
});

t('a stream with no SNR shows none rather than zero', () => {
    // The upstream cluster stores 0 where it has no measurement, and "0 dB" is
    // a reading somebody would believe.
    assert.strictEqual(snrLabel({ stream: 'dxcluster', snr: 0 }), '');
    assert.strictEqual(snrLabel({ stream: 'cwskimmer', snr: 24 }), '+24 dB');
    assert.strictEqual(snrLabel({ stream: 'decoder', snr: -13 }), '-13 dB');
});

t('the note reads whichever columns the stream filled', () => {
    assert.strictEqual(spotNote({ comment: 'CQ', wpm: 27, spotter: 'MM9PSY' }), 'CQ · 27 wpm · de MM9PSY');
    assert.strictEqual(spotNote({ message: 'G3WPD IO91 20' }), 'G3WPD IO91 20');
    assert.strictEqual(spotNote({}), '');
});

t('the mode label is the server’s word, or the comment’s', () => {
    assert.strictEqual(modeLabel({ mode: 'WSPR' }), 'WSPR');
    assert.strictEqual(modeLabel({ voice_mode: 'LSB' }), 'LSB');
    assert.strictEqual(modeLabel({ comment: 'FT8 -13dB' }), 'FT8');
    assert.strictEqual(modeLabel({ comment: 'WWFF FFF-1351' }), '');
});

t('a row key separates two spots of the same station', () => {
    const a = spotKey(SPOTS[0], 0);
    const b = spotKey({ ...SPOTS[0], timestamp: '2026-09-07T13:52:00Z' }, 1);
    assert.notStrictEqual(a, b);
});

t('a capped total reads as a floor, not as a count', () => {
    assert.strictEqual(
        resultSummary({ shown: 50, total: 100000, capped: true, took: 82 }),
        '50 of over 100,000 · 82 ms',
    );
    assert.strictEqual(resultSummary({ shown: 0 }), 'No spots match these filters.');
});

// ── Meta ────────────────────────────────────────────────────────────────────

t('the chips come from the server, in the order it gave them', () => {
    assert.deepStrictEqual(bandsFrom(META), ['160m', '80m', '40m', '20m']);
    // A receiver that has not answered yet, or answered with rubbish, leaves the
    // callsign box and the period chips working rather than throwing.
    assert.deepStrictEqual(bandsFrom(null), []);
    assert.deepStrictEqual(sourcesFrom({}), []);
});

t('every stream the receiver runs gets a chip', () => {
    // All five, not the three that `mode_groups` names. DX cluster and Local
    // spots are the two that were missing while this filtered on mode.
    assert.deepStrictEqual(sourcesFrom(META), [
        { key: 'decoder', label: 'Digital' },
        { key: 'cwskimmer', label: 'CW' },
        { key: 'voice', label: 'Voice' },
        { key: 'dxcluster', label: 'DX cluster' },
        { key: 'localspot', label: 'Local spots' },
    ]);
});

t('a stream with no label of its own still gets a chip', () => {
    // A receiver running something this client has never heard of must not lose
    // the chip for it — the label is a nicety, the key is the filter.
    assert.deepStrictEqual(
        sourcesFrom({ streams: ['newthing'], stream_labels: {} }),
        [{ key: 'newthing', label: 'newthing' }],
    );
});

// ── The render ──────────────────────────────────────────────────────────────

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

ta('the modal renders, and asks for the last day', async () => {
    reset();
    asked.length = 0;
    const first = mount(DXClusterSearch, { onClose() {}, onTune() {} });
    assert.ok(walk(first.tree).length > 1, 'the modal rendered nothing');
    assert.ok(/Searching/.test(words(first.tree)), words(first.tree));

    await settle();
    assert.ok(asked.some((u) => /\/api\/search\/meta$/.test(u)), asked.join('\n'));
    const search = asked.find((u) => /\/api\/search\?/.test(u));
    assert.ok(search, asked.join('\n'));
    assert.ok(/hours=24/.test(search), search);
    drain();
});

ta('the rows arrive, and carry the spot', async () => {
    reset();
    const shown = [];
    mount(DXClusterSearch, { onClose() {}, onTune: (s) => shown.push(s) });
    await settle();

    // A second call with the hook state kept: the promise that resolved above
    // wrote into the same slots, so this render is the one showing the results.
    // hookStub is not a renderer and does not do this for us.
    const { tree } = mount(DXClusterSearch, { onClose() {}, onTune: (s) => shown.push(s) });
    const text = words(tree);
    assert.ok(/ZA1RR/.test(text), text);
    assert.ok(/21016\.7/.test(text), text);
    assert.ok(/G3WPD/.test(text), text);
    assert.ok(/3,957/.test(text), text);

    // The row is a button that tunes, and it closes the modal on the way.
    const row = deep(tree).find((n) => (
        n.props && typeof n.props.onClick === 'function'
        && /dxs-row/.test(String(n.props.className || ''))
    ));
    assert.ok(row, 'no tuneable row was rendered');
    row.props.onClick();
    assert.strictEqual(shown.length, 1);
    assert.strictEqual(shown[0].callsign, 'ZA1RR');
    drain();
});

ta('an error from the addon is repeated rather than swallowed', async () => {
    // 503 "search is busy" and 504 "narrow the time window" both say what to do
    // next, which a generic message would throw away.
    const was = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve({
        ok: false, status: 503, json: () => Promise.resolve({ error: 'search is busy — retry in a moment' }),
    });
    reset();
    mount(DXClusterSearch, { onClose() {}, onTune() {} });
    await settle();
    const { tree } = mount(DXClusterSearch, { onClose() {}, onTune() {} });
    assert.ok(/search is busy/.test(words(tree)), words(tree));
    globalThis.fetch = was;
    drain();
});

/**
 * The context the panel renders against.
 *
 * hookStub has one context for every useContext, and the panel reads two: the
 * radio, for tuning, and the layout, for deciding whether the dock it is in is
 * too narrow to be a terminal at all. A bottom placement is the one where it
 * draws itself rather than the two signpost buttons.
 */
function panelCtx(onTune) {
    return {
        actions: { tuneTo: onTune || (() => {}), ensureVisible() {} },
        placementOf: () => 'bottom',
        movePanel() {},
        setFloat() {},
        floats: {},
    };
}

/** The magnifier, matched on the label a screen reader would read. */
function magnifier(tree) {
    return deep(tree).find((n) => (
        n.props && /Search the spot archive/.test(String(n.props['aria-label'] || ''))
    ));
}

ta('the magnifier waits for the command row it sits beside', async () => {
    // Disconnected there is no command row, so there is nowhere beside Send for
    // it to be. That is the placement, not an oversight — recorded here so that
    // moving it later is a decision rather than an accident.
    _resetDxSession();
    reset();
    const { tree } = mount(DXClusterPanel, {}, panelCtx());
    assert.ok(!magnifier(tree), 'the magnifier is drawn before there is a command row');
    assert.ok(/Connect/.test(words(tree)), words(tree));
    drain();
});

ta('connected, the magnifier opens the search and its rows tune', async () => {
    _resetDxSession();
    dxConnect({ callsign: 'M0TST', password: '' });
    await settle(30);

    reset();
    const tuned = [];
    const ctx = panelCtx((o) => tuned.push(o));
    const { tree } = mount(DXClusterPanel, {}, ctx);
    const glass = magnifier(tree);
    assert.ok(glass, 'no magnifier beside Send once connected');

    // Opening it is a state change on the panel, so the modal appears on the
    // panel's next render — the same two-call shape as the rows test above.
    glass.props.onClick();
    const again = mount(DXClusterPanel, {}, ctx).tree;
    const modal = walk(again).find((n) => (
        typeof n.type === 'function' && n.props
        && typeof n.props.onTune === 'function' && typeof n.props.onClose === 'function'
    ));
    assert.ok(modal, 'the magnifier did not open the search');

    // The panel's own handler is what turns a result row into a tuned receiver,
    // and it is the half the modal cannot test: the modal only hands the row
    // back. A WSPR spot on 40 m has to arrive as USB, not as the LSB the
    // sideband split would give it.
    modal.props.onTune(SPOTS[1]);
    assert.deepStrictEqual(tuned, [{ frequency: 7038600, mode: 'usb' }]);

    dxDisconnect();
    _resetDxSession();
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

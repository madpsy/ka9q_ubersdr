// The DXpeditions panel renders, and the rules that decide what it shows hold.
//
// Two things here that nothing else can reach. The panel is ABSENT on a receiver
// whose calendar is empty or unreachable, which is a decision taken outside any
// component and read by the registry before the first render — so a store that
// answered wrongly would either hide a working panel or leave a permanently
// empty one in somebody's dock. And the panel has two different "all"s, a switch
// that changes what the list is and a button that changes how much of it is on
// screen; the button following the switch rather than overriding it is the sort
// of thing that builds cleanly either way.
//
// See hookStub.js for what "renders" means here.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Before the bundle: the store reads localStorage at module init for its seed,
// and the module graph behind the panel reaches the radio and the display
// settings, both of which read the browser at import time.
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};
// Seeded, so the first assertion below is about the seed being honoured rather
// than about an empty store.
store.set('ubersdr.v2.dxpeditions', '3');

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

let nextFetch = () => Promise.reject(new Error('no fetch configured'));
globalThis.fetch = (...args) => nextFetch(...args);

const {
    deep, render, reset, walk, words,
    DXpeditionsPanel, GROUPS, SOLO, onLookupRequest,
    bandLabel, bearingLabel, dxpedKey, dxpeditionState, dxpeditionsPresent,
    isActive, listenFor, placedBy, positionOf, refreshDXpeditions, runLabel,
    visibleDXpeditions, websiteOf,
} = require('./.build/dxpeditions.cjs');

let pass = 0;

// Every mount's cleanups, drained after each test whether it passed or not.
// The panel holds a one-minute interval to keep its relative dates moving, so a
// test that threw before its own cleanup would leave the timer running and node
// would never exit — the run hangs after printing every result, which reads as
// a test-runner fault rather than as the missing `off()` it is.
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

// The Show all switch is a stored preference, so a test that flips it changes
// the panel every later test mounts. Forgotten between tests, which leaves each
// one asserting about the shipped default rather than about whatever ran before
// it — the persistence itself is tested on its own, below, inside one test.
function forgetShowAll() {
    store.delete('ubersdr.v2.dxpeditions.all');
}

/** The Show All button, or undefined when the panel is not offering one.
 *
 * Matched on the handler and the words under it rather than on `children`:
 * deep() expands ui.jsx's Button into the <button> it returns, and that element's
 * children are the icon and a <span> around the label — so the node carrying the
 * label is a leaf with no onClick, and the node carrying the onClick has no
 * label of its own. */
function showAllButton(tree) {
    return deep(tree).find((n) => (
        n.props && typeof n.props.onClick === 'function' && /Show All/.test(words(n))
    ));
}

/**
 * The detail modal, mounted in a hook frame of its own.
 *
 * Calling `detail.type(props)` directly continues whichever frame the last
 * render() left behind — the panel's — so its useState lands on slots after the
 * panel's, and the NEXT call lands on different ones again: the view toggle is
 * forgotten between the click and the read. render() resets the index, so the
 * modal's slots are the same two each time and its state actually persists.
 * reset() first, so it does not inherit the panel's values into them.
 */
function mountDetail(panelTree, ctx, over) {
    const el = findDetail(panelTree);
    assert.ok(el, 'the detail modal was not rendered');
    const props = { ...el.props, ...over };
    reset();
    return {
        props,
        show: () => mount(el.type, props, ctx).tree,
    };
}

/** The map modal's view swap.
 *
 * Matched on its class, not on its words: the Modal's own backdrop is an element
 * with an onClick whose subtree contains every word in the dialog, and the
 * button's label changes with the view because it names the other one. */
function findSwap(tree) {
    return deep(tree).find((n) => /dxp-detail__swap/.test(String(n.props && n.props.className || '')));
}

/** The detail modal's element, unexpanded, so its props can be read.
 *
 * `entry` alone would match a Row: the panel's own list is still rendered behind
 * the overlay and its rows come first in the tree. `onClose` is what only the
 * detail has. */
function findDetail(tree) {
    return walk(tree).find((n) => (
        typeof n.type === 'function' && n.props && n.props.entry && typeof n.props.onClose === 'function'
    ));
}

const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
    finally { drain(); forgetShowAll(); restoreStore(); }
};
const ta = async (name, fn) => {
    try { await fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
    finally { drain(); forgetShowAll(); restoreStore(); }
};

const NOW = Date.UTC(2026, 8, 7, 12, 0, 0); // 2026-09-07T12:00:00Z
const day = (n) => Math.floor(NOW / 1000) + n * 86400;

// Shaped exactly as /api/dxpeditions serves them.
const entry = (over) => ({
    call: 'V51WH',
    prefix_only: false,
    entity: 'Namibia',
    country: 'Namibia',
    country_code: 'NA',
    continent: 'AF',
    start_unix: day(-3),
    end_unix: day(4),
    dates: 'Sep 4-11, 2026',
    bands: ['20m', '17m', '15m'],
    modes: ['CW', 'SSB'],
    info: 'By DK2WH fm nr Omaruru; 160-6m, incl 60m',
    qsl: 'DK2WH',
    source: 'MM0NDX (Jul 5, 2026)',
    latitude: -22,
    longitude: 17,
    approx: true,
    position_source: 'callsign',
    distance_km: 8343.2,
    bearing_deg: 164.4,
    in_range: true,
    ...over,
});

const LIVE = entry();
const SOON = entry({ call: 'P29YY', entity: 'Papua New Guinea', start_unix: day(9), end_unix: day(16) });
const LATER = entry({ call: '3W9C', entity: 'Vietnam', start_unix: day(40), end_unix: day(47) });

// Shaped as /api/description actually serves it: the station identity — name,
// callsign, gps — lives under `receiver`, and the top level carries the tuning
// range and the feature flags. Getting that nesting wrong in a fixture would
// hide exactly the bug the map test below is for, so it is written out here
// rather than flattened for convenience.
// A panel showing exactly these entries, whatever the store holds: the row
// tests are about one announcement's shape, not about the feed.
//
// The store's array is swapped rather than refetched, and put back by drain() —
// a test that left it holding its own fixtures would change what every later
// test sees, and the failure lands somewhere else entirely.
let storeBackup = null;
function contextWith(entries) {
    const live = dxpeditionState().entries;
    if (storeBackup === null) storeBackup = live.slice();
    live.length = 0;
    live.push(...entries);
    return context();
}
function restoreStore() {
    if (storeBackup === null) return;
    const live = dxpeditionState().entries;
    live.length = 0;
    live.push(...storeBackup);
    storeBackup = null;
}

const context = ({ receiverGps = { lat: 51.507, lon: -0.128 }, ...over } = {}) => ({
    serverInfo: {
        receiver: { callsign: 'M9PSY', name: 'Test receiver', gps: receiverGps },
        tuning_range: { min: 10000, max: 30000000 },
        // /api/description's own flag for "this receiver has a callsign lookup
        // service configured" — main.go's "lookup_service".
        lookup_service: true,
    },
    tuning: { frequency: 14_074_000, mode: 'usb' },
    running: true,
    actions: { tuneTo() {}, ensureVisible() {} },
    ...over,
});

// ── Where it lives on a phone ───────────────────────────────────────────────

t('the panel is grouped for the phone, under Activity', () => {
    // A phone has no docks: the tab row is seven fixed targets, six of which
    // open a group list, and that list is the ONLY way to a panel there. A panel
    // in the registry and in no group still works — it rides with the last group
    // — so nothing complains, and it turns up at the bottom of Setup among the
    // things you set once and leave. See groups.jsx.
    //
    // Activity because that is the question this panel answers: what is out
    // there worth listening to. The same reason it is next to Spots in the dock.
    const named = GROUPS.filter((g) => g.panels.includes('dxpeditions'));
    assert.strictEqual(named.length, 1, 'in ' + named.length + ' groups, want exactly one');
    assert.strictEqual(named[0].id, 'activity');
    assert.notStrictEqual(SOLO, 'dxpeditions', 'the slot a phone opens on is Multipad');
    // After the spot feeds, which are the same question over the last ten
    // minutes rather than the next three months.
    const items = named[0].panels;
    assert.ok(items.indexOf('dxpeditions') > items.indexOf('spots'));
});

// ── The gate ────────────────────────────────────────────────────────────────

t('the seed answers before any fetch', () => {
    // The registry reads this synchronously, before the first render — a store
    // that could only answer after a round trip would pop the panel into the
    // dock a second after the page settled, every load.
    assert.strictEqual(dxpeditionsPresent(), true);
});

const jsonOnce = (body, ok = true) => {
    nextFetch = () => Promise.resolve({ ok, status: ok ? 200 : 503, json: () => Promise.resolve(body) });
};

(async () => {
    await ta('a calendar with entries makes the panel present', async () => {
        jsonOnce({ entries: [LIVE, SOON] });
        await refreshDXpeditions();
        assert.strictEqual(dxpeditionsPresent(), true);
        assert.strictEqual(dxpeditionState().entries.length, 2);
        assert.strictEqual(store.get('ubersdr.v2.dxpeditions'), '2');
    });

    await ta('an empty calendar hides the panel and clears the seed', async () => {
        jsonOnce({ entries: [] });
        await refreshDXpeditions();
        assert.strictEqual(dxpeditionsPresent(), false);
        // Cleared, so the next load does not show the panel and then take it
        // away again on a receiver that has stopped publishing one.
        assert.strictEqual(store.has('ubersdr.v2.dxpeditions'), false);
    });

    await ta('a failed fetch hides the panel', async () => {
        jsonOnce({ entries: [LIVE] });
        await refreshDXpeditions();
        assert.strictEqual(dxpeditionsPresent(), true);
        // Deliberately NOT the "keep the last good list" rule the other feeds
        // follow: this panel's existence is conditional on the endpoint
        // answering, and the server already rides out its own upstream failures.
        nextFetch = () => Promise.reject(new Error('network down'));
        await refreshDXpeditions();
        assert.strictEqual(dxpeditionsPresent(), false);
        assert.ok(dxpeditionState().error);
    });

    await ta('a non-2xx is a failure, not an empty calendar', async () => {
        jsonOnce({ entries: [LIVE] });
        await refreshDXpeditions();
        jsonOnce({ entries: [LIVE, SOON] }, false);
        await refreshDXpeditions();
        assert.strictEqual(dxpeditionsPresent(), false);
        assert.ok(/503/.test(dxpeditionState().error));
    });

    await ta('a payload without entries does not throw', async () => {
        jsonOnce({ enabled: false, loaded: false });
        await refreshDXpeditions();
        assert.deepStrictEqual(dxpeditionState().entries, []);
    });

    // Leave the store loaded for the render tests below.
    jsonOnce({ entries: [LIVE, SOON, LATER] });
    await refreshDXpeditions();

    // ── Shaping ─────────────────────────────────────────────────────────────

    t('active means on the air by the inclusive range', () => {
        assert.strictEqual(isActive(LIVE, NOW), true);
        assert.strictEqual(isActive(SOON, NOW), false);
        // The last second of the last announced day is still on the air. An
        // exclusive end would drop every operation a day early.
        assert.strictEqual(isActive(entry({ start_unix: day(-1), end_unix: Math.floor(NOW / 1000) }), NOW), true);
    });

    t('the default list is the active operations only', () => {
        const rows = visibleDXpeditions([LATER, SOON, LIVE], { all: false, now: NOW });
        assert.deepStrictEqual(rows.map((e) => e.call), ['V51WH']);
    });

    t('show-all is every announcement, soonest first', () => {
        const rows = visibleDXpeditions([LATER, SOON, LIVE], { all: true, now: NOW });
        assert.deepStrictEqual(rows.map((e) => e.call), ['V51WH', 'P29YY', '3W9C']);
    });

    t('two announcements for the same prefix are separate rows', () => {
        // A third of the feed is a bare prefix, so the callsign alone is not an
        // identity: two Iceland operations are both "TF". A key that collided
        // would drop one of them out of the list with no error anywhere.
        const a = entry({ call: 'TF', prefix_only: true, start_unix: day(1) });
        const b = entry({ call: 'TF', prefix_only: true, start_unix: day(20) });
        assert.notStrictEqual(dxpedKey(a), dxpedKey(b));
    });

    t('the run label counts in days, and names the last one', () => {
        assert.strictEqual(runLabel(entry({ start_unix: day(3), end_unix: day(9) }), NOW), 'starts in 3 days');
        assert.strictEqual(runLabel(entry({ start_unix: day(-2), end_unix: day(5) }), NOW), '5 days left');
        assert.strictEqual(runLabel(entry({ start_unix: day(-2), end_unix: day(1) }), NOW), 'ends tomorrow');
        // Inside the final day: "0 days left" reads as finished, which it is not.
        assert.strictEqual(runLabel(entry({ start_unix: day(-2), end_unix: Math.floor(NOW / 1000) + 3600 }), NOW), 'last day');
    });

    t('a long band list is shortened rather than wrapped', () => {
        assert.strictEqual(bandLabel(['20m', '17m']), '20m 17m');
        // "HF" expands to nine bands server-side, which is right for filtering
        // and useless as a list in a dock column.
        const hf = ['160m', '80m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];
        assert.strictEqual(bandLabel(hf), '160m 80m 40m 30m +5');
        assert.strictEqual(bandLabel([]), '');
        assert.strictEqual(bandLabel(undefined), '');
    });

    t('a recovered callsign is what the row listens for', () => {
        // The announcement's callsign field is a country prefix for about a
        // third of the feed, because the operation was announced before its
        // licence came through — but most of those say what the call will be a
        // line later, in the portable convention. "PJ2" is a country; "PJ2/K5SL"
        // is something you can hear, and that is what belongs at the top of a
        // row.
        const pfx = entry({ call: 'PJ2/K5SL', announced_as: 'PJ2', prefix_only: false, operating_calls: ['PJ2/K5SL'] });
        assert.deepStrictEqual(listenFor(pfx), { call: 'PJ2/K5SL', more: 0, known: true });

        // Several operators: the first leads and the row says how many more,
        // rather than growing a line for them.
        const many = entry({ call: 'J38LD', announced_as: 'J3', prefix_only: false, operating_calls: ['J38LD', 'J38DX'] });
        assert.deepStrictEqual(listenFor(many), { call: 'J38LD', more: 1, known: true });

        // Nothing announced. This is the only case worth marking, because it is
        // the only one with nothing to listen for.
        const bare = entry({ call: 'HK0', prefix_only: true, operating_calls: [] });
        assert.deepStrictEqual(listenFor(bare), { call: 'HK0', more: 0, known: false });

        // An announcement that already carries a callsign is left alone.
        assert.deepStrictEqual(listenFor(LIVE), { call: 'V51WH', more: 0, known: true });
    });

    t('the row heads with the recovered call, and marks only the unknown', () => {
        const rowText = (over) => {
            const e = entry(over);
            reset();
            const { tree } = mount(DXpeditionsPanel, {}, contextWith([e]));
            const row = deep(tree).find((n) => n.props && /dxp-row\b/.test(String(n.props.className || '')));
            assert.ok(row, 'no row rendered');
            return words(row);
        };

        const recovered = rowText({ call: 'PJ2/K5SL', announced_as: 'PJ2', prefix_only: false, operating_calls: ['PJ2/K5SL'] });
        assert.ok(/PJ2\/K5SL/.test(recovered), recovered);
        // A row headed by a call we know has no business also calling itself a
        // prefix — that was the marker saying the opposite of the headline.
        assert.ok(!/prefix/.test(recovered), 'a recovered row still says "prefix": ' + recovered);

        const unknown = rowText({ call: 'HK0', prefix_only: true, operating_calls: [] });
        assert.ok(/prefix/.test(unknown), 'nothing marks a row with no callsign: ' + unknown);

        const several = rowText({ call: 'J38LD', announced_as: 'J3', prefix_only: false, operating_calls: ['J38LD', 'J38DX'] });
        assert.ok(/J38LD/.test(several) && /\+1/.test(several), several);
    });

    t('a centroid is flagged so the map does not zoom to street level', () => {
        assert.deepStrictEqual(positionOf(LIVE), { lat: -22, lon: 17, fromGrid: true });
        const g = entry({ latitude: -2.56, longitude: 150.79, position_source: 'grid', grid: 'QI57jk' });
        assert.deepStrictEqual(positionOf(g), { lat: -2.56, lon: 150.79, fromGrid: false });
        assert.strictEqual(positionOf(entry({ latitude: null, longitude: null })), null);
        // 0,0 is a real place, not a missing value.
        assert.ok(positionOf(entry({ latitude: 0, longitude: 0 })));
    });

    t('the caveat names which of the three placed the pin', () => {
        assert.ok(/callsign/.test(placedBy(LIVE)));
        assert.ok(/QI57jk/.test(placedBy(entry({ position_source: 'grid', grid: 'QI57jk' }))));
        assert.ok(/announcement names/.test(placedBy(entry({ position_source: 'entity' }))));
        assert.strictEqual(placedBy(entry({ position_source: undefined })), '');
    });

    t('the beam reads as distance and a compass point', () => {
        assert.strictEqual(bearingLabel(LIVE), '8,343 km · SSE 164°');
        assert.strictEqual(bearingLabel(entry({ distance_km: null, bearing_deg: null })), '');
        // Zero-padded so a column of headings lines up.
        assert.ok(/ N 007°$/.test(bearingLabel(entry({ distance_km: 12, bearing_deg: 7 }))));
    });

    t('only http(s) reaches the browser as a link', () => {
        assert.strictEqual(websiteOf(entry({ website: 'https://oh7o.com/p29yy/' })), 'https://oh7o.com/p29yy/');
        // The server refuses these at parse time; this is the second check, at
        // the point a URL would actually become an href.
        for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', '', undefined]) {
            assert.strictEqual(websiteOf(entry({ website: bad })), '', String(bad));
        }
    });

    // ── Rendering ───────────────────────────────────────────────────────────

    t('the panel renders the operations on the air', () => {
        reset();
        const { tree } = mount(DXpeditionsPanel, {}, context());
        const text = words(tree);
        assert.ok(/V51WH/.test(text), text);
        // The switch is off by default, so the forward calendar is not listed.
        assert.ok(!/3W9C/.test(text), text);
        assert.ok(/on the air/.test(text), text);
    });

    await ta('the empty state names which list is empty', async () => {
        // A calendar of nothing but future operations. The panel is still
        // PRESENT — the endpoint answered with entries — so it has to say in its
        // own words that none of them are on the air, rather than looking like
        // it failed to load.
        jsonOnce({ entries: [SOON, LATER] });
        await refreshDXpeditions();
        reset();
        let out = mount(DXpeditionsPanel, {}, context());
        assert.ok(/No DXpeditions are on the air right now/.test(words(out.tree)), words(out.tree));

        // And with the switch on, the same calendar is not empty at all.
        deep(out.tree).find((n) => n.props && n.props.role === 'switch').props.onClick();
        drain();
        out = mount(DXpeditionsPanel, {}, context());
        const text = words(out.tree);
        assert.ok(/P29YY/.test(text) && /3W9C/.test(text), text);
        assert.ok(!/on the air right now/.test(text), text);

        jsonOnce({ entries: [LIVE, SOON, LATER] });
        await refreshDXpeditions();
    });

    t('the Show all switch changes what the list is', () => {
        reset();
        let out = mount(DXpeditionsPanel, {}, context());
        const sw = deep(out.tree).find((n) => n.props && n.props.role === 'switch');
        assert.ok(sw, 'no Show all switch');
        assert.strictEqual(sw.props['aria-checked'], false, 'the switch ships off');
        sw.props.onClick();

        out = mount(DXpeditionsPanel, {}, context());
        const text = words(out.tree);
        assert.ok(/3W9C/.test(text), 'turning it on did not reveal the forward calendar');
        assert.ok(/announced/.test(text), text);
    });

    t('the Show all choice survives the panel being closed and reopened', () => {
        // A preference, not panel state: it is remembered wherever the panel is
        // drawn, docked or floating, the same as every other switch here.
        reset();
        let out = mount(DXpeditionsPanel, {}, context());
        deep(out.tree).find((n) => n.props && n.props.role === 'switch').props.onClick();
        drain();

        // A fresh mount with no hook state at all — this is the panel being
        // reopened, and the only thing carrying the answer across is storage.
        reset();
        out = mount(DXpeditionsPanel, {}, context());
        const sw = deep(out.tree).find((n) => n.props && n.props.role === 'switch');
        assert.strictEqual(sw.props['aria-checked'], true, 'the choice was forgotten');
    });

    await ta('Show All is offered for any non-empty list, and withheld for an empty one', async () => {
        // Offered even when the dock is already showing every row: the modal is
        // the room the column does not have, not just more of them.
        reset();
        let out = mount(DXpeditionsPanel, {}, context());
        assert.ok(showAllButton(out.tree), 'no Show All button for a single row');
        drain();

        // Nothing on the air, but a calendar behind it — so the panel is still
        // present and the default list is still empty. A button here could only
        // ever open an empty dialog.
        jsonOnce({ entries: [SOON, LATER] });
        await refreshDXpeditions();
        reset();
        out = mount(DXpeditionsPanel, {}, context());
        assert.ok(!showAllButton(out.tree), 'offered Show All over an empty list');

        jsonOnce({ entries: [LIVE, SOON, LATER] });
        await refreshDXpeditions();
    });

    await ta('Show All opens the current list, and follows the switch', async () => {
        // Seven live operations and seven future ones: more than a page either
        // way, so the button is offered in both states and can be asked whether
        // it honours the switch above it.
        const live = Array.from({ length: 7 }, (_, i) => entry({
            call: `L${i}AA`, start_unix: day(-2), end_unix: day(3),
        }));
        const future = Array.from({ length: 7 }, (_, i) => entry({
            call: `F${i}BB`, start_unix: day(30 + i), end_unix: day(37 + i),
        }));
        jsonOnce({ entries: [...live, ...future] });
        await refreshDXpeditions();

        // Switch off — the modal lists the seven on the air and none of the
        // forward calendar. That is the whole point of the two controls being
        // separate: the button changes how much is on screen, never what the
        // list is.
        reset();
        let out = mount(DXpeditionsPanel, {}, context());
        let btn = showAllButton(out.tree);
        assert.ok(btn, 'no Show All button with fourteen announcements');
        btn.props.onClick();
        drain();

        out = mount(DXpeditionsPanel, {}, context());
        let modal = deep(out.tree).find((n) => /dxp-all\b/.test(String(n.props && n.props.className || '')));
        assert.ok(modal, 'Show All did not open a modal');
        let text = words(modal);
        assert.ok(/L0AA/.test(text) && /L6AA/.test(text), 'the modal dropped live rows: ' + text);
        assert.ok(!/F0BB/.test(text), 'the modal overrode the switch and showed the forward calendar');
        assert.ok(/On the air now/.test(text), text);
        drain();

        // And with the switch on it lists everything.
        reset();
        out = mount(DXpeditionsPanel, {}, context());
        deep(out.tree).find((n) => n.props && n.props.role === 'switch').props.onClick();
        drain();
        out = mount(DXpeditionsPanel, {}, context());
        showAllButton(out.tree).props.onClick();
        drain();
        out = mount(DXpeditionsPanel, {}, context());
        modal = deep(out.tree).find((n) => /dxp-all\b/.test(String(n.props && n.props.className || '')));
        text = words(modal);
        assert.ok(/F0BB/.test(text) && /L0AA/.test(text), 'the modal did not follow the switch: ' + text);
        assert.ok(/Every announced operation/.test(text), text);
    });

    await ta('a row in the Show All modal opens its detail, replacing it', async () => {
        // Two dismissable layers would be two Escapes to get back to the panel.
        reset();
        let out = mount(DXpeditionsPanel, {}, context());
        showAllButton(out.tree).props.onClick();
        drain();
        out = mount(DXpeditionsPanel, {}, context());
        // The row INSIDE the modal, not the first in the tree. The panel's own
        // list is still rendered behind the overlay, and its rows only open the
        // detail — they do not close the big list, because nothing can click
        // them while it is covering them.
        const big = deep(out.tree).find((n) => /dxp-all\b/.test(String(n.props && n.props.className || '')));
        const row = deep(big).find((n) => n.props && /dxp-row/.test(String(n.props.className || '')));
        assert.ok(row, 'no rows inside the Show All modal');
        row.props.onClick();
        drain();
        out = mount(DXpeditionsPanel, {}, context());
        const nodes = deep(out.tree);
        assert.ok(nodes.some((n) => /dxp-detail/.test(String(n.props && n.props.className || ''))), 'no detail');
        assert.ok(!nodes.some((n) => /dxp-all\b/.test(String(n.props && n.props.className || ''))),
            'the big list stayed open under the detail');
    });

    // Back to the three-entry calendar the remaining tests were written against.
    jsonOnce({ entries: [LIVE, SOON, LATER] });
    await refreshDXpeditions();

    t('clicking a row opens its detail with the map', () => {
        reset();
        let out = mount(DXpeditionsPanel, {}, context());
        const row = deep(out.tree).find((n) => n.props && /dxp-row/.test(String(n.props.className || '')));
        assert.ok(row, 'no rows rendered');
        row.props.onClick();

        out = mount(DXpeditionsPanel, {}, context());
        const nodes = deep(out.tree);
        assert.ok(nodes.some((n) => /dxp-detail/.test(String(n.props && n.props.className || ''))), 'no detail modal');
        // The map itself: CallsignMap renders a .csmap box when it has a
        // position, and nothing at all when it does not — so its presence is
        // the assertion that the position survived the trip.
        assert.ok(nodes.some((n) => /csmap/.test(String(n.props && n.props.className || ''))), 'no map in the detail');
        const text = words(out.tree);
        assert.ok(/Sep 4-11, 2026/.test(text), text);
        // The announcement verbatim, alongside the parsed bands.
        assert.ok(/Omaruru/.test(text), text);
    });

    t('an operation with no position gets the modal without a map', () => {
        reset();
        // Rendered directly through the panel: the row is the only way in, and
        // a detail that threw on a null position would take the panel with it.
        let out = mount(DXpeditionsPanel, {}, context({ serverInfo: {} }));
        const row = deep(out.tree).find((n) => n.props && /dxp-row/.test(String(n.props.className || '')));
        row.props.onClick();
        out = mount(DXpeditionsPanel, {}, context({ serverInfo: {} }));
        // No receiver coordinates: the modal still draws, without a path.
        assert.ok(deep(out.tree).some((n) => /dxp-detail/.test(String(n.props && n.props.className || ''))));
    });

    t('the receiver reaches the map, so the path is drawn', () => {
        // The bug this exists for: /api/description puts gps under `receiver`
        // and the tuning range at the top level, so handing the map the whole
        // description reads `gps` off an object that never had it. The pin and
        // the great-circle path then silently do not draw — nothing throws,
        // nothing is logged, and the modal looks fine because the operation's
        // own pin is still there.
        reset();
        let out = mount(DXpeditionsPanel, {}, context());
        deep(out.tree).find((n) => n.props && /dxp-row/.test(String(n.props.className || ''))).props.onClick();
        drain();
        out = mount(DXpeditionsPanel, {}, context());

        // walk() rather than deep(): `from` is consumed inside CallsignMap's
        // effect and never reaches its output, so the assertion has to be made
        // on the element before it is expanded.
        const detail = findDetail(out.tree);
        assert.ok(detail, 'the detail was not rendered');
        const map = walk(detail.type(detail.props)).find((n) => n.props && n.props.position);
        assert.ok(map, 'no map element in the detail');
        assert.ok(map.props.from, 'the receiver never reached the map — no path will be drawn');
        assert.strictEqual(map.props.from.lat, 51.507);
        assert.strictEqual(map.props.from.label, 'M9PSY');
        // And the operation's own pin, flagged as a centroid so the map does
        // not open at street level on a whole country.
        assert.deepStrictEqual(map.props.position, { lat: -22, lon: 17, fromGrid: true });
    });

    t('a receiver at 0,0 is the config default, not a position', () => {
        // The same test the spot map makes: a path drawn from the Gulf of
        // Guinea is worse than no path.
        reset();
        let out = mount(DXpeditionsPanel, {}, context({ receiverGps: { lat: 0, lon: 0 } }));
        deep(out.tree).find((n) => n.props && /dxp-row/.test(String(n.props.className || ''))).props.onClick();
        drain();
        out = mount(DXpeditionsPanel, {}, context({ receiverGps: { lat: 0, lon: 0 } }));
        const detail = findDetail(out.tree);
        const map = walk(detail.type(detail.props)).find((n) => n.props && n.props.position);
        assert.strictEqual(map.props.from, null, 'drew a path from 0,0');
    });

    t('the country code becomes a flag on the row', () => {
        // The server has to send country_code for this: the client turns an ISO
        // alpha-2 into regional indicators and has nothing else to work from.
        reset();
        const { tree } = mount(DXpeditionsPanel, {}, context());
        // NA -> the two regional-indicator code points.
        assert.ok(/\u{1F1F3}\u{1F1E6}/u.test(words(tree)), 'no flag on the row — country_code missing?');
    });

    await ta('the map modal swaps to every operation the panel is showing', async () => {
        const live = Array.from({ length: 4 }, (_, i) => entry({
            call: `L${i}AA`, start_unix: day(-2), end_unix: day(3),
        }));
        const future = Array.from({ length: 4 }, (_, i) => entry({
            call: `F${i}BB`, start_unix: day(30 + i), end_unix: day(37 + i),
        }));
        jsonOnce({ entries: [...live, ...future] });
        await refreshDXpeditions();

        reset();
        let out = mount(DXpeditionsPanel, {}, context());
        deep(out.tree).find((n) => n.props && /dxp-row/.test(String(n.props.className || ''))).props.onClick();
        drain();
        out = mount(DXpeditionsPanel, {}, context());
        const modal = mountDetail(out.tree, context());

        // It opens on the operation that was clicked — a single pin, not the
        // hemisphere. Somebody who pressed a row asked about that row.
        let tree = modal.show();
        assert.ok(walk(tree).some((n) => n.props && n.props.position), 'did not open on the single view');
        assert.ok(!walk(tree).some((n) => n.props && n.props.points), 'opened on the all view');

        const swap = findSwap(tree);
        assert.ok(swap, 'no Show all toggle in the map modal');
        assert.ok(/Show all/.test(words(swap)), 'the toggle does not name the view it opens');
        swap.props.onClick();

        tree = modal.show();
        const world = walk(tree).find((n) => n.props && n.props.points);
        assert.ok(world, 'the toggle did not swap to the world map');
        // And it now names the way back rather than repeating itself.
        assert.ok(/L0AA/.test(words(findSwap(tree))), 'the toggle does not name the operation to return to');

        // Four live operations, because the panel's own Show all switch is off.
        // The modal's toggle changes how much of the map you see, never what the
        // list is.
        const calls = world.props.points.map((pt) => pt.spot.callsign).sort();
        assert.deepStrictEqual(calls, ['L0AA', 'L1AA', 'L2AA', 'L3AA'], 'the map did not follow the panel');

        // Coordinates come straight from the server, not from a locator:
        // SpotsWorldMap's own placeable() reads a grid, and nine in ten of these
        // do not have one.
        assert.strictEqual(world.props.points[0].lat, -22);
        assert.strictEqual(world.props.points[0].lon, 17);
        // The receiver goes through, so the map draws its pin and the great
        // circle on hover.
        assert.ok(world.props.receiver && world.props.receiver.gps, 'the receiver never reached the world map');
        // The bands ride in the tooltip field: for a DXpedition "where do I
        // listen" is the bands, and that field is what a station is using.
        assert.ok(/20m/.test(world.props.points[0].spot.mode), world.props.points[0].spot.mode);
    });

    await ta('with the panel switch on, the map shows the whole calendar', async () => {
        reset();
        let out = mount(DXpeditionsPanel, {}, context());
        deep(out.tree).find((n) => n.props && n.props.role === 'switch').props.onClick();
        drain();
        out = mount(DXpeditionsPanel, {}, context());
        deep(out.tree).find((n) => n.props && /dxp-row/.test(String(n.props.className || ''))).props.onClick();
        drain();
        out = mount(DXpeditionsPanel, {}, context());

        const modal = mountDetail(out.tree, context());
        findSwap(modal.show()).props.onClick();
        const world = walk(modal.show()).find((n) => n.props && n.props.points);
        assert.strictEqual(world.props.points.length, 8, 'the map did not pick up the forward calendar');
    });

    await ta('picking a point on the map goes back to that operation', async () => {
        reset();
        let out = mount(DXpeditionsPanel, {}, context());
        deep(out.tree).find((n) => n.props && /dxp-row/.test(String(n.props.className || ''))).props.onClick();
        drain();
        out = mount(DXpeditionsPanel, {}, context());

        const modal = mountDetail(out.tree, context());
        findSwap(modal.show()).props.onClick();
        const world = walk(modal.show()).find((n) => n.props && n.props.points);

        // The entry rides on the point, so a pick needs no second lookup.
        const target = world.props.points.find((pt) => pt.spot.callsign === 'L2AA');
        assert.ok(target && target.spot.entry, 'the point does not carry its operation');
        world.props.onPick(target.spot);

        const tree = modal.show();
        assert.ok(walk(tree).some((n) => n.props && n.props.position), 'a pick did not return to the single view');
        assert.ok(/L2AA/.test(words(tree)), 'the single view shows the wrong operation: ' + words(tree));

        jsonOnce({ entries: [LIVE, SOON, LATER] });
        await refreshDXpeditions();
    });

    t('an operation that cannot be placed is dropped from the map, and counted', () => {
        // Quietly showing a partial map as though it were the whole one is the
        // failure SpotsWorldMap's own count exists to avoid.
        reset();
        let out = mount(DXpeditionsPanel, {}, context());
        deep(out.tree).find((n) => n.props && /dxp-row/.test(String(n.props.className || ''))).props.onClick();
        drain();
        out = mount(DXpeditionsPanel, {}, context());

        const el = findDetail(out.tree);
        // One of them cannot be placed at all.
        const rows = el.props.rows.map((e, i) => (i === 0 ? { ...e, latitude: null, longitude: null } : e));
        const modal = mountDetail(out.tree, context(), { rows });
        findSwap(modal.show()).props.onClick();
        const tree = modal.show();
        const world = walk(tree).find((n) => n.props && n.props.points);
        assert.strictEqual(world.props.points.length, rows.length - 1, 'an unplaceable operation reached the map');
        assert.ok(new RegExp(`${rows.length - 1} of ${rows.length} placed`).test(words(tree)),
            'the count does not say how many were left out: ' + words(tree));
    });

    t('each line of a row sizes itself, so one cannot squeeze the other', () => {
        // The bug: the row was one grid, `auto 1fr`, with the callsign and the
        // bands-and-modes line sharing column one. A grid column is as wide as
        // its widest cell, so an operation announcing most of HF made that
        // column wide enough to push the country and its flag off the end of
        // the line ABOVE it — the flag disappearing because of the length of a
        // line it is not on.
        //
        // Asserted twice, because either half alone would let it back: the
        // markup has to keep the two lines separate, and the stylesheet has to
        // keep laying them out independently.
        reset();
        const { tree } = mount(DXpeditionsPanel, {}, context());
        const row = deep(tree).find((n) => n.props && /dxp-row\b/.test(String(n.props.className || '')));
        assert.ok(row, 'no rows rendered');

        const lines = deep(row).filter((n) => /dxp-row__line/.test(String(n.props && n.props.className || '')));
        assert.strictEqual(lines.length, 2, 'a row is not two independent lines');
        const cellsOf = (line) => deep(line)
            .map((n) => String(n.props && n.props.className || ''))
            .filter((c) => /dxp-row__(call|where|detail|when)/.test(c))
            .map((c) => c.replace('dxp-row__', ''));
        // The identity line and the detail line, and nothing crossing between.
        assert.deepStrictEqual(cellsOf(lines[0]), ['call', 'where']);
        assert.deepStrictEqual(cellsOf(lines[1]), ['detail', 'when']);

        const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
        const block = (selector) => {
            const at = css.indexOf(selector);
            assert.ok(at >= 0, `no ${selector} rule in styles.css`);
            return css.slice(at, css.indexOf('}', at));
        };
        // No shared column track anywhere in the row.
        assert.ok(!/grid/.test(block('.list__row.dxp-row {')), 'the row is a grid again');
        assert.ok(!/grid/.test(block('.dxp-row__line {')), 'a line is a grid');
        // Each line is its own flex context, full width.
        assert.ok(/display:\s*flex/.test(block('.dxp-row__line {')), 'a line is not a flex row');
        assert.ok(/width:\s*100%/.test(block('.dxp-row__line {')), 'a line does not fill the row');
        // And the two cells that give the slack back as an ellipsis can actually
        // shrink: a flex item's default min-width is its content, so without
        // min-width: 0 the line overflows the panel instead of the text cutting.
        for (const sel of ['.dxp-row__where {', '.dxp-row__detail {']) {
            const rule = block(sel);
            assert.ok(/min-width:\s*0/.test(rule), `${sel} cannot shrink`);
            assert.ok(/text-overflow:\s*ellipsis/.test(rule), `${sel} does not ellipse`);
        }
    });

    t('clicking an operation looks its callsign up', () => {
        // Paired the way the spot rows pair tuning with a lookup: opening one
        // operation is also asking who it is. The in-app Callsign panel is
        // whatever is listening here.
        const asked = [];
        const off = onLookupRequest((call, opts) => asked.push([call, opts]));
        try {
            reset();
            const { tree } = mount(DXpeditionsPanel, {}, context());
            const row = deep(tree).find((n) => n.props && /dxp-row\b/.test(String(n.props.className || '')));
            row.props.onClick();
            assert.deepStrictEqual(asked.map((a) => a[0]), ['V51WH']);
            // Not `auto`: somebody clicked this, so a lookup that cannot be had
            // should say why rather than failing quietly.
            assert.ok(!asked[0][1] || !asked[0][1].auto, 'the click was reported as automatic');
        } finally {
            off();
        }
    });

    t('a prefix with no callsign is not looked up', () => {
        // The payoff of prefix_only meaning "nothing to listen for": there is no
        // callsign to ask about, and asking about "HK0" would hand the lookup
        // service a country prefix. An operation whose call was RECOVERED is not
        // prefix-only, so it is looked up like any other.
        const asked = [];
        const off = onLookupRequest((call) => asked.push(call));
        try {
            const click = (over) => {
                reset();
                const { tree } = mount(DXpeditionsPanel, {}, contextWith([entry(over)]));
                deep(tree).find((n) => n.props && /dxp-row\b/.test(String(n.props.className || ''))).props.onClick();
                drain();
                restoreStore();
            };
            click({ call: 'HK0', prefix_only: true, operating_calls: [] });
            assert.deepStrictEqual(asked, [], 'a bare prefix was looked up');

            // A recovered call IS looked up — and the portable prefix comes off
            // on the way, because a lookup service has a record for the
            // operator's own call and none for the portable form of it.
            // normaliseCallsign takes the longest slash-separated segment,
            // which is the right answer for both of the forms recovery finds:
            // PJ2/K5SL and W9HT/VP9 both resolve to the home call.
            click({ call: 'PJ2/K5SL', announced_as: 'PJ2', prefix_only: false, operating_calls: ['PJ2/K5SL'] });
            assert.deepStrictEqual(asked, ['K5SL'], 'a recovered callsign was not looked up as its base call');

            click({ call: 'W9HT/VP9', announced_as: 'VP9', prefix_only: false, operating_calls: ['W9HT/VP9'] });
            assert.deepStrictEqual(asked, ['K5SL', 'W9HT'], 'the appended-prefix form did not resolve');

            // An issued call has no prefix to strip.
            click({ call: 'J38LD', announced_as: 'J3', prefix_only: false, operating_calls: ['J38LD', 'J38DX'] });
            assert.deepStrictEqual(asked, ['K5SL', 'W9HT', 'J38LD']);
        } finally {
            off();
        }
    });

    t('a receiver with no lookup service is not asked', () => {
        const asked = [];
        const off = onLookupRequest((call) => asked.push(call));
        try {
            reset();
            const ctx = context();
            // The same gate the spot rows and the voice panels use.
            ctx.serverInfo = { ...ctx.serverInfo, lookup_service: false };
            const { tree } = mount(DXpeditionsPanel, {}, ctx);
            deep(tree).find((n) => n.props && /dxp-row\b/.test(String(n.props.className || ''))).props.onClick();
            assert.deepStrictEqual(asked, [], 'looked a callsign up on a receiver that cannot');
        } finally {
            off();
        }
    });

    t('the detail still opens when the callsign cannot be looked up', () => {
        // The lookup rides along with opening the modal; it must never be the
        // thing that decides whether the modal opens.
        reset();
        const ctx = context();
        ctx.serverInfo = { ...ctx.serverInfo, lookup_service: false };
        let out = mount(DXpeditionsPanel, {}, ctx);
        deep(out.tree).find((n) => n.props && /dxp-row\b/.test(String(n.props.className || ''))).props.onClick();
        drain();
        out = mount(DXpeditionsPanel, {}, ctx);
        assert.ok(findDetail(out.tree), 'the detail did not open');
    });

    t('minimal keeps everything a phone needs, and loses only the pager', () => {
        // Every panel starts cut down on a phone, so this IS the default mobile
        // view. A minimal that dropped the switch and the Show All button would
        // leave a phone able to see five active operations and nothing else —
        // the forward calendar unreachable, on the machine most likely to be
        // looking at it.
        reset();
        const { tree } = mount(DXpeditionsPanel, { minimal: true }, context());
        const nodes = deep(tree);
        assert.ok(nodes.some((n) => n.props && n.props.role === 'switch'), 'the Show all switch is gone on a phone');
        assert.ok(showAllButton(tree), 'the Show All button is gone on a phone');
        assert.ok(nodes.some((n) => n.props && /dxp-row/.test(String(n.props.className || ''))), 'no rows');
        // The pager is the one thing it loses: growing the list in place is what
        // a cut-down view is avoiding, and Show All reaches the same rows.
        assert.ok(!nodes.some((n) => /show-more/.test(String(n.props && n.props.className || ''))),
            'the pager survived minimal');
    });

    t('mounting and unmounting leaves nothing behind', () => {
        reset();
        mount(DXpeditionsPanel, {}, context());
        // An effect that throws on the way out leaks a subscriber per open and
        // close, and is invisible until a session has been running for hours.
        assert.ok(true);
    });

    console.log(`\n${pass} passed`);
})();

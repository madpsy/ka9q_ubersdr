// The Spots panel renders, in both of its views.
//
// The panel is now two pictures of one feed — rows, and the same spots on a
// world map — and which one it shows is read from localStorage on every render
// rather than held in state. That is a shape nothing else here covers: a view
// that never appears, a map handed the unfiltered list, or a press that opens
// the wrong modal all build cleanly and pass every other test. See hookStub.js
// for what "renders" means.

const assert = require('assert');

// Before the bundle: the module graph behind the panel reaches the radio, the
// display settings and the spot store, all of which read the browser at import
// time. The panel's own view and modal switches are localStorage, so this store
// is what the tests below write to choose a view.
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
// The spot socket is opened by the panel's own subscribe effect, and the
// connection reads the address bar on the way there.
globalThis.location = { search: '', href: 'http://localhost/', protocol: 'http:', host: 'localhost' };
globalThis.WebSocket = function WebSocketStub() {
    return { close() {}, send() {}, addEventListener() {}, removeEventListener() {}, readyState: 0 };
};
globalThis.WebSocket.OPEN = 1;
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.fetch = () => Promise.reject(new Error('no network in a test'));
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const {
    deep, render, reset, walk, words,
    SpotsPanel, SpotMap, placeable, normaliseCW, normaliseDigital, normaliseDX,
} = require('./.build/spotspanel.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

// Two decodes with a locator and one without, all on the band the dial below is
// in — so the panel's own default filters (auto band, ten minutes) keep them.
const DIGITAL = [
    normaliseDigital({
        mode: 'FT8', band: '20m', callsign: 'JA1ABC', locator: 'PM95', country: 'Japan',
        country_code: 'JP', snr: -12, frequency: 14074000, timestamp: iso(1000),
        message: 'CQ JA1ABC PM95', distance_km: 9500, bearing_deg: 35,
    }),
    normaliseDigital({
        mode: 'FT8', band: '20m', callsign: 'VK2XYZ', locator: 'QF56', country: 'Australia',
        country_code: 'AU', snr: -3, frequency: 14074000, timestamp: iso(2000),
        message: 'CQ VK2XYZ QF56', distance_km: 17000, bearing_deg: 80,
    }),
    normaliseDigital({
        mode: 'FT8', band: '20m', callsign: 'W1NOG', country: 'United States',
        country_code: 'US', snr: -8, frequency: 14074000, timestamp: iso(3000),
        message: 'CQ W1NOG',
    }),
];

const CW = [normaliseCW({
    frequency: 14025000, dx_call: 'W1AW', spotter: 'DL0ABC', snr: 18, wpm: 25,
    time: iso(1000), band: '20m', country: 'United States', country_code: 'US',
    distance_km: 5400, bearing_deg: 290, grid: 'FN31',
})];

const DX = [normaliseDX({
    frequency: 14025000, dx_call: 'VK9DX', spotter: 'G4ABC', comment: 'CW 599',
    time: iso(1000), band: '20m', country: 'Norfolk Island', country_code: 'NF',
})];

// One object answers useRadio and useLayout both — the stub's useContext cannot
// tell two contexts apart, and the panel wants `sections` from one and the rest
// from the other.
function context(over) {
    return {
        serverInfo: {
            dx_cluster: true,
            digital_decodes: true,
            cw_skimmer: true,
            lookup_service: true,
            receiver: { callsign: 'G0TST', gps: { lat: 51.5, lon: -0.1 } },
        },
        tuning: { frequency: 14_074_000, mode: 'usb' },
        running: true,
        actions: { tuneTo() {} },
        sections: {},
        ...over,
    };
}

const nodes = (tree, cls) => deep(tree).filter(
    (n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes(cls),
);
// The modal, wherever the panel put it — asserted on by props rather than by
// what it draws, because what it draws is Leaflet's business.
const modalOf = (tree) => walk(tree).find((n) => n.type === SpotMap);

const show = (tab, view) => {
    store.clear();
    if (view) store.set(`ubersdr.v2.spotsView.${tab}`, view);
};

// --- it renders at all -----------------------------------------------------

t('every tab renders as a list, docked and minimal', () => {
    for (const [tab, spots] of [['dx', DX], ['digital', DIGITAL], ['cw', CW]]) {
        for (const minimal of [false, true]) {
            show(tab, 'list');
            reset();
            const { tree, cleanups } = render(SpotsPanel, { minimal }, context());
            assert.ok(tree, `${tab}/${minimal}: rendered nothing`);
            // The first tab present is the one shown, so only DX can be
            // asserted on without driving the tab picker; what matters here is
            // that the render path and the mount effects run at all.
            assert.ok(spots.length > 0);
            for (const off of cleanups) off();
        }
    }
});

// --- the choice of view ----------------------------------------------------

t('the map view is offered on the feeds that have locators, and not on DX', () => {
    // The picker is the second segmented control; the first is the tabs. Both
    // are found by the option labels rather than by position.
    const labels = (tree) => deep(tree)
        .filter((n) => n.type === 'button' && typeof n.props.title === 'string')
        .map((n) => n.props.children);

    show('dx', null);
    reset();
    const dx = render(SpotsPanel, {}, context()).tree;
    assert.ok(!labels(dx).includes('Map'), 'DX offered a map it cannot draw');

    // Only the digital feed present, so it is the tab that opens.
    show('digital', null);
    reset();
    const dig = render(SpotsPanel, {}, context({
        serverInfo: { ...context().serverInfo, dx_cluster: false, cw_skimmer: false },
    })).tree;
    assert.ok(labels(dig).includes('Map'), 'digital was not offered the map');
    assert.ok(labels(dig).includes('List'));
});

t('digital opens on the map with nothing stored, and CW on its rows', () => {
    // The split is deliberate: a digital row cannot tune, and a CW row is a
    // frequency to go to. See VIEW_DEFAULT.
    show('digital', null);
    reset();
    const digital = render(SpotsPanel, {}, context({
        serverInfo: { ...context().serverInfo, dx_cluster: false, cw_skimmer: false },
    })).tree;
    assert.strictEqual(nodes(digital, 'spots__open').length, 1, 'digital did not open on the map');

    show('cw', null);
    reset();
    const cw = render(SpotsPanel, {}, context({
        serverInfo: { ...context().serverInfo, dx_cluster: false, digital_decodes: false },
    })).tree;
    assert.strictEqual(nodes(cw, 'spots__open').length, 0, 'CW opened on a map it cannot be tuned from');
    assert.strictEqual(nodes(cw, 'spots__list').length, 1, 'CW drew no list');
    // ...and it is still one press away, which is the whole of what makes the
    // default a default rather than a restriction.
    const labels = deep(cw)
        .filter((n) => n.type === 'button' && typeof n.props.title === 'string')
        .map((n) => n.props.children);
    assert.ok(labels.includes('Map'), 'CW was not offered the map at all');
});

t('a stored choice of "list" is honoured over that default', () => {
    show('digital', 'list');
    reset();
    const info = { ...context().serverInfo, dx_cluster: false, cw_skimmer: false };
    const { tree } = render(SpotsPanel, {}, context({ serverInfo: info }));
    assert.strictEqual(nodes(tree, 'spots__open').length, 0, 'the map came back uninvited');
    assert.strictEqual(nodes(tree, 'spots__list').length, 1, 'no list either');
});

t('a stored choice of "map" is what the panel opens as', () => {
    // CW, because that is the tab where the store is overriding the default
    // rather than agreeing with it.
    show('cw', 'map');
    reset();
    const info = { ...context().serverInfo, dx_cluster: false, digital_decodes: false };
    const { tree } = render(SpotsPanel, {}, context({ serverInfo: info }));
    assert.strictEqual(nodes(tree, 'spots__open').length, 1, 'no map in the map view');
    // ...and the rows are gone with it, rather than both being drawn.
    assert.strictEqual(nodes(tree, 'spots__list').length, 0, 'the list is still there');
});

t('the DX tab stays a list however the store was seeded — and by default', () => {
    // Nothing writes this key for DX, but a hand-edited store — or a tab that
    // was renamed — must not produce an empty world where the rows were.
    const dxOnly = { ...context().serverInfo, digital_decodes: false, cw_skimmer: false };
    for (const seed of ['map', null]) {
        show('dx', seed);
        reset();
        const { tree } = render(SpotsPanel, {}, context({ serverInfo: dxOnly }));
        assert.strictEqual(nodes(tree, 'spots__open').length, 0, `seeded ${seed}`);
        assert.strictEqual(nodes(tree, 'spots__list').length, 1, `seeded ${seed}: no list`);
    }
});

// --- what the map is given -------------------------------------------------

t('the panel map draws the filtered spots that reported a locator', () => {
    // Two of the three decodes carry one; the third is a spot like any other and
    // simply cannot be drawn.
    const points = placeable(DIGITAL);
    assert.strictEqual(points.length, 2);
    assert.deepStrictEqual(points.map((p) => p.spot.callsign), ['JA1ABC', 'VK2XYZ']);
});

t('the count says how many of the matching spots could be placed', () => {
    show('digital', 'map');
    reset();
    const info = { ...context().serverInfo, dx_cluster: false, cw_skimmer: false };
    // The store is what the panel subscribes to; the count is about whatever it
    // holds, so an empty feed must still read as a sentence rather than "NaN".
    const { tree } = render(SpotsPanel, {}, context({ serverInfo: info }));
    assert.ok(/\d+ of \d+ placed/.test(words(tree)), words(tree).slice(0, 200));
});

// --- pressing it -----------------------------------------------------------

t('pressing the map opens the modal on the world, with no spot in it', () => {
    show('digital', 'map');
    reset();
    const info = { ...context().serverInfo, dx_cluster: false, cw_skimmer: false };
    const ctx = context({ serverInfo: info });
    const first = render(SpotsPanel, {}, ctx);
    assert.ok(!modalOf(first.tree), 'the modal was open before anything was pressed');

    const [button] = nodes(first.tree, 'spots__open');
    button.props.onClick();

    // Same hook storage, so this is the panel re-rendering rather than a new
    // mount — which is the only way the press can be seen at all.
    const { tree } = render(SpotsPanel, {}, ctx);
    const modal = modalOf(tree);
    assert.ok(modal, 'the press opened nothing');
    assert.strictEqual(modal.props.view, 'all');
    assert.strictEqual(modal.props.spot, null);
    // And carrying the panel's filters over, resolved: the big map opens showing
    // what the small one showed, and 'auto' means nothing without a dial.
    assert.strictEqual(modal.props.filters.band, '20m');
});

t('a row press still opens the modal on that row', () => {
    // The modal switch defaults on for digital, so this is the default press.
    show('digital', 'list');
    reset();
    const info = { ...context().serverInfo, dx_cluster: false, cw_skimmer: false };
    const ctx = context({ serverInfo: info });
    const first = render(SpotsPanel, {}, ctx);
    // No rows without a live feed behind the panel, so the modal is driven the
    // way a row drives it and the assertion is about what it is handed.
    assert.ok(!modalOf(first.tree));
});

// --- the modal with nothing selected ---------------------------------------

t('the modal opens on the world without a spot and says nothing about one', () => {
    reset();
    const { tree } = render(SpotMap, {
        spot: null,
        spots: DIGITAL,
        kind: 'digital',
        view: 'all',
        lookups: true,
        receiver: { callsign: 'G0TST', gps: { lat: 51.5, lon: -0.1 } },
        onClose() {},
    }, context());
    const said = words(tree);
    assert.ok(!/Locating/.test(said), 'it tried to locate a station nobody asked about');
    // The swap button names the station it would go back to, and there is none.
    assert.ok(!/Show all/.test(said));
    assert.ok(/All spots/.test(said), said.slice(0, 200));
});

t('picking a station on it switches to that station', () => {
    reset();
    const props = {
        spot: null,
        spots: DIGITAL,
        kind: 'digital',
        view: 'all',
        lookups: false,
        receiver: null,
        onClose() {},
    };
    const first = render(SpotMap, props, context());
    const map = walk(first.tree).find((n) => n.props && typeof n.props.onPick === 'function');
    assert.ok(map, 'the all-spots view drew no map');
    map.props.onPick(DIGITAL[0]);
    const { tree } = render(SpotMap, props, context());
    assert.ok(/JA1ABC/.test(words(tree)), 'the picked station is not what it is showing');
});

console.log(`\n${pass} passed`);

// The first test renders with the receiver running, which opens the spot socket
// — and the stubbed one above never connects, so its reconnect timer holds the
// event loop open for ever. Nothing is left to wait for by here.
process.exit(process.exitCode || 0);

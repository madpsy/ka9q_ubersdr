// The start overlay's map, and the other receivers on it.
//
// The other receivers are decoration from an endpoint that may be missing, slow
// or wrong, so the tests are mostly about what happens when it is: the
// receiver's pin, the greeting and the fit to "this receiver and you" must all
// arrive exactly as before, and the dots must never move the view.

const assert = require('assert');

// --- browser stubs, before the bundle ----------------------------------------

// loadScript/loadStyle append an element and wait for its onload; fire it at once.
const head = { appendChild(el) { Promise.resolve().then(() => el.onload && el.onload()); } };
// A tiny DOM, enough for buildPopup.
function el(tag) {
    return {
        tag, children: [], className: '', textContent: '', listeners: {},
        appendChild(c) { this.children.push(c); return c; },
        addEventListener(n, fn) { this.listeners[n] = fn; },
    };
}
globalThis.document = {
    head,
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: el,
};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.navigator = { userAgent: 'node' };
globalThis.window = globalThis;

// Leaflet, recording what the component asks of it.
let log;
function fakeLeaflet() {
    log = { markers: [], circles: [], fits: [], views: [], lines: [], removed: 0 };
    const layer = (kind, extra) => {
        const o = {
            kind, ...extra,
            addTo(m) { m.layers.push(o); return o; },
            bindTooltip(t) { o.tooltip = t; return o; },
            openTooltip() { return o; }, closeTooltip() { return o; },
            bindPopup(fn, opts) { o.popup = fn; o.popupOpts = opts; return o; },
            on() { return o; }, off() { return o; },
        };
        return o;
    };
    globalThis.L = {
        map(_el, opts) {
            log.mapOpts = opts;
            const m = {
                layers: [],
                setView(c, z) { log.views.push([c, z]); return m; },
                fitBounds(b) { log.fits.push(b); return m; },
                remove() { log.removed++; },
                removeLayer() {},
            };
            log.map = m;
            return m;
        },
        tileLayer: () => layer('tiles'),
        divIcon: (o) => o,
        marker: (ll, o) => { const x = layer('marker', { ll, o }); log.markers.push(x); return x; },
        circleMarker: (ll, o) => { const x = layer('circle', { ll, o }); log.circles.push(x); return x; },
        polyline: (ll) => { const x = layer('line', { ll }); log.lines.push(x); return x; },
        latLngBounds: (pts) => ({ pts }),
        canvas: (o) => ({ canvas: o }),
    };
}

const MYIP = { ip: '1.2.3.4', country: 'France', country_code: 'FR', city: 'Paris', latitude: 48.86, longitude: 2.35, distance_km: 340 };
const NEARBY = {
    receivers: [
        { id: 'a', callsign: 'G0AAA', name: 'Hilltop SDR', location: 'Kent, UK', lat: 51.2, lon: 0.9, country_code: 'gb', public_url: 'https://a.example/', max_clients: 10, available_clients: 3, distance_km: 61.4 },
        { id: 'b', callsign: '<img src=x onerror=alert(1)>', name: '', location: '', lat: 40, lon: -74, public_url: 'https://b.example/', max_clients: 0, available_clients: 0 },
        { id: 'bad', callsign: 'X', lat: 0, lon: 0, public_url: 'https://c.example/' },
        { id: 'js', callsign: 'Y', lat: 10, lon: 10, public_url: 'javascript:alert(1)' },
    ],
};

// fetch per URL: 'hang' never settles, 'fail' rejects, a number is a status.
function stubFetch(routes) {
    globalThis.fetch = (url, opts) => {
        const r = routes[url];
        if (r === 'hang') {
            return new Promise((_, reject) => {
                if (opts && opts.signal) opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
            });
        }
        if (r === 'fail' || r === undefined) return Promise.reject(new Error('offline'));
        if (typeof r === 'number') return Promise.resolve({ ok: false, status: r, json: async () => ({}) });
        return Promise.resolve({ ok: true, json: async () => r });
    };
}

const { render, reset, walk, StartMap, _resetMyIp, nearby } = require('./.build/startmap.cjs');

// The stub has no DOM to attach refs to. The map is built after an await, so
// giving the canvas div's ref a node straight after render is in time.
function attachRefs(tree) {
    for (const n of walk(tree)) {
        if (n && n.props && n.props.ref && 'current' in n.props.ref) n.props.ref.current = {};
    }
}

const RX = { name: 'Here', location: 'London', asl: 30, gps: { lat: 51.5, lon: -0.12 } };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

async function mount(routes, handheld = false) {
    fakeLeaflet();
    _resetMyIp();
    stubFetch(routes);
    reset();
    const out = render(StartMap, { receiver: RX, handheld });
    attachRefs(out.tree);
    return out;
}

// --- parse ---------------------------------------------------------------------

t('parse keeps placeable, linkable entries only', async () => {
    const list = nearby.parseNearby(NEARBY);
    assert.deepStrictEqual(list.map((r) => r.id), ['a', 'b']);
    assert.strictEqual(list[0].distanceKm, 61.4);
    assert.strictEqual(list[1].distanceKm, null);
    assert.deepStrictEqual(nearby.parseNearby(null), []);
    assert.deepStrictEqual(nearby.parseNearby({ receivers: 'x' }), []);
});

t('popup text: callsign first, then name and place, then facts', async () => {
    const [a, b] = nearby.parseNearby(NEARBY);
    const ta = nearby.popupText(a);
    assert.strictEqual(ta.title, 'G0AAA');
    assert.strictEqual(ta.name, 'Hilltop SDR');
    assert.ok(ta.location.endsWith('Kent, UK'));
    assert.strictEqual(ta.facts, '61 km away · 3/10 slots free');
    const tb = nearby.popupText(b);
    assert.strictEqual(tb.name, '');
    assert.strictEqual(tb.location, '');
    assert.strictEqual(tb.facts, '');
    // No callsign: the name is the heading and is not repeated.
    const tn = nearby.popupText({ ...a, callsign: '' });
    assert.strictEqual(tn.title, 'Hilltop SDR');
    assert.strictEqual(tn.name, '');
});

t('popup is text nodes, and Connect opens the URL', async () => {
    const [, b] = nearby.parseNearby(NEARBY);
    let opened = null;
    const root = nearby.buildPopup(document, b, (u) => { opened = u; });
    const call = root.children.find((c) => c.className === 'startmap-pop__call');
    assert.strictEqual(call.textContent, '<img src=x onerror=alert(1)>');
    assert.ok(!('innerHTML' in call));
    const btn = root.children.find((c) => c.tag === 'button');
    btn.listeners.click({ preventDefault() {}, stopPropagation() {} });
    assert.strictEqual(opened, 'https://b.example/');
});

// --- fetch ---------------------------------------------------------------------

t('fetch: 404, offline, bad JSON and a hang all give []', async () => {
    for (const r of [404, 'fail', { nope: 1 }]) {
        stubFetch({ '/api/nearby-receivers': r });
        assert.deepStrictEqual(await nearby.fetchNearbyReceivers(), []);
    }
    stubFetch({ '/api/nearby-receivers': 'hang' });
    const start = Date.now();
    assert.deepStrictEqual(await nearby.fetchNearbyReceivers({ timeoutMs: 50 }), []);
    assert.ok(Date.now() - start < 1000, 'timed out promptly');
});

t('fetch: a fetch that ignores abort still resolves by the timeout', async () => {
    globalThis.fetch = () => new Promise(() => {});
    assert.deepStrictEqual(await nearby.fetchNearbyReceivers({ timeoutMs: 30 }), []);
});

// --- the map -------------------------------------------------------------------

t('dots are added and the fit is still this receiver and you', async () => {
    await mount({ '/api/myip': MYIP, '/api/nearby-receivers': NEARBY });
    await tick(20);
    assert.strictEqual(log.markers.length, 2, 'receiver and you');
    assert.strictEqual(log.mapOpts.scrollWheelZoom, true, 'wheel zooms');
    assert.notStrictEqual(log.mapOpts.touchZoom, false, 'pinch zooms');
    assert.strictEqual(log.fits.length, 1);
    assert.deepStrictEqual(log.fits[0].pts, [[51.5, -0.12], [48.86, 2.35]]);
    assert.strictEqual(log.circles.length, 2);
    assert.deepStrictEqual(log.circles[0].ll, [51.2, 0.9]);
    assert.strictEqual(log.circles[0].tooltip, 'G0AAA');
    assert.strictEqual(log.circles[0].popupOpts.className, 'startmap-pop');
    const pop = log.circles[0].popup();
    assert.strictEqual(pop.children[0].textContent, 'G0AAA');
});

t('handheld: no hover label, the tap opens the popup', async () => {
    await mount({ '/api/myip': MYIP, '/api/nearby-receivers': NEARBY }, true);
    await tick(20);
    assert.strictEqual(log.circles.length, 2);
    assert.strictEqual(log.circles[0].tooltip, undefined);
    assert.ok(log.circles[0].popup);
});

for (const [label, r] of [['404', 404], ['offline', 'fail'], ['hung', 'hang']]) {
    t(`endpoint ${label}: pins, greeting and fit arrive as before`, async () => {
        await mount({ '/api/myip': MYIP, '/api/nearby-receivers': r });
        await tick(20);
        assert.strictEqual(log.markers.length, 2);
        assert.strictEqual(log.fits.length, 1, 'fit did not wait on the nearby list');
        assert.strictEqual(log.circles.length, 0);
    });
}

t('unmount while the list is in flight: nothing lands on a removed map', async () => {
    let resolve;
    globalThis.fetch = (url) => (url === '/api/nearby-receivers'
        ? new Promise((r) => { resolve = r; })
        : Promise.resolve({ ok: true, json: async () => MYIP }));
    fakeLeaflet();
    _resetMyIp();
    reset();
    const { tree, cleanups } = render(StartMap, { receiver: RX, handheld: false });
    attachRefs(tree);
    await tick(20);
    cleanups.forEach((c) => c());
    assert.strictEqual(log.removed, 1);
    if (resolve) resolve({ ok: true, json: async () => NEARBY });
    await tick(20);
    assert.strictEqual(log.circles.length, 0);
});

(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
    }
    console.log(`\n${pass}/${tests.length} startmap tests passed`);
})();

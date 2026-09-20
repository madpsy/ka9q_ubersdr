// The base layer under every Leaflet map, and what it does when the tiles do
// not come.
//
// This is the offline case, and it was the most visible thing wrong with the
// interface without a route out: four maps drawing their markers, tooltips and
// great-circle lines correctly onto a blank rectangle, with nothing on screen
// to say why. Leaflet's own behaviour on a tile that will not load is to leave
// the tile blank and fire `tileerror`, and none of the four listened.
//
// What is worth testing here is the decision, not the drawing: when to give up
// on the tiles, and — just as important — when not to. A map that swapped to
// the local outline because one tile out of thirty was unlucky would be
// replacing a working map with a worse one.

const assert = require('assert');
const base = require('./.build/leafletbase.cjs');

let pass = 0;
let chain = Promise.resolve();
const t = (name, fn) => {
    chain = chain.then(() => Promise.resolve(fn())).then(
        () => { console.log('ok    ' + name); pass++; },
        (e) => { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; },
    );
};

// --- the antimeridian --------------------------------------------------------

t('an arc becomes one run of latlngs, in Leaflet order', () => {
    // Flat [lon, lat, …] in, [[lat, lon], …] out. Getting this pair the wrong
    // way round puts England in the Indian Ocean and is invisible in review.
    const runs = base.arcToLatLngs([0, 51, 1, 52, 2, 53]);
    assert.strictEqual(runs.length, 1);
    assert.deepStrictEqual(runs[0], [[51, 0], [52, 1], [53, 2]]);
});

t('a run that crosses the antimeridian is cut rather than wrapped', () => {
    // Natural Earth cuts its geometry at ±180 so this should never arrive, but
    // the cost of being wrong is a stripe straight across every map.
    const runs = base.arcToLatLngs([179, 10, 179.5, 10, -179.5, 10, -179, 10]);
    assert.strictEqual(runs.length, 2, 'the jump should have started a new run');
    assert.deepStrictEqual(runs[0], [[10, 179], [10, 179.5]]);
    assert.deepStrictEqual(runs[1], [[10, -179.5], [10, -179]]);
});

t('a single point is not a line', () => {
    assert.deepStrictEqual(base.arcToLatLngs([0, 0]), []);
});

t('an empty arc yields nothing', () => {
    assert.deepStrictEqual(base.arcToLatLngs([]), []);
});

t('a trailing coordinate with no pair is dropped, not half-drawn', () => {
    // decodeArcs always pushes lon and lat together, so this is a guard on the
    // shape. Without it the odd one out becomes [undefined, lon] and Leaflet
    // draws the coastline to wherever that lands.
    const runs = base.arcToLatLngs([0, 1, 2, 3, 4]);
    assert.deepStrictEqual(runs, [[[1, 0], [3, 2]]]);
    for (const run of runs) {
        for (const [lat, lon] of run) {
            assert.ok(Number.isFinite(lat) && Number.isFinite(lon), `bad point ${lat},${lon}`);
        }
    }
});

// --- when the tiles are given up on -----------------------------------------
//
// Enough of Leaflet to hold the events and record what was added and removed.

function fakeL() {
    const events = {};
    const tiles = {
        added: false,
        on: (name, fn) => { (events[name] = events[name] || []).push(fn); },
        off: (name, fn) => {
            events[name] = (events[name] || []).filter((f) => f !== fn);
        },
        addTo: (m) => { tiles.added = true; m.layers.push(tiles); return tiles; },
        fire: (name) => { for (const fn of [...(events[name] || [])]) fn(); },
        listeners: (name) => (events[name] || []).length,
    };
    const L = {
        tileLayer: (url, opts) => { tiles.url = url; tiles.opts = opts; return tiles; },
        canvas: () => ({ canvas: true }),
        polyline: (runs, opts) => ({
            runs,
            opts,
            addTo: (m) => { m.layers.push('outline'); },
            bringToBack: () => {},
        }),
    };
    const map = {
        layers: [],
        removeLayer: (l) => { map.layers = map.layers.filter((x) => x !== l); },
    };
    return { L, map, tiles };
}

// The outline is fetched from the receiver, so the module under test reaches
// for /countries-110m.json exactly as the browser would.
const TOPO = {
    type: 'Topology',
    arcs: [[[0, 0], [10, 10]], [[20, 20], [5, 5]]],
    objects: {},
};
let served = () => Promise.resolve({ ok: true, json: () => Promise.resolve(TOPO) });
globalThis.fetch = (...a) => served(...a);
// worldMap.js caches the outline for the page — one decode shared by every map,
// which is the point of it. Each case here starts from a clean cache so that
// what it is testing is its own, and not what ran before it.
const freshOutline = () => base._resetWorldArcs();

t('tiles go on the map, and the watch is armed', () => {
    const { L, map, tiles } = fakeL();
    base.addBaseLayer(L, map);
    assert.ok(tiles.added, 'the tile layer was never added');
    assert.strictEqual(tiles.url, base.TILE_URL);
    assert.ok(tiles.listeners('tileerror') > 0, 'nothing is watching for failures');
});

t('one tile failing is not the connection failing', () => {
    const { L, map, tiles } = fakeL();
    base.addBaseLayer(L, map);
    tiles.fire('tileerror');
    tiles.fire('tileerror');
    assert.deepStrictEqual(map.layers, [tiles], 'gave up on the tiles far too early');
});

t('a tile that loads disarms the watch for good', () => {
    const { L, map, tiles } = fakeL();
    base.addBaseLayer(L, map);
    tiles.fire('tileload');
    assert.strictEqual(tiles.listeners('tileerror'), 0, 'still listening after the tiles proved fine');
    // Whatever happens after that is about those tiles, not about the network.
    tiles.fire('tileerror');
    tiles.fire('tileerror');
    tiles.fire('tileerror');
    tiles.fire('tileerror');
    assert.deepStrictEqual(map.layers, [tiles], 'a working map was swapped for the outline');
});

t('nothing loading and enough failing swaps in the local outline', async () => {
    const { L, map, tiles } = fakeL();
    base.addBaseLayer(L, map);
    for (let i = 0; i < base.FAIL_THRESHOLD; i++) tiles.fire('tileerror');

    // The failed layer comes off as well as the outline going on. Left on, it
    // re-requests the whole grid on every pan and zoom, at a tile server this
    // receiver has just established it cannot reach.
    assert.ok(!map.layers.includes(tiles), 'the dead tile layer was left on the map');

    await new Promise((r) => setImmediate(r));
    assert.ok(map.layers.includes('outline'), 'no outline was drawn');
});

t('the outline is drawn under everything, and takes no clicks', async () => {
    const { L, map } = fakeL();
    const layer = await base.addWorldOutline(L, map);
    assert.ok(layer, 'no outline layer');
    assert.strictEqual(layer.opts.interactive, false, 'scenery must not swallow a press meant for a marker');
    assert.ok(layer.opts.renderer, 'a layer per arc would be felt on the spots map');
    assert.strictEqual(layer.opts.attribution, base.OFFLINE_ATTRIBUTION);
    // Two arcs in, two runs out — the outline is the whole world, not one shape.
    assert.strictEqual(layer.runs.length, 2);
});

t('a receiver that cannot serve the outline leaves the map as it was', async () => {
    const prev = served;
    served = () => Promise.reject(new TypeError('Failed to fetch'));
    freshOutline();
    try {
        const { L, map } = fakeL();
        const layer = await base.addWorldOutline(L, map);
        assert.strictEqual(layer, null, 'claimed to have drawn an outline it could not load');
        assert.deepStrictEqual(map.layers, [], 'something was added anyway');
    } finally {
        served = prev;
        freshOutline();
    }
});

t('a map torn down while the outline is loading is not drawn on', async () => {
    // The panel was collapsed, or the modal closed, while
    // /countries-110m.json was in flight. Leaflet throws on a map it has
    // already pulled apart, and that throw is inside a promise nobody is
    // holding — so it has to be caught here or it surfaces as an unhandled
    // rejection on a receiver that is otherwise working perfectly well.
    freshOutline();
    const { L, map } = fakeL();
    L.polyline = () => ({
        addTo: () => { throw new Error('Map container is being reused by another instance'); },
        bringToBack: () => {},
    });
    assert.strictEqual(await base.addWorldOutline(L, map), null, 'the throw escaped');
    assert.deepStrictEqual(map.layers, [], 'something was added to a map that is gone');
});

t('no map is no outline', async () => {
    freshOutline();
    assert.strictEqual(await base.addWorldOutline(fakeL().L, null), null);
});

chain.then(() => {
    if (process.exitCode) console.log('\nleaflet base tests FAILED');
    else console.log(`\nall ${pass} leaflet base checks passed`);
});

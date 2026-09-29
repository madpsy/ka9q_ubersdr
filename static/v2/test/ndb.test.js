// The NDB panel's data handling.
//
// The panel takes one endpoint, /api/beacons, and turns it into dots on a regional map.
// What is worth pinning down is that slice: which records can be drawn, the order they
// are listed in, the unit conversions (the addon deals in unix seconds and hertz), and
// the framing, since a map framed wrongly shows nothing at all.

const assert = require('assert');
const nd = require('./.build/ndb.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const NOW = 1790700000000;
const secs = (ms) => Math.round(ms / 1000);
// A beacon as /api/beacons sends it.
const beacon = (over = {}) => ({
    ident: 'EDN',
    confirmed: true,
    name: 'Edinburgh',
    country: 'GB',
    freq_hz: 340999.3,
    lat: 55.9784,
    lon: -3.2841,
    dist_km: 8,
    bearing_deg: 147,
    first_heard: secs(NOW - 3600000),
    last_heard: secs(NOW - 2000),
    age_s: 2,
    best_snr_db: 56.4,
    live: true,
    snr_db: 55.1,
    ...over,
});
const ME = { lat: 56.0366, lon: -3.3513 };

// --- is the addon there? -----------------------------------------------------

t('the addon is found in the list by name, whatever its case', () => {
    assert.strictEqual(nd.ndbAvailable({ addons: ['NDB'] }), true);
    assert.strictEqual(nd.ndbAvailable({ addons: ['hfdl', 'ndb'] }), true);
    assert.strictEqual(nd.ndbAvailable({ addons: ['hfdl'] }), false);
    assert.strictEqual(nd.ndbAvailable(null), false);
});

t('the endpoint is the addon\'s own, under the proxy, with the window', () => {
    assert.strictEqual(nd.beaconsUrl(), '/addon/ndb/api/beacons?max_age=3600');
    assert.strictEqual(nd.beaconsUrl(600), '/addon/ndb/api/beacons?max_age=600');
    assert.strictEqual(nd.addonUrl(), '/addon/ndb/');
});

t('the window is one the addon accepts (it 400s outside 1..604800)', () => {
    assert.ok(nd.WINDOW_S >= 1 && nd.WINDOW_S <= 604800);
    assert.strictEqual(nd.POLL_MS, 5000);
});

// --- one beacon ----------------------------------------------------------------

t('a beacon is normalised: kHz from Hz, milliseconds from seconds', () => {
    const b = nd.normaliseBeacon(beacon());
    assert.strictEqual(b.ident, 'EDN');
    assert.strictEqual(b.key, 'EDN@341.0');
    assert.ok(Math.abs(b.khz - 340.9993) < 1e-6);
    assert.strictEqual(b.lastAt, secs(NOW - 2000) * 1000);
    assert.strictEqual(b.live, true);
    assert.strictEqual(b.snr, 55.1);
    assert.strictEqual(b.distKm, 8);
});

t('an unlisted beacon (null position) is kept for the list but not placed at 0,0', () => {
    const b = nd.normaliseBeacon(beacon({ confirmed: false, lat: null, lon: null, name: '', dist_km: null }));
    assert.strictEqual(b.lat, null);
    assert.strictEqual(b.lon, null);
    assert.strictEqual(nd.mappable([b]).length, 0);
});

t('a position of exactly 0,0 is treated as none', () => {
    const b = nd.normaliseBeacon(beacon({ lat: 0, lon: 0 }));
    assert.strictEqual(b.lat, null);
});

t('a record without an ident is dropped, and junk does not throw', () => {
    assert.strictEqual(nd.normaliseBeacon(beacon({ ident: '' })), null);
    assert.strictEqual(nd.normaliseBeacon(null), null);
    assert.deepStrictEqual(nd.beaconList(null), []);
    assert.deepStrictEqual(nd.beaconList({ error: 'max_age must be…' }), []);
    assert.deepStrictEqual(nd.beaconList('<html>'), []);
});

t('a live beacon with no current SNR is null, not zero', () => {
    const b = nd.normaliseBeacon(beacon({ snr_db: null }));
    assert.strictEqual(b.snr, null);
    assert.strictEqual(nd.snrLabel(b.snr), '');
});

// --- the list ------------------------------------------------------------------

t('live first, strongest first; then the rest, most recently heard first', () => {
    const list = nd.beaconList({ beacons: [
        beacon({ ident: 'OLD', live: false, snr_db: null, last_heard: secs(NOW - 900000) }),
        beacon({ ident: 'WEAK', snr_db: 20 }),
        beacon({ ident: 'NEWER', live: false, snr_db: null, last_heard: secs(NOW - 60000) }),
        beacon({ ident: 'STRONG', snr_db: 50 }),
    ] });
    assert.deepStrictEqual(list.map((b) => b.ident), ['STRONG', 'WEAK', 'NEWER', 'OLD']);
});

t('the reply object or its bare array are both accepted', () => {
    assert.strictEqual(nd.beaconList([beacon()]).length, 1);
    assert.strictEqual(nd.beaconList({ beacons: [beacon()] }).length, 1);
});

t('quiet: not live, and nothing for ten minutes', () => {
    const recent = nd.normaliseBeacon(beacon({ live: false, last_heard: secs(NOW - 60000) }));
    const quiet = nd.normaliseBeacon(beacon({ live: false, last_heard: secs(NOW - 11 * 60000) }));
    const live = nd.normaliseBeacon(beacon({ last_heard: secs(NOW - 11 * 60000) }));
    assert.strictEqual(nd.isQuiet(recent, NOW), false);
    assert.strictEqual(nd.isQuiet(quiet, NOW), true);
    assert.strictEqual(nd.isQuiet(live, NOW), false);
});

t('the summary counts live and heard, and names the furthest live one', () => {
    const list = nd.beaconList([
        beacon({ ident: 'EDN', dist_km: 8 }),
        beacon({ ident: 'ATF', dist_km: 139 }),
        beacon({ ident: 'CFN', dist_km: 333, live: false }),
    ]);
    const s = nd.ndbSummary(list, ME);
    assert.strictEqual(s.count, 3);
    assert.strictEqual(s.live, 2);
    assert.strictEqual(s.furthest.beacon.ident, 'ATF');   // CFN is further but not live
    assert.strictEqual(s.furthest.km, 139);
    assert.strictEqual(nd.ndbSummary([], ME).furthest, null);
});

t('labels', () => {
    assert.strictEqual(nd.khzLabel(340.9993), '341.0 kHz');
    assert.strictEqual(nd.khzLabel(null), '');
    assert.strictEqual(nd.snrLabel(38.4), '38 dB');
    assert.strictEqual(nd.beaconLabel(nd.normaliseBeacon(beacon())), 'EDN Edinburgh');
    assert.strictEqual(nd.beaconLabel(nd.normaliseBeacon(beacon({ name: '' }))), 'EDN');
});

// --- the framing ---------------------------------------------------------------

const W = 900;
const H = 450;
const inView = (p, v) => {
    const s = (W / 360) * v.z;
    const x = W / 2 + (p.lon - v.lon) * s;
    const y = H / 2 - (p.lat - v.lat) * s;
    return x >= 0 && x <= W && y >= 0 && y <= H;
};

t('the frame holds the receiver and every beacon', () => {
    const list = nd.beaconList([
        beacon({ ident: 'ATF', lat: 57.0775, lon: -2.1057 }),
        beacon({ ident: 'CBL', lat: 55.4356, lon: -5.6881 }),
        beacon({ ident: 'CFN', lat: 55.0442, lon: -8.341 }),
    ]);
    const v = nd.frameView(ME, list, W, H);
    for (const p of [ME, ...nd.mappable(list)]) assert.ok(inView(p, v), `${p.ident || 'me'} off the map`);
    assert.ok(v.z > 5, `zoomed out too far for a region: z=${v.z}`);
});

t('a cluster within ~160 km fills the map rather than sitting in its middle', () => {
    const list = nd.beaconList([
        beacon({ ident: 'ATF', lat: 57.0775, lon: -2.1057 }),
        beacon({ ident: 'CBL', lat: 55.4356, lon: -5.6881 }),
    ]);
    const v = nd.frameView(ME, list, W, H);
    const s = (W / 360) * v.z;
    const spanPx = (-2.1057 - -5.6881) * s;   // ATF to CBL, across the map
    assert.ok(spanPx > W * 0.5, `the cluster spans only ${Math.round(spanPx)} of ${W} px`);
    assert.ok(v.z <= nd.NDB_ZOOM_MAX);
});

t('the NDB clamp allows the deeper zoom and still keeps the view on the planet', () => {
    assert.strictEqual(nd.clampNdbView({ lon: 0, lat: 0, z: 1000 }, W, H).z, nd.NDB_ZOOM_MAX);
    assert.strictEqual(nd.clampNdbView({ lon: 170, lat: 0, z: 1 }, W, H).lon, 0);
});

t('with one close beacon it stays at a regional scale rather than street level', () => {
    const v = nd.frameView(ME, nd.beaconList([beacon()]), W, H);
    const spanLat = 180 * (H / W) * 2 / v.z;   // degrees of latitude on screen
    assert.ok(spanLat >= 2.4, `only ${spanLat.toFixed(2)}° of latitude in view`);
});

t('with nothing to frame it is the receiver, or the world', () => {
    const v = nd.frameView(ME, [], W, H);
    assert.ok(inView(ME, v));
    assert.deepStrictEqual(nd.frameView(null, [], W, H), { lon: 0, lat: 0, z: 1 });
});

t('unplaced beacons do not pull the frame to 0,0', () => {
    const a = nd.frameView(ME, nd.beaconList([beacon()]), W, H);
    const b = nd.frameView(ME, nd.beaconList([beacon(), beacon({ ident: 'X', lat: null, lon: null })]), W, H);
    assert.deepStrictEqual(a, b);
});

// --- range rings -----------------------------------------------------------------

t('a range ring is the given distance from its centre all the way round', () => {
    const R = 6371;
    const rad = Math.PI / 180;
    const dist = (a, b) => {
        const s = Math.sin((b.lat - a.lat) * rad / 2) ** 2
            + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lon - a.lon) * rad / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(s));
    };
    for (const [lon, lat] of nd.rangeRing(ME, 500, 24)) {
        assert.ok(Math.abs(dist(ME, { lat, lon }) - 500) < 0.5, `point ${lat},${lon} not 500 km out`);
    }
});

t('rings reach just past the furthest beacon, and there is always one', () => {
    assert.deepStrictEqual(nd.ringsFor(0), [100, 250]);
    assert.deepStrictEqual(nd.ringsFor(333), [100, 250]);
    assert.deepStrictEqual(nd.ringsFor(480), [100, 250, 500]);
    assert.deepStrictEqual(nd.ringsFor(1500), [100, 250, 500, 1000]);
});

console.log(`\n${pass} passed`);

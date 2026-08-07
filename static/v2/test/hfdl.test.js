// The HFDL panel's data handling.
//
// The addon is a large thing and the panel takes a narrow slice of it: positions, ground
// stations and two figures. What is worth pinning down is the slice — which records are
// worth drawing, when an aeroplane stops being where the map says it is, and the unit
// conversions, since the addon deals in unix seconds and kilohertz.

const assert = require('assert');
const hf = require('./.build/hfdl.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const NOW = 1786123727000;
const secs = (ms) => Math.round(ms / 1000);
// An aircraft as the addon sends it.
const plane = (over = {}) => ({
    key: '4076f5',
    icao: '4076F5',
    reg: 'g-vwoo',
    flight: 'vs401',
    lat: 51.5,
    lon: -30.2,
    freq_khz: 13276,
    gs_id: 1,
    msg_count: 14,
    sig_level: -71.2,
    last_seen: secs(NOW - 120000),
    alt_ft: 35000,
    alt_valid: true,
    gnd_spd_kts: 480,
    true_trk_deg: 271,
    true_trk_valid: true,
    tracked_km: 1420.5,
    ...over,
});

const station = (over = {}) => ({
    gs_id: 1,
    location: 'San Francisco, California',
    lat: 37.6,
    lon: -122.4,
    last_heard: secs(NOW - 300000),
    spdu_active: true,
    ...over,
});

// --- is the addon there? -----------------------------------------------------

t('the addon is found in the list by name, whatever its case', () => {
    assert.strictEqual(hf.hfdlAvailable({ addons: ['HFDL'] }), true);
    assert.strictEqual(hf.hfdlAvailable({ addons: ['sstv', 'hfdl'] }), true);
    assert.strictEqual(hf.hfdlAvailable({ addons: ['sstv'] }), false);
    assert.strictEqual(hf.hfdlAvailable(null), false);
});

t('the routes are the addon\'s own, under the proxy', () => {
    assert.strictEqual(hf.aircraftUrl(), '/addon/hfdl/aircraft');
    assert.strictEqual(hf.stationsUrl(), '/addon/hfdl/groundstations');
    assert.strictEqual(hf.addonUrl(), '/addon/hfdl/');
});

// --- one aircraft ---------------------------------------------------------------

t('an aircraft keeps its identity, its position and its link', () => {
    const a = hf.normaliseAircraft(plane());
    assert.strictEqual(a.flight, 'VS401');
    assert.strictEqual(a.reg, 'G-VWOO');
    assert.strictEqual(a.lat, 51.5);
    assert.strictEqual(a.khz, 13276);
    assert.strictEqual(a.at, NOW - 120000, 'seconds became milliseconds');
    assert.strictEqual(a.alt, 35000);
    assert.strictEqual(a.track, 271);
});

t('it is called whatever a person would recognise it by', () => {
    // Flight number first — it is what a passenger and a tracker both use — then the
    // registration, then the hex, which is the last resort and always there.
    assert.strictEqual(hf.aircraftLabel(hf.normaliseAircraft(plane())), 'VS401');
    assert.strictEqual(hf.aircraftLabel(hf.normaliseAircraft(plane({ flight: '' }))), 'G-VWOO');
    assert.strictEqual(hf.aircraftLabel(hf.normaliseAircraft(plane({ flight: '', reg: '' }))), '4076F5');
});

t('an altitude the addon has not validated is not an altitude', () => {
    // alt_ft carries a stale or default value when alt_valid is false, and "FL0" over
    // the Atlantic would be a striking thing to claim.
    assert.strictEqual(hf.normaliseAircraft(plane({ alt_valid: false })).alt, null);
    assert.strictEqual(hf.normaliseAircraft(plane({ true_trk_valid: false })).track, null);
});

t('an aeroplane on the ground is at zero feet, which is a reading', () => {
    // The distinction the null-vs-zero care is for: nothing reported is null, and zero
    // reported is zero.
    assert.strictEqual(hf.normaliseAircraft(plane({ alt_ft: 0, alt_valid: true })).alt, 0);
    assert.strictEqual(hf.normaliseAircraft(plane({ gnd_spd_kts: null })).speed, null);
});

t('no position, no aircraft — this panel is a map', () => {
    assert.strictEqual(hf.normaliseAircraft(plane({ lat: 0, lon: 0 })), null);
    assert.strictEqual(hf.normaliseAircraft(plane({ lat: null })), null);
    assert.strictEqual(hf.normaliseAircraft(null), null);
});

// --- what is worth drawing ---------------------------------------------------------

t('the freshest report is first, because that is the one being watched', () => {
    const list = hf.liveAircraft([
        plane({ key: 'a', last_seen: secs(NOW - 900000) }),
        plane({ key: 'b', last_seen: secs(NOW - 60000) }),
    ], NOW);
    assert.deepStrictEqual(list.map((a) => a.key), ['b', 'a']);
});

t('an aircraft nobody has heard for an hour comes off the map', () => {
    // A position report is a snapshot of something doing 500 knots: a two-hour-old dot
    // is a thousand miles from where that aeroplane is, which is worse than no dot.
    const list = hf.liveAircraft([
        plane({ key: 'gone', last_seen: secs(NOW - 2 * 3600 * 1000) }),
        plane({ key: 'here', last_seen: secs(NOW - 60000) }),
    ], NOW);
    assert.deepStrictEqual(list.map((a) => a.key), ['here']);
});

t('between half an hour and an hour it is stale rather than gone', () => {
    // Still information — it was there and has not reported since — so it is drawn
    // faded instead of removed.
    const old = hf.normaliseAircraft(plane({ last_seen: secs(NOW - 40 * 60000) }));
    assert.strictEqual(hf.isStale(old, NOW), true);
    const fresh = hf.normaliseAircraft(plane());
    assert.strictEqual(hf.isStale(fresh, NOW), false);
    assert.strictEqual(hf.liveAircraft([plane({ last_seen: secs(NOW - 40 * 60000) })], NOW).length, 1);
});

t('nonsense in the list is skipped rather than fatal', () => {
    assert.deepStrictEqual(hf.liveAircraft(null), []);
    assert.deepStrictEqual(hf.liveAircraft([null, {}, 'x']), []);
});

// --- the ground stations ------------------------------------------------------------

t('a station is kept when it can be put on the map', () => {
    const [s] = hf.stationList([station()]);
    assert.strictEqual(s.id, 1);
    assert.strictEqual(s.name, 'San Francisco, California');
    assert.strictEqual(s.active, true);
    assert.strictEqual(s.at, NOW - 300000);
});

t('a station with no position cannot be drawn, so it is not kept', () => {
    assert.deepStrictEqual(hf.stationList([station({ lat: 0, lon: 0 })]), []);
    assert.deepStrictEqual(hf.stationList([station({ lat: undefined })]), []);
    assert.deepStrictEqual(hf.stationList(null), []);
});

t('never heard is no time at all, rather than 1970', () => {
    assert.strictEqual(hf.stationList([station({ last_heard: 0 })])[0].at, 0);
});

t('an aircraft is matched to the station it was talking to', () => {
    const list = hf.stationList([station(), station({ gs_id: 5, location: 'Shannon', lat: 52, lon: -9 })]);
    assert.strictEqual(hf.stationOf(list, 5).name, 'Shannon');
    assert.strictEqual(hf.stationOf(list, 99), null);
    assert.strictEqual(hf.stationOf(list, 0), null, 'and no station is not station zero');
});

// --- the figures ---------------------------------------------------------------------

t('the summary separates what is current from what is merely still on the map', () => {
    const list = hf.liveAircraft([
        plane({ key: 'a' }),
        plane({ key: 'b' }),
        plane({ key: 'c', last_seen: secs(NOW - 45 * 60000) }),
    ], NOW);
    const sum = hf.hfdlSummary(list, null, NOW);
    assert.strictEqual(sum.count, 3);
    assert.strictEqual(sum.fresh, 2);
});

t('the busiest frequency is the one carrying the most aircraft', () => {
    // Which frequency is working is the HF question — the band moves with the
    // ionosphere all day.
    const list = hf.liveAircraft([
        plane({ key: 'a', freq_khz: 13276 }),
        plane({ key: 'b', freq_khz: 13276 }),
        plane({ key: 'c', freq_khz: 5652 }),
    ], NOW);
    const sum = hf.hfdlSummary(list, null, NOW);
    assert.strictEqual(sum.busiest, 13276);
    assert.strictEqual(sum.onBusiest, 2);
});

t('an empty sky has no busiest frequency and no message count', () => {
    assert.deepStrictEqual(hf.hfdlSummary([], null, NOW), {
        count: 0, fresh: 0, busiest: 0, onBusiest: 0, messages: null,
    });
    assert.strictEqual(hf.hfdlSummary([], { total_messages: 4210 }, NOW).messages, 4210);
});

// --- how it reads ---------------------------------------------------------------------

t('kilohertz read as megahertz, which is how a frequency list writes them', () => {
    assert.strictEqual(hf.freqLabel(13276), '13.276 MHz');
    assert.strictEqual(hf.freqLabel(0), '');
});

t('altitude reads as a flight level up high and as feet down low', () => {
    // FL350 is what the crew and the controller both say; 2000 ft is not "FL20".
    assert.strictEqual(hf.altLabel(35000), 'FL350');
    assert.strictEqual(hf.altLabel(18000), 'FL180');
    assert.strictEqual(hf.altLabel(2400), '2400 ft');
    assert.strictEqual(hf.altLabel(0), '0 ft');
    assert.strictEqual(hf.altLabel(null), '');
});

if (process.exitCode) console.log('\nHFDL tests FAILED');
else console.log(`\nall ${pass} HFDL tests passed`);

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

// --- bands, which is what the map is coloured by --------------------------------------

t('a frequency belongs to the megahertz allocation it sits in', () => {
    assert.strictEqual(hf.bandOf(13276), 13);
    assert.strictEqual(hf.bandOf(5652), 5);
    assert.strictEqual(hf.bandOf(0), 0);
});

t('a band keeps its colour, whatever order the bands were first heard in', () => {
    // The addon hands out colours in the order it first hears a band, which makes
    // 13 MHz blue tonight and orange tomorrow. Here the band picks the colour.
    assert.strictEqual(hf.bandColour(13), hf.bandColour(13));
    assert.notStrictEqual(hf.bandColour(13), hf.bandColour(5));
    // No frequency is not a band, and should not be given one of their colours.
    assert.notStrictEqual(hf.bandColour(0), hf.bandColour(2));
    // A band outside the known allocations still gets a colour rather than nothing.
    assert.ok(hf.bandColour(29));
});

t('the legend is the bands actually on the map, low to high, with their counts', () => {
    const list = hf.liveAircraft([
        plane({ key: 'a', freq_khz: 13276 }),
        plane({ key: 'b', freq_khz: 13312 }),
        plane({ key: 'c', freq_khz: 5652 }),
        plane({ key: 'd', freq_khz: 0 }),
    ], NOW);
    assert.deepStrictEqual(hf.bandCounts(list), [
        { mhz: 0, count: 1 }, { mhz: 5, count: 1 }, { mhz: 13, count: 2 },
    ]);
    assert.deepStrictEqual(hf.bandCounts([]), []);
});

t('switching a band off takes exactly that band off the map', () => {
    const list = hf.liveAircraft([
        plane({ key: 'a', freq_khz: 13276 }),
        plane({ key: 'b', freq_khz: 5652 }),
    ], NOW);
    assert.deepStrictEqual(hf.visibleAircraft(list, new Set([13])).map((a) => a.key), ['b']);
    // No filter at all is the list itself, not a copy of it: this runs on every draw.
    assert.strictEqual(hf.visibleAircraft(list, new Set()), list);
    assert.strictEqual(hf.visibleAircraft(list, null), list);
});

// --- one aircraft, in detail ----------------------------------------------------------

t('the hex to look an aircraft up by is the hex, or a key that is one', () => {
    assert.strictEqual(hf.icaoHex({ icao: '4076F5', key: '4076f5' }), '4076F5');
    // "ICAO hex if known, else registration" — so a key of six hex digits is one.
    assert.strictEqual(hf.icaoHex({ icao: '', key: '4076f5' }), '4076F5');
    // And a registration is not, however much it looks like a name for the aeroplane.
    assert.strictEqual(hf.icaoHex({ icao: '', key: 'G-VWOO' }), '');
    assert.strictEqual(hf.icaoHex(null), '');
});

t('the track drops the fixes that are not positions', () => {
    const pts = hf.trackPoints([
        { lat: 51.5, lon: -30.2, time: secs(NOW - 3600000) },
        { lat: 0, lon: 0, time: secs(NOW) },        // the null island fix again
        { lat: 52.1, lon: null, time: secs(NOW) },  // half a position is not one
        { lat: 52.1, lon: -28.4, time: secs(NOW) },
    ]);
    assert.strictEqual(pts.length, 2);
    // Milliseconds, like every other time in the panel — the addon deals in seconds.
    assert.strictEqual(pts[0].at, NOW - 3600000);
    assert.deepStrictEqual(hf.trackPoints(null), []);
});

t('a lookup that knew nothing is nothing, not a record of empty strings', () => {
    assert.strictEqual(hf.enrichment(null), null);
    assert.strictEqual(hf.enrichment({}), null);
    assert.strictEqual(hf.enrichment({ operator: '   ' }), null);
    const e = hf.enrichment({
        operator: 'Virgin Atlantic',
        icao_type: 'B789',
        origin: { icao: 'EGLL', iata: 'LHR', name: 'London Heathrow' },
        destination: { iata: 'JFK', city: 'New York', country: 'United States' },
    });
    assert.strictEqual(e.operator, 'Virgin Atlantic');
    assert.strictEqual(e.icaoType, 'B789');
    // An airport with no city and no country falls back to its name, rather than being
    // reduced to a three-letter code somebody then has to look up separately.
    assert.strictEqual(hf.airportLabel(e.from), 'LHR — London Heathrow');
    assert.strictEqual(hf.airportLabel(e.to), 'JFK — New York, United States');
    assert.strictEqual(hf.airportLabel(null), '');
});

t('the photo is the first one, at the size a column can hold', () => {
    assert.strictEqual(hf.firstPhoto(null), null);
    assert.strictEqual(hf.firstPhoto({ photos: [] }), null);
    assert.strictEqual(hf.firstPhoto({ photos: [{ link: 'x' }] }), null);
    const p = hf.firstPhoto({
        photos: [
            { thumbnail: { src: 'small.jpg' }, thumbnail_large: { src: 'large.jpg' },
                link: 'https://planespotters/1', photographer: 'A N Other' },
            { thumbnail_large: { src: 'second.jpg' } },
        ],
    });
    assert.deepStrictEqual(p, {
        src: 'large.jpg', link: 'https://planespotters/1', by: 'A N Other',
    });
});

// --- where it is, from here -----------------------------------------------------------

t('distance is the great circle, and needs both ends', () => {
    // London to New York, near enough — the figure everyone knows.
    const km = hf.greatCircleKm({ lat: 51.5, lon: -0.13 }, { lat: 40.71, lon: -74.0 });
    assert.ok(km > 5540 && km < 5600, `got ${km}`);
    assert.strictEqual(hf.greatCircleKm({ lat: 1, lon: 1 }, { lat: 1, lon: 1 }), 0);
    assert.strictEqual(hf.greatCircleKm(null, { lat: 1, lon: 1 }), null);
});

t('a heading reads as degrees and as a point of the compass', () => {
    assert.strictEqual(hf.headingLabel(0), '0° N');
    assert.strictEqual(hf.headingLabel(271), '271° W');
    assert.strictEqual(hf.headingLabel(359), '359° N');
    // The addon can report a track past a full circle after a wrap; it is still a way.
    assert.strictEqual(hf.headingLabel(-90), '270° W');
    assert.strictEqual(hf.headingLabel(null), '');
});

t('kilometres lose their last digits once there are enough of them', () => {
    assert.strictEqual(hf.kmLabel(1420.5), '1,421 km');
    assert.strictEqual(hf.kmLabel(12500), '12.5k km');
    assert.strictEqual(hf.kmLabel(0), '0 km');
    assert.strictEqual(hf.kmLabel(null), '');
});

if (process.exitCode) console.log('\nHFDL tests FAILED');
else console.log(`\nall ${pass} HFDL tests passed`);

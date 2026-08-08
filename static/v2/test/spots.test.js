// Spot normalisation, tuning and filtering.
//
// Pinned against the v1 extensions, which are the reference implementation:
// the payload field names are the server's, and the mode rules are copied from
// dx-cluster/digital-spots/cw-spots `tuneToSpot`. Every failure here is silent
// in use — a spot that tunes to the wrong sideband still tunes, a duplicated
// buffer replay still renders, a mis-scaled frequency still looks like a
// frequency.

const assert = require('assert');
const {
    MAX_SPOTS, DEFAULT_AGE_MIN, TEN_M_BEACON_HZ, DEFAULT_FILTERS, MARKER_AGE_MIN,
    normaliseDX, normaliseDigital, normaliseCW,
    modeForSpot, filterSpots, countriesIn, addSpot, spotKey, ageLabel, markerSpots,
    AUTO_BAND, resolveBandFilter,
} = require('./.build/spots.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const NOW = Date.parse('2026-08-03T12:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

// Payloads exactly as dxcluster_websocket.go emits them.
const dxRaw = {
    frequency: 14025000, dx_call: 'VK9DX', spotter: 'G4ABC', comment: 'CW 599',
    time: iso(0), band: '20m', country: 'Norfolk Island', country_code: 'NF',
    continent: 'OC', time_offset: 11,
};
const digitalRaw = {
    mode: 'FT8', band: '20m', callsign: 'JA1ABC', locator: 'PM95', country: 'Japan',
    country_code: 'JP', Continent: 'AS', snr: -12, frequency: 14074000,
    timestamp: iso(0), message: 'CQ JA1ABC PM95', distance_km: 9500, bearing_deg: 35,
};
const cwRaw = {
    frequency: 7025000, dx_call: 'W1AW', spotter: 'DL0ABC', snr: 18, wpm: 25,
    comment: '', time: iso(0), band: '40m', country: 'United States',
    country_code: 'US', continent: 'NA', latitude: 41.7, longitude: -72.7,
    distance_km: 5400, bearing_deg: 290, grid: 'FN31',
};

// --- normalisation ---------------------------------------------------------

t('the three feeds’ different callsign fields land on one name', () => {
    // dx_call, callsign, dx_call — three names for the same thing.
    assert.strictEqual(normaliseDX(dxRaw).callsign, 'VK9DX');
    assert.strictEqual(normaliseDigital(digitalRaw).callsign, 'JA1ABC');
    assert.strictEqual(normaliseCW(cwRaw).callsign, 'W1AW');
});

t('frequencies stay in Hz, as the server sends them', () => {
    // The server converts the cluster's kHz on the way in. Re-scaling here
    // would tune 14 MHz spots to 14 kHz.
    assert.strictEqual(normaliseDX(dxRaw).frequency, 14025000);
    assert.strictEqual(normaliseDigital(digitalRaw).frequency, 14074000);
    assert.strictEqual(normaliseCW(cwRaw).frequency, 7025000);
});

t('continent is read under both spellings the server uses', () => {
    // DX and CW spots say `continent`; digital spots say `Continent`.
    assert.strictEqual(normaliseDX(dxRaw).continent, 'OC');
    assert.strictEqual(normaliseCW(cwRaw).continent, 'NA');
    assert.strictEqual(normaliseDigital(digitalRaw).continent, 'AS');
});

t('a DX spot reports no SNR rather than a misleading zero', () => {
    // Cluster spots carry no SNR at all. Reporting 0 would let a "min SNR"
    // filter appear to work while silently keeping everything.
    assert.strictEqual(normaliseDX(dxRaw).snr, null);
    assert.strictEqual(normaliseDigital(digitalRaw).snr, -12);
    assert.strictEqual(normaliseCW(cwRaw).snr, 18);
});

t('both timestamp field names are understood', () => {
    assert.strictEqual(normaliseDX({ ...dxRaw, time: iso(60000) }).at, NOW - 60000);
    assert.strictEqual(normaliseDigital({ ...digitalRaw, timestamp: iso(60000) }).at, NOW - 60000);
});

t('a missing or unparseable timestamp does not produce NaN', () => {
    // NaN would sort the row to an unpredictable place and make its age blank.
    assert.ok(Number.isFinite(normaliseDX({ ...dxRaw, time: undefined }).at));
    assert.ok(Number.isFinite(normaliseDX({ ...dxRaw, time: 'not a date' }).at));
});

// --- tuning: v1's rules ----------------------------------------------------

t('CW spots cross sidebands at 10 MHz', () => {
    // v1: `spot.frequency < 10000000 ? 'cwl' : 'cwu'`.
    assert.strictEqual(modeForSpot(normaliseCW({ ...cwRaw, frequency: 7025000 })), 'cwl');
    assert.strictEqual(modeForSpot(normaliseCW({ ...cwRaw, frequency: 14025000 })), 'cwu');
    // Exactly on the boundary is upper, as v1's >= puts it.
    assert.strictEqual(modeForSpot(normaliseCW({ ...cwRaw, frequency: 10000000 })), 'cwu');
});

t('digital spots are always USB, on every band', () => {
    assert.strictEqual(modeForSpot(normaliseDigital({ ...digitalRaw, frequency: 3573000 })), 'usb');
    assert.strictEqual(modeForSpot(normaliseDigital({ ...digitalRaw, frequency: 28074000 })), 'usb');
});

t('a DX spot’s mode comes from the spotter’s comment', () => {
    const at = (comment, frequency) => modeForSpot(normaliseDX({ ...dxRaw, comment, frequency }));
    // FT8/FT4 is USB regardless of band — v1 checks this before the band rule.
    assert.strictEqual(at('FT8 -12', 3573000), 'usb');
    assert.strictEqual(at('CQ FT4', 7047500), 'usb');
    // CW follows the sideband crossover.
    assert.strictEqual(at('CW 599', 7025000), 'cwl');
    assert.strictEqual(at('CW 599', 14025000), 'cwu');
});

t('a DX spot with no useful comment falls back to voice by band', () => {
    const at = (frequency) => modeForSpot(normaliseDX({ ...dxRaw, comment: 'up 5', frequency }));
    assert.strictEqual(at(3790000), 'lsb');
    assert.strictEqual(at(14195000), 'usb');
});

t('the comment match is case-insensitive', () => {
    assert.strictEqual(modeForSpot(normaliseDX({ ...dxRaw, comment: 'ft8 calling', frequency: 3573000 })), 'usb');
    assert.strictEqual(modeForSpot(normaliseDX({ ...dxRaw, comment: 'cw qrs', frequency: 7025000 })), 'cwl');
});

// --- list management -------------------------------------------------------

t('a replayed spot is not added twice', () => {
    // Every subscribe replays the server's buffer, and switching tabs
    // re-subscribes. Without a stable key the list would double each time.
    const s = normaliseCW(cwRaw);
    let list = addSpot([], s, 100);
    list = addSpot(list, normaliseCW(cwRaw), 100);
    assert.strictEqual(list.length, 1);
});

t('two spots for one callsign at different times are both kept', () => {
    const a = normaliseCW({ ...cwRaw, time: iso(0) });
    const b = normaliseCW({ ...cwRaw, time: iso(60000) });
    assert.notStrictEqual(spotKey(a), spotKey(b));
    assert.strictEqual(addSpot(addSpot([], a, 100), b, 100).length, 2);
});

t('the newest spot is first and the list is capped', () => {
    let list = [];
    for (let i = 0; i < 10; i += 1) {
        list = addSpot(list, normaliseCW({ ...cwRaw, time: iso(i * 1000) }), 5);
    }
    assert.strictEqual(list.length, 5);
    // The most recently added is at the head.
    assert.strictEqual(list[0].at, NOW - 9000);
});

t('v1’s list caps and default ages are carried over', () => {
    assert.deepStrictEqual(MAX_SPOTS, { dx: 500, digital: 5000, cw: 5000 });
    assert.deepStrictEqual(DEFAULT_AGE_MIN, { dx: 30, digital: 10, cw: 10 });
});

// --- filtering -------------------------------------------------------------

const mk = (over = {}) => normaliseCW({ ...cwRaw, ...over });
const F = (over) => ({ ...DEFAULT_FILTERS, ...over });

t('the age filter is in minutes and drops what is older', () => {
    const spots = [mk({ time: iso(60000) }), mk({ time: iso(20 * 60000), dx_call: 'K2XX' })];
    assert.strictEqual(filterSpots(spots, F({ age: 10 }), NOW).length, 1);
    assert.strictEqual(filterSpots(spots, F({ age: null }), NOW).length, 2);
});

t('band, country and callsign filters combine', () => {
    const spots = [
        mk({ dx_call: 'W1AW', band: '40m', country: 'United States' }),
        mk({ dx_call: 'G4ABC', band: '20m', country: 'England' }),
    ];
    assert.strictEqual(filterSpots(spots, F({ band: '40m' }), NOW).length, 1);
    assert.strictEqual(filterSpots(spots, F({ country: 'England' }), NOW).length, 1);
    assert.strictEqual(filterSpots(spots, F({ band: '40m', country: 'England' }), NOW).length, 0);
});

t('the callsign filter matches anywhere, and ignores case', () => {
    // v1 uses a substring match, so a partial prefix and a /P suffix both find
    // their spots.
    const spots = [mk({ dx_call: 'GM4ABC/P' })];
    assert.strictEqual(filterSpots(spots, F({ callsign: 'gm4' }), NOW).length, 1);
    assert.strictEqual(filterSpots(spots, F({ callsign: '4ABC' }), NOW).length, 1);
    assert.strictEqual(filterSpots(spots, F({ callsign: 'W1' }), NOW).length, 0);
});

t('a minimum drops rows that have no value for it at all', () => {
    // A spot with no SNR cannot satisfy "at least +10 dB"; keeping it would
    // make the filter look broken.
    const spots = [mk({ snr: 20 }), mk({ snr: null, dx_call: 'K2XX' })];
    assert.strictEqual(filterSpots(spots, F({ minSnr: 10 }), NOW).length, 1);
});

t('WPM and distance minimums work the same way', () => {
    const spots = [mk({ wpm: 30, distance_km: 9000 }), mk({ wpm: 12, distance_km: 200, dx_call: 'K2XX' })];
    assert.strictEqual(filterSpots(spots, F({ minWpm: 20 }), NOW).length, 1);
    assert.strictEqual(filterSpots(spots, F({ minDistance: 1000 }), NOW).length, 1);
});

t('10m beacons are hidden by default and shown on request', () => {
    // v1's default: the skimmer hears a great many of these and they drown the
    // list otherwise.
    const spots = [mk({ frequency: TEN_M_BEACON_HZ + 1000, band: '10m' })];
    assert.strictEqual(filterSpots(spots, F({}), NOW).length, 0);
    assert.strictEqual(filterSpots(spots, F({ tenMeterBeacons: true }), NOW).length, 1);
});

t('the beacon rule applies only to CW spots', () => {
    // A DX or digital spot up at 28.2 MHz is an ordinary spot.
    const dx = normaliseDX({ ...dxRaw, frequency: TEN_M_BEACON_HZ + 1000, band: '10m' });
    assert.strictEqual(filterSpots([dx], F({}), NOW).length, 1);
});

t('the digital mode filter matches the feed’s own mode names', () => {
    const spots = [
        normaliseDigital({ ...digitalRaw, mode: 'FT8' }),
        normaliseDigital({ ...digitalRaw, mode: 'WSPR', callsign: 'K2XX' }),
    ];
    assert.strictEqual(filterSpots(spots, F({ mode: 'WSPR' }), NOW).length, 1);
    assert.strictEqual(filterSpots(spots, F({ mode: 'all' }), NOW).length, 2);
});

t('the country list is built from the spots actually held', () => {
    const spots = [mk({ country: 'Japan' }), mk({ country: 'Chile' }), mk({ country: 'Japan' }), mk({ country: '' })];
    assert.deepStrictEqual(countriesIn(spots), ['Chile', 'Japan']);
});

// --- spectrum markers -------------------------------------------------------

const win = { startFreq: 7000000, endFreq: 7200000, now: NOW };

t('markers only cover the visible span', () => {
    const spots = [
        mk({ frequency: 7100000 }),
        mk({ frequency: 14100000, dx_call: 'K2XX' }),
    ];
    const out = markerSpots({ spots, kind: 'cw', ...win });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].frequency, 7100000);
});

t('markers drop spots older than their window', () => {
    const fresh = mk({ frequency: 7100000, time: iso(60000) });
    const stale = mk({ frequency: 7110000, time: iso((MARKER_AGE_MIN.cw + 5) * 60000), dx_call: 'K2XX' });
    const out = markerSpots({ spots: [fresh, stale], kind: 'cw', ...win });
    assert.deepStrictEqual(out.map((s) => s.callsign), ['W1AW']);
});

t('the two feeds have their own marker windows', () => {
    // The DX cluster is slow and its spots stay useful for longer than the
    // skimmer's, which is why v1 defaults them differently.
    assert.strictEqual(MARKER_AGE_MIN.dx, DEFAULT_AGE_MIN.dx);
    assert.strictEqual(MARKER_AGE_MIN.cw, DEFAULT_AGE_MIN.cw);
    assert.ok(MARKER_AGE_MIN.dx > MARKER_AGE_MIN.cw);
});

t('a station re-spotted on the same frequency yields one marker', () => {
    // The skimmer re-spots the same station every few minutes. Without this the
    // bar becomes a stack of identical pills on one pixel.
    const spots = [
        mk({ frequency: 7100000, time: iso(0) }),
        mk({ frequency: 7100030, time: iso(120000) }),
        mk({ frequency: 7099980, time: iso(240000) }),
    ];
    const out = markerSpots({ spots, kind: 'cw', ...win });
    assert.strictEqual(out.length, 1);
});

t('and the marker kept is the newest of them', () => {
    // The age on the pill has to mean something.
    const spots = [
        mk({ frequency: 7100000, time: iso(240000) }),
        mk({ frequency: 7100030, time: iso(1000) }),
    ];
    const [only] = markerSpots({ spots, kind: 'cw', ...win });
    assert.strictEqual(only.at, NOW - 1000);
});

t('two stations far enough apart both keep their markers', () => {
    const spots = [mk({ frequency: 7100000 }), mk({ frequency: 7105000, dx_call: 'K2XX' })];
    assert.strictEqual(markerSpots({ spots, kind: 'cw', ...win }).length, 2);
});

t('markers come back in frequency order, ready to lay out', () => {
    const spots = [
        mk({ frequency: 7150000 }),
        mk({ frequency: 7010000, dx_call: 'K2XX' }),
        mk({ frequency: 7080000, dx_call: 'G4ABC' }),
    ];
    const out = markerSpots({ spots, kind: 'cw', ...win });
    assert.deepStrictEqual(out.map((s) => s.frequency), [7010000, 7080000, 7150000]);
});

// --- age column -------------------------------------------------------------

t('ages read in seconds, minutes then hours', () => {
    assert.strictEqual(ageLabel(NOW - 45000, NOW), '45s');
    assert.strictEqual(ageLabel(NOW - 3 * 60000, NOW), '3m');
    assert.strictEqual(ageLabel(NOW - 2 * 3600000, NOW), '2h');
});

t('a spot from the future reads as zero, not a negative age', () => {
    // Clock skew between the server and the browser is normal.
    assert.strictEqual(ageLabel(NOW + 5000, NOW), '0s');
});

// --- the band filter following the dial ------------------------------------------
//
// Default, because what a spot list is usually being asked is "who can be heard where I
// am listening" — a 20m spot while you are on 40m is a fact about somebody else's
// afternoon. The spectrogram panel made the same choice; this is the same idea in a
// filter.

t('the band filter follows the dial by default', () => {
    assert.strictEqual(DEFAULT_FILTERS.band, AUTO_BAND);
});

t('auto resolves to the band the dial is in', () => {
    assert.strictEqual(resolveBandFilter(AUTO_BAND, '20m'), '20m');
});

t('auto outside every band is all bands, not an empty list', () => {
    // A listener parked on 6 MHz would otherwise see nothing and no clue why, and "no
    // band" is not a band anybody has spots for.
    assert.strictEqual(resolveBandFilter(AUTO_BAND, null), 'all');
    assert.strictEqual(resolveBandFilter(AUTO_BAND, ''), 'all');
});

t('a chosen band is not overridden by where the dial is', () => {
    // Pinning a band is how you watch one you are not listening to.
    assert.strictEqual(resolveBandFilter('40m', '20m'), '40m');
    assert.strictEqual(resolveBandFilter('all', '20m'), 'all');
});

t('filtering on auto keeps the dial\'s band and drops the rest', () => {
    const spots = [
        mk({ dx_call: 'W1AW', band: '20m' }),
        mk({ dx_call: 'G4ABC', band: '40m' }),
    ];
    const on20 = filterSpots(spots, F({ band: AUTO_BAND }), NOW, '20m');
    assert.deepStrictEqual(on20.map((x) => x.callsign), ['W1AW']);
    const on40 = filterSpots(spots, F({ band: AUTO_BAND }), NOW, '40m');
    assert.deepStrictEqual(on40.map((x) => x.callsign), ['G4ABC']);
});

t('a caller with no dial to consult gets everything, not nothing', () => {
    // filterSpots is called from places with no receiver in scope; auto there has to mean
    // "no band filter" rather than silently matching none.
    const spots = [mk({ dx_call: 'W1AW', band: '20m' }), mk({ dx_call: 'G4ABC', band: '40m' })];
    assert.strictEqual(filterSpots(spots, F({ band: AUTO_BAND }), NOW).length, 2);
});

console.log(`\nall ${pass} spots tests passed`);

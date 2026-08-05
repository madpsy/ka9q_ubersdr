// The DX cluster addon's feed: which spots are shown, and where they tune to.
//
// Four streams arrive on one channel and they do not carry the same fields, so
// most of what can go wrong here is a filter excluding spots that simply never
// had the field it was filtering on.

const assert = require('assert');
const {
    ALL_MODES, DEFAULT_FILTERS, STREAMS, STREAM_MODES, bandsIn, callPrefixes,
    continentsIn, countriesIn, dialFreq, dxClusterAvailable, modeOf, spotKey,
    spotMatches, streamMeta, streamOf,
} = require('./.build/dxaddon.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const dx = (o = {}) => ({ stream: 'dxcluster', callsign: 'DL1ABC', freq_hz: 14074000, band: '20m', country: 'Germany', country_code: 'DE', continent: 'EU', timestamp: '2026-08-05T12:00:00Z', spotter: 'G0ABC', ...o });
const ft8 = (o = {}) => ({ stream: 'decoder', callsign: 'EA1XYZ', freq_hz: 14075300, est_dial_freq: 14074000, band: '20m', mode: 'FT8', snr: -12, country_code: 'ES', country: 'Spain', continent: 'EU', timestamp: '2026-08-05T12:00:30Z', ...o });
const cw = (o = {}) => ({ stream: 'cwskimmer', callsign: 'F5ABC', freq_hz: 7020000, band: '40m', wpm: 24, snr: 9, country_code: 'FR', continent: 'EU', timestamp: '2026-08-05T12:01:00Z', ...o });
const voice = (o = {}) => ({ stream: 'voice', callsign: 'GM4ABC', freq_hz: 3760000, band: '80m', voice_mode: 'LSB', country_code: 'GB', continent: 'EU', timestamp: '2026-08-05T12:02:00Z', ...o });

// --- availability ------------------------------------------------------------

t('the panel exists only where the addon does', () => {
    // The addon, not the receiver's own cluster connection: `dx_cluster` is a
    // different feature and having it says nothing about this one.
    assert.strictEqual(dxClusterAvailable({ addons: ['sstv', 'dxcluster'] }), true);
    assert.strictEqual(dxClusterAvailable({ addons: ['sstv'] }), false);
    assert.strictEqual(dxClusterAvailable({ dx_cluster: true }), false);
    assert.strictEqual(dxClusterAvailable(null), false);
});

// --- streams -----------------------------------------------------------------

t('a user-submitted spot is a DX spot', () => {
    // `localspot` is the same thing arriving from a telnet login rather than
    // from the network, and splitting the column in two would say nothing.
    assert.strictEqual(streamOf({ stream: 'localspot' }), 'dxcluster');
    assert.strictEqual(streamMeta(streamOf({ stream: 'localspot' })).label, 'DX');
});

t('an unknown stream still renders as something', () => {
    assert.strictEqual(streamMeta('newthing').label, 'newthing');
    assert.strictEqual(streamMeta(undefined).label, '—');
});

t('the mode comes from where each stream actually puts it', () => {
    // The skimmer does not label its decodes and voice activity carries the
    // sideband in its own field.
    assert.strictEqual(modeOf(cw()), 'CW');
    assert.strictEqual(modeOf(voice()), 'LSB');
    assert.strictEqual(modeOf(ft8()), 'FT8');
    assert.strictEqual(modeOf(dx()), '');
});

// --- tuning ------------------------------------------------------------------

t('a digital decode tunes to the dial, not to the tone', () => {
    // FT8's freq_hz is a tone inside the passband; tuning there puts the dial a
    // kilohertz or two off and the decode outside the filter.
    assert.strictEqual(dialFreq(ft8()), 14074000);
    assert.strictEqual(dialFreq(dx()), 14074000);
});

t('a spot with nothing tuneable says so rather than tuning to zero', () => {
    assert.strictEqual(dialFreq({}), null);
    assert.strictEqual(dialFreq({ freq_hz: 0 }), null);
});

t('spots are identified by more than their callsign', () => {
    // The same station spotted twice a minute apart is two spots; the same spot
    // arriving in history and again live is one.
    assert.strictEqual(spotKey(dx()), spotKey(dx()));
    assert.notStrictEqual(spotKey(dx()), spotKey(dx({ timestamp: '2026-08-05T12:05:00Z' })));
    assert.notStrictEqual(spotKey(dx()), spotKey(dx({ spotter: 'M0XYZ' })));
});

// --- filtering ---------------------------------------------------------------

t('everything passes the default filters', () => {
    for (const s of [dx(), ft8(), cw(), voice()]) {
        assert.ok(spotMatches(s, DEFAULT_FILTERS), JSON.stringify(s.stream));
    }
});

t('a stream can be switched off', () => {
    const f = { ...DEFAULT_FILTERS, streams: ['dxcluster'] };
    assert.strictEqual(spotMatches(dx(), f), true);
    assert.strictEqual(spotMatches(ft8(), f), false);
});

t('a mode filter does not exclude the stream that has no modes', () => {
    // The failure this prevents: unticking FT8 emptied the DX column too,
    // because a cluster spot has no mode and so matched nothing.
    const f = { ...DEFAULT_FILTERS, modes: ['CW'] };
    assert.strictEqual(spotMatches(dx(), f), true, 'a cluster spot has no mode to fail');
    assert.strictEqual(spotMatches(cw(), f), true);
    assert.strictEqual(spotMatches(ft8(), f), false);
});

t('band, continent and country filters are empty-means-all', () => {
    assert.ok(spotMatches(dx(), { ...DEFAULT_FILTERS, bands: [] }));
    assert.ok(spotMatches(dx(), { ...DEFAULT_FILTERS, bands: ['20M'] }), 'case insensitive');
    assert.ok(!spotMatches(dx(), { ...DEFAULT_FILTERS, bands: ['40m'] }));
    assert.ok(spotMatches(dx(), { ...DEFAULT_FILTERS, continents: ['eu'] }));
    assert.ok(!spotMatches(dx(), { ...DEFAULT_FILTERS, continents: ['NA'] }));
    assert.ok(spotMatches(dx(), { ...DEFAULT_FILTERS, countries: ['DE'] }));
    assert.ok(!spotMatches(dx(), { ...DEFAULT_FILTERS, countries: ['FR'] }));
});

t('a spot missing a field is not excluded by a filter on it', () => {
    // Half these streams do not carry a continent or a country.
    const bare = { stream: 'cwskimmer', callsign: 'F5ABC', freq_hz: 7020000 };
    assert.ok(spotMatches(bare, { ...DEFAULT_FILTERS, continents: ['EU'], countries: ['FR'], bands: ['40m'] }));
});

t('the callsign box takes one prefix or several', () => {
    assert.deepStrictEqual(callPrefixes('g, ea vk3'), ['G', 'EA', 'VK3']);
    assert.deepStrictEqual(callPrefixes('  '), []);
    assert.ok(spotMatches(dx(), { ...DEFAULT_FILTERS, call: 'DL' }));
    assert.ok(spotMatches(dx(), { ...DEFAULT_FILTERS, call: 'G, DL' }));
    assert.ok(!spotMatches(dx(), { ...DEFAULT_FILTERS, call: 'G' }));
});

t('SNR bounds only apply to spots that report one', () => {
    assert.ok(spotMatches(ft8(), { ...DEFAULT_FILTERS, snrMin: -20 }));
    assert.ok(!spotMatches(ft8(), { ...DEFAULT_FILTERS, snrMin: -5 }));
    assert.ok(!spotMatches(cw(), { ...DEFAULT_FILTERS, snrMax: 5 }));
    assert.ok(spotMatches(dx(), { ...DEFAULT_FILTERS, snrMin: 30, snrMax: 40 }),
        'a cluster spot has no SNR to fail');
});

// --- the option lists --------------------------------------------------------

t('bands are offered in frequency order, not alphabetical', () => {
    // "10m, 15m, 20m, 40m, 80m" sorted as text is not a band plan.
    const bands = bandsIn([voice(), dx(), cw()]);
    assert.deepStrictEqual(bands, ['80m', '40m', '20m']);
});

t('countries are offered by name, once each', () => {
    const list = countriesIn([dx(), dx(), ft8()]);
    assert.deepStrictEqual(list, [{ code: 'DE', name: 'Germany' }, { code: 'ES', name: 'Spain' }]);
});

t('continents come out sorted and deduplicated', () => {
    assert.deepStrictEqual(continentsIn([dx(), cw(), { continent: 'NA' }, {}]), ['EU', 'NA']);
});

t('every stream the addon publishes has a label', () => {
    assert.deepStrictEqual(STREAMS.map((s) => s.id).sort(), Object.keys(STREAM_MODES).sort());
    for (const s of STREAMS) assert.ok(s.label && s.tone, s.id);
});

t('the mode list is every mode any stream can report', () => {
    for (const modes of Object.values(STREAM_MODES)) {
        for (const m of modes) assert.ok(ALL_MODES.includes(m), m);
    }
});

console.log(`\n${pass} ok`);

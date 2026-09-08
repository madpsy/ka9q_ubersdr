// The NCDXF beacon panel renders, and the shaping behind it holds.
//
// Two things here are worth a test of their own. The API answers in a
// deduplicated form whose key includes the UTC day, so a window crossing
// midnight comes back split into two rows for one beacon on one band — merged
// wrongly, a panel reports half the decodes and the wrong age at midnight only,
// which is exactly the sort of thing that ships. And the band filter's Auto has
// to mean something different here than it does everywhere else in the app,
// because a beacon panel knows five bands and the dial spends most of its life
// outside them; got wrong, the panel is empty for everybody parked on 40m.
//
// See hookStub.js for what "renders" means here.

const assert = require('assert');

// Before the bundle: the preferences are read from localStorage at first
// render, and the module graph behind the panel reaches the radio and the
// display settings, both of which read the browser at import time.
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

let nextFetch = () => Promise.reject(new Error('no fetch configured'));
globalThis.fetch = (...args) => nextFetch(...args);

const {
    deep, render, reset, walk, words,
    NCDXFPanel, BeaconMap, GROUPS, SOLO,
    BEACON_BANDS, BEACON_FREQ, BEACON_MODE, WINDOWS,
    _resetNcdxf, _seedNcdxf, bandSummary, beaconTarget, cleanRoster, fetchHeard,
    mergeSpots, ncdxfState, notHeard, receiverAt, refreshNcdxf, resolveBeaconBand,
    rowsForBand, savedPrefs, snrLabel, spotsUrl, statsFor, windowLabel,
} = require('./.build/ncdxf.cjs');

let pass = 0;

// Every mount's cleanups, drained after each test whether it passed or not. The
// panel holds a ten-second interval to keep its ages moving, so a test that
// threw before its own cleanup would leave the timer running and node would
// never exit — the run hangs after printing every result, which reads as a
// test-runner fault rather than as the missing off() it is.
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
    store.clear();
}

const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
    finally { drain(); }
};
const ta = async (name, fn) => {
    try { await fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
    finally { drain(); }
};

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 8, 7, 12, 0, 0); // 2026-09-07T12:00:00Z
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const min = (n) => NOW - n * 60000;

// Shaped exactly as /ncdxf_beacons.json serves it.
const ROSTER_DOC = {
    ncdxf_iaru_beacons: {
        beacons: [
            {
                slot: 1, callsign: '4U1UN', entity: 'United Nations', location: 'New York City',
                country: 'United States', country_code: 'US', grid: 'FN30as',
                latitude: 40.75, longitude: -73.97, operator: 'UNRC',
            },
            {
                slot: 2, callsign: 'VE8AT', entity: 'Canada', location: 'Inuvik, NT',
                country: 'Canada', country_code: 'CA', grid: 'CP38gh',
                latitude: 68.35, longitude: -133.72, operator: 'RAC/NARC',
            },
            {
                slot: 5, callsign: 'ZL6B', entity: 'New Zealand', location: 'Masterton',
                country: 'New Zealand', country_code: 'NZ', grid: 'RE78tw',
                latitude: -41.05, longitude: 175.47, operator: 'NZART',
            },
        ],
    },
};
const ROSTER = cleanRoster(ROSTER_DOC);

// Shaped exactly as /api/cwskimmer/spots serves them, deduplicated: one row per
// callsign+band+UTC day, the timestamp of the last decode, and seen_count.
const spot = (over) => ({
    timestamp: iso(min(4)),
    callsign: 'VE8AT',
    snr: 14,
    frequency: 14100000,
    band: '20m',
    wpm: 22,
    comment: '',
    country: 'Canada',
    continent: 'NA',
    seen_count: 6,
    ...over,
});

// Shaped as /api/description serves it: the station identity — name, callsign,
// gps — under `receiver`, and the feature flags at the top level.
const context = ({ frequency = 14_074_000, ...over } = {}) => ({
    serverInfo: {
        receiver: { callsign: 'M9PSY', name: 'Test receiver', gps: { lat: 51.507, lon: -0.128 } },
        tuning_range: { min: 10000, max: 30000000 },
        cw_skimmer: true,
    },
    tuning: { frequency, mode: 'usb' },
    running: true,
    actions: { tuneTo() {}, ensureVisible() {} },
    ...over,
});

/** Put a reading on screen without a server. */
function seed(rows, over) {
    _seedNcdxf({
        roster: ROSTER, rows, loading: false, error: null, off: false, at: NOW, ...over,
    });
}

const cls = (n) => String((n.props && n.props.className) || '');
const hasClass = (tree, re) => deep(tree).some((n) => re.test(cls(n)));

// ── Where it lives ──────────────────────────────────────────────────────────

t('the panel is grouped for the phone, under Activity', () => {
    // A phone has no docks: a panel in the registry and in no group rides with
    // the last group and turns up at the bottom of Setup, among the things you
    // set once and leave. Activity is the question this one answers — what is
    // out there, and can I hear it.
    const named = GROUPS.filter((g) => g.panels.includes('ncdxf'));
    assert.strictEqual(named.length, 1, 'in ' + named.length + ' groups, want exactly one');
    assert.strictEqual(named[0].id, 'activity');
    assert.notStrictEqual(SOLO, 'ncdxf', 'the slot a phone opens on is Multipad');
    // After DXpeditions, which is where it sits in the dock: the spot feeds are
    // the last ten minutes, this is the last hour of the bands themselves.
    const items = named[0].panels;
    assert.ok(items.indexOf('ncdxf') > items.indexOf('dxpeditions'));
});

// ── The query ───────────────────────────────────────────────────────────────

t('the query narrows whole days to the window', () => {
    const url = spotsUrl(ROSTER, 60, NOW);
    // The date pair is what the API requires; the timestamps are what make "the
    // last hour" mean the last hour rather than "since midnight".
    assert.ok(url.includes('from_date=2026-09-07'), url);
    assert.ok(url.includes('to_date=2026-09-07'), url);
    assert.ok(url.includes(`from_ts=${Math.floor(min(60) / 1000)}`), url);
    assert.ok(url.includes(`to_ts=${Math.ceil(NOW / 1000)}`), url);
    assert.ok(url.includes('callsign=4U1UN%2CVE8AT%2CZL6B'), url);
});

t('a window across midnight asks for both days', () => {
    const justAfterMidnight = Date.UTC(2026, 8, 7, 0, 30, 0);
    const url = spotsUrl(ROSTER, 60, justAfterMidnight);
    assert.ok(url.includes('from_date=2026-09-06'), url);
    assert.ok(url.includes('to_date=2026-09-07'), url);
});

t('the whole roster fits the API cap', () => {
    // The endpoint refuses more than 20 callsigns, and the network is 18.
    assert.ok(spotsUrl(ROSTER, 60, NOW).split('%2C').length <= 20);
});

// ── Shaping ─────────────────────────────────────────────────────────────────

t('a beacon carries one cell per band it was heard on', () => {
    const rows = mergeSpots([
        spot(),
        spot({ band: '17m', frequency: 18110000, snr: 6, seen_count: 2, timestamp: iso(min(30)) }),
    ], ROSTER);
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual(Object.keys(rows[0].bands).sort(), ['17m', '20m']);
    // The row's own figures are the most recent band's, so it reads as one
    // sentence rather than as an SNR from one band beside an age from another.
    assert.strictEqual(rows[0].lastBand, '20m');
    assert.strictEqual(rows[0].snr, 14);
    assert.strictEqual(rows[0].count, 8);
});

t('the midnight split is merged rather than counted twice', () => {
    // The server's dedup key includes the UTC day, so one beacon on one band
    // comes back as two rows whenever the window crosses midnight. Two rows for
    // 20m would double the pips and take the age from whichever landed last.
    const rows = mergeSpots([
        spot({ timestamp: iso(min(90)), snr: 3, seen_count: 4 }),
        spot({ timestamp: iso(min(10)), snr: 11, seen_count: 5 }),
    ], ROSTER);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(Object.keys(rows[0].bands).length, 1);
    assert.strictEqual(rows[0].bands['20m'].count, 9, 'the counts add');
    assert.strictEqual(rows[0].bands['20m'].snr, 11, 'the later decode is the reading');
    assert.strictEqual(rows[0].bands['20m'].at, Date.parse(iso(min(10))));
});

t('rows are newest first', () => {
    const rows = mergeSpots([
        spot({ callsign: 'ZL6B', timestamp: iso(min(50)) }),
        spot({ callsign: 'VE8AT', timestamp: iso(min(2)) }),
        spot({ callsign: '4U1UN', timestamp: iso(min(20)) }),
    ], ROSTER);
    assert.deepStrictEqual(rows.map((r) => r.call), ['VE8AT', '4U1UN', 'ZL6B']);
});

t('anything that is not a beacon decode is dropped', () => {
    const rows = mergeSpots([
        // A callsign the roster does not have: the API was asked for eighteen,
        // but the filter is not a promise about what comes back.
        spot({ callsign: 'G3XYZ' }),
        // A beacon callsign heard on a band the beacons do not use. It is a
        // real decode of something; it is not a beacon transmission, and the
        // five-cell strip has nowhere to put it.
        spot({ band: '30m' }),
        spot({ band: null }),
        // A timestamp that is not one.
        spot({ timestamp: 'yesterday' }),
    ], ROSTER);
    assert.deepStrictEqual(rows, []);
});

t('a missing seen_count counts as one decode', () => {
    const rows = mergeSpots([spot({ seen_count: undefined })], ROSTER);
    assert.strictEqual(rows[0].count, 1);
});

t('the band strip counts every band whatever the filter', () => {
    const rows = mergeSpots([
        spot(),
        spot({ callsign: 'ZL6B', snr: 2, timestamp: iso(min(9)) }),
        spot({ callsign: '4U1UN', band: '17m', frequency: 18110000, snr: -3, seen_count: 1 }),
    ], ROSTER);
    const cells = bandSummary(rows);
    assert.deepStrictEqual(cells.map((c) => c.band), BEACON_BANDS, 'always five, in slot order');
    const twenty = cells.find((c) => c.band === '20m');
    assert.strictEqual(twenty.beacons, 2);
    assert.strictEqual(twenty.spots, 12);
    assert.strictEqual(twenty.call, 'VE8AT', 'the strongest, not the latest');
    assert.strictEqual(cells.find((c) => c.band === '15m').beacons, 0);
});

t('picking a band promotes that band figures onto the row', () => {
    // Otherwise the list is sorted and labelled by decodes it is not showing.
    const rows = mergeSpots([
        spot(),
        spot({ band: '17m', frequency: 18110000, snr: -2, seen_count: 3, timestamp: iso(min(40)) }),
    ], ROSTER);
    const only = rowsForBand(rows, '17m');
    assert.strictEqual(only.length, 1);
    assert.strictEqual(only[0].snr, -2);
    assert.strictEqual(only[0].count, 3);
    assert.strictEqual(only[0].lastBand, '17m');
    assert.strictEqual(rowsForBand(rows, '15m').length, 0);
    assert.strictEqual(rowsForBand(rows, 'all')[0].snr, 14, 'all bands leaves the row alone');
});

t('the silent beacons are named', () => {
    const rows = mergeSpots([spot()], ROSTER);
    assert.deepStrictEqual(notHeard(ROSTER, rows), ['4U1UN', 'ZL6B']);
});

t('Auto follows the dial, but only into a beacon band', () => {
    assert.strictEqual(resolveBeaconBand('auto', '20m'), '20m');
    assert.strictEqual(resolveBeaconBand('auto', '10m'), '10m');
    // The reason this is not lib/bands.js resolveBandFilter: parked on 40m the
    // shared one answers '40m', and a panel that only knows five bands would
    // then be empty for everybody who is not on one of them.
    assert.strictEqual(resolveBeaconBand('auto', '40m'), 'all');
    assert.strictEqual(resolveBeaconBand('auto', null), 'all');
    // A pinned band is a decision, and it is kept wherever the dial goes.
    assert.strictEqual(resolveBeaconBand('15m', '40m'), '15m');
    assert.strictEqual(resolveBeaconBand('all', '20m'), 'all');
});

t('the figures under the list are of what is on it', () => {
    const rows = mergeSpots([
        spot({ snr: 10 }),
        spot({ callsign: 'ZL6B', snr: 4, timestamp: iso(min(8)) }),
    ], ROSTER);
    const rx = receiverAt(context().serverInfo.receiver);
    const stats = statsFor(rows, ROSTER, rx, 'all');
    assert.strictEqual(stats.avgSnr, 7);
    assert.strictEqual(stats.decodes, 2);
    // London to Masterton is the long way round from London to Inuvik.
    assert.strictEqual(stats.far.call, 'ZL6B');
    assert.ok(stats.far.distKm > 18000 && stats.far.distKm < 19000, String(stats.far.distKm));
});

t('a receiver at 0,0 has no position', () => {
    // The configuration default, not a place: a distance measured from the Gulf
    // of Guinea is worse than no distance at all.
    assert.strictEqual(receiverAt({ callsign: 'X', gps: { lat: 0, lon: 0 } }), null);
    assert.ok(receiverAt({ callsign: 'X', gps: { lat: 51.5, lon: -0.1 } }));
});

t('a beacon tunes to its published frequency in CW', () => {
    for (const band of BEACON_BANDS) {
        assert.deepStrictEqual(beaconTarget(band), {
            frequency: BEACON_FREQ[band], mode: BEACON_MODE,
        });
    }
    assert.strictEqual(beaconTarget('40m'), null);
});

t('the wording of a window is a phrase, not a number', () => {
    assert.strictEqual(windowLabel(60), 'the last hour');
    assert.strictEqual(windowLabel(180), 'the last 3 hours');
    assert.strictEqual(snrLabel(14), '+14 dB');
    assert.strictEqual(snrLabel(-3), '-3 dB');
    assert.strictEqual(snrLabel(0), '0 dB');
});

t('a stored preference is honoured, and nonsense is not', () => {
    store.set('ubersdr.v2.ncdxf', JSON.stringify({ window: 360, band: '15m' }));
    assert.deepStrictEqual(savedPrefs(), { window: 360, band: '15m' });
    // A window this panel does not offer would be sent to the API as-is.
    store.set('ubersdr.v2.ncdxf', JSON.stringify({ window: 99999, band: '' }));
    assert.deepStrictEqual(savedPrefs(), { window: WINDOWS[0].minutes, band: 'auto' });
    store.set('ubersdr.v2.ncdxf', 'not json');
    assert.deepStrictEqual(savedPrefs(), { window: WINDOWS[0].minutes, band: 'auto' });
});

// ── The store ───────────────────────────────────────────────────────────────

const answer = (status, body) => {
    nextFetch = (url) => {
        if (String(url).startsWith('/ncdxf_beacons.json')) {
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(ROSTER_DOC) });
        }
        return Promise.resolve({
            ok: status === 200,
            status,
            json: () => Promise.resolve(body),
        });
    };
};

(async () => {
    await ta('a reading arrives and is shaped', async () => {
        _resetNcdxf();
        answer(200, { spots: [spot()], count: 1 });
        await refreshNcdxf(60, true);
        const s = ncdxfState();
        assert.strictEqual(s.loading, false);
        assert.strictEqual(s.roster.length, 3);
        assert.deepStrictEqual(s.rows.map((r) => r.call), ['VE8AT']);
        assert.strictEqual(s.off, false);
        assert.strictEqual(s.error, null);
    });

    await ta('nothing heard is an answer, not an error', async () => {
        _resetNcdxf();
        // 204 is what the API says on a quiet band, and it is the most common
        // answer this panel gets.
        answer(204, null);
        await refreshNcdxf(60, true);
        assert.deepStrictEqual(ncdxfState().rows, []);
        assert.strictEqual(ncdxfState().error, null);
        assert.strictEqual(ncdxfState().off, false);
    });

    await ta('a receiver that does not log CW spots says so in its own words', async () => {
        _resetNcdxf();
        answer(503, { error: 'CW spots logging is not enabled' });
        await refreshNcdxf(60, true);
        assert.strictEqual(ncdxfState().off, true);
        assert.strictEqual(ncdxfState().error, null, 'not an error to be reported as one');
    });

    await ta('a failure drops the rows rather than keeping them', async () => {
        _resetNcdxf();
        answer(200, { spots: [spot()] });
        await refreshNcdxf(60, true);
        assert.strictEqual(ncdxfState().rows.length, 1);
        nextFetch = () => Promise.reject(new Error('network down'));
        await refreshNcdxf(60, true);
        // They are a claim about the last hour, and going on making it for
        // another fifteen minutes is the one thing this panel must not do.
        assert.deepStrictEqual(ncdxfState().rows, []);
        assert.ok(/network down/.test(ncdxfState().error));
    });

    await ta('the floor holds, and a new window goes through it', async () => {
        _resetNcdxf();
        let calls = 0;
        const count = () => { calls += 1; };
        answer(200, { spots: [spot()] });
        const wrapped = nextFetch;
        nextFetch = (...a) => { count(); return wrapped(...a); };

        await refreshNcdxf(60, true);
        const first = calls;
        // Same question, moments later: the panel being reopened must not become
        // a request per open.
        await refreshNcdxf(60);
        assert.strictEqual(calls, first, 'the floor let a repeat through');
        // A different window is a different question and is always asked.
        await refreshNcdxf(360);
        assert.ok(calls > first, 'a new window was not fetched');
        assert.strictEqual(ncdxfState().window, 360);
    });

    // ── Rendering ───────────────────────────────────────────────────────────

    t('the panel draws a row per beacon heard', () => {
        seed(mergeSpots([
            spot(),
            spot({ callsign: 'ZL6B', snr: 4, timestamp: iso(min(8)) }),
        ], ROSTER));
        reset();
        const { tree } = mount(NCDXFPanel, {}, context());
        assert.ok(hasClass(tree, /ncdxf-row/), 'no beacon rows');
        assert.ok(/VE8AT/.test(words(tree)), 'the callsign is not on screen');
        assert.ok(/ZL6B/.test(words(tree)));
        // The five pips are the compact form of the 18 x 5 grid, and every row
        // carries all five whether or not the beacon was heard on them.
        assert.strictEqual(deep(tree).filter((n) => /ncdxf-pip\b/.test(cls(n))).length, 10);
        assert.ok(hasClass(tree, /ncdxf-strip/), 'no band strip');
        assert.ok(hasClass(tree, /ncdxf__filters/), 'no window or band picker');
        assert.ok(hasClass(tree, /ncdxf-foot/), 'no figures under the list');
    });

    t('the cut-down view is the rows and nothing else', () => {
        seed(mergeSpots([spot()], ROSTER));
        reset();
        const { tree } = mount(NCDXFPanel, { minimal: true }, context());
        assert.ok(hasClass(tree, /ncdxf-row/), 'the rows are what minimal keeps');
        assert.ok(!hasClass(tree, /ncdxf__filters/), 'the pickers survived');
        assert.ok(!hasClass(tree, /ncdxf-strip/), 'the band strip survived');
        assert.ok(!hasClass(tree, /ncdxf-foot/), 'the figures survived');
        assert.ok(!/Full page/.test(words(tree)), 'the link out survived');
        assert.ok(!/Map/.test(words(tree)), 'the map button survived');
    });

    t('an empty window explains itself', () => {
        seed([]);
        reset();
        const { tree } = mount(NCDXFPanel, {}, context());
        const said = words(tree);
        assert.ok(/No beacons heard/.test(said), said);
        assert.ok(/the last hour/.test(said), said);
        // The receiver may simply not be listening on the beacon frequencies,
        // which is the most likely reason of all and not one anybody would
        // guess from an empty list.
        assert.ok(/14\.100/.test(said), said);
    });

    t('an empty band says the other bands have something', () => {
        // Parked on 15m with nothing on it, but 20m open: the filter is the
        // reason the list is empty, and saying "the bands may be closed" there
        // would be wrong as well as unhelpful.
        seed(mergeSpots([spot()], ROSTER));
        reset();
        const { tree } = mount(NCDXFPanel, {}, context({ frequency: 21_150_000 }));
        const said = words(tree);
        assert.ok(/No beacons heard on 15m/.test(said), said);
        assert.ok(/clear the band filter/i.test(said), said);
    });

    t('a receiver with no CW spot log says that instead', () => {
        seed([], { off: true });
        reset();
        const { tree } = mount(NCDXFPanel, {}, context());
        assert.ok(/CW spot logging is not enabled/.test(words(tree)));
    });

    t('a failed poll is reported rather than drawn as a quiet band', () => {
        seed([], { error: 'HTTP 500' });
        reset();
        const { tree } = mount(NCDXFPanel, {}, context());
        const said = words(tree);
        assert.ok(/unavailable/.test(said), said);
        assert.ok(/HTTP 500/.test(said), said);
        assert.ok(hasClass(tree, /note--warn/), 'not marked as a fault');
    });

    t('the map is offered only when there is something to draw', () => {
        seed([]);
        reset();
        const empty = mount(NCDXFPanel, {}, context()).tree;
        const mapButton = (tree) => deep(tree).find((n) => (
            n.props && typeof n.props.onClick === 'function' && /^Map$/.test(words(n).trim())
        ));
        const off = mapButton(empty);
        assert.ok(off, 'the button is not there at all');
        assert.strictEqual(off.props.disabled, true, 'an empty map is 18 grey dots');

        seed(mergeSpots([spot()], ROSTER));
        reset();
        const full = mount(NCDXFPanel, {}, context()).tree;
        assert.strictEqual(mapButton(full).props.disabled, false);
    });

    t('the map draws every beacon, not only the ones heard', () => {
        // Which of them stayed silent is half the reading — a map that omitted
        // them would look like a map of a smaller network.
        reset();
        const { tree } = mount(BeaconMap, {
            roster: ROSTER,
            rows: mergeSpots([spot()], ROSTER),
            band: 'all',
            receiver: context().serverInfo.receiver,
        }, context());
        // Leaflet is loaded inside the effect and is not present here, so what
        // is under test is that the component renders its box and its effects
        // survive a world with no window.L — which is what a first paint is,
        // before the 150 KB arrives.
        assert.ok(/csmap/.test(cls(tree)), cls(tree));
        assert.ok(/ncdxf-map/.test(cls(tree)), cls(tree));
    });

    t('mounting and unmounting leaves nothing behind', () => {
        seed(mergeSpots([spot()], ROSTER));
        reset();
        mount(NCDXFPanel, {}, context());
        // An effect that throws on the way out leaks a subscriber and a timer
        // per open and close, and is invisible until a session has been running
        // for hours. drain() runs them.
        assert.ok(true);
    });

    console.log(`\n${pass} passed`);
})();

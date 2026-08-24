// What a marker scan will step through, and what it remembers between sessions.
//
// The list is where a scan goes wrong quietly. Two markers on the same station —
// the voice detector's sighting and the skimmer's confirmation of it — are two
// dwells and two mode reloads on one signal, and a scan that visits both spends
// half its time on whoever happens to be spotted twice. The band limit is the
// other half: it is the setting that ships on, so the case where the dial is
// nowhere near a ham band decides whether a first press does anything at all.

const assert = require('assert');

const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};

const { nextScanMarker, scanTargets } = require('./.build/scanner.cjs');
const {
    SCAN_DEFAULT_BAND_ONLY, SCAN_DEFAULT_TYPES,
    _resetScanSettings, onScanSettings, saveScanSettings, savedScanSettings,
} = require('./.build/scannersettings.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const KEY = 'ubersdr.v2.scanner';
const fresh = () => { store.clear(); _resetScanSettings(); };

const marker = (freq, over = {}) => ({
    freq, mode: 'usb', family: 'usb', name: '', type: 'voice', priority: 1, ...over,
});

// ── The target list ─────────────────────────────────────────────────────────

t('the targets come back in frequency order', () => {
    const list = scanTargets([marker(14250000), marker(14100000), marker(14200000)], {});
    assert.deepStrictEqual(list.map((m) => m.freq), [14100000, 14200000, 14250000]);
});

t('kinds nobody asked for are left out', () => {
    const list = scanTargets(
        [marker(14100000, { type: 'voice' }), marker(14200000, { type: 'cw' })],
        { types: ['voice'] },
    );
    assert.deepStrictEqual(list.map((m) => m.type), ['voice']);
});

t('no selection at all is not a filter', () => {
    // `types` absent means the caller is not filtering — the panel always passes
    // one, but scanTargets is also the pure answer to "what is out there".
    const list = scanTargets([marker(14100000), marker(14200000, { type: 'dx' })], {});
    assert.strictEqual(list.length, 2);
});

t('the band limit keeps the scan on the band the dial is in', () => {
    const list = scanTargets(
        [marker(7100000), marker(14100000), marker(14300000), marker(21200000)],
        { bandOnly: true, dialHz: 14074000 },
    );
    assert.deepStrictEqual(list.map((m) => m.freq), [14100000, 14300000]);
});

t('the band limit outside every ham band scans everything', () => {
    // "No band" is not a band with nothing in it — the same fallback
    // resolveBandFilter makes. A listener parked on a broadcast station who
    // presses Scan with the shipped settings must get a scan, not an empty list
    // and no explanation.
    const list = scanTargets(
        [marker(6000000), marker(9500000), marker(14100000)],
        { bandOnly: true, dialHz: 9600000 },
    );
    assert.strictEqual(list.length, 3);
});

t('the band limit off scans across the bands', () => {
    const list = scanTargets(
        [marker(7100000), marker(14100000)],
        { bandOnly: false, dialHz: 14074000 },
    );
    assert.strictEqual(list.length, 2);
});

t('two markers on one station are one target', () => {
    // The detector hears a voice at 14247980 and the skimmer confirms a callsign
    // at 14248000. Twenty hertz apart is the same station, and the dial cannot
    // tell them apart — so scanning both is two dwells on one signal.
    const list = scanTargets([
        marker(14247980, { name: 'Voice 20m', priority: 1 }),
        marker(14248000, { name: 'G4ABC', priority: 2 }),
    ], {});
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'G4ABC', 'the fold kept the unnamed one');
});

t('a bookmark under a live spot loses to it', () => {
    const list = scanTargets([
        marker(14200000, { name: 'Net', type: 'bookmark-server', priority: 0 }),
        marker(14200000, { name: 'GB2RS', type: 'dx', priority: 1 }),
    ], {});
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'GB2RS');
});

t('markers further apart than the dial tolerance are both scanned', () => {
    const list = scanTargets([marker(14200000), marker(14200400)], {});
    assert.strictEqual(list.length, 2);
});

t('rubbish in the marker list is dropped rather than scanned to', () => {
    const list = scanTargets([null, { freq: 0 }, marker(14200000)], {});
    assert.deepStrictEqual(list.map((m) => m.freq), [14200000]);
});

// ── Stepping ────────────────────────────────────────────────────────────────

t('the next target is the first one above where the scan is', () => {
    const list = scanTargets([marker(14100000), marker(14200000), marker(14300000)], {});
    assert.strictEqual(nextScanMarker(list, 14150000).freq, 14200000);
});

t('the top of the list wraps back to the bottom', () => {
    const list = scanTargets([marker(14100000), marker(14200000)], {});
    assert.strictEqual(nextScanMarker(list, 14200000).freq, 14100000);
});

t('a scan started below everything begins at the bottom', () => {
    const list = scanTargets([marker(14100000), marker(14200000)], {});
    assert.strictEqual(nextScanMarker(list, 14000000).freq, 14100000);
});

t('nothing to scan is nowhere to go, not the first thing again', () => {
    assert.strictEqual(nextScanMarker([], 14000000), null);
    assert.strictEqual(nextScanMarker(null, 14000000), null);
});

// ── The settings ────────────────────────────────────────────────────────────

t('a browser that has never been told scans voice, on this band', () => {
    fresh();
    const s = savedScanSettings();
    assert.deepStrictEqual(s.types, SCAN_DEFAULT_TYPES);
    assert.deepStrictEqual(s.types, ['voice']);
    assert.strictEqual(s.bandOnly, SCAN_DEFAULT_BAND_ONLY);
    assert.strictEqual(s.bandOnly, true);
});

t('a stored selection comes back', () => {
    fresh();
    store.set(KEY, JSON.stringify({ types: ['dx', 'cw'], bandOnly: false }));
    const s = savedScanSettings();
    assert.deepStrictEqual(s.types, ['dx', 'cw']);
    assert.strictEqual(s.bandOnly, false);
});

t('nothing selected is a selection and survives a reload', () => {
    // The scan turned off, as opposed to a browser that has never been told.
    fresh();
    store.set(KEY, JSON.stringify({ types: [], bandOnly: true }));
    assert.deepStrictEqual(savedScanSettings().types, []);
});

t('a selection this build recognises none of falls back to the defaults', () => {
    fresh();
    store.set(KEY, JSON.stringify({ types: ['satellites', 'runes'] }));
    assert.deepStrictEqual(savedScanSettings().types, SCAN_DEFAULT_TYPES);
});

t('junk in the key is not a setting', () => {
    fresh();
    store.set(KEY, 'not json at all');
    assert.deepStrictEqual(savedScanSettings().types, SCAN_DEFAULT_TYPES);
    assert.strictEqual(savedScanSettings().bandOnly, true);
});

t('one control is written without disturbing the other', () => {
    // The two live in one key, so a whole-object write from the chips would put
    // back whatever the band switch was when that half rendered.
    fresh();
    saveScanSettings({ bandOnly: false });
    assert.deepStrictEqual(savedScanSettings().types, ['voice'], 'the kinds were overwritten');
    saveScanSettings({ types: ['dx'] });
    assert.strictEqual(savedScanSettings().bandOnly, false, 'the band switch was overwritten');
});

t('a write reaches the other copy of the panel', () => {
    fresh();
    const seen = [];
    const off = onScanSettings((s) => seen.push(s));
    saveScanSettings({ types: ['cw'] });
    assert.strictEqual(seen.length, 1);
    assert.deepStrictEqual(seen[0].types, ['cw']);
    // One object to every listener, so a useMemo keyed on it does not re-run
    // once per subscriber.
    assert.strictEqual(seen[0], savedScanSettings());
    off();
    saveScanSettings({ types: ['dx'] });
    assert.strictEqual(seen.length, 1, 'a removed listener was still called');
});

t('a request made entirely of kinds this build does not have is refused', () => {
    fresh();
    saveScanSettings({ types: ['runes'] });
    assert.deepStrictEqual(savedScanSettings().types, ['voice'], 'a typo became a setting');
});

t('turning every kind off is allowed', () => {
    fresh();
    saveScanSettings({ types: [] });
    assert.deepStrictEqual(savedScanSettings().types, []);
    assert.deepStrictEqual(JSON.parse(store.get(KEY)).types, []);
});

console.log(`\n${pass} scanner checks passed`);

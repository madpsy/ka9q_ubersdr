// What tuning to a bookmark asks for.
//
// Both kinds of bookmark — the receiver's own from config.yaml, and the browser's from v1's
// store — can carry `bandwidth_low` / `bandwidth_high`, and v1 applies them on either. In v2
// only the local bookmarks panel did: the server panel, a pill on the marker bar and marker
// navigation all opened the mode's default filter instead. That is not cosmetic — a bookmark
// on a narrow CW signal, or on one of the passbands a KiwiSDR import brings, is about its
// filter, and the frequency without it is the wrong station.

const assert = require('assert');
const { bookmarkTarget, markerTarget } = require('./.build/bookmarktune.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const bm = (over = {}) => ({ name: 'Net', frequency: 7100000, mode: 'lsb', ...over });

// --- a bookmark --------------------------------------------------------------------

t('frequency and mode come across', () => {
    assert.deepStrictEqual(bookmarkTarget(bm()), { frequency: 7100000, mode: 'lsb' });
});

t('a stored passband comes across with them', () => {
    // And in one call, not three actions: a mode change resets the passband, so
    // setMode-then-setBandwidth sends two tunes and passes through the wrong filter.
    assert.deepStrictEqual(
        bookmarkTarget(bm({ mode: 'cwl', bandwidth_low: -200, bandwidth_high: 200 })),
        { frequency: 7100000, mode: 'cwl', bandwidthLow: -200, bandwidthHigh: 200 },
    );
});

t('no passband means the mode decides, rather than a null being sent', () => {
    const r = bookmarkTarget(bm());
    assert.ok(!('bandwidthLow' in r), 'absent, so tuneTo fills in the mode default');
    assert.ok(!('bandwidthHigh' in r));
});

t('half a passband is not a filter, so it is left out', () => {
    // A bookmark carrying only a low edge says nothing about the high one.
    assert.ok(!('bandwidthLow' in bookmarkTarget(bm({ bandwidth_low: -200 }))));
    assert.ok(!('bandwidthHigh' in bookmarkTarget(bm({ bandwidth_high: 200 }))));
    // Nor is a pair the wrong way round, or one of zero width.
    assert.ok(!('bandwidthLow' in bookmarkTarget(bm({ bandwidth_low: 200, bandwidth_high: -200 }))));
    assert.ok(!('bandwidthLow' in bookmarkTarget(bm({ bandwidth_low: 0, bandwidth_high: 0 }))));
});

t('a mode is lower-cased, and a bookmark without one keeps the current mode', () => {
    assert.strictEqual(bookmarkTarget(bm({ mode: 'LSB' })).mode, 'lsb');
    const none = bookmarkTarget(bm({ mode: '' }));
    assert.ok(!('mode' in none), 'absent rather than empty — tuneTo keeps what is tuned');
});

t('a mode this receiver does not have is passed on for tuneTo to reject', () => {
    // KiwiSDR imports bring drm, iq, wfm and ecss. tuneTo tests the mode against its own
    // table and keeps the current one, which is what v1 does — and the frequency still moves.
    assert.strictEqual(bookmarkTarget(bm({ mode: 'drm' })).mode, 'drm');
});

t('a fractional frequency is rounded, because the dial is in whole Hz', () => {
    assert.strictEqual(bookmarkTarget(bm({ frequency: 7100000.6 })).frequency, 7100001);
});

t('a bookmark with nothing to tune to is nothing', () => {
    assert.strictEqual(bookmarkTarget(null), null);
    assert.strictEqual(bookmarkTarget(bm({ frequency: 0 })), null);
    assert.strictEqual(bookmarkTarget(bm({ frequency: -1 })), null);
});

// --- a marker ----------------------------------------------------------------------
//
// Stepping onto a bookmark with marker navigation is the fourth way to tune to one. The
// marker carries the pair already flattened — see collectMarkers.

t('a bookmark marker lands on the filter it was saved with', () => {
    assert.deepStrictEqual(
        markerTarget({ freq: 7100000, mode: 'cwl', low: -200, high: 200 }),
        { frequency: 7100000, mode: 'cwl', bandwidthLow: -200, bandwidthHigh: 200 },
    );
});

t('a marker that is not a bookmark carries no filter, and asks for none', () => {
    // A spot says where somebody was heard, not how to listen to them.
    const r = markerTarget({ freq: 14074000, mode: 'usb', low: null, high: null });
    assert.deepStrictEqual(r, { frequency: 14074000, mode: 'usb' });
});

t('a wildcard bookmark marker keeps the mode you are in', () => {
    // `mode: null` is what a bookmark with no mode becomes — "7.100 — net" in any mode.
    const r = markerTarget({ freq: 7100000, mode: null });
    assert.ok(!('mode' in r));
    assert.strictEqual(r.frequency, 7100000);
});

t('a marker with no frequency is nothing', () => {
    assert.strictEqual(markerTarget(null), null);
    assert.strictEqual(markerTarget({ freq: 0 }), null);
});

if (process.exitCode) console.log('\nbookmark tune tests FAILED');
else console.log(`\nall ${pass} bookmark tune tests passed`);

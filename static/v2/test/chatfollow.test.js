// Following another listener over chat — v1's "sync".
//
// Chat publishes what everyone is tuned to; following makes that continuous, so when their
// dial moves yours moves with it. The rules are v1's (chat-ui.js `syncToUser` / `toggleSync`)
// and most of them are about *not* acting: on half a record, on our own row, on a list refresh
// that carries no actual change.

const assert = require('assert');
const {
    FOLLOW_ZOOM_KEY, followSignature, followTarget, followView, followable, loadFollowZoom,
    saveFollowZoom, sortFollowFirst,
} = require('./.build/chatfollow.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// A user as the server publishes them.
const user = (over = {}) => ({
    username: 'G0ABC',
    frequency: 14074000,
    mode: 'usb',
    bw_low: 300,
    bw_high: 2700,
    ...over,
});

// --- what to tune ----------------------------------------------------------------

t('their frequency, mode and passband come across together', () => {
    // One tune, not three: a mode change resets the passband, so applying them separately
    // would pass the receiver through the wrong filter on the way.
    assert.deepStrictEqual(followTarget(user()), {
        frequency: 14074000, mode: 'usb', bandwidthLow: 300, bandwidthHigh: 2700,
    });
});

t('a record with no mode is not followed at all', () => {
    // v1's rule. A frequency with no mode is a client that has not published properly, and
    // tuning to it in whatever mode we happen to be in is a guess.
    assert.strictEqual(followTarget(user({ mode: '' })), null);
    assert.strictEqual(followTarget(user({ mode: null })), null);
});

t('a record with no frequency is not followed either', () => {
    assert.strictEqual(followTarget(user({ frequency: 0 })), null);
    assert.strictEqual(followTarget(null), null);
});

t('a mode is lower-cased, as the rest of the receiver spells it', () => {
    assert.strictEqual(followTarget(user({ mode: 'USB' })).mode, 'usb');
});

t('a passband that is not a pair is left to the mode', () => {
    // v1 substitutes 0 for a missing edge and hands that over; leaving it out means the mode's
    // own passband applies, which is what somebody following a mode change expects to hear.
    for (const over of [{ bw_low: undefined }, { bw_high: undefined }, { bw_low: 2700, bw_high: 300 }]) {
        const r = followTarget(user(over));
        assert.ok(r, JSON.stringify(over));
        assert.ok(!('bandwidthLow' in r), JSON.stringify(over));
    }
});

// --- their view ------------------------------------------------------------------

t('zoom is copied as resolution, and turned into our own span', () => {
    // They publish Hz per bin. The two receivers may be asking for different bin counts, so
    // copying the span would show a different slice of the band at the same zoom setting.
    assert.deepStrictEqual(followView(user({ zoom_bw: 10 }), 1024),
        { frequency: 14074000, span: 10240 });
    assert.deepStrictEqual(followView(user({ zoom_bw: 10 }), 2048),
        { frequency: 14074000, span: 20480 });
});

t('no zoom published is no view to match', () => {
    assert.strictEqual(followView(user(), 1024), null);
    assert.strictEqual(followView(user({ zoom_bw: 0 }), 1024), null);
    assert.strictEqual(followView(user({ zoom_bw: 10 }), 0), null, 'and we need our bin count');
});

t('the view is pulled back to stay inside the spectrum', () => {
    // v1's clamp. Following somebody on 200 kHz at a wide zoom otherwise asks for a window
    // starting below zero, and what comes back is not the view either of you is looking at.
    const low = followView(user({ frequency: 200000, zoom_bw: 1000 }), 1024);
    assert.strictEqual(low.span, 1024000);
    assert.strictEqual(low.frequency, 512000, 'half a span up from the bottom');
    const high = followView(user({ frequency: 29900000, zoom_bw: 1000 }), 1024);
    assert.strictEqual(high.frequency, 30e6 - 512000);
});

t('a span wider than the spectrum centres on the middle rather than failing', () => {
    const v = followView(user({ zoom_bw: 50000 }), 1024);
    assert.strictEqual(v.frequency, 15e6);
});

// --- when to act -----------------------------------------------------------------

t('the signature only changes when something worth acting on does', () => {
    // The user list is refreshed by anything happening on the channel — a join, an idle sweep,
    // our own status going out. Re-tuning on each would fight an operator who has since nudged
    // the dial.
    const a = followSignature(user(), false);
    assert.strictEqual(a, followSignature(user({ is_idle: true, idle_minutes: 4 }), false));
    assert.notStrictEqual(a, followSignature(user({ frequency: 14075000 }), false));
    assert.notStrictEqual(a, followSignature(user({ mode: 'lsb' }), false));
    assert.notStrictEqual(a, followSignature(user({ bw_high: 2400 }), false));
});

t('their zoom only counts when we are matching it', () => {
    const off = followSignature(user({ zoom_bw: 10 }), false);
    assert.strictEqual(off, followSignature(user({ zoom_bw: 50 }), false), 'not watching it');
    assert.notStrictEqual(
        followSignature(user({ zoom_bw: 10 }), true),
        followSignature(user({ zoom_bw: 50 }), true),
    );
});

t('a record there is nothing to follow in has no signature', () => {
    assert.strictEqual(followSignature(user({ mode: '' }), false), '');
    assert.strictEqual(followSignature(null, true), '');
});

// --- who can be followed ---------------------------------------------------------

t('not ourselves', () => {
    assert.strictEqual(followable(user({ username: 'M0ME' }), 'M0ME'), false);
    assert.strictEqual(followable(user({ username: 'G0ABC' }), 'M0ME'), true);
});

t('not somebody with nothing published', () => {
    assert.strictEqual(followable(user({ mode: '' }), 'M0ME'), false);
    assert.strictEqual(followable(user({ frequency: 0 }), 'M0ME'), false);
    assert.strictEqual(followable(null, 'M0ME'), false);
});

// --- the order of the list -------------------------------------------------------

t('the followed user is first, then alphabetical', () => {
    // The server's own order changes as people come and go, which moves the row you are aiming
    // at. Alphabetical does not, and the followed one is pinned where it can be seen.
    const list = [user({ username: 'ZZ1Z' }), user({ username: 'A1AA' }), user({ username: 'M0ME' })];
    assert.deepStrictEqual(
        sortFollowFirst(list, 'M0ME').map((u) => u.username),
        ['M0ME', 'A1AA', 'ZZ1Z'],
    );
    assert.deepStrictEqual(
        sortFollowFirst(list, null).map((u) => u.username),
        ['A1AA', 'M0ME', 'ZZ1Z'],
    );
});

t('sorting does not disturb the list it was given', () => {
    const list = [user({ username: 'ZZ1Z' }), user({ username: 'A1AA' })];
    sortFollowFirst(list, 'A1AA');
    assert.strictEqual(list[0].username, 'ZZ1Z');
});

t('an empty list sorts to an empty list', () => {
    assert.deepStrictEqual(sortFollowFirst(null, 'x'), []);
});

// --- the zoom preference ---------------------------------------------------------

t('matching their zoom is off until asked for, and then remembered', () => {
    // Off by default because the spectrum view is your own window on the band: following
    // somebody zoomed into 200 Hz of a CW signal takes away your sight of everything else.
    const store = new Map();
    global.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
    };
    assert.strictEqual(loadFollowZoom(), false);
    saveFollowZoom(true);
    assert.strictEqual(store.get(FOLLOW_ZOOM_KEY), 'on');
    assert.strictEqual(loadFollowZoom(), true);
    saveFollowZoom(false);
    assert.strictEqual(loadFollowZoom(), false);
    delete global.localStorage;
});

t('no storage at all is not an error', () => {
    // Private windows, and node.
    assert.strictEqual(loadFollowZoom(), false);
    saveFollowZoom(true);
});

if (process.exitCode) console.log('\nchat follow tests FAILED');
else console.log(`\nall ${pass} chat follow tests passed`);

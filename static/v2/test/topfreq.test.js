// The most-used frequency leaderboard.
//
// The store is the part worth testing: it survives reloads, so anything it
// accepts it has to keep working with for as long as the operator uses the
// receiver. A record it cannot tune to is worse than no record — it occupies a
// row and does nothing when clicked.

const assert = require('assert');
const tf = require('./.build/topfreq.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const store = new Map();
global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};

// --- scoring -----------------------------------------------------------------

t('a minute on a new combination starts it at one', () => {
    const c = tf.creditMinute({}, 14074000, 'usb', 1000);
    assert.deepStrictEqual(c[tf.comboKey(14074000, 'usb')], {
        hz: 14074000, mode: 'usb', count: 1, last: 1000,
    });
});

t('another minute on the same one counts up', () => {
    let c = tf.creditMinute({}, 14074000, 'usb', 1000);
    c = tf.creditMinute(c, 14074000, 'usb', 2000);
    c = tf.creditMinute(c, 14074000, 'usb', 3000);
    assert.strictEqual(c[tf.comboKey(14074000, 'usb')].count, 3);
    assert.strictEqual(c[tf.comboKey(14074000, 'usb')].last, 3000);
});

t('the same frequency in another mode is another entry', () => {
    // The whole point of the thing: 14.074 in USB is FT8, in CW it is not.
    let c = tf.creditMinute({}, 14074000, 'usb', 1000);
    c = tf.creditMinute(c, 14074000, 'cwu', 2000);
    assert.strictEqual(Object.keys(c).length, 2);
});

t('the mode is matched however it was capitalised', () => {
    let c = tf.creditMinute({}, 7100000, 'LSB', 1000);
    c = tf.creditMinute(c, 7100000, 'lsb', 2000);
    assert.strictEqual(Object.keys(c).length, 1);
    assert.strictEqual(c[tf.comboKey(7100000, 'lsb')].count, 2);
});

t('a credit does not change the store it was given', () => {
    // The panel holds this in React state, where mutating it in place would
    // stop the list re-rendering.
    const before = tf.creditMinute({}, 14074000, 'usb', 1000);
    const snapshot = JSON.stringify(before);
    tf.creditMinute(before, 14074000, 'usb', 2000);
    assert.strictEqual(JSON.stringify(before), snapshot);
});

t('nothing to credit changes nothing', () => {
    const c = { x: 1 };
    assert.strictEqual(tf.creditMinute(c, 0, 'usb'), c);
    assert.strictEqual(tf.creditMinute(c, 14074000, ''), c);
    assert.strictEqual(tf.creditMinute(c, NaN, 'usb'), c);
});

// --- ordering ----------------------------------------------------------------

t('the most-used comes first', () => {
    const c = {};
    c[tf.comboKey(1, 'usb')] = { hz: 1, mode: 'usb', count: 2, last: 10 };
    c[tf.comboKey(2, 'usb')] = { hz: 2, mode: 'usb', count: 9, last: 10 };
    c[tf.comboKey(3, 'usb')] = { hz: 3, mode: 'usb', count: 5, last: 10 };
    assert.deepStrictEqual(tf.sortedCombos(c).map((x) => x.hz), [2, 3, 1]);
});

t('a tie breaks on which was used most recently', () => {
    // Otherwise two equal rows swap places at random every time the list is
    // redrawn, which on a panel that redraws every minute is very visible.
    const c = {};
    c[tf.comboKey(1, 'usb')] = { hz: 1, mode: 'usb', count: 4, last: 100 };
    c[tf.comboKey(2, 'usb')] = { hz: 2, mode: 'usb', count: 4, last: 900 };
    assert.deepStrictEqual(tf.sortedCombos(c).map((x) => x.hz), [2, 1]);
});

t('an empty or missing store sorts to nothing', () => {
    assert.deepStrictEqual(tf.sortedCombos({}), []);
    assert.deepStrictEqual(tf.sortedCombos(null), []);
});

// --- bounds ------------------------------------------------------------------

t('the store is capped, and it is the weakest that go', () => {
    let c = {};
    for (let i = 0; i < tf.TOP_FREQ_STORE + 50; i++) {
        c = tf.creditMinute(c, 1000000 + i * 1000, 'usb', i);
        // Give the first few a lead so they are the ones that must survive.
        if (i < 3) for (let n = 0; n < 10; n++) c = tf.creditMinute(c, 1000000 + i * 1000, 'usb', i);
    }
    assert.strictEqual(Object.keys(c).length, tf.TOP_FREQ_STORE);
    for (let i = 0; i < 3; i++) {
        assert.ok(c[tf.comboKey(1000000 + i * 1000, 'usb')], `the leader at index ${i} was evicted`);
    }
});

// --- how long it reads as ----------------------------------------------------

t('minutes read as a duration', () => {
    assert.strictEqual(tf.formatDwell(0), '0m');
    assert.strictEqual(tf.formatDwell(1), '1m');
    assert.strictEqual(tf.formatDwell(4), '4m');
    assert.strictEqual(tf.formatDwell(59), '59m');
    assert.strictEqual(tf.formatDwell(140), '2h20m');
});

t('a whole hour or day drops the empty smaller unit', () => {
    assert.strictEqual(tf.formatDwell(60), '1h');
    assert.strictEqual(tf.formatDwell(120), '2h');
    assert.strictEqual(tf.formatDwell(24 * 60), '1d');
});

t('past a day it reads in days and hours', () => {
    assert.strictEqual(tf.formatDwell(24 * 60 + 60), '1d1h');
    assert.strictEqual(tf.formatDwell(3 * 24 * 60 + 5 * 60), '3d5h');
    // The minutes stop mattering, and a four-figure column would shift the row.
    assert.strictEqual(tf.formatDwell(3 * 24 * 60 + 5 * 60 + 30), '3d5h');
});

t('nonsense reads as nothing rather than NaN', () => {
    for (const bad of [null, undefined, NaN, -5, 'lots']) {
        assert.strictEqual(tf.formatDwell(bad), '0m', String(bad));
    }
});

// --- persistence -------------------------------------------------------------

t('the store survives a round trip', () => {
    tf._clearCombos();
    const c = tf.creditMinute({}, 14074000, 'usb', 1000);
    tf.saveCombos(c);
    assert.deepStrictEqual(tf.loadCombos(), c);
});

t('nothing stored is an empty board, not a crash', () => {
    tf._clearCombos();
    assert.deepStrictEqual(tf.loadCombos(), {});
});

t('a corrupt store is discarded rather than thrown on', () => {
    for (const bad of ['{not json', '"a string"', '[1,2,3]', 'null', '42']) {
        tf._clearCombos();
        global.localStorage.setItem('ubersdr.v2.topfreq', bad);
        assert.deepStrictEqual(tf.loadCombos(), {}, bad);
    }
});

t('a record that could not be tuned to is dropped on load', () => {
    // It would take a row on the leaderboard and do nothing when clicked.
    tf._clearCombos();
    global.localStorage.setItem('ubersdr.v2.topfreq', JSON.stringify({
        [tf.comboKey(14074000, 'usb')]: { hz: 14074000, mode: 'usb', count: 3, last: 1 },
        'bad|1': { hz: 0, mode: 'usb', count: 3, last: 1 },
        'bad|2': { hz: 14074000, mode: '', count: 3, last: 1 },
        'bad|3': { hz: 14074000, mode: 'usb', count: 0, last: 1 },
        'bad|4': { hz: 'fourteen', mode: 'usb', count: 3, last: 1 },
        'bad|5': null,
    }));
    const loaded = tf.loadCombos();
    assert.deepStrictEqual(Object.keys(loaded), [tf.comboKey(14074000, 'usb')]);
});

t('a record filed under the wrong key is dropped', () => {
    // The key is how the panel decides which row is the one you are on, so a
    // mismatch would highlight the wrong frequency.
    tf._clearCombos();
    global.localStorage.setItem('ubersdr.v2.topfreq', JSON.stringify({
        '7100000|lsb': { hz: 14074000, mode: 'usb', count: 3, last: 1 },
    }));
    assert.deepStrictEqual(tf.loadCombos(), {});
});

t('storage that refuses to write does not throw', () => {
    const prev = global.localStorage.setItem;
    global.localStorage.setItem = () => { throw new Error('quota'); };
    try {
        tf.saveCombos({ a: 1 });
    } finally {
        global.localStorage.setItem = prev;
    }
});

t('the key is stable however the frequency arrived', () => {
    assert.strictEqual(tf.comboKey(14074000.4, 'USB'), tf.comboKey(14074000, 'usb'));
});

// --- the clock ---------------------------------------------------------------
//
// It lives in the store rather than in the panel, because a collapsed dock unmounts the
// panel and the leaderboard was quietly counting only the time it spent on screen. Which
// means the clock has to survive a whole session unattended, and these are the two ways a
// wall clock gets that wrong: a throttled background tab, and a machine that was asleep.

const clock = (name, fn) => t(name, () => {
    tf._resetDwell();
    store.clear();
    try { fn(); } finally { tf._resetDwell(); }
});

const count = (hz, mode) => (tf.comboState().combos[tf.comboKey(hz, mode)] || {}).count || 0;

// Starts a stay and hands back the moment its clock started from. Real time, because that is
// what trackDwell reads — the fabricated times below are all offsets from it, so a step is a
// step and not a three-hour gap the store would rightly throw away.
const start = (hz, mode, running = true) => {
    tf.trackDwell({ running, hz, mode });
    return Date.now();
};

clock('nothing is timed until the receiver is running', () => {
    const t0 = start(14074000, 'usb', false);
    assert.strictEqual(tf.comboState().timing, false);
    tf._tickDwell(t0 + 60000);
    assert.strictEqual(count(14074000, 'usb'), 0, 'a stopped receiver is not listening');
});

clock('a full minute on one combination scores one point', () => {
    const t0 = start(14074000, 'usb');
    // Four looks at the clock, fifteen seconds apart, is one minute — and the score is one
    // rather than four, because it is the time that counts and not the number of looks.
    for (let i = 1; i <= 4; i++) tf._tickDwell(t0 + i * tf.DWELL_TICK_MS);
    assert.strictEqual(count(14074000, 'usb'), 1);
    assert.strictEqual(tf.comboState().dwell, 1);
});

clock('a part minute scores nothing, and is lost when the dial moves', () => {
    // The widget's rule, and the reason tuning past a frequency never scores.
    const t0 = start(14074000, 'usb');
    tf._tickDwell(t0 + tf.DWELL_TICK_MS * 3);
    assert.strictEqual(count(14074000, 'usb'), 0);
    const t1 = start(7100000, 'lsb');
    tf._tickDwell(t1 + tf.DWELL_TICK_MS);
    assert.strictEqual(count(14074000, 'usb'), 0, 'the part minute did not follow the dial');
    assert.strictEqual(count(7100000, 'lsb'), 0);
});

clock('a throttled tab still scores the minutes it was there', () => {
    // A background tab has its timers cut to about one a minute. Counting firings would have
    // credited a quarter of the time; measuring it credits all of it.
    const t0 = start(14074000, 'usb');
    for (let i = 1; i <= 3; i++) tf._tickDwell(t0 + i * 60000);
    assert.strictEqual(count(14074000, 'usb'), 3);
});

clock('a gap too long to be a tick is thrown away, not credited', () => {
    // A laptop shut for three hours must not hand three hours to whatever the dial was left
    // on. There is no way to know when the sleep began, so the whole gap goes.
    const t0 = start(14074000, 'usb');
    tf._tickDwell(t0 + 3 * 60 * 60 * 1000);
    assert.strictEqual(count(14074000, 'usb'), 0);
    // And the clock carries on from the wake-up rather than staying stuck.
    for (let i = 1; i <= 4; i++) tf._tickDwell(t0 + 3 * 60 * 60 * 1000 + i * tf.DWELL_TICK_MS);
    assert.strictEqual(count(14074000, 'usb'), 1);
});

clock('the limit sits above a throttled tick and below anything else', () => {
    assert.ok(tf.DWELL_TICK_MS < 60000, 'so a minute of throttling is still one step');
    assert.ok(tf.DWELL_MAX_STEP_MS > 60000);
    assert.ok(tf.DWELL_MAX_STEP_MS < 5 * 60000, 'and a coffee break is not listening time');
});

clock('several minutes at once are several points, not one', () => {
    const t0 = start(14074000, 'usb');
    // Two throttled ticks either side of a minute boundary: the second covers two whole
    // minutes at once, and both have to land.
    tf._tickDwell(t0 + 60000);
    tf._tickDwell(t0 + 120000);
    assert.strictEqual(count(14074000, 'usb'), 2);
});

clock('a subscriber hears the minute land, and can stop hearing it', () => {
    const seen = [];
    const off = tf.onCombos((s) => seen.push(s.dwell));
    assert.strictEqual(seen.length, 1, 'and hears the current state at once');
    const t0 = start(14074000, 'usb');
    tf._tickDwell(t0 + 60000);
    assert.strictEqual(seen[seen.length - 1], 1);
    off();
    tf._tickDwell(t0 + 120000);
    assert.strictEqual(seen[seen.length - 1], 1, 'nothing after unsubscribing');
});

clock('clearing wipes the board and the stay in progress with it', () => {
    const t0 = start(14074000, 'usb');
    for (let i = 1; i <= 4; i++) tf._tickDwell(t0 + i * tf.DWELL_TICK_MS);
    assert.strictEqual(count(14074000, 'usb'), 1);
    tf.clearCombos();
    assert.deepStrictEqual(tf.comboState().combos, {});
    assert.strictEqual(tf.comboState().dwell, 0);
});

clock('the same reading twice does not restart the stay', () => {
    // The watch re-runs its effect on every render of the app; a stay that restarted each
    // time would never reach a full minute.
    const t0 = start(14074000, 'usb');
    tf._tickDwell(t0 + 30000);
    tf.trackDwell({ running: true, hz: 14074000.4, mode: 'USB' });
    tf._tickDwell(t0 + 60000);
    assert.strictEqual(count(14074000, 'usb'), 1);
});

console.log(`\n${pass} ok`);

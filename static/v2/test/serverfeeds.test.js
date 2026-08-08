// The server-feed gate: what Stop actually stops.
//
// The gate is one flag for the whole page and every recurring request hangs off
// it, so the cases that matter are the ones where a feed leaks — a poll that
// keeps its timer through a close, or one that comes back without refreshing.

const assert = require('assert');
const {
    feedInterval, feedsAllowed, onFeedsAllowed, resetFeeds, setFeedsAllowed,
} = require('./.build/serverfeeds.cjs');

let pass = 0;
const t = (name, fn) => {
    try { resetFeeds(); fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
    finally { resetFeeds(); }
};

// Node's timers are real, so nothing here waits for one: the cases are about
// whether a timer exists at all, which is observable from the leading call and
// from what happens on the next edge.
const PERIOD = 60_000;

t('the gate starts closed, so nothing polls before the receiver runs', () => {
    assert.strictEqual(feedsAllowed(), false);
    let calls = 0;
    const stop = feedInterval(() => { calls++; }, PERIOD);
    assert.strictEqual(calls, 0, 'a feed started while stopped must not fetch');
    stop();
});

t('opening the gate starts a feed that was created closed', () => {
    let calls = 0;
    const stop = feedInterval(() => { calls++; }, PERIOD);
    setFeedsAllowed(true);
    assert.strictEqual(calls, 1);
    stop();
});

t('a feed created while open fires at once', () => {
    setFeedsAllowed(true);
    let calls = 0;
    const stop = feedInterval(() => { calls++; }, PERIOD);
    assert.strictEqual(calls, 1);
    stop();
});

t('coming back refreshes rather than waiting out a whole period', () => {
    setFeedsAllowed(true);
    let calls = 0;
    const stop = feedInterval(() => { calls++; }, PERIOD);
    assert.strictEqual(calls, 1);
    setFeedsAllowed(false);
    setFeedsAllowed(true);
    assert.strictEqual(calls, 2, 'a resumed feed catches up instead of showing stale data');
    stop();
});

t('the gate set to what it already is changes nothing', () => {
    setFeedsAllowed(true);
    let calls = 0;
    const stop = feedInterval(() => { calls++; }, PERIOD);
    setFeedsAllowed(true);
    setFeedsAllowed(true);
    assert.strictEqual(calls, 1, 'a redundant set must not re-fire every poll on the page');
    stop();
});

t('a stopped feed does not come back when the gate reopens', () => {
    setFeedsAllowed(true);
    let calls = 0;
    const stop = feedInterval(() => { calls++; }, PERIOD);
    stop();
    setFeedsAllowed(false);
    setFeedsAllowed(true);
    assert.strictEqual(calls, 1, 'stop() unsubscribes from the gate as well as clearing the timer');
});

t('one subscriber throwing does not stop the rest of the page', () => {
    const seen = [];
    onFeedsAllowed(() => { throw new Error('bad listener'); });
    onFeedsAllowed((on) => seen.push(on));
    setFeedsAllowed(true);
    assert.deepStrictEqual(seen, [true]);
});

t('a subscriber that unsubscribes from inside its own callback is safe', () => {
    const seen = [];
    const off = onFeedsAllowed((on) => { seen.push(on); off(); });
    onFeedsAllowed((on) => seen.push(`b${on}`));
    setFeedsAllowed(true);
    setFeedsAllowed(false);
    assert.deepStrictEqual(seen, [true, 'btrue', 'bfalse']);
});

console.log(`\n${pass} passed`);

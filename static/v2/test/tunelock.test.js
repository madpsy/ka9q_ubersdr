// The tuning lock's toast.
//
// Two numbers carry the whole feature and both are easy to get wrong in a way
// nothing else would notice: the toast has to appear on the *first* refusal of a
// burst — a waterfall drag refuses dozens of times a second — and then say
// nothing for thirty, or it becomes a strobe rather than a message.

const assert = require('assert');
const lock = require('./.build/tunelock.cjs');

let pass = 0;
const t = (name, fn) => {
    lock._resetTuneLock();
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const NOW = Date.UTC(2026, 7, 26, 12, 0, 0);
const SEC = 1000;

// --- showing it ----------------------------------------------------------------

t('a refusal shows the toast', () => {
    assert.strictEqual(lock.lockToastVisible(), false);
    lock.refusedByLock(NOW);
    assert.strictEqual(lock.lockToastVisible(), true);
});

t('subscribers are told, and can unsubscribe', () => {
    const seen = [];
    const off = lock.onLockToast((v) => seen.push(v));
    lock.refusedByLock(NOW);
    assert.deepStrictEqual(seen, [true]);
    off();
    lock.refusedByLock(NOW + 60 * SEC);
    assert.deepStrictEqual(seen, [true]);
});

t('a subscriber that throws does not stop the others', () => {
    const seen = [];
    lock.onLockToast(() => { throw new Error('nope'); });
    lock.onLockToast((v) => seen.push(v));
    lock.refusedByLock(NOW);
    assert.deepStrictEqual(seen, [true]);
});

// --- the throttle --------------------------------------------------------------

t('a burst of refusals is one toast', () => {
    const seen = [];
    lock.onLockToast((v) => seen.push(v));
    // A single drag across the waterfall, near enough.
    for (let i = 0; i < 40; i++) lock.refusedByLock(NOW + i);
    assert.deepStrictEqual(seen, [true]);
});

t('nothing more for thirty seconds', () => {
    const seen = [];
    lock.onLockToast((v) => seen.push(v));
    lock.refusedByLock(NOW);
    lock.refusedByLock(NOW + 29 * SEC);
    assert.deepStrictEqual(seen, [true]);
    lock.refusedByLock(NOW + 30 * SEC);
    assert.deepStrictEqual(seen, [true, true]);
});

t('the window runs from the toast shown, not from the last attempt', () => {
    // Otherwise somebody pressing steadily would never see it a second time,
    // because every attempt would push the window along in front of them.
    lock.refusedByLock(NOW);
    for (let i = 1; i < 30; i++) lock.refusedByLock(NOW + i * SEC);
    const seen = [];
    lock.onLockToast((v) => seen.push(v));
    lock.refusedByLock(NOW + 30 * SEC);
    assert.deepStrictEqual(seen, [true]);
});

// --- toggling the lock ---------------------------------------------------------

t('toggling clears the throttle, so a new lock explains itself at once', () => {
    lock.refusedByLock(NOW);
    lock.resetLockToast();
    const seen = [];
    lock.onLockToast((v) => seen.push(v));
    lock.refusedByLock(NOW + SEC);
    assert.deepStrictEqual(seen, [true]);
});

t('unlocking takes a visible toast down', () => {
    lock.refusedByLock(NOW);
    assert.strictEqual(lock.lockToastVisible(), true);
    const seen = [];
    lock.onLockToast((v) => seen.push(v));
    lock.resetLockToast();
    assert.strictEqual(lock.lockToastVisible(), false);
    assert.deepStrictEqual(seen, [false]);
});

t('a reset with nothing on screen tells nobody', () => {
    const seen = [];
    lock.onLockToast((v) => seen.push(v));
    lock.resetLockToast();
    assert.deepStrictEqual(seen, []);
});

// --- taking it away again ------------------------------------------------------

// The three-second timer is a real one, so this last case is awaited outside the
// harness above rather than faked. It is the only one that has to be: everything
// else here is decided by the timestamp it is handed.
(async () => {
    lock._resetTuneLock();
    const seen = [];
    lock.onLockToast((v) => seen.push(v));
    lock.refusedByLock(NOW);
    await new Promise((r) => setTimeout(r, 3200));
    try {
        assert.strictEqual(lock.lockToastVisible(), false);
        assert.deepStrictEqual(seen, [true, false]);
        console.log('ok    the toast takes itself away after three seconds');
        pass++;
    } catch (e) {
        console.log('FAIL  the toast takes itself away after three seconds\n      ' + e.message);
        process.exitCode = 1;
    }
    console.log(`\n${pass} passed`);
})();

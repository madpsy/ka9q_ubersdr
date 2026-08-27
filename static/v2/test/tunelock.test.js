// The tuning lock's toast.
//
// Two numbers carry the refusal half and both are easy to get wrong in a way
// nothing else would notice: the toast has to appear on the *first* refusal of a
// burst — a waterfall drag refuses dozens of times a second — and then say
// nothing for thirty, or it becomes a strobe rather than a message.
//
// The other half is the announcement, which is not throttled and must not be:
// throwing the lock happens once, deliberately, and possibly from a MIDI button
// or a bridge client nowhere near the padlock — so it is always answered, and
// the answer says which way it went.

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
    assert.strictEqual(lock.lockToastState(), null);
    assert.strictEqual(lock.lockToastVisible(), false);
    lock.refusedByLock(NOW);
    assert.strictEqual(lock.lockToastState(), 'locked');
    assert.strictEqual(lock.lockToastVisible(), true);
});

t('subscribers are told, and can unsubscribe', () => {
    const seen = [];
    const off = lock.onLockToast((v) => seen.push(v));
    lock.refusedByLock(NOW);
    assert.deepStrictEqual(seen, ['locked']);
    off();
    lock.refusedByLock(NOW + 60 * SEC);
    assert.deepStrictEqual(seen, ['locked']);
});

t('a subscriber that throws does not stop the others', () => {
    const seen = [];
    lock.onLockToast(() => { throw new Error('nope'); });
    lock.onLockToast((v) => seen.push(v));
    lock.refusedByLock(NOW);
    assert.deepStrictEqual(seen, ['locked']);
});

// --- the throttle --------------------------------------------------------------

t('a burst of refusals is one toast', () => {
    const seen = [];
    lock.onLockToast((v) => seen.push(v));
    // A single drag across the waterfall, near enough.
    for (let i = 0; i < 40; i++) lock.refusedByLock(NOW + i);
    assert.deepStrictEqual(seen, ['locked']);
});

t('nothing more for thirty seconds', () => {
    const seen = [];
    lock.onLockToast((v) => seen.push(v));
    lock.refusedByLock(NOW);
    lock.refusedByLock(NOW + 29 * SEC);
    assert.deepStrictEqual(seen, ['locked']);
    lock.refusedByLock(NOW + 30 * SEC);
    assert.deepStrictEqual(seen, ['locked', 'locked']);
});

t('the window runs from the toast shown, not from the last attempt', () => {
    // Otherwise somebody pressing steadily would never see it a second time,
    // because every attempt would push the window along in front of them.
    lock.refusedByLock(NOW);
    for (let i = 1; i < 30; i++) lock.refusedByLock(NOW + i * SEC);
    const seen = [];
    lock.onLockToast((v) => seen.push(v));
    lock.refusedByLock(NOW + 30 * SEC);
    assert.deepStrictEqual(seen, ['locked']);
});

// --- throwing the lock ---------------------------------------------------------

t('locking says so, in the same words a refusal uses', () => {
    // The point of reusing the message: whoever threw the lock and whoever runs
    // into it a minute later are being told the same thing about the same state.
    const seen = [];
    lock.onLockToast((v) => seen.push(v));
    lock.announceLock(true, NOW);
    assert.deepStrictEqual(seen, ['locked']);
    assert.strictEqual(lock.lockToastState(), 'locked');
});

t('unlocking says so too, and says the opposite', () => {
    const seen = [];
    lock.onLockToast((v) => seen.push(v));
    lock.announceLock(false, NOW);
    assert.deepStrictEqual(seen, ['unlocked']);
    assert.strictEqual(lock.lockToastState(), 'unlocked');
});

t('an announcement is never throttled', () => {
    // A refusal a moment ago must not swallow the operator's own press. This is
    // the one message that is always answered.
    const seen = [];
    lock.onLockToast((v) => seen.push(v));
    lock.refusedByLock(NOW);
    lock.announceLock(false, NOW + SEC);
    lock.announceLock(true, NOW + 2 * SEC);
    assert.deepStrictEqual(seen, ['locked', 'unlocked', 'locked']);
});

t('locking counts as having said it, so the next refusal does not repeat it', () => {
    // They have just read the words; the drag that runs into the lock a second
    // later does not need them again, which is what the throttle is for.
    lock.announceLock(true, NOW);
    const seen = [];
    lock.onLockToast((v) => seen.push(v));
    lock.refusedByLock(NOW + SEC);
    assert.deepStrictEqual(seen, []);
    lock.refusedByLock(NOW + 30 * SEC);
    assert.deepStrictEqual(seen, ['locked']);
});

t('unlocking clears the throttle, so a new lock explains itself at once', () => {
    lock.refusedByLock(NOW);
    lock.announceLock(false, NOW + SEC);
    const seen = [];
    lock.onLockToast((v) => seen.push(v));
    lock.refusedByLock(NOW + 2 * SEC);
    assert.deepStrictEqual(seen, ['locked']);
});

t('an announcement replaces whatever is on screen', () => {
    lock.refusedByLock(NOW);
    assert.strictEqual(lock.lockToastState(), 'locked');
    lock.announceLock(false, NOW + SEC);
    // "Tuning locked" left up after an unlock is a message that has become
    // untrue while it was being read.
    assert.strictEqual(lock.lockToastState(), 'unlocked');
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
        assert.strictEqual(lock.lockToastState(), null);
        assert.deepStrictEqual(seen, ['locked', null]);
        console.log('ok    the toast takes itself away after three seconds');
        pass++;
    } catch (e) {
        console.log('FAIL  the toast takes itself away after three seconds\n      ' + e.message);
        process.exitCode = 1;
    }
    console.log(`\n${pass} passed`);
})();

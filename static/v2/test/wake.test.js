// Wake-on-use: when touching a control powers the receiver back on.
//
// Each of these is a session the operator did not ask for, or an audio context
// that never gets its gesture, so the rule is pinned rather than left to the
// three refs it reads in RadioContext.

const assert = require('assert');
const { shouldWake } = require('./.build/wake.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// The state after an idle timeout: started earlier in the visit, stopped since,
// nothing connecting. The only combination that wakes.
const OFF = { running: false, connecting: false, everStarted: true };

t('a control touched on a stopped receiver wakes it', () => {
    assert.strictEqual(shouldWake(OFF), true);
});

t('a running receiver is left alone, so a touch cannot mint a second session', () => {
    assert.strictEqual(shouldWake({ ...OFF, running: true }), false);
});

t('a wake already connecting is not joined by the rest of the drag', () => {
    assert.strictEqual(shouldWake({ ...OFF, connecting: true }), false);
});

t('the first session of a visit belongs to the Start overlay', () => {
    assert.strictEqual(shouldWake({ ...OFF, everStarted: false }), false);
});

t('never started and never stopped is still the overlay\'s, not a wake', () => {
    assert.strictEqual(
        shouldWake({ running: false, connecting: false, everStarted: undefined }),
        false,
    );
});

console.log(`\n${pass} passed`);

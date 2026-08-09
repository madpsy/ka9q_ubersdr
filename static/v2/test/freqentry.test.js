// Asking for the frequency box from somewhere that cannot reach it.
//
// The box is local state inside TopBar and the callers are ShortcutWatch and the
// control surfaces, so the two only meet through this list. What is worth pinning
// is the answer when nobody is listening — a phone on its side has no top bar, and
// a key that silently does nothing is the failure mode — and that unsubscribing
// really unsubscribes, since the bar remounts whenever the shell changes.

const assert = require('assert');
const fe = require('./.build/freqentry.cjs');

let pass = 0;
const t = (name, fn) => {
    fe._resetFreqEntry();
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

t('a request with nothing listening says so', () => {
    assert.strictEqual(fe.requestFreqEntry(), false);
});

t('the listener is called, and the request reports that it landed', () => {
    let opened = 0;
    fe.onFreqEntry(() => { opened += 1; });
    assert.strictEqual(fe.requestFreqEntry(), true);
    assert.strictEqual(opened, 1);
});

t('unsubscribing stops the calls', () => {
    let opened = 0;
    const off = fe.onFreqEntry(() => { opened += 1; });
    off();
    assert.strictEqual(fe.requestFreqEntry(), false);
    assert.strictEqual(opened, 0);
    // An effect cleanup that runs twice must not be an error.
    off();
});

t('a listener that throws does not swallow the others', () => {
    const errors = console.error;
    console.error = () => {};
    let opened = 0;
    try {
        fe.onFreqEntry(() => { throw new Error('boom'); });
        fe.onFreqEntry(() => { opened += 1; });
        assert.strictEqual(fe.requestFreqEntry(), true);
    } finally {
        console.error = errors;
    }
    assert.strictEqual(opened, 1);
});

if (process.exitCode) console.log('\nfrequency entry tests FAILED');
else console.log(`\nall ${pass} frequency entry tests passed`);

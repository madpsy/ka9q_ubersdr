// The squelch's open/closed state, shared by the main receiver and every VFO
// listened to beside it — radio/squelchState.js.

const assert = require('assert');
const { squelchState, squelchBrightens } = require('./.build/squelchstate.cjs');
const { SQUELCH_HANG_MS } = require('./.build/constants.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

t('the hang is the server\'s 500 ms', () => {
    assert.strictEqual(SQUELCH_HANG_MS, 500);
});

t('at or over the threshold it is open, and the hang restarts', () => {
    assert.deepStrictEqual(squelchState({ snr: 10, threshold: 10, now: 1000, lastOpenAt: 0 }), { open: true, lastOpenAt: 1000 });
    assert.deepStrictEqual(squelchState({ snr: 12, threshold: 10, now: 2000, lastOpenAt: 0 }), { open: true, lastOpenAt: 2000 });
});

t('under the threshold it stays open for the hang, then closes', () => {
    const at = 1000;
    assert.deepStrictEqual(squelchState({ snr: 3, threshold: 10, now: at + 499, lastOpenAt: at }), { open: true, lastOpenAt: at });
    assert.deepStrictEqual(squelchState({ snr: 3, threshold: 10, now: at + 500, lastOpenAt: at }), { open: false, lastOpenAt: at });
});

t('no reading counts as under the threshold', () => {
    assert.strictEqual(squelchState({ snr: null, threshold: 10, now: 5000, lastOpenAt: 0 }).open, false);
});

t('squelch off is always open', () => {
    assert.deepStrictEqual(squelchState({ snr: -40, threshold: null, now: 9000, lastOpenAt: 0 }), { open: true, lastOpenAt: 9000 });
});

t('IQ is held open whatever the threshold says', () => {
    assert.deepStrictEqual(squelchState({ snr: -40, threshold: 30, iq: true, now: 9000, lastOpenAt: 0 }), { open: true, lastOpenAt: 9000 });
});

t('the passband brightens only for a set squelch that is open, never in IQ', () => {
    assert.strictEqual(squelchBrightens({ enabled: true, open: true }), true);
    assert.strictEqual(squelchBrightens({ enabled: true, open: false }), false);
    assert.strictEqual(squelchBrightens({ enabled: false, open: true }), false);
    assert.strictEqual(squelchBrightens({ enabled: true, open: true, iq: true }), false);
});

if (!process.exitCode) console.log(`\n${pass} passed`);

// The session countdown: the three states, and when it is worth a timer.
//
// Two places on screen show this now — the top bar and the Receiver info panel
// — and both read it from here, so what is pinned is the thing that would let
// them disagree: the boundary at five minutes, and what "no limit" and "no
// session" each look like.

const assert = require('assert');
const { LOW_SEC, formatLeft, sessionClock, sessionTicks } = require('./.build/sessionclock.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const START = 1_000_000_000_000;
const running = (maxSec) => ({ maxSec, startedAt: START });

// --- the three states -------------------------------------------------------

t('no session yet is a dash, not a countdown from nowhere', () => {
    const c = sessionClock({ maxSec: null, startedAt: 0 }, START);
    assert.strictEqual(c.state, 'none');
    assert.strictEqual(c.label, '—');
    assert.strictEqual(c.low, false);
    assert.strictEqual(sessionClock(null, START).state, 'none');
    assert.strictEqual(sessionClock(undefined, START).state, 'none');
});

t('no limit is said in a word', () => {
    const c = sessionClock(running(0), START);
    assert.strictEqual(c.state, 'unlimited');
    assert.strictEqual(c.label, 'Unlimited');
    assert.strictEqual(c.low, false);
});

t('a limit with no start time is no countdown, not an expired one', () => {
    // Clamping would give 00:00:00, which reads as "your session has ended" —
    // wrong, and alarming, when all that is missing is the start moment.
    const c = sessionClock({ maxSec: 3600, startedAt: 0 }, START);
    assert.strictEqual(c.state, 'none');
    assert.strictEqual(c.label, '—');
});

// --- counting ---------------------------------------------------------------

t('it counts down from the limit', () => {
    assert.strictEqual(sessionClock(running(3600), START).label, '01:00:00');
    assert.strictEqual(sessionClock(running(3600), START + 60_000).label, '00:59:00');
    assert.strictEqual(sessionClock(running(3600), START + 3599_000).label, '00:00:01');
});

t('an overrun stops at zero rather than going negative', () => {
    const c = sessionClock(running(60), START + 600_000);
    assert.strictEqual(c.left, 0);
    assert.strictEqual(c.label, '00:00:00');
});

t('a clock that has run backwards does not show more time than the limit', () => {
    // A machine that resynchronised its clock, or a session object from before
    // a suspend. More time than the server granted is the one answer that
    // cannot be right.
    const c = sessionClock(running(3600), START - 600_000);
    assert.ok(c.left <= 3600, `${c.left} is more than the limit`);
});

t('the parts are padded, so the reading does not change width as it counts', () => {
    assert.strictEqual(formatLeft(0), '00:00:00');
    assert.strictEqual(formatLeft(9), '00:00:09');
    assert.strictEqual(formatLeft(61), '00:01:01');
    assert.strictEqual(formatLeft(3661), '01:01:01');
    assert.strictEqual(formatLeft(36000), '10:00:00');
});

t('a nonsense duration formats rather than throwing', () => {
    assert.strictEqual(formatLeft(-5), '00:00:00');
    assert.strictEqual(formatLeft(null), '00:00:00');
    assert.strictEqual(formatLeft(undefined), '00:00:00');
});

// --- the warning ------------------------------------------------------------

t('the last five minutes are the alarming ones, on the boundary too', () => {
    assert.strictEqual(LOW_SEC, 300);
    const low = (left) => sessionClock(running(3600), START + (3600 - left) * 1000).low;
    assert.strictEqual(low(301), false);
    assert.strictEqual(low(300), false);   // exactly five minutes is not yet low
    assert.strictEqual(low(299), true);
    assert.strictEqual(low(0), true);
});

t('a session shorter than the warning is not born red for no reason', () => {
    // It is red because it is nearly over, and a four-minute session is nearly
    // over the moment it starts. Stated rather than assumed: this is the one
    // case where "low from the first second" is correct.
    assert.strictEqual(sessionClock(running(240), START).low, true);
});

// --- whether to run a timer -------------------------------------------------

t('only a counting session is worth a timer', () => {
    // "Unlimited" and "—" never change, and a panel redrawing once a second to
    // repaint the same word is a wakeup a second for as long as it is open.
    assert.strictEqual(sessionTicks(running(3600)), true);
    assert.strictEqual(sessionTicks(running(0)), false);
    assert.strictEqual(sessionTicks({ maxSec: null, startedAt: 0 }), false);
    assert.strictEqual(sessionTicks({ maxSec: 3600, startedAt: 0 }), false);
});

console.log(`\n${pass} passed`);

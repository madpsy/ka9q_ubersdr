// Idle detection rules.
//
// The consequence of getting these wrong is not visible in the UI: too eager
// and the operator is asked "are you still there?" while typing, too slack and
// their session is reclaimed with no warning at all — or never reclaimed, which
// is how one idle tab holds a receiver slot all evening.

const assert = require('assert');
const {
    CONFIRM_MS, DEFAULT_IDLE_SEC, PING_EVERY_MS,
    THROTTLE_CHOICES, THROTTLE_MIN_MOBILE, THROTTLE_MIN_DESKTOP,
    idlePhrase, shouldPing, throttleAfterMs, throttleMinutes, warnAfterMs,
} = require('./.build/idle.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

t('the warning lands 30 seconds before the server would drop the session', () => {
    // v1's rule: session_timeout of 300 s warns at 4m30.
    assert.strictEqual(warnAfterMs(300), 270000);
    assert.strictEqual(warnAfterMs(60), 30000);
});

t('only an explicit zero means no warning', () => {
    // 0 is the server saying "this client is bypassed" or "no timeout set".
    assert.strictEqual(warnAfterMs(0), null);
    assert.strictEqual(warnAfterMs(-5), null);
});

t('a reply we could not read falls back rather than assuming no timeout', () => {
    // Assuming none would mean the session is dropped with no warning at all.
    assert.strictEqual(warnAfterMs(null), warnAfterMs(DEFAULT_IDLE_SEC));
    assert.strictEqual(warnAfterMs(undefined), warnAfterMs(DEFAULT_IDLE_SEC));
    assert.strictEqual(warnAfterMs(NaN), warnAfterMs(DEFAULT_IDLE_SEC));
});

t('a timeout too short for the warning still gets one', () => {
    // Being disconnected without notice reads as a fault, so v1 shows the
    // dialog at once rather than skipping it.
    assert.strictEqual(warnAfterMs(30), 1000);
    assert.strictEqual(warnAfterMs(10), 1000);
    assert.ok(CONFIRM_MS === 30000);
});

t('a ping goes out at most every 10 seconds while somebody is working', () => {
    const now = 1000000;
    // Just pinged, still active: nothing to send.
    assert.strictEqual(shouldPing(now, now - 1000, now - 1000), false);
    assert.strictEqual(shouldPing(now, now - PING_EVERY_MS, now - 500), true);
});

t('coming back after a spell away pings immediately', () => {
    const now = 1000000;
    // Pinged a second ago, but the last activity was a minute ago: the server
    // is told somebody is back without waiting out the throttle.
    assert.strictEqual(shouldPing(now, now - 1000, now - 60000), true);
});

t('an unset throttle takes this device\'s default, sooner on mobile', () => {
    // The stored value has to mean the right thing on a phone and on a desktop
    // without the two disagreeing, so "not chosen" is a value of its own.
    assert.strictEqual(throttleMinutes(null, true), THROTTLE_MIN_MOBILE);
    assert.strictEqual(throttleMinutes(null, false), THROTTLE_MIN_DESKTOP);
    assert.strictEqual(throttleMinutes(undefined, false), THROTTLE_MIN_DESKTOP);
    assert.ok(THROTTLE_MIN_MOBILE < THROTTLE_MIN_DESKTOP);
    // ...and both defaults are on the list, or the control could not show them.
    assert.ok(THROTTLE_CHOICES.includes(THROTTLE_MIN_MOBILE));
    assert.ok(THROTTLE_CHOICES.includes(THROTTLE_MIN_DESKTOP));
});

t('a chosen delay is the same on either device', () => {
    for (const m of THROTTLE_CHOICES) {
        assert.strictEqual(throttleMinutes(m, true), m);
        assert.strictEqual(throttleMinutes(m, false), m);
    }
});

t('never is a choice, not an absence', () => {
    // 0 has to survive the "not chosen" test, or turning the throttle off would
    // silently be read as never having been asked and put back to the default.
    assert.strictEqual(throttleMinutes(0, true), 0);
    assert.strictEqual(throttleAfterMs(0, true), null, 'null arms no timer at all');
    assert.strictEqual(throttleAfterMs(0, false), null);
});

t('a delay off the list is not honoured', () => {
    // A stored value from a build with different rungs, or a hand-edited one:
    // the control could not show it, so it must not be what is running.
    assert.strictEqual(throttleMinutes(7, false), THROTTLE_MIN_DESKTOP);
    assert.strictEqual(throttleMinutes(-1, false), THROTTLE_MIN_DESKTOP);
    assert.strictEqual(throttleMinutes('soon', false), THROTTLE_MIN_DESKTOP);
    // The trap this exists for: Number(null) is 0, which is itself a valid
    // choice meaning never — so an unset setting must not be coerced on the way
    // in, or it would read as the operator having switched the throttle off.
    assert.strictEqual(throttleMinutes('0', false), THROTTLE_MIN_DESKTOP);
    assert.strictEqual(throttleMinutes(false, false), THROTTLE_MIN_DESKTOP);
});

t('the delay reaches the timer in milliseconds', () => {
    assert.strictEqual(throttleAfterMs(2, false), 120000);
    assert.strictEqual(throttleAfterMs(30, false), 1800000);
    assert.strictEqual(throttleAfterMs(null, true), THROTTLE_MIN_MOBILE * 60000);
});

t('the dialog says how long it has been, in words', () => {
    assert.strictEqual(idlePhrase(1000), '1 second');
    assert.strictEqual(idlePhrase(45000), '45 seconds');
    assert.strictEqual(idlePhrase(60000), '1 minute and 0 seconds');
    assert.strictEqual(idlePhrase(125000), '2 minutes and 5 seconds');
    assert.strictEqual(idlePhrase(-5), '0 seconds');
});

console.log(`\n${pass} idle checks passed`);

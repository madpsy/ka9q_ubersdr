// Idle detection rules.
//
// The consequence of getting these wrong is not visible in the UI: too eager
// and the operator is asked "are you still there?" while typing, too slack and
// their session is reclaimed with no warning at all — or never reclaimed, which
// is how one idle tab holds a receiver slot all evening.

const assert = require('assert');
const {
    CONFIRM_MS, DEFAULT_IDLE_SEC, PING_EVERY_MS, THROTTLE_MS_MOBILE, THROTTLE_MS_DESKTOP,
    idlePhrase, shouldPing, throttleAfterMs, warnAfterMs,
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

t('mobile throttles the spectrum sooner than desktop', () => {
    assert.strictEqual(throttleAfterMs(true), THROTTLE_MS_MOBILE);
    assert.strictEqual(throttleAfterMs(false), THROTTLE_MS_DESKTOP);
    assert.ok(THROTTLE_MS_MOBILE < THROTTLE_MS_DESKTOP);
});

t('the dialog says how long it has been, in words', () => {
    assert.strictEqual(idlePhrase(1000), '1 second');
    assert.strictEqual(idlePhrase(45000), '45 seconds');
    assert.strictEqual(idlePhrase(60000), '1 minute and 0 seconds');
    assert.strictEqual(idlePhrase(125000), '2 minutes and 5 seconds');
    assert.strictEqual(idlePhrase(-5), '0 seconds');
});

console.log(`\n${pass} idle checks passed`);

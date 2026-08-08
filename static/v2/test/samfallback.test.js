// SAM giving up on a carrier that has gone away.
//
// The interesting part is what counts as evidence. "No packets for two seconds"
// is the obvious test and it is wrong: ka9q-radio sends silence continuously, so
// packet arrivals look identical on a dead band and a strong one. What stops is
// the *movement* of basebandPower, and that is what these pin.

const assert = require('assert');
const {
    CHECK_MS, FALLBACK_MS, createWatch, notePower, resetWatch, shouldFallBack,
} = require('./.build/samfallback.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

t('nothing seen yet is not silence', () => {
    // Unknown, not quiet. Switching mode on no evidence at all is worse than
    // waiting for some — and this is the state every mode change resets to.
    const w = createWatch();
    assert.strictEqual(shouldFallBack(w, 'sam', 1e9), false);
});

t('a figure that keeps moving keeps SAM', () => {
    const w = createWatch();
    let now = 1000;
    for (let i = 0; i < 20; i++) {
        notePower(w, -40 - i * 0.01, now);
        now += 200;
        assert.strictEqual(shouldFallBack(w, 'sam', now), false, `moved at ${now}`);
    }
});

t('a figure holding still for two seconds gives up', () => {
    const w = createWatch();
    notePower(w, -95.5, 1000);
    // Repeats change nothing, which is the whole mechanism: silence is the same
    // float over and over.
    for (const at of [1200, 1400, 1600, 1800, 2400]) notePower(w, -95.5, at);
    assert.strictEqual(shouldFallBack(w, 'sam', 1000 + FALLBACK_MS - 1), false);
    assert.strictEqual(shouldFallBack(w, 'sam', 1000 + FALLBACK_MS), true);
});

t('only in SAM', () => {
    const w = createWatch();
    notePower(w, -95.5, 1000);
    const late = 1000 + FALLBACK_MS + 5000;
    assert.strictEqual(shouldFallBack(w, 'sam', late), true);
    for (const mode of ['am', 'usb', 'lsb', 'nfm', '', null]) {
        assert.strictEqual(shouldFallBack(w, mode, late), false, `mode ${mode}`);
    }
    // Case is the server's business, not ours.
    assert.strictEqual(shouldFallBack(w, 'SAM', late), true);
});

t('a mode change means starting again', () => {
    // Without this, switching into SAM after a quiet spell in AM would fall
    // straight back out on the strength of readings taken in another mode.
    const w = createWatch();
    notePower(w, -95.5, 1000);
    const late = 1000 + FALLBACK_MS + 1;
    assert.strictEqual(shouldFallBack(w, 'sam', late), true);
    resetWatch(w);
    assert.strictEqual(shouldFallBack(w, 'sam', late), false);
    // And it takes a fresh reading, then a fresh two seconds.
    notePower(w, -95.5, late);
    assert.strictEqual(shouldFallBack(w, 'sam', late + FALLBACK_MS - 1), false);
    assert.strictEqual(shouldFallBack(w, 'sam', late + FALLBACK_MS), true);
});

t('a change reports itself, a repeat does not', () => {
    const w = createWatch();
    assert.strictEqual(notePower(w, -40, 1000), true);
    assert.strictEqual(notePower(w, -40, 1200), false, 'the same float is not news');
    assert.strictEqual(notePower(w, -40.0001, 1400), true);
    // The clock only moved on the changes.
    assert.strictEqual(w.at, 1400);
});

t('a missing or broken figure is ignored, not treated as a change', () => {
    // A packet without the v2 header carries no power at all. Counting that as
    // movement would keep SAM alive on exactly the silence it is watching for.
    const w = createWatch();
    notePower(w, -95.5, 1000);
    for (const bad of [null, undefined, NaN, Infinity]) {
        assert.strictEqual(notePower(w, bad, 5000), false, `${bad} should be ignored`);
    }
    assert.strictEqual(w.at, 1000, 'the clock did not move');
    assert.strictEqual(shouldFallBack(w, 'sam', 1000 + FALLBACK_MS), true);
});

t('the check runs comfortably inside the window it is watching', () => {
    assert.ok(CHECK_MS < FALLBACK_MS / 2,
        'a check no finer than the window would report the switch up to a window late');
});

console.log(`\n${pass} passed`);

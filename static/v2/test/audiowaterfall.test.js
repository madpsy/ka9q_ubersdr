// The audio waterfall's scroll rate.
//
// Only the arithmetic: the drawing needs a canvas. This is the part that can
// fail quietly — it divides, so a bad rate does not throw, it stops the
// waterfall dead with nothing on screen to say why.

const assert = require('assert');
const {
    AUDIO_WF_RATE_MAX, AUDIO_WF_RATE_MIN, audioRowMs,
} = require('./.build/audiowaterfall.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

t('a rate becomes the gap between rows', () => {
    assert.strictEqual(audioRowMs(30), 1000 / 30);
    assert.strictEqual(audioRowMs(10), 100);
    assert.strictEqual(audioRowMs(2), 500);
});

t('faster means a shorter gap', () => {
    assert.ok(audioRowMs(40) < audioRowMs(10), 'the slider would work backwards');
});

t('a rate outside the slider is pulled back into it', () => {
    assert.strictEqual(audioRowMs(1000), 1000 / AUDIO_WF_RATE_MAX);
    assert.strictEqual(audioRowMs(0.001), 1000 / AUDIO_WF_RATE_MIN);
});

t('a missing or nonsense rate falls back rather than freezing', () => {
    // Infinity here is a waterfall that never commits a row: no error, no
    // drawing, and nothing to connect it to the speed setting.
    for (const bad of [0, -5, null, undefined, NaN, 'fast', {}]) {
        const ms = audioRowMs(bad);
        assert.ok(Number.isFinite(ms) && ms > 0, `${String(bad)} gave ${ms}`);
    }
    assert.strictEqual(audioRowMs(undefined), 1000 / 30, 'the v1 default');
});

console.log(`\n${pass} ok`);

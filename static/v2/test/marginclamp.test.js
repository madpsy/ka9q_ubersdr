// Validation of the reduced-depth margin, on the browser side.
//
// The server clamps whatever it is sent (pcm_lossy.go, LossyMarginFromQuery), so
// nothing here can produce a broken stream. What these check is that the client
// does not ASK for something different from what it will get: a slider that runs
// past the server's range, or a saved preference that silently turns the lossy
// mode on, are both bugs the server cannot see.
//
// The numeric values are pinned deliberately. They are duplicated on the Go side
// and there is no build-time link between the two, so a change to one must fail
// here rather than drift quietly into a UI that mis-states what it is requesting.

const assert = require('assert');
const {
    clampMargin, marginFromSlider, sliderFromMargin,
    MARGIN_MIN_DB, MARGIN_MAX_DB, MARGIN_DEFAULT_DB, MARGIN_LOSSLESS, MARGIN_STEP_DB,
} = require('./.build/marginclamp.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

t('the range matches the server clamp in pcm_lossy.go', () => {
    assert.strictEqual(MARGIN_MIN_DB, 15, 'lossyMinMarginDB is 15');
    assert.strictEqual(MARGIN_MAX_DB, 60, 'lossyMaxMarginDB is 60');
});

t('the default sits inside the range', () => {
    assert.ok(MARGIN_DEFAULT_DB >= MARGIN_MIN_DB && MARGIN_DEFAULT_DB <= MARGIN_MAX_DB,
        `default ${MARGIN_DEFAULT_DB} outside ${MARGIN_MIN_DB}..${MARGIN_MAX_DB}`);
});

// Zero is the lossless path, and it must stay reachable: it is what every
// client that has not asked for the mode gets, and what the stream falls back
// to when a preference cannot be read.
t('anything unusable becomes lossless rather than the default', () => {
    for (const bad of [undefined, null, NaN, Infinity, -Infinity, 'abc', {}, [], -5, 0, '']) {
        assert.strictEqual(clampMargin(bad), 0, `clampMargin(${JSON.stringify(bad)})`);
    }
});

t('a value below the range is raised, not rejected', () => {
    assert.strictEqual(clampMargin(1), MARGIN_MIN_DB);
    assert.strictEqual(clampMargin(14.9), MARGIN_MIN_DB);
});

t('a value above the range is capped', () => {
    assert.strictEqual(clampMargin(61), MARGIN_MAX_DB);
    assert.strictEqual(clampMargin(1e9), MARGIN_MAX_DB);
});

t('a value inside the range survives, as an integer', () => {
    assert.strictEqual(clampMargin(20), 20);
    assert.strictEqual(clampMargin(26), 26);
    assert.strictEqual(clampMargin(60), 60);
    assert.strictEqual(clampMargin(26.4), 26);
    assert.strictEqual(clampMargin('26'), 26);
});

// The slider steps in 2 dB; every position it can produce must be a value the
// server will honour unchanged, or the readout lies about what was requested.
t('every slider position round trips unchanged', () => {
    for (let v = MARGIN_MIN_DB; v <= MARGIN_MAX_DB; v += 2) {
        assert.strictEqual(clampMargin(v), v, `slider position ${v}`);
    }
});

// The top of the slider is lossless, and is where an untouched control sits.
// This is the promise that "Lossless" means lossless: a listener who
// never touches the slider must ask for nothing at all.
// The step has to divide the distance to the top exactly. A range input only
// offers min + n*step, so a step that overshoots leaves the lossless position
// drawn at the end of the track but impossible to select -- which is what
// happened when the floor moved from 20 to 15 while the step was still 2.
t('the lossless position is actually reachable on the slider', () => {
    assert.strictEqual((MARGIN_LOSSLESS - MARGIN_MIN_DB) % MARGIN_STEP_DB, 0,
        `stepping ${MARGIN_STEP_DB} from ${MARGIN_MIN_DB} never lands on ${MARGIN_LOSSLESS}`);
    // Walk the track the way the browser will, and check the top is hit.
    let v = MARGIN_MIN_DB;
    const seen = [];
    while (v <= MARGIN_LOSSLESS) { seen.push(v); v += MARGIN_STEP_DB; }
    assert.strictEqual(seen[seen.length - 1], MARGIN_LOSSLESS,
        'the last selectable position is not the lossless one');
    assert.strictEqual(marginFromSlider(seen[seen.length - 1]), 0);
});

t('the floor is selectable and asks for the floor', () => {
    assert.strictEqual(marginFromSlider(MARGIN_MIN_DB), MARGIN_MIN_DB);
});

t('the top of the scale is lossless', () => {
    assert.strictEqual(MARGIN_LOSSLESS, MARGIN_MAX_DB + MARGIN_STEP_DB);
    assert.strictEqual(marginFromSlider(MARGIN_LOSSLESS), 0);
    assert.strictEqual(marginFromSlider(MARGIN_LOSSLESS + 10), 0);
});

t('an unset preference draws the slider at lossless', () => {
    for (const unset of [undefined, null, 0, NaN, '']) {
        assert.strictEqual(sliderFromMargin(unset), MARGIN_LOSSLESS,
            `sliderFromMargin(${JSON.stringify(unset)})`);
    }
});

t('every position below the top asks for a real margin', () => {
    for (let v = MARGIN_MIN_DB; v <= MARGIN_MAX_DB; v += MARGIN_STEP_DB) {
        const asked = marginFromSlider(v);
        assert.strictEqual(asked, v, `slider ${v}`);
        assert.ok(asked >= MARGIN_MIN_DB && asked <= MARGIN_MAX_DB, `slider ${v} out of range`);
    }
});

t('the control round trips through the stored setting', () => {
    for (let v = MARGIN_MIN_DB; v <= MARGIN_LOSSLESS; v += MARGIN_STEP_DB) {
        assert.strictEqual(sliderFromMargin(marginFromSlider(v)), v, `position ${v}`);
    }
});

t('the recommended value is reachable from the slider', () => {
    assert.strictEqual((MARGIN_DEFAULT_DB - MARGIN_MIN_DB) % MARGIN_STEP_DB, 0,
        `${MARGIN_DEFAULT_DB} dB is not on a slider step`);
    assert.strictEqual(marginFromSlider(MARGIN_DEFAULT_DB), MARGIN_DEFAULT_DB);
});

console.log(`\n${pass} passing`);

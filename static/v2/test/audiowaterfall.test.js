// The audio waterfall's scroll rate.
//
// Only the arithmetic: the drawing needs a canvas. This is the part that can
// fail quietly — it divides, so a bad rate does not throw, it stops the
// waterfall dead with nothing on screen to say why.

const assert = require('assert');
// Enough browser for cssVar, which is the other thing in this module worth
// pinning. Set before the bundle: the module reads nothing at import time, but
// the tests below call straight into it.
const theme = { theme: 'dark' };
const vars = { '--accent': '#08a2fb' };
globalThis.document = { documentElement: { dataset: theme } };
globalThis.getComputedStyle = () => ({ getPropertyValue: (n) => vars[n] || '' });

const {
    AUDIO_WF_RATE_MAX, AUDIO_WF_RATE_MIN, audioRowMs, barWidth, cssVar, invalidateCssVars,
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
    // The default is the top of the range: one row per analyser frame.
    assert.strictEqual(audioRowMs(undefined), 1000 / AUDIO_WF_RATE_MAX);
});

// The bar view's resolution steps.
//
// The failure this guards against is the whole reason widths are used rather
// than bin counts: if two settings land on the same number of bars, the
// Resolution control looks broken in the bar view — you press it and nothing
// moves. So it is not enough that the widths differ, the bar counts they
// produce have to differ too, at every panel width and pixel ratio.

// What drawAudioBars does with the width, kept in step with it by the assertion
// below that Balanced still gives the count the bars have always had.
const barCount = (fftSize, cssWidth, dpr) => {
    const target = Math.max(2, Math.round(barWidth(fftSize) * dpr));
    const gap = target >= 8 && dpr >= 2 ? 2 : 1;
    return Math.max(1, Math.floor(Math.round(cssWidth * dpr) / (target + gap)));
};

const SIZES = [2048, 4096, 8192, 16384];

t('finer resolution means narrower bars', () => {
    for (let i = 1; i < SIZES.length; i++) {
        assert.ok(
            barWidth(SIZES[i]) < barWidth(SIZES[i - 1]),
            `${SIZES[i]} is not narrower than ${SIZES[i - 1]}`,
        );
    }
});

t('every step is a visibly different number of bars', () => {
    // Narrow phone panel through to a wide desktop one, at both pixel ratios.
    for (const cssWidth of [240, 300, 340, 420, 700]) {
        for (const dpr of [1, 2]) {
            const counts = SIZES.map((f) => barCount(f, cssWidth, dpr));
            for (let i = 1; i < counts.length; i++) {
                assert.ok(
                    counts[i] > counts[i - 1] * 1.2,
                    `${cssWidth}px @${dpr}x: ${SIZES[i - 1]} gave ${counts[i - 1]} bars, `
                    + `${SIZES[i]} gave ${counts[i]} — the control would look dead`,
                );
            }
        }
    }
});

t('the default resolution leaves the bars as they were', () => {
    // 7 CSS px is what drawAudioBars used before the width became a setting.
    // Changing it would move the default look for everyone.
    assert.strictEqual(barWidth(4096), 7);
});

t('an unknown fft size draws rather than vanishing', () => {
    // A stored setting from an older build, or a size the picker no longer
    // offers. A width of 0 or NaN here is a blank canvas, not a wrong one.
    for (const bad of [1024, 0, null, undefined, NaN, 'max', {}]) {
        const px = barWidth(bad);
        assert.ok(Number.isFinite(px) && px > 0, `${String(bad)} gave ${px}`);
    }
});


// --- the colour cache --------------------------------------------------------
//
// Every canvas in the interface reads its colours through cssVar, and it caches
// them because getComputedStyle inside a draw loop costs more than the drawing.
// The key is the theme, which was enough while the values came only from the
// stylesheet — and stopped being enough when the accent became settable and the
// interface grew nine colour schemes, eight of them dark.

t('a colour is read once and then remembered', () => {
    invalidateCssVars();
    assert.strictEqual(cssVar('--accent', '#000'), '#08a2fb');
    // The whole point of the cache: a second read does not go near the DOM.
    let reads = 0;
    const real = globalThis.getComputedStyle;
    globalThis.getComputedStyle = () => { reads++; return real(); };
    assert.strictEqual(cssVar('--accent', '#000'), '#08a2fb');
    assert.strictEqual(reads, 0, 'the cache was not used');
    globalThis.getComputedStyle = real;
});

t('changing the theme drops it', () => {
    invalidateCssVars();
    cssVar('--accent', '#000');
    vars['--accent'] = '#ff0000';
    theme.theme = 'light';
    assert.strictEqual(cssVar('--accent', '#000'), '#ff0000');
});

t('a colour that changed without the theme changing reaches the canvas', () => {
    // The bug this exists for. Eight of the nine schemes are dark, so switching
    // between two of them rewrites --accent while data-theme stays "dark" — the
    // key does not move, the cache is never dropped, and every canvas keeps the
    // previous scheme's colours until the page is reloaded. DisplayContext calls
    // the invalidator from the effect that writes the colours.
    invalidateCssVars();
    theme.theme = 'dark';
    assert.strictEqual(cssVar('--accent', '#000'), '#ff0000');
    vars['--accent'] = '#00ff00';
    assert.strictEqual(cssVar('--accent', '#000'), '#ff0000', 'the cache should still hold');
    invalidateCssVars();
    assert.strictEqual(cssVar('--accent', '#000'), '#00ff00', 'the canvas is stuck on the old scheme');
});

t('a token the stylesheet does not define falls back', () => {
    invalidateCssVars();
    assert.strictEqual(cssVar('--nothing-here', '#abc'), '#abc');
});

t('the colours are invalidated wherever they are written', () => {
    // A source check, because the bug is a *missing call*: the cache and the
    // effect that changes the colours are in different files, and nothing in
    // either would notice the other not being told.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'display', 'DisplayContext.jsx'), 'utf8',
    );
    assert.ok(/invalidateCssVars\(\)/.test(src),
        'DisplayContext writes the colours but never drops the cssVar cache');
    // Beside the spectrum's own, which has the same problem and the same answer.
    assert.ok(/invalidateThemeColors\(\)/.test(src));
});

console.log(`\n${pass} ok`);

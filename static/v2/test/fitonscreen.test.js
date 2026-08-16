// Keeping a floating window on a page that has just got shorter.
//
// The property that matters is that this is a *drawing* correction: it must be
// exactly reversible, so a window pulled up by a keyboard goes back where it
// was put when the keyboard goes. That is why nothing here writes anything —
// and why "already on screen" has to be the identity.

const assert = require('assert');
const { fitX, fitY, KEEP_VISIBLE } = require('./.build/fitonscreen.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

t('a window that fits is left exactly where it was put', () => {
    assert.strictEqual(fitY(100, 300, 1000), 100);
    assert.strictEqual(fitX(80, 400, 1200), 80);
});

t('a window below a shortened page is pulled up to sit in it', () => {
    // 300 tall at y=800 on a 593 tall page: it should end at 293, fully visible.
    assert.strictEqual(fitY(800, 300, 593), 293);
});

t('a window taller than the page keeps its top rather than its bottom', () => {
    // Nothing can show all of it, and the top is where the header and the first
    // controls are.
    assert.strictEqual(fitY(400, 900, 593), 0);
});

t('a window is never pushed off the top', () => {
    assert.strictEqual(fitY(-50, 200, 800), 0);
});

t('a window with no height still keeps its header on screen', () => {
    assert.strictEqual(fitY(900, 0, 500), 500 - KEEP_VISIBLE);
});

t('the same rules sideways', () => {
    assert.strictEqual(fitX(900, 300, 600), 300);
    assert.strictEqual(fitX(900, 800, 600), 0);
});

t('an unmeasured viewport changes nothing', () => {
    assert.strictEqual(fitY(500, 200, 0), 500);
    assert.strictEqual(fitX(500, 200, 0), 500);
});

console.log(`${pass} ok`);

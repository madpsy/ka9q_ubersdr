// Keeping the focused field above the keyboard.
//
// The arithmetic is what these cover, because it is what decides whether the
// interface twitches. "Already visible" has to be exactly zero — a reveal that
// fires on every focus and moves the list by a pixel is worse than no reveal —
// and a field taller than the gap above the keys has to resolve to something
// rather than to a scroll that hides the line being typed.

const assert = require('assert');
const { revealBy, visibleBox, isTextEntry, GAP } = require('./.build/keyboardreveal.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const rect = (top, bottom) => ({ top, bottom });
const view = rect(0, 400);          // 400 px visible, keyboard below

// --- how far to move ---------------------------------------------------------

t('a field already in view is not moved at all', () => {
    assert.strictEqual(revealBy(rect(100, 140), view), 0);
});

t('a field under the keyboard is lifted just clear of it', () => {
    // Bottom at 500 against a 400 px region with a 12 px gap: 112 to move.
    assert.strictEqual(revealBy(rect(460, 500), view), 500 - (400 - GAP));
});

t('a field just touching the gap is moved by the gap, not by nothing', () => {
    assert.strictEqual(revealBy(rect(360, 395), view), 395 - (400 - GAP));
});

t('a field above the region is brought back down', () => {
    // Negative: the scroller goes the other way.
    assert.ok(revealBy(rect(-30, 10), view) < 0);
});

t('a field taller than the visible region is aligned to its top', () => {
    // 500 tall against 400 visible: it cannot be wholly shown, and the top —
    // where the text is — wins.
    const by = revealBy(rect(50, 550), view);
    assert.strictEqual(by, 50 - GAP);
});

t('a region with no room in it asks for nothing', () => {
    assert.strictEqual(revealBy(rect(0, 10), rect(100, 105)), 0);
});

t('nothing to measure is not a crash', () => {
    assert.strictEqual(revealBy(null, view), 0);
    assert.strictEqual(revealBy(rect(0, 10), null), 0);
});

// --- what the visible region is ----------------------------------------------

t('the visual viewport is the region, offset included', () => {
    const box = visibleBox({ innerHeight: 800, visualViewport: { height: 400, offsetTop: 90 } });
    assert.deepStrictEqual(box, { top: 90, bottom: 490 });
});

t('with no visual viewport the whole window is visible', () => {
    assert.deepStrictEqual(visibleBox({ innerHeight: 800 }), { top: 0, bottom: 800 });
});

t('a viewport reporting nothing is treated as no viewport', () => {
    assert.deepStrictEqual(visibleBox({ innerHeight: 640, visualViewport: { height: 0 } }),
        { top: 0, bottom: 640 });
});

// --- what raises a keyboard --------------------------------------------------

const input = (type) => ({ tagName: 'INPUT', getAttribute: () => type });

t('text fields and text areas count', () => {
    assert.ok(isTextEntry(input('text')));
    assert.ok(isTextEntry(input('search')));
    assert.ok(isTextEntry(input(null)));            // no type is a text input
    assert.ok(isTextEntry({ tagName: 'TEXTAREA' }));
    assert.ok(isTextEntry({ tagName: 'DIV', isContentEditable: true }));
});

t('a slider does not, which is the one that would fight a drag', () => {
    assert.ok(!isTextEntry(input('range')));
});

t('nor do the other controls that happen to be inputs', () => {
    for (const type of ['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'color']) {
        assert.ok(!isTextEntry(input(type)), type);
    }
});

t('nor does anything else, or nothing', () => {
    assert.ok(!isTextEntry({ tagName: 'BODY' }));
    assert.ok(!isTextEntry(null));
});

console.log(`${pass} ok`);

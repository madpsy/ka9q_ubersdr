// How tall the bottom dock may be, and what that does to the size somebody
// dragged it to.
//
// Three things are worth pinning, and all three have already gone wrong once:
//
//  - the ceiling is a share of the column, so it has to move with the window
//    rather than being a number that is right on one machine;
//  - the spectrum keeps a usable strip whatever that share works out to;
//  - and an unmeasured column means *no* cap. The first attempt at this asked
//    CSS for the share, and a peeked dock — an overlay inside the 30px
//    collapsed rail — resolved the percentage against the rail: the dock came
//    out at its floor with a resizer that could not move it. Anything that
//    cannot see the real column has to decline to answer, not guess.

const assert = require('assert');
const { CEILING_SHARE, SPECTRUM_KEEP, columnOf, dockCeiling, fitDock } = require('./.build/docksize.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// The dock's own floor, from DOCK_DEFAULTS.
const MIN = 120;

// --- the share -------------------------------------------------------------

t('a tall column gives the share, not a fixed number of pixels', () => {
    // 1440p, less the top bar: the old 560px cap never engaged here at all.
    assert.strictEqual(dockCeiling(1396, MIN), 1047);
    assert.ok(dockCeiling(1396, MIN) > 560, 'a big screen is no longer held to a laptop\'s cap');
});

t('the ceiling follows the column down', () => {
    const tall = dockCeiling(1036, MIN);      // 1080p
    const short = dockCeiling(720, MIN);      // 768px laptop
    assert.ok(short < tall, `${short} should be under ${tall}`);
    assert.strictEqual(short, 520);
});

t('every column gets a ceiling no bigger than the column', () => {
    for (let h = MIN; h <= 2000; h += 7) {
        assert.ok(dockCeiling(h, MIN) <= Math.max(MIN, h), `column ${h}`);
    }
});

t('the ceiling never falls as the column grows', () => {
    let last = 0;
    for (let h = 1; h <= 2000; h += 3) {
        const c = dockCeiling(h, MIN);
        assert.ok(c >= last, `column ${h}: ${c} after ${last}`);
        last = c;
    }
});

// --- the strip the spectrum keeps -------------------------------------------

t('the share binds on a tall column, the spectrum strip on a short one', () => {
    // The two terms cross where 0.75h == h - 200, i.e. h == 800.
    assert.strictEqual(dockCeiling(900, MIN), 900 * CEILING_SHARE);
    assert.strictEqual(dockCeiling(700, MIN), 700 - SPECTRUM_KEEP);
});

t('the spectrum keeps its strip at every column height above the floor', () => {
    for (let h = 400; h <= 2000; h += 11) {
        const left = h - dockCeiling(h, MIN);
        assert.ok(left >= SPECTRUM_KEEP, `column ${h} left the spectrum ${left}`);
    }
});

// --- the floor ---------------------------------------------------------------

t('a window too short for either term still leaves a usable dock', () => {
    // 256px of column: three quarters is 192 and the strip would leave 56.
    assert.strictEqual(dockCeiling(256, MIN), MIN);
});

t('the floor is the dock\'s own minSize, not a number of its own', () => {
    assert.strictEqual(dockCeiling(200, 90), 90);
    assert.strictEqual(dockCeiling(200, 160), 160);
});

// --- an unmeasured column ----------------------------------------------------

t('an unmeasured column means no cap at all', () => {
    // Nothing rendered yet, no column found, a detached element: each of these
    // must leave the dock exactly as it was rather than pinning it anywhere.
    for (const h of [0, -1, NaN, Infinity, undefined, null]) {
        assert.strictEqual(dockCeiling(h, MIN), Infinity, `column ${h}`);
    }
    assert.strictEqual(fitDock(420, dockCeiling(0, MIN)), 420);
});

t('the 30px rail a peek is rendered inside is not a column', () => {
    // The regression this file exists for: measured against the rail, the old
    // arithmetic returned the floor and the peek could not be resized. It is
    // the *measuring* that must not offer the rail, and the arithmetic still
    // has to be honest about what such a box would mean — a dock with no room.
    assert.strictEqual(dockCeiling(30, MIN), MIN);
});

// --- what gets drawn ---------------------------------------------------------

t('a size that fits is drawn as it is', () => {
    assert.strictEqual(fitDock(300, dockCeiling(1036, MIN)), 300);
});

t('a size that no longer fits is drawn capped', () => {
    assert.strictEqual(fitDock(900, dockCeiling(720, MIN)), 520);
});

t('the size somebody chose survives a window that cannot show it', () => {
    // fitDock caps what is drawn and returns nothing about what is stored: the
    // same stored size, put to a bigger column, is back in full.
    const chosen = 900;
    assert.strictEqual(fitDock(chosen, dockCeiling(720, MIN)), 520);
    assert.strictEqual(fitDock(chosen, dockCeiling(1396, MIN)), chosen);
});

// --- finding the column ------------------------------------------------------

// Element-shaped stubs: a class, a height, and a parent, with `closest` doing
// what the DOM's does. Enough to ask the one question that matters — which box
// gets measured — without a DOM.
function el(cls, height, parent) {
    const node = {
        cls,
        clientHeight: height,
        parentElement: parent || null,
        closest(sel) {
            const want = sel.replace('.', '');
            for (let n = node; n; n = n.parentElement) if (n.cls.split(' ').includes(want)) return n;
            return null;
        },
    };
    return node;
}

// The shell, as far as the dock is concerned: a column holding the spectrum and
// whatever the dock is rendered as.
const column = () => el('shell__column', 1036, el('shell__main', 1080, el('shell', 1080, null)));

t('a docked bottom dock measures the column it sits in', () => {
    const col = column();
    const dock = el('dock dock--bottom', 300, col);
    assert.strictEqual(columnOf(dock), col);
    assert.strictEqual(dockCeiling(columnOf(dock).clientHeight, MIN), 777);
});

t('a peeked dock measures the column too, not the rail it is drawn inside', () => {
    // The regression: the peek is a child of the 30px collapsed rail, and the
    // rail is what `parentElement` offers.
    const col = column();
    const rail = el('dock dock--bottom is-collapsed', 30, col);
    const peek = el('dock dock--bottom dock--peek', 300, rail);
    assert.strictEqual(peek.parentElement, rail, 'the rail really is the parent');
    assert.strictEqual(columnOf(peek), col);
    assert.strictEqual(dockCeiling(columnOf(peek).clientHeight, MIN), 777, 'same ceiling as when docked');
});

t('a dock with no column above it asks for no cap', () => {
    // Detached, or a shell that has been restructured: better to leave the dock
    // alone than to measure the first box that comes to hand.
    const orphan = el('dock dock--bottom', 300, el('somewhere-else', 30, null));
    assert.strictEqual(columnOf(orphan), null);
    assert.strictEqual(fitDock(420, dockCeiling(0, MIN)), 420);
});

t('nothing to climb from is not a crash', () => {
    for (const nothing of [null, undefined, {}]) {
        assert.strictEqual(columnOf(nothing), null);
    }
});

console.log(`\n${pass} ok`);

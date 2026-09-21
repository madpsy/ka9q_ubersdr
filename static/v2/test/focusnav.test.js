// Leaving a slider with a remote control.
//
// The bug this is for: on a Fire TV the Multipad's squelch slider, once focused,
// took all four arrows, and the D-pad is the whole of the input there — so the
// operator could ride the squelch and never reach anything else. Up and down now
// move focus by direction, and which control they land on is the part worth
// pinning: a pick that jumps across the panel is nearly as bad as none.

const assert = require('assert');
const { pickNeighbour, verticalArrow } = require('./.build/focusnav.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const box = (id, left, top, w, h) => ({ id, rect: { left, top, right: left + w, bottom: top + h } });
const from = { left: 40, top: 200, right: 300, bottom: 220 };   // the squelch slider

t('down picks the control directly under, not a nearer one off to the side', () => {
    const got = pickNeighbour(from, [
        box('under', 40, 260, 260, 30),
        box('aside', 320, 225, 40, 20),
    ], 'down');
    assert.strictEqual(got.id, 'under');
});

t('up picks the nearest row above', () => {
    const got = pickNeighbour(from, [
        box('far', 40, 60, 260, 30),
        box('near', 40, 150, 260, 30),
        box('below', 40, 260, 260, 30),
    ], 'up');
    assert.strictEqual(got.id, 'near');
});

t('a control on the same row is neither above nor below', () => {
    const reset = box('reset', 310, 198, 24, 24);
    assert.strictEqual(pickNeighbour(from, [reset], 'down'), null);
    assert.strictEqual(pickNeighbour(from, [reset], 'up'), null);
});

t('rows that share an edge still count', () => {
    const got = pickNeighbour(from, [box('touching', 40, 219.5, 260, 30)], 'down');
    assert.strictEqual(got.id, 'touching');
});

t('among a row of buttons below, the one under the middle wins', () => {
    const got = pickNeighbour(from, [
        box('a', 40, 240, 60, 30), box('b', 140, 240, 60, 30), box('c', 240, 240, 60, 30),
    ], 'down');
    assert.strictEqual(got.id, 'b');
});

t('nothing that way is nothing', () => {
    assert.strictEqual(pickNeighbour(from, [], 'down'), null);
});

t('only unmodified vertical arrows are taken', () => {
    assert.strictEqual(verticalArrow({ key: 'ArrowUp' }), 'up');
    assert.strictEqual(verticalArrow({ key: 'ArrowDown' }), 'down');
    assert.strictEqual(verticalArrow({ key: 'ArrowLeft' }), null);
    assert.strictEqual(verticalArrow({ key: 'ArrowRight' }), null);
    assert.strictEqual(verticalArrow({ key: 'ArrowUp', shiftKey: true }), null);
    assert.strictEqual(verticalArrow({ key: 'ArrowDown', ctrlKey: true }), null);
    assert.strictEqual(verticalArrow(null), null);
});

console.log(`\n${pass} passed`);

// Walking the Multipad with a remote control.
//
// The bug this is for: on a Fire TV the noise reduction picker and the width
// slider could not be reached. Both sat to the right of a control that takes
// left and right for itself — the zoom drum, the squelch slider — so geometry
// had no way over to them. Up and down now step through every control in
// order, and what is pinned here is what counts as a stop: every control once,
// a row of buttons once, and the row's selected button as where it lands.

const assert = require('assert');
const { nextStop, padStops, stepInRow } = require('./.build/padnav.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// Elements are only ever compared, so a string names each one.
const one = (el) => ({ el, group: null, active: false });
const row = (group, names, active) => names.map((el) => ({ el, group, active: el === active }));

// The full pad, top to bottom, in the order it is drawn.
const pad = [
    one('freq'), one('step'), one('mode-select'),
    one('freq-drum'), one('prev-marker'), one('next-marker'),
    ...row('navtypes', ['DX', 'CW', 'Voice'], null),
    one('zoom-drum'), one('nr'), one('nb'),
    ...row('view', ['split', 'spectrum', 'waterfall'], 'split'),
    ...row('modes', ['usb', 'lsb', 'am', 'fm'], 'am'),
    ...row('bands', ['160', '80', '60', '40', '30', '20'], '40'),
    one('width'), one('reset'), one('squelch'), one('auto'),
];

function walk(from, dir) {
    const seen = [from];
    for (let at = from; ;) {
        at = nextStop(pad, at, dir);
        if (!at) return seen;
        seen.push(at);
    }
}

t('down reaches every control that sits beside a drum or a slider', () => {
    const seen = walk('freq', 1);
    for (const lost of ['nr', 'nb', 'reset', 'width', 'auto']) {
        assert.ok(seen.includes(lost), lost + ' is never reached');
    }
});

t('a row of buttons is one stop, landing on its selected button', () => {
    assert.strictEqual(nextStop(pad, 'nb', 1), 'split');
    assert.strictEqual(nextStop(pad, 'split', 1), 'am');
    assert.strictEqual(nextStop(pad, 'am', 1), '40');
    assert.strictEqual(nextStop(pad, '40', 1), 'width');
});

t('a row with no single selection lands on its first button', () => {
    assert.strictEqual(nextStop(pad, 'next-marker', 1), 'DX');
    const two = [one('a'), ...row('g', ['x', 'y'], null).map((i) => ({ ...i, active: true }))];
    assert.strictEqual(nextStop(two, 'a', 1), 'x');
});

t('leaving a row from any button in it goes to the next stop', () => {
    assert.strictEqual(nextStop(pad, '160', 1), 'width');
    assert.strictEqual(nextStop(pad, '20', -1), 'am');
});

t('up walks the same stops as down, backwards', () => {
    const down = walk('freq', 1);
    const up = walk(down[down.length - 1], -1);
    assert.deepStrictEqual(up.slice().reverse(), down);
});

t('the ends of the pad are null, so the page can take the key', () => {
    assert.strictEqual(nextStop(pad, 'freq', -1), null);
    assert.strictEqual(nextStop(pad, 'auto', 1), null);
    assert.strictEqual(nextStop(pad, 'not-on-the-pad', 1), null);
});

t('the whole pad is a short walk, not one press per button', () => {
    assert.strictEqual(padStops(pad).length, 17);
    assert.strictEqual(walk('freq', 1).length, 17);
});

t('left and right move along a row and stop at its ends', () => {
    assert.strictEqual(stepInRow(pad, '40', 1), '30');
    assert.strictEqual(stepInRow(pad, '40', -1), '60');
    assert.strictEqual(stepInRow(pad, '20', 1), null);
    assert.strictEqual(stepInRow(pad, '160', -1), null);
});

t('left and right on a control of its own are not the walk\'s', () => {
    assert.strictEqual(stepInRow(pad, 'zoom-drum', 1), null);
    assert.strictEqual(stepInRow(pad, 'squelch', -1), null);
});

t('two separate rows of the same kind stay separate stops', () => {
    const items = [...row('a', ['1', '2'], '1'), one('mid'), ...row('b', ['3', '4'], '4')];
    assert.strictEqual(padStops(items).length, 3);
    assert.strictEqual(nextStop(items, '2', 1), 'mid');
    assert.strictEqual(nextStop(items, 'mid', 1), '4');
});

console.log(`\n${pass} passed`);

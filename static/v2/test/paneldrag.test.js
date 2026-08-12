// Where a dragged panel lands.
//
// One function answers this for both ways a panel arrives in a dock — the
// browser drag from another dock, and a floating window carried over one — so
// that the marker shown during the drag and the placement chosen on release
// cannot disagree. A drop indicator that promises one gap and delivers another
// is worse than no indicator at all.

const assert = require('assert');
const { nearestPanelGap } = require('./.build/paneldrag.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// A dock body of stacked panels, each 100 tall, as the DOM would answer.
const body = (panels, vertical = true) => ({
    querySelectorAll: () => panels.map(([id, start, size]) => ({
        dataset: { panel: id },
        getBoundingClientRect: () => (vertical
            ? { top: start, height: size, left: 0, width: 200 }
            : { left: start, width: size, top: 0, height: 200 }),
    })),
});

const SIDE = body([['spectrum', 0, 100], ['audio', 100, 100], ['chat', 200, 100]]);

t('nothing to sit beside is nothing, not a guess', () => {
    assert.strictEqual(nearestPanelGap(null, 10, 10, 'left', null), null);
    assert.strictEqual(nearestPanelGap(body([]), 10, 10, 'left', null), null);
});

t('the nearest middle wins, and the side of it says which gap', () => {
    // Above the first panel's midpoint (50): before it.
    assert.deepStrictEqual(nearestPanelGap(SIDE, 0, 10, 'left', null), { id: 'spectrum', edge: 'before' });
    // Just past it: after.
    assert.deepStrictEqual(nearestPanelGap(SIDE, 0, 60, 'left', null), { id: 'spectrum', edge: 'after' });
    // Nearest the last one, below its middle.
    assert.deepStrictEqual(nearestPanelGap(SIDE, 0, 290, 'left', null), { id: 'chat', edge: 'after' });
});

t('the panel in hand is not one of the places to put it', () => {
    // Over its own middle, the answer is the neighbour rather than itself —
    // the gaps either side of where it already is are not moves.
    const at = nearestPanelGap(SIDE, 0, 150, 'left', 'audio');
    assert.notStrictEqual(at, null);
    assert.notStrictEqual(at.id, 'audio');
});

t('the bottom dock is measured across, not down', () => {
    // Same panels laid out in a row: the x coordinate decides, and y is
    // irrelevant — which is the whole difference between the docks.
    const row = body([['a', 0, 100], ['b', 100, 100]], false);
    assert.deepStrictEqual(nearestPanelGap(row, 10, 999, 'bottom', null), { id: 'a', edge: 'before' });
    assert.deepStrictEqual(nearestPanelGap(row, 190, 0, 'bottom', null), { id: 'b', edge: 'after' });
});

console.log(`\n${pass} passed`);

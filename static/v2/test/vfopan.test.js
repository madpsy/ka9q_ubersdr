// Where each listening VFO sits in the stereo field — lib/vfoPan.js.

const assert = require('assert');
const { vfoPans, panPositions, HYSTERESIS_HZ } = require('./.build/vfopan.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const near = (a, b) => Math.abs(a - b) < 1e-9;
const v = (id, frequency, out = 'auto') => ({ id, frequency, out });

t('the spread is even across the field', () => {
    assert.deepStrictEqual(panPositions(1), [0]);
    assert.deepStrictEqual(panPositions(2), [-1, 1]);
    assert.deepStrictEqual(panPositions(3), [-1, 0, 1]);
    const four = panPositions(4);
    [-1, -1 / 3, 1 / 3, 1].forEach((p, i) => assert.ok(near(four[i], p), `${four}`));
});

t('two VFOs: lower on the left, higher on the right', () => {
    const { pans } = vfoPans([v('A', 14074000), v('B', 7074000)]);
    assert.strictEqual(pans.B, -1);
    assert.strictEqual(pans.A, 1);
});

t('three and four VFOs are placed in frequency order', () => {
    const three = vfoPans([v('A', 3), v('B', 1), v('C', 2)].map((x) => ({ ...x, frequency: x.frequency * 1e6 }))).pans;
    assert.deepStrictEqual(three, { B: -1, C: 0, A: 1 });
    const four = vfoPans([v('D', 4e6), v('A', 1e6), v('C', 3e6), v('B', 2e6)]).pans;
    assert.ok(near(four.A, -1) && near(four.B, -1 / 3) && near(four.C, 1 / 3) && near(four.D, 1));
});

t('a pinned VFO keeps its side and the others take what is left', () => {
    // A is the lowest but pinned right; B and C spread over the left and middle.
    const { pans } = vfoPans([v('A', 1e6, 'right'), v('B', 2e6), v('C', 3e6)]);
    assert.strictEqual(pans.A, 1);
    assert.strictEqual(pans.B, -1);
    assert.strictEqual(pans.C, 0);
    // Two pinned left both sit left; the one on Auto gets the far right.
    const two = vfoPans([v('A', 5e6, 'left'), v('B', 6e6, 'left'), v('C', 1e6)]).pans;
    assert.deepStrictEqual(two, { A: -1, B: -1, C: 1 });
});

t('both is the middle and takes no side', () => {
    const { pans } = vfoPans([v('A', 1e6, 'both'), v('B', 2e6), v('C', 3e6)]);
    assert.strictEqual(pans.A, 0);
    assert.strictEqual(pans.B, -1);
    assert.strictEqual(pans.C, 1);
});

t('two VFOs a few hertz apart do not swap ears while one is dragged past', () => {
    let res = vfoPans([v('A', 7100000), v('B', 7100050)]);
    assert.deepStrictEqual(res.pans, { A: -1, B: 1 });
    // B dragged just under A: inside the hysteresis, nothing moves.
    res = vfoPans([v('A', 7100000), v('B', 7100000 - HYSTERESIS_HZ + 1)], res);
    assert.deepStrictEqual(res.pans, { A: -1, B: 1 });
    // Exactly at the hysteresis is still not past it.
    res = vfoPans([v('A', 7100000), v('B', 7100000 - HYSTERESIS_HZ)], res);
    assert.deepStrictEqual(res.pans, { A: -1, B: 1 });
    // Clearly past: now they trade.
    res = vfoPans([v('A', 7100000), v('B', 7100000 - HYSTERESIS_HZ - 1)], res);
    assert.deepStrictEqual(res.pans, { A: 1, B: -1 });
    // ...and coming back by a little does not trade them back.
    res = vfoPans([v('A', 7100000), v('B', 7100020)], res);
    assert.deepStrictEqual(res.pans, { A: 1, B: -1 });
});

t('a newcomer is placed by frequency among the sticky order', () => {
    let res = vfoPans([v('A', 7100000), v('B', 7100050)]);
    res = vfoPans([v('A', 7100000), v('B', 7100050), v('C', 1e6)], res);
    assert.deepStrictEqual(res.order, ['C', 'A', 'B']);
    assert.deepStrictEqual(res.pans, { C: -1, A: 0, B: 1 });
});

t('one VFO alone is in the middle', () => {
    assert.deepStrictEqual(vfoPans([v('A', 7e6)]).pans, { A: 0 });
    assert.deepStrictEqual(vfoPans([]).pans, {});
});

if (!process.exitCode) console.log(`\n${pass} passed`);

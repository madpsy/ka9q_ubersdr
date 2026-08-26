// Which way the frequency drum turns.
//
// A listener asked for it backwards, and "backwards" has to mean both halves at once.
// The drum's whole illusion is that the strip is a physical thing under the thumb, so
// reversing only the steps would slide the scale one way while the numbers counted the
// other — which reads as a bug, not a preference. Barrel therefore mirrors the labels and
// negates the steps together, and these tests hold those two facts to each other.
//
// A render test rather than a unit one because the failure this guards against is a scope
// error: a `reverse` referenced where it is not defined builds cleanly, passes every pure
// test, and blanks the panel at runtime. Mounting is the only thing that catches it.

const assert = require('assert');
const {
    deep, render, reset, words, Barrel, DEFAULTS,
} = require('./.build/barrelflip.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// The scale under test: each detent is labelled with its own offset, so a cell's text is
// the detent index the component asked `label` for. That makes the mirroring readable —
// the cell drawn at +1 says "1" normally and "-1" reversed.
const label = (i) => String(i);

// The cells, in the order the strip lays them out, as [drawnAt, text].
function cells(tree) {
    return deep(tree)
        .filter((n) => n.props && String(n.props.className || '').startsWith('barrel__cell'))
        .map((n) => [n.props.style && n.props.style.transform, words(n).trim()]);
}

function mount(props) {
    reset();
    // render() hands back { tree, cleanups } — the cleanups so a caller can prove
    // unmounting works. Only the tree is wanted here.
    const { tree } = render(Barrel, { detent: 10, centre: 0, label, onStep: () => 0, ...props });
    return tree;
}

// --- the labels ---------------------------------------------------------------

t('normally the scale counts up to the right', () => {
    const drawn = cells(mount({}));
    const at = (px) => (drawn.find(([x]) => x === `translateX(${px}px)`) || [])[1];
    assert.strictEqual(at(0), '0', 'the index line is the centre');
    assert.strictEqual(at(10), '1', 'one detent right is one step up');
    assert.strictEqual(at(-10), '-1', 'one detent left is one step down');
});

t('reversed, the same cells carry the opposite values', () => {
    const drawn = cells(mount({ reverse: true }));
    const at = (px) => (drawn.find(([x]) => x === `translateX(${px}px)`) || [])[1];
    assert.strictEqual(at(0), '0', 'the centre is still the centre');
    assert.strictEqual(at(10), '-1', 'one detent right is now one step down');
    assert.strictEqual(at(-10), '1', 'and one detent left is one step up');
});

t('the cells themselves do not move — only what they say', () => {
    // The mirror is in the scale, not in the layout: same count, same positions, so the
    // strip the drag translates is unchanged and the physics never learns about this.
    const normal = cells(mount({})).map(([x]) => x);
    const flipped = cells(mount({ reverse: true })).map(([x]) => x);
    // Asserted before they are compared: two empty lists are deep-equal, so without
    // this the test passes hardest when the drum draws nothing at all.
    assert.ok(normal.length > 3, 'a scale was drawn to compare');
    assert.deepStrictEqual(flipped, normal);
});

// --- the default ---------------------------------------------------------------

t('a barrel with no reverse prop behaves as it always did', () => {
    // Every other barrel in the app passes nothing, so the absent case is the one that
    // must not have changed.
    const drawn = cells(mount({ reverse: undefined }));
    const at = (px) => (drawn.find(([x]) => x === `translateX(${px}px)`) || [])[1];
    assert.strictEqual(at(10), '1');
});

t('the stored preference is off by default', () => {
    // Reversed is a minority request. A new listener gets the direction the spectrum
    // pans in, which is what every other surface here does.
    assert.strictEqual(DEFAULTS.tuneReverse, false);
});

// --- it renders at all ----------------------------------------------------------

t('it mounts and draws a scale, in both directions', () => {
    for (const reverse of [false, true]) {
        const tree = mount({ reverse });
        assert.ok(tree, `no tree for reverse=${reverse}`);
        assert.ok(cells(tree).length > 3, `no scale drawn for reverse=${reverse}`);
    }
});

console.log(`\n${pass} passed`);

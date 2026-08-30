// Which optional children of a row still fit.
//
// The property that matters is not "does it get the arithmetic right" but "does
// the answer hold still". A row whose measurement includes an optional child
// says the child does not fit, hides it, measures a narrower row, says it fits,
// shows it — once per render, forever. In React that is "Maximum update depth
// exceeded" (#185), and it only shows up when the window happens to sit on the
// threshold, which is why it appeared in one browser and not another.

const assert = require('assert');
const { measureRoom, sameFits } = require('./.build/roomfor.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// --- element-shaped objects --------------------------------------------------

// `hidden` children are simply absent, as React leaves them out of the DOM.
function el({ w = 0, optional, slack, gap = 0, children = [] } = {}) {
    const dataset = {};
    if (optional != null) dataset.optional = optional;
    if (slack) dataset.slack = '';
    const node = {
        children,
        dataset,
        gap,
        clientWidth: w,
        get offsetWidth() {
            // A container is as wide as its children and the gaps between them,
            // which is what makes the nesting bug possible in the first place.
            if (!children.length) return w;
            const inner = children.reduce((sum, c) => sum + c.offsetWidth, 0);
            return inner + gap * Math.max(0, children.length - 1);
        },
        getBoundingClientRect() {
            return { width: node.offsetWidth };
        },
        querySelectorAll() {
            const found = [];
            const walk = (kids) => {
                for (const c of kids) {
                    if (c.dataset.optional != null) found.push(c);
                    walk(c.children);
                }
            };
            walk(children);
            return found;
        },
    };
    return node;
}

/**
 * An inline SVG child, which is not an HTMLElement and so has no offsetWidth.
 *
 * The icon sets in this interface are inline SVG (components/icons.jsx), so any
 * row with an icon in it has one of these among its children. Every row that
 * used this until now happened to be all spans.
 */
function svgEl(w) {
    return {
        children: [],
        dataset: {},
        gap: 0,
        clientWidth: w,
        getBoundingClientRect: () => ({ width: w }),
        querySelectorAll: () => [],
    };
}

global.getComputedStyle = (node) => ({
    columnGap: `${node.gap || 0}px`,
    paddingLeft: '0px',
    paddingRight: '0px',
});

// --- the row as the top bar actually builds it -------------------------------

// The filter width lives inside the frequency readout, beside the mode it
// describes — not as a direct child of the bar.
function topBar({ barWidth, showWidth }) {
    const freqKids = [el({ w: 120 }), el({ w: 40 })];
    if (showWidth) freqKids.push(el({ w: 52, optional: 'width' }));
    return el({
        w: barWidth,
        gap: 10,
        children: [
            el({ w: 150 }),                       // brand
            el({ gap: 8, children: freqKids }),   // the readout
            el({ slack: true, w: 0 }),
        ],
    });
}

const SPECS = [{ key: 'width', width: 52 }];

t('a nested optional child does not oscillate', () => {
    // Every width across the range where the decision flips. At each one, the
    // answer with the child up must equal the answer with it down — otherwise
    // the two states point at each other and the row never settles.
    const unstable = [];
    for (let barWidth = 200; barWidth <= 500; barWidth += 1) {
        const widths = {};
        // Seed the cache the way a real first render does: the child starts
        // shown, so it is measured before it is ever judged.
        measureRoom(topBar({ barWidth, showWidth: true }), SPECS, widths);

        const shown = measureRoom(topBar({ barWidth, showWidth: true }), SPECS, widths);
        const hidden = measureRoom(topBar({ barWidth, showWidth: false }), SPECS, widths);
        if (shown.width !== hidden.width) unstable.push(barWidth);
    }
    assert.deepStrictEqual(
        unstable, [],
        `the row flip-flops at ${unstable.length} widths, e.g. ${unstable.slice(0, 5)}`,
    );
});

t('a row resting on the boundary does not chase itself', () => {
    // The failure this guards: with one rule for both states, a child that only
    // just fits is dropped, which makes room, which brings it back. Each answer
    // is a render, so React changes its mind until it throws and the interface
    // goes blank — which is what a phone's top bar did once its buttons grew
    // for touch.
    for (let barWidth = 200; barWidth <= 500; barWidth += 1) {
        const widths = {};
        measureRoom(topBar({ barWidth, showWidth: true }), SPECS, widths);

        // Whatever it decides from one state, asking again from the state that
        // decision produces must give the same answer.
        const first = measureRoom(topBar({ barWidth, showWidth: true }), SPECS, widths, { width: true });
        const again = measureRoom(
            topBar({ barWidth, showWidth: first.width }), SPECS, widths, first,
        );
        assert.strictEqual(again.width, first.width, `settles at ${barWidth}px`);
    }
});

t('it is still shown when there is room and dropped when there is not', () => {
    const widths = {};
    assert.strictEqual(measureRoom(topBar({ barWidth: 900, showWidth: true }), SPECS, widths).width, true);
    assert.strictEqual(measureRoom(topBar({ barWidth: 240, showWidth: true }), SPECS, widths).width, false);
});

t('a nested child is remembered as nested, at what it costs its parent', () => {
    const widths = {};
    measureRoom(topBar({ barWidth: 900, showWidth: true }), SPECS, widths);
    // 52 wide plus one of the readout's own 8px gaps: remove it and the row
    // gives back both.
    assert.deepStrictEqual(widths.width, { w: 60, nested: true });
});

// --- direct children, which is what this always did --------------------------

function flatRow({ rowWidth, items }) {
    return el({
        w: rowWidth,
        gap: 10,
        children: [el({ w: 100 }), ...items],
    });
}

t('a direct optional child does not oscillate either', () => {
    const specs = [{ key: 'clock', width: 96 }];
    const unstable = [];
    for (let rowWidth = 120; rowWidth <= 400; rowWidth += 1) {
        const widths = {};
        const up = () => flatRow({ rowWidth, items: [el({ w: 96, optional: 'clock' })] });
        measureRoom(up(), specs, widths);
        const shown = measureRoom(up(), specs, widths);
        const hidden = measureRoom(flatRow({ rowWidth, items: [] }), specs, widths);
        if (shown.clock !== hidden.clock) unstable.push(rowWidth);
    }
    assert.deepStrictEqual(unstable, [], `flip-flops at ${unstable.slice(0, 5)}`);
});

t('keep order decides who goes first', () => {
    const specs = [{ key: 'keepMe', width: 60 }, { key: 'dropMe', width: 60 }];
    const widths = {};
    const row = flatRow({
        rowWidth: 190,
        items: [el({ w: 60, optional: 'keepMe' }), el({ w: 60, optional: 'dropMe' })],
    });
    const fits = measureRoom(row, specs, widths);
    assert.strictEqual(fits.keepMe, true);
    assert.strictEqual(fits.dropMe, false, 'the less important one should go first');
});

t('the flex spacer is room, not content', () => {
    const specs = [{ key: 'clock', width: 96 }];
    const withSlack = el({
        w: 300,
        gap: 0,
        children: [el({ w: 100 }), el({ slack: true, w: 900 }), el({ w: 96, optional: 'clock' })],
    });
    // Counting the spacer would make every row look exactly full.
    assert.strictEqual(measureRoom(withSlack, specs, {}).clock, true);
});

t('a child never yet seen falls back to the width the caller guessed', () => {
    const specs = [{ key: 'clock', width: 96 }];
    const fits = measureRoom(flatRow({ rowWidth: 130, items: [] }), specs, {});
    assert.strictEqual(fits.clock, false, '100 + 96 does not fit in 130');
});

t('the cushion keeps a child from being shown into the last few pixels', () => {
    const specs = [{ key: 'clock', width: 96 }];
    // 100 + 96 = 196 fits exactly, but not with room to spare.
    assert.strictEqual(measureRoom(flatRow({ rowWidth: 196, items: [] }), specs, {}).clock, false);
    assert.strictEqual(measureRoom(flatRow({ rowWidth: 220, items: [] }), specs, {}).clock, true);
});

// --- the identity guard ------------------------------------------------------

t('the same answer compares equal, so the hook can keep the old object', () => {
    assert.ok(sameFits({ a: true, b: false }, { a: true, b: false }));
    assert.ok(!sameFits({ a: true }, { a: false }));
    assert.ok(!sameFits({ a: true }, { a: true, b: true }));
    assert.ok(sameFits({}, {}));
});

console.log(`\n${pass} ok`);

// --- an icon among the children ---------------------------------------------

t('an inline SVG child is measured like any other', () => {
    // SVGElement is not an HTMLElement and has no offsetWidth, so reading one
    // returns undefined — and one undefined in the sum makes the whole figure
    // NaN, which fails every comparison. The optional child is then hidden for
    // ever, at any width, with nothing on screen to say why. That is what the IQ
    // panel's demodulator rows hit: they lead with a chevron.
    const row = el({
        w: 400,
        gap: 6,
        children: [svgEl(12), el({ w: 40 }), el({ w: 100 }), el({ w: 80, optional: 'freq' })],
    });
    const fits = measureRoom(row, [{ key: 'freq', width: 80 }], {}, {});
    assert.strictEqual(fits.freq, true, 'a row with room said no — the sum went NaN');
});

t('an SVG child still takes up its own width', () => {
    // ...and it is not simply skipped: a row that is exactly full with the icon
    // counted must say no, or the optional child overlaps it.
    const row = el({
        w: 150,
        gap: 6,
        children: [svgEl(40), el({ w: 40 }), el({ w: 80, optional: 'freq' })],
    });
    const fits = measureRoom(row, [{ key: 'freq', width: 80 }], {}, {});
    assert.strictEqual(fits.freq, false, 'the icon was measured as nothing');
});

console.log(`\n${pass} passed`);

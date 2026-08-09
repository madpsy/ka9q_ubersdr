// The top bar readout shrinking to keep the filter width.
//
// As with roomfor.test.js, the property that matters is not the arithmetic but
// that the answer holds still — and there are two loops available here, not one.
// A scale worked out from the thing it is applied to is a loop by itself, and a
// scale worked out from a readout whose last part useRoomFor has already dropped
// is a loop with that: the chip goes, the type grows into the room it left, and
// the chip no longer fits.

const assert = require('assert');
const { measureFit, FIT_MIN, FIT_STEP } = require('./.build/fitscale.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// --- element-shaped objects --------------------------------------------------
//
// A scalable part is as wide as its text at scale 1 times the scale it is drawn
// at, which is the one behaviour the measurement leans on.

function part({ key, w, scale = 1 }) {
    return {
        children: [],
        dataset: { fit: key },
        get offsetWidth() { return w * scale; },
        querySelectorAll: () => [],
    };
}

function box({ w = 0, gap = 0, slack, pad = 0, children = [] } = {}) {
    const node = {
        children,
        dataset: slack ? { slack: '' } : {},
        gap,
        pad,
        clientWidth: w,
        get offsetWidth() {
            if (!children.length) return w;
            const inner = children.reduce((s, c) => s + c.offsetWidth, 0);
            return pad + inner + gap * Math.max(0, children.length - 1);
        },
        querySelectorAll() {
            return children.filter((c) => c.dataset && c.dataset.fit != null);
        },
    };
    return node;
}

global.getComputedStyle = (node) => ({
    columnGap: `${node.gap || 0}px`,
    paddingLeft: `${(node.pad || 0) / 2}px`,
    paddingRight: `${(node.pad || 0) / 2}px`,
});

// The compact bar as it actually is: brand, readout, spacer, three icon buttons.
// The readout's parts are the frequency, the mode and the filter width.
const HZ = 84;
const MODE = 26;
const BW = 39;

function bar({ barWidth, scale = 1, showBw = true }) {
    const parts = [part({ key: 'hz', w: HZ, scale }), part({ key: 'mode', w: MODE, scale })];
    if (showBw) parts.push(part({ key: 'bw', w: BW, scale }));
    const freq = box({ gap: 8, pad: 24, children: parts });
    const row = box({
        w: barWidth,
        gap: 9,
        pad: 20,
        children: [
            box({ w: 69 }),               // brand
            freq,
            box({ slack: true, w: 0 }),   // spacer
            box({ w: 36 }),               // listen
            box({ w: 32 }),               // theme
            box({ w: 32 }),               // share
        ],
    });
    return { row, freq };
}

t('a wide bar leaves the type alone', () => {
    const { row, freq } = bar({ barWidth: 900 });
    assert.strictEqual(measureFit(row, freq, 1, {}), 1);
});

t('a bar between the two extremes shrinks, and shrinks to a real fit', () => {
    // The widths are a model of the compact bar, not a measurement of one — the
    // real ones depend on font metrics no test here can see. So this asks for
    // the property rather than a number: there is a band of widths where the
    // readout shrinks, and everywhere in it the whole readout is inside the bar
    // at the scale it was given. Where that band falls on a real handset is what
    // the arithmetic decides at runtime.
    const band = [];
    for (let barWidth = 200; barWidth <= 900; barWidth += 1) {
        const { row, freq } = bar({ barWidth });
        const s = measureFit(row, freq, 1, {});
        if (s === 1) continue;
        band.push(barWidth);
        const drawn = 24 + 8 * 2 + (HZ + MODE + BW) * s;
        assert.ok(
            20 + 69 + drawn + 36 + 32 + 32 + 9 * 5 <= barWidth,
            `scale ${s} still leaves the readout ${drawn} wide at ${barWidth}px`,
        );
    }
    assert.ok(band.length > 20, `only ${band.length} widths shrink at all`);
});

t('a row too narrow to be saved keeps its type at full size', () => {
    // Not clamped to the floor: shrinking that does not buy the filter width
    // leaves small type *and* no filter width, which is worse than the plain
    // readout with the chip dropped that this always had.
    const { row, freq } = bar({ barWidth: 260 });
    assert.strictEqual(measureFit(row, freq, 1, {}), 1);
});

t('every scale it does return is one worth having', () => {
    for (let barWidth = 200; barWidth <= 900; barWidth += 1) {
        const { row, freq } = bar({ barWidth });
        const s = measureFit(row, freq, 1, {});
        assert.ok(s === 1 || s >= FIT_MIN, `${s} at ${barWidth}px is below the floor`);
    }
});

t('the answer does not depend on what it is currently drawn at', () => {
    // The loop this closes: measure at scale 1, apply, measure again. A
    // measurement that read the shrunken text as the text would shrink it again
    // every frame until it hit the floor.
    for (let barWidth = 260; barWidth <= 900; barWidth += 1) {
        const fresh = bar({ barWidth });
        const first = measureFit(fresh.row, fresh.freq, 1, {});
        const { row, freq } = bar({ barWidth, scale: first });
        const second = measureFit(row, freq, first, {});
        assert.strictEqual(second, first, `settled at ${first} then moved to ${second} at ${barWidth}px`);
    }
});

t('a dropped filter width does not let the type grow back into its place', () => {
    // The other loop. useRoomFor has taken the chip out of the DOM; the scale
    // must still be the one that would fit it, or the two chase each other.
    for (let barWidth = 260; barWidth <= 900; barWidth += 1) {
        const widths = {};
        // Seeded as a first render seeds it: everything on screen once.
        const fresh = bar({ barWidth });
        const s = measureFit(fresh.row, fresh.freq, 1, widths);
        const { row, freq } = bar({ barWidth, scale: s, showBw: false });
        assert.strictEqual(
            measureFit(row, freq, s, widths), s,
            `dropping the chip moved the scale at ${barWidth}px`,
        );
    }
});

t('the scale is quantised, so a resize does not leave it twitching', () => {
    const seen = new Set();
    for (let barWidth = 260; barWidth <= 900; barWidth += 1) {
        const { row, freq } = bar({ barWidth });
        seen.add(measureFit(row, freq, 1, {}));
    }
    for (const s of seen) {
        const steps = s / FIT_STEP;
        assert.ok(Math.abs(steps - Math.round(steps)) < 1e-6, `${s} is not a whole step`);
    }
});

console.log(`\n${pass} fit scale checks passed`);

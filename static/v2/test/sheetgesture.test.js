// Tap or drag a sheet's title bar to cut it down or open it out.
//
// The failure this guards against is the one nobody reports: a tap on the bar
// that was meant for Close, or a drag that flips the panel back and forth
// because it was read as "toggle" rather than as "make it this".

const assert = require('assert');
const { SHEET_SLOP_PX, sheetIntent, sheetWants } = require('./.build/sheetgesture.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const S = SHEET_SLOP_PX;

t('a finger that stayed put is a tap', () => {
    assert.strictEqual(sheetIntent(0, 0), 'tap');
    // A fingertip that means to stay still still moves a few pixels, both ways.
    assert.strictEqual(sheetIntent(S, S), 'tap');
    assert.strictEqual(sheetIntent(-S, -S), 'tap');
});

t('up opens the panel out, down cuts it down', () => {
    assert.strictEqual(sheetIntent(0, -40), 'expand');
    assert.strictEqual(sheetIntent(0, 40), 'minimise');
    // One pixel past the slop is already a drag: past it the direction is
    // known, and waiting longer only makes a short deliberate drag do nothing.
    assert.strictEqual(sheetIntent(0, -(S + 1)), 'expand');
    assert.strictEqual(sheetIntent(0, S + 1), 'minimise');
});

t('a sideways drag is not aimed at this', () => {
    // A finger crossing the bar on the way somewhere else must not change what
    // the panel is showing.
    assert.strictEqual(sheetIntent(60, 0), null);
    assert.strictEqual(sheetIntent(-60, 4), null);
    // Diagonal goes to whichever axis won.
    assert.strictEqual(sheetIntent(40, -50), 'expand');
    assert.strictEqual(sheetIntent(50, -40), null);
});

t('a tap asks for the other state, a drag for a named one', () => {
    assert.strictEqual(sheetWants('tap', true), false);
    assert.strictEqual(sheetWants('tap', false), true);
    // The whole reason a drag names its state: repeating it is a no-op, so a
    // second downward drag on an already cut-down sheet cannot open it again.
    assert.strictEqual(sheetWants('minimise', true), true);
    assert.strictEqual(sheetWants('minimise', false), true);
    assert.strictEqual(sheetWants('expand', true), false);
    assert.strictEqual(sheetWants('expand', false), false);
});

t('a gesture that meant nothing asks for nothing', () => {
    assert.strictEqual(sheetWants(null, true), null);
    assert.strictEqual(sheetWants(null, false), null);
});

t('every intent a drag can produce is one sheetWants answers', () => {
    // The two are used together and only together, so a value one of them
    // learns and the other does not is a gesture that silently does nothing.
    const seen = new Set();
    for (let dx = -30; dx <= 30; dx += 3) {
        for (let dy = -30; dy <= 30; dy += 3) seen.add(sheetIntent(dx, dy));
    }
    for (const intent of seen) {
        const want = sheetWants(intent, false);
        assert.ok(want === true || want === false || want === null, `${intent} → ${want}`);
        if (intent !== null) assert.notStrictEqual(want, null, `${intent} must decide`);
    }
});

// --- and the sheet resizing on its own ---------------------------------------

t('only an editable child raises the sheet to make room for a keyboard', () => {
    // The stylesheet's half of the same problem, and the reason it is asserted
    // here rather than left to the eye: a sheet that resizes mid-tap moves the
    // panel out from under the finger, and the click a touch leaves behind is
    // hit-tested against the DOM as it is then. `:focus-within` did exactly that
    // on every button press, because Chrome focuses a <button> when it is
    // tapped — so pressing Start on a panel taller than the cap grew the sheet
    // by a sixth of the screen and the press landed somewhere else.
    const fs = require('fs');
    const path = require('path');
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');

    assert.ok(!/\.sheet:focus-within/.test(css),
        ':focus-within is any focusable child, buttons included — name the editable ones');

    const rule = css.match(/\.sheet:has\(([^)]*(?:\([^)]*\)[^)]*)*)\)\s*\{[^}]*--sheet-height[^}]*\}/);
    assert.ok(rule, 'the sheet still gets its room back for a keyboard');
    const sel = rule[1];
    assert.ok(/textarea:focus/.test(sel) && /contenteditable\]:focus/.test(sel) && /input:focus/.test(sel),
        sel);
    // The input types that take focus from a finger and raise no keyboard. A
    // slider is the one that matters — the panels are full of them.
    for (const type of ['range', 'checkbox', 'radio', 'color', 'button', 'submit']) {
        assert.ok(sel.includes(`[type="${type}"]`), `${type} is not excluded: ${sel}`);
    }
});

console.log(`\n${pass} ok`);

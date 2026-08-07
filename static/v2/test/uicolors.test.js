// The interface's own colours, and everything derived from them.
//
// Two pickers' worth of input and seven custom properties out, which is where the
// mistakes live: an accent whose label goes unreadable on top of it, a text colour
// that leaves its own labels grey, and — the quiet one — an untouched setting that
// nevertheless writes values over the stylesheet's and shifts every shade by one.

const assert = require('assert');
const {
    ACCENT_DEFAULT, CONTRAST_MIN, CONTRAST_MIN_FAINT, TEXT_DEFAULT, TEXT_DIM_DEFAULT,
    TEXT_FAINT_DEFAULT, contrastMin,
    UI_COLOR_VARS, accentVars, contrastRatio, effectiveColors, inkFor, luminance, pageContrast,
    parseHex, textVars, uiColorVars,
} = require('./.build/uicolors.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// --- nothing chosen ---------------------------------------------------------

t('an untouched setting writes nothing at all', () => {
    // The important one. The derived greys land within a shade of the stock ones
    // but not on them, so writing them out on first load would shift the whole
    // interface by a hair for everybody who never opened the panel.
    assert.deepStrictEqual(uiColorVars({}, 'dark'), {});
    assert.deepStrictEqual(uiColorVars(undefined, 'light'), {});
    assert.deepStrictEqual(uiColorVars({ accent: null, text: null }, 'dark'), {});
});

t('the pickers open on what is really on screen', () => {
    // Not on black, and not on a derived approximation of the stock greys: a
    // first drag has to start from where the interface actually is.
    for (const theme of ['dark', 'light']) {
        assert.deepStrictEqual(effectiveColors({}, theme), {
            accent: ACCENT_DEFAULT[theme],
            text: TEXT_DEFAULT[theme],
            dim: TEXT_DIM_DEFAULT[theme],
            faint: TEXT_FAINT_DEFAULT[theme],
        });
    }
});

// --- the accent -------------------------------------------------------------

t('an accent brings its own ink, wash and rule', () => {
    const v = accentVars('#08a2fb', 'dark');
    assert.deepStrictEqual(Object.keys(v).sort(), [
        '--accent', '--accent-ink', '--accent-line', '--accent-soft',
    ]);
    assert.strictEqual(v['--accent'], '#08a2fb');
    assert.strictEqual(v['--accent-soft'], 'rgba(8, 162, 251, 0.13)');
    assert.strictEqual(v['--accent-line'], 'rgba(8, 162, 251, 0.4)');
});

t('choosing the stock blue by hand looks identical to not choosing', () => {
    // The alphas and the ink come from the stylesheet's own values, so the two
    // routes to the same colour must not differ by a shade.
    const v = accentVars(ACCENT_DEFAULT.dark, 'dark');
    assert.strictEqual(v['--accent-ink'], '#031a2b', 'the stylesheet\'s dark ink');
    assert.strictEqual(accentVars(ACCENT_DEFAULT.light, 'light')['--accent-ink'], '#ffffff');
    // ...and the light theme washes a shade thinner, as it does in the stylesheet.
    assert.ok(accentVars('#08a2fb', 'light')['--accent-soft'].endsWith('0.12)'));
});

t('the ink on a fill is whichever is legible, measured not guessed', () => {
    // The dark ink is a very dark blue rather than black, so where the two
    // candidates cross is not where a 50%-lightness rule would put it.
    assert.strictEqual(inkFor('#ffe066'), '#031a2b', 'a pale yellow takes dark ink');
    assert.strictEqual(inkFor('#7c3aed'), '#ffffff', 'a deep violet takes white');
    assert.strictEqual(inkFor('#ffffff'), '#031a2b');
    assert.strictEqual(inkFor('#000000'), '#ffffff');
    // And whichever it picks is genuinely the better of the two.
    for (const hex of ['#08a2fb', '#ffe066', '#7c3aed', '#45d69a', '#888888']) {
        const ink = inkFor(hex);
        const other = ink === '#ffffff' ? '#031a2b' : '#ffffff';
        assert.ok(
            contrastRatio(parseHex(hex), parseHex(ink)) >= contrastRatio(parseHex(hex), parseHex(other)),
            `${hex} chose the worse ink`,
        );
    }
});

// --- the text and its greys --------------------------------------------------

t('the greys follow the text unless they are chosen', () => {
    // Amber text with the stock grey labels under it is not a theme, it is a
    // half-applied setting.
    const v = textVars({ text: '#ffcc66' }, 'dark');
    assert.strictEqual(v['--text'], '#ffcc66');
    assert.ok(v['--text-dim'] && v['--text-dim'] !== TEXT_DIM_DEFAULT.dark);
    assert.ok(v['--text-faint'] && v['--text-faint'] !== v['--text-dim']);

    // Chosen, and it wins — the clocks are their own decision if somebody wants
    // them to be.
    const both = textVars({ text: '#ffcc66', dim: '#888888' }, 'dark');
    assert.strictEqual(both['--text-dim'], '#888888');
    assert.strictEqual(both['--text-faint'], v['--text-faint'], 'faint still follows the text');
});

t('a grey on its own leaves the text alone', () => {
    const v = textVars({ dim: '#888888' }, 'dark');
    assert.deepStrictEqual(v, { '--text-dim': '#888888' });
    assert.strictEqual(textVars({}, 'dark'), null);
});

t('the derived greys sit between the page and the text, in that order', () => {
    // The hierarchy is the point: faint quieter than dim, dim quieter than text,
    // on a light theme as much as a dark one — where "quieter" reverses.
    for (const [theme, text] of [['dark', '#dfe5ee'], ['light', '#16202e']]) {
        const v = textVars({ text }, theme);
        const l = (hex) => luminance(parseHex(hex));
        const bg = theme === 'dark' ? l('#090c12') : l('#e9edf3');
        const away = (hex) => Math.abs(l(hex) - bg);
        assert.ok(away(v['--text-faint']) < away(v['--text-dim']), theme);
        assert.ok(away(v['--text-dim']) < away(v['--text']), theme);
    }
});

t('the derived greys land within a shade of the stock ones', () => {
    // Which is what says the ratios were measured off the stylesheet rather than
    // picked: a text colour set to the default should look like the default.
    const v = textVars({ text: TEXT_DEFAULT.dark }, 'dark');
    const near = (a, b) => {
        const x = parseHex(a);
        const y = parseHex(b);
        return Math.max(Math.abs(x.r - y.r), Math.abs(x.g - y.g), Math.abs(x.b - y.b));
    };
    assert.ok(near(v['--text-dim'], TEXT_DIM_DEFAULT.dark) <= 14, v['--text-dim']);
    assert.ok(near(v['--text-faint'], TEXT_FAINT_DEFAULT.dark) <= 14, v['--text-faint']);
});

// --- rubbish in --------------------------------------------------------------

t('anything that is not a colour is ignored rather than written out', () => {
    // A hand-edited store, or a value from a build with a different format. Half
    // an interface recoloured is worse than none of it.
    for (const bad of [null, undefined, '', 'blue', '#12', '#1234567', 'rgb(1,2,3)', 42, {}]) {
        assert.strictEqual(accentVars(bad, 'dark'), null, JSON.stringify(bad));
        assert.deepStrictEqual(uiColorVars({ accent: bad, text: bad }, 'dark'), {});
    }
});

t('short hex and stray case are understood', () => {
    // What a hand-typed value or an older store looks like.
    assert.deepStrictEqual(parseHex('#FFF'), { r: 255, g: 255, b: 255 });
    assert.deepStrictEqual(parseHex('08A2FB'), parseHex('#08a2fb'));
    assert.strictEqual(accentVars('  #08A2FB  ', 'dark')['--accent'], '#08a2fb');
});

// --- what the panel warns about ------------------------------------------------

t('contrast is measured against the page, not against the swatch', () => {
    // The one thing an OS colour picker cannot tell you: it knows nothing about
    // what the colour will sit on.
    assert.ok(pageContrast('#ffffff', 'dark') > pageContrast('#333333', 'dark'));
    assert.strictEqual(pageContrast('nonsense', 'dark'), null);
    // A dark grey on the dark page is exactly what the warning is for.
    assert.ok(pageContrast('#2a2f3a', 'dark') < CONTRAST_MIN);
});

t('the faint grey is held to a lower bar, because it is meant to be quiet', () => {
    assert.strictEqual(contrastMin('faint'), CONTRAST_MIN_FAINT);
    for (const which of ['accent', 'text', 'dim']) {
        assert.strictEqual(contrastMin(which), CONTRAST_MIN);
    }
    assert.ok(CONTRAST_MIN_FAINT < CONTRAST_MIN);
});

t('the stock colours are recorded, including the two that fall short', () => {
    // Pinned rather than asserted to pass: the dark theme is 7:1 and up, but the
    // light theme's accent is under AA against its own page and both faint greys
    // are quieter still. That is why the panel measures chosen colours only — and
    // if these numbers ever move, this is where it gets noticed.
    const at = (hex, theme) => Number(pageContrast(hex, theme).toFixed(1));
    assert.strictEqual(at(ACCENT_DEFAULT.dark, 'dark'), 7.1);
    assert.strictEqual(at(TEXT_DEFAULT.dark, 'dark'), 15.5);
    assert.strictEqual(at(TEXT_DIM_DEFAULT.dark, 'dark'), 6.8);
    assert.ok(at(ACCENT_DEFAULT.light, 'light') < CONTRAST_MIN, 'the light accent is 4.0:1');
    assert.ok(at(TEXT_FAINT_DEFAULT.dark, 'dark') >= CONTRAST_MIN_FAINT, 'faint clears its own bar');
    assert.ok(at(TEXT_FAINT_DEFAULT.light, 'light') < CONTRAST_MIN_FAINT, 'the light one does not');
});

// --- the property list ----------------------------------------------------------

t('every property the group can set is in the list that clears them', () => {
    // Applying and clearing walk the same list; one left off it would be a
    // colour that could be set and never unset.
    const all = uiColorVars({
        accent: '#ff0000', text: '#00ff00', dim: '#0000ff', faint: '#ffff00',
    }, 'dark');
    for (const name of Object.keys(all)) {
        assert.ok(UI_COLOR_VARS.includes(name), `${name} missing from UI_COLOR_VARS`);
    }
    assert.strictEqual(Object.keys(all).length, UI_COLOR_VARS.length);
});

console.log(`\n${pass} ok`);

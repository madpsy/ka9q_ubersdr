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
    SPEC_BG, SPEC_INK_DEFAULT, UI_COLOR_KEYS, UI_THEMES, matchUiTheme, parseHex, specInk,
    stationInk, textVars, themeSwatch, uiColorVars, uiColorsFrom,
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
            // Nothing chosen and no operator colour: the stock ink over the
            // canvas, which is what the overlay is really drawn in.
            station: SPEC_INK_DEFAULT,
        });
    }
    // Told what the operator set, the row opens on that instead.
    assert.strictEqual(effectiveColors({}, 'dark', '#ff8800').station, '#ff8800');
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
        station: '#ff00ff',
    }, 'dark');
    for (const name of Object.keys(all)) {
        assert.ok(UI_COLOR_VARS.includes(name), `${name} missing from UI_COLOR_VARS`);
    }
    assert.strictEqual(Object.keys(all).length, UI_COLOR_VARS.length);
});

// --- ink over the canvas --------------------------------------------------

t('the readouts over the waterfall follow a light text colour', () => {
    // A white readout in the corner of an amber interface reads as somebody
    // else's — but the canvas is dark in both themes, so following the text
    // blindly would put black on black half the time.
    assert.strictEqual(specInk('#f3d9a8', 'dark'), '#f3d9a8', 'amber is legible there');
    assert.strictEqual(specInk('#ffffff', 'light'), '#ffffff');
});

t('...and refuse a text colour that would vanish into it', () => {
    // The light theme's own near-black text is the case this exists for: the
    // waterfall stays dark on the light theme, because a light one is unreadable.
    assert.strictEqual(specInk('#16202e', 'light'), null);
    assert.strictEqual(specInk('#222222', 'dark'), null);
    // Null, not a substitute: the stylesheet's own light ink stays in place, and
    // obeying a setting into invisibility is not obedience.
    assert.strictEqual(specInk(null, 'dark'), null);
    assert.strictEqual(specInk('nonsense', 'dark'), null);
});

t('the canvas is dark on both themes, which is why this check exists', () => {
    for (const theme of ['dark', 'light']) {
        assert.ok(luminance(parseHex(SPEC_BG[theme])) < 0.02, theme);
    }
});

t('every preset produces a readable readout over the waterfall', () => {
    // Either by following its own text colour or by leaving the stylesheet's.
    for (const preset of UI_THEMES) {
        const theme = preset.theme || 'dark';
        const ink = uiColorVars(preset.colors, theme)['--spec-ink'];
        if (!ink) continue;                     // falls back to the stock light ink
        const ratio = contrastRatio(parseHex(ink), parseHex(SPEC_BG[theme]));
        assert.ok(ratio >= CONTRAST_MIN, `${preset.id}: ${ratio.toFixed(1)}:1 on the canvas`);
    }
});

// --- the receiver's name over the spectrum ------------------------------------

t('a chosen colour for the receiver info beats everything else', () => {
    // It is the listener's screen and they picked a colour for this specifically,
    // which can only mean they want it.
    assert.strictEqual(stationInk({ station: '#ff0000' }, 'dark', '#00ff00'), '#ff0000');
    assert.strictEqual(uiColorVars({ station: '#ff0000' }, 'dark')['--station-ink'], '#ff0000');
});

t('...then the operator\'s, which a scheme nobody chose must not overrule', () => {
    // Their receiver's name in their receiver's colour. A text colour the
    // listener happens to have set does not get to repaint somebody's branding.
    assert.strictEqual(stationInk({ text: '#c8f5d8' }, 'dark', '#00ff00'), '#00ff00');
    assert.strictEqual(stationInk({}, 'dark', '#00ff00'), '#00ff00');
});

t('...then the ink the rest of the overlay uses, and failing that the stock one', () => {
    assert.strictEqual(stationInk({ text: '#c8f5d8' }, 'dark', null), '#c8f5d8');
    assert.strictEqual(stationInk({}, 'dark', null), SPEC_INK_DEFAULT);
    // A text colour that would vanish into the waterfall does not get there
    // either — the light theme's near-black is the case.
    assert.strictEqual(stationInk({ text: '#16202e' }, 'light', null), SPEC_INK_DEFAULT);
});

t('the station colour is its own property, not folded into the overlay ink', () => {
    // Because the two rank differently against the operator's colour: one
    // overrules it and the other does not, so the draw path has to tell them
    // apart.
    const v = uiColorVars({ text: '#c8f5d8', station: '#ff0000' }, 'dark');
    assert.strictEqual(v['--spec-ink'], '#c8f5d8');
    assert.strictEqual(v['--station-ink'], '#ff0000');
});

// --- the shape a scheme is ------------------------------------------------------

t('applying a preset clears every colour it does not set', () => {
    // A scheme swapped in on top of another's leftovers is neither of them.
    const amber = UI_THEMES.find((p) => p.id === 'amber');
    const full = uiColorsFrom(amber);
    assert.deepStrictEqual(Object.keys(full).sort(), [...UI_COLOR_KEYS].sort());
    assert.strictEqual(full.accent, amber.colors.accent);
    assert.strictEqual(full.dim, null, 'not carried over from whatever was there');
    // And the default clears the lot.
    assert.deepStrictEqual(
        Object.values(uiColorsFrom(UI_THEMES[0])).filter(Boolean),
        [],
    );
});

t('a scheme can carry a receiver-info colour, and matching accounts for it', () => {
    // The mechanism is open to the presets, whether or not one uses it today.
    const scheme = { colors: { accent: '#ff0000', station: '#ff0000' } };
    const full = uiColorsFrom(scheme);
    assert.strictEqual(full.station, '#ff0000');
    // Two sets differing only in that colour are not the same scheme.
    const amber = UI_THEMES.find((p) => p.id === 'amber');
    assert.strictEqual(matchUiTheme(uiColorsFrom(amber)), 'amber');
    assert.strictEqual(matchUiTheme({ ...uiColorsFrom(amber), station: '#ff0000' }), null);
});

// --- the presets ------------------------------------------------------------

t('every preset is legible on its own page', () => {
    // The bar the panel would warn about, applied to the colours it ships with.
    // Two of these needed nudging to clear it, and the one that failed both times
    // was the faint grey — the one nobody checks by eye.
    for (const preset of UI_THEMES) {
        const theme = preset.theme || 'dark';
        const now = effectiveColors(preset.colors, theme);
        for (const which of ['accent', 'text', 'dim', 'faint']) {
            const ratio = pageContrast(now[which], theme);
            assert.ok(
                ratio >= contrastMin(which),
                `${preset.id} ${which}: ${ratio.toFixed(2)}:1 under ${contrastMin(which)}:1`,
            );
        }
    }
});

t('the default preset is the theme\'s own colours, named', () => {
    // Named rather than left as an unlabelled "none", because it is a choice like
    // the others — and because choosing it is how you get back.
    const first = UI_THEMES[0];
    assert.strictEqual(first.id, 'default');
    assert.strictEqual(first.name, 'UberSDR');
    assert.deepStrictEqual(first.colors, {}, 'sets nothing, so each theme keeps its own');
    assert.strictEqual(first.theme, undefined, 'and does not drag the theme with it');
});

t('each preset says which theme it was drawn for', () => {
    // Amber on white is a highlighter. Only the default is theme-agnostic.
    for (const preset of UI_THEMES.slice(1)) {
        assert.ok(['dark', 'light'].includes(preset.theme), preset.id);
        assert.ok(preset.name && preset.note, preset.id);
    }
    assert.ok(UI_THEMES.some((p) => p.theme === 'light'), 'at least one for a bright room');
});

t('a preset is recognised by its colours, not by a remembered name', () => {
    // The pickers are the truth and any of them can be nudged afterwards, so a
    // stored id would go on claiming a scheme that had been edited out from under
    // it.
    for (const preset of UI_THEMES) {
        assert.strictEqual(matchUiTheme(preset.colors), preset.id, preset.id);
    }
    assert.strictEqual(matchUiTheme({}), 'default', 'nothing set is the default');
    assert.strictEqual(matchUiTheme({ accent: '#123456' }), null, 'a colour nobody ships');
    // One value changed and it is nobody's scheme any more, which is what the
    // panel's "custom" hint is for.
    const amber = UI_THEMES.find((p) => p.id === 'amber');
    assert.strictEqual(matchUiTheme({ ...amber.colors, dim: '#888888' }), null);
});

t('there is a scheme for low vision, and it does not fade anything', () => {
    // The point of it, and the thing a "high contrast" theme usually gets wrong:
    // the headline text is never the problem. What is unreadable is everything
    // the design steps back — labels, units, the clocks, placeholders — so this
    // one sets all four values rather than letting the quiet two follow the text
    // down to where the ordinary theme has them.
    const hc = UI_THEMES.find((p) => p.id === 'contrast');
    assert.ok(hc, 'a high-contrast scheme is offered');
    const now = effectiveColors(hc.colors, hc.theme);
    for (const which of ['accent', 'text', 'dim', 'faint']) {
        assert.ok(hc.colors[which], `${which} is set outright, not derived`);
        // AAA for body text, on every one of them including the faint grey.
        assert.ok(
            pageContrast(now[which], hc.theme) >= 7,
            `${which}: ${pageContrast(now[which], hc.theme).toFixed(1)}:1`,
        );
    }
    // And the accent has to differ from the text in *brightness*, not only in
    // hue — the distinction reduced colour discrimination takes away first. A
    // bright yellow was the obvious choice here and failed this: 13.7:1 against
    // the page and 1.4:1 against the white beside it, which in greyscale is the
    // same colour twice.
    assert.ok(
        contrastRatio(parseHex(now.accent), parseHex(now.text)) >= 1.8,
        'the accent vanishes into the text when hue is taken away',
    );
});

t('the night scheme is actually red', () => {
    // The first attempt was a salmon — as much green and blue in it as red — which
    // is a warm grey with a cast, not a night mode: what costs dark adaptation is
    // the short wavelengths, and a scheme that keeps them has done nothing.
    const night = UI_THEMES.find((p) => p.id === 'night');
    for (const hex of Object.values(night.colors)) {
        const { r, g, b } = parseHex(hex);
        assert.ok(r > g * 1.6 && r > b * 1.6, `${hex} is not red enough`);
        assert.ok(b <= g, `${hex} has more blue than green in it`);
    }
});

t('the ids and names are unique, so the grid cannot show two of anything', () => {
    const ids = UI_THEMES.map((p) => p.id);
    const names = UI_THEMES.map((p) => p.name);
    assert.strictEqual(new Set(ids).size, ids.length);
    assert.strictEqual(new Set(names).size, names.length);
});

t('a swatch is drawn in the scheme\'s own three colours', () => {
    // What is on the button has to be what the interface will look like, or the
    // grid is a row of guesses.
    for (const preset of UI_THEMES) {
        const sw = themeSwatch(preset);
        for (const v of Object.values(sw)) assert.ok(parseHex(v), `${preset.id}: ${v}`);
        // The default has no colours of its own, so its swatch borrows the
        // theme's — which is exactly what choosing it produces.
        if (preset.colors.accent) assert.strictEqual(sw.accent, preset.colors.accent);
    }
});

console.log(`\n${pass} ok`);

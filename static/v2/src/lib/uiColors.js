// The two colours the interface is built out of, and everything derived from
// them.
//
// Every highlight in this app is `--accent` — the tuned frequency, a selected
// mode, the dial line on the spectrum, every focus ring — and every word in it is
// `--text`. Two custom properties and something like two hundred uses, which is
// what makes them worth offering and what makes each of them more than one
// value, because the stylesheet derives others from both and the derivations are
// not obvious:
//
//   --accent-ink   what is legible *on top* of a fill of the accent. A pale one
//                  needs dark text and a deep one needs white, and getting it
//                  wrong is a button whose label vanishes.
//   --accent-soft  the accent as a wash, behind a selected row or a drop target.
//   --accent-line  the same again at rule strength, for hairlines.
//   --text-dim     the quieter text — labels, units, anything secondary.
//   --text-faint   quieter still: placeholders, disabled things, the empty state.
//
// So each picker sets one value and this works out the rest. All of it is
// arithmetic on a hex string, which is why it is here rather than in the panel.

// What each theme uses when nothing has been chosen — the blue off the
// receiver's own mark, and the near-white it prints in. Kept here as well as in
// the stylesheet so a picker can open on the colour actually in force rather than
// on black, and so "back to the default" has something to say.
export const ACCENT_DEFAULT = { dark: '#08a2fb', light: '#0b78c4' };
export const TEXT_DEFAULT = { dark: '#dfe5ee', light: '#16202e' };
// The two quieter greys as the stylesheet actually writes them. Not the derived
// values: those land within a shade but not on the nose, and an untouched picker
// has to open on the colour that is really on screen.
export const TEXT_DIM_DEFAULT = { dark: '#8d99ad', light: '#5d6a7d' };
export const TEXT_FAINT_DEFAULT = { dark: '#5c6779', light: '#8996a8' };

// The page behind them, per theme — the stylesheet's own --bg. Both the contrast
// check and the derived greys are measured against it.
export const PAGE_BG = { dark: '#090c12', light: '#e9edf3' };

// The spectrum canvas, which is dark in *both* themes: a light waterfall is
// unreadable, so the stylesheet keeps --spec-bg near black even on the light one.
// Anything drawn over it therefore cannot use the page's text colour without
// being checked first — see specInk.
export const SPEC_BG = { dark: '#0a0e15', light: '#0d1219' };

// The ink for text over the canvas — the stats overlay, and anything else that
// ends up there. Light in both themes, because the canvas is.
export const SPEC_INK_DEFAULT = '#e8edf5';

// How far from the background toward the text colour the two quieter greys sit.
//
// Measured off the stylesheet's own values rather than invented, and the finding
// is that both themes already agree: dim lands at 0.62–0.70 of the way in each
// channel and faint at 0.38–0.47, on the dark theme and on the light one alike.
// So one pair of ratios reproduces all four stock greys to within a shade, and a
// chosen text colour keeps the hierarchy — and the hue — instead of leaving amber
// text with grey labels under it.
const DIM_MIX = 0.65;
const FAINT_MIX = 0.42;

// The ink candidates, and the alphas each theme washes with — both taken from
// the stylesheet's own values so an unchanged accent renders identically whether
// it is the default or the same colour chosen by hand.
const INK_DARK = '#031a2b';
const INK_LIGHT = '#ffffff';
const SOFT_ALPHA = { dark: 0.13, light: 0.12 };
const LINE_ALPHA = { dark: 0.4, light: 0.35 };

const key = (theme) => (theme === 'light' ? 'light' : 'dark');

export function accentDefault(theme) {
    return ACCENT_DEFAULT[key(theme)];
}

export function textDefault(theme) {
    return TEXT_DEFAULT[key(theme)];
}

/** `#rgb` or `#rrggbb` to channels, or null for anything else. */
export function parseHex(hex) {
    const s = String(hex || '').trim();
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (!m) return null;
    const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
    return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
    };
}

// WCAG relative luminance. The gamma curve matters here rather than a plain
// average: a saturated yellow and a saturated blue of the same "brightness" by
// eye are nowhere near the same by contrast, and the whole point of this is
// picking readable ink.
export function luminance({ r, g, b }) {
    const c = (v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}

// Named for what it returns rather than the plain `contrast`: this is a module
// everything imports from, and "contrast" is already a display setting, a slider
// and a prop in half a dozen files — test/unresolved.js refuses the collision,
// and it is right to.
export function contrastRatio(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    const hi = Math.max(la, lb);
    const lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
}

/**
 * Which of the two inks to print on a fill of `hex`.
 *
 * Measured rather than assumed from a lightness threshold: the dark ink is not
 * black but a very dark blue, so where the two candidates cross is not where a
 * 50% rule would put it.
 */
export function inkFor(hex) {
    const rgb = parseHex(hex);
    if (!rgb) return null;
    return contrastRatio(rgb, parseHex(INK_DARK)) >= contrastRatio(rgb, parseHex(INK_LIGHT))
        ? INK_DARK
        : INK_LIGHT;
}

/**
 * The custom properties to set for a chosen accent, or null to leave the
 * stylesheet's own alone.
 *
 * Null in, null out — "not chosen" is a state, and it is the one where each
 * theme keeps the blue it was designed around.
 */
export function accentVars(hex, theme) {
    const rgb = parseHex(hex);
    if (!rgb) return null;
    const t = key(theme);
    const rgbCsv = `${rgb.r}, ${rgb.g}, ${rgb.b}`;
    return {
        '--accent': hex.trim().toLowerCase(),
        '--accent-ink': inkFor(hex),
        '--accent-soft': `rgba(${rgbCsv}, ${SOFT_ALPHA[t]})`,
        '--accent-line': `rgba(${rgbCsv}, ${LINE_ALPHA[t]})`,
    };
}

// A step from the background toward `hex`, as a hex string. Plain channel
// interpolation: these are two colours a few shades apart on the same page, not a
// gradient anybody will look at closely, and a perceptual blend would differ from
// this by less than the rounding does.
function mixToward(bg, fg, t) {
    const a = parseHex(bg);
    const b = parseHex(fg);
    if (!a || !b) return null;
    const ch = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
    return `#${ch(a.r, b.r)}${ch(a.g, b.g)}${ch(a.b, b.b)}`;
}

const norm = (hex) => String(hex).trim().toLowerCase();

/**
 * The custom properties for the three text colours, or null for none set.
 *
 * The quieter two follow the main one unless they have been chosen themselves:
 * they are steps from the page toward the text, so a text colour changed on its
 * own would otherwise be a heading in amber with its labels still in grey. Set
 * one of them explicitly and that wins — the clocks, the units and every other
 * secondary line are their own decision if somebody wants them to be.
 *
 * With nothing set at all this returns null and the stylesheet's own values
 * stand. That matters more than it looks: the derived greys land within a shade
 * of the stock ones but not exactly on them, and "I have changed nothing" should
 * mean nothing has changed.
 */
export function textVars({ text, dim, faint } = {}, theme) {
    const bg = PAGE_BG[key(theme)];
    const out = {};
    if (parseHex(text)) {
        out['--text'] = norm(text);
        out['--text-dim'] = mixToward(bg, text, DIM_MIX);
        out['--text-faint'] = mixToward(bg, text, FAINT_MIX);
    }
    if (parseHex(dim)) out['--text-dim'] = norm(dim);
    if (parseHex(faint)) out['--text-faint'] = norm(faint);
    return Object.keys(out).length ? out : null;
}

// Every property the two groups own, so applying and clearing cannot drift
// apart — a cleared colour that left one property behind would be a
// half-recoloured interface with no control pointing at it.
export const UI_COLOR_VARS = [
    '--accent', '--accent-ink', '--accent-soft', '--accent-line',
    '--text', '--text-dim', '--text-faint',
    '--spec-ink', '--station-ink',
];

// How readable the interface will be with a colour, so the panel can say so
// before the operator finds out by trying to read a button.
//
// Against the page: text in the accent — a tuned frequency, a link, a hovered
// control — is where a bad accent actually hurts, and for the text colour it is
// the whole question. That pairing is the one thing an OS colour picker cannot
// show you.
//
// 4.5:1 is WCAG AA for body text, and it is the bar for everything except the
// faint grey, which is deliberately quiet — placeholders, disabled controls, an
// empty panel — and would fail a body-text bar by design. 3:1 is the large-text
// and non-text bar, and the right one to hold it to.
//
// Only ever applied to a colour somebody chose. The dark theme's own values are
// 7:1 and up, but the light theme's accent is 3.97:1 against its page and its
// faint grey is 2.56:1 — so a panel that measured the defaults would open by
// warning about the receiver's own design, which is noise rather than advice.
export const CONTRAST_MIN = 4.5;
export const CONTRAST_MIN_FAINT = 3;

export function contrastMin(which) {
    return which === 'faint' ? CONTRAST_MIN_FAINT : CONTRAST_MIN;
}

export function pageContrast(hex, theme) {
    const rgb = parseHex(hex);
    if (!rgb) return null;
    return contrastRatio(rgb, parseHex(PAGE_BG[key(theme)]));
}

/**
 * The ink for text drawn over the spectrum canvas, given the chosen text colour.
 *
 * The overlay used to be plain white, which was right when there was one text
 * colour and it was near-white. With the colour settable it looks foreign — amber
 * everywhere and a white readout in the corner — so it follows the text where it
 * can, and the check is whether it can: the canvas stays dark in both themes, so
 * a light theme's near-black text, or anybody's dark choice, would be a readout
 * that has disappeared into the waterfall.
 *
 * Null when the chosen colour will not do, which leaves the stylesheet's own
 * light ink in place. That is the honest fallback — the alternative is obeying
 * the setting into illegibility.
 */
export function specInk(hex, theme) {
    const rgb = parseHex(hex);
    if (!rgb) return null;
    const bg = parseHex(SPEC_BG[key(theme)]);
    return contrastRatio(rgb, bg) >= CONTRAST_MIN ? norm(hex) : null;
}

/** Contrast against the canvas rather than the page, for anything drawn on it. */
export function canvasContrast(hex, theme) {
    const rgb = parseHex(hex);
    if (!rgb) return null;
    return contrastRatio(rgb, parseHex(SPEC_BG[key(theme)]));
}

/**
 * The colour the receiver's name and location are drawn in, and the order the
 * three possible answers are asked in.
 *
 * A listener's own choice first: it is their screen, and choosing a colour for
 * this specifically can only mean they want it. Then the operator's, from the
 * server's ui-config — that is their receiver's name in their receiver's colour,
 * and a scheme nobody chose should not overrule it. Then the interface's ink over
 * the canvas, which is what an untouched overlay follows.
 */
export function stationInk(colors = {}, theme, serverColor) {
    if (parseHex(colors.station)) return norm(colors.station);
    if (parseHex(serverColor)) return norm(serverColor);
    return specInk(colors.text, theme) || SPEC_INK_DEFAULT;
}

/** Everything to set on the root, from the whole settings group. */
export function uiColorVars(colors = {}, theme) {
    const out = {
        ...(accentVars(colors.accent, theme) || {}),
        ...(textVars(colors, theme) || {}),
    };
    const ink = specInk(colors.text, theme);
    if (ink) out['--spec-ink'] = ink;
    // Its own property rather than folded into --spec-ink: this one overrules the
    // operator's colour and the other does not, so the draw path has to be able
    // to tell them apart. See stationInk and drawStationId.
    if (parseHex(colors.station)) out['--station-ink'] = norm(colors.station);
    return out;
}

/**
 * The colour each picker should open on: what is actually in force.
 *
 * A picker showing black for "unset" is a picker that lies about what the screen
 * looks like, and a first drag from black is a first drag from nowhere near where
 * you were.
 */
export function effectiveColors(colors = {}, theme, serverStation) {
    const vars = uiColorVars(colors, theme);
    const t = key(theme);
    return {
        accent: vars['--accent'] || ACCENT_DEFAULT[t],
        text: vars['--text'] || TEXT_DEFAULT[t],
        dim: vars['--text-dim'] || TEXT_DIM_DEFAULT[t],
        faint: vars['--text-faint'] || TEXT_FAINT_DEFAULT[t],
        station: stationInk(colors, theme, serverStation),
    };
}

// ── Presets ──────────────────────────────────────────────────────────────────
//
// A starting point, not a mode: choosing one writes its colours into the same
// four settings the pickers edit, and every one of them can then be changed. So
// there is nothing to "be on" — the panel works out which preset the current
// colours match, if any, and says so.
//
// Each carries the theme it was drawn for, because half of these do not make
// sense on the other one: amber on white is a highlighter, and Paper on black is
// a light box. The default carries none and leaves the theme alone, since it *is*
// the theme's own colours, whichever theme that is.
//
// Every preset clears the contrast bar the panel would warn about — measured, not
// eyeballed, and pinned in test/uicolors.test.js. Two of them needed a nudge to
// get there, which is the argument for measuring: the faint grey is the one that
// fails, and it is the one nobody checks.
export const UI_THEMES = [
    {
        id: 'default',
        name: 'UberSDR',
        note: 'The receiver\'s own blue on the dark page',
        // Nothing set: this is what "no colours chosen" looks like, and choosing it is
        // how you get back there.
        //
        // It carries the dark base like every other scheme here, because the top bar's
        // menu is a list of schemes and nothing else now — so each one has to answer
        // "dark or light" on its own. There is deliberately no light twin of it: the
        // stock accent measures 3.97:1 on a white page, under the bar every preset in
        // this list clears, and Paper is the scheme that exists to be the light one.
        // The Display panel still puts any colours on either base for anybody building
        // their own.
        theme: 'dark',
        colors: {},
    },
    {
        id: 'contrast',
        name: 'High contrast',
        note: 'Maximum legibility: white on near-black, and secondary text that is not faded',
        theme: 'dark',
        // For low vision, and the reason all four values are set rather than
        // three derived: the failure mode of this interface is not the headline
        // text, it is everything the design quietly steps back — labels, units,
        // the clocks, placeholders. Left to follow, they would land at 6.8:1 and
        // 3.4:1, which is the ordinary theme again. Here they are 17:1 and 12:1,
        // so the hierarchy is carried by weight and size rather than by fading
        // things until they are hard to read.
        //
        // Amber for the accent, and specifically not the brighter yellow this
        // started as. That was 13.7:1 against the page and looked ideal, but it
        // is only 1.4:1 against the white text beside it: the two differ in hue
        // and hardly at all in brightness, which is the one distinction reduced
        // colour discrimination takes away. This one is 9.6:1 on the page and
        // 2.0:1 against the text, so a highlight reads as a highlight even to
        // someone seeing it in greyscale — and amber survives every common colour
        // vision deficiency, which a green or a red accent does not.
        colors: {
            accent: '#ffa000', text: '#ffffff', dim: '#eef1f5', faint: '#c9ced6',
        },
    },
    {
        id: 'amber',
        name: 'Amber',
        note: 'An amber monitor, as the first ones were',
        theme: 'dark',
        colors: { accent: '#ffb000', text: '#f3d9a8' },
    },
    {
        id: 'phosphor',
        name: 'Phosphor',
        note: 'Green screen',
        theme: 'dark',
        colors: { accent: '#35e07a', text: '#c8f5d8' },
    },
    {
        id: 'night',
        name: 'Night',
        note: 'Deep red only, to keep your dark adaptation at the radio',
        theme: 'dark',
        // Red the way a night scheme means it. The first attempt at this was a
        // salmon — #ff7a63, which carries nearly as much green and blue as red —
        // and that is not a night mode, it is a warm grey with a red cast: what
        // costs an observer their dark adaptation is the short wavelengths, and
        // a scheme that keeps them has done nothing.
        //
        // All four set, because the derived greys of a red text come out below
        // the bar — the faint one at 2.4:1 — and a scheme for reading in the dark
        // cannot have unreadable labels in it.
        colors: {
            accent: '#ff4b2e', text: '#ff9b84', dim: '#c96a58', faint: '#8f4c3f',
        },
    },
    {
        id: 'ice',
        name: 'Ice',
        note: 'Cyan on near-black',
        theme: 'dark',
        colors: { accent: '#45d6e6', text: '#dcf0f5' },
    },
    {
        id: 'violet',
        name: 'Violet',
        note: 'The violet the app already uses for its second colour',
        theme: 'dark',
        colors: { accent: '#a58bff', text: '#e4dff7' },
    },
    {
        id: 'mono',
        name: 'Mono',
        note: 'No hue in the interface at all — everything says what it is by weight',
        theme: 'dark',
        colors: { accent: '#aab6c6', text: '#e2e7ee' },
    },
    {
        id: 'paper',
        name: 'Paper',
        // Its faint grey is set rather than derived: on a white page the derived
        // one lands at 2.5:1, which is where the stock light theme sits and below
        // where this is prepared to leave it.
        note: 'Ink on paper, for a bright room',
        theme: 'light',
        colors: { accent: '#0a5ea8', text: '#16202e', faint: '#6f7885' },
    },
];

// Every colour a scheme can carry, and the shape the pickers edit. Listed once so
// applying a preset clears the ones it does not set — a scheme swapped in on top
// of another's leftovers is neither of them.
export const UI_COLOR_KEYS = ['accent', 'text', 'dim', 'faint', 'station'];

/** A preset's colours as a full set, with everything it leaves out cleared. */
export function uiColorsFrom(preset) {
    const out = {};
    for (const k of UI_COLOR_KEYS) out[k] = (preset && preset.colors && preset.colors[k]) || null;
    return out;
}

const sameColor = (a, b) => (a ? norm(a) : null) === (b ? norm(b) : null);

/**
 * Which preset the current colours are, or null for a set that is nobody's.
 *
 * By value rather than by a stored id, deliberately: the pickers are the truth
 * and any of them can be nudged afterwards, so a remembered name would go on
 * claiming a preset that had been edited out from under it.
 *
 * The theme is not compared. Amber on the light theme is still Amber's colours —
 * unusual, but the operator's business, and un-naming it would only be confusing.
 */
export function matchUiTheme(colors = {}) {
    const has = (c) => UI_COLOR_KEYS.some((k) => c[k]);
    for (const preset of UI_THEMES) {
        const p = preset.colors;
        if (!has(p) && !has(colors)) return preset.id;
        if (!has(p) || !has(colors)) continue;
        if (UI_COLOR_KEYS.every((k) => sameColor(p[k], colors[k]))) return preset.id;
    }
    return null;
}

/** The swatch a preset is drawn as: its accent over its page. */
export function themeSwatch(preset) {
    const t = key(preset.theme);
    return {
        bg: PAGE_BG[t],
        accent: preset.colors.accent || ACCENT_DEFAULT[t],
        text: preset.colors.text || TEXT_DEFAULT[t],
    };
}

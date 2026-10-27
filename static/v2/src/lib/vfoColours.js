// One colour per VFO letter, for wherever a listening VFO is drawn.
//
// With several VFOs playing at once the operator has to be able to tell at a
// glance which passband on the spectrum, which marker on the bar and which row in
// the VFOs panel is the one they are hearing on the left. A colour per letter,
// fixed rather than themed, is what lets the three be matched without reading a
// label: B is green everywhere.
//
// The hues are chosen by what they must not be confused with, which is most of
// the screen:
//
//   the accent blue      the main receiver's dial and every active control
//                        (#08a2fb dark, #0b78c4 light)
//   the marker-bar pink  a *parked* VFO (MarkerBar VFO_FILL). A listening VFO is
//                        a different thing from a parked one and must not look
//                        like it.
//   --spec-band purple   the main receiver's passband wash
//
// That leaves the warm half of the wheel and the greens, so the four are spread
// across it — yellow, green, red-orange, turquoise — and kept bright, because
// they are drawn on the spectrum's near-black canvas in both themes (the light
// theme lightens the chrome, not the picture). vfocolours.test.js holds them to
// both rules, so a later change of heart about one hue cannot quietly put it on
// top of another.

export const VFO_COLOURS = Object.freeze({
    A: '#ffd23f',   // yellow
    B: '#3ee07f',   // green
    C: '#ff5a36',   // red-orange
    D: '#2ee6d0',   // turquoise
});

// The ones the palette is kept away from, for the test.
export const AVOID_COLOURS = Object.freeze({
    accentDark: '#08a2fb',
    accentLight: '#0b78c4',
    storedVfo: '#e91e63',
    specBand: '#8b7cf8',
});

/** A letter's colour, or a neutral grey for anything that is not A–D. */
export function vfoColour(id) {
    return VFO_COLOURS[id] || '#9aa4b2';
}

/** `#rrggbb` as [r, g, b], 0..255. */
export function hexRgb(hex) {
    const h = String(hex).replace('#', '');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/** A letter's colour at `alpha`, for washes and stems. */
export function vfoRgba(id, alpha) {
    const [r, g, b] = hexRgb(vfoColour(id));
    const a = Math.max(0, Math.min(1, Number(alpha) || 0));
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Hue in degrees, 0..360. */
export function hueOf(hex) {
    const [r, g, b] = hexRgb(hex).map((v) => v / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (d === 0) return 0;
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return (h * 60 + 360) % 360;
}

/** WCAG relative luminance, 0..1. */
export function luminance(hex) {
    const [r, g, b] = hexRgb(hex).map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

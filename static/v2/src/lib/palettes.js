// Waterfall colour maps.
//
// Each palette is a short list of control points that gets expanded into a
// 256-entry Uint8ClampedArray LUT (RGB triplets) once, at module load.

const STOPS = {
    turbo: [
        [0.00, 48, 18, 59], [0.13, 70, 107, 227], [0.25, 54, 168, 237],
        [0.38, 42, 217, 184], [0.50, 118, 244, 112], [0.63, 200, 246, 56],
        [0.75, 253, 197, 39], [0.88, 245, 111, 25], [1.00, 122, 4, 3],
    ],
    viridis: [
        [0.00, 68, 1, 84], [0.25, 59, 82, 139], [0.50, 33, 145, 140],
        [0.75, 94, 201, 98], [1.00, 253, 231, 37],
    ],
    inferno: [
        [0.00, 0, 0, 4], [0.25, 87, 16, 110], [0.50, 188, 55, 84],
        [0.75, 249, 142, 9], [1.00, 252, 255, 164],
    ],
    magma: [
        [0.00, 0, 0, 4], [0.25, 81, 18, 124], [0.50, 183, 55, 121],
        [0.75, 252, 137, 97], [1.00, 252, 253, 191],
    ],
    // Classic SDR look: black -> blue -> cyan -> yellow -> white
    classic: [
        [0.00, 0, 0, 0], [0.20, 0, 0, 140], [0.40, 0, 160, 220],
        [0.62, 240, 230, 60], [0.82, 240, 90, 30], [1.00, 255, 255, 255],
    ],
    // Monochrome, for print-like clarity
    mono: [
        [0.00, 4, 5, 8], [1.00, 245, 248, 255],
    ],
    // Cool single-hue that matches the UI accent
    ice: [
        [0.00, 4, 8, 16], [0.35, 12, 66, 104], [0.7, 62, 180, 208],
        [1.00, 226, 250, 255],
    ],
};

function buildLUT(stops) {
    const lut = new Uint8ClampedArray(256 * 3);
    let seg = 0;
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        while (seg < stops.length - 2 && t > stops[seg + 1][0]) seg++;
        const a = stops[seg];
        const b = stops[seg + 1];
        const span = b[0] - a[0] || 1;
        const f = (t - a[0]) / span;
        lut[i * 3 + 0] = a[1] + (b[1] - a[1]) * f;
        lut[i * 3 + 1] = a[2] + (b[2] - a[2]) * f;
        lut[i * 3 + 2] = a[3] + (b[3] - a[3]) * f;
    }
    return lut;
}

const CACHE = {};
for (const name of Object.keys(STOPS)) CACHE[name] = buildLUT(STOPS[name]);

export const PALETTE_NAMES = Object.keys(STOPS);

export function getPalette(name) {
    return CACHE[name] || CACHE.turbo;
}

// CSS gradient string for palette swatches in the UI.
export function paletteGradient(name) {
    const stops = STOPS[name] || STOPS.turbo;
    const parts = stops.map(([t, r, g, b]) => `rgb(${r},${g},${b}) ${(t * 100).toFixed(0)}%`);
    return `linear-gradient(90deg, ${parts.join(', ')})`;
}

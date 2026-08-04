// QRSS: the signal processing and the numbers that fall out of it.
//
// QRSS is Morse sent so slowly that a dot lasts seconds. Nothing decodes it —
// you read it off a waterfall by eye, because integrating for seconds per pixel
// is what pulls a beacon out from ten or twenty dB below the noise. So this
// extension is a spectrogram, not a decoder, and unlike every other extension
// here it runs entirely in the browser: there is no server side.
//
// The chain is the standard zoom-FFT one, and the same one v1 used:
//
//   demodulated audio  →  worklet: mix down by fc, low-pass, decimate by D
//                      →  overlapping complex FFT of N points, Hann windowed
//                      →  one waterfall column per FFT, 10·log10 power
//
// Down-converting first is what makes the resolution affordable. To resolve
// 0.1 Hz at 48 kHz directly needs a half-million-point FFT; decimating to a
// 200 Hz bandwidth first gets there with 2048 points, and lets the display zoom
// onto a signal anywhere in the passband rather than only near DC.
//
// Everything here is pure: the worklet is in /qrss-ddc-worklet.js and the
// canvas work is in ./render.js.

// ── Colour maps ─────────────────────────────────────────────────────────────
// Control points, interpolated once into a 256-entry lookup table. v1's, and
// worth keeping as they are: a QRSS operator recognises a band by its palette,
// and grayscale is the default because faint streaks read best without hue.

export const COLORMAPS = {
    grayscale: [
        [0.00, 0, 0, 0], [1.00, 255, 255, 255],
    ],
    qrss: [
        [0.00, 0, 0, 0], [0.15, 0, 0, 80], [0.35, 0, 80, 160],
        [0.50, 0, 180, 180], [0.65, 0, 200, 60], [0.80, 230, 230, 0],
        [0.92, 230, 60, 0], [1.00, 255, 255, 255],
    ],
    viridis: [
        [0.000, 68, 1, 84], [0.125, 72, 40, 120], [0.250, 62, 74, 137],
        [0.375, 49, 104, 142], [0.500, 38, 130, 142], [0.625, 31, 158, 137],
        [0.750, 53, 183, 121], [0.875, 110, 206, 88], [1.000, 253, 231, 37],
    ],
    inferno: [
        [0.000, 0, 0, 4], [0.125, 31, 12, 72], [0.250, 85, 15, 109],
        [0.375, 136, 34, 106], [0.500, 186, 54, 85], [0.625, 227, 89, 51],
        [0.750, 249, 140, 10], [0.875, 249, 201, 50], [1.000, 252, 255, 164],
    ],
    afmhot: [
        [0.00, 0, 0, 0], [0.33, 170, 0, 0], [0.66, 255, 170, 0], [1.00, 255, 255, 255],
    ],
};

export const PALETTES = [
    { id: 'grayscale', label: 'Gray' },
    { id: 'qrss', label: 'QRSS' },
    { id: 'viridis', label: 'Viridis' },
    { id: 'inferno', label: 'Inferno' },
    { id: 'afmhot', label: 'Heat' },
];

/** A 256×RGB lookup table for a palette. */
export function buildColorLUT(name) {
    const pts = COLORMAPS[name] || COLORMAPS.grayscale;
    const lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        let a = pts[0];
        let b = pts[pts.length - 1];
        for (let k = 0; k < pts.length - 1; k++) {
            if (t >= pts[k][0] && t <= pts[k + 1][0]) { a = pts[k]; b = pts[k + 1]; break; }
        }
        const span = (b[0] - a[0]) || 1;
        const f = (t - a[0]) / span;
        lut[i * 3] = a[1] + (b[1] - a[1]) * f;
        lut[i * 3 + 1] = a[2] + (b[2] - a[2]) * f;
        lut[i * 3 + 2] = a[3] + (b[3] - a[3]) * f;
    }
    return lut;
}

// ── Radix-2 FFT ─────────────────────────────────────────────────────────────

/**
 * In-place complex FFT with precomputed bit-reversal and twiddle tables.
 *
 * Complex rather than real: the worklet hands us I/Q from a down-converter, and
 * the spectrum either side of the centre frequency is not symmetric — which is
 * the whole point of tuning the display onto a signal.
 */
export class FFT {
    constructor(n) {
        this.n = n;
        this.cos = new Float32Array(n / 2);
        this.sin = new Float32Array(n / 2);
        for (let i = 0; i < n / 2; i++) {
            this.cos[i] = Math.cos(-2 * Math.PI * i / n);
            this.sin[i] = Math.sin(-2 * Math.PI * i / n);
        }
        this.rev = new Uint32Array(n);
        const bits = Math.log2(n);
        for (let i = 0; i < n; i++) {
            let x = i;
            let r = 0;
            for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
            this.rev[i] = r;
        }
    }

    /** `re` and `im` are Float32Array(n), transformed in place. */
    transform(re, im) {
        const { n, rev, cos, sin } = this;
        for (let i = 0; i < n; i++) {
            const j = rev[i];
            if (j > i) {
                let t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }
        for (let size = 2; size <= n; size <<= 1) {
            const half = size >> 1;
            const step = n / size;
            for (let i = 0; i < n; i += size) {
                for (let j = i, k = 0; j < i + half; j++, k += step) {
                    const c = cos[k];
                    const s = sin[k];
                    const tr = re[j + half] * c - im[j + half] * s;
                    const ti = re[j + half] * s + im[j + half] * c;
                    re[j + half] = re[j] - tr;
                    im[j + half] = im[j] - ti;
                    re[j] += tr;
                    im[j] += ti;
                }
            }
        }
    }
}

/** Hann window of `n` points, as the FFT is fed through. */
export function hannWindow(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
    return w;
}

/**
 * Anti-alias filter for the decimator: a windowed sinc, unity gain at DC.
 *
 * Cutoff is half the decimated rate, which is what stops everything outside the
 * displayed span folding back into it — the failure that would put a mirror
 * image of a strong signal in the middle of an otherwise empty waterfall.
 */
export function designLowpass(decim) {
    if (decim <= 1) return new Float32Array([1]);
    let taps = Math.min(511, (8 * decim) | 1);
    if ((taps & 1) === 0) taps++;                 // must be odd for a linear phase
    const fc = 0.5 / decim;
    const c = (taps - 1) / 2;
    const h = new Float32Array(taps);
    let sum = 0;
    for (let n = 0; n < taps; n++) {
        const x = n - c;
        const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
        const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / (taps - 1));   // Hamming
        h[n] = sinc * w;
        sum += h[n];
    }
    for (let n = 0; n < taps; n++) h[n] /= sum;
    return h;
}

// ── settings ────────────────────────────────────────────────────────────────

// Displayed bandwidth. 200 Hz is the QRSS convention — a whole band's beacons
// live inside 100 Hz of one another — and the wider ones are for finding them.
export const SPANS = [6000, 3000, 1500, 750, 375, 200, 100];

// FFT size, named by what it costs rather than by its number: a longer
// transform resolves finer but takes longer to fill before the first column.
export const RESOLUTIONS = [
    { value: 2048, label: 'Fast' },
    { value: 4096, label: 'Normal' },
    { value: 8192, label: 'Fine' },
];

// Seconds per pixel column. The named ones are the QRSS dot lengths people
// actually transmit: QRSS-3, -10, -30 and -60 are 3, 10, 30 and 60 second dots.
export const SPEEDS = [
    { value: 0.25, label: 'Fast · 0.25 s/px' },
    { value: 0.5, label: '0.5 s/px' },
    { value: 1, label: 'Normal · 1 s/px' },
    { value: 2, label: '2 s/px · QRSS-10' },
    { value: 3, label: 'Slow · 3 s/px' },
    { value: 5, label: '5 s/px · QRSS-30' },
    { value: 10, label: '10 s/px' },
    { value: 15, label: '15 s/px' },
    { value: 20, label: 'Very slow · 20 s/px · QRSS-60' },
];

// Total time on screen. Locking it holds the sweep across a window resize,
// which Speed alone cannot: the same seconds-per-pixel over more pixels is a
// longer sweep, and a grabber you have widened should still show ten minutes.
export const WINDOWS = [
    { value: 0, label: 'Auto' },
    { value: 300, label: '5 min' },
    { value: 600, label: '10 min' },
    { value: 1200, label: '20 min' },
    { value: 1800, label: '30 min' },
    { value: 3600, label: '60 min' },
];

// Auto-contrast sensitivity, as dB of range above the tracked noise floor.
// Tighter makes a weak signal pop; wider is gentler on a band full of traffic.
export const AUTO_LEVELS = [
    { id: 'high', label: 'High', span: 15 },
    { id: 'med', label: 'Med', span: 25 },
    { id: 'low', label: 'Low', span: 40 },
];

export const QRSS_CONFIG = {
    span: 200,
    centerHz: null,        // null puts the view at [0, span]
    fftSize: 2048,
    secPerPixel: 1,
    windowSec: 0,          // 0 is Auto; above that, Speed is derived from width
    colormap: 'grayscale',
    dbMin: -110,
    dbMax: -60,
    autoContrast: true,
    autoLevel: 'high',
};

export function autoSpanOf(level) {
    const hit = AUTO_LEVELS.find((l) => l.id === level);
    return hit ? hit.span : 15;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Everything the capture chain and the axes need, from the settings.
 *
 * The decimation is chosen so the complex baseband bandwidth is about the
 * requested span; the hop is derived from a time target rather than an overlap
 * fraction, which is what keeps the time axis steady when the FFT size changes.
 */
export function derive(config, sampleRate, innerW) {
    const inSR = sampleRate || 48000;
    const decim = Math.max(1, Math.round(inSR / config.span));
    const decSR = inSR / decim;
    // Window-lock mode holds the total sweep by deriving the rate from the
    // pixel width, so it survives a resize.
    const secPerPixel = config.windowSec > 0 && innerW > 0
        ? config.windowSec / innerW
        : config.secPerPixel;
    const hop = Math.max(1, Math.round(secPerPixel * decSR));
    const fc = clamp(config.centerHz == null ? decSR / 2 : config.centerHz, 0, inSR / 2);
    return {
        inSR,
        decim,
        decSR,
        fc,
        hop,
        secPerPixel,
        secPerCol: hop / decSR,
        binHz: decSR / config.fftSize,
        // The audio the display covers, which is also what the receiver's
        // passband has to reach for any of it to arrive.
        lo: fc - decSR / 2,
        hi: fc + decSR / 2,
    };
}

/**
 * Which FFT bins each pixel row covers.
 *
 * The complex spectrum runs from −N/2 to +N/2 around the centre frequency in
 * fftshift order, so a row's bins are signed and the painter indexes the output
 * modulo N. Row 0 is the top of the display, which is the highest frequency.
 */
export function buildBinMap(fftSize, height) {
    const map = new Int32Array(height * 2);
    for (let y = 0; y < height; y++) {
        const loF = (0.5 - (y + 1) / height) * fftSize;
        const hiF = (0.5 - y / height) * fftSize;
        const start = Math.round(loF);
        map[y * 2] = start;
        map[y * 2 + 1] = Math.max(1, Math.round(hiF) - start);
    }
    return map;
}

/**
 * One column of dB values from a transformed spectrum.
 *
 * A pixel takes the strongest bin it covers rather than their mean: a QRSS
 * carrier is one bin wide, and averaging it with its empty neighbours is
 * exactly how you lose the signal you zoomed in to see.
 */
export function powerColumn(re, im, binMap, fftSize, out) {
    const height = binMap.length / 2;
    const col = out && out.length === height ? out : new Float32Array(height);
    const norm = 1 / (fftSize * 0.5);
    for (let y = 0; y < height; y++) {
        const start = binMap[y * 2];
        const count = binMap[y * 2 + 1];
        let maxP = 0;
        for (let c = 0; c < count; c++) {
            const b = ((start + c) % fftSize + fftSize) % fftSize;
            const p = re[b] * re[b] + im[b] * im[b];
            if (p > maxP) maxP = p;
        }
        col[y] = 10 * Math.log10(maxP * norm * norm + 1e-20);
    }
    return col;
}

/** One dB column as RGBA pixels, through the palette and the current range. */
export function colorColumn(dbCol, lut, dbMin, dbMax, out) {
    const h = dbCol.length;
    const col = out && out.length === h * 4 ? out : new Uint8ClampedArray(h * 4);
    const range = (dbMax - dbMin) || 1;
    for (let y = 0; y < h; y++) {
        let t = (dbCol[y] - dbMin) / range;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        const ci = (t * 255) | 0;
        col[y * 4] = lut[ci * 3];
        col[y * 4 + 1] = lut[ci * 3 + 1];
        col[y * 4 + 2] = lut[ci * 3 + 2];
        col[y * 4 + 3] = 255;
    }
    return col;
}

export function median(arr) {
    const c = Array.prototype.slice.call(arr).sort((a, b) => a - b);
    return c[c.length >> 1];
}

/**
 * Track the noise floor and put the black point on it.
 *
 * The median of a column is the noise floor, because a QRSS band is mostly
 * noise — a signal occupies one row out of hundreds, so it cannot move the
 * median. Smoothed, so a burst of static does not wash the display out and
 * leave it grey for a minute afterwards.
 */
export function trackFloor(floorEMA, dbCol, span) {
    const next = 0.9 * floorEMA + 0.1 * median(dbCol);
    return { floorEMA: next, dbMin: Math.round(next), dbMax: Math.round(next + span) };
}

// ── axis helpers ────────────────────────────────────────────────────────────

/** A round tick interval near `range / targetTicks`. */
export function niceStep(range, targetTicks) {
    // Never zero or NaN: both would hang the loop that steps through the ticks.
    if (!(range > 0) || !Number.isFinite(range)) return 1;
    const raw = range / targetTicks;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const n = raw / mag;
    return (n < 1.5 ? 1 : (n < 3 ? 2 : (n < 7 ? 5 : 10))) * mag;
}

export function fmtDuration(s) {
    if (s < 90) return `${s.toFixed(0)} s`;
    const m = s / 60;
    if (m < 90) return `${m.toFixed(1)} min`;
    return `${(m / 60).toFixed(1)} h`;
}

export function fmtShort(s) {
    if (s < 60) return `${s.toFixed(0)}s`;
    const m = Math.floor(s / 60);
    const r = Math.round(s % 60);
    return r ? `${m}m${r}s` : `${m}m`;
}

// ── the magnifier ───────────────────────────────────────────────────────────
//
// A normalised sub-rectangle of the waterfall that is scaled to fill the plot.
// x runs 0 (oldest, left) to 1 (newest, right); y runs 0 (top, highest
// frequency) to 1. It magnifies what has already been captured and never
// re-tunes anything, so zooming out again shows exactly what was there.

export const FULL_VIEW = { x0: 0, y0: 0, x1: 1, y1: 1 };

// About fifty times, which is as far as one pixel of captured data usefully goes.
const MIN_VIEW = 0.02;

export function zoomView(view, factor, px, py) {
    let wx = view.x1 - view.x0;
    let wy = view.y1 - view.y0;
    const cx = view.x0 + px * wx;
    const cy = view.y0 + py * wy;
    wx = Math.min(1, Math.max(MIN_VIEW, wx * factor));
    wy = Math.min(1, Math.max(MIN_VIEW, wy * factor));
    const x0 = Math.min(1 - wx, Math.max(0, cx - px * wx));
    const y0 = Math.min(1 - wy, Math.max(0, cy - py * wy));
    return { x0, y0, x1: x0 + wx, y1: y0 + wy };
}

export function panView(view, dx, dy) {
    const wx = view.x1 - view.x0;
    const wy = view.y1 - view.y0;
    const x0 = Math.min(1 - wx, Math.max(0, view.x0 + dx));
    const y0 = Math.min(1 - wy, Math.max(0, view.y0 + dy));
    return { x0, y0, x1: x0 + wx, y1: y0 + wy };
}

/** A plot position in 0..1 → the audio frequency and age it points at. */
export function pointToFreqTime(view, px, py, { fc, decSR, secPerCol, innerW }) {
    const cx = view.x0 + px * (view.x1 - view.x0);
    const cy = view.y0 + py * (view.y1 - view.y0);
    return {
        audio: (fc + decSR / 2) - cy * decSR,
        ago: secPerCol * innerW * (1 - cx),
    };
}

// ── bands ───────────────────────────────────────────────────────────────────

// v1's list: the dial frequency for each band's QRSS window, chosen so the
// activity lands about 100 Hz up in the audio. The label says both, because
// "which dial do I set" and "where is the activity" are different questions and
// QRSS operators quote the second.
//
// v1's 6 m entry is gone. The receiver tops out at 30 MHz (MAX_FREQ in
// radio/constants.js, mirroring the server), so choosing it would have tuned to
// the clamp and sat there never matching itself — an entry that cannot work is
// worse than one that is not offered.
export const QRSS_BANDS = [
    {
        group: 'Most active',
        options: [
            { hz: 10139900, label: '30 m · dial 10.13990 · QRSS 10.140000 MHz' },
            { hz: 7039800, label: '40 m · dial 7.03980 · QRSS 7.039900 MHz' },
            { hz: 28125600, label: '10 m · dial 28.12560 · QRSS 28.125700 MHz' },
        ],
    },
    {
        group: 'Other HF bands',
        options: [
            { hz: 14096800, label: '20 m · dial 14.09680 · QRSS 14.096900 MHz' },
            { hz: 18105800, label: '17 m · dial 18.10580 · QRSS 18.105900 MHz' },
            { hz: 21095800, label: '15 m · dial 21.09580 · QRSS 21.095900 MHz' },
            { hz: 24925800, label: '12 m · dial 24.92580 · QRSS 24.925900 MHz' },
            { hz: 3569800, label: '80 m · dial 3.56980 · QRSS 3.569900 MHz' },
            { hz: 5288450, label: '60 m · dial 5.28845 · QRSS 5.288550 MHz' },
            { hz: 13555300, label: '22 m ISM · dial 13.55530 · QRSS 13.555400 MHz' },
            { hz: 1837800, label: '160 m · dial 1.83780 · QRSS 1.837900 MHz' },
        ],
    },
    {
        group: 'MF / LF',
        options: [
            { hz: 476000, label: '630 m · dial 476.000 · QRSS 476.100 kHz' },
        ],
    },
];

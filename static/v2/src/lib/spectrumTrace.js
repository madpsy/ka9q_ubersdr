// How a spectrum trace is drawn, shared by the panes that draw one.
//
// The main spectrum and the band spectrum panel are the same picture of
// different data — one whole receiver, one band at the resolution it is
// recorded — and they looked different only because the second was written
// later. These are the parts that decide how a trace *reads*: how bins are
// collapsed onto pixels, and the palette gradients that colour it by level.
// Both panes import them, so a change to either shows up in both.

import { getPalette } from './palettes.js';

// The trace is drawn from a compressed slice of the palette (TRACE_FLOOR..1)
// because most palettes start at near-black, which would make weak signals
// invisible against the dark background.
export const TRACE_FLOOR = 0.35;
export const GRAD_STOPS = 24;

// Stroke weight of an unfilled trace, in CSS px.
export const TRACE_WIDTH = 1.25;

// Vertical palette gradients for the spectrum, so the trace and its fill use
// the same colour-per-amplitude mapping as the waterfall: hot at the top of the
// dB range, cold at the bottom, with the same `contrast` gamma applied.
//
// The fill is opaque. A translucent wash reads as a tint rather than a filled
// spectrum, and leaving it solid is what makes the backdrop image work: the
// image shows in the open area above the trace, with the signal a solid block
// below it.
//
export function paletteGradients(c, H, palette, contrast) {
    const lut = getPalette(palette);
    const gammaInv = 1 / contrast;
    const trace = c.createLinearGradient(0, 0, 0, H);
    const fill = c.createLinearGradient(0, 0, 0, H);

    for (let i = 0; i <= GRAD_STOPS; i++) {
        const offset = i / GRAD_STOPS;        // 0 = top of the range
        let amp = 1 - offset;                 // amplitude fraction at this height
        if (contrast !== 1) amp = Math.pow(amp, gammaInv);

        const fi = Math.round(amp * 255) * 3;
        fill.addColorStop(offset, `rgb(${lut[fi]},${lut[fi + 1]},${lut[fi + 2]})`);

        const ti = Math.round((TRACE_FLOOR + amp * (1 - TRACE_FLOOR)) * 255) * 3;
        trace.addColorStop(offset, `rgb(${lut[ti]},${lut[ti + 1]},${lut[ti + 2]})`);
    }
    return { trace, fill };
}


// Theme colours, resolved once per theme. getComputedStyle forces a style
// recalculation, so calling it inside the draw loop would cost more than the
// rendering itself.
let themeCache = null;

export function themeColors(vars) {
    const theme = document.documentElement.dataset.theme || 'dark';
    if (themeCache && themeCache.theme === theme) return themeCache;
    const css = getComputedStyle(document.documentElement);
    const out = { theme };
    for (const name of vars) out[name] = css.getPropertyValue(name).trim();
    themeCache = out;
    return out;
}


// Collapses `bins` onto `width` pixels, taking the maximum of each pixel's bin
// range so narrow carriers survive downsampling.
export function binsToPixels(bins, width, out) {
    const n = bins.length;
    if (!n) return out;
    const ratio = n / width;
    for (let x = 0; x < width; x++) {
        const lo = Math.floor(x * ratio);
        const hi = Math.max(lo + 1, Math.floor((x + 1) * ratio));
        let m = -Infinity;
        for (let i = lo; i < hi && i < n; i++) {
            const v = bins[i];
            if (v > m) m = v;
        }
        out[x] = m === -Infinity ? bins[Math.min(n - 1, lo)] : m;
    }
    return out;
}


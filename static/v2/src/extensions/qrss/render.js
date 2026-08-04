// Compositing the QRSS grabber: waterfall, axes, colour bar, header.
//
// The waterfall itself lives in an off-screen canvas one pixel per column, and
// this draws a sub-rectangle of it — the magnifier view — scaled into the plot
// area, then the furniture around it. Keeping the two apart is what lets the
// display zoom and pan without recomputing a single FFT, and what lets a
// palette change recolour an hour of history from the dB values it kept.
//
// The chrome follows the theme; the waterfall does not. A palette is a
// measurement scale — grey means a particular number of dB above the noise —
// and inverting it for a light theme would make the same picture mean something
// different, so the plot area stays dark in both.

import { cssVar } from '../../lib/audioWaterfall.js';
import { fmtShort, niceStep } from './dsp.js';

// Room for the frequency labels on the left, the colour bar on the right, the
// header above and the time labels below.
export const MARGINS = { l: 62, r: 56, t: 24, b: 22 };

export function plotSize(cssW, cssH) {
    return {
        innerW: Math.max(1, Math.round(cssW - MARGINS.l - MARGINS.r)),
        innerH: Math.max(1, Math.round(cssH - MARGINS.t - MARGINS.b)),
    };
}

const AXIS_FONT = '10px ui-monospace, monospace';

/**
 * Draw one frame.
 *
 * `wf` is the off-screen waterfall canvas; everything else is what the axes
 * need to say what the picture means.
 */
export function drawFrame(canvas, {
    wf, view, innerW, innerH, cssW, cssH, dpr,
    fc, decSR, secPerCol, dial, binHz, dbMin, dbMax, lut,
}) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = cssVar('--spec-bg', '#0a0e15');
    ctx.fillRect(0, 0, cssW, cssH);

    if (wf && wf.width > 0 && wf.height > 0) {
        const sx = view.x0 * wf.width;
        const sy = view.y0 * wf.height;
        const sw = (view.x1 - view.x0) * wf.width;
        const sh = (view.y1 - view.y0) * wf.height;
        // Smoothed: a magnified waterfall of hard pixel blocks is harder to
        // read a faint streak off than an interpolated one.
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(wf, sx, sy, sw, sh, MARGINS.l, MARGINS.t, innerW, innerH);
    }

    ctx.strokeStyle = cssVar('--border-strong', '#2f3b4e');
    ctx.strokeRect(MARGINS.l + 0.5, MARGINS.t + 0.5, innerW, innerH);

    drawFreqAxis(ctx, { view, innerW, innerH, fc, decSR, dial });
    drawTimeAxis(ctx, { view, innerW, innerH, secPerCol });
    drawColorbar(ctx, { innerW, innerH, dbMin, dbMax, lut });
    drawHeader(ctx, { cssW, dial, binHz });
}

// Labelled in absolute RF — dial plus audio offset — because that is what a
// QRSS beacon is quoted at, to the hertz. With no dial known it falls back to
// audio, which is at least honest about what it is showing.
function drawFreqAxis(ctx, { view, innerW, innerH, fc, decSR, dial }) {
    const fullHi = fc + decSR / 2;
    const visHi = fullHi - view.y0 * decSR;
    const visLo = fullHi - view.y1 * decSR;
    const range = visHi - visLo;

    ctx.font = AXIS_FONT;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const step = niceStep(range, 6);
    if (range > 0 && Number.isFinite(range) && step > 0) {
        const decimals = Math.max(1, Math.min(3, Math.ceil(Math.log10(1000 / step))));
        const first = Math.ceil(visLo / step) * step;
        const grid = cssVar('--border', '#232c3a');
        const text = cssVar('--text-faint', '#5c6779');
        for (let f = first; f <= visHi + 0.001; f += step) {
            const y = MARGINS.t + innerH * (1 - (f - visLo) / range);
            ctx.strokeStyle = grid;
            ctx.beginPath();
            ctx.moveTo(MARGINS.l, y);
            ctx.lineTo(MARGINS.l + innerW, y);
            ctx.stroke();
            ctx.fillStyle = text;
            ctx.fillText(((dial + f) / 1000).toFixed(decimals), MARGINS.l - 6, y);
        }
    }

    ctx.save();
    ctx.translate(11, MARGINS.t + innerH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = cssVar('--text-faint', '#5c6779');
    ctx.fillText(dial ? 'Frequency (kHz)' : 'Audio (kHz)', 0, 0);
    ctx.restore();
}

// Labelled as age rather than clock time: what you want off a grabber is "that
// streak was four minutes ago", and a wall clock would need the columns to
// carry timestamps through every zoom.
function drawTimeAxis(ctx, { view, innerW, innerH, secPerCol }) {
    const total = secPerCol * innerW;
    const agoLeft = total * (1 - view.x0);
    const agoRight = total * (1 - view.x1);
    const range = agoLeft - agoRight;

    ctx.font = AXIS_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = cssVar('--text-faint', '#5c6779');

    const step = niceStep(range, 6);
    if (range > 0 && Number.isFinite(range) && step > 0) {
        const first = Math.ceil(agoRight / step) * step;
        for (let s = first; s <= agoLeft + 0.001; s += step) {
            const x = MARGINS.l + innerW * (1 - (s - agoRight) / range);
            ctx.fillText(`-${fmtShort(s)}`, x, MARGINS.t + innerH + 4);
        }
    }
    ctx.textAlign = 'right';
    ctx.fillText('now', MARGINS.l + innerW, MARGINS.t + innerH + 4);
}

function drawColorbar(ctx, { innerW, innerH, dbMin, dbMax, lut }) {
    const x = MARGINS.l + innerW + 14;
    const w = 12;
    for (let y = 0; y < innerH; y++) {
        const ci = ((1 - y / innerH) * 255) | 0;
        ctx.fillStyle = `rgb(${lut[ci * 3]},${lut[ci * 3 + 1]},${lut[ci * 3 + 2]})`;
        ctx.fillRect(x, MARGINS.t + y, w, 1);
    }
    ctx.strokeStyle = cssVar('--border-strong', '#2f3b4e');
    ctx.strokeRect(x + 0.5, MARGINS.t + 0.5, w, innerH);

    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = cssVar('--text-faint', '#5c6779');
    // A proper minus sign: a hyphen at 9 px beside a digit reads as a dash.
    ctx.fillText(String(dbMax).replace('-', '−'), x + w + 3, MARGINS.t + 4);
    ctx.fillText(String(dbMin).replace('-', '−'), x + w + 3, MARGINS.t + innerH - 4);
    ctx.save();
    ctx.translate(x + w + 22, MARGINS.t + innerH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('dB', 0, 0);
    ctx.restore();
}

// In the picture rather than beside it, so a saved PNG says what it is of.
function drawHeader(ctx, { cssW, dial, binHz }) {
    ctx.font = '600 11px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = cssVar('--text', '#dfe5ee');
    const label = dial ? `${(dial / 1e6).toFixed(5)} MHz` : '—';
    ctx.fillText(`QRSS · USB dial ${label}`, MARGINS.l, MARGINS.t / 2);

    ctx.textAlign = 'right';
    ctx.fillStyle = cssVar('--text-faint', '#5c6779');
    ctx.fillText(`${binHz < 1 ? binHz.toFixed(3) : binHz.toFixed(2)} Hz/bin`, cssW - MARGINS.r, MARGINS.t / 2);
}

/**
 * The dB value at a plot position, from the kept columns.
 *
 * Reads the history rather than the pixels, so the readout is the measurement
 * and not whatever the palette and the magnifier's interpolation turned it
 * into. Returns null outside the part of the display that has data.
 */
export function dbAt(history, view, px, py, innerW) {
    if (!history || !history.length || innerW <= 0) return null;
    const cx = view.x0 + px * (view.x1 - view.x0);
    const cy = view.y0 + py * (view.y1 - view.y0);
    // The history is right-aligned: its last entry is the newest column, at the
    // right-hand edge, and a partly filled display is blank on the left.
    const col = Math.round(cx * (innerW - 1)) - (innerW - history.length);
    if (col < 0 || col >= history.length) return null;
    const column = history[col];
    if (!column || !column.length) return null;
    const row = Math.min(column.length - 1, Math.max(0, Math.round(cy * (column.length - 1))));
    return column[row];
}

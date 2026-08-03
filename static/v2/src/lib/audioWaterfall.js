// Drawing for the audio waterfall, shared by the audio scope and the filter
// panel's preview so both read the same way: same palette, same auto level,
// same silence handling, same frequency window.
//
// The x axis is the audio the current mode actually carries — see audioBand.js
// — not Nyquist.

import { getPalette } from './palettes.js';
import { audioBins } from './audioBand.js';

const ROW_MS = 33;             // one row, ~30 fps as in v1
export const WF_FLOOR_DB = -110;   // never map anything quieter than this
export const WF_MIN_SPAN_DB = 45;  // and never stretch a narrower range

export function fmtHz(hz) {
    return hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 ? 1 : 0)}k` : `${Math.round(hz)}`;
}

export function sizedCanvas(canvas, cssH) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round((cssH || canvas.clientHeight || 100) * dpr));
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }
    return { w, h, dpr };
}

export function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
}

export function newRing() {
    return { canvas: null, ctx: null, w: 0, h: 0, head: 0, at: 0, level: { floor: -100, ceil: -30 } };
}

/**
 * Paint one frame. `marks` are vertical lines in audio Hz — the filter panel
 * uses them to show where its notches and bandpass sit — as
 * { hz, color, soft, label }. A label is drawn once at the top of its line, so
 * several notches can be told apart at a glance.
 */
export function drawAudioWaterfall({
    canvas, ring, bins, binCount, sampleRate, tuning, palette, contrast, marks,
}) {
    if (!canvas || !bins || bins.length !== binCount) return;
    const { w, h } = sizedCanvas(canvas);

    if (!ring.canvas || ring.w !== w || ring.h !== h) {
        const off = document.createElement('canvas');
        off.width = w;
        off.height = h;
        const octx = off.getContext('2d', { alpha: false });
        octx.fillStyle = '#05070c';
        octx.fillRect(0, 0, w, h);
        ring.canvas = off;
        ring.ctx = octx;
        ring.w = w;
        ring.h = h;
        ring.head = 0;
    }

    const { start, count, startFreq, endFreq } = audioBins(
        tuning.bandwidthLow, tuning.bandwidthHigh, sampleRate, binCount,
    );

    // Auto level, eased and bounded: with the gate closed the audio is a
    // hundred dB down, and an unbounded range would stretch that noise across
    // the whole palette.
    const level = ring.level;
    let min = Infinity;
    let max = -Infinity;
    for (let i = start; i < start + count; i++) {
        const v = bins[i];
        if (!Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
    }
    if (Number.isFinite(min)) {
        const targetFloor = Math.max(WF_FLOOR_DB, min - 3);
        const targetCeil = Math.max(targetFloor + WF_MIN_SPAN_DB, max + 5);
        level.floor += (targetFloor - level.floor) * 0.05;
        level.ceil += (targetCeil - level.ceil) * 0.05;
    }
    const range = Math.max(WF_MIN_SPAN_DB, level.ceil - level.floor);

    const now = performance.now();
    if (now - ring.at >= ROW_MS) {
        ring.at = now;
        const lut = getPalette(palette);
        const img = ring.ctx.createImageData(w, 1);
        const data = img.data;
        for (let x = 0; x < w; x++) {
            const lo = start + Math.floor((x / w) * count);
            const hi = Math.max(lo + 1, start + Math.floor(((x + 1) / w) * count));
            let v = -Infinity;
            for (let i = lo; i < hi; i++) if (bins[i] > v) v = bins[i];
            let t = (v - level.floor) / range;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            if (contrast && contrast !== 1) t = Math.pow(t, 1 / contrast);
            const idx = (t * 255) | 0;
            const o = x * 4;
            data[o] = lut[idx * 3];
            data[o + 1] = lut[idx * 3 + 1];
            data[o + 2] = lut[idx * 3 + 2];
            data[o + 3] = 255;
        }
        ring.head = (ring.head - 1 + h) % h;
        ring.ctx.putImageData(img, 0, ring.head);
    }

    const c = canvas.getContext('2d', { alpha: false });
    c.imageSmoothingEnabled = false;
    const firstH = Math.min(h - ring.head, h);
    c.drawImage(ring.canvas, 0, ring.head, w, firstH, 0, 0, w, firstH);
    if (firstH < h) c.drawImage(ring.canvas, 0, 0, w, h - firstH, 0, firstH, w, h - firstH);

    // Marker lines go on the visible canvas, never into the ring, or they would
    // scroll away with the history instead of standing still.
    if (marks && marks.length && endFreq > startFreq) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        for (const m of marks) {
            const x = ((m.hz - startFreq) / (endFreq - startFreq)) * w;
            if (x < 0 || x > w) continue;
            c.strokeStyle = m.color;
            c.lineWidth = m.soft ? 1 : 1.5;
            if (m.soft) c.setLineDash([2, 4]);
            c.beginPath();
            c.moveTo(Math.round(x) + 0.5, 0);
            c.lineTo(Math.round(x) + 0.5, h);
            c.stroke();
            c.setLineDash([]);

            if (!m.label) continue;
            // A small tag at the top of the line. Kept inside the canvas at
            // both edges, so a notch parked at the end of the passband is still
            // identifiable.
            c.font = `600 ${9 * dpr}px ui-sans-serif, system-ui, sans-serif`;
            c.textBaseline = 'top';
            const tw = c.measureText(m.label).width;
            const bw = tw + 6 * dpr;
            const bx = Math.max(0, Math.min(w - bw, x - bw / 2));
            c.fillStyle = m.color;
            c.fillRect(bx, 0, bw, 12 * dpr);
            c.fillStyle = '#0b1016';
            c.textAlign = 'center';
            c.fillText(m.label, bx + bw / 2, 2 * dpr);
        }
    }
}

export function drawAudioRuler(canvas, tuning, sampleRate, binCount) {
    if (!canvas) return;
    const { w, h, dpr } = sizedCanvas(canvas);
    const c = canvas.getContext('2d');
    c.fillStyle = cssVar('--scale-bg', '#0d121b');
    c.fillRect(0, 0, w, h);

    const { startFreq, endFreq } = audioBins(tuning.bandwidthLow, tuning.bandwidthHigh, sampleRate, binCount);
    const span = endFreq - startFreq;
    if (!(span > 0)) return;

    const step = span > 4000 ? 1000 : span > 1500 ? 500 : span > 600 ? 200 : 100;
    c.font = `${8.5 * dpr}px ui-monospace, monospace`;
    c.textBaseline = 'middle';
    c.textAlign = 'center';
    for (let f = Math.ceil(startFreq / step) * step; f <= endFreq; f += step) {
        const x = ((f - startFreq) / span) * w;
        c.strokeStyle = cssVar('--scale-tick', 'rgba(255,255,255,0.16)');
        c.beginPath();
        c.moveTo(Math.round(x) + 0.5, 0);
        c.lineTo(Math.round(x) + 0.5, 3 * dpr);
        c.stroke();
        c.fillStyle = cssVar('--scale-text', '#8b96a9');
        c.fillText(fmtHz(f), x, h * 0.62);
    }
}

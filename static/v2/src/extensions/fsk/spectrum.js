// The FSK audio spectrum, with the mark and space tones marked on it.
//
// The decoder is looking for two tones at fixed audio frequencies, so the job
// this display does is getting the signal's two peaks onto the two markers —
// which is why the markers are here at all, and why the panel makes a click on
// it move the dial so the peak clicked lands on the centre frequency.
//
// Like FT8's it starts switched off. It is what you open when the copy is not
// coming out; once it is, the text is what you are reading and this is 120 px
// and an FFT read per frame that nothing is paying for.

import { cssVar, sizedCanvas } from '../../lib/audioWaterfall.js';

// The span drawn, matching v1. The decoder will accept a centre frequency well
// above this, but nothing transmits a teleprinter tone up there and a wider
// display would only make the tones harder to place.
export const MAX_AUDIO_HZ = 3000;

// The analyser's own dB window, so a bar means the same thing here as in the
// audio scope.
const DB_FLOOR = -100;
const DB_CEIL = -30;

/**
 * RMS level of one time-domain frame, in dBFS.
 *
 * `wave` is the analyser's byte data: unsigned, centred on 128. Returns
 * -Infinity for digital silence, which the caller shows as -∞ rather than
 * drawing a bar of length NaN.
 */
export function waveLevelDb(wave) {
    if (!wave || !wave.length) return -Infinity;
    let sum = 0;
    for (let i = 0; i < wave.length; i++) {
        const v = (wave[i] - 128) / 128;
        sum += v * v;
    }
    const rms = Math.sqrt(sum / wave.length);
    return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

// A tone marker, clipped to the drawn span. Returns null when the tone is off
// the display — a 1000 Hz shift centred at 2800 Hz puts mark past 3 kHz — so a
// marker is never drawn at the edge pretending to be somewhere it is not.
function toneX(hz, width) {
    if (!Number.isFinite(hz) || hz < 0 || hz > MAX_AUDIO_HZ) return null;
    return (hz / MAX_AUDIO_HZ) * width;
}

function drawTone(ctx, { x, width, height, colour, label, hz }) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.setLineDash([]);

    // Labels flip to the left of their line near the right edge, or they would
    // be drawn off the canvas exactly when the operator is tuning towards it.
    ctx.fillStyle = colour;
    ctx.font = '10px ui-monospace, monospace';
    const textWidth = ctx.measureText(`${Math.round(hz)} Hz`).width;
    const right = x + 5 + textWidth > width;
    ctx.textAlign = right ? 'right' : 'left';
    const tx = right ? x - 5 : x + 5;
    ctx.fillText(label, tx, 12);
    ctx.fillText(`${Math.round(hz)} Hz`, tx, 24);
    ctx.textAlign = 'left';
}

/**
 * Draw one frame.
 *
 * `bins` are the analyser's dB values; only the part below MAX_AUDIO_HZ is
 * drawn. `mark` and `space` are the two tones the decoder is listening for.
 */
export function drawSpectrum(canvas, { bins, binCount, sampleRate, mark, space, cssHeight }) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { w, h, dpr } = sizedCanvas(canvas, cssHeight);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const width = w / dpr;
    const height = h / dpr;

    ctx.fillStyle = cssVar('--spec-bg', '#0a0e15');
    ctx.fillRect(0, 0, width, height);

    if (bins && binCount) {
        const nyquist = (sampleRate || 48000) / 2;
        const binHz = nyquist / binCount;
        const maxBin = Math.min(binCount, Math.max(1, Math.floor(MAX_AUDIO_HZ / binHz)));
        const barWidth = width / maxBin;

        // Three bands rather than a gradient, as both v1 extensions draw it:
        // what matters is seeing which tones are strong at a glance.
        const accent = cssVar('--accent', '#3ddbe8');
        const warn = cssVar('--warn', '#f2b544');
        const bad = cssVar('--bad', '#f2646a');

        for (let i = 0; i < maxBin; i++) {
            const level = Math.max(0, Math.min(1, (bins[i] - DB_FLOOR) / (DB_CEIL - DB_FLOOR)));
            if (level <= 0) continue;
            const barHeight = level * height;
            ctx.fillStyle = level > 0.7 ? bad : (level > 0.4 ? warn : accent);
            ctx.fillRect(i * barWidth, height - barHeight, Math.max(1, barWidth), barHeight);
        }
    }

    // Frequency scale along the bottom.
    ctx.fillStyle = cssVar('--text-faint', '#5c6779');
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'left';
    for (let hz = 0; hz <= MAX_AUDIO_HZ; hz += 500) {
        ctx.fillText(`${hz}`, (hz / MAX_AUDIO_HZ) * width + 2, height - 3);
    }

    const markX = toneX(mark, width);
    if (markX != null) {
        drawTone(ctx, { x: markX, width, height, colour: cssVar('--good', '#45d69a'), label: 'Mark', hz: mark });
    }
    const spaceX = toneX(space, width);
    if (spaceX != null) {
        drawTone(ctx, { x: spaceX, width, height, colour: cssVar('--warn', '#f2b544'), label: 'Space', hz: space });
    }
}

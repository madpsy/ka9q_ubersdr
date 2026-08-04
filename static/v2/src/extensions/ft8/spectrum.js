// The FT8 audio spectrum, and the callsign labels drawn over it.
//
// The bars are the demodulated audio from 0 to 3 kHz — the band the decoder
// works in — so a slot's transmissions appear as a comb of tones and you can
// see whether the passband is actually full of FT8 before wondering why nothing
// decodes.
//
// The labels are the interesting part. A station's tone is only on the air for
// half of each pair of slots, so labelling the *current* slot would label an
// empty spectrum: by the time a decode exists, that slot's audio has gone. What
// is on the air right now is the same parity as the last slot but one, so the
// labels come from the most recent slot with the same odd/even parity as the
// current one. That is v1's rule, and it is why the labels line up with the
// bars underneath them.

import { cssVar, sizedCanvas } from '../../lib/audioWaterfall.js';
import { MAX_AUDIO_HZ } from './messages.js';

// Matches the analyser's own dB window, so a bar's height means the same thing
// here as in the audio scope.
const DB_FLOOR = -100;
const DB_CEIL = -30;

const MIN_LABEL_GAP_PX = 50;   // horizontal spacing before labels are stacked
const LABEL_ROW_PX = 14;       // vertical step between stacked labels

/**
 * The callsigns to label, from the last slot with the current slot's parity.
 *
 * `messages` is newest-first. Returns [] until two same-parity slots have been
 * seen, which is the first 30 seconds of decoding.
 */
export function labelsFor(messages, currentSlot) {
    if (!currentSlot || currentSlot <= 0) return [];
    const parity = currentSlot % 2;

    let slot = null;
    for (const m of messages) {
        if (m.slot < currentSlot && m.slot % 2 === parity) { slot = m.slot; break; }
    }
    if (slot == null) return [];

    return messages
        .filter((m) => m.slot === slot && m.txCallsign && m.frequency)
        .map((m) => ({ callsign: m.txCallsign, frequency: m.frequency }))
        .sort((a, b) => a.frequency - b.frequency);
}

/**
 * Place labels so they do not sit on top of each other.
 *
 * Labels closer together than MIN_LABEL_GAP_PX are stacked into rows rather
 * than overlapping; a column that runs out of height wraps back to the top,
 * because a label drawn off the bottom is worse than one drawn twice.
 *
 * `measure` returns a text width — the caller passes the canvas context's, and
 * a test passes a fixed-width one.
 */
export function layoutLabels(labels, { width, height, measure, maxHz = MAX_AUDIO_HZ }) {
    const placed = [];
    for (const l of labels) {
        const x = (l.frequency / maxHz) * width;
        const textWidth = measure(l.callsign);

        let y = 15;
        while (y < height - 20 && placed.some(
            (p) => Math.abs(p.x - x) < MIN_LABEL_GAP_PX && Math.abs(p.y - y) < LABEL_ROW_PX,
        )) {
            y += LABEL_ROW_PX;
        }
        if (y >= height - 20) y = 15;

        placed.push({ callsign: l.callsign, x, y, textWidth });
    }
    return placed;
}

/**
 * Draw one frame.
 *
 * `bins` are the analyser's dB values; only the part below MAX_AUDIO_HZ is
 * drawn, so the display is the decoder's band rather than Nyquist.
 */
export function drawSpectrum(canvas, { bins, binCount, sampleRate, labels, cssHeight }) {
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

        // Three bands rather than a gradient, as v1 draws it: the point is to
        // see at a glance which tones are strong, not to read a level off them.
        const accent = cssVar('--accent', '#08a2fb');
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

    if (!labels || !labels.length) return;

    ctx.font = '11px ui-monospace, monospace';
    const placed = layoutLabels(labels, {
        width,
        height,
        measure: (text) => ctx.measureText(text).width,
    });

    const good = cssVar('--good', '#45d69a');
    ctx.textAlign = 'center';
    for (const p of placed) {
        // A leader line down to the axis, so a stacked label still says which
        // tone it belongs to.
        ctx.strokeStyle = good;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x, height - 15);
        ctx.lineTo(p.x, p.y + 10);
        ctx.stroke();

        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(p.x - p.textWidth / 2 - 2, p.y - 10, p.textWidth + 4, 12);
        ctx.fillStyle = good;
        ctx.fillText(p.callsign, p.x, p.y);
    }
    ctx.textAlign = 'left';
}

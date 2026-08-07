// The stats readout in the corner of the waterfall: what to show, and how to
// word it.
//
// Off by default and worth having at all for two reasons. The first is that this
// display has several rates in it and they are not the same number — the server's
// poll rate, the frames actually arriving, the canvas repaints, the committed
// waterfall rows — and when the picture looks wrong ("slow", "stuttery") the only
// way to say which one is wrong is to see them side by side. The second is that
// they are the questions asked about a remote receiver over and over: how much
// bandwidth is this costing me, how far behind is the audio, what resolution am I
// actually getting at this zoom.
//
// Pure, and given a plain sample, because the interesting part is the wording and
// the edge cases: a socket that has not delivered anything yet, a receiver still
// negotiating its geometry, a divisor of 1 that should say nothing at all. None
// of that needs a canvas or a clock.

// Where the readout sits, and the vocabulary the Display panel offers.
export const STATS_PLACES = ['off', 'left', 'right'];

export function statsPlace(setting) {
    return STATS_PLACES.includes(setting) ? setting : 'off';
}

/** A rate per second from a counter difference over `ms`, or null if unmeasurable. */
export function perSecond(delta, ms) {
    if (!(ms > 0) || !Number.isFinite(delta) || delta < 0) return null;
    return (delta * 1000) / ms;
}

// One decimal below ten, none above: "8.3 fps" is a reading and "8 fps" is a
// rounding, but "23.7" is three characters of noise on a number that moves.
function rate(v) {
    if (v == null || !Number.isFinite(v)) return null;
    return v < 10 ? v.toFixed(1) : String(Math.round(v));
}

// The two streams and their total, on one line: "41 + 6.2 = 47 kB/s".
//
// Bytes rather than the bits lib/format.js reports for a link rate: that is the
// right unit for "is this connection fast enough" and the wrong one here, where
// the question is what an hour of listening costs a data allowance.
//
// Both parts and the sum, because each answers a different question and the
// answer to one does not give you the other. The total is what the connection is
// costing; the split is which half to do something about — the spectrum is the
// expensive one and the one with settings behind it (zoom, poll rate, pausing it
// altogether), while the audio is a fixed drip you cannot tune away.
//
// One unit for all three, picked from the total, so the numbers can be compared
// by eye. Two rates in different units on the same line is a line that has to be
// read rather than glanced at.
export function formatThroughput(specBps, audioBps) {
    const spec = Number.isFinite(specBps) && specBps >= 0 ? specBps : null;
    const audio = Number.isFinite(audioBps) && audioBps >= 0 ? audioBps : null;
    if (spec == null && audio == null) return null;
    const total = (spec || 0) + (audio || 0);

    // The unit the total wants, applied to the parts as well.
    const [div, unit] = total < 1024
        ? [1, 'B/s']
        : (total < 1024 * 1024 ? [1024, 'kB/s'] : [1024 * 1024, 'MB/s']);
    // A part that rounds to nothing still has to read as a number rather than as
    // a blank, so the small end keeps a decimal.
    const part = (v) => {
        const n = v / div;
        return n < 10 ? n.toFixed(1) : String(Math.round(n));
    };
    // Only one of them known — a socket that has never opened — so there is no
    // sum to show and no split worth pretending to.
    if (spec == null || audio == null) return `${part(spec == null ? audio : spec)} ${unit}`;
    return `${part(spec)} + ${part(audio)} = ${part(total)} ${unit}`;
}

// Resolution reads better as Hz per bin than as a span: it is what decides
// whether two carriers 20 Hz apart are one blob or two, which is the thing the
// zoom is being changed for.
function formatHzPerBin(hz) {
    if (!(hz > 0)) return null;
    if (hz < 1) return `${hz.toFixed(2)} Hz`;
    if (hz < 100) return `${hz.toFixed(1)} Hz`;
    return `${Math.round(hz)} Hz`;
}

/**
 * The lines to draw, given a sample of everything measured.
 *
 * Every field is optional: this runs while the receiver is starting, between
 * reconnects, and on a browser that reports no output latency. A line whose
 * numbers are not known yet is left out rather than shown as a dash, because the
 * readout is small and a column of dashes is worse than a shorter column.
 *
 * @param s.fps        canvas repaints per second (null while unmeasured)
 * @param s.framesIn   spectrum frames arriving per second
 * @param s.rows       waterfall rows committed per second
 * @param s.bytesIn    spectrum bytes per second
 * @param s.audioBytes audio bytes per second, shown beside it and summed
 * @param s.binCount   bins across the view
 * @param s.binHz      Hz per bin
 * @param s.divisor    the server's poll divisor, 1 for full rate
 * @param s.queuedSec  audio queued ahead of the playback clock
 * @param s.outLatSec  what the hardware adds after that
 * @param s.underruns  dropouts since the session started
 * @returns [{ key, label, value, title }]
 */
export function statLines(s = {}) {
    const out = [];
    const add = (key, label, value, title) => {
        if (value) out.push({ key, label, value, title });
    };

    // Painted frames, not animation frames: the loop only draws when something
    // has changed, so this sits at the feed rate rather than at 60 and a figure
    // *below* the feed rate is the one worth seeing — that is the browser failing
    // to keep up, which is the difference between a slow receiver and a slow
    // machine.
    add('fps', 'FPS', rate(s.fps), 'Canvas repaints per second. The loop draws only when a frame has arrived, so this tracks the feed unless the browser cannot keep up.');

    add('feed', 'FEED', rate(s.framesIn) && `${rate(s.framesIn)}/s`, 'Spectrum frames arriving per second. Halves when the idle throttle takes effect, and drops to nothing when the socket is paused.');

    // Only when it is not 1. At full rate this line would say "the receiver is
    // behaving normally" in a corner meant for things that are not.
    if (s.divisor > 1) {
        add('poll', 'POLL', `1/${Math.round(s.divisor)}`, 'The server is polling the receiver at this fraction of the full rate — the idle throttle, or another client on a shared channel.');
    }

    const fft = [s.binCount > 0 && `${s.binCount} bins`, formatHzPerBin(s.binHz)]
        .filter(Boolean).join('  ');
    add('fft', 'FFT', fft, 'Bins across the view, and what one bin is worth. The resolution decides whether two close carriers are one blob or two.');

    add('rows', 'ROWS', rate(s.rows) && `${rate(s.rows)}/s`, 'Waterfall rows committed per second — the display speed, which is capped by the setting in the Display panel and by the feed.');

    add('net', 'NET', formatThroughput(s.bytesIn, s.audioBytes), 'Spectrum plus audio, and the total: what this session is costing the connection, and which half of it to do something about.');

    // Queue plus hardware, because the operator's question is "how far behind am
    // I", and answering with only the half this client controls is a figure that
    // is always wrong in the same direction.
    const latency = (s.queuedSec || 0) + (s.outLatSec || 0);
    const audio = latency > 0
        ? `${Math.round(latency * 1000)} ms${s.underruns > 0 ? `  ${s.underruns} drop${s.underruns === 1 ? '' : 's'}` : ''}`
        : null;
    add('audio', 'AUDIO', audio, 'Audio queued ahead of the playback clock plus what the output device adds — how far behind live you are, and how many dropouts there have been.');

    return out;
}

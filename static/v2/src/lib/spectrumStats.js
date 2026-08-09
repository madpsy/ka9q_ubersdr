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
// There is deliberately no committed-rows figure, which was tried and removed.
// Rows are committed as frames arrive, so in steady state it was the feed rate
// written out twice; shown only when it fell below the feed, it blinked in and
// out on every zoom, because a view change brings a catch-up burst that outruns
// the waterfall rate for exactly one sample. Both halves of that are noise, and
// the cap it was reporting is a setting the operator chose and can read in the
// Display panel.
//
// Pure, and given a plain sample, because the interesting part is the wording and
// the edge cases: a socket that has not delivered anything yet, a receiver still
// negotiating its geometry, a divisor of 1 that should say nothing at all. None
// of that needs a canvas or a clock.

// Where the readout sits, and the vocabulary the Display panel offers.
export const STATS_PLACES = ['off', 'left', 'right'];

// What "not chosen" means, per device.
//
// A desktop gets it: there is room in the corner, and somebody at a desk in front
// of a receiver is the person the readout is for. A phone does not — the bottom
// of that screen is the pad, the sheet and the band chips, and one of the lines
// is the address you are connecting from, which is not something to put on screen
// by default on a device used in public.
export const STATS_DEFAULT_DESKTOP = 'left';
export const STATS_DEFAULT_MOBILE = 'off';

/**
 * The corner in force, for a stored setting that may be absent.
 *
 * null or anything unrecognised is "not chosen" and takes this device's default.
 * 'off' is a choice like any other and survives — the same rule the idle delays
 * follow, where 0 means never and must not be read as unset.
 */
export function statsPlace(setting, isMobile) {
    if (STATS_PLACES.includes(setting)) return setting;
    return isMobile ? STATS_DEFAULT_MOBILE : STATS_DEFAULT_DESKTOP;
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

// The streams and their total, on one line: "41 + 6.2 = 47 kB/s", or with the
// band spectrum panel open, "41 + 6.2 + 3.1 = 50 kB/s".
//
// Bytes rather than the bits lib/format.js reports for a link rate: that is the
// right unit for "is this connection fast enough" and the wrong one here, where
// the question is what an hour of listening costs a data allowance.
//
// Every part and the sum, because each answers a different question and the
// answer to one does not give you the other. The total is what the connection is
// costing; the split is which of them to do something about — the main spectrum
// has zoom, poll rate and a pause behind it, the band panel can be closed, and
// the audio is a fixed drip you cannot tune away.
//
// One unit for all of them, picked from the total, so they can be compared by
// eye. Two rates in different units on the same line is a line that has to be
// read rather than glanced at.
//
// A variable number of parts, because the third one comes and goes: the band
// spectrum stream exists only while that panel is open. An absent stream is left
// out rather than added as a zero — "+ 0" would read as a stream that has
// stalled, which is a different and much more alarming thing.
export function formatThroughput(...streams) {
    const parts = streams.filter((v) => Number.isFinite(v) && v >= 0);
    if (!parts.length) return null;
    const total = parts.reduce((a, b) => a + b, 0);

    // The unit the total wants, applied to the parts as well.
    const [div, unit] = total < 1024
        ? [1, 'B/s']
        : (total < 1024 * 1024 ? [1024, 'kB/s'] : [1024 * 1024, 'MB/s']);
    // Whole units throughout. The small end used to keep a decimal so that a few
    // kB/s of audio beside a spectrum in the hundreds could not round to "0" and
    // read as a stream that had stopped — but the mixed widths were the thing
    // that made the line hard to take in at a glance, which is all this line is
    // for. It only bites at the MB/s scale now: at kB/s, which is where a
    // session actually lives, the audio is a whole number of its own.
    const part = (v) => String(Math.round(v / div));
    // One stream known and the rest not — a socket that has never opened — so
    // there is no sum to show and no split worth pretending to.
    if (parts.length === 1) return `${part(parts[0])} ${unit}`;
    return `${parts.map(part).join(' + ')} = ${part(total)} ${unit}`;
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
 * @param s.bytesIn    spectrum bytes per second
 * @param s.audioBytes audio bytes per second, shown beside it and summed
 * @param s.bandBytes  the band spectrum panel's stream, when that panel is open
 * @param s.binCount   bins across the view
 * @param s.binHz      Hz per bin
 * @param s.divisor    the server's poll divisor, 1 for full rate
 * @param s.queuedSec  audio queued ahead of the playback clock
 * @param s.outLatSec  what the hardware adds after that
 * @param s.underruns  dropouts since the session started
 * @param s.listeners  sessions on this receiver, this one included
 * @param s.chatUsers  how many of them are in chat, if chat is connected
 * @param s.ip         the address this page connected from, per /api/myip
 * @returns [{ key, label, value, title }]
 */
export function statLines(s = {}) {
    const out = [];
    const add = (key, label, value, title) => {
        if (value) out.push({ key, label, value, title });
    };

    // Animation frames, drawn or not — what the browser is managing, which on a
    // healthy machine is the display's refresh rate and on a struggling one is
    // not. Counting only the *drawn* frames would report the feed a second time:
    // the loop paints when a frame arrives and sleeps otherwise, so those two are
    // the same number by construction and one of them is not worth a line.
    add('fps', 'FPS', rate(s.fps), 'Animation frames per second — the rate the browser is managing, drawn or idle. Well below the screen refresh means this machine is struggling, whatever the receiver is doing.');

    add('feed', 'FEED', rate(s.framesIn) && `${rate(s.framesIn)}/s`, 'Spectrum frames arriving per second. Halves when the idle throttle takes effect, and drops to nothing when the socket is paused.');

    // Only when it is not 1. At full rate this line would say "the receiver is
    // behaving normally" in a corner meant for things that are not.
    if (s.divisor > 1) {
        add('poll', 'POLL', `1/${Math.round(s.divisor)}`, 'The server is polling the receiver at this fraction of the full rate — the idle throttle, or another client on a shared channel.');
    }

    const fft = [s.binCount > 0 && `${s.binCount} bins`, formatHzPerBin(s.binHz)]
        .filter(Boolean).join('  ');
    add('fft', 'FFT', fft, 'Bins across the view, and what one bin is worth. The resolution decides whether two close carriers are one blob or two.');

    add('net', 'NET', formatThroughput(s.bytesIn, s.audioBytes, s.bandBytes), 'Every stream this session is running — the main spectrum, the audio, and the band spectrum panel when it is open — and the total. What the connection is costing, and which part of it to do something about.');

    // Queue plus hardware, because the operator's question is "how far behind am
    // I", and answering with only the half this client controls is a figure that
    // is always wrong in the same direction.
    const latency = (s.queuedSec || 0) + (s.outLatSec || 0);
    const audio = latency > 0
        ? `${Math.round(latency * 1000)} ms${s.underruns > 0 ? `  ${s.underruns} drop${s.underruns === 1 ? '' : 's'}` : ''}`
        : null;
    // Listening, and how many of those are in chat — the bracket is left off
    // rather than shown as (0), because there are two different reasons for a
    // nought here and the readout cannot tell them apart: nobody in the room, or
    // no chat socket at all, which is what a hidden Chat panel means. A bracket
    // that appears when the panel is opened would be reporting the panel.
    const users = s.listeners > 0
        ? `${Math.round(s.listeners)}${s.chatUsers > 0 ? ` (${Math.round(s.chatUsers)})` : ''}`
        : null;
    add('users', 'USERS', users, 'Sessions on this receiver right now, yours included — the same list the Listeners panel shows — and in brackets how many are in chat. A shared receiver getting busy is the other reason the spectrum can slow down, and the one nothing else on this display would tell you about.');

    // Where the receiver thinks you are connecting from. Last, and worth one line
    // rather than the city and distance the start map gives it: the reason to want
    // it here is to see which address a session is on — a VPN that dropped, a
    // phone that moved from wifi to mobile data — and that is the address itself.
    add('ip', 'IP', typeof s.ip === 'string' && s.ip ? s.ip : null, 'The address this page is connected from, as the receiver sees it — /api/myip, the same lookup behind the greeting on the start screen.');

    add('audio', 'AUDIO', audio, 'Audio queued ahead of the playback clock plus what the output device adds — how far behind live you are, and how many dropouts there have been.');

    return out;
}

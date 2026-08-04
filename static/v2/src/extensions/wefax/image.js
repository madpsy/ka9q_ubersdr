// WEFAX: the decoder's wire frames, its settings, and the stations to hear.
//
// Radiofax is a picture sent one line at a time, so this decoder's results are
// not text at all — they are scanlines, defined in audio_extensions/wefax/
// decoder.go:
//
//     0x01  line   [type:1][line_number:4][width:4][grey pixels:width]
//     0x02  start  [type:1]
//     0x03  stop   [type:1]
//
// The two signals are the transmission's own start and stop tones, which every
// chart is bracketed by. They matter more than they look: on a START the server
// resets its line counter to zero so the picture begins at the top of the page,
// which means the client has to treat one as the end of whatever it was drawing
// and the beginning of something new. Without that, a second chart is drawn
// over the first.
//
// A line arrives every half second at 120 LPM, so nothing here is on a hot
// path. The pixels are 8-bit greyscale, one byte each.

export const FRAME_LINE = 0x01;
export const FRAME_START = 0x02;
export const FRAME_STOP = 0x03;

function bytesOf(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
}

/**
 * One binary frame, as the value the panel acts on, or null.
 *
 * Null for a frame that is truncated, of an unknown type, or not binary — the
 * same single failure signal the other decoders use, for the same reason: one
 * malformed frame must not take the panel down.
 *
 * The pixels are returned as a view onto the frame rather than a copy. The
 * caller paints them into a canvas within the same tick and never keeps the
 * reference, and a copy per line would be a megabyte a minute for nothing.
 */
export function decodeFrame(data) {
    const b = bytesOf(data);
    if (!b || b.length < 1) return null;

    switch (b[0]) {
        case FRAME_LINE: {
            if (b.length < 9) return null;
            const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
            const line = view.getUint32(1);
            const width = view.getUint32(5);
            // A width that disagrees with the frame is a truncated frame, not a
            // reason to paint whatever bytes happen to follow.
            if (width === 0 || width !== b.length - 9) return null;
            return { kind: 'line', line, width, pixels: b.subarray(9) };
        }
        case FRAME_START:
            return { kind: 'start' };
        case FRAME_STOP:
            return { kind: 'stop' };
        default:
            return null;
    }
}

// ── the decoder's settings ──────────────────────────────────────────────────

// Lines per minute. 120 is what almost every meteorological service transmits;
// 60 and 240 exist and 90 is rare.
export const LPM_OPTIONS = [60, 90, 120, 240];

// The demodulator's input filter. Narrow rejects more noise but softens the
// picture; wide is for a strong signal you want detail from.
export const BANDWIDTHS = [
    { value: 0, label: 'Narrow' },
    { value: 1, label: 'Middle' },
    { value: 2, label: 'Wide' },
];

// What the server will accept — audio_extensions/wefax/extension.go validates
// these — narrowed to what is worth offering. A carrier outside 1000-3000 Hz is
// not a fax you could receive in a sideband passband anyway.
export const LIMITS = {
    carrier: { min: 1000, max: 3000, step: 10 },
    deviation: { min: 100, max: 800, step: 10 },
    image_width: { min: 800, max: 4000, step: 1 },
};

// The defaults, which are the backend's except for the two automatic ones.
//
// auto_start and auto_stop are off server-side and on here, following v1's
// template. They are what makes the decoder behave like a fax machine rather
// than a chart recorder: wait for the start tone, draw the page, stop on the
// stop tone. With both off it paints continuously and every chart runs into the
// next one, which is only what you want if you are chasing a signal that never
// gives you a clean header.
export const WEFAX_CONFIG = {
    lpm: 120,
    image_width: 1809,
    carrier: 1900,
    deviation: 400,
    bandwidth: 1,
    use_phasing: true,
    auto_start: true,
    auto_stop: true,
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const int = (v, lim, fallback) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? Math.round(clamp(n, lim.min, lim.max)) : fallback;
};

/**
 * Settings in the shape the attach carries, with the numbers made safe.
 *
 * The server refuses an out-of-range value outright, and a refused attach is an
 * error the user has to clear rather than a setting they can nudge back.
 */
export function attachParams(config) {
    const lpm = LPM_OPTIONS.includes(Number(config.lpm)) ? Number(config.lpm) : WEFAX_CONFIG.lpm;
    const bw = Number(config.bandwidth);
    return {
        lpm,
        image_width: int(config.image_width, LIMITS.image_width, WEFAX_CONFIG.image_width),
        carrier: clamp(
            Number.isFinite(Number(config.carrier)) ? Number(config.carrier) : WEFAX_CONFIG.carrier,
            LIMITS.carrier.min, LIMITS.carrier.max,
        ),
        deviation: clamp(
            Number.isFinite(Number(config.deviation)) ? Number(config.deviation) : WEFAX_CONFIG.deviation,
            LIMITS.deviation.min, LIMITS.deviation.max,
        ),
        bandwidth: bw === 0 || bw === 1 || bw === 2 ? bw : WEFAX_CONFIG.bandwidth,
        use_phasing: !!config.use_phasing,
        auto_start: !!config.auto_start,
        auto_stop: !!config.auto_stop,
    };
}

// ── the picture ─────────────────────────────────────────────────────────────

// How tall the canvas starts, and how tall it may get.
//
// The cap is not tidiness: at the default width a canvas is 7 kB of bitmap per
// line, so an unattended overnight session with no stop tone would ask the
// browser for a gigabyte. Past the cap the panel finishes the picture and
// starts another, which is the behaviour you want anyway — you end up with a
// series of pages rather than one that fails to allocate.
export const INITIAL_LINES = 512;
export const MAX_IMAGE_LINES = 4000;

/**
 * How tall to make the canvas to hold `want` lines.
 *
 * Doubling, as v1 did, because growing means copying the bitmap: at one line
 * every half second, growing by a line at a time would copy the whole picture
 * twice a second.
 */
export function growTo(height, want, cap = MAX_IMAGE_LINES) {
    if (want <= height) return height;
    let next = Math.max(height, 1);
    while (next < want) next *= 2;
    return Math.min(next, cap);
}

/**
 * Whether a line begins a new picture rather than continuing this one.
 *
 * The server resets its line counter on a start tone, so a number that has gone
 * backwards means a new chart has begun — the case that matters when the start
 * frame itself was lost in the noise, which is common on the signal levels this
 * is used at. Filling the canvas is the other way a picture ends.
 */
export function startsNewImage(lineNumber, lastLine, cap = MAX_IMAGE_LINES) {
    if (lastLine == null) return false;
    return lineNumber < lastLine || lineNumber >= cap;
}

/**
 * Grey pixels as the RGBA a canvas wants.
 *
 * `out` is reused between lines — one line of RGBA is 7 kB at the default
 * width, and allocating that twice a second for an hour is 50 MB of garbage
 * for no reason.
 */
export function toRGBA(pixels, out) {
    const rgba = out && out.length >= pixels.length * 4 ? out : new Uint8ClampedArray(pixels.length * 4);
    for (let i = 0; i < pixels.length; i++) {
        const v = pixels[i];
        const o = i * 4;
        rgba[o] = v;
        rgba[o + 1] = v;
        rgba[o + 2] = v;
        rgba[o + 3] = 255;
    }
    return rgba;
}

/** How long one line takes, for the readout of how far through a page we are. */
export function lineSeconds(lpm) {
    const n = Number(lpm);
    return Number.isFinite(n) && n > 0 ? 60 / n : 0.5;
}

// ── stations ────────────────────────────────────────────────────────────────

// v1's station list, unchanged, including its choice of which frequencies to
// list for each transmitter. These are the *assigned* frequencies, so tuning one
// puts the dial a carrier below it — v1's tuneToStation arithmetic, and the
// standard way of receiving fax on a sideband receiver.
//
// `lpm` rides along because it is part of what a station is: choosing one sets
// the rate as well as the frequency, exactly as v1 did.
export const WEFAX_STATIONS = [
    {
        group: 'North America',
        options: [
            { hz: 4317900, lpm: 120, label: 'NMG New Orleans — 4.3179 MHz' },
            { hz: 8503900, lpm: 120, label: 'NMG New Orleans — 8.5039 MHz' },
            { hz: 12789900, lpm: 120, label: 'NMG New Orleans — 12.7899 MHz' },
            { hz: 17146400, lpm: 120, label: 'NMG New Orleans — 17.1464 MHz' },
            { hz: 4235000, lpm: 120, label: 'NMF Boston — 4.235 MHz' },
            { hz: 6340500, lpm: 120, label: 'NMF Boston — 6.3405 MHz' },
            { hz: 9110000, lpm: 120, label: 'NMF Boston — 9.110 MHz' },
            { hz: 12750000, lpm: 120, label: 'NMF Boston — 12.750 MHz' },
        ],
    },
    {
        group: 'Europe',
        options: [
            { hz: 3855000, lpm: 120, label: 'DDH47 Germany — 3.855 MHz' },
            { hz: 7880000, lpm: 120, label: 'DDH47 Germany — 7.880 MHz' },
            { hz: 13882500, lpm: 120, label: 'DDH47 Germany — 13.8825 MHz' },
            { hz: 2618500, lpm: 120, label: 'GYA UK — 2.6185 MHz' },
            { hz: 4610000, lpm: 120, label: 'GYA UK — 4.610 MHz' },
            { hz: 8040000, lpm: 120, label: 'GYA UK — 8.040 MHz' },
            { hz: 11086500, lpm: 120, label: 'GYA UK — 11.0865 MHz' },
        ],
    },
    {
        group: 'Asia / Pacific',
        options: [
            { hz: 3622500, lpm: 120, label: 'JMH Japan — 3.6225 MHz' },
            { hz: 7795000, lpm: 120, label: 'JMH Japan — 7.795 MHz' },
            { hz: 9970000, lpm: 120, label: 'JMH Japan — 9.970 MHz' },
            { hz: 13597500, lpm: 120, label: 'JMH Japan — 13.5975 MHz' },
            { hz: 10865000, lpm: 120, label: 'NMO Hawaii — 10.865 MHz' },
            { hz: 13861500, lpm: 120, label: 'NMO Hawaii — 13.8615 MHz' },
        ],
    },
];

/** The station entry at this assigned frequency, with its LPM. */
export function stationAt(hz) {
    for (const g of WEFAX_STATIONS) {
        for (const o of g.options) if (o.hz === hz) return o;
    }
    return null;
}

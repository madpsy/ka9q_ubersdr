// The Sound Modem's audio waterfall, and the channel markers over it.
//
// This is the panel's tuning aid and it does a job nothing else can: a packet
// modem listens at a fixed audio frequency, so getting the signal onto the
// channel marker is the whole of tuning it, and a burst lasts a fraction of a
// second — far too short to catch on a spectrum display that only shows now.
// A waterfall holds the last thirty seconds of them.
//
// It runs whether or not the decoder is started, as v1's does, because the
// point is to see where the traffic is *before* choosing a modem frequency.
//
// v1's colour map and 3300 Hz span are kept as they are. The map is a
// hand-rolled black → blue → cyan → green → yellow → red ramp rather than one
// of the palettes in qrss/dsp.js: those are calibrated for reading a carrier
// out of noise over tens of dB, and this one is calibrated for seeing the shape
// of a packet burst.

// The span drawn. Wider than the 3 kHz of a sideband passband on purpose: a
// modem may be configured up to 4 kHz, and a marker off the edge of the display
// is worse than a little empty space.
export const MAX_AUDIO_HZ = 3300;

// One line every 50 ms — twenty a second — so the scroll speed is the same
// whatever rate the animation loop happens to run at.
export const LINE_MS = 50;

// Channel marker colours, one per modem channel. Bright and saturated because
// they are drawn over a waterfall that uses the whole colour ramp itself.
export const CHANNEL_COLOURS = ['#ff4d4d', '#4dff88', '#4db4ff', '#ffd24d'];

/**
 * v1's colour ramp, as three functions of one byte.
 *
 * Kept as v1 wrote it — piecewise linear over four quarters — rather than
 * rewritten as a lookup table. The shape is the part that matters and this is
 * the shape, unambiguously.
 */
export function rampR(v) {
    if (v < 128) return 0;
    if (v < 192) return Math.round((v - 128) * 4);
    return 255;
}

export function rampG(v) {
    if (v < 64) return 0;
    if (v < 128) return Math.round((v - 64) * 4);
    if (v < 192) return 255;
    return Math.round(255 - (v - 192) * 4);
}

export function rampB(v) {
    if (v < 64) return Math.round(v * 4);
    if (v < 128) return 255;
    if (v < 192) return Math.round(255 - (v - 128) * 4);
    return 0;
}

/**
 * Which analyser bin each pixel column reads.
 *
 * The display spans 0..MAX_AUDIO_HZ and the analyser spans 0..Nyquist, so this
 * is the map between them. Built once per size change rather than per line: it
 * is the same arithmetic for every one of the twenty lines a second.
 */
export function buildBinMap(width, binCount, sampleRate, maxHz = MAX_AUDIO_HZ) {
    const map = new Uint32Array(width);
    const nyquist = (sampleRate || 48000) / 2;
    for (let px = 0; px < width; px++) {
        const hz = (px / width) * maxHz;
        map[px] = Math.min(Math.round((hz / nyquist) * binCount), Math.max(0, binCount - 1));
    }
    return map;
}

/** Where a frequency sits across the display, as a fraction, or null if off it. */
export function xOf(hz, maxHz = MAX_AUDIO_HZ) {
    if (!Number.isFinite(hz) || hz < 0 || hz > maxHz) return null;
    return hz / maxHz;
}

/**
 * How wide a modem's signal is, in Hz — for the bar drawn under each marker.
 *
 * Approximated from the baud rate in the modem's name, because that is what
 * QtSoundModem's own table gives us: an AX.25 modem occupies roughly its symbol
 * rate either side of centre for AFSK, and about the symbol rate in total for
 * PSK. It is a guide to where to put the signal, not a measurement, and it is
 * labelled as the modem's name rather than as a number for that reason.
 */
export function modemBandwidth(label) {
    const m = /(\d+(?:\.\d+)?)\s*bd/i.exec(String(label || ''));
    const baud = m ? parseFloat(m[1]) : 1200;
    // AFSK carries the shift as well as the symbol rate; Bell 202's tones are
    // a kilohertz apart, which is far wider than its 1200 baud alone implies.
    if (/AFSK/i.test(label)) return baud <= 300 ? 500 : 1200;
    return Math.max(200, baud * 1.2);
}

/**
 * Scroll the waterfall down a line and draw the newest at the top.
 *
 * Newest at the top and scrolling down, which is v1's direction and the one
 * every packet program uses. `bins` is the analyser's byte frequency data.
 */
export function drawLine(ctx, bins, binMap, rgba) {
    const { width, height } = ctx.canvas;
    if (!width || !height) return;
    // Move everything down one pixel by drawing the canvas onto itself.
    ctx.drawImage(ctx.canvas, 0, 0, width, height - 1, 0, 1, width, height - 1);

    const out = rgba && rgba.length === width * 4 ? rgba : new Uint8ClampedArray(width * 4);
    for (let px = 0; px < width; px++) {
        const v = bins[binMap[px]];
        const o = px * 4;
        out[o] = rampR(v);
        out[o + 1] = rampG(v);
        out[o + 2] = rampB(v);
        out[o + 3] = 255;
    }
    ctx.putImageData(new ImageData(out, width, 1), 0, 0);
    return out;
}

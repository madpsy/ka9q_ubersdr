// The picture of the 12 kHz the IQ demodulator is working inside.
//
// Everything else in this interface that draws spectrum draws the *server's*:
// radiod computes the transform, the socket delivers bins, and the client
// stretches them onto a canvas. This one is computed here, from the same
// quadrature samples the demodulator is listening to, and that difference is
// the point of it.
//
// Two things follow from being a complex transform rather than a real one:
//
//   * It is two-sided. A transform of I+jQ tells positive frequencies apart
//     from negative ones, so the twelve kilohertz appears as twelve kilohertz —
//     3 kHz below the dial is a different place from 3 kHz above it. The audio
//     analyser behind the Audio scope cannot do that: fed a demodulated mono
//     stream it has nothing to tell the two apart with, and the panel does not
//     even subscribe in IQ (see ScopePanel).
//   * It shows exactly what the demodulator can reach. The passband drawn over
//     it is the filter that is actually running, at the offset it is actually
//     running at, so aiming becomes pointing at a signal rather than moving a
//     slider and listening for the result.
//
// ── The half swap ────────────────────────────────────────────────────────────
//
// An FFT returns positive frequencies in the bottom half of the output and
// negative ones in the top, so bins in natural order run 0..+6 kHz then
// -6 kHz..0 — the two halves the wrong way round for anything meant to be read
// left to right. Every consumer of a transform in this codebase has to undo
// that and this is no exception; `frame()` writes the display order out and the
// tests pin it, because a picture with its halves swapped looks like a
// plausible spectrum of something else entirely rather than like a bug.

import { approachFor } from './timeConstant.js';

// 1024 complex points at 12 kHz: 11.7 Hz a bin, and 85 ms of signal in each
// transform. Fine enough to separate two CW signals inside a 500 Hz filter,
// short enough that the picture still moves with the band rather than smearing
// several seconds of it together.
export const IQ_FFT_SIZE = 1024;

// How much of the previous picture survives into the next, quoted at the
// reference frame interval in lib/timeConstant.js. Enough to stop the noise
// floor boiling; not so much that a CW element is gone before it is drawn.
const SMOOTH_K = 0.45;

// Below this the bin is treated as silence rather than as minus infinity, which
// is not a number a display can scale against. -180 dBFS is far below anything
// a 16-bit stream can carry.
const FLOOR_DB = -180;

// Twiddle tables, one per transform size. Built once: the recurrence that
// avoids them drifts over a thousand points, and this runs twenty times a
// second for the life of the session.
const TWIDDLES = new Map();

function twiddles(n) {
    let t = TWIDDLES.get(n);
    if (t) return t;
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) {
        cos[k] = Math.cos((2 * Math.PI * k) / n);
        sin[k] = Math.sin((2 * Math.PI * k) / n);
    }
    t = { cos, sin };
    TWIDDLES.set(n, t);
    return t;
}

/**
 * In-place radix-2 complex FFT. `re` and `im` must be the same power-of-two
 * length; both are overwritten with the transform.
 *
 * Written out rather than pulled in: this is thirty lines against a dependency
 * that would have to be vendored (see vendor/README.md for why a fetched one
 * cannot work here), and the only correctness question it raises — which half
 * of the output is which — is one the caller has to answer anyway.
 */
export function fftInPlace(re, im) {
    const n = re.length;
    if (n < 2 || (n & (n - 1)) !== 0) throw new Error('fftInPlace needs a power-of-two length');

    // Bit-reversal permutation.
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            const tr = re[i]; re[i] = re[j]; re[j] = tr;
            const ti = im[i]; im[i] = im[j]; im[j] = ti;
        }
    }

    const { cos, sin } = twiddles(n);
    for (let len = 2; len <= n; len <<= 1) {
        const half = len >> 1;
        const step = n / len;
        for (let base = 0; base < n; base += len) {
            for (let j = 0, k = 0; j < half; j++, k += step) {
                // e^(-j2*pi*k/n)
                const wr = cos[k];
                const wi = -sin[k];
                const a = base + j;
                const b = a + half;
                const vr = re[b] * wr - im[b] * wi;
                const vi = re[b] * wi + im[b] * wr;
                re[b] = re[a] - vr;
                im[b] = im[a] - vi;
                re[a] += vr;
                im[a] += vi;
            }
        }
    }
}

/**
 * A Hann window. Cheap, and its skirts are what stop a strong carrier spreading
 * across the whole picture.
 *
 * The QRSS extension has one of its own in extensions/qrss/dsp.js. Left
 * duplicated rather than shared: that module is a self-contained DSP kit for one
 * extension, with its own FFT class of a different shape, and reaching into an
 * extension from a lib would be the wrong direction for a nine-line function.
 */
export function hannWindow(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    return w;
}

/**
 * Where in the picture an offset falls, as a fraction from 0 to 1.
 *
 * The inverse of binOffsetHz over the whole span rather than per bin, because
 * that is what a canvas x coordinate wants. Values outside the span come back
 * outside 0..1 rather than clamped: a passband edge that has run off the end
 * should be drawn off the end, not stacked up against it.
 */
export function offsetFraction(hz, rateHz) {
    return (hz + rateHz / 2) / rateHz;
}

/** And back: the offset a fraction across the picture stands for. */
export function fractionOffset(frac, rateHz) {
    return (frac - 0.5) * rateHz;
}

/**
 * A ring of the most recent quadrature samples, and the transform of them.
 *
 * A ring rather than a batch so the picture is not tied to the packet size: at
 * 12 kHz a 20 ms packet is 240 samples, so a transform per packet would be
 * either four times too short or four packets stale. This keeps the last 1024
 * whatever arrives and transforms whenever asked, which is once a frame.
 */
export class IQSpectrum {
    constructor(size = IQ_FFT_SIZE) {
        this.size = size;
        this.rate = 12000;
        this.ring = { re: new Float32Array(size), im: new Float32Array(size) };
        this.pos = 0;
        this.filled = 0;
        this.window = hannWindow(size);
        // Coherent gain, so a full-scale tone reads 0 dBFS rather than whatever
        // the window and the length happen to make it.
        this.windowSum = this.window.reduce((a, b) => a + b, 0);
        this.wr = new Float32Array(size);
        this.wi = new Float32Array(size);
        this.db = new Float32Array(size);
        this.avg = null;
    }

    /** Take a block of planar quadrature, at whatever rate it arrived at. */
    push(planeI, planeQ, frames, rateHz) {
        if (!planeI || !planeQ || !frames) return;
        if (rateHz > 0) this.rate = rateHz;
        const { size } = this;
        // A block longer than the ring: only its tail can survive, and copying
        // the rest would be writing over what we are about to keep.
        const from = frames > size ? frames - size : 0;
        for (let i = from; i < frames; i++) {
            this.ring.re[this.pos] = planeI[i];
            this.ring.im[this.pos] = planeQ[i];
            this.pos = this.pos + 1 === size ? 0 : this.pos + 1;
        }
        this.filled = Math.min(size, this.filled + (frames - from));
    }

    /** Nothing has been through it yet, so there is no picture to draw. */
    get ready() {
        return this.filled >= this.size;
    }

    /** Forget everything. A mode change or a reconnect is not a continuation. */
    reset() {
        this.ring.re.fill(0);
        this.ring.im.fill(0);
        this.pos = 0;
        this.filled = 0;
        this.avg = null;
    }

    /**
     * The current picture in dBFS, low frequency first, or null if the ring has
     * not filled yet.
     *
     * The returned array is reused between calls: it is drawn within the same
     * frame and copying a thousand floats per frame to guard against a
     * hypothetical retainer would cost more than the problem.
     */
    frame(dtSec) {
        if (!this.ready) return null;
        const { size, window: win, wr, wi, db } = this;

        // Oldest first, windowed on the way out.
        for (let i = 0; i < size; i++) {
            const r = (this.pos + i) % size;
            const w = win[i];
            wr[i] = this.ring.re[r] * w;
            wi[i] = this.ring.im[r] * w;
        }
        fftInPlace(wr, wi);

        // Into display order — see the note at the top of this file.
        const half = size / 2;
        const norm = 1 / this.windowSum;
        for (let i = 0; i < size; i++) {
            const bin = i < half ? i + half : i - half;
            const re = wr[bin] * norm;
            const im = wi[bin] * norm;
            const p = re * re + im * im;
            db[i] = p > 0 ? Math.max(FLOOR_DB, 10 * Math.log10(p)) : FLOOR_DB;
        }

        if (!this.avg || this.avg.length !== size) {
            this.avg = Float32Array.from(db);
            return this.avg;
        }
        const a = approachFor(1 - SMOOTH_K, dtSec > 0 ? dtSec : 0.05);
        for (let i = 0; i < size; i++) this.avg[i] += (db[i] - this.avg[i]) * a;
        return this.avg;
    }
}

/**
 * Resample a bin array down to a pixel width, keeping the maximum in each.
 *
 * The maximum rather than the mean because a carrier is one bin wide and a mean
 * would average it away against the noise either side — a CW signal would
 * disappear at exactly the zoom where somebody is looking for it. Same choice
 * the main spectrum makes.
 */
export function binsToPixels(bins, out) {
    const n = bins.length;
    const w = out.length;
    for (let x = 0; x < w; x++) {
        const from = Math.floor((x * n) / w);
        const to = Math.max(from + 1, Math.floor(((x + 1) * n) / w));
        let peak = -Infinity;
        for (let i = from; i < to && i < n; i++) if (bins[i] > peak) peak = bins[i];
        out[x] = peak;
    }
    return out;
}

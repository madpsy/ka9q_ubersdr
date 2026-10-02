// The tone detector the MFSK family shares: a complex signal in, and for each
// symbol the power at each of a row of frequencies — the tones, and as many
// points between and beyond them as the mode needs.
//
// Every mode here sends one tone at a time out of a set spaced evenly, and a
// receiver's first job is the same for all of them: measure how much of each
// tone there is, once per symbol. What differs is what it does next, which is
// why that is the stage boundary:
//
//   MFSK16, MFSK32   the tones themselves, one point each, kept on frequency
//                    by AFC — the tone is the data (fldigi mfsk.cxx).
//   DominoEX, THOR   points a fifth of a tone apart and half the band again
//                    each side, with no AFC: the data is the step from one
//                    tone to the next, which a mistuning leaves alone
//                    (fldigi dominoex.cxx and thor.cxx, their `paths` and
//                    `extones`).
//   Olivia,          points half a tone apart and a margin each side, two
//   Contestia        rows per symbol and no timing of its own: the decoder
//                    after it searches every offset and timing at once (pj_mfsk.h
//                    MFSK_Demodulator, CarrierSepar 2 and SpectraPerSymbol 2).
//
// The row: `tones` tones `spacingHz` apart, centred on zero, tone k at
// (k − (tones − 1)/2) × spacing — where fldigi puts them about its carrier
// frequency in every one of these modes. Points are `oversample` to a
// spacing, and `margin` tones extend the row each side, so tone k is point
// round(margin × oversample) + k × oversample. Power is |X|² with the window
// normalised: a tone of amplitude 1 on a point reads 1.
//
// Each power is a DFT at that one frequency over one window, worked out
// directly at the moments it is needed rather than as a sliding DFT on every
// sample — a frame needs a few thousand multiplies, and with no running sums
// there is nothing to drift.
//
// ── Two pulses ──────────────────────────────────────────────────────────────
//
//   rect     one frame per symbol, over exactly one symbol — the matched
//            filter for a tone held one symbol, which is what MFSK16, DominoEX
//            and THOR send. It finds the symbols itself, as fldigi does
//            (mfsk::synchronize): when a tone stood alone between two others,
//            how far from where it was expected its power peaked says how
//            early or late the frames are, and the next frame moves a part of
//            the way. In between, AFC (mfsk::afc): a tone held two symbols
//            running turns its phase by exactly its frequency times the time
//            between, so what is left over is the mistuning.
//   olivia   two frames per symbol, each over two symbols with Olivia's
//            raised-cosine window (1 − cos, pj_mfsk.h MFSK_Demodulator::
//            SymbolShape — the shape its modulator gives each tone), and no
//            timing: the frames simply run, half a symbol apart, and the
//            decoder works out which line up with the symbols.

import { Decimator } from '../../lib/dsp/decimator.js';
import { designLowpass } from '../../lib/dsp/fir.js';

/** Where the points are for a detector's settings: `{ os, first, size, centre }`. */
export function toneGrid(p) {
    const os = Math.max(1, Math.round(p.oversample || 1));
    const first = Math.round((p.margin || 0) * os);
    const size = (Math.round(p.tones) - 1) * os + 2 * first + 1;
    // The point that is the row's middle — zero hertz — which need not be a
    // whole one (an even number of tones puts zero between two).
    return { os, first, size, centre: (size - 1) / 2 };
}

/** Frames per symbol for a pulse. */
export const framesPerSymbol = (pulse) => (pulse === 'olivia' ? 2 : 1);

// How many frames apart the timing probe looks, either side of where a symbol
// was decided: a sixteenth of a symbol each.
const PROBE_STEPS = 16;
// How far each timing measurement moves the frames: a part of the way, so one
// bad reading in noise moves them little.
const TIMING_GAIN = 0.25;
// How far each AFC measurement moves the tuning, and the most one may say.
// fldigi believes a quarter of a spacing (mfsk::afc), which leaves a signal
// further off than that where it is; but while the tone decided is the right
// one — anything under half a spacing off — the measurement is right too, up
// to the half a baud it can tell apart, so this believes nearly that.
const AFC_GAIN = 0.1;
const AFC_TRUST = 0.45;
// And only while a signal is there: fldigi asks the same (afcmetric, and the
// squelch), or noise walks the tuning off.
const AFC_QUALITY = 6;

const wrapPi = (x) => x - 2 * Math.PI * Math.round(x / (2 * Math.PI));

export class ToneDetector {
    constructor() {
        this.dec = new Decimator();
        this.key = '';
        this.p = null;
        this.grid = toneGrid({ tones: 2 });
        this.afcHz = 0;
        this.reset();
    }

    /** At `rate`, for settings `p`. Keeps what it can of what it was doing. */
    configure(rate, p) {
        const grid = toneGrid(p);
        // Wide enough for the whole row and a spacing more, and fine enough
        // that a symbol is a few dozen samples: below that the timing probe
        // has nothing to resolve.
        const pass = ((p.tones - 1) / 2 + (p.margin || 0) + 1) * p.spacingHz + p.baud;
        const D = Math.max(1, Math.floor(rate / Math.max(2 * pass + 200, 24 * p.baud)));
        const key = `${rate}/${D}/${pass}/${p.baud}/${p.pulse}/${grid.size}/${grid.os}/${grid.first}/${p.spacingHz}/${p.tones}`;
        this.p = p;
        if (!p.afc) this.afcHz = 0;
        if (key === this.key) return;
        this.key = key;
        this.grid = grid;
        this.rate = rate / D;
        if (D > 1) {
            const stop = this.rate - pass;
            this.dec.setFilter(designLowpass((pass + stop) / 2, rate, stop - pass), D);
        } else {
            this.dec.setFilter(Float32Array.of(1), 1);
        }
        this.D = D;
        this.period = this.rate / p.baud;
        const span = p.pulse === 'olivia' ? 2 : 1;
        this.N = Math.max(4, Math.round(span * this.period));
        this.window = new Float64Array(this.N);
        let sum = 0;
        for (let n = 0; n < this.N; n++) {
            this.window[n] = p.pulse === 'olivia' ? 1 - Math.cos((2 * Math.PI * n) / this.N) : 1;
            sum += this.window[n];
        }
        this.norm = 1 / (sum * sum);
        // Each point's frequency, in cycles per (decimated) sample.
        this.freqs = new Float64Array(grid.size);
        for (let g = 0; g < grid.size; g++) this.freqs[g] = (((g - grid.centre) / grid.os) * p.spacingHz) / this.rate;
        // Three symbols of history and a window: what the timing probe reaches back to.
        const need = Math.ceil(3 * this.period + this.N + 16);
        this.size = 1 << Math.ceil(Math.log2(need));
        this.reI = new Float64Array(this.size);
        this.reQ = new Float64Array(this.size);
        this.xr = new Float64Array(grid.size);
        this.xi = new Float64Array(grid.size);
        this.pr = new Float64Array(grid.size);
        this.pi = new Float64Array(grid.size);
        this.power = new Float64Array(grid.size);
        this.reset();
    }

    reset() {
        this.dec.reset();
        this.total = 0;
        this.next = this.N || 0;
        this.prevEnd = -1;
        this.prev = -1;
        this.prev2 = -1;
        this.afcHz = 0;
        this.quality = 0;
        if (this.reI) { this.reI.fill(0); this.reQ.fill(0); }
        this.tmpI = null;
        this.tmpQ = null;
    }

    /**
     * The DFT at points `from`..`to` (exclusive) over the window ending at
     * sample `end`, into xr/xi. Phases are taken from the window's start.
     */
    _dft(end, from, to) {
        const { N, size, reI, reQ, window, freqs, xr, xi } = this;
        const mask = size - 1;
        const start = end - N;
        for (let g = from; g < to; g++) {
            const w = -2 * Math.PI * freqs[g];
            const cr = Math.cos(w);
            const ci = Math.sin(w);
            let er = 1;
            let ei = 0;
            let sr = 0;
            let si = 0;
            for (let n = 0; n < N; n++) {
                const at = (start + n) & mask;
                const a = reI[at] * window[n];
                const b = reQ[at] * window[n];
                sr += a * er - b * ei;
                si += a * ei + b * er;
                const t = er * cr - ei * ci;
                ei = er * ci + ei * cr;
                er = t;
            }
            xr[g] = sr;
            xi[g] = si;
        }
    }

    /** Power at one point over the window ending at `end`. */
    _powerAt(end, g) {
        this._dft(end, g, g + 1);
        return (this.xr[g] * this.xr[g] + this.xi[g] * this.xi[g]) * this.norm;
    }

    /**
     * `n` samples in; each frame's powers appended to `out` from `at`, in
     * point order (reversed for an inverted signal). Returns how many values
     * were written.
     */
    process(re, im, n, inRate, out, at = 0) {
        if (!this.p) return 0;
        const max = Math.ceil(n / this.D) + 2;
        if (!this.tmpI || this.tmpI.length < max) {
            this.tmpI = new Float64Array(max);
            this.tmpQ = new Float64Array(max);
        }
        this.dec.frequencyHz = this.afcHz;
        const m = this.dec.process(re, im, this.tmpI, this.tmpQ, n, inRate);
        const mask = this.size - 1;
        let w = at;
        for (let k = 0; k < m; k++) {
            this.reI[this.total & mask] = this.tmpI[k];
            this.reQ[this.total & mask] = this.tmpQ[k];
            this.total++;
            while (this.total >= Math.ceil(this.next)) {
                w = this.p.pulse === 'olivia' ? this._oliviaFrame(out, w) : this._symbol(out, w);
            }
        }
        // Keep the counts small; only differences matter to anything here.
        if (this.total > this.size * 4096) {
            const back = this.size * 2048;
            this.total -= back;
            this.next -= back;
            if (this.prevEnd >= 0) this.prevEnd -= back;
        }
        return w - at;
    }

    _emit(out, w) {
        const { size } = this.grid;
        const { power, norm, xr, xi } = this;
        for (let g = 0; g < size; g++) power[g] = (xr[g] * xr[g] + xi[g] * xi[g]) * norm;
        if (this.p.invert) for (let g = 0; g < size; g++) out[w + g] = power[size - 1 - g];
        else out.set(power, w);
        return w + size;
    }

    _oliviaFrame(out, w) {
        const end = Math.round(this.next);
        this._dft(end, 0, this.grid.size);
        this.next += this.period / 2;
        return this._emit(out, w);
    }

    _symbol(out, w) {
        const { size } = this.grid;
        const end = Math.round(this.next);
        this._dft(end, 0, size);
        w = this._emit(out, w);
        let cur = 0;
        let sum = 0;
        for (let g = 0; g < size; g++) {
            sum += this.power[g];
            if (this.power[g] > this.power[cur]) cur = g;
        }
        // How far the strongest stands above the rest, smoothed: in noise
        // alone the largest of sixteen is three or four times the others'
        // average; a signal AFC can trust, ten and more.
        const rest = (sum - this.power[cur]) / Math.max(1, size - 1);
        this.quality += 0.1 * ((rest > 0 ? this.power[cur] / rest : 0) - this.quality);

        // AFC: the same tone two symbols running has turned its phase by its
        // own frequency times the time between, and anything more is the
        // mistuning (mfsk::afc, which also wants the tone repeated).
        if (this.p.afc && cur === this.prev && this.prevEnd >= 0 && this.quality > AFC_QUALITY) {
            const dt = end - this.prevEnd;
            const dphi = Math.atan2(this.xi[cur] * this.pr[cur] - this.xr[cur] * this.pi[cur],
                this.xr[cur] * this.pr[cur] + this.xi[cur] * this.pi[cur]);
            // Phases run from each window's start, so the tone's own turn
            // over dt is 2π f dt.
            const err = (wrapPi(dphi - 2 * Math.PI * this.freqs[cur] * dt) * this.rate) / (2 * Math.PI * dt);
            if (Math.abs(err) < AFC_TRUST * Math.min(this.p.spacingHz, this.p.baud)) {
                const lim = this.p.afcRangeHz;
                this.afcHz = Math.max(-lim, Math.min(lim, this.afcHz + AFC_GAIN * err));
            }
        }

        // Timing: the last symbol's tone, standing alone between two others,
        // should have peaked exactly where it was decided. Look either side
        // of there and move toward where it did (mfsk::synchronize, which
        // asks the same of the tones either side).
        let move = 0;
        if (this.prev >= 0 && cur !== this.prev && this.prev !== this.prev2 && this.prevEnd >= 0) {
            const step = this.period / PROBE_STEPS;
            let best = 0;
            let bestP = -1;
            const probe = new Float64Array(2 * PROBE_STEPS + 1);
            for (let k = -PROBE_STEPS; k <= PROBE_STEPS; k++) {
                const e = Math.round(this.prevEnd + k * step);
                if (e > this.total || e - this.N < this.total - this.size) continue;
                const pw = this._powerAt(e, this.prev);
                probe[k + PROBE_STEPS] = pw;
                if (pw > bestP) { bestP = pw; best = k; }
            }
            // A parabola through the peak and its neighbours, for the part
            // of a step.
            let frac = 0;
            if (best > -PROBE_STEPS && best < PROBE_STEPS) {
                const a = probe[best + PROBE_STEPS - 1];
                const b = probe[best + PROBE_STEPS];
                const c = probe[best + PROBE_STEPS + 1];
                const den = a - 2 * b + c;
                if (den < 0) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
            }
            move = TIMING_GAIN * (best + frac) * step;
            // The DFT above wrote point `prev` of the frame; put it back.
            this._dft(end, this.prev, this.prev + 1);
        }

        this.pr.set(this.xr);
        this.pi.set(this.xi);
        this.prevEnd = end;
        this.prev2 = this.prev;
        this.prev = cur;
        this.next += this.period + Math.max(-this.period / 4, Math.min(this.period / 4, move));
        return w;
    }
}

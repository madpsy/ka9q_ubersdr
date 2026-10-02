// WEFAX (HF radiofax): weather charts sent a line at a time as an FM subcarrier.
//
// Ported from ubersdr_wefax (github.com/madpsy/ubersdr_wefax, MIT licence),
// decoder.go, whose own lineage is ACfax by way of OpenCPN's weatherfax plugin:
// the same 17-tap low-pass filters, the same quadrature FM discriminator and
// its scale, the same DFT tone tests on the demodulated stream, the same
// phasing-line search, line counting and output-line blending.
//
// The signal: a carrier at 1900 Hz swung ±400 Hz — 1500 Hz black, 2300 Hz white
// — at LPM lines a minute. A transmission opens with a START tone (the picture
// keyed black/white as a square wave at 300 Hz for IOC 576, 675 Hz for IOC 288)
// for 5 s, then 30 s of phasing lines (black, with a white pulse 5% of a line
// long centred on the line boundary) that tell a receiver where a line begins,
// then the picture, then a STOP tone (450 Hz) for 5 s. The IOC (index of
// cooperation) fixes the picture's shape: π·IOC pixels a line keeps them square,
// 1809 for IOC 576 (truncated, as the Go has it).
//
// Where this differs from the Go, and why:
//  - Audio above ~18 kHz is first decimated to near 12 kHz, the rate UberSDR
//    sends the Go addon. The 17-tap filters are fixed coefficients, so their
//    cutoff scales with the rate; at 48 kHz they would let the mixer's 3.8 kHz
//    image straight through.
//  - The local oscillator keeps its phase from line to line. The Go restarts it
//    at zero every line, harmless at 12 kHz (a whole number of cycles a line)
//    but a click at the start of every line at rates like 11025 Hz.
//  - The line length is kept exact. The Go cuts a line to int(rate·60/lpm)
//    samples, which at 11025 Hz is half a sample short a line, a 90 ppm slant;
//    here the sample-rate ratio (the Go's samplesPerSecFrac/samplesPerSecNom)
//    absorbs the remainder, and `slantPpm` adds a known clock error to it.
//    The Go has no automatic slant correction (samplesPerSecFrac is never
//    changed after construction), so neither does this.
//  - The 675 Hz IOC 288 START tone, defined but never tested in the Go, is
//    tested, and (with `autoIoc`) switches the picture to IOC 288.
//  - Phasing uses at most the phasing lines there are: 40 at 120 and 90 LPM,
//    as the Go, but fewer at 60 LPM, where 30 s holds only 30 lines and the
//    Go's 40 would read picture lines as phasing and reject the lot.
//  - A tone held for many lines is acted on once, not every line it lasts.
//
// It comes in two halves, so the playground can build fax from blocks:
// WefaxFrontEnd (audio to an FM level, −1 black … +1 white — the scale of the
// fm-discriminator block) and WefaxRaster (that level to pictures; the
// fax-raster block in blocks/fax.js). WefaxDecoder is the two in a line.
//
// Output is image events (README.md): a picture per START, its height unknown,
// ending complete at STOP or cut short by reset() or a new START.

import { quantile } from '../timecode/dsp.js';

// Low-pass coefficients from ACfax, by bandwidth.
const WEFAX_LPF = {
    narrow: [-7, -18, -15, 11, 56, 116, 177, 223, 240, 223, 177, 116, 56, 11, -15, -18, -7],
    middle: [0, -18, -38, -39, 0, 83, 191, 284, 320, 284, 191, 83, 0, -39, -38, -18, 0],
    wide: [6, 20, 7, -42, -74, -12, 159, 353, 440, 353, 159, -12, -74, -42, 7, 20, 6],
};

const WEFAX_START_576_HZ = 300;
const WEFAX_START_288_HZ = 675;
const WEFAX_STOP_HZ = 450;
const WEFAX_TONE_SECONDS = 5;
const WEFAX_PHASING_SECONDS = 30;
// Phasing lines read after the tone before positions are trusted, and again
// after the median before the picture starts (the Go's phasingSkipLines).
const PHASING_SKIP_LINES = 2;
// The DFT tone tests' threshold, in pixel levels a sample (0–255 stream).
const TONE_THRESHOLD = 5;

const HDR_IMAGE = 0;
const HDR_START = 1;
const HDR_STOP = 2;

/** The Go's FIRFilter: a 17-tap delay line, newest sample walking backwards. */
class WefaxFir {
    constructor(coeff) {
        this.c = coeff;
        this.buf = new Float64Array(17);
        this.cur = 0;
    }

    apply(x) {
        const b = this.buf, c = this.c;
        b[this.cur] = x;
        let sum = 0;
        let idx = this.cur;
        for (let i = 0; i < 17; i++) {
            sum += b[idx] * c[i];
            if (++idx >= 17) idx = 0;
        }
        if (--this.cur < 0) this.cur = 16;
        return sum;
    }
}

/**
 * Integer decimation behind a Blackman windowed-sinc low-pass, so the fixed
 * 17-tap filters see the rate they were designed near. Passes up to ~3.6 kHz,
 * well clear of the fax band (1500–2300 Hz and its sidebands).
 */
class WefaxDecimator {
    constructor(fs, factor) {
        this.m = factor;
        const fc = 3600 / fs;
        const n = Math.max(15, Math.ceil((5.5 * fs) / 2400)) | 1;
        this.h = new Float64Array(n);
        let sum = 0;
        for (let i = 0; i < n; i++) {
            const k = i - (n - 1) / 2;
            const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
            const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
            this.h[i] = sinc * w;
            sum += this.h[i];
        }
        for (let i = 0; i < n; i++) this.h[i] /= sum;
        // Doubled ring, so a window is always one contiguous run.
        this.ring = new Float64Array(2 * n);
        this.pos = 0;
        this.phase = 0;
    }

    /** Push one input sample; returns the output sample, or NaN between outputs. */
    push(x) {
        const n = this.h.length;
        this.ring[this.pos] = x;
        this.ring[this.pos + n] = x;
        if (++this.pos >= n) this.pos = 0;
        if (++this.phase < this.m) return NaN;
        this.phase = 0;
        let acc = 0;
        const r = this.ring, h = this.h, p = this.pos;
        for (let i = 0; i < n; i++) acc += r[p + i] * h[i];
        return acc;
    }
}

// The Go's discriminator gain over the plain one: its x is -1.3·(fs/dev/8)
// times sin(Δφ), which is 1.3·2π/8 = 1.021 times the frequency offset over the
// deviation. Levels here are the plain one (−1 black, +1 white, as an FM
// discriminator block puts them out); the raster puts the 1.021 back, so the
// grey scale, slight overdrive included, is the Go's.
const WEFAX_GO_GAIN = (1.3 * 2 * Math.PI) / 8;

/**
 * Image width for an IOC: π·IOC pixels keeps them square, truncated as the Go
 * and the stations' own figures have it — 1809 for IOC 576, 904 for 288.
 */
export const wefaxWidthFor = (ioc) => Math.floor(Math.PI * ioc);

/**
 * The front end: audio in, the FM level out (−1 at carrier − deviation, black;
 * +1 at carrier + deviation, white), at the audio rate over `decimation`.
 *
 * The Go's demodulateData: mix to zero, the ACfax 17-tap low-pass on I and Q,
 * normalise, and take i·Δq − q·Δi — sin(Δφ), which is the frequency offset for
 * the small phase steps a ±400 Hz swing makes. Ahead of it, audio above ~18 kHz
 * is brought down near 12 kHz, the rate the filters' fixed coefficients were
 * chosen for.
 */
export class WefaxFrontEnd {
    constructor({ sampleRate, carrier = 1900, deviation = 400, bandwidth = 'middle' } = {}) {
        if (!(sampleRate > 0)) throw new Error('A sample rate is needed');
        this.fsIn = sampleRate;
        this.decimation = Math.max(1, Math.round(sampleRate / 12000));
        this.rate = sampleRate / this.decimation;
        this.carrier = carrier;
        this.deviation = deviation;
        this.coeff = WEFAX_LPF[bandwidth] || WEFAX_LPF.middle;
        this.reset();
    }

    reset() {
        this.decimator = this.decimation > 1 ? new WefaxDecimator(this.fsIn, this.decimation) : null;
        this.fir = [new WefaxFir(this.coeff), new WefaxFir(this.coeff)];
        this.iPrev = 0; this.qPrev = 0;
        this.oscPhase = 0;
        this.phaseInc = this.carrier / this.rate;
        this.scale = this.rate / (2 * Math.PI * this.deviation);
    }

    /** Most levels `n` audio samples can make. */
    maxOut(n) { return Math.ceil(n / this.decimation) + 1; }

    /** Demodulate n samples of `x` into `out`; returns how many levels were written. */
    process(x, n, out) {
        const dec = this.decimator;
        let m = 0;
        for (let k = 0; k < n; k++) {
            let s = x[k];
            if (dec) {
                s = dec.push(s);
                if (s !== s) continue;
            }
            out[m++] = this._level(s);
        }
        return m;
    }

    _level(samp) {
        // The oscillator keeps its phase from line to line (the Go restarts it).
        const ph = 2 * Math.PI * this.oscPhase;
        let i = this.fir[0].apply(samp * Math.cos(ph));
        let q = this.fir[1].apply(samp * Math.sin(ph));
        this.oscPhase += this.phaseInc;
        if (this.oscPhase > 1) this.oscPhase -= 1;
        const mag = Math.sqrt(i * i + q * q);
        if (mag > 0) { i /= mag; q /= mag; }
        // Mixing by e^{+jωt} puts a tone above the carrier below zero, so the
        // sign is turned round: white positive.
        const v = -(i * (q - this.qPrev) - q * (i - this.iPrev)) * this.scale;
        this.iPrev = i;
        this.qPrev = q;
        return v;
    }
}

/**
 * The raster: FM level in (−1 black, +1 white, any rate), pictures out. Lines
 * of LPM a minute, START/STOP found by the Go's DFTs on the demodulated line,
 * phasing, the IOC switch, slant, and the Go's output-line blending.
 */
export class WefaxRaster {
    constructor({
        sampleRate, lpm = 120, ioc = 576, width = null, usePhasing = true, autoStart = true,
        autoStop = true, includeHeaders = false, autoIoc = true, slantPpm = 0,
    } = {}) {
        if (!(sampleRate > 0)) throw new Error('A sample rate is needed');
        this.fs = sampleRate;
        this.lpm = +lpm > 0 ? +lpm : 120;
        this.ioc = +ioc === 288 ? 288 : 576;
        this.fixedWidth = width > 0 ? Math.round(width) : null;
        this.usePhasing = !!usePhasing;
        this.autoStart = !!autoStart;
        this.autoStop = !!autoStop;
        this.includeHeaders = !!includeHeaders;
        this.autoIoc = !!autoIoc;
        this.slantPpm = +slantPpm || 0;
        this.skipHeaderDetection = !this.usePhasing && !this.autoStop && !this.autoStart;
        this.serial = 0;
        this.events = [];
        this.id = null;
        this.reset();
    }

    get mode() { return `WEFAX ${this.lpm}/${this.ioc}`; }

    /** Line geometry: everything that follows from rate, LPM, IOC and slant. */
    _geometry() {
        this.width = this.fixedWidth || wefaxWidthFor(this.ioc);
        const exact = (this.fs * 60) / this.lpm;
        this.samplesPerLine = Math.floor(exact);
        // Stored samples a line are whole; input samples a line need not be.
        // The Go's sampleRateRatio, with the truncation and the clock error in it.
        this.ratio = (exact * (1 + this.slantPpm * 1e-6)) / this.samplesPerLine;
        this.lineIncrFrac = this.width / (Math.PI * this.ioc);
        this.phasingLines = Math.max(8, Math.min(40, Math.floor((WEFAX_PHASING_SECONDS * this.lpm) / 60) - 4));
        this.line = new Uint8Array(this.samplesPerLine);
        this.cur = new Uint8ClampedArray(this.width);
        this.prev = new Uint8ClampedArray(this.width);
        this.phasingPos = new Array(this.phasingLines).fill(0);
    }

    reset() {
        if (this.id) this._end(false);
        this._geometry();
        this.sampIdx = 0;
        this.fi = 0;
        this.imageLine = 0;
        this.rows = 0;
        this.lineIncrAcc = 0;
        this.lineBlend = 0;
        this.lastType = HDR_IMAGE;
        this.typeCount = 0;
        this.toneLatch = HDR_IMAGE;
        this.phasingLinesLeft = 0;
        this.phasingSkipData = 0;
        this.havePhasing = false;
        this.inPhasing = false;
        this.autoStopped = false;
        this.autoStarted = false;
        // Without auto-start a picture is open from the first sample.
        if (!this.autoStart) this._begin();
    }

    drain() {
        const e = this.events;
        this.events = [];
        return e;
    }

    status() {
        let state = 'idle';
        if (this.id && !this.autoStopped) state = this.inPhasing ? 'phasing' : 'receiving';
        return { state, mode: this.mode, detail: { line: this.rows, lpm: this.lpm, ioc: this.ioc } };
    }

    _begin() {
        this.serial++;
        this.id = `${this.mode}-${Date.now()}-${this.serial}`;
        this.rows = 0;
        this.events.push({ type: 'image', event: 'start', id: this.id, mode: this.mode, width: this.width, height: null, colour: 'gray' });
    }

    _end(complete) {
        this.events.push({ type: 'image', event: 'end', id: this.id, complete });
        this.id = null;
    }

    /**
     * n levels. The Go walks a packet by a fractional index, advancing it by
     * the rate ratio for every sample stored, so a fast clock drops a sample
     * now and then and a slow one repeats one; `fi` is that index, relative to
     * the sample in hand.
     */
    process(level, n = level.length) {
        for (let k = 0; k < n; k++) {
            // The Go's pixel: (x/2 + 0.5)·255, truncated and clipped.
            let px = Math.trunc(((WEFAX_GO_GAIN * level[k]) / 2 + 0.5) * 255);
            if (px < 0) px = 0; else if (px > 255) px = 255;
            while (this.fi < 1) {
                this.line[this.sampIdx++] = px;
                this.fi += this.ratio;
                if (this.sampIdx === this.samplesPerLine) {
                    this.sampIdx = 0;
                    this._decodeLine();
                }
            }
            this.fi -= 1;
        }
    }

    /** The Go's fourierTransformSub: the DFT magnitude of the line's start at one tone. */
    _toneMag(len, freq) {
        const k = (-2 * Math.PI * freq * 60) / this.lpm / this.samplesPerLine;
        const b = this.line;
        let re = 0, im = 0;
        for (let n = 0; n < len; n++) {
            re += b[n] * Math.cos(k * n);
            im += b[n] * Math.sin(k * n);
        }
        return Math.sqrt(re * re + im * im);
    }

    _lineType() {
        const len = Math.min(this.samplesPerLine, 3000);
        const s576 = this._toneMag(len, WEFAX_START_576_HZ) / len;
        const s288 = this._toneMag(len, WEFAX_START_288_HZ) / len;
        const stop = this._toneMag(len, WEFAX_STOP_HZ) / len;
        if (s576 > TONE_THRESHOLD || s288 > TONE_THRESHOLD) {
            this.startIoc = s288 > s576 ? 288 : 576;
            return HDR_START;
        }
        if (stop > TONE_THRESHOLD) return HDR_STOP;
        return HDR_IMAGE;
    }

    /**
     * The Go's faxPhasingLinePosition: slide a triangular window 7% of a line
     * wide along it and take the place that is whitest — the phasing pulse —
     * returning its middle, which is where a line starts.
     */
    _phasingPosition() {
        const spl = this.samplesPerLine, img = this.line;
        const n = Math.trunc(spl * 0.07);
        const res = 4;
        const incr = Math.max(1, Math.trunc(spl / this.width)) * res;
        let minTotal = -1, minPos = 0;
        for (let i = 0; i < spl; i += incr) {
            let total = 0;
            for (let j = 0; j < n; j += res) {
                const wedge = (n >> 1) - Math.abs(j - (n >> 1));
                total += wedge * (255 - img[(i + j) % spl]);
            }
            if (total < minTotal || minTotal === -1) { minTotal = total; minPos = i; }
        }
        return (minPos + (n >> 1)) % spl;
    }

    _onStart() {
        const ioc = this.startIoc;
        this.events.push({ type: 'text', text: `START ${ioc}\n` });
        // A picture already open was cut short by this one.
        if (this.id) this._end(false);
        if (this.autoIoc && ioc !== this.ioc) {
            this.ioc = ioc;
            this.width = this.fixedWidth || wefaxWidthFor(this.ioc);
            this.lineIncrFrac = this.width / (Math.PI * this.ioc);
            this.cur = new Uint8ClampedArray(this.width);
            this.prev = new Uint8ClampedArray(this.width);
        }
        if (!this.includeHeaders) {
            this.imageLine = 0;
            this.lineIncrAcc = 0;
            this.lineBlend = 0;
        }
        this.phasingLinesLeft = this.phasingLines;
        this.inPhasing = this.usePhasing;
        this.phasingSkipData = 0;
        this.havePhasing = false;
        this.autoStopped = false;
        if (this.autoStart) this.autoStarted = true;
        this._begin();
    }

    _onStop() {
        this.events.push({ type: 'text', text: 'STOP\n' });
        if (this.autoStop) this.autoStopped = true;
        if (this.autoStart) this.autoStarted = false;
        this.inPhasing = false;
        // Without auto-stop the picture runs on through the tone, as in the Go.
        if (this.id && (this.autoStop || this.autoStart)) this._end(true);
    }

    /** The Go's decodeFaxLine: classify the line, track tones and phasing, and draw it. */
    _decodeLine() {
        const type = this.skipHeaderDetection ? HDR_IMAGE : this._lineType();

        if (type === this.lastType && type !== HDR_IMAGE) {
            this.typeCount++;
        } else if (--this.typeCount < 0) {
            this.typeCount = 0;
        }
        this.lastType = type;
        // A tone counts once it has lasted most of its 5 s, less some leeway.
        const threshold = Math.trunc((WEFAX_TONE_SECONDS * this.lpm) / 60) - 4;
        if (type !== this.toneLatch) this.toneLatch = HDR_IMAGE;

        if (type !== HDR_IMAGE && this.typeCount >= threshold && this.toneLatch !== type) {
            this.toneLatch = type;
            if (type === HDR_START) {
                // Already receiving under auto-start: picture content near 300 Hz
                // tripped the detector. Ignored outright, as in the Go, or a
                // good picture would be thrown away half drawn.
                if (!(this.autoStart && this.autoStarted)) this._onStart();
            } else if (this.autoStop || this.autoStart || this.id) {
                this._onStop();
            }
        }

        const pl = this.phasingLines;
        if (this.usePhasing && this.phasingLinesLeft > 0 && this.phasingLinesLeft <= pl - PHASING_SKIP_LINES) {
            this.phasingPos[this.phasingLinesLeft - 1] = this._phasingPosition();
        }

        if (this.usePhasing && type === HDR_IMAGE && this.phasingLinesLeft >= -PHASING_SKIP_LINES) {
            this.phasingLinesLeft--;
            if (this.phasingLinesLeft === 0) {
                const pos = this.phasingPos.slice(0, pl - PHASING_SKIP_LINES);
                this.phasingSkipData = quantile(pos, 0.5);
                // Positions all over the line are not a phasing signal.
                if (quantile(pos, 0.9) - quantile(pos, 0.1) > this.samplesPerLine / 6) {
                    this.phasingSkipData = 0;
                    if (this.id) this.events.push({ type: 'text', text: 'no phasing\n' });
                } else if (this.id) {
                    this.events.push({ type: 'text', text: 'phasing\n' });
                }
            }
            if (this.phasingLinesLeft < -PHASING_SKIP_LINES) this.inPhasing = false;
        }

        if (this.includeHeaders || !this.usePhasing || (type === HDR_IMAGE && this.phasingLinesLeft < -PHASING_SKIP_LINES)) {
            const shouldDecode = !this.autoStopped && (!this.autoStart || this.autoStarted);
            if (shouldDecode) {
                if (!this.id) this._begin();
                this._decodeImageLine();
            }
            this.phasingSkipData %= this.samplesPerLine;
            if (this.phasingSkipData !== 0 && this.usePhasing && !this.havePhasing) {
                // Drop that many samples so lines start at the phasing pulse.
                // The Go drops them at the next packet; here, straight away.
                this.fi += this.phasingSkipData * this.ratio;
                this.havePhasing = true;
            }
            this.imageLine++;
        }
    }

    /**
     * The Go's decodeImageLine: average the samples under each pixel, then emit
     * a line each time the accumulated line increment passes one — blended with
     * the line before by where the crossing fell — so a width other than π·IOC
     * scales the picture vertically too.
     */
    _decodeImageLine() {
        const spl = this.samplesPerLine, w = this.width, buf = this.line;
        const tmp = this.prev;
        this.prev = this.cur;
        this.cur = tmp;
        for (let i = 0; i < w; i++) {
            const first = Math.trunc((spl * i) / w);
            const last = Math.trunc((spl * (i + 1)) / w) - 1;
            let sum = 0, cnt = 0;
            for (let s = first; s <= last; s++) { sum += buf[s]; cnt++; }
            this.cur[i] = cnt ? Math.trunc(sum / cnt) : buf[Math.min(first, spl - 1)];
        }
        let out = null;
        if (this.lineIncrAcc >= 1) {
            this.lineIncrAcc -= 1;
            if (this.imageLine !== 0 && this.lineIncrAcc !== 0) {
                const next = this.lineIncrAcc / this.lineBlend;
                const prevW = 1 - next;
                out = new Uint8ClampedArray(w);
                for (let i = 0; i < w; i++) out[i] = Math.trunc(this.cur[i] * next + this.prev[i] * prevW);
                this.lineBlend = this.lineIncrFrac;
            } else {
                out = this.cur.slice();
            }
        } else {
            this.lineBlend += this.lineIncrFrac;
        }
        this.lineIncrAcc += this.lineIncrFrac;
        if (out) {
            this.events.push({ type: 'image', event: 'line', id: this.id, y: this.rows, pixels: out });
            this.rows++;
        }
    }
}

/** The whole decoder, audio to pictures: the front end into the raster. */
export class WefaxDecoder {
    constructor({ sampleRate, carrier = 1900, deviation = 400, bandwidth = 'middle', ...raster } = {}) {
        if (!(sampleRate > 0)) throw new Error('A sample rate is needed');
        this.front = new WefaxFrontEnd({ sampleRate, carrier, deviation, bandwidth });
        this.raster = new WefaxRaster({ ...raster, sampleRate: this.front.rate });
        this.levels = new Float64Array(0);
    }

    get mode() { return this.raster.mode; }

    process(x, n = x.length) {
        const max = this.front.maxOut(n);
        if (this.levels.length < max) this.levels = new Float64Array(max);
        const m = this.front.process(x, n, this.levels);
        this.raster.process(this.levels, m);
    }

    reset() {
        this.front.reset();
        this.raster.reset();
    }

    drain() { return this.raster.drain(); }

    status() { return this.raster.status(); }
}

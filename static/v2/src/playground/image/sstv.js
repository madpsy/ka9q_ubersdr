// SSTV: audio in, pictures out. A port of slowrx by Oona Räisänen OH2EIQ
// (https://github.com/windytan/slowrx, ISC licence) — its VIS detector
// (vis.c), its video demodulator (video.c: a short Hann window, a DFT, the
// peak bin refined by Gaussian interpolation, the window shortened or
// lengthened with the SNR), its sync detector and slant correction (sync.c: a
// Hough transform of the sync pulses picks the line rate and phase), and its
// mode table (modespec.c).
//
// slowrx works at 44100 Hz. Rather than resample, its constants are scaled:
// every window, hop and interval keeps its length in *time* (a 48-sample window
// is 1.09 ms at any rate), and the DFT bins keep slowrx's spacing in *hertz*
// (44100/1024 Hz for video, 44100/2048 for the header) — the bins are worked
// out one by one over just the band of interest, so neither the length nor a
// power-of-two FFT matters. The decoder then behaves the same at 8 kHz as at
// 48 kHz, and costs less the lower the rate.
//
// It is two stages, each a block of its own (blocks/sstvstages.js), and
// SstvDecoder is the two in a row: SstvDemodulator, audio to the frequency
// and the sync tone's strength for every sample, and SstvRaster, those to
// pictures. The demodulator reads before the header has said its shift, so it
// measures over a band wide enough for any likely one and the raster takes
// the shift off; the raster reads the header from the frequency too.
//
// slowrx decodes a whole picture, then corrects slant and redraws it. Here the
// picture is sent line by line as it arrives (at the nominal rate, from the
// VIS's timing), then, with `slant` on, the line rate and phase are found from
// the sync pulses and every line is sent again, redrawn from the stored
// luminance, before the 'end' event.
//
// Where this departs from slowrx, on purpose:
//  - Robot 72 has the real layout (Y 138 ms, R−Y and B−Y 69 ms each); slowrx
//    gives all three channels 92 ms, which is not the mode.
//  - Scottie 1/2/DX line times are the sum of their published parts (428.22,
//    277.692, 1050.3 ms); slowrx's Scottie 1 is 428.38, 374 ppm long. The
//    picture starts after Scottie's one leading sync pulse.
//  - The slant Hough transform runs over the sync pulses' falling edges at
//    the flags' full resolution, in (slope, intercept) rather than slowrx's
//    half-degree (angle, distance) grid, and a least-squares fit finishes
//    it: slowrx's grid cannot resolve under 86 ppm in the PD modes, and noise
//    tipped it into slanting straight pictures (see _findSync). The phase
//    comes from the same fit and wraps a full line (slowrx subtracts half a
//    line, throwing a picture that started late half a line off), with
//    Scottie's sync where it really is mid-line.
//  - Pixels are sampled at their centres in every mode (slowrx uses x−½ for
//    all but PD), and Robot 36's first row borrows neutral chroma.
//  - Height-2 modes (Martin 3/4, Robot 12/8 B/W) send each line twice, so the
//    picture has its proper aspect.
//  - The FSK ID after a picture (the sender's callsign, as MMSSTV and QSSTV
//    send it) is found by a detector of its own rather than slowrx's
//    (fsk.c): slowrx samples every half bit and takes alternate samples, so
//    a header straddling its grid can be missed; here every eighth of a bit
//    is tried, and the checksum MMSSTV sends after the 0x01 is checked,
//    which slowrx ignores (see SstvFskId).

// ── the modes (modespec.c) ──────────────────────────────────────────────────

// Times in seconds. `layout` says how a line's channels sit (video.c's switch);
// `colour` how they make RGB.
const SSTV_MODE_SPECS = [
    { name: 'Martin 1', short: 'M1', vis: 0x2c, sync: 4.862e-3, porch: 0.572e-3, septr: 0.572e-3, pixel: 0.4576e-3, line: 446.446e-3, width: 320, lines: 256, height: 1, colour: 'gbr', layout: 'rgb3' },
    { name: 'Martin 2', short: 'M2', vis: 0x28, sync: 4.862e-3, porch: 0.572e-3, septr: 0.572e-3, pixel: 0.2288e-3, line: 226.7986e-3, width: 320, lines: 256, height: 1, colour: 'gbr', layout: 'rgb3' },
    { name: 'Martin 3', short: 'M3', vis: 0x24, sync: 4.862e-3, porch: 0.572e-3, septr: 0.572e-3, pixel: 0.2288e-3, line: 446.446e-3, width: 320, lines: 128, height: 2, colour: 'gbr', layout: 'rgb3' },
    { name: 'Martin 4', short: 'M4', vis: 0x20, sync: 4.862e-3, porch: 0.572e-3, septr: 0.572e-3, pixel: 0.2288e-3, line: 226.7986e-3, width: 320, lines: 128, height: 2, colour: 'gbr', layout: 'rgb3' },
    { name: 'Scottie 1', short: 'S1', vis: 0x3c, sync: 9e-3, porch: 1.5e-3, septr: 1.5e-3, pixel: 0.4320e-3, line: 428.22e-3, width: 320, lines: 256, height: 1, colour: 'gbr', layout: 'scottie' },
    { name: 'Scottie 2', short: 'S2', vis: 0x38, sync: 9e-3, porch: 1.5e-3, septr: 1.5e-3, pixel: 0.2752e-3, line: 277.692e-3, width: 320, lines: 256, height: 1, colour: 'gbr', layout: 'scottie' },
    { name: 'Scottie DX', short: 'SDX', vis: 0x4c, sync: 9e-3, porch: 1.5e-3, septr: 1.5e-3, pixel: 1.08053e-3, line: 1050.3e-3, width: 320, lines: 256, height: 1, colour: 'gbr', layout: 'scottie' },
    { name: 'Robot 72', short: 'R72', vis: 0x0c, sync: 9e-3, porch: 3e-3, septr: 6e-3, pixel: 0.215625e-3, line: 300e-3, width: 320, lines: 240, height: 1, colour: 'yuv', layout: 'robot3' },
    { name: 'Robot 36', short: 'R36', vis: 0x08, sync: 9e-3, porch: 3e-3, septr: 6e-3, pixel: 0.1375e-3, line: 150e-3, width: 320, lines: 240, height: 1, colour: 'yuv', layout: 'robot2' },
    { name: 'Robot 24', short: 'R24', vis: 0x04, sync: 9e-3, porch: 3e-3, septr: 6e-3, pixel: 0.1375e-3, line: 150e-3, width: 320, lines: 240, height: 1, colour: 'yuv', layout: 'robot2' },
    { name: 'Robot 24 B/W', short: 'R24BW', vis: 0x0a, sync: 7e-3, porch: 0, septr: 0, pixel: 0.291e-3, line: 100e-3, width: 320, lines: 240, height: 1, colour: 'bw', layout: 'bw' },
    { name: 'Robot 12 B/W', short: 'R12BW', vis: 0x06, sync: 7e-3, porch: 0, septr: 0, pixel: 0.291e-3, line: 100e-3, width: 320, lines: 120, height: 2, colour: 'bw', layout: 'bw' },
    { name: 'Robot 8 B/W', short: 'R8BW', vis: 0x02, sync: 7e-3, porch: 0, septr: 0, pixel: 0.1871875e-3, line: 66.9e-3, width: 320, lines: 120, height: 2, colour: 'bw', layout: 'bw' },
    { name: 'Wraase SC-2 120', short: 'W2120', vis: 0x3f, sync: 5.5225e-3, porch: 0.5e-3, septr: 0, pixel: 0.489039081e-3, line: 475.530018e-3, width: 320, lines: 256, height: 1, colour: 'rgb', layout: 'rgb3' },
    { name: 'Wraase SC-2 180', short: 'W2180', vis: 0x37, sync: 5.5225e-3, porch: 0.5e-3, septr: 0, pixel: 0.734532e-3, line: 711.0225e-3, width: 320, lines: 256, height: 1, colour: 'rgb', layout: 'rgb3' },
    { name: 'PD 50', short: 'PD50', vis: 0x5d, sync: 20e-3, porch: 2.08e-3, septr: 0, pixel: 0.286e-3, line: 388.16e-3, width: 320, lines: 256, height: 1, colour: 'yuv', layout: 'pd' },
    { name: 'PD 90', short: 'PD90', vis: 0x63, sync: 20e-3, porch: 2.08e-3, septr: 0, pixel: 0.532e-3, line: 703.04e-3, width: 320, lines: 256, height: 1, colour: 'yuv', layout: 'pd' },
    { name: 'PD 120', short: 'PD120', vis: 0x5f, sync: 20e-3, porch: 2.08e-3, septr: 0, pixel: 0.19e-3, line: 508.48e-3, width: 640, lines: 496, height: 1, colour: 'yuv', layout: 'pd' },
    { name: 'PD 160', short: 'PD160', vis: 0x62, sync: 20e-3, porch: 2.08e-3, septr: 0, pixel: 0.382e-3, line: 804.416e-3, width: 512, lines: 400, height: 1, colour: 'yuv', layout: 'pd' },
    { name: 'PD 180', short: 'PD180', vis: 0x60, sync: 20e-3, porch: 2.08e-3, septr: 0, pixel: 0.286e-3, line: 754.24e-3, width: 640, lines: 496, height: 1, colour: 'yuv', layout: 'pd' },
    { name: 'PD 240', short: 'PD240', vis: 0x61, sync: 20e-3, porch: 2.08e-3, septr: 0, pixel: 0.382e-3, line: 1000e-3, width: 640, lines: 496, height: 1, colour: 'yuv', layout: 'pd' },
    { name: 'PD 290', short: 'PD290', vis: 0x5e, sync: 20e-3, porch: 2.08e-3, septr: 0, pixel: 0.286e-3, line: 937.28e-3, width: 800, lines: 616, height: 1, colour: 'yuv', layout: 'pd' },
    { name: 'Pasokon P3', short: 'P3', vis: 0x71, sync: 5.208e-3, porch: 1.042e-3, septr: 1.042e-3, pixel: 0.2083e-3, line: 409.375e-3, width: 640, lines: 496, height: 1, colour: 'rgb', layout: 'rgb3' },
    { name: 'Pasokon P5', short: 'P5', vis: 0x72, sync: 7.813e-3, porch: 1.563e-3, septr: 1.563e-3, pixel: 0.3125e-3, line: 614.065e-3, width: 640, lines: 496, height: 1, colour: 'rgb', layout: 'rgb3' },
    { name: 'Pasokon P7', short: 'P7', vis: 0x73, sync: 10.417e-3, porch: 2.083e-3, septr: 2.083e-3, pixel: 0.4167e-3, line: 818.747e-3, width: 640, lines: 496, height: 1, colour: 'rgb', layout: 'rgb3' },
];

/** The mode names, for a picker. */
export const SSTV_MODES = SSTV_MODE_SPECS.map((m) => m.name);

// Channel starts and lengths within a line, as video.c lays them out; and,
// for the phase search, where the sync pulse ends within a line.
for (const m of SSTV_MODE_SPECS) {
    const w = m.width * m.pixel;
    const first = m.sync + m.porch;
    if (m.layout === 'robot2') {
        m.chanLen = [2 * w, w, w];
        m.chanStart = [first, first + 2 * w + m.septr, first + 2 * w + m.septr];
    } else if (m.layout === 'robot3') {
        m.chanLen = [2 * w, w, w];
        m.chanStart = [first, first + 2 * w + m.septr, first + 3 * w + 2 * m.septr];
    } else if (m.layout === 'scottie') {
        m.chanLen = [w, w, w];
        m.chanStart = [m.septr, 2 * m.septr + w, 2 * m.septr + 2 * w + m.sync + m.porch];
    } else if (m.layout === 'pd') {
        m.chanLen = [w, w, w, w];
        m.chanStart = [first, first + w, first + 2 * w, first + 3 * w];
    } else if (m.layout === 'bw') {
        m.chanLen = [w];
        m.chanStart = [first];
    } else {
        m.chanLen = [w, w, w];
        m.chanStart = [first, first + w + m.septr, first + 2 * w + 2 * m.septr];
    }
    // A Scottie line's sync is in its middle, after green and blue.
    m.syncEnd = m.layout === 'scottie' ? 2 * m.septr + 2 * w + m.sync : m.sync;
    // PD sends two picture rows in each radio line.
    m.frames = m.layout === 'pd' ? m.lines / 2 : m.lines;
}

const SSTV_BY_VIS = new Map(SSTV_MODE_SPECS.map((m) => [m.vis, m]));

const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** A mode by its name or short name, loosely ('Martin 1', 'm1', 'PD-120'); null if none. */
export function sstvModeByName(name) {
    const k = squash(name);
    return SSTV_MODE_SPECS.find((m) => squash(m.name) === k || squash(m.short) === k) || null;
}

// ── constants slowrx has at 44100 Hz, here in time or in hertz ──────────────

const SLOWRX_FS = 44100;
const VIDEO_BIN_HZ = SLOWRX_FS / 1024;       // FFTLen 1024 in video.c
const HANN_LENS = [48, 64, 96, 128, 256, 512, 1024];
const SYNC_WIN = 64;                         // the sync detector's window
const SYNC_HOP = 13;                         // ... taken every 13 samples
const SNR_HOP = 256;
const FM_HOP = 6;

// slowrx's GetBin: the bin a frequency falls in, by truncation.
const videoBin = (f) => Math.floor(f / VIDEO_BIN_HZ);

const clip8 = (a) => (a < 0 ? 0 : a > 255 ? 255 : Math.round(a));

/**
 * Hann-windowed DFT powers over bins kLo..kHi of a fixed spacing, for a window
 * of `len` samples: the zero-padded FFT slowrx takes, but only the bins it
 * reads, so it is cheap and needs no power-of-two length.
 */
class SstvBinBank {
    constructor(fs, len, binHz, kLo, kHi) {
        this.len = len;
        this.kLo = kLo;
        this.n = kHi - kLo + 1;
        this.c = new Float64Array(this.n * len);
        this.s = new Float64Array(this.n * len);
        this.p = new Float64Array(this.n);
        for (let j = 0; j < this.n; j++) {
            const w = (2 * Math.PI * (kLo + j) * binHz) / fs;
            for (let i = 0; i < len; i++) {
                const h = len > 1 ? 0.5 * (1 - Math.cos((2 * Math.PI * i) / (len - 1))) : 1;
                this.c[j * len + i] = h * Math.cos(w * i);
                this.s[j * len + i] = h * Math.sin(w * i);
            }
        }
    }

    /** Powers of the window of `x` (length len), into this.p (index k − kLo). */
    run(x) {
        const { len, n, c, s, p } = this;
        for (let j = 0; j < n; j++) {
            let re = 0;
            let im = 0;
            const o = j * len;
            for (let i = 0; i < len; i++) { re += x[i] * c[o + i]; im += x[i] * s[o + i]; }
            p[j] = re * re + im * im;
        }
        return p;
    }

    at(k) { return this.p[k - this.kLo]; }
}

// Gaussian interpolation of a spectral peak (slowrx's, in vis.c and video.c):
// the offset from the peak bin, 0 where the logs are undefined.
function gaussPeak(pm, p0, pp) {
    if (!(pm > 0 && p0 > 0 && pp > 0)) return 0;
    const den = 2 * Math.log((p0 * p0) / (pp * pm));
    if (!(den !== 0) || !Number.isFinite(den)) return 0;
    const d = Math.log(pp / pm) / den;
    return Number.isFinite(d) ? d : 0;
}

// The VIS leader-and-bits pattern over the last 45 tones (10 ms apart), as
// vis.c reads it: `tone[0+j]` is the leader, start and stop bits 700 Hz under
// it, data bits 600 (0) or 800 (1) under. The first parity-good known code wins.
function matchVis(tone) {
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            const lead = tone[j];
            const near = (v, off, tol) => v > lead - off - tol && v < lead - off + tol;
            if (!(near(tone[3 + i], 0, 25) && near(tone[6 + i], 0, 25) && near(tone[9 + i], 0, 25)
                && near(tone[12 + i], 0, 25) && near(tone[15 + i], 700, 25) && near(tone[42 + i], 700, 25))) continue;
            const bits = [];
            for (let k = 0; k < 8; k++) {
                const v = tone[18 + i + 3 * k];
                if (near(v, 600, 25)) bits.push(0);
                else if (near(v, 800, 25)) bits.push(1);
                else break;
            }
            if (bits.length < 8) continue;
            let vis = 0;
            let parity = 0;
            for (let k = 0; k < 7; k++) { vis |= bits[k] << k; parity ^= bits[k]; }
            const m = SSTV_BY_VIS.get(vis);
            if (m && m.short === 'R12BW') parity ^= 1;   // its parity is odd
            if (!m || parity !== bits[7]) continue;
            return { vis, mode: m, shift: Math.trunc(lead - 1900), phase: i };
        }
    }
    return null;
}

// ── the FSK ID ──────────────────────────────────────────────────────────────

// MMSSTV's FSK ID (its fskid.txt; QSSTV's sendFSKID the same): after the
// picture, 45.45 baud FSK — 1900 Hz a 1, 2100 Hz a 0 — in 6-bit symbols, low
// bit first (as both programs' code sends them, whatever fskid.txt's table
// suggests). 300 ms of 1500 Hz, 100 ms of 2100 Hz and one 1900 Hz bit, then
// 0x2A, the callsign (each character minus 0x20), 0x01, and the XOR of the
// callsign's symbols. The 100 ms of 2100 Hz is four and a half bits, not
// five: read as a symbol ending on the 1900 Hz bit, the lead-in is 0x20 only
// in its top five bits — its lowest starts 10 ms into the 1500 Hz — so only
// those five are asked of it.
const FSK_BIT = 0.022;
const FSK_SUB = 8;                 // readings a bit
const FSK_LISTEN = 6;              // seconds after the picture to look
const FSK_SPAN = 300;              // Hz either side of the centre that count as the tones
const FSK_MAX_CALL = 16;           // characters MMSSTV takes in a callsign

/**
 * Looks for an FSK ID in the demodulator's frequency from `from` to `until`,
 * fed as it comes. Each eighth of a bit is a reading: the mean offset from
 * 2000 Hz (+ the header's shift), each sample's offset clamped to ±300 Hz so a
 * noise spike cannot outvote the rest — or no reading, where too few samples
 * are near the tones to be them. A bit is eight readings; at every reading
 * the eleven bits that end there are tried for the lead-in's 0 0 0 0 1 and
 * 0x2A, and the timing is put in the middle of the readings that match.
 */
class SstvFskId {
    constructor(fs, shift, from, until) {
        this.fs = fs;
        this.centre = 2000 + shift;
        this.pos = Math.max(0, from);
        this.until = until;
        this.subLen = (FSK_BIT * fs) / FSK_SUB;
        this.subAt = this.subLen;
        this.got = 0;
        this.acc = 0;
        this.near = 0;
        this.subs = [];            // offset in Hz from the centre, or NaN where the tones are not what is there
        this.scan = 0;             // the next reading to try the header at
        this.match = null;         // { from, to } readings where the header matched
        this.read = null;          // { next, symbols, end, restart } once a header is found
        this.done = false;
        this.callsign = null;
    }

    /**
     * The bit that ends at reading j: 1, 0, or -1 if not there to read. The
     * readings that are the tones vote; a few lost to noise do not lose the
     * bit, so long as at least half of them are there.
     */
    _bit(j) {
        if (j < FSK_SUB - 1 || j >= this.subs.length) return -1;
        let sum = 0;
        let got = 0;
        for (let k = j - FSK_SUB + 1; k <= j; k++) {
            const v = this.subs[k];
            if (v !== v) continue;
            sum += v;
            got++;
        }
        if (got * 2 < FSK_SUB) return -1;
        return sum < 0 ? 1 : 0;
    }

    /** The lead-in's 0 0 0 0 1, its four 2100 Hz bits and the 1900 Hz one, the first ending at reading j. */
    _leadIn(j) {
        for (let b = 0; b < 5; b++) if (this._bit(j + b * FSK_SUB) !== (b === 4 ? 1 : 0)) return false;
        return true;
    }

    _symbol(j) {
        let v = 0;
        for (let b = 0; b < 6; b++) {
            const bit = this._bit(j + b * FSK_SUB);
            if (bit < 0) return -1;
            v |= bit << b;
        }
        return v;
    }

    /** Works through the readings in hand: the header looked for at each, or the symbols after one found. */
    _advance() {
        const last = this.subs.length - 1;
        for (;;) {
            if (this.read) {
                // A symbol whose last bit ends at `next`.
                if (this.read.next > last) return;
                const sym = this._symbol(this.read.next - 5 * FSK_SUB);
                this.read.next += 6 * FSK_SUB;
                if (this._take(sym)) {
                    if (this.done) return;
                    // Not an ID after all: looking again from just after where that header matched.
                    this.scan = this.read.restart;
                    this.read = null;
                }
                continue;
            }
            if (this.scan > last) return;
            const j = this.scan++;
            // The header's eleven bits, ending at reading j: the lead-in's top
            // five (2100 Hz four times, the 1900 Hz bit), then 0x2A.
            const first = j - 10 * FSK_SUB;
            const ok = first >= 0 && this._leadIn(first) && this._symbol(first + 5 * FSK_SUB) === 0x2a;
            if (ok) {
                if (!this.match) this.match = { from: j, to: j };
                else this.match.to = j;
                if (this.match.to - this.match.from < FSK_SUB - 1) continue;
            }
            if (this.match) {
                // Matched over about a bit's worth of readings: its middle is
                // where each bit ends, give or take half a reading.
                const centre = Math.round((this.match.from + this.match.to) / 2);
                this.read = { next: centre + 6 * FSK_SUB, symbols: [], end: false, restart: j + 1 };
                this.match = null;
            }
        }
    }

    /** One symbol after the header. Returns true when reading stops, with `callsign` set if it was an ID. */
    _take(sym) {
        const r = this.read;
        if (sym < 0) return true;
        if (r.end) {
            let x = 0;
            for (const v of r.symbols) x ^= v;
            if (x !== sym || !r.symbols.length) return true;
            this.callsign = r.symbols.map((v) => String.fromCharCode(v + 0x20)).join('').trim();
            this.done = true;
            return true;
        }
        if (sym === 0x01) { r.end = true; return false; }
        // Anything else below 0x0d ends it (slowrx's rule), and a callsign is
        // as long as MMSSTV allows at most.
        if (sym < 0x0d || r.symbols.length >= FSK_MAX_CALL) return true;
        r.symbols.push(sym);
        return false;
    }

    /** The frequency in `hz` (a ring, `mask`) up to absolute position `count`. */
    feed(hz, mask, count) {
        const end = Math.min(count, this.until);
        while (this.pos < end && !this.done) {
            const d = hz[this.pos & mask] - this.centre;
            this.pos++;
            this.acc += d > FSK_SPAN ? FSK_SPAN : d < -FSK_SPAN ? -FSK_SPAN : d;
            if (d > -FSK_SPAN && d < FSK_SPAN) this.near++;
            this.got++;
            if (this.got >= this.subAt) {
                this.subs.push(this.near >= 0.75 * this.got ? this.acc / this.got : NaN);
                this.subAt += this.subLen - this.got;
                this.got = 0; this.acc = 0; this.near = 0;
                this._advance();
            }
        }
        if (this.pos >= this.until) this.done = true;
    }
}

// ── stage one: the demodulator ──────────────────────────────────────────────

// The band the demodulator reads the frequency over. It cannot know the
// header's shift before the header has been read — and the raster that reads
// the header is after it — so it reads wide enough for any likely one: the
// video's 1500–2300 Hz and the VIS's 1100–1300 Hz bits, ±250 Hz. The raster
// subtracts the shift it finds.
const DEMOD_LO_HZ = 850;
const DEMOD_HI_HZ = 2550;
// video.c's sync test: the sync tone there when its power per bin is more
// than twice the video band's.
const SYNC_RATIO = 2;
const SYNC_RATIO_MAX = 1000;

const pow2AtLeast = (n) => { let c = 1; while (c < n) c <<= 1; return c; };

/**
 * slowrx's video demodulator (video.c) as a stream: audio in; out, for every
 * sample, the frequency (Hz) and the sync tone's power ratio. The frequency is
 * taken every 6 samples' worth from a Hann window whose length follows the
 * SNR (48 samples' worth on a clean signal, 1024 on a weak one), the DFT's
 * peak refined by Gaussian interpolation, and held between; the ratio every
 * 13 samples' worth from a 64-sample window — the power around 1200 Hz over
 * the power per bin across the video band — held over the samples nearest
 * each. The windows are centred on the sample they describe, so the output
 * runs `delay` samples behind the input.
 */
export class SstvDemodulator {
    constructor({ sampleRate, adaptive = true } = {}) {
        const fs = sampleRate;
        this.fs = fs;
        this.adaptive = adaptive !== false;
        const scale = fs / SLOWRX_FS;
        // Lengths at this rate that are slowrx's in time.
        this.hannLens = HANN_LENS.map((l) => Math.max(4, Math.round(l * scale)));
        this.syncLen = Math.max(4, Math.round(SYNC_WIN * scale));
        this.syncStep = SYNC_HOP * scale;
        this.snrStep = SNR_HOP * scale;
        this.fmStep = FM_HOP * scale;
        this.delay = Math.ceil(this.hannLens[6] / 2) + 2;
        this.cap = pow2AtLeast(4 * this.hannLens[6] + 64);
        this.mask = this.cap - 1;
        this.buf = new Float64Array(this.cap);
        this.win = new Float64Array(this.hannLens[6] + 1);
        this.syncBank = new SstvBinBank(fs, this.syncLen, VIDEO_BIN_HZ, videoBin(1200) - 1, videoBin(2300));
        this.snrBank = new SstvBinBank(fs, this.hannLens[6], VIDEO_BIN_HZ, videoBin(400), videoBin(3400));
        this.fmBanks = this.hannLens.map((len) => new SstvBinBank(fs, len, VIDEO_BIN_HZ, videoBin(DEMOD_LO_HZ) - 1, videoBin(DEMOD_HI_HZ) + 1));
        this.reset();
    }

    reset() {
        this.buf.fill(0);
        this.count = 0;
        this.freq = 0;
        this.snr = 0;
        this.ratio = 0;
        this.syncK = 0; this.nextSync = 0;
        this.snrK = 0; this.nextSnr = 0;
        this.fmK = 0; this.nextFm = 0;
    }

    _window(start, len) {
        const w = this.win;
        const { buf, mask } = this;
        const oldest = this.count - this.cap;
        for (let i = 0; i < len; i++) {
            const p = start + i;
            w[i] = p >= 0 && p >= oldest && p < this.count ? buf[p & mask] : 0;
        }
        return w;
    }

    /** n samples of `x` in; n of frequency into `hz` and of sync ratio into `sync`. */
    process(x, n, hz, sync) {
        const D = this.delay;
        const b1500 = videoBin(1500);
        const b2300 = videoBin(2300);
        for (let i = 0; i < n; i++) {
            this.buf[(this.count++) & this.mask] = x[i];
            const p = this.count - 1 - D;
            if (p < 0) { hz[i] = 0; sync[i] = 0; continue; }

            if (p >= this.nextSync) {
                // The flag for the 13 samples' worth around its centre.
                const centre = Math.round(this.syncK * this.syncStep);
                const bank = this.syncBank;
                bank.run(this._window(centre - Math.floor(bank.len / 2), bank.len));
                const t = videoBin(1200);
                let praw = 0;
                for (let k = b1500; k <= b2300; k++) praw += bank.at(k);
                praw /= b2300 - b1500;
                const psync = (bank.at(t - 1) * 0.5 + bank.at(t) + bank.at(t + 1) * 0.5) / 2;
                this.ratio = praw > 0 ? Math.min(SYNC_RATIO_MAX, psync / praw) : (psync > 0 ? SYNC_RATIO_MAX : 0);
                this.syncK++;
                this.nextSync = Math.round((this.syncK - 0.5) * this.syncStep);
            }

            if (p >= this.nextSnr) {
                // video.c's SNR: the video band against the bands either side
                // of it, which carry only noise.
                const bank = this.snrBank;
                bank.run(this._window(p - (bank.len >> 1), bank.len));
                let pvn = 0;
                let pno = 0;
                for (let k = b1500; k <= b2300; k++) pvn += bank.at(k);
                for (let k = videoBin(400); k <= videoBin(800); k++) pno += bank.at(k);
                for (let k = videoBin(2700); k <= videoBin(3400); k++) pno += bank.at(k);
                const videoBins = b2300 - b1500 + 1;
                const noiseBins = videoBin(800) - videoBin(400) + 1 + videoBin(3400) - videoBin(2700) + 1;
                const rxBins = videoBin(3400) - videoBin(400);
                const pnoise = pno * (rxBins / noiseBins);
                const psignal = pvn - pno * (videoBins / noiseBins);
                this.snr = psignal / pnoise < 0.01 || !(pnoise > 0) ? -20 : 10 * Math.log10(psignal / pnoise);
                this.snrK++;
                this.nextSnr = Math.round(this.snrK * this.snrStep);
            }

            if (p >= this.nextFm) {
                // A shorter window for a cleaner signal: sharper pixels.
                const snr = this.snr;
                let wi;
                if (!this.adaptive || snr >= 20) wi = 0;
                else if (snr >= 10) wi = 1;
                else if (snr >= 9) wi = 2;
                else if (snr >= 3) wi = 3;
                else if (snr >= -5) wi = 4;
                else if (snr >= -10) wi = 5;
                else wi = 6;
                const bank = this.fmBanks[wi];
                const pw = bank.run(this._window(p - (bank.len >> 1), bank.len));
                const lo = bank.kLo;
                const hi = lo + bank.n - 1;
                let maxBin = lo;
                for (let k = lo; k <= hi; k++) if (pw[k - lo] > pw[maxBin - lo]) maxBin = k;
                if (maxBin > lo && maxBin < hi) {
                    this.freq = (maxBin + gaussPeak(pw[maxBin - 1 - lo], pw[maxBin - lo], pw[maxBin + 1 - lo])) * VIDEO_BIN_HZ;
                } else {
                    // At the band's edge: clipped to it, as video.c clips.
                    this.freq = maxBin === lo ? DEMOD_LO_HZ : DEMOD_HI_HZ;
                }
                this.fmK++;
                this.nextFm = Math.round(this.fmK * this.fmStep);
            }

            hz[i] = this.freq;
            sync[i] = this.ratio;
        }
    }
}

// ── stage two: the raster ───────────────────────────────────────────────────

/**
 * Pictures from the demodulator's two streams: the VIS header read from the
 * frequency, the picture laid out line by line from it, the slant corrected
 * from the sync ratio and the picture redrawn, and the FSK ID read after.
 * Events as SstvDecoder's (see image/README.md).
 */
export class SstvRaster {
    constructor({ sampleRate, mode = 'auto', slant = true } = {}) {
        const fs = sampleRate;
        this.fs = fs;
        this.forced = mode && mode !== 'auto' ? sstvModeByName(mode) : null;
        this.slant = slant !== false;
        this.syncStep = SYNC_HOP * (fs / SLOWRX_FS);
        this.visLen = Math.round(0.02 * fs);
        // Four seconds or more: enough to start a picture at a sync seen a
        // while back (a forced mode waits to see if a VIS follows).
        this.cap = pow2AtLeast(4 * fs);
        this.mask = this.cap - 1;
        this.hz = new Float64Array(this.cap);
        this.sy = new Float32Array(this.cap);
        this.sorted = new Float64Array(this.visLen);
        this.seq = 0;
        this.reset();
    }

    reset() {
        this.count = 0;              // samples taken in, ever
        this.events = [];
        this.rx = null;
        this.vis = null;
        this.fskId = null;
        this.lastCallsign = null;
        this._listenFrom(0);
    }

    drain() {
        const e = this.events;
        this.events = [];
        return e;
    }

    status() {
        const rx = this.rx;
        if (!rx) return { state: 'listening', mode: this.forced ? this.forced.name : null, detail: { line: 0, of: 0, vis: this.vis, callsign: this.lastCallsign } };
        return { state: 'receiving', mode: rx.m.name, detail: { line: rx.nextRow * rx.m.height, of: rx.m.lines * rx.m.height, vis: rx.vis, callsign: this.lastCallsign } };
    }

    /** n samples of the demodulator's frequency (`hz`) and sync ratio (`sync`). */
    process(hz, sync, n) {
        // In slices, so a long packet cannot overrun the ring before it is read.
        const slice = this.cap >> 3;
        for (let o = 0; o < n; o += slice) {
            const e = Math.min(n, o + slice);
            for (let i = o; i < e; i++) {
                const j = (this.count++) & this.mask;
                this.hz[j] = hz[i];
                this.sy[j] = sync[i];
            }
            this._run();
            this._fsk();
        }
    }

    // ── internals ───────────────────────────────────────────────────────────

    _fsk() {
        const f = this.fskId;
        if (!f) return;
        f.find.feed(this.hz, this.mask, this.count);
        if (!f.find.done) return;
        this.fskId = null;
        if (f.find.callsign) {
            this.lastCallsign = f.find.callsign;
            this.events.push({ type: 'text', text: `ID ${f.find.callsign}\n` });
            this.events.push({ type: 'image', event: 'info', id: f.id, callsign: f.find.callsign });
        }
    }

    _run() {
        for (;;) {
            if (this.rx) { if (!this._receive()) return; } else if (!this._listen()) return;
        }
    }

    _listenFrom(pos) {
        this.visBase = pos + Math.floor(this.visLen / 2);
        this.visK = 0;
        this.tones = new Float64Array(45);
        this.tonePtr = 0;
        // A forced mode also starts on a sync pulse.
        this.syncSearch = this.forced ? { k: 0, base: pos, run: 0, runStart: 0, pending: null } : null;
    }

    // vis.c's loop: every 10 ms, the frequency of the last 20 ms; a VIS when
    // the last 450 ms look like the end of a header. vis.c takes the peak of a
    // 20 ms spectrum; here the window's median frequency, from the
    // demodulator's short windows — as sharp on a tone, and a noise spike in
    // the window cannot move it. Returns true when a picture started, false
    // when it needs more input.
    _listen() {
        const L = this.visLen;
        const half = Math.floor(L / 2);
        const s = this.sorted;
        for (;;) {
            const c = this.visBase + Math.round((this.visK * this.fs) / 100);
            if (c - half + L > this.count) return false;
            if (this.syncSearch && this._searchSync(c)) return true;

            for (let i = 0; i < L; i++) {
                const p = c - half + i;
                s[i] = p >= 0 ? this.hz[p & this.mask] : 0;
            }
            s.sort();
            this.tones[this.tonePtr] = L & 1 ? s[L >> 1] : 0.5 * (s[(L >> 1) - 1] + s[L >> 1]);
            this.tonePtr = (this.tonePtr + 1) % 45;
            const tone = new Float64Array(45);
            for (let i = 0; i < 45; i++) tone[i] = this.tones[(this.tonePtr + i) % 45];
            const got = matchVis(tone);
            this.visK++;
            if (got) {
                const m = this.forced || got.mode;
                this.vis = got.vis;
                this.events.push({ type: 'text', text: `VIS ${got.vis} — ${got.mode.name}${this.forced && this.forced !== got.mode ? ` (decoding as ${m.name})` : ''}\n` });
                // The picture starts as the stop bit ends: 300 ms after the
                // start bit's leading edge, which the frequency stream places
                // to a sample or two where the 10 ms readings only bracket it
                // (slowrx skips 20 ms from its reading, which is within 5 ms
                // or so). Scottie then sends one sync pulse before its first line.
                let s0 = this._startEdge(c + Math.round(0.02 * this.fs) - Math.round(0.3 * this.fs)) + Math.round(0.3 * this.fs);
                if (m.layout === 'scottie') s0 += Math.round(m.sync * this.fs);
                this._begin(m, s0, got.shift, got.vis);
                return true;
            }
            const pend = this.syncSearch && this.syncSearch.pending;
            if (pend && c >= pend.deadline) {
                this.events.push({ type: 'text', text: `SYNC — ${this.forced.name}\n` });
                this._begin(this.forced, pend.s0, 0, null);
                return true;
            }
        }
    }

    // The VIS start bit's leading edge, within 20 ms of `near`: where the
    // frequency falls furthest from the 5 ms before to the 5 ms after.
    _startEdge(near) {
        const fs = this.fs;
        const K = Math.max(2, Math.round(0.005 * fs));
        const span = Math.round(0.02 * fs);
        const from = near - span - K;
        const len = 2 * span + 2 * K;
        if (from < Math.max(0, this.count - this.cap)) return near;
        const cum = new Float64Array(len + 1);
        for (let i = 0; i < len; i++) cum[i + 1] = cum[i] + this.hz[(from + i) & this.mask];
        let best = -Infinity;
        let at = near;
        for (let i = K; i + K <= len; i++) {
            const fall = (cum[i] - cum[i - K]) - (cum[i + K] - cum[i]);
            if (fall > best) { best = fall; at = from + i; }
        }
        return at;
    }

    // A forced mode's start without a VIS: a run of sync flags about as long
    // as the mode's sync pulse. It waits half a second before starting in
    // case the pulse was a VIS start bit and the VIS follows.
    _searchSync(upTo) {
        const ss = this.syncSearch;
        const m = this.forced;
        for (;;) {
            const pos = ss.base + Math.round(ss.k * this.syncStep);
            if (pos > upTo) return false;
            const on = this.sy[pos & this.mask] > SYNC_RATIO;
            if (on) {
                if (ss.run === 0) ss.runStart = pos;
                ss.run++;
            } else if (ss.run) {
                const dur = (pos - ss.runStart) / this.fs;
                ss.run = 0;
                if (!ss.pending && dur >= 0.6 * m.sync && dur <= 1.6 * m.sync + 0.002) {
                    let s0 = pos - Math.round(m.syncEnd * this.fs);
                    const oldest = this.count - this.cap + 1;
                    while (s0 < oldest) s0 += Math.round(m.line * this.fs);
                    ss.pending = { s0, deadline: pos + Math.round(0.5 * this.fs) };
                }
            }
            ss.k++;
        }
    }

    _begin(m, s0, shift, vis) {
        const fs = this.fs;
        const length = Math.floor(m.line * m.frames * fs);
        // A little past the nominal end, so the redraw has samples for a
        // picture that started late or ran slow.
        const total = length + Math.round(fs * (0.1 + 0.002 * m.line * m.frames));
        this.rx = {
            m, s0, shift, vis, length, total,
            lum: new Uint8Array(total),
            hasSync: new Uint8Array(Math.ceil(total / this.syncStep) + 2),
            sn: 0, syncK: 0, nextSync: 0, nextRow: 0, ready: -1,
            id: `${m.name}-${Date.now()}-${++this.seq}`,
        };
        this.rx.ready = this._rowReady(this.rx, 0, fs, 0);
        this.events.push({
            type: 'image', event: 'start', id: this.rx.id, mode: m.name,
            width: m.width, height: m.lines * m.height, colour: m.colour === 'bw' ? 'gray' : 'rgb',
        });
    }

    // video.c's main loop, a sample at a time: the sync flag every 13 samples'
    // worth, the luminance stored for every sample, and each row drawn once
    // its last pixel is in.
    _receive() {
        const rx = this.rx;
        const m = rx.m;
        const fs = this.fs;
        const black = 1500 + rx.shift;
        while (rx.sn < rx.total) {
            const pos = rx.s0 + rx.sn;
            if (pos >= this.count) return false;
            const j = pos & this.mask;
            if (rx.sn >= rx.nextSync) {
                rx.hasSync[rx.syncK] = this.sy[j] > SYNC_RATIO ? 1 : 0;
                rx.syncK++;
                rx.nextSync = Math.round(rx.syncK * this.syncStep);
            }
            rx.lum[rx.sn] = clip8((this.hz[j] - black) / 3.1372549);
            rx.sn++;
            while (rx.nextRow < m.lines && rx.ready < rx.sn) {
                this._emitRow(rx, rx.nextRow, fs, 0);
                rx.nextRow++;
                if (rx.nextRow < m.lines) rx.ready = this._rowReady(rx, rx.nextRow, fs, 0);
            }
        }
        this._finish();
        return true;
    }

    _finish() {
        const rx = this.rx;
        const m = rx.m;
        const fs = this.fs;
        while (rx.nextRow < m.lines) this._emitRow(rx, rx.nextRow++, fs, 0);
        let note = '';
        if (this.slant) {
            const { rate, skip } = this._findSync(rx);
            for (let y = 0; y < m.lines; y++) this._emitRow(rx, y, rate, skip);
            const ppm = (rate / fs - 1) * 1e6;
            note = ` — slant ${ppm >= 0 ? '+' : ''}${ppm.toFixed(0)} ppm, phase ${((skip / rate) * 1000).toFixed(1)} ms`;
            rx.rate = rate;
            rx.skip = skip;
        }
        this.events.push({ type: 'text', text: `END ${m.name}, ${m.width}×${m.lines * m.height}${note}\n` });
        this.events.push({ type: 'image', event: 'end', id: rx.id, complete: true });
        this.lastImage = { mode: m.name, rate: rx.rate ?? fs, skip: rx.skip ?? 0, s0: rx.s0 };
        this.rx = null;
        this._listenFrom(rx.s0 + rx.total);
        // The FSK ID, if the sender sends one: from a little before the
        // picture's nominal end, in case it ran fast.
        const from = rx.s0 + rx.length - Math.round(0.3 * fs);
        this.fskId = { find: new SstvFskId(fs, rx.shift, from, from + Math.round(FSK_LISTEN * fs)), id: rx.id, mode: m.name };
    }

    // The components a picture row is made of: [image channel, radio line,
    // channel start, channel length]. Robot 36/24 rows take their own line's
    // chroma and the line before's (video.c writes each chroma to two rows);
    // PD rows share their frame's chroma.
    _rowPlan(m, y) {
        const cs = m.chanStart;
        const cl = m.chanLen;
        switch (m.layout) {
            case 'bw': return [[0, y, cs[0], cl[0]]];
            case 'pd': {
                const f = y >> 1;
                return [[0, f, (y & 1) ? cs[3] : cs[0], cl[0]], [1, f, cs[1], cl[1]], [2, f, cs[2], cl[2]]];
            }
            case 'robot2': {
                const own = (y & 1) ? 2 : 1;
                const plan = [[0, y, cs[0], cl[0]], [own, y, cs[1], cl[1]]];
                if (y > 0) plan.push([3 - own, y - 1, cs[1], cl[1]]);
                return plan;
            }
            default: return [[0, y, cs[0], cl[0]], [1, y, cs[1], cl[1]], [2, y, cs[2], cl[2]]];
        }
    }

    // A pixel's sample, at its centre: video.c's PixelGrid time.
    static _pixelTime(m, line, start, len, x, rate, skip) {
        return Math.round(rate * (line * m.line + start + ((x + 0.5) / m.width) * len) + skip);
    }

    _rowReady(rx, y, rate, skip) {
        let t = -Infinity;
        for (const [, line, start, len] of this._rowPlan(rx.m, y)) {
            t = Math.max(t, SstvRaster._pixelTime(rx.m, line, start, len, rx.m.width - 1, rate, skip));
        }
        return t;
    }

    _emitRow(rx, y, rate, skip) {
        const m = rx.m;
        const W = m.width;
        const lum = rx.lum;
        const ch = [new Uint8Array(W), new Uint8Array(W).fill(128), new Uint8Array(W).fill(128)];
        for (const [c, line, start, len] of this._rowPlan(m, y)) {
            const out = ch[c];
            for (let x = 0; x < W; x++) {
                const t = SstvRaster._pixelTime(m, line, start, len, x, rate, skip);
                out[x] = t >= 0 && t < rx.sn ? lum[t] : 0;
            }
        }
        let pixels;
        if (m.colour === 'bw') {
            pixels = new Uint8ClampedArray(ch[0]);
        } else {
            pixels = new Uint8ClampedArray(3 * W);
            const [a, b, c] = ch;
            for (let x = 0; x < W; x++) {
                let r, g, bl;
                if (m.colour === 'gbr') { r = c[x]; g = a[x]; bl = b[x]; }
                else if (m.colour === 'rgb') { r = a[x]; g = b[x]; bl = c[x]; }
                else {
                    // video.c's YUV: Y, R−Y (V) and B−Y (U), full range.
                    r = clip8((100 * a[x] + 140 * b[x] - 17850) / 100);
                    g = clip8((100 * a[x] - 71 * b[x] - 33 * c[x] + 13260) / 100);
                    bl = clip8((100 * a[x] + 178 * c[x] - 22695) / 100);
                }
                pixels[3 * x] = r;
                pixels[3 * x + 1] = g;
                pixels[3 * x + 2] = bl;
            }
        }
        for (let k = 0; k < m.height; k++) {
            this.events.push({ type: 'image', event: 'line', id: rx.id, y: y * m.height + k, pixels: k ? pixels.slice() : pixels });
        }
    }

    // sync.c's FindSync, reworked. slowrx draws the sync flags as a picture a
    // line wide, finds the slanted line the pulses make with a Hough transform
    // over (angle, distance) in half-degree steps, corrects the rate by the
    // angle and repeats until upright, then finds the phase from the pulses'
    // summed falling edge in 700 columns. Its columns are a quarter of a sync
    // pulse wide, so the pulses are a band four columns thick: every angle
    // within a degree of upright fits it equally well, and half a degree is
    // 86 ppm in the PD modes — a tie that noise tips the wrong way, slanting a
    // straight picture. Here the same picture is drawn at the flags' own
    // resolution, only the falling edges are kept (a thin line, not a band),
    // and the Hough transform runs over (slope, intercept) — the slope being
    // the rate error directly, in steps that move the line's end by a column.
    // A least-squares fit to the edges near the winning line then gives the
    // rate and the phase together.
    _findSync(rx) {
        const m = rx.m;
        const fs = this.fs;
        const hs = rx.hasSync;
        const step = this.syncStep;
        const frames = m.frames;
        const lineSamples = m.line * fs;
        const lw = Math.floor(lineSamples / step);         // columns a line
        const K = Math.max(2, Math.min(8, Math.floor((0.6 * m.sync * fs) / step)));
        const flag = (i) => (i >= 0 && i < rx.syncK ? hs[i] : 0);

        // Falling edges: K columns of sync (one may miss), then K without.
        const ex = [];
        const ey = [];
        for (let y = 0; y < frames; y++) {
            const base = Math.round((y * lineSamples) / step);
            for (let x = 0; x < lw; x++) {
                const i = base + x;
                if (!(flag(i - 1) && !flag(i))) continue;
                let before = 0;
                let after = 0;
                for (let k = 1; k <= K; k++) before += flag(i - k);
                for (let k = 0; k < K; k++) after += flag(i + k);
                if (before >= K - 1 && after <= 1) { ex.push(x); ey.push(y); }
            }
        }
        const none = { rate: fs, skip: 0 };
        if (ex.length < Math.max(8, frames / 8)) return none;

        // Hough: slopes to ±5000 ppm, each step moving the last row by under a
        // column; intercepts in whole columns, scored over three neighbours.
        const maxSlope = (5000e-6 * lineSamples) / step;
        const dS = 1 / Math.max(1, frames);
        const hist = new Float64Array(lw);
        let best = -1;
        let bestS = 0;
        let bestX = 0;
        for (let sl = -maxSlope; sl <= maxSlope; sl += dS) {
            hist.fill(0);
            for (let e = 0; e < ex.length; e++) {
                let x0 = Math.round(ex[e] - sl * ey[e]) % lw;
                if (x0 < 0) x0 += lw;
                hist[x0]++;
            }
            for (let x = 0; x < lw; x++) {
                const v = hist[(x + lw - 1) % lw] + hist[x] + hist[(x + 1) % lw];
                if (v > best) { best = v; bestS = sl; bestX = x; }
            }
        }
        if (best < Math.max(8, frames / 8)) return none;

        // Least squares over the edges within two columns of that line, each
        // unwrapped to the side of the line it is nearest.
        let n = 0, sy = 0, sx = 0, syy = 0, sxy = 0;
        for (let e = 0; e < ex.length; e++) {
            const pred = bestX + bestS * ey[e];
            let x = ex[e];
            x += Math.round((pred - x) / lw) * lw;
            if (Math.abs(x - pred) > 2) continue;
            n++; sy += ey[e]; sx += x; syy += ey[e] * ey[e]; sxy += ey[e] * x;
        }
        let slope = bestS;
        let icept = bestX;
        const den = n * syy - sy * sy;
        if (n >= 2 && den > 0) {
            slope = (n * sxy - sy * sx) / den;
            icept = (sx - slope * sy) / n;
        }
        // A line of P samples moves the edge (P − nominal)/step columns a line.
        const period = lineSamples + slope * step;
        const rate = period / m.line;
        // The flags' edge sits on the true edge (the detector's window is
        // centred and its threshold symmetric: measured within 0.03 ms); the
        // line starts a sync pulse (or, in Scottie, more) before it.
        const edge = icept * step;
        let skip = edge - m.syncEnd * rate;
        skip -= Math.floor(skip / period + 0.5) * period;
        return { rate, skip };
    }
}

// ── the two together ────────────────────────────────────────────────────────

/** Audio in, pictures out: SstvDemodulator into SstvRaster. */
export class SstvDecoder {
    constructor({ sampleRate, mode = 'auto', slant = true, adaptive = true } = {}) {
        this.demod = new SstvDemodulator({ sampleRate, adaptive });
        this.raster = new SstvRaster({ sampleRate, mode, slant });
        this.hzBuf = new Float64Array(4096);
        this.syncBuf = new Float64Array(4096);
    }

    reset() { this.demod.reset(); this.raster.reset(); }

    drain() { return this.raster.drain(); }

    status() { return this.raster.status(); }

    get lastImage() { return this.raster.lastImage; }

    process(x, n = x.length) {
        const step = this.hzBuf.length;
        for (let o = 0; o < n; o += step) {
            const len = Math.min(step, n - o);
            this.demod.process(o ? x.subarray(o) : x, len, this.hzBuf, this.syncBuf);
            this.raster.process(this.hzBuf, this.syncBuf, len);
        }
    }
}

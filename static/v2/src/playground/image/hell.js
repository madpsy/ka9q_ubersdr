// Hellschreiber (Feld Hell): text sent as pictures of its letters, read by
// eye, not decoded.
//
// A Feld Hell character is a 7 × 14 grid sent a column at a time, bottom to
// top, at 122.5 baud — the carrier on for a black element, off for white —
// 245 half-elements a second, 17.5 columns. A receiver has only to draw the
// keyed tone's strength, a column at a time, and the letters appear; a
// mistiming slants them rather than garbles them, which is why Hell survives
// conditions that defeat decoders.
//
// So: the tone mixed to zero and low-passed to about its keying bandwidth, its
// magnitude against a slowly falling peak (so the picture follows fading),
// sampled 14 times a column. Columns build a strip `width` columns long; each
// strip is drawn twice, one copy above the other, as Hell machines printed it
// — so text slanting off one copy carries on in the other. A full strip
// starts the next row down, like tape on a page.
//
// Output is image events (README.md): one picture that grows a strip at a
// time, its rows re-sent every few columns as the strip fills.

const COLUMN_PX = 14;
const STRIP_H = COLUMN_PX * 2;

export const HELL_MODES = {
    feld: { label: 'Feld Hell', columnsPerSec: 17.5, bandwidthHz: 245 },
    slow: { label: 'Slow Hell', columnsPerSec: 17.5 / 4, bandwidthHz: 61.25 },
    x5: { label: 'Feld Hell ×5', columnsPerSec: 17.5 * 5, bandwidthHz: 1225 },
};

export class HellDecoder {
    constructor({ sampleRate, toneHz = 1000, mode = 'feld', width = 360, invert = false } = {}) {
        if (!(sampleRate > 0)) throw new Error('A sample rate is needed');
        this.fs = sampleRate;
        this.tone = toneHz;
        this.spec = HELL_MODES[mode] || HELL_MODES.feld;
        this.width = Math.max(40, width | 0);
        this.invert = invert;
        this.reset();
    }

    reset() {
        const w = (2 * Math.PI * this.tone) / this.fs;
        this.dc = Math.cos(-w);
        this.ds = Math.sin(-w);
        this.c = 1; this.s = 0; this.n = 0;
        // Two one-pole stages on I and Q at the keying bandwidth.
        this.alpha = 1 - Math.exp((-2 * Math.PI * this.spec.bandwidthHz) / this.fs);
        this.i1 = 0; this.q1 = 0; this.i2 = 0; this.q2 = 0;
        this.peak = 1e-9;
        this.peakFall = Math.exp(-1 / (this.fs * 2));
        // Samples per half-element, kept fractional so long runs keep their rate.
        this.per = this.fs / (this.spec.columnsPerSec * COLUMN_PX);
        this.acc = 0;
        this.got = 0;
        this.column = new Uint8ClampedArray(COLUMN_PX);
        this.cy = 0;
        this.col = 0;
        this.strip = 0;
        this.rows = Array.from({ length: STRIP_H }, () => new Uint8ClampedArray(this.width).fill(255));
        this.events = [];
        this.id = null;
        this.sinceSent = 0;
    }

    _start() {
        this.id = `hell-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        this.events.push({ type: 'image', event: 'start', id: this.id, mode: this.spec.label, width: this.width, height: null, colour: 'gray' });
    }

    _send() {
        for (let r = 0; r < STRIP_H; r++) {
            this.events.push({ type: 'image', event: 'line', id: this.id, y: this.strip * STRIP_H + r, pixels: this.rows[r].slice() });
        }
        this.sinceSent = 0;
    }

    _column() {
        if (!this.id) this._start();
        // The column bottom to top, into both copies of the strip.
        for (let k = 0; k < COLUMN_PX; k++) {
            const v = this.column[k];
            this.rows[COLUMN_PX - 1 - k][this.col] = v;
            this.rows[STRIP_H - 1 - k][this.col] = v;
        }
        this.col++;
        if (++this.sinceSent >= 6) this._send();
        if (this.col >= this.width) {
            this._send();
            this.strip++;
            this.col = 0;
            for (const r of this.rows) r.fill(255);
        }
    }

    process(x, n) {
        const a = this.alpha;
        for (let k = 0; k < n; k++) {
            const v = x[k];
            const mi = v * this.c;
            const mq = v * this.s;
            const cn = this.c * this.dc - this.s * this.ds;
            this.s = this.c * this.ds + this.s * this.dc;
            this.c = cn;
            if (++this.n % 1024 === 0) { const m = Math.hypot(this.c, this.s); this.c /= m; this.s /= m; }
            this.i1 += a * (mi - this.i1); this.q1 += a * (mq - this.q1);
            this.i2 += a * (this.i1 - this.i2); this.q2 += a * (this.q1 - this.q2);
            const mag = Math.hypot(this.i2, this.q2);
            this.peak = Math.max(mag, this.peak * this.peakFall);
            this.acc += mag;
            this.got++;
            if (this.got >= this.per) {
                this.got -= this.per;
                const level = Math.min(1, (this.acc / Math.max(1, Math.round(this.per))) / this.peak);
                this.acc = 0;
                // Carrier on is ink: black on white, unless inverted.
                const ink = this.invert ? level : 1 - level;
                this.column[this.cy++] = Math.round(255 * ink);
                if (this.cy >= COLUMN_PX) { this.cy = 0; this._column(); }
            }
        }
    }

    drain() {
        const e = this.events;
        this.events = [];
        return e;
    }

    status() {
        return { state: this.id ? 'receiving' : 'listening', mode: this.spec.label, detail: { strip: this.strip, column: this.col } };
    }
}

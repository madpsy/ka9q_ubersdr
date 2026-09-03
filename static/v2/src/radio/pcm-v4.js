// Lossless PCM, protocol version 4.
//
// Version 3 wrapped every packet in zstd, which does not compress this data at
// all: measured against a live receiver it came back at 0.99x on IQ and 0.90x
// on audio — larger than the samples it carried. zstd is an LZ77 matcher over
// bytes and a band-limited RF signal has no repeated byte strings, so it
// correctly gives up and pays a frame header for nothing.
//
// What the samples do have is correlation between neighbours, which a
// predictor turns into small residuals and a Rice code turns into fewer bits.
// Measured on the same receiver: USB 26.6 -> 12.2 kB/s, IQ 12k 50.7 -> 34.3,
// IQ 48k 199.6 -> 140.4, and a squelched session 2.90 -> 0.49.
//
// This file is the mirror of pcm_predictive.go and pcm_v4_header.go on the
// server. The two must agree bit for bit, so everything here is integer
// arithmetic in the same order as the Go — see the note on exactness below.
//
// NO BigInt IS NEEDED, AND THAT IS NOT AN ACCIDENT
// -----------------------------------------------
// The server clamps every filter tap to 2^24 and samples are 16-bit, so each
// product stays under 2^40 and an order-16 sum under 2^45. A float64 holds
// integers exactly to 2^53, so plain numbers are exact here rather than
// approximately right. The clamp exists on the server for int64 overflow
// headroom; it is what makes this port clean.
//
// The 64-bit GPS timestamp is the one field that would need BigInt. It is read
// and discarded: nothing in this interface uses it, and version 3's decoder
// does not expose it either.

// "PCM4" little-endian. Four bytes rather than two because Opus frames share
// the socket and begin with a timestamp, so the magic width is a false
// positive rate — two bytes would mistake one Opus frame in 65536, about one a
// minute at IQ packet rates.
const V4_MAGIC = 0x344d4350;

const FLAG_ESCAPE = 1 << 7;
const FLAG_QUALITY = 1 << 6;
const FLAG_METADATA = 1 << 5;
const FLAG_SILENT = 1 << 4;
const FLAG_COUNT = 1 << 3;
const PROFILE_MASK = 0x07;

const TAP_SHIFT = 65536; // Q16
const TAP_LIMIT = 1 << 24;
const QUALITY_NO_READING = -32768;

// Predictor profiles. The packet declares which one it was coded with, so this
// interface never infers it from the mode or the channel count — the server
// decides and can be retuned without touching a deployed client.
//
// The two differ because the signals do. IQ is complex baseband, where a
// carrier is a single complex pole that one complex tap cancels; treating I and
// Q as separate real streams measured 1.29x against 1.89x. Demodulated audio is
// mono, so the same filter with the imaginary terms dropped — and it wants a
// deep cascade of short filters, because a 12 kHz channel carrying a 2.65 kHz
// passband is about 4x oversampled and has structure at several scales.
//
// Profile 2 is profile 0 with a reduced-depth front end: the body opens with a
// shift byte, and the samples were requantised by it before the predictor saw
// them. The predictor is identical because the scaling happens outside it, so
// `scaled` only says that the extra byte is there and that the output must be
// shifted back. A server sends it only to a client that asked for it with
// `min_margin`; anything else still gets profile 0.
const PROFILES = {
    0: { name: 'iq-complex-o16', complex: true, orders: [16], mus: [16] },
    1: { name: 'audio-real-8/8/4/2', complex: false, orders: [8, 8, 4, 2], mus: [16, 16, 32, 32] },
    2: { name: 'iq-complex-o16-scaled', complex: true, orders: [16], mus: [16], scaled: true },
};

// Round-to-nearest shift by 16, away from zero on ties. A plain >> rounds
// negatives towards negative infinity and would diverge from the server.
function rshift16(v) {
    return v >= 0
        ? Math.floor((v + 32768) / TAP_SHIFT)
        : -Math.floor((-v + 32768) / TAP_SHIFT);
}

function sgn(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }

// One adaptive filter. Complex and real are the same algorithm; the real form
// is the complex one with the imaginary terms removed, so both live here rather
// than in two near-identical classes.
class Stage {
    constructor(order, mu, complex) {
        this.order = order;
        this.mu = mu;
        this.complex = complex;
        this.wr = new Float64Array(order);
        this.hr = new Float64Array(order * 2);
        this.sr = new Float64Array(order * 2);
        if (complex) {
            this.wi = new Float64Array(order);
            this.hi = new Float64Array(order * 2);
            this.si = new Float64Array(order * 2);
        }
        this.idx = order;
    }

    // Reconstruct one sample from its residual, then adapt and record it. The
    // encoder performs the identical prediction and adaptation on its side,
    // which is what keeps the two in step with nothing transmitted.
    stepReal(e) {
        const { wr, hr, sr, order } = this;
        const base = this.idx - 1;
        let p = 0;
        for (let j = 0; j < order; j++) p += wr[j] * hr[base - j];
        const x = e + rshift16(p);
        const m = this.mu * sgn(e);
        for (let j = 0; j < order; j++) {
            let a = wr[j] + m * sr[base - j];
            wr[j] = a > TAP_LIMIT ? TAP_LIMIT : a < -TAP_LIMIT ? -TAP_LIMIT : a;
        }
        this._push1(x);
        return x;
    }

    stepComplex(er, ei, out) {
        const { wr, wi, hr, hi, sr, si, order } = this;
        const base = this.idx - 1;
        let pr = 0, pi = 0;
        for (let j = 0; j < order; j++) {
            const br = hr[base - j], bi = hi[base - j];
            pr += wr[j] * br - wi[j] * bi;
            pi += wr[j] * bi + wi[j] * br;
        }
        const xr = er + rshift16(pr);
        const xi = ei + rshift16(pi);
        const mr = this.mu * sgn(er), mi = this.mu * sgn(ei);
        for (let j = 0; j < order; j++) {
            const hrs = sr[base - j];
            const his = -si[base - j]; // conjugate
            let a = wr[j] + mr * hrs - mi * his;
            let b = wi[j] + mr * his + mi * hrs;
            wr[j] = a > TAP_LIMIT ? TAP_LIMIT : a < -TAP_LIMIT ? -TAP_LIMIT : a;
            wi[j] = b > TAP_LIMIT ? TAP_LIMIT : b < -TAP_LIMIT ? -TAP_LIMIT : b;
        }
        this._push2(xr, xi);
        out[0] = xr;
        out[1] = xi;
    }

    // The encoder direction, used where the samples are already known: the
    // verbatim escape and the silent mode both send no residuals but still
    // require both sides to advance their filters over the samples.
    advanceReal(x) {
        const { wr, hr, sr, order } = this;
        const base = this.idx - 1;
        let p = 0;
        for (let j = 0; j < order; j++) p += wr[j] * hr[base - j];
        const e = x - rshift16(p);
        const m = this.mu * sgn(e);
        for (let j = 0; j < order; j++) {
            let a = wr[j] + m * sr[base - j];
            wr[j] = a > TAP_LIMIT ? TAP_LIMIT : a < -TAP_LIMIT ? -TAP_LIMIT : a;
        }
        this._push1(x);
        return e;
    }

    advanceComplex(xr, xi, out) {
        const { wr, wi, hr, hi, sr, si, order } = this;
        const base = this.idx - 1;
        let pr = 0, pi = 0;
        for (let j = 0; j < order; j++) {
            const br = hr[base - j], bi = hi[base - j];
            pr += wr[j] * br - wi[j] * bi;
            pi += wr[j] * bi + wi[j] * br;
        }
        const er = xr - rshift16(pr);
        const ei = xi - rshift16(pi);
        const mr = this.mu * sgn(er), mi = this.mu * sgn(ei);
        for (let j = 0; j < order; j++) {
            const hrs = sr[base - j];
            const his = -si[base - j];
            let a = wr[j] + mr * hrs - mi * his;
            let b = wi[j] + mr * his + mi * hrs;
            wr[j] = a > TAP_LIMIT ? TAP_LIMIT : a < -TAP_LIMIT ? -TAP_LIMIT : a;
            wi[j] = b > TAP_LIMIT ? TAP_LIMIT : b < -TAP_LIMIT ? -TAP_LIMIT : b;
        }
        this._push2(xr, xi);
        out[0] = er;
        out[1] = ei;
    }

    // History is linear with a periodic slide rather than circular, so the tap
    // loops walk contiguous memory with no index wrapping — this runs per
    // sample, 1098 packets a second on the widest IQ streams.
    _push1(x) {
        this.hr[this.idx] = x;
        this.sr[this.idx] = sgn(x);
        if (++this.idx === this.hr.length) {
            const n = this.order;
            this.hr.copyWithin(0, n, n * 2);
            this.sr.copyWithin(0, n, n * 2);
            this.idx = n;
        }
    }

    _push2(xr, xi) {
        this.hr[this.idx] = xr;
        this.hi[this.idx] = xi;
        this.sr[this.idx] = sgn(xr);
        this.si[this.idx] = sgn(xi);
        if (++this.idx === this.hr.length) {
            const n = this.order;
            this.hr.copyWithin(0, n, n * 2);
            this.hi.copyWithin(0, n, n * 2);
            this.sr.copyWithin(0, n, n * 2);
            this.si.copyWithin(0, n, n * 2);
            this.idx = n;
        }
    }
}

// Trailing-zero count per byte, for the Rice unary runs.
const CTZ = new Uint8Array(256);
for (let i = 1; i < 256; i++) {
    let n = 0, v = i;
    while ((v & 1) === 0) { v >>= 1; n++; }
    CTZ[i] = n;
}

// Reads the Rice bitstream: per value, a run of 1 bits, a 0 stop bit, then k
// raw low bits, zigzagged.
function riceDecode(body, count, out) {
    const k = body[0];
    if (k > 30) return false;
    let bytePos = 1, acc = 0, nbits = 0;
    const len = body.length;
    const kMul = Math.pow(2, k);

    for (let i = 0; i < count; i++) {
        let q = 0;
        for (;;) {
            if (nbits === 0) {
                if (bytePos >= len) return false;
                acc = body[bytePos++];
                nbits = 8;
            }
            const inv = ~acc & 0xff;
            const t = inv === 0 ? nbits : Math.min(CTZ[inv], nbits);
            q += t;
            if (t < nbits) {
                acc >>= t + 1;
                nbits -= t + 1;
                break;
            }
            acc = 0;
            nbits = 0;
        }
        let rem = 0, need = k, shift = 0;
        while (need > 0) {
            if (nbits === 0) {
                if (bytePos >= len) return false;
                acc = body[bytePos++];
                nbits = 8;
            }
            const take = need < nbits ? need : nbits;
            rem += (acc & ((1 << take) - 1)) * (1 << shift);
            acc >>= take;
            nbits -= take;
            shift += take;
            need -= take;
        }
        const u = q * kMul + rem;
        out[i] = (u % 2 === 1) ? -(u + 1) / 2 : u / 2;
    }
    return true;
}

// Version 4 Opus header.
//
// Opus carries the same timestamp, metadata and signal quality as the lossless
// path, tracked the same way and encoded identically -- the readings come from
// the same place on the server, so decoding them two different ways would only
// be two places to get the "no reading" sentinel wrong. What it does not carry
// is everything specific to the predictive codec: no sample count, since an
// Opus body's length is implicit, and no escape, silent or profile bits.
//
// It carries no magic either, and that is safe rather than convenient. Frames
// are sorted by elimination -- a v4 PCM magic, else a zstd magic, else Opus --
// so the only hazard is an Opus header being read as PCM. It cannot be: the
// PCM magic's first byte is 0x50, which has bit 4 set, while an Opus header
// begins with a flags byte using only bits 0 and 1 and so never exceeds 0x03.
//
// Version 3 sent a fixed 21 bytes here. This averages about 4, which on frames
// this small is between an eighth and a fifth of the whole stream.
const OPUS_FLAG_QUALITY = 1 << 0;
const OPUS_FLAG_METADATA = 1 << 1;

export class OpusV4HeaderDecoder {
    constructor() { this.reset(); }

    reset() {
        this.haveMetadata = false;
        this.sampleRate = 0;
        this.channels = 1;
        this.power = QUALITY_NO_READING;
        this.noise = QUALITY_NO_READING;
    }

    // Returns { bodyOffset, sampleRate, channels, signal } or null for a frame
    // that cannot be read -- including one that arrives before any
    // resynchronisation point, which is what a mid-stream join looks like.
    decode(buffer) {
        const u8 = new Uint8Array(buffer);
        const view = new DataView(buffer);
        if (u8.length < 2) return null;
        const flags = u8[0];
        if (flags & ~(OPUS_FLAG_QUALITY | OPUS_FLAG_METADATA)) return null;
        let off = 1;

        // The metadata bit marks a resynchronisation, which is also what
        // carries a full timestamp; the two never differ.
        if (flags & OPUS_FLAG_METADATA) {
            if (off + 8 > u8.length) return null;
            off += 8; // the timestamp is not used by this interface
        } else {
            if (!this.haveMetadata) return null;
            const n = varintLen(u8, off);
            if (n < 0) return null;
            off += n;
        }

        if (flags & OPUS_FLAG_METADATA) {
            const r = uvarint(u8, off);
            if (!r) return null;
            this.sampleRate = r[0];
            off = r[1];
            if (off >= u8.length) return null;
            this.channels = u8[off++] || 1;
            this.haveMetadata = true;
        } else if (!this.haveMetadata) {
            return null;
        }

        if (flags & OPUS_FLAG_QUALITY) {
            if (off + 4 > u8.length) return null;
            this.power = view.getInt16(off, true);
            this.noise = view.getInt16(off + 2, true);
            off += 4;
        }
        if (!this.sampleRate) return null;

        return {
            bodyOffset: off,
            sampleRate: this.sampleRate,
            channels: this.channels,
            signal: {
                basebandPower: quality(this.power),
                noisePower: quality(this.noise),
            },
        };
    }
}

// Whether a binary frame is a version 4 PCM packet rather than an Opus frame.
// Both arrive on the same socket, because the server picks the format per
// packet and forces PCM in IQ modes whatever was negotiated.
export function isV4Frame(buffer) {
    if (buffer.byteLength < 5) return false;
    return new DataView(buffer).getUint32(0, true) === V4_MAGIC;
}

// Decoder for one connection.
//
// STATEFUL, and that is the whole design: the predictor's taps carry the
// adaptation of every sample decoded so far, and the header carries only what
// changed since the last packet. So this must be constructed per WebSocket and
// reset() on reconnect — exactly the lifecycle PCMStreamDecoder already has.
export class PCMv4StreamDecoder {
    constructor() { this.reset(); }

    reset() {
        this.stages = null;
        this.profileId = -1;
        this.complex = false;
        this.sampleRate = 0;
        this.channels = 1;
        this.sampleCount = 0;
        this.power = QUALITY_NO_READING;
        this.noise = QUALITY_NO_READING;
        this.haveMetadata = false;
        this.residuals = null;
        this.pair = new Float64Array(2);
    }

    _useProfile(id) {
        if (this.profileId === id && this.stages) return true;
        const p = PROFILES[id];
        // An unimplemented profile is refused rather than guessed at: decoding
        // with the wrong predictor returns plausible noise instead of failing,
        // which is the worst outcome for a codec whose promise is exactness.
        if (!p) return false;
        this.stages = p.orders.map((o, i) => new Stage(o, p.mus[i], p.complex));
        this.complex = p.complex;
        this.scaled = !!p.scaled;
        this.profileId = id;
        return true;
    }

    // Returns { planes, sampleRate, channels, signal } like PCMStreamDecoder,
    // or null for a frame that cannot be read.
    decode(buffer) {
        const u8 = new Uint8Array(buffer);
        const view = new DataView(buffer);
        if (u8.length < 5 || view.getUint32(0, true) !== V4_MAGIC) return null;

        const flags = u8[4];
        let off = 5;
        const escape = (flags & FLAG_ESCAPE) !== 0;
        const silent = (flags & FLAG_SILENT) !== 0;
        if (escape && silent) return null;
        if (!this._useProfile(flags & PROFILE_MASK)) return null;

        // The timestamp is read only to step over it. A resynchronisation
        // carries the full 64 bits; every other packet carries a delta.
        if (flags & FLAG_METADATA) {
            if (off + 8 > u8.length) return null;
            off += 8;
        } else {
            if (!this.haveMetadata) return null; // joined mid-stream, wait for a resync
            const n = varintLen(u8, off);
            if (n < 0) return null;
            off += n;
        }

        if (flags & FLAG_COUNT) {
            const r = uvarint(u8, off);
            if (!r) return null;
            this.sampleCount = r[0];
            off = r[1];
        }
        if (flags & FLAG_METADATA) {
            const r = uvarint(u8, off);
            if (!r) return null;
            this.sampleRate = r[0];
            off = r[1];
            if (off >= u8.length) return null;
            this.channels = u8[off++] || 1;
            this.haveMetadata = true;
        } else if (!this.haveMetadata) {
            return null;
        }
        if (flags & FLAG_QUALITY) {
            if (off + 4 > u8.length) return null;
            this.power = view.getInt16(off, true);
            this.noise = view.getInt16(off + 2, true);
            off += 4;
        }
        if (!this.sampleRate || this.sampleCount <= 0) return null;

        // The shift leads the body on a scaled profile. It is not in the header
        // because the flags byte is full, and because a silent packet has no
        // body and needs no shift.
        let shift = 0;
        if (this.scaled && !silent) {
            if (off >= u8.length) return null;
            shift = u8[off];
            if (shift > 15) return null;
            off += 1;
        }

        const count = this.sampleCount;
        const channels = this.channels;
        const step = this.complex ? 2 : 1;
        if (count % step !== 0) return null;

        const frames = Math.floor(count / channels);
        const planes = [];
        for (let c = 0; c < channels; c++) planes.push(new Float32Array(frames));

        if (silent) {
            // No body was sent. The samples are zero, but the predictor still
            // has to run over them: the server advanced its filters across this
            // packet, and everything after it decodes wrongly if we do not.
            if (off !== u8.length) return null;
            this._advanceZeros(count);
            // planes are already zero-filled
        } else if (escape) {
            if (off + count * 2 > u8.length) return null;
            // The scale is undone on the way out only: the predictor ran on the
            // quantised values, exactly as the encoder's did, and shifting
            // before it would put the two out of step.
            const g = 1 / 32768 * (1 << shift);
            for (let i = 0; i < count; i += step) {
                const a = view.getInt16(off + 2 * i, true);
                if (step === 2) {
                    const b = view.getInt16(off + 2 * i + 2, true);
                    this._advance2(a, b);
                    planes[0][i / 2] = a * g;
                    if (channels > 1) planes[1][i / 2] = b * g;
                } else {
                    this._advance1(a);
                    planes[0][i] = a * g;
                }
            }
        } else {
            const body = u8.subarray(off);
            if (body.length < 1) return null;
            if (!this.residuals || this.residuals.length < count) {
                this.residuals = new Float64Array(count);
            }
            if (!riceDecode(body, count, this.residuals)) return null;
            const res = this.residuals;
            // As on the escape path, the scale is folded into the output gain
            // rather than applied before the predictor.
            const g = 1 / 32768 * (1 << shift);
            if (step === 2) {
                for (let i = 0; i < count; i += 2) {
                    const [xr, xi] = this._step2(res[i], res[i + 1]);
                    planes[0][i / 2] = xr * g;
                    if (channels > 1) planes[1][i / 2] = xi * g;
                }
            } else {
                for (let i = 0; i < count; i++) {
                    const x = this._step1(res[i]);
                    planes[0][i] = x * g;
                }
            }
        }

        return {
            planes,
            sampleRate: this.sampleRate,
            channels,
            signal: {
                basebandPower: quality(this.power),
                noisePower: quality(this.noise),
            },
        };
    }

    // Stages are undone in reverse: the last to have predicted is the first to
    // be reversed.
    _step1(e) {
        const st = this.stages;
        let v = e;
        for (let i = st.length - 1; i >= 0; i--) v = st[i].stepReal(v);
        return v;
    }

    _step2(er, ei) {
        const st = this.stages;
        let a = er, b = ei;
        const pair = this.pair;
        for (let i = st.length - 1; i >= 0; i--) {
            st[i].stepComplex(a, b, pair);
            a = pair[0];
            b = pair[1];
        }
        return [a, b];
    }

    // Forward direction, for packets whose samples arrive without residuals.
    _advance1(x) {
        const st = this.stages;
        let v = x;
        for (let i = 0; i < st.length; i++) v = st[i].advanceReal(v);
    }

    _advance2(xr, xi) {
        const st = this.stages;
        let a = xr, b = xi;
        const pair = this.pair;
        for (let i = 0; i < st.length; i++) {
            st[i].advanceComplex(a, b, pair);
            a = pair[0];
            b = pair[1];
        }
    }

    _advanceZeros(count) {
        if (this.complex) {
            for (let i = 0; i < count; i += 2) this._advance2(0, 0);
        } else {
            for (let i = 0; i < count; i++) this._advance1(0);
        }
    }
}

// Signal quality is signed centidecibels, with one codepoint reserved for
// "radiod reported nothing" — the -999 sentinel cannot be represented, since
// -99900 overflows an int16. 0.01 dB is twenty times finer than this interface
// displays.
function quality(v) {
    if (v === QUALITY_NO_READING) return null;
    return v / 100;
}

function uvarint(u8, off) {
    let x = 0, s = 0;
    for (let i = off; i < u8.length && i < off + 10; i++) {
        const b = u8[i];
        if (b < 0x80) return [x + b * Math.pow(2, s), i + 1];
        x += (b & 0x7f) * Math.pow(2, s);
        s += 7;
    }
    return null;
}

// Length of the varint at off, without decoding it — used to step over the
// timestamp delta, which this interface does not need.
function varintLen(u8, off) {
    for (let i = off; i < u8.length && i < off + 10; i++) {
        if (u8[i] < 0x80) return i - off + 1;
    }
    return -1;
}

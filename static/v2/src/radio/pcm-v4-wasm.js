// Lossless PCM, protocol version 4 -- the WebAssembly decoder.
//
// A drop-in for PCMv4StreamDecoder in pcm-v4.js: the same decode(buffer) and
// reset(), the same return shape, and the same output bit for bit -- identical
// Float32 planes and the same null for every packet the JavaScript refuses.
// It exists because that decoder is the browser's cost on wide IQ. Measured on
// a Ryzen 7 5700U under node 20 with a fully warmed JIT, per IQ frame:
// JavaScript ~220 ns, this ~50 ns with WebAssembly SIMD and ~130 ns without;
// at iq384 that is 8.4% of a core against 2%, on the thread that draws the
// spectrum. Audio halves, ~220 ns to ~110. See static/v2/native/pcmv4/ for
// the C, the build, the tests and the measurements, and README.md there.
//
// Used by audio-connection.js for IQ (profiles 0 and 2); demodulated audio
// stays on pcm-v4.js. Where a stream may change hands between the two is in
// that file, at _v4DecoderFor, and in the README.
//
// WHAT RUNS WHERE
// ---------------
// The header is parsed here, by a copy of pcm-v4.js's own logic, line for
// line, because it is cheap and because its state -- rate, channels, signal
// quality, the capture clock -- is exactly what a caller reads back. The body
// goes to the module: the Rice bitstream, the predictor, and the conversion to
// deinterleaved Float32 at the JavaScript decoder's scale. All this file then
// does with a packet is copy the body in and the planes out.
//
// The order of every check, and every piece of state a refused packet still
// changes, follows pcm-v4.js exactly -- including that a packet naming a new
// profile resets the predictor even when it is then refused, and that the
// output planes are allocated (Float32Array(count / channels) each) before the
// body is looked at. That last one is not cosmetic: a header claiming an
// absurd sample count makes the JavaScript decoder throw a RangeError from the
// allocation, and so does this one, at the same point.
//
// Why exactness extends to corrupt streams, and the one place it cannot (the
// bit pattern of a NaN), is in static/v2/native/pcmv4/pcmv4.h.
//
// LOADING
// -------
// Compiling is asynchronous -- Chrome refuses a synchronous compile of anything
// over 4 kB on the main thread -- so a decoder comes from a promise:
//
//   const dec = await PCMv4WasmStreamDecoder.create();
//   dec.backend      // 'wasm-simd' or 'wasm-scalar'
//
// or, to share one load across many decoders, loadPCMv4Wasm() once and
// `new PCMv4WasmStreamDecoder(runtime)` per connection. The SIMD build is
// chosen when WebAssembly.validate accepts a SIMD instruction (Chrome 91,
// Firefox 89, Safari 16.4 and later); otherwise the scalar build, which runs
// anywhere WebAssembly does. pcmV4WasmStatus() says what loaded, or why
// nothing did, for a Stats panel or a fallback decision.
//
// A page served with a Content-Security-Policy needs 'wasm-unsafe-eval' in
// script-src to compile any WebAssembly; without it the load rejects and the
// caller should keep the JavaScript decoder.

import {
    PCMV4_WASM_ABI,
    PCMV4_WASM_SIMD,
    PCMV4_WASM_SCALAR,
} from './pcm-v4-wasm.generated.js';

const V4_MAGIC = 0x344d4350;

const FLAG_ESCAPE = 1 << 7;
const FLAG_QUALITY = 1 << 6;
const FLAG_METADATA = 1 << 5;
const FLAG_SILENT = 1 << 4;
const FLAG_COUNT = 1 << 3;
const PROFILE_MASK = 0x07;

const QUALITY_NO_READING = -32768;

// What the module needs to know about a profile; the predictor itself is in
// the C. Must list exactly the profiles pcm-v4.js's PROFILES does, so that an
// unknown one is refused by both.
const PROFILES = {
    0: { complex: true, scaled: false },
    1: { complex: false, scaled: false },
    2: { complex: true, scaled: true },
};

// The module's return codes that are not a refused packet.
const ERR_NOMEM = -6;

const BODY_RICE = 0;
const BODY_ESCAPE = 1;

// The largest sample count passed to the module in one call; it takes an i32.
const MAX_CALL = 0x40000000;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

// The smallest module that uses a SIMD instruction (i8x16.splat then
// i8x16.popcnt, which only the final SIMD proposal has): if it validates, the
// engine has WebAssembly SIMD as shipped.
const SIMD_PROBE = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0,
    65, 0, 253, 15, 253, 98, 11,
]);

export function pcmV4WasmAvailable() {
    return typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';
}

export function pcmV4WasmSimdSupported() {
    try {
        return pcmV4WasmAvailable() && WebAssembly.validate(SIMD_PROBE);
    } catch {
        return false;
    }
}

function base64Bytes(s) {
    if (typeof atob === 'function') {
        const bin = atob(s);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    // eslint-disable-next-line no-undef
    return new Uint8Array(Buffer.from(s, 'base64'));
}

let status = { state: 'idle', backend: null, error: null };
const loads = new Map();

// What has loaded, for display or for choosing a decoder:
//   { state: 'idle' | 'loading' | 'ready' | 'failed',
//     backend: 'wasm-simd' | 'wasm-scalar' | null,
//     error: string | null }
// It reflects the most recent loadPCMv4Wasm() call.
export function pcmV4WasmStatus() {
    return { ...status };
}

// Compile and instantiate the module, once per flavour. Resolves to a runtime
// to construct decoders from; rejects when WebAssembly is missing, blocked by
// a Content-Security-Policy, or the embedded module is not the ABI this file
// was written for. Options:
//   simd: true | false | undefined   force a build; by default SIMD when the
//                                    engine validates it, else scalar
export function loadPCMv4Wasm(opts = {}) {
    const want = opts.simd === undefined ? pcmV4WasmSimdSupported() : !!opts.simd;
    const key = want ? 'simd' : 'scalar';
    if (loads.has(key)) {
        const p = loads.get(key);
        p.then((rt) => { status = { state: 'ready', backend: rt.backend, error: null }; }, () => {});
        return p;
    }
    status = { state: 'loading', backend: null, error: null };
    const p = (async () => {
        if (!pcmV4WasmAvailable()) throw new Error('WebAssembly is not available');
        const bytes = base64Bytes(want ? PCMV4_WASM_SIMD : PCMV4_WASM_SCALAR);
        const module = await WebAssembly.compile(bytes);
        const instance = await WebAssembly.instantiate(module, {});
        const ex = instance.exports;
        const abi = ex.pv4_abi();
        if (abi !== PCMV4_WASM_ABI) {
            throw new Error(`pcm v4 wasm: module ABI ${abi}, wrapper expects ${PCMV4_WASM_ABI}`);
        }
        return new Runtime(ex, ex.pv4_simd() === 1);
    })();
    loads.set(key, p);
    p.then(
        (rt) => { status = { state: 'ready', backend: rt.backend, error: null }; },
        (e) => {
            loads.delete(key);
            status = { state: 'failed', backend: null, error: String(e && e.message || e) };
        },
    );
    return p;
}

// One instance of the module, shared by every decoder made from it. Decoding
// is synchronous, so its scratch buffers are only ever in use by one packet.
class Runtime {
    constructor(ex, simd) {
        this.ex = ex;
        this.simd = simd;
        this.backend = simd ? 'wasm-simd' : 'wasm-scalar';
        this._buffer = null;
        this.u8 = null;
        this.f32 = null;
        // A decoder dropped without dispose() still gives its codec back.
        this.registry = typeof FinalizationRegistry === 'function'
            ? new FinalizationRegistry((h) => ex.pv4_codec_free(h))
            : null;
    }

    // Views on the module's memory, rebuilt whenever it has grown: growing
    // detaches the old ArrayBuffer and every view on it.
    views() {
        const buf = this.ex.memory.buffer;
        if (buf !== this._buffer) {
            this._buffer = buf;
            this.u8 = new Uint8Array(buf);
            this.f32 = new Float32Array(buf);
        }
    }
}

// ---------------------------------------------------------------------------
// The header state, as pcm-v4.js keeps it
// ---------------------------------------------------------------------------

// pcm-v4.js's Timestamp; see there for why base and delta are kept apart.
class Timestamp {
    constructor() { this.reset(); }

    reset() {
        this.base = 0;
        this.delta = 0;
    }

    read(u8, view, off, absolute) {
        if (absolute) {
            if (off + 8 > u8.length) return -1;
            this.base = view.getUint32(off, true) + view.getUint32(off + 4, true) * 4294967296;
            this.delta = 0;
            return off + 8;
        }
        const r = uvarint(u8, off);
        if (!r) return -1;
        const u = r[0];
        this.delta += (u % 2 === 1) ? -(u + 1) / 2 : u / 2;
        return r[1];
    }

    get ms() {
        return this.base ? (this.base + this.delta) / 1e6 : null;
    }
}

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

// ---------------------------------------------------------------------------
// The decoder
// ---------------------------------------------------------------------------

// Decoder for one connection. Stateful exactly as PCMv4StreamDecoder is:
// construct one per WebSocket, reset() on reconnect. dispose() releases the
// module-side state at once; a decoder that is simply dropped releases it when
// it is garbage-collected.
export class PCMv4WasmStreamDecoder {
    // A decoder on its own freshly loaded (or already cached) runtime.
    static async create(opts) {
        return new PCMv4WasmStreamDecoder(await loadPCMv4Wasm(opts));
    }

    constructor(runtime) {
        if (!(runtime instanceof Runtime)) {
            throw new TypeError('PCMv4WasmStreamDecoder needs a runtime from loadPCMv4Wasm()');
        }
        this.rt = runtime;
        this.handle = runtime.ex.pv4_codec_new();
        if (!this.handle) throw new Error('pcm v4 wasm: out of memory');
        if (runtime.registry) runtime.registry.register(this, this.handle, this);
        this.reset();
    }

    // 'wasm-simd' or 'wasm-scalar': which build is decoding.
    get backend() { return this.rt.backend; }

    dispose() {
        if (!this.handle) return;
        if (this.rt.registry) this.rt.registry.unregister(this);
        this.rt.ex.pv4_codec_free(this.handle);
        this.handle = 0;
    }

    reset() {
        if (this.handle) this.rt.ex.pv4_codec_reset(this.handle);
        this.profileId = -1;
        this.complex = false;
        this.scaled = false;
        this.sampleRate = 0;
        this.channels = 1;
        this.sampleCount = 0;
        this.power = QUALITY_NO_READING;
        this.noise = QUALITY_NO_READING;
        this.haveMetadata = false;
        this.ts = new Timestamp();
        this.residualCap = 0;
    }

    _useProfile(id) {
        if (this.profileId === id) return true;
        const p = PROFILES[id];
        if (!p) return false;
        if (this.rt.ex.pv4_codec_profile(this.handle, id) !== 0) return false;
        this.complex = p.complex;
        this.scaled = p.scaled;
        this.profileId = id;
        return true;
    }

    // Returns { planes, sampleRate, channels, signal, captureMs, kind, samples }
    // or null, exactly as PCMv4StreamDecoder.decode does for the same packet.
    decode(buffer) {
        if (!this.handle) throw new Error('pcm v4 wasm: decoder used after dispose()');
        const u8 = new Uint8Array(buffer);
        const view = new DataView(buffer);
        if (u8.length < 5 || view.getUint32(0, true) !== V4_MAGIC) return null;

        const flags = u8[4];
        let off = 5;
        const escape = (flags & FLAG_ESCAPE) !== 0;
        const silent = (flags & FLAG_SILENT) !== 0;
        if (escape && silent) return null;
        if (!this._useProfile(flags & PROFILE_MASK)) return null;

        if (!(flags & FLAG_METADATA) && !this.haveMetadata) return null;
        off = this.ts.read(u8, view, off, (flags & FLAG_METADATA) !== 0);
        if (off < 0) return null;

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

        const ex = this.rt.ex;
        if (silent) {
            if (off !== u8.length) return null;
            // In pieces only for a count past what an i32 argument holds, which
            // no real packet approaches.
            for (let left = count; left > 0;) {
                const n = Math.min(left, MAX_CALL);
                ex.pv4_silent(this.handle, n);
                left -= n;
            }
            // planes are already zero-filled
        } else {
            const len = u8.length - off;
            if (escape) {
                if (count * 2 > len) return null;
            } else {
                if (len < 1) return null;
                // The JavaScript sizes its residual buffer here, before reading
                // the body, and keeps it: new Float64Array(count) whenever count
                // is the largest yet. The module has its own buffer, but a count
                // past the engine's typed-array limit makes that allocation throw
                // a RangeError, and this must throw it too, at the same packet. So
                // the allocation is repeated -- and dropped -- at the same points,
                // which on a real stream is the first packet and never again.
                if (count > this.residualCap) {
                    new Float64Array(count);
                    this.residualCap = count;
                }
                // The JavaScript refuses this by running out of body. Refusing it
                // here first keeps a nonsense count from sizing the module's
                // buffers: every Rice value needs at least its stop bit.
                if (count > (len - 1) * 8) return null;
            }
            const ptr = ex.pv4_input(len) >>> 0;
            if (!ptr) throw new Error('pcm v4 wasm: out of memory');
            this.rt.views();
            this.rt.u8.set(u8.subarray(off), ptr);
            const n = ex.pv4_decode(this.handle, len, count, escape ? BODY_ESCAPE : BODY_RICE, shift);
            if (n < 0) {
                if (n === ERR_NOMEM) throw new Error('pcm v4 wasm: out of memory');
                return null;
            }
            this.rt.views();
            const f32 = this.rt.f32;
            // A plane shorter than the decoded frames keeps only its first
            // `frames`, and a longer one keeps zeros past them, as JavaScript's
            // out-of-range typed-array writes do: a header whose channel count
            // disagrees with its profile decodes the same way in both.
            const m = Math.min(frames, n);
            const pa = ex.pv4_plane(0) >>> 2;
            planes[0].set(f32.subarray(pa, pa + m));
            if (this.complex && channels > 1) {
                const pb = ex.pv4_plane(1) >>> 2;
                planes[1].set(f32.subarray(pb, pb + m));
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
            captureMs: this.ts.ms,
            kind: silent ? 'silent' : escape ? 'escape' : 'rice',
            samples: count,
        };
    }
}

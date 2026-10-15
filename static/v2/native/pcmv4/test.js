// test.js — the WebAssembly PCM v4 decoder against the JavaScript one.
//
//   node static/v2/native/pcmv4/test.js
//
// Needs node and esbuild, nothing else: the module under test is the one
// embedded in src/radio/pcm-v4-wasm.generated.js, so no toolchain is needed to
// run this, only to rebuild that file (build.sh).
//
// The reference is PCMv4StreamDecoder in src/radio/pcm-v4.js, the decoder this
// one is meant to replace. Both builds -- SIMD and scalar -- are held to it
// packet by packet: the same null for every packet it refuses, the same
// metadata, and Float32 planes identical to the bit. "Close" is a failure.
//
// The streams are the server's own output (see fixtures.js), and for this
// directory's set the JavaScript's output is also checked against the hash of
// what the server's decoder made of each stream, so the reference is itself
// pinned to the Go rather than taken on trust.
//
// Then the fuzz: real streams with bits flipped, truncated and with k
// rewritten; synthetic packets with random headers, profiles, channel counts
// and bodies; and bodies built to drive the predictor out of int16 and on to
// Infinity and NaN, which is the part of the comparison that the C cannot pass
// by being an integer codec -- see pcmv4.h. The one allowance anywhere is that
// a NaN equals a NaN: the bit pattern of a NaN is unspecified in both
// WebAssembly and JavaScript, so its sign and payload are not compared.

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { loadAll, bundles, HERE } = require('./fixtures.js');
const { sourceHash } = require('./embed.js');

let pass = 0;
const t = async (name, fn) => {
    try {
        const note = await fn();
        console.log('ok    ' + name + (note ? '\n      ' + note : ''));
        pass++;
    } catch (e) {
        console.log('FAIL  ' + name + '\n      ' + (e && e.stack || e));
        process.exitCode = 1;
    }
};

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

const stats = { nan: 0, nanBitsDiffer: 0, inf: 0, overFull: 0 };

function comparePlanes(a, b, where) {
    assert.strictEqual(b.length, a.length, `${where}: plane length ${b.length}, want ${a.length}`);
    const ua = new Uint32Array(a.buffer, a.byteOffset, a.length);
    const ub = new Uint32Array(b.buffer, b.byteOffset, b.length);
    for (let i = 0; i < a.length; i++) {
        if (ua[i] === ub[i]) {
            const v = a[i];
            if (v !== v) stats.nan++;
            else if (v === Infinity || v === -Infinity) stats.inf++;
            else if (v > 1 || v < -1) stats.overFull++;
            continue;
        }
        if (a[i] !== a[i] && b[i] !== b[i]) { stats.nan++; stats.nanBitsDiffer++; continue; }
        throw new Error(`${where} sample ${i}: ${b[i]} (0x${ub[i].toString(16)}), want ${a[i]} (0x${ua[i].toString(16)})`);
    }
}

function compareFrame(want, got, where) {
    if (want === null) {
        assert.strictEqual(got, null, `${where}: accepted a packet the JavaScript refuses`);
        return;
    }
    assert.ok(got !== null, `${where}: refused a packet the JavaScript accepts`);
    assert.deepStrictEqual(Object.keys(got).sort(), Object.keys(want).sort(), `${where}: result keys`);
    for (const k of ['sampleRate', 'channels', 'kind', 'samples']) {
        assert.strictEqual(got[k], want[k], `${where}: ${k}`);
    }
    assert.ok(Object.is(got.captureMs, want.captureMs), `${where}: captureMs ${got.captureMs}, want ${want.captureMs}`);
    assert.deepStrictEqual(got.signal, want.signal, `${where}: signal`);
    assert.strictEqual(got.planes.length, want.planes.length, `${where}: plane count`);
    for (let c = 0; c < want.planes.length; c++) {
        assert.ok(got.planes[c] instanceof Float32Array, `${where}: plane ${c} is not a Float32Array`);
        comparePlanes(want.planes[c], got.planes[c], `${where} plane ${c}`);
    }
}

// Feeds the same packets to the reference and every candidate, comparing each
// result. ops may also say 'reset'. Returns counts for the report.
function run(decs, packets, label) {
    let accepted = 0, refused = 0;
    packets.forEach((p, n) => {
        if (p === 'reset') {
            for (const d of decs) d.reset();
            return;
        }
        let want, wantErr = null;
        try { want = decs[0].decode(p); } catch (e) { wantErr = e; }
        for (let i = 1; i < decs.length; i++) {
            let got, gotErr = null;
            try { got = decs[i].decode(p); } catch (e) { gotErr = e; }
            const where = `${label} packet ${n} [${decs[i].backend}]`;
            if (wantErr || gotErr) {
                assert.ok(wantErr && gotErr, `${where}: ${wantErr ? 'JavaScript threw ' + wantErr : 'wasm threw ' + gotErr}`);
                assert.strictEqual(gotErr.constructor, wantErr.constructor, `${where}: threw ${gotErr}, JavaScript threw ${wantErr}`);
                continue;
            }
            compareFrame(want, got, where);
        }
        if (wantErr || want === null) refused++;
        else accepted++;
    });
    return { accepted, refused };
}

// The JavaScript's output as the server's decoder renders it: int16
// little-endian, I/Q interleaved, and on a scaled stream saturated at full
// scale as the server's lossyRestore does.
function serverHash(frames) {
    const h = crypto.createHash('sha256');
    for (const f of frames) {
        const ch = f.planes.length;
        const n = f.planes[0].length;
        const buf = Buffer.alloc(2 * n * ch);
        for (let i = 0; i < n; i++) {
            for (let c = 0; c < ch; c++) {
                let v = Math.round(f.planes[c][i] * 32768);
                if (v > 32767) v = 32767;
                if (v < -32768) v = -32768;
                buf.writeInt16LE(v, 2 * (i * ch + c));
            }
        }
        h.update(buf);
    }
    return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Packet construction, for the fuzz only
// ---------------------------------------------------------------------------

function rng(seed) {
    let a = seed >>> 0;
    const next = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let x = a;
        x = Math.imul(x ^ (x >>> 15), x | 1);
        x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    next.int = (n) => Math.floor(next() * n);
    next.pick = (arr) => arr[next.int(arr.length)];
    return next;
}

function uvarintBytes(v) {
    const out = [];
    while (v >= 0x80) {
        out.push((v % 128) | 0x80);
        v = Math.floor(v / 128);
    }
    out.push(v);
    return out;
}

// A resynchronisation packet: full timestamp, count and metadata.
function packet({ profile, escape = false, silent = false, count, rate = 12000, channels, quality = null, shift = null, body = [] }) {
    const bytes = [0x50, 0x43, 0x4d, 0x34];
    let flags = (profile & 7) | (1 << 5) | (1 << 3);
    if (escape) flags |= 1 << 7;
    if (silent) flags |= 1 << 4;
    if (quality) flags |= 1 << 6;
    bytes.push(flags);
    const ts = 1_700_000_000_000 + bytes.length;
    for (let i = 0; i < 8; i++) bytes.push(Math.floor(ts * 1e6 / 2 ** (8 * i)) & 0xff);
    bytes.push(...uvarintBytes(count), ...uvarintBytes(rate), channels & 0xff);
    if (quality) bytes.push(...quality);
    if (shift !== null) bytes.push(shift);
    const out = new Uint8Array(bytes.length + body.length);
    out.set(bytes);
    out.set(body, bytes.length);
    return out.buffer;
}

// Where a packet's body starts (after the shift byte on a scaled profile),
// read from the packet alone -- every field's presence is in its flags.
function bodyOffset(ab) {
    const u8 = new Uint8Array(ab);
    if (u8.length < 5) return -1;
    const flags = u8[4];
    let off = 5;
    const skipVarint = () => { while (off < u8.length && u8[off] >= 0x80) off++; off++; };
    if (flags & (1 << 5)) off += 8; else skipVarint();
    if (flags & (1 << 3)) skipVarint();
    if (flags & (1 << 5)) { skipVarint(); off++; }
    if (flags & (1 << 6)) off += 4;
    if ((flags & 7) === 2 && !(flags & (1 << 4))) off++;
    return off <= u8.length ? off : -1;
}

function randomBody(r, len) {
    const style = r.int(4);
    const b = new Array(len);
    for (let i = 0; i < len; i++) {
        switch (style) {
        case 0: b[i] = r.int(256); break;                         // uniform
        case 1: b[i] = r() < 0.8 ? 0xff : r.int(256); break;      // long unary runs
        case 2: b[i] = r() < 0.8 ? 0x00 : r.int(256); break;      // short codes
        default: b[i] = r() < 0.5 ? 0xaa : 0x55; break;           // alternating
        }
    }
    return b;
}

// ---------------------------------------------------------------------------

(async () => {
    const { js, wasm, generated } = bundles();
    const streams = loadAll();

    const rtSimd = await wasm.loadPCMv4Wasm({ simd: true });
    const rtScalar = await wasm.loadPCMv4Wasm({ simd: false });
    const decoders = () => [
        new js.PCMv4StreamDecoder(),
        new wasm.PCMv4WasmStreamDecoder(rtSimd),
        new wasm.PCMv4WasmStreamDecoder(rtScalar),
    ];

    const runtimes = [rtSimd, rtScalar];
    const counters = (rt) => ({
        kernel: rt.ex.pv4_counter(0) >>> 0,
        frame: rt.ex.pv4_counter(1) >>> 0,
        exits: rt.ex.pv4_counter(2) >>> 0,
        wide: rt.ex.pv4_counter(3) >>> 0,
    });
    const resetCounters = () => runtimes.forEach((rt) => rt.ex.pv4_counters_reset());

    await t('the embedded modules are built from the sources in this directory', () => {
        assert.strictEqual(generated.PCMV4_WASM_SOURCE_SHA256, sourceHash(HERE),
            'src/radio/pcm-v4-wasm.generated.js is stale: run static/v2/native/pcmv4/build.sh');
        return `abi ${generated.PCMV4_WASM_ABI}, simd ${Buffer.from(generated.PCMV4_WASM_SIMD, 'base64').length} B, ` +
            `scalar ${Buffer.from(generated.PCMV4_WASM_SCALAR, 'base64').length} B`;
    });

    await t('both builds load, and say which they are', () => {
        assert.strictEqual(rtSimd.backend, 'wasm-simd');
        assert.strictEqual(rtScalar.backend, 'wasm-scalar');
        assert.strictEqual(wasm.pcmV4WasmSimdSupported(), true, 'node 20 has SIMD; the probe should say so');
        const d = new wasm.PCMv4WasmStreamDecoder(rtScalar);
        assert.strictEqual(d.backend, 'wasm-scalar');
        d.dispose();
        assert.strictEqual(wasm.pcmV4WasmStatus().state, 'ready');
    });

    await t('the default load picks SIMD here, and create() resolves a working decoder', async () => {
        const d = await wasm.PCMv4WasmStreamDecoder.create();
        assert.strictEqual(d.backend, 'wasm-simd');
        assert.ok(d.decode(streams[0].packets[0]), 'the first packet of a stream decodes');
        d.dispose();
        assert.throws(() => d.decode(streams[0].packets[0]), /after dispose/);
    });

    // The fixtures, whole.
    for (const s of streams) {
        await t(`${s.name}: every packet identical to the JavaScript${s.desc ? ' (' + s.desc + ')' : ''}`, () => {
            const ref = new js.PCMv4StreamDecoder();
            const frames = s.packets.map((p) => ref.decode(p));
            frames.forEach((f, n) => assert.ok(f, `the JavaScript refused packet ${n} of a server stream`));
            if (s.manifest) {
                assert.strictEqual(serverHash(frames), s.manifest.serverSha256,
                    'the JavaScript reference disagrees with the server decoder');
            }
            const r = run(decoders(), s.packets, s.name);
            const kinds = {};
            for (const f of frames) kinds[f.kind] = (kinds[f.kind] || 0) + 1;
            const samples = frames.reduce((a, f) => a + f.samples, 0);
            return `${r.accepted} packets, ${samples} samples; ` +
                Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(', ') +
                (s.manifest ? '; matches the server decoder' : '');
        });
    }

    await t('on every server stream, every coded IQ frame went through the block kernel', () => {
        resetCounters();
        for (const s of streams) run(decoders(), s.packets, s.name);
        const notes = [];
        for (const rt of runtimes) {
            const c = counters(rt);
            assert.ok(c.kernel > 1e6, `${rt.backend}: only ${c.kernel} kernel frames`);
            assert.strictEqual(c.frame, 0, `${rt.backend}: ${c.frame} frames fell back to the per-frame path`);
            assert.strictEqual(c.exits + c.wide, 0, `${rt.backend}: kernel exits or wide bodies on clean streams`);
            notes.push(`${rt.backend} ${c.kernel} frames`);
        }
        return notes.join(', ');
    });

    await t('the per-frame IQ path alone (kernel switched off) is identical too', () => {
        resetCounters();
        runtimes.forEach((rt) => rt.ex.pv4_set_kernel(0));
        try {
            for (const s of streams) run(decoders(), s.packets, s.name + ' per-frame');
        } finally {
            runtimes.forEach((rt) => rt.ex.pv4_set_kernel(1));
        }
        for (const rt of runtimes) {
            const c = counters(rt);
            assert.strictEqual(c.kernel, 0);
            assert.ok(c.frame > 1e6, `${rt.backend}: only ${c.frame} per-frame frames`);
        }
    });

    await t('joining part-way: the same packets refused until the same resynchronisation', () => {
        let refused = 0;
        for (const s of streams) {
            for (const start of [1, 7, 40, Math.floor(s.packets.length / 2)]) {
                const r = run(decoders(), s.packets.slice(start), `${s.name} from ${start}`);
                refused += r.refused;
            }
        }
        assert.ok(refused > 0, 'no join was ever refused; the test is not testing joins');
        return `${refused} packets refused before a resynchronisation, identically`;
    });

    await t('reset() mid-stream', () => {
        for (const s of streams.slice(0, 6)) {
            const ops = [];
            s.packets.forEach((p, i) => {
                if (i % 97 === 50) ops.push('reset');
                ops.push(p);
            });
            run(decoders(), ops, s.name + ' with resets');
        }
    });

    // -----------------------------------------------------------------------
    // Fuzz
    // -----------------------------------------------------------------------

    const fuzzTotals = { accepted: 0, refused: 0 };
    const tally = (r) => { fuzzTotals.accepted += r.accepted; fuzzTotals.refused += r.refused; };

    await t('fuzz: real streams with random bits flipped', () => {
        const r = rng(1);
        for (const s of streams) {
            for (let rep = 0; rep < 2; rep++) {
                const ops = s.packets.map((p) => {
                    if (r() > 0.08) return p;
                    const c = new Uint8Array(p.slice(0));
                    const flips = 1 + r.int(3);
                    for (let i = 0; i < flips; i++) {
                        const at = r() < 0.7 && c.length > 30 ? 20 + r.int(c.length - 20) : r.int(c.length);
                        c[at] ^= 1 << r.int(8);
                    }
                    return c.buffer;
                });
                tally(run(decoders(), ops, `${s.name} bitflips ${rep}`));
            }
        }
    });

    await t('fuzz: real streams truncated and extended', () => {
        const r = rng(2);
        for (const s of streams) {
            const ops = s.packets.map((p) => {
                const x = r();
                if (x < 0.05) return p.slice(0, r.int(p.byteLength + 1));
                if (x < 0.07) {
                    const c = new Uint8Array(p.byteLength + 1 + r.int(8));
                    c.set(new Uint8Array(p));
                    for (let i = p.byteLength; i < c.length; i++) c[i] = r.int(256);
                    return c.buffer;
                }
                return p;
            });
            tally(run(decoders(), ops, `${s.name} truncated`));
        }
    });

    await t('fuzz: real streams with k rewritten to anything from 0 to 31', () => {
        const r = rng(3);
        let rewritten = 0;
        for (const s of streams) {
            const ops = s.packets.map((p) => {
                const flags = new Uint8Array(p)[4];
                if (flags & 0x90 || r() > 0.1) return p;   // escape and silent have no k
                const off = bodyOffset(p);
                if (off < 0 || off >= p.byteLength) return p;
                const c = new Uint8Array(p.slice(0));
                c[off] = r.int(32);
                rewritten++;
                return c.buffer;
            });
            tally(run(decoders(), ops, `${s.name} k rewritten`));
        }
        return `${rewritten} packets rewritten`;
    });

    await t('fuzz: synthetic packets -- random profile, channels, count, mode and body', () => {
        const r = rng(4);
        for (let seq = 0; seq < 300; seq++) {
            const ops = [];
            for (let i = 0; i < 40; i++) {
                if (r() < 0.03) { ops.push('reset'); continue; }
                const profile = r() < 0.9 ? r.int(3) : 3 + r.int(5);
                const channels = r.pick([1, 1, 2, 2, 3, 0, 4]);
                const count = r() < 0.9 ? 1 + r.int(400) : r.pick([0, 1, 2, 3, 2047, 70000]);
                const mode = r.int(10);
                const escape = mode === 0 || mode === 9;
                const silent = mode === 1 || mode === 9;
                let body;
                if (silent) body = r() < 0.8 ? [] : randomBody(r, 1 + r.int(4));
                else if (escape) body = randomBody(r, Math.max(0, count * 2 + r.int(5) - 2));
                else {
                    const k = r() < 0.8 ? r.int(31) : r.int(256);
                    body = [k, ...randomBody(r, r.int(Math.ceil(count * (k > 30 ? 2 : k + 2) / 8) + 4))];
                }
                const shift = profile === 2 && !silent && r() < 0.95 ? (r() < 0.9 ? r.int(16) : 16 + r.int(240)) : null;
                const quality = r() < 0.3 ? [r.int(256), r.int(256), r.int(256), r.int(256)] : null;
                ops.push(packet({ profile, escape, silent, count, channels, quality, shift, body }));
            }
            tally(run(decoders(), ops, `synthetic ${seq}`));
        }
    });

    await t('fuzz: synthetic counts past what a body can hold, and absurd ones', () => {
        // A coded or escaped body refuses these by running out of bytes. A
        // silent one has no body to run out of, so its count is only ever
        // tried at sizes whose plane allocation throws in both decoders --
        // anything smaller is a legitimate, and in JavaScript very long,
        // run of zeros.
        const r = rng(5);
        const ops = [];
        for (let i = 0; i < 300; i++) {
            const profile = r.int(3);
            const silent = r() < 0.2;
            const escape = !silent && r() < 0.3;
            const count = silent ? r.pick([2 ** 40, 2 ** 53]) : r.pick([1e6, 2 ** 31 - 2, 2 ** 31, 2 ** 32 + 2, 2 ** 40, 2 ** 53]);
            const channels = silent ? 1 : r.pick([1, 2, 255]);
            ops.push(packet({ profile, escape, silent, count, channels, shift: profile === 2 && !silent ? 0 : null, body: silent ? [] : randomBody(r, 1 + r.int(64)) }));
        }
        tally(run(decoders(), ops, 'absurd counts'));
    });

    await t('fuzz: residuals past int32 and a predictor driven to Infinity and NaN', () => {
        const r = rng(6);
        const before = { ...stats };
        resetCounters();
        // A cold predictor barely amplifies anything: its taps move by mu a
        // step from zero. So each run starts with a stretch of a real stream to
        // train them, then the bodies, then more of the real stream, which the
        // poisoned history carries on to Infinity and NaN.
        const trained = streams.filter((s) => s.manifest);
        for (let seq = 0; seq < 60; seq++) {
            const s = trained[seq % trained.length];
            const profile = s.manifest.profiles[s.manifest.profiles.length - 1];
            const complex = profile !== 1;
            const lead = 30 + r.int(150);
            const ops = s.packets.slice(0, lead);
            for (let i = 0; i < 30; i++) {
                const count = complex ? 2 * (1 + r.int(48)) : 1 + r.int(96);
                // k = 30 with runs of 1 bits: every value a quotient of up to
                // dozens, so residuals of 2^30 * q -- far past int32 and, through
                // the taps, past 2^53 within a few packets.
                const k = r() < 0.7 ? 30 : r.int(31);
                const bits = [];
                for (let v = 0; v < count; v++) {
                    const q = r() < 0.5 ? r.int(64) : r.int(4);
                    for (let j = 0; j < q; j++) bits.push(1);
                    bits.push(0);
                    for (let j = 0; j < k; j++) bits.push(r.int(2));
                }
                const body = [k];
                for (let j = 0; j < bits.length; j += 8) {
                    let b = 0;
                    for (let m = 0; m < 8 && j + m < bits.length; m++) b |= bits[j + m] << m;
                    body.push(b);
                }
                const mode = r.int(12);
                const ch = complex ? 2 : 1;
                if (mode === 0) ops.push(packet({ profile, count, channels: ch, silent: true, body: [] }));
                else if (mode === 1) ops.push(packet({ profile, count, channels: ch, escape: true, shift: profile === 2 ? r.int(16) : null, body: randomBody(r, count * 2) }));
                else ops.push(packet({ profile, count, channels: ch, shift: profile === 2 ? r.int(16) : null, body }));
            }
            ops.push(...s.packets.slice(lead, lead + 60));
            tally(run(decoders(), ops, `blow-up ${seq} on ${s.name}`));
        }
        const d = (k) => stats[k] - before[k];
        assert.ok(d('overFull') > 1000, 'the bodies did not drive the output past full scale');
        assert.ok(d('inf') > 0, 'the predictor never reached Infinity');
        assert.ok(d('nan') > 0, 'the predictor never reached NaN');
        const paths = [];
        for (const rt of runtimes) {
            const c = counters(rt);
            assert.ok(c.wide > 0, `${rt.backend}: the wide Rice decoder never ran`);
            assert.ok(c.exits > 0, `${rt.backend}: the block kernel never had to hand over`);
            assert.ok(c.frame > 0 && c.kernel > 0, `${rt.backend}: both IQ paths should have run`);
            paths.push(`${rt.backend}: ${c.wide} wide bodies, ${c.exits} kernel hand-overs`);
        }
        return `${d('overFull')} samples past full scale, ${d('inf')} infinite, ${d('nan')} NaN -- all identical ` +
            `(${d('nanBitsDiffer')} NaNs differing only in bit pattern)\n      ${paths.join('; ')}`;
    });

    await t('fuzz: a corrupt stream then a clean one, on the same decoders', () => {
        // The state a corrupt packet leaves behind must be the same too, so the
        // clean stream that follows (refused until its resynchronisation, then
        // decoded from the poisoned taps) must still agree.
        const r = rng(7);
        for (const s of streams.slice(0, 9)) {
            const ops = [];
            for (let i = 0; i < 20; i++) {
                const k = 30;
                ops.push(packet({ profile: s.manifest && s.manifest.profiles[0] || 0, count: 64, channels: 2, body: [k, ...randomBody(r, 200)] }));
            }
            ops.push(...s.packets);
            tally(run(decoders(), ops, `${s.name} after corruption`));
        }
    });

    await t('fuzz totals', () => {
        assert.ok(fuzzTotals.accepted > 10000 && fuzzTotals.refused > 1000, JSON.stringify(fuzzTotals));
        return `${fuzzTotals.accepted} packets accepted and ${fuzzTotals.refused} refused (or thrown), ` +
            `every one identically in both builds; over the whole run ${stats.overFull} samples past full scale, ` +
            `${stats.inf} infinite, ${stats.nan} NaN, of which ${stats.nanBitsDiffer} differed in bit pattern only`;
    });

    await t('decoders come and go without the module growing', () => {
        const ex = rtScalar.ex;
        // The first may have to take a fresh block; every one after it must
        // reuse the block the one before it gave back.
        new wasm.PCMv4WasmStreamDecoder(rtScalar).dispose();
        const before = ex.memory.buffer.byteLength;
        for (let i = 0; i < 2000; i++) {
            const d = new wasm.PCMv4WasmStreamDecoder(rtScalar);
            d.decode(streams[0].packets[0]);
            d.dispose();
        }
        assert.strictEqual(ex.memory.buffer.byteLength, before, 'memory grew across create/dispose');
    });

    console.log(`\n${pass} passed${process.exitCode ? ', SOME FAILED' : ''}`);
})();

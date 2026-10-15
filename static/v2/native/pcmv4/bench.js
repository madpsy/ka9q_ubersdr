// bench.js — what the WebAssembly decoder costs, against the JavaScript one.
//
//   node static/v2/native/pcmv4/bench.js [--native-dir=<dir>] [--quick]
//
// Every stream test.js checks is decoded start to finish, as a connection
// would decode it (one stateful decoder per pass, every packet including the
// header parse, the plane allocation and the copy out), by:
//
//   js            PCMv4StreamDecoder, src/radio/pcm-v4.js
//   wasm-scalar   this decoder, the build for engines without SIMD
//   wasm-simd     this decoder, the build every current engine gets
//   native        clients/python/pcm_v4_native.c, gcc -O2 -march=native: the
//                 same algorithm with AVX2, as a floor. It decodes to int16
//                 and does no float conversion or header parse, so it is a
//                 bound on the codec, not a like-for-like decoder.
//
// The result is ns per frame (a frame is one sample, or one I/Q pair) and the
// share of one core that costs at the mode's real rate. Captures exist for 12
// and 24 kHz audio and for 12 and 384 kHz IQ; iq48, iq96 and iq192 are
// extrapolated from the 384 kHz streams' per-frame cost, which is the right
// model because the per-frame work does not depend on the rate -- packets at
// lower IQ rates are smaller, so the per-packet overhead is a slightly larger
// share there and the extrapolation is slightly optimistic.
//
// Times are the median of several passes after a warm-up, so the JIT has
// optimised the JavaScript and tiered up the WebAssembly before anything
// counts. The native harness is built into --native-dir (default: a directory
// under the system temp dir), never into the tree.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadAll, bundles, V2 } = require('./fixtures.js');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const QUICK = !!args.quick;
const NATIVE_DIR = args['native-dir'] || path.join(os.tmpdir(), 'pcmv4-native-baseline');
const TARGET_MS = QUICK ? 150 : 600;   // per measurement
const TRIALS = QUICK ? 3 : 5;

const now = () => Number(process.hrtime.bigint()) / 1e6;

// One pass over a stream with a fresh decoder; returns frames decoded.
function pass(make, packets) {
    const d = make();
    let frames = 0;
    for (const p of packets) {
        const f = d.decode(p);
        if (f) frames += f.planes[0].length;
    }
    if (d.dispose) d.dispose();
    return frames;
}

function measure(make, packets) {
    // Warm-up: a second or so of passes, so the measurement sees optimised code.
    let frames = 0;
    const w0 = now();
    while (now() - w0 < TARGET_MS) frames = pass(make, packets);
    const per = [];
    for (let t = 0; t < TRIALS; t++) {
        let n = 0, f = 0;
        const t0 = now();
        do { f += pass(make, packets); n++; } while (now() - t0 < TARGET_MS);
        per.push((now() - t0) * 1e6 / f);
    }
    per.sort((a, b) => a - b);
    return { ns: per[per.length >> 1], frames };
}

// ---------------------------------------------------------------------------
// Native baseline
// ---------------------------------------------------------------------------

const HARNESS = String.raw`
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
void *pcmv4_codec_new(int profile);
void pcmv4_codec_free(void *h);
int pcmv4_codec_decode_body(void *h, const uint8_t *body, size_t len, int count, int escape, int16_t *out);
int pcmv4_codec_advance_silence(void *h, int count);
void pcmv4_lossy_restore(int16_t *samples, int count, int shift);
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }
/* bodies: [u8 profile][u8 mode 0 rice 1 escape 2 silent][u8 shift][u8 0][u32 count][u32 len][body] */
static long pass(const uint8_t *b, long n, int16_t *out) {
    void *c = 0; int prof = -1; long frames = 0;
    for (long o = 0; o < n;) {
        int p = b[o], mode = b[o + 1], shift = b[o + 2]; uint32_t cnt, len;
        memcpy(&cnt, b + o + 4, 4); memcpy(&len, b + o + 8, 4); o += 12;
        if (p != prof) { if (c) pcmv4_codec_free(c); c = pcmv4_codec_new(p); prof = p; }
        int rc = mode == 2 ? pcmv4_codec_advance_silence(c, cnt) : pcmv4_codec_decode_body(c, b + o, len, cnt, mode == 1, out);
        if (rc) { fprintf(stderr, "rc %d\n", rc); exit(1); }
        if (mode != 2 && shift) pcmv4_lossy_restore(out, cnt, shift);
        frames += p == 1 ? cnt : cnt / 2; o += len;
    }
    if (c) pcmv4_codec_free(c);
    return frames;
}
int main(int argc, char **argv) {
    FILE *f = fopen(argv[1], "rb"); fseek(f, 0, SEEK_END); long n = ftell(f); rewind(f);
    uint8_t *b = malloc(n); if (fread(b, 1, n, f) != (size_t)n) return 1; fclose(f);
    double target = atof(argv[2]); int trials = atoi(argv[3]);
    static int16_t out[1 << 20];
    double w0 = now(); while (now() - w0 < target) pass(b, n, out);
    double per[16];
    for (int t = 0; t < trials; t++) { long fr = 0; double t0 = now(); do fr += pass(b, n, out); while (now() - t0 < target); per[t] = (now() - t0) * 1e6 / fr; }
    for (int i = 0; i < trials; i++) for (int j = i + 1; j < trials; j++) if (per[j] < per[i]) { double x = per[i]; per[i] = per[j]; per[j] = x; }
    printf("%.3f\n", per[trials / 2]);
    return 0;
}
`;

function buildNative() {
    const src = path.resolve(V2, '..', '..', 'clients', 'python', 'pcm_v4_native.c');
    try {
        fs.mkdirSync(NATIVE_DIR, { recursive: true });
        fs.writeFileSync(path.join(NATIVE_DIR, 'harness.c'), HARNESS);
        const exe = path.join(NATIVE_DIR, 'harness');
        execFileSync('gcc', ['-O2', '-march=native', '-o', exe, path.join(NATIVE_DIR, 'harness.c'), src], { stdio: 'pipe' });
        return exe;
    } catch (e) {
        console.error(`native baseline unavailable: ${e.message.split('\n')[0]}`);
        return null;
    }
}

// The bodies the native codec takes, with the header already parsed -- by the
// JavaScript decoder's own reading of each packet, so the stream is the same.
function nativeBodies(packets, js) {
    const ref = new js.PCMv4StreamDecoder();
    const parts = [];
    for (const p of packets) {
        const f = ref.decode(p);
        if (!f) continue;
        const u8 = new Uint8Array(p);
        const flags = u8[4];
        let off = 5;
        const skip = () => { while (u8[off] >= 0x80) off++; off++; };
        if (flags & 0x20) off += 8; else skip();
        if (flags & 0x08) skip();
        if (flags & 0x20) { skip(); off++; }
        if (flags & 0x40) off += 4;
        const profile = flags & 7;
        let shift = 0;
        if (profile === 2 && !(flags & 0x10)) shift = u8[off++];
        const body = Buffer.from(u8.subarray(off));
        const h = Buffer.alloc(12);
        h[0] = profile;
        h[1] = f.kind === 'rice' ? 0 : f.kind === 'escape' ? 1 : 2;
        h[2] = shift;
        h.writeUInt32LE(f.samples, 4);
        h.writeUInt32LE(f.kind === 'silent' ? 0 : body.length, 8);
        parts.push(h);
        if (f.kind !== 'silent') parts.push(body);
    }
    return Buffer.concat(parts);
}

function nativeMeasure(exe, packets, js, name) {
    const file = path.join(NATIVE_DIR, name.replace(/[^a-z0-9.-]/gi, '_') + '.bodies');
    fs.writeFileSync(file, nativeBodies(packets, js));
    return Number(execFileSync(exe, [file, String(TARGET_MS), String(TRIALS)]).toString().trim());
}

// ---------------------------------------------------------------------------

(async () => {
    const { js, wasm } = bundles();
    const rtSimd = await wasm.loadPCMv4Wasm({ simd: true });
    const rtScalar = await wasm.loadPCMv4Wasm({ simd: false });
    const native = buildNative();

    // This directory's server-made streams, one per capture. The test/ ones
    // repeat the same captures and are left to test.js.
    const streams = loadAll().filter((s) => s.manifest);
    const rows = [];
    for (const s of streams) {
        const first = new js.PCMv4StreamDecoder().decode(s.packets[0]);
        const r = {
            name: s.name.replace(/\.v4$/, ''),
            profiles: s.manifest.profiles.join('+'),
            rate: first.sampleRate,
            js: measure(() => new js.PCMv4StreamDecoder(), s.packets).ns,
            scalar: measure(() => new wasm.PCMv4WasmStreamDecoder(rtScalar), s.packets).ns,
            simd: measure(() => new wasm.PCMv4WasmStreamDecoder(rtSimd), s.packets).ns,
            native: native ? nativeMeasure(native, s.packets, js, s.name) : NaN,
        };
        rows.push(r);
        process.stderr.write('.');
    }
    process.stderr.write('\n');

    const f1 = (v) => Number.isFinite(v) ? v.toFixed(1).padStart(7) : '      -';
    const pct = (ns, rate) => Number.isFinite(ns) ? (ns * rate / 1e7).toFixed(2).padStart(6) + '%' : '      -';
    const out = [];
    const W = '-'.repeat(118);
    out.push(`PCM v4 decode cost -- ${os.cpus()[0].model.trim()}, node ${process.version}`);
    out.push('ns per frame (median of passes); %core = ns x frames/s at the mode\'s rate');
    out.push(W);
    out.push('stream                 prof      rate |      js  scalar    simd  native |    js %  scalar %    simd %  native % | simd vs js');
    out.push(W);
    for (const r of rows) {
        out.push(`${r.name.padEnd(22)} ${r.profiles.padEnd(5)} ${String(r.rate).padStart(8)} |` +
            `${f1(r.js)} ${f1(r.scalar)} ${f1(r.simd)} ${f1(r.native)} |` +
            ` ${pct(r.js, r.rate)}  ${pct(r.scalar, r.rate)}   ${pct(r.simd, r.rate)}   ${pct(r.native, r.rate)} | ${(r.js / r.simd).toFixed(1).padStart(5)}x`);
    }
    out.push(W);

    // Per-mode summary. The IQ ladder takes the mean per-frame cost of the
    // three 384 kHz lossless captures.
    const mean = (xs, k) => xs.reduce((a, x) => a + x[k], 0) / xs.length;
    const iq384 = rows.filter((r) => r.rate === 384000 && r.profiles === '0');
    const at = (sel) => ({ js: mean(sel, 'js'), scalar: mean(sel, 'scalar'), simd: mean(sel, 'simd'), native: mean(sel, 'native') });
    const modes = [
        ['usb/lsb/cw 12k', 12000, at(rows.filter((r) => r.profiles === '1' && r.rate === 12000)), 'measured'],
        ['am/nfm 24k', 24000, at(rows.filter((r) => r.profiles === '1' && r.rate === 24000)), 'measured'],
        ['iq 12k', 12000, at(rows.filter((r) => r.name.startsWith('iq12k'))), 'measured'],
        ['iq48', 48000, at(iq384), 'from iq384'],
        ['iq96', 96000, at(iq384), 'from iq384'],
        ['iq192', 192000, at(iq384), 'from iq384'],
        ['iq384', 384000, at(iq384), 'measured'],
        ['iq384 scaled (prof 2)', 384000, at(rows.filter((r) => r.name === 'iq384-scaled')), 'measured'],
    ];
    out.push('mode                         rate |    js %  scalar %    simd %  native % | ns/frame js / scalar / simd / native');
    out.push(W);
    for (const [name, rate, c, how] of modes) {
        out.push(`${name.padEnd(22)} ${String(rate).padStart(10)} | ${pct(c.js, rate)}  ${pct(c.scalar, rate)}   ${pct(c.simd, rate)}   ${pct(c.native, rate)} |` +
            ` ${c.js.toFixed(0)} / ${c.scalar.toFixed(0)} / ${c.simd.toFixed(0)} / ${Number.isFinite(c.native) ? c.native.toFixed(0) : '-'}  (${how})`);
    }
    out.push(W);
    console.log(out.join('\n'));
})();

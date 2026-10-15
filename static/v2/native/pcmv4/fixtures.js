// fixtures.js — loads every PCM v4 stream test.js and bench.js run, and builds
// the two decoders' bundles. Not part of the decoder.
//
// Streams come from two places, both coded by the server's Go encoder:
//
//   testdata/*.v4         this directory's set, one per capture in
//                         testdata/pcm_predictive plus a scaled and a mixed
//                         stream; written by pcm_v4_wasm_fixture_test.go,
//                         described in testdata/manifest.json
//   static/v2/test/       the browser's existing fixtures, read in place:
//                         pcmv4.sample.bin, pcmv4scaled.sample.bin and the v4
//                         half of pcmcpu.sample.bin (three streams)

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const V2 = path.resolve(HERE, '..', '..');
const BUILD = path.join(HERE, '.build');

function toAB(buf) {
    const ab = new ArrayBuffer(buf.length);
    new Uint8Array(ab).set(buf);
    return ab;
}

// "UV4F", a format byte, a uint32 packet count, then [uint32 length][packet].
function loadUV4F(file) {
    const b = fs.readFileSync(file);
    if (b.toString('latin1', 0, 4) !== 'UV4F') throw new Error(`${file}: not a UV4F fixture`);
    const n = b.readUInt32LE(5);
    const out = [];
    let off = 9;
    for (let i = 0; i < n; i++) {
        const len = b.readUInt32LE(off);
        off += 4;
        out.push(toAB(b.subarray(off, off + len)));
        off += len;
    }
    return out;
}

// [packet length u32][sample count u32][packet][samples int16 LE].
function loadInterleaved(file) {
    const b = fs.readFileSync(file);
    const out = [];
    let off = 0;
    while (off + 8 <= b.length) {
        const len = b.readUInt32LE(off);
        const n = b.readUInt32LE(off + 4);
        off += 8;
        out.push(toAB(b.subarray(off, off + len)));
        off += len + 2 * n;
    }
    return out;
}

// [v3 length][v4 length][sample count][stream id][v3][v4]; one stream per id.
function loadCPU(file) {
    const b = fs.readFileSync(file);
    const streams = new Map();
    let off = 0;
    while (off + 16 <= b.length) {
        const v3 = b.readUInt32LE(off), v4 = b.readUInt32LE(off + 4), id = b.readUInt32LE(off + 12);
        off += 16 + v3;
        if (!streams.has(id)) streams.set(id, []);
        streams.get(id).push(toAB(b.subarray(off, off + v4)));
        off += v4;
    }
    return [...streams.entries()].map(([id, packets]) => ({ id, packets }));
}

// Every stream, as { name, packets, profiles, rate, sha256? }.
function loadAll() {
    const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'testdata', 'manifest.json'), 'utf8'));
    const out = manifest.map((m) => ({
        name: m.file,
        desc: m.desc,
        packets: loadUV4F(path.join(HERE, 'testdata', m.file)),
        manifest: m,
    }));
    const t = path.join(V2, 'test');
    out.push({ name: 'test/pcmv4.sample.bin', packets: loadInterleaved(path.join(t, 'pcmv4.sample.bin')) });
    out.push({ name: 'test/pcmv4scaled.sample.bin', packets: loadInterleaved(path.join(t, 'pcmv4scaled.sample.bin')) });
    const cpuNames = ['usb', 'am', 'iq12k'];
    for (const s of loadCPU(path.join(t, 'pcmcpu.sample.bin'))) {
        out.push({ name: `test/pcmcpu.sample.bin#${cpuNames[s.id] || s.id}`, packets: s.packets });
    }
    return out;
}

// Bundles pcm-v4.js and pcm-v4-wasm.js for node with esbuild, as the v2 test
// runner does for its own entries, and loads them.
function bundles() {
    fs.mkdirSync(BUILD, { recursive: true });
    const build = (entry, out) => execFileSync('esbuild', [
        path.join(V2, 'src', 'radio', entry), '--bundle', '--format=cjs', '--platform=node',
        '--log-level=warning', `--outfile=${path.join(BUILD, out)}`,
    ], { stdio: 'inherit' });
    build('pcm-v4.js', 'pcm-v4.cjs');
    build('pcm-v4-wasm.js', 'pcm-v4-wasm.cjs');
    build('pcm-v4-wasm.generated.js', 'pcm-v4-wasm.generated.cjs');
    return {
        js: require(path.join(BUILD, 'pcm-v4.cjs')),
        wasm: require(path.join(BUILD, 'pcm-v4-wasm.cjs')),
        generated: require(path.join(BUILD, 'pcm-v4-wasm.generated.cjs')),
    };
}

module.exports = { loadAll, bundles, HERE, V2, BUILD };

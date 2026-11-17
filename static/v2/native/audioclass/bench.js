// bench.js -- what a verdict costs: CPU time (process.cpuUsage, user + system)
// per 5 s window, for both builds of this module and, when given, for the Go
// module it replaces. CPU time rather than wall clock, so a busy machine does
// not inflate the numbers.
//
//   node bench.js [audioclass.wasm wasm_exec.js]
//
// The optional pair is the Go module this replaced and Go's loader for it, from
// git history (static/v2/audioclass/audioclass.wasm and
// static/v2/src/lib/audioClass/wasm_exec.js before the port).

'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const V2 = path.join(__dirname, '..', '..');
const GEN = path.join(V2, 'src', 'lib', 'audioClass', 'audioclass-wasm.generated.js');
const MODEL = fs.readFileSync(path.join(V2, 'audioclass', 'mn05_as_mAP_443.pt'));

const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1e6; };

// 7 s of hiss at 12 kHz, the SSB rate, pushed in 100 ms packets.
function audio() {
    const x = new Float32Array(12000 * 7);
    let s = 1;
    for (let i = 0; i < x.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; x[i] = 0.2 * (s / 0x7fffffff - 0.5); }
    return x;
}

const REPS = 40;

async function benchC(name, b64) {
    const { instance } = await WebAssembly.instantiate(Buffer.from(b64, 'base64'), {});
    const E = instance.exports;
    let t = cpu();
    const ptr = E.ac_model_buffer(MODEL.length);
    new Uint8Array(E.memory.buffer, ptr, MODEL.length).set(MODEL);
    if (E.ac_load() !== 0) throw new Error('load failed');
    const load = cpu() - t;
    E.ac_reset(12000);
    const x = audio();
    t = cpu();
    for (let off = 0; off < x.length; off += 1200) {
        new Float32Array(E.memory.buffer, E.ac_input(), 1200).set(x.subarray(off, off + 1200));
        E.ac_push(1200);
    }
    const pushSec = cpu() - t;
    E.ac_classify(5); // warm up
    t = cpu();
    for (let i = 0; i < REPS; i++) E.ac_classify(5);
    const per = (cpu() - t) / REPS;
    // The front end alone, on the same 5 s.
    const win = E.ac_test_buffer(160000);
    new Float32Array(E.memory.buffer, win, 160000).fill(0.01);
    t = cpu();
    for (let i = 0; i < REPS; i++) E.ac_bench_mel(win, 160000);
    const mel = (cpu() - t) / REPS;
    return { name, load, per, push: pushSec / 7, mel };
}

async function benchGo(wasmPath, execPath) {
    require(path.resolve(execPath));
    const go = new globalThis.Go();
    const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasmPath), go.importObject);
    go.run(instance);
    const api = globalThis.audioclass;
    let t = cpu();
    const err = api.load(new Uint8Array(MODEL));
    if (err) throw new Error(err);
    const load = cpu() - t;
    api.reset(12000);
    const x = audio();
    t = cpu();
    for (let off = 0; off < x.length; off += 1200) {
        const s = x.slice(off, off + 1200);
        api.push(new Uint8Array(s.buffer));
    }
    const pushSec = cpu() - t;
    api.classify(5);
    t = cpu();
    for (let i = 0; i < REPS; i++) api.classify(5);
    const per = (cpu() - t) / REPS;
    return { name: 'Go (the module this replaces)', load, per, push: pushSec / 7 };
}

async function main() {
    const G = await import(pathToFileURL(GEN).href);
    const rows = [];
    rows.push(await benchC('C, WebAssembly SIMD', G.AUDIOCLASS_WASM_SIMD));
    rows.push(await benchC('C, scalar', G.AUDIOCLASS_WASM_SCALAR));
    const [goWasm, goExec] = process.argv.slice(2);
    if (goWasm && goExec) rows.push(await benchGo(goWasm, goExec));
    console.log(`CPU time, node ${process.version}, ${REPS} windows of 5 s:`);
    for (const r of rows) {
        console.log(`  ${r.name.padEnd(32)} ${(r.per * 1000).toFixed(1).padStart(7)} ms per window` +
            `   load ${(r.load * 1000).toFixed(0).padStart(4)} ms   resampling ${(r.push * 1000).toFixed(2)} ms per second of audio` +
            (r.mel ? `   (mel ${(r.mel * 1000).toFixed(1)} ms of it)` : ''));
    }
    const go = rows.find((r) => r.name.startsWith('Go'));
    if (go) for (const r of rows.filter((r) => r !== go)) console.log(`  ${r.name}: ${(go.per / r.per).toFixed(1)}x faster than Go`);
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

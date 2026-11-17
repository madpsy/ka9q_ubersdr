// test.js -- the WebAssembly audio classifier against its references.
//
//   node test.js            (after ./build.sh; needs nothing else)
//
// Both builds, SIMD and scalar, are run through every check:
//
//   * the Go original this was ported from (removed once this matched it; see
//     git history): what its WebAssembly build computed for a set of
//     deterministic signals streamed in the way the page streams them,
//     recorded in testdata/wasm_parity.json. The float32 outputs must match to
//     the last bit -- compared by hash, all 527 class probabilities and the
//     640-number embedding -- and the verdicts and tags exactly. A deliberate
//     change to the arithmetic means re-recording it from this module (see
//     README.md);
//   * PyTorch: golden outputs from an independent PyTorch run on the official
//     weights (testdata/efficientat_golden.json), on the chord signal;
//   * the committed weights are EfficientAT's published file, byte for byte;
//   * the .pt reader, on testdata/tiny_state_dict.pt (written by torch.save from
//     known values), and on thousands of corrupted and truncated files: an
//     error every time, never a trap;
//   * the stream: bounded memory, a reset forgets, too little audio is "ask
//     again", silence skips the model;
//   * the committed build is the build of these sources.

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const HERE = __dirname;
const PKG = HERE;
const V2 = path.join(HERE, '..', '..');
const GEN = path.join(V2, 'src', 'lib', 'audioClass', 'audioclass-wasm.generated.js');
const MODEL = path.join(V2, 'audioclass', 'mn05_as_mAP_443.pt');

let pass = 0, fail = 0;
async function t(name, fn) {
    try { await fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e && e.stack || e)); fail++; }
}

// ── the module ──────────────────────────────────────────────────────────────

async function instantiate(b64) {
    const { instance } = await WebAssembly.instantiate(Buffer.from(b64, 'base64'), {});
    return instance.exports;
}

const dec = new TextDecoder();
function cstr(E, ptr, len) { return dec.decode(new Uint8Array(E.memory.buffer, ptr, len)); }
function f32(E, ptr, n) { return new Float32Array(E.memory.buffer, ptr, n); }

function loadModel(E, bytes) {
    const ptr = E.ac_model_buffer(bytes.length);
    assert.ok(ptr, 'room for the model');
    new Uint8Array(E.memory.buffer, ptr, bytes.length).set(bytes);
    const rc = E.ac_load();
    return rc === 0 ? '' : cstr(E, E.ac_error(), E.ac_error_len());
}

function push(E, x, packet) {
    for (let off = 0; off < x.length; off += packet) {
        const n = Math.min(packet, x.length - off);
        f32(E, E.ac_input(), n).set(x.subarray(off, off + n));
        E.ac_push(n);
    }
}

const LABELS = ['voice', 'music', 'noise', 'silent'];
function result(E) {
    const p = E.ac_result();
    const v = new DataView(E.memory.buffer, p, 104);
    const label = v.getInt32(0, true), ntags = v.getInt32(4, true);
    const tags = [];
    for (let i = 0; i < ntags; i++) {
        const idx = v.getInt32(24 + 4 * i, true);
        tags.push({ label: cstr(E, E.ac_label(idx), E.ac_label_len(idx)), score: v.getFloat64(48 + 8 * i, true) });
    }
    return { label: LABELS[label], confidence: v.getFloat64(8, true), seconds: v.getFloat64(16, true), tags };
}

function sha(floats) {
    return crypto.createHash('sha256').update(Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength)).digest('hex');
}

// ── the parity signals: the Go original's paritySignal, exactly ────────────

function signal(c) {
    const n = Math.trunc(c.seconds * c.rate);
    const x = new Float32Array(n);
    let st = 12345 >>> 0;
    const next = () => {
        st ^= st << 13; st >>>= 0;
        st ^= st >>> 17;
        st ^= st << 5; st >>>= 0;
        return st;
    };
    const sample = (amp) => Math.fround(Math.fround((next() | 0) >> 8) / 8388608 * amp);
    const U = (v) => v >>> 0;
    if (c.name === 'noise') {
        for (let i = 0; i < n; i++) x[i] = sample(0.25);
    } else if (c.name === 'squares') {
        let p1 = 0, p2 = 0;
        for (let i = 0; i < n; i++) {
            p1 = U(p1 + 0x01234567); p2 = U(p2 + 0x00345678);
            let v = (p1 & 0x80000000) ? 0.125 : -0.125;
            v = Math.fround(v + ((p2 & 0x80000000) ? 0.0625 : -0.0625));
            x[i] = Math.fround(v + sample(0.015625));
        }
    } else if (c.name === 'fsk') {
        let p = 0;
        const steps = [0x04000000, 0x04800000, 0x05000000, 0x05800000];
        const hop = Math.trunc(c.rate * 160 / 1000);
        for (let i = 0; i < n; i++) {
            p = U(p + steps[Math.trunc(i / hop) % 4]);
            const v = (p & 0x80000000) ? 0.25 : -0.25;
            x[i] = Math.fround(v + sample(0.0625));
        }
    } else if (c.name === 'gated') {
        const gate = Math.trunc(c.rate * 60 / 1000);
        for (let i = 0; i < n; i++) {
            const s = sample(0.5);
            x[i] = Math.trunc(i / gate) % 2 === 1 ? 0 : s;
        }
    } else if (c.name === 'quiet') {
        for (let i = 0; i < n; i++) x[i] = sample(1 / 65536);
    } else {
        throw new Error('unknown case ' + c.name);
    }
    return x;
}

// ── PyTorch's golden input: the chords, at 16 kHz, through a WAV round trip,
// resampled to 32 kHz, the first 10 s, through a WAV round trip again ──────

function floatToInt16(v) {
    const x = Math.fround(v * 32767);
    if (x > 32767) return 32767;
    if (x < -32768) return -32768;
    return Math.trunc(x);
}
function wavRoundTrip(v) { for (let i = 0; i < v.length; i++) v[i] = floatToInt16(v[i]) / 32768; }

function chords(rate, secs) {
    const notes = [220, 261.6, 329.6, 392];
    const n = Math.trunc(rate * secs);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const tt = i / rate;
        const f0 = notes[Math.trunc(tt) % 4];
        let v = 0;
        for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f0 * h * tt) / h;
        x[i] = 0.2 * v;
    }
    return x;
}

// ── the checks ──────────────────────────────────────────────────────────────

async function main() {
    const G = await import(pathToFileURL(GEN).href);
    const { sourceHash } = require('./embed.js');
    const model = fs.readFileSync(MODEL);
    const parity = JSON.parse(fs.readFileSync(path.join(PKG, 'testdata', 'wasm_parity.json'), 'utf8'));
    const golden = JSON.parse(fs.readFileSync(path.join(PKG, 'testdata', 'efficientat_golden.json'), 'utf8'));
    const tiny = fs.readFileSync(path.join(PKG, 'testdata', 'tiny_state_dict.pt'));
    const csvLabels = fs.readFileSync(path.join(PKG, 'audioset_labels.csv'), 'utf8');

    await t('the committed weights are EfficientAT\'s v0.0.1 mn05_as_mAP_443.pt', () => {
        const sum = crypto.createHash('sha256').update(model).digest('hex');
        assert.strictEqual(model.length, 5878097);
        assert.strictEqual(sum, '97f00bb717ce957dbdf60c26d4de8b161dd7c2593fbe6424859fad7e5569fd7f');
    });

    await t('the committed build is of these sources', () => {
        assert.strictEqual(G.AUDIOCLASS_WASM_SOURCE_SHA256, sourceHash(HERE),
            'audioclass-wasm.generated.js is stale: run ./build.sh');
    });

    for (const [build, b64] of [['simd', G.AUDIOCLASS_WASM_SIMD], ['scalar', G.AUDIOCLASS_WASM_SCALAR]]) {
        const E = await instantiate(b64);

        await t(`${build}: ABI ${G.AUDIOCLASS_WASM_ABI}`, () => {
            assert.strictEqual(E.ac_abi(), G.AUDIOCLASS_WASM_ABI);
        });

        await t(`${build}: loads the committed model`, () => {
            assert.strictEqual(loadModel(E, model), '');
            assert.strictEqual(E.ac_embedding_size(), 640);
        });

        await t(`${build}: the AudioSet labels`, () => {
            for (let i = 0; i < 527; i++) {
                const name = cstr(E, E.ac_label(i), E.ac_label_len(i));
                assert.ok(name.length && csvLabels.includes(name), `label ${i}: ${name}`);
            }
            assert.strictEqual(cstr(E, E.ac_label(0), E.ac_label_len(0)), 'Speech');
        });

        if (process.env.AUDIOCLASS_RECORD_PARITY && build === 'simd') {
            // Re-record the reference from this module, after a deliberate
            // change to the arithmetic. Check the new verdicts by hand first.
            const results = [];
            for (const c of parity.cases) {
                E.ac_reset(c.rate);
                push(E, signal(c), c.packet);
                for (const w of c.windows) {
                    E.ac_classify(w);
                    const r = result(E);
                    const out = { case: c.name, window: w, label: r.label, confidence: r.confidence, tags: r.tags,
                        seconds: r.seconds, probs_sha256: '', hidden_sha256: '', top: null, buffered: E.ac_buffered() };
                    if (r.label !== 'silent') {
                        const probs = Float32Array.from(f32(E, E.ac_probs(), 527));
                        out.probs_sha256 = sha(probs);
                        out.hidden_sha256 = sha(Float32Array.from(f32(E, E.ac_embedding(), 640)));
                        out.top = Array.from(probs.keys()).sort((i, j) => probs[j] - probs[i] || i - j).slice(0, 10).map((i) => [i, probs[i]]);
                    }
                    results.push(out);
                }
            }
            fs.writeFileSync(path.join(PKG, 'testdata', 'wasm_parity.json'), JSON.stringify({ cases: parity.cases, results }, null, 1) + '\n');
            console.log('recorded testdata/wasm_parity.json');
        }

        await t(`${build}: the Go original's outputs, bit for bit (testdata/wasm_parity.json)`, () => {
            let k = 0;
            for (const c of parity.cases) {
                assert.strictEqual(E.ac_reset(c.rate), 0);
                push(E, signal(c), c.packet);
                for (const w of c.windows) {
                    const want = parity.results[k++];
                    assert.strictEqual(E.ac_classify(w), 1, `${c.name}/${w}: no verdict`);
                    const got = result(E);
                    const where = `${c.name}/${w}`;
                    assert.strictEqual(got.label, want.label, where);
                    assert.strictEqual(got.confidence, want.confidence, where);
                    assert.strictEqual(got.seconds, want.seconds, where);
                    assert.deepStrictEqual(got.tags, want.tags, where);
                    assert.strictEqual(E.ac_buffered(), want.buffered, where + ' buffered');
                    if (want.label !== 'silent') {
                        const probs = f32(E, E.ac_probs(), 527);
                        const hidden = f32(E, E.ac_embedding(), 640);
                        if (sha(probs) !== want.probs_sha256) {
                            const worst = want.top.map(([i, p]) => Math.abs(probs[i] - p)).reduce((a, b) => Math.max(a, b));
                            assert.fail(`${where}: probabilities differ from Go's (top-10 max diff ${worst})`);
                        }
                        assert.strictEqual(sha(hidden), want.hidden_sha256, where + ' embedding');
                    }
                }
            }
        });

        await t(`${build}: PyTorch's reference outputs (chords)`, () => {
            const x16 = chords(16000, 20);
            wavRoundTrip(x16);
            const inp = E.ac_test_buffer(x16.length), out = E.ac_test_buffer(x16.length * 2 + 64);
            f32(E, inp, x16.length).set(x16);
            const n = E.ac_test_resample(inp, x16.length, 16000, 32000, out);
            assert.ok(n >= 320000, `resampled to ${n}`);
            const y = Float32Array.from(f32(E, out, 320000));
            wavRoundTrip(y);
            const win = E.ac_test_buffer(y.length);
            f32(E, win, y.length).set(y);
            assert.strictEqual(E.ac_window(win, y.length), 1);
            const frames = E.ac_mel_frames(y.length);
            assert.deepStrictEqual([128, frames], golden['chords/mel_shape']);
            let sum = 0;
            for (const v of f32(E, E.ac_mel(), 128 * frames)) sum += v;
            const want = golden['chords/mel_sum'];
            assert.ok(Math.abs(sum - want) <= 1e-4 * Math.abs(want) + 0.1, `mel sum ${sum}, PyTorch ${want}`);
            const probs = f32(E, E.ac_probs(), 527);
            for (const [i, p] of golden['chords/mn05']) {
                assert.ok(Math.abs(probs[i] - p) <= 5e-4, `class ${i}: ${probs[i]}, PyTorch ${p}`);
            }
        });

        await t(`${build}: the .pt reader (testdata/tiny_state_dict.pt)`, () => {
            const ptr = E.ac_model_buffer(tiny.length);
            new Uint8Array(E.memory.buffer, ptr, tiny.length).set(tiny);
            const n = E.ac_pt_open();
            assert.ok(n > 0, cstr(E, E.ac_error(), E.ac_error_len()));
            const T = {};
            for (let i = 0; i < n; i++) {
                const name = cstr(E, E.ac_pt_name(i), E.ac_pt_name_len(i));
                const shape = [];
                for (let d = 0; d < E.ac_pt_ndim(i); d++) shape.push(E.ac_pt_dim(i, d));
                const numel = E.ac_pt_numel(i);
                const data = new Float32Array(E.memory.buffer.slice(E.ac_pt_data(i), E.ac_pt_data(i) + 4 * numel));
                T[name] = { shape, data };
            }
            assert.deepStrictEqual(T['layer.weight'].shape, [2, 3]);
            assert.deepStrictEqual(Array.from(T['layer.weight'].data), [0, 1, 2, 3, 4, 5].map((i) => i / 4 - 0.5));
            assert.deepStrictEqual(Array.from(T['layer.bias'].data), [1.5, -2.25]);
            assert.deepStrictEqual(T.scalar.shape, []);
            assert.deepStrictEqual(Array.from(T.scalar.data), [3]);
            const big = T['big.weight'].data;
            assert.ok(big.length === 300 && big[0] === -1 && big[299] === 1);
            assert.ok(!('bn.num_batches_tracked' in T), 'an integer tensor was returned as float');
        });

        await t(`${build}: corrupt and truncated files are errors, never traps`, () => {
            let seed = 7;
            const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
            let errors = 0;
            for (let trial = 0; trial < 3000; trial++) {
                const b = Buffer.from(tiny);
                const flips = 1 + rnd(8);
                for (let f = 0; f < flips; f++) b[rnd(b.length)] = rnd(256);
                const cut = trial % 5 === 0 ? b.subarray(0, rnd(b.length)) : b;
                const ptr = E.ac_model_buffer(Math.max(1, cut.length));
                new Uint8Array(E.memory.buffer, ptr, cut.length).set(cut);
                if (E.ac_pt_open() < 0) errors++;
            }
            assert.ok(errors > 100, `only ${errors} of 3000 corruptions were noticed`);
            // The real file, cut short and with its headers and pickle damaged:
            for (let trial = 0; trial < 60; trial++) {
                const b = Buffer.from(model);
                if (trial % 3 === 0) {
                    const cut = b.subarray(0, rnd(b.length));
                    assert.notStrictEqual(loadModel(E, cut), '', 'a truncated model loaded');
                } else {
                    for (let f = 0; f < 4; f++) b[rnd(4096)] = rnd(256);
                    for (let f = 0; f < 4; f++) b[b.length - 1 - rnd(2048)] = rnd(256);
                    loadModel(E, b); // an error or a (garbled) model; either way, no trap
                }
            }
            assert.strictEqual(loadModel(E, model), '', 'the real model loads again afterwards');
            assert.match(loadModel(E, Buffer.alloc(16)), /pt|zip/);
            assert.strictEqual(loadModel(E, model), '');
        });

        await t(`${build}: the stream`, () => {
            // The ring keeps the newest ten seconds however much is pushed.
            E.ac_reset(12000);
            push(E, new Float32Array(12000 * 30), 1200);
            const b = E.ac_buffered();
            assert.ok(b >= 10 && b <= 20.1, `buffered ${b} s after 30 s`);
            // A retune forgets.
            E.ac_reset(24000);
            assert.strictEqual(E.ac_buffered(), 0);
            push(E, new Float32Array(24000), 2400);
            const n = E.ac_buffered() * 32000;
            assert.ok(n >= 31000 && n <= 32000, `${n} samples at 32 kHz from one second at 24 kHz`);
            // Too little audio is "ask again".
            E.ac_reset(12000);
            push(E, new Float32Array(12000 * 6), 1200);
            assert.strictEqual(E.ac_classify(10), 0);
            // Digital silence is not run through the model.
            assert.strictEqual(E.ac_classify(5), 1);
            assert.strictEqual(result(E).label, 'silent');
            // Pushes larger than the input buffer are cut to it, not overrun.
            E.ac_reset(48000);
            f32(E, E.ac_input(), E.ac_input_capacity()).fill(0.1);
            E.ac_push(E.ac_input_capacity() * 4);
            assert.ok(E.ac_buffered() > 0);
        });
    }

    console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ''}`);
    process.exitCode = fail ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

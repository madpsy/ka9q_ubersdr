// The audio classifier's worker, minus the Worker: the messages it answers,
// as a function of whatever posts them. worker.entry.js wires it to the
// worker's own scope; the tests wire it to a plain object and drive the real
// WebAssembly module through it under node.
//
// Messages in (from ./classifier.js):
//
//   { type: 'init', model: ArrayBuffer, signals: ArrayBuffer | null }
//                                         the weights (.pt) and the signal
//                                         references (signals.bin, see
//                                         ./signals.js); the module itself is
//                                         in this bundle
//   { type: 'reset', rate }               new stream rate, or a retune
//   { type: 'push', samples: Float32Array }
//   { type: 'classify', seconds, epoch }
//
// Messages out:
//
//   { type: 'ready', backend, signals }  or  { type: 'error', error }
//                                         signals: how many signals can be
//                                         named (0 without signals.bin)
//   { type: 'result', epoch, result }      result is null when too little audio is held
//
// A result is { label, confidence, tags: [{ label, score }], seconds, ms,
// signal }: label is voice, music, noise, or silent when the window held no
// audio worth classifying (then the model was not run and ms is 0); signal is
// what the windows since the last reset add up to (./signals.js
// scoreWindows), or null.
//
// The module is the C port in static/v2/native/audioclass, built twice and
// embedded here as base64 (./audioclass-wasm.generated.js): with WebAssembly
// SIMD when the engine has it (Chrome 91, Firefox 89, Safari 16.4 and later),
// without it otherwise. Both give the same numbers to the last bit.

import {
    AUDIOCLASS_WASM_ABI,
    AUDIOCLASS_WASM_SIMD,
    AUDIOCLASS_WASM_SCALAR,
} from './audioclass-wasm.generated.js';
import { parseSignals, createSignalTracker } from './signals.js';

// The smallest module that uses a SIMD instruction (i8x16.splat then
// i8x16.popcnt, which only the final SIMD proposal has): if it validates, the
// engine has WebAssembly SIMD as shipped. The same probe as pcm-v4-wasm.js.
const SIMD_PROBE = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0,
    65, 0, 253, 15, 253, 98, 11,
]);

export function audioClassSimdSupported() {
    try {
        return typeof WebAssembly === 'object' && WebAssembly.validate(SIMD_PROBE);
    } catch (e) {
        return false;
    }
}

function base64Bytes(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

const VERDICTS = ['voice', 'music', 'noise', 'silent'];
const decoder = new TextDecoder();

/**
 * The module, instantiated. `simd`: true or false to choose a build, or
 * undefined for the engine's best. Resolves to { exports, backend }.
 */
export async function instantiateAudioClass(simd) {
    const useSimd = simd === undefined ? audioClassSimdSupported() : !!simd;
    const bytes = base64Bytes(useSimd ? AUDIOCLASS_WASM_SIMD : AUDIOCLASS_WASM_SCALAR);
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const exports = instance.exports;
    if (exports.ac_abi() !== AUDIOCLASS_WASM_ABI) throw new Error('the classifier module is the wrong version');
    return { exports, backend: useSimd ? 'wasm-simd' : 'wasm-scalar' };
}

// The struct ac_classify fills (audioclass.h ac_result).
function readResult(E) {
    const v = new DataView(E.memory.buffer, E.ac_result(), 88);
    const label = VERDICTS[v.getInt32(0, true)] || 'noise';
    const ntags = v.getInt32(4, true);
    const tags = [];
    for (let i = 0; i < ntags && i < 5; i++) {
        const idx = v.getInt32(24 + 4 * i, true);
        const name = decoder.decode(new Uint8Array(E.memory.buffer, E.ac_label(idx), E.ac_label_len(idx)));
        tags.push({ label: name, score: v.getFloat64(48 + 8 * i, true) });
    }
    return { label, confidence: v.getFloat64(8, true), tags, seconds: v.getFloat64(16, true) };
}

const now = () => (typeof performance === 'object' && performance.now ? performance.now() : Date.now());

/**
 * `post` sends a message back. `opts.simd` forces a build (the tests run both).
 */
export function createWorkerHost(post, opts = {}) {
    let E = null;
    let failed = null;
    let tracker = null;

    async function init(msg) {
        try {
            const { exports, backend } = await instantiateAudioClass(opts.simd);
            const model = new Uint8Array(msg.model || new ArrayBuffer(0));
            const ptr = exports.ac_model_buffer(Math.max(1, model.length));
            if (!ptr) throw new Error('not enough memory for the model');
            new Uint8Array(exports.memory.buffer, ptr, model.length).set(model);
            if (exports.ac_load() !== 0) {
                const p = exports.ac_error(), n = exports.ac_error_len();
                throw new Error(decoder.decode(new Uint8Array(exports.memory.buffer, p, n)));
            }
            E = exports;
            // Naming signals is extra: without the file (or with a bad one)
            // the classifier still says VOICE / MUSIC / NOISE.
            tracker = null;
            let signals = 0;
            if (msg.signals) {
                try {
                    const ref = parseSignals(msg.signals);
                    if (ref.D === exports.ac_embedding_size()) {
                        tracker = createSignalTracker(ref);
                        signals = ref.S;
                    }
                } catch (e) {
                    tracker = null;
                }
            }
            post({ type: 'ready', backend, signals });
        } catch (e) {
            failed = String((e && e.message) || e);
            E = null;
            post({ type: 'error', error: failed });
        }
    }

    function push(s) {
        const cap = E.ac_input_capacity();
        for (let off = 0; off < s.length; off += cap) {
            const n = Math.min(cap, s.length - off);
            // A view per copy: the module's memory may have grown (and its
            // buffer been replaced) since the last one.
            new Float32Array(E.memory.buffer, E.ac_input(), n).set(s.subarray(off, off + n));
            E.ac_push(n);
        }
    }

    return function onMessage(msg) {
        if (!msg || typeof msg !== 'object') return undefined;
        if (msg.type === 'init') return init(msg);
        if (!E) return undefined;
        switch (msg.type) {
            case 'reset':
                E.ac_reset(msg.rate | 0);
                if (tracker) tracker.clear();
                break;
            case 'push': {
                const s = msg.samples;
                if (s && s.length) push(s);
                break;
            }
            case 'classify': {
                let result = null;
                try {
                    const t0 = now();
                    if (E.ac_classify(Number(msg.seconds) || 0)) {
                        result = readResult(E);
                        if (tracker && result.label !== 'silent') {
                            tracker.add(new Float32Array(E.memory.buffer, E.ac_embedding(), E.ac_embedding_size()), result);
                        }
                        result.ms = result.label === 'silent' ? 0 : Math.round((now() - t0) * 1000) / 1000;
                        result.signal = tracker ? tracker.score() : null;
                    }
                } catch (e) {
                    result = null;
                }
                post({ type: 'result', epoch: msg.epoch, result });
                break;
            }
            default:
        }
        return undefined;
    };
}

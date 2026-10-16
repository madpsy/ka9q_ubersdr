// The browser's Whisper module under node, over a recording, as the worker
// drives it: 100 ms of audio at a time, an interim offered whenever nothing is
// waiting. Prints every line with the audio time it arrived at and what each
// call cost.
//
//   node run.js MODULE_DIR MODEL VAD_MODEL WAV|F32 [lang] [--realtime]
//
// MODULE_DIR holds whisper-stt.js and .wasm (../../build.sh --only=wasm writes
// them to static/v2/whisper/). WAV is 16 kHz mono PCM16; a .f32 file is raw
// float samples at 16 kHz. --realtime paces the audio as a receiver would and
// reports how far behind it fell.
'use strict';
const fs = require('fs');
const path = require('path');

const [dir, modelPath, vadPath, audioPath, langArg] = process.argv.slice(2);
const realtime = process.argv.includes('--realtime');
if (!dir || !modelPath || !vadPath || !audioPath) {
    console.error('usage: node run.js MODULE_DIR MODEL VAD_MODEL WAV|F32 [lang] [--realtime]');
    process.exit(2);
}

function readAudio(p) {
    const b = fs.readFileSync(p);
    if (p.endsWith('.f32')) return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
    // The data chunk of a 16 kHz mono PCM16 WAV.
    let o = 12;
    while (o + 8 <= b.length) {
        const id = b.toString('ascii', o, o + 4);
        const n = b.readUInt32LE(o + 4);
        if (id === 'data') {
            const out = new Float32Array(n / 2);
            for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(o + 8 + i * 2) / 32768;
            return out;
        }
        o += 8 + n + (n & 1);
    }
    throw new Error('no data chunk in ' + p);
}

(async () => {
    const factory = require(path.resolve(dir, 'whisper-stt.js'));
    const lines = [];
    let clock = 0;
    let t0 = Date.now();
    let queued = 0;
    const M = await factory({
        locateFile: (f) => path.resolve(dir, f),
        onLine: (l) => { lines.push({ at: clock, msg: JSON.parse(l) }); report(lines[lines.length - 1]); },
        onNote: (n) => { if (process.env.VERBOSE) process.stderr.write('note: ' + n + (n.endsWith('\n') ? '' : '\n')); },
        backlog: () => queued,
    });
    M._stt_init(process.env.VERBOSE ? 1 : 0);
    const load = (fn, p) => {
        const b = fs.readFileSync(p);
        const ptr = M._malloc(b.length);
        M.HEAPU8.set(b, ptr);
        const t = Date.now();
        const rc = fn(ptr, b.length);
        M._free(ptr);
        if (rc !== 0) throw new Error('could not load ' + p);
        return Date.now() - t;
    };
    console.log(`vad ${load(M._stt_load_vad, vadPath)} ms, model ${load(M._stt_load_model, modelPath)} ms, multilingual ${M._stt_multilingual()}`);
    const langs = JSON.parse(M.UTF8ToString(M._stt_languages()));
    console.log(`${langs.length} languages, e.g. ${langs.slice(0, 6).join(' ')} … jv:${langs.includes('jv')}`);

    const pcm = readAudio(audioPath);
    const lang = langArg && !langArg.startsWith('--') ? langArg : 'en';
    const FRAME = 1600;
    const ptr = M._malloc(FRAME * 4);
    t0 = Date.now();
    M.ccall('stt_start', 'number', ['string'], [JSON.stringify({ lang, session: 1 })]);
    let worst = 0;
    function report(l) {
        const m = l.msg;
        const behind = realtime ? ((Date.now() - t0) / 1000 - l.at).toFixed(1) : '';
        if (m.type === 'result') console.log(`${l.at.toFixed(1).padStart(6)} s ${m.final ? 'FINAL  ' : 'interim'} ${behind && `(+${behind} s)`} ${m.text}`);
        else console.log(`${l.at.toFixed(1).padStart(6)} s ${JSON.stringify(m)}`);
    }
    for (let i = 0; i + FRAME <= pcm.length; i += FRAME) {
        clock = (i + FRAME) / 16000;
        if (realtime) {
            // How much audio would be waiting by now, had a receiver been
            // sending it all along.
            const due = (Date.now() - t0) / 1000;
            queued = Math.max(0, Math.round((due - clock) * 16000));
            worst = Math.max(worst, due - clock);
            const ahead = clock - due;
            if (ahead > 0) await new Promise((r) => setTimeout(r, ahead * 1000));
        }
        new Float32Array(M.HEAPF32.buffer, ptr, FRAME).set(pcm.subarray(i, i + FRAME));
        M._stt_audio(ptr, FRAME, 0);
        if (!queued) M._stt_interim();
    }
    // A second of silence, so the last utterance ends.
    new Float32Array(M.HEAPF32.buffer, ptr, FRAME).fill(0);
    for (let k = 0; k < 10; k++) { clock += 0.1; M._stt_audio(ptr, FRAME, 0); }
    M._stt_stop();
    const took = (Date.now() - t0) / 1000;
    const finals = lines.filter((l) => l.msg.type === 'result' && l.msg.final).length;
    const interims = lines.filter((l) => l.msg.type === 'result' && !l.msg.final).length;
    console.log(`${(pcm.length / 16000).toFixed(1)} s of audio in ${took.toFixed(1)} s (RTF ${(took / (pcm.length / 16000)).toFixed(2)}); ${finals} finals, ${interims} interims${realtime ? `; at worst ${worst.toFixed(1)} s behind` : ''}`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

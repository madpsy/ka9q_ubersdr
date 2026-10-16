// Full-window finals against sized ones, on the same audio at the same time.
//
//   node ab.js [file.wav] [lang]
//
// Two helpers, one as the desktop client runs it and one with --sized-finals
// (the browser build's setting: Whisper's encoder sized to the utterance rather
// than its 30 s window), fed one recording in real time, 100 ms at a time, side
// by side. Prints each one's finals as they come and, at the end, what each
// final cost — from the helpers' own --verbose accounts — and when the last
// arrived. For deciding whether the desktop should switch: the browser has to,
// and measured 5-15x cheaper there; this asks whether the words hold up.
//
// The audio: a 16 kHz mono WAV, by default test/fixtures/speech.wav (record.sh
// makes one off the air). WHISPER_HELPER / WHISPER_MODEL / WHISPER_VAD_MODEL /
// WHISPER_THREADS as for live.js. Not part of run.sh: it is a measurement.
'use strict';
const path = require('path');
const { Helper, RATE, paths, readWav, silence, concat } = require('./protocol.js');

const WAV = process.argv[2] || path.join(__dirname, 'fixtures', 'speech.wav');
const LANG = process.argv[3] || 'en';
const FRAME_SAMPLES = RATE / 10;

const base = ['--model', paths.model, '--vad-model', paths.vad, '--verbose'];
if (process.env.WHISPER_THREADS) base.push('--threads', process.env.WHISPER_THREADS);
const runs = [
    { name: 'full ', h: new Helper({ args: base }) },
    { name: 'sized', h: new Helper({ args: [...base, '--sized-finals'] }) },
];

(async () => {
    await Promise.all(runs.map((r) => r.h.waitFor((m) => m.type === 'ready', 30000, 'ready')));
    const pcm = concat(readWav(WAV), silence(2));
    const t0 = Date.now();
    for (const r of runs) r.h.start(LANG, 1);
    for (let i = 0; i < pcm.length; i += FRAME_SAMPLES) {
        const at = (i / RATE) * 1000;
        const wait = t0 + at - Date.now();
        // eslint-disable-next-line no-await-in-loop
        if (wait > 0) await new Promise((res) => setTimeout(res, wait));
        const chunk = pcm.subarray(i, i + FRAME_SAMPLES);
        const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        for (const r of runs) r.h.audio(buf);
    }
    // Time for the last final to come.
    await new Promise((res) => setTimeout(res, 15000));
    for (const r of runs) {
        const finals = r.h.messages((m) => m.type === 'result' && m.final);
        const costs = [...r.h.stderr.matchAll(/final .*-> ([0-9.]+) s/g)].map((m) => Number(m[1]));
        const total = costs.reduce((a, b) => a + b, 0);
        const rejected = (r.h.stderr.match(/final .*REJECTED/g) || []).length;
        const fellBack = (r.h.stderr.match(/settled on the last interim/g) || []).length;
        console.log(`\n== ${r.name}: ${finals.length} finals; decode ${total.toFixed(2)} s total, ` +
            `${costs.length ? (total / costs.length).toFixed(2) : '-'} s each, worst ${Math.max(0, ...costs).toFixed(2)} s; ` +
            `${rejected} rejected, ${fellBack} fell back on the interim`);
        for (const f of finals) console.log(`  ${(f.t / 1000).toFixed(1).padStart(6)} s  ${f.msg.text}`);
        r.h.end();
    }
    process.exit(0);
})().catch((e) => { console.error(e); for (const r of runs) r.h.kill(); process.exit(1); });

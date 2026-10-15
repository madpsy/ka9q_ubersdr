// The real whisper-helper, with the real models, driven over its protocol the
// way the desktop client drives it.
//
//   node helper.test.js
//
// Needs a built helper and the models (../build.sh --only=linux-x64,models, or
// WHISPER_HELPER / WHISPER_MODEL / WHISPER_VAD_MODEL), and speech to transcribe:
// WHISPER_TEST_WAV, or test/fixtures/speech.wav as record.sh makes it — 16 kHz
// mono, ten seconds or so of somebody talking. Off-air audio is the point:
// Whisper on a clean studio sample proves less about a receiver than Whisper on
// an AM broadcast does.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Helper, FRAME, RATE, paths, readWav, silence, noise, concat } = require('./protocol.js');

const SPEECH = process.env.WHISPER_TEST_WAV || path.join(__dirname, 'fixtures', 'speech.wav');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const [what, p] of Object.entries({ helper: paths.helper, model: paths.model, 'VAD model': paths.vad, speech: SPEECH })) {
    if (!fs.existsSync(p)) {
        console.error(`no ${what} at ${p} — see the top of this file`);
        process.exit(1);
    }
}
const speech = readWav(SPEECH);

const tests = [];
const t = (name, fn) => tests.push({ name, fn });
const live = [];
function helper(opts) {
    const h = new Helper(opts);
    live.push(h);
    return h;
}
const ready = (h) => h.waitFor((m) => m.type === 'ready', 15000, 'ready');
const results = (h, session) => h.messages((m) => m.type === 'result' && (session == null || m.session === session));

// ── The command line ─────────────────────────────────────────────────────────

t('--version names the helper, whisper.cpp and the build', async () => {
    const h = helper({ args: ['--version'] });
    const { code } = await h.exited;
    assert.strictEqual(code, 0);
    assert.match(h.lines[0].msg.line, /^whisper-helper \d+ \(whisper\.cpp \S+ [0-9a-f]{40}, \w+\)$/);
    console.log(`      ${h.lines[0].msg.line}`);
});

t('--languages prints Whisper\'s codes as JSON', async () => {
    const h = helper({ args: ['--languages'] });
    assert.strictEqual((await h.exited).code, 0);
    const langs = h.messages()[0].msg;
    assert.ok(Array.isArray(langs) && langs.length >= 99, `got ${langs.length}`);
    for (const c of ['en', 'de', 'zh', 'ja', 'yue']) assert.ok(langs.includes(c), c);
});

t('bad arguments: usage, exit 1', async () => {
    const h = helper({ args: ['--model'] });
    const { code } = await h.exited;
    assert.strictEqual(code, 1);
    assert.match(h.stderr, /usage/);
});

// ── Models ───────────────────────────────────────────────────────────────────

t('a missing model is a fatal error on stdout, exit 2', async () => {
    const h = helper({ args: ['--model', '/nonexistent/ggml-base-q5_1.bin', '--vad-model', paths.vad] });
    const { code } = await h.exited;
    assert.strictEqual(code, 2);
    const errs = h.messages((m) => m.type === 'error');
    assert.strictEqual(errs.length, 1);
    assert.deepStrictEqual({ ...errs[0].msg, message: undefined },
        { type: 'error', session: null, code: 'model-missing', message: undefined, fatal: true });
    assert.match(errs[0].msg.message, /nonexistent/);
    assert.strictEqual(h.messages((m) => m.type === 'ready').length, 0);
});

t('a missing VAD model likewise', async () => {
    const h = helper({ args: ['--model', paths.model, '--vad-model', '/nonexistent/vad.bin'] });
    const { code } = await h.exited;
    assert.strictEqual(code, 2);
    assert.strictEqual(h.messages((m) => m.type === 'error' && m.code === 'vad-model-missing' && m.fatal).length, 1);
});

t('a file that is not a model: model-invalid, exit 2', async () => {
    const junk = path.join(os.tmpdir(), `whisper-junk-${process.pid}.bin`);
    fs.writeFileSync(junk, Buffer.alloc(4096, 7));
    try {
        const h = helper({ args: ['--model', junk, '--vad-model', paths.vad] });
        const { code } = await h.exited;
        assert.strictEqual(code, 2);
        assert.strictEqual(h.messages((m) => m.type === 'error' && m.code === 'model-invalid' && m.fatal).length, 1);
    } finally {
        fs.unlinkSync(junk);
    }
});

// ── Sessions ─────────────────────────────────────────────────────────────────

t('an unknown language: fatal for that session, the process carries on', async () => {
    const h = helper();
    await ready(h);
    h.start('xx', 5);
    const e = await h.waitFor((m) => m.type === 'error', 5000, 'the error');
    assert.deepStrictEqual({ ...e.msg, message: undefined },
        { type: 'error', session: 5, code: 'language-not-supported', message: undefined, fatal: true });
    assert.strictEqual(h.messages((m) => m.type === 'started').length, 0);
    h.start('de-DE', 6);
    await h.waitFor((m) => m.type === 'started' && m.session === 6, 5000, 'started 6');
    h.end();
    assert.strictEqual((await h.exited).code, 0);
});

t('speech in real time: interims, then a final that settles them', async () => {
    const h = helper();
    await ready(h);
    h.start('en', 1);
    await h.waitFor((m) => m.type === 'started' && m.session === 1, 5000, 'started');
    const began = h.now();
    await h.play(speech, 1);
    await h.play(silence(1.5), 1);
    await h.waitFor((m) => m.type === 'result' && m.final, 15000, 'a final');
    await sleep(1500);
    const rs = results(h, 1);
    const finals = rs.filter((r) => r.msg.final);
    const interims = rs.filter((r) => !r.msg.final);
    console.log(`      ${interims.length} interim(s), ${finals.length} final(s); first result ${((rs[0].t - began) / 1000).toFixed(1)} s in`);
    for (const r of rs) console.log(`        ${((r.t - began) / 1000).toFixed(1).padStart(5)} s ${r.msg.final ? 'FINAL  ' : 'interim'} ${r.msg.text}`);
    assert.ok(interims.length >= 1, 'no interim in ten seconds of speech');
    for (const f of finals) assert.ok(f.msg.text.split(/\s+/).length >= 2, `a thin final: ${f.msg.text}`);
    // Every interim belongs to an utterance a final then settled: none comes
    // after the last final.
    assert.ok(interims[interims.length - 1].t < finals[finals.length - 1].t);
    for (let i = 1; i < finals.length; i++) assert.notStrictEqual(finals[i].msg.text, finals[i - 1].msg.text);
    assert.strictEqual(h.messages((m) => m.type === 'unparseable').length, 0);
    h.end();
    assert.strictEqual((await h.exited).code, 0);
});

t('noise and silence: nothing at all', async () => {
    const h = helper();
    await ready(h);
    h.start('en', 2);
    await h.play(concat(silence(3), noise(12, -38), noise(4, -55), silence(3)), 4);
    await sleep(3000);
    assert.deepStrictEqual(results(h).map((r) => r.msg.text), []);
    assert.deepStrictEqual(h.messages((m) => m.type === 'error'), []);
    h.end();
    await h.exited;
});

t('RESET drops the utterance in progress and the session carries on', async () => {
    const h = helper();
    await ready(h);
    h.start('en', 3);
    await h.play(speech.subarray(0, 4 * RATE), 1);
    h.reset();
    const resetAt = h.now();
    await h.play(silence(2), 1);
    await sleep(1500);
    // Anything already on its way when RESET was written may land; nothing
    // after that.
    const late = results(h).filter((r) => r.t > resetAt + 100);
    assert.deepStrictEqual(late.map((r) => r.msg.text), []);
    // Still listening: the same speech again, in frames split mid-sample to
    // check the odd byte is carried over.
    const bytes = Buffer.from(concat(speech, silence(1.5)).buffer);
    const step = 3201;
    const begin = Date.now();
    for (let i = 0; i < bytes.length; i += step) {
        h.send(FRAME.AUDIO, bytes.subarray(i, Math.min(bytes.length, i + step)));
        const due = begin + ((i + step) / 2 / RATE) * 1000;
        if (due > Date.now()) await sleep(due - Date.now());
    }
    const f = await h.waitFor((m, at) => m.type === 'result' && m.final && at > resetAt + 100, 15000, 'a final after the reset');
    assert.strictEqual(f.msg.session, 3);
    h.end();
    await h.exited;
});

t('STOP: no more output for the session; START begins another', async () => {
    const h = helper();
    await ready(h);
    h.start('en', 4);
    await h.play(speech.subarray(0, 5 * RATE), 2);
    h.stop();
    const stopAt = h.now();
    await h.play(concat(speech.subarray(5 * RATE), silence(2)), 4);
    await sleep(2500);
    assert.deepStrictEqual(results(h).filter((r) => r.t > stopAt + 100).map((r) => r.msg.text), []);
    h.start('auto', 7);
    await h.waitFor((m) => m.type === 'started' && m.session === 7, 5000, 'started 7');
    await h.play(concat(speech, silence(1.5)), 2);
    const f = await h.waitFor((m) => m.type === 'result' && m.final, 15000, 'a final in session 7', 0);
    assert.strictEqual(f.msg.session, 7);
    assert.deepStrictEqual([...new Set(results(h).filter((r) => r.t > stopAt + 100).map((r) => r.msg.session))], [7]);
    h.end();
    await h.exited;
});

t('end of input mid-transcription: exit 0, at once', async () => {
    const h = helper();
    await ready(h);
    h.start('en', 8);
    // All at once, so the worker is busy when the input ends.
    await h.play(concat(speech, silence(1)), Infinity);
    await sleep(300);
    const endAt = h.now();
    h.end();
    const { code, t: exitAt } = await h.exited;
    assert.strictEqual(code, 0);
    assert.ok(exitAt - endAt < 2000, `took ${exitAt - endAt} ms to exit`);
});

t('falling behind: the oldest audio goes, said once, and it keeps working', async () => {
    const h = helper();
    await ready(h);
    h.start('en', 9);
    // Thirty seconds at once: ten more than it will hold.
    await h.play(concat(speech, speech, speech, speech.subarray(0, 2 * RATE)), Infinity);
    const e = await h.waitFor((m) => m.type === 'error', 5000, 'falling-behind');
    assert.deepStrictEqual({ ...e.msg, message: undefined },
        { type: 'error', session: 9, code: 'falling-behind', message: undefined, fatal: false });
    await h.play(concat(speech, speech, speech), Infinity);
    await h.play(silence(1.5), Infinity);
    await h.waitFor((m) => m.type === 'result' && m.final, 30000, 'a final');
    assert.strictEqual(h.messages((m) => m.type === 'error').length, 1, 'said more than once');
    h.end();
    await h.exited;
});

t('an unknown frame type is skipped with a warning', async () => {
    const h = helper();
    await ready(h);
    h.send(9, Buffer.from('hello'));
    const e = await h.waitFor((m) => m.type === 'error', 5000, 'the warning');
    assert.strictEqual(e.msg.code, 'protocol');
    assert.strictEqual(e.msg.fatal, false);
    h.start('en', 10);
    await h.waitFor((m) => m.type === 'started' && m.session === 10, 5000, 'started');
    h.end();
    await h.exited;
});

t('a frame length that cannot be right is fatal, exit 3', async () => {
    const h = helper();
    await ready(h);
    const head = Buffer.alloc(5);
    head[0] = FRAME.AUDIO;
    head.writeUInt32LE(0xfffffff0, 1);
    h.proc.stdin.write(head);
    const { code } = await h.exited;
    assert.strictEqual(code, 3);
    assert.strictEqual(h.messages((m) => m.type === 'error' && m.code === 'protocol' && m.fatal).length, 1);
});

(async () => {
    let pass = 0;
    for (const { name, fn } of tests) {
        try {
            await fn();
            pass++;
            console.log(`  ok   ${name}`);
        } catch (e) {
            console.log(`  FAIL ${name}\n${e.stack}`);
            const h = live[live.length - 1];
            if (h) console.log(`--- helper stderr ---\n${h.stderr.slice(-3000)}`);
            for (const x of live) x.kill();
            console.log(`${pass} passed, 1 failed`);
            process.exit(1);
        }
        for (const x of live) x.kill();
        live.length = 0;
    }
    console.log(`${pass} passed`);
})();

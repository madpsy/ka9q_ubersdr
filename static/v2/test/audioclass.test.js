// The audio classifier: VOICE / MUSIC / NOISE above the spectrum
// (src/lib/audioClass/, components/AudioClassTag.jsx, AudioClassWatch.jsx).
//
// What matters here is what nobody would notice going wrong until a listener did:
//
//   * **It is mode-aware.** Only SSB, AM and FM carry audio worth classifying;
//     CW, IQ and anything else load nothing and show nothing.
//   * **It costs nothing until it is used.** Nothing is fetched before audio
//     plays in such a mode, and turning it off unloads the worker.
//   * **A retune forgets.** No verdict spans two signals, but fine-tuning the
//     one being listened to does not throw its verdicts away.
//   * **A failure is quiet.** It is on by default, so a receiver that cannot
//     serve the files must not put a fault badge in front of every listener;
//     the Display panel says why instead.
//   * **The committed module and model actually classify**, through the same
//     message handling the worker runs, under node.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.window = global.window || {};
const A = require('./.build/audioclass.cjs');
const { verdict: V, classifier: C } = A;

const V2 = path.resolve(__dirname, '..');

let pass = 0;
let chain = Promise.resolve();
const t = (name, fn) => {
    chain = chain.then(async () => {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + (e && e.stack || e)); process.exitCode = 1; }
    });
};

const r = (label, extra = {}) => ({ label, confidence: 0.8, tags: [], seconds: 5, ms: 120, ...extra });

// ── what the verdicts mean ───────────────────────────────────────────────────

t('only SSB, AM and FM are classified', () => {
    for (const m of ['usb', 'lsb', 'am', 'sam', 'fm', 'nfm', 'USB']) assert.ok(V.classifiableMode(m), m);
    for (const m of ['cwu', 'cwl', 'iq', 'iq48', 'iq384', '', null, 'drm']) assert.ok(!V.classifiableMode(m), String(m));
});

t('the badge is the majority of the last three, else the latest', () => {
    assert.strictEqual(V.smoothLabel([]), null);
    assert.strictEqual(V.smoothLabel([r('voice')]), 'voice');
    // One pause between words does not flip a conversation to noise.
    assert.strictEqual(V.smoothLabel([r('voice'), r('noise'), r('voice')]), 'voice');
    assert.strictEqual(V.smoothLabel([r('voice'), r('voice'), r('noise')]), 'voice');
    // Only the last three count.
    assert.strictEqual(V.smoothLabel([r('voice'), r('voice'), r('music'), r('music'), r('noise')]), 'music');
    // No majority: the latest.
    assert.strictEqual(V.smoothLabel([r('voice'), r('music'), r('noise')]), 'noise');
});

t('no badge until the classifier is ready and has a verdict', () => {
    assert.strictEqual(V.badge(null), null);
    for (const status of ['off', 'idle', 'loading', 'error']) {
        assert.strictEqual(V.badge({ status, history: [r('voice')] }), null, status);
    }
    assert.strictEqual(V.badge({ status: 'ready', history: [] }), null);
});

t('the badge text is short and the tooltip carries the rest', () => {
    const b = V.badge({ status: 'ready', history: [r('voice', { confidence: 0.87, tags: [{ label: 'Speech', score: 0.87 }, { label: 'Radio', score: 0.79 }] })] });
    assert.strictEqual(b.text, 'VOICE');
    assert.strictEqual(b.tone, 'good');
    assert.match(b.title, /87% likely/);
    assert.match(b.title, /Heard: Speech 87%, Radio 79%/);
    assert.match(b.title, /in 120 ms/);
    assert.match(b.title, /Click to switch it off/);
    assert.strictEqual(V.badge({ status: 'ready', history: [r('music')] }).text, 'MUSIC');
    assert.strictEqual(V.badge({ status: 'ready', history: [r('noise')] }).tone, 'ghost');
    for (const l of ['voice', 'music', 'noise']) {
        assert.ok(V.badge({ status: 'ready', history: [r(l)] }).text.length <= 5, l);
    }
});

t('a closed squelch keeps the last verdict, dimmed, and says so', () => {
    const b = V.badge({ status: 'ready', quiet: true, history: [r('voice')] });
    assert.strictEqual(b.text, 'VOICE');
    assert.strictEqual(b.tone, 'ghost');
    assert.match(b.title, /Nothing is coming through now/);
});

t('the Display panel hint says what it is doing, or why not', () => {
    assert.strictEqual(V.statusText({ status: 'off' }, 'usb'), '');
    assert.match(V.statusText({ status: 'idle' }, 'usb'), /Starts when audio is playing/);
    assert.match(V.statusText({ status: 'loading' }, 'usb'), /10 MB/);
    assert.match(V.statusText({ status: 'error', error: 'HTTP 404' }, 'usb'), /Not available: HTTP 404/);
    assert.match(V.statusText({ status: 'ready', history: [] }, 'cwu'), /SSB, AM or FM/);
    assert.match(V.statusText({ status: 'ready', history: [] }, 'usb'), /first verdict after 5 s/);
    assert.strictEqual(V.statusText({ status: 'ready', history: [r('voice')] }, 'usb'), '');
});

// ── the engine, with a fake worker, network, clock and player ────────────────

function rig({ fetchFails } = {}) {
    const posted = [];
    const fetched = [];
    let worker = null;
    let terminated = 0;
    const timers = new Map();
    let nextTimer = 1;
    const tap = new Set();
    const player = { onAudio(fn) { tap.add(fn); return () => tap.delete(fn); } };
    const c = C.createAudioClassifier({
        createWorker(url) {
            assert.strictEqual(url, C.WORKER_URL);
            worker = {
                postMessage(msg, transfer) { posted.push({ msg, transfer }); },
                terminate() { terminated++; },
            };
            return worker;
        },
        fetch(url) {
            fetched.push(url);
            if (fetchFails) return Promise.resolve({ ok: false, status: 404 });
            return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
        },
        setInterval(fn, ms) { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
        clearInterval(id) { timers.delete(id); },
    });
    return {
        c, player, posted, fetched, timers, tap,
        get worker() { return worker; },
        get terminated() { return terminated; },
        reply(msg) { worker.onmessage({ data: msg }); },
        play(frames, rate, value = 0.1, channels = 1) {
            const planes = Array.from({ length: channels }, () => new Float32Array(frames).fill(value));
            for (const fn of Array.from(tap)) fn(planes, frames, rate);
        },
        tick() { for (const { fn } of timers.values()) fn(); },
        types() { return posted.map((p) => p.msg.type); },
    };
}

const flush = () => new Promise((res) => setImmediate(res));

t('off: nothing is fetched or started', async () => {
    const x = rig();
    x.c.configure({ enabled: false, listening: true, player: x.player, mode: 'usb', freq: 14200000 });
    await flush();
    assert.strictEqual(x.worker, null);
    assert.deepStrictEqual(x.fetched, []);
    assert.strictEqual(x.c.getState().status, 'off');
});

t('on but not listening (stopped, hidden, or a CW/IQ mode): still nothing fetched', async () => {
    const x = rig();
    x.c.configure({ enabled: true, listening: false, player: x.player, mode: 'cwu', freq: 14000000 });
    await flush();
    assert.strictEqual(x.worker, null);
    assert.deepStrictEqual(x.fetched, []);
    assert.strictEqual(x.c.getState().status, 'idle');
});

t('listening: loads the module and model from the receiver, then taps the audio', async () => {
    const x = rig();
    x.c.configure({ enabled: true, listening: true, player: x.player, mode: 'usb', freq: 14200000 });
    assert.strictEqual(x.c.getState().status, 'loading');
    await flush(); await flush();
    assert.deepStrictEqual(x.fetched.sort(), [C.MODEL_URL, C.WASM_URL].sort());
    // Both relative to the page: nothing comes from anywhere but the receiver.
    for (const u of x.fetched) assert.ok(!/^[a-z]+:\/\//i.test(u) && !u.startsWith('/'), u);
    assert.deepStrictEqual(x.types(), ['init']);
    assert.strictEqual(x.posted[0].transfer.length, 2, 'both buffers transferred, not copied');
    assert.strictEqual(x.tap.size, 0, 'no tap before the model is loaded');
    x.reply({ type: 'ready' });
    assert.strictEqual(x.c.getState().status, 'ready');
    assert.strictEqual(x.tap.size, 1);
    assert.strictEqual(x.timers.size, 1);
    assert.strictEqual([...x.timers.values()][0].ms, V.HOP_MS);
});

async function ready(opts) {
    const x = rig(opts);
    x.c.configure({ enabled: true, listening: true, player: x.player, mode: 'usb', freq: 14200000 });
    await flush(); await flush();
    x.reply({ type: 'ready' });
    x.posted.length = 0;
    return x;
}

t('audio goes to the worker as mono, 100 ms at a time, after a reset to its rate', async () => {
    const x = await ready();
    // Five 20 ms packets at 12 kHz, as a duplicated stereo pair.
    for (let i = 0; i < 5; i++) x.play(240, 12000, 0.25, 2);
    assert.deepStrictEqual(x.types(), ['reset', 'push']);
    assert.strictEqual(x.posted[0].msg.rate, 12000);
    const s = x.posted[1].msg.samples;
    assert.strictEqual(s.length, 1200);
    assert.ok(s.every((v) => Math.abs(v - 0.25) < 1e-7));
    assert.deepStrictEqual(x.posted[1].transfer, [s.buffer]);
});

t('a verdict lands in the history; one from before a retune is dropped', async () => {
    const x = await ready();
    x.play(1200, 12000);
    x.tick();
    const ask = x.posted.find((p) => p.msg.type === 'classify').msg;
    assert.strictEqual(ask.seconds, V.WINDOW_SEC);
    // Busy: no second question while the first is unanswered.
    x.tick();
    assert.strictEqual(x.posted.filter((p) => p.msg.type === 'classify').length, 1);
    x.reply({ type: 'result', epoch: ask.epoch, result: r('voice') });
    assert.deepStrictEqual(x.c.getState().history.map((h) => h.label), ['voice']);

    // Retune well away: the history goes, and the answer to a question asked
    // before the retune is not believed.
    x.play(1200, 12000);
    x.tick();
    const stale = x.posted.filter((p) => p.msg.type === 'classify').pop().msg;
    x.c.configure({ enabled: true, listening: true, player: x.player, mode: 'usb', freq: 14200000 + C.RETUNE_HZ + 1 });
    assert.deepStrictEqual(x.c.getState().history, []);
    x.reply({ type: 'result', epoch: stale.epoch, result: r('music') });
    assert.deepStrictEqual(x.c.getState().history, []);
});

t('fine-tuning the same signal keeps its verdicts', async () => {
    const x = await ready();
    x.play(1200, 12000);
    x.tick();
    const ask = x.posted.find((p) => p.msg.type === 'classify').msg;
    x.reply({ type: 'result', epoch: ask.epoch, result: r('voice') });
    x.c.configure({ enabled: true, listening: true, player: x.player, mode: 'usb', freq: 14200000 + 100 });
    assert.deepStrictEqual(x.c.getState().history.map((h) => h.label), ['voice']);
});

t('silence keeps the last verdict, marked quiet; audio clears the mark', async () => {
    const x = await ready();
    x.play(1200, 12000);
    const answer = (result) => {
        x.tick();
        const ask = x.posted.filter((p) => p.msg.type === 'classify').pop().msg;
        x.reply({ type: 'result', epoch: ask.epoch, result });
    };
    answer(r('voice'));
    answer({ label: 'silent', confidence: 0, tags: [], seconds: 5, ms: 0 });
    assert.strictEqual(x.c.getState().quiet, true);
    assert.deepStrictEqual(x.c.getState().history.map((h) => h.label), ['voice']);
    answer(r('voice'));
    assert.strictEqual(x.c.getState().quiet, false);
});

t('switching to CW stops listening and forgets', async () => {
    const x = await ready();
    x.play(1200, 12000);
    x.tick();
    const ask = x.posted.find((p) => p.msg.type === 'classify').msg;
    x.reply({ type: 'result', epoch: ask.epoch, result: r('voice') });
    x.c.configure({ enabled: true, listening: false, player: x.player, mode: 'cwu', freq: 14200000 });
    assert.strictEqual(x.tap.size, 0);
    assert.strictEqual(x.timers.size, 0);
    assert.deepStrictEqual(x.c.getState().history, []);
    assert.strictEqual(x.terminated, 0, 'the model stays loaded for the way back');
});

t('switching it off unloads the worker', async () => {
    const x = await ready();
    x.c.configure({ enabled: false, listening: true, player: x.player, mode: 'usb', freq: 14200000 });
    assert.strictEqual(x.terminated, 1);
    assert.strictEqual(x.tap.size, 0);
    assert.strictEqual(x.timers.size, 0);
    assert.strictEqual(x.c.getState().status, 'off');
});

t('a receiver that cannot serve the files: error, no badge, the hint says why', async () => {
    const x = rig({ fetchFails: true });
    x.c.configure({ enabled: true, listening: true, player: x.player, mode: 'usb', freq: 14200000 });
    await flush(); await flush();
    const s = x.c.getState();
    assert.strictEqual(s.status, 'error');
    assert.match(s.error, /HTTP 404/);
    assert.strictEqual(V.badge(s), null);
    assert.match(V.statusText(s, 'usb'), /Not available/);
    assert.strictEqual(x.terminated, 1);
    // Not retried on every render; switching off and on again does.
    x.c.configure({ enabled: true, listening: true, player: x.player, mode: 'usb', freq: 14200000 });
    await flush();
    assert.strictEqual(x.fetched.length, 2);
    x.c.configure({ enabled: false, listening: true, player: x.player, mode: 'usb', freq: 14200000 });
    x.c.configure({ enabled: true, listening: true, player: x.player, mode: 'usb', freq: 14200000 });
    await flush();
    assert.strictEqual(x.fetched.length, 4);
});

t('a model the worker cannot load is the same quiet error', async () => {
    const x = rig();
    x.c.configure({ enabled: true, listening: true, player: x.player, mode: 'usb', freq: 14200000 });
    await flush(); await flush();
    x.reply({ type: 'error', error: 'pt: zip: not a valid zip file' });
    assert.strictEqual(x.c.getState().status, 'error');
    assert.strictEqual(V.badge(x.c.getState()), null);
});

// ── the components render ────────────────────────────────────────────────────

globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.matchMedia = globalThis.matchMedia;
global.document = global.document || {
    visibilityState: 'visible',
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
};

function context(over = {}) {
    return {
        ...A.DEFAULTS,
        set() {},
        server: {},
        serverInfo: {},
        actions: { centerOnTuned() {} },
        running: false,
        player: null,
        tuning: { mode: 'usb', frequency: 14200000 },
        ...over,
    };
}

t('the tag renders nothing until there is a verdict', () => {
    A.reset();
    const empty = A.render(A.AudioClassTag, {}, context());
    assert.strictEqual(empty.tree, null);
    empty.cleanups.forEach((f) => f());
});

t('the watch mounts and unmounts without starting anything when stopped', () => {
    A.reset();
    const out = A.render(A.AudioClassWatch, {}, context());
    assert.strictEqual(out.tree, null);
    assert.strictEqual(C.getAudioClassifier().getState().status, 'idle');
    out.cleanups.forEach((f) => f());
    // Off in the settings: back to off.
    A.reset();
    const off = A.render(A.AudioClassWatch, {}, context({ audioClass: false }));
    off.cleanups.forEach((f) => f());
    assert.strictEqual(C.getAudioClassifier().getState().status, 'off');
});

t('the Display panel renders with the switch, and its hint', () => {
    A.reset();
    const out = A.render(A.DisplayPanel, {}, context());
    const text = A.words(out.tree);
    assert.match(text, /Identify audio/);
    out.cleanups.forEach((f) => f());
});

t('an inline hint that is a phrase wraps under its label; a reading stays beside it', () => {
    for (const h of ['the view moves at the edge', 'hidden while a panel is open', 'follows the audio',
        'Not available: the receiver could not supply the model (HTTP 404)',
        'Listening — first verdict after 5 s of audio']) {
        assert.ok(A.hintIsPhrase(h), h);
    }
    for (const h of ['20 dB', '512 ms', '-90 dBFS', 'steps 500 Hz', '45 % spectrum', undefined, null, 3]) {
        assert.ok(!A.hintIsPhrase(h), String(h));
    }
});

t('on by default', () => {
    assert.strictEqual(A.DEFAULTS.audioClass, true);
});

// ── the committed module and model, for real ─────────────────────────────────

t('the committed module loads the committed model and classifies', async () => {
    const wasm = fs.readFileSync(path.join(V2, 'audioclass', 'audioclass.wasm'));
    const model = fs.readFileSync(path.join(V2, 'audioclass', 'mn05_as_mAP_443.pt'));
    const out = [];
    // The module puts its functions on the global scope: node's here, the
    // worker's in a browser.
    const host = A.createWorkerHost(globalThis.Go, (m) => out.push(m), globalThis);
    await host({ type: 'init', wasm: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength), model: model.buffer.slice(model.byteOffset, model.byteOffset + model.byteLength) });
    assert.deepStrictEqual(out.pop(), { type: 'ready' });

    const rate = 12000;
    host({ type: 'reset', rate });
    // Too little audio yet: no answer, not a guess.
    host({ type: 'push', samples: new Float32Array(rate) });
    host({ type: 'classify', seconds: 5, epoch: 1 });
    assert.deepStrictEqual(out.pop(), { type: 'result', epoch: 1, result: null });

    // Five seconds of digital silence: a closed squelch, not run through the model.
    for (let i = 0; i < 5; i++) host({ type: 'push', samples: new Float32Array(rate) });
    host({ type: 'classify', seconds: 5, epoch: 2 });
    const quiet = out.pop().result;
    assert.strictEqual(quiet.label, 'silent');

    // Five seconds of white noise: hiss, which is what an empty channel is.
    let seed = 1;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    for (let i = 0; i < 6; i++) host({ type: 'push', samples: Float32Array.from({ length: rate }, () => 0.2 * rnd()) });
    host({ type: 'classify', seconds: 5, epoch: 3 });
    const hiss = out.pop().result;
    assert.strictEqual(hiss.label, 'noise', JSON.stringify(hiss));
    assert.ok(hiss.ms > 0 && hiss.seconds === 5, JSON.stringify(hiss));
    console.log(`      white noise: ${hiss.label} ${hiss.confidence}, ${hiss.ms} ms for 5 s`);
});

t('a module given a bad model says so', async () => {
    const wasm = fs.readFileSync(path.join(V2, 'audioclass', 'audioclass.wasm'));
    const out = [];
    const host = A.createWorkerHost(globalThis.Go, (m) => out.push(m), globalThis);
    await host({ type: 'init', wasm: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength), model: new ArrayBuffer(16) });
    const m = out.pop();
    assert.strictEqual(m.type, 'error');
    assert.match(m.error, /pt|zip/);
});

chain.then(() => {
    console.log(`\n${pass} passed`);
    // The Go runtime parks in select{} for the life of the process.
    process.exit(process.exitCode || 0);
});

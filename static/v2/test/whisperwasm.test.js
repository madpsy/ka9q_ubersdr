// The browser's own Whisper: WebAssembly in a worker, with models the user
// downloads (src/extensions/whisper/engines/wasm.js, wasm/worker.entry.js).
//
// What matters most here is what nobody would notice going wrong until a user
// did:
//
//   * **The committed module is the one the sources make.** static/v2/whisper/
//     is built elsewhere (clients/electron/whisper/build.sh --only=wasm) and
//     committed; a change to the shared session that was not rebuilt fails
//     here, not in a browser.
//   * **A download is the pinned file or nothing.** Size and SHA-256, as it
//     arrives; a short, long or wrong download is thrown away.
//   * **The apps are untouched.** Inside Electron or Capacitor this engine is
//     never chosen, even where the app has no recogniser of its own.
//   * **A retune drops what was being said before it**, although the worker
//     cannot abandon a decode: lines carry an epoch and old ones are dropped.
//   * **It actually transcribes.** The real worker bundle, the real module and
//     the real models, over recorded speech — where the models and the
//     recording are on this machine (see the end of the file).

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

global.window = global.window || {};
const W = require('./.build/whisperwasm.cjs');

const REPO = path.resolve(__dirname, '../../..');
const HELPER = path.join(REPO, 'clients', 'electron', 'whisper');
const V2 = path.resolve(__dirname, '..');

let pass = 0;
let chain = Promise.resolve();
const t = (name, fn) => {
    chain = chain.then(async () => {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + (e && e.stack || e)); process.exitCode = 1; }
    });
};
const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 10) { for (let i = 0; i < n; i++) await tick(); }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ---- the committed module ---------------------------------------------------------

t('the generated description matches the sources it was built from', () => {
    // The same list, in the same order, as clients/electron/whisper/wasm/embed.js.
    const SOURCES = [
        'whisper_core.h', 'whisper_core.cpp', 'whisper_session.h', 'whisper_session.cpp',
        'wasm/whisper_wasm.cpp', 'wasm/CMakeLists.txt',
    ];
    const h = crypto.createHash('sha256');
    for (const f of SOURCES) h.update(f + '\0').update(fs.readFileSync(path.join(HELPER, f))).update('\0');
    h.update(W.WASM_BUILD.whisperCpp + '\0' + W.WASM_BUILD.emsdk);
    assert.strictEqual(h.digest('hex'), W.WASM_BUILD.sourceSha256,
        'the shared Whisper sources changed since static/v2/whisper/ was built: run clients/electron/whisper/build.sh --only=wasm');
});

t('the committed module files are the ones described', () => {
    for (const [f, d] of Object.entries(W.WASM_BUILD.files)) {
        const b = fs.readFileSync(path.join(V2, 'whisper', f));
        assert.strictEqual(b.length, d.size, f);
        assert.strictEqual(sha(b), d.sha256, f);
    }
    assert.match(W.WASM_BUILD.version, /^[0-9a-f]{16}$/);
});

t('the pins are models.json\'s entries for the browser: base, tiny and the VAD', () => {
    const all = JSON.parse(fs.readFileSync(path.join(HELPER, 'models.json'), 'utf8'));
    const want = {};
    for (const [id, v] of Object.entries(all)) {
        if (id.startsWith('//') || !(v.clients || []).includes('browser')) continue;
        want[id] = { file: v.file, url: v.url, size: v.size, sha256: v.sha256 };
    }
    assert.deepStrictEqual(W.WASM_PINS, want, 'models.json changed: run clients/electron/whisper/build.sh --only=wasm');
    assert.deepStrictEqual(Object.keys(W.WASM_PINS).sort(), ['base', 'tiny', 'vad']);
    for (const p of Object.values(W.WASM_PINS)) {
        assert.match(p.url, /^https:\/\/huggingface\.co\/.*\/resolve\/[0-9a-f]{40}\//, 'pinned to a commit');
        assert.match(p.sha256, /^[0-9a-f]{64}$/);
    }
});

// ---- the hash ------------------------------------------------------------------------

t('SHA-256 in pieces is SHA-256 of the whole, wherever the pieces break', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 127, 128, 1000, 70001]) {
        const b = crypto.randomBytes(n);
        const s = W.createSha256();
        for (let i = 0; i < n;) {
            const k = Math.min(n - i, 1 + ((i * 7919) % 131));
            s.update(new Uint8Array(b.buffer, b.byteOffset + i, k));
            i += k;
        }
        assert.strictEqual(s.hex(), sha(b), `${n} bytes`);
    }
});

// ---- where it is offered ---------------------------------------------------------------

function browserWin(extra = {}) {
    return { Worker: function Worker() {}, indexedDB: {}, WebAssembly, localStorage: memStorage(), ...extra };
}

t('offered in a browser with workers, IndexedDB and WebAssembly SIMD', () => {
    assert.strictEqual(W.wasmSupported(browserWin()), true);
    assert.strictEqual(W.wasmSupported(browserWin({ Worker: undefined })), false);
    assert.strictEqual(W.wasmSupported(browserWin({ indexedDB: undefined })), false);
    assert.strictEqual(W.wasmSupported(browserWin({ WebAssembly: { validate: () => false } })), false);
});

t('never inside an app — even one with no recogniser of its own', () => {
    // An Electron or Capacitor page: ubersdrDesktop is there, stt or not.
    assert.strictEqual(W.wasmSupported(browserWin({ ubersdrDesktop: {} })), false);
    assert.strictEqual(W.localEngineKind(browserWin({ ubersdrDesktop: {} })), null);
    const host = { start() {}, push() {} };
    assert.strictEqual(W.localEngineKind(browserWin({ ubersdrDesktop: { stt: host } })), 'host');
});

t('the engine order: an app\'s recogniser, then Whisper, then Web Speech', () => {
    function Rec() {}
    Rec.available = () => Promise.resolve('available');
    Rec.prototype.processLocally = false;
    assert.strictEqual(W.localEngineKind(browserWin({ SpeechRecognition: Rec })), 'wasm');
    assert.strictEqual(W.localEngineKind({ SpeechRecognition: Rec, navigator: { userAgent: 'Chrome' } }), 'browser');
    // Known at once: nothing to probe.
    assert.deepStrictEqual(W.usableLocalKind(browserWin()), { kind: 'wasm', pending: false });
});

t('until a model is downloaded, the server stays the default where there is one', () => {
    const r = W.pickSource({ localAvailable: true, serverEnabled: true, saved: null, localDefault: false });
    assert.strictEqual(r.source, 'server');
    assert.strictEqual(r.options.find((o) => o.value === 'local').disabled, false, 'still on offer');
    assert.strictEqual(W.pickSource({ localAvailable: true, serverEnabled: true, saved: 'local', localDefault: false }).source, 'local');
    assert.strictEqual(W.pickSource({ localAvailable: true, serverEnabled: false, saved: null, localDefault: false }).source, 'local');
    assert.strictEqual(W.pickSource({ localAvailable: true, serverEnabled: true, saved: null }).source, 'local', 'others unchanged');
});

// ---- the stt object, against a scripted worker -----------------------------------------------

function memStorage() {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

function memStore() {
    const m = new Map();
    return {
        map: m,
        get: async (k) => m.get(k),
        put: async (k, v) => { m.set(k, v); },
        delete: async (k) => { m.delete(k); },
        keys: async () => [...m.keys()],
    };
}

// Small stand-ins for the models, with real hashes.
function fakeModel(name, n) {
    const bytes = Buffer.alloc(n, name.charCodeAt(0));
    return { bytes, pin: { file: name, url: `https://example.test/${name}`, size: n, sha256: sha(bytes) } };
}

function scriptedWorker() {
    const workers = [];
    class FakeWorker {
        constructor(url) {
            this.url = url;
            this.sent = [];
            this.terminated = false;
            workers.push(this);
        }
        postMessage(m, transfer) {
            this.sent.push({ m, transfer: transfer || [] });
            if (m.type === 'call') {
                const value = m.op === 'languages' ? ['en', 'de', 'jv', 'zh'] : { multilingual: true };
                setImmediate(() => this.onmessage({ data: { type: 'reply', id: m.id, ok: true, value } }));
            }
        }
        terminate() { this.terminated = true; }
        emit(epoch, line) { this.onmessage({ data: { type: 'line', epoch, line: JSON.stringify(line) } }); }
    }
    return { FakeWorker, workers };
}

function streamOf(bytes, { chunk = 7, gate = null } = {}) {
    let i = 0;
    return {
        getReader: () => ({
            read: async () => {
                if (gate) await gate();
                if (i >= bytes.length) return { done: true, value: undefined };
                const v = new Uint8Array(bytes.subarray(i, i + chunk));
                i += chunk;
                return { done: false, value: v };
            },
        }),
    };
}

function setup({ fetchBody, gate } = {}) {
    const tiny = fakeModel('tiny', 300);
    const base = fakeModel('base', 500);
    const vad = fakeModel('vad', 40);
    const files = { [tiny.pin.url]: tiny.bytes, [base.pin.url]: base.bytes, [vad.pin.url]: vad.bytes };
    const fetched = [];
    const fetch = async (url, opts) => {
        fetched.push(url);
        const signal = opts && opts.signal;
        const body = fetchBody ? fetchBody(url, files[url]) : files[url];
        return {
            ok: true,
            status: 200,
            body: streamOf(body, {
                gate: gate && (async () => {
                    await gate();
                    if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
                }),
            }),
        };
    };
    const { FakeWorker, workers } = scriptedWorker();
    const storage = memStorage();
    const store = memStore();
    let persisted = 0;
    const stt = W.createWasmStt({
        win: {},
        Worker: FakeWorker,
        fetch,
        storage,
        store,
        persist: async () => { persisted++; return true; },
        baseUrl: 'http://receiver.test/v2/',
        pins: { base: base.pin, tiny: tiny.pin, vad: vad.pin },
        build: { version: 'abc' },
    });
    return { stt, workers, fetched, storage, store, pins: { tiny, base, vad }, persisted: () => persisted };
}

t('models: Base then Tiny, none built in, none there until downloaded', async () => {
    const { stt } = setup();
    const list = await stt.models();
    assert.deepStrictEqual(list.map((m) => m.id), ['base', 'tiny']);
    assert.ok(list.every((m) => !m.installed && !m.active && !m.builtIn && !m.downloading));
    assert.deepStrictEqual(list.map((m) => m.sizeBytes), [500, 300]);
});

t('Start with nothing downloaded says to download one, and starts no worker', async () => {
    const { stt, workers } = setup();
    await assert.rejects(stt.start({ lang: 'en' }), (e) => e.code === 'no-model' && /Download a speech model first/.test(e.message));
    assert.strictEqual(workers.length, 0);
});

t('a download: the VAD and the model, checked, kept, with progress to the end, and storage made persistent', async () => {
    const h = setup();
    const progress = [];
    await h.stt.installModel('tiny', (p) => progress.push(p));
    assert.deepStrictEqual(h.fetched, [h.pins.vad.pin.url, h.pins.tiny.pin.url]);
    assert.ok(h.store.map.has(h.pins.tiny.pin.sha256) && h.store.map.has(h.pins.vad.pin.sha256));
    const last = progress[progress.length - 1];
    assert.deepStrictEqual(last, { received: 340, total: 340 });
    assert.strictEqual(h.persisted(), 1);
    const list = await h.stt.models();
    assert.deepStrictEqual(list.map((m) => [m.id, m.installed, m.active]), [['base', false, false], ['tiny', true, true]]);
    assert.strictEqual(W.wasmHasModel({ localStorage: h.storage }), true, 'the synchronous hint follows');
    // The second model needs no second VAD.
    await h.stt.installModel('base');
    assert.strictEqual(h.fetched.filter((u) => u === h.pins.vad.pin.url).length, 1);
});

t('a download that is not the pinned file is thrown away: wrong bytes, short, or long', async () => {
    for (const [what, body] of [
        ['wrong', (url, b) => (url.includes('tiny') ? Buffer.alloc(b.length, 1) : b)],
        ['short', (url, b) => (url.includes('tiny') ? b.subarray(0, b.length - 1) : b)],
        ['long', (url, b) => (url.includes('tiny') ? Buffer.concat([b, Buffer.alloc(1)]) : b)],
    ]) {
        const h = setup({ fetchBody: body });
        await assert.rejects(h.stt.installModel('tiny'), (e) => e.code === 'corrupt', what);
        assert.ok(!h.store.map.has(h.pins.tiny.pin.sha256), what);
        assert.strictEqual((await h.stt.models()).find((m) => m.id === 'tiny').installed, false, what);
    }
});

t('Cancel: the download stops, its waiters hear \'cancelled\', nothing is kept', async () => {
    let open;
    let wait = new Promise((r) => { open = r; });
    const h = setup({ gate: () => wait });
    const a = h.stt.installModel('base');
    const b = h.stt.installModel('base');
    await settle();
    assert.strictEqual((await h.stt.models()).find((m) => m.id === 'base').downloading, true);
    assert.strictEqual(h.fetched.length, 1, 'joined, not fetched twice');
    h.stt.cancelInstall('base');
    open();
    wait = Promise.resolve();
    await assert.rejects(a, (e) => e.code === 'cancelled');
    await assert.rejects(b, (e) => e.code === 'cancelled');
    await settle();
    assert.strictEqual((await h.stt.models()).find((m) => m.id === 'base').downloading, false);
    assert.ok(!h.store.map.has(h.pins.base.pin.sha256));
});

t('setModel takes only a downloaded model; Remove of the last takes the VAD too', async () => {
    const h = setup();
    await assert.rejects(h.stt.setModel('base'), (e) => e.code === 'not-installed');
    await h.stt.installModel('tiny');
    await h.stt.installModel('base');
    // Base is first in the list, but the one chosen is what counts.
    await h.stt.setModel('tiny');
    assert.strictEqual((await h.stt.models()).find((m) => m.active).id, 'tiny');
    await h.stt.removeModel('tiny');
    assert.strictEqual((await h.stt.models()).find((m) => m.active).id, 'base', 'the other one, once its choice is gone');
    await h.stt.removeModel('base');
    assert.deepStrictEqual([...h.store.map.keys()], []);
    assert.strictEqual(W.wasmHasModel({ localStorage: h.storage }), false);
});

t('start: the worker is given the models once, then the session; lines from before a reset are dropped', async () => {
    const h = setup();
    await h.stt.installModel('tiny');
    const results = [];
    await h.stt.start({ lang: 'en', onResult: (r) => results.push(r), onError() {}, onEnd() {} });
    const w = h.workers[0];
    assert.strictEqual(w.url, 'http://receiver.test/v2/dist/whisper-worker.js');
    const init = w.sent[0].m;
    assert.strictEqual(init.moduleUrl, 'http://receiver.test/v2/whisper/whisper-stt.js?v=abc');
    assert.strictEqual(init.wasmUrl, 'http://receiver.test/v2/whisper/whisper-stt.wasm?v=abc');
    const load = w.sent.find((s) => s.m.op === 'load');
    assert.ok(load.m.vad && load.m.model, 'both models');
    assert.strictEqual(load.transfer.length, 2, 'moved, not copied');
    const start = w.sent.find((s) => s.m.type === 'start').m;
    assert.deepStrictEqual(JSON.parse(start.json), { lang: 'en', session: 1 });

    const pcm = new Int16Array(1600);
    h.stt.push(pcm);
    const audio = w.sent.find((s) => s.m.type === 'audio');
    assert.strictEqual(audio.m.epoch, start.epoch);
    assert.deepStrictEqual(audio.transfer, [pcm.buffer]);

    w.emit(start.epoch, { type: 'result', session: 1, text: 'heard', final: false });
    h.stt.reset();
    // The final for what was heard before the retune, after it: dropped.
    w.emit(start.epoch, { type: 'result', session: 1, text: 'before the retune', final: true });
    const after = w.sent.find((s) => s.m.type === 'reset').m.epoch;
    w.emit(after, { type: 'result', session: 1, text: 'after', final: true });
    assert.deepStrictEqual(results, [{ text: 'heard', final: false }, { text: 'after', final: true }]);

    // A restart on the same model loads nothing again.
    h.stt.stop();
    await h.stt.start({ lang: 'en' });
    assert.strictEqual(w.sent.filter((s) => s.m.op === 'load').length, 1);
    assert.strictEqual(JSON.parse(w.sent.filter((s) => s.m.type === 'start')[1].m.json).session, 2);
});

t('a module that will not load ends the session with the reason; the next Start tries a new worker', async () => {
    const h = setup();
    await h.stt.installModel('tiny');
    const seen = [];
    await h.stt.start({ lang: 'en', onError: (e) => seen.push(['error', e.code, e.fatal]), onEnd: () => seen.push(['end']) });
    h.workers[0].onmessage({ data: { type: 'failed', message: 'HTTP 404' } });
    assert.deepStrictEqual(seen, [['error', 'start-failed', true], ['end']]);
    assert.strictEqual(h.workers[0].terminated, true);
    await h.stt.start({ lang: 'en' });
    assert.strictEqual(h.workers.length, 2);
});

t('languages: Whisper\'s, sorted by English name', async () => {
    const { stt } = setup();
    const list = await stt.languages();
    assert.deepStrictEqual(list, ['zh', 'en', 'de', 'jv'].sort((a, b) => {
        const n = new Intl.DisplayNames(['en'], { type: 'language' });
        return n.of(a).localeCompare(n.of(b), 'en');
    }));
});

// ---- the real thing ---------------------------------------------------------------------
//
// The worker bundle (built by run.sh into .build/whisper-worker.js) in a vm
// context shaped like a dedicated worker, loading the committed module, with
// the desktop client's base and VAD models (clients/electron/whisper/build.sh
// --only=models) over its speech fixture (test/record.sh there). Skipped, and
// said so, where those are not on this machine.

const MODELS = path.join(HELPER, 'dist', 'models');
const SPEECH = process.env.WHISPER_TEST_WAV || path.join(HELPER, 'test', 'fixtures', 'speech.wav');

function readWav(p) {
    const b = fs.readFileSync(p);
    let o = 12;
    while (o + 8 <= b.length) {
        const n = b.readUInt32LE(o + 4);
        if (b.toString('ascii', o, o + 4) === 'data') return new Int16Array(b.buffer.slice(b.byteOffset + o + 8, b.byteOffset + o + 8 + n));
        o += 8 + n + (n & 1);
    }
    throw new Error('no data in ' + p);
}

// A dedicated worker, as far as worker.entry.js and the Emscripten glue look.
function vmWorkerClass() {
    const fileOf = (u) => decodeURIComponent(new URL(u).pathname);
    return class VmWorker {
        constructor(url) {
            const page = this;
            const ctx = {
                WorkerGlobalScope: function WorkerGlobalScope() {},
                location: { href: url },
                postMessage: (m) => setImmediate(() => page.onmessage && page.onmessage({ data: m })),
                importScripts: (...urls) => { for (const u of urls) vm.runInContext(fs.readFileSync(fileOf(u), 'utf8'), ctx, { filename: u }); },
                fetch: async (u) => new Response(fs.readFileSync(fileOf(u)), { headers: { 'Content-Type': 'application/wasm' } }),
                MessageChannel, WebAssembly, URL, TextDecoder, TextEncoder, performance, console, setTimeout, clearTimeout,
            };
            ctx.self = ctx;
            vm.createContext(ctx);
            this.ctx = ctx;
            vm.runInContext(fs.readFileSync(path.join(__dirname, '.build', 'whisper-worker.js'), 'utf8'), ctx);
        }
        postMessage(m, transfer) {
            const copy = structuredClone(m, { transfer: transfer || [] });
            setImmediate(() => this.ctx.onmessage({ data: copy }));
        }
        terminate() {}
    };
}

const haveReal = ['ggml-base-q5_1.bin', 'ggml-silero-v6.2.0.bin'].every((f) => fs.existsSync(path.join(MODELS, f))) && fs.existsSync(SPEECH);

t('the real worker, module and models transcribe recorded speech' + (haveReal ? '' : ' (skipped: no models or speech here)'), async () => {
    if (!haveReal) return;
    const store = memStore();
    for (const id of ['base', 'vad']) {
        const pin = W.WASM_PINS[id];
        store.map.set(pin.sha256, new Blob([fs.readFileSync(path.join(MODELS, pin.file))]));
    }
    const stt = W.createWasmStt({
        win: {},
        Worker: vmWorkerClass(),
        fetch: () => { throw new Error('nothing should be downloaded'); },
        storage: memStorage(),
        store,
        baseUrl: 'file://' + V2 + '/',
        // WHISPER_WASM_VERBOSE=1: the session's own account of each decode.
        verbose: !!process.env.WHISPER_WASM_VERBOSE,
    });
    const langs = await stt.languages();
    assert.ok(langs.length >= 99 && langs.includes('en') && langs.includes('jv') && !langs.includes('jw'));

    const results = [];
    const errors = [];
    const log = process.env.WHISPER_WASM_VERBOSE ? (...a) => console.log('     ', ...a) : () => {};
    await stt.start({
        lang: 'en',
        onResult: (r) => { log(r.final ? 'final  ' : 'interim', r.text); results.push(r); },
        onError: (e) => { log('error', e); errors.push(e); },
        onEnd() {},
    });
    const speech = readWav(SPEECH);
    const silence = new Int16Array(16000 * 2);
    for (const pcm of [speech, silence]) {
        for (let i = 0; i < pcm.length; i += 1600) stt.push(pcm.slice(i, i + 1600));
    }
    const until = Date.now() + 120000;
    while (!results.some((r) => r.final) && !errors.length && Date.now() < until) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 100));
    }
    stt.stop();
    assert.deepStrictEqual(errors, []);
    const final = results.find((r) => r.final);
    assert.ok(final, 'a final within two minutes');
    const words = final.text.split(/\s+/).filter(Boolean).length;
    console.log(`      "${final.text}"`);
    assert.ok(words >= 5, `a sentence, not a word: ${final.text}`);
});

chain.then(() => {
    console.log(`\n${pass} passed`);
    process.exit(process.exitCode || 0);
});

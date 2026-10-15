// Local speech-to-text: where the helper is, the model downloads, and a
// receiver window's sessions — through the preload's bridge and the IPC
// channels, as the page reaches them.
//
// The session tests run the real whisper-helper on real speech. They need
// whisper/build.sh to have built it for this platform and fetched the models,
// and a speech sample at whisper/test/fixtures/speech.wav (whisper/test/
// record.sh makes one off the air); without them those tests are skipped and
// say so. The downloads are served from a local HTTP server, against pins
// made up for the test, so they need nothing.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const {
    SttService, registerSttIpc, sttPaths, platformDir, toWhisperLang, fromWhisperLang, languageList, readJson,
} = require('../stt.js');
const { ModelManager } = require('../sttmodels.js');
const { createSttBridge, pcmBytes } = require('../sttbridge.js');
const { readWav, silence, concat, RATE } = require('../whisper/test/protocol.js');

let pass = 0;
let skipped = 0;
const tests = [];
const t = (name, fn) => tests.push({ name, fn });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(pred, ms, what) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (pred()) return;
        await sleep(20);
    }
    throw new Error(`timed out waiting for ${what}`);
}

const dirs = [];
function tmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-test-'));
    dirs.push(d);
    return d;
}
process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// ---- the real helper, if there is one ------------------------------------------

const APP = path.join(__dirname, '..');
const REAL = sttPaths({ resourcesPath: undefined, appDir: APP });
const PINS = readJson(REAL.pins);
const SPEECH_WAV = process.env.WHISPER_TEST_WAV || path.join(APP, 'whisper', 'test', 'fixtures', 'speech.wav');
const SMALL_REAL = process.env.WHISPER_SMALL_MODEL || '';
const haveHelper = !!REAL.helper && fs.existsSync(REAL.helper)
    && fs.existsSync(path.join(REAL.modelsDir, 'ggml-base-q5_1.bin'))
    && fs.existsSync(path.join(REAL.modelsDir, 'ggml-silero-v6.2.0.bin'));
const haveSpeech = fs.existsSync(SPEECH_WAV);
const speech = haveSpeech ? readWav(SPEECH_WAV) : null;

function needsHelper(withSpeech = true) {
    if (!haveHelper) return `no helper for ${process.platform}-${process.arch} — run whisper/build.sh`;
    if (withSpeech && !haveSpeech) return `no speech at ${SPEECH_WAV} — see whisper/test/record.sh`;
    return '';
}

// A spawn that remembers every helper it started, so a test can see the
// arguments and kill one.
function recordingSpawn() {
    const { spawn } = require('child_process');
    const spawned = [];
    const fn = (cmd, args, opts) => {
        const child = spawn(cmd, args, opts);
        spawned.push({ args, child });
        return child;
    };
    fn.spawned = spawned;
    return fn;
}

/** A service on the real helper; `small` replaces small's pin. */
function realService({ chosen = null, small = null, spawn } = {}) {
    const pins = JSON.parse(JSON.stringify(PINS));
    if (small) pins.small = { ...pins.small, ...small };
    const state = { active: chosen };
    const models = new ModelManager({
        pins,
        builtinDir: REAL.modelsDir,
        dir: tmp(),
        getActive: () => state.active,
        setActive: (id) => { state.active = id; },
    });
    const service = new SttService({ paths: REAL, models, spawn: spawn || recordingSpawn() });
    return { service, models, state };
}

/** A window on a service, with what it sent the page. */
function windowOn(service) {
    const events = [];
    const w = service.createWindow((msg) => events.push({ at: Date.now(), ...msg }));
    return { w, events };
}

/** `pcm` into a window in 100 ms pieces, `speed` times real time. */
async function play(push, pcm, speed = 1) {
    const step = RATE / 10;
    const begin = Date.now();
    for (let i = 0; i < pcm.length; i += step) {
        push(pcm.subarray(i, Math.min(pcm.length, i + step)));
        const due = begin + ((i + step) / RATE) * 1000 / speed;
        if (due > Date.now()) await sleep(due - Date.now());
    }
}

const bytes = (pcm) => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);

// ---- where things are --------------------------------------------------------------

t('the helper directory for each platform the client ships on', () => {
    assert.strictEqual(platformDir('linux', 'x64'), 'linux-x64');
    assert.strictEqual(platformDir('linux', 'arm64'), 'linux-arm64');
    assert.strictEqual(platformDir('win32', 'x64'), 'win-x64');
    // One universal binary for both Macs.
    assert.strictEqual(platformDir('darwin', 'arm64'), 'darwin-universal');
    assert.strictEqual(platformDir('darwin', 'x64'), 'darwin-universal');
    assert.strictEqual(platformDir('linux', 'ia32'), null);
    assert.strictEqual(platformDir('freebsd', 'x64'), null);
});

t('packaged: resources/whisper; from source: whisper/dist; never a mixture', () => {
    const res = path.join('/', 'opt', 'UberSDR', 'resources');
    const app = path.join(res, 'app.asar');
    const packaged = sttPaths({
        resourcesPath: res, appDir: app, platform: 'linux', arch: 'x64', exists: (p) => p.startsWith(res),
    });
    assert.strictEqual(packaged.helper, path.join(res, 'whisper', 'whisper-helper'));
    assert.strictEqual(packaged.modelsDir, path.join(res, 'whisper', 'models'));
    assert.strictEqual(packaged.pins, path.join(app, 'whisper', 'models.json'));
    assert.strictEqual(packaged.packaged, true);

    const win = sttPaths({ resourcesPath: 'C:\\x', appDir: '/a', platform: 'win32', arch: 'x64', exists: () => true });
    assert.ok(win.helper.endsWith('whisper-helper.exe'), win.helper);

    // From source, Electron's own resources directory has no helper in it.
    const dev = sttPaths({
        resourcesPath: '/repo/node_modules/electron/dist/resources', appDir: '/repo', platform: 'linux', arch: 'arm64',
        exists: () => false,
    });
    assert.strictEqual(dev.helper, path.join('/repo', 'whisper', 'dist', 'linux-arm64', 'whisper-helper'));
    assert.strictEqual(dev.modelsDir, path.join('/repo', 'whisper', 'dist', 'models'));
    assert.strictEqual(dev.packaged, false);

    const mac = sttPaths({ appDir: '/repo', platform: 'darwin', arch: 'arm64', exists: () => false });
    assert.strictEqual(mac.helper, path.join('/repo', 'whisper', 'dist', 'darwin-universal', 'whisper-helper'));
    // No helper is built for this one: no path to look for.
    assert.strictEqual(sttPaths({ appDir: '/repo', platform: 'linux', arch: 'ia32', exists: () => false }).helper, null);
});

t('the pins the app reads are the ones the build checks', () => {
    assert.ok(PINS, `no ${REAL.pins}`);
    assert.strictEqual(PINS.base.bundled, true);
    assert.strictEqual(PINS.small.bundled, false);
    assert.strictEqual(PINS.vad.bundled, true);
    assert.match(PINS.small.sha256, /^[0-9a-f]{64}$/);
    assert.match(PINS.small.url, /^https:\/\/huggingface\.co\/.*\/resolve\/[0-9a-f]{40}\/ggml-small-q5_1\.bin$/);
});

// ---- languages -------------------------------------------------------------------

t('languages: Whisper\'s codes as tags the page names, and back', () => {
    assert.strictEqual(fromWhisperLang('jw'), 'jv');
    assert.strictEqual(fromWhisperLang('en'), 'en');
    assert.strictEqual(toWhisperLang('jv'), 'jw');
    assert.strictEqual(toWhisperLang('en-GB'), 'en');
    assert.strictEqual(toWhisperLang('nb-NO'), 'no');
    assert.strictEqual(toWhisperLang('zh_TW'), 'zh');
    assert.strictEqual(toWhisperLang('haw'), 'haw');
    assert.strictEqual(toWhisperLang(''), 'auto');
    const list = languageList(['en', 'zh', 'de', 'jw', 'yue', 'en', 'not a code']);
    assert.deepStrictEqual([...list].sort(), ['de', 'en', 'jv', 'yue', 'zh']);
    // Alphabetical by name, which is how the menu is read.
    assert.ok(list.indexOf('zh') < list.indexOf('en'), `Chinese before English: ${list}`);
    assert.ok(list.indexOf('en') < list.indexOf('de'), `English before German: ${list}`);
});

t('the bridge sends a PCM view\'s own bytes, not its whole buffer', () => {
    const whole = new Int16Array([1, 2, 3, 4, 5, 6]);
    const view = whole.subarray(2, 4);
    const b = pcmBytes(view);
    assert.strictEqual(b.byteLength, 4);
    assert.deepStrictEqual(Array.from(new Int16Array(b.buffer)), [3, 4]);
    assert.strictEqual(pcmBytes(whole).byteLength, 12);
    assert.deepStrictEqual(Array.from(new Int16Array(pcmBytes([7, 8]).buffer)), [7, 8]);
});

// ---- downloading a model -----------------------------------------------------------

// A server for one fake model: `payload`, with Range support, or a damaged
// copy of it, or a slow trickle, or nothing.
function modelServer(payload) {
    const log = [];
    const server = http.createServer((req, res) => {
        log.push({ url: req.url, range: req.headers.range || null });
        const body = req.url.startsWith('/corrupt') ? Buffer.from(payload).fill(1, 1000, 2000) : payload;
        if (req.url.startsWith('/missing')) { res.writeHead(404, 'Not Found'); res.end(); return; }
        let start = 0;
        const m = /^bytes=(\d+)-$/.exec(req.headers.range || '');
        if (m && !req.url.startsWith('/norange')) start = Number(m[1]);
        res.writeHead(start ? 206 : 200, {
            'Content-Length': body.length - start,
            ...(start ? { 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}` } : {}),
        });
        if (req.url.startsWith('/slow')) {
            // 16 KB every 20 ms: long enough to cancel in the middle of.
            let at = start;
            const tick = () => {
                if (res.destroyed) return;
                const next = Math.min(body.length, at + 16384);
                res.write(body.subarray(at, next));
                at = next;
                if (at >= body.length) res.end(); else setTimeout(tick, 20);
            };
            tick();
            return;
        }
        res.end(body.subarray(start));
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        server, log, url: (p) => `http://127.0.0.1:${server.address().port}${p}`,
    })));
}

const PAYLOAD = crypto.randomBytes(600 * 1024);
const PAYLOAD_SHA = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

/** A ModelManager whose small model is served from `srv` at `route`. */
function fakeModels(srv, route = '/model.bin', extra = {}) {
    const builtin = tmp();
    fs.writeFileSync(path.join(builtin, 'base.bin'), 'a base model');
    fs.writeFileSync(path.join(builtin, 'vad.bin'), 'a vad model');
    const state = { active: null };
    const models = new ModelManager({
        pins: {
            '//': 'a note',
            base: { file: 'base.bin', url: 'http://unused/', size: 12, sha256: '0', bundled: true },
            small: { file: 'small.bin', url: srv.url(route), size: PAYLOAD.length, sha256: PAYLOAD_SHA, bundled: false },
            vad: { file: 'vad.bin', url: 'http://unused/', size: 11, sha256: '0', bundled: true },
        },
        builtinDir: builtin,
        dir: path.join(tmp(), 'whisper-models'),
        getActive: () => state.active,
        setActive: (id) => { state.active = id; },
        progressMs: 0,
        ...extra,
    });
    return { models, state };
}

let srv;
t('(start the model server)', async () => { srv = await modelServer(PAYLOAD); });

t('the list: base built in and in use, small not downloaded', () => {
    const { models } = fakeModels(srv);
    assert.deepStrictEqual(models.list(), [
        { id: 'base', label: 'Base', sizeBytes: 12, installed: true, active: true, builtIn: true, downloading: false },
        { id: 'small', label: 'Small', sizeBytes: PAYLOAD.length, installed: false, active: false, builtIn: false, downloading: false },
    ]);
    assert.deepStrictEqual(models.resolve(), { id: 'base', file: models.fileFor('base'), fallback: null });
});

t('install: progress, the pinned bytes checked, then chosen', async () => {
    const { models, state } = fakeModels(srv);
    const seen = [];
    await models.install('small', (p) => seen.push(p));
    const file = models.fileFor('small');
    assert.ok(fs.readFileSync(file).equals(PAYLOAD), 'not the served bytes');
    assert.ok(!fs.existsSync(`${file}.part`), 'the .part was left behind');
    assert.ok(seen.length >= 2, `progress: ${seen.length}`);
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i].received >= seen[i - 1].received);
    assert.deepStrictEqual(seen[seen.length - 1], { received: PAYLOAD.length, total: PAYLOAD.length });
    assert.strictEqual(models.list()[1].installed, true);
    // Installing is not choosing; choosing is the page's next call.
    assert.strictEqual(models.resolve().id, 'base');
    await models.setActive('small');
    assert.strictEqual(state.active, 'small');
    assert.strictEqual(models.resolve().id, 'small');
    assert.deepStrictEqual(models.list().map((m) => m.active), [false, true]);
    // Choosing the built-in one again is the default, stored as nothing.
    await models.setActive('base');
    assert.strictEqual(state.active, null);
    // Already there: nothing fetched.
    const before = srv.log.length;
    await models.install('small');
    assert.strictEqual(srv.log.length, before);
});

t('a download that is not the pinned file is thrown away, and says so', async () => {
    const { models } = fakeModels(srv, '/corrupt');
    await assert.rejects(models.install('small'), (e) => {
        assert.strictEqual(e.code, 'corrupt');
        assert.match(e.message, /downloaded damaged \(its checksum does not match\), so it was thrown away\. Try again\./);
        return true;
    });
    const file = models.fileFor('small');
    assert.ok(!fs.existsSync(file) && !fs.existsSync(`${file}.part`), 'something was kept');
    assert.strictEqual(models.list()[1].installed, false);
    await assert.rejects(models.setActive('small'), /not downloaded yet/);
});

t('cancel: rejected as cancelled, and the next install carries on from the piece', async () => {
    const { models } = fakeModels(srv, '/slow');
    const seen = [];
    const p = models.install('small', (x) => seen.push(x.received));
    await until(() => seen.some((r) => r > 100000), 5000, 'some of it');
    assert.strictEqual(models.list()[1].downloading, true);
    models.cancel('small');
    await assert.rejects(p, (e) => e.code === 'cancelled' && e.message === 'Download cancelled.');
    const part = `${models.fileFor('small')}.part`;
    const kept = fs.statSync(part).size;
    assert.ok(kept > 0 && kept < PAYLOAD.length, `kept ${kept}`);
    assert.strictEqual(models.list()[1].downloading, false);

    const from = srv.log.length;
    await models.install('small');
    assert.deepStrictEqual(srv.log.slice(from).map((l) => l.range), [`bytes=${kept}-`], 'not resumed');
    assert.ok(fs.readFileSync(models.fileFor('small')).equals(PAYLOAD));
});

t('a server that ignores the Range starts the file again', async () => {
    const { models } = fakeModels(srv, '/norange');
    fs.mkdirSync(models.dir, { recursive: true });
    fs.writeFileSync(`${models.fileFor('small')}.part`, Buffer.alloc(5000, 9));
    await models.install('small');
    assert.ok(fs.readFileSync(models.fileFor('small')).equals(PAYLOAD));
});

t('two installs of one model are one download', async () => {
    const { models } = fakeModels(srv, '/slow');
    const from = srv.log.length;
    const a = [];
    const b = [];
    await Promise.all([models.install('small', (p) => a.push(p)), models.install('small', (p) => b.push(p))]);
    assert.strictEqual(srv.log.length - from, 1);
    assert.ok(a.length && b.length, 'both were told how it went');
});

t('a failed download says why, in words', async () => {
    const { models } = fakeModels(srv, '/missing');
    await assert.rejects(models.install('small'), /Couldn't download the Small model: the server answered 404 Not Found/);
    const { models: nowhere } = fakeModels({ url: () => 'http://127.0.0.1:9/x' });
    await assert.rejects(nowhere.install('small'), /Couldn't download the Small model: /);
});

t('remove: the download goes, base takes over; base itself cannot go', async () => {
    const { models, state } = fakeModels(srv);
    await models.install('small');
    await models.setActive('small');
    await models.remove('small');
    assert.ok(!fs.existsSync(models.fileFor('small')));
    assert.strictEqual(state.active, null, 'still chosen after it was removed');
    assert.strictEqual(models.resolve().id, 'base');
    await assert.rejects(models.remove('base'), /built in and can't be removed/);
    await assert.rejects(models.remove('nope'), /There is no "nope" model/);
    // Removing what is not there is not an error.
    await models.remove('small');
});

t('chosen but missing: base runs, and says which was chosen', () => {
    const { models, state } = fakeModels(srv);
    state.active = 'small';
    assert.deepStrictEqual(models.resolve(), { id: 'base', file: models.fileFor('base'), fallback: 'small' });
    assert.deepStrictEqual(models.list().map((m) => m.active), [true, false]);
    // A truncated file is not installed either.
    fs.mkdirSync(models.dir, { recursive: true });
    fs.writeFileSync(models.fileFor('small'), PAYLOAD.subarray(0, 100));
    assert.strictEqual(models.installed('small'), false);
    // A name this version does not know is simply the default.
    state.active = 'large';
    assert.deepStrictEqual(models.resolve(), { id: 'base', file: models.fileFor('base'), fallback: null });
});

// ---- the page's end, through the IPC ------------------------------------------------

// ipcMain and ipcRenderer, joined: every message is a structured clone, as
// Electron's are, and both directions keep their order.
function ipcPair(senderId = 7) {
    const handlers = new Map();
    const listeners = new Map();
    const pageListeners = new Map();
    const clone = (v) => (v === undefined ? v : structuredClone(v));
    const sender = {
        id: senderId,
        destroyed: false,
        isDestroyed() { return this.destroyed; },
        send(channel, msg) {
            const m = clone(msg);
            queueMicrotask(() => { for (const fn of pageListeners.get(channel) || []) fn({}, m); });
        },
    };
    const ipcMain = {
        handle: (channel, fn) => handlers.set(channel, fn),
        on: (channel, fn) => listeners.set(channel, fn),
    };
    const ipcRenderer = {
        on(channel, fn) {
            if (!pageListeners.has(channel)) pageListeners.set(channel, []);
            pageListeners.get(channel).push(fn);
        },
        send(channel, ...args) {
            const a = args.map(clone);
            queueMicrotask(() => { const fn = listeners.get(channel); if (fn) fn({ sender }, ...a); });
        },
        invoke(channel, ...args) {
            const a = args.map(clone);
            return Promise.resolve()
                .then(() => handlers.get(channel)({ sender }, ...a))
                .then(clone);
        },
    };
    return { ipcMain, ipcRenderer, sender };
}

/**
 * The bridge the page sees, wired to `service` through a fake IPC. Each is a
 * window of its own (`senderId`); `modelsAllowed` is main.js's check, and
 * `models` the preload's.
 */
function bridgeOn(service, { senderId = 7, modelsAllowed, models = true } = {}) {
    const ipc = ipcPair(senderId);
    let w = null;
    const events = [];
    registerSttIpc({
        ipcMain: ipc.ipcMain,
        service,
        windowFor: () => {
            if (!w) w = service.createWindow((msg) => { events.push(msg); ipc.sender.send('stt:event', msg); });
            return w;
        },
        ...(modelsAllowed ? { modelsAllowed } : {}),
    });
    const pagehide = [];
    const win = { addEventListener: (type, fn) => { if (type === 'pagehide') pagehide.push(fn); } };
    const stt = createSttBridge({ ipc: ipc.ipcRenderer, win, models });
    return { stt, events, window: () => w, hide: () => pagehide.forEach((fn) => fn()) };
}

t('the bridge: models, an install with progress, choosing, removing, errors as Errors', async () => {
    const { models, state } = fakeModels(srv);
    const service = new SttService({ paths: { helper: '/nonexistent' }, models });
    const { stt } = bridgeOn(service);
    let list = await stt.models();
    assert.deepStrictEqual(list.map((m) => [m.id, m.installed, m.active]), [['base', true, true], ['small', false, false]]);

    await assert.rejects(stt.setModel('small'), (e) => e instanceof Error && /not downloaded yet/.test(e.message));
    const seen = [];
    await stt.installModel('small', (p) => seen.push(p));
    assert.ok(seen.length >= 1, 'no progress reached the page');
    assert.strictEqual(seen[seen.length - 1].received, PAYLOAD.length);
    await stt.setModel('small');
    assert.strictEqual(state.active, 'small');
    list = await stt.models();
    assert.deepStrictEqual(list.map((m) => [m.id, m.installed, m.active]), [['base', true, false], ['small', true, true]]);
    await assert.rejects(stt.removeModel('base'), /built in/);
    await stt.removeModel('small');
    list = await stt.models();
    assert.deepStrictEqual(list.map((m) => [m.id, m.installed, m.active]), [['base', true, true], ['small', false, false]]);

    // A cancel, from the page.
    const { models: slow } = fakeModels(srv, '/slow');
    const { stt: page } = bridgeOn(new SttService({ paths: { helper: '/nonexistent' }, models: slow }));
    const got = [];
    const p = page.installModel('small', (x) => got.push(x));
    await until(() => got.length > 2, 5000, 'progress');
    page.cancelInstall('small');
    await assert.rejects(p, /Download cancelled/);
});

t('one window cancelling a shared download: only its own install ends', async () => {
    const { models } = fakeModels(srv, '/slow');
    const service = new SttService({ paths: { helper: '/nonexistent' }, models });
    const a = bridgeOn(service, { senderId: 7 }).stt;
    const b = bridgeOn(service, { senderId: 8 }).stt;
    const seenA = [];
    const seenB = [];
    const from = srv.log.length;
    const pa = a.installModel('small', (x) => seenA.push(x.received));
    await until(() => seenA.length > 1, 5000, 'progress in A');
    const pb = b.installModel('small', (x) => seenB.push(x.received));
    await until(() => seenB.length > 1, 5000, 'progress in B');
    a.cancelInstall('small');
    await assert.rejects(pa, (e) => e.code === 'cancelled' && e.message === 'Download cancelled.');
    // B is still downloading, and finishes.
    assert.strictEqual(models.list()[1].downloading, true);
    await pb;
    assert.ok(fs.readFileSync(models.fileFor('small')).equals(PAYLOAD));
    assert.strictEqual(srv.log.length - from, 1, 'one download, not restarted');
    const lastA = seenA[seenA.length - 1];
    assert.ok(lastA < PAYLOAD.length, 'A went on being told after it cancelled');

    // Both cancelling stops it, and the piece is kept to carry on from.
    const { models: m2 } = fakeModels(srv, '/slow');
    const s2 = new SttService({ paths: { helper: '/nonexistent' }, models: m2 });
    const c = bridgeOn(s2, { senderId: 7 }).stt;
    const d = bridgeOn(s2, { senderId: 8 }).stt;
    const got = [];
    const pc = c.installModel('small', (x) => got.push(x));
    const pd = d.installModel('small');
    await until(() => got.length > 2, 5000, 'progress');
    c.cancelInstall('small');
    d.cancelInstall('small');
    await assert.rejects(pc, (e) => e.code === 'cancelled');
    await assert.rejects(pd, (e) => e.code === 'cancelled');
    await until(() => !m2.list()[1].downloading, 3000, 'the download to stop');
    assert.ok(fs.existsSync(`${m2.fileFor('small')}.part`), 'the piece was not kept');
});

t('a page that may not manage models: no model calls, and the main process refuses them anyway', async () => {
    const { models, state } = fakeModels(srv);
    const service = new SttService({ paths: { helper: '/nonexistent' }, models });
    // The preload leaves them off the object...
    const { stt: bare } = bridgeOn(service, { models: false });
    for (const k of ['models', 'installModel', 'cancelInstall', 'removeModel', 'setModel']) {
        assert.strictEqual(bare[k], undefined, k);
    }
    for (const k of ['languages', 'start', 'push', 'reset', 'stop']) assert.strictEqual(typeof bare[k], 'function', k);

    // ...and a page that reaches the channels regardless is turned away.
    const { stt } = bridgeOn(service, { modelsAllowed: () => false });
    assert.deepStrictEqual(await stt.models(), []);
    const from = srv.log.length;
    await assert.rejects(stt.installModel('small'), (e) => e.code === 'not-allowed');
    assert.strictEqual(srv.log.length, from, 'it fetched something');
    assert.strictEqual(fs.existsSync(models.fileFor('small')), false);
    fs.mkdirSync(models.dir, { recursive: true });
    fs.writeFileSync(models.fileFor('small'), PAYLOAD);
    state.active = 'small';
    await assert.rejects(stt.removeModel('small'), /own receiver page/);
    await assert.rejects(stt.setModel('base'), /own receiver page/);
    assert.ok(fs.existsSync(models.fileFor('small')), 'removed regardless');
    assert.strictEqual(state.active, 'small', 'chosen regardless');
});

t('the bundled page, and nothing else on the proxy\'s origin, is the client\'s own', () => {
    const { InstanceProxy } = require('../proxy.js');
    const ui = tmp();
    fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html>');
    const mk = (builtin) => {
        const p = new InstanceProxy({ host: 'example.invalid', port: 8080, uiDir: ui, builtin });
        p.localOrigin = 'http://127.0.0.1:41234';
        return p;
    };
    const own = mk(true);
    assert.strictEqual(own.isBundledPage('http://127.0.0.1:41234/v2/'), true);
    assert.strictEqual(own.isBundledPage('http://127.0.0.1:41234/v2/?freq=7074000'), true);
    assert.strictEqual(own.isBundledPage('http://127.0.0.1:41234/v2/index.html#x'), true);
    // Upstream's, on the same origin: a /v2 file the bundle does not have,
    // and anything outside /v2.
    assert.strictEqual(own.isBundledPage('http://127.0.0.1:41234/v2/other.html'), false);
    assert.strictEqual(own.isBundledPage('http://127.0.0.1:41234/'), false);
    assert.strictEqual(own.isBundledPage('http://127.0.0.1:41234/v2'), false);
    assert.strictEqual(own.isBundledPage('http://127.0.0.1:9/v2/'), false);
    assert.strictEqual(own.isBundledPage('not a url'), false);
    // An entry set to the receiver's own UI: /v2/ is upstream's too.
    assert.strictEqual(mk(false).isBundledPage('http://127.0.0.1:41234/v2/'), false);
});

t('without the helper: not available, and Start says what is missing', async () => {
    const { models } = fakeModels(srv);
    const service = new SttService({ paths: { helper: path.join(tmp(), 'whisper-helper') }, models });
    assert.strictEqual(service.available(), false);
    const { stt } = bridgeOn(service);
    await assert.rejects(
        stt.start({ lang: 'en', sampleRate: 16000 }),
        /the speech recogniser is missing from this installation — reinstall UberSDR/,
    );
    // The models are not enough on their own, nor the helper without them.
    const real = { helper: process.execPath };
    assert.strictEqual(new SttService({ paths: real, models }).available(), true);
    fs.unlinkSync(models.fileFor('vad'));
    assert.strictEqual(new SttService({ paths: real, models }).available(), false);
});

t('a rate other than 16 kHz is refused before anything starts', async () => {
    const { models } = fakeModels(srv);
    const { stt, events } = bridgeOn(new SttService({ paths: { helper: '/nonexistent' }, models }));
    await assert.rejects(stt.start({ lang: 'en', sampleRate: 48000 }), /16000 Hz, not 48000/);
    assert.deepStrictEqual(events, []);
});

// ---- the real helper ------------------------------------------------------------------

t('the real helper: available, and its languages as tags', async () => {
    const why = needsHelper(false);
    if (why) return why;
    const { service } = realService();
    assert.strictEqual(service.available(), true);
    const langs = await service.languages();
    assert.ok(langs.length >= 99, `${langs.length}`);
    for (const l of ['en', 'de', 'zh', 'yue', 'jv']) assert.ok(langs.includes(l), l);
    assert.ok(!langs.includes('jw'));
    // Asked once.
    assert.strictEqual(await service.languages(), langs);
    return '';
});

t('the real helper, through the bridge: interims and a final, then Stop', async () => {
    const why = needsHelper();
    if (why) return why;
    const spawn = recordingSpawn();
    const { service } = realService({ spawn });
    const { stt, window } = bridgeOn(service);
    assert.ok((await stt.languages()).includes('en'));

    const results = [];
    const errors = [];
    let ended = 0;
    await stt.start({
        lang: 'en-GB', sampleRate: 16000,
        onResult: (r) => results.push({ ...r, at: Date.now() }),
        onError: (e) => errors.push(e),
        onEnd: () => { ended += 1; },
    });
    assert.strictEqual(spawn.spawned.length, 1);
    assert.deepStrictEqual(spawn.spawned[0].args.slice(0, 4), [
        '--model', path.join(REAL.modelsDir, 'ggml-base-q5_1.bin'),
        '--vad-model', path.join(REAL.modelsDir, 'ggml-silero-v6.2.0.bin'),
    ]);
    // Pushed as the page pushes: Int16Array views, 100 ms at a time.
    await play((pcm) => stt.push(pcm), concat(speech, silence(1.5)), 2);
    await until(() => results.some((r) => r.final), 20000, 'a final');
    const finals = results.filter((r) => r.final);
    console.log(`      ${results.length - finals.length} interim(s), ${finals.length} final(s): ${finals.map((f) => f.text).join(' / ')}`);
    assert.ok(results.some((r) => !r.final), 'no interim');
    assert.ok(finals[0].text.split(/\s+/).length >= 2, `thin final: ${finals[0].text}`);
    assert.deepStrictEqual(errors, []);

    stt.stop();
    const stoppedAt = Date.now();
    await play((pcm) => window().push(-1, bytes(pcm)), speech.subarray(0, RATE), 4);
    await sleep(1500);
    assert.deepStrictEqual(results.filter((r) => r.at > stoppedAt + 100), [], 'results after Stop');
    assert.strictEqual(ended, 0, 'onEnd after the page stopped it');

    // The process stays up for the next session.
    await stt.start({ lang: 'de', sampleRate: 16000 });
    assert.strictEqual(spawn.spawned.length, 1, 'a new helper for the second session');
    stt.stop();
    window().dispose();
    await until(() => spawn.spawned[0].child.exitCode !== null || spawn.spawned[0].child.signalCode, 3000, 'the helper to exit');
    assert.strictEqual(spawn.spawned[0].child.exitCode, 0);
    return '';
});

t('the real helper: a language it does not have is the page\'s error, then the end', async () => {
    const why = needsHelper(false);
    if (why) return why;
    const { service } = realService();
    const { stt, window } = bridgeOn(service);
    const errors = [];
    let ended = 0;
    await stt.start({ lang: 'xx', onError: (e) => errors.push(e), onEnd: () => { ended += 1; } });
    await until(() => ended === 1, 5000, 'the end');
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].code, 'language-not-supported');
    assert.strictEqual(errors[0].fatal, true);
    window().dispose();
    return '';
});

t('the real helper: RESET drops what was heard, and the session goes on', async () => {
    const why = needsHelper();
    if (why) return why;
    const { service } = realService();
    const { stt, window } = bridgeOn(service);
    const results = [];
    await stt.start({ lang: 'en', onResult: (r) => results.push({ ...r, at: Date.now() }) });
    await play((pcm) => stt.push(pcm), speech.subarray(0, 4 * RATE), 2);
    stt.reset();
    const resetAt = Date.now();
    await play((pcm) => stt.push(pcm), silence(2), 2);
    await sleep(1500);
    assert.deepStrictEqual(results.filter((r) => r.final && r.at > resetAt + 200).map((r) => r.text), [], 'a final for the dropped utterance');
    await play((pcm) => stt.push(pcm), concat(speech, silence(1.5)), 2);
    await until(() => results.some((r) => r.final && r.at > resetAt + 200), 20000, 'a final after the reset');
    window().dispose();
    return '';
});

t('the real helper crashing mid-session: started again quietly, the session carries on', async () => {
    const why = needsHelper();
    if (why) return why;
    const spawn = recordingSpawn();
    const { service } = realService({ spawn });
    const { stt, window } = bridgeOn(service);
    const results = [];
    const errors = [];
    let ended = 0;
    await stt.start({
        lang: 'en', onResult: (r) => results.push({ ...r, at: Date.now() }), onError: (e) => errors.push(e), onEnd: () => { ended += 1; },
    });
    await play((pcm) => stt.push(pcm), speech.subarray(0, 2 * RATE), 4);
    spawn.spawned[0].child.kill('SIGKILL');
    const killedAt = Date.now();
    await until(() => spawn.spawned.length === 2, 5000, 'a new helper');
    await until(() => window().helper && window().helper.ready && window().session.startWritten, 5000, 'the session in it');
    await play((pcm) => stt.push(pcm), concat(speech, silence(1.5)), 2);
    await until(() => results.some((r) => r.final && r.at > killedAt), 20000, 'a final from the new helper');
    assert.deepStrictEqual(errors, [], 'the page was told about a retry');
    assert.strictEqual(ended, 0);

    // And one that will not stay up gives up, in words, and ends.
    for (let i = 0; i < 4 && !ended; i++) {
        await until(() => window().helper && window().helper.ready, 5000, 'a helper to kill');
        window().helper.child.kill('SIGKILL');
        await sleep(100);
    }
    await until(() => ended === 1, 5000, 'the end');
    assert.strictEqual(errors.length, 1);
    assert.deepStrictEqual({ ...errors[0], message: undefined }, { code: 'helper-crashed', fatal: true, message: undefined });
    assert.match(errors[0].message, /keeps crashing/);
    window().dispose();
    return '';
});

t('the real helper: a downloaded model that fails its pins goes, and Base carries on with a note', async () => {
    const why = needsHelper(false);
    if (why) return why;
    const junk = Buffer.alloc(4096, 7);
    const spawn = recordingSpawn();
    // The pinned size, so it counts as installed, but not the pinned bytes.
    const { service, models, state } = realService({
        chosen: 'small', spawn,
        small: { size: junk.length, sha256: crypto.createHash('sha256').update(Buffer.alloc(4096, 8)).digest('hex') },
    });
    fs.mkdirSync(models.dir, { recursive: true });
    fs.writeFileSync(models.fileFor('small'), junk);
    assert.strictEqual(models.resolve().id, 'small');
    const { stt, window } = bridgeOn(service);
    const errors = [];
    await stt.start({ lang: 'en', onError: (e) => errors.push(e) });
    await until(() => errors.length, 3000, 'the note');
    assert.deepStrictEqual({ ...errors[0], message: undefined }, { code: 'model-fallback', fatal: false, message: undefined });
    assert.match(errors[0].message, /The Small model was damaged, so it has been removed and the Base model is being used instead/);
    assert.ok(!fs.existsSync(models.fileFor('small')), 'the damaged file is still there');
    assert.strictEqual(state.active, null, 'still chosen after it was removed');
    assert.strictEqual(spawn.spawned.length, 2);
    assert.strictEqual(spawn.spawned[1].args[1], path.join(REAL.modelsDir, 'ggml-base-q5_1.bin'));
    window().dispose();
    return '';
});

t('the real helper: a good download that fails to load is kept, and tried again next time', async () => {
    const why = needsHelper(false);
    if (why) return why;
    // Matches its pins, and still will not load — standing in for a scanner
    // holding the file, or too little memory.
    const junk = Buffer.alloc(4096, 7);
    const spawn = recordingSpawn();
    const { service, models, state } = realService({
        chosen: 'small', spawn,
        small: { size: junk.length, sha256: crypto.createHash('sha256').update(junk).digest('hex') },
    });
    fs.mkdirSync(models.dir, { recursive: true });
    fs.writeFileSync(models.fileFor('small'), junk);
    const { stt, window } = bridgeOn(service);
    const errors = [];
    await stt.start({ lang: 'en', onError: (e) => errors.push(e) });
    await until(() => errors.length, 3000, 'the note');
    assert.strictEqual(errors[0].code, 'model-fallback');
    assert.match(errors[0].message, /The Small model couldn't be loaded this time .* so the Base model is being used instead\. It will be tried again at the next Start\./);
    assert.ok(fs.existsSync(models.fileFor('small')), 'a good file was deleted');
    assert.strictEqual(state.active, 'small', 'the choice was dropped');
    assert.strictEqual(spawn.spawned[1].args[1], path.join(REAL.modelsDir, 'ggml-base-q5_1.bin'));
    // The next Start goes for Small again.
    stt.stop();
    await stt.start({ lang: 'en', onError: (e) => errors.push(e) });
    await until(() => errors.length > 1, 3000, 'the second note');
    assert.strictEqual(spawn.spawned[2].args[1], models.fileFor('small'));
    window().dispose();
    return '';
});

t('the real helper: a new model is taken up at the next start', async () => {
    const why = needsHelper(false);
    if (why) return why;
    const spawn = recordingSpawn();
    // The real small model if one is to hand (WHISPER_SMALL_MODEL); the base
    // file under small's name otherwise, which is just as good a test of
    // which file the helper is handed.
    const source = SMALL_REAL && fs.existsSync(SMALL_REAL) ? SMALL_REAL : path.join(REAL.modelsDir, 'ggml-base-q5_1.bin');
    const { service, models } = realService({ spawn, small: { size: fs.statSync(source).size } });
    const { stt, window } = bridgeOn(service);
    await stt.start({ lang: 'en' });
    stt.stop();
    fs.mkdirSync(models.dir, { recursive: true });
    fs.symlinkSync(source, models.fileFor('small'));
    await stt.setModel('small');
    // Not until then: a running session is not pulled out from under the page.
    assert.strictEqual(spawn.spawned.length, 1);
    await stt.start({ lang: 'en' });
    assert.strictEqual(spawn.spawned.length, 2);
    assert.strictEqual(spawn.spawned[1].args[1], models.fileFor('small'));
    await until(() => spawn.spawned[0].child.exitCode !== null, 3000, 'the old helper to go');
    window().dispose();
    return '';
});

t('the real helper: the page going away stops its session', async () => {
    const why = needsHelper(false);
    if (why) return why;
    const { service } = realService();
    const b = bridgeOn(service);
    await b.stt.start({ lang: 'en' });
    assert.ok(b.window().session);
    b.hide();
    await until(() => !b.window().session, 2000, 'the session to end');
    service.disposeAll();
    return '';
});

(async () => {
    for (const { name, fn } of tests) {
        try {
            const skip = await fn();
            if (skip) {
                console.log(`skip  ${name}\n      ${skip}`);
                skipped++;
            } else {
                console.log('ok    ' + name);
                pass++;
            }
        } catch (e) {
            console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message));
            process.exitCode = 1;
        }
    }
    if (srv) srv.server.close();
    console.log(`\n${pass} passed${skipped ? `, ${skipped} skipped` : ''}`);
    // A helper a failed test left behind must not hold the run open.
    setTimeout(() => process.exit(), 200).unref();
})();

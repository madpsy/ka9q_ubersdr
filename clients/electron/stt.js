'use strict';

// Speech-to-text on this computer, for the Speech-to-Text extension's "On this
// device" mode: whisper.cpp in a helper process, one per receiver window.
//
// A desktop Electron has no recogniser the page can use — Chromium's on-device
// one kills the renderer that touches it (see static/v2/src/extensions/whisper/
// engines/index.js) — so this client brings its own: whisper/whisper-helper, a
// static build of whisper.cpp with a multilingual model shipped beside it. The
// page reaches it through `window.ubersdrDesktop.stt`, whose contract is at the
// top of static/v2/src/extensions/whisper/engines/host.js; the preload's half
// is sttbridge.js, and this is the main process's.
//
// One helper per receiver window, started the first time that window presses
// Start and kept between sessions — loading a model takes a tenth of a second,
// but a process per Start would also throw away the helper's settled language
// and its warm caches. It goes when the window closes or the app quits.
// Separate processes rather than one shared: two windows transcribing at once
// is two streams of audio, and the helper does one.
//
// The helper's protocol is at the top of whisper/whisper_helper.cpp: frames on
// stdin, JSON lines on stdout. What this adds is the page's side of the
// contract — its session ids, its error wording, a helper that dies being
// started again under a session that carries on — and choosing which model to
// start it with (sttmodels.js).

const { spawn: nodeSpawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const FRAME = { START: 1, AUDIO: 2, RESET: 3, STOP: 4 };
const RATE = 16000;

// Loading base takes a tenth of a second and small about half of one; a
// helper that has said nothing after this is stuck on a disk that is not
// answering, and Start should say so rather than sit at "Starting…".
const READY_TIMEOUT_MS = 30000;
// START is answered at once: the helper only checks the language.
const STARTED_TIMEOUT_MS = 10000;
// A helper asked to go (stdin closed) exits straight away, abandoning any
// decode. One that has not after this is killed.
const QUIT_GRACE_MS = 2000;
// A helper that crashes mid-session is started again under the same session,
// quietly — the contract asks a host to retry what it can without bothering
// the page. This many times in this long, and it is not going to stop
// crashing: the session ends with a fatal error instead.
const RESPAWN = { max: 3, windowMs: 60000 };
// Audio waiting to be written to a helper that is not reading it. The helper
// reads stdin on a thread of its own and never blocks, so this is only ever
// reached by a hung one, and then 30 s of audio is plenty to give up on.
const MAX_QUEUED_BYTES = 30 * RATE * 2;

// Whisper's language codes are ISO 639-1 with one exception the page would
// not recognise: Javanese is `jw` to Whisper and `jv` to everybody else. The
// helper takes either (and BCP-47 tags generally), so only the list it gives
// needs translating on the way out.
const WHISPER_TO_TAG = { jw: 'jv' };
// What the helper also accepts, done here too so a tag the page sends is
// turned into exactly the code the language list offered.
const TAG_TO_WHISPER = { jv: 'jw', nb: 'no', iw: 'he', in: 'id', ji: 'yi', fil: 'tl', cmn: 'zh' };

/** A Whisper language code as the BCP-47 tag the page lists and names. */
function fromWhisperLang(code) {
    const c = String(code || '').toLowerCase();
    return WHISPER_TO_TAG[c] || c;
}

/** A tag the page chose ('en', 'en-GB', 'jv') as a Whisper language code. */
function toWhisperLang(tag) {
    const t = String(tag || '').trim();
    if (!t) return 'auto';
    const primary = t.split(/[-_]/)[0].toLowerCase();
    return TAG_TO_WHISPER[primary] || primary;
}

/**
 * Whisper's languages as the page's list: tags, alphabetical by English name.
 * The helper gives them in the order of how much training data each had,
 * which is no order to find one in among a hundred.
 */
function languageList(codes) {
    let names = null;
    try { names = new Intl.DisplayNames(['en'], { type: 'language' }); } catch { /* no ICU */ }
    const name = (tag) => {
        try { return (names && names.of(tag)) || tag; } catch { return tag; }
    };
    const seen = new Set();
    return (Array.isArray(codes) ? codes : [])
        .map(fromWhisperLang)
        .filter((t) => /^[a-z]{2,3}$/.test(t) && !seen.has(t) && seen.add(t))
        .map((t) => ({ t, n: name(t) }))
        .sort((a, b) => a.n.localeCompare(b.n, 'en'))
        .map((x) => x.t);
}

// --- where things are --------------------------------------------------------

/** whisper/dist/'s directory for this platform, or null where none is built. */
function platformDir(platform, arch) {
    // One universal binary: arm64, and x86_64h beside plain x86_64 so a
    // Haswell or later Intel Mac gets the AVX2 build without being asked.
    if (platform === 'darwin') return 'darwin-universal';
    const os = { linux: 'linux', win32: 'win' }[platform];
    if (!os || (arch !== 'x64' && arch !== 'arm64')) return null;
    return `${os}-${arch}`;
}

function helperName(platform) {
    return platform === 'win32' ? 'whisper-helper.exe' : 'whisper-helper';
}

/**
 * The helper, the shipped models and the pins.
 *
 * Packaged, the helper and its models are beside app.asar (extraResources in
 * package.json puts them in resources/whisper/, outside the archive, because an
 * executable cannot be run from inside one — and the x86 helper hands over to
 * its AVX2 sibling, which it looks for next to itself). Run from source, they
 * are wherever whisper/build.sh left them. The two are taken as a pair, by
 * whether the packaged helper is there: a helper from one and models from the
 * other is a combination nobody tested.
 *
 * models.json is read from the app itself in both cases — it is in build.files,
 * and it is the pins the download is checked against, which must be the ones
 * this version was built with.
 */
function sttPaths({
    resourcesPath = process.resourcesPath,
    appDir = __dirname,
    platform = process.platform,
    arch = process.arch,
    exists = fs.existsSync,
} = {}) {
    const name = helperName(platform);
    const dir = platformDir(platform, arch);
    const packaged = resourcesPath ? {
        helper: path.join(resourcesPath, 'whisper', name),
        modelsDir: path.join(resourcesPath, 'whisper', 'models'),
    } : null;
    const dev = {
        helper: dir ? path.join(appDir, 'whisper', 'dist', dir, name) : null,
        modelsDir: path.join(appDir, 'whisper', 'dist', 'models'),
    };
    const root = packaged && exists(packaged.helper) ? packaged : dev;
    return { ...root, pins: path.join(appDir, 'whisper', 'models.json'), packaged: root === packaged };
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// --- the helper's frames ------------------------------------------------------

function header(type, length) {
    const head = Buffer.alloc(5);
    head[0] = type;
    head.writeUInt32LE(length, 1);
    return head;
}

/** Bytes from whatever the IPC delivered: a Uint8Array, a Buffer, an ArrayBuffer. */
function bytesOf(data) {
    if (!data) return null;
    if (Buffer.isBuffer(data)) return data;
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    return null;
}

// --- what goes wrong, in words ------------------------------------------------

const REINSTALL = 'reinstall UberSDR';

/** Why a helper did not come up, as the end of "On-device recognition couldn't start: …". */
function startFailureText(e) {
    const code = e && e.code;
    if (code === 'ENOENT' || code === 'EACCES' || code === 'helper-missing') {
        return `the speech recogniser is missing from this installation — ${REINSTALL}`;
    }
    if (code === 'vad-model-missing' || code === 'vad-model-invalid') {
        return `the voice-activity model is missing or damaged — ${REINSTALL}`;
    }
    if (code === 'model-missing' || code === 'model-invalid') {
        return `the speech model is missing or damaged — ${REINSTALL}`;
    }
    if (code === 'ready-timeout') return 'the speech recogniser took too long to load its model';
    if (code === 'started-timeout') return 'the speech recogniser stopped answering';
    return (e && e.message) || 'the speech recogniser would not start';
}

const MODEL_ERRORS = new Set(['model-missing', 'model-invalid']);

// --- one window's recogniser --------------------------------------------------

class SttWindow {
    /**
     * @param {object} o
     * @param {SttService} o.service
     * @param {Function} o.send   (msg) => void: an event for this window's
     *                            preload — {session, type: 'result'|'error'|'end', …}
     */
    constructor({ service, send }) {
        this.service = service;
        this.send = send;
        this.helper = null;     // {child, model, ready, readyWait, error, stderr}
        this.session = null;    // {id, lang, plan, startWritten, pending}
        this.crashes = [];
        this.disposed = false;
    }

    // ---- the page's calls ----------------------------------------------------

    /**
     * Begin session `id` in `lang`. Resolves `{ok: true}` once the helper has
     * the session, or `{ok: false, message}` — never rejects, because an IPC
     * rejection reaches the page wrapped in Electron's own wording, and the
     * message is shown to the user as it stands.
     */
    async start(id, lang) {
        if (this.disposed) return { ok: false, message: 'the window is closing' };
        // A new session replaces the one before, as the page's restarts expect.
        if (this.session) this.endSession(true, 'replaced by a new session');
        const sess = { id, lang: String(lang || ''), plan: null, startWritten: false, pending: null };
        const result = new Promise((resolve) => { sess.pending = { resolve, timer: null }; });
        this.session = sess;
        this.crashes = [];

        const models = this.service.models;
        let plan = models.resolve();
        if (!plan.file) {
            this.settle(sess, { ok: false, message: 'no speech model is installed' });
            if (this.session === sess) this.session = null;
            return result;
        }
        try {
            await this.ensureHelper(plan.file);
        } catch (e) {
            // A downloaded model that will not load: the shipped one is the
            // way on for this session, with a note saying so. Whether the
            // download goes too is for its pins to say, not the failure —
            // a load also fails for a scanner holding the file or too little
            // memory, and the file is fine (ModelManager.verify). A damaged
            // one is deleted; a good one is kept, still chosen, and tried
            // again at the next Start. The shipped one failing is the
            // installation's fault.
            if (this.session === sess && MODEL_ERRORS.has(e && e.code) && plan.id !== models.defaultId) {
                const failed = plan.id;
                let verdict = 'unknown';
                try { verdict = await models.verify(failed); } catch { /* kept, then */ }
                const base = models.defaultId;
                plan = { id: base, file: models.fileFor(base), fallback: failed, damaged: verdict === 'bad', loadFailed: true };
                try {
                    await this.ensureHelper(plan.file);
                    e = null;
                } catch (again) {
                    e = again;
                }
            }
            if (e) {
                if (this.session === sess) this.session = null;
                this.settle(sess, { ok: false, message: startFailureText(e) });
                return result;
            }
        }
        // Stopped or replaced while the model loaded: whoever did that has
        // already answered this start.
        if (this.session !== sess) return result;
        sess.plan = plan;
        this.writeStart(sess);
        return result;
    }

    push(id, data) {
        const sess = this.session;
        const h = this.helper;
        if (!sess || sess.id !== id || !sess.startWritten || !h || !h.ready) return;
        const body = bytesOf(data);
        if (!body || !body.length) return;
        if (h.child.stdin.writableLength > MAX_QUEUED_BYTES) return;
        this.write(h, FRAME.AUDIO, body);
    }

    reset(id) {
        const sess = this.session;
        if (!sess || sess.id !== id || !sess.startWritten || !this.helper) return;
        this.write(this.helper, FRAME.RESET);
    }

    stop(id) {
        if (this.session && this.session.id === id) this.endSession(true, 'stopped');
    }

    /** The window has gone: the session with it, and the helper. */
    dispose() {
        this.disposed = true;
        if (this.session) this.endSession(true, 'the window closed');
        if (this.helper) this.retire(this.helper);
    }

    // ---- sessions --------------------------------------------------------------

    writeStart(sess) {
        const payload = Buffer.from(JSON.stringify({ lang: toWhisperLang(sess.lang), session: sess.id }));
        this.write(this.helper, FRAME.START, payload);
        sess.startWritten = true;
        if (sess.pending && !sess.pending.timer) {
            sess.pending.timer = setTimeout(() => {
                if (this.session !== sess || !sess.pending) return;
                this.session = null;
                this.settle(sess, { ok: false, message: startFailureText({ code: 'started-timeout' }) });
                if (this.helper) this.retire(this.helper);
            }, this.service.startedTimeoutMs);
        }
    }

    /** Answer a start that is still waiting. */
    settle(sess, answer) {
        const p = sess.pending;
        if (!p) return;
        sess.pending = null;
        if (p.timer) clearTimeout(p.timer);
        p.resolve(answer);
    }

    /** The page asked for the session to end, or replaced it. */
    endSession(tellHelper, why) {
        const sess = this.session;
        this.session = null;
        if (!sess) return;
        if (tellHelper && sess.startWritten && this.helper) this.write(this.helper, FRAME.STOP);
        this.settle(sess, { ok: false, message: why });
    }

    /**
     * The session cannot go on: a fatal error, then the end, as the contract
     * has it. A start still waiting is answered instead, since the page has
     * no session to send them to yet.
     */
    failSession(sess, error) {
        if (this.session !== sess) return;
        this.session = null;
        if (sess.pending) {
            this.settle(sess, { ok: false, message: error.message });
            return;
        }
        this.send({ session: sess.id, type: 'error', ...error, fatal: true });
        this.send({ session: sess.id, type: 'end' });
    }

    /** A note that does not stop anything. */
    notify(sess, code, message) {
        this.send({ session: sess.id, type: 'error', code, message, fatal: false });
    }

    // ---- the helper process ----------------------------------------------------

    /** A helper on `model`, up and ready. Resolves once it is, rejects with its reason. */
    ensureHelper(model) {
        const h = this.helper;
        if (h && h.model === model) return h.readyWait;
        if (h) this.retire(h);
        return this.spawnHelper(model).readyWait;
    }

    spawnHelper(model) {
        const svc = this.service;
        const args = ['--model', model, '--vad-model', svc.vadFile()];
        if (svc.threads) args.push('--threads', String(svc.threads));
        const h = { child: null, model, ready: false, readyWait: null, error: null, stderr: '', exited: false };
        let resolveReady;
        let rejectReady;
        h.readyWait = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
        // Nobody may be waiting by the time it fails — a retired helper's
        // start has been answered already.
        h.readyWait.catch(() => {});
        h.resolveReady = resolveReady;
        h.rejectReady = rejectReady;
        this.helper = h;

        let child;
        try {
            child = svc.spawn(svc.paths.helper, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        } catch (err) {
            this.helper = null;
            h.exited = true;
            rejectReady(err);
            return h;
        }
        h.child = child;
        const readyTimer = setTimeout(() => {
            if (h.ready || h.exited) return;
            const err = new Error('ready-timeout');
            err.code = 'ready-timeout';
            rejectReady(err);
            this.retire(h);
        }, svc.readyTimeoutMs);

        let buffer = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            buffer += chunk;
            let at;
            while ((at = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, at).trim();
                buffer = buffer.slice(at + 1);
                if (line) this.onLine(h, line);
            }
        });
        // Kept, the last of it, for a failure nothing on stdout explains; and
        // read either way, because an unread pipe fills and a helper blocked
        // writing to it stops transcribing.
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (d) => { h.stderr = (h.stderr + d).slice(-4000); });
        // A write to a helper that has just died is reported by 'close'.
        child.stdin.on('error', () => {});
        child.on('error', (err) => {
            // Could not be run at all — ENOENT, EACCES. 'close' may not follow.
            clearTimeout(readyTimer);
            this.onExit(h, null, err);
        });
        // 'close' rather than 'exit': exit can come before the last of stdout
        // has been read, and the last line is the error that says why.
        child.on('close', (code, signal) => {
            clearTimeout(readyTimer);
            this.onExit(h, code, null, signal);
        });
        return h;
    }

    /** Ask a helper to go: no more input is its signal to exit. */
    retire(h) {
        h.retired = true;
        if (this.helper === h) this.helper = null;
        if (!h.child || h.exited) return;
        const err = new Error('replaced');
        err.code = 'retired';
        h.rejectReady(err);
        try { h.child.stdin.end(); } catch { /* already closed */ }
        const kill = setTimeout(() => { try { h.child.kill('SIGKILL'); } catch { /* gone */ } }, QUIT_GRACE_MS);
        if (kill.unref) kill.unref();
        h.child.once('close', () => clearTimeout(kill));
    }

    write(h, type, body) {
        if (!h || !h.child || h.exited) return;
        const stdin = h.child.stdin;
        try {
            if (body && body.length) {
                stdin.cork();
                stdin.write(header(type, body.length));
                stdin.write(body);
                stdin.uncork();
            } else {
                stdin.write(header(type, 0));
            }
        } catch { /* a helper on its way out; 'close' says so */ }
    }

    onLine(h, line) {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ready') {
            h.ready = true;
            h.resolveReady();
            return;
        }
        // Everything else is about a session, and only the current one — and
        // only from the current helper: a retired one may still be finishing
        // a line.
        if (h !== this.helper) return;
        if (msg.type === 'error' && msg.session == null) {
            // A model failure, fatal to the helper, which exits next; kept for
            // that exit to report.
            if (msg.fatal) h.error = { code: String(msg.code || ''), message: String(msg.message || '') };
            return;
        }
        const sess = this.session;
        if (!sess || msg.session !== sess.id) return;
        switch (msg.type) {
        case 'started':
            if (sess.pending) {
                this.settle(sess, { ok: true });
                // After the answer, so it lands in a session the page has.
                if (sess.plan && sess.plan.fallback) {
                    setImmediate(() => { if (this.session === sess) this.notify(sess, 'model-fallback', fallbackText(sess.plan)); });
                }
            }
            break;
        case 'result':
            this.send({ session: sess.id, type: 'result', text: String(msg.text || ''), final: !!msg.final });
            break;
        case 'error':
            this.onSessionError(sess, msg);
            break;
        default:
            break;
        }
    }

    onSessionError(sess, msg) {
        const code = String(msg.code || 'error');
        if (code === 'falling-behind') {
            this.notify(sess, code, fallingBehindText(msg.message, sess.plan));
            return;
        }
        if (!msg.fatal) {
            if (code !== 'protocol') this.notify(sess, code, String(msg.message || ''));
            return;
        }
        // Fatal to the session — an unsupported language, which the helper
        // says instead of `started`. The page has its own words for that one,
        // naming the language, so the code is what matters. The start is
        // answered first: it did start, and this is how it ended.
        this.session = null;
        this.settle(sess, { ok: true });
        setImmediate(() => {
            this.send({ session: sess.id, type: 'error', code, message: String(msg.message || ''), fatal: true });
            this.send({ session: sess.id, type: 'end' });
        });
    }

    onExit(h, code, err, signal) {
        if (h.exited) return;
        h.exited = true;
        const current = this.helper === h;
        if (current) this.helper = null;
        if (!h.ready) {
            const reason = err || new Error(h.error ? h.error.message : `exited with ${code != null ? `code ${code}` : signal}`);
            if (!err && h.error) reason.code = h.error.code;
            h.rejectReady(reason);
            return;
        }
        if (!current || h.retired || this.disposed) return;
        // Up, and then gone without being asked: a crash. A session in
        // progress carries on in a new helper.
        const sess = this.session;
        if (!sess) return;
        const now = Date.now();
        this.crashes = this.crashes.filter((t) => now - t < RESPAWN.windowMs);
        this.crashes.push(now);
        if (this.crashes.length > RESPAWN.max) {
            this.failSession(sess, {
                code: 'helper-crashed',
                message: 'The speech recogniser keeps crashing, so it has been stopped.',
            });
            return;
        }
        this.respawn(sess);
    }

    async respawn(sess) {
        sess.startWritten = false;
        // No plan yet only if it crashed in the moment between coming up and
        // the session being written to it; start() writes the session then.
        if (!sess.plan) return;
        try {
            await this.ensureHelper(sess.plan.file);
        } catch (e) {
            if (this.session === sess) {
                this.failSession(sess, { code: 'helper-crashed', message: `The speech recogniser stopped and would not start again: ${startFailureText(e)}.` });
            }
            return;
        }
        if (this.session !== sess) return;
        this.writeStart(sess);
    }
}

function fallbackText(plan) {
    const name = plan.fallback === 'small' ? 'Small' : plan.fallback;
    if (plan.damaged) {
        return `The ${name} model was damaged, so it has been removed and the Base model is being used instead. Download it again under Model.`;
    }
    if (plan.loadFailed) {
        return `The ${name} model couldn't be loaded this time — another program may be using the file, or memory is short — so the Base model is being used instead. It will be tried again at the next Start.`;
    }
    return `The ${name} model isn't downloaded, so the Base model is being used instead.`;
}

function fallingBehindText(helperMessage, plan) {
    const m = /([\d.]+) s/.exec(String(helperMessage || ''));
    const lost = m ? `${m[1]} s of audio was` : 'some audio was';
    const advice = plan && plan.id !== 'base'
        ? ' The Base model is several times quicker — choose it under Model.'
        : ' Something else keeping this computer busy can cause it.';
    return `Transcription fell behind the audio, so ${lost} skipped.${advice}`;
}

// --- the app's half -----------------------------------------------------------

class SttService {
    /**
     * @param {object} o
     * @param {object} o.paths     from sttPaths()
     * @param {ModelManager} o.models
     * @param {number} [o.threads]  passed to the helper; its own default is
     *                              min(4, cores - 1)
     * @param {Function} [o.spawn]  for the tests
     */
    constructor({
        paths, models, threads = 0, spawn = nodeSpawn,
        readyTimeoutMs = READY_TIMEOUT_MS, startedTimeoutMs = STARTED_TIMEOUT_MS,
    }) {
        this.paths = paths;
        this.models = models;
        this.threads = threads;
        this.spawn = spawn;
        this.readyTimeoutMs = readyTimeoutMs;
        this.startedTimeoutMs = startedTimeoutMs;
        this.windows = new Set();
        this.languagesPromise = null;
    }

    vadFile() {
        return this.models.fileFor('vad');
    }

    /**
     * Whether this build can transcribe at all: the helper for this platform
     * and the shipped models are all there. A build without them — an
     * architecture nobody built a helper for, a tree where whisper/build.sh
     * never ran — has no local mode, rather than one that fails at Start.
     */
    available() {
        try {
            return !!this.paths.helper && fs.existsSync(this.paths.helper)
                && !!this.models.defaultId && this.models.installed(this.models.defaultId)
                && this.models.installed('vad');
        } catch {
            return false;
        }
    }

    /**
     * The languages, as tags. Asked of the helper once (`--languages`) and
     * remembered; a failure is not remembered, so the next look asks again.
     */
    languages() {
        if (!this.languagesPromise) {
            this.languagesPromise = new Promise((resolve, reject) => {
                execFile(this.paths.helper, ['--languages'], { timeout: 15000, windowsHide: true }, (err, stdout) => {
                    if (err) { reject(err); return; }
                    try { resolve(languageList(JSON.parse(stdout))); } catch (e) { reject(e); }
                });
            }).catch((e) => {
                this.languagesPromise = null;
                throw e;
            });
        }
        return this.languagesPromise;
    }

    /** A recogniser for one window. `send` delivers its events to that window. */
    createWindow(send) {
        const w = new SttWindow({ service: this, send });
        this.windows.add(w);
        const dispose = w.dispose.bind(w);
        w.dispose = () => { this.windows.delete(w); dispose(); };
        return w;
    }

    /** The app is quitting: every helper, every download. */
    disposeAll() {
        for (const w of [...this.windows]) w.dispose();
        this.models.cancelAll();
    }
}

// --- IPC ----------------------------------------------------------------------

/**
 * The channels sttbridge.js talks to.
 *
 * `windowFor(sender)` is the SttWindow for a receiver window's webContents,
 * made on first use, or null for anything that is not a receiver window — the
 * chooser, a popup — which then gets nothing.
 *
 * `modelsAllowed(event)` says whether the page asking may touch the models.
 * In the app, only this client's own bundled UI may (main.js): a receiver
 * window can also be showing a page the receiver served — an entry set to the
 * receiver's own UI, or a /v2 file the bundle does not have — and that page is
 * the receiver operator's, not this computer's user's. It can transcribe,
 * which only costs CPU while the window is open; it cannot delete a download,
 * change which model every window uses, or pull 190 MB down over and over.
 *
 * What a page can do through these, since this is the main process: run the
 * bundled helper on audio it supplies, and (if allowed) list and choose between
 * the models in models.json, download one of those from its pinned URL into the
 * one folder, and delete that download. No path, URL or argument of its own
 * reaches a file, a process or the network.
 */
function registerSttIpc({ ipcMain, service, windowFor, modelsAllowed = (event) => !!windowFor(event.sender) }) {
    const answer = (fn) => Promise.resolve()
        .then(fn)
        .then(() => ({ ok: true }), (e) => ({ ok: false, message: (e && e.message) || String(e), code: (e && e.code) || '' }));

    ipcMain.handle('stt:languages', () => service.languages().catch(() => []));
    ipcMain.handle('stt:start', (event, req) => {
        const w = windowFor(event.sender);
        if (!w) return { ok: false, message: 'not a receiver window' };
        const r = req && typeof req === 'object' ? req : {};
        return w.start(Number(r.session), String(r.lang || ''));
    });
    ipcMain.on('stt:audio', (event, session, data) => {
        const w = windowFor(event.sender);
        if (w) w.push(Number(session), data);
    });
    ipcMain.on('stt:reset', (event, session) => {
        const w = windowFor(event.sender);
        if (w) w.reset(Number(session));
    });
    ipcMain.on('stt:stop', (event, session) => {
        const w = windowFor(event.sender);
        if (w) w.stop(Number(session));
    });

    const refused = { ok: false, message: 'Models can only be managed from UberSDR\'s own receiver page.', code: 'not-allowed' };
    const allowed = (event) => {
        try { return !!modelsAllowed(event); } catch { return false; }
    };
    ipcMain.handle('stt:models', (event) => (allowed(event) ? service.models.list() : []));
    // The window is the download's owner: its Cancel is its own, and another
    // window waiting on the same download carries on (ModelManager.cancel).
    ipcMain.handle('stt:install-model', (event, id) => {
        if (!allowed(event)) return refused;
        return answer(() => service.models.install(String(id), (p) => {
            try {
                if (!event.sender.isDestroyed()) event.sender.send('stt:install-progress', { id: String(id), ...p });
            } catch { /* the window went */ }
        }, event.sender.id));
    });
    ipcMain.on('stt:cancel-install', (event, id) => {
        if (allowed(event)) service.models.cancel(String(id), event.sender.id);
    });
    ipcMain.handle('stt:remove-model', (event, id) => (allowed(event) ? answer(() => service.models.remove(String(id))) : refused));
    ipcMain.handle('stt:set-model', (event, id) => (allowed(event) ? answer(() => service.models.setActive(String(id))) : refused));
}

module.exports = {
    SttService, SttWindow, registerSttIpc, sttPaths, platformDir, helperName, readJson,
    toWhisperLang, fromWhisperLang, languageList, FRAME, RESPAWN,
};

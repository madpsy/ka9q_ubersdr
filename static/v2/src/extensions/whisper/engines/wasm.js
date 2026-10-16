// Speech-to-text on the device: Whisper in the browser, as WebAssembly.
//
// Where no app brings a recogniser of its own, the page brings one: the same
// Whisper session the desktop client runs in its helper process
// (clients/electron/whisper/whisper_session.cpp), compiled to WebAssembly and
// run in a Web Worker (../wasm/worker.entry.js). It answers the host contract
// in ./host.js — languages, start, push, reset, stop, and the five model calls —
// so the page drives it exactly as it drives the desktop client's: through
// createHostEngine, and the Model setting through ../useHostModels.js.
//
// No model ships with the page. Base (60 MB) and Tiny (32 MB) are downloaded on
// request, from the URLs ../../../../../clients/electron/whisper/models.json
// pins, checked against the pinned size and SHA-256 as they arrive, and kept in
// IndexedDB, so a model is fetched once per browser per receiver site and is
// there on the next visit. IndexedDB rather than the Cache API because the
// latter, like crypto.subtle, exists only on HTTPS pages, and many receivers
// are reached over plain HTTP. The page asks for persistent storage after a
// download, so the browser does not clear a model it is short of space for.
// Storage belongs to the site, so each receiver's site downloads its own copy:
// nothing can be shared across sites, or with the desktop client's.
//
// Base is the better transcriber; Tiny the one that keeps up on a slow
// machine. Measured on one thread in Chrome on 5 s chunks of an AM broadcast,
// in seconds of work per second of audio: Tiny 0.32, Base 0.69 — and over a
// whole broadcast in real time, through the VAD, Base kept up with finals two
// to five seconds after each utterance ended. One thread because more would
// need the page cross-origin isolated, which no receiver is. The rest of the
// reasoning is at the top of clients/electron/whisper/wasm/whisper_wasm.cpp.
//
// Only in a browser: inside one of UberSDR's apps — window.ubersdrDesktop
// present — the app's recogniser is the one used, and this is never offered,
// even where the app has none, so the apps behave exactly as they did.

import { STT_RATE } from '../pcm.js';
import { createSha256 } from '../sha256.js';
import { WASM_BUILD, WASM_PINS } from '../wasm/build.generated.js';

const LABELS = { base: 'Base', tiny: 'Tiny' };
// Where the worker script is, relative to the page, as the playground's is.
export const WORKER_URL = 'dist/whisper-worker.js';
const MODULE_PATH = 'whisper/whisper-stt';

const DB_NAME = 'ubersdr-stt-models';
const DB_STORE = 'models';
// What is installed and which is in use, mirrored where it can be read
// synchronously: the panel decides its default source during a render.
const HINT_KEY = 'ubersdr.v2.stt.wasm';

// The progress bar's cadence; see clients/electron/sttmodels.js.
const PROGRESS_MS = 250;

export const NO_MODEL_MESSAGE = 'Download a speech model first — choose one under Model and press Download. It is kept in this browser for next time.';

const theWindow = () => (typeof window !== 'undefined' ? window : {});

// The smallest module with a SIMD instruction in it: one function, () -> (),
// whose body is v128.const 0, drop. An engine without SIMD rejects it.
const SIMD_PROBE = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,                        // \0asm, version 1
    1, 4, 1, 96, 0, 0,                                   // types: () -> ()
    3, 2, 1, 0,                                          // one function of it
    10, 23, 1, 21, 0,                                    // code: one body, 21 bytes, no locals
    253, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,  // v128.const 0
    26, 11,                                              // drop, end
]);

/**
 * Whether this browser can run it: a plain browser — no app around the page —
 * with Web Workers, IndexedDB, and WebAssembly with SIMD, which every engine
 * has had since 2021–2023 and without which Whisper is too slow to bother.
 */
export function wasmSupported(win = theWindow()) {
    try {
        if (!win || win.ubersdrDesktop) return false;
        if (typeof win.Worker !== 'function' || !win.indexedDB) return false;
        const W = win.WebAssembly;
        return !!(W && typeof W.validate === 'function' && W.validate(SIMD_PROBE));
    } catch (e) {
        return false;
    }
}

// ---- the synchronous hint -----------------------------------------------------

function readHint(storage) {
    try {
        const v = JSON.parse(storage.getItem(HINT_KEY) || 'null');
        return v && typeof v === 'object' ? v : {};
    } catch (e) {
        return {};
    }
}

function writeHint(storage, hint) {
    try { storage.setItem(HINT_KEY, JSON.stringify(hint)); } catch (e) { /* private mode */ }
}

/**
 * Whether a model was downloaded here, as last known. Synchronous, for a
 * render; the store itself is the truth, and the hint is rewritten from it
 * whenever the model list is read.
 */
export function wasmHasModel(win = theWindow()) {
    try {
        const hint = readHint(win.localStorage);
        return Array.isArray(hint.installed) && hint.installed.length > 0;
    } catch (e) {
        return false;
    }
}

// ---- IndexedDB ------------------------------------------------------------------

function request(r) {
    return new Promise((resolve, reject) => {
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error || new Error('IndexedDB request failed'));
    });
}

/**
 * The model store: blobs keyed by their pinned SHA-256, so a new pin is a new
 * key and an old file is never mistaken for it.
 */
export function idbStore(idb) {
    let db = null;
    const open = () => {
        if (!db) {
            const r = idb.open(DB_NAME, 1);
            r.onupgradeneeded = () => { r.result.createObjectStore(DB_STORE); };
            db = request(r).catch((e) => { db = null; throw e; });
        }
        return db;
    };
    const tx = async (mode, fn) => {
        const d = await open();
        const t = d.transaction(DB_STORE, mode);
        const result = request(fn(t.objectStore(DB_STORE)));
        await new Promise((resolve, reject) => {
            t.oncomplete = resolve;
            t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
            t.onerror = () => reject(t.error || new Error('IndexedDB transaction failed'));
        });
        return result;
    };
    return {
        get: (key) => tx('readonly', (s) => s.get(key)),
        put: (key, value) => tx('readwrite', (s) => s.put(value, key)),
        delete: (key) => tx('readwrite', (s) => s.delete(key)),
        keys: () => tx('readonly', (s) => s.getAllKeys()),
    };
}

// ---- languages --------------------------------------------------------------------

/** Tags in Whisper's order, as the page's list: alphabetical by English name. */
export function sortLanguages(tags) {
    let names = null;
    try { names = new Intl.DisplayNames(['en'], { type: 'language' }); } catch (e) { /* no ICU */ }
    const name = (t) => {
        try { return (names && names.of(t)) || t; } catch (e) { return t; }
    };
    const seen = new Set();
    return (Array.isArray(tags) ? tags : [])
        .map(String)
        .filter((t) => /^[a-z]{2,3}$/.test(t) && !seen.has(t) && seen.add(t))
        .map((t) => ({ t, n: name(t) }))
        .sort((a, b) => a.n.localeCompare(b.n, 'en'))
        .map((x) => x.t);
}

// ---- the recogniser -------------------------------------------------------------------

function said(message, code) {
    const e = new Error(message);
    if (code) e.code = code;
    return e;
}

/**
 * The host-contract object. `deps` exist for tests: `Worker`, `fetch`, `store`,
 * `storage`, `persist`, `baseUrl`, `now`, `pins`, `build`.
 */
export function createWasmStt(deps = {}) {
    const win = deps.win || theWindow();
    const WorkerCtor = deps.Worker || win.Worker;
    const fetchImpl = deps.fetch || ((...a) => win.fetch(...a));
    const storage = deps.storage || win.localStorage;
    const store = deps.store || idbStore(win.indexedDB);
    const now = deps.now || (() => Date.now());
    const pins = deps.pins || WASM_PINS;
    const build = deps.build || WASM_BUILD;
    const baseUrl = deps.baseUrl || (win.location && win.location.href) || '';
    const persist = deps.persist || (() => {
        try {
            const s = win.navigator && win.navigator.storage;
            if (s && typeof s.persist === 'function') return s.persist().catch(() => false);
        } catch (e) { /* not offered */ }
        return Promise.resolve(false);
    });

    const speechIds = Object.keys(pins).filter((id) => id !== 'vad');

    // ---- the worker ----
    let worker = null;
    let calls = new Map();
    let nextCall = 1;
    let loaded = null;       // the speech model id the worker has loaded
    let vadLoaded = false;
    let epoch = 0;
    let session = 0;
    let cbs = null;          // the running session's callbacks

    function url(path) {
        try { return new URL(path, baseUrl).href; } catch (e) { return path; }
    }

    function dropWorker(message) {
        const w = worker;
        worker = null;
        loaded = null;
        vadLoaded = false;
        const pending = calls;
        calls = new Map();
        for (const c of pending.values()) c.reject(said(message));
        try { if (w) w.terminate(); } catch (e) { /* gone */ }
        const o = cbs;
        cbs = null;
        if (o) {
            o.onError({ code: 'start-failed', message, fatal: true });
            o.onEnd();
        }
    }

    function line(m) {
        let msg;
        try { msg = JSON.parse(m.line); } catch (e) { return; }
        // From before the latest start, reset or stop: see worker.entry.js.
        if (m.epoch !== epoch || !cbs || !msg) return;
        if (msg.session != null && msg.session !== session) return;
        if (msg.type === 'result') cbs.onResult({ text: String(msg.text || ''), final: !!msg.final });
        else if (msg.type === 'error') {
            const o = cbs;
            o.onError({ code: msg.code, message: msg.message, fatal: !!msg.fatal });
            if (msg.fatal) {
                cbs = null;
                o.onEnd();
            }
        }
    }

    function ensureWorker() {
        if (worker) return worker;
        if (typeof WorkerCtor !== 'function') throw said('This browser can\'t run the speech model.', 'unsupported');
        const w = new WorkerCtor(url(WORKER_URL));
        worker = w;
        w.onmessage = (e) => {
            if (worker !== w) return;
            const m = e.data || {};
            if (m.type === 'reply') {
                const c = calls.get(m.id);
                if (!c) return;
                calls.delete(m.id);
                if (m.ok) c.resolve(m.value);
                else c.reject(said(m.error));
            } else if (m.type === 'line') {
                line(m);
            } else if (m.type === 'note') {
                try { console.debug('[whisper]', m.text); } catch (err) { /* no console */ }
            } else if (m.type === 'failed') {
                dropWorker(`The speech model's code could not be loaded: ${m.message}`);
            }
        };
        w.onerror = (e) => {
            if (worker !== w) return;
            if (e && typeof e.preventDefault === 'function') e.preventDefault();
            dropWorker(`The speech recogniser stopped: ${(e && e.message) || 'it crashed'}`);
        };
        const v = encodeURIComponent(build.version || '');
        w.postMessage({
            type: 'init',
            moduleUrl: url(`${MODULE_PATH}.js?v=${v}`),
            wasmUrl: url(`${MODULE_PATH}.wasm?v=${v}`),
            verbose: !!deps.verbose,
        });
        return w;
    }

    function call(op, extra = {}, transfer = []) {
        let w;
        try { w = ensureWorker(); } catch (e) { return Promise.reject(e); }
        const id = nextCall++;
        return new Promise((resolve, reject) => {
            calls.set(id, { resolve, reject });
            w.postMessage({ type: 'call', id, op, ...extra }, transfer);
        });
    }

    // ---- what is installed ----
    let installedCache = null;   // Set of ids, as of the last look at the store

    async function installedIds() {
        let keys = [];
        try { keys = await store.keys(); } catch (e) { keys = []; }
        const have = new Set(keys.map(String));
        const ids = new Set();
        for (const id of Object.keys(pins)) if (have.has(pins[id].sha256)) ids.add(id);
        installedCache = ids;
        const hint = readHint(storage);
        hint.installed = speechIds.filter((id) => ids.has(id));
        if (hint.active && !ids.has(hint.active)) delete hint.active;
        writeHint(storage, hint);
        return ids;
    }

    function activeId(ids) {
        const chosen = readHint(storage).active;
        if (chosen && ids.has(chosen)) return chosen;
        return speechIds.find((id) => ids.has(id)) || null;
    }

    // ---- downloads ----
    const jobs = new Map();   // id -> {promise, controller, listeners:Set}

    async function fetchPinned(pin, signal, onBytes) {
        const res = await fetchImpl(pin.url, { signal });
        if (!res || !res.ok) throw said(`The download failed (${res ? `HTTP ${res.status}` : 'no response'}). Try again later.`);
        const sha = createSha256();
        const parts = [];
        let got = 0;
        const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
        if (reader) {
            for (;;) {
                // eslint-disable-next-line no-await-in-loop
                const { done, value } = await reader.read();
                if (done) break;
                if (got + value.length > pin.size) throw said('The download was larger than the model should be, so it was thrown away.', 'corrupt');
                sha.update(value);
                parts.push(value);
                got += value.length;
                onBytes(value.length);
            }
        } else {
            const all = new Uint8Array(await res.arrayBuffer());
            sha.update(all);
            parts.push(all);
            got = all.length;
            onBytes(all.length);
        }
        if (got !== pin.size) throw said(`The download stopped short (${got} of ${pin.size} bytes). Try again.`, 'corrupt');
        if (sha.hex() !== pin.sha256) throw said('The download did not match the model it should be, so it was thrown away. Try again.', 'corrupt');
        return new Blob(parts, { type: 'application/octet-stream' });
    }

    function startJob(id) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const listeners = new Set();
        const pin = pins[id];
        const vad = pins.vad;
        const job = { controller, listeners, waiters: new Set(), promise: null };
        job.promise = (async () => {
            const ids = await installedIds();
            const needVad = vad && !ids.has('vad');
            const total = pin.size + (needVad ? vad.size : 0);
            let received = 0;
            let last = 0;
            const tell = (force) => {
                const t = now();
                if (!force && t - last < PROGRESS_MS) return;
                last = t;
                for (const fn of listeners) {
                    try { fn({ received, total }); } catch (e) { /* the listener's */ }
                }
            };
            const onBytes = (n) => { received += n; tell(false); };
            const signal = controller ? controller.signal : undefined;
            try {
                if (needVad) await store.put(vad.sha256, await fetchPinned(vad, signal, onBytes));
                await store.put(pin.sha256, await fetchPinned(pin, signal, onBytes));
            } catch (e) {
                if (e && e.name === 'AbortError') throw said('Cancelled', 'cancelled');
                if (e && e.name === 'QuotaExceededError') {
                    throw said('This browser has no room to keep the model. Free some space, or try the Tiny model.', 'quota');
                }
                if (e && e.code) throw e;
                throw said(`The download failed: ${(e && e.message) || e}`);
            }
            tell(true);
            await installedIds();
            // Asked once there is something worth keeping; a refusal only
            // means the browser may clear it when short of space.
            try { await persist(); } catch (e) { /* kept anyway */ }
        })();
        job.promise.then(() => jobs.delete(id), () => jobs.delete(id));
        jobs.set(id, job);
        return job;
    }

    // ---- the contract ----

    async function languages() {
        return sortLanguages(await call('languages'));
    }

    async function prepare() {
        const ids = await installedIds();
        const id = activeId(ids);
        if (!id) throw said(NO_MODEL_MESSAGE, 'no-model');
        if (!ids.has('vad')) throw said(NO_MODEL_MESSAGE, 'no-model');
        if (loaded === id && vadLoaded && worker) return;
        const read = async (pin) => {
            const blob = await store.get(pin.sha256);
            if (!blob) throw said('The speech model has gone from this browser\'s storage. Download it again.', 'missing');
            return blob.arrayBuffer();
        };
        const extra = {};
        const transfer = [];
        if (!vadLoaded || !worker) {
            extra.vad = await read(pins.vad);
            transfer.push(extra.vad);
        }
        extra.model = await read(pins[id]);
        transfer.push(extra.model);
        await call('load', extra, transfer);
        vadLoaded = true;
        loaded = id;
    }

    async function start({ lang, onResult, onError, onEnd } = {}) {
        // A session already running is replaced, as the helper's START does.
        cbs = null;
        await prepare();
        epoch += 1;
        session += 1;
        const quiet = () => {};
        cbs = { onResult: onResult || quiet, onError: onError || quiet, onEnd: onEnd || quiet };
        ensureWorker().postMessage({ type: 'start', epoch, json: JSON.stringify({ lang: String(lang || ''), session }) });
    }

    function push(pcm) {
        if (!cbs || !worker || !(pcm instanceof Int16Array) || !pcm.length) return;
        // The array is the host's to keep (see ./host.js), so it moves.
        worker.postMessage({ type: 'audio', epoch, pcm }, [pcm.buffer]);
    }

    function reset() {
        if (!worker) return;
        epoch += 1;
        worker.postMessage({ type: 'reset', epoch });
    }

    function stop() {
        cbs = null;
        if (!worker) return;
        epoch += 1;
        worker.postMessage({ type: 'stop', epoch });
    }

    async function models() {
        const ids = await installedIds();
        const active = activeId(ids);
        return speechIds.map((id) => ({
            id,
            label: LABELS[id] || id,
            sizeBytes: pins[id].size,
            installed: ids.has(id),
            active: id === active,
            builtIn: false,
            downloading: jobs.has(id),
        }));
    }

    function installModel(id, onProgress) {
        if (!pins[id] || id === 'vad') return Promise.reject(said(`There is no model called ${id}.`));
        // A download already running for it is joined, not started again.
        const job = jobs.get(id) || startJob(id);
        const fn = typeof onProgress === 'function' ? onProgress : null;
        if (fn) job.listeners.add(fn);
        return new Promise((resolve, reject) => {
            job.waiters.add(reject);
            const done = () => {
                job.waiters.delete(reject);
                if (fn) job.listeners.delete(fn);
            };
            job.promise.then(() => { done(); resolve(); }, (e) => { done(); reject(e); });
        });
    }

    // One page shares this object, so its Cancel is everybody's: every waiter
    // is told 'cancelled', and the download stops. What arrived is not kept —
    // there is nowhere to keep half a model and resume it from.
    function cancelInstall(id) {
        const job = jobs.get(id);
        if (!job) return;
        for (const reject of [...job.waiters]) reject(said('Cancelled', 'cancelled'));
        job.waiters.clear();
        if (job.controller) job.controller.abort();
    }

    async function removeModel(id) {
        if (!pins[id] || id === 'vad') throw said(`There is no model called ${id}.`);
        await store.delete(pins[id].sha256);
        if (loaded === id) loaded = null;
        const hint = readHint(storage);
        if (hint.active === id) {
            delete hint.active;
            writeHint(storage, hint);
        }
        const ids = await installedIds();
        // Nothing left to recognise with: the voice-activity model goes too.
        if (!speechIds.some((x) => ids.has(x)) && ids.has('vad')) {
            await store.delete(pins.vad.sha256);
            vadLoaded = false;
            await installedIds();
        }
    }

    async function setModel(id) {
        const ids = installedCache || await installedIds();
        if (!ids.has(id)) {
            const fresh = await installedIds();
            if (!fresh.has(id)) throw said(`The ${LABELS[id] || id} model is not downloaded yet.`, 'not-installed');
        }
        const hint = readHint(storage);
        hint.active = id;
        writeHint(storage, hint);
    }

    return {
        sampleRate: STT_RATE,
        languages,
        start,
        push,
        reset,
        stop,
        models,
        installModel,
        cancelInstall,
        removeModel,
        setModel,
    };
}

// One per page: every receiver panel shares the worker and the downloads.
let shared = null;

/** The page's WebAssembly recogniser, or null where it cannot run. */
export function wasmStt(win = theWindow()) {
    if (!wasmSupported(win)) return null;
    if (!shared) shared = createWasmStt({ win });
    return shared;
}

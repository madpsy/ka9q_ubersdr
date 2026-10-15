'use strict';

// `window.ubersdrDesktop.stt`, the preload's half: the object the page calls,
// turned into messages to the main process (stt.js), and the main process's
// events turned back into the page's callbacks.
//
// The contract is at the top of static/v2/src/extensions/whisper/engines/
// host.js, with the model calls this client adds. A separate module rather than
// more of receiver-preload.js so it can be driven under plain node with a fake
// ipcRenderer (test/stt.test.js); build.sh bundles it into the preload, as it
// does tci.js.
//
// The object is handed to contextBridge, so everything the page passes in
// arrives as a copy or a proxy: the callbacks given to start() and
// installModel() are proxies the preload can call later, and the PCM given to
// push() is a fresh Int16Array. That copy is sent on as bytes with
// ipcRenderer.send, which clones it again into the main process — two copies
// of 3.2 KB ten times a second, which is nothing. Not a MessagePort transfer:
// an ArrayBuffer transferred to the main process arrives there as null.
//
// Session ids are this file's, one per start(), starting from a random point
// on each page load. The main process outlives the page — a reload keeps the
// window, its helper and possibly a session — so an event still on its way
// for the old page must not match the new page's first session by
// coincidence.

const STT_RATE = 16000;

function idBase() {
    return Math.floor(Math.random() * 0x40000000);
}

function errorOf(answer, fallback) {
    return new Error((answer && answer.message) || fallback);
}

/** The bytes of an Int16Array, and only its own, whatever buffer it is a view of. */
function pcmBytes(pcm) {
    if (!pcm) return null;
    const a = pcm instanceof Int16Array ? pcm : (ArrayBuffer.isView(pcm) ? null : Int16Array.from(pcm));
    if (!a) return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength).slice();
    if (a.byteOffset === 0 && a.byteLength === a.buffer.byteLength) return new Uint8Array(a.buffer);
    return new Uint8Array(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength));
}

/**
 * The page-facing object. `ipc` is ipcRenderer (or a fake with on, send and
 * invoke); `win` is the window, for noticing the page going away. `models`
 * adds the model calls, for this client's own bundled UI only — see
 * registerSttIpc in stt.js, which checks again, since a preload's say-so is
 * no guard on the main process.
 */
function createSttBridge({ ipc, win, models: withModels = true }) {
    let counter = idBase();
    // The one session there can be: {id, onResult, onError, onEnd}.
    let current = null;
    // Install progress listeners, by model id.
    const progress = new Map();

    const call = (fn, arg) => {
        try { if (typeof fn === 'function') fn(arg); } catch { /* the page's own problem */ }
    };

    ipc.on('stt:event', (_event, msg) => {
        const c = current;
        if (!c || !msg || msg.session !== c.id) return;
        if (msg.type === 'result') {
            call(c.onResult, { text: String(msg.text || ''), final: !!msg.final });
        } else if (msg.type === 'error') {
            call(c.onError, {
                code: String(msg.code || 'error'),
                message: String(msg.message || ''),
                fatal: !!msg.fatal,
                ...(msg.retryable ? { retryable: true } : {}),
            });
        } else if (msg.type === 'end') {
            current = null;
            call(c.onEnd);
        }
    });

    ipc.on('stt:install-progress', (_event, p) => {
        const set = p && progress.get(p.id);
        if (!set) return;
        for (const fn of set) call(fn, { received: Number(p.received) || 0, total: Number(p.total) || 0 });
    });

    function stopCurrent() {
        if (!current) return;
        ipc.send('stt:stop', current.id);
        current = null;
    }

    // A page going away ends its session at the main process, so the helper
    // is not left holding a session for a page that no longer exists. The
    // next page's first start would replace it anyway; this is sooner.
    if (win && typeof win.addEventListener === 'function') win.addEventListener('pagehide', stopCurrent);

    const bridge = {
        languages() {
            return ipc.invoke('stt:languages').then((list) => (Array.isArray(list) ? list.map(String) : []));
        },

        start({ lang, sampleRate, onResult, onError, onEnd } = {}) {
            stopCurrent();
            // The helper takes 16 kHz and nothing else, and audio at the
            // wrong rate makes Whisper loop a confident hallucination rather
            // than fail — so a page that asks for another rate is refused.
            if (sampleRate != null && Number(sampleRate) !== STT_RATE) {
                return Promise.reject(new Error(`audio must be ${STT_RATE} Hz, not ${sampleRate}`));
            }
            counter += 1;
            const id = counter;
            current = { id, onResult, onError, onEnd };
            return ipc.invoke('stt:start', { session: id, lang: String(lang || '') }).then((answer) => {
                if (answer && answer.ok) return undefined;
                if (current && current.id === id) current = null;
                throw errorOf(answer, 'the speech recogniser did not start');
            });
        },

        push(pcm) {
            if (!current) return;
            const bytes = pcmBytes(pcm);
            if (bytes && bytes.length) ipc.send('stt:audio', current.id, bytes);
        },

        reset() {
            if (current) ipc.send('stt:reset', current.id);
        },

        stop() {
            stopCurrent();
        },
    };
    if (!withModels) return bridge;

    return {
        ...bridge,

        // ---- the models: this client's addition to the contract ---------------

        models() {
            return ipc.invoke('stt:models').then((list) => (Array.isArray(list) ? list : []));
        },

        installModel(id, onProgress) {
            const key = String(id);
            let set = null;
            if (typeof onProgress === 'function') {
                set = progress.get(key) || new Set();
                set.add(onProgress);
                progress.set(key, set);
            }
            const done = () => {
                if (!set) return;
                set.delete(onProgress);
                if (!set.size && progress.get(key) === set) progress.delete(key);
            };
            return ipc.invoke('stt:install-model', key).then((answer) => {
                done();
                if (!answer || !answer.ok) {
                    const e = errorOf(answer, 'the download failed');
                    if (answer && answer.code) e.code = answer.code;
                    throw e;
                }
            }, (e) => { done(); throw e; });
        },

        cancelInstall(id) {
            ipc.send('stt:cancel-install', String(id));
        },

        removeModel(id) {
            return ipc.invoke('stt:remove-model', String(id)).then((answer) => {
                if (!answer || !answer.ok) throw errorOf(answer, 'the model could not be removed');
            });
        },

        setModel(id) {
            return ipc.invoke('stt:set-model', String(id)).then((answer) => {
                if (!answer || !answer.ok) throw errorOf(answer, 'the model could not be chosen');
            });
        },
    };
}

module.exports = { createSttBridge, pcmBytes };

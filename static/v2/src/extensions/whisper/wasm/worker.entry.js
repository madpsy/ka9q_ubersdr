// The browser's Whisper, in a Web Worker: the WebAssembly session
// (clients/electron/whisper/wasm/whisper_wasm.cpp) and the queue in front of it.
// Built by ../../../../build.sh into dist/whisper-worker.js; the page's side is
// ../engines/wasm.js.
//
// The queue is the desktop helper's inbox (whisper_helper.cpp, Inbox), in
// JavaScript: a control message purges the audio queued ahead of it, since
// after a retune or a stop that audio is not worth a moment's work, and when
// more than ten seconds of audio is waiting the oldest goes, back to three, and
// the session is told once. The difference is that nothing here can interrupt a
// decode: the worker has one thread, and while whisper_full runs no message is
// even delivered. So every message from the page carries an epoch — the page
// bumps it at each start, reset and stop — and every line going back carries the
// epoch of the message it came from, and the page drops the ones from before
// its latest. A final from before a retune is then simply not shown.
//
// Messages in:
//   {type: 'init', moduleUrl, wasmUrl, verbose}
//   {type: 'call', id, op: 'languages'}
//   {type: 'call', id, op: 'load', model?: ArrayBuffer, vad?: ArrayBuffer}
//   {type: 'start', epoch, json}       json as the helper's START frame
//   {type: 'audio', epoch, pcm}        Int16Array, 16 kHz mono
//   {type: 'reset', epoch} / {type: 'stop', epoch}
// Messages out:
//   {type: 'reply', id, ok, value | error}
//   {type: 'line', epoch, line}        a protocol line, as the helper prints
//   {type: 'note', text}               for the console
//   {type: 'failed', message}          the module could not be loaded

/* global importScripts */

const RATE = 16000;
const MAX_BACKLOG = RATE * 10;
const KEEP_BACKLOG = RATE * 3;

let M = null;
let ready = null;
let verbose = false;
const q = [];
let queued = 0;          // samples of audio in q
let current = 0;         // the epoch of the message being handled
let session = null;      // the last START's session, for the falling-behind note
let warned = false;
let scheduled = false;
let heap = 0;
let heapSamples = 0;

const post = (m, transfer) => self.postMessage(m, transfer || []);

// A zero-delay yield: setTimeout nests into a 4 ms clamp, and between items is
// exactly where the page's messages have to get in.
const channel = new MessageChannel();
channel.port1.onmessage = () => { scheduled = false; pump(); };
function schedule() {
    if (scheduled) return;
    scheduled = true;
    channel.port2.postMessage(0);
}

function init(m) {
    verbose = !!m.verbose;
    ready = new Promise((resolve, reject) => {
        try {
            importScripts(m.moduleUrl);
        } catch (e) {
            reject(e);
            return;
        }
        self.WhisperStt({
            // The .wasm beside the glue, at the page's version.
            locateFile: (f) => (f.endsWith('.wasm') ? m.wasmUrl : f),
            onLine: (line) => post({ type: 'line', epoch: current, line }),
            onNote: (text) => { if (verbose) post({ type: 'note', text }); },
            backlog: () => queued,
        }).then((mod) => {
            M = mod;
            M._stt_init(verbose ? 1 : 0);
            resolve();
        }, reject);
    });
    ready.catch((e) => post({ type: 'failed', message: (e && e.message) || String(e) }));
}

function loadInto(fn, buf) {
    const bytes = new Uint8Array(buf);
    const p = M._malloc(bytes.length);
    if (!p) return false;
    M.HEAPU8.set(bytes, p);
    const rc = fn(p, bytes.length);
    M._free(p);
    return rc === 0;
}

function call(m) {
    if (m.op === 'languages') return JSON.parse(M.UTF8ToString(M._stt_languages()));
    if (m.op === 'load') {
        if (m.vad && !loadInto(M._stt_load_vad, m.vad)) throw new Error('The voice-activity model could not be loaded.');
        if (m.model && !loadInto(M._stt_load_model, m.model)) throw new Error('The speech model could not be loaded.');
        return { multilingual: M._stt_multilingual() === 1 };
    }
    throw new Error('unknown call ' + m.op);
}

function purgeAudio() {
    for (let i = q.length - 1; i >= 0; i--) if (q[i].type === 'audio') q.splice(i, 1);
    queued = 0;
}

// Behind: the oldest audio goes, and the first that is left says so, so the
// session finishes what it was hearing rather than joining it to this.
function shed() {
    let dropped = 0;
    while (queued > KEEP_BACKLOG) {
        const i = q.findIndex((x) => x.type === 'audio');
        if (i < 0) break;
        queued -= q[i].pcm.length;
        dropped += q[i].pcm.length;
        q.splice(i, 1);
    }
    const first = q.find((x) => x.type === 'audio');
    if (first) first.gap = true;
    if (!warned && session != null) {
        warned = true;
        post({
            type: 'line',
            epoch: current,
            line: JSON.stringify({
                type: 'error',
                session,
                code: 'falling-behind',
                message: `Transcription is falling behind the audio; ${(dropped / RATE).toFixed(1)} s of it was skipped. The Tiny model would keep up more easily.`,
                fatal: false,
            }),
        });
    }
}

function audio(item) {
    const n = item.pcm.length;
    if (n > heapSamples) {
        if (heap) M._free(heap);
        heap = M._malloc(n * 4);
        heapSamples = n;
    }
    const f = new Float32Array(M.HEAPF32.buffer, heap, n);
    for (let i = 0; i < n; i++) f[i] = item.pcm[i] / 32768;
    M._stt_audio(heap, n, item.gap ? 1 : 0);
}

function handle(item) {
    current = item.epoch == null ? current : item.epoch;
    switch (item.type) {
    case 'start':
        try { session = JSON.parse(item.json).session; } catch (e) { session = null; }
        warned = false;
        M.ccall('stt_start', 'number', ['string'], [item.json]);
        break;
    case 'audio': audio(item); break;
    case 'reset': M._stt_reset(); break;
    case 'stop': M._stt_stop(); break;
    case 'call':
        try {
            post({ type: 'reply', id: item.id, ok: true, value: call(item) });
        } catch (e) {
            post({ type: 'reply', id: item.id, ok: false, error: (e && e.message) || String(e) });
        }
        break;
    default: break;
    }
}

function pump() {
    if (!M) return;
    const item = q.shift();
    if (item) {
        if (item.type === 'audio') queued -= item.pcm.length;
        handle(item);
    }
    if (q.length) schedule();
    // Caught up: the moment for an interim, if one is due.
    else M._stt_interim();
}

self.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === 'init') {
        init(m);
        return;
    }
    if (m.type === 'audio') {
        // isView rather than instanceof: true of an Int16Array from any realm.
        if (!ArrayBuffer.isView(m.pcm) || m.pcm.BYTES_PER_ELEMENT !== 2 || !m.pcm.length) return;
        q.push(m);
        queued += m.pcm.length;
        if (queued > MAX_BACKLOG) shed();
    } else if (m.type === 'start' || m.type === 'reset' || m.type === 'stop') {
        purgeAudio();
        q.push(m);
    } else if (m.type === 'call') {
        q.push(m);
    } else {
        return;
    }
    if (ready) ready.then(schedule, () => {});
};

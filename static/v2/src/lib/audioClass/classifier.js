// The audio classifier: is what the listener is hearing voice, music or noise?
//
// An AudioSet tagger (EfficientAT mn05) compiled to WebAssembly and run in a
// worker: the C in static/v2/native/audioclass, built with and without
// WebAssembly SIMD and carried inside the worker's bundle. It hears the
// receiver's demodulated audio through the player's tap — what is coming out
// of the speakers, before volume and mute — and every 2.5 s gives a verdict on
// the last 5 s. The spectrum's tag row shows the result
// (components/AudioClassTag.jsx); components/AudioClassWatch.jsx drives this
// from the radio's state.
//
// Costs, measured as CPU time under node on a desktop: about 35 ms of one core
// per 5 s window with SIMD (about 65 ms without), so about 1.5% of a core with
// windows overlapping by half. Nothing is fetched and nothing runs until audio
// is playing in a mode that carries some (SSB, AM, FM), and the tap, the timer
// and the worker's work stop whenever that stops being true. The first time,
// the page fetches the worker (dist/audioclass-worker.js, 155 kB with both
// builds of the module in it, 64 kB compressed), the weights (5.9 MB) and the
// signal references (3 MB), both committed in static/v2/audioclass/, from the
// receiver — nothing comes from anywhere else. All are then in the browser's
// cache.

import { HISTORY, HOP_MS, WINDOW_SEC } from './verdict.js';

// Relative to the page (/v2/), as the browser Whisper's worker is.
export const WORKER_URL = 'dist/audioclass-worker.js';
export const MODEL_URL = 'audioclass/mn05_as_mAP_443.pt';
// The signal references (./signals.js). Optional: without them the badge says
// VOICE / MUSIC / NOISE only.
export const SIGNALS_URL = 'audioclass/signals.bin';

// Audio is posted to the worker in pieces this long: the tap fires every
// packet (20 ms), and a message per packet would be fifty a second for nothing.
const BATCH_SEC = 0.1;
// A retune by more than this is a different signal: the history is dropped so
// no verdict spans two. Less is fine-tuning the one being listened to.
export const RETUNE_HZ = 500;

export function createAudioClassifier(deps = {}) {
    const env = {
        createWorker: deps.createWorker || ((url) => new Worker(url)),
        fetch: deps.fetch || ((url) => fetch(url)),
        setInterval: deps.setInterval || ((fn, ms) => setInterval(fn, ms)),
        clearInterval: deps.clearInterval || ((id) => clearInterval(id)),
    };

    let state = { status: 'off', error: null, history: [], quiet: false };
    const listeners = new Set();
    const emit = (patch) => {
        state = { ...state, ...patch };
        for (const fn of Array.from(listeners)) {
            try { fn(state); } catch (e) { /* a listener's fault, not ours */ }
        }
    };

    let worker = null;
    let untap = null;
    let timer = null;
    let busy = false;
    let epoch = 0;
    let rate = 0;          // the stream rate the worker was last reset to
    let pending = null;    // the batch being filled
    let fill = 0;
    let tunedMode = null;  // what the history is about
    let tunedFreq = null;
    let player = null;

    function startWorker() {
        if (worker || state.status === 'error') return;
        emit({ status: 'loading', error: null });
        let w;
        try {
            w = env.createWorker(WORKER_URL);
        } catch (e) {
            emit({ status: 'error', error: 'the browser would not start a worker' });
            return;
        }
        worker = w;
        w.onmessage = (e) => onWorker(e.data);
        w.onerror = () => fail('the classifier worker failed to load');
        const get = (url, what) => env.fetch(url).then((r) => {
            if (!r.ok) throw new Error(`the receiver could not supply the ${what} (HTTP ${r.status})`);
            return r.arrayBuffer();
        });
        const signals = env.fetch(SIGNALS_URL)
            .then((r) => (r.ok ? r.arrayBuffer() : null))
            .catch(() => null);
        Promise.all([get(MODEL_URL, 'model'), signals]).then(([model, sig]) => {
            if (worker !== w) return; // switched off while fetching
            w.postMessage({ type: 'init', model, signals: sig }, sig ? [model, sig] : [model]);
        }).catch((e) => {
            if (worker === w) fail(String((e && e.message) || e));
        });
    }

    function fail(error) {
        stopListening();
        if (worker) { try { worker.terminate(); } catch (e) { /* gone */ } }
        worker = null;
        emit({ status: 'error', error, history: [], quiet: false });
    }

    function onWorker(msg) {
        if (!msg) return;
        if (msg.type === 'ready') {
            emit({ status: 'ready' });
            sync();
        } else if (msg.type === 'error') {
            fail(msg.error);
        } else if (msg.type === 'result') {
            busy = false;
            if (msg.epoch !== epoch || !msg.result) return;
            const r = msg.result;
            if (r.label === 'silent') {
                if (!state.quiet && state.history.length) emit({ quiet: true });
                return;
            }
            emit({ quiet: false, history: [...state.history, r].slice(-HISTORY) });
        }
    }

    // Everything heard so far is about a signal no longer being listened to.
    function forget() {
        epoch++;
        busy = false;
        rate = 0;
        pending = null;
        fill = 0;
        if (state.history.length || state.quiet) emit({ history: [], quiet: false });
    }

    function onAudio(planes, frames, sampleRate) {
        if (!worker || !planes || !planes.length || !(frames > 0)) return;
        if (sampleRate !== rate) {
            // A new rate is a new mode (or a new stream): start over at it.
            forget();
            rate = sampleRate;
            worker.postMessage({ type: 'reset', rate });
        }
        const size = Math.max(1, Math.round(rate * BATCH_SEC));
        let i = 0;
        while (i < frames) {
            if (!pending) { pending = new Float32Array(size); fill = 0; }
            const n = Math.min(frames - i, size - fill);
            // Mono: voice modes arrive as a duplicated pair, and an average is
            // right for that and harmless for anything else.
            for (let k = 0; k < n; k++) {
                let v = 0;
                for (let c = 0; c < planes.length; c++) v += planes[c][i + k];
                pending[fill + k] = v / planes.length;
            }
            fill += n;
            i += n;
            if (fill === size) {
                worker.postMessage({ type: 'push', samples: pending }, [pending.buffer]);
                pending = null;
            }
        }
    }

    function tick() {
        if (!worker || busy || state.status !== 'ready' || !rate) return;
        busy = true;
        worker.postMessage({ type: 'classify', seconds: WINDOW_SEC, epoch });
    }

    function startListening() {
        if (!untap && player && typeof player.onAudio === 'function') {
            untap = player.onAudio(onAudio);
        }
        if (timer == null) timer = env.setInterval(tick, HOP_MS);
    }

    function stopListening() {
        if (untap) { untap(); untap = null; }
        if (timer != null) { env.clearInterval(timer); timer = null; }
        forget();
    }

    let want = { enabled: false, listening: false };

    function sync() {
        if (!want.enabled) return;
        if (!want.listening) { stopListening(); return; }
        startWorker();
        if (state.status === 'ready') startListening();
    }

    return {
        getState: () => state,
        subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },

        /**
         * What the radio is doing. `enabled` is the Display setting;
         * `listening` is whether there is audio worth hearing — playing, page
         * visible, a mode with demodulated audio. `mode` and `freq` say what
         * is being listened to, so a retune drops the old verdicts.
         */
        configure({ enabled, listening, player: p, mode, freq }) {
            if (p !== player) {
                if (untap) { untap(); untap = null; }
                player = p || null;
            }
            if (!enabled) {
                stopListening();
                if (worker) { try { worker.terminate(); } catch (e) { /* gone */ } }
                worker = null;
                want = { enabled: false, listening: false };
                // Off clears a failure too, so switching it back on retries.
                emit({ status: 'off', error: null, history: [], quiet: false });
                return;
            }
            if (state.status === 'off') emit({ status: 'idle' });
            const retuned = mode !== tunedMode
                || tunedFreq == null || !Number.isFinite(freq)
                || Math.abs(freq - tunedFreq) > RETUNE_HZ;
            if (retuned) {
                tunedMode = mode;
                tunedFreq = Number.isFinite(freq) ? freq : null;
                // The worker is reset with the next packet: forget() zeroes the
                // rate, so the first audio after this looks like a new stream.
                forget();
            }
            want = { enabled: true, listening: !!listening };
            sync();
        },
    };
}

let shared = null;
/** The page's one classifier. */
export function getAudioClassifier() {
    if (!shared) shared = createAudioClassifier();
    return shared;
}

// Speech-to-text on the device: the host app's own recogniser.
//
// Inside one of UberSDR's apps there is a better recogniser than Web Speech —
// the platform's: Android's SpeechRecognizer with on-device models, Apple's
// SFSpeechRecognizer with `requiresOnDeviceRecognition`. A WebView has no Web
// Speech recogniser at all, so on a phone this is the only local engine there
// is. The page cannot reach either API, so the host does the recognising and
// the page feeds it audio, the same arrangement as the host's speech synthesis
// that ../../../lib/announce.js reads through `ubersdrDesktop.speech`.
//
// ── The contract ─────────────────────────────────────────────────────────────
//
// Declared by the host on `window.ubersdrDesktop`, alongside the flags it
// already sets there (see clients/capacitor/src/receiver.js and
// clients/electron/receiver-preload.js). Absent means "no host recogniser", and
// the page falls back to Web Speech or to the server.
//
//     window.ubersdrDesktop.stt = {
//         languages(): Promise<string[]>,
//         start({ lang, sampleRate, onResult, onError, onEnd }): Promise<void>,
//         push(pcm: Int16Array),
//         reset(),
//         stop(),
//     }
//
//   languages  BCP-47 tags the device can recognise *on the device*, now —
//              not ones it could with a network connection, and not ones that
//              would need a download first. Optional: a host without it is
//              asked to start in whatever language was chosen.
//   start      begin a session in `lang`, taking audio at `sampleRate` (always
//              16000). Resolves once the host is ready for push(); rejects with
//              an Error whose message is shown to the user ("On-device
//              recognition couldn't start: <message>"). Never falls back to the
//              microphone, and never to a cloud recogniser — the user chose
//              "on this device", and the receiver's audio is not the host's to
//              send anywhere.
//   push       16 kHz mono PCM16, about 100 ms per call (1600 samples), in
//              order and gap-free while the receiver plays. The array is the
//              host's to keep. Audio is taken before the volume, the mute and
//              the duck, so it keeps coming while the receiver is silenced.
//   onResult   `{ text, final }`: `final: false` is the hypothesis for the
//              utterance in progress, sent again whenever it changes, each one
//              replacing the last; `final: true` settles it. The next interim
//              starts a new utterance.
//   onError    `{ code, message, fatal }`. `code` is one of the Web Speech
//              error codes or this extension's own (../local.js ERRORS) where
//              one fits — 'not-allowed' for a refused permission,
//              'language-not-supported', 'start-failed' — and anything else
//              otherwise; `message` is shown when the code is not one the page
//              knows. For a code it does know, the page uses its own wording,
//              written for an app: a refused permission points at the app's
//              permissions in the device's settings. `fatal: true` means the
//              host has stopped and will call onEnd. Something the host is
//              retrying by itself should not be reported at all; if it is,
//              mark it `retryable: true` and the page shows nothing — but a
//              retryable error followed by onEnd counts towards giving up.
//   onEnd      the session has ended. A host recogniser should restart its
//              own native session across pauses and keep going until stop();
//              if it ends without being asked, the page starts it again, on
//              the same bounded policy as the browser engine (../local.js
//              restartPlan), and gives up with "keeps stopping".
//   reset      forget the utterance in progress, keep the session — the
//              receiver has been retuned.
//   stop       end the session; no callbacks after it.
//
// And for translating, which local mode does itself (the server's translator
// is not in the loop):
//
//     window.ubersdrDesktop.translate = {
//         availability(source, target): Promise<'available'|'downloadable'|'unavailable'>,
//         translate(text, source, target): Promise<string>,
//     }
//
// with BCP-47 language tags ('en', 'de', 'zh-Hant'). See ../translate.js.

import { describeError, restartPlan } from '../local.js';
import { Pcm16Batcher, STT_RATE } from '../pcm.js';

/** See ./index.js for the engine contract, and the top of this file for the host's. */
export function createHostEngine({
    player,
    stt,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    now = () => Date.now(),
} = {}) {
    let opts = null;
    let running = false;
    let session = 0;        // bumped per host start; callbacks from older ones are ignored
    let live = false;       // the host is ready for push()
    let strikes = 0;
    let startedAt = 0;
    // How the session in progress is going, for restartPlan — as in
    // ./browser.js.
    let sessionError = '';
    let settled = false;
    let timer = null;
    let offAudio = null;
    let lang = '';

    const quiet = () => {};

    const batcher = new Pcm16Batcher({
        onChunk: (pcm) => {
            if (!live || !running) return;
            try { stt.push(pcm); } catch (e) { /* the host's to report */ }
        },
    });

    function teardown() {
        running = false;
        live = false;
        session += 1;
        if (timer != null) clearTimer(timer);
        timer = null;
        if (offAudio) offAudio();
        offAudio = null;
        batcher.reset();
        try { if (stt) stt.stop(); } catch (e) { /* already stopped */ }
    }

    function finish(error) {
        if (!running) return;
        const o = opts;
        teardown();
        opts = null;
        if (error) o.onError(error);
        o.onEnd();
    }

    function hostError(id, e) {
        if (id !== session || !running) return;
        const err = e || {};
        const d = describeError(err.code, err.message, { kind: 'host', lang });
        // The host's own word on fatality wins; the table decides only when
        // the host did not say. A code the table does not know is shown as
        // the host phrased it.
        const fatal = err.fatal === true || (err.fatal == null && !err.retryable && d.fatal);
        if (fatal) {
            finish({ ...d, fatal: true, retryable: false });
            return;
        }
        // Quiet, but remembered: if the session ends on it, it counts.
        if (err.retryable || d.retryable) {
            sessionError = String(err.code || 'error');
            return;
        }
        opts.onError({ ...d, fatal: false });
    }

    function hostEnded(id) {
        if (id !== session || !running) return;
        live = false;
        const plan = restartPlan(strikes, now() - startedAt, { error: sessionError, settled });
        strikes = plan.strikes;
        if (plan.giveUp) {
            finish(describeError('keeps-stopping', '', { kind: 'host' }));
            return;
        }
        timer = setTimer(() => { timer = null; launch(false); }, plan.delayMs);
    }

    async function launch(first) {
        if (!running) return;
        session += 1;
        const id = session;
        startedAt = now();
        sessionError = '';
        settled = false;
        batcher.reset();
        try {
            await stt.start({
                lang,
                sampleRate: STT_RATE,
                onResult: (r) => {
                    if (id !== session || !running) return;
                    const res = { text: String((r && r.text) || ''), final: !!(r && r.final) };
                    // See restartPlan: a settled line clears the count, an
                    // interim does not.
                    if (res.final && res.text.trim()) settled = true;
                    opts.onResult(res);
                },
                onError: (e) => hostError(id, e),
                onEnd: () => hostEnded(id),
            });
        } catch (e) {
            if (id !== session || !running) return;
            if (first) {
                finish(describeError('start-failed', (e && e.message) || String(e), { kind: 'host' }));
                return;
            }
            // A restart that would not start counts as one that died at once.
            hostEnded(id);
            return;
        }
        if (id !== session || !running) {
            // Stopped while the host was starting: it has a session nobody
            // will stop otherwise.
            if (!running) try { stt.stop(); } catch (e) { /* ignore */ }
            return;
        }
        live = true;
    }

    async function start({ lang: l, onResult, onError, onEnd } = {}) {
        if (running) return;
        opts = { onResult: onResult || quiet, onError: onError || quiet, onEnd: onEnd || quiet };
        running = true;
        strikes = 0;
        lang = String(l || '');
        if (!stt || typeof stt.start !== 'function' || typeof stt.push !== 'function') {
            finish(describeError('unsupported', '', { kind: 'host' }));
            return;
        }
        if (player && typeof player.onAudio === 'function') {
            offAudio = player.onAudio((planes, frames, sampleRate) => batcher.push(planes, frames, sampleRate));
        }
        await launch(true);
    }

    function reset() {
        if (!running) return;
        batcher.reset();
        try { if (typeof stt.reset === 'function') stt.reset(); } catch (e) { /* ignore */ }
    }

    return {
        kind: 'host',
        start,
        reset,
        stop: () => finish(null),
    };
}

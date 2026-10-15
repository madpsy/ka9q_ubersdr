'use strict';

// Speech-to-text and translation on the device, as the page expects to find
// them: `window.ubersdrDesktop.stt` and `window.ubersdrDesktop.translate`.
//
// v2's Whisper extension can transcribe the receiver's audio on the device
// instead of on the server, and inside an app the recogniser that can do it is
// the platform's — a WebView has no Web Speech recogniser at all. The contract
// the page reads is written down at the top of
// static/v2/src/extensions/whisper/engines/host.js; this is the page half of
// it, and the host half is whatever native code answers the messages below.
// On iOS that is OnDeviceSpeech.swift and OnDeviceTranslation.swift, reached
// through HostChannel.swift; on Android, Recognition.java and Translation.java,
// reached through ReceiverActivity.java.
//
// Declared only when the host says so, through two flags its document-start
// script writes into `window.ubersdrDesktop` before this runs:
//
//   sttHost        the host has a recogniser that works without the network,
//                  in at least one language, and has not been refused
//                  permission for it. iOS sets it, and Android 13 and later
//                  where the phone has an on-device recognition service.
//   translateHost  the host can translate without the network and without
//                  showing anything. iOS 26 and later; Android 12 and later,
//                  with the system's TranslationManager.
//   translateSettings
//                  the host can open the device's page for adding translation
//                  languages, which the page offers when a pair is not there
//                  yet: translate.openSettings(). Android only — iOS has no
//                  such page an app can open, and leaves it out.
//
// Absent, nothing is declared, and the page is exactly where it was — which is
// what keeps an older native half, or a phone without a recogniser, unchanged
// by this file.
// The decision has to be the host's and has to be made before the page's first
// script: v2 looks for `stt` synchronously, during a render, to decide whether
// to offer the source at all (engines/index.js, hostStt), so an object that
// arrived later would never be seen, and one declared on a host that cannot
// answer would be offered and then fail at Start.
//
// ── The protocol ────────────────────────────────────────────────────────────
//
// Page → host, as JSON over the host channel (tellHost):
//
//   {type:'stt-languages'}
//   {type:'stt-start', session, lang, sampleRate}
//   {type:'stt-audio', session, pcm}       pcm: base64 of Int16 little-endian,
//                                          16 kHz mono, ~100 ms per message
//   {type:'stt-reset', session}
//   {type:'stt-stop', session}
//   {type:'translate-availability', id, source, target}
//   {type:'translate', id, text, source, target}
//   {type:'translate-settings'}            no answer
//
// Host → page, as strings in the host channel's own `prefix:payload` style:
//
//   stt-languages:<json string[]>          BCP-47, hyphenated ('en-US')
//   stt-started:{session}
//   stt-start-failed:{session, code, message}
//   stt-result:{session, text, final}
//   stt-error:{session, code, message, fatal, retryable}
//   stt-end:{session}
//   translate-availability:{id, status}    'available'|'downloadable'|'downloading'|'unavailable'
//   translate-result:{id, text} | {id, error}
//
// `session` is this file's own counter, one per start(). Everything the host
// says is tagged with it and anything not about the session in progress is
// dropped here, so a result still in flight from a session the page has
// stopped — or replaced on a retune's restart — cannot land in the next one.
// The counters (this one and translation's `id`) start from a random point on
// each page load rather than from 1: the host outlives the page — a reload
// keeps the same receiver window and host channel — so a reply queued for the
// old page can arrive at the new one, and it must not match the new page's
// first session or request by coincidence.
//
// The page going away stops its session at the host (`pagehide` sends
// stt-stop). Both hosts also stop the recogniser themselves when the main
// frame moves to a new page, for the case where the old page never got to say
// so.
//
// Every request that expects an answer has a deadline, because the host is a
// different process that can be busy, suspended or simply older than this
// file: start() rejects, availability() answers 'unavailable', translate() and
// languages() reject. A promise that never settles is worse than any of those —
// the page would sit on "starting" for ever.

export const TIMEOUTS = {
    // Long, because the first start shows the system's permission prompt on
    // iOS and nobody reads one in a second — and on Android the first session
    // after a reboot can take a dozen seconds to get going.
    startMs: 60000,
    languagesMs: 10000,
    availabilityMs: 8000,
    // The page abandons a line itself after six seconds (translate.js,
    // LIMITS.lineMs); this only stops an answer that never comes from leaking.
    translateMs: 30000,
};

const STATUSES = ['available', 'downloadable', 'downloading', 'unavailable'];

// Where a page load's counters begin: anywhere in [0, 2^30), leaving room to
// count up without leaving the integers both ends parse exactly.
function idBase() {
    return Math.floor(Math.random() * 0x40000000);
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Int16 samples as base64 of their little-endian bytes.
 *
 * Base64 because the channel carries strings and nothing else: on iOS it is a
 * WKScriptMessageHandler whose body is a JSON string here, on Android a
 * WebMessage. 100 ms of 16 kHz audio is 3.2 KB of bytes and about 4.3 KB of
 * text, ten times a second — nothing next to what the WebView is already
 * doing to play the receiver.
 */
export function pcmToBase64(pcm, btoaFn) {
    const samples = pcm instanceof Int16Array ? pcm : Int16Array.from(pcm || []);
    let bytes;
    if (LITTLE_ENDIAN) {
        bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    } else {
        bytes = new Uint8Array(samples.length * 2);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i], true);
    }
    // In slices: String.fromCharCode.apply with the whole array would hit the
    // engine's argument limit on a long push.
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoaFn(binary);
}

function parse(json) {
    try { return JSON.parse(json); } catch (e) { return null; }
}

/**
 * Declare `stt` and `translate` on `win.ubersdrDesktop` if the host's flags
 * say to, and return the handler for what the host sends back.
 *
 * `onHostMessage(data)` returns true for a message that was this file's, so
 * the caller can stop looking. The timer functions exist for tests.
 */
export function installHostSpeech({
    win,
    tellHost,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    timeouts = TIMEOUTS,
} = {}) {
    const limits = { ...TIMEOUTS, ...timeouts };
    let flags = null;
    try { flags = win && win.ubersdrDesktop; } catch (e) { flags = null; }
    const wantStt = !!(flags && flags.sttHost);
    const wantTranslate = !!(flags && flags.translateHost);
    const handlers = [];
    const btoaFn = (s) => (win && typeof win.btoa === 'function' ? win.btoa(s) : btoa(s));

    if (wantStt) handlers.push(installStt());
    if (wantTranslate) handlers.push(installTranslate());

    // ---- speech to text ----------------------------------------------------

    function installStt() {
        let counter = idBase();
        // The one session there can be: {id, started, opts, startTimer,
        // resolve, reject}. A second start() replaces the first, as the page's
        // restart policy expects of a host.
        let current = null;
        let languageWaiters = [];

        function drop(reason) {
            const c = current;
            if (!c) return;
            current = null;
            if (c.startTimer != null) clearTimer(c.startTimer);
            c.startTimer = null;
            if (c.reject) {
                const reject = c.reject;
                c.resolve = null;
                c.reject = null;
                reject(new Error(reason));
            }
        }

        const stt = {
            languages() {
                return new Promise((resolve, reject) => {
                    const waiter = { resolve, reject, timer: null };
                    waiter.timer = setTimer(() => {
                        languageWaiters = languageWaiters.filter((w) => w !== waiter);
                        reject(new Error('the app did not say which languages it has'));
                    }, limits.languagesMs);
                    languageWaiters.push(waiter);
                    // One question answers every caller waiting on it.
                    if (languageWaiters.length === 1) tellHost({ type: 'stt-languages' });
                });
            },

            start({ lang, sampleRate, onResult, onError, onEnd } = {}) {
                if (current) {
                    tellHost({ type: 'stt-stop', session: current.id });
                    drop('replaced by a new session');
                }
                counter += 1;
                const id = counter;
                const quiet = () => {};
                return new Promise((resolve, reject) => {
                    current = {
                        id,
                        started: false,
                        opts: { onResult: onResult || quiet, onError: onError || quiet, onEnd: onEnd || quiet },
                        resolve,
                        reject,
                        startTimer: null,
                    };
                    current.startTimer = setTimer(() => {
                        if (!current || current.id !== id) return;
                        // The host may yet start; it must not run a session
                        // nobody is feeding or listening to.
                        tellHost({ type: 'stt-stop', session: id });
                        drop('the app did not answer');
                    }, limits.startMs);
                    tellHost({ type: 'stt-start', session: id, lang: String(lang || ''), sampleRate: sampleRate || 16000 });
                });
            },

            push(pcm) {
                if (!current || !current.started) return;
                tellHost({ type: 'stt-audio', session: current.id, pcm: pcmToBase64(pcm, btoaFn) });
            },

            reset() {
                if (!current || !current.started) return;
                tellHost({ type: 'stt-reset', session: current.id });
            },

            // No callbacks after this, which the contract promises: a start
            // still waiting is rejected (the page has already moved on and
            // ignores it), and anything the host sends later fails the session
            // check.
            stop() {
                if (!current) return;
                tellHost({ type: 'stt-stop', session: current.id });
                drop('stopped');
            },
        };

        win.ubersdrDesktop.stt = stt;

        // A reload, or any navigation in the receiver's window, must not leave
        // the host running a recogniser that nothing feeds: the host's engine
        // belongs to the window, not to the page, and on its own it would keep
        // restarting its tasks until the receiver closed. A start still waiting
        // for its answer is stopped too — the host may be about to begin it.
        //
        // A page kept in the back-forward cache comes back with its session
        // stopped under it, so on that return the page is told the session
        // ended — the same as the host ending one by itself, which the page
        // already answers by starting afresh. Without it the page would show
        // a transcription running that will never say another word.
        if (typeof win.addEventListener === 'function') {
            let frozen = null;
            win.addEventListener('pagehide', (e) => {
                if (!current) return;
                frozen = e && e.persisted && current.started ? current.opts : null;
                stt.stop();
            });
            win.addEventListener('pageshow', (e) => {
                const opts = frozen;
                frozen = null;
                if (opts && e && e.persisted && !current) opts.onEnd();
            });
        }

        const mine = (msg) => !!(msg && current && msg.session === current.id);

        return (data) => {
            if (data.startsWith('stt-languages:')) {
                const list = parse(data.slice(14));
                const waiting = languageWaiters;
                languageWaiters = [];
                for (const w of waiting) {
                    clearTimer(w.timer);
                    w.resolve(Array.isArray(list) ? list.map(String) : []);
                }
                return true;
            }
            if (data.startsWith('stt-started:')) {
                const msg = parse(data.slice(12));
                if (!mine(msg) || !current.resolve) return true;
                const c = current;
                clearTimer(c.startTimer);
                c.startTimer = null;
                c.started = true;
                const resolve = c.resolve;
                c.resolve = null;
                c.reject = null;
                resolve();
                return true;
            }
            if (data.startsWith('stt-start-failed:')) {
                const msg = parse(data.slice(17));
                if (!mine(msg) || !current.resolve) return true;
                const c = current;
                const code = String(msg.code || '');
                const message = String(msg.message || '');
                // A failure with a reason the page has its own words for — a
                // refused permission, a missing language — goes through
                // onError, because a rejected start() is always shown as
                // "couldn't start: <message>" and loses the code: the page's
                // note for 'not-allowed' says where in Settings to fix it,
                // and that is the note somebody needs. So: started, then a
                // fatal error, then the end — exactly what a session that
                // failed a moment after starting looks like, which the page
                // already handles. A plain 'start-failed' is a rejection.
                if (!code || code === 'start-failed') {
                    drop(message || 'the recogniser would not start');
                    return true;
                }
                clearTimer(c.startTimer);
                c.startTimer = null;
                c.started = true;
                const resolve = c.resolve;
                c.resolve = null;
                c.reject = null;
                resolve();
                // After the page has taken the resolution, so it sees a
                // session that started and then failed, in that order.
                setTimer(() => {
                    if (current !== c) return;
                    current = null;
                    c.opts.onError({ code, message, fatal: true, retryable: false });
                    c.opts.onEnd();
                }, 0);
                return true;
            }
            if (data.startsWith('stt-result:')) {
                const msg = parse(data.slice(11));
                if (!mine(msg) || !current.started) return true;
                current.opts.onResult({ text: String(msg.text || ''), final: !!msg.final });
                return true;
            }
            if (data.startsWith('stt-error:')) {
                const msg = parse(data.slice(10));
                if (!mine(msg) || !current.started) return true;
                current.opts.onError({
                    code: String(msg.code || ''),
                    message: String(msg.message || ''),
                    fatal: msg.fatal === true,
                    retryable: msg.retryable === true,
                });
                return true;
            }
            if (data.startsWith('stt-end:')) {
                const msg = parse(data.slice(8));
                if (!mine(msg)) return true;
                const c = current;
                current = null;
                if (c.startTimer != null) clearTimer(c.startTimer);
                if (c.reject) {
                    // Ended before it ever said it had started.
                    const reject = c.reject;
                    c.resolve = null;
                    c.reject = null;
                    reject(new Error('the recogniser stopped as it started'));
                    return true;
                }
                c.opts.onEnd();
                return true;
            }
            return false;
        };
    }

    // ---- translation -------------------------------------------------------

    function installTranslate() {
        let counter = idBase();
        const pending = new Map();

        function ask(message, onTimeout) {
            counter += 1;
            const id = counter;
            return new Promise((resolve, reject) => {
                const entry = { resolve, reject, timer: null };
                entry.timer = setTimer(() => {
                    if (!pending.has(id)) return;
                    pending.delete(id);
                    onTimeout(resolve, reject);
                }, message.type === 'translate' ? limits.translateMs : limits.availabilityMs);
                pending.set(id, entry);
                tellHost({ ...message, id });
            });
        }

        function settle(msg) {
            if (!msg || !pending.has(msg.id)) return null;
            const entry = pending.get(msg.id);
            pending.delete(msg.id);
            clearTimer(entry.timer);
            return entry;
        }

        const translate = {
            availability(source, target) {
                return ask(
                    { type: 'translate-availability', source: String(source || ''), target: String(target || '') },
                    (resolve) => resolve('unavailable'),
                );
            },
            translate(text, source, target) {
                return ask(
                    { type: 'translate', text: String(text == null ? '' : text), source: String(source || ''), target: String(target || '') },
                    (resolve, reject) => reject(new Error('the translator did not answer')),
                );
            },
        };
        if (flags.translateSettings) translate.openSettings = () => { tellHost({ type: 'translate-settings' }); };
        win.ubersdrDesktop.translate = translate;

        return (data) => {
            if (data.startsWith('translate-availability:')) {
                const msg = parse(data.slice(23));
                const entry = settle(msg);
                if (entry) entry.resolve(STATUSES.includes(msg.status) ? msg.status : 'unavailable');
                return true;
            }
            if (data.startsWith('translate-result:')) {
                const msg = parse(data.slice(17));
                const entry = settle(msg);
                if (!entry) return true;
                if (typeof msg.text === 'string') entry.resolve(msg.text);
                else entry.reject(new Error(String(msg.error || 'translation failed')));
                return true;
            }
            return false;
        };
    }

    return {
        stt: wantStt ? win.ubersdrDesktop.stt : null,
        translate: wantTranslate ? win.ubersdrDesktop.translate : null,
        onHostMessage(data) {
            for (const handle of handlers) {
                try {
                    if (handle(data)) return true;
                } catch (e) {
                    // A page callback that threw is the page's; the message
                    // was still this file's.
                    return true;
                }
            }
            return false;
        },
    };
}

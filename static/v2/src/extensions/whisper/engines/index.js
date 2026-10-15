// Speech-to-text on the device: which recogniser there is, and what it can do.
//
// Two engines behind one interface, both fed the *receiver's* audio and never
// the microphone:
//
//   'host'     the native app's own recogniser — Android's SpeechRecognizer,
//              Apple's SFSpeechRecognizer — declared by the host as
//              window.ubersdrDesktop.stt. Preferred whenever it is there: it is
//              the platform's best model, and in a WebView it is the only one.
//              The contract is in ./host.js.
//   'browser'  Web Speech, with on-device recognition forced on. See
//              ./browser.js.
//
// Every engine is the same object:
//
//     engine = {
//         kind,                               // 'host' | 'browser'
//         start({ lang, onResult, onError, onEnd }): Promise<void>,
//         reset(),
//         stop(),
//     }
//
//   start      resolves once the recogniser is running or has failed; it never
//              rejects. Every failure arrives through onError instead, so there
//              is one path to the failure note rather than two.
//   onResult   `{text, final}` — an interim hypothesis or a settled utterance;
//              ../localSegments.js turns these into transcript segments.
//   onError    `{code, message, retryable, fatal, action}` from
//              ../local.js describeError. Retryable failures are retried inside
//              the engine and never reach here; a fatal one is followed by
//              onEnd. A non-fatal one is a note to show while it keeps running.
//   onEnd      once, when the engine has stopped for good — after stop(), or
//              after a fatal error.
//   reset      forget the utterance in progress (a retune); keeps running.
//   stop       release everything. Safe to call twice, or before start settles.
//
// Detection comes in two speeds, because two different callers need it.
// ExtensionsContext decides whether to offer the extension at all, during a
// render, so `localSttAvailable` is synchronous and only looks at what exists.
// Whether a given *language* works is a question for the recogniser and is
// asynchronous — `localLanguages`, `languageStatus` — and is only asked once
// the panel is open.

import { createBrowserEngine } from './browser.js';
import { createHostEngine } from './host.js';
import { SPOKEN_CANDIDATES, LOCAL_UNSUPPORTED } from '../local.js';

const theWindow = () => (typeof window !== 'undefined' ? window : {});

const STATUSES = ['available', 'downloadable', 'downloading', 'unavailable'];
const status = (v) => (STATUSES.includes(v) ? v : 'unavailable');

/** The host's recogniser, or null. Both calls a session needs must be there. */
export function hostStt(win = theWindow()) {
    try {
        const d = win && win.ubersdrDesktop;
        const s = d && d.stt;
        return s && typeof s.start === 'function' && typeof s.push === 'function' ? s : null;
    } catch (e) {
        return null;
    }
}

const userAgent = (win) => {
    try {
        return String((win && win.navigator && win.navigator.userAgent) || '');
    } catch (e) {
        return '';
    }
};

/**
 * Web Speech's recogniser if it can work on the device, or null.
 *
 * Three tests, and each is load-bearing:
 *
 *   * `available` exists. It is how a language is checked before starting, and
 *     it arrived with on-device recognition (Chrome 139) — so it is also the
 *     cleanest test for "this is a recogniser that can be kept off the
 *     network".
 *   * `processLocally` is on the prototype. Setting it on a recogniser that
 *     does not know it adds a property nobody reads and starts a *cloud*
 *     session, sending the receiver's audio to Google. It must be a real
 *     attribute or this engine does not exist.
 *   * Not Electron. Electron's renderer is killed outright the moment a page
 *     touches on-device recognition — Blink asks for an interface only Chrome
 *     binds, and the browser process treats that as a bad message (fixed in
 *     Electron 42.10, 43.5 and 44). The desktop client offers a recogniser of
 *     its own through `stt` when it has one; until then, local is simply not
 *     offered there, which is better than a receiver window that vanishes.
 *
 * `start(track)` — recognising a MediaStreamTrack rather than the microphone —
 * cannot be detected at all, and is tried at start. It shipped in Chrome 135,
 * before the two above, so a browser that passes them has it; that ordering is
 * what makes it safe to rely on, since a browser *without* it would ignore the
 * argument and open the microphone.
 */
export function browserRecognition(win = theWindow()) {
    try {
        const R = win && (win.SpeechRecognition || win.webkitSpeechRecognition);
        if (typeof R !== 'function') return null;
        if (typeof R.available !== 'function') return null;
        if (!R.prototype || !('processLocally' in R.prototype)) return null;
        if (/\bElectron\//.test(userAgent(win))) return null;
        return R;
    } catch (e) {
        return null;
    }
}

/** 'host', 'browser' or null: the local engine to use, best first. */
export function localEngineKind(win = theWindow()) {
    if (hostStt(win)) return 'host';
    if (browserRecognition(win)) return 'browser';
    return null;
}

/** Whether transcribing on the device is possible at all. Synchronous. */
export function localSttAvailable(win = theWindow()) {
    return localEngineKind(win) !== null;
}

// --- does start(track) actually work? -----------------------------------------
//
// Everything browserRecognition tests for can be present while the one thing
// this engine needs is not. Measured in Chrome 145 on Linux: available(),
// install() and processLocally all there, the en-US pack installed and
// answering 'available', on-device recognition from the microphone working —
// and every start(track) answered with a 'network' error and an end within
// 50 ms. Whatever the track: a Web Audio destination, the media-controls
// element anchor, captureStream() on an <audio>, even getUserMedia's own
// microphone track. processLocally on or off made no difference.
//
// So the feature tests say a browser *might* manage, and only trying says
// whether it does. Offering local on their word alone made it the default for
// every Chrome user, and every Start a failure. This tries once: a recogniser
// on a silent track, and a 'network' error before anything else is the
// signature. Anything else — audio arriving, a different error, nothing at all
// within the window — got past the hand-over of the track, which is the part
// that fails, so it passes. When Chrome fixes it, this starts passing and local
// appears without a line changing here.
//
// The probe asks in a language the device already has, because a missing pack
// is its own error and would say nothing about the track. With none installed
// there is nothing to learn yet: it passes without remembering, so the next
// look — after an Install — asks again.

const PROBE_MS = 1500;
// Keyed by the recogniser constructor rather than the window: it is what is
// being judged, and a test swapping globals swaps it.
const probes = typeof WeakMap === 'function' ? new WeakMap() : null;

export const TRACK_UNSUPPORTED_REASON = 'This browser can\'t transcribe the receiver\'s audio on the device yet';

/**
 * What the probe found for this browser's recogniser: true, false, or null
 * when it has not finished (or not run). Synchronous, for a first render.
 */
export function browserTrackProbed(win = theWindow()) {
    const R = browserRecognition(win);
    if (!R || !probes) return null;
    const p = probes.get(R);
    return p && typeof p.result === 'boolean' ? p.result : null;
}

/**
 * Whether start(track) works here. Resolves true or false, never rejects, and
 * runs once per recogniser — every caller after the first gets the same
 * answer. `deps` exist for tests: `setTimer`/`clearTimer`, `timeoutMs`.
 */
export function probeBrowserTrack(win = theWindow(), deps = {}) {
    const R = browserRecognition(win);
    if (!R) return Promise.resolve(false);
    const held = probes && probes.get(R);
    if (held) return held.promise;
    const entry = { result: null, promise: null };
    entry.promise = runProbe(R, win, deps).then((r) => {
        // Inconclusive is not remembered: see above.
        if (r === null) {
            if (probes) probes.delete(R);
            return true;
        }
        entry.result = r;
        return r;
    });
    if (probes) probes.set(R, entry);
    return entry.promise;
}

async function runProbe(R, win, deps) {
    const setTimer = deps.setTimer || setTimeout;
    const clearTimer = deps.clearTimer || clearTimeout;
    const timeoutMs = deps.timeoutMs || PROBE_MS;

    let lang = '';
    for (const code of SPOKEN_CANDIDATES) {
        // eslint-disable-next-line no-await-in-loop
        if (await languageStatus('browser', code, win) === 'available') { lang = code; break; }
    }
    if (!lang) return null;

    // No AudioContext means no receiver audio either, and the engine says so
    // itself when started ("no audio graph"); nothing for the probe to add.
    const AC = win.AudioContext || win.webkitAudioContext;
    if (typeof AC !== 'function') return null;

    let ctx;
    let track;
    try {
        ctx = new AC();
        track = ctx.createMediaStreamDestination().stream.getAudioTracks()[0];
    } catch (e) {
        track = null;
    }
    if (!track) {
        try { if (ctx) ctx.close(); } catch (e) { /* already closed */ }
        return null;
    }

    return new Promise((resolve) => {
        let rec = null;
        let timer = null;
        let done = false;
        const finish = (r) => {
            if (done) return;
            done = true;
            if (timer) clearTimer(timer);
            if (rec) {
                rec.onerror = null;
                rec.onaudiostart = null;
                rec.onend = null;
                try { rec.abort(); } catch (e) { /* not running */ }
            }
            try { track.stop(); } catch (e) { /* already stopped */ }
            try { ctx.close(); } catch (e) { /* already closed */ }
            resolve(r);
        };
        try {
            rec = new R();
            rec.lang = lang;
            rec.processLocally = true;
            rec.continuous = false;
            rec.interimResults = false;
            rec.onerror = (e) => finish(!(e && e.error === 'network'));
            rec.onaudiostart = () => finish(true);
            rec.onend = () => finish(true);
            timer = setTimer(() => finish(true), timeoutMs);
            rec.start(track);
        } catch (e) {
            // The overload refused outright: the same verdict, sooner.
            finish(false);
        }
    });
}

/**
 * The local engine that will actually work, once known: 'host', 'browser' or
 * null, with `pending` while the browser's probe is still out. The host is
 * taken at its word — it declared `stt` because it has a recogniser.
 */
export function usableLocalKind(win = theWindow()) {
    const kind = localEngineKind(win);
    if (kind !== 'browser') return { kind, pending: false };
    const probed = browserTrackProbed(win);
    if (probed === null) return { kind: null, pending: true };
    return { kind: probed ? 'browser' : null, pending: false };
}

/**
 * Why local is not offered, for the disabled option's tooltip. Empty when it
 * is.
 */
export function localUnavailableReason(win = theWindow()) {
    if (localEngineKind(win) === 'browser' && browserTrackProbed(win) === false) {
        return TRACK_UNSUPPORTED_REASON;
    }
    if (localEngineKind(win)) return '';
    const R = win && (win.SpeechRecognition || win.webkitSpeechRecognition);
    if (R && /\bElectron\//.test(userAgent(win))) return 'Not supported in this app yet';
    if (typeof R === 'function') return 'This browser can only recognise speech on its own servers, not on the device';
    return LOCAL_UNSUPPORTED;
}

/**
 * Whether the device can recognise `lang` locally right now:
 * 'available' | 'downloadable' | 'downloading' | 'unavailable'.
 *
 * Never rejects — a check that throws is a language that cannot be used. For
 * the host, a language is available if `stt.languages()` lists it; a host
 * with no list is taken at its word that it can do anything it is asked.
 */
export async function languageStatus(kind, lang, win = theWindow()) {
    const tag = String(lang || '');
    if (!tag) return 'unavailable';
    try {
        if (kind === 'host') {
            const stt = hostStt(win);
            if (!stt) return 'unavailable';
            if (typeof stt.languages !== 'function') return 'available';
            const list = await stt.languages();
            const want = tag.toLowerCase();
            return (Array.isArray(list) ? list : []).some((l) => String(l).toLowerCase() === want)
                ? 'available'
                : 'unavailable';
        }
        if (kind === 'browser') {
            const R = browserRecognition(win);
            if (!R) return 'unavailable';
            return status(await R.available({ langs: [tag], processLocally: true }));
        }
    } catch (e) {
        return 'unavailable';
    }
    return 'unavailable';
}

/**
 * The spoken languages on offer, as `[{code, status}]`, in the order given.
 *
 * The host is asked for its list. A browser cannot be — it only answers "can
 * you do this one?" — so it is asked about each of SPOKEN_CANDIDATES, all at
 * once, and anything 'unavailable' is left out. 'downloadable' ones stay in:
 * choosing one is how the user gets to the Install button.
 */
export async function localLanguages(kind, win = theWindow()) {
    if (kind === 'host') {
        const stt = hostStt(win);
        if (!stt || typeof stt.languages !== 'function') return [];
        try {
            const list = await stt.languages();
            const seen = new Set();
            return (Array.isArray(list) ? list : [])
                .map(String)
                .filter((l) => l && !seen.has(l) && seen.add(l))
                .map((code) => ({ code, status: 'available' }));
        } catch (e) {
            return [];
        }
    }
    if (kind === 'browser') {
        const answers = await Promise.all(SPOKEN_CANDIDATES.map(async (code) => ({
            code,
            status: await languageStatus('browser', code, win),
        })));
        return answers.filter((a) => a.status !== 'unavailable');
    }
    return [];
}

/** Whether a missing language can be downloaded from here. */
export function canInstall(kind, win = theWindow()) {
    if (kind !== 'browser') return false;
    const R = browserRecognition(win);
    return !!(R && typeof R.install === 'function');
}

/**
 * Download a language pack. Resolves true once it is installed, false if it
 * could not be — never rejects. Chrome wants a user gesture for this, so call
 * it from the Install button's click and not from an effect.
 */
export async function installLanguage(lang, win = theWindow()) {
    const R = browserRecognition(win);
    if (!R || typeof R.install !== 'function') return false;
    try {
        return (await R.install({ langs: [String(lang || '')], processLocally: true })) === true;
    } catch (e) {
        return false;
    }
}

/**
 * A new engine of the given kind, or null.
 *
 * `deps.player` is the receiver's AudioPlayer. The rest exist for tests:
 * `win` for the globals, `setTimer`/`clearTimer`/`now` for the clock.
 */
export function createLocalEngine(kind, deps = {}) {
    const win = deps.win || theWindow();
    if (kind === 'host') return createHostEngine({ ...deps, stt: deps.stt || hostStt(win) });
    if (kind === 'browser') {
        return createBrowserEngine({ ...deps, Recognition: deps.Recognition || browserRecognition(win) });
    }
    return null;
}

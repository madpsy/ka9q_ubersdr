'use strict';

// What the host runs inside a receiver page.
//
// The desktop client's equivalent is clients/electron/receiver-preload.js, and
// this is the same idea with a different injection: there a sandboxed preload,
// here a document-start script (ReceiverActivity). Both are bundled at build
// time with the v2 page API's own client library, because neither can `require`
// or `import` anything at run time.
//
// Two jobs: telling the host when the receiver starts and stops, and what it is
// tuned to while it runs. The first closes the Activity; the second is what the
// notification and the lock screen say.
//
// Everything here talks to the page over the documented API
// (static/v2/BRIDGE_API.md) rather than reaching into it. That is not
// politeness — it is the difference between a client of a versioned contract
// and a private arrangement with a particular build of the UI, and the
// alternative here would have been watching a button for a CSS class, which is
// exactly what that API exists to replace.

import { createClient } from '../../../static/v2/src/bridge/client.js';
import { SECRETS } from '../../../static/v2/src/lib/backup.js';

// The channel ReceiverActivity opens with addWebMessageListener. Absent on a
// system WebView too old for it, in which case the receiver simply stays open
// when it is stopped — the back gesture still works.
const host = () => (typeof window !== 'undefined' ? window.ubersdrHost : null);

function tellHost(message) {
    const channel = host();
    if (!channel) return;
    try { channel.postMessage(JSON.stringify(message)); } catch (e) { /* the Activity is going */ }
}

// ---- shared settings --------------------------------------------------------
//
// Each instance has its own loopback port, so its own origin, so its own
// localStorage — without this every receiver would open at the defaults. One
// arrangement of the interface, on every receiver, exactly as the desktop
// client does it (clients/electron/receiver-preload.js) and with no switch,
// because there was one sensible answer and a control offering the other.
//
// The seeding half already happened: ReceiverActivity writes the snapshot into
// this origin's localStorage from the document-start script, before the page's
// first script can read it. This half is the other direction — what changes
// here is reported back so the next receiver opened inherits it.
//
// What is never shared is the judgement, and it is the desktop client's list
// plus one addition: v2's own SECRETS (lib/backup.js), which is that file's
// answer to the same question for the settings backup. Importing it rather than
// restating it means a credential that moves — the rotator or antenna-switch
// password gaining a `ubersdr.v2.` key, say — is excluded from both features by
// the one edit. Today they are outside the prefix and could not travel anyway;
// the point is that this holds when that stops being true.

const PREFIX = 'ubersdr.v2.';
const SKIP_PREFIX = 'ubersdr.v2.news.cache.';
const SKIP_EXACT = new Set(['ubersdr.v2.radio', ...SECRETS]);

// Settings change at human speed; this is a copy of a few kilobytes.
const POLL_MS = 2000;

function sharedKey(key) {
    return !!key && key.startsWith(PREFIX) && !key.startsWith(SKIP_PREFIX) && !SKIP_EXACT.has(key);
}

function readShared() {
    const map = {};
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!sharedKey(key)) continue;
            map[key] = localStorage.getItem(key);
        }
    } catch (e) { /* private mode */ }
    return map;
}

let lastPushed = null;

function pushShared() {
    const map = readShared();
    const serialised = JSON.stringify(map);
    if (serialised === lastPushed) return;
    lastPushed = serialised;
    tellHost({ type: 'prefs', map });
}

function watchShared() {
    // No snapshot yet — nothing has ever been opened — so this receiver becomes
    // the template rather than the first one somebody happens to change a
    // setting in. Otherwise the baseline is what is here now, and only later
    // changes are reported.
    let seeded = false;
    try { seeded = !!(window.ubersdrDesktop && window.ubersdrDesktop.prefsSeeded); } catch (e) { /* none */ }
    if (seeded) lastPushed = JSON.stringify(readShared());
    else pushShared();
    setInterval(pushShared, POLL_MS);
}

// ---- what the lock screen says ----------------------------------------------
//
// None of it is composed here. v2 already builds a media session — the receiver
// as the title, the frequency, mode and callsign as the artist, the bookmark or
// spot (enriched by the callsign lookup) as the album, and the operator's photo
// as the artwork — and installs handlers that map next/previous to tuning steps
// and play/pause to mute. See static/v2/src/radio/media/.
//
// In Chrome all of that reaches the OS by itself. A WebView is where it stops:
// Chromium's own media-notification integration is part of the browser, not of
// the engine, so `navigator.mediaSession` in here is a well-behaved object that
// nothing is listening to. So this listens to it, and PlaybackService turns
// what it hears into the notification — the page is not asked to do anything
// differently, and the two cannot disagree because there is only one source.
//
// The alternative was composing a title from the `tuning` topic, which is a
// second implementation of something already written, and a worse one: no
// artwork, no callsign lookup, no bookmark name.

const actionHandlers = Object.create(null);
let lastArtwork = null;

function readMetadata(md) {
    if (!md) return null;
    const artwork = Array.from(md.artwork || []);
    // The largest declared image: the OS picks by size and the operator photo
    // is deliberately declared at 800 so it beats the logo (artwork.js).
    const biggest = artwork.reduce((best, image) => {
        const side = parseInt(String(image.sizes || '0x0').split('x')[0], 10) || 0;
        return side > (best.side || 0) ? { side, src: image.src } : best;
    }, {});
    return {
        title: md.title || '',
        artist: md.artist || '',
        album: md.album || '',
        art: biggest.src || '',
    };
}

// The artwork arrives as a blob: URL — v2 fetches each image once and hands the
// browser a blob so Chrome's re-fetching costs nothing, and because a blob
// resolves where an absolute URL to a self-signed LAN receiver does not. Native
// cannot read either, so it is fetched here and sent across as bytes.
//
// The newest wins, and that is the whole subtlety. The page sets its artwork
// twice for a station with an operator photo: the logo immediately, because it
// is already in memory and the card should never be blank, then the photo when
// its blob resolves (controller.js, _pushMetadata). Those are two sends, each
// with a fetch of its own, and without `wanted` whichever finished last stood —
// which is usually the logo, since it is the larger file and starts first. The
// photo would arrive, be replaced, and the lock screen would sit on the logo
// with the panel showing the photo beside it.
let wantedArtwork = null;

async function sendArtwork(src) {
    if (!src) return;
    wantedArtwork = src;
    if (src === lastArtwork) return;
    try {
        const blob = await (await fetch(src)).blob();
        if (wantedArtwork !== src) return;
        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
        // Checked again: the read is a second turn of the loop, and the photo
        // for a callsign that has since gone is the wrong picture.
        if (wantedArtwork !== src) return;
        lastArtwork = src;
        tellHost({ type: 'artwork', src: dataUrl });
    } catch (e) {
        // No picture is a notification without one, not a failure.
        if (lastArtwork === src) lastArtwork = null;
    }
}

function onMetadata(md) {
    const meta = readMetadata(md);
    if (!meta) return;
    tellHost({
        type: 'metadata',
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        actions: Object.keys(actionHandlers).filter((name) => actionHandlers[name]),
    });
    sendArtwork(meta.art);
}

/**
 * Give the page a media session if the WebView has not.
 *
 * Chromium implements the Media Session API in the *browser*, not in the
 * engine: `navigator.mediaSession` and `MediaMetadata` are simply absent in a
 * WebView. v2 checks for them (`'mediaSession' in navigator`, support.js) and,
 * finding nothing, reports the feature unavailable and never sets a thing —
 * which is honest in a plain WebView and wrong in this one, because the host
 * *does* have somewhere to put it.
 *
 * So the objects are provided. Nothing here plays anything or talks to the OS;
 * they are the API's shape, and what the page assigns to them goes to
 * PlaybackService. The page is then in exactly the position it is in on a
 * platform where this works, which is the point — no Android-specific branch in
 * v2, and no second implementation of its metadata.
 */
function polyfillMediaSession() {
    if (typeof navigator === 'undefined' || navigator.mediaSession) return;

    if (typeof window.MediaMetadata !== 'function') {
        window.MediaMetadata = function MediaMetadata(init) {
            const spec = init || {};
            this.title = spec.title || '';
            this.artist = spec.artist || '';
            this.album = spec.album || '';
            this.artwork = spec.artwork || [];
        };
    }

    let metadata = null;
    let playbackState = 'none';
    const session = {
        get metadata() { return metadata; },
        set metadata(value) {
            metadata = value;
            try { onMetadata(value); } catch (e) { /* never break the page */ }
        },
        get playbackState() { return playbackState; },
        set playbackState(value) { playbackState = value; },
        setActionHandler(action, handler) { actionHandlers[action] = handler || null; },
        // v2 keeps the scrubber fed so Chrome will light the seek buttons.
        // Nothing consumes it here, and refusing it would throw in the page.
        setPositionState() {},
    };
    Object.defineProperty(navigator, 'mediaSession', { value: session, configurable: true });
}

/**
 * Watch a media session the WebView provided, without changing what it does.
 *
 * A no-op after the polyfill, which reports for itself; this is for a WebView
 * that has the API. Every hook passes the value straight through to the real
 * implementation first — the page must behave exactly as it does in a browser,
 * and this is a listener rather than a replacement. `metadata` is an accessor
 * on MediaSession.prototype, so it is wrapped on the instance, leaving the
 * prototype (and any other page) untouched.
 */
// ---- announcements ----------------------------------------------------------
//
// v2 speaks the frequency, the mode and a looked-up callsign through the Web
// Speech API (lib/announce.js, components/AnnounceWatch.jsx). Android's WebView
// implements none of it, so `speechAvailable()` is false, the Announcements
// panel reports the feature as unavailable and nothing is ever said.
//
// The desktop client has the same shape of problem for a different reason —
// Electron ships no voices, so it switches on speech-dispatcher and borrows the
// system's. This does the same thing with Android's: Speech.java wraps
// TextToSpeech, and what is below is the API the page expects, so the panel,
// the voice picker and the announcements work unchanged.
//
// Only the parts the page uses are here, which is the whole of what
// announce.js, AnnounceWatch.jsx and the Whisper extension touch: getVoices,
// speak, cancel, the `voiceschanged` event, and an utterance carrying a voice,
// a rate and a volume.

let voices = [];
const voiceTarget = typeof EventTarget === 'function' ? new EventTarget() : null;

function polyfillSpeech() {
    if (typeof window === 'undefined' || window.speechSynthesis) return;

    function Utterance(text) {
        this.text = text == null ? '' : String(text);
        this.voice = null;
        this.lang = '';
        this.rate = 1;
        this.pitch = 1;
        this.volume = 1;
    }
    window.SpeechSynthesisUtterance = Utterance;

    const synth = {
        // Empty until the engine reports itself ready, exactly as a browser
        // behaves on first call — which is why the page listens for
        // `voiceschanged` rather than reading this once.
        getVoices: () => voices,
        speak(utterance) {
            if (!utterance) return;
            tellHost({
                type: 'speak',
                text: utterance.text,
                // The engine's own identifier, carried through the voice object
                // the page picked out of getVoices. Matching on the readable
                // name would break the moment two engines produced the same one.
                voice: (utterance.voice && utterance.voice.id) || '',
                rate: Number(utterance.rate) || 1,
                volume: Number(utterance.volume) || 1,
            });
        },
        cancel() { tellHost({ type: 'speak-cancel' }); },
        pause() {},
        resume() {},
        speaking: false,
        pending: false,
        paused: false,
        addEventListener: (name, fn) => voiceTarget && voiceTarget.addEventListener(name, fn),
        removeEventListener: (name, fn) => voiceTarget && voiceTarget.removeEventListener(name, fn),
        onvoiceschanged: null,
    };
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });

    // The engine may have been ready before this page loaded, in which case the
    // host's own push has already been and gone.
    tellHost({ type: 'voices' });
}

function onVoices(json) {
    try {
        const list = JSON.parse(json);
        if (!Array.isArray(list)) return;
        voices = list;
    } catch (e) {
        return;
    }
    const synth = window.speechSynthesis;
    if (voiceTarget) voiceTarget.dispatchEvent(new Event('voiceschanged'));
    if (synth && typeof synth.onvoiceschanged === 'function') {
        try { synth.onvoiceschanged(); } catch (e) { /* the page's handler threw */ }
    }
}

// ---- the notification shade -------------------------------------------------
//
// v2 raises browser notifications for what is worth knowing while you are not
// looking: your callsign in the chat, voice activity on a watched frequency,
// the rotator finishing, the recorder out of disk. Android's WebView has no
// Notification API, so `nativeSupported()` is false in there and every one of
// them degrades to an in-page toast — a notification you can only see if you
// are already looking at the page, on the device most likely to be in a pocket.
//
// The same treatment as the media session, and for the same reason: the page's
// logic is right, it just has nowhere to put the result. Nothing in v2 knows
// about this — its own feature check (`typeof window.Notification === 'function'`,
// plus a secure context, which loopback is) starts answering yes.

const notices = new Map();
let noticePermission = 'default';
let permissionWaiters = [];

function polyfillNotifications() {
    if (typeof window === 'undefined' || typeof window.Notification === 'function') return;

    // What Android has already granted, from the host (ReceiverActivity).
    try {
        const declared = window.ubersdrDesktop && window.ubersdrDesktop.notifications;
        if (declared === 'granted' || declared === 'denied') noticePermission = declared;
    } catch (e) { /* nothing declared */ }

    function HostNotification(title, options) {
        const opts = options || {};
        this.title = title || 'UberSDR';
        this.body = opts.body || '';
        this.tag = opts.tag || `ubersdr-${Date.now()}`;
        this.onclick = null;
        notices.set(this.tag, this);
        tellHost({
            type: 'notice',
            tag: this.tag,
            title: this.title,
            body: this.body,
            // v2 sets this for a notice with no timeout — one that should stay
            // until it is dealt with.
            ongoing: !!opts.requireInteraction,
            silent: !!opts.silent,
        });
    }

    HostNotification.prototype.close = function close() {
        notices.delete(this.tag);
        tellHost({ type: 'notice-close', tag: this.tag });
    };

    Object.defineProperty(HostNotification, 'permission', {
        get: () => noticePermission,
    });

    // v2 only asks from a user gesture, which is what Android wants too: the
    // runtime prompt appears because somebody chose native notifications in the
    // panel, not because a page loaded.
    HostNotification.requestPermission = () => new Promise((resolve) => {
        if (noticePermission !== 'default') {
            resolve(noticePermission);
            return;
        }
        permissionWaiters.push(resolve);
        tellHost({ type: 'notice-permission' });
    });

    window.Notification = HostNotification;
}

// Tell the page its speech is worth using.
//
// v2 decides whether to offer the announcements by reading the user agent,
// because in a browser that is the only way to guess at the voices behind
// `speechSynthesis` — and it wants Chrome's or Microsoft's, having found what
// Windows ships unintelligible for reading numbers. Inside this app the guess
// is both unnecessary and wrong: on Android the voices are TextToSpeech's
// through Speech.java, and on iOS they are AVSpeechSynthesizer's, which WebKit
// offers to the page directly. Neither is what the user agent suggests.
//
// It was wrong in the way that matters, too. The iOS app reads "iPad" and is
// told to use Chrome — on a device where Chrome is this same WebKit under
// another name — while the callsign lookup in the next panel along speaks
// perfectly well through the engine being refused.
//
// Declared rather than sniffed, like every other host flag: see announce.js,
// which reads it, and support.js for the same pattern with the media session.
function declareSpeech() {
    try {
        if (typeof window.speechSynthesis === 'undefined') return;
        window.ubersdrDesktop = window.ubersdrDesktop || {};
        window.ubersdrDesktop.speech = true;
    } catch (e) { /* nothing to declare to */ }
}

// ---- what this app is costing ----------------------------------------------
//
// The stats readout over the waterfall can show the app's own processor and
// memory use, and only a host can measure that: there is no browser API for it,
// and Chrome's `performance.memory` is the JavaScript heap rather than the app.
// See static/v2/src/lib/appStats.js, which defines what is installed here.
//
// Pull, not push. The page asks once a second while the readout is open, and
// asking is what makes the host measure — so a receiver whose operator never
// turns the readout on costs nothing at all. What `read()` returns is the
// previous second's answer, which is what these two figures want anyway: CPU is
// a rate and has to be averaged over an interval before it means anything.
let appStats = null;

function installAppStats() {
    if (typeof window === 'undefined') return;
    window.ubersdrAppStats = {
        read() {
            tellHost({ type: 'stats' });
            return appStats;
        },
    };
}

function onAppStats(json) {
    try {
        const s = JSON.parse(json);
        appStats = (s && (Number.isFinite(s.cpu) || Number.isFinite(s.mem))) ? s : null;
    } catch (e) {
        appStats = null;
    }
}

function onHostMessage(data) {
    if (data.startsWith('action:')) {
        runAction(data.slice(7));
        return;
    }
    if (data.startsWith('notice-click:')) {
        const notice = notices.get(data.slice(13));
        // Exactly what the browser does with a click, including the close: v2
        // hangs "show me this" off onclick and closes the notification itself.
        if (notice && typeof notice.onclick === 'function') {
            try { notice.onclick(); } catch (e) { /* the page said no */ }
        }
        return;
    }
    if (data.startsWith('stats:')) {
        onAppStats(data.slice(6));
        return;
    }
    if (data.startsWith('voices:')) {
        onVoices(data.slice(7));
        return;
    }
    if (data.startsWith('notice-permission:')) {
        noticePermission = data.slice(18) === 'granted' ? 'granted' : 'denied';
        const waiting = permissionWaiters;
        permissionWaiters = [];
        for (const resolve of waiting) resolve(noticePermission);
    }
}

function observeMediaSession() {
    const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : null;
    if (!ms) return;

    const proto = Object.getPrototypeOf(ms);
    const metadata = Object.getOwnPropertyDescriptor(proto, 'metadata');
    if (metadata && metadata.set) {
        Object.defineProperty(ms, 'metadata', {
            configurable: true,
            get() { return metadata.get.call(ms); },
            set(value) {
                metadata.set.call(ms, value);
                try { onMetadata(value); } catch (e) { /* never break the page */ }
            },
        });
    }

    const original = ms.setActionHandler.bind(ms);
    ms.setActionHandler = (action, handler) => {
        actionHandlers[action] = handler || null;
        original(action, handler);
    };
}

// The lock screen's buttons, run as the page's own handlers — so "next" steps
// the dial exactly as it does in a browser, and nothing here has to know what
// any of them mean.
function runAction(action) {
    const handler = actionHandlers[action];
    if (typeof handler === 'function') {
        try { handler(); } catch (e) { /* the page said no */ }
    }
}


const client = createClient(window, { id: 'ubersdr-android' });

// Power off closes the receiver.
//
// On a desktop each receiver is a window, and closing the window is how you
// leave one; there is no equivalent here, because a phone shows one thing at a
// time and the thing before this was the chooser. So the page's own stop button
// is the way back — no second control that means almost the same thing, and
// nothing added to the interface to say so.
//
// `running` is v2's "audio is playing" (the `session` topic), and this waits for
// a true before it will act on a false. The first snapshot arrives before the
// receiver has started: without the latch, opening one would close it.
let hasRun = false;

function onSession(snapshot) {
    if (!snapshot) return;
    if (snapshot.running) {
        // Repeated on every session patch rather than only on the edge: the
        // host treats `running` as "keep the service up", so a reload or a
        // reconnect re-establishes it without a special case. What the
        // notification *says* comes from the media session, not from here.
        hasRun = true;
        tellHost({ type: 'running' });
        return;
    }
    if (hasRun) {
        hasRun = false;
        tellHost({ type: 'stopped' });
    }
}

// Subscribing is driven by `announce`, not done once at the top.
//
// This runs as a document-start script, before any of the page's own scripts,
// so at this point there is nothing to talk to: a subscribe sent now goes
// nowhere and never retries, and the stop button silently does nothing for the
// rest of the session. The page announces itself when it mounts and again
// whenever the descriptor changes — which includes the receiver starting — and
// an announce means "reset and re-subscribe" (see BRIDGE_API.md), so it covers
// first mount, a reload, and the operator switching the bridge off and on
// again alike. The desktop client's Layout menu is wired the same way and for
// the same reason.
//
// `hello` is still sent, to prompt an announce out of a page that was already
// up before this ran. Its rejection is not interesting: the announce is the
// answer, and it may simply arrive later.
client.on('announce', () => {
    // The reply carries a snapshot of each topic, which is what catches a
    // receiver that was already running before this subscribed.
    client.subscribe(['session'])
        .then((state) => onSession(state && state.session))
        .catch(() => { /* the bridge is switched off on this receiver */ });
});
client.on('session', onSession);
client.hello().catch(() => { /* nothing there yet; the announce will come */ });

// The host's end of the channel: the lock screen's buttons, arriving as the
// names v2 registered them under.
const channel = host();
if (channel) {
    channel.onmessage = (event) => onHostMessage(String(event.data || ''));
}

// Before the page's first script, which is the whole point of running as a
// document-start script: the session has to exist, and the observer be on it,
// before anything the page does with either. That v2 should use it at all is
// not decided here — the host says so through window.ubersdrDesktop.mediaSession
// (set in ReceiverActivity), and support.js reads it.
polyfillMediaSession();
observeMediaSession();
polyfillNotifications();
polyfillSpeech();
declareSpeech();
installAppStats();
watchShared();

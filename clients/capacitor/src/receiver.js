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

// The channel ReceiverActivity opens with addWebMessageListener. Absent on a
// system WebView too old for it, in which case the receiver simply stays open
// when it is stopped — the back gesture still works.
const host = () => (typeof window !== 'undefined' ? window.ubersdrHost : null);

function tellHost(message) {
    const channel = host();
    if (!channel) return;
    try { channel.postMessage(JSON.stringify(message)); } catch (e) { /* the Activity is going */ }
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

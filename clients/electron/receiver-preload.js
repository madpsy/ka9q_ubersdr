'use strict';

// Shared settings for receiver windows.
//
// Each receiver's proxy origin keeps its own localStorage — deliberately, so
// receivers don't trample each other. With "share settings" on, this preload
// bridges them: it runs before any page script, so it can seed this origin's
// `ubersdr.v2.*` keys from the shared snapshot while the v2 bundle has yet to
// read them, and afterwards it watches for changes and reports them back.
// The page itself is untouched — it reads and writes localStorage exactly as
// it does in a browser, unaware any of this happened.
//
// Only the /v2/ page takes part. The legacy popups (callsign lookup, map)
// share this origin's storage, so a poller there would be a duplicate of the
// parent window's; and the v1 pages' own keys are outside the prefix anyway.

const { ipcRenderer } = require('electron');

const PREFIX = 'ubersdr.v2.';
// The news panel's fetched-article cache: bulky, transient, and nothing about
// how the interface looks.
const SKIP_PREFIX = 'ubersdr.v2.news.cache.';
// What this receiver was doing, as opposed to how the operator likes their
// interface: frequency, mode, filter edges, where the spectrum is pointed, and
// the squelch. All of it belongs to one receiver.
//
// Not merely surprising to share — carrying a frequency across would tune a
// receiver to a band it may not even cover, and a squelch threshold set against
// one receiver's noise floor can gate another's audio to silence, which reads
// as a broken receiver rather than as a setting. Volume and the output device
// live in the same blob and are the price of excluding it whole; they are set
// once per receiver, where the tuning changes every minute.
const SKIP_EXACT = new Set(['ubersdr.v2.radio']);

// Settings change at human speed; this is a copy of a few kilobytes.
const POLL_MS = 2000;

function shared(key) {
    return !!key && key.startsWith(PREFIX) && !key.startsWith(SKIP_PREFIX) && !SKIP_EXACT.has(key);
}

function read() {
    const map = {};
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!shared(key)) continue;
        map[key] = localStorage.getItem(key);
    }
    return map;
}

let timer = null;
let last = null;

function push() {
    const map = read();
    const serialised = JSON.stringify(map);
    if (serialised === last) return;
    last = serialised;
    ipcRenderer.send('prefs:push', map);
}

// `pushNow` seeds the snapshot from this window immediately — the window whose
// look is being adopted when sharing is switched on. Otherwise the baseline is
// what is here now, so only future changes are reported.
function start(pushNow) {
    if (timer) return;
    if (pushNow) push();
    else last = JSON.stringify(read());
    timer = setInterval(push, POLL_MS);
}

function stop() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

if (location.pathname.startsWith('/v2')) {
    const seed = ipcRenderer.sendSync('prefs:seed');
    if (seed && seed.enabled) {
        if (seed.prefs) {
            // Overwrite, don't clear: a key this receiver has and the snapshot
            // lacks is a feature the template receiver never used, not a
            // difference in how the shared ones are set.
            try {
                for (const [key, value] of Object.entries(seed.prefs)) {
                    // Filtered on the way in as well as on the way out: a
                    // snapshot written by an older build could hold a key this
                    // one has since decided is the receiver's own business.
                    if (shared(key)) localStorage.setItem(key, value);
                }
            } catch { /* quota — the page still boots on its own settings */ }
        }
        // No snapshot yet (sharing enabled with no receiver open): the first
        // window in becomes the template, not the first window somebody
        // happens to change a setting in.
        start(!seed.prefs);
    }
    // Flipped from the chooser while this window is open.
    ipcRenderer.on('prefs:mode', (_event, mode) => {
        if (mode && mode.enabled) start(!!mode.primary);
        else stop();
    });
}

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

// --- flrig, as a Radio Control transport -------------------------------------
//
// What the panel renders for it, and what it is able to keep in step. The panel
// knows nothing else about flrig: it draws these two fields, remembers what was
// typed, and says whether the operator has asked to be connected. See
// static/v2/src/controls/radioProviders.js.
const FLRIG_PROVIDER = {
    id: 'flrig',
    label: 'FLRig',
    fields: [
        { key: 'host', label: 'Host', type: 'text', default: '127.0.0.1', placeholder: '127.0.0.1' },
        { key: 'port', label: 'Port', type: 'number', default: 12345 },
    ],
    capabilities: ['frequency', 'mode', 'ptt'],
};

// The panel's settings as they last arrived, and the rig as flrig last reported
// it. Both are needed on every event: a tune has to know which way the sync is
// meant to run, and a poll has to know whether to push what it found.
let rc = null;
let rig = { frequency: null, mode: null, sdrMode: null, tx: false, connected: false };
let bridge = null;
let wanted = false;             // whether a link should be up for the current settings
// Where that link should point, as a string to compare by value. null when none
// is wanted; a change to it is what starts, moves or stops the link.
let target = null;
let lastSentToRig = { frequency: null, mode: null };
let lastPushedToSdr = { frequency: null, mode: null };
let ducked = false;

// Rounded before comparing: flrig reports whole hertz and the receiver tunes in
// whole hertz, but a rig whose last digit dithers would otherwise trade writes
// with the receiver forever.
const sameFreq = (a, b) => a != null && b != null && Math.abs(a - b) < 2;

function report(patch) {
    if (!bridge) return;
    bridge.command('radio', { action: 'status', id: 'flrig', ...patch }).catch(() => {});
}

/** Settings changed, or arrived for the first time. */
function onRadioControl(next) {
    if (!next) return;
    rc = next;
    const shouldRun = next.transport === 'flrig' && next.connect;

    // Keyed on where the link should point, not merely on whether one is
    // wanted. Watching the boolean alone meant a correction could not be
    // applied: a refused connection leaves the intent switched on, so editing
    // the port afterwards changed nothing and the link went on polling the
    // address that had just failed. The only way out was to select another
    // transport and come back, which is not a thing anyone should have to
    // discover.
    const nextTarget = shouldRun ? JSON.stringify({
        host: String(next.config.host || '127.0.0.1'),
        port: Number(next.config.port) || 12345,
    }) : null;
    if (nextTarget === target) return;
    const wasRunning = target !== null;
    target = nextTarget;
    wanted = shouldRun;

    // Moved rather than stopped: drop the old link before opening the new one,
    // or two pollers talk to two flrigs and the readout alternates.
    if (wasRunning && shouldRun) ipcRenderer.send('flrig:stop');

    if (!shouldRun) {
        if (wasRunning) ipcRenderer.send('flrig:stop');
        // Whatever the rig was doing stops being true the moment the link goes.
        rig = { frequency: null, mode: null, sdrMode: null, tx: false, connected: false };
        lastSentToRig = { frequency: null, mode: null };
        lastPushedToSdr = { frequency: null, mode: null };
        if (ducked) { ducked = false; command('duck', { ducked: false }); }
        report({ connected: false, busy: false, frequency: null, mode: null, tx: false, error: null });
        return;
    }
    report({ busy: true, error: null });
    ipcRenderer.send('flrig:start', JSON.parse(target));
}

function command(name, args) {
    if (!bridge) return Promise.resolve(null);
    return bridge.command(name, args).catch(() => null);
}

/** The receiver was tuned — push it to the rig if that is the way sync runs. */
function onTuning(t) {
    if (!wanted || !rig.connected || !t) return;
    if (!rc || rc.direction !== 'sdr-to-radio') return;

    const patch = {};
    if (rc.syncFrequency && t.frequency && !sameFreq(t.frequency, lastSentToRig.frequency)
        && !sameFreq(t.frequency, rig.frequency)) {
        patch.frequency = t.frequency;
        lastSentToRig.frequency = t.frequency;
    }
    if (rc.syncMode && t.mode && t.mode !== lastSentToRig.mode && t.mode !== rig.sdrMode) {
        patch.mode = t.mode;
        lastSentToRig.mode = t.mode;
    }
    if (patch.frequency != null || patch.mode) ipcRenderer.send('flrig:set', patch);
}

function startFlrig(client) {
    bridge = client;

    ipcRenderer.on('flrig:state', (_event, state) => {
        const wasConnected = rig.connected;
        rig = { ...rig, ...state };
        report({
            connected: !!state.connected,
            busy: false,
            frequency: state.frequency ?? null,
            mode: state.mode || null,
            tx: !!state.tx,
            error: state.error || null,
        });
        if (!state.connected) return;

        // Mute while the rig transmits. `duck` rather than `mute`, so it leaves
        // the operator's own mute alone — see the page API.
        if (rc && rc.muteOnTx && !!state.tx !== ducked) {
            ducked = !!state.tx;
            command('duck', { ducked });
        }

        if (!rc || rc.direction !== 'radio-to-sdr') return;

        // The rig leads. Only what changed, and only what the panel asked to
        // follow — and never straight back what we just sent, which is what
        // makes this a sync rather than a loop.
        const patch = {};
        if (rc.syncFrequency && state.frequency
            && !sameFreq(state.frequency, lastPushedToSdr.frequency)) {
            patch.frequency = state.frequency;
            lastPushedToSdr.frequency = state.frequency;
        }
        if (rc.syncMode && state.sdrMode && state.sdrMode !== lastPushedToSdr.mode) {
            patch.mode = state.sdrMode;
            lastPushedToSdr.mode = state.sdrMode;
        }
        // One tune, not two: sending frequency and mode separately walks the
        // receiver through an intermediate pair, which is audible.
        if (patch.frequency != null || patch.mode) command('tune', patch);

        // A rig that has only just connected has nothing to compare against, so
        // the first poll is a starting point rather than a change.
        if (!wasConnected && !patch.frequency) lastPushedToSdr.frequency = state.frequency ?? null;
    });

    // The window is going away: drop the link rather than leaving it polling a
    // rig for a page that no longer exists.
    window.addEventListener('pagehide', () => {
        ipcRenderer.send('flrig:stop');
        if (bridge) bridge.command('radio', { action: 'unregister', id: 'flrig' }).catch(() => {});
    });
}

// --- the Layout menu's end of the page API ----------------------------------
//
// The native Layout menu is a bridge client, exactly like a browser extension
// would be: it subscribes to the `layout` topic and sends `panel` commands. The
// bridge is built for this — CustomEvents on window, which cross from an
// isolated world into the page because they travel through the DOM, so no
// MAIN-world injection and no second copy of the wire format here.
//
// The client library is the page's own, bundled to CJS at staging time. Absent
// when the UI has never been built, in which case there is simply no menu.
function startLayoutBridge() {
    let createClient;
    try {
        // eslint-disable-next-line global-require
        ({ createClient } = require('./ui/bridgeClient.cjs'));
    } catch { return; }

    const client = createClient(window, { id: 'electron-menu' });
    const push = (layout) => {
        if (layout) ipcRenderer.send('layout:changed', layout);
    };

    // Subscribing is driven by `announce`, not by the reply to `hello`.
    //
    // A preload runs before any of the page's own scripts, so at this point
    // there is nothing to talk to yet — a bare `hello` would time out against a
    // page that was merely still starting, and the menu would never appear. The
    // host announces itself when it mounts, and again whenever the descriptor
    // changes, and an announce means "reset and re-subscribe" (see
    // BRIDGE_API.md), which covers first mount, a reload, and the operator
    // switching the bridge back on in the Page API panel alike.
    //
    // `hello` is still sent, to prompt an announce out of a page that was
    // already up before this ran. Its rejection is not interesting: the
    // announce is the answer, and it may simply arrive later.
    const resubscribe = () => {
        client.subscribe(['layout', 'radiocontrol', 'tuning'])
            .then((state) => {
                push(state && state.layout);
                // Re-offered on every announce, because an announce means the
                // page reset — after a reload the registry is empty and a
                // transport that only registered once would have vanished.
                client.command('radio', { action: 'register', provider: FLRIG_PROVIDER })
                    .then(() => onRadioControl(state && state.radiocontrol))
                    .catch(() => { /* an older page, without transports */ });
            })
            .catch(() => { /* the next announce will bring us back */ });
    };
    client.on('announce', resubscribe);
    client.on('layout', push);
    client.on('radiocontrol', onRadioControl);
    client.on('tuning', onTuning);
    client.hello().catch(() => { /* not up yet — its announce will arrive */ });

    startFlrig(client);

    // The menu asking for a change. Failures are reported back so the menu can
    // put its tick where the page actually is rather than where it asked to be.
    ipcRenderer.on('layout:panel', (_event, req) => {
        client.command('panel', req.args)
            .then(() => ipcRenderer.send('layout:done', { id: req.id, ok: true }))
            .catch((err) => ipcRenderer.send('layout:done', { id: req.id, ok: false, error: err.message }));
    });
}

if (location.pathname.startsWith('/v2')) {
    startLayoutBridge();
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

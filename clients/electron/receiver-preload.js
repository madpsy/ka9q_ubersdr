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

// --- the Radio Control transports this client offers -------------------------
//
// What the panel renders for each, and what each can keep in step. The panel
// knows nothing else about them: it draws the fields, remembers what was typed
// against the id, and says which one is chosen and whether the operator has
// asked to be connected. See static/v2/src/controls/radioProviders.js.
//
// Both are things a page cannot reach on its own — flrig answers XML-RPC with
// no CORS headers, rigctld is a raw socket — which is the whole reason this
// client has anything to offer here. The protocols live in the main process
// (flrig.js, rigctl.js); this end only names them.
const PROVIDERS = [
    {
        id: 'flrig',
        label: 'FLRig',
        fields: [
            { key: 'host', label: 'Host', type: 'text', default: '127.0.0.1', placeholder: '127.0.0.1' },
            { key: 'port', label: 'Port', type: 'number', default: 12345 },
        ],
        capabilities: ['frequency', 'mode', 'ptt'],
    },
    {
        id: 'rigctld',
        // Named for what somebody is running rather than for Hamlib, which is
        // also what the page's Serial transport is built on — two entries both
        // called Hamlib would be a menu you cannot choose from.
        label: 'rigctld',
        fields: [
            { key: 'host', label: 'Host', type: 'text', default: '127.0.0.1', placeholder: '127.0.0.1' },
            { key: 'port', label: 'Port', type: 'number', default: 4532 },
        ],
        capabilities: ['frequency', 'mode', 'ptt'],
    },
];
const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

// The panel's settings as they last arrived, and the rig as flrig last reported
// it. Both are needed on every event: a tune has to know which way the sync is
// meant to run, and a poll has to know whether to push what it found.
let rc = null;
let rig = { frequency: null, mode: null, sdrMode: null, tx: false, connected: false };
// The receiver's own dial, as last reported. Kept whichever way the sync runs,
// because it is what a link coming up has to be brought into line with.
let tuning = null;
let bridge = null;
let wanted = false;             // whether a link should be up for the current settings
let selected = null;            // the transport of ours the panel is showing, if any
// What that link should be, as a string to compare by value — the transport and
// where it points. null when none is wanted; a change to it is what starts,
// moves or stops the link.
let target = null;
let lastSentToRig = { frequency: null, mode: null };
let lastPushedToSdr = { frequency: null, mode: null };
let ducked = false;
// Transports found to have no PTT — plenty of Hamlib backends cannot read it.
const droppedPtt = new Set();

/**
 * A transport as it should be offered *now*.
 *
 * Through one function because it is registered from two places — once per
 * announce, and again the moment a rig turns out to lack PTT — and the announce
 * is the more frequent of the two. Building the descriptor from the constant in
 * that path put the capability straight back every time the page re-announced,
 * so the switch it was meant to remove reappeared a second later.
 */
function descriptorFor(spec) {
    if (!droppedPtt.has(spec.id)) return spec;
    return { ...spec, capabilities: spec.capabilities.filter((c) => c !== 'ptt') };
}

// Rounded before comparing: flrig reports whole hertz and the receiver tunes in
// whole hertz, but a rig whose last digit dithers would otherwise trade writes
// with the receiver forever.
const sameFreq = (a, b) => a != null && b != null && Math.abs(a - b) < 2;

// Reported against whichever transport is selected: a status for one the panel
// is not showing would be a readout nobody asked for.
function report(patch) {
    if (!bridge || !selected) return;
    bridge.command('radio', { action: 'status', id: selected, ...patch }).catch(() => {});
}

/** Settings changed, or arrived for the first time. */
function onRadioControl(next) {
    if (!next) return;
    rc = next;
    selected = PROVIDER_IDS.includes(next.transport) ? next.transport : null;
    const shouldRun = !!selected && next.connect;

    // Keyed on where the link should point, not merely on whether one is
    // wanted. Watching the boolean alone meant a correction could not be
    // applied: a refused connection leaves the intent switched on, so editing
    // the port afterwards changed nothing and the link went on polling the
    // address that had just failed. The only way out was to select another
    // transport and come back, which is not a thing anyone should have to
    // discover.
    const spec = PROVIDERS.find((p) => p.id === selected);
    const nextTarget = shouldRun ? JSON.stringify({
        kind: selected,
        host: String(next.config.host || '127.0.0.1'),
        port: Number(next.config.port)
            || spec.fields.find((f) => f.key === 'port').default,
    }) : null;
    if (nextTarget === target) { onSettingsOnly(); return; }
    const wasRunning = target !== null;
    target = nextTarget;
    wanted = shouldRun;

    // Moved rather than stopped: drop the old link before opening the new one,
    // or two pollers talk to two flrigs and the readout alternates.
    if (wasRunning && shouldRun) ipcRenderer.send('radio:stop');

    if (!shouldRun) {
        if (wasRunning) ipcRenderer.send('radio:stop');
        // Whatever the rig was doing stops being true the moment the link goes.
        rig = { frequency: null, mode: null, sdrMode: null, tx: false, connected: false };
        lastSentToRig = { frequency: null, mode: null };
        lastPushedToSdr = { frequency: null, mode: null };
        if (ducked) { ducked = false; command('duck', { ducked: false }); }
        report({ connected: false, busy: false, frequency: null, mode: null, tx: false, error: null });
        return;
    }
    report({ busy: true, error: null });
    ipcRenderer.send('radio:start', JSON.parse(target));
}

/** Settings changed without the link needing to move — a direction flip, say. */
function onSettingsOnly() {
    syncToRig();
}

function command(name, args) {
    if (!bridge) return Promise.resolve(null);
    return bridge.command(name, args).catch(() => null);
}

/** The receiver was tuned. Remembered whichever way the sync runs. */
function onTuning(t) {
    if (t) tuning = t;
    syncToRig();
}

/**
 * Bring the rig into line with the receiver, where that is the way sync runs.
 *
 * Called when the receiver moves, and also the moment a link comes up or the
 * direction is changed to this one — which is the part that was missing. Waiting
 * for the receiver to move next meant switching sync on did nothing at all: the
 * rig sat wherever it had been until somebody happened to touch the dial, and
 * a mode that was already right on the receiver was never sent, so the rig
 * stayed in the wrong one indefinitely.
 *
 * The guards below are what keep it from being a loop rather than a sync: never
 * send what was last sent, and never send what the rig is already on.
 */
function syncToRig() {
    if (!wanted || !rig.connected || !tuning) return;
    if (!rc || rc.direction !== 'sdr-to-radio') return;

    const patch = {};
    if (rc.syncFrequency && tuning.frequency
        && !sameFreq(tuning.frequency, lastSentToRig.frequency)
        && !sameFreq(tuning.frequency, rig.frequency)) {
        patch.frequency = tuning.frequency;
        lastSentToRig.frequency = tuning.frequency;
    }
    if (rc.syncMode && tuning.mode && tuning.mode !== lastSentToRig.mode
        && tuning.mode !== rig.sdrMode) {
        patch.mode = tuning.mode;
        lastSentToRig.mode = tuning.mode;
    }
    if (patch.frequency != null || patch.mode) ipcRenderer.send('radio:set', patch);
}

function startRadio(client) {
    bridge = client;

    ipcRenderer.on('radio:state', (_event, state) => {
        // A rig that turns out to have no PTT: offer the transport again
        // without that capability, so the panel stops showing a mute-on-
        // transmit switch that nothing will ever trip. Registering the same id
        // replaces the descriptor and leaves its status alone.
        if (state.pttAvailable === false && selected && !droppedPtt.has(selected)) {
            droppedPtt.add(selected);
            const spec = PROVIDERS.find((p) => p.id === selected);
            if (spec) command('radio', { action: 'register', provider: descriptorFor(spec) });
        }
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

        // The link has just come up, and the receiver leads: bring the rig to
        // it rather than waiting for the next time somebody turns the dial.
        if (!wasConnected && state.connected) syncToRig();

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
        ipcRenderer.send('radio:stop');
        if (!bridge) return;
        for (const id of PROVIDER_IDS) {
            bridge.command('radio', { action: 'unregister', id }).catch(() => {});
        }
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
// A panel icon, as something a native menu can show.
//
// The page sends SVG markup; nativeImage does not read SVG, so it is drawn to a
// canvas here — the preload shares the page's DOM, and the main process has no
// renderer to do it in. PNG data URLs go up with the layout, cached by panel id
// because the icons never change while a page is open.
//
// One flat colour, because a menu is drawn by the desktop theme and there is no
// way to ask which way round it is: `currentColor` would resolve to nothing
// useful outside a page. Mid-grey is the compromise that stays legible on a
// light menu and a dark one alike — macOS could do better with a template
// image, but not GTK.
const ICON_COLOUR = '#8a93a6';
const ICON_PX = 32;
const iconCache = new Map();

function rasteriseIcon(id, svg) {
    if (iconCache.has(id)) return Promise.resolve(iconCache.get(id));
    if (!svg) { iconCache.set(id, null); return Promise.resolve(null); }
    return new Promise((resolve) => {
        // Two things the markup needs before it is a document rather than a
        // fragment of a page:
        //
        //   * `xmlns`. Inline in HTML an <svg> needs none; loaded through an
        //     Image it is a standalone document and without it nothing parses.
        //   * one width and height. The icons already carry 16×16, and simply
        //     prepending another pair produces duplicate attributes — which is
        //     a fatal XML error, so the image fails to load and every panel
        //     silently ends up with no icon.
        //
        // Only the opening tag is touched: several of these icons are drawn
        // from <rect>s, whose own width and height must survive.
        const sized = svg
            .replace(/currentColor/g, ICON_COLOUR)
            .replace(/^<svg[^>]*>/, (tag) => tag
                .replace(/\s(?:width|height)="[^"]*"/g, '')
                .replace('<svg', `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_PX}" height="${ICON_PX}"`));
        const img = new Image();
        const done = (value) => { iconCache.set(id, value); resolve(value); };
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = ICON_PX;
                canvas.height = ICON_PX;
                canvas.getContext('2d').drawImage(img, 0, 0, ICON_PX, ICON_PX);
                done(canvas.toDataURL('image/png'));
            } catch (e) { done(null); }
        };
        img.onerror = () => done(null);
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sized);
    });
}

/**
 * The layout, with every icon drawn into a PNG the menu can use — the panels'
 * and the groups' alike.
 *
 * Group ids are namespaced in the cache: a group of one carries its panel's id
 * (the Multipad is its own group), and the two would otherwise share an entry.
 */
function withIcons(layout) {
    const panels = layout.panels || [];
    const groups = layout.groups || [];
    return Promise.all([
        ...panels.map((p) => rasteriseIcon(p.id, p.icon)),
        ...groups.map((g) => rasteriseIcon('group:' + g.id, g.icon)),
    ]).then((icons) => ({
        ...layout,
        panels: panels.map((p, i) => {
            // The markup has done its job; only the picture travels on.
            const { icon, ...rest } = p;
            return { ...rest, iconPng: icons[i] };
        }),
        groups: groups.map((g, i) => {
            const { icon, ...rest } = g;
            return { ...rest, iconPng: icons[panels.length + i] };
        }),
    }));
}

function startLayoutBridge() {
    let createClient;
    try {
        // eslint-disable-next-line global-require
        ({ createClient } = require('./ui/bridgeClient.cjs'));
    } catch { return; }

    const client = createClient(window, { id: 'electron-menu' });
    const push = (layout) => {
        if (!layout) return;
        withIcons(layout)
            .then((withPictures) => ipcRenderer.send('layout:changed', withPictures))
            // An icon is a nicety; the menu is not.
            .catch(() => ipcRenderer.send('layout:changed', layout));
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
                // The reply carries a snapshot of each topic. Seeding the dial
                // from it matters: the topic only emits on a *change*, so
                // without this the receiver's current frequency and mode are
                // unknown until somebody moves them — and a link coming up has
                // nothing to bring the rig into line with.
                if (state && state.tuning) tuning = state.tuning;
                // Re-offered on every announce, because an announce means the
                // page reset — after a reload the registry is empty and a
                // transport that only registered once would have vanished.
                Promise.all(PROVIDERS.map((spec) => client.command(
                    'radio', { action: 'register', provider: descriptorFor(spec) },
                )))
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

    startRadio(client);

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

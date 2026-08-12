'use strict';

// What the host runs inside a receiver page.
//
// The desktop client's equivalent is clients/electron/receiver-preload.js, and
// this is the same idea with a different injection: there a sandboxed preload,
// here a document-start script (ReceiverActivity). Both are bundled at build
// time with the v2 page API's own client library, because neither can `require`
// or `import` anything at run time.
//
// One job so far: closing the receiver when the page says it has stopped.
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
    try { channel.postMessage(message); } catch (e) { /* the Activity is going */ }
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
        hasRun = true;
        return;
    }
    if (hasRun) {
        hasRun = false;
        tellHost('stopped');
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

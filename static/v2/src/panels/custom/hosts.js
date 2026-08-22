// The page side of a custom panel's connection.
//
// A panel speaks the documented page API — the same topics, the same commands,
// the same `run` catalogue an extension or a userscript gets, straight out of
// BRIDGE_API.md. What differs is the transport and the accounting.
//
// ── Why panels are not bridge clients ────────────────────────────────────────
//
// The obvious implementation is to let a panel be a client of the bridge like
// anything else, and it is wrong three times over. bridge/host.js caps clients
// at eight, and an operator may enable ten panels. bridge/settings.js gives the
// operator a switch to refuse outside clients, which is a decision about browser
// extensions, not about panels they installed on their own receiver — and a
// panel that vanished when that switch was thrown would look broken. And the
// attached-client count feeds a badge meaning "something outside this page is
// driving my receiver", which a panel is not.
//
// So panels get hosts of their own. `createHost` is DOM-free and takes its
// dependencies as functions, which is exactly what makes that cheap: the same
// snapshot, command and run that BridgeHost already built, a different `send`,
// and a client cap and an announce of its own.
//
// One host per panel rather than one shared host with many clients, so that a
// panel cannot address another panel's client id, and a message can only ever
// reach the frame it came from.
//
// ── What a panel may do ──────────────────────────────────────────────────────
//
// Everything a built-in panel may do. `uses` in a manifest is a declaration for
// the operator to read, not a permission grant, and there is nothing here that
// enforces it: a custom Rotator panel can call the same rotator functions
// panels/RotatorPanel.jsx calls, and is gated by the same stored hardware
// password it cannot obtain for itself. See CUSTOM_PANELS.md §5.1.
//
// The one exception is `fetch`, which is proxied here rather than performed in
// the frame, and refuses the admin endpoints. See fetchForPanel below.

import { createHost } from '../../bridge/host.js';
import { readAll, writeKey } from './store.js';

// Bounded because a frame can ask for anything: one host per attached panel, and
// panels are capped server-side at ten.
const MAX_PANELS = 16;

const hosts = new Map();        // panel id -> { host, port, detach }
let deps = null;                // supplied by BridgeHost once it exists

/**
 * Give the panel hosts what they need to answer.
 *
 * Called by bridge/BridgeHost.jsx, which is where the receiver's state and the
 * command implementations already live. Panels attached before this arrives
 * simply have nothing to answer with yet, which is a race that cannot happen in
 * practice — BridgeHost mounts above the docks — and is handled rather than
 * assumed.
 */
export function setPanelDeps(next) {
    deps = next;
}

/** Fan a topic out to every attached panel. */
export function publishToPanels(topic, value) {
    for (const entry of hosts.values()) entry.host.publish(topic, value);
}

/** The rate-limit tick, for the same reason the bridge has one. */
export function tickPanels() {
    for (const entry of hosts.values()) entry.host.tick();
}

/** Tell every panel the page is going away. */
export function closingPanels() {
    for (const entry of hosts.values()) entry.host.closing();
}

export function attachedPanelIds() {
    return Array.from(hosts.keys());
}

/**
 * Fetch, on a panel's behalf.
 *
 * A panel's frame has an opaque origin, so it can reach any third-party API that
 * sends permissive CORS headers but not this receiver's own — the one thing
 * nearly every panel actually wants. So the parent performs it.
 *
 * Same-origin only, and with the operator's credentials, which is parity with a
 * built-in panel: they are same-origin and carry the session too.
 *
 * The admin endpoints are the single deviation from that parity. Nothing a
 * built-in panel calls one, so denying them costs an author nothing they would
 * ever notice — and it is the difference between a bad panel being an annoyance
 * and a bad panel taking the receiver, on a page where the operator may well be
 * signed into admin in the same browser. A denylist rather than an allowlist,
 * because an allowlist has to be kept correct for ever and this has to be
 * correct once.
 */
export async function fetchForPanel(path, init) {
    let url;
    try {
        url = new URL(String(path), location.origin);
    } catch (e) {
        return { ok: false, status: 0, error: 'that is not a URL this panel can ask for' };
    }
    if (url.origin !== location.origin) {
        return {
            ok: false,
            status: 0,
            error: 'sdr.fetch is for this receiver; use fetch() directly for anything else',
        };
    }
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
        return { ok: false, status: 0, error: 'panels may not call admin endpoints' };
    }

    try {
        const res = await fetch(url.toString(), {
            method: (init && init.method) || 'GET',
            headers: (init && init.headers) || undefined,
            body: (init && init.body) || undefined,
            credentials: 'same-origin',
        });
        return {
            ok: res.ok,
            status: res.status,
            contentType: res.headers.get('Content-Type') || '',
            body: await res.text(),
        };
    } catch (e) {
        return { ok: false, status: 0, error: 'the request failed' };
    }
}

/**
 * Attach one panel's frame.
 *
 * `port` is one end of a MessageChannel the parent created; the frame has the
 * other. Two kinds of message travel over it, told apart by their type rather
 * than by an envelope:
 *
 *   - a **string** is a page-API message, handed to the host untouched, so the
 *     frame can use bridge/client.js exactly as an extension does;
 *   - an **object** is a panel-only request — storage, height, fetch — which the
 *     page API has no business carrying.
 */
export function attachPanel({ id, port, onHeight }) {
    if (!id || !port) return () => {};
    detachPanel(id);
    if (hosts.size >= MAX_PANELS) return () => {};

    // Page-API messages go over as strings, panel-only ones as objects, and that
    // is the whole discrimination — no envelope, no type field shared between
    // two protocols. So the two must not share a sender: putting a panel-only
    // reply through `send` would stringify it, and the frame would read its own
    // answer as bridge traffic and drop it.
    const send = (msg) => {
        try { port.postMessage(typeof msg === 'string' ? msg : JSON.stringify(msg)); } catch (e) { /* gone */ }
    };
    const postPanel = (msg) => {
        try { port.postMessage(msg); } catch (e) { /* gone */ }
    };

    const host = createHost({
        send,
        // Answered from BridgeHost's own state, so a panel and the page can
        // never disagree about what the receiver is doing.
        describe: () => (deps ? deps.describe() : null),
        snapshot: (topic) => (deps ? deps.snapshot(topic) : null),
        command: (name, args) => {
            if (!deps) throw new Error('the receiver is not ready yet');
            return deps.command(name, args);
        },
        run: (fn, event) => {
            if (!deps) throw new Error('the receiver is not ready yet');
            return deps.run(fn, event);
        },
        // Not the operator's bridge switch: that is about clients outside this
        // page, and a panel is inside it. See the note at the top of this file.
        enabled: () => true,
    });

    const onMessage = async (ev) => {
        const data = ev.data;
        if (typeof data === 'string') {
            host.handle(data);
            return;
        }
        if (!data || typeof data !== 'object') return;

        // Panel-only requests. Each carries its own id so the frame can await
        // one, and each answers exactly once.
        const reply = (value) => postPanel({ p: data.p, rid: data.rid, value });
        switch (data.p) {
            case 'height':
                if (onHeight && Number.isFinite(Number(data.height))) onHeight(Number(data.height));
                break;
            case 'store.all':
                reply(await readAll(id));
                break;
            case 'store.set':
                reply({ error: await writeKey(id, data.key, data.value) });
                break;
            case 'fetch':
                reply(await fetchForPanel(data.path, data.init));
                break;
            default:
                break;
        }
    };

    port.onmessage = onMessage;
    try { port.start(); } catch (e) { /* already started */ }

    hosts.set(id, { host, port });
    host.announce();
    return () => detachPanel(id);
}

export function detachPanel(id) {
    const entry = hosts.get(id);
    if (!entry) return;
    hosts.delete(id);
    try { entry.host.closing(); } catch (e) { /* ignore */ }
    try { entry.port.onmessage = null; entry.port.close(); } catch (e) { /* ignore */ }
}

// Testing seam.
export function resetPanelHosts() {
    for (const id of Array.from(hosts.keys())) detachPanel(id);
    deps = null;
}

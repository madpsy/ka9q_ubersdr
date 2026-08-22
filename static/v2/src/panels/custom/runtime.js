// `ubersdr`, as a panel sees it.
//
// This runs inside the sandboxed frame, inlined ahead of the panel's own code by
// srcdoc.js. Its whole job is to turn the one MessagePort the parent hands over
// into the API an author writes against.
//
// The page-API half is not reimplemented here: bridge/client.js is the reference
// client, and it takes any object with add/removeEventListener and
// dispatchEvent. So the port is wrapped as one and that file is used unchanged —
// which means a panel and a browser extension exercise the same code and cannot
// drift apart. Everything in BRIDGE_API.md is therefore already true here.
//
// On top of it: storage, an outgoing fetch the parent performs, and the height
// this panel wants to be. Those are panel-only and travel as objects, where page
// API messages travel as strings — see hosts.js.

import { createClient } from '../../bridge/client.js';
import { EVENT_FROM_PAGE, EVENT_TO_PAGE } from '../../bridge/protocol.js';

/** The port, as something bridge/client.js will talk to. */
function portTarget(port) {
    const listeners = new Map();
    port.addEventListener('message', (ev) => {
        if (typeof ev.data !== 'string') return;     // panel-only traffic
        const set = listeners.get(EVENT_FROM_PAGE);
        if (!set) return;
        for (const fn of Array.from(set)) fn({ detail: ev.data });
    });
    return {
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(fn);
        },
        removeEventListener(type, fn) {
            const set = listeners.get(type);
            if (set) set.delete(fn);
        },
        dispatchEvent(ev) {
            if (ev && ev.type === EVENT_TO_PAGE) port.postMessage(ev.detail);
            return true;
        },
    };
}

// A CustomEvent stand-in, so client.js needs nothing from the DOM. The real one
// exists in here, but constructing objects is cheaper and keeps this working
// wherever the runtime is exercised.
function eventCtor(type, init) {
    return { type, detail: init && init.detail };
}
eventCtor.prototype = {};

export function startPanelRuntime(global) {
    const scope = global || globalThis;
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });

    // Panel-only requests, each awaiting its own reply.
    let rid = 0;
    const waiting = new Map();

    let heightTimer = null;
    let lastHeight = -1;

    function connect(port) {
        port.start();

        port.addEventListener('message', (ev) => {
            const data = ev.data;
            if (typeof data === 'string' || !data || typeof data !== 'object') return;
            const pending = waiting.get(data.rid);
            if (!pending) return;
            waiting.delete(data.rid);
            pending(data.value);
        });

        const ask = (p, extra) => new Promise((resolve) => {
            rid += 1;
            waiting.set(rid, resolve);
            port.postMessage({ p, rid, ...extra });
        });

        const client = createClient(portTarget(port), { CustomEvent: eventCtor });

        /**
         * How tall this panel wants to be.
         *
         * Reported rather than measured from outside: the parent cannot see into
         * an opaque-origin frame, so the panel is the only thing that knows. Sent
         * on a frame boundary and only when it changes, because a ResizeObserver
         * fires on every layout and a message per layout is a message per
         * animation frame.
         */
        const height = (px) => {
            const value = Math.max(0, Math.round(Number(px) || 0));
            if (value === lastHeight) return;
            lastHeight = value;
            port.postMessage({ p: 'height', height: value });
        };

        const watchHeight = () => {
            if (typeof ResizeObserver !== 'function') return;
            const observer = new ResizeObserver(() => {
                if (heightTimer) return;
                heightTimer = requestAnimationFrame(() => {
                    heightTimer = null;
                    height(document.documentElement.scrollHeight);
                });
            });
            observer.observe(document.documentElement);
            observer.observe(document.body);
        };

        const config = scope.__ubersdrPanel || {};
        const minimalListeners = new Set();
        // Declared ahead of the object that closes over it: `store.all()` is
        // synchronous for the author, so the value has to exist before anything
        // can be handed a reference to it.
        let storeSnapshot = {};

        const sdr = {
            // Everything BRIDGE_API.md documents, unchanged.
            on: (topic, fn) => client.on(topic, fn),
            get: (topic) => client.get(topic),
            subscribe: (topics, opts) => client.subscribe(topics, opts),
            command: (name, args) => client.command(name, args),
            run: (fn, event) => client.run(fn, event),
            get receiver() { return client.descriptor ? client.descriptor.receiver : null; },
            client,

            // Panel-only.
            //
            // `store.all()` is synchronous because the whole store arrives with
            // the port: settings are read during a panel's first render, and
            // awaiting a parent across a channel to draw a clock face is not
            // something an author should have to arrange.
            store: {
                all: () => ({ ...storeSnapshot }),
                get: (key) => storeSnapshot[key],
                set: async (key, value) => {
                    if (value === undefined) delete storeSnapshot[key];
                    else storeSnapshot[key] = value;
                    const res = await ask('store.set', { key, value });
                    return (res && res.error) || null;
                },
            },
            fetch: (path, init) => ask('fetch', { path: String(path), init: init || null }),
            height,

            // Whether the operator has this panel cut down. The panel decides
            // what survives; nothing here does it for them.
            get minimal() { return !!config.minimal; },
            onMinimal: (fn) => { minimalListeners.add(fn); return () => minimalListeners.delete(fn); },
        };

        ask('store.all').then((all) => {
            storeSnapshot = (all && typeof all === 'object') ? all : {};
            // Only now: an author's first line is `await ubersdr.ready()`, and
            // everything after it may read the store synchronously.
            scope.sdr = sdr;
            resolveReady(sdr);
            watchHeight();
            height(document.documentElement.scrollHeight);
        });
    }

    // The parent hands the port over once, after this document has loaded — by
    // which time this listener is registered, because the runtime is inlined in
    // the head and runs while the document is still parsing.
    scope.addEventListener('message', (ev) => {
        if (!ev.ports || !ev.ports.length) return;
        if (!ev.data || ev.data['ubersdr.panel-port'] !== true) return;
        connect(ev.ports[0]);
    });

    scope.ubersdr = {
        ready: () => ready,
        version: 1,
    };
    return scope.ubersdr;
}

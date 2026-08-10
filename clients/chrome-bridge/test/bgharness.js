// A background script, loaded with the browser it expects stubbed out.
//
// background.js is the half of this extension nothing executed in a test: the
// contract test reads it as text, and the content-script harness records what
// reaches it without ever running it. That is exactly where a `tabId` that was
// never declared could sit in a case statement and throw on every message,
// which is what it did — the panel's settings arrived and were dropped.
'use strict';
const fs = require('fs');
const path = require('path');

function makeBackground(extDir, { flrigPort = 0 } = {}) {
    const store = {};
    const listeners = { message: [], activated: [], removed: [], updated: [], alarm: [] };
    const toTabs = [];        // [tabId, message]
    const toPopup = [];
    const alarms = new Set();

    const evt = (list) => ({ addListener: (fn) => list.push(fn) });
    const api = {
        runtime: {
            onMessage: evt(listeners.message),
            sendMessage: (m) => { toPopup.push(m); return Promise.resolve(); },
            lastError: null,
        },
        storage: {
            local: {
                get: (keys) => Promise.resolve(
                    Array.isArray(keys)
                        ? Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]]))
                        : { ...store },
                ),
                set: (o) => { Object.assign(store, o); return Promise.resolve(); },
                remove: (k) => { delete store[k]; return Promise.resolve(); },
            },
            session: {
                get: () => Promise.resolve({}),
                set: () => Promise.resolve(),
                remove: () => Promise.resolve(),
                setAccessLevel: () => Promise.resolve(),
            },
        },
        tabs: {
            onActivated: evt(listeners.activated),
            onRemoved: evt(listeners.removed),
            onUpdated: evt(listeners.updated),
            query: () => Promise.resolve([]),
            create: () => Promise.resolve({}),
            update: () => Promise.resolve({}),
            sendMessage: (id, m) => { toTabs.push([id, m]); return Promise.resolve(); },
        },
        alarms: {
            onAlarm: evt(listeners.alarm),
            create: (n) => alarms.add(n),
            clear: (n) => { alarms.delete(n); return Promise.resolve(); },
        },
    };

    const src = fs.readFileSync(path.join(extDir, 'background.js'), 'utf8');
    const fetchCalls = [];
    const fetchImpl = (url, opts) => {
        fetchCalls.push([url, opts]);
        // flrig's XML-RPC, answered only for the port the test says is live.
        const ok = flrigPort && String(url).includes(':' + flrigPort + '/');
        if (!ok) return Promise.reject(new Error('ECONNREFUSED'));
        const body = String((opts && opts.body) || '');
        const method = (/<methodName>([^<]+)<\/methodName>/.exec(body) || [])[1];
        const val = method === 'rig.get_vfo' ? '<double>14074000</double>'
            : method === 'rig.get_mode' ? '<string>USB</string>'
                : method === 'rig.get_AB' ? '<string>A</string>'
                    : '<int>0</int>';
        return Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve(
                `<?xml version="1.0"?><methodResponse><params><param><value>${val}</value></param></params></methodResponse>`),
        });
    };

    // How `browser` is supplied depends on the build. The Chrome one declares
    // its own (`const browser = globalThis.browser ?? chrome`), so a parameter
    // of that name would be a redeclaration and it has to come from the global
    // instead — read once, at load. The Firefox one just uses `browser`, and
    // takes it as a parameter so each harness keeps its own rather than every
    // instance sharing one global and the last one built winning.
    const declaresBrowser = /\b(?:const|let|var)\s+browser\s*=/.test(src);
    const params = ['chrome', ...(declaresBrowser ? [] : ['browser']),
        'fetch', 'console', 'setTimeout', 'clearTimeout'];
    const args = [api, ...(declaresBrowser ? [] : [api]), fetchImpl,
        { log() {}, warn() {}, error() {} },
        (fn, ms) => setTimeout(fn, Math.min(ms || 0, 5)), clearTimeout];

    const hadBrowser = 'browser' in globalThis;
    const prevBrowser = globalThis.browser;
    if (declaresBrowser) globalThis.browser = api;
    try {
        // eslint-disable-next-line no-new-func
        new Function(...params, src)(...args);
    } finally {
        if (declaresBrowser) {
            if (hadBrowser) globalThis.browser = prevBrowser;
            else delete globalThis.browser;
        }
    }

    return {
        store,
        toTabs,
        toPopup,
        fetchCalls,
        /** A message from a content script in `tabId`. */
        say: (tabId, msg) => {
            const results = listeners.message.map(
                (fn) => fn(msg, { tab: { id: tabId } }, () => {}),
            );
            return Promise.all(results.filter((r) => r && typeof r.then === 'function'));
        },
        sentTo: (tabId, type) => toTabs.filter(([id, m]) => id === tabId && m.type === type).map(([, m]) => m),
        settle: () => new Promise((r) => setTimeout(r, 30)),
    };
}

module.exports = { makeBackground };

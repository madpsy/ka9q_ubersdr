'use strict';

// window.ubersdr — everything the chooser page can do.
//
// The chooser is not forked for this client: build.sh stages
// clients/electron/chooser/ as it stands, and its one dependency on the host it
// runs in is `const api = window.ubersdr` (chooser.js). This module is that
// object, built out of the store, the discovery layer and the plugin, where the
// desktop client builds it out of ipcRenderer (clients/electron/preload.js) and
// 32 handlers in its main process.
//
// So the contract here is not this file's to choose — every shape below is the
// one main.js already answers with, and the comments say where a shape is not
// obvious from the call site. Where the desktop client's behaviour cannot be
// reproduced yet, the difference is named rather than smoothed over.

import { InstanceStore } from './store.js';
import { UberSdr } from './native.js';
import * as discovery from './discovery.js';
import { PRODUCT } from './useragent.js';
import pkg from '../package.json';

// Stamped in by build.sh (esbuild --define), so a stale bundle is visible in
// the chooser's footer at a glance. The fallback is for a bundle built by hand.
const BUILD_INFO = typeof __BUILD_INFO__ === 'string' ? __BUILD_INFO__ : '';

const store = new InstanceStore();

// Which receiver is open, as far as the chooser is concerned.
//
// The desktop client has a window per instance and asks a Map. Here a receiver
// is an Activity and there is one of it: a phone shows one thing at a time, and
// two receivers playing at once would be two claims on the audio focus. The
// native side is the authority — the Activity can be dismissed by the system or
// by the back gesture without this half of the app being asked.
let openId = null;

// The GeoIP answer for this run: `undefined` until asked, then a position or
// null. See api.home.
let geoip;

async function refreshOpen() {
    try {
        const { id } = await UberSdr.receiverState();
        openId = id || null;
    } catch {
        openId = null;
    }
    return openId;
}

const listeners = [];
const notifyChanged = () => { for (const cb of listeners) { try { cb(); } catch { /* a page mid-teardown */ } } };

// The receiver Activity closing is the one change that happens without the
// chooser asking for anything, and the saved list draws a "● connected" marker
// that would otherwise stay on after the receiver had gone.
UberSdr.addListener('receiverClosed', () => {
    openId = null;
    notifyChanged();
});

const hasPassword = async (id) => {
    try {
        const { has } = await UberSdr.secretHas({ id });
        return !!has;
    } catch {
        return false;
    }
};

// A receiver found on the LAN or in the directory may already be saved, in
// which case its key icon should show what is set rather than an empty lock on
// a receiver that has a password.
async function withSaved(rows) {
    return Promise.all(rows.map(async (row) => {
        const saved = await store.find(row.host, row.port, row.tls);
        return saved ? { ...row, hasPassword: await hasPassword(saved.id) } : row;
    }));
}

/**
 * Open a receiver: start its loopback proxy, and point an Activity at it.
 *
 * The bundled UI is the only UI. The desktop client offers a per-receiver
 * choice between its own bundle and the one the instance serves, because on a
 * desktop both are equally reachable and an instance whose server has drifted
 * ahead of the app is a real situation. Here there is one answer: the bundle
 * shipped in the APK, updated when the app is. A picker whose other option is
 * "load 1.5 MB over the air every time you connect" is not a choice worth
 * offering on a phone.
 *
 * The saved password is never fetched here. `openReceiver` is given the
 * instance id and the native side reads the secret itself, so a value the
 * chooser must not hold does not pass through it on the way to the page.
 */
async function connect(desc) {
    const entry = desc.id ? await store.get(desc.id) : await store.ensure(desc);
    if (!entry) throw new Error('unknown instance');

    // A password typed against a receiver that was not saved yet — one from the
    // scan or the directory. It travels with the connect that creates the
    // entry, exactly as it does on the desktop, and goes straight to the
    // keystore rather than onto the entry.
    if (desc.password) await UberSdr.secretSet({ id: entry.id, value: String(desc.password) });

    // Fail here, with a message the chooser can show, rather than opening a
    // receiver onto a 502.
    await discovery.probe(entry);

    const { localPort } = await UberSdr.openReceiver({
        id: entry.id,
        host: entry.host,
        port: entry.port,
        tls: !!entry.tls,
        insecureTLS: !!entry.insecureTLS,
        localPort: entry.localPort,
        label: entry.label,
        product: PRODUCT,
    });
    // The stored port is the receiver's origin, and so where its settings live.
    // It is kept unless something else already had it, in which case what came
    // back is what it is from now on — losing the settings once beats not
    // connecting.
    if (localPort && localPort !== entry.localPort) {
        entry.localPort = localPort;
        await store.persist();
    }
    openId = entry.id;
    await store.recordUse(entry.id);
    notifyChanged();
    return entry.id;
}

export const api = {
    appInfo: async () => ({
        // Always: the bundle is in the APK, and build.sh cannot produce one
        // without it.
        builtinAvailable: true,
        // ...and always the only one, so the chooser draws no picker. See the
        // comment on connect() for why the desktop client's choice does not
        // belong here.
        uiChoice: false,
        buildInfo: BUILD_INFO,
        version: pkg.version,
    }),

    saved: async () => {
        await refreshOpen();
        const rows = await store.listForUI(hasPassword);
        return rows.map((entry) => ({ ...entry, running: entry.id === openId }));
    },

    directory: async () => withSaved(await discovery.fetchDirectory()),
    lan: async () => withSaved(await discovery.discoverLan()),

    resolve: async (input, opts) => {
        try {
            return { ok: true, row: await discovery.resolveTarget(input, opts) };
        } catch (err) {
            return { ok: false, error: err.message, certError: err.certError || null };
        }
    },

    connect: async (desc) => {
        try {
            return { ok: true, id: await connect(desc) };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    },

    update: (id, patch) => store.update(id, patch),

    /**
     * Set or clear a receiver's bypass password.
     *
     * One way only, as on the desktop: the chooser can set one and is told
     * whether one is set, and there is no call that gives one back. A receiver
     * that is not saved yet cannot have one stored against an id it does not
     * have, so `saved: false` sends it back to the page to travel with the
     * connect that creates the entry.
     */
    setPassword: async (target, password) => {
        const found = target && target.id
            ? await store.get(target.id)
            : (target ? await store.find(target.host, target.port, !!target.tls) : null);
        if (!found) return { ok: true, saved: false, hasPassword: !!password };
        if (password) await UberSdr.secretSet({ id: found.id, value: String(password) });
        else await UberSdr.secretClear({ id: found.id });
        notifyChanged();
        return { ok: true, saved: true, hasPassword: !!password };
    },

    disconnect: async (id) => {
        if (openId === id) await UberSdr.closeReceiver();
    },

    remove: async (id) => {
        if (openId === id) await UberSdr.closeReceiver();
        await UberSdr.secretClear({ id });
        await store.remove(id);
    },

    sort: () => store.sort(),
    setSort: (value) => store.setSort(value),
    chooser: () => store.chooser(),
    setChooser: (patch) => store.setChooser(patch),

    sharedPrefs: () => store.sharedPrefs(),
    setSharedPrefs: (on) => store.setSharedPrefs(on),

    /**
     * Where the operator is: what the map centres on and the distance column is
     * measured from. A position typed in always wins; otherwise GeoIP.
     *
     * Looked up once per run and then remembered, including the failure: it is
     * a property of this connection, it does not change under a running app,
     * and a directory refresh every minute should not be a GeoIP request every
     * minute. `undefined` is "not asked yet", `null` is "asked, and it could not
     * say" — which is why geoip is not initialised to null.
     */
    home: async () => {
        const { home: manual } = await store.chooser();
        if (manual) return { ...manual, source: 'manual' };
        if (geoip === undefined) {
            try { geoip = await discovery.fetchGeoIP(); } catch { geoip = null; }
        }
        return geoip;
    },

    onChanged: (cb) => { listeners.push(cb); },
};

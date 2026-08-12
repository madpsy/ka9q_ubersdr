'use strict';

// Saved instances, persisted through Capacitor Preferences.
//
// A port of clients/electron/store.js, and deliberately a close one: the two
// clients stage the same chooser page (see build.sh), so what it may read and
// write has to mean the same thing in both. Line for line the differences are:
//
//   * Preferences rather than a JSON file in userData. One key holding the same
//     document, because the whole thing is read at startup and written on every
//     change anyway — the file was never being used as a database.
//   * Every method is async. Preferences is, and pretending otherwise would
//     mean a synchronous cache that can disagree with what is on disk.
//   * No password, at all. The desktop client keeps the sealed string on the
//     entry; here it never enters JavaScript — Secrets.java holds it against
//     the instance id, and the store only ever learns `hasPassword`. That is
//     stricter than the desktop arrangement rather than a compromise on it.
//
// The local port is still assigned and still stable per instance. Nothing reads
// it yet — the loopback proxy is the next step — but it is the instance's origin
// once there is one, and therefore where the v2 UI keeps that receiver's
// settings in localStorage. Assigning it late would mean assigning it to
// receivers that already existed, resetting exactly what it exists to preserve.

import { Preferences } from '@capacitor/preferences';

const KEY = 'instances';
const FIRST_PORT = 17820;

// Fields the chooser is allowed to change after creation.
const MUTABLE = new Set(['label', 'ui', 'insecureTLS']);

const TABS = new Set(['saved', 'lan', 'dir', 'custom']);
const DIR_SORTS = new Set(['distance', 'listeners', 'snr', 'name']);

/**
 * A home position, or null. Read back out of storage the operator's other apps
 * cannot reach but a restore from backup can, so the coordinates are
 * range-checked rather than trusted: a longitude of 400 does not throw
 * anywhere, it just puts the map somewhere that does not exist.
 */
function sanitiseHome(home) {
    if (!home || typeof home !== 'object') return null;
    const lat = Number(home.lat);
    const lon = Number(home.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon, label: typeof home.label === 'string' ? home.label.slice(0, 80) : '' };
}

function sanitiseChooser(chooser) {
    const raw = chooser && typeof chooser === 'object' ? chooser : {};
    const out = {};
    if (TABS.has(raw.tab)) out.tab = raw.tab;
    if (DIR_SORTS.has(raw.dirSort)) out.dirSort = raw.dirSort;
    const home = sanitiseHome(raw.home);
    if (home) out.home = home;
    return out;
}

const EMPTY = () => ({ nextPort: FIRST_PORT, sort: 'used', chooser: {}, instances: [] });

export class InstanceStore {
    constructor() {
        this.data = EMPTY();
        // Every method awaits this rather than the caller having to remember to
        // open the store first. The chooser calls half a dozen of these in its
        // first tick and none of them can be the one that happens to be first.
        this.ready = this._load();
    }

    async _load() {
        try {
            const { value } = await Preferences.get({ key: KEY });
            const loaded = value ? JSON.parse(value) : null;
            if (loaded && Array.isArray(loaded.instances)) {
                this.data = {
                    nextPort: loaded.nextPort || FIRST_PORT,
                    sort: loaded.sort === 'recent' ? 'recent' : 'used',
                    chooser: sanitiseChooser(loaded.chooser),
                    instances: loaded.instances,
                };
            }
        } catch { /* first run, or a document from a version that cannot be read */ }
    }

    async persist() {
        await Preferences.set({ key: KEY, value: JSON.stringify(this.data) });
    }

    async list() {
        await this.ready;
        return this.data.instances;
    }

    /**
     * The list as the chooser may see it.
     *
     * `hasPassword` is asked of the native side rather than derived from
     * anything here: this half of the client has never seen a password and is
     * not the place that could be wrong about one.
     */
    async listForUI(hasPassword) {
        await this.ready;
        return Promise.all(this.data.instances.map(async (entry) => ({
            ...entry,
            hasPassword: await hasPassword(entry.id),
        })));
    }

    async get(id) {
        await this.ready;
        return this.data.instances.find((inst) => inst.id === id) || null;
    }

    async find(host, port, tls) {
        await this.ready;
        return this.data.instances.find(
            (inst) => inst.host === host && inst.port === port && !!inst.tls === !!tls,
        ) || null;
    }

    /**
     * Returns the entry for a descriptor {host, port, tls, ...}, creating one
     * (with a fresh stable local port) on first contact. Metadata that the
     * probe or directory supplied refreshes the stored copy.
     */
    async ensure(desc) {
        let entry = await this.find(desc.host, desc.port, desc.tls);
        if (!entry) {
            entry = {
                id: crypto.randomUUID(),
                label: desc.name || desc.callsign || `${desc.host}:${desc.port}`,
                host: desc.host,
                port: desc.port,
                tls: !!desc.tls,
                insecureTLS: !!desc.insecureTLS,
                // 'builtin' once there is a bundled UI to serve; api.js falls
                // back to the instance's own UI while there is not.
                ui: 'builtin',
                localPort: this.data.nextPort++,
                lastUsed: null,
            };
            this.data.instances.push(entry);
        }
        if (desc.insecureTLS) entry.insecureTLS = true;
        for (const key of ['callsign', 'location', 'version']) {
            if (desc[key]) entry[key] = desc[key];
        }
        entry.lastUsed = new Date().toISOString();
        await this.persist();
        return entry;
    }

    /**
     * One successful connection. Called once a receiver has actually opened, so
     * a receiver that refused the probe is not counted as used — the list is
     * meant to answer "where do I listen", and an address that never answers is
     * the opposite of that.
     */
    async recordUse(id) {
        const entry = await this.get(id);
        if (!entry) return null;
        entry.useCount = (entry.useCount || 0) + 1;
        entry.lastUsed = new Date().toISOString();
        await this.persist();
        return entry;
    }

    async sort() {
        await this.ready;
        return this.data.sort;
    }

    async setSort(value) {
        await this.ready;
        this.data.sort = value === 'recent' ? 'recent' : 'used';
        await this.persist();
        return this.data.sort;
    }

    /** The chooser's state, as the page may see it. Never null. */
    async chooser() {
        await this.ready;
        return { ...this.data.chooser };
    }

    /**
     * Merge a patch in. Unknown keys are dropped and bad values fall out in
     * sanitiseChooser, so a page that sends nonsense cannot make the next
     * launch open on a tab that does not exist.
     *
     * `home: null` clears the manual position — a real request ("go back to
     * using my IP address"), not a no-op, so it is distinguished from a patch
     * that simply does not mention home.
     */
    async setChooser(patch) {
        await this.ready;
        const next = { ...this.data.chooser, ...(patch && typeof patch === 'object' ? patch : {}) };
        if (patch && 'home' in patch && !patch.home) delete next.home;
        this.data.chooser = sanitiseChooser(next);
        await this.persist();
        return { ...this.data.chooser };
    }

    async update(id, patch) {
        const entry = await this.get(id);
        if (!entry) return null;
        for (const [key, value] of Object.entries(patch || {})) {
            if (MUTABLE.has(key)) entry[key] = value;
        }
        await this.persist();
        return entry;
    }

    async remove(id) {
        await this.ready;
        this.data.instances = this.data.instances.filter((inst) => inst.id !== id);
        await this.persist();
    }
}

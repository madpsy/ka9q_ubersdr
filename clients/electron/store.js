'use strict';

// Saved instances, persisted as JSON in the app's userData directory.
//
// Every instance ever connected to gets an entry, because the entry is what
// pins its local proxy port — and the port is the origin, and the origin is
// where the v2 UI keeps its per-receiver settings in localStorage. Reassigning
// ports between runs would silently reset those.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIRST_PORT = 17820;

// Fields the chooser is allowed to change after creation. The password is not
// among them: it goes through setPassword, so a stray patch cannot drop a
// plaintext secret into the file by a field name alone.
const MUTABLE = new Set(['label', 'ui', 'insecureTLS']);

// --- the chooser's own state ------------------------------------------------
//
// Not about any one receiver, so it does not belong on an entry: which of the
// three tabs was open, how the public directory was last sorted, and where the
// operator has said they are. The last is the one worth persisting most — it is
// typed in by hand, it is what the map centres on and the distance column is
// measured from, and re-entering coordinates every launch is not a feature.

const TABS = new Set(['saved', 'lan', 'dir', 'custom']);
const DIR_SORTS = new Set(['distance', 'listeners', 'snr', 'name']);

/**
 * A home position, or null. Read back out of a file anybody can edit, so the
 * coordinates are range-checked rather than trusted: a longitude of 400 does
 * not throw anywhere, it just puts the map somewhere that does not exist.
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

class InstanceStore {
    /**
     * @param {string} dir        userData directory
     * @param {object} [keychain] Electron's safeStorage, or anything with the
     *                            same three methods. Optional so this module
     *                            stays requirable — and testable — outside
     *                            Electron.
     */
    constructor(dir, keychain) {
        this.keychain = keychain || null;
        this.file = path.join(dir, 'instances.json');
        this.data = { nextPort: FIRST_PORT, sort: 'used', chooser: {}, instances: [] };
        try {
            const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (loaded && Array.isArray(loaded.instances)) {
                this.data = {
                    nextPort: loaded.nextPort || FIRST_PORT,
                    sort: loaded.sort === 'recent' ? 'recent' : 'used',
                    chooser: sanitiseChooser(loaded.chooser),
                    instances: loaded.instances,
                };
            }
        } catch { /* first run */ }
    }

    persist() {
        const tmp = this.file + '.tmp';
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
        fs.renameSync(tmp, this.file);
    }

    list() {
        return this.data.instances;
    }

    /**
     * The list as the chooser may see it: everything except the password.
     *
     * The renderer is told only whether one is set, which is all the key icon
     * needs. A password that never crosses into the page cannot be read out of
     * it, and the chooser has no use for the value it typed in five minutes ago.
     */
    listForUI() {
        return this.data.instances.map(({ password, ...rest }) => ({
            ...rest,
            hasPassword: !!password,
        }));
    }

    // --- the optional per-instance password ---------------------------------
    //
    // v2's bypass password (see static/v2/src/radio/session.js): typed into the
    // start overlay in a browser, where sessionStorage forgets it when the tab
    // closes. A desktop client is a different proposition — it is the operator's
    // own machine and the whole point of the saved list is not typing things
    // twice — so here it is kept, and kept in the OS keychain where there is one.
    //
    // Stored as a tagged string so a file written on a machine with a keychain
    // is still readable on one without: `enc:` cannot be opened without the key
    // and reads as no password rather than as garbage, `plain:` always can.

    _seal(password) {
        if (!password) return null;
        try {
            if (this.keychain && this.keychain.isEncryptionAvailable()) {
                return 'enc:' + this.keychain.encryptString(password).toString('base64');
            }
        } catch { /* a keyring that was there at install time and is not now */ }
        // No keychain — a headless Linux box with no libsecret, most often.
        // Refusing to store it would make the feature simply not work there,
        // which is worse than a file the user must already be able to read: it
        // sits in their own userData directory, beside everything else.
        return 'plain:' + password;
    }

    _open(stored) {
        if (typeof stored !== 'string') return '';
        if (stored.startsWith('plain:')) return stored.slice(6);
        if (stored.startsWith('enc:')) {
            try {
                return this.keychain.decryptString(Buffer.from(stored.slice(4), 'base64'));
            } catch { return ''; }
        }
        return '';
    }

    /** Set it, or clear it with an empty string. */
    setPassword(id, password) {
        const entry = this.get(id);
        if (!entry) return null;
        const sealed = this._seal(String(password == null ? '' : password));
        if (sealed) entry.password = sealed;
        else delete entry.password;
        this.persist();
        return entry;
    }

    passwordFor(id) {
        const entry = this.get(id);
        return entry ? this._open(entry.password) : '';
    }

    get(id) {
        return this.data.instances.find((inst) => inst.id === id) || null;
    }

    find(host, port, tls) {
        return this.data.instances.find(
            (inst) => inst.host === host && inst.port === port && !!inst.tls === !!tls,
        ) || null;
    }

    /**
     * The entry for a public UUID, if one of them is that receiver.
     *
     * Recorded by `ensure` for anything that arrived from the directory, so this
     * answers for a receiver connected to at least once from the directory tab
     * or a followed ubersdr:// link. It is what lets a link open a receiver that
     * is already saved without asking the directory anything.
     */
    findByUuid(uuid) {
        if (!uuid) return null;
        return this.data.instances.find((inst) => inst.uuid === uuid) || null;
    }

    /**
     * Returns the entry for a descriptor {host, port, tls, ...}, creating one
     * (with a fresh stable local port) on first contact. Metadata that the
     * probe or directory supplied refreshes the stored copy.
     */
    ensure(desc) {
        let entry = this.find(desc.host, desc.port, desc.tls);
        if (!entry) {
            entry = {
                id: crypto.randomUUID(),
                label: desc.name || desc.callsign || `${desc.host}:${desc.port}`,
                host: desc.host,
                port: desc.port,
                tls: !!desc.tls,
                insecureTLS: !!desc.insecureTLS,
                ui: 'builtin', // main.js falls back to remote when no bundle is staged
                localPort: this.data.nextPort++,
                lastUsed: null,
            };
            this.data.instances.push(entry);
        }
        if (desc.insecureTLS) entry.insecureTLS = true;
        // A password typed against a receiver that was not saved yet — one from
        // the LAN scan or the directory. It is saved at the moment the entry is.
        if (desc.password) entry.password = this._seal(String(desc.password));
        // `uuid` is the directory's, and is only ever learned from it — a LAN
        // scan and a typed address do not carry one, and must not clear one that
        // an earlier directory connect to the same address recorded.
        for (const key of ['uuid', 'callsign', 'location', 'version']) {
            if (desc[key]) entry[key] = desc[key];
        }
        entry.lastUsed = new Date().toISOString();
        this.persist();
        return entry;
    }

    /**
     * One successful connection. Called once a window has actually opened, so
     * a receiver that refused the probe is not counted as used — the list is
     * meant to answer "where do I listen", and a address that never answers is
     * the opposite of that.
     *
     * Entries saved before counting existed have no `useCount`; they start at
     * zero and the order falls back to recency until they are used again,
     * which is where the list already was. Seeding them to 1 would be a
     * guess, and a wrong one for the receiver somebody has opened daily.
     */
    recordUse(id) {
        const entry = this.get(id);
        if (!entry) return null;
        entry.useCount = (entry.useCount || 0) + 1;
        entry.lastUsed = new Date().toISOString();
        this.persist();
        return entry;
    }

    get sort() {
        return this.data.sort;
    }

    setSort(value) {
        this.data.sort = value === 'recent' ? 'recent' : 'used';
        this.persist();
        return this.data.sort;
    }

    /** The chooser's state, as the page may see it. Never null. */
    get chooser() {
        return { ...this.data.chooser };
    }

    /**
     * Merge a patch in. Unknown keys are dropped and bad values fall out in
     * sanitiseChooser, so a page that sends nonsense cannot make the next
     * launch open on a tab that does not exist.
     *
     * `home: null` clears the manual position — which is a real request ("go
     * back to using my IP address"), not a no-op, so it is distinguished from
     * a patch that simply does not mention home.
     */
    setChooser(patch) {
        const next = { ...this.data.chooser, ...(patch && typeof patch === 'object' ? patch : {}) };
        if (patch && 'home' in patch && !patch.home) delete next.home;
        this.data.chooser = sanitiseChooser(next);
        this.persist();
        return this.chooser;
    }

    update(id, patch) {
        const entry = this.get(id);
        if (!entry) return null;
        for (const [key, value] of Object.entries(patch || {})) {
            if (MUTABLE.has(key)) entry[key] = value;
        }
        this.persist();
        return entry;
    }

    remove(id) {
        this.data.instances = this.data.instances.filter((inst) => inst.id !== id);
        this.persist();
    }
}

module.exports = { InstanceStore };

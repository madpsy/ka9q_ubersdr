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

// Fields the chooser is allowed to change after creation.
const MUTABLE = new Set(['label', 'ui', 'insecureTLS']);

class InstanceStore {
    constructor(dir) {
        this.file = path.join(dir, 'instances.json');
        this.data = { nextPort: FIRST_PORT, instances: [] };
        try {
            const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (loaded && Array.isArray(loaded.instances)) {
                this.data = { nextPort: loaded.nextPort || FIRST_PORT, instances: loaded.instances };
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

    get(id) {
        return this.data.instances.find((inst) => inst.id === id) || null;
    }

    find(host, port, tls) {
        return this.data.instances.find(
            (inst) => inst.host === host && inst.port === port && !!inst.tls === !!tls,
        ) || null;
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
        for (const key of ['callsign', 'location', 'version']) {
            if (desc[key]) entry[key] = desc[key];
        }
        entry.lastUsed = new Date().toISOString();
        this.persist();
        return entry;
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

'use strict';

// The shared-settings snapshot, persisted as JSON in the app's userData
// directory alongside the instance store.
//
// Each instance's local proxy port is its own origin, so the v2 UI keeps a
// separate localStorage per receiver — which is a feature until somebody wants
// every receiver to look the same. When sharing is on, this holds one image of
// the `ubersdr.v2.*` keys: receiver windows are seeded from it before the page
// boots (see receiver-preload.js) and write back into it as settings change.
// The per-origin stores stay where they are — turning sharing off simply stops
// the seeding and the write-back, and every receiver is independent again with
// whatever it had last.

const fs = require('fs');
const path = require('path');

const PREFIX = 'ubersdr.v2.';

class SharedPrefs {
    constructor(dir) {
        this.file = path.join(dir, 'shared-prefs.json');
        this.data = { enabled: false, prefs: null };
        try {
            const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (loaded && typeof loaded === 'object') {
                this.data.enabled = !!loaded.enabled;
                if (loaded.prefs && typeof loaded.prefs === 'object') this.data.prefs = loaded.prefs;
            }
        } catch { /* first run */ }
    }

    persist() {
        const tmp = this.file + '.tmp';
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
        fs.renameSync(tmp, this.file);
    }

    get enabled() {
        return this.data.enabled;
    }

    setEnabled(on) {
        this.data.enabled = !!on;
        this.persist();
    }

    snapshot() {
        return this.data.prefs;
    }

    // Replaces the snapshot with what a window reported. Filtered here as well
    // as in the preload: the sender is a renderer showing remote content, so
    // nothing it says is taken at face value.
    update(map) {
        if (!map || typeof map !== 'object' || Array.isArray(map)) return;
        const clean = {};
        for (const [key, value] of Object.entries(map)) {
            if (typeof key !== 'string' || typeof value !== 'string') continue;
            if (!key.startsWith(PREFIX)) continue;
            clean[key] = value;
        }
        this.data.prefs = clean;
        this.persist();
    }
}

module.exports = { SharedPrefs };

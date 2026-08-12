'use strict';

// The shared-settings snapshot, persisted as JSON in the app's userData
// directory alongside the instance store.
//
// Each instance's local proxy port is its own origin, so the v2 UI keeps a
// separate localStorage per receiver. That isolation is a property of how the
// proxy works rather than something anybody asked for: somebody who has spent
// an evening arranging panels and picking a scheme means it for their client,
// not for one receiver, and finding the next receiver back at the defaults
// reads as the settings having been lost. So this holds one image of the
// `ubersdr.v2.*` keys: receiver windows are seeded from it before the page
// boots (see receiver-preload.js) and write back into it as settings change.
//
// It used to be a checkbox in the chooser, defaulting to on. It is not any
// more: an arrangement of the interface is a property of the client rather than
// of any one receiver, so there was one sensible answer and a control that
// offered the other one. What is deliberately never shared is unchanged and is
// where the real judgement lives — `ubersdr.v2.radio` (frequency, filter,
// squelch, volume) belongs to the receiver, and receiver-preload.js says why.

const fs = require('fs');
const path = require('path');

const PREFIX = 'ubersdr.v2.';
// Mirrors receiver-preload.js, which is where the reasoning is. Repeated here
// because the sender is a renderer showing remote content: what it reports is
// checked rather than trusted.
const SKIP_EXACT = new Set(['ubersdr.v2.radio']);

class SharedPrefs {
    constructor(dir) {
        this.file = path.join(dir, 'shared-prefs.json');
        this.data = { prefs: null };
        try {
            const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (loaded && typeof loaded === 'object') {
                // A file written when this was a toggle may carry `enabled`.
                // It is read past rather than migrated: the snapshot is the
                // only part that was ever worth keeping, and somebody who had
                // switched sharing off simply has one that is out of date,
                // which the first window in replaces.
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
            if (!key.startsWith(PREFIX) || SKIP_EXACT.has(key)) continue;
            clean[key] = value;
        }
        this.data.prefs = clean;
        this.persist();
    }
}

module.exports = { SharedPrefs };

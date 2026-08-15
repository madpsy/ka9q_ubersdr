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

/**
 * The interface settings the receiver windows share, or keep apart.
 *
 * One snapshot for everybody, or one per receiver — the operator's choice, made
 * in the chooser's settings and passed in with each read and write. Shared is
 * the default and what most people want: arranging the panels once and finding
 * them arranged in the next window is the whole reason these are the app's
 * settings rather than each page's. Per receiver is for somebody who uses two
 * very differently and wants each to keep its own shape.
 *
 * The two stores never merge and neither is converted into the other: switching
 * scope shows what that scope last held, which is one sentence to explain and
 * is reversible.
 */
class SharedPrefs {
    constructor(dir) {
        this.file = path.join(dir, 'shared-prefs.json');
        this.data = { prefs: null, byReceiver: {} };
        try {
            const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (loaded && typeof loaded === 'object') {
                // A file written when this was a toggle may carry `enabled`.
                // It is read past rather than migrated: the snapshot is the
                // only part that was ever worth keeping, and somebody who had
                // switched sharing off simply has one that is out of date,
                // which the first window in replaces.
                if (loaded.prefs && typeof loaded.prefs === 'object') this.data.prefs = loaded.prefs;
                if (loaded.byReceiver && typeof loaded.byReceiver === 'object'
                    && !Array.isArray(loaded.byReceiver)) {
                    this.data.byReceiver = loaded.byReceiver;
                }
            }
        } catch { /* first run */ }
    }

    persist() {
        const tmp = this.file + '.tmp';
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
        fs.renameSync(tmp, this.file);
    }

    snapshot(id) {
        if (!id) return this.data.prefs;
        return this.data.byReceiver[id] || null;
    }

    /**
     * Throw away every snapshot, both scopes.
     *
     * Both, deliberately: "reset settings" is pressed by somebody who wants the
     * interface as it came out of the box, and leaving the other scope's copy
     * behind would hand it back the moment they changed the switch — a reset
     * that did not reset, discovered later.
     */
    reset() {
        this.data.prefs = null;
        this.data.byReceiver = {};
        this.persist();
    }

    // Replaces the snapshot with what a window reported. Filtered here as well
    // as in the preload: the sender is a renderer showing remote content, so
    // nothing it says is taken at face value.
    update(map, id) {
        if (!map || typeof map !== 'object' || Array.isArray(map)) return;
        const clean = {};
        for (const [key, value] of Object.entries(map)) {
            if (typeof key !== 'string' || typeof value !== 'string') continue;
            if (!key.startsWith(PREFIX) || SKIP_EXACT.has(key)) continue;
            clean[key] = value;
        }
        if (id) this.data.byReceiver[id] = clean;
        else this.data.prefs = clean;
        this.persist();
    }
}

module.exports = { SharedPrefs };

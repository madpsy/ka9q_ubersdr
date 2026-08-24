// What the Scanner panel scans: which kinds of marker, whether to stay in the
// band the dial is in, and whether to skip quadrature markers.
//
// Its own setting rather than the one lib/markerNavSettings.js keeps, and the
// difference is the point. Stepping is "show me the next thing along", so it
// defaults to everything sparse enough to be worth landing on. Scanning is
// "leave the dial alone and find me someone talking", which is a different
// question with a different answer: voice only, because a scan that stops on a
// bookmark stops on a frequency rather than on a station, and one that stops on
// a CW spot stops on a carrier the squelch cannot hear anyway. Sharing the
// selection would mean changing what prev/next does every time somebody narrowed
// a scan.
//
// Same shape as markerNavSettings all the same — one copy, listeners, and
// localStorage as where it persists rather than how it propagates. The panel can
// be on screen twice (docked and floating), and the second copy has to see a
// change as it is made.

import { NAV_TYPES } from './markerNav.js';

const KEY = 'ubersdr.v2.scanner';

// Voice, and the band you are in.
//
// Both defaults are about the same thing: a scan you start and then listen to
// rather than watch. Voice markers are where a human is talking, which is what
// an audio-gated scan can actually stop on — and confining it to the current
// band keeps a stop somewhere you were already listening, instead of throwing
// the dial from 40m to 10m and back while you are in the middle of a QSO.
//
// Neither is a limit: the pickers offer every kind the stepper does, and the
// band can be switched off for a scan of the whole spectrum.
export const SCAN_DEFAULT_TYPES = ['voice'];
export const SCAN_DEFAULT_BAND_ONLY = true;
// Quadrature markers skipped, because tuning to one is not a hop.
//
// Switching into IQ is confirmed rather than selected, so the tune is swallowed
// and a dialog goes up in the middle of a scan — and answering it would take the
// squelch away, which is the one thing that can stop the scan. On by default for
// that reason: the toggle is there for somebody deliberately walking a list of
// IQ bookmarks, not for the ordinary case. See scanTargets.
export const SCAN_DEFAULT_IGNORE_IQ = true;

const clean = (list) => (Array.isArray(list) ? list.filter((t) => NAV_TYPES.includes(t)) : []);

const listeners = new Set();

let current = null;

/**
 * The stored settings, or the defaults.
 *
 * Nothing selected is a selection and has to survive a reload: it means the scan
 * is turned off, and the panel says so. What cannot be told from it is a browser
 * that has never been told — no key at all — which is where the defaults belong.
 * A stored selection this build recognises none of is a third case: it was a real
 * choice made against a vocabulary that has since changed, and honouring it as
 * "off" would silently disable a scanner nobody switched off. That falls back to
 * the defaults.
 */
export function savedScanSettings() {
    if (current) return current;
    let types = SCAN_DEFAULT_TYPES;
    let bandOnly = SCAN_DEFAULT_BAND_ONLY;
    let ignoreIQ = SCAN_DEFAULT_IGNORE_IQ;
    try {
        const raw = localStorage.getItem(KEY);
        const saved = raw == null ? null : JSON.parse(raw);
        if (saved && typeof saved === 'object') {
            if (Array.isArray(saved.types)) {
                const kept = clean(saved.types);
                types = saved.types.length && !kept.length ? SCAN_DEFAULT_TYPES : kept;
            }
            if (typeof saved.bandOnly === 'boolean') bandOnly = saved.bandOnly;
            if (typeof saved.ignoreIQ === 'boolean') ignoreIQ = saved.ignoreIQ;
        }
    } catch (e) {
        /* private mode, or a hand-edited key */
    }
    current = { types, bandOnly, ignoreIQ };
    return current;
}

/**
 * Writes part of the settings and tells everyone.
 *
 * A patch rather than the whole object: the controls are independent, and a
 * panel that had to read-modify-write all of them would overwrite its
 * neighbours' changes with whatever it had rendered with.
 */
export function saveScanSettings(patch) {
    if (!patch || typeof patch !== 'object') return savedScanSettings();
    const now = savedScanSettings();
    const types = Array.isArray(patch.types) ? clean(patch.types) : now.types;
    // A request made entirely of kinds this build does not have is a caller bug,
    // not a request to scan nothing — storing it would turn a typo into a
    // setting. Deselecting every chip is a different thing and is allowed.
    if (Array.isArray(patch.types) && patch.types.length && !types.length) return now;
    const next = {
        types,
        bandOnly: typeof patch.bandOnly === 'boolean' ? patch.bandOnly : now.bandOnly,
        ignoreIQ: typeof patch.ignoreIQ === 'boolean' ? patch.ignoreIQ : now.ignoreIQ,
    };
    current = next;
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (e) { /* private mode */ }
    // One object to every listener, so two copies of the panel hold one identity
    // and a useMemo keyed on it does not re-run per subscriber.
    for (const fn of [...listeners]) {
        try { fn(next); } catch (e) { /* a broken listener is not the setting's problem */ }
    }
    return next;
}

export function onScanSettings(fn) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

// Test seam: the module-level copy outlives a test's localStorage, which is the
// one thing about caching it that a test can see.
export function _resetScanSettings() {
    current = null;
    listeners.clear();
}

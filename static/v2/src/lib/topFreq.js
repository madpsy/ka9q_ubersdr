// A leaderboard of the frequency and mode combinations you actually use.
//
// Ported from widgets/top_freqmode.widget.html. The scoring is what makes it
// worth having: a combination earns a point for every full minute the dial stays
// on it, so tuning past a frequency never counts and the places you sit rise to
// the top on their own. Nothing to curate, unlike a bookmark list.
//
// Everything here is the store. The clock belongs to the panel, which is the
// only thing that knows whether the receiver is running — a minute with the
// audio stopped is a minute nobody spent listening.

const KEY = 'ubersdr.v2.topfreq';

// Rows shown, and combinations kept. The store is larger than the display so a
// frequency you worked last week is still there to climb back, but bounded so a
// long-running session cannot grow it without limit.
export const TOP_FREQ_ROWS = 5;
export const TOP_FREQ_STORE = 200;

export const comboKey = (hz, mode) => `${Math.round(hz)}|${String(mode || '').toLowerCase()}`;

/**
 * Every stored combination, best first.
 *
 * Ties break on which was used most recently, so two frequencies on the same
 * count do not swap places at random as the list is redrawn.
 */
export function sortedCombos(combos) {
    return Object.values(combos || {}).sort((a, b) => (
        b.count !== a.count ? b.count - a.count : (b.last || 0) - (a.last || 0)
    ));
}

export function loadCombos() {
    try {
        const raw = JSON.parse(localStorage.getItem(KEY));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
        const out = {};
        for (const [key, rec] of Object.entries(raw)) {
            const hz = Number(rec && rec.hz);
            const mode = String((rec && rec.mode) || '').toLowerCase();
            const count = Number(rec && rec.count);
            // A record that cannot be tuned to is worse than no record: it would
            // occupy a row and do nothing when clicked.
            if (!Number.isFinite(hz) || hz <= 0 || !mode || !Number.isFinite(count) || count <= 0) continue;
            if (key !== comboKey(hz, mode)) continue;
            out[key] = { hz, mode, count, last: Number(rec.last) || 0 };
        }
        return out;
    } catch (e) {
        return {};
    }
}

export function saveCombos(combos) {
    try { localStorage.setItem(KEY, JSON.stringify(combos)); } catch (e) { /* ignore */ }
}

/** Drops the weakest once the store is over its limit. */
export function pruneCombos(combos) {
    const keys = Object.keys(combos);
    if (keys.length <= TOP_FREQ_STORE) return combos;
    const keep = {};
    for (const c of sortedCombos(combos).slice(0, TOP_FREQ_STORE)) keep[comboKey(c.hz, c.mode)] = c;
    return keep;
}

/**
 * One more minute on this combination. Returns a new store — the caller decides
 * when to write it.
 */
export function creditMinute(combos, hz, mode, now = Date.now()) {
    const m = String(mode || '').toLowerCase();
    if (!Number.isFinite(hz) || hz <= 0 || !m) return combos;
    const key = comboKey(hz, m);
    const rec = combos[key];
    const next = {
        ...combos,
        [key]: rec
            ? { ...rec, count: rec.count + 1, last: now }
            : { hz: Math.round(hz), mode: m, count: 1, last: now },
    };
    return pruneCombos(next);
}

/** Test seam. */
export function _clearCombos() {
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
}

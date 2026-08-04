// Four VFOs — A, B, C, D.
//
// Each one holds a complete receiver setting: frequency, mode, passband, and
// the spectrum zoom. Switching stores what is live into the VFO you are leaving
// and recalls the one you pick, which is how a real radio's VFO switch behaves —
// you never lose the frequency you were on by stepping off it.
//
// The active slot's stored copy is deliberately not kept up to date: while a
// VFO is selected, the live receiver *is* that VFO, and the stored value is
// written the moment you switch away. That avoids a localStorage write on every
// turn of the dial and there is nothing it can get wrong — nothing reads the
// active slot.

export const VFO_IDS = ['A', 'B', 'C', 'D'];

const STORAGE_KEY = 'ubersdr.v2.vfos';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** What is live now, as a VFO. `view` is RadioContext's spectrum view. */
export function vfoSnapshot(tuning, view) {
    return {
        frequency: num(tuning.frequency),
        mode: tuning.mode,
        bandwidthLow: num(tuning.bandwidthLow),
        bandwidthHigh: num(tuning.bandwidthHigh),
        // Hz per bin — the zoom itself rather than a span, because that is what
        // the server quantises and what the zoom actions work in. null means
        // "no zoom stored", e.g. saved before the spectrum ever connected.
        binBandwidth: view && num(view.binBandwidth) > 0 ? num(view.binBandwidth) : null,
    };
}

/** A stored slot, or null if it is missing or unusable. */
export function cleanSlot(s) {
    if (!s || typeof s !== 'object') return null;
    const frequency = num(s.frequency);
    if (!frequency || frequency <= 0) return null;
    if (!s.mode || typeof s.mode !== 'string') return null;
    const low = num(s.bandwidthLow);
    const high = num(s.bandwidthHigh);
    if (low == null || high == null) return null;
    const bw = num(s.binBandwidth);
    return {
        frequency,
        mode: s.mode,
        bandwidthLow: low,
        bandwidthHigh: high,
        binBandwidth: bw != null && bw > 0 ? bw : null,
    };
}

export function loadVfos() {
    const empty = { active: 'A', slots: Object.fromEntries(VFO_IDS.map((id) => [id, null])) };
    try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (!raw || typeof raw !== 'object') return empty;
        const slots = { ...empty.slots };
        for (const id of VFO_IDS) slots[id] = cleanSlot(raw.slots && raw.slots[id]);
        return {
            active: VFO_IDS.includes(raw.active) ? raw.active : 'A',
            slots,
        };
    } catch (e) {
        return empty;
    }
}

export function saveVfos(state) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* private mode */ }
}

/**
 * Switch to `to`, given what is live.
 *
 * Returns the next state and the setting to apply, if any. An unused VFO is
 * seeded with what is live rather than left empty — it then reads as a copy you
 * can take somewhere else, which is what pressing an empty B on a radio does.
 * There is nothing to apply in that case: the receiver is already there.
 */
export function switchTo(state, to, live) {
    if (!VFO_IDS.includes(to) || to === state.active) return { state, recall: null };
    const target = cleanSlot(state.slots[to]);
    return {
        state: {
            active: to,
            slots: { ...state.slots, [state.active]: live, [to]: target || live },
        },
        recall: target,
    };
}

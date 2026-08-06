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

// --- the shared copy --------------------------------------------------------
//
// Two places write VFOs now: the buttons in the Receiver panel, and the
// spectrum's right-click menu. The panel is unmounted whenever its section is
// collapsed, so its own state cannot be the record — a store written from the
// menu would be overwritten by the next switch made from a stale panel. One
// copy here, and everyone re-reads it when it changes.

let current = null;
const listeners = new Set();

export function getVfos() {
    if (!current) current = loadVfos();
    return current;
}

export function setVfos(next) {
    current = next;
    saveVfos(next);
    for (const fn of listeners) {
        try { fn(next); } catch (e) { console.error('vfo listener threw', e); }
    }
    return next;
}

export function onVfosChanged(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/**
 * Switch to `to`, given what is live.
 *
 * Returns the next state and the setting to apply, if any. An unused VFO is
 * seeded with what is live rather than left empty — it then reads as a copy you
 * can take somewhere else, which is what pressing an empty B on a radio does.
 * There is nothing to apply in that case: the receiver is already there.
 */
/**
 * Copies `live` into `to` without going there.
 *
 * For storing the receiver as it stands into a VFO you are not on — the other
 * half of `switchTo`, which only ever writes the one you are leaving. Storing
 * into the VFO already in use is refused rather than written: that slot is the
 * live receiver by definition, and writing it would imply otherwise.
 */
export function storeInto(state, to, live) {
    if (!VFO_IDS.includes(to) || to === state.active) return state;
    return { ...state, slots: { ...state.slots, [to]: live } };
}

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

// --- switching as an action -------------------------------------------------
//
// Three things switch VFOs now: the buttons in the Receiver panel, the
// spectrum's right-click menu, and a control mapped to one on a hardware
// surface. Switching is more than storing a slot — the recalled zoom has to go
// back through the same actions a manual zoom uses, or it lands off the
// server's binBandwidth ladder — so the whole of it lives here rather than in a
// panel that is unmounted whenever it is collapsed.
//
// `radio` is anything carrying `tuning`, `view` and `actions`: the RadioContext
// value in a panel, and the control-surface facade from controls/panel.jsx.

// Puts the recalled view back: where it was centred and how far it was zoomed,
// in one go.
//
// Both together, deliberately. Setting the frequency and then the span leaves
// the span to close around wherever the spectrum was already pointing — the
// auto-recentre runs on the tune, decides against the span still in force, and
// is finished before the zoom arrives. From a full-span view that meant a
// recalled VFO tuned correctly and then had a narrow window shut around a
// centre 800 kHz away, so the dial marker was off screen with the frequency
// perfectly right.
function applyView(radio, recall) {
    const { view, actions } = radio;
    const bw = recall.binBandwidth;
    if (!bw || !view || !view.binCount) return;
    // At or beyond full span, `reset` is the way back — it also hands the
    // private radiod channel back, and full span contains the dial wherever it
    // is, so there is no centre to restore.
    if (view.defaultBinBandwidth > 0 && bw >= view.defaultBinBandwidth) {
        actions.resetSpectrum();
        return;
    }
    actions.setSpectrumView(recall.frequency, bw * view.binCount);
}

/** Switch to VFO `to`. Returns false if it was already the active one. */
export function selectVfo(radio, to) {
    const before = getVfos();
    const { state, recall } = switchTo(before, to, vfoSnapshot(radio.tuning, radio.view));
    if (state === before) return false;
    setVfos(state);
    if (!recall) return true;   // an unused VFO starts as a copy of this one
    radio.actions.tuneTo({
        frequency: recall.frequency,
        mode: recall.mode,
        bandwidthLow: recall.bandwidthLow,
        bandwidthHigh: recall.bandwidthHigh,
    });
    applyView(radio, recall);
    return true;
}

/** Step `dir` places along A B C D, wrapping. */
export function stepVfo(radio, dir) {
    const i = VFO_IDS.indexOf(getVfos().active);
    const next = VFO_IDS[(i + dir + VFO_IDS.length) % VFO_IDS.length];
    return selectVfo(radio, next);
}

/**
 * The VFOs worth marking on the spectrum: the parked ones.
 *
 * Never the active slot — that is the dial, and the spectrum draws it as the
 * dial. Never one sitting on the frequency you are already on either, whichever
 * slot it is: two marks on one pixel is not two places to go, and the second
 * would sit under the dial line saying nothing the dial does not.
 *
 * `liveHz` is the tuned frequency, which is not necessarily the active slot's
 * stored one — the stored copy is only written when you switch away.
 */
export function markableVfos(state, liveHz) {
    const out = [];
    if (!state || !state.slots) return out;
    const live = Number(liveHz);
    for (const id of VFO_IDS) {
        if (id === state.active) continue;
        const slot = state.slots[id];
        if (!slot || !(slot.frequency > 0)) continue;
        if (Number.isFinite(live) && slot.frequency === live) continue;
        out.push({ id, ...slot });
    }
    return out;
}

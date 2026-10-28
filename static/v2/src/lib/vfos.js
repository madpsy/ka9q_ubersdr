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

import { freqInRange } from './format.js';
import {
    FILTER_WIDTH_MIN, SQUELCH_MAX, SQUELCH_MIN, bandwidthLimits, isIQ,
} from '../radio/constants.js';
import { getVfoLimit } from '../radio/session.js';

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

// --- listening ----------------------------------------------------------------
//
// A VFO can also be *heard* without being the one you are on: the server gives
// a session up to N audio streams under one id (POST /connection says how many
// as `vfos`), and every one past the first is a secondary that plays alongside
// the main receiver. Which VFOs are listening, and how each is heard, lives
// here with the slots rather than in the engine (radio/subReceivers.js),
// because it is a property of the VFO — it survives a reload, and the panel,
// the spectrum menu and a control surface all have to agree about it.
//
//   on      whether this VFO is being listened to. Never true on the active
//           slot: the main receiver is listened to by being the main receiver,
//           and a second stream of the same frequency would be an echo.
//   out     'auto' | 'left' | 'right' | 'both' — where it sits in the stereo
//           field. Auto spreads every listening VFO across it by frequency;
//           see lib/vfoPan.js. Kept on the active slot too, since the main
//           receiver takes part in that spread.
//   vol     0..1, its own fader.
//   muted   its own mute, so one VFO can be silenced without being dropped.
//   bw      its filter, per mode family — see listenEdges.
//   sq      its squelch, a threshold in dB or 'off' — see listenThreshold.
//
// A listening VFO is *live*: its frequency is written back to its slot as it
// is tuned (throttled, see tuneListening), since there is no "switching away"
// moment to store it at. Its own saved mode and filter are deliberately left
// alone, though. A listening VFO always plays in the main receiver's mode — the
// streams then share one sample rate and one audio context with no resampling
// — and writing that borrowed mode into the slot would lose the one it had, so
// that it came back as something else when it stopped listening.
//
// The filter is the exception to the lock, because it costs nothing: the
// width does not change the stream's rate. Each listening VFO has its own, set
// on the spectrum by its passband edges or by its slider in the VFOs panel, and
// independent of main's: moving main's filter moves no other. It starts as a
// copy of main's (seedListen), so turning a VFO on sounds the way the main one
// does. It is remembered per mode family in the listen entry, not in the slot,
// for the same reason the mode is not: the slot's own filter belongs to its own
// mode. A family the VFO has never played in starts from main's again the first
// time main takes it there.
//
// The squelch is its own in the same way, and for a better reason still: VFOs
// on different bands sit on different noise, and a threshold that keeps main
// quiet on 20 m is held open by 80 m's. It also starts as a copy of main's, and
// may be off while main's is on, or the other way round.
//
// The stored flag is not the whole answer. It is kept whatever the server's
// VFO count is — that reads 1 until /connection answers, and a reload must not
// wipe the set — so every question about who is listening *now* takes the
// limit, and at 1 the answer is nobody. And IQ ends listening outright: the
// server will not demodulate a secondary beside an IQ main, so entering IQ
// clears every flag (clearListening, called by radio/subReceivers.js) and the
// VFOs fall back to being ordinary memories, their own mode and filter intact.

export const LISTEN_OUTS = ['auto', 'left', 'right', 'both'];

const DEFAULT_LISTEN = Object.freeze({ on: false, out: 'auto', vol: 1, muted: false });

/** A stored listen entry, defaulted field by field. */
export function cleanListen(l) {
    if (!l || typeof l !== 'object') return { ...DEFAULT_LISTEN };
    const vol = num(l.vol);
    return {
        on: l.on === true,
        out: LISTEN_OUTS.includes(l.out) ? l.out : 'auto',
        vol: vol == null ? 1 : Math.max(0, Math.min(1, vol)),
        muted: l.muted === true,
        ...cleanBw(l.bw),
        ...cleanSq(l.sq),
    };
}

// --- a listening VFO's own squelch -------------------------------------------

// 'off', or a threshold the squelch slider could set; the slider's floor is off.
function sqValue(v) {
    if (v === 'off') return 'off';
    const n = num(v);
    if (n == null) return null;
    if (n <= SQUELCH_MIN) return 'off';
    return Math.min(SQUELCH_MAX, n);
}

function cleanSq(sq) {
    const v = sq == null ? null : sqValue(sq);
    return v == null ? {} : { sq: v };
}

/**
 * The squelch a listening VFO is gated by, with main's at `mainThreshold`
 * (dB, or null when main's is off): `{threshold, own}`, threshold null for
 * off, `own` saying it differs from main's. Main's stands in only until
 * seedListen has run.
 */
export function listenThreshold(listen, mainThreshold) {
    const main = mainThreshold == null ? null : mainThreshold;
    const v = listen ? sqValue(listen.sq) : null;
    if (v == null) return { threshold: main, own: false };
    const threshold = v === 'off' ? null : v;
    return { threshold, own: threshold !== main };
}

/**
 * The listen entry with its squelch set to `value` (dB, or 'off' — the
 * slider's floor reads as off too), or with null set to a copy of main's,
 * `mainThreshold`, as it stands now.
 */
export function withListenSquelch(listen, mainThreshold, value) {
    const v = value == null ? sqValue(mainThreshold == null ? 'off' : mainThreshold) : sqValue(value);
    const next = { ...listen };
    delete next.sq;
    return v == null ? next : { ...next, sq: v };
}

/**
 * `state` with listening VFO `id` given a copy of main's filter and squelch
 * wherever it has none of its own for main's mode yet — which is how a VFO
 * starts out, and how it first meets a new mode family. The same state back
 * when there is nothing to fill in. Run by the engine (radio/subReceivers.js)
 * for every listening VFO, so it covers however the VFO came to be listening.
 */
export function seedListen(state, id, tuning, mainThreshold) {
    const fam = filterFamily(tuning && tuning.mode);
    const was = listenOf(state, id);
    let next = was;
    if (fam && !(was.bw && was.bw[fam])) next = withListenFilter(next, tuning, null);
    if (!('sq' in was)) next = withListenSquelch(next, mainThreshold, null);
    if (next === was) return state;
    return { ...state, listen: { ...(state.listen || {}), [id]: cleanListen(next) } };
}

// --- a listening VFO's own filter --------------------------------------------
//
// Stored per mode family, so a VFO given 1.8 kHz on SSB keeps it while the main
// receiver goes to AM and back, and follows the main filter in AM meanwhile — a
// width set for speech on one sideband is no answer for a broadcast station.
// Upper and lower sideband are one family, kept in upper-sideband terms and
// mirrored for LSB, so flipping sideband keeps the width and the shift.

/** The family a mode's own filter is kept under, or null for none (IQ). */
export function filterFamily(mode) {
    switch (mode) {
        case 'usb': case 'lsb': return 'ssb';
        case 'cwu': case 'cwl': return 'cw';
        case 'am': case 'sam': return 'am';
        case 'fm': return 'fm';
        case 'nfm': return 'nfm';
        default: return null;
    }
}

const BW_FAMILIES = ['ssb', 'cw', 'am', 'fm', 'nfm'];
const BW_REACH = 12000;

// Only well-formed entries survive a reload; none at all is no `bw` field.
function cleanBw(bw) {
    if (!bw || typeof bw !== 'object') return {};
    const out = {};
    for (const fam of BW_FAMILIES) {
        const e = bw[fam];
        if (!Array.isArray(e) || e.length !== 2) continue;
        const lo = num(e[0]);
        const hi = num(e[1]);
        if (lo == null || hi == null || !(hi > lo) || Math.abs(lo) > BW_REACH || Math.abs(hi) > BW_REACH) continue;
        out[fam] = [Math.round(lo), Math.round(hi)];
    }
    return Object.keys(out).length ? { bw: out } : {};
}

// Stored edges <-> the edges in `mode`: LSB is the stored USB pair mirrored.
const flipFor = (mode, [lo, hi]) => (mode === 'lsb' ? [-hi, -lo] : [lo, hi]);

/**
 * The filter a listening VFO plays with, with the main receiver in `tuning`:
 * `{low, high, own}`, `own` saying it differs from main's. Clamped into the
 * mode's limits. Main's stands in only until seedListen has run, or where the
 * stored one clamps narrower than any control would set.
 */
export function listenEdges(listen, tuning) {
    const main = {
        low: Number(tuning && tuning.bandwidthLow) || 0,
        high: Number(tuning && tuning.bandwidthHigh) || 0,
        own: false,
    };
    const mode = tuning && tuning.mode;
    const fam = filterFamily(mode);
    const stored = fam && listen && listen.bw ? listen.bw[fam] : null;
    if (!stored) return main;
    const l = bandwidthLimits(mode);
    const [a, b] = flipFor(mode, stored);
    const low = Math.max(l.min, Math.min(l.max, a));
    const high = Math.max(l.min, Math.min(l.max, b));
    if (high - low < FILTER_WIDTH_MIN) return main;
    return { low, high, own: low !== main.low || high !== main.high };
}

/**
 * The listen entry with its filter in `tuning`'s mode set to `[low, high]`, or
 * with null set to a copy of main's as it stands now.
 */
export function withListenFilter(listen, tuning, edges) {
    const fam = filterFamily(tuning && tuning.mode);
    if (!fam) return listen;
    const bw = { ...((listen && listen.bw) || {}) };
    const e = edges || [Number(tuning.bandwidthLow) || 0, Number(tuning.bandwidthHigh) || 0];
    bw[fam] = flipFor(tuning.mode, [Math.round(e[0]), Math.round(e[1])]);
    const next = { ...listen };
    delete next.bw;
    return Object.keys(bw).length ? { ...next, bw } : next;
}

/** The listen entry for `id`, whatever shape the state is in. */
export function listenOf(state, id) {
    return cleanListen(state && state.listen && state.listen[id]);
}

/**
 * Whether `id` is a listening VFO — on, not the active slot, and holding
 * something — at the server's VFO count `limit`. At 1 nothing is, whatever the
 * store remembers; see the note above.
 */
export function isListening(state, id, limit = getVfoLimit()) {
    if (!state || id === state.active || !(limit > 1)) return false;
    return listenOf(state, id).on && !!cleanSlot(state.slots && state.slots[id]);
}

/** The listening VFOs in A–D order, each with its slot and listen entry. */
export function listeningVfos(state, limit = getVfoLimit()) {
    const out = [];
    if (!state) return out;
    for (const id of VFO_IDS) {
        if (!isListening(state, id, limit)) continue;
        out.push({ id, slot: cleanSlot(state.slots[id]), listen: listenOf(state, id) });
    }
    return out;
}

/** Why no VFO may listen with the main receiver in `mode`, or null when one may. */
export const LISTEN_IQ_REASON = 'Not available while main is in IQ';

export function listenBlockedReason(mode) {
    return isIQ(mode) ? LISTEN_IQ_REASON : null;
}

/** Every listening flag off; the slots and how each was heard are kept. */
export function clearListening(state) {
    if (!state || !VFO_IDS.some((id) => listenOf(state, id).on)) return state;
    const listen = {};
    for (const id of VFO_IDS) listen[id] = { ...listenOf(state, id), on: false };
    return { ...state, listen };
}

/**
 * Turn listening on `id` on or off.
 *
 * `limit` is the server's VFO count, main included, so at most `limit - 1`
 * VFOs listen alongside it; a request past that is refused (the state comes
 * back unchanged) rather than quietly bumping another one off. An unused slot
 * is seeded with `live` first, exactly as switching to it would — listening to
 * an empty VFO starts it where the receiver is, to be tuned away from.
 *
 * `mainMode` is the main receiver's mode, which `live` carries when it is
 * given; in IQ starting to listen is refused (listenBlockedReason).
 */
export function setListen(state, id, on, { limit = 1, live = null, mainMode = live && live.mode } = {}) {
    if (!VFO_IDS.includes(id) || id === state.active) return state;
    const was = listenOf(state, id);
    if (was.on === !!on) return state;
    let slots = state.slots;
    if (on) {
        if (listenBlockedReason(mainMode)) return state;
        const others = listeningVfos(state, limit).filter((v) => v.id !== id).length;
        if (others >= Math.max(0, limit - 1)) return state;
        if (!cleanSlot(slots[id])) {
            if (!live || !cleanSlot(live)) return state;
            slots = { ...slots, [id]: cleanSlot(live) };
        }
    }
    return {
        ...state,
        slots,
        listen: { ...(state.listen || {}), [id]: { ...was, on: !!on } },
    };
}

/** Change how `id` is heard: any of `out`, `vol`, `muted`. */
export function patchListen(state, id, patch) {
    if (!VFO_IDS.includes(id) || !patch) return state;
    const next = cleanListen({ ...listenOf(state, id), ...patch, on: listenOf(state, id).on });
    return { ...state, listen: { ...(state.listen || {}), [id]: next } };
}

/** A listening VFO's new frequency, written into its slot and nothing else. */
export function retuneListening(state, id, hz) {
    const slot = cleanSlot(state.slots && state.slots[id]);
    const f = num(hz);
    if (!slot || !f || f <= 0 || slot.frequency === f) return state;
    return { ...state, slots: { ...state.slots, [id]: { ...slot, frequency: f } } };
}

export function loadVfos() {
    const empty = {
        active: 'A',
        slots: Object.fromEntries(VFO_IDS.map((id) => [id, null])),
        listen: Object.fromEntries(VFO_IDS.map((id) => [id, { ...DEFAULT_LISTEN }])),
    };
    try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (!raw || typeof raw !== 'object') return empty;
        const slots = { ...empty.slots };
        for (const id of VFO_IDS) slots[id] = cleanSlot(raw.slots && raw.slots[id]);
        const active = VFO_IDS.includes(raw.active) ? raw.active : 'A';
        // Saved before listening existed, `listen` is simply absent and every
        // VFO comes back parked. The active one is never listening, whatever
        // was stored — see the note on `on` above.
        const listen = {};
        for (const id of VFO_IDS) {
            const l = cleanListen(raw.listen && raw.listen[id]);
            if (id === active || !slots[id]) l.on = false;
            listen[id] = l;
        }
        return { active, slots, listen };
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

// A listening VFO's frequency is written on every step of a drag, and a
// localStorage write per step is what the active slot's deliberately stale
// copy exists to avoid. So that one write is deferred and coalesced: the
// listeners hear it at once, the disk a moment later. Any ordinary write in
// between saves everything, the deferred change included.
const LAZY_SAVE_MS = 1000;
let saveTimer = null;

export function setVfos(next, { lazy = false } = {}) {
    current = next;
    if (lazy) {
        if (!saveTimer) {
            saveTimer = setTimeout(() => {
                saveTimer = null;
                saveVfos(current);
            }, LAZY_SAVE_MS);
        }
    } else {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        saveVfos(next);
    }
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
            ...state,
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

/**
 * Switch to VFO `to`. Returns false if it was already the active one.
 *
 * `limit` is the server's VFO count (session.js). The listening flags are kept
 * in the store whatever it is — it reads 1 until /connection answers, and a
 * reload must not wipe them — so at 1 a slot can still be marked listening
 * with nothing playing it. Swapping with that would be a switch that looks
 * wrong for no visible reason; it is an ordinary recall instead.
 */
export function selectVfo(radio, to, { limit = getVfoLimit() } = {}) {
    const before = getVfos();
    // Nor in IQ, where a swap would make the old main a listener nothing can
    // play; the flags are cleared there anyway, but not before the next render.
    if (isListening(before, to, limit) && !listenBlockedReason(radio.tuning && radio.tuning.mode)) {
        return swapVfo(radio, to);
    }
    const { state, recall } = switchTo(before, to, vfoSnapshot(radio.tuning, radio.view));
    if (state === before) return false;
    // An unused VFO has nothing to recall and is always switchable — it simply becomes a
    // copy of where the receiver already is. The range test below must come after this,
    // not before: applied to a null recall it refused every first switch to a fresh slot.
    if (!recall) {
        setVfos(state);
        return true;
    }

    // A VFO whose stored frequency is outside the receiver's range is left alone
    // entirely — the switch is refused rather than made.
    //
    // VFOs are persisted per browser, so one parked on 6 m while the front end ran at
    // 129.6 Msps is still there after a drop back to 64.8. Switching to it and letting
    // tuneTo clamp would not just land on the wrong frequency: switchTo writes the live
    // tuning into the slot being left, so the next switch away would save the clamped
    // 30 MHz over the stored 50 MHz and the VFO would be gone for good. Refusing keeps
    // it intact, and usable again if the operator goes back.
    if (!freqInRange(recall.frequency)) return false;

    setVfos(state);
    radio.actions.tuneTo({
        frequency: recall.frequency,
        mode: recall.mode,
        bandwidthLow: recall.bandwidthLow,
        bandwidthHigh: recall.bandwidthHigh,
    });
    applyView(radio, recall);
    return true;
}

// Selecting a VFO that is already being listened to swaps the two roles rather
// than switching: the one you were on starts listening where it is, and the one
// you picked becomes the main receiver at its own frequency.
//
// The mode is kept, not recalled. The listening VFO was being heard in the main
// receiver's mode all along (see the note on listening above), so recalling its
// own saved mode at the moment it is promoted would change what the operator
// was just hearing on it — the swap is "bring that one to the front", and it
// should sound the same when it gets there. Its saved mode is spent by this:
// the active slot's copy is rewritten from live the next time it is left, which
// is the ordinary rule for the VFO you are on.
//
// The listen entries swap with the roles, so a VFO pinned to the left ear is
// still heard on the left when it comes back from being the main receiver. The
// zoom is left where it is — the auto-recentre follows the dial.
//
// The filters go with the stations, for the same reason the mode stays: one
// heard through its own 1.8 kHz comes to the front still 1.8 kHz wide, and the
// one it displaced carries on in the filter it had as main. The squelch too,
// where `radio` carries it: the main receiver's becomes the promoted VFO's,
// and the displaced one keeps the threshold it had.
function swapVfo(radio, to) {
    const before = getVfos();
    const target = cleanSlot(before.slots[to]);
    if (!target || !freqInRange(target.frequency)) return false;
    const from = before.active;
    const live = vfoSnapshot(radio.tuning, radio.view);
    const lFrom = listenOf(before, from);
    const lTo = listenOf(before, to);
    const t = radio.tuning || {};
    const heard = listenEdges(lTo, t);
    const promoted = { ...t, bandwidthLow: heard.low, bandwidthHigh: heard.high };
    let entryFrom = withListenFilter({ ...lTo, on: true }, promoted, [t.bandwidthLow, t.bandwidthHigh]);
    // The new main's entry keeps nothing for this mode: if it is heard again
    // later, it starts from main's as it then is.
    let entryTo = dropFor({ ...lFrom, on: false }, t.mode);
    const sq = radio.squelch && radio.actions.setSquelch ? radio.squelch : null;
    let squelchTo;
    if (sq) {
        const was = sq.enabled ? sq.threshold : null;
        const gate = listenThreshold(lTo, was);
        entryFrom = withListenSquelch(entryFrom, gate.threshold, was == null ? 'off' : was);
        delete entryTo.sq;
        if (gate.own) squelchTo = gate.threshold == null ? SQUELCH_MIN : gate.threshold;
    }
    setVfos({
        ...before,
        active: to,
        slots: { ...before.slots, [from]: live },
        listen: { ...(before.listen || {}), [from]: entryFrom, [to]: entryTo },
    });
    radio.actions.tuneTo(heard.own
        ? { frequency: target.frequency, bandwidthLow: heard.low, bandwidthHigh: heard.high }
        : { frequency: target.frequency });
    if (squelchTo != null) radio.actions.setSquelch(squelchTo);
    return true;
}

/**
 * Start or stop listening to `id` alongside the main receiver.
 *
 * `limit` is the server's VFO count (session.js getVfoLimit). Returns whether
 * anything changed: false for the active VFO, for a request past the limit,
 * for one while the main receiver is in IQ, and for one already in the state
 * asked for.
 */
export function listenVfo(radio, id, on, limit = getVfoLimit()) {
    const before = getVfos();
    const live = radio ? vfoSnapshot(radio.tuning, radio.view) : null;
    const state = setListen(before, id, on, { limit, live });
    if (state === before) return false;
    setVfos(state);
    return true;
}

/** `out`, `vol` and/or `muted` for a VFO's listening. */
export function setVfoListen(id, patch) {
    const before = getVfos();
    const state = patchListen(before, id, patch);
    setVfos(state);
    return state !== before;
}

// An entry without its filter for `mode`'s family.
function dropFor(listen, mode) {
    const fam = filterFamily(mode);
    if (!fam || !listen.bw || !listen.bw[fam]) return listen;
    const bw = { ...listen.bw };
    delete bw[fam];
    const next = { ...listen };
    delete next.bw;
    return Object.keys(bw).length ? { ...next, bw } : next;
}

/**
 * Set listening VFO `id`'s filter in the main receiver's mode, or with null
 * copy main's as it stands (see listenEdges). Lazy on disk like a retune:
 * a slider or an edge drag is a stream of them.
 */
export function setVfoFilter(id, tuning, edges) {
    const before = getVfos();
    if (!VFO_IDS.includes(id) || id === before.active || !filterFamily(tuning && tuning.mode)) return false;
    const was = listenOf(before, id);
    const next = cleanListen(withListenFilter(was, tuning, edges));
    if (JSON.stringify(next.bw || null) === JSON.stringify(was.bw || null)) return false;
    setVfos({ ...before, listen: { ...(before.listen || {}), [id]: next } }, { lazy: true });
    return true;
}

/**
 * Set listening VFO `id`'s squelch — dB, or 'off' — or with null copy main's,
 * which is at `mainThreshold` (null for off). Lazy on disk: the
 * slider is a stream of these.
 */
export function setVfoSquelch(id, mainThreshold, value) {
    const before = getVfos();
    if (!VFO_IDS.includes(id) || id === before.active) return false;
    const was = listenOf(before, id);
    const next = cleanListen(withListenSquelch(was, mainThreshold, value));
    if (next.sq === was.sq) return false;
    setVfos({ ...before, listen: { ...(before.listen || {}), [id]: next } }, { lazy: true });
    return true;
}

/**
 * Retune a listening VFO. Written to its slot straight away for everybody
 * watching the store, and to disk lazily — see setVfos.
 */
export function tuneListening(id, hz, limit = getVfoLimit()) {
    const before = getVfos();
    if (!isListening(before, id, limit)) return false;
    const state = retuneListening(before, id, hz);
    if (state === before) return false;
    setVfos(state, { lazy: true });
    return true;
}

/**
 * Put the receiver as it stands into another VFO, and stay where you are.
 *
 * The counterpart to selectVfo: that one *goes* somewhere, this one *sends* the
 * current settings somewhere. Both live here rather than in a panel because a
 * VFO must be written exactly one way — the panel, the spectrum's right-click
 * menu and a MIDI mapping all reach the same slots, and two of them disagreeing
 * about what "B" holds is the bug this module exists to prevent.
 *
 * Copying onto the active VFO is refused by storeInto: that slot *is* the live
 * receiver, and writing it would imply otherwise.
 */
export function copyVfo(radio, to) {
    const before = getVfos();
    const state = storeInto(before, to, vfoSnapshot(radio.tuning, radio.view));
    if (state === before) return false;
    setVfos(state);
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

// --- scanning ---------------------------------------------------------------
//
// A scan is a switch repeated on a timer, so it is the same selectVfo every
// other caller uses — nothing here tunes on its own. What does belong here is
// *which* VFOs a scan may visit, because getting that wrong writes to the
// store: switching to an unused slot seeds it with a copy of what is live, so a
// scan that stepped through all four would fill the empty ones with the
// frequency it happened to be sitting on and there would be nothing left to
// scan. Only slots that already hold something are visited.

/**
 * The VFOs a scan can step through, in A–D order.
 *
 * Listening VFOs are skipped: they are already being heard. At a `limit` of 1
 * none is, so a stale flag does not hide a VFO from the scan.
 *
 * The active slot counts whenever the receiver is tuned somewhere real: its
 * stored copy is deliberately stale — written only when you switch away — so it
 * is judged on live tuning rather than on what the store says about it.
 */
export function scannableVfos(state, tuning, limit = getVfoLimit()) {
    const out = [];
    if (!state) return out;
    for (const id of VFO_IDS) {
        if (state.active === id) {
            if (tuning && num(tuning.frequency) > 0) out.push(id);
        } else if (isListening(state, id, limit)) {
            // Already being heard. A scan that landed on it would swap it with
            // the main receiver (see swapVfo), dragging the listening set round
            // the slots on every step — and there is nothing to find there that
            // the operator is not already hearing.
            continue;
        } else if (cleanSlot(state.slots && state.slots[id])) {
            out.push(id);
        }
    }
    return out;
}

/**
 * Where a scan goes after `from`, wrapping.
 *
 * null when there is nowhere to go: fewer than two VFOs hold anything, and a
 * scan of one channel is just sitting on it.
 */
export function nextScanVfo(ids, from) {
    if (!ids || ids.length < 2) return null;
    const i = ids.indexOf(from);
    return i < 0 ? ids[0] : ids[(i + 1) % ids.length];
}

// Mapping storage and dispatch for the control panels.
//
// A mapping is keyed by whatever the source calls its control — a FlexControl
// key like `dial_up`, a MIDI address like `176:0:14` — and holds the function
// to run plus an optional rate limit:
//
//   { function: 'freq_enc_1k', throttleMs: 100, mode: 'rate_limit' }
//
// That record is byte-for-byte v1's, and the export envelope is v1's too, so a
// mapping file moves between the two frontends in either direction. Mappings
// saved by the v1 extensions are adopted on first run for the same reason —
// someone who spent an evening learning twenty buttons should not have to do it
// again to try v2.

import { runFunction } from './functions.js';

const STORE_KEY = 'ubersdr.v2.radioControl';

// v1's keys, read once when this panel has nothing of its own yet.
const V1_KEYS = {
    flexcontrol: { mappings: 'ubersdr_flexcontrol_mappings', step: 'ubersdr_flexcontrol_step_hz' },
    midi: { mappings: 'ubersdr_midi_mappings', step: 'ubersdr_midi_step_hz', device: 'ubersdr_midi_device' },
};

// The mapped surfaces, which are mutually exclusive. Radio Sync is not among
// them: it is a panel of its own now, and may run alongside either of these.
export const SURFACES = ['off', 'flexcontrol', 'midi'];

export const DEFAULT_STATE = {
    surface: 'off',
    stepHz: 1000,
    flexcontrol: { mappings: {} },
    midi: { mappings: {}, device: '' },
    radiosync: { rig: '', baud: 0, direction: 'sdr-to-radio', muteOnTx: true },
};

function readJSON(key) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

// Pulls v1's mappings across the first time this panel runs. Only ever fills
// gaps: once v2 has a mapping of its own for a source, v1 is left alone and the
// two drift independently, which is what you want if someone is running both.
function adoptV1(state) {
    for (const [source, keys] of Object.entries(V1_KEYS)) {
        if (Object.keys(state[source].mappings).length) continue;
        const m = readJSON(keys.mappings);
        if (m && typeof m === 'object') state[source].mappings = m;
    }
    if (state.stepHz === DEFAULT_STATE.stepHz) {
        const step = Number(localStorage.getItem(V1_KEYS.flexcontrol.step) || localStorage.getItem(V1_KEYS.midi.step));
        if (Number.isFinite(step) && step > 0) state.stepHz = step;
    }
    if (!state.midi.device) {
        state.midi.device = localStorage.getItem(V1_KEYS.midi.device) || '';
    }
    return state;
}

export function loadState() {
    const saved = readJSON(STORE_KEY);
    const state = {
        ...DEFAULT_STATE,
        ...(saved || {}),
        flexcontrol: { ...DEFAULT_STATE.flexcontrol, ...((saved && saved.flexcontrol) || {}) },
        midi: { ...DEFAULT_STATE.midi, ...((saved && saved.midi) || {}) },
        radiosync: { ...DEFAULT_STATE.radiosync, ...((saved && saved.radiosync) || {}) },
    };
    // Until the split there was one `source` covering all three, Radio Sync
    // included. A saved 'radiosync' therefore names no surface at all: the sync
    // panel now stands on its own and needs no flag, so it simply drops.
    if (saved && saved.surface === undefined && typeof saved.source === 'string') {
        state.surface = saved.source === 'radiosync' ? 'off' : saved.source;
    }
    delete state.source;
    if (!SURFACES.includes(state.surface)) state.surface = 'off';
    return saved ? state : adoptV1(state);
}

export function saveState(state) {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
        /* private browsing, quota — the panel still works for this session */
    }
}

// --- the shared store -------------------------------------------------------
//
// One saved blob, two panels: SDR Control owns `surface`, `stepHz` and the
// mapping tables, Radio Control owns `radiosync`. If each held its own copy in
// component state, whichever saved last would write back a stale version of the
// other's half — picking a rig would silently undo a mapping learned a moment
// earlier. So the state lives here and both panels subscribe.

let current = null;
const listeners = new Set();

export function controlState() {
    if (!current) current = loadState();
    return current;
}

export function onControlState(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

// Takes a patch or a reducer, same shape as a React setState.
export function updateControlState(patch) {
    const prev = controlState();
    current = typeof patch === 'function' ? patch(prev) : { ...prev, ...patch };
    saveState(current);
    for (const fn of Array.from(listeners)) fn(current);
    return current;
}

// Encoders repeat as fast as the hardware can send, so they get a rate limit by
// default and everything else does not. v1 picks the same 100 ms.
export function defaultThrottle(functionId) {
    return functionId.startsWith('freq_enc') || functionId === 'zoom_dial'
        ? { throttleMs: 100, mode: 'rate_limit' }
        : { throttleMs: 0, mode: 'none' };
}

// Runs mapped functions and enforces their rate limits. One per source; the
// source hands it a normalised event and it decides whether anything happens.
export class Dispatcher {
    constructor() {
        this.mappings = {};
        this.last = {};
        this.onResult = null;   // (key, functionId, ok) — for the message log
    }

    setMappings(mappings) {
        this.mappings = mappings || {};
    }

    // `ctx` is the radio facade from RadioControlPanel. Returns the mapping that
    // fired, or null.
    handle(key, ev, ctx) {
        const mapping = this.mappings[key];
        if (!mapping) return null;

        if (mapping.mode === 'rate_limit' && mapping.throttleMs > 0) {
            const now = Date.now();
            if (now - (this.last[key] || 0) < mapping.throttleMs) return null;
            this.last[key] = now;
        }

        let ok = false;
        try {
            ok = runFunction(mapping.function, ev, ctx);
        } catch (err) {
            ok = false;
        }
        if (this.onResult) this.onResult(key, mapping.function, ok);
        return mapping;
    }
}

// --- import / export --------------------------------------------------------
//
// v1's envelope, unchanged: { version, source, exported, mappings }.

export function exportMappings(source, mappings) {
    const payload = {
        version: 1,
        source: source === 'flexcontrol' ? 'flexcontrol' : 'midi-control',
        exported: new Date().toISOString(),
        mappings,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${source}-mappings-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return Object.keys(mappings).length;
}

// Resolves to the mappings object, or rejects with a message fit to show. The
// file's `source` is not enforced: the two surfaces share a function catalogue,
// and the keys simply will not match if the file came from the other one — a
// harmless no-op that is easier to see than a modal asking to confirm.
export function importMappings(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Could not read the file'));
        reader.onload = (e) => {
            let data;
            try {
                data = JSON.parse(e.target.result);
            } catch (err) {
                reject(new Error('Not a valid JSON file'));
                return;
            }
            if (!data || typeof data.mappings !== 'object' || data.mappings === null) {
                reject(new Error('No “mappings” object in that file'));
                return;
            }
            resolve(data.mappings);
        };
        reader.readAsText(file);
    });
}

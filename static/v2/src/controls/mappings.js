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

import { isEncoderFunction, runFunction } from './functions.js';
import { isCCKey } from './webmidi.js';

const STORE_KEY = 'ubersdr.v2.radioControl';

// v1's keys, read once when this panel has nothing of its own yet.
const V1_KEYS = {
    flexcontrol: { mappings: 'ubersdr_flexcontrol_mappings', step: 'ubersdr_flexcontrol_step_hz' },
    midi: { mappings: 'ubersdr_midi_mappings', step: 'ubersdr_midi_step_hz', device: 'ubersdr_midi_device' },
};

// The surfaces this page can open by itself, which are mutually exclusive: two
// things mapped to frequency would fight each other. Radio Sync is not among
// them — it is a panel of its own now, and may run alongside either.
//
// Not the whole list any more. A surface may also be registered from outside
// (controls/surfaces.js), and its id goes in the same setting, so anything
// validating this must ask the registry rather than only this array.
export const SURFACES = ['off', 'flexcontrol', 'midi'];

/**
 * Whether a chosen surface is one this page opens itself, and so has mappings,
 * a learn mode and a piece of hardware behind it.
 *
 * Here rather than spelled out at the call site, because "not off" is the
 * obvious test and the wrong one: an externally provided surface is also not
 * off, and it has no `state[id]` at all — reading `state[id].mappings` for one
 * is not a degraded panel but a crash on mount, which is exactly what picking
 * TCI did the first time. Anything about to touch a surface's own settings
 * should ask this first.
 */
export function isMappedSurface(id) {
    return id === 'flexcontrol' || id === 'midi';
}

export const DEFAULT_STATE = {
    surface: 'off',
    stepHz: 1000,
    // Per-surface field values for the ones registered from outside, keyed by
    // id, so switching away and back does not lose what was typed.
    surfaces: {},
    // `autoConnect` is off until asked for. Hardware that binds itself on page
    // load is how a knob left against the desk starts retuning a receiver
    // nobody is watching, so the operator turns it on per surface.
    flexcontrol: { mappings: {}, autoConnect: false },
    midi: { mappings: {}, device: '', autoConnect: false },
    radiosync: {
        rig: '', baud: 0, direction: 'sdr-to-radio', muteOnTx: true,
        syncFrequency: true, syncMode: true,
        // Which transport the panel is using. 'serial' is the one the page can
        // host itself (Web Serial + Hamlib); anything else is the id of a
        // provider registered from outside — see controls/radioProviders.js.
        transport: 'serial',
        // Whether the operator has asked to be connected. Only meaningful for a
        // provider: the serial link is opened by a button press, because
        // requestPort() needs a user gesture and cannot be resumed on load.
        connect: false,
        // Per-provider field values, keyed by provider id, so switching
        // transports and back does not lose what was typed.
        providers: {},
        // Whether to connect on its own when the page opens. Off by default: a
        // receiver that reaches for a rig nobody asked it to touch is a
        // surprise, and the serial transport cannot do it at all — opening a
        // port needs a user gesture the browser will not accept on load.
        autoConnect: false,
    },
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

// Fills in the encoder flag for CCs that could only ever be encoders.
//
// v1 has no such flag: its `freq_enc_*` cases treat every value as a detent, so
// a mapping written by v1 — or by v2 before this — says nothing about the
// control being endless. Read as a fader those messages arrive as positions,
// the function refuses them, and the wheel does nothing at all. An explicit
// `false` is the operator having pressed the switch and is left alone; only an
// absent flag is filled in.
export function normaliseMidiMappings(mappings) {
    let changed = false;
    const out = {};
    for (const [key, m] of Object.entries(mappings || {})) {
        if (m && m.relative === undefined && isCCKey(key) && isEncoderFunction(m.function)) {
            out[key] = { ...m, relative: true };
            changed = true;
        } else {
            out[key] = m;
        }
    }
    return changed ? out : mappings;
}

export function loadState() {
    const saved = readJSON(STORE_KEY);
    const state = {
        ...DEFAULT_STATE,
        ...(saved || {}),
        flexcontrol: { ...DEFAULT_STATE.flexcontrol, ...((saved && saved.flexcontrol) || {}) },
        midi: { ...DEFAULT_STATE.midi, ...((saved && saved.midi) || {}) },
        radiosync: { ...DEFAULT_STATE.radiosync, ...((saved && saved.radiosync) || {}) },
        surfaces: { ...((saved && saved.surfaces) || {}) },
    };
    // The connect intent is not a preference; it is what is being asked for
    // right now, and on a fresh page that is exactly the auto-connect setting.
    // Persisting it as it was would make every reload reopen a link somebody
    // had closed, and would connect on startup with the toggle switched off.
    state.radiosync.connect = !!state.radiosync.autoConnect;
    // Until the split there was one `source` covering all three, Radio Sync
    // included. A saved 'radiosync' therefore names no surface at all: the sync
    // panel now stands on its own and needs no flag, so it simply drops.
    if (saved && saved.surface === undefined && typeof saved.source === 'string') {
        state.surface = saved.source === 'radiosync' ? 'off' : saved.source;
    }
    delete state.source;
    // Only a shape check: an id that is not one of the built-ins may be a
    // surface something else registers, which has not happened yet at load.
    // The panel says so if nothing claims it — see SDRControlPanel.
    if (typeof state.surface !== 'string' || !state.surface) state.surface = 'off';
    const out = saved ? state : adoptV1(state);
    out.midi.mappings = normaliseMidiMappings(out.midi.mappings);
    return out;
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

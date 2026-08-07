// Keyboard shortcuts: which key runs which function.
//
// This file holds *only* the key half. What a shortcut can do is the function
// catalogue in controls/functions.js — the same one the MIDI surface and the
// FlexControl dial map to — and a shortcut is nothing more than
//
//     "k" -> "mode_usb"
//
// dispatched through the same runFunction() those two use. That is the whole
// design, and it is worth stating plainly because it is what makes this
// extensible: a function added to the catalogue becomes available to the
// keyboard, to MIDI and to the FlexControl at once, with its label, its hint
// and its group already written, and nothing here needs editing to pick it up.
//
// v1 went the other way. Its shortcuts were a 250-line if/else chain in app.js
// with the behaviour inlined at each branch, a second copy of the band keys in
// bands_state.js that fired alongside it, and no way for anyone to see the list
// — never mind change it. Adding a key meant editing the chain; adding a
// function meant editing the chain, the MIDI extension and the FlexControl
// extension separately.
//
// Bindings are stored as { combo: functionId }, one function per key. A
// function may be bound to more than one key, which is why the map is that way
// round rather than the reverse.

const STORAGE_KEY = 'ubersdr.v2.shortcuts';

// Named keys that read better than their raw values, and the ones whose raw
// value is unusable in a combo string (' ' in particular).
const KEY_LABELS = {
    ' ': 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Escape: 'Esc',
    Enter: 'Enter',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'Page up',
    PageDown: 'Page down',
    Tab: 'Tab',
};

// Modifiers in a fixed order, so one combination has exactly one spelling.
const MODIFIERS = [
    ['ctrlKey', 'Ctrl'],
    ['altKey', 'Alt'],
    ['shiftKey', 'Shift'],
    ['metaKey', 'Meta'],
];

/**
 * The combo string for a keyboard event, or '' if it is not one to bind.
 *
 * Letters are lowercased so that Shift+K and K are distinguishable as
 * "Shift+k" and "k" rather than colliding on the character the browser reports.
 */
export function comboFor(e) {
    if (!e || !e.key) return '';
    // A modifier on its own is not a shortcut, it is the start of one.
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return '';
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const parts = MODIFIERS.filter(([prop]) => e[prop]).map(([, name]) => name);
    parts.push(key === ' ' ? 'Space' : key);
    return parts.join('+');
}

/** "Shift + K", "Ctrl + Left", "Space" — for showing, never for storing. */
export function comboLabel(combo) {
    if (!combo) return '';
    const parts = combo.split('+');
    const key = parts.pop();
    const shown = KEY_LABELS[key === 'Space' ? ' ' : key]
        || (key.length === 1 ? key.toUpperCase() : key);
    return [...parts, shown].join(' + ');
}

// Keys the browser and the page need more than we do. Binding these is refused
// rather than silently swallowed, so nobody loses Find or a tab switch to a
// shortcut and has to work out where it went.
const RESERVED = new Set([
    'Tab', 'F5', 'F11', 'F12',
    'Ctrl+r', 'Ctrl+t', 'Ctrl+w', 'Ctrl+n', 'Ctrl+l', 'Ctrl+f', 'Ctrl+p',
    'Meta+r', 'Meta+t', 'Meta+w', 'Meta+n', 'Meta+l', 'Meta+f', 'Meta+p', 'Meta+q',
]);

/** Why this combo cannot be bound, or '' if it can. */
export function comboProblem(combo) {
    if (!combo) return 'No key';
    if (RESERVED.has(combo)) return 'The browser needs that one';
    return '';
}

// v1's layout, as far as v2's catalogue covers it, so anyone arriving from the
// old interface finds their fingers already work.
//
// Not carried over: E (max zoom), R (recorder) and F (focus the frequency box)
// have no equivalent function yet, and v1's C/J/K mode *pairs* are single modes
// here — v2 has eight modes and a next/previous pair, which covers the same
// ground without three keys that each behave differently depending on where
// they are pressed from.
export const DEFAULT_BINDINGS = {
    ArrowLeft: 'freq_step_down',
    ArrowRight: 'freq_step_up',
    ArrowUp: 'volume_up',
    ArrowDown: 'volume_down',
    m: 'mute_toggle',
    u: 'mode_usb',
    l: 'mode_lsb',
    c: 'mode_cwu',
    j: 'mode_am',
    k: 'mode_nfm',
    w: 'zoom_in',
    s: 'zoom_out',
    q: 'spectrum_reset',
    z: 'bw_narrow',
    x: 'bw_widen',
    n: 'dsp_toggle',
    t: 'vfo_toggle_ab',
    y: 'announce_toggle',
    g: 'squelch_toggle',
    1: 'band_160m',
    2: 'band_80m',
    3: 'band_60m',
    4: 'band_40m',
    5: 'band_30m',
    6: 'band_20m',
    7: 'band_17m',
    8: 'band_15m',
    9: 'band_12m',
    0: 'band_10m',
};

export const DEFAULTS = {
    // On by default, unlike the announcements: a shortcut does nothing until a
    // key is pressed, and the keys are the ones v1 has always used.
    enabled: true,
    bindings: { ...DEFAULT_BINDINGS },
};

// --- the store --------------------------------------------------------------
//
// Its own, for the same reason the announcements have one: the watcher that
// reads it is always mounted and the panel that writes it is not.

let current = null;
const listeners = new Set();

function load() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (!saved || typeof saved !== 'object') return { ...DEFAULTS };
        return {
            enabled: saved.enabled !== false,
            // A saved map replaces the defaults rather than merging with them:
            // a deleted shortcut has to stay deleted, and merging would put
            // every one of them back on the next load.
            bindings: saved.bindings && typeof saved.bindings === 'object'
                ? { ...saved.bindings }
                : { ...DEFAULT_BINDINGS },
        };
    } catch (e) {
        return { ...DEFAULTS };
    }
}

export function shortcutSettings() {
    if (!current) current = load();
    return current;
}

export function setShortcutSettings(patch) {
    current = { ...shortcutSettings(), ...patch };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch (e) { /* private mode */ }
    for (const fn of Array.from(listeners)) fn(current);
    return current;
}

export function onShortcutSettings(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

// --- editing ----------------------------------------------------------------

/** Bind `combo` to `fnId`, taking it off whatever had it. */
export function bindShortcut(combo, fnId) {
    if (comboProblem(combo)) return shortcutSettings();
    return setShortcutSettings({
        bindings: { ...shortcutSettings().bindings, [combo]: fnId },
    });
}

export function unbindShortcut(combo) {
    const next = { ...shortcutSettings().bindings };
    delete next[combo];
    return setShortcutSettings({ bindings: next });
}

export function resetShortcuts() {
    return setShortcutSettings({ bindings: { ...DEFAULT_BINDINGS } });
}

/** The function a combo runs, or undefined. */
export function shortcutFor(combo) {
    return shortcutSettings().bindings[combo];
}

// --- when not to listen ------------------------------------------------------

/**
 * True when the keystroke belongs to whatever is being typed into.
 *
 * A shortcut that fires while someone is naming a bookmark is worse than no
 * shortcut at all, and this is the one rule every v1 handler had to remember
 * separately — the band keys in bands_state.js remembered, the rest of app.js
 * remembered, and each did it slightly differently.
 */
/**
 * A temporary claim on the letter keys, for something that needs them itself.
 *
 * The Morse trainer's typing mode is the case: `U` there is an answer, and a
 * receiver that switched to USB while you copied would be unusable. What it must
 * not do is turn the user's shortcuts *setting* off — that is theirs, it is
 * persisted, and a game that flips it has to put it back on close, on unmount and
 * on the reload that never runs the cleanup. The one time it failed, the radio
 * would be deaf to its own keyboard with nothing on screen to explain why.
 *
 * So this is runtime only and deliberately unpersisted: worst case, a reload has
 * every shortcut back. Counted rather than a flag, so two claimants cannot release
 * each other's hold, and each release is idempotent — an effect cleanup that runs
 * twice must not decrement twice.
 */
let claims = 0;

export function claimKeys() {
    claims += 1;
    let held = true;
    return () => {
        if (!held) return;
        held = false;
        claims = Math.max(0, claims - 1);
    };
}

export const keysClaimed = () => claims > 0;

/** Test seam: no product code drops a claim it does not hold. */
export function _releaseAllKeys() {
    claims = 0;
}

export function isTyping(target) {
    if (!target) return false;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return !!target.isContentEditable;
}

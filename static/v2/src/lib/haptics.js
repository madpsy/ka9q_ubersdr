// Haptic feedback, for phones.
//
// A receiver on a phone is a screen full of controls with no travel and no
// click: a tap on a mute button, a tap on the waterfall to tune, and a pinch
// that zooms in rungs the finger cannot see, all feel identical to the hand.
// A few milliseconds of vibration is what tells you the tap landed — and, on
// the spectrum, *when* it landed, which matters most on the gestures whose
// result is somewhere other than under your finger.
//
// Three rules shape everything below:
//
//   Short.   A UI tap is 8-20 ms. Anything longer reads as an alert, not as a
//            control, and a phone left buzzing for 50 ms per button is a phone
//            people turn this off on.
//   Rare.    Nothing fires per frame. A pan buzzes once as it takes hold and
//            once at the end of the band, not per move; a zoom fires once per
//            rung actually taken. A whole gesture is a handful of pulses.
//   Silent.  navigator.vibrate does not exist on desktop Safari or Firefox and
//            is a no-op in desktop Chrome. Every call here is a no-op when
//            unsupported, so callers never guard.
//
// Buttons do not call this: HapticWatch delegates one pointerdown listener at
// the document and gives every button, switch and tab in the app its tap for
// free. Only gestures that a delegated listener cannot see — tune, zoom rung,
// filter-edge grab, dial digit — call `haptic()` themselves.
//
// Every pulse belongs to one of two scopes, which are switched separately in
// the Display panel because they answer different questions and people want
// different amounts of each:
//
//   ui         a control was pressed. Confirmation of something you did on
//              purpose to a thing you were already looking at.
//   spectrum   the waterfall did something. Tuning, zooming, panning and
//              grabbing a filter edge all put the result somewhere other than
//              under your finger — often *behind* it — which is where the
//              feedback earns the most and where somebody who finds buzzing
//              buttons fussy may still want it.
//
// Someone who wants their buttons silent and their waterfall talkative (or the
// reverse) says so with two switches rather than by giving the whole thing up.

// Base durations in ms at 'medium'. `bump` is the one two-part pattern: it says
// "that went as far as it goes", and a single pulse cannot say that.
const PATTERNS = {
    tap: 8,        // any button, tab or menu item
    toggle: 14,    // a switch changing state — heavier than a tap, since it latched
    select: 10,    // one of a set: segmented item, palette, band
    step: 6,       // one rung of a repeating gesture: zoom, dial digit
    tune: 16,      // the receiver moved to where you tapped
    grab: 18,      // a drag took hold of something (a filter edge, the splitter)
    bump: [10, 40, 10],   // ran into a limit
};

// What each mode does to those. 'off' is absent on purpose: it returns null
// before the table is consulted.
const SCALE = { light: 0.6, medium: 1, strong: 1.6 };

// Minimum gap between two pulses of the same kind. The repeating kinds get the
// longer one — a pinch can ask for a rung every 60 ms, and pulses closer than
// this stop being distinct events and start being a buzz. The rest only need
// enough to survive a double-fire (a pointerdown that also produces a click).
const MIN_GAP_MS = { step: 30, tap: 20, select: 20, toggle: 20 };
const MIN_GAP_DEFAULT = 40;

export const HAPTIC_MODES = ['off', 'light', 'medium', 'strong'];
export const HAPTIC_SCOPES = ['ui', 'spectrum'];

// Both on unless told otherwise: an unrecognised or missing scope is treated as
// enabled, so a caller that forgets one is loud rather than silently dead.
const DEFAULT_SCOPES = { ui: true, spectrum: true };

/**
 * The vibration pattern for a kind of feedback, or null for silence.
 *
 * Durations are rounded but never to zero: a 0 ms pulse is a request the
 * platform accepts and ignores, which would make 'light' feel broken on the
 * shortest kinds rather than merely subtle.
 */
export function hapticPattern(kind, mode) {
    const scale = SCALE[mode];
    if (!scale) return null;                 // 'off', or anything unrecognised
    const base = PATTERNS[kind];
    if (base == null) return null;
    const one = (ms) => Math.max(1, Math.round(ms * scale));
    return Array.isArray(base) ? base.map(one) : one(base);
}

/**
 * Whether this scope is switched on. Pure, and separate from `haptic()` so the
 * rule — off only when explicitly false — is testable without a vibrator.
 */
export function scopeEnabled(scope, state) {
    if (!state) return true;
    return state[scope] !== false;
}

/** Whether enough time has passed since the last pulse of this kind. */
export function shouldFire(kind, now, last) {
    if (!(last > 0)) return true;
    const gap = MIN_GAP_MS[kind] != null ? MIN_GAP_MS[kind] : MIN_GAP_DEFAULT;
    return now - last >= gap;
}

// ---------------------------------------------------------------------------
// The live side. Module state rather than context: the delegated listener and
// the canvas gesture handlers are both outside React's render path, and neither
// should re-subscribe to anything to find out whether haptics are on.

let mode = 'off';
let scopes = { ...DEFAULT_SCOPES };
const lastAt = new Map();

/**
 * Is there a vibrator worth talking to?
 *
 * `any-pointer: coarse` rather than `pointer: coarse`: a touchscreen laptop
 * whose primary pointer is a mouse has no vibration motor either way, and the
 * question being asked is really "is this a phone or tablet". Desktop Chrome
 * defines navigator.vibrate and does nothing with it, so the API check alone
 * would show the setting to everyone.
 */
export function hapticsSupported() {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(any-pointer: coarse)').matches;
}

export function setHapticMode(next) {
    mode = HAPTIC_MODES.includes(next) ? next : 'off';
}

export function getHapticMode() {
    return mode;
}

/** Which scopes are live, as {ui, spectrum}. Anything absent stays on. */
export function setHapticScopes(next) {
    scopes = { ...DEFAULT_SCOPES, ...(next || {}) };
}

export function getHapticScopes() {
    return { ...scopes };
}

/**
 * Fire one piece of feedback. Safe to call from anywhere, at any rate — an
 * unsupported device, a mode of 'off', a scope the operator has switched off
 * and a pulse too soon after the last one all come out the same way, as
 * nothing.
 *
 * `scope` defaults to 'ui': a call site that does not say is a control being
 * pressed, which is what most of them are.
 */
export function haptic(kind, scope = 'ui') {
    if (mode === 'off') return false;
    if (!scopeEnabled(scope, scopes)) return false;
    const pattern = hapticPattern(kind, mode);
    if (pattern == null) return false;
    if (!hapticsSupported()) return false;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!shouldFire(kind, now, lastAt.get(kind) || 0)) return false;
    lastAt.set(kind, now);
    try {
        navigator.vibrate(pattern);
    } catch (e) {
        return false;   // some browsers throw when the page is not visible
    }
    return true;
}

// ---------------------------------------------------------------------------
// Delegation.
//
// Which kind of tap an element deserves, from the element alone. This is what
// lets one listener cover every panel in the app: a new button is felt without
// anybody remembering to make it so.

// Anything a finger can press. `[data-haptic]` opts an element in explicitly
// (and names its kind); `[data-haptic="off"]` opts one out — used for controls
// that fire their own, so the press and the result are not two pulses.
const PRESSABLE = 'button, [role="button"], [role="switch"], [role="tab"], a[href],'
    + ' summary, select, input[type="checkbox"], input[type="radio"], input[type="range"],'
    + ' [data-haptic]';

export function hapticKindFor(el) {
    if (!el || !el.closest) return null;
    const hit = el.closest(PRESSABLE);
    if (!hit) return null;
    const named = hit.dataset ? hit.dataset.haptic : null;
    if (named) return named === 'off' ? null : named;
    if (hit.disabled) return null;
    // aria-disabled covers the elements that have no `disabled` property of
    // their own but are drawn as unavailable.
    if (hit.getAttribute && hit.getAttribute('aria-disabled') === 'true') return null;
    if (hit.getAttribute && hit.getAttribute('role') === 'switch') return 'toggle';
    const tag = hit.tagName;
    if (tag === 'INPUT') {
        const type = hit.type;
        if (type === 'range') return 'grab';
        return 'toggle';
    }
    // Picking one of a set — a band chip, a palette, a segmented option, a row
    // in a list — is a different act from pressing a command button, so it gets
    // its own weight. String check because SVG elements carry an SVGAnimatedString.
    const cls = hit.className;
    if (typeof cls === 'string'
        && /(^|\s)(segmented__item|palette|tabbar__item|chip--button|list__row|menu__item)(\s|$)/.test(cls)) {
        return 'select';
    }
    return 'tap';
}

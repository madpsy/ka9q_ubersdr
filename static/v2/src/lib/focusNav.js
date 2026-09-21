// Moving focus by direction, for the controls that would otherwise keep it.
//
// A television's WebView moves focus with the D-pad itself — spatial navigation,
// which Chromium turns on wherever there is no touchscreen — but only for a key
// the focused element leaves alone. A native `<input type=range>` does not leave
// any alone: all four arrows change its value, so a remote that lands on the
// squelch slider can turn it and do nothing else, ever. `<select>` has an
// exception for exactly this in Chromium; the range input has none.
//
// So the slider hands up and down back, on a television, and this is where they
// go: to the nearest focusable thing that way, which is what the platform would
// have picked had it been allowed to.

import { isTelevision } from './appLinks.js';

// useMediaQuery's NO_POINTER_QUERY, spelt out: that module brings React with it,
// and this one is tested under plain node.
const NO_POINTER_QUERY = '(pointer: none)';

/**
 * Driven by a remote? The same two signals as useTelevision, read at the time
 * of the key press rather than through a hook, so a control as plain as the
 * slider does not need to subscribe to a media query to know.
 */
export function drivenByRemote() {
    try {
        if (isTelevision()) return true;
        return typeof window !== 'undefined' && !!window.matchMedia
            && window.matchMedia(NO_POINTER_QUERY).matches;
    } catch (e) {
        return false;
    }
}

/** 'up' / 'down' for an unmodified vertical arrow, else null. */
export function verticalArrow(event) {
    if (!event || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
    if (event.key === 'ArrowUp') return 'up';
    if (event.key === 'ArrowDown') return 'down';
    return null;
}

/**
 * The candidate focus should move to, given where it is now and which way.
 *
 * Only what lies wholly past the near edge counts — a control beside the slider
 * is not "below" it because its baseline is a pixel lower. Of those, the nearest
 * wins, with sideways distance weighted so the control directly under is chosen
 * over a closer one off to the side: a column of rows is what this is walking.
 *
 * Pure: `from` and every `rect` are plain {left, top, right, bottom}.
 */
export function pickNeighbour(from, candidates, dir) {
    const down = dir === 'down';
    const fromCx = (from.left + from.right) / 2;
    let best = null;
    let bestScore = Infinity;
    for (const c of candidates) {
        const r = c.rect;
        const gap = down ? r.top - from.bottom : from.top - r.bottom;
        // A pixel of slack: rows that touch share an edge, and rounding in a
        // transformed layout can put one a fraction over it.
        if (gap < -1) continue;
        // Horizontal overlap is no distance at all; otherwise how far off to
        // the side the nearer edge is.
        const side = r.right < from.left ? from.left - r.right
            : r.left > from.right ? r.left - from.right
            : 0;
        const cx = (r.left + r.right) / 2;
        const score = Math.max(0, gap) + side * 2 + Math.abs(cx - fromCx) * 0.01;
        if (score < bestScore) { bestScore = score; best = c; }
    }
    return best;
}

export const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]';

/** Can focus land on this element and be seen doing so? */
export function focusable(el) {
    if (el.disabled || el.getAttribute('tabindex') === '-1') return false;
    if (el.closest('[inert], [aria-hidden="true"]')) return false;
    const rect = el.getBoundingClientRect();
    // Not laid out, or out of sight: display:none, a collapsed dock.
    return !!(rect.width && rect.height);
}

/** Focus `el` and bring it into view, as the platform's own move would. */
export function focusAndReveal(el) {
    el.focus();
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* old engines */ }
}

/**
 * Focus the nearest focusable element above or below `from`. Returns whether
 * anything was found; nothing moves if not, which is where the platform's own
 * navigation would have stopped too.
 */
export function focusNeighbour(from, dir) {
    if (!from || typeof document === 'undefined') return false;
    const fromRect = from.getBoundingClientRect();
    const candidates = [];
    for (const el of document.querySelectorAll(FOCUSABLE)) {
        if (el === from || from.contains(el) || el.contains(from)) continue;
        if (!focusable(el)) continue;
        candidates.push({ el, rect: el.getBoundingClientRect() });
    }
    const next = pickNeighbour(fromRect, candidates, dir);
    if (!next) return false;
    focusAndReveal(next.el);
    return true;
}

/**
 * The keydown half, for a control whose own handling of the arrows would trap
 * a remote: on a television, up and down leave it. True if the key was taken.
 */
export function releaseVerticalArrows(event) {
    const dir = verticalArrow(event);
    if (!dir || !drivenByRemote()) return false;
    // Stops the range input's own step as well as moving on: the value must not
    // change on the way past.
    event.preventDefault();
    focusNeighbour(event.currentTarget, dir);
    return true;
}

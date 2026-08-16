// Keeping the field you are typing in above the keyboard.
//
// A browser reveals a focused input on its own, and on a page that scrolls it
// is right every time. This interface does not scroll: it is one window tall,
// and everything inside it — a dock, a sheet, a panel body — scrolls
// separately. So the browser's reveal has nothing to move, and on a handset the
// keyboard simply covers whatever is under it: the callsign box, the bookmark
// search, the frequency entry, every field in every panel.
//
// iOS makes that worse in a specific way. Rather than resizing the page it pans
// the *visual* viewport up over an unchanged layout, so the input is still
// where it always was in the document — nothing has scrolled, nothing looks
// wrong to the page, and the field is behind the keys. Android resizes, which
// helps the layout and still leaves an input inside a scroller wherever it was.
//
// So the reveal is done here: find what is actually scrollable around the
// focused field and move it, by the smallest amount that puts the field clear
// of the keyboard. What "clear" means is the visible region — see appHeight.js,
// which measures it for the same reason.
//
// The arithmetic is separate from the DOM below it because the interesting part
// is the arithmetic: which way to scroll, how far, and when the honest answer
// is "not at all". A field already in view must not be nudged, and a scroller
// that cannot move must not be asked to.

/** Breathing room between the field and the keyboard, in CSS px. */
export const GAP = 12;

/**
 * How far to scroll a container so `field` is inside `view`.
 *
 * All three are `{ top, bottom }` in the same coordinates — client
 * coordinates, as getBoundingClientRect gives them. `view` is the visible
 * region: the window less whatever the keyboard is over.
 *
 * Positive means scroll down (content moves up). Zero means it is already
 * visible, which is the common answer and the one worth being sure of: a
 * reveal that fires on every focus and moves things by a pixel is worse than no
 * reveal at all.
 *
 * A field taller than the space available is aligned to the *top* of it. That
 * is the one case where the rules conflict — it cannot be wholly visible — and
 * the top is where the text being typed is.
 */
export function revealBy(field, view, gap = GAP) {
    if (!field || !view) return 0;
    const top = view.top + gap;
    const bottom = view.bottom - gap;
    if (bottom <= top) return 0;

    if (field.bottom > bottom) {
        const wanted = field.bottom - bottom;
        // Not so far that the top of the field goes off the other edge.
        const room = field.top - top;
        return room <= 0 ? 0 : Math.round(Math.min(wanted, room));
    }
    if (field.top < top) return Math.round(field.top - top);
    return 0;
}

/**
 * The visible region, from the visual viewport.
 *
 * In client coordinates, so it can be compared with a rect: the visual
 * viewport's offset is *from* the layout viewport, which is what client
 * coordinates are relative to, so the region starts at `offsetTop`.
 */
export function visibleBox(win = window) {
    const vv = win && win.visualViewport;
    if (!vv || !(vv.height > 0)) {
        const h = (win && win.innerHeight) || 0;
        return { top: 0, bottom: h };
    }
    const top = vv.offsetTop || 0;
    return { top, bottom: top + vv.height };
}

/** Is this something a keyboard comes up for? */
export function isTextEntry(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag !== 'INPUT') return false;
    // Buttons, checkboxes and radios are INPUTs and raise no keyboard; a range
    // slider is the one that matters here, because the Multipad is full of them
    // and a reveal on every touch of one would fight the drag.
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'image', 'color']
        .includes(type);
}

/** The nearest ancestor that can actually scroll vertically. */
function scroller(el, doc) {
    let node = el && el.parentElement;
    while (node && node !== doc.body && node !== doc.documentElement) {
        const style = getComputedStyle(node);
        const scrolls = /auto|scroll|overlay/.test(`${style.overflowY} ${style.overflow}`);
        if (scrolls && node.scrollHeight > node.clientHeight + 1) return node;
        node = node.parentElement;
    }
    return null;
}

// How long to wait for the keyboard before measuring. Focus arrives first and
// the viewport resize follows it — measuring on focus alone measures the window
// as it was, which is a reveal of zero every time. Twice, because the first
// resize on iOS can arrive before the pan has settled.
const SETTLE_MS = [180, 420];

/**
 * Install the reveal. Returns a function that removes it.
 *
 * One listener for the whole interface rather than a hook per panel: every text
 * field in every panel wants exactly this, and none of them should have to ask.
 */
export function startKeyboardReveal(win = window, doc = document) {
    if (!win || !doc || typeof win.addEventListener !== 'function') return () => {};

    let timers = [];
    const clear = () => { for (const id of timers) win.clearTimeout(id); timers = []; };

    const reveal = () => {
        const el = doc.activeElement;
        if (!isTextEntry(el) || typeof el.getBoundingClientRect !== 'function') return;

        const view = visibleBox(win);
        // Nothing is covering anything: no keyboard, or a keyboard the browser
        // has already made room for by resizing. Either way there is nothing
        // here to fix, and moving a scroller would only take the operator
        // somewhere they did not ask to go.
        if (view.bottom >= (win.innerHeight || 0) - 1 && view.top <= 1) return;

        const by = revealBy(el.getBoundingClientRect(), view);
        if (!by) return;

        const box = scroller(el, doc);
        if (box) box.scrollTop += by;
        else if (typeof el.scrollIntoView === 'function') {
            // Nothing scrollable around it — a field in a fixed dialog, say.
            // The browser's own reveal is the last resort and is usually right
            // once something has told it to look.
            el.scrollIntoView({ block: 'center' });
        }
    };

    const onFocus = () => {
        clear();
        timers = SETTLE_MS.map((ms) => win.setTimeout(reveal, ms));
    };

    win.addEventListener('focusin', onFocus);
    // The keyboard can change size after it is up — a language switch, the
    // predictive bar appearing — and a field that was clear stops being clear.
    if (win.visualViewport) win.visualViewport.addEventListener('resize', reveal);

    return () => {
        clear();
        win.removeEventListener('focusin', onFocus);
        if (win.visualViewport) win.visualViewport.removeEventListener('resize', reveal);
    };
}

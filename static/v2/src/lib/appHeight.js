// How tall the window actually is, as a CSS custom property.
//
// `100dvh` is the right idea and works everywhere except where it matters most:
// installed to the home screen on iOS, the unit resolves before the standalone
// viewport has settled, so the shell comes out taller than the screen. Nothing
// scrolls the page, so the bottom of it — the mobile tab bar, the only way to
// reach any panel — is simply below the fold and unreachable. Rotating the phone
// forces a re-layout and it appears, which is the tell: the layout was right all
// along, the height it was given was not.
//
// So the height is measured and written to `--app-height`, which `.shell` uses
// with `100dvh` as its fallback. Measured, not computed: whatever the browser
// believes `innerHeight` to be is by definition what is on screen.
//
// ── The keyboard ────────────────────────────────────────────────────────────
//
// iOS overlays the keyboard: the window keeps its full height, the visual
// viewport shrinks, and Safari *pans* the visual viewport down to bring the
// focused input above the keys — with breathing room, which takes the pan past
// the end of the document. The shell is exactly one window tall, so everything
// past its end is bare html background: a black band between the bottom of the
// page and the keyboard, exactly as tall as the overshoot.
//
// The first attempt at this shrank the shell to the visual viewport, and made
// it worse, instructively: the pan Safari had already committed to was measured
// against the old, taller layout, so shrinking left the visible region mostly
// past the end of the new one — even a floating input, whose reveal pan is
// small, got a band. There is also no API to un-pan a visual viewport, so the
// pan cannot be fought, only accommodated.
//
// So the shell is never shrunk for a keyboard. It is *extended*: while an
// editable element has focus and the viewport is keyboard-short, the height is
// whatever reaches the bottom of wherever Safari has panned to —
// scrollY + offsetTop + height, the visible region's bottom edge in document
// coordinates. No pan, no change, and no canvas resize; a pan past the end
// grows the shell by the overshoot so the compose box rides down to sit flush
// on the keys. The pan clamps itself back to zero when the keyboard closes
// (its ceiling is layout height minus viewport height, which returns to
// nothing), and the height follows focus out the same moment.

// Re-reads after the first paint. Standalone mode on iOS settles some time after
// load and does not always say so; these cost one property write each.
const SETTLE_MS = [0, 120, 400, 1000];

// The least shortfall read as a keyboard. Far below any real keyboard — an iPad
// keyboard is several hundred pixels — and above the browser-chrome jitter the
// visual viewport reports while settling.
const KEYBOARD_MIN = 90;

export function startAppHeight(win = window, doc = document) {
    if (!win || !doc || !doc.documentElement) return () => {};

    const vv = win.visualViewport;

    // Whether the focused element is one that raises a keyboard. Checkboxes and
    // buttons are INPUTs too, but the visual viewport does not shrink for them,
    // and both conditions have to hold.
    const editing = () => {
        const el = doc.activeElement;
        if (!el) return false;
        return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
    };

    let last = 0;
    const apply = () => {
        const inner = Math.round(win.innerHeight || 0);
        if (!inner) return;

        let h = inner;
        // `scale` keeps pinch zoom out of this: pinched in, the visual viewport
        // is a window onto the page rather than the space above a keyboard. A
        // band around 1, not a floor — a floor of 0.99 waves through the 2× the
        // whole condition exists to keep out.
        if (vv && Math.abs(vv.scale - 1) < 0.01 && editing()) {
            const vvh = Math.round(vv.height);
            if (inner - vvh > KEYBOARD_MIN) {
                // The bottom of the visible region, in document coordinates —
                // however Safari split the reveal between a layout scroll and a
                // visual-viewport pan. Never less than the window: the shell
                // only ever grows for a keyboard, so a reveal that needed no
                // overshoot changes nothing and resizes nothing.
                const seen = Math.round((win.scrollY || 0) + (vv.offsetTop || 0) + vv.height);
                h = Math.max(inner, seen);
            }
        }

        // Unchanged is the common case — a scroll event on the visual viewport
        // fires constantly — and writing a custom property invalidates layout.
        if (h !== last) {
            last = h;
            doc.documentElement.style.setProperty('--app-height', `${h}px`);
        }

        // A reveal done with a layout scroll can survive the keyboard that
        // asked for it; the page never scrolls on purpose, so once nothing is
        // being edited any scroll is Safari's leftovers. The visual-viewport
        // pan needs no undoing — its ceiling collapses to zero on its own.
        if (h === inner && win.scrollY > 0 && typeof win.scrollTo === 'function') {
            win.scrollTo(0, 0);
        }
    };

    // Focus moves before the keyboard does, and the keyboard's own resize can
    // arrive while `activeElement` is still mid-change — a beat later both have
    // settled, whichever order they happened in.
    const applySoon = () => win.setTimeout(apply, 0);

    apply();

    const timers = SETTLE_MS.map((ms) => win.setTimeout(apply, ms));
    win.addEventListener('resize', apply);
    win.addEventListener('orientationchange', apply);
    // Returning to an installed app from the background restores it from the
    // page cache, at whatever size it was put away at.
    win.addEventListener('pageshow', apply);
    // Blur is what closes the keyboard, and iOS does not always follow it with
    // a visual-viewport resize promptly. `editing()` is false the moment focus
    // has moved, so this restores the full height without waiting to be told.
    win.addEventListener('focusin', applySoon);
    win.addEventListener('focusout', applySoon);

    if (vv) {
        vv.addEventListener('resize', apply);
        vv.addEventListener('scroll', apply);
    }

    return () => {
        for (const id of timers) win.clearTimeout(id);
        win.removeEventListener('resize', apply);
        win.removeEventListener('orientationchange', apply);
        win.removeEventListener('pageshow', apply);
        win.removeEventListener('focusin', applySoon);
        win.removeEventListener('focusout', applySoon);
        if (vv) {
            vv.removeEventListener('resize', apply);
            vv.removeEventListener('scroll', apply);
        }
    };
}

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
// `innerHeight` is the measurement — except while the on-screen keyboard is up,
// when it is a lie with a black band under it. iOS overlays the keyboard: the
// window keeps its full height, the visual viewport shrinks, and Safari scrolls
// the layout viewport to bring the focused input above the keys. This shell is
// exactly one window tall and scrolls nowhere, so that scroll drags the whole
// page up and exposes the html background beneath it — on an iPad with chat in
// the bottom dock, a keyboard-sized black hole between the compose box and the
// keys.
//
// So while an editable element has focus and the visual viewport is meaningfully
// shorter than the window, the visual viewport *is* the height: the shell fits
// above the keys, the input is on screen without Safari scrolling anything, and
// the scroll it already did is undone. The rest of the time innerHeight stands,
// for the reason it always did — the visual viewport also shrinks for pinch
// zoom and fires resize constantly, and driving the shell from it wholesale
// would resize the spectrum canvas whenever anything twitched. Gated on focus
// and on scale, it costs two canvas resizes per keyboard session, not one per
// keystroke.

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
        // is a window onto the page rather than the space above a keyboard, and
        // shrinking the shell to it would shrink the page being looked at. A
        // band around 1, not a floor — a floor of 0.99 waves through the 2× the
        // whole condition exists to keep out.
        if (vv && Math.abs(vv.scale - 1) < 0.01 && editing()) {
            const above = Math.round(vv.height);
            if (inner - above > KEYBOARD_MIN) h = above;
        }

        // Unchanged is the common case — a scroll event on the visual viewport
        // fires constantly — and writing a custom property invalidates layout.
        if (h !== last) {
            last = h;
            doc.documentElement.style.setProperty('--app-height', `${h}px`);
        }

        // Undo the reveal-the-input scroll. With the shell sized to the visual
        // viewport the input is on screen at scroll zero, and any offset Safari
        // keeps is doubled-up correction: the page moved up *and* got shorter.
        if (h !== inner && (win.scrollY || (vv && vv.offsetTop))) {
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

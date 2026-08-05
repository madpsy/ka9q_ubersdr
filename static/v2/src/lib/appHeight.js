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
// `innerHeight` rather than `visualViewport.height` deliberately. The visual
// viewport shrinks when the on-screen keyboard opens, and driving the shell from
// it would resize the spectrum canvas every time somebody typed a frequency. The
// visual viewport is still worth *listening* to — on iOS it reports the settling
// that innerHeight quietly finishes without an event of its own.

// Re-reads after the first paint. Standalone mode on iOS settles some time after
// load and does not always say so; these cost one property write each.
const SETTLE_MS = [0, 120, 400, 1000];

export function startAppHeight(win = window, doc = document) {
    if (!win || !doc || !doc.documentElement) return () => {};

    let last = 0;
    const apply = () => {
        const h = Math.round(win.innerHeight || 0);
        // Unchanged is the common case — a scroll event on the visual viewport
        // fires constantly — and writing a custom property invalidates layout.
        if (!h || h === last) return;
        last = h;
        doc.documentElement.style.setProperty('--app-height', `${h}px`);
    };

    apply();

    const timers = SETTLE_MS.map((ms) => win.setTimeout(apply, ms));
    win.addEventListener('resize', apply);
    win.addEventListener('orientationchange', apply);
    // Returning to an installed app from the background restores it from the
    // page cache, at whatever size it was put away at.
    win.addEventListener('pageshow', apply);

    const vv = win.visualViewport;
    if (vv) {
        vv.addEventListener('resize', apply);
        vv.addEventListener('scroll', apply);
    }

    return () => {
        for (const id of timers) win.clearTimeout(id);
        win.removeEventListener('resize', apply);
        win.removeEventListener('orientationchange', apply);
        win.removeEventListener('pageshow', apply);
        if (vv) {
            vv.removeEventListener('resize', apply);
            vv.removeEventListener('scroll', apply);
        }
    };
}

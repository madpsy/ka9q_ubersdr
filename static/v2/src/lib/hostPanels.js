// Panels a host has asked not to show.
//
// v2 already lets a panel decide it does not apply — `requires` in
// panels/registry.jsx, which is how the spot panels vanish on a receiver with
// no skimmer. That answers "does this receiver have the thing", and it needs a
// change in v2 for each new case.
//
// This answers a different question: whether the *client* wants the panel at
// all. The Android and iOS clients hide chat this way already, through a flag
// of its own — and every further panel meant a second flag, a second predicate
// and a release of both halves to switch one thing off.
//
//     window.ubersdrDesktop.hidePanels = ['games', 'shortcuts'];
//
// So hiding a panel in a client is now a line in that client. Nothing here
// needs to know why, which is the point: "no keyboard shortcuts panel on a
// phone" and "this build is for a kiosk" are the client's business.
//
// ── What it does not do ──────────────────────────────────────────────────────
//
// Declared by the host and never sniffed, exactly like the other flags on that
// object (see radio/media/support.js). A page cannot hide its own panels with
// it, and a receiver cannot hide them for somebody else: the object is written
// by the client's own preload before the page's first script and by nothing
// else.
//
// A hidden panel is *gone*, not collapsed — it leaves the dock, the layout
// menu and the mobile tabs alike, because a control that cannot be reached is
// worse than one that is absent.

/**
 * Is this page inside one of UberSDR's own applications?
 *
 * `window.ubersdrDesktop` is set by the desktop client's receiver preload and
 * by the mobile clients' document-start script, and by nothing in an ordinary
 * browser — so its presence is the question answered, not any field on it.
 *
 * What it is for is behaviour that only makes sense with a host: an app has its
 * own windows, its own panels and nowhere sensible to put a second browser tab,
 * so things that reach for one outside are answered inside instead. See the top
 * bar's callsign lookup.
 */
export function insideApp() {
    try {
        return typeof window !== 'undefined' && !!window.ubersdrDesktop;
    } catch (e) {
        return false;
    }
}

/**
 * Is `id` hidden by the host?
 *
 * `host` is `window.ubersdrDesktop` or anything shaped like it. Anything that
 * is not a list of names is "hides nothing": a client that sets this to a
 * string, or to true, has made a mistake, and the safe reading of a mistake
 * here is to show the interface rather than to lose parts of it silently.
 */
export function panelHiddenByHost(host, id) {
    if (!host || !id) return false;
    const list = host.hidePanels;
    if (!Array.isArray(list)) return false;
    const want = String(id).toLowerCase();
    return list.some((name) => typeof name === 'string' && name.toLowerCase() === want);
}

/** The same question, asked of the real host. */
export function hiddenByHost(id) {
    try {
        return panelHiddenByHost(typeof window !== 'undefined' ? window.ubersdrDesktop : null, id);
    } catch (e) {
        return false;
    }
}

/**
 * May a notice carrying a link be drawn here?
 *
 * The rule is fail-closed, and deliberately not the shape of the others in this
 * file: an ordinary browser allows one, and a *host* allows one only by saying
 * so.
 *
 * The mobile clients are the reason, and only for the link. A notice is the
 * operator's own words on somebody else's receiver, and one of the things it is
 * for is a donate button — which inside an iOS or Android app is a payment link
 * the stores require to go through their own billing. The apps open whichever
 * receiver the listener picked, so what appears in them is not something this
 * project chooses: any receiver in the directory could put any link there.
 *
 * The words alone are a different matter. "Antenna work this afternoon" breaks
 * no rule and is exactly what somebody in an app wants to know, so a notice with
 * no link is shown everywhere. Only the ones carrying a link are held back — and
 * every link, not the ones that look like payment: a donate button is a URL like
 * any other and there is no telling them apart from here.
 *
 * Expressed as an opt-out it would only take one future client forgetting a
 * flag. Expressed this way there is nothing for them to remember — the mobile
 * clients set nothing and no link can appear, and no receiver-side setting can
 * turn it on. The desktop client, which is ours and goes through no store, opts
 * in explicitly with `noticeLinks: true`.
 */
export function noticeLinksAllowedByHost() {
    try {
        if (typeof window === 'undefined') return true;
        const host = window.ubersdrDesktop;
        if (!host) return true;
        return host.noticeLinks === true;
    } catch (e) {
        // Whatever this is, it is not a browser a link can be offered in safely.
        return false;
    }
}

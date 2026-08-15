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

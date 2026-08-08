// The browser's own notifications — the ones that appear outside the page, in the corner of
// the desktop or in the OS notification centre.
//
// Everything that touches the Notification API is here, so lib/notifications.js stays a plain
// store that can be reasoned about (and tested) without a browser. This module answers three
// questions and performs one action:
//
//   Can this browser do it at all?  Is it allowed to?  Is the page being looked at?
//   And: show one.
//
// ── Why "supported" is not just "is Notification defined" ────────────────────
//
// The API is only present in a secure context, and a receiver served over plain HTTP on a
// shack LAN is not one — which is a completely ordinary way to run UberSDR. So the honest
// answer on those is "not available on this connection", and the panel says exactly that
// rather than offering a switch that silently does nothing.
//
// iOS Safari is the other absence: it has the API only for a site installed to the home
// screen. Nothing here can change that, but permission simply stays deniable, and the
// fallback to a toast means nobody is left with no notification at all.

/** Does this browser, on this connection, have the API? */
export function nativeSupported() {
    return typeof window !== 'undefined'
        && typeof window.Notification === 'function'
        // Secure context: the API exists but throws or no-ops off https. Checked explicitly
        // rather than discovered by a failed request.
        && (window.isSecureContext !== false);
}

/**
 * 'granted' | 'denied' | 'default' | 'unsupported'.
 *
 * 'default' is "never asked", and it is the only state from which asking is worth doing.
 * 'denied' is the state that has to be *shown*: browsers do not ask twice, so a switch that
 * appears to work while nothing arrives is the failure to avoid.
 */
export function nativePermission() {
    if (!nativeSupported()) return 'unsupported';
    const p = window.Notification.permission;
    return p === 'granted' || p === 'denied' ? p : 'default';
}

/**
 * Ask for permission, and report what was decided.
 *
 * Must be called from a user gesture — Safari requires it and Firefox has since 72 — which is
 * why the panel asks as part of *choosing* native notifications rather than in an effect when
 * the setting changes. One press, one prompt, and the answer decides whether the choice sticks.
 */
export async function requestNativePermission() {
    if (!nativeSupported()) return 'unsupported';
    const now = nativePermission();
    // Already answered. Asking again does nothing in every browser, and in some it counts
    // against the site.
    if (now !== 'default') return now;
    try {
        const answer = await window.Notification.requestPermission();
        return answer === 'granted' || answer === 'denied' ? answer : 'default';
    } catch (e) {
        return nativePermission();
    }
}

/** Is the page in front of somebody? What 'auto' turns on. */
export function pageVisible() {
    if (typeof document === 'undefined') return true;
    return document.visibilityState !== 'hidden';
}

// The icon. A URL, because that is what the API takes — our panel icons are inline SVG React
// elements and cannot be handed over. The receiver's own app icon is the right choice anyway:
// at 20 px in a system notification the useful information is *which application* this is,
// which is exactly what a favicon is for.
const ICON = '/images/android-chrome-192x192.png';

/**
 * Show one. Returns the Notification, or null if it could not be shown.
 *
 * `tag` is the key, so a keyed notification replaces its own earlier one in the OS the same
 * way it replaces its own toast — otherwise the antenna switch being tried four times leaves
 * four popups behind, which is the thing keys exist to prevent.
 *
 * Duration is deliberately not enforced. The operator's "for N seconds" is a toast setting:
 * browsers hide these on their own schedule and ignore ours, and closing one early would take
 * it out of the notification centre where somebody who was away is going to look for it. The
 * one instruction that does travel is "until dismissed", which is what requireInteraction is.
 */
export function showNative(item, onClick) {
    if (!item || nativePermission() !== 'granted') return null;
    try {
        const n = new window.Notification(item.title || 'UberSDR', {
            body: item.body || '',
            icon: ICON,
            tag: item.key || `ubersdr-${item.id}`,
            // A replacement should not re-alert: the point of a key is that this is the same
            // fact again, and a second ping for it is noise.
            renotify: false,
            silent: false,
            requireInteraction: item.seconds === 0,
        });
        if (onClick) {
            n.onclick = () => {
                // The window first: a notification is usually read with the tab hidden, and
                // being taken to the receiver is the whole reason to click one.
                try { window.focus(); } catch (e) { /* blocked by the browser */ }
                onClick(item);
                n.close();
            };
        }
        return n;
    } catch (e) {
        // Some browsers throw for a constructed notification where only a service worker may
        // show one (Android Chrome). Nothing to do about it here; the toast fallback in
        // deliveryFor is what keeps the operator informed.
        return null;
    }
}

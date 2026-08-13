// This receiver, handed to an app.
//
// Two schemes, one shape:
//
//   vibesdr://connect?uuid=<public uuid>
//   ubersdr://connect?uuid=<public uuid>
//
// The UUID is the instance's public one — the `id` the directory lists it under
// (`public_uuid` in /api/description, see instance_reporter.go) — and not the
// session's. It names the receiver, so the app can look up where that receiver
// is *now* rather than being told an address that was true when the link was
// made. A tunnel hostname changes; the UUID does not.
//
// Which is also why the link carries nothing else. The apps resolve the UUID
// against the directory themselves (clients/electron/deeplink.js and
// clients/capacitor/src/deeplink.js are the two ends of ubersdr://), and an
// address here would be the one part of it guaranteed to go stale.
//
// Plain JS rather than part of StartExtras.jsx so that these can be tested —
// the v2 test harness bundles .js modules under node, and a link that is wrong
// fails silently: the OS simply does nothing with a scheme nobody claims.

const connectUri = (scheme, publicUuid) => {
    const uuid = String(publicUuid || '').trim();
    // No UUID, no link: an instance that is not registered with the directory
    // has nothing for an app to connect *to*, and callers use the null to leave
    // the button out rather than offer one that cannot work.
    if (!uuid) return null;
    // A UUID needs no escaping and v1 does none (app.js _buildVibeSDRUri), so
    // this produces the identical string for every real instance. It is here
    // for the one that is not real — the value arrives from the server, and a
    // link is a URL whether or not what went into it was one.
    return `${scheme}://connect?uuid=${encodeURIComponent(uuid)}`;
};

/** The VibeSDR app's link for this receiver, or null. */
export function vibesdrUri(publicUuid) {
    return connectUri('vibesdr', publicUuid);
}

/**
 * The UberSDR app's link for this receiver, or null.
 *
 * Followed by the desktop client (Windows, macOS, Linux) and the Android
 * client, which register the scheme with the platform. Nothing happens if
 * neither is installed — an unclaimed scheme is not an error anywhere, which is
 * why the dialog that offers this also shows the link itself.
 */
export function ubersdrAppUri(publicUuid) {
    return connectUri('ubersdr', publicUuid);
}

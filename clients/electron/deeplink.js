'use strict';

// ubersdr:// links — a receiver named in a link, opened from wherever the link
// was.
//
//   ubersdr://connect?uuid=4907ba0a-32e6-40bb-a4ca-47f823331728
//
// The same scheme, the same shape and the same ladder as the Android client
// (clients/capacitor/src/deeplink.js), deliberately: a link that works on the
// phone has to work on the desktop, or it is not a link, it is a phone feature.
// The two files are ports of each other in the way discovery.js and store.js
// are.
//
// The UUID is the one the public directory knows the instance as: the `id` on
// its /api/instances entry, which is the `public_uuid` the instance itself
// reports (see instance_reporter.go). An address is not used because an address
// is the thing that changes — a tunnel hostname, a dynamic IP, a move from port
// 8080 to 443 — and a link printed on a QR code beside a radio should still
// work after any of that. The UUID is what the instance keeps.
//
// Nothing about the link is trusted beyond being a UUID to look up. What comes
// back is a directory row and is treated exactly like one clicked in the
// directory tab: probed, saved, opened. So the worst a hostile link can do is
// open a public receiver that somebody else chose, which is what the chooser's
// directory tab is a list of.
//
// This module is the part that does not need Electron, so that it can be tested
// without one (test/deeplink.test.js). Everything platform-shaped — registering
// the scheme, and the three different ways the three platforms deliver a
// followed link — is in main.js.

// Canonical form, which is the only form. A UUID is what the directory hands
// out and what /api/instances/<uuid> is asked for, and refusing anything else
// here means one place says "that is not a receiver" rather than a lookup
// failing later for a reason that reads like the receiver is down.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What a link is asking for, or an Error saying why it is not asking for
 * anything.
 *
 * Both spellings of a custom-scheme URI are read: `ubersdr://connect?…`, which
 * is what everything writes, puts the action in the authority, and
 * `ubersdr:connect?…`, which is equally valid and puts it in the path. The
 * difference is invisible to whoever typed the link and should stay that way.
 */
function parse(url) {
    let parsed;
    try {
        parsed = new URL(String(url || ''));
    } catch {
        throw new Error('not a link this app understands');
    }
    if (parsed.protocol !== 'ubersdr:') throw new Error(`not an UberSDR link (${parsed.protocol})`);

    const action = (parsed.hostname || parsed.pathname.replace(/^\/+/, '')).toLowerCase();
    if (action !== 'connect') {
        throw new Error(action ? `unknown link action "${action}"` : 'the link says nothing to do');
    }

    const uuid = (parsed.searchParams.get('uuid') || '').trim();
    if (!uuid) throw new Error('the link carries no receiver UUID');
    if (!UUID.test(uuid)) throw new Error('the link carries something that is not a UUID');

    return { action, uuid };
}

/**
 * The ubersdr:// URL in a command line, if there is one.
 *
 * How a link arrives on Windows and Linux, both when it starts the app and —
 * through the second-instance lock — when one is already running. It is one
 * argument among Chromium's own, which is why this searches rather than reading
 * the last: a run under `electron .` has the app path in there too, and a
 * packaged app can be handed switches by the desktop environment.
 *
 * The last one wins, on the grounds that a second URL later in the line is more
 * likely to be the one the operator just clicked than a leftover.
 */
function fromArgv(argv) {
    let found = null;
    for (const arg of argv || []) {
        if (typeof arg === 'string' && /^ubersdr:/i.test(arg)) found = arg;
    }
    return found;
}

/**
 * Turn a UUID into an open receiver, through whichever of the two answers is
 * quicker to be right.
 *
 * The saved list is tried first, and this is the whole reason store entries
 * remember their UUID: a receiver already connected to once opens with no
 * directory round trip at all, which is also what makes a link work on a
 * machine that can reach the receiver but not the internet.
 *
 * When that fails — a receiver never seen before, or one whose saved address
 * has stopped answering because it moved — the directory is asked what the UUID
 * is at now. That second half is what a UUID is *for*, so a failed saved
 * connect is a step on the way rather than the end: the address in the store
 * can be out of date, and the whole point is that the name in the link is not.
 *
 * The three things it needs are passed in rather than required: main.js owns
 * the store and the connect, and a module that reached for them would be a
 * module that cannot be tested without an Electron app around it.
 */
async function open(uuid, { store, lookupUuid, connect }) {
    const saved = store.findByUuid(uuid);
    if (saved) {
        try {
            return await connect({ id: saved.id });
        } catch { /* it has moved, or it is down — ask the directory which */ }
    }

    const row = await lookupUuid(uuid);
    if (!row) {
        throw new Error(saved
            // It was reachable once and the directory has never heard of it, so
            // there is nothing left to try and the saved failure is the real
            // one to report.
            ? `${saved.label || saved.host} did not answer, and the directory does not list it`
            : 'the directory has no receiver with that UUID');
    }
    return connect(row);
}

module.exports = { parse, fromArgv, open };

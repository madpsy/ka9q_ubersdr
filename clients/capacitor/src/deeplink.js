'use strict';

// ubersdr:// links — a receiver named in a link, opened from wherever the link
// was.
//
//   ubersdr://connect?uuid=4907ba0a-32e6-40bb-a4ca-47f823331728
//
// The UUID is the one the public directory knows the instance as: the `id` on
// its /api/instances entry, which is the `public_uuid` the instance itself
// reports (see instance_reporter.go). An address is not used because an address
// is the thing that changes — a tunnel hostname, a dynamic IP, a move from port
// 8080 to 443 — and a link printed on a QR code beside a radio should still
// work after any of that. The UUID is what the instance keeps.
//
// Nothing about the link is trusted beyond being a UUID to look up. What comes
// back is a directory row and is treated exactly like one tapped in the
// directory tab: probed, saved, opened. So the worst a hostile link can do is
// open a public receiver that somebody else chose, which is what the chooser's
// directory tab is a list of.
//
// The scheme is registered in AndroidManifest.xml, and UberSdrPlugin turns a
// followed link into the `deepLink` event this listens for. Cold start and warm
// start arrive the same way — see the plugin for how, and why a relaunch from
// the recents list deliberately does not.

import { UberSdr } from './native.js';
import { store, connect } from './api.js';
import * as discovery from './discovery.js';

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
export function parse(url) {
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
 * Open the receiver a link names.
 *
 * The saved list is tried first, and this is the whole reason store entries
 * remember their UUID: a receiver already connected to once opens with no
 * directory round trip at all, which is also what makes a link work on a phone
 * whose data has dropped but whose Wi-Fi still reaches the receiver.
 *
 * When that fails — a receiver never seen before, or one whose saved address
 * has stopped answering because it moved — the directory is asked what the UUID
 * is at now. That second half is what a UUID is *for*, so a failed saved
 * connect is a step on the way rather than the end: the address in the store
 * can be out of date, and the whole point is that the name in the link is not.
 */
async function open(uuid, say) {
    const saved = await store.findByUuid(uuid);
    if (saved) {
        say(`opening ${saved.label || saved.host}…`);
        const first = await connect({ id: saved.id }).then(() => true, () => false);
        if (first) return;
    }

    say(saved ? 'not where it was — asking the directory…' : 'looking this receiver up…');
    const row = await discovery.lookupUuid(uuid);
    if (!row) {
        throw new Error(saved
            // It was reachable once and the directory has never heard of it, so
            // there is nothing left to try and the saved failure is the real
            // one to report.
            ? `${saved.label || saved.host} did not answer, and the directory does not list it`
            : 'the directory has no receiver with that UUID');
    }

    say(`opening ${row.name || row.callsign || row.host}…`);
    await connect(row);
}

// ---- the banner ------------------------------------------------------------
//
// Where a followed link says what it is doing, and the one piece of UI in this
// client that the chooser page does not draw.
//
// It is drawn here rather than added to the chooser because the chooser is not
// this client's: clients/electron/chooser/ is staged into www/ unmodified by
// build.sh (see package.json), and a deep link is an Android idea that the
// desktop client has no equivalent of. So it is built in the DOM by the same
// bundle that registers window.ubersdr, and styled by mobile.css, which is this
// client's sheet — using the chooser's own custom properties, so it is the
// chooser's palette rather than a second one.

let banner;

/** The banner element, once there is a document to put it in. */
async function ensure() {
    if (document.readyState === 'loading') {
        await new Promise((done) => document.addEventListener('DOMContentLoaded', done, { once: true }));
    }
    if (!banner) {
        banner = document.createElement('div');
        banner.className = 'deeplink';
        banner.hidden = true;

        const text = document.createElement('span');
        text.className = 'deeplink-text';
        banner.appendChild(text);

        const close = document.createElement('button');
        close.className = 'deeplink-close';
        close.type = 'button';
        close.textContent = '×';
        close.setAttribute('aria-label', 'Dismiss');
        close.addEventListener('click', () => { banner.hidden = true; });
        banner.appendChild(close);

        document.body.appendChild(banner);
    }
    return banner;
}

async function show(text, isError) {
    const node = await ensure();
    node.querySelector('.deeplink-text').textContent = text;
    node.classList.toggle('deeplink--error', !!isError);
    // A step on the way is not dismissable — there is nothing to dismiss, it is
    // about to be replaced. A failure stays until it is read and closed.
    node.querySelector('.deeplink-close').hidden = !isError;
    node.hidden = false;
}

// ---- the event -------------------------------------------------------------

// One link at a time, in the order they arrived. Two in quick succession is not
// a normal thing to do, but two connects overlapping would be two proxies and
// two Activities racing for one receiver slot, and a queue costs a line.
let queue = Promise.resolve();

/** Follow one link, reporting where it got to. */
export function follow(url) {
    queue = queue.then(async () => {
        let target;
        try {
            target = parse(url);
        } catch (err) {
            await show(err.message, true);
            return;
        }

        await show('opening a receiver…');
        try {
            await open(target.uuid, (msg) => { show(msg); });
            // The receiver Activity is in front by now and the banner is behind
            // it; clearing it means backing out lands on the chooser rather than
            // on a stale "opening…".
            if (banner) banner.hidden = true;
        } catch (err) {
            await show(err.message || String(err), true);
        }
    });
    return queue;
}

/**
 * Start listening.
 *
 * Called from main.js as the bundle loads, which is early enough for a link
 * that started the app: the plugin holds that event until something is
 * listening (notifyListeners with retainUntilConsumed), so registering here
 * rather than after the page has settled is what makes a cold start work.
 */
export function install() {
    UberSdr.addListener('deepLink', (event) => {
        if (event && event.url) follow(event.url);
    });
}

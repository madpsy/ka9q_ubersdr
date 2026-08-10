// Sharing what you are listening to, as a link.
//
// The whole content of a shared link is the radio: frequency, mode, filter edges,
// and where the spectrum is pointed and how far in. Nothing about panels, docks,
// palettes or any other preference — those are the recipient's, and a link that
// rearranged somebody's workspace to show them a signal would be a link nobody
// sends twice.
//
// The parameter names are v1's, exactly (app.js loadSettingsFromURL): freq, mode,
// bwl, bwh, zoom_freq, zoom_bw. Two frontends serve the same receiver and a link
// is the one thing certain to cross between them — the recipient may not be using
// the one that made it, and may not know there is a choice.
//
// Built from the origin and path rather than from the current URL with parameters
// added, which matters for one reason above the tidiness: this page can be opened
// with `?password=` (see radio/session.js), and a share button that carried
// whatever was in the address bar would hand that to a group chat.
//
// Which origin, though, is a question `location.origin` does not always answer —
// see shareOrigin below.

import { MODE_BY_ID, bandwidthLimits } from '../radio/constants.js';
import { clamp } from './format.js';

export const SHARE_KEYS = ['freq', 'mode', 'bwl', 'bwh', 'zoom_freq', 'zoom_bw'];

// Absent is null, not zero. `Number(null)` is 0 and `Number('')` is 0, and a
// missing edge that reads as a real 0 turns a lone `bwh` into a filter pair with
// its low edge on the carrier — a passband nobody shared.
const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

/**
 * What a link says, from a query string. Everything is optional and anything
 * unreadable is left out rather than guessed at: a link is typed, forwarded and
 * truncated by chat clients, and half of one should still tune what it can.
 *
 * `frequency` also accepts v2's earlier `?frequency=`, which was in use before
 * this settled on v1's shorter name.
 */
export function readShareUrl(search) {
    const q = new URLSearchParams(search || '');
    const out = {};

    const freq = num(q.get('freq') ?? q.get('frequency'));
    if (freq > 0) out.frequency = freq;

    const mode = q.get('mode');
    if (mode && MODE_BY_ID[mode]) out.mode = mode;

    // Clamped to the mode's own limits, and only as a pair: one edge on its own
    // would be applied against whatever the other happened to be, which for a
    // link carrying a CW filter into an AM default is a passband the receiver
    // will refuse.
    const low = num(q.get('bwl'));
    const high = num(q.get('bwh'));
    if (low != null && high != null && high > low) {
        const l = bandwidthLimits(out.mode || 'usb');
        out.bandwidthLow = clamp(low, l.min, l.max);
        out.bandwidthHigh = clamp(high, l.min, l.max);
    }

    // The spectrum view: where it is pointed, and how wide one bin is — which
    // with the receiver's bin count is the zoom. Both or neither, because a
    // centre without a span is a pan and a span without a centre is a zoom, and
    // the link is meant to reproduce a picture rather than half of one.
    const centre = num(q.get('zoom_freq'));
    const binBandwidth = num(q.get('zoom_bw'));
    if (centre > 0 && binBandwidth > 0) {
        out.view = { frequency: centre, binBandwidth };
    }

    return out;
}

// The view a link arrived with, once.
//
// Once, because powering the receiver off and on again within a visit should come
// back to the view you left rather than the one you arrived on — the same rule
// the saved view follows, and the reason resumeView is read fresh at power-on
// rather than from a load-time snapshot.
let pendingView = undefined;

export function takeUrlView() {
    if (pendingView === undefined) {
        pendingView = readShareUrl(typeof location === 'undefined' ? '' : location.search).view || null;
    }
    const v = pendingView;
    pendingView = null;
    return v;
}

// Test seam.
export function _resetUrlView() {
    pendingView = undefined;
}

/**
 * The link itself.
 *
 * `zoom_bw` keeps three decimals: at the deepest zoom a bin is a fraction of a
 * hertz, and rounding it to an integer would land the recipient on a different
 * rung of the ladder from the one being shared.
 */
export function buildShareUrl({ origin, pathname, tuning, view } = {}) {
    const q = new URLSearchParams();
    if (tuning) {
        if (tuning.frequency > 0) q.set('freq', String(Math.round(tuning.frequency)));
        if (tuning.mode) q.set('mode', String(tuning.mode));
        if (Number.isFinite(tuning.bandwidthLow) && Number.isFinite(tuning.bandwidthHigh)) {
            q.set('bwl', String(Math.round(tuning.bandwidthLow)));
            q.set('bwh', String(Math.round(tuning.bandwidthHigh)));
        }
    }
    // Only once the server has told us what the spectrum is doing. Before that
    // there is no view to share, and inventing one would send the recipient
    // somewhere the sender never was.
    if (view && view.centerFreq > 0 && view.binBandwidth > 0) {
        q.set('zoom_freq', String(Math.round(view.centerFreq)));
        q.set('zoom_bw', String(Number(view.binBandwidth.toFixed(3))));
    }
    const base = `${origin || ''}${pathname || '/'}`;
    const qs = q.toString();
    return qs ? `${base}?${qs}` : base;
}

// --- which origin the link points at ---------------------------------------------
//
// Almost always `location.origin`: the address in the bar is the address that
// demonstrably reaches this receiver, and nothing configured anywhere can be
// more current than it. That holds for a LAN address as much as for a domain —
// a receiver shared with the other people on its own network wants the address
// those people use, not whatever it advertises to the internet.
//
// The exception is the desktop client (clients/electron), which runs a reverse
// proxy on loopback in front of the receiver and loads the window from it. There
// `location.origin` is http://127.0.0.1:17820 — not a hard-to-reach address of
// the receiver but no address of it at all, an artefact of how this one client
// happens to connect. What the receiver is actually being reached at is the
// address the client dialled, which its preload passes in as `upstreamOrigin`;
// that is what the link should carry, LAN address or not.
//
// `publicUrl` — `receiver.public_url` from /api/description, the operator's own
// declaration (config.go, ConstructPublicURL) — is the last resort only, for the
// one case where the address in hand is loopback and so reaches nobody: server
// and client on the same machine. Most instances publish nothing, which is why
// it cannot be the thing the link is built on.

// The placeholder ConstructPublicURL returns when instance reporting has no host
// or port configured — a real-looking URL for a receiver that is not there, and
// the one value in this whole path that would silently produce a link to
// somebody else's website.
const PLACEHOLDER_HOSTS = new Set(['example.com', 'www.example.com']);

// An origin, or null. Anything that is not an absolute http(s) URL is not an
// origin — including the empty string, `null` as a string, and the "origin" of a
// page opened from a file, which serialises as "null" and would otherwise
// concatenate into a link reading `null/v2/`.
function usableOrigin(value) {
    if (!value) return null;
    let url;
    try {
        url = new URL(String(value));
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    if (PLACEHOLDER_HOSTS.has(url.hostname.toLowerCase())) return null;
    // `origin` normalises away the trailing slash public_url arrives with, and
    // the default port, which is what makes this safe to concatenate a path onto.
    return url.origin;
}

// This machine, and only this machine.
//
// The single distinction worth drawing, and drawn no wider than that: a LAN
// address is a real address of the receiver and is kept, because the person it
// is being sent to is very often on that LAN. Loopback is the one address that
// is true for nobody but the sender.
function loopback(origin) {
    let host;
    try {
        host = new URL(origin).hostname.toLowerCase();
    } catch {
        return false;
    }
    // IPv6 arrives bracketed from `hostname`.
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host === '::1' || host === '::' || host === '') return true;
    // 127.0.0.0/8, and 0.0.0.0 — which is not loopback but is not an address
    // anybody can be sent to either.
    return /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0)$/.test(host);
}

/**
 * The origin a shared link should carry.
 *
 * `upstreamOrigin` is present under the desktop client and absent in a browser,
 * which is the whole of the difference between the two cases.
 *
 * Returns '' if nothing usable is on offer, which leaves buildShareUrl making a
 * relative link — still copyable, still readable, and honest about knowing no
 * address rather than inventing one.
 */
export function shareOrigin({ origin, publicUrl, upstreamOrigin } = {}) {
    // Where the receiver is being reached, as opposed to where this page is
    // served from. The two differ only under the desktop client, and there it is
    // the page that is the odd one out.
    const reached = usableOrigin(upstreamOrigin) || usableOrigin(origin);
    if (reached && !loopback(reached)) return reached;

    // Loopback: nothing about this address travels, so the only thing left worth
    // sending is whatever the receiver publishes about itself. Usually nothing.
    return usableOrigin(publicUrl) || reached || '';
}

// What goes with the link, where the target takes a line of text as well.
//
// The frequency and mode in words, because in a chat window the URL is opaque —
// a row of query parameters says nothing about what is on the other end of it,
// and "have a listen to this" with no frequency in it is a link people do not
// click.
export function shareText({ tuning, receiver } = {}) {
    const mhz = tuning && tuning.frequency > 0
        ? `${(tuning.frequency / 1e6).toFixed(3)} MHz`
        : '';
    const mode = tuning && tuning.mode ? String(tuning.mode).toUpperCase() : '';
    const where = receiver && receiver.callsign ? ` on ${receiver.callsign}` : '';
    const what = [mhz, mode].filter(Boolean).join(' ');
    return what ? `Listening to ${what}${where}` : `Listening${where}`;
}

// Where a link can be sent, in the order they are offered.
//
// Web intents, every one of them: a URL the target opens in a new tab, with no
// script of theirs on this page and no account of ours. That rules out the ones
// which only work through an SDK, and it is why there is no "post to Mastodon" —
// there is no single address to post to, only whichever instance the sender is
// on, which is a question this menu cannot ask in one click.
//
// `href(url, text)` — both already encoded by the caller.
export const SHARE_TARGETS = [
    {
        id: 'email',
        label: 'Email',
        href: (url, text) => `mailto:?subject=${encodeURIComponent(text)}&body=${encodeURIComponent(`${text}\n\n${url}`)}`,
    },
    {
        id: 'whatsapp',
        label: 'WhatsApp',
        href: (url, text) => `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`,
    },
    {
        id: 'telegram',
        label: 'Telegram',
        href: (url, text) => `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`,
    },
    {
        id: 'x',
        label: 'X',
        href: (url, text) => `https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`,
    },
    {
        id: 'facebook',
        label: 'Facebook',
        // Facebook's sharer takes the URL only and reads the page's own metadata
        // for the rest, so the text is deliberately not passed: it would be
        // dropped, and a parameter that is ignored is one somebody later spends
        // an afternoon on.
        href: (url) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
    },
    {
        id: 'reddit',
        label: 'Reddit',
        href: (url, text) => `https://www.reddit.com/submit?url=${encodeURIComponent(url)}&title=${encodeURIComponent(text)}`,
    },
];

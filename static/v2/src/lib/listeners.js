// Who else is listening — v1's "Active Channels" block, as data.
//
// `/stats` reports one entry per audio session: where it is tuned, how long
// since it was last active, and — where the operator has GeoIP and chat — the
// country, position and chat name behind it. v1 asks with `session_id` so the
// server puts *your* session first, and both the panel and channels-map.html
// rely on that ordering to mark which row is you.
//
// That id is the server's session key from the `status` message, not the
// browser's own UUID — see getServerSessionId. The reply carries no ids at all,
// so position is the only way to tell which row is yours, and asking with the
// wrong id silently makes it somebody else's.
//
// The poll is shared and refcounted, like the voice-activity one: the panel
// wants it while it is open, and the map popup wants it for as long as it is
// on screen — which outlives the panel, since a collapsed section is unmounted.
// One loop serves both, and nothing polls when neither is watching.

import { getServerSessionId } from '../radio/session.js';
import { feedInterval, setFeedsAllowed } from './serverFeeds.js';

// v1's cadence (app.js startStatsUpdates).
export const POLL_MS = 10000;

export function endpoint(sessionId) {
    return sessionId ? `/stats?session_id=${encodeURIComponent(sessionId)}` : '/stats';
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * The server's channel list, in the shape the panel and the map want.
 *
 * `you` is the first entry when the request carried a session id — the server
 * hoists that session to the front, and there is no other way to tell: the
 * reply deliberately carries no session ids at all.
 */
export function normaliseChannels(raw, hasSession) {
    const list = Array.isArray(raw && raw.channels) ? raw.channels : [];
    return list.map((c, i) => ({
        // The server's own index, which is what the map labels its pins with.
        index: num(c.index) != null ? num(c.index) : i,
        you: hasSession && i === 0,
        frequency: num(c.frequency) || 0,
        mode: String(c.mode || '').toLowerCase(),
        bandwidthLow: num(c.bandwidth_low) || 0,
        bandwidthHigh: num(c.bandwidth_high) || 0,
        lastActive: c.last_active ? Date.parse(c.last_active) : null,
        country: c.country || '',
        countryCode: c.country_code || '',
        lat: num(c.latitude),
        lon: num(c.longitude),
        chatUsername: c.chat_username || '',
        // The raw entry, for channels-map.html: it reads the server's own field
        // names off `window.activeChannels` and must not see ours.
        raw: c,
    }));
}

// v1's wording (app.js displayActiveChannels): seconds, then minutes, then
// hours. Anything in the future — a clock skewed between server and browser —
// reads as "now" rather than a negative age.
export function activeLabel(atMs, nowMs) {
    if (!atMs) return '';
    const secs = Math.max(0, Math.floor((nowMs - atMs) / 1000));
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    return `${Math.floor(secs / 3600)}h ago`;
}

// v1 refuses to tune to an IQ channel, and so does this: there is no audio to
// listen to and the passband means something else entirely.
export function tunable(channel) {
    return !!channel && !channel.you && channel.mode !== 'iq' && channel.frequency > 0;
}

// --- shared polling ---------------------------------------------------------

const subscribers = new Set();
let timer = null;
let latest = null;
let inFlight = false;

function emit(state) {
    latest = state;
    for (const fn of subscribers) {
        try { fn(state); } catch (err) { console.error('listeners subscriber threw', err); }
    }
}

function load() {
    if (inFlight) return;
    inFlight = true;
    const session = getServerSessionId();
    fetch(endpoint(session))
        .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        })
        .then((d) => emit({ channels: normaliseChannels(d, !!session), error: '', at: Date.now() }))
        .catch((err) => {
            // Keep the last list and report alongside it: one failed poll is
            // not everybody leaving.
            emit({
                channels: (latest && latest.channels) || [],
                error: err.message || String(err),
                at: latest ? latest.at : 0,
            });
        })
        .finally(() => { inFlight = false; });
}

export function subscribeListeners(fn) {
    subscribers.add(fn);
    // Replay, so a panel opening mid-cycle renders at once rather than sitting
    // on "Loading…" for up to ten seconds.
    if (latest) {
        try { fn(latest); } catch (err) { console.error('listeners subscriber threw', err); }
    }
    if (timer === null) {
        timer = feedInterval(load, POLL_MS);
    }
    return () => {
        subscribers.delete(fn);
        if (subscribers.size === 0 && timer !== null) {
            timer();
            timer = null;
        }
    };
}

// Test seam.
export function _resetListeners() {
    // A store under test polls: the feed gate is the receiver's business, it
    // has its own tests, and every case here is about this module's refcounting
    // rather than about being switched off. See lib/serverFeeds.js.
    setFeedsAllowed(true);
    subscribers.clear();
    if (timer !== null) timer();
    timer = null;
    latest = null;
    inFlight = false;
}

// The announced DX operations calendar, from /api/dxpeditions.
//
// The server fetches NG3K's ADXO feed every six hours, parses it and enriches
// each announcement with what this receiver can say about it — where it is, how
// far away and on what bearing, and whether any of its announced bands are
// inside the tuning range. See dxpeditions.go. Everything here is the client
// half: a store the registry can ask synchronously, and the pure shaping the
// panel renders.
//
// ── Why this is a store and not a fetch inside the panel ────────────────────
//
// The panel is absent on a receiver whose calendar is empty or unreachable, and
// "absent" is a decision the panel cannot make: the registry is read before the
// first render and every place that lists panels asks it. So the answer has to
// exist outside any component, on the pattern panels/custom/cache.js already
// uses for the same reason.
//
// The seed is only the COUNT, not the entries. It exists so a returning visitor
// does not watch the panel pop into their left dock a second after the page
// settles, and it is cleared the moment a fetch says the calendar is empty or
// cannot be reached — so a receiver that stops publishing one loses the panel
// on the next load rather than showing it and then taking it away again. The
// entries themselves are never persisted: they are somebody else's schedule and
// go stale, and a panel drawn from a week-old cache would state dates that have
// already passed as though they were current.

import { feedInterval } from './serverFeeds.js';

export const DXPED_URL = '/api/dxpeditions';

const SEED_KEY = 'ubersdr.v2.dxpeditions';

// The server refreshes every six hours and answers with Cache-Control max-age=300,
// so a poll faster than this buys nothing at all. Fifteen minutes is really about
// crossing the boundary of an operation's announced run while somebody has the
// panel open, which is the only thing that changes inside a server refresh.
export const DXPED_POLL_MS = 15 * 60 * 1000;

let state = { entries: [], loading: true, error: null, at: 0 };
let inFlight = null;
const listeners = new Set();

/** The last known count, read synchronously — safe at module init. */
function seedCount() {
    try {
        const n = Number(localStorage.getItem(SEED_KEY));
        return Number.isFinite(n) && n > 0 ? n : 0;
    } catch (e) {
        // Private mode or blocked site data. No seed is the first-load case,
        // which is a state this has to handle anyway.
        return 0;
    }
}

let present = seedCount() > 0;

/**
 * Whether this receiver has a calendar worth a panel — what the registry gate
 * asks. True while the seed says the last load found something, then whatever
 * the current fetch found.
 */
export function dxpeditionsPresent() {
    return present;
}

/** Everything the panel needs: the entries, and whether they arrived. */
export function dxpeditionState() {
    return state;
}

export function onDXpeditions(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function publish(next) {
    state = next;
    present = next.entries.length > 0;
    try {
        if (present) localStorage.setItem(SEED_KEY, String(next.entries.length));
        else localStorage.removeItem(SEED_KEY);
    } catch (e) { /* private mode */ }
    for (const fn of Array.from(listeners)) fn(state);
    return state;
}

/** Only the fields the panel reads, and nothing a hostile payload could smuggle. */
function clean(body) {
    const rows = body && Array.isArray(body.entries) ? body.entries : [];
    const out = [];
    for (const e of rows) {
        if (!e || typeof e !== 'object') continue;
        if (typeof e.call !== 'string' || !e.call) continue;
        out.push(e);
    }
    return out;
}

/**
 * Fetch the calendar and publish it.
 *
 * A failure publishes EMPTY rather than keeping what was there. That is the
 * opposite of what most of the feeds in this app do, and it is deliberate: the
 * panel's whole existence is conditional on the endpoint answering, so an error
 * that left the last good list in place would leave a panel standing on a
 * receiver that can no longer fill it. The server already holds the last good
 * copy across its own failures — see the stale-on-error path in dxpeditions.go —
 * so by the time a failure reaches here, it is not a blip.
 */
export function refreshDXpeditions() {
    if (inFlight) return inFlight;
    inFlight = fetch(DXPED_URL, { cache: 'no-store' })
        .then(async (res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return clean(await res.json());
        })
        .then((entries) => publish({ entries, loading: false, error: null, at: Date.now() }))
        .catch((err) => publish({
            entries: [], loading: false, error: err.message || String(err), at: Date.now(),
        }))
        .then((s) => { inFlight = null; return s; });
    return inFlight;
}

/**
 * Keep the calendar fresh while something is watching it.
 *
 * Gated by serverFeeds, so a stopped receiver stops polling — unlike the single
 * load at startup, which is a one-shot and is not a feed. Returns a stop.
 */
export function pollDXpeditions() {
    return feedInterval(() => refreshDXpeditions(), DXPED_POLL_MS);
}

// ── Shaping, all pure ───────────────────────────────────────────────────────

/**
 * A stable identity for a row.
 *
 * The feed carries no id of its own, and the callsign alone is not unique: a
 * third of the entries are a bare PREFIX, so two announcements for two different
 * operations from Iceland are both "TF". The start date separates them.
 */
export function dxpedKey(e) {
    return `${e.call}|${e.start_unix}`;
}

/** On the air right now, by the server's inclusive range. */
export function isActive(e, now = Date.now()) {
    const t = Math.floor(now / 1000);
    return e.start_unix <= t && t <= e.end_unix;
}

/**
 * What the panel lists: the active operations, or everything, in the order a
 * calendar wants — soonest first, and among simultaneous ones the one ending
 * first, because that is the one you have least time to catch.
 */
export function visibleDXpeditions(entries, { all = false, now = Date.now() } = {}) {
    const rows = all ? entries.slice() : entries.filter((e) => isActive(e, now));
    rows.sort((a, b) => (
        a.start_unix - b.start_unix
        || a.end_unix - b.end_unix
        || a.call.localeCompare(b.call)
    ));
    return rows;
}

const DAY = 86400;

/**
 * The one line under a row that says where in its run an operation is.
 *
 * Days rather than hours throughout: the source announces dates and nothing
 * finer, so "ends in 4 h" would be a precision the announcement never had. The
 * last day counts as "ends today" rather than rounding to zero days left.
 */
export function runLabel(e, now = Date.now()) {
    const t = Math.floor(now / 1000);
    if (t < e.start_unix) {
        const days = Math.ceil((e.start_unix - t) / DAY);
        return days <= 1 ? 'starts tomorrow' : `starts in ${days} days`;
    }
    if (t > e.end_unix) return 'finished';
    const left = Math.floor((e.end_unix - t) / DAY);
    if (left <= 0) return 'last day';
    return left === 1 ? 'ends tomorrow' : `${left} days left`;
}

/**
 * Bands as a row of chips, shortened when an announcement claims most of HF.
 *
 * "HF" in the source expands to nine bands server-side, which is right for
 * filtering and useless as a list in a dock column three inches wide.
 */
export function bandLabel(bands, max = 4) {
    if (!bands || !bands.length) return '';
    if (bands.length <= max) return bands.join(' ');
    return `${bands.slice(0, max).join(' ')} +${bands.length - max}`;
}

/**
 * What to listen for, and how many more there are.
 *
 * `call` is already the answer: the server promotes a recovered callsign into
 * it, so an operation announced before its licence came through arrives as
 * "PJ2/K5SL" with the prefix it was announced under in `announced_as`. Nothing
 * here has to reconstruct that — this exists to say the other two things in one
 * place.
 *
 * `more` is the operators beyond the first, for an operation sending several:
 * the row names one and says there are others rather than growing a line for
 * them. `known` is false only when the announcement never said what callsign
 * would be used — two entries in the whole feed, and the only case where there
 * is nothing to listen for.
 */
export function listenFor(e) {
    const ops = e.operating_calls || [];
    return { call: e.call, more: Math.max(0, ops.length - 1), known: !e.prefix_only };
}

/**
 * Where to put the pin, in the shape components/CallsignMap.jsx wants.
 *
 * `fromGrid` is the map's "do not zoom to street level" flag, and it is set for
 * every centroid as well as for a locator: a DXCC entity's centre is a whole
 * country's worth of imprecision, which is far more than a grid square's.
 */
export function positionOf(e) {
    if (e.latitude == null || e.longitude == null) return null;
    return { lat: e.latitude, lon: e.longitude, fromGrid: e.position_source !== 'grid' };
}

/** What placed the pin, in words, for the caveat under a map. */
export function placedBy(e) {
    switch (e.position_source) {
        case 'grid':
            return `from the locator ${e.grid} in the announcement`;
        case 'entity':
            return `the centre of ${e.country || e.entity} — the entity the announcement names`;
        case 'callsign':
            return `the centre of ${e.country || e.entity}, from the callsign's prefix`;
        default:
            return '';
    }
}

/** "1 234 km  ·  ENE 067°" — the beam heading, when the receiver has a position. */
export function bearingLabel(e) {
    if (e.distance_km == null || e.bearing_deg == null) return '';
    const points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
        'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const compass = points[Math.round(e.bearing_deg / 22.5) % 16];
    const km = Math.round(e.distance_km).toLocaleString();
    return `${km} km · ${compass} ${String(Math.round(e.bearing_deg)).padStart(3, '0')}°`;
}

/** The announced run as dates, preferring the source's own wording. */
export function datesLabel(e) {
    return e.dates || '';
}

/**
 * The operation's own page, when there is one and it is safe to link.
 *
 * The server already refuses anything that is not http(s) at parse time. This
 * is the second check, at the point a URL would actually reach the browser,
 * because the cost of being wrong here is an operator clicking it.
 */
export function websiteOf(e) {
    const url = typeof e.website === 'string' ? e.website.trim() : '';
    if (!url) return '';
    return /^https?:\/\//i.test(url) ? url : '';
}

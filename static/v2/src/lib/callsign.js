// Callsign lookup: normalisation, geometry and the /api/lookup call.
//
// The server proxies a lookup provider (QRZ) and augments the reply from the
// CTY database, so one request answers "who is this, where are they, and how
// far away". Everything here is the part worth testing on its own — the panel
// is presentation.
//
// Two rules from the server that shape the UI:
//
//   * /api/lookup requires an *active audio session* for the UUID, not merely a
//     registered one. Spectrum-only viewers get 401. So the panel cannot work
//     before the receiver is started, and has to say so rather than showing a
//     bare error.
//   * the reply is rate limited per UUID, with cache hits allowed ten times the
//     normal rate — which is why repeating a lookup is cheap and hammering new
//     callsigns is not.

// v1's rule (app.js _normaliseCallsign, and the same reduce in the widget and
// voice-activity.html): a spot may be "GB4XYZ/P" or "F/GB4XYZ", and the longest
// slash-separated segment is the callsign in both shapes.
export function normaliseCallsign(raw) {
    if (!raw) return '';
    return String(raw).trim().toUpperCase()
        .split('/')
        .reduce((a, b) => (b.length > a.length ? b : a), '');
}

// What the server will accept (lookup_api.go reValidCallsign), checked here so
// an obvious typo costs no request and no rate-limit budget.
export function isValidCallsign(call) {
    return /^[A-Z0-9]{3,10}$/.test(call || '');
}

// Maidenhead locator -> centre of the square. Same decode as v1's
// maidenhead.js, but returning null on bad input rather than throwing: this is
// fed straight from a provider field that is often blank or malformed.
export function maidenheadToLatLon(locator) {
    if (typeof locator !== 'string') return null;
    const loc = locator.trim().toUpperCase();
    if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(loc)) return null;

    let lon = -180 + (loc.charCodeAt(0) - 65) * 20 + parseInt(loc[2], 10) * 2;
    let lat = -90 + (loc.charCodeAt(1) - 65) * 10 + parseInt(loc[3], 10) * 1;

    if (loc.length >= 6) {
        lon += (loc.charCodeAt(4) - 65) * (2 / 24);
        lat += (loc.charCodeAt(5) - 65) * (1 / 24);
        // Centre of the subsquare rather than its corner.
        lon += 1 / 24;
        lat += 0.5 / 24;
    } else {
        lon += 1;
        lat += 0.5;
    }
    return { lat, lon };
}

// Great-circle distance in km and initial bearing in degrees, as the widget
// computes them (haversine on a 6371 km sphere).
export function distanceBearing(fromLat, fromLon, toLat, toLon) {
    if ([fromLat, fromLon, toLat, toLon].some((v) => !Number.isFinite(v))) return null;
    const rad = (d) => (d * Math.PI) / 180;
    const R = 6371;

    const p1 = rad(fromLat);
    const p2 = rad(toLat);
    const dp = rad(toLat - fromLat);
    const dl = rad(toLon - fromLon);

    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    const distKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    const bearing = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;

    return {
        distKm: Math.round(distKm),
        // Rounded *then* wrapped: 359.7° rounds to 360, which is not a bearing
        // and which a rotator would refuse. v1's widget has this off-by-one.
        bearing: Math.round(bearing) % 360,
    };
}

// Where the operator is, from whatever the lookup gave us: the provider's own
// position if it has one, otherwise the centre of their grid square. The widget
// makes the same choice, and the distinction matters — a grid square is 3-5 km
// across at best, so a bearing from one is an approximation.
/**
 * A great-circle path between two points, as [lat, lon] pairs for a polyline.
 *
 * Drawn as a curve because it is one: a straight line on a Mercator map between
 * two distant points is not the path the signal took, and on HF the difference
 * is most of what makes a contact interesting. This is v1's own interpolation
 * (callsign_lookup.html, geodesicPoints) so the two frontends draw the same arc.
 *
 * `steps` segments, which at 64 is smooth at any zoom a panel map reaches.
 */
export function geodesicPoints(lat1, lon1, lat2, lon2, steps = 64) {
    const rad = (d) => (d * Math.PI) / 180;
    const deg = (r) => (r * 180) / Math.PI;
    const p1 = rad(lat1);
    const l1 = rad(lon1);
    const p2 = rad(lat2);
    const l2 = rad(lon2);
    const d = 2 * Math.asin(Math.sqrt(
        Math.sin((p2 - p1) / 2) ** 2
        + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2,
    ));
    // The same point twice: one vertex, and no division by a sine of nothing.
    if (!d || !Number.isFinite(d)) return [[lat1, lon1]];
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        const A = Math.sin((1 - f) * d) / Math.sin(d);
        const B = Math.sin(f * d) / Math.sin(d);
        const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
        const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
        const z = A * Math.sin(p1) + B * Math.sin(p2);
        pts.push([deg(Math.atan2(z, Math.sqrt(x * x + y * y))), deg(Math.atan2(y, x))]);
    }
    return pts;
}

export function positionOf(data) {
    if (!data) return null;
    const lat = Number(data.lat);
    const lon = Number(data.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon)) {
        return { lat, lon, fromGrid: false };
    }
    const grid = maidenheadToLatLon(data.grid);
    return grid ? { ...grid, fromGrid: true } : null;
}

// The display name, preferring the provider's preformatted one.
export function displayName(data) {
    if (!data) return '';
    if (data.name_fmt) return data.name_fmt;
    return [data.fname, data.nickname ? `"${data.nickname}"` : '', data.name]
        .filter(Boolean).join(' ');
}

/**
 * Whether a lookup answered with an actual station, rather than merely answering.
 *
 * The transport already rejects the obvious misses — a 404, a provider that says it
 * has never heard of the call, an empty body — so this is about the record that comes
 * back as `{}`, or as a bare echo of what was asked. A caller that only *displays* a
 * lookup can ignore the distinction, because an empty result renders as nothing much
 * either way; one that *acts* on it cannot. The announcer is the case: sending a
 * callsign in Morse because a provider replied at all would announce every typo.
 *
 * One identifying field is enough, and any of them will do — plenty of records have a
 * country and no name, or a grid and neither.
 */
export function identified(data) {
    if (!data || typeof data !== 'object') return false;
    const cty = data.cty || {};
    return !!(displayName(data) || data.country || cty.country || data.grid
        || data.class || data.qth || data.image);
}

/**
 * Whether a failure says anything about the callsign, or only about the moment.
 *
 * A 401 means the audio session is not registered *yet* — the Markers panel asks
 * the instant the receiver starts, which is before the server has the session.
 * A 429 means not now, a 503 means the service is off, a dropped connection
 * means nothing at all. None of those are facts about the callsign, and caching
 * them as "no such station" leaves the operator's name blank for the rest of the
 * page. A 404, or a provider that answered and said it has never heard of the
 * call, is a fact — worth remembering so the dial crossing that spot again does
 * not spend a rate-limit slot re-asking.
 */
export function lookupRetryable(status) {
    return status !== 404;
}

// HTTP status -> something an operator can act on. The bare server text for 401
// ("an active audio session is required to use this endpoint") is accurate but
// does not tell anyone what to do about it.
export function lookupError(status, body) {
    if (status === 401) return 'Start the receiver first — lookups need an active audio session.';
    if (status === 429) return 'Too many lookups — wait a moment and try again.';
    if (status === 503) return 'The lookup service is disabled on this receiver.';
    if (status === 404) return 'Not found.';
    return (body && body.error) || `Lookup failed (HTTP ${status}).`;
}

// Lookups in flight, by callsign. Not a result cache — the server already keeps
// one for a day — but a guard against the same callsign being asked for twice
// at the same moment by two different parts of the UI.
//
// Which is exactly what clicking a marker did: the Markers panel asked so it
// could show the operator's name, and the same click drove the Callsign panel,
// which asked again. Two requests, two rate-limit slots, one answer wanted.
// Sharing the promise means both get the result — and both get the error, so
// neither has to care that it was not the one who sent it.
const inFlight = new Map();

export function lookupCallsignData(callsign, uuid) {
    if (!uuid) {
        const err = new Error('No session — start the receiver first.');
        err.retryable = true;
        return Promise.reject(err);
    }
    const key = `${normaliseCallsign(callsign)}|${uuid}`;
    const already = inFlight.get(key);
    if (already) return already;

    const request = fetchLookup(callsign, uuid)
        .finally(() => { inFlight.delete(key); });
    inFlight.set(key, request);
    return request;
}

async function fetchLookup(callsign, uuid) {
    const url = `/api/lookup?callsign=${encodeURIComponent(callsign)}&uuid=${encodeURIComponent(uuid)}`;
    let resp;
    try {
        resp = await fetch(url);
    } catch (err) {
        // Offline, or the receiver went away mid-request.
        err.retryable = true;
        throw err;
    }
    const body = await resp.json().catch(() => null);
    if (!resp.ok) {
        const err = new Error(lookupError(resp.status, body));
        err.retryable = lookupRetryable(resp.status);
        throw err;
    }
    // A 200 can still carry an error field — the provider may have answered
    // "no such callsign" without that being an HTTP failure. It answered, so
    // this one is not worth asking again.
    if (body && body.error) {
        const err = new Error(body.error);
        err.retryable = false;
        throw err;
    }
    if (!body) {
        const err = new Error('Lookup returned nothing.');
        err.retryable = true;
        throw err;
    }
    lookupAnswered(normaliseCallsign(callsign), body);
    return body;
}

// --- answers ------------------------------------------------------------------
//
// Every lookup in the app ends up here — the Callsign panel's search box, a click on
// a spot, a marker the dial has landed on, the Media Session fetching artwork — so
// this is the one place that knows a lookup has come back and what it said.
//
// It exists for the announcer, and the reason it is here rather than in the panel is
// the reason AnnounceWatch is not in the Announcements panel: a collapsed dock section
// is unmounted, and a receiver that stops announcing because a panel was closed is a
// puzzle. Announcing from the panel also missed every lookup the panel did not make
// itself, which is most of them.

const answerListeners = new Set();

/** Called with (callsign, data) each time a lookup comes back with a record. */
export function onLookupAnswer(fn) {
    answerListeners.add(fn);
    return () => answerListeners.delete(fn);
}

function lookupAnswered(call, data) {
    for (const fn of Array.from(answerListeners)) {
        try { fn(call, data); } catch (e) { console.error('lookup answer listener threw', e); }
    }
}

/** Test seam. */
export function _resetInFlight() {
    inFlight.clear();
    pending = null;
}

// --- in-app lookup requests -------------------------------------------------
//
// Clicking a spot elsewhere in the UI should land in the panel. A module-level
// list rather than context: the panel is unmounted while its section is
// collapsed, and the sender should neither know nor care.

const listeners = new Set();

// A request made a moment before anything was listening — see `retain` below.
let pending = null;
// How long one waits. A panel being revealed is listening on the next render,
// so this only has to cover a frame or two; it is seconds rather than
// milliseconds because a slow first mount is still the same gesture, and a
// window this short cannot collect anything the operator has forgotten about.
const PENDING_MS = 3000;

export function onLookupRequest(fn) {
    listeners.add(fn);
    // Whatever was asked for while this panel was still mounting. Consumed
    // rather than broadcast: it was one request, and a second panel registering
    // later must not answer it again.
    if (pending && Date.now() - pending.at <= PENDING_MS) {
        const { call, auto } = pending;
        pending = null;
        try { fn(call, { auto }); } catch (e) { console.error('lookup listener threw', e); }
    } else {
        pending = null;
    }
    return () => listeners.delete(fn);
}

/**
 * Ask whatever is listening to look a callsign up.
 *
 * Returns true if anything was listening, so a caller can fall back (the voice
 * activity panel routes to the v1 popup when the panel is closed).
 *
 * `auto` marks a request nobody typed or clicked — the Markers panel asking
 * about whatever the dial has landed on. The difference matters at the far end:
 * a lookup you asked for and cannot have should say why, and one that happened
 * on your behalf should fail quietly rather than putting an error on screen
 * about something you did not do.
 *
 * `retain` keeps the request for a listener that is about to exist, which is
 * for one caller: the top bar's lookup inside an app reveals the Callsign panel
 * and then asks. Revealing takes a render, so the panel is not listening yet —
 * the panel opened and sat empty, which looked like a lookup that had silently
 * failed. Off by default because the return value is a fallback signal
 * elsewhere: the voice activity panel opens the v1 popup when nothing answered,
 * and a request retained behind that would be looked up twice.
 */
export function requestLookup(callsign, { auto = false, retain = false } = {}) {
    const call = normaliseCallsign(callsign);
    if (!call) return false;
    if (listeners.size === 0) {
        pending = retain ? { call, auto, at: Date.now() } : null;
        return false;
    }
    for (const fn of listeners) {
        try { fn(call, { auto }); } catch (e) { console.error('lookup listener threw', e); }
    }
    return true;
}

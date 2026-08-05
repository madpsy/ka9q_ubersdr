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
    if (!uuid) return Promise.reject(new Error('No session — start the receiver first.'));
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
    const resp = await fetch(url);
    const body = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error(lookupError(resp.status, body));
    // A 200 can still carry an error field — the provider may have answered
    // "no such callsign" without that being an HTTP failure.
    if (body && body.error) throw new Error(body.error);
    if (!body) throw new Error('Lookup returned nothing.');
    return body;
}

/** Test seam. */
export function _resetInFlight() {
    inFlight.clear();
}

// --- in-app lookup requests -------------------------------------------------
//
// Clicking a spot elsewhere in the UI should land in the panel. A module-level
// list rather than context: the panel is unmounted while its section is
// collapsed, and the sender should neither know nor care.

const listeners = new Set();

export function onLookupRequest(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

// Returns true if anything was listening, so a caller can fall back (the voice
// activity panel routes to the v1 popup when the panel is closed).
export function requestLookup(callsign) {
    const call = normaliseCallsign(callsign);
    if (!call || listeners.size === 0) return false;
    for (const fn of listeners) {
        try { fn(call); } catch (e) { console.error('lookup listener threw', e); }
    }
    return true;
}

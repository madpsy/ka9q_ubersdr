// The NDB addon: aviation beacons, heard on LF.
//
// A non-directional beacon is a transmitter on 190-535 kHz that sends a two- or
// three-letter Morse ident, over and over, from a known place. The addon takes one or
// more wide IQ streams, finds every carrier in them, decodes each ident in parallel and
// names it from the OurAirports navaid list — so a receiver running it knows which
// beacons it can hear right now, and where they are. On a map that is a picture of
// propagation: groundwave by day reaching a few hundred kilometres, skywave at night
// reaching a thousand and more.
//
// The addon's own dashboard has everything: the spectrum, every carrier, the live Morse
// copy, the heard log, search. This panel is the map and the count, and the modal is the
// map several times the size with the beacons listed beside it.
//
// ── What it asks for ────────────────────────────────────────────────────────
//
// /api/beacons alone: the identified beacons heard within `max_age` seconds, each a few
// hundred bytes with its position, distance and SNR. It is the addon's endpoint for
// exactly this — a small, pollable answer to "what is being heard?" — and it applies
// the addon's own radius and known-list filters, so the panel draws what the dashboard
// does.

import { greatCircleKm } from './hfdl.js';
import { ZOOM_MIN, pxPerDeg } from './worldMap.js';

export const BASE = '/addon/ndb';

export const ADDON_NAME = 'ndb';

/** The addon's own dashboard, the same route the Addons panel links to. */
export const addonUrl = (base = BASE) => `${base}/`;

/** Is the addon on this receiver? Same test the other addon panels make. */
export function ndbAvailable(serverInfo) {
    const addons = serverInfo && serverInfo.addons;
    return Array.isArray(addons)
        && addons.some((n) => String(n).toLowerCase() === ADDON_NAME);
}

// How far back the panel looks. An hour: long enough to hold a beacon through the fades
// of a night-time skywave path, short enough that the map is tonight rather than the
// week. The addon refuses anything outside 1..604800 with a 400, so this is fixed here
// rather than taken from anywhere a typo could reach.
export const WINDOW_S = 3600;

export const beaconsUrl = (maxAge = WINDOW_S, base = BASE) =>
    `${base}/api/beacons?max_age=${encodeURIComponent(maxAge)}`;

// The addon re-reads its channels once a second and the list changes as idents are
// copied, which is every few seconds on a busy band. Five seconds is the rate the
// addon's endpoint is meant to be polled at, well inside the proxy's per-minute limit.
export const POLL_MS = 5000;

// A beacon that was being received and is not now is still worth drawing — it has faded,
// not gone — but faded, so the map says which are in right now. After ten minutes with
// nothing it is drawn fainter still: most likely a skywave path that has closed.
export const QUIET_MS = 10 * 60 * 1000;

const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

const str = (v) => String(v == null ? '' : v).trim();

/**
 * One beacon, in the shape the panel uses.
 *
 * Times are milliseconds: the addon deals in unix seconds, and mixing the two puts every
 * beacon in 1970. A beacon with no position — an ident the addon could not match, which
 * it only reports when asked to show unlisted ones — keeps `lat`/`lon` null: it can be
 * listed, not drawn.
 */
export function normaliseBeacon(raw) {
    if (!raw || typeof raw !== 'object' || !str(raw.ident)) return null;
    const khz = num(raw.freq_hz) != null ? num(raw.freq_hz) / 1000 : null;
    // The null check before the conversion, because Number(null) is 0 and an unlisted
    // beacon would otherwise be placed in the Gulf of Guinea.
    let lat = raw.lat == null ? null : num(raw.lat);
    let lon = raw.lon == null ? null : num(raw.lon);
    if (lat == null || lon == null || (lat === 0 && lon === 0)) { lat = null; lon = null; }
    const first = num(raw.first_heard);
    const last = num(raw.last_heard);
    return {
        // Ident and frequency: the same ident is used by different beacons on different
        // channels, and the same beacon is never on two.
        key: `${str(raw.ident).toUpperCase()}@${khz != null ? khz.toFixed(1) : '?'}`,
        ident: str(raw.ident).toUpperCase(),
        name: str(raw.name),
        country: str(raw.country).toUpperCase(),
        confirmed: !!raw.confirmed,
        khz,
        lat,
        lon,
        distKm: num(raw.dist_km),
        bearing: num(raw.bearing_deg),
        firstAt: first ? first * 1000 : 0,
        lastAt: last ? last * 1000 : 0,
        live: !!raw.live,
        snr: num(raw.snr_db),
        bestSnr: num(raw.best_snr_db),
    };
}

/**
 * The beacons in a /api/beacons reply: live first, strongest first among those, then
 * the rest most recently heard first.
 *
 * Accepts the reply object or its `beacons` array; anything else is an empty list rather
 * than a throw, since a proxy error page parsed as JSON is not a reason to blank the map.
 */
export function beaconList(reply) {
    const rows = Array.isArray(reply) ? reply : (reply && Array.isArray(reply.beacons) ? reply.beacons : []);
    const out = [];
    for (const raw of rows) {
        const b = normaliseBeacon(raw);
        if (b) out.push(b);
    }
    return out.sort((a, b) => {
        if (a.live !== b.live) return a.live ? -1 : 1;
        if (a.live) return (b.snr ?? -Infinity) - (a.snr ?? -Infinity);
        return b.lastAt - a.lastAt;
    });
}

/** Only the beacons that can be drawn. */
export const mappable = (beacons) => (beacons || []).filter((b) => b.lat != null && b.lon != null);

/** Heard, not live, and not for a while. */
export const isQuiet = (b, now = Date.now()) => !!(b && !b.live && b.lastAt && now - b.lastAt > QUIET_MS);

/**
 * The headline figures: how many are live, how many heard in the window, and the
 * furthest live one — which is the number that says how far the band is reaching tonight.
 */
export function ndbSummary(beacons, me = null) {
    let live = 0;
    let furthest = null;
    for (const b of beacons || []) {
        if (!b.live) continue;
        live++;
        const d = b.distKm != null ? b.distKm : (me && b.lat != null ? greatCircleKm(me, b) : null);
        if (d != null && (!furthest || d > furthest.km)) furthest = { beacon: b, km: d };
    }
    return { count: (beacons || []).length, live, furthest };
}

/** What to call a beacon: its ident, and its name when the list has one. */
export function beaconLabel(b) {
    if (!b) return '';
    return b.name ? `${b.ident} ${b.name}` : b.ident;
}

/** "341.0 kHz". NDBs sit on half-kHz channels, so one decimal is the resolution that matters. */
export function khzLabel(khz) {
    if (khz == null || !Number.isFinite(khz)) return '';
    return `${khz.toFixed(1)} kHz`;
}

/** "38 dB", or '' for a beacon with no reading. */
export function snrLabel(db) {
    if (db == null || !Number.isFinite(db)) return '';
    return `${Math.round(db)} dB`;
}

// ── The map's framing ──────────────────────────────────────────────────────
//
// HFDL is a world map because aeroplanes are everywhere. Beacons are not: they are within
// the addon's radius of the receiver, a couple of thousand kilometres at most, and a
// world map would put them all in one pixel. So the view frames the receiver and what it
// can hear, with a margin, and never zooms in past a regional scale however close the
// beacons are.

const MARGIN = 1.35;
const MIN_SPAN_DEG = 2.5;   // about 280 km of latitude: never closer than a region

// The deepest zoom, for the framing and for the buttons. worldMap's ZOOM_MAX (24) is a
// world map's — at 24 the panel's 320-pixel map still spans fifteen degrees, and a
// cluster of beacons within 150 km of the receiver is a knot in the middle of it. The
// projection is worldMap's and so are the coastlines; only how far in it may go differs,
// and that is kept here rather than raised for the HFDL map and the Countries game too.
export const NDB_ZOOM_MAX = 64;

/** worldMap's clampView with this map's zoom limit. */
export function clampNdbView(view, w, h) {
    const z = Math.min(NDB_ZOOM_MAX, Math.max(ZOOM_MIN, view.z));
    const s = pxPerDeg(w, z);
    const halfLon = (w / 2) / s;
    const halfLat = (h / 2) / s;
    return {
        z,
        lon: halfLon >= 180 ? 0 : Math.min(180 - halfLon, Math.max(-180 + halfLon, view.lon)),
        lat: halfLat >= 90 ? 0 : Math.min(90 - halfLat, Math.max(-90 + halfLat, view.lat)),
    };
}

/**
 * A view ({lon, lat, z}) for the worldMap projection that frames the receiver and the
 * beacons. With nothing to frame it centres on the receiver at a regional zoom, or on
 * the whole world with no receiver either.
 */
export function frameView(me, beacons, w, h) {
    const pts = [];
    if (me && Number.isFinite(me.lat) && Number.isFinite(me.lon)) pts.push(me);
    for (const b of mappable(beacons)) pts.push(b);
    if (!pts.length) return { lon: 0, lat: 0, z: 1 };
    let minLat = Infinity; let maxLat = -Infinity; let minLon = Infinity; let maxLon = -Infinity;
    for (const p of pts) {
        minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
        minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
    }
    const spanLat = Math.max(MIN_SPAN_DEG, (maxLat - minLat) * MARGIN);
    const spanLon = Math.max(MIN_SPAN_DEG * (w / h), (maxLon - minLon) * MARGIN);
    // The projection is pxPerDeg = (w / 360) * z in both axes, so the zoom that fits a
    // span is whichever axis is tighter.
    const z = Math.max(1, Math.min(NDB_ZOOM_MAX, 360 / spanLon, (360 * h) / (w * spanLat)));
    return { lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2, z };
}

/**
 * A ring of the given radius around a point, as [lon, lat] pairs — the destination-point
 * formula at every few degrees of bearing. Drawn on an equirectangular map it is an oval,
 * which is what a circle of fixed distance really is on one.
 */
export function rangeRing(centre, km, steps = 96) {
    const R = 6371;
    const d = km / R;
    const rad = Math.PI / 180;
    const lat1 = centre.lat * rad;
    const lon1 = centre.lon * rad;
    const out = [];
    for (let i = 0; i <= steps; i++) {
        const brg = (i / steps) * 2 * Math.PI;
        const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg));
        const lon2 = lon1 + Math.atan2(
            Math.sin(brg) * Math.sin(d) * Math.cos(lat1),
            Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
        );
        out.push([((lon2 / rad + 540) % 360) - 180, lat2 / rad]);
    }
    return out;
}

/** The range rings worth drawing for a view that reaches `maxKm` from the receiver. */
export function ringsFor(maxKm) {
    const all = [100, 250, 500, 1000, 2000, 3000];
    const out = all.filter((k) => k <= Math.max(250, maxKm * 1.1));
    return out.length ? out : [100];
}

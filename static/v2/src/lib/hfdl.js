// The HFDL addon: aircraft, heard on HF.
//
// HFDL is the datalink airliners use where there is no VHF and no satellite — the
// Pacific, the poles, the middle of the Atlantic. Each aircraft talks to one of about
// fifteen ground stations on a handful of shortwave frequencies, and the messages carry
// position reports. So a receiver running this addon knows where aeroplanes are, from
// half a world away, which is a thing worth putting on a map.
//
// The addon's own dashboard has everything: per-frequency statistics, the ground-station
// network, propagation, the raw message feed, the frequency configuration. This panel is
// the map and the count, and the modal is the map with the aircraft table beside it —
// the rest stays where it is, a click away.
//
// ── What it asks for, and what it leaves alone ───────────────────────────────
//
// /aircraft is the whole of the panel: a few hundred bytes per aircraft, and every field
// it draws. /groundstations is a second small request for the stations, which move only
// when the addon is restarted. /stats is 20 kB of per-frequency detail and is only asked
// for while the modal is open, and only for two figures out of it.
//
// There is an SSE feed as well. It carries every decoded message — position reports and
// ACARS text both — and this panel plots positions and counts messages, so a poll is the
// cheaper way round: an aircraft crossing an ocean moves a few miles in thirty seconds.

export const BASE = '/addon/hfdl';

export const ADDON_NAME = 'hfdl';

/** The addon's own dashboard, the same route the Addons panel links to. */
export const addonUrl = (base = BASE) => `${base}/`;

/** Is the addon on this receiver? Same test the other addon panels make. */
export function hfdlAvailable(serverInfo) {
    const addons = serverInfo && serverInfo.addons;
    return Array.isArray(addons)
        && addons.some((n) => String(n).toLowerCase() === ADDON_NAME);
}

export const aircraftUrl = (base = BASE) => `${base}/aircraft`;
export const stationsUrl = (base = BASE) => `${base}/groundstations`;
export const statsUrl = (base = BASE) => `${base}/stats`;

// The three per-aircraft routes, asked for once each when one is clicked and never
// otherwise: the track is up to 500 points, and the other two leave the receiver for an
// API somewhere else. Keyed differently on purpose — the track is by the addon's own
// aircraft key, the other two by ICAO hex, which is what the outside world indexes on.
export const trackUrl = (key, base = BASE) =>
    `${base}/aircraft/${encodeURIComponent(key)}/track`;
export const enrichUrl = (icao, base = BASE) =>
    `${base}/aircraft/${encodeURIComponent(icao)}/enrich`;
export const photoUrl = (icao, base = BASE) =>
    `${base}/aircraft/${encodeURIComponent(icao)}/photo`;

// How often the positions are re-read, and how often while the modal is open. An
// aircraft at 500 knots covers four miles in thirty seconds, which at the panel's map
// scale is less than a pixel; the modal is bigger and being looked at, so it is worth
// the faster rate while it is up.
export const POLL_MS = 30000;
export const MODAL_POLL_MS = 10000;

// When an aircraft stops being drawn. HFDL position reports come every ten to thirty
// minutes — it is a slow, half-duplex link shared by a whole ocean — so half an hour is
// "still out there" and an hour is "gone, or on another band".
export const STALE_MS = 30 * 60 * 1000;
export const DROP_MS = 60 * 60 * 1000;

/**
 * One aircraft, in the shape the panel uses.
 *
 * `at` is milliseconds: the addon deals in unix seconds and mixing the two puts every
 * aeroplane in 1970. Everything optional stays null rather than zero — an altitude of
 * zero is a report from the ground, which is a different claim from having no altitude.
 */
export function normaliseAircraft(raw) {
    if (!raw || typeof raw !== 'object') return null;
    // No position, no aircraft: this panel is a map, and the addon's own dashboard is
    // where a message from an aeroplane that has not said where it is still counts.
    //
    // The null check comes first and separately, because Number(null) is 0 — a record
    // with a longitude and no latitude would otherwise be drawn on the equator, which is
    // a confident claim about an aeroplane that has not made one.
    if (raw.lat == null || raw.lon == null) return null;
    const lat = Number(raw.lat);
    const lon = Number(raw.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
    const seen = Number(raw.last_seen);
    return {
        key: String(raw.key || raw.icao || raw.reg || `${lat},${lon}`),
        icao: String(raw.icao || '').toUpperCase(),
        reg: String(raw.reg || '').toUpperCase(),
        flight: String(raw.flight || '').toUpperCase().trim(),
        lat,
        lon,
        at: Number.isFinite(seen) ? seen * 1000 : 0,
        khz: Number(raw.freq_khz) || 0,
        gs: Number(raw.gs_id) || 0,
        msgs: Number(raw.msg_count) || 0,
        sig: num(raw.sig_level),
        alt: raw.alt_valid ? num(raw.alt_ft) : null,
        speed: num(raw.gnd_spd_kts),
        track: raw.true_trk_valid ? num(raw.true_trk_deg) : null,
        trackedKm: num(raw.tracked_km),
    };
}

// Null for "not reported", which is what the addon's `omitempty` leaves behind, and a
// number otherwise — including zero, because an aircraft at zero feet is on the ground
// and that is a reading rather than a gap.
const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

/**
 * What to call an aircraft, in the order somebody would recognise it.
 *
 * `aircraftLabel` rather than `label`, which is a local or a prop in about a hundred
 * files here — test/unresolved.js counted them, and it was right to.
 */
export function aircraftLabel(a) {
    if (!a) return '';
    return a.flight || a.reg || a.icao || a.key;
}

/**
 * The aircraft worth drawing, freshest first.
 *
 * Anything older than an hour is dropped rather than left on the map: an HFDL position
 * is a snapshot of an aeroplane doing 500 knots, and a two-hour-old dot is 1000 miles
 * from where that aircraft actually is. Half an hour to an hour is drawn faded — see
 * isStale — because "it was here and has not reported since" is still information.
 */
export function liveAircraft(rows, now = Date.now()) {
    const out = [];
    for (const raw of rows || []) {
        const a = normaliseAircraft(raw);
        if (!a) continue;
        if (a.at && now - a.at > DROP_MS) continue;
        out.push(a);
    }
    return out.sort((x, y) => y.at - x.at);
}

export const isStale = (a, now = Date.now()) => !!(a && a.at && now - a.at > STALE_MS);

/**
 * The ground stations, which are the other half of the picture.
 *
 * Every aircraft on the map is talking to one of these, and where the station is says
 * which way the path runs — a Reykjavik contact and a Johannesburg contact from the same
 * receiver are two very different bits of propagation. Only the ones with a position are
 * kept: a station the addon knows by name but not by place cannot be drawn.
 */
export function stationList(rows) {
    const out = [];
    for (const raw of rows || []) {
        if (!raw || typeof raw !== 'object') continue;
        const lat = Number(raw.lat);
        const lon = Number(raw.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || (!lat && !lon)) continue;
        const heard = Number(raw.last_heard);
        out.push({
            id: Number(raw.gs_id) || 0,
            name: String(raw.location || '').trim(),
            lat,
            lon,
            at: Number.isFinite(heard) && heard > 0 ? heard * 1000 : 0,
            active: !!raw.spdu_active,
        });
    }
    return out;
}

/** Which station an aircraft was last talking to, for the table. */
export function stationOf(stations, id) {
    if (!id) return null;
    return stations.find((s) => s.id === id) || null;
}

/**
 * The headline figures.
 *
 * Aircraft, and how many of those are current; the busiest frequency, because HFDL
 * moves around the bands with the ionosphere and which one is working is the thing an
 * operator would want to know; and the messages the addon has decoded altogether.
 */
export function hfdlSummary(aircraft, stats, now = Date.now()) {
    let fresh = 0;
    const byFreq = new Map();
    for (const a of aircraft) {
        if (!isStale(a, now)) fresh++;
        if (a.khz) byFreq.set(a.khz, (byFreq.get(a.khz) || 0) + 1);
    }
    let busiest = 0;
    let most = 0;
    for (const [khz, n] of byFreq) {
        if (n > most) { most = n; busiest = khz; }
    }
    // Ruled out before the conversion, for the same reason as above: Number(null) is 0,
    // and "no statistics fetched" would otherwise read as a receiver that has decoded
    // nothing.
    const total = stats && typeof stats === 'object' ? Number(stats.total_messages) : NaN;
    return {
        count: aircraft.length,
        fresh,
        busiest,
        onBusiest: most,
        messages: Number.isFinite(total) ? total : null,
    };
}

/** "13.276 MHz" from the addon's kilohertz. */
export function freqLabel(khz) {
    if (!khz) return '';
    return `${(khz / 1000).toFixed(3)} MHz`;
}

/** A compact "FL350" for an altitude in feet, which is how aviation says it. */
export function altLabel(ft) {
    if (ft == null || !Number.isFinite(ft)) return '';
    if (ft >= 18000) return `FL${Math.round(ft / 100)}`;
    return `${Math.round(ft / 100) * 100} ft`;
}

// ── Bands ───────────────────────────────────────────────────────────────────
//
// HFDL lives in about a dozen aeronautical allocations, and which one an aircraft is on
// is the single most useful thing to colour a dot by: the band *is* the propagation. Two
// aircraft on 21 MHz and 5 MHz at the same moment are two different paths, and on a map
// coloured by band that reads at a glance, where a table of frequencies does not.

/** The MHz allocation a frequency belongs to. 13276 kHz → 13. */
export const bandOf = (khz) => (khz ? Math.floor(khz / 1000) : 0);

// The allocations, low to high. The order is the palette index, so a band keeps its
// colour between sessions and between receivers — the addon assigns colours in the order
// it first hears a band, which makes 13 MHz blue on one night and orange on the next.
export const HFDL_BANDS = [2, 3, 4, 5, 6, 8, 10, 11, 13, 15, 17, 21];

// Twelve hues, distinguishable on both themes and away from the map's own furniture
// (--good for a live station, --warn for a stale aircraft). Ordered so that neighbouring
// bands — the ones most often on screen together — are not neighbouring hues.
const BAND_COLOURS = [
    '#8bd5ff', '#f0883e', '#7ee787', '#d2a8ff', '#ffd866', '#ff9ec7',
    '#5ac8c8', '#c9d1d9', '#a5b4fc', '#f97583', '#9ae6b4', '#e5b567',
];

/** The colour for a band, by its MHz. Grey for an aircraft with no frequency. */
export function bandColour(mhz) {
    if (!mhz) return '#8b949e';
    const i = HFDL_BANDS.indexOf(mhz);
    return BAND_COLOURS[(i >= 0 ? i : mhz) % BAND_COLOURS.length];
}

/**
 * The bands on the map right now, low to high, with how many aircraft are on each.
 *
 * This is the legend and the filter both: what is being heard tonight is not the list of
 * allocations, it is the three or four of them that are open.
 */
export function bandCounts(aircraft) {
    const by = new Map();
    for (const a of aircraft || []) {
        const b = bandOf(a.khz);
        by.set(b, (by.get(b) || 0) + 1);
    }
    return [...by.entries()]
        .map(([mhz, count]) => ({ mhz, count }))
        .sort((x, y) => x.mhz - y.mhz);
}

/** The aircraft left after the legend's switched-off bands are taken out. */
export function visibleAircraft(aircraft, off) {
    if (!off || !off.size) return aircraft;
    return (aircraft || []).filter((a) => !off.has(bandOf(a.khz)));
}

// ── One aircraft, in detail ─────────────────────────────────────────────────

/**
 * The ICAO hex to look an aircraft up by, or ''.
 *
 * The addon's `key` is "ICAO hex if known, else registration" — so a key that looks like
 * six hex digits is one, and a key that does not is a registration and no use to a
 * database indexed on the hex.
 */
export function icaoHex(a) {
    if (!a) return '';
    const hex = a.icao || (/^[0-9a-f]{6}$/i.test(a.key || '') ? a.key : '');
    return hex ? String(hex).toUpperCase() : '';
}

/** The position history, oldest first, in the same units as the live records. */
export function trackPoints(rows) {
    const out = [];
    for (const r of rows || []) {
        if (!r || r.lat == null || r.lon == null) continue;
        const lat = Number(r.lat);
        const lon = Number(r.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
        const t = Number(r.time);
        out.push({ lat, lon, at: Number.isFinite(t) ? t * 1000 : 0 });
    }
    return out;
}

const str = (v) => String(v == null ? '' : v).trim();

const airport = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const code = str(raw.iata) || str(raw.icao);
    const place = [str(raw.city), str(raw.country)].filter(Boolean).join(', ') || str(raw.name);
    if (!code && !place) return null;
    return { code, place };
};

/**
 * What the lookup knows about an aeroplane, or null if it knew nothing.
 *
 * Null rather than an object of empty strings: the panel shows a section only when there
 * is something in it, and "the lookup failed" and "the lookup returned a record with no
 * fields set" mean the same thing to somebody looking at the screen.
 */
export function enrichment(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {
        operator: str(raw.operator),
        type: str(raw.type),
        icaoType: str(raw.icao_type),
        manufacturer: str(raw.manufacturer),
        registration: str(raw.registration),
        country: str(raw.country),
        iataFlight: str(raw.iata_flight),
        airline: str(raw.airline_iata),
        from: airport(raw.origin),
        to: airport(raw.destination),
    };
    return Object.values(out).some(Boolean) ? out : null;
}

/** "LHR — London, United Kingdom" for one end of a route. */
export function airportLabel(ap) {
    if (!ap) return '';
    if (ap.code && ap.place) return `${ap.code} — ${ap.place}`;
    return ap.code || ap.place;
}

/**
 * The first Planespotters photo, in the size that fits a side panel.
 *
 * `thumbnail_large` is about 400 px wide, which is the column; the full-size original is
 * a megabyte and a half and there is nowhere here to put it.
 */
export function firstPhoto(json) {
    const list = json && Array.isArray(json.photos) ? json.photos : null;
    const p = list && list.length ? list[0] : null;
    if (!p) return null;
    const src = (p.thumbnail_large && p.thumbnail_large.src)
        || (p.thumbnail && p.thumbnail.src) || '';
    if (!src) return null;
    return { src, link: str(p.link), by: str(p.photographer) };
}

// ── Where it is, from here ──────────────────────────────────────────────────

const R_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;

/** Great-circle kilometres between two {lat, lon}, or null without both. */
export function greatCircleKm(from, to) {
    if (!from || !to) return null;
    const dLat = rad(to.lat - from.lat);
    const dLon = rad(to.lon - from.lon);
    const s = Math.sin(dLat / 2) ** 2
        + Math.cos(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** "271° W" — the number for the instrument and the point for the eye. */
export function headingLabel(deg) {
    if (deg == null || !Number.isFinite(deg)) return '';
    const d = ((deg % 360) + 360) % 360;
    return `${Math.round(d)}° ${POINTS[Math.round(d / 22.5) % 16]}`;
}

/** Kilometres, at the precision the number deserves. */
export function kmLabel(km) {
    if (km == null || !Number.isFinite(km)) return '';
    if (km >= 10000) return `${(km / 1000).toFixed(1)}k km`;
    return `${Math.round(km).toLocaleString()} km`;
}

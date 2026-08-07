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

// What the two ends of the start map are: the receiver's own position, and the
// listener's from /api/myip.
//
// Split out of the map itself because both have edge cases that only show up on
// somebody else's connection — a receiver with no position configured, a GeoIP
// lookup that knows the country but not the city, a VPN with no distance.

import { countryFlag } from './format.js';

export const MYIP_URL = '/api/myip';

// The answer, fetched once and kept.
//
// Two things want it now — the start map's greeting and the spectrum's stats
// readout — and they come and go at different times, so neither can own the
// request. It is also the same answer every time: a GeoIP lookup of the address
// this page connected from, which does not change under a session that is already
// open. So: one request per page, whoever asks first, and everybody after that
// gets what it said.
//
// A failure is not cached. The lookup is optional everywhere it is used — the map
// draws the receiver's pin without it — so a connection that was briefly down
// should not cost the whole session its greeting.
let cached = null;
let inFlight = null;

export function fetchMyIp() {
    if (cached) return Promise.resolve(cached);
    if (!inFlight) {
        inFlight = fetch(MYIP_URL)
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
                cached = d && typeof d === 'object' ? d : null;
                inFlight = null;
                return cached;
            })
            .catch(() => { inFlight = null; return null; });
    }
    return inFlight;
}

/** What is already known, without asking — null until the first fetch lands. */
export function peekMyIp() {
    return cached;
}

// Test seam.
export function _resetMyIp() {
    cached = null;
    inFlight = null;
}

// 0,0 is the config default rather than a position, which is why it cannot just
// be a null check — v1 tests the same way before drawing anything.
export function hasPosition(gps) {
    return !!(gps && Number.isFinite(gps.lat) && Number.isFinite(gps.lon) && (gps.lat !== 0 || gps.lon !== 0));
}

/**
 * v1's greeting under the map: "Hello Berlin, 🇩🇪 Germany (824 km) 🖥️".
 *
 * Empty when the lookup gave nothing to say. The parts are independent: a city
 * without a country reads as neither, a country without a distance still says
 * where you are, and the device is always known.
 */
export function greeting(myip, mobile) {
    if (!myip || !myip.country) return '';
    const parts = [];
    if (myip.city) parts.push(myip.city);
    const flag = countryFlag(myip.country_code);
    parts.push(flag ? `${flag} ${myip.country}` : myip.country);
    const km = Number(myip.distance_km);
    const distance = Number.isFinite(km) ? ` (${Math.round(km)} km)` : '';
    return `Hello ${parts.join(', ')}${distance} ${mobile ? '📱' : '🖥️'}`;
}

/**
 * The listener's coordinates, or null when the lookup had none.
 *
 * The absent check is deliberately not `Number(v)`: `Number(null)` is 0, which
 * is a perfectly finite number and would drop a pin off the coast of Africa for
 * anyone whose longitude the database does not know.
 */
const coord = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function myipPosition(myip) {
    if (!myip) return null;
    const lat = coord(myip.latitude);
    const lon = coord(myip.longitude);
    return lat == null || lon == null ? null : [lat, lon];
}

// The other public receivers on the start overlay's map.
//
// The list comes from this receiver, not from the directory: the server fetches
// the directory's short list every 15 minutes and answers /api/nearby-receivers
// from memory (nearby_receivers.go). So the visitor's browser only talks to the
// receiver it opened, and a receiver with no internet access answers at once
// with an empty list.
//
// It is decoration, and is handled as such. Any failure — the endpoint switched
// off (404), an older server without it, a slow answer, bad JSON — gives an
// empty list and never throws, and the fetch has its own timeout so it cannot
// hold anything open.

import { countryFlag } from './format.js';

export const NEARBY_URL = '/api/nearby-receivers';
export const NEARBY_TIMEOUT_MS = 4000;

function cleanUrl(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    try {
        const u = new URL(raw);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
        if (!u.host || u.username || u.password) return null;
        return u.href;
    } catch (e) {
        return null;
    }
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const int = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/**
 * The entries the map can place and link to. The server checks the same things,
 * but this is what turns a link into something a visitor clicks, so it does not
 * take that on trust.
 */
export function parseNearby(data) {
    const list = data && Array.isArray(data.receivers) ? data.receivers : [];
    const out = [];
    for (const r of list) {
        if (!r || typeof r !== 'object') continue;
        const lat = Number(r.lat);
        const lon = Number(r.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) continue;
        const url = cleanUrl(r.public_url);
        if (!url) continue;
        const km = Number(r.distance_km);
        out.push({
            id: str(r.id),
            callsign: str(r.callsign),
            name: str(r.name),
            location: str(r.location),
            countryCode: str(r.country_code),
            lat,
            lon,
            url,
            maxClients: int(r.max_clients),
            availableClients: int(r.available_clients),
            distanceKm: r.distance_km != null && Number.isFinite(km) ? km : null,
        });
    }
    return out;
}

/** Resolves to the list, or [] on any failure. Never rejects. */
export function fetchNearbyReceivers({ timeoutMs = NEARBY_TIMEOUT_MS, signal } = {}) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctl) ctl.abort(); }, timeoutMs);
    const onAbort = () => { if (ctl) ctl.abort(); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    let req;
    try {
        req = fetch(NEARBY_URL, ctl ? { signal: ctl.signal } : undefined);
    } catch (e) {
        req = Promise.reject(e);
    }
    // Raced against the timer too, for a fetch that ignores the abort.
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs + 50));
    return Promise.race([
        Promise.resolve(req).then((r) => (r && r.ok ? r.json() : null)),
        timeout,
    ])
        .then(parseNearby)
        .catch(() => [])
        .finally(() => {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
        });
}

/**
 * What the popup says, as plain text — the callsign as the heading, then the
 * name and the place, then distance and free slots on one line. Fields the
 * receiver did not fill in are left out rather than shown blank.
 */
export function popupText(r) {
    const title = r.callsign || r.name || 'Receiver';
    const name = r.callsign && r.name ? r.name : '';
    const flag = countryFlag(r.countryCode);
    const location = r.location ? (flag ? `${flag} ${r.location}` : r.location) : '';
    const facts = [];
    if (r.distanceKm != null) facts.push(`${Math.round(r.distanceKm).toLocaleString('en-GB')} km away`);
    if (r.maxClients > 0) facts.push(`${Math.min(r.availableClients, r.maxClients)}/${r.maxClients} slots free`);
    return { title, name, location, facts: facts.join(' · ') };
}

/**
 * The popup as DOM, built with textContent throughout: every string in it came
 * from another receiver's operator, by way of the directory.
 */
export function buildPopup(doc, r, open = defaultOpen) {
    const t = popupText(r);
    const root = doc.createElement('div');
    root.className = 'startmap-pop__body';
    const line = (cls, text) => {
        if (!text) return;
        const el = doc.createElement('div');
        el.className = cls;
        el.textContent = text;
        root.appendChild(el);
    };
    line('startmap-pop__call', t.title);
    line('startmap-pop__name', t.name);
    line('startmap-pop__loc', t.location);
    line('startmap-pop__facts', t.facts);
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'startmap-pop__connect';
    btn.textContent = 'Connect ↗';
    btn.title = r.url;
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        open(r.url);
    });
    root.appendChild(btn);
    return root;
}

function defaultOpen(url) {
    // noopener: the other receiver gets no handle back to this page.
    window.open(url, '_blank', 'noopener,noreferrer');
}

'use strict';

// Instance discovery: the public directory, the LAN, and manual addresses.
//
// A port of clients/electron/discovery.js. The logic — the row shape, the sort,
// the candidate ladder a bare hostname expands to — is that file's and is kept
// identical on purpose: the chooser page is shared, and two clients that
// resolved "m0abc.example.org" differently would be two clients whose saved
// lists cannot be compared.
//
// What changes is the transport. In Electron every request goes through
// http/https.request in the main process, because Node's fetch cannot be told
// to accept a self-signed certificate and LAN receivers often have exactly
// that. The same reasoning applies here twice over:
//
//   * a WebView's fetch cannot accept one either, and there is no equivalent of
//     the desktop client's per-receiver "trust this one" without going native;
//   * the app's own origin is not the receiver's, so every one of these would
//     be a cross-origin request — and CORS on an UberSDR instance is an
//     operator setting that defaults off (main.go, config.Server.EnableCORS).
//     Fetching /api/description from the page would fail against most of the
//     receivers this is meant to find.
//
// So getJson is the plugin, and everything below is unchanged around it.

import { UberSdr } from './native.js';
import { API_USER_AGENT } from './useragent.js';

const DIRECTORY_HOST = 'instances.ubersdr.org';
const DIRECTORY_TARGET = { host: DIRECTORY_HOST, port: 443, tls: true };
// conditions=true adds the per-band FT8 SNRs the chooser draws as badges, and
// the average it can sort on. Nothing about this device is sent: the directory
// will also compute distances given lat/lon, but that would mean telling it
// where the operator is to find out how far away a receiver is, and the same
// answer falls out of the coordinates it already returns.
const DIRECTORY_PATH = '/api/instances?conditions=true';
const MYIP_PATH = '/api/myip';

/**
 * One GET, one JSON document, one place certificate failures are classified.
 *
 * The native side resolves with a result rather than rejecting, so a receiver
 * that is simply not there travels the bridge the same way as one that is —
 * and the error it produces here carries `code` and `certError`, which is what
 * resolveTarget reads to offer "trust this receiver anyway".
 */
async function getJson(target, path, timeoutMs = 8000) {
    const res = await UberSdr.getJson({
        host: target.host,
        port: target.port,
        tls: !!target.tls,
        insecureTLS: !!target.insecureTLS,
        path,
        timeoutMs,
        userAgent: API_USER_AGENT,
    });
    if (!res.ok) {
        throw Object.assign(new Error(res.error || 'request failed'), {
            code: res.code || 'EFAILED',
            status: res.status || 0,
            certError: !!res.certError,
        });
    }
    return JSON.parse(res.body);
}

function isCertError(err) {
    return !!(err && err.certError);
}

// One row shape for every source, so the chooser renders them uniformly.
function row(desc, extra) {
    const receiver = (desc && desc.receiver) || {};
    return {
        name: receiver.name || '',
        callsign: receiver.callsign || '',
        location: receiver.location || '',
        version: (desc && desc.version) || '',
        availableClients: desc && typeof desc.available_clients === 'number' ? desc.available_clients : -1,
        maxClients: (desc && desc.max_clients) || 0,
        snr: (desc && desc.snr_0_30_mhz) || 0,
        ...extra,
    };
}

/** Probe an instance's /api/description. Returns a row; throws on failure. */
export async function probe(target) {
    const desc = await getJson(target, '/api/description');
    return row(desc, {
        host: target.host,
        port: target.port,
        tls: !!target.tls,
        insecureTLS: !!target.insecureTLS,
    });
}

// A coordinate, or null. Deliberately not `Number(v)`: `Number(null)` is 0, a
// perfectly finite number that would drop a pin in the Gulf of Guinea for every
// instance whose position the directory does not know.
const coord = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The public directory, most usable receivers first (free slots, then SNR). */
export async function fetchDirectory() {
    const body = await getJson(DIRECTORY_TARGET, DIRECTORY_PATH, 15000);
    const instances = Array.isArray(body) ? body : body.instances || [];

    const rows = instances
        .filter((inst) => inst.host)
        .map((inst) => ({
            // The directory's own UUID, and not `id` — that name belongs to the
            // saved store, and api.js reads `desc.id` as "an instance already
            // saved under this id" when it connects. A directory row carrying
            // one would be looked up in a store it is not in.
            uuid: inst.id || '',
            name: inst.name || inst.callsign || `${inst.host}:${inst.port}`,
            callsign: inst.callsign || '',
            location: inst.location || inst.country_name || '',
            version: inst.version || '',
            availableClients: typeof inst.available_clients === 'number' ? inst.available_clients : -1,
            maxClients: inst.max_clients || 0,
            snr: inst.snr_0_30_mhz || 0,
            host: inst.host,
            port: inst.port || (inst.tls ? 443 : 80),
            tls: !!inst.tls,
            source: 'directory',

            // What the map and the richer directory list draw. All optional:
            // an instance with no position is listed and simply not pinned.
            lat: coord(inst.latitude),
            lon: coord(inst.longitude),
            grid: inst.maidenhead || '',
            countryCode: (inst.country_code || '').toLowerCase(),
            countryName: inst.country_name || '',
            online: inst.is_online !== false,
            daylight: !!inst.is_daylight,
            bandConditions: inst.band_conditions || null,
            conditionsAt: inst.conditions_updated_at || '',
            avgBandSnr: typeof inst.avg_band_snr === 'number' ? inst.avg_band_snr : null,
        }));

    rows.sort((a, b) => {
        const aFree = a.availableClients > 0;
        const bFree = b.availableClients > 0;
        if (aFree !== bFree) return aFree ? -1 : 1;
        return b.snr - a.snr;
    });
    return rows;
}

/**
 * Roughly where this device is, by GeoIP from the directory host.
 *
 * The map wants a "you are here" to fit alongside the receivers, and the list
 * wants it to sort by distance. A phone has a real satellite fix available, and
 * this does not ask for it: a location permission prompt on first launch, to
 * order a list, is a poor trade for something the address the directory was
 * just fetched from answers well enough. "Set my location…" remains the exact
 * answer, as on the desktop.
 *
 * Returns null rather than throwing when the lookup answers without a position:
 * a country-only result, or a device on a mobile network the database has never
 * placed. The chooser draws the map without a home pin either way.
 */
export async function fetchGeoIP() {
    const body = await getJson(DIRECTORY_TARGET, MYIP_PATH, 8000);
    const lat = coord(body.latitude);
    const lon = coord(body.longitude);
    if (lat == null || lon == null) return null;
    return {
        lat,
        lon,
        city: body.city || '',
        country: body.country || '',
        countryCode: (body.country_code || '').toLowerCase(),
        source: 'geoip',
    };
}

/**
 * Browse the LAN, then keep only services that answer /api/description —
 * mDNS says something is advertising, the probe says it's actually UberSDR.
 */
export async function discoverLan() {
    const { services = [] } = await UberSdr.mdnsBrowse({ timeoutMs: 3000 });
    const rows = await Promise.all(services.map(async (svc) => {
        try {
            const r = await probe({ host: svc.host, port: svc.port, tls: false });
            if (!r.name) r.name = svc.name;
            r.source = 'lan';
            return r;
        } catch {
            return null;
        }
    }));
    return rows.filter(Boolean);
}

/**
 * Resolve a manually entered address: a full URL, host:port, or bare host.
 * Tries the plausible scheme/port combinations in order and returns the row
 * for the first that answers. On total failure throws; if any attempt failed
 * on the certificate, the error carries certError plus the target it died on,
 * so the caller can offer "accept self-signed" and retry with insecureTLS.
 */
export async function resolveTarget(input, { insecureTLS = false } = {}) {
    const text = String(input || '').trim();
    if (!text) throw new Error('empty address');

    let candidates;
    if (/^https?:\/\//i.test(text)) {
        const u = new URL(text);
        const useTLS = u.protocol === 'https:';
        candidates = [{ host: u.hostname, port: Number(u.port) || (useTLS ? 443 : 80), tls: useTLS }];
    } else {
        const m = text.match(/^\[?([^\]/]+?)\]?(?::(\d+))?$/);
        if (!m) throw new Error('unparseable address');
        const host = m[1];
        if (m[2]) {
            const port = Number(m[2]);
            candidates = port === 443
                ? [{ host, port, tls: true }]
                : [{ host, port, tls: false }, { host, port, tls: true }];
        } else {
            // Bare hostname: public receivers sit behind TLS on 443; a LAN
            // box is plain HTTP on 80 or the default 8080.
            candidates = [
                { host, port: 443, tls: true },
                { host, port: 80, tls: false },
                { host, port: 8080, tls: false },
            ];
        }
    }

    let certFailure = null;
    let lastErr = null;
    for (const cand of candidates) {
        try {
            const r = await probe({ ...cand, insecureTLS });
            r.source = 'manual';
            return r;
        } catch (err) {
            lastErr = err;
            if (isCertError(err) && !certFailure) certFailure = { ...cand, code: err.code };
        }
    }
    if (certFailure) {
        throw Object.assign(new Error(`certificate not trusted (${certFailure.code})`), { certError: certFailure });
    }
    throw new Error(`no UberSDR instance answered at "${text}" (${lastErr ? lastErr.code || lastErr.message : 'unknown'})`);
}

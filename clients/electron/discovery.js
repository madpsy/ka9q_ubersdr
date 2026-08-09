'use strict';

// Instance discovery: the public directory, the LAN, and manual addresses.
// Follows the conventions of the other clients (clients/tui/discovery.go,
// clients/ubersdr-audio/discovery.go): the directory rows carry everything
// needed to list them; LAN and manual instances are validated and enriched by
// fetching /api/description themselves.

const http = require('http');
const https = require('https');
const mdns = require('./mdns');

const DIRECTORY_URL = 'https://instances.ubersdr.org/api/instances';
const USER_AGENT = 'UberSDR Desktop Client (electron)';

// Node's fetch cannot be told to accept a self-signed certificate, and LAN
// receivers often have exactly that, so requests go through http/https.request.
function getJson({ host, port, tls: useTLS, insecureTLS }, path, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const mod = useTLS ? https : http;
        const req = mod.request({
            host,
            port,
            path,
            method: 'GET',
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
            rejectUnauthorized: !insecureTLS,
            timeout: timeoutMs,
        }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                catch (err) { reject(err); }
            });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end();
    });
}

const CERT_ERRORS = new Set([
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

function isCertError(err) {
    return CERT_ERRORS.has(err && err.code);
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
async function probe(target) {
    const desc = await getJson(target, '/api/description');
    return row(desc, {
        host: target.host,
        port: target.port,
        tls: !!target.tls,
        insecureTLS: !!target.insecureTLS,
    });
}

/** The public directory, most usable receivers first (free slots, then SNR). */
async function fetchDirectory() {
    const res = await fetch(DIRECTORY_URL, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`directory returned HTTP ${res.status}`);
    const body = await res.json();
    const instances = Array.isArray(body) ? body : body.instances || [];

    const rows = instances
        .filter((inst) => inst.host)
        .map((inst) => ({
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
 * Browse the LAN, then keep only services that answer /api/description —
 * mDNS says something is advertising, the probe says it's actually UberSDR.
 */
async function discoverLan() {
    const found = await mdns.browse({ timeoutMs: 3000 });
    const rows = await Promise.all(found.map(async (svc) => {
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
async function resolveTarget(input, { insecureTLS = false } = {}) {
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

module.exports = { fetchDirectory, discoverLan, resolveTarget, probe, isCertError };

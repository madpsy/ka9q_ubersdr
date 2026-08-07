// The voice skimmer addon: callsigns heard spoken on SSB.
//
// The addon runs several receivers through Whisper, pulls callsigns out of the
// transcript — phonetics and all, "Golf Zero Romeo Quebec Lima" — validates each
// against QRZ, and optionally submits the ones it is sure of to the DX cluster. Its own
// dashboard has the live transcript, the band activity and why each candidate was
// accepted or thrown out.
//
// This is the dock version, and it is two lists rather than one because the addon makes
// a distinction worth keeping:
//
//   Confirmed — heard, extracted and validated. This receiver has evidence somebody was
//   on that frequency saying that callsign.
//
//   Spotted — the subset it was confident enough to submit to the cluster, where the
//   rest of the world can see it. Necessarily fewer, and the ones it would stake its
//   name on.
//
// Side by side, they say what the skimmer is hearing and what it is willing to claim.
//
// ── One request per second, so the two columns take turns ────────────────────
//
// /api/spots is rate limited to one request per address per second — it takes
// caller-supplied filters and can return a lot — so the two queries cannot be fired
// together. The panel sends the confirmed one, waits, then sends the spotted one; see
// SECOND_QUERY_MS.
//
// The alternative would be one query and a client-side split, and it has the failure the
// WEFAX panel had: spotted is a subset, so a quiet spell puts every submitted spot
// outside whatever window was asked for and the column reads empty when it is not. The
// server can filter exactly, so it does.

export const BASE = '/addon/voiceskimmer';

export const ADDON_NAME = 'voiceskimmer';

/** The addon's own dashboard, the same route the Addons panel links to. */
export const addonUrl = (base = BASE) => `${base}/`;

/** Is the addon on this receiver? Same test the other addon panels make. */
export function voiceSkimmerAvailable(serverInfo) {
    const addons = serverInfo && serverInfo.addons;
    return Array.isArray(addons)
        && addons.some((n) => String(n).toLowerCase() === ADDON_NAME);
}

// How many rows each column shows.
export const COLUMN_ROWS = 5;

// Only the fields the panel draws. The full record carries the transcript line it came
// from, the QRZ summary, the confidence scores and a dozen flags — three kilobytes a
// row, against about a hundred and fifty bytes for this.
export const FIELDS = [
    'callsign', 'band', 'frequency', 'mode', 'last_heard', 'submitted_at',
    'country', 'country_code', 'snr',
].join(',');

const query = (params) => `${BASE}/api/spots?${params}&fields=${FIELDS}`;

/** Newest confirmed sightings — everything the skimmer has validated. */
export const confirmedUrl = (rows = COLUMN_ROWS) =>
    query(`limit=${rows}&sort=last_heard&order=desc`);

/**
 * Newest submitted spots. Filtered and sorted by the server on purpose: `submitted` is
 * a real filter there, so the column cannot go empty because the submitted ones happen
 * to be older than the window.
 */
export const spottedUrl = (rows = COLUMN_ROWS) =>
    query(`limit=${rows}&submitted=true&sort=submitted_at&order=desc`);

// How often each column is refreshed, and how long the second query waits behind the
// first. Thirty seconds because a skimmer working three bands confirms a few callsigns a
// minute; 1.2 s because the limit is one request a second and a margin costs nothing.
export const POLL_MS = 30000;
export const SECOND_QUERY_MS = 1200;

/**
 * One row, in the shape the panel uses.
 *
 * The band and the country come from the addon rather than being worked out here. It
 * has already resolved both, and its own comment on the matter is worth repeating:
 * re-deriving the band from the frequency risks a second band plan that disagrees with
 * every other table in the interface, and mapping a country *name* to a flag would be
 * wrong for exactly the entities this hears most — England, Scotland and Wales are
 * three DXCC entities and one ISO country.
 */
export function normaliseSpot(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const callsign = String(raw.callsign || '').trim().toUpperCase();
    const hz = Number(raw.frequency) || 0;
    if (!callsign || !hz) return null;
    const heard = Number(raw.last_heard);
    const spotted = Number(raw.submitted_at);
    const snr = Number(raw.snr);
    return {
        callsign,
        hz,
        // The addon deals in seconds since the epoch; everything here is in
        // milliseconds, and mixing the two is a bug that reads as 1970.
        at: Number.isFinite(heard) ? heard * 1000 : 0,
        spottedAt: Number.isFinite(spotted) ? spotted * 1000 : 0,
        band: String(raw.band || '').trim(),
        mode: String(raw.mode || '').trim().toLowerCase(),
        cc: String(raw.country_code || '').trim().toUpperCase(),
        country: String(raw.country || '').trim(),
        snr: Number.isFinite(snr) ? snr : null,
        // Unique per frequency as well as per callsign: the same station worked on two
        // bands is two rows, which is what the addon's own key does.
        key: `${callsign}|${hz}`,
    };
}

export function spotList(payload) {
    const rows = (payload && payload.spots) || [];
    return rows.map(normaliseSpot).filter(Boolean);
}

/** How many the addon holds altogether, for the caption. */
export function matchedCount(payload) {
    const n = Number(payload && payload.matched);
    return Number.isFinite(n) ? n : null;
}

/**
 * What to tune when a callsign is clicked.
 *
 * The addon reports the frequency it heard the station on and the mode it was listening
 * in. Both go across, because tuning to an SSB station in the wrong sideband is the same
 * as not tuning to it — and a mode it did not report is left alone rather than guessed,
 * so the receiver stays in whatever the operator had chosen.
 */
export function tuneTarget(spot) {
    if (!spot || !spot.hz) return null;
    const mode = /^(usb|lsb|am|sam|fm|nfm|cwu|cwl)$/.test(spot.mode) ? spot.mode : null;
    return mode ? { frequency: spot.hz, mode } : { frequency: spot.hz };
}

/** "14.297" — the frequency as a spotting list writes it. */
export function freqLabel(hz) {
    if (!hz) return '';
    return (hz / 1e6).toFixed(3);
}

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
//
// ── The band filter belongs on the server for the same reason ────────────────
//
// Each column asks for five rows. Filtering those five here would show an empty 40m column
// whenever the last five things heard were on 20m — a picture of the query rather than of
// the band. `band=40m` is a real filter on the addon (verified against a live receiver: it
// takes `matched` from 885 to 416 for 20m, and combines with `submitted=true`), so the band
// goes into the query and five rows come back from the band asked about.
//
// One catch, also verified: `band=all` matches nothing, because it is compared against the
// band names. "All bands" therefore has to *omit* the parameter rather than pass a word
// meaning all, which is what bandParam does.

import { AUTO_BAND, BAND_NAMES, resolveBandFilter } from './bands.js';

// 'auto' — the band the dial is in — is shared with the spot lists so the two pickers mean
// the same thing by it. Re-exported because the panel needs both, and one import of a band
// vocabulary reads better than two.
export { AUTO_BAND, BAND_NAMES, resolveBandFilter };

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

/**
 * The band as the query wants it. 'all' — and anything the panel cannot resolve to a band —
 * becomes nothing at all, because `band=all` matches no rows on the addon.
 *
 * A name that is not one of ours is dropped rather than passed through: the picker cannot
 * produce one, and a stored preference from a future version should show a full list rather
 * than an empty one.
 */
export function bandParam(band) {
    if (!band || band === 'all' || band === AUTO_BAND) return '';
    return BAND_NAMES.includes(band) ? `&band=${encodeURIComponent(band)}` : '';
}

/** Newest confirmed sightings — everything the skimmer has validated, on one band or all. */
export const confirmedUrl = (rows = COLUMN_ROWS, band = 'all') =>
    query(`limit=${rows}&sort=last_heard&order=desc${bandParam(band)}`);

/**
 * Newest submitted spots. Filtered and sorted by the server on purpose: `submitted` is
 * a real filter there, so the column cannot go empty because the submitted ones happen
 * to be older than the window.
 */
export const spottedUrl = (rows = COLUMN_ROWS, band = 'all') =>
    query(`limit=${rows}&submitted=true&sort=submitted_at&order=desc${bandParam(band)}`);

// How often each column is refreshed, and how long the second query waits behind the
// first. Thirty seconds because a skimmer working three bands confirms a few callsigns a
// minute; 1.2 s because the limit is one request a second and a margin costs nothing.
export const POLL_MS = 30000;
export const SECOND_QUERY_MS = 1200;

// How long a band change waits before it is queried. On 'auto' the band comes from the dial,
// and a dial being swept through the spectrum passes through several bands in a couple of
// seconds — each of which would otherwise fire a pair of requests at an endpoint that allows
// one a second. Waiting for the tuning to settle turns a sweep into one query.
export const BAND_SETTLE_MS = 700;

// ── The chosen band, kept between openings ───────────────────────────────────
//
// A panel is unmounted whenever its dock is collapsed — and peeked docks collapse constantly
// — so a filter held in component state would reset itself all day. Stored rather than
// remembered in a module variable so it also survives a reload, which is what somebody who
// pinned a band they are watching expects.

const KEY = 'ubersdr.v2.voiceskimmer';

export function savedBand() {
    try {
        const raw = JSON.parse(localStorage.getItem(KEY));
        const band = raw && typeof raw.band === 'string' ? raw.band : '';
        // Only a band this build knows, or one of the two words: anything else is a
        // preference from another version, and 'auto' is the right thing to fall back to.
        if (band === 'all' || band === AUTO_BAND || BAND_NAMES.includes(band)) return band;
    } catch (e) { /* private mode */ }
    return AUTO_BAND;
}

export function saveBand(band) {
    try { localStorage.setItem(KEY, JSON.stringify({ band })); } catch (e) { /* private mode */ }
}

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

// How far off a spot's frequency still counts as being tuned to it.
//
// Clicking a row tunes to the exact figure, so that case needs no tolerance at all; hand
// tuning to a station somebody else spotted does. Two hundred Hz is the width of a
// deliberate choice rather than of a channel: an SSB passband is more than ten times this,
// so a neighbour a couple of kilohertz away is never claimed, while a dial nudged a little
// off a spot — or a spot rounded to the nearest hundred by the addon — still matches.
export const TUNED_TOL_HZ = 200;

/**
 * Is the receiver on this spot's frequency?
 *
 * Frequency only, deliberately: mode is not part of the question. Listening to an SSB
 * station in the wrong sideband is a mistake worth being told about, and a row that stopped
 * matching because the mode was changed would hide exactly that.
 */
export function tunedToSpot(spot, hz, tol = TUNED_TOL_HZ) {
    if (!spot || !spot.hz || !(hz > 0)) return false;
    return Math.abs(spot.hz - hz) <= tol;
}

/** "14.297" — the frequency as a spotting list writes it. */
export function freqLabel(hz) {
    if (!hz) return '';
    return (hz / 1e6).toFixed(3);
}

// The NCDXF/IARU beacons this receiver has heard, from its own CW skimmer.
//
// Eighteen beacons share five frequencies on a three-minute cycle, each one
// transmitting for ten seconds on 20m and then working up the bands. Between
// them they are the only signals on HF whose location, power and schedule are
// all known in advance, which makes "which of them can I hear" the most direct
// propagation reading a receiver can take of itself.
//
// static/ncdxf_beacons.html already answers that at full-page length — a world
// map with a path per decode, a 24-hour heatmap per band, a replay bar — and
// this is the same question asked of a dock column, so it uses exactly the two
// endpoints that page does and adds no server of its own:
//
//   /ncdxf_beacons.json     the roster: 18 callsigns, slots, locations, and the
//                           coordinates the map draws. Static, so it is fetched
//                           once per page and held.
//   /api/cwskimmer/spots    the decodes, filtered to those 18 callsigns.
//
// ── Why the deduplicated form ───────────────────────────────────────────────
//
// The spots API collapses rows to one per callsign+band+UTC day by default,
// keeping the LATEST decode and reporting how many it stands for in seen_count.
// That is exactly the shape a panel row wants, and it is bounded: eighteen
// beacons on five bands is ninety rows whatever the window, where the raw form
// of a 24-hour window is up to forty thousand and would be truncated by the
// server's own cap.
//
// The consequence is that every signal figure here is the LAST decode, never
// the best one in the window, and the wording throughout says so. A "best SNR"
// would need the raw rows, which is a lot of wire for a number that is mostly
// telling you about one lucky second.
//
// ── What is deliberately not checked ────────────────────────────────────────
//
// A decode is trusted because of its callsign, not because it arrived in the
// beacon's scheduled slot. The schedule is deterministic and the check is
// possible — telegram_bot_beacons.go makes it — but it needs the raw rows this
// module has just given up, and the page this panel comes from has always
// worked this way. A skimmer inventing "VE8AT" on 14.100 in the wrong ten
// seconds is rare enough that the page ships without the test.

import { AUTO_BAND } from './bands.js';
import { distanceBearing } from './callsign.js';
import { feedInterval } from './serverFeeds.js';

export const ROSTER_URL = '/ncdxf_beacons.json';
export const SPOTS_URL = '/api/cwskimmer/spots';

// The five beacon bands in slot order — 20m first, because a beacon starts
// there and works upwards, and because that is the order both the page and the
// bot print them in.
export const BEACON_BANDS = ['20m', '17m', '15m', '12m', '10m'];

// Where each band's beacons transmit, exactly. Unlike a spot, this is not a
// measurement: the frequencies are published to the Hz and every beacon on a
// band uses the same one, so a row can tune to a beacon with no rounding and no
// guesswork about where the signal actually was.
export const BEACON_FREQ = {
    '20m': 14100000,
    '17m': 18110000,
    '15m': 21150000,
    '12m': 24930000,
    '10m': 28200000,
};

// All five are above the sideband crossover, so every beacon is upper-sideband
// CW — the same answer lib/spots.js reaches for a CW skimmer spot on any of
// these frequencies, reached here without the comparison because the five
// frequencies are constants.
export const BEACON_MODE = 'cwu';

// One full cycle. Also the denominator of every "n of 18" in the panel.
export const BEACON_COUNT = 18;

// Fifteen minutes, matching the DXpeditions calendar and for a similar reason:
// the shortest window offered is an hour and a beacon comes round every three
// minutes, so a faster poll cannot change what the panel says. It only governs
// a panel left open — feedInterval fires immediately when the gate opens, and a
// collapsed section does not mount its body at all, so expanding the panel
// always fetches.
export const NCDXF_POLL_MS = 15 * 60 * 1000;

// The windows on offer. An hour is the default because it is roughly the
// timescale on which HF propagation actually changes; the wider ones are for
// answering "was this band ever open today", which is a different question and
// the reason the dropdown exists at all.
export const WINDOWS = [
    { minutes: 60, label: 'Last hour' },
    { minutes: 180, label: 'Last 3 hours' },
    { minutes: 360, label: 'Last 6 hours' },
    { minutes: 1440, label: 'Last 24 hours' },
];

export const DEFAULT_PREFS = { window: 60, band: AUTO_BAND };

const PREFS_KEY = 'ubersdr.v2.ncdxf';

/** The stored window and band, falling back to the defaults for anything odd. */
export function savedPrefs() {
    try {
        const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
        const minutes = Number(raw.window);
        return {
            window: WINDOWS.some((w) => w.minutes === minutes) ? minutes : DEFAULT_PREFS.window,
            band: typeof raw.band === 'string' && raw.band ? raw.band : DEFAULT_PREFS.band,
        };
    } catch (e) {
        // Private mode, blocked site data, or a value written by a version that
        // meant something else by it. The defaults are a working panel.
        return { ...DEFAULT_PREFS };
    }
}

export function savePrefs(prefs) {
    try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch (e) { /* private mode */ }
}

// ── The roster ──────────────────────────────────────────────────────────────

let rosterPromise = null;

/**
 * The 18 beacons, fetched once for the life of the page.
 *
 * The file is a constant of the network rather than of this receiver — the same
 * eighteen callsigns in the same slots everywhere — so it is held in a module
 * promise and shared by the panel and its map. A failure is not cached: it
 * would leave a panel that can never draw a row until the tab is reloaded.
 */
export function loadRoster() {
    if (!rosterPromise) {
        rosterPromise = fetch(ROSTER_URL)
            .then(async (res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return cleanRoster(await res.json());
            })
            .catch((err) => { rosterPromise = null; throw err; });
    }
    return rosterPromise;
}

/** Only the fields anything here reads, and only entries that have a callsign. */
export function cleanRoster(body) {
    const doc = body && body.ncdxf_iaru_beacons;
    const rows = doc && Array.isArray(doc.beacons) ? doc.beacons : [];
    const out = [];
    for (const b of rows) {
        if (!b || typeof b.callsign !== 'string' || !b.callsign) continue;
        out.push({
            slot: Number(b.slot) || 0,
            callsign: b.callsign,
            entity: String(b.entity || ''),
            location: String(b.location || ''),
            country: String(b.country || ''),
            countryCode: String(b.country_code || ''),
            grid: String(b.grid || ''),
            lat: Number.isFinite(b.latitude) ? b.latitude : null,
            lon: Number.isFinite(b.longitude) ? b.longitude : null,
            operator: String(b.operator || ''),
        });
    }
    out.sort((a, b) => a.slot - b.slot);
    return out;
}

// ── The decodes ─────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');
const utcDate = (ms) => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/**
 * The query for one window.
 *
 * `from_date`/`to_date` are required and are whole UTC days; `from_ts`/`to_ts`
 * narrow that to the actual window, which is what makes "the last hour" mean
 * the last hour rather than "since midnight". A window crossing midnight asks
 * for two days and is narrowed the same way — the reason the date pair is
 * always sent rather than only when the days differ.
 */
export function spotsUrl(roster, minutes, now = Date.now()) {
    const from = now - minutes * 60000;
    const calls = roster.map((b) => b.callsign).slice(0, 20).join(',');
    return `${SPOTS_URL}?from_date=${utcDate(from)}&to_date=${utcDate(now)}`
        + `&from_ts=${Math.floor(from / 1000)}&to_ts=${Math.ceil(now / 1000)}`
        + `&callsign=${encodeURIComponent(calls)}`;
}

/** Thrown for the one failure the panel words differently: the feature is off. */
export class SkimmerOffError extends Error {}

/**
 * Fetch and shape one window's decodes.
 *
 * 204 is the API's "nothing matched", which is a perfectly good answer here and
 * the most common one on a quiet band — it resolves to no rows rather than
 * raising. 503 is the receiver saying it does not log CW spots at all, which is
 * a different sentence to put in front of somebody, hence its own error type.
 */
export async function fetchHeard(roster, minutes, now = Date.now()) {
    const res = await fetch(spotsUrl(roster, minutes, now), { cache: 'no-store' });
    if (res.status === 204) return { rows: [], at: now };
    if (res.status === 503) throw new SkimmerOffError('CW spot logging is not enabled');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    return { rows: mergeSpots(body && body.spots, roster), at: now };
}

// ── The store ───────────────────────────────────────────────────────────────
//
// One reading, held outside any component, on the pattern lib/noiseTrend.js
// uses. The panel is unmounted every time its section is collapsed or dragged
// between docks, and a reading that lived in its state would be refetched on
// each of those — so the rows live here and a reopened panel draws immediately
// from what is already known.
//
// The window is part of the state rather than a parameter of the subscription:
// there is one panel and one window, and a store that could be asked for two
// different windows at once would have to decide which of them the rows it is
// holding belong to.

let state = {
    roster: [],
    rows: [],
    window: DEFAULT_PREFS.window,
    loading: true,
    error: null,
    off: false,
    at: 0,
};
const listeners = new Set();
// Stamped on the way OUT, so a burst of opens cannot become a burst of
// requests — the same rule, for the same reason, as the noise trend's.
let lastAt = 0;
// Which request is the current one. A window changed mid-flight leaves an
// answer to the old question in the air, and without this the slower of the two
// wins by landing last.
let seq = 0;

export function ncdxfState() {
    return state;
}

export function onNcdxf(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function publish(next) {
    state = { ...state, ...next };
    for (const fn of Array.from(listeners)) {
        try { fn(state); } catch (err) { console.error('ncdxf subscriber threw', err); }
    }
    return state;
}

/**
 * Fetch one window, unless the floor says not to.
 *
 * A different window is always fetched: it is a different question, and the
 * floor exists to stop repetition rather than to make somebody wait for an
 * answer they have just asked for.
 *
 * A failure publishes NO rows rather than keeping the last set. They are a
 * claim about the last hour specifically, and going on making it for another
 * fifteen minutes after the receiver stopped answering would be the one thing
 * this panel must not do — quietly show a stale picture of the bands.
 */
export function refreshNcdxf(minutes, force = false) {
    const changed = minutes !== state.window;
    if (!force && !changed && lastAt && Date.now() - lastAt < NCDXF_POLL_MS) {
        return Promise.resolve(state);
    }
    lastAt = Date.now();
    seq += 1;
    const mine = seq;
    if (changed) publish({ window: minutes, loading: true });

    return loadRoster()
        .then((roster) => fetchHeard(roster, minutes).then((got) => ({ roster, got })))
        .then(({ roster, got }) => {
            if (mine !== seq) return state;
            return publish({
                roster,
                rows: got.rows,
                window: minutes,
                loading: false,
                error: null,
                off: false,
                at: got.at,
            });
        })
        .catch((err) => {
            if (mine !== seq) return state;
            return publish({
                rows: [],
                window: minutes,
                loading: false,
                off: err instanceof SkimmerOffError,
                error: err instanceof SkimmerOffError ? null : (err.message || String(err)),
                at: Date.now(),
            });
        });
}

/**
 * Keep it fresh while the panel is open. Gated by serverFeeds, so a stopped
 * receiver stops polling — unlike the load the panel does on mount, which is a
 * one-shot and is not a feed. Returns a stop.
 */
export function pollNcdxf(minutes) {
    return feedInterval(() => refreshNcdxf(minutes), NCDXF_POLL_MS);
}

/**
 * The API's rows, one per beacon.
 *
 * Two rows for the same beacon and band can arrive from one window: the
 * server's dedup key includes the UTC day, so anything spanning midnight comes
 * back split. They are merged here — counts added, and the later of the two
 * kept for the figures, which is the same rule the server applied within a day.
 *
 * Anything that is not one of the five beacon bands is dropped. The skimmer
 * bands are configuration and a receiver watching 30m will report a beacon
 * callsign heard there; it is a real decode of something, but it is not a
 * beacon transmission and the five-cell strip has nowhere to put it.
 */
export function mergeSpots(spots, roster) {
    const known = new Set(roster.map((b) => b.callsign));
    const byCall = new Map();

    for (const s of Array.isArray(spots) ? spots : []) {
        if (!s || !known.has(s.callsign)) continue;
        if (!BEACON_BANDS.includes(s.band)) continue;
        const at = Date.parse(s.timestamp);
        if (!Number.isFinite(at)) continue;

        let row = byCall.get(s.callsign);
        if (!row) {
            row = { call: s.callsign, bands: {}, at: 0, count: 0 };
            byCall.set(s.callsign, row);
        }
        const seen = Number(s.seen_count) > 0 ? Number(s.seen_count) : 1;
        const prev = row.bands[s.band];
        if (!prev) {
            row.bands[s.band] = { at, snr: s.snr, count: seen, frequency: s.frequency };
        } else {
            prev.count += seen;
            if (at > prev.at) {
                prev.at = at;
                prev.snr = s.snr;
                prev.frequency = s.frequency;
            }
        }
    }

    // The row's own figures are its most recent band's, so a row reads as one
    // sentence: heard on these bands, last on this one, this strong, this long
    // ago. A "best of five bands" SNR beside an age from a sixth would be two
    // facts wearing one row.
    const rows = [];
    for (const row of byCall.values()) {
        let last = null;
        for (const band of BEACON_BANDS) {
            const b = row.bands[band];
            if (!b) continue;
            row.count += b.count;
            if (!last || b.at > row.bands[last].at) last = band;
        }
        if (!last) continue;
        row.at = row.bands[last].at;
        row.snr = row.bands[last].snr;
        row.lastBand = last;
        rows.push(row);
    }
    return sortRows(rows);
}

/** Most recently heard first — a beacon audible a minute ago is the news. */
export function sortRows(rows) {
    return rows.slice().sort((a, b) => b.at - a.at || a.call.localeCompare(b.call));
}

// ── Filtering by band ───────────────────────────────────────────────────────

/**
 * Which band the picker means, for a panel that only knows five of them.
 *
 * lib/bands.js resolveBandFilter maps 'auto' to whatever band the dial is in.
 * Here that would mean parking on 40m emptied the panel — the dial is in a
 * band, there are simply no beacons in it — so Auto falls back to all bands
 * anywhere outside the five. Same judgement lib/bandNoise.js followsDial makes
 * for a band its monitor does not watch: a panel reading "40m — nothing" for
 * ever is worse than one that quietly shows everything.
 */
export function resolveBeaconBand(choice, dialBand) {
    if (choice !== AUTO_BAND) return choice;
    return BEACON_BANDS.includes(dialBand) ? dialBand : 'all';
}

/**
 * The rows for one band, with that band's figures promoted onto the row.
 *
 * The promotion is the point: with 20m selected, the SNR and the age beside a
 * callsign have to be its 20m ones, or the list is sorted and labelled by
 * decodes it is not showing.
 */
export function rowsForBand(rows, band) {
    if (!band || band === 'all') return sortRows(rows);
    const out = [];
    for (const row of rows) {
        const b = row.bands[band];
        if (!b) continue;
        out.push({ ...row, at: b.at, snr: b.snr, count: b.count, lastBand: band });
    }
    return sortRows(out);
}

/**
 * Per band: how many beacons, how many decodes, and the strongest last-decode.
 *
 * Always over every band regardless of the filter, because this strip is how
 * somebody notices that the band they have pinned is the wrong one.
 */
export function bandSummary(rows) {
    const out = {};
    for (const band of BEACON_BANDS) {
        out[band] = { band, beacons: 0, spots: 0, call: '', snr: null };
    }
    for (const row of rows) {
        for (const band of BEACON_BANDS) {
            const b = row.bands[band];
            if (!b) continue;
            const cell = out[band];
            cell.beacons += 1;
            cell.spots += b.count;
            if (cell.snr == null || b.snr > cell.snr) {
                cell.snr = b.snr;
                cell.call = row.call;
            }
        }
    }
    return BEACON_BANDS.map((band) => out[band]);
}

/** The beacons that stayed silent, which is half of what the panel says. */
export function notHeard(roster, rows) {
    const heard = new Set(rows.map((r) => r.call));
    return roster.filter((b) => !heard.has(b.callsign)).map((b) => b.callsign);
}

// ── Numbers under the list ──────────────────────────────────────────────────

/**
 * Where the receiver is, or null.
 *
 * 0,0 is the configuration default and not a position — the same test the spot
 * map and the DXpeditions modal make, for the same reason: a distance measured
 * from the Gulf of Guinea is worse than no distance.
 */
export function receiverAt(receiver) {
    const gps = receiver && receiver.gps;
    if (!gps || (!gps.lat && !gps.lon)) return null;
    return { lat: gps.lat, lon: gps.lon, label: receiver.callsign || 'Receiver' };
}

/** Distance and bearing from the receiver to a beacon, or null for either half missing. */
export function beaconRange(rx, beacon) {
    if (!rx || !beacon || beacon.lat == null || beacon.lon == null) return null;
    return distanceBearing(rx.lat, rx.lon, beacon.lat, beacon.lon);
}

/**
 * The footer line: the average signal, and the furthest beacon that made it in.
 *
 * The average is of the last decode on each band of each beacon — every figure
 * this module has — so it moves with the bands rather than with how busy the
 * skimmer has been, which a per-decode mean would.
 */
export function statsFor(rows, roster, rx, band) {
    const byCall = new Map(roster.map((b) => [b.callsign, b]));
    let sum = 0;
    let n = 0;
    let far = null;

    for (const row of rows) {
        const bands = band && band !== 'all'
            ? (row.bands[band] ? [row.bands[band]] : [])
            : BEACON_BANDS.map((b) => row.bands[b]).filter(Boolean);
        for (const cell of bands) {
            sum += cell.snr;
            n += 1;
        }
        if (!bands.length) continue;
        const range = beaconRange(rx, byCall.get(row.call));
        if (range && (!far || range.distKm > far.distKm)) {
            far = { call: row.call, distKm: range.distKm, bearing: range.bearing };
        }
    }

    return { avgSnr: n ? Math.round(sum / n) : null, decodes: n, far };
}

/** What to tune for a band's beacons: exact, and always upper-sideband CW. */
export function beaconTarget(band) {
    const frequency = BEACON_FREQ[band];
    return frequency ? { frequency, mode: BEACON_MODE } : null;
}

/** "+14 dB" — the sign is the reading, so it is always shown. */
export function snrLabel(snr) {
    return `${snr > 0 ? '+' : ''}${snr} dB`;
}

/** The window as a phrase for a sentence, e.g. "the last hour". */
export function windowLabel(minutes) {
    if (minutes < 60) return `the last ${minutes} minutes`;
    if (minutes === 60) return 'the last hour';
    return `the last ${Math.round(minutes / 60)} hours`;
}

// ── Test seams ──────────────────────────────────────────────────────────────

/** Forget the roster and the reading, so a test starts from a fresh page. */
export function _resetNcdxf() {
    rosterPromise = null;
    listeners.clear();
    lastAt = 0;
    seq += 1;
    state = {
        roster: [], rows: [], window: DEFAULT_PREFS.window,
        loading: true, error: null, off: false, at: 0,
    };
}

/**
 * Put a reading in without a server.
 *
 * The panel renders what the store holds, which is the only way a test can ask
 * it what a list of beacons looks like — the alternative is asserting on a
 * component that has just started a fetch and drawn its loading state.
 */
export function _seedNcdxf(next) {
    return publish(next);
}

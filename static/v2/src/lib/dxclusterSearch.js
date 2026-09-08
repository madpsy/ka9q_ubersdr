// The DX cluster addon's spot archive, as a search this panel can offer.
//
// The terminal in DXClusterPanel is a telnet session: you type `sh/dx G3ABC`
// and read the answer as text, and you have to be logged in to ask. The addon
// also keeps every spot it has ever seen in a database and puts a parametric
// read API over it — see ubersdr_dxcluster/web_search.go — which is reachable
// from here through the ordinary addon proxy:
//
//   /addon/dxcluster/api/search        the query
//   /addon/dxcluster/api/search/meta   the band ladder and the streams
//
// No auth, no session, and rows rather than text — which is the whole reason
// this exists alongside the transcript. A row that arrives as JSON carries a
// frequency and a mode, so it can tune the receiver; a row that arrives as
// eighty columns of text has to be parsed back out of the display first.
//
// ── What this deliberately does not offer ───────────────────────────────────
//
// The addon's own search tab has about twenty-five controls: spotter, grid
// square, comment text, continent, country, a custom datetime range, five
// numeric ranges (SNR, frequency, distance, WPM, hour-of-day), sort key, sort
// order, page size, CSV export and an API-URL copy button.
//
// This has four: callsign, period, band, source. It is the question somebody
// sitting in front of a receiver actually asks — "where has this station been
// heard, and on what" — and every control removed is one the full web UI is a
// click away from providing. Sort is fixed at newest-first, which is both the
// only ordering that means anything for that question and the only one the
// server can page through at constant cost.

import { modeFromSpot } from './dxclusterTerminal.js';

/** Where the addon lives. Same mount point the terminal socket uses. */
export const SEARCH_BASE = '/addon/dxcluster';

/**
 * The addon's name in /api/description's `addons` list.
 *
 * Here rather than in DXClusterPanel — where it used to live and from where it
 * is still re-exported — because the archive now has a second reader: the
 * callsign panel asks it for a last-heard line, and a panel that has nothing to
 * do with the terminal should not have to import the terminal to find out
 * whether the database exists.
 */
export const ADDON_NAME = 'dxcluster';

/** Is the addon on this receiver? Same test the widget makes. */
export function dxClusterAvailable(serverInfo) {
    const addons = serverInfo && serverInfo.addons;
    return Array.isArray(addons)
        && addons.some((n) => String(n).toLowerCase() === ADDON_NAME);
}

// Rows per request. Fifty fills the modal's scroller about twice over, which is
// enough to scroll rather than enough to page — and Show more asks for the next
// fifty by cursor, so a deep read costs the same as a shallow one.
export const PAGE_SIZE = 50;

// The anonymous callsign the addon's voice-activity detector files its spots
// under. It is not a station: it is this receiver noticing that somebody was
// talking on a frequency, and on a busy day it is seventy thousand of the
// quarter-million rows in the window. Nobody searching a spot archive means
// those, and the Voice chip is unusable while they are in it — so they are
// excluded from every query here rather than offered as a filter.
export const ANON_CALLSIGN = 'N0CALL';

/**
 * The three windows offered, and why there are only three.
 *
 * A rare callsign is not in the last 24 hours, so a search that could only look
 * that far back would answer "nothing" to the question it exists for. Thirty
 * days is where the addon's retention usually ends and where a query starts
 * costing real time. Between those two there is nothing a fourth chip would add
 * that the reader could not get by pressing the next one along.
 */
export const PERIODS = [
    { key: '24h', label: '24h', param: ['hours', 24] },
    { key: '7d', label: '7 days', param: ['days', 7] },
    { key: '30d', label: '30 days', param: ['days', 30] },
];

export const DEFAULT_PERIOD = '24h';

// CW below 10 MHz is lower sideband and above it is upper — the IARU
// convention, and the same split dxclusterTerminal.js applies to a spot line.
const SIDEBAND_SPLIT_HZ = 10000000;

// Mode names that mean "a decode", whoever wrote them. The decoder stream puts
// these in the `mode` column; the upstream cluster has no mode column at all and
// leads its comment with one instead, which is the only reason this set is
// matched against text as well.
//
// They all matter for one reason: a digital mode is upper sideband on every
// band, 160 m included. FT8 on 40 m is 7074 USB, not LSB — so these have to be
// recognised before the sideband split gets a chance to answer.
const DIGITAL_MODES = new Set([
    'FT8', 'FT4', 'FT2', 'WSPR', 'JS8', 'JS8CALL', 'JT65', 'JT9', 'Q65',
    'PSK31', 'PSK63', 'RTTY', 'OLIVIA', 'MFSK', 'CONTESTIA', 'SSTV', 'HELL',
]);

/** The addon's API root, for a caller that mounts it somewhere else. */
export const searchApi = (base = SEARCH_BASE) => `${base}/api/search`;

/**
 * The query string for one search.
 *
 * `bands` and `streams` are arrays of values already in the API's vocabulary —
 * the band ladder and the stream names, both of which come from the meta
 * document rather than being written out here, so a receiver running a stream
 * this file has never heard of still filters correctly.
 *
 * A cursor replaces the offset rather than joining it: the server pages by
 * keyset when the sort is `ts`, which is the only sort this offers.
 */
export function searchQuery({ callsign, bands, streams, period, cursor } = {}) {
    const q = new URLSearchParams();

    const p = PERIODS.find((x) => x.key === period) || PERIODS[0];
    q.set(p.param[0], String(p.param[1]));

    const call = String(callsign || '').trim().toUpperCase();
    // A prefix, not an exact match. Prefix already finds the exact callsign and
    // finds G3ABC/P and G3ABC/QRP with it, which is what somebody typing a
    // callsign into a spot archive wanted; `callsign_exact` would refuse all
    // three of those and is the control a cut-down search can most afford to
    // lose.
    if (call) q.set('callsign', call);

    if (bands && bands.length) q.set('band', bands.join(','));
    if (streams && streams.length) q.set('stream', streams.join(','));

    q.set('callsign_exclude', ANON_CALLSIGN);
    q.set('sort', 'ts');
    q.set('order', 'desc');
    q.set('limit', String(PAGE_SIZE));
    if (cursor) q.set('cursor', cursor);

    return q.toString();
}

/** The full URL for one search. */
export function searchUrl(params, base = SEARCH_BASE) {
    return `${searchApi(base)}?${searchQuery(params)}`;
}

// The addon answers an error as {"error": "..."} at every status it chooses,
// including the two a search can legitimately provoke: 503 when eight searches
// are already running, and 504 when this one outran its fifteen seconds. Both
// are worth repeating verbatim — they say what to do next — so the body is read
// before the status is turned into a message.
async function readJSON(res) {
    let body = null;
    try {
        body = await res.json();
    } catch (e) {
        body = null;
    }
    if (res.ok) return body;
    const said = body && typeof body.error === 'string' ? body.error : '';
    throw new Error(said || `search failed (${res.status})`);
}

/**
 * The meta document: the band ladder and the streams this receiver runs.
 *
 * Fetched rather than hardcoded because both are a property of the addon's
 * database, not of this file — a receiver with no CW skimmer has no CW stream to
 * offer, and a band ladder written out here would drift the first time the addon
 * learned a new one.
 */
export async function fetchSearchMeta(base = SEARCH_BASE, signal) {
    const res = await fetch(`${searchApi(base)}/meta`, { signal });
    return readJSON(res);
}

/** One page of results. */
export async function fetchSearch(params, base = SEARCH_BASE, signal) {
    const res = await fetch(searchUrl(params, base), { signal });
    return readJSON(res);
}

// ── The last-heard line ─────────────────────────────────────────────────────
//
// The callsign panel asks a different question of the same database: not "where
// has this station been heard" but "have *we* heard it, and when". One row
// answers that, so the query below is the search above with everything a list
// needs taken out.
//
// Three differences, and each of them is the reason this is not just
// fetchSearch({ limit: 1 }):
//
//   * `callsign_exact`, not `callsign`. The modal's prefix is right for
//     somebody typing into a search box — G3ABC there should find G3ABC/P —
//     and wrong here, where the callsign was not typed but looked up and
//     normalised. A prefix on a whole callsign also matches the longer ones
//     that merely start with it, so M0AB would answer with M0ABC's spot and
//     say it was M0AB's. It is the cheaper query by two orders of magnitude
//     as well: `callsign = ?` is an index seek where LIKE 'M0AB%' is a scan —
//     measured at 1 ms against 339 ms on a month of this receiver's archive.
//   * `count=none`. The row is the answer; the total is what the count costs,
//     and the addon documents this as the cheapest form.
//   * 30 days, not the modal's 24 hours. "Never heard" is only worth saying
//     over the whole window the archive keeps, and a station heard three weeks
//     ago is exactly the answer that makes this line worth having.
//
// The cost of exact matching is that a station worked as G3ABC/P has its
// portable spots filed under a callsign this will not ask for. That is the
// right way round: normaliseCallsign has already decided the panel is looking
// at G3ABC, and a last-heard line that quietly answered for a different
// callsign would be worse than one that says nothing.

/** How far back the last-heard line looks. The archive's usual retention. */
export const LAST_SPOT_DAYS = 30;

/** The URL for the one-row last-heard query. */
export function lastSpotUrl(callsign, base = SEARCH_BASE) {
    const q = new URLSearchParams();
    q.set('days', String(LAST_SPOT_DAYS));
    q.set('callsign_exact', String(callsign || '').trim().toUpperCase());
    q.set('callsign_exclude', ANON_CALLSIGN);
    q.set('sort', 'ts');
    q.set('order', 'desc');
    q.set('limit', '1');
    q.set('count', 'none');
    return `${searchApi(base)}?${q.toString()}`;
}

/**
 * The most recent spot of one callsign, or null where there is none.
 *
 * Null is an answer — "not heard in the window" — and is returned rather than
 * thrown for that reason. A failure still throws: the caller shows nothing at
 * all for that, because an addon that is down and a station that was never
 * heard must not read the same.
 */
export async function fetchLastSpot(callsign, base = SEARCH_BASE, signal) {
    const call = String(callsign || '').trim().toUpperCase();
    if (!call) return null;
    const data = await readJSON(await fetch(lastSpotUrl(call, base), { signal }));
    const spots = data && Array.isArray(data.spots) ? data.spots : [];
    return spots.length ? spots[0] : null;
}

/**
 * How long ago, in one short phrase.
 *
 * The spots panels stop at hours (lib/spots.js ageLabel) because nothing in
 * them is older than a few; this window is a month, so it carries days too.
 * Whole units only — "3d" rather than "3d 4h" — since the point of the line is
 * whether the station was heard this morning or a fortnight ago, and the exact
 * moment is on the row's tooltip for anyone who wants it.
 */
export function spotAge(iso, now = Date.now()) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const secs = Math.max(0, Math.round((now - t) / 1000));
    if (secs < 60) return 'just now';
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86400)}d ago`;
}

/**
 * The band chips, from the meta document.
 *
 * The ladder arrives longest-wavelength first, which is the order a band plan
 * is written in and the order a row of chips reads best in. Kept as the server
 * gave it.
 */
export function bandsFrom(meta) {
    const bands = meta && meta.bands;
    return Array.isArray(bands) ? bands.filter((b) => typeof b === 'string') : [];
}

/**
 * The source chips: Digital, CW, Voice, DX cluster, Local spots.
 *
 * ── Why this filters the stream and not the mode ────────────────────────────
 *
 * It started as a mode filter, built from the server's `mode_groups`, and that
 * was wrong in a way that is worth writing down because the two look identical
 * from the outside.
 *
 * `mode_groups` is not a taxonomy of modulation. It is three of the five
 * streams wearing mode labels: Digital is the decoder, CW is the skimmer, Voice
 * is the voice detector, and each group simply lists whatever modes its stream
 * happens to record. The remaining two streams — the spots relayed from the
 * upstream cluster, and the ones people spot on this receiver — have no mode
 * column at all. They keep it in the comment, as free text.
 *
 * So a filter on `mode` cannot express them. Worse, it excludes them silently:
 * ask for CW and the forty-four thousand upstream spots vanish, because SQL
 * compares their empty mode column against 'CW' and finds no match. The answer
 * looks like an answer.
 *
 * Filtering the stream says the same thing about the three that have modes,
 * says the two that do not, and drops nothing without being asked. It is also
 * the cheaper query by an order of magnitude — `stream` is an indexed column
 * where the unified mode is a COALESCE across three of them.
 */
export function sourcesFrom(meta) {
    const streams = meta && meta.streams;
    if (!Array.isArray(streams)) return [];
    const labels = (meta && meta.stream_labels) || {};
    return streams
        .filter((k) => typeof k === 'string' && k)
        .map((key) => ({ key, label: typeof labels[key] === 'string' && labels[key] ? labels[key] : key }));
}

/**
 * Where a row would tune to.
 *
 * The voice stream records the dial it decided on separately from the frequency
 * it heard energy at; everything else spots the dial directly.
 */
export function tuneFreq(spot) {
    const dial = Number(spot && spot.est_dial_freq);
    if (Number.isFinite(dial) && dial > 0) return dial;
    const hz = Number(spot && spot.freq_hz);
    return Number.isFinite(hz) && hz > 0 ? hz : 0;
}

/**
 * The receiver mode a row should be listened to in.
 *
 * ── Why a digital row is tuneable here and not in the transcript ────────────
 *
 * parseSpotLine refuses a digital spot outright: a line reading "FT8 -12 dB" is
 * somebody else's decode of a signal that is already over, and tuning to it puts
 * you on a carrier. That is the right answer for a spot arriving live in a
 * terminal.
 *
 * It is the wrong answer for a search result, for two reasons. The rows are
 * historical either way — nothing in this list is happening now — so "the QSO is
 * over" stops distinguishing them. And on the receiver this ships with, decodes
 * are most of the archive: 185,000 of the 250,000 rows in a week. A results list
 * where four rows in five cannot be clicked is a list that does not work.
 *
 * What you get instead is the watering hole — 14074, 14095.6 — in USB, which is
 * exactly where somebody wanting to see FT8 on the waterfall would put the dial.
 */
export function receiverMode(spot) {
    const hz = tuneFreq(spot);
    const mode = String((spot && (spot.mode || spot.voice_mode)) || '').trim().toUpperCase();

    if (mode === 'CW') return hz >= SIDEBAND_SPLIT_HZ ? 'cwu' : 'cwl';
    if (mode === 'USB') return 'usb';
    if (mode === 'LSB') return 'lsb';
    if (DIGITAL_MODES.has(mode)) return 'usb';
    if (mode) return hz >= SIDEBAND_SPLIT_HZ ? 'usb' : 'lsb';

    // No mode column: the upstream cluster and the local spots keep it in the
    // comment, which is the text the transcript's own parser was written for.
    // Its leading word is checked first, because it is the one place a digital
    // mode is named and the split below would otherwise put 40 m FT8 on LSB.
    const note = String((spot && (spot.comment || spot.message)) || '');
    const lead = note.trim().split(/\s+/)[0];
    if (lead && DIGITAL_MODES.has(lead.toUpperCase())) return 'usb';

    return modeFromSpot(hz, note) || (hz >= SIDEBAND_SPLIT_HZ ? 'usb' : 'lsb');
}

/** What the row calls the mode, which is the server's word and not ours. */
export function modeLabel(spot) {
    const mode = String((spot && (spot.mode || spot.voice_mode)) || '').trim().toUpperCase();
    if (mode) return mode;
    // The streams with no mode column say it in the comment, or not at all.
    const lead = String((spot && (spot.comment || spot.message)) || '').trim().split(/\s+/)[0];
    return lead && DIGITAL_MODES.has(lead.toUpperCase()) ? lead.toUpperCase() : '';
}

/** `14095.6` — kHz to one decimal, which is as fine as a spot means. */
export function khzLabel(hz) {
    const n = Number(hz);
    if (!Number.isFinite(n) || n <= 0) return '';
    return (Math.round(n / 100) / 10).toFixed(1);
}

/** `1348Z` — the spot's UTC time, in the form the cluster itself prints. */
export function utcLabel(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
}

/** `7 Sep` — the date, for a window wider than a day. */
export function dayLabel(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const d = new Date(t);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

/** `+13 dB`, or '' where the stream does not measure one. */
export function snrLabel(spot) {
    // The cluster stream has no SNR and stores a zero rather than a null, so a
    // bare 0 there would read as a measurement that happens to be zero.
    if (spot && spot.stream === 'dxcluster' && !spot.snr) return '';
    const n = Number(spot && spot.snr);
    if (!Number.isFinite(n) || n === 0) return '';
    const r = Math.round(n);
    return `${r > 0 ? '+' : ''}${r} dB`;
}

/**
 * The right-hand end of a row: who spotted it, and whatever they said.
 *
 * The four streams fill different columns — a skimmer spot has a spotter and a
 * WPM, a decode has a message and a grid, an upstream spot has a spotter and a
 * human comment — so this reads whichever are there rather than assuming a
 * shape.
 */
export function spotNote(spot) {
    if (!spot) return '';
    const bits = [];
    const note = String(spot.comment || spot.message || '').trim();
    if (note) bits.push(note);
    if (spot.wpm) bits.push(`${spot.wpm} wpm`);
    if (spot.spotter) bits.push(`de ${spot.spotter}`);
    return bits.join(' · ');
}

/**
 * A stable identity for a row.
 *
 * There is no id in the payload, and there does not need to be one: a spot is
 * one station on one frequency at one instant, and the three together do not
 * repeat within a stream. Pages are appended rather than replaced, so this is
 * what stops the last row of one page and the first of the next colliding.
 */
export function spotKey(spot, i) {
    if (!spot) return `row-${i}`;
    return [spot.timestamp, spot.callsign, spot.freq_hz, spot.stream, i].join('|');
}

/**
 * The summary line: which slice of what.
 *
 * `total_capped` means the server stopped counting at its cap rather than that
 * it found exactly that many, so the figure is a floor and has to read as one.
 */
export function resultSummary({ shown, total, capped, took }) {
    if (!shown) return 'No spots match these filters.';
    const many = total == null
        ? `${shown.toLocaleString()} shown`
        : `${shown.toLocaleString()} of ${capped ? 'over ' : ''}${Number(total).toLocaleString()}`;
    return took == null ? many : `${many} · ${Math.round(took)} ms`;
}

// The noise floor monitor's latest measurement for every band it watches.
//
// This is what static/noisefloor.html puts on its dashboard cards, from the same
// endpoint: /api/noisefloor/latest returns one BandMeasurement per configured
// band — noise floor, signal peak, dynamic range, occupancy and FT8 SNR — in a
// single request. Nothing in v2 asked for it before; lib/bandConditions.js polls
// /api/noisefloor/aggregate, which is a ten-minute *average* of one field
// (ft8_snr) and is the right answer for colouring ten buttons and the wrong one
// for a panel that wants the current reading with its working shown.
//
// Same store shape as lib/bandConditions.js and lib/spotStore.js: acquired on
// the first subscriber, released with the last, and the last answer outlives any
// one component so a panel reopened after a dock drag paints immediately instead
// of sitting empty until the next minute comes round.
//
// ── The once-a-minute rule ──────────────────────────────────────────────────
//
// The monitor measures on its own schedule and nothing here is worth asking for
// more often than that, so the poll is a minute — and it is a minute *floor*,
// not just a timer period. Section unmounts a closed panel's body, so opening
// and closing the panel releases and re-acquires this store, and a timer alone
// would fetch on every re-acquire: a fidgety operator would be a request a
// second. `lastRequestAt` is what actually enforces the rule, and it is stamped
// when the request goes out rather than when it lands — a timer that fires at
// exactly POLL_MS after the previous *response* would be a hair early every
// time and skip every poll.

import { bandOrder } from './bands.js';
import { classify } from './bandConditions.js';
import { feedInterval } from './serverFeeds.js';

export const LATEST_URL = '/api/noisefloor/latest';
export const POLL_MS = 60 * 1000;

// Fewer measured bands than this and ranking one against the others says
// nothing — with two bands, one of them is always "the worst on the receiver".
export const RANK_MIN_BANDS = 3;

// ── Reading a reply ─────────────────────────────────────────────────────────

/**
 * The reply as rows, up the spectrum.
 *
 * The endpoint is keyed by band name and JSON object order is not the band
 * plan's, so the sort is this module's job. Bands lib/bands.js does not know —
 * an operator's own name for a stretch of spectrum — sort after the amateur
 * ones rather than being dropped, because the monitor measuring something
 * unusual is not a reason to hide the measurement.
 */
export function rowsFrom(latest) {
    if (!latest || typeof latest !== 'object') return [];
    return Object.keys(latest)
        .filter((name) => latest[name] && typeof latest[name] === 'object')
        .map((name) => ({ ...latest[name], band: name }))
        .sort((a, b) => (bandOrder(a.band) - bandOrder(b.band)) || a.band.localeCompare(b.band));
}

/**
 * Whether the picker is following the dial.
 *
 * A pin to a band the receiver has stopped measuring is treated as auto rather
 * than as an error: the monitor's band list is configuration, it can change
 * under a stored preference, and a panel that reads "40m — no data" forever is
 * worse than one that quietly goes back to following.
 *
 * Named at length rather than `following` because that is a common enough local
 * in this codebase — the chat panel and the Morse game both have one — and an
 * export sharing the name defeats test/unresolved.js for every file that does.
 */
export function followsDial(pref, rows) {
    if (!pref || pref === 'auto') return true;
    return !rows.some((r) => r.band === pref);
}

/**
 * Which band the panel shows: the pinned one, or the one the dial is in, or —
 * when the dial is somewhere the monitor does not watch — the first measured
 * band, so the panel has something to say rather than nothing.
 */
export function chooseBand(pref, rows, dialBand) {
    if (!rows.length) return null;
    if (!followsDial(pref, rows)) return pref;
    if (dialBand && rows.some((r) => r.band === dialBand)) return dialBand;
    return rows[0].band;
}

// ── Colouring a reading ─────────────────────────────────────────────────────

/**
 * Whether a measurement carries an FT8 reading at all.
 *
 * noisefloor.html's test, verbatim: the field is a float32 that is zero both
 * when nothing was heard and when the monitor has not run its FT8 pass yet, so
 * a zero is "no reading" rather than "0 dB".
 */
export function hasFT8(m) {
    return !!(m && Number.isFinite(m.ft8_snr) && m.ft8_snr > 0);
}

/**
 * The condition bucket for a measurement's FT8 SNR — 'excellent' | 'good' |
 * 'fair' | 'poor' — or 'none' when there is no reading.
 *
 * Deliberately the band buttons' buckets (lib/bandConditions.js `classify`,
 * which is v1's), so a band this panel calls Good is the same amber the Quick
 * bands key is painted. The two are looking at different windows — this is the
 * latest measurement, the buttons are a ten-minute average — so they can differ
 * by a bucket at a boundary, but they cannot disagree about what Good means.
 */
export function snrTone(m) {
    return hasFT8(m) ? classify(m.ft8_snr).toLowerCase() : 'none';
}

/** The bucket as a word for a reader: 'Good', or 'No FT8' when there is none. */
export function snrLabel(m) {
    if (!hasFT8(m)) return 'No FT8';
    const s = classify(m.ft8_snr);
    return s.charAt(0) + s.slice(1).toLowerCase();
}

/**
 * The quartiles of the noise floor across the measured bands, or null when
 * there are too few bands for the comparison to mean anything.
 *
 * noisefloor.html's index arithmetic, kept exactly: it ranks each band's floor
 * against the rest of this receiver rather than against an absolute figure,
 * which is the only comparison that survives one site being on a beverage and
 * another on a loop in a loft.
 */
export function floorStats(rows) {
    const values = rows.map((r) => r.p5_db).filter((v) => Number.isFinite(v));
    if (values.length < RANK_MIN_BANDS) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return {
        q1: sorted[Math.floor(sorted.length * 0.25)],
        q3: sorted[Math.floor(sorted.length * 0.75)],
    };
}

/**
 * How a band's noise floor compares with the rest of the receiver's:
 * 'good' in the quietest quarter, 'bad' in the noisiest, 'warn' between, and
 * 'none' when there is nothing to compare it with.
 *
 * Lower is better — this is a floor, not a signal.
 */
export function floorTone(p5, stats) {
    if (!stats || !Number.isFinite(p5)) return 'none';
    if (p5 <= stats.q1) return 'good';
    if (p5 <= stats.q3) return 'warn';
    return 'bad';
}

/**
 * A reading to one decimal, or a dash — measurements are float32 and any of
 * them may be absent from a reply.
 *
 * Bare, without a unit: these go in `.readout` cells that carry their own, and
 * a column of them has to line up on the decimal point. (lib/bandSpectrum.js
 * has a `formatDb` that appends " dBFS", which is why this is not called that.)
 */
export function formatFigure(v, dp = 1) {
    return Number.isFinite(v) ? `${v.toFixed(dp)}` : '—';
}

/** When a measurement was taken, in ms, or null for one with no usable timestamp. */
export function measuredMs(m) {
    if (!m || !m.timestamp) return null;
    const t = Date.parse(m.timestamp);
    return Number.isFinite(t) ? t : null;
}

// ── The preference ──────────────────────────────────────────────────────────

const KEY = 'ubersdr.v2.bandstats.band';

/**
 * Which band the panel is pinned to, 'auto' being "follow the dial".
 *
 * A bare string rather than the settings object the other panels store, because
 * that is all there is: one choice. It survives a reload for the reason the band
 * spectrum panel's pin does — a pin you have to set again every session is not a
 * pin.
 */
export function savedBand() {
    try {
        const raw = localStorage.getItem(KEY);
        return typeof raw === 'string' && raw ? raw : 'auto';
    } catch (e) {
        return 'auto';
    }
}

export function saveBand(name) {
    try {
        localStorage.setItem(KEY, typeof name === 'string' && name ? name : 'auto');
    } catch (e) { /* private mode */ }
}

// ── The store ───────────────────────────────────────────────────────────────

let state = { latest: null, error: null, at: 0 };
let lastRequestAt = 0;
let inFlight = false;
const subscribers = new Set();
let timer = null;

export function getBandNoise() {
    return state;
}

function emit() {
    for (const fn of subscribers) {
        try { fn(state); } catch (err) { console.error('band noise subscriber threw', err); }
    }
}

function settle(next) {
    state = { ...state, ...next };
    emit();
}

function load() {
    if (inFlight) return;
    // The rule, and the only thing enforcing it — see the header.
    if (lastRequestAt && Date.now() - lastRequestAt < POLL_MS) return;
    lastRequestAt = Date.now();
    inFlight = true;

    fetch(LATEST_URL)
        .then((r) => {
            // 204 is the monitor running but not having measured yet, which is
            // the first minute of a restarted receiver and not an error.
            if (r.status === 204) return {};
            if (r.status === 503) throw new Error('Noise floor monitoring is not enabled');
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        })
        .then((d) => {
            inFlight = false;
            settle({ latest: d && typeof d === 'object' ? d : {}, error: null, at: Date.now() });
        })
        .catch((err) => {
            inFlight = false;
            // The last good answer is kept and the failure is reported beside
            // it: a minute-old set of noise floors is still worth reading, and
            // the panel says which it is showing.
            settle({ error: err.message || 'unavailable' });
        });
}

/**
 * Subscribes to the measurements. `fn` is called with what is already known
 * immediately, and again on every refresh. Returns the unsubscribe.
 */
export function subscribeBandNoise(fn) {
    subscribers.add(fn);
    if (subscribers.size === 1) timer = feedInterval(load, POLL_MS);
    try { fn(state); } catch (err) { console.error('band noise subscriber threw', err); }

    return () => {
        if (!subscribers.delete(fn)) return;
        if (subscribers.size > 0) return;
        if (timer) timer();
        timer = null;
        // The answer is kept, as lib/bandConditions.js keeps its own: it is a
        // measurement of the last minute, still true a moment later, and holding
        // it is what lets a reopened panel paint at once.
    };
}

/**
 * Test seam: drop every subscriber and the poll floor, so the next subscribe
 * polls again. `keepState` holds the last answer, which is how the "a failed
 * refresh keeps the previous measurement" path is reachable at all — the floor
 * otherwise makes a second request within the minute impossible by design.
 */
export function resetBandNoise({ keepState = false } = {}) {
    subscribers.clear();
    if (timer) timer();
    timer = null;
    if (!keepState) state = { latest: null, error: null, at: 0 };
    lastRequestAt = 0;
    inFlight = false;
}

// Space weather: the NOAA-derived numbers /api/spaceweather serves.
//
// Two things read it — the top bar's one-line summary (the same "S:164 K:2 A:9
// W:2.3 P:Good" v1 pins to its corner) and the Space weather panel, which shows
// the whole reply. Both take it from the single poll at the foot of this file:
// they want the identical document, the endpoint is rate limited per IP, and
// two independent minute loops would spend that budget on the same bytes.
//
// Everything with a rule in it lives here rather than in either component. The
// tone a reading is painted in, and the thresholds behind it, are the part
// worth testing and the part that must not drift between the summary and the
// panel — a flux the top bar calls good and the panel calls marginal is a bug
// that no one would ever notice in review.

import { bandOrder } from './bands.js';

export const ENDPOINT = '/api/spaceweather';
// v1's cadence (space-weather-display.js). The server refreshes from NOAA far
// less often than this; a minute is simply short enough that the age readout
// never lies by much.
export const POLL_MS = 60000;

// --- grades -----------------------------------------------------------------

// The four words the server grades with, worst first. Both the per-band
// conditions and the overall propagation quality use this scale.
export const GRADES = ['Poor', 'Fair', 'Good', 'Excellent'];

// CSS suffix for a grade — what .band-chip--* and .sw-grade--* are keyed on.
// Anything unrecognised (including a band the server did not grade) is 'none',
// which is styled as absent rather than as a fifth grade.
export function gradeClass(q) {
    return GRADES.includes(q) ? q.toLowerCase() : 'none';
}

// Text tone for a grade, on the good/warn/bad set the rest of the UI uses.
// Excellent and Good share one: they are both "the band is open".
export function gradeTone(q) {
    switch (q) {
        case 'Excellent':
        case 'Good':
            return 'good';
        case 'Fair':
            return 'warn';
        case 'Poor':
            return 'bad';
        default:
            return 'idle';
    }
}

// --- individual readings ----------------------------------------------------

// Solar flux bands, inverted out of the server's own model rather than picked
// here: it scores flux as 1.35 + (sfi - 65) × 0.017 and, with a quiet field,
// calls the result Excellent from 2.95 and Good from 1.90 (space_weather.go
// fluxScore / calculatePropagationQuality). Solving for the flux gives the
// numbers below, so the colour on the flux reading agrees with the propagation
// quality printed beside it instead of contradicting it.
// Each is rounded up, not to nearest: they are the lowest flux that actually
// reaches the grade, and 159 misses Excellent by two thousandths of a point.
export const FLUX_VERY_HIGH = 160;  // ceil((2.95 - 1.35) / 0.017 + 65)
export const FLUX_HIGH = 98;        // ceil((1.90 - 1.35) / 0.017 + 65)
export const FLUX_MODERATE = 65;    // the quiet-sun floor the model starts from

export function fluxLabel(sfi) {
    if (sfi == null) return '';
    if (sfi >= FLUX_VERY_HIGH) return 'Very high';
    if (sfi >= FLUX_HIGH) return 'High';
    if (sfi >= FLUX_MODERATE) return 'Moderate';
    return 'Low';
}

export function fluxTone(sfi) {
    if (sfi == null) return 'idle';
    if (sfi >= FLUX_HIGH) return 'good';
    if (sfi >= FLUX_MODERATE) return 'warn';
    return 'bad';
}

// The server sends k_index_status; this is the fallback for a reply that
// somehow lacks it, and it uses the server's own thresholds
// (space_weather.go getKIndexStatus) so the two can never disagree.
export function kStatus(k) {
    if (k == null) return '';
    if (k <= 2) return 'Quiet';
    if (k <= 4) return 'Unsettled';
    if (k <= 6) return 'Active';
    return 'Storm';
}

// Kp 5 is where NOAA's G scale starts, so that is where this turns red rather
// than amber: below it the field is unsettled, at it there is a storm on.
export function kTone(k) {
    if (k == null) return 'idle';
    if (k <= 2) return 'good';
    if (k <= 4) return 'warn';
    return 'bad';
}

// The A-index is the day's running average of the same field activity, on a
// linear scale: under 8 is a quiet day, 30 and up is a stormy one.
export function aTone(a) {
    if (a == null) return 'idle';
    if (a < 8) return 'good';
    if (a < 30) return 'warn';
    return 'bad';
}

// Bz is the north-south component of the interplanetary magnetic field, and the
// sign is what matters: southward (negative) opens the magnetopause and lets
// the solar wind drive a geomagnetic storm, northward shields against it. So a
// large positive Bz is not "worse than" a small one, which is why this is not a
// magnitude scale like the others.
export function bzLabel(bz) {
    if (bz == null) return '';
    if (bz <= -10) return 'Strongly south';
    if (bz <= -5) return 'Southward';
    if (bz < 0) return 'Slightly south';
    return 'Northward';
}

export function bzTone(bz) {
    if (bz == null) return 'idle';
    if (bz <= -10) return 'bad';
    if (bz <= -5) return 'warn';
    return 'good';
}

// --- NOAA scales ------------------------------------------------------------

// R, S and G levels arrive as strings ("0".."5"), and sometimes not at all —
// NOAA omits a scale it has nothing to say about. A missing level is not level
// zero: "no storm forecast" and "no forecast issued" read differently, so this
// returns null rather than 0 for anything unparseable.
export function scaleLevel(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(5, Math.round(n)));
}

export function scaleTone(level) {
    if (level == null) return 'idle';
    if (level === 0) return 'good';
    if (level <= 2) return 'warn';
    return 'bad';
}

// "G0" is not a thing NOAA prints — level zero is quiet conditions, so it is
// spelled out rather than given a number that would look like a storm.
export function scaleLabel(letter, level) {
    if (level == null) return '—';
    return level === 0 ? 'None' : `${letter}${level}`;
}

// NOAA forecasts R and S as probabilities rather than as levels — a live reply
// carries r_minor_prob, r_major_prob and s_prob and no r_scale or s_scale at
// all, because "20% chance of an R1 tomorrow" is not a level you can name. Only
// G comes back as a forecast level, since Kp is predicted directly.
//
// Percentages arrive as strings ("20"), and an absent one is unknown, not zero.
export function probPercent(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, Math.round(n)));
}

// A one-in-five chance of a minor event is an ordinary day on an active sun, so
// that is still green; the amber starts where an event is worth planning around
// and the red where it is more likely than not.
export function probTone(pct) {
    if (pct == null) return 'idle';
    if (pct < 20) return 'good';
    if (pct < 50) return 'warn';
    return 'bad';
}

// --- band conditions --------------------------------------------------------

// The day and night maps as one list of rows, in frequency order rather than
// the object's own — the keys come back alphabetically, where "10m, 12m, 160m,
// 17m" reads as a sorting accident rather than as a spectrum. Bands graded in
// only one of the two maps still get a row, with the other side blank.
export function bandRows(sw) {
    const day = (sw && sw.band_conditions_day) || {};
    const night = (sw && sw.band_conditions_night) || {};
    const names = [...new Set([...Object.keys(day), ...Object.keys(night)])];
    names.sort((a, b) => bandOrder(a) - bandOrder(b) || a.localeCompare(b));
    return names.map((band) => ({ band, day: day[band] || '', night: night[band] || '' }));
}

// --- freshness --------------------------------------------------------------

// How old the reading is, from the server's own last_update rather than from
// when we fetched it: the poll below runs every minute but NOAA is refreshed on
// the server's schedule, so "fetched 3 s ago" would claim a freshness the data
// does not have. Anything in the future — a browser clock ahead of the
// server's — reads as "just now" rather than as a negative age.
export function ageLabel(atMs, nowMs) {
    if (!atMs) return '';
    const secs = Math.max(0, Math.floor((nowMs - atMs) / 1000));
    if (secs < 90) return 'just now';
    if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
    const hours = Math.floor(secs / 3600);
    if (hours < 24) return `${hours} h ago`;
    return `${Math.floor(hours / 24)} d ago`;
}

// Milliseconds for the timestamp on a reply, or null when it is missing or
// unparseable — an unusable date must not become 1970 and read as "20955 d ago".
export function updatedAt(sw) {
    const t = sw && (sw.last_update || sw.timestamp);
    if (!t) return null;
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms : null;
}

// --- shared polling ---------------------------------------------------------
//
// Lazy in both directions, as lib/voiceActivity.js is: nothing is fetched until
// something subscribes, and the loop stops when the last subscriber goes. The
// panel is unmounted while its section is collapsed, so "nobody watching" is a
// normal state and not an edge case.

const subscribers = new Set();
let timer = null;
let latest = null;
let inFlight = false;

function emit(state) {
    latest = state;
    for (const fn of subscribers) {
        try { fn(state); } catch (err) { console.error('space weather subscriber threw', err); }
    }
}

function load() {
    if (inFlight) return;
    inFlight = true;
    fetch(ENDPOINT)
        .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        })
        .then((data) => emit({ data, error: '', at: Date.now() }))
        // Keep the last good reading and report the failure alongside it. These
        // numbers change on the hour, so one missed request is no reason to
        // blank a panel that is still showing something true.
        .catch((err) => emit({
            data: latest ? latest.data : null,
            error: err.message || String(err),
            at: latest ? latest.at : 0,
        }))
        .finally(() => { inFlight = false; });
}

export function subscribeSpaceWeather(fn) {
    subscribers.add(fn);
    // Replay, so a panel opened mid-cycle draws at once instead of sitting on
    // "Loading…" for up to a minute with the data already in hand.
    if (latest) {
        try { fn(latest); } catch (err) { console.error('space weather subscriber threw', err); }
    }
    if (timer === null) {
        load();
        timer = setInterval(load, POLL_MS);
    }
    return () => {
        subscribers.delete(fn);
        if (subscribers.size === 0 && timer !== null) {
            clearInterval(timer);
            timer = null;
        }
    };
}

// Test seam.
export function _resetSpaceWeather() {
    subscribers.clear();
    if (timer !== null) clearInterval(timer);
    timer = null;
    latest = null;
    inFlight = false;
}

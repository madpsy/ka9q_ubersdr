// Twenty-four hours of every band the noise floor monitor watches.
//
// The four 24-hour charts on static/noisefloor.html are four views of one
// array: the page fetches a band's trend once and draws the noise floor, the
// dynamic range, the FT8 SNR and the band's condition from the same points
// (noisefloor.js `trendDataCache`). This does the same, for every band at once.
//
// ── Why the plural endpoint ─────────────────────────────────────────────────
//
// /api/noisefloor/trend?date=…&band=… is what v1 uses, and it has two problems
// here. It is one request per band, so following the dial across a band edge
// would refetch; and its rolling-24-hour behaviour is conditional on `date`
// matching the *server's* local date (noise_floor.go GetTrendData) — v1 sends
// the browser's UTC date, so on a receiver whose local day differs from the
// browser's UTC day the reply is a calendar day rather than the last 24 hours,
// silently.
//
// /api/noisefloor/trends takes no parameters, is always now−24 h → now, and
// returns { band: [measurement, …] } for the lot. One request covers every band
// and every metric, so changing band — by hand or by tuning — costs nothing.
//
// ── The rate ────────────────────────────────────────────────────────────────
//
// The server averages into 10-minute buckets, so a poll faster than that
// returns the same array. Ten minutes is the floor as well as the period, and
// enforced the same way lib/bandNoise.js enforces its minute: stamped when the
// request goes out, so opening and closing the panel cannot turn into a request
// per open. Both stores are held by the same panel and neither drives the
// other — the readings above the chart are a minute old at most, the chart
// behind them moves every ten.

import { classify } from './bandConditions.js';
import { feedInterval } from './serverFeeds.js';

export const TRENDS_URL = '/api/noisefloor/trends';
export const POLL_MS = 10 * 60 * 1000;
/** The server's averaging bucket. Also how wide a single reading is drawn. */
export const BUCKET_MS = 10 * 60 * 1000;
/** What the chart covers, matching what the endpoint returns. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How long a hole in the series has to be before the trace is broken across it.
 *
 * Two and a half buckets. A single missed measurement is noise in the recording
 * and joining across it is honest; a receiver that was off for six hours is not
 * a band whose noise floor slid smoothly from one value to the other, and a
 * straight line across the gap would say exactly that.
 */
export const MAX_GAP_MS = 25 * 60 * 1000;

// ── What can be plotted ─────────────────────────────────────────────────────

/**
 * The three series worth a chart, and what each is called.
 *
 * noisefloor.html gives each of these its own full-width chart and stacks them.
 * A dock column has room for one, so they share it and the selector says which
 * — the data is one array either way, so switching is free and instant.
 *
 * `zeroIsAbsent` is the FT8 SNR's alone: the field is a float32 that is zero
 * both when nothing was heard and when the pass has not run, so plotting the
 * zeros would drag the trace to the axis every quiet bucket and read as the
 * band having collapsed rather than as nobody having called.
 */
export const METRICS = [
    {
        key: 'floor',
        label: 'Floor',
        field: 'p5_db',
        unit: 'dB',
        title: 'Noise floor (P5) over the last 24 hours',
    },
    {
        key: 'range',
        label: 'Range',
        field: 'dynamic_range',
        unit: 'dB',
        title: 'Dynamic range (P95 − P5) over the last 24 hours — the room the band has for a weak signal',
    },
    {
        key: 'snr',
        label: 'SNR',
        field: 'ft8_snr',
        unit: 'dB',
        zeroIsAbsent: true,
        title: 'FT8 signal-to-noise over the last 24 hours. Buckets where nothing was heard are gaps, not zeroes',
    },
];

export const DEFAULT_METRIC = 'floor';

export function metricByKey(key) {
    return METRICS.find((m) => m.key === key) || METRICS[0];
}

const METRIC_KEY = 'ubersdr.v2.bandstats.metric';

/**
 * Which series the chart opens on.
 *
 * Remembered for the same reason the band pin is (lib/bandNoise.js): an
 * operator who watches the FT8 SNR watches it every session, and a choice that
 * has to be made again every time the panel is opened is not a choice. Resolved
 * through metricByKey, so a stored key that no longer names a metric falls back
 * rather than blanking the chart.
 */
export function savedMetric() {
    try {
        const raw = localStorage.getItem(METRIC_KEY);
        return metricByKey(raw).key;
    } catch (e) {
        return DEFAULT_METRIC;
    }
}

export function saveMetric(key) {
    try {
        localStorage.setItem(METRIC_KEY, metricByKey(key).key);
    } catch (e) { /* private mode */ }
}

// ── Reading a reply ─────────────────────────────────────────────────────────

/** Whether this receiver has any history at all for `band`. */
export function hasTrend(trends, band) {
    return !!(trends && band && Array.isArray(trends[band]) && trends[band].length);
}

/**
 * One band's readings of one metric, oldest first, as {t, v}.
 *
 * Anything unusable is dropped rather than substituted: a point with no
 * timestamp cannot be placed, and a missing reading is a gap in what was
 * recorded. Both come back as breaks in the trace, which is what they are.
 */
export function seriesFor(trends, band, metric) {
    const rows = (trends && trends[band]) || [];
    const out = [];
    for (const r of rows) {
        if (!r) continue;
        const t = Date.parse(r.timestamp);
        if (!Number.isFinite(t)) continue;
        const v = r[metric.field];
        if (!Number.isFinite(v)) continue;
        if (metric.zeroIsAbsent && v <= 0) continue;
        out.push({ t, v });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
}

/**
 * The same band's condition, bucket by bucket, for the strip under the chart.
 *
 * Every bucket is kept, including the ones with no FT8 — those are the strip's
 * point as much as the loud ones are, because "20m was open from 0700 and shut
 * at 1900" is a shape you read off the quiet either side of it.
 *
 * The buckets are the band keys' (lib/bandConditions.js `classify`), so a green
 * hour on this strip is the same green the band key was showing at the time.
 */
export function conditionSeries(trends, band) {
    const rows = (trends && trends[band]) || [];
    const out = [];
    for (const r of rows) {
        if (!r) continue;
        const t = Date.parse(r.timestamp);
        if (!Number.isFinite(t)) continue;
        const v = r.ft8_snr;
        out.push({ t, tone: Number.isFinite(v) && v > 0 ? classify(v).toLowerCase() : 'none' });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
}

/**
 * Contiguous stretches of one condition, as {from, to, tone}.
 *
 * Run-length encoded because a day is 144 buckets and the strip is a few
 * hundred pixels: drawn one rectangle per bucket they would seam, and there is
 * nothing to see in a boundary between two buckets of the same colour.
 *
 * A run ends where the next bucket starts, unless the series jumps — after an
 * outage the last bucket before it is one bucket long, not six hours long.
 */
export function conditionRuns(points, maxGap = MAX_GAP_MS) {
    const out = [];
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const next = points[i + 1];
        const contiguous = next && next.t - p.t <= maxGap;
        const to = contiguous ? next.t : p.t + BUCKET_MS;
        const last = out[out.length - 1];
        if (last && last.tone === p.tone && last.to >= p.t) last.to = to;
        else out.push({ from: p.t, to, tone: p.tone });
    }
    return out;
}

/**
 * The series split into stretches that may be joined by a line.
 *
 * Returned as an array of arrays rather than as one array with holes in it,
 * because that is what drawing wants: one path per stretch, and no decision to
 * make per point about whether this segment is real.
 */
export function spans(series, maxGap = MAX_GAP_MS) {
    const out = [];
    let run = null;
    for (const p of series) {
        if (run && p.t - run[run.length - 1].t <= maxGap) run.push(p);
        else { run = [p]; out.push(run); }
    }
    return out;
}

/** The reading nearest a moment, for the hover readout, or null. */
export function nearest(series, t) {
    let best = null;
    let bestGap = Infinity;
    for (const p of series) {
        const gap = Math.abs(p.t - t);
        if (gap < bestGap) { bestGap = gap; best = p; }
    }
    return best;
}

// ── The scales ──────────────────────────────────────────────────────────────

/** A step a human would have chosen: 1, 2 or 5 times a power of ten. */
export function niceStep(raw) {
    if (!(raw > 0)) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / pow;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

/**
 * The vertical scale for a set of readings: padded, snapped to a round step,
 * and never narrower than `minSpan`.
 *
 * The floor is the reason for the minimum. A quiet night's noise floor moves
 * about a decibel, and a scale fitted to it turns that decibel into the full
 * height of the chart — every ripple of the measurement looks like an event.
 * Six decibels is the same argument the main spectrum's auto-range makes for
 * its own minimum span, at the size this chart is drawn.
 */
export function niceRange(series, { minSpan = 6, pad = 0.08 } = {}) {
    if (!series || !series.length) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of series) {
        if (p.v < lo) lo = p.v;
        if (p.v > hi) hi = p.v;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;

    let span = hi - lo;
    if (span < minSpan) {
        const mid = (lo + hi) / 2;
        lo = mid - minSpan / 2;
        hi = mid + minSpan / 2;
        span = minSpan;
    }
    lo -= span * pad;
    hi += span * pad;

    const step = niceStep((hi - lo) / 4);
    return {
        min: Math.floor(lo / step) * step,
        max: Math.ceil(hi / step) * step,
        step,
    };
}

/** The horizontal grid lines: every `step` from min to max inclusive. */
export function levelTicks(range) {
    if (!range) return [];
    const out = [];
    // Counted rather than accumulated: adding a float step 30 times lands a
    // hair off the top and drops the last line.
    const n = Math.round((range.max - range.min) / range.step);
    for (let i = 0; i <= n; i++) out.push(range.min + i * range.step);
    return out;
}

const HOUR_MS = 60 * 60 * 1000;
const HOUR_STEPS = [1, 2, 3, 4, 6, 12, 24];

/**
 * Times to label the x axis at, on the hour, in the operator's own timezone.
 *
 * Stepped with setHours rather than by adding milliseconds so the labels stay
 * on the hour across a daylight-saving change — over a 24-hour window that
 * happens twice a year and would otherwise put every label at half past.
 */
export function hourTicks(from, to, maxTicks = 5) {
    if (!(to > from)) return [];
    const hours = (to - from) / HOUR_MS;
    const stepH = HOUR_STEPS.find((h) => hours / h <= maxTicks) || 24;

    const d = new Date(from);
    d.setMinutes(0, 0, 0);
    if (d.getTime() < from) d.setHours(d.getHours() + 1);
    // Onto a multiple of the step, so the labels are 00:00, 06:00, 12:00 rather
    // than wherever the window happened to open.
    let guard = 0;
    while (d.getHours() % stepH !== 0 && guard++ < 24) d.setHours(d.getHours() + 1);

    const out = [];
    while (d.getTime() <= to && out.length <= 48) {
        out.push({ t: d.getTime(), label: `${String(d.getHours()).padStart(2, '0')}:00` });
        d.setHours(d.getHours() + stepH);
    }
    return out;
}

/** A time of day, for the hover readout. */
export function clockAt(t) {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── The store ───────────────────────────────────────────────────────────────

let state = { trends: null, error: null, at: 0 };
let lastRequestAt = 0;
let inFlight = false;
const subscribers = new Set();
let timer = null;

export function getNoiseTrend() {
    return state;
}

function emit() {
    for (const fn of subscribers) {
        try { fn(state); } catch (err) { console.error('noise trend subscriber threw', err); }
    }
}

function settle(next) {
    state = { ...state, ...next };
    emit();
}

/**
 * What a 404 from this endpoint actually means.
 *
 * Two quite different things, and only the body tells them apart: a receiver
 * with no database will never have history, and one that has simply not
 * recorded any yet will have some in ten minutes. Saying "not found" for both
 * would leave an operator waiting for the first and reconfiguring for the
 * second.
 */
export function trendFault(body) {
    const text = String((body && body.error) || '');
    if (/database/i.test(text)) return 'This receiver does not store history.';
    return 'No history recorded yet.';
}

function load() {
    if (inFlight) return;
    // The rule. Stamped on the way out, not on the way back — see the header.
    if (lastRequestAt && Date.now() - lastRequestAt < POLL_MS) return;
    lastRequestAt = Date.now();
    inFlight = true;

    fetch(TRENDS_URL)
        .then((r) => {
            // Nothing recorded in the window: the monitor is running and the
            // chart is empty, which is not an error.
            if (r.status === 204) return { trends: {}, error: null };
            if (r.status === 503) throw new Error('Noise floor monitoring is not enabled');
            if (r.status === 404) {
                return r.json().catch(() => null).then((b) => ({ trends: {}, error: trendFault(b) }));
            }
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json().then((d) => ({ trends: d && typeof d === 'object' ? d : {}, error: null }));
        })
        .then((next) => {
            inFlight = false;
            settle({ ...next, at: Date.now() });
        })
        .catch((err) => {
            inFlight = false;
            // The chart already on screen is kept: it is a day of history, and
            // one failed poll has not changed any of it.
            settle({ error: err.message || 'unavailable' });
        });
}

/**
 * Subscribes to the history. `fn` is called with what is already known
 * immediately, and again on every refresh. Returns the unsubscribe.
 */
export function subscribeNoiseTrend(fn) {
    subscribers.add(fn);
    if (subscribers.size === 1) timer = feedInterval(load, POLL_MS);
    try { fn(state); } catch (err) { console.error('noise trend subscriber threw', err); }

    return () => {
        if (!subscribers.delete(fn)) return;
        if (subscribers.size > 0) return;
        if (timer) timer();
        timer = null;
        // Kept, like the live readings are: a day of history is still a day of
        // history a moment later, and holding it is what lets the chart come
        // back instantly when the panel is reopened.
    };
}

/** Test seam, with the same contract as resetBandNoise. */
export function resetNoiseTrend({ keepState = false } = {}) {
    subscribers.clear();
    if (timer) timer();
    timer = null;
    if (!keepState) state = { trends: null, error: null, at: 0 };
    lastRequestAt = 0;
    inFlight = false;
}

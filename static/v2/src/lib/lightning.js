// The lightning addon: VLF sferics detected off this receiver.
//
// The addon listens to a 48 kHz VLF slice in IQ, triggers when the smoothed power clears
// the noise floor by THRESHOLD_DB (25 dB by default), and publishes each strike with a
// GPS-synchronised timestamp of its leading edge — the timestamp being the point of it,
// since that is what lets several receivers work out where a strike was by when each of
// them heard it.
//
// Its own page has the waveform captures, the spectrum, the map and the full log. This
// is the dock version: is it striking, how hard, how often, and when was the last one.
// That is what a panel three inches wide can answer honestly, and it is what you want
// while listening to something else — the rest is a click away.
//
// ── Which stream, and why the compact one ────────────────────────────────────
//
// /api/events carries three things: the strike itself, a ±10 ms waveform capture for
// each (about 7.5 KB), and an FFT frame every five seconds. `?minimal=1` sends only the
// strikes, at about 150 bytes each. Nothing here draws a waveform or a spectrum, so the
// compact stream is not a compromise — subscribing to the full one would be paying a
// few kilobytes a strike to throw them away.
//
// A live strike is placed at the moment it arrives rather than at its own timestamp,
// even now the compact message carries timestamp_ns: the receiver keeps GPS time and
// this browser keeps whatever time its machine has, and a strike stamped a second in
// this clock's future would fall off the right of the strip. Over a local network the
// difference is a few milliseconds, which does not show with one-second bins — and the
// displayed clock is the addon's own string, so nothing here has to guess at a date or
// a time zone. The backfill from /api/strikes is placed by timestamp_ns as given; see
// normaliseStrike. Older addons sent no id in the compact message, which is why a live
// strike without one is given an id of its own.
//
// ── The addon's status ─────────────────────────────────────────────────────────
//
// /api/status carries what the addon works out over the last ten minutes and that the
// strikes alone do not: the storm trend (coming or going) and whether a mains impulse
// train is being filtered out. Polled, not streamed; see normaliseStatus.

import { clockOf } from './format.js';

export const BASE = '/addon/lightning';

export const ADDON_NAME = 'lightning';

/** The addon's own page, the same route the Addons panel links to. */
export const addonUrl = (base = BASE) => `${base}/`;

/** Is the addon on this receiver? Same test the SSTV panel makes. */
export function lightningAvailable(serverInfo) {
    const addons = serverInfo && serverInfo.addons;
    return Array.isArray(addons)
        && addons.some((n) => String(n).toLowerCase() === ADDON_NAME);
}

// How much history to ask for when the panel opens, and over what window. An hour is
// the span the headline figures are quoted over; 400 strikes is a busy storm's worth of
// it and a request small enough not to matter.
export const HISTORY_WINDOW = '1h';
export const HISTORY_MAX = 400;

export const strikesUrl = (base = BASE) =>
    `${base}/api/strikes?minimal=1&since=${HISTORY_WINDOW}&n=${HISTORY_MAX}`;

export const streamUrl = (base = BASE) => `${base}/api/events?minimal=1`;

export const statusUrl = (base = BASE) => `${base}/api/status`;

// The window the rate and the activity strip are measured over. Sixty seconds, with one
// bar per second, which is the addon's own choice and a good one: a storm overhead is
// several a second and a distant one is a few a minute, and both read on the same chart.
export const WINDOW_S = 60;

// How many strikes the panel lists. Six fills a dock column without scrolling it.
export const LIST_MAX = 6;

// How long the panel keeps strikes for. The strip needs a minute, the headline figures
// need an hour, and an hour of a serious storm is a few thousand small objects — worth
// a cap, not worth a large one.
export const KEEP_MS = 60 * 60 * 1000;
export const KEEP_MAX = 2000;

// Where the SNR bands are. The addon's own thresholds, so a strike that is "strong" here
// is the one that is strong on its page: 40 dB and up is a close or hard strike, 30 to
// 40 an ordinary one, below that a distant sferic not far over the trigger level (25 dB
// over the floor by default, so nothing much below that ever arrives).
export const SNR_HI = 40;
export const SNR_MED = 30;
// Where a list row's bar is full. The addon's own scale, as its SNR bar and strip use.
export const SNR_FULL_DB = 50;

// How many strikes in ten minutes make a storm. The addon's stormMinStrikes, the same
// rule behind its trend and its storm-active sensor: one isolated impulse over the
// threshold is what a noisy site throws up now and then, and is not a storm.
export const STORM_MIN_STRIKES = 5;
export const STORM_WINDOW_MS = 10 * 60 * 1000;

/** 'hi' | 'med' | 'lo' — the addon's snrClass, kept identical on purpose. */
export function snrBand(db) {
    const v = Number(db) || 0;
    if (v >= SNR_HI) return 'hi';
    if (v >= SNR_MED) return 'med';
    return 'lo';
}

// The strip's colours: the theme's, so the chart belongs to the interface it is sitting
// in rather than to the addon's palette — the same three bands, and the same variables
// the `.lx__stat-v` and `.lx__row` classes use, so a bar is the colour its row is.
//
// Resolved to real colours rather than handed to the canvas as `var(--bad)`. A canvas
// context has no element to resolve a custom property against: the spec says an
// unparseable fillStyle is *ignored*, so every bar was painted in the default black —
// on a --spec-bg background, which is black. The strip looked empty however hard it was
// striking.
export const TONE_VARS = { hi: '--bad', med: '--warn', lo: '--accent' };

// Where a variable is missing — a theme mid-swap, a canvas drawn before the stylesheet
// has applied — the strip is drawn in these rather than in nothing. They are the dark
// theme's values from styles.css.
export const TONE_FALLBACK = { hi: '#f2646a', med: '#f2b544', lo: '#08a2fb' };

/**
 * The three band colours, given a way to read a CSS custom property.
 *
 * `read` is a `(name) => string`, i.e. a computed style's getPropertyValue bound to
 * whatever element the canvas is in. Keeping the lookup a parameter is what makes this
 * testable without a DOM, and what stops a `var(...)` string reaching the canvas again.
 */
export function stripTone(read) {
    const out = {};
    for (const band of Object.keys(TONE_VARS)) {
        const raw = read ? read(TONE_VARS[band]) : '';
        const value = typeof raw === 'string' ? raw.trim() : '';
        out[band] = value && !value.startsWith('var(') ? value : TONE_FALLBACK[band];
    }
    return out;
}

/**
 * One strike, from either source, in the shape the panel uses.
 *
 * `at` is epoch ms: the arrival time for a live strike (`arrivedAt` given), and the
 * addon's nanosecond timestamp for the history — see the note at the top for why a live
 * one is not placed by its own timestamp. `time` is the addon's own UTC clock string where it sent one, so the panel never
 * formats a time the addon has already formatted.
 */
export function normaliseStrike(raw, arrivedAt) {
    if (!raw || typeof raw !== 'object') return null;
    const ns = Number(raw.timestamp_ns);
    let at = arrivedAt;
    if (at == null) at = Number.isFinite(ns) && ns > 0 ? Math.round(ns / 1e6) : Date.now();
    const snr = Number(raw.snr_db);
    const width = Number(raw.width_us);
    return {
        // The addon's UUID where there is one. Live compact messages have none, so
        // falling back to the time keeps React keys unique without inventing an id that
        // could collide with a real one.
        id: raw.id || `${at}-${raw.time || ''}`,
        at,
        time: typeof raw.time === 'string' && raw.time ? raw.time : clockOf(at),
        snr: Number.isFinite(snr) ? snr : 0,
        ms: Number(raw.duration_ms) || 0,
        // The width of the main pulse at half its peak. What the addon now shows where
        // it used to show the duration, which became how long the smoothed power stayed
        // over the threshold — a tenth of a millisecond or so for nearly every strike.
        // null from an addon that predates it.
        widthUs: Number.isFinite(width) && width > 0 ? width : null,
        flash: Number(raw.flash) || 0,
        peak: Number(raw.peak_amplitude) || 0,
        saturated: !!raw.saturated,
    };
}

/**
 * A list row's last column: the pulse width, compact. From an addon too old to send one,
 * the duration as before.
 */
export function pulseLabel(s) {
    if (!s) return '';
    if (s.widthUs != null) {
        return s.widthUs >= 1000 ? `${(s.widthUs / 1000).toFixed(1)}ms` : `${Math.round(s.widthUs)}µs`;
    }
    return `${(s.ms || 0).toFixed(1)}ms`;
}

// The addon's storm trend words, as its own page shows them.
export const TREND_TEXT = {
    distant: 'distant',
    approaching: 'approaching',
    overhead: 'overhead',
    receding: 'receding',
    steady: 'steady',
};

/**
 * The addon's /api/status, in the shape the panel uses, or null.
 *
 * Null from an addon that predates the detector and activity blocks, which is the panel's
 * cue to leave the storm figure at a dash rather than invent one from the strikes.
 */
export function normaliseStatus(raw) {
    const d = raw && raw.detector;
    const a = raw && raw.activity;
    if (!d || !a || typeof a !== 'object') return null;
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const trend = typeof a.trend === 'string' && a.trend ? a.trend : 'none';
    return {
        trend,
        level: typeof a.level === 'string' ? a.level : 'none',
        rateNow: num(a.trend_rate_now),
        ratePrev: num(a.trend_rate_prev),
        dbChange: num(a.trend_db_change),
        hour: num(a.strikes_last_hour),
        state: typeof d.state === 'string' ? d.state : '',
        mains: !!d.mains_active,
    };
}

/** The storm figure's word, or a dash when there is no storm or no status. */
export const trendLabel = (st) =>
    (!st || st.trend === 'none' ? '—' : TREND_TEXT[st.trend] || st.trend);

/**
 * The storm figure's colour. The addon's page reds the two that mean "coming for you" and
 * greens the one that means "going away"; the rest are not news and are left plain.
 */
export function trendTone(st) {
    if (!st) return undefined;
    if (st.trend === 'approaching' || st.trend === 'overhead') return 'hi';
    if (st.trend === 'receding') return 'good';
    return undefined;
}

/** What the storm figure's tooltip says: the two halves of the ten minutes it compares. */
export function trendDetail(st) {
    if (!st || st.trend === 'none') return 'No storm: fewer than five strikes in ten minutes';
    let out = `${st.ratePrev.toFixed(1)} → ${st.rateNow.toFixed(1)} /min over the last ten minutes`;
    if (st.dbChange) out += `, ${st.dbChange >= 0 ? '+' : ''}${st.dbChange.toFixed(1)} dB`;
    return out;
}

/** Just the seconds, for a display too narrow for the milliseconds the addon sends. */
export const shortClock = (time) => String(time || '').slice(0, 8);

/**
 * Add a strike to the list, newest first, and drop what has aged out.
 *
 * Deduplicated by id: the backfill and the stream overlap by however long the first
 * request took, and a strike counted twice is a rate that is wrong for an hour.
 */
export function addStrike(list, strike, now = Date.now()) {
    if (!strike) return list;
    if (list.some((s) => s.id === strike.id)) return list;
    const out = [strike, ...list];
    return trimStrikes(out, now);
}

export function trimStrikes(list, now = Date.now()) {
    const cutoff = now - KEEP_MS;
    const kept = list.filter((s) => s.at >= cutoff);
    return kept.length > KEEP_MAX ? kept.slice(0, KEEP_MAX) : kept;
}

/** Strikes per minute over the last WINDOW_S, which is how the addon quotes it. */
export function strikeRate(list, now = Date.now()) {
    const cutoff = now - WINDOW_S * 1000;
    const n = list.filter((s) => s.at >= cutoff).length;
    return n / (WINDOW_S / 60);
}

/** How many in the last hour, and the hardest of them. */
export function hourStats(list, now = Date.now()) {
    const cutoff = now - KEEP_MS;
    let count = 0;
    let best = null;
    for (const s of list) {
        if (s.at < cutoff) continue;
        count++;
        if (best == null || s.snr > best) best = s.snr;
    }
    return { count, best };
}

/**
 * The activity strip: one bucket per second over the window, newest at the right.
 *
 * Each bucket carries how many strikes fell in it and the hardest of them, because the
 * two say different things — a bar's height is how many, its colour is how close. An
 * empty second is a bucket of zero rather than a gap, so the strip scrolls smoothly and
 * a quiet minute looks like a quiet minute rather than like no data.
 */
export function activityBuckets(list, now = Date.now(), windowS = WINDOW_S) {
    const out = Array.from({ length: windowS }, () => ({ n: 0, snr: 0 }));
    const start = now - windowS * 1000;
    for (const s of list) {
        if (s.at < start || s.at > now) continue;
        // Which second it falls in, counting back from now: the last bucket is the
        // second in progress.
        const i = Math.min(windowS - 1, Math.floor((s.at - start) / 1000));
        out[i].n++;
        if (s.snr > out[i].snr) out[i].snr = s.snr;
    }
    return out;
}

// The flash, when a strike lands: how bright, from how hard it was.
//
// The addon's own page flashes the whole window white-to-orange on every strike, and it
// is the best thing about it — you look up because the room changed, not because a
// number did. The panel version is the same idea at panel size.
//
// Brightness is the whole of what the strike says here. The hue is lightning's — a white
// core in a yellow-white glow, see `.lx__flash` in styles.css — and not the strike's SNR
// band, because a band colour puts a close strike behind the red this interface uses for
// something being wrong. The bands still colour everything that is read rather than seen:
// the figures, the strip and the list.
//
// So brightness scales with SNR rather than being fixed, because a fixed flash makes a
// distant sferic look like a strike overhead. Floor and ceiling both matter: below the
// floor a real strike would go unnoticed, and above the ceiling a busy storm is a
// strobe. The ramp runs from FLASH_FROM_DB, the addon's default trigger level and so
// the faintest strike it normally sends, to FLASH_FULL_DB, the top of its own SNR scale.
// From zero instead, every strike there is would sit in the top half of the range.
export const FLASH_MIN = 0.22;
export const FLASH_MAX = 0.58;
export const FLASH_FROM_DB = 25;
export const FLASH_FULL_DB = 50;

export function flashStrength(db) {
    const v = Number(db);
    if (!Number.isFinite(v) || v <= FLASH_FROM_DB) return FLASH_MIN;
    const frac = Math.min(1, (v - FLASH_FROM_DB) / (FLASH_FULL_DB - FLASH_FROM_DB));
    return FLASH_MIN + (FLASH_MAX - FLASH_MIN) * frac;
}


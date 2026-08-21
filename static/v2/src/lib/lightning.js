// The lightning addon: VLF sferics detected off this receiver.
//
// The addon listens to 1–49 kHz in IQ, triggers on the envelope against an adaptive
// noise floor, and publishes each strike with a GPS-synchronised timestamp — the
// timestamp being the point of it, since that is what lets several receivers work out
// where a strike was by when each of them heard it.
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
// The cost is that the compact message carries `time` as "HH:MM:SS.mmm" and no epoch,
// so a live strike is placed at the moment it arrives rather than at its own timestamp.
// Over a local network that is a few milliseconds, which does not show on a bar chart
// with one-second bins — and the displayed clock is the addon's own string, so nothing
// here has to guess at a date or a time zone. The backfill from /api/strikes does carry
// timestamp_ns and is used as given; see normaliseStrike.

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
// is the one that is strong on its page: 20 dB and up is a close or hard strike, 12 to
// 20 is an ordinary one, below that is a distant sferic barely over the floor.
export const SNR_HI = 20;
export const SNR_MED = 12;

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
 * `at` is epoch ms: the addon's nanosecond timestamp where there is one (the history),
 * and the arrival time where there is not (the compact stream) — see the note at the
 * top. `time` is the addon's own UTC clock string where it sent one, so the panel never
 * formats a time the addon has already formatted.
 */
export function normaliseStrike(raw, arrivedAt = Date.now()) {
    if (!raw || typeof raw !== 'object') return null;
    const ns = Number(raw.timestamp_ns);
    const at = Number.isFinite(ns) && ns > 0 ? Math.round(ns / 1e6) : arrivedAt;
    const snr = Number(raw.snr_db);
    return {
        // The addon's UUID where there is one. Live compact messages have none, so
        // falling back to the time keeps React keys unique without inventing an id that
        // could collide with a real one.
        id: raw.id || `${at}-${raw.time || ''}`,
        at,
        time: typeof raw.time === 'string' && raw.time ? raw.time : clockOf(at),
        snr: Number.isFinite(snr) ? snr : 0,
        ms: Number(raw.duration_ms) || 0,
        peak: Number(raw.peak_amplitude) || 0,
        saturated: !!raw.saturated,
    };
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
// strobe. FLASH_FULL_DB is where it reaches full brightness — 30 dB is a close strike,
// and everything harder than that is close enough.
export const FLASH_MIN = 0.22;
export const FLASH_MAX = 0.58;
export const FLASH_FULL_DB = 30;

export function flashStrength(db) {
    const v = Number(db);
    if (!Number.isFinite(v) || v <= 0) return FLASH_MIN;
    const frac = Math.min(1, v / FLASH_FULL_DB);
    return FLASH_MIN + (FLASH_MAX - FLASH_MIN) * frac;
}


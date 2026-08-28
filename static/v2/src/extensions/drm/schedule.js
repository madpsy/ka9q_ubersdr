// The DRM broadcast schedule, as the panel needs it.
//
// The data comes from the server's /api/drm/schedule, which fetches drmrx.org
// once a day and holds it in memory (see drm_schedule.go). The panel never
// talks to drmrx.org itself: it sends no CORS header, so the browser could not
// read it even though the file is public.
//
// A DRM station is not one entry. Each broadcaster runs several frequencies and
// several time slots on each, so what arrives is a flat list of transmissions —
// one row per (station, frequency, slot) — and the grouping this file does is
// the panel's, not the schedule's.
//
// `on_air` is computed by the server and taken at face value. A browser clock
// that is minutes out would otherwise disagree with the very thing the panel
// exists to answer.

/** How long a fetched schedule is reused before asking the server again. */
export const SCHEDULE_TTL_MS = 30 * 60 * 1000;

// One shared result for the whole app. The panel can be opened, closed and
// reopened repeatedly, and each open should not be another request.
let cache = null; // { at, data }
let inflight = null;

/** Drop the cache. Exported for tests and for an explicit refresh. */
export function resetSchedule() {
    cache = null;
    inflight = null;
}

/**
 * The schedule, from the cache when it is fresh enough.
 *
 * Never rejects: an unreachable or disabled schedule is a panel with no list in
 * it, not an error the operator has to dismiss. The `error` field says which,
 * for the one line the panel prints.
 */
export function fetchSchedule({ force = false } = {}) {
    const now = Date.now();
    if (!force && cache && now - cache.at < SCHEDULE_TTL_MS) {
        return Promise.resolve(cache.data);
    }
    if (!force && inflight) return inflight;

    inflight = fetch('/api/drm/schedule')
        .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        })
        .then((json) => {
            const data = {
                enabled: json.enabled !== false,
                loaded: !!json.loaded,
                source: json.source || '',
                loadedAt: json.loaded_at || null,
                nowUtc: json.now_utc || null,
                entries: Array.isArray(json.entries) ? json.entries : [],
                // Why the *server's* own fetch failed, which is a different
                // failure from ours below and needs saying differently: one is
                // "your receiver cannot reach drmrx.org", the other is "you
                // cannot reach your receiver".
                serverError: json.last_error || null,
                stale: !!json.stale,
                error: null,
            };
            cache = { at: Date.now(), data };
            inflight = null;
            return data;
        })
        .catch((e) => {
            inflight = null;
            // Not cached: a failure should be retried on the next open rather
            // than held for the half hour a success is.
            return {
                enabled: true, loaded: false, source: '', loadedAt: null, nowUtc: null,
                entries: [], serverError: null, stale: false,
                error: e.message || 'could not be reached',
            };
        });

    return inflight;
}

// ── local time ──────────────────────────────────────────────────────────────
//
// A broadcast schedule is published in UTC and that is how it is read, so UTC is
// what the panel shows by default. But "is that this evening or the middle of
// the night for me" is a real question, and the answer is one subtraction, so
// the panel offers it.
//
// Everything below works in minutes past midnight and wraps within the day. A
// slot does not become a different slot in another zone: 17:00–18:00 UTC at
// +06:30 is 23:30–00:30, which reads as crossing midnight because it does.

/**
 * The browser's offset from UTC in minutes, positive east of Greenwich.
 *
 * Taken from a Date rather than assumed constant: half the world moves twice a
 * year, and India and Nepal are not on a whole number of hours at all, so an
 * offset in hours would be wrong for a fifth of DRM's audience.
 */
export function localOffsetMinutes(at = new Date()) {
    return -at.getTimezoneOffset();
}

/** An HHMM integer moved by an offset in minutes, wrapping within the day. */
export function shiftHHMM(hhmm, offsetMinutes) {
    const v = Math.max(0, Math.min(2400, Number(hhmm) || 0));
    const mins = Math.floor(v / 100) * 60 + (v % 100);
    const day = 24 * 60;
    const moved = (((mins + (Number(offsetMinutes) || 0)) % day) + day) % day;
    return Math.floor(moved / 60) * 100 + (moved % 60);
}

/** "UTC+5:45", "UTC−4", "UTC" — how the toggle names the offset it applies. */
export function formatOffsetLabel(offsetMinutes) {
    const m = Number(offsetMinutes) || 0;
    if (m === 0) return 'UTC';
    const sign = m < 0 ? '−' : '+';
    const abs = Math.abs(m);
    const h = Math.floor(abs / 60);
    const mm = abs % 60;
    return `UTC${sign}${h}${mm ? `:${String(mm).padStart(2, '0')}` : ''}`;
}

/** "1830" → "18:30". The server sends HHMM integers, as EiBi does. */
export function formatSlotTime(hhmm) {
    const v = Math.max(0, Math.min(2400, Number(hhmm) || 0));
    const h = Math.floor(v / 100);
    const m = v % 100;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * The slot as one label: "18:30–19:00", or "24h" for a station that never leaves
 * the air — of which there are plenty, All India Radio's mediumwave
 * transmitters being most of them.
 *
 * `offsetMinutes` shifts it out of UTC. An all-day entry is left alone: it is on
 * air at every moment of every day, and rendering it as "05:45–05:45" in Nepal
 * would be arithmetically right and completely useless.
 */
export function formatSlot(entry, offsetMinutes = 0) {
    if (!entry) return '';
    if (entry.start_utc === 0 && entry.end_utc === 2400) return '24h';
    const off = Number(offsetMinutes) || 0;
    return `${formatSlotTime(shiftHHMM(entry.start_utc, off))}–${formatSlotTime(shiftHHMM(entry.end_utc, off))}`;
}

/**
 * Both readings of the slot, for the row's tooltip.
 *
 * Whichever the row is showing, the other one is a hover away rather than a
 * mode switch — and the days are always UTC days, which is worth saying on an
 * entry that only runs on some of them.
 */
export function describeSlot(entry, offsetMinutes = 0) {
    if (!entry) return '';
    const off = Number(offsetMinutes) || 0;
    if (entry.start_utc === 0 && entry.end_utc === 2400) {
        return entry.days && entry.days !== 'Daily' ? `On air all day, ${entry.days} UTC` : 'On air all day';
    }
    const utc = `${formatSlot(entry, 0)} UTC`;
    const line = off === 0 ? utc : `${utc} · ${formatSlot(entry, off)} ${formatOffsetLabel(off)}`;
    return entry.days && entry.days !== 'Daily' ? `${line} · ${entry.days} (UTC days)` : line;
}

/** The frequency as the row shows it: "5875 kHz", "17.68 MHz" above 10 MHz. */
export function formatScheduleFreq(entry) {
    const khz = Number(entry && entry.freq_khz) || 0;
    if (khz >= 10000) return `${(khz / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} MHz`;
    return `${khz} kHz`;
}

/**
 * The second line of a row: everything known about the transmission that is not
 * its station, frequency or time.
 *
 * Assembled here rather than in the markup so an absent field leaves no stray
 * separator — the KiwiSDR fallback source carries none of these, and a row of
 * bare middots is worse than a blank line.
 */
export function scheduleDetail(entry) {
    if (!entry) return '';
    const parts = [];
    if (entry.language) parts.push(entry.language);
    if (entry.site) parts.push(entry.country ? `${entry.site}, ${entry.country}` : entry.site);
    else if (entry.country) parts.push(entry.country);
    if (entry.power_kw && entry.power_kw !== '?') parts.push(`${entry.power_kw} kW`);
    if (entry.target) parts.push(`to ${entry.target}`);
    return parts.join(' · ');
}

/**
 * Entries for the list, filtered and ordered for display.
 *
 * On-air first when showing everything, because "what can I hear now" is the
 * question, but still by frequency within each group so the list does not
 * reshuffle itself every time a slot ends.
 */
export function scheduleRows(entries, { onAirOnly = false, band = 'all', query = '' } = {}) {
    const list = Array.isArray(entries) ? entries : [];
    const q = query.trim().toLowerCase();

    const rows = list.filter((e) => {
        if (onAirOnly && !e.on_air) return false;
        if (band !== 'all' && e.band !== band) return false;
        if (!q) return true;
        return [e.station, e.language, e.country, e.site, e.target]
            .some((f) => f && String(f).toLowerCase().includes(q));
    });

    return rows.sort((a, b) => {
        if (!onAirOnly && a.on_air !== b.on_air) return a.on_air ? -1 : 1;
        if (a.freq_khz !== b.freq_khz) return a.freq_khz - b.freq_khz;
        return (a.start_utc || 0) - (b.start_utc || 0);
    });
}

/** How many of the entries are on air, for the "on now" count on the toggle. */
export function onAirCount(entries) {
    if (!Array.isArray(entries)) return 0;
    return entries.reduce((n, e) => n + (e.on_air ? 1 : 0), 0);
}

/**
 * Which row, if any, the receiver is currently sitting on.
 *
 * Within 5 kHz: a DRM channel is up to 20 kHz wide and the operator may well be
 * tuned a little off centre while hunting for the lock, so an exact match would
 * lose the highlight exactly when it is most wanted.
 */
export const SCHEDULE_MATCH_HZ = 5000;

export function isTunedTo(entry, frequencyHz) {
    if (!entry || !Number.isFinite(frequencyHz)) return false;
    return Math.abs((Number(entry.freq_hz) || 0) - frequencyHz) <= SCHEDULE_MATCH_HZ;
}

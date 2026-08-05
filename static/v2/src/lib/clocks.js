// World clocks — the cities on offer, and reading a time in one of them.
//
// Ported from widgets/world_clocks.widget.html. That widget hard-codes six
// clocks; this lets the operator pick from a list, because which six matter
// depends on who you are working. Zulu is in the list rather than pinned: it is
// the one everybody wants, but a receiver already shows UTC in the top bar, and
// somebody watching three European mornings should not have to spend a cell on
// it.
//
// Zones are resolved with Intl, which handles DST, so nothing here needs a
// service or a table of offsets that would go stale twice a year.

export const CLOCK_CITIES = [
    { id: 'utc', label: 'Zulu', tz: 'UTC' },

    { id: 'honolulu', label: 'Honolulu', tz: 'Pacific/Honolulu' },
    { id: 'anchorage', label: 'Anchorage', tz: 'America/Anchorage' },
    { id: 'losangeles', label: 'Los Angeles', tz: 'America/Los_Angeles' },
    { id: 'denver', label: 'Denver', tz: 'America/Denver' },
    { id: 'chicago', label: 'Chicago', tz: 'America/Chicago' },
    { id: 'newyork', label: 'New York', tz: 'America/New_York' },
    { id: 'toronto', label: 'Toronto', tz: 'America/Toronto' },
    { id: 'mexicocity', label: 'Mexico City', tz: 'America/Mexico_City' },
    { id: 'bogota', label: 'Bogotá', tz: 'America/Bogota' },
    { id: 'saopaulo', label: 'São Paulo', tz: 'America/Sao_Paulo' },
    { id: 'buenosaires', label: 'Buenos Aires', tz: 'America/Argentina/Buenos_Aires' },

    { id: 'reykjavik', label: 'Reykjavík', tz: 'Atlantic/Reykjavik' },
    { id: 'lisbon', label: 'Lisbon', tz: 'Europe/Lisbon' },
    { id: 'dublin', label: 'Dublin', tz: 'Europe/Dublin' },
    { id: 'london', label: 'London', tz: 'Europe/London' },
    { id: 'paris', label: 'Paris', tz: 'Europe/Paris' },
    { id: 'madrid', label: 'Madrid', tz: 'Europe/Madrid' },
    { id: 'berlin', label: 'Berlin', tz: 'Europe/Berlin' },
    { id: 'rome', label: 'Rome', tz: 'Europe/Rome' },
    { id: 'stockholm', label: 'Stockholm', tz: 'Europe/Stockholm' },
    { id: 'helsinki', label: 'Helsinki', tz: 'Europe/Helsinki' },
    { id: 'athens', label: 'Athens', tz: 'Europe/Athens' },
    { id: 'istanbul', label: 'Istanbul', tz: 'Europe/Istanbul' },
    { id: 'moscow', label: 'Moscow', tz: 'Europe/Moscow' },

    { id: 'lagos', label: 'Lagos', tz: 'Africa/Lagos' },
    { id: 'cairo', label: 'Cairo', tz: 'Africa/Cairo' },
    { id: 'nairobi', label: 'Nairobi', tz: 'Africa/Nairobi' },
    { id: 'johannesburg', label: 'Johannesburg', tz: 'Africa/Johannesburg' },

    { id: 'dubai', label: 'Dubai', tz: 'Asia/Dubai' },
    { id: 'karachi', label: 'Karachi', tz: 'Asia/Karachi' },
    { id: 'delhi', label: 'Delhi', tz: 'Asia/Kolkata' },
    { id: 'dhaka', label: 'Dhaka', tz: 'Asia/Dhaka' },
    { id: 'bangkok', label: 'Bangkok', tz: 'Asia/Bangkok' },
    { id: 'jakarta', label: 'Jakarta', tz: 'Asia/Jakarta' },
    { id: 'singapore', label: 'Singapore', tz: 'Asia/Singapore' },
    { id: 'hongkong', label: 'Hong Kong', tz: 'Asia/Hong_Kong' },
    { id: 'shanghai', label: 'Shanghai', tz: 'Asia/Shanghai' },
    { id: 'seoul', label: 'Seoul', tz: 'Asia/Seoul' },
    { id: 'tokyo', label: 'Tokyo', tz: 'Asia/Tokyo' },

    { id: 'perth', label: 'Perth', tz: 'Australia/Perth' },
    { id: 'sydney', label: 'Sydney', tz: 'Australia/Sydney' },
    { id: 'auckland', label: 'Auckland', tz: 'Pacific/Auckland' },
];

// The widget's six, and a reasonable spread of the bands' busiest hours.
export const DEFAULT_CLOCKS = ['utc', 'losangeles', 'newyork', 'london', 'tokyo', 'sydney'];

// More than a side dock can draw legibly, and past the point where a wall of
// faces is quicker to read than a list.
export const MAX_CLOCKS = 12;

const CITY_KEY = 'ubersdr.v2.clocks';
const MODE_KEY = 'ubersdr.v2.clocks.mode';

export function clockCity(id) {
    return CLOCK_CITIES.find((c) => c.id === id) || null;
}

/** The chosen cities, as city records. Unknown ids are dropped. */
export function savedClocks() {
    let ids = null;
    try {
        const raw = JSON.parse(localStorage.getItem(CITY_KEY));
        if (Array.isArray(raw)) ids = raw;
    } catch (e) { /* ignore */ }
    if (!ids) ids = DEFAULT_CLOCKS;

    const out = [];
    for (const id of ids) {
        const city = clockCity(id);
        // Deduplicated as well as validated: two of the same clock is a wasted
        // cell, and the id is the React key.
        if (city && !out.some((c) => c.id === city.id)) out.push(city);
        if (out.length >= MAX_CLOCKS) break;
    }
    return out;
}

export function saveClocks(ids) {
    try {
        localStorage.setItem(CITY_KEY, JSON.stringify(ids.slice(0, MAX_CLOCKS)));
    } catch (e) { /* private browsing — this session still works */ }
}

/** 'analogue' or 'digital'. One choice for all the faces, as v1 has it. */
export function savedClockMode() {
    try {
        return localStorage.getItem(MODE_KEY) === 'digital' ? 'digital' : 'analogue';
    } catch (e) {
        return 'analogue';
    }
}

export function saveClockMode(mode) {
    try { localStorage.setItem(MODE_KEY, mode === 'digital' ? 'digital' : 'analogue'); } catch (e) { /* ignore */ }
}

/**
 * The wall clock in a zone: { hour, minute, second }, 24-hour.
 *
 * Intl rather than an offset table, so daylight saving is somebody else's
 * problem. A zone the browser does not know throws, and a clock reading 00:00:00
 * would be a lie — so that returns null and the panel says the zone is
 * unavailable instead.
 */
export function zoneParts(tz, now = new Date()) {
    let parts;
    try {
        parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: tz,
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        }).formatToParts(now);
    } catch (e) {
        return null;
    }
    const out = { hour: 0, minute: 0, second: 0 };
    for (const p of parts) {
        // "24" for midnight is legal in en-GB's h23/h24 handling, and a 24 would
        // put the hour hand two turns round.
        if (p.type === 'hour') out.hour = parseInt(p.value, 10) % 24;
        else if (p.type === 'minute') out.minute = parseInt(p.value, 10);
        else if (p.type === 'second') out.second = parseInt(p.value, 10);
    }
    return out;
}

/** Same rule as the widget: 06:00–18:00 is daylight, for the face tint. */
export function isDaylight(parts) {
    return !!parts && parts.hour >= 6 && parts.hour < 18;
}

const pad = (n) => String(n).padStart(2, '0');

export function formatClock(parts, withSeconds) {
    if (!parts) return '--:--';
    const hm = `${pad(parts.hour)}:${pad(parts.minute)}`;
    return withSeconds ? `${hm}:${pad(parts.second)}` : hm;
}

/**
 * Where the hands point, in degrees clockwise from twelve.
 *
 * The hour and minute hands carry the fraction below them — an hour hand that
 * jumps between the numerals reads as a broken clock at twenty past.
 */
export function handAngles(parts) {
    if (!parts) return { hour: 0, minute: 0, second: 0 };
    const second = (parts.second / 60) * 360;
    const minute = ((parts.minute + parts.second / 60) / 60) * 360;
    const hour = (((parts.hour % 12) + parts.minute / 60) / 12) * 360;
    return { hour, minute, second };
}

/** Test seam. */
export function _clearClocks() {
    try {
        localStorage.removeItem(CITY_KEY);
        localStorage.removeItem(MODE_KEY);
    } catch (e) { /* ignore */ }
}

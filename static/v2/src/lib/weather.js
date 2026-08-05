// Terrestrial weather, from /api/weather.
//
// The server fetches OpenWeatherMap's current-weather through the instance
// reporter and caches it, refreshing every 15 minutes; the endpoint hands back
// that raw payload, or 404 with a short reason when there is nothing cached —
// which covers both "no weather source configured on this receiver" and "the
// first fetch has not landed yet". Nothing in /api/description says which, so
// the panel reports what it was told rather than guessing.
//
// The icons are the receiver's own: static/weather holds the eighteen OWM codes
// (nine conditions, day and night) at three sizes. Local, so they work on a
// receiver with no route to the internet and cost no third-party request.

export const WEATHER_URL = '/api/weather';

// What is actually on disk — see static/weather. An unknown code gets no image
// rather than a broken one.
const ICON_CODES = new Set([
    '01d', '01n', '02d', '02n', '03d', '03n', '04d', '04n', '09d', '09n',
    '10d', '10n', '11d', '11n', '13d', '13n', '50d', '50n',
]);

/**
 * Path to a condition icon, or '' if the code is not one we have.
 *
 * `_t` is the variant v1 uses: it reads on a dark surface, which is where this
 * is drawn. The 2x asset at a 1x box so it stays sharp on a phone.
 */
export function weatherIcon(code) {
    return ICON_CODES.has(code) ? `/weather/${code}_t@2x.png` : '';
}

// 16 points: a compass rose has no use for more, and 8 loses the difference
// between a southerly and a south-westerly that decides whether the beam swings.
const POINTS = [
    'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];

export function windDirection(deg) {
    if (!Number.isFinite(deg)) return '';
    return POINTS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

/**
 * The Beaufort number for a speed in m/s.
 *
 * Worth having on a receiver: what the wind is doing to the antenna is the
 * reason to look, and "5" says more about that than "9.3 m/s" does.
 */
export function beaufort(ms) {
    if (!Number.isFinite(ms) || ms < 0) return null;
    const LIMITS = [0.5, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
    for (let i = 0; i < LIMITS.length; i++) if (ms < LIMITS[i]) return i;
    return 12;
}

const BEAUFORT_NAMES = [
    'Calm', 'Light air', 'Light breeze', 'Gentle breeze', 'Moderate breeze',
    'Fresh breeze', 'Strong breeze', 'Near gale', 'Gale', 'Severe gale',
    'Storm', 'Violent storm', 'Hurricane',
];

export function beaufortName(force) {
    return force == null ? '' : BEAUFORT_NAMES[force] || '';
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// OWM's description is lower case ("light intermittent rain"); it reads as a
// heading with the first letter up, and only the first — title case turns
// "light rain" into a proper noun.
function sentence(text) {
    const s = String(text || '').trim();
    return s ? s[0].toUpperCase() + s.slice(1) : '';
}

/**
 * The payload, in the shape the panel wants. Every field may be null: OWM omits
 * what the station did not report, and a receiver in a place with no wind vane
 * still has a temperature worth showing.
 */
export function readWeather(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const first = Array.isArray(raw.weather) ? (raw.weather[0] || {}) : {};
    const main = raw.main || {};
    const wind = raw.wind || {};
    const sys = raw.sys || {};

    return {
        condition: first.main || '',
        description: sentence(first.description || first.main),
        icon: weatherIcon(first.icon),
        tempC: num(main.temp),
        feelsLikeC: num(main.feels_like),
        humidity: num(main.humidity),
        pressure: num(main.pressure),
        windMs: num(wind.speed),
        windDeg: num(wind.deg),
        gustMs: num(wind.gust),
        cloud: num(raw.clouds && raw.clouds.all),
        // Metres from OWM, and capped at 10 km — beyond that it reports the cap
        // rather than a measurement.
        visibilityM: num(raw.visibility),
        place: raw.name || '',
        country: (sys.country || '').toUpperCase(),
        // Unix seconds throughout.
        at: num(raw.dt),
        sunrise: num(sys.sunrise),
        sunset: num(sys.sunset),
        // Seconds east of UTC *at the weather station*, which is the clock
        // sunrise and sunset belong to. Usually the receiver's own, but a
        // receiver reporting weather for somewhere else would otherwise print
        // its sunrise in the wrong timezone.
        tzOffsetSec: num(raw.timezone),
    };
}

export const round = (v) => (v == null ? null : Math.round(v));

export function windKmh(ms) {
    return ms == null ? null : Math.round(ms * 3.6);
}

/**
 * A unix time in the *receiver's* local clock, as HH:MM.
 *
 * Same trick the top bar's clock uses: shift the epoch by the location's offset
 * and read the UTC fields back, so sunrise is the sunrise where the weather is
 * rather than where you happen to be reading it from.
 */
export function localTime(unixSec, offsetSec) {
    if (!Number.isFinite(unixSec)) return '';
    const off = Number.isFinite(offsetSec) ? offsetSec : 0;
    const d = new Date((unixSec + off) * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** How long ago the reading was taken, for a line that says how stale it is. */
export function ageLabel(unixSec, nowMs = Date.now()) {
    if (!Number.isFinite(unixSec)) return '';
    const mins = Math.floor((nowMs / 1000 - unixSec) / 60);
    if (mins < 1) return 'just now';
    if (mins === 1) return '1 min ago';
    if (mins < 60) return `${mins} mins ago`;
    const hours = Math.round(mins / 60);
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}

// --- fetching ---------------------------------------------------------------
//
// One cache for the page, shared by everything that wants weather: the panel,
// and the station-ID block painted on the spectrum. They ask on their own
// schedules and mostly get the same answer back without a request.
//
// Worth being strict about. The endpoint is rate limited to one request a second
// per IP, the data behind it only moves every fifteen minutes, and a panel that
// is opened, closed and opened again should not spend requests on it. v1 shares
// a promise between its two consumers for exactly the same reason.
//
// Five minutes: often enough that a reading is never badly stale against a
// server cache that turns over every fifteen, rare enough that two consumers
// polling independently still come to about one request per interval.
const MIN_AGE_MS = 5 * 60_000;
let cached = null;      // { at, result }
let inFlight = null;

/**
 * @returns { data, unavailable, error } — exactly one of the three is set.
 *          `unavailable` is the 404: no source configured, or nothing fetched
 *          yet. `error` is anything else, which is worth showing as a failure.
 */
export function fetchWeather({ force = false, now = Date.now() } = {}) {
    if (!force && cached && now - cached.at < MIN_AGE_MS) {
        return Promise.resolve(cached.result);
    }
    if (inFlight) return inFlight;

    inFlight = fetch(WEATHER_URL)
        .then(async (resp) => {
            const body = await resp.json().catch(() => null);
            if (resp.status === 404) {
                return { unavailable: (body && body.error) || 'No weather data on this receiver.' };
            }
            if (!resp.ok) {
                return { error: (body && body.error) || `Weather failed (HTTP ${resp.status}).` };
            }
            const data = readWeather(body);
            return data ? { data } : { error: 'Weather returned nothing.' };
        })
        .catch((err) => ({ error: err.message || String(err) }))
        .then((result) => {
            // A failure is cached too, briefly: a receiver with no weather
            // source would otherwise be asked again on every render.
            cached = { at: Date.now(), result };
            inFlight = null;
            return result;
        });

    return inFlight;
}

/** Test seam. */
export function _resetWeather() {
    cached = null;
    inFlight = null;
}

// The SSTV addon's decoded images.
//
// Ported from widgets/sstv.widget.html. The addon decodes SSTV off this
// receiver and keeps the pictures; the widget shows the most recent one and
// lets you step back through the history. There is no stream — it is a REST
// endpoint polled once a minute, which is often enough for a mode where a
// single picture takes two minutes to arrive.
//
// The widget asked for one picture at a time and walked backwards with an
// offset, probing for the next one to decide whether its ← button should be
// live. The endpoint takes a `limit`, so this asks for however many are wanted
// in a single request — the offset walk was working around a query parameter
// that was there all along.

export const BASE = '/addon/sstv';

export const ADDON_NAME = 'sstv';

/** Is the addon on this receiver? Same test the widget makes. */
export function sstvAvailable(serverInfo) {
    const addons = serverInfo && serverInfo.addons;
    return Array.isArray(addons)
        && addons.some((n) => String(n).toLowerCase() === ADDON_NAME);
}

// The widget's query, kept exactly: complete pictures only, above an SNR that
// filters out the noise-only decodes, and without the per-line SNR series,
// which is a lot of numbers for something nothing here draws.
const QUERY = 'snr_series=0&complete=1&min_snr=38';

// How many pictures the panel will show at once. Six because that is a couple
// of hours of a busy SSTV net, and because a dock column of more than that is
// scrolling rather than glancing.
export const MAX_IMAGES = 6;
export const DEFAULT_IMAGES = 1;

export const clampCount = (n) => Math.min(MAX_IMAGES, Math.max(1, Math.round(Number(n) || 1)));

export const imagesUrl = (count = 1, base = BASE) =>
    `${base}/api/images?${QUERY}&limit=${clampCount(count)}&offset=0`;

export const imageUrl = (file, base = BASE) => `${base}/images/${file}`;

// How often the addon is asked for a new picture. An SSTV frame takes one to
// four minutes to send, so a minute is comfortably faster than pictures arrive.
export const POLL_MS = 60000;

// How often the "3m ago" label is redrawn.
export const AGE_TICK_MS = 15000;

// The mode table from the widget, which took it from v1's app.js.
export const MODE_NAMES = {
    M1: 'Martin 1',
    M2: 'Martin 2',
    S1: 'Scottie 1',
    S2: 'Scottie 2',
    SDX: 'Scottie DX',
    R36: 'Robot 36',
    R72: 'Robot 72',
    PD50: 'PD50',
    PD90: 'PD90',
    PD120: 'PD120',
    PD160: 'PD160',
    PD180: 'PD180',
    PD240: 'PD240',
    PD290: 'PD290',
    'SC2-60': 'SC2 60',
    'SC2-120': 'SC2 120',
    'SC2-180': 'SC2 180',
};

/** A mode's full name, or the code itself if it is one we do not know. */
export function modeName(code) {
    return (code && (MODE_NAMES[code] || code)) || '—';
}

export function formatFreq(hz) {
    if (!hz) return '—';
    if (hz >= 1e6) return `${(hz / 1e6).toFixed(3)} MHz`;
    if (hz >= 1e3) return `${(hz / 1e3).toFixed(1)} kHz`;
    return `${hz} Hz`;
}

export function formatSNR(v) {
    // Zero means "not measured" here rather than a very poor decode, which is
    // the addon's own convention.
    return v != null && v !== 0 ? `${v.toFixed(1)} dB` : '—';
}

export function formatTime(iso) {
    if (!iso) return '—';
    const t = new Date(iso);
    if (Number.isNaN(t.getTime())) return '—';
    return `${t.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')} UTC`;
}

export function formatAge(iso, now = Date.now()) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '';
    const secs = Math.round((now - t) / 1000);
    if (secs < 0) return 'just now';
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

/** What the panel shows beside the picture. */
export function detailRows(rec) {
    if (!rec) return [];
    const rows = [['Mode', modeName(rec.sstv_mode)]];
    // Only when the decoder actually read one out of the picture.
    if (rec.callsign) rows.push(['Call', rec.callsign]);
    rows.push(
        ['Freq', formatFreq(rec.frequency_hz)
            + (rec.audio_mode ? ` ${String(rec.audio_mode).toUpperCase()}` : '')],
        ['SNR', formatSNR(rec.snr_avg_db)],
        ['RX end', formatTime(rec.rx_end)],
    );
    return rows;
}

/** The records in a response, newest first — the addon returns an array. */
export function records(payload) {
    return Array.isArray(payload) ? payload.filter((r) => r && r.file) : [];
}

// How many pictures to show. Its own key rather than a corner of the display
// settings: it is what this panel is showing, not how anything looks.
const COUNT_KEY = 'ubersdr.v2.sstv';

export function savedCount() {
    try {
        const raw = JSON.parse(localStorage.getItem(COUNT_KEY));
        return clampCount(raw && raw.count);
    } catch (e) {
        return DEFAULT_IMAGES;
    }
}

export function saveCount(count) {
    try {
        localStorage.setItem(COUNT_KEY, JSON.stringify({ count: clampCount(count) }));
    } catch (e) { /* private mode */ }
}

/** A filename to save the picture under. */
export function downloadName(file) {
    const name = String(file || '').split('/').pop();
    return name || 'sstv.png';
}

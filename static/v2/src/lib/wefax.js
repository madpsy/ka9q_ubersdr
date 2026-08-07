// The WEFAX addon: weather fax pages, already decoded.
//
// The addon watches one or more HF fax frequencies, decodes each transmission line by
// line, and saves a PNG when the page finishes. Its own page has the live decode
// arriving a line at a time, the SNR history, the audio preview and the whole library;
// this is the dock version: the last page each frequency produced.
//
// ── Polling something that costs 300 KB to ask ───────────────────────────────
//
// /api/images is the only way to list what has been decoded, and it is expensive: each
// record carries an SNR series of a few thousand points, so one image is 120 KB of JSON
// and a handful is nearer 300 KB. There is no parameter to leave the series out.
//
// /api/status is 400 bytes and carries `total_images`, which is exactly the question
// worth asking every minute: has anything new been decoded? So that is what the panel
// polls, and the expensive list is fetched only when that number moves — which is once
// per completed page, about every ten minutes on a busy frequency.
//
// It also happens to carry the channels, so the same request feeds the picker. Unlike
// the NAVTEX addon, this one publishes its configuration: a frequency that has never
// produced a page is still offered, because the receiver is still listening to it.

export const BASE = '/addon/wefax';

export const ADDON_NAME = 'wefax';

/** The addon's own page, the same route the Addons panel links to. */
export const addonUrl = (base = BASE) => `${base}/`;

/** Is the addon on this receiver? Same test the other addon panels make. */
export function wefaxAvailable(serverInfo) {
    const addons = serverInfo && serverInfo.addons;
    return Array.isArray(addons)
        && addons.some((n) => String(n).toLowerCase() === ADDON_NAME);
}

export const statusUrl = (base = BASE) => `${base}/api/status`;

// How many records to ask for when something has changed. Enough that a channel which
// has just produced two pages in a row cannot push another channel's latest off the
// end, and small enough to keep the one expensive request from getting worse.
export const IMAGE_LIMIT = 8;
export const imagesUrl = (base = BASE, limit = IMAGE_LIMIT) =>
    `${base}/api/images?limit=${Math.max(1, Math.round(limit) || IMAGE_LIMIT)}`;

/** Where the PNGs live. The full page and its thumbnail are the same route. */
export const imageUrl = (file, base = BASE) => `${base}/images/${encodeURIComponent(file)}`;

// A minute for "is there anything new", which is fast for a mode where one page takes
// eight to twelve minutes to send.
export const POLL_MS = 60000;

export const PICK_KEY = 'ubersdr.v2.wefax.pick';
export const PICK_LATEST = 'latest';

export function savedPick() {
    try { return localStorage.getItem(PICK_KEY) || PICK_LATEST; } catch (e) { return PICK_LATEST; }
}

export function savePick(value) {
    try { localStorage.setItem(PICK_KEY, value || PICK_LATEST); } catch (e) { /* private mode */ }
    return value || PICK_LATEST;
}

/** A channel label as a frequency somebody would say: "7880000_usb" is 7880 kHz. */
export function channelKhz(hz) {
    const n = Number(hz) || 0;
    if (!n) return '';
    return String(Math.round(n / 1000));
}

/**
 * The channels the addon is watching, from /api/status.
 *
 * Kept in the order the addon lists them rather than sorted by frequency: that is the
 * order they appear in its own interface, and two views of one addon disagreeing about
 * which channel is first is a small confusion with no upside.
 */
export function channelList(status) {
    const rows = status && status.channels;
    if (!Array.isArray(rows)) return [];
    return rows.map((c) => ({
        label: String((c && c.label) || '').trim(),
        hz: Number(c && c.freq_hz) || 0,
        khz: channelKhz(c && c.freq_hz),
        mode: String((c && c.audio_mode) || '').toUpperCase(),
        running: String((c && c.status) || '').toLowerCase() === 'running',
    })).filter((c) => c.label);
}

/** How many pages the addon has ever saved — the panel's "has anything changed". */
export function totalImages(status) {
    // Number(null) is 0, and 0 is a real answer here — a receiver that has decoded
    // nothing yet. So "no status at all" has to be ruled out before the conversion, or
    // a failed request would read as an addon with an empty library and the panel would
    // never fetch the list again.
    if (!status || typeof status !== 'object') return null;
    const n = Number(status.total_images);
    return Number.isFinite(n) ? n : null;
}

/**
 * One decoded page, in the shape the panel uses.
 *
 * `at` is when the page was *saved* — when the transmission finished — rather than when
 * it started. A fax takes ten minutes to arrive, and "20 minutes ago" meaning "started
 * twenty minutes ago and finished ten minutes ago" is the sort of age that has people
 * looking for a newer one that does not exist.
 */
export function normaliseImage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const file = String(raw.filename || '').trim();
    if (!file) return null;
    const at = Date.parse(raw.saved_at);
    const started = Date.parse(raw.started_at);
    const snr = raw.snr && typeof raw.snr === 'object' ? Number(raw.snr.avg_db) : NaN;
    const width = Number(raw.width) || 0;
    const height = Number(raw.image_height || raw.lines) || 0;
    return {
        id: String(raw.id || file),
        label: String(raw.label || '').trim(),
        hz: Number(raw.freq_hz) || 0,
        khz: channelKhz(raw.freq_hz),
        file,
        thumb: String(raw.thumb_file || '').trim() || file,
        width,
        height,
        at: Number.isFinite(at) ? at : 0,
        // How long the page took to come in, which is the other half of what a fax's
        // timestamps say: a page that took three minutes was cut short.
        tookMs: Number.isFinite(at) && Number.isFinite(started) ? Math.max(0, at - started) : 0,
        snr: Number.isFinite(snr) ? snr : null,
    };
}

/** The newest page on each channel, newest channel first. */
export function latestPerChannel(payload) {
    const rows = (payload && payload.images) || [];
    const best = new Map();
    for (const raw of rows) {
        const img = normaliseImage(raw);
        if (!img) continue;
        const had = best.get(img.label);
        if (!had || img.at > had.at) best.set(img.label, img);
    }
    return [...best.values()].sort((a, b) => b.at - a.at);
}

/**
 * What the picker offers: "Latest", then one chip per channel.
 *
 * Built from the addon's channel list, not from what has been decoded — this addon
 * publishes its configuration, so a frequency that has produced nothing today is still
 * a frequency the receiver is listening to and still worth being able to ask about.
 */
export function pickOptions(channels, images = []) {
    const seen = new Map();
    for (const c of channels) seen.set(c.label, c.khz || c.label);
    // A page whose channel has since been removed from the configuration still has to
    // be reachable, or the panel would be holding something it cannot show.
    for (const img of images) if (!seen.has(img.label)) seen.set(img.label, img.khz || img.label);
    return [
        { value: PICK_LATEST, label: 'Latest' },
        ...[...seen.entries()].map(([value, label]) => ({ value, label })),
    ];
}

/**
 * The page to show, given the choice. Same three cases as the NAVTEX panel:
 *
 *   the chosen channel has a page — show it, however old;
 *   the chosen channel is known but has nothing yet — show nothing, and let the panel
 *   say which channel it is waiting on, because a page from another frequency under a
 *   chip reading 4610 is worse than an empty panel;
 *   the choice is not on offer at all — fall back to the newest anything.
 */
export function chosenImage(images, pick, known = null) {
    if (pick && pick !== PICK_LATEST) {
        const hit = images.find((i) => i.label === pick);
        if (hit) return hit;
        if (known && known.includes(pick)) return null;
    }
    return images[0] || null;
}

/**
 * How the page is shaped, for deciding how to show it.
 *
 * Weather fax pages are tall — a chart is around 1800 px across and can run to several
 * thousand lines — so the modal fits them to its width and scrolls, rather than fitting
 * them on screen and rendering a wall of grey. This is the number that decides when
 * that matters: anything taller than it is wide gets the scrolling treatment by default.
 */
export function isTall(img) {
    return !!(img && img.height > img.width);
}

/** "1809 × 1277", for the caption. */
export function sizeLabel(img) {
    if (!img || !img.width || !img.height) return '';
    return `${img.width} × ${img.height}`;
}

/** How long the page took to arrive, in whole minutes. */
export function tookLabel(img) {
    if (!img || !img.tookMs) return '';
    const mins = Math.round(img.tookMs / 60000);
    return mins < 1 ? '<1 min' : `${mins} min`;
}

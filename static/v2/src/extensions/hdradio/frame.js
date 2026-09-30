// HD Radio: the three messages the server sends back, and what the panel
// makes of them.
//
//     0x02  [type:1][timestamp:8][sample_rate:4][channels:1][opus…]   48 kHz stereo
//     0x03  [type:1][utf-8 JSON status line]
//     0x04  [type:1][header length:4][header JSON][JPEG or PNG]
//
// The status is ubersdr-hdradio's own, forwarded unchanged (its README
// documents every field); anything the station has not sent is null, "" or [],
// and the panel shows exactly what has arrived and nothing else. Images are
// album art, station logos and HERE traffic/weather maps.
//
// Everything in both comes from the station and is treated as untrusted: text
// is rendered as text, a link is only a link if it is http(s), and an image is
// only an image if its bytes say JPEG or PNG — checked here again, not taken on
// the server's word.

export const FRAME_AUDIO = 0x02;
export const FRAME_STATUS = 0x03;
export const FRAME_IMAGE = 0x04;

export const MAX_PROGRAMS = 8;

// Audio frames come every 20 ms while a program decodes; this long without one
// and HD audio is called lost (and the analogue audio comes back up).
export const SIGNAL_TIMEOUT_MS = 2500;

// Status lines come at least once a second. This long without one and the
// figures are shown as stale.
export const STATUS_STALE_MS = 5000;

// How many album-art pictures are kept, newest first, so switching programs or
// a song coming round again does not wait for the station to resend it.
export const MAX_ART = 24;

const IMAGE_KINDS = ['art', 'logo', 'traffic', 'weather'];

function bytesOf(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
}

const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

function parseJSON(bytes) {
    if (!textDecoder) return null;
    try {
        return JSON.parse(textDecoder.decode(bytes));
    } catch (e) {
        return null;
    }
}

/** What the bytes are, from their signature: 'image/jpeg', 'image/png' or ''. */
export function imageMime(b) {
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
        && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
    return '';
}

/**
 * One binary message: { kind: 'audio' | 'status' | 'image', … } or null.
 *
 * Anything malformed is null rather than thrown, so one bad message never
 * takes the audio down with it. The Opus payload and image bytes are views
 * onto the message; the caller copies what it keeps.
 */
export function decodeFrame(data) {
    const b = bytesOf(data);
    if (!b || !b.length) return null;

    if (b[0] === FRAME_STATUS) {
        const status = parseJSON(b.subarray(1));
        if (!status || status.t !== 'status') return null;
        return { kind: 'status', status };
    }

    if (b[0] === FRAME_IMAGE) {
        if (b.length < 5) return null;
        const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
        const hl = view.getUint32(1);
        if (hl > b.length - 5) return null;
        const header = parseJSON(b.subarray(5, 5 + hl));
        const bytes = b.subarray(5 + hl);
        if (!header || header.t !== 'image' || !IMAGE_KINDS.includes(header.kind)) return null;
        const mime = imageMime(bytes);
        if (!mime) return null;
        return {
            kind: 'image',
            image: {
                kind: header.kind,
                program: Number.isInteger(header.program) ? header.program : null,
                lot: Number.isInteger(header.lot) ? header.lot : null,
                mime,
                name: typeof header.name === 'string' ? header.name : '',
                bounds: header.bounds && typeof header.bounds === 'object' ? header.bounds : null,
            },
            bytes,
        };
    }

    if (b[0] !== FRAME_AUDIO || b.length < 15) return null;
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const sampleRate = view.getUint32(9) || 48000;
    const channels = b[13] || 2;
    return { kind: 'audio', sampleRate, channels, opus: b.subarray(14) };
}

// ── presentation ────────────────────────────────────────────────────────────

/** 0 → 'HD1'. */
export function programLabel(n) {
    return `HD${n + 1}`;
}

/** A trimmed string, or '' for anything else. Stations pad with spaces. */
export function stationText(v) {
    return typeof v === 'string' ? v.trim() : '';
}

/** The program the status says is playing, or null. */
export function selectedProgram(status) {
    if (!status || !Array.isArray(status.programs)) return null;
    return status.programs.find((p) => p.program === status.program) || null;
}

/** 'UTC−6', 'UTC+5:30', 'UTC'. */
export function formatUtcOffset(minutes) {
    if (!Number.isFinite(minutes) || minutes === 0) return 'UTC';
    const sign = minutes < 0 ? '−' : '+';
    const m = Math.abs(minutes);
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return `UTC${sign}${h}${rest ? `:${String(rest).padStart(2, '0')}` : ''}`;
}

/**
 * The station's own clock, 'HH:MM', from its SIS local time. The offset is
 * standard time; an hour is added while daylight saving is in effect there
 * and practised locally.
 */
export function stationClock(zone, nowMs) {
    if (!zone || !Number.isFinite(zone.utcOffset)) return '';
    const dst = zone.dstRegional && zone.dstLocal ? 60 : 0;
    const t = new Date(nowMs + (zone.utcOffset + dst) * 60000);
    return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}

/** The zone the station's clock is in, e.g. 'UTC−5 (DST)'. */
export function stationZone(zone) {
    if (!zone || !Number.isFinite(zone.utcOffset)) return '';
    const dst = zone.dstRegional && zone.dstLocal;
    return `${formatUtcOffset(zone.utcOffset + (dst ? 60 : 0))}${dst ? ' (DST)' : ''}`;
}

/** BER as a percentage to two places, e.g. '9.01%', or '' before one is measured. */
export function formatBer(ber) {
    if (typeof ber !== 'number' || !Number.isFinite(ber)) return '';
    return `${(ber * 100).toFixed(2)}%`;
}

/** 'GG · core 1.2.3.4 · mfr 2.3.4.5', or '' for no device. */
export function formatDevice(d) {
    if (!d) return '';
    const parts = [];
    if (stationText(d.manufacturer)) parts.push(stationText(d.manufacturer));
    if (d.coreVersion) parts.push(`core ${d.coreVersion}${d.coreRelease && d.coreRelease !== 'commercial' ? ` (${d.coreRelease})` : ''}`);
    if (d.manufacturerVersion) {
        parts.push(`mfr ${d.manufacturerVersion}${d.manufacturerRelease && d.manufacturerRelease !== 'commercial' ? ` (${d.manufacturerRelease})` : ''}`);
    }
    return parts.join(' · ');
}

/** The areas an alert covers, e.g. 'FIPS 17031, 17043', or ''. */
export function alertAreas(status) {
    if (!status || !Array.isArray(status.alertLocations) || !status.alertLocations.length) return '';
    const codes = status.alertLocations.slice(0, 12).join(', ');
    const more = status.alertLocations.length > 12 ? ` +${status.alertLocations.length - 12}` : '';
    return `${stationText(status.alertLocationFormat) || 'Areas'} ${codes}${more}`;
}

/** A station-supplied URL, only if it is http(s); '' otherwise. */
export function safeUrl(url) {
    const u = stationText(url);
    return /^https?:\/\/[^\s]+$/i.test(u) ? u : '';
}

/** GPS−UTC offset from the leap second block, e.g. 'GPS−UTC 18 s (19 s pending)'. */
export function formatLeapSecond(ls) {
    if (!ls || !Number.isFinite(ls.current)) return '';
    const pending = Number.isFinite(ls.pending) && ls.pending !== ls.current ? ` (${ls.pending} s pending)` : '';
    return `GPS−UTC ${ls.current} s${pending}`;
}

/**
 * The picture for a program: the current song's album art when the station
 * has named it and it has arrived, else the station logo for that program,
 * else any station logo. null when there is nothing to show.
 *
 * art: Map lot → url. logos: Map program → url.
 */
export function pictureFor(program, art, logos) {
    if (program && program.artLot != null && art.has(program.artLot)) {
        return { url: art.get(program.artLot), kind: 'art' };
    }
    const n = program ? program.program : 0;
    if (logos.has(n)) return { url: logos.get(n), kind: 'logo' };
    if (logos.size) return { url: logos.values().next().value, kind: 'logo' };
    return null;
}

/** 'Weather map, 41.50°N–40.50°N, 88.50°W–87.00°W'. */
export function describeHereMap(image) {
    const kind = image.kind === 'traffic' ? 'Traffic map' : 'Weather map';
    const b = image.bounds;
    if (!b || ![b.north, b.south, b.west, b.east].every(Number.isFinite)) return kind;
    const lat = (v) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? 'N' : 'S'}`;
    const lon = (v) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? 'E' : 'W'}`;
    return `${kind}, ${lat(b.north)}–${lat(b.south)}, ${lon(b.west)}–${lon(b.east)}`;
}

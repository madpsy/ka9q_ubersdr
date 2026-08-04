// FreeDV: the audio frame, and the FreeDV Reporter activity list.
//
// Two unrelated streams meet in this panel, and it is worth being clear which
// is which:
//
//   * The decoder. `freedv` is an audio extension like the others, but what it
//     sends back is not a decode to display — it is *audio*. A RADE waveform
//     carries speech, so the server runs freedv-ka9q, Opus-encodes the voice
//     that comes out, and sends it as frames on the same binary channel:
//
//         0x02  [type:1][gps_nanos:8][sample_rate:4][channels:1][opus data…]
//
//     Frames arrive only while a signal is being decoded, which is why their
//     mere arrival is the signal indicator — there is no "no signal" message.
//
//   * FreeDV Reporter. The server holds a view-only connection to
//     qso.freedv.org and relays who is on the air, over the same dxcluster
//     socket as the spot streams. That is what the activity list shows, and it
//     works whether or not the decoder is running: it says where to point the
//     receiver, which is the harder half of using FreeDV.

export const FRAME_OPUS = 0x02;

// The decoded stream's own rate. Fixed by the server (RADE outputs 12 kHz mono)
// and sent in every frame anyway, so this is only the fallback.
export const FREEDV_RATE = 12000;

// How long after the last frame the signal is called lost. Frames come every
// 20 ms while decoding, so this is generous — it exists to survive a gap in a
// speech burst, not to detect the end of a transmission quickly.
export const SIGNAL_TIMEOUT_MS = 2000;

function bytesOf(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
}

/**
 * One binary frame, or null.
 *
 * The Opus payload is returned as a view onto the frame. The caller copies it
 * before handing it to the decoder — the decode is asynchronous and the socket
 * will have overwritten the buffer by the time it runs.
 */
export function decodeFrame(data) {
    const b = bytesOf(data);
    if (!b || b.length < 14 || b[0] !== FRAME_OPUS) return null;
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    // The timestamp is GPS nanoseconds. Read as two 32-bit halves rather than
    // through getBigUint64, so no BigInt enters the bundle for a value nothing
    // schedules from — playback is chained frame to frame, not timestamped.
    const nanos = view.getUint32(1) * 4294967296 + view.getUint32(5);
    const sampleRate = view.getUint32(9) || FREEDV_RATE;
    const channels = b[13] || 1;
    const opus = b.subarray(14);
    if (!opus.length) return null;
    return { kind: 'audio', at: nanos / 1e6, sampleRate, channels, opus };
}

// ── the activity list ───────────────────────────────────────────────────────

/**
 * One reporter station, in the shape the table renders.
 *
 * Every field but the callsign is optional — the server enriches what it can
 * from the CTY database and the receiver's locator, and a station that has just
 * connected has reported nothing yet.
 */
export function normaliseUser(raw) {
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
        sid: String(raw.sid || ''),
        callsign: raw.callsign || '',
        grid: raw.grid_square || '',
        freqHz: num(raw.freq_hz) ?? 0,
        mode: raw.mode || '',
        transmitting: !!raw.transmitting,
        message: raw.message || '',
        country: raw.country || '',
        continent: raw.continent || '',
        distanceKm: num(raw.distance_km),
        bearingDeg: num(raw.bearing_deg),
        lastTx: raw.last_tx || '',
        lastRxCall: raw.last_rx_callsign || '',
        lastRxSnr: num(raw.last_rx_snr),
        rxOnly: !!raw.rx_only,
    };
}

/**
 * Apply one update event to a map of stations, returning a new map.
 *
 * The events are the reporter's own vocabulary — see BroadcastFreeDVActivity in
 * dxcluster_websocket.go. Every one but a removal carries the station's full
 * current state, so there is nothing to merge: the server has already done it,
 * and merging here would let a dropped event leave a stale field behind.
 */
export function applyUpdate(map, { event, user, sid }) {
    const next = new Map(map);
    if (event === 'remove_connection') {
        const key = sid || (user && user.sid);
        if (key) next.delete(key);
        return next;
    }
    if (user && user.sid) next.set(user.sid, normaliseUser(user));
    return next;
}

export function snapshotToMap(users) {
    const map = new Map();
    for (const raw of users || []) {
        if (raw && raw.sid) map.set(raw.sid, normaliseUser(raw));
    }
    return map;
}

/**
 * The stations worth showing, in the order to show them.
 *
 * Filtered to the band the receiver is on, because that is the question the
 * list answers — "who could I hear right now" — and the reporter carries the
 * whole world. Outside any known band nothing is filtered: hiding everything
 * would look like an empty reporter rather than a dial between bands.
 *
 * Transmitting first, then by callsign. Someone on the air now is the only
 * station you can do anything about.
 */
export function visibleUsers(map, band) {
    const all = Array.from(map.values());
    const inBand = band
        ? all.filter((u) => u.freqHz >= band.min && u.freqHz <= band.max)
        : all;
    return inBand.sort((a, b) => {
        if (a.transmitting !== b.transmitting) return a.transmitting ? -1 : 1;
        return (a.callsign || '').localeCompare(b.callsign || '');
    });
}

/**
 * Whether the receiver could tune to this station.
 *
 * The reporter carries VHF and above, which this receiver cannot reach, and a
 * row that looks clickable and then tunes to the band edge is worse than one
 * that plainly is not.
 */
export function isTunable(user, minHz = 10000, maxHz = 30000000) {
    return !!user.freqHz && user.freqHz >= minHz && user.freqHz <= maxHz;
}

// How close the dial has to be for a station to read as the one being heard.
// A FreeDV signal is a couple of kHz wide and operators quote the suppressed
// carrier, so this is wider than it looks.
const ON_FREQUENCY_HZ = 500;

export function isOnFrequency(user, dialHz) {
    return !!user.freqHz && !!dialHz && Math.abs(user.freqHz - dialHz) <= ON_FREQUENCY_HZ;
}

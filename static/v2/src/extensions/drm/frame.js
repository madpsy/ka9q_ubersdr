// DRM: the two frames the server sends back.
//
// Like FreeDV, the `drm` extension's output is not a decode to display but
// *audio* — a DRM broadcast carries AAC speech and music, which the server
// decodes and re-encodes as Opus. Unlike FreeDV, a DRM signal also carries a
// station identity and a text message, and those come on a frame of their own:
//
//     0x02  [type:1][gps_nanos:8][sample_rate:4][channels:1][opus data…]
//     0x03  [type:1][utf-8 JSON…]
//
// The split is the decoder binary's, not this file's: it writes raw PCM on
// stdout and its JSON status on a separate descriptor, so the audio stream
// never has to carry a header. The Go side forwards each verbatim with a type
// byte in front.
//
// Audio frames arrive only while a signal is being decoded, so their arrival is
// the signal indicator. Status frames arrive about once a second regardless —
// including before a lock, which is what lets the panel show "searching" rather
// than nothing at all.

export const FRAME_OPUS = 0x02;
export const FRAME_STATUS = 0x03;

// DRM audio is always delivered at 12 kHz mono. Sent in every frame anyway, so
// this is only the fallback.
export const DRM_RATE = 12000;

// How long after the last audio frame the signal is called lost. Frames come
// every 20 ms while decoding; this is generous enough to survive a fade without
// flickering the lamp.
export const SIGNAL_TIMEOUT_MS = 2500;

// Status codes shared by every per-block field (fac, sdc, audio, …).
export const RX_NOT_PRESENT = 0;
export const RX_CRC_ERROR = 1;
export const RX_DATA_ERROR = 2;
export const RX_OK = 3;

function bytesOf(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
}

/**
 * One binary frame — an audio frame, a status object, or null.
 *
 * The Opus payload is returned as a view onto the frame. The caller copies it
 * before handing it to the decoder: the decode is asynchronous and the socket
 * will have reused the buffer by the time it runs.
 */
export function decodeFrame(data) {
    const b = bytesOf(data);
    if (!b || !b.length) return null;

    if (b[0] === FRAME_STATUS) {
        // Malformed JSON is dropped rather than thrown: one bad status line
        // must not take the audio down with it.
        try {
            const json = new TextDecoder().decode(b.subarray(1));
            const status = JSON.parse(json);
            if (!status || status.t !== 'status') return null;
            return { kind: 'status', status };
        } catch (e) {
            return null;
        }
    }

    if (b[0] !== FRAME_OPUS || b.length < 14) return null;
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    // GPS nanoseconds, read as two 32-bit halves so no BigInt enters the bundle
    // for a value nothing schedules from — playback is chained frame to frame.
    const nanos = view.getUint32(1) * 4294967296 + view.getUint32(5);
    const sampleRate = view.getUint32(9) || DRM_RATE;
    const channels = b[13] || 1;
    const opus = b.subarray(14);
    if (!opus.length) return null;
    return { kind: 'audio', at: nanos / 1e6, sampleRate, channels, opus };
}

/** Whether the decoder has a usable lock, i.e. audio is actually coming out. */
export function hasAudioLock(status) {
    return !!status && status.audio === RX_OK;
}

/**
 * One line describing what the receiver is doing, for when there is no audio.
 *
 * Deliberately staged: "no signal" and "found it but cannot decode the audio"
 * are very different situations for someone deciding whether to keep tuning.
 */
export function progressLabel(status) {
    if (!status) return 'Waiting for the decoder…';
    if (!status.acq) return 'Searching for a DRM signal…';
    if (status.fac !== RX_OK) return 'Signal found — syncing…';
    if (status.sdc !== RX_OK) return 'Synced — reading station information…';
    if (status.audio !== RX_OK) return 'Station found — audio not decoding yet';
    return 'Decoding';
}

// How long a status frame stays believable. The binary sends one a second, so
// missing several running means the decoder has stalled or the pipe has gone —
// and showing a confident "17.5 dB, DeutschlandRadio" from a dead decoder is
// worse than showing nothing.
export const STATUS_STALE_MS = 5000;

// The MER either side of which the quality bar is meaningless, and the point
// where audio starts decoding. 64-QAM at DRM's usual protection levels needs
// about 16 dB; below 8 there is nothing worth drawing, and by 24 it is solid.
export const WMER_FLOOR = 8;
export const WMER_THRESHOLD = 16;
export const WMER_CEILING = 24;

/** Where the decode threshold sits on the quality bar, as a 0–1 fraction. */
export const WMER_THRESHOLD_FRACTION =
    (WMER_THRESHOLD - WMER_FLOOR) / (WMER_CEILING - WMER_FLOOR);

// ISO 639-2 codes for the languages DRM is actually broadcast in, so the panel
// can say "German" rather than "deu". Anything not here falls back to the raw
// code, which is still more use than nothing.
const LANGUAGES = {
    ara: 'Arabic', ben: 'Bengali', bul: 'Bulgarian', chi: 'Chinese', zho: 'Chinese',
    ces: 'Czech', cze: 'Czech', dan: 'Danish', deu: 'German', ger: 'German',
    dut: 'Dutch', nld: 'Dutch', ell: 'Greek', gre: 'Greek', eng: 'English',
    fas: 'Persian', per: 'Persian', fin: 'Finnish', fra: 'French', fre: 'French',
    hin: 'Hindi', hun: 'Hungarian', ind: 'Indonesian', ita: 'Italian',
    jpn: 'Japanese', kor: 'Korean', mya: 'Burmese', bur: 'Burmese',
    nor: 'Norwegian', pol: 'Polish', por: 'Portuguese', ron: 'Romanian',
    rum: 'Romanian', rus: 'Russian', slk: 'Slovak', slo: 'Slovak',
    spa: 'Spanish', swe: 'Swedish', tam: 'Tamil', tha: 'Thai', tur: 'Turkish',
    ukr: 'Ukrainian', urd: 'Urdu', vie: 'Vietnamese',
};

/** A readable language name, or the code itself when it is not one we know. */
export function languageName(code) {
    if (!code) return '';
    return LANGUAGES[String(code).toLowerCase()] || String(code).toUpperCase();
}

/** Signal quality as a 0–1 fraction, from the MSC weighted MER. */
export function qualityFraction(wmer) {
    if (typeof wmer !== 'number' || !Number.isFinite(wmer)) return 0;
    return Math.max(0, Math.min(1, (wmer - WMER_FLOOR) / (WMER_CEILING - WMER_FLOOR)));
}

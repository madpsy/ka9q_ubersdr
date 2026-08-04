// The teleprinter decoders' shared machinery: wire frames, and the console.
//
// FSK/RTTY and NAVTEX are the same decoder twice. The Go side says so plainly —
// audio_extensions/navtex/fsk.go is audio_extensions/fsk/fsk_demod.go with the
// state machine's exported names changed — and the wire format is identical:
// one type byte and a payload, defined in audio_extensions/fsk/decoder.go.
//
//     0x01  text     [type:1][unix_seconds:8][length:4][utf-8 text:length]
//     0x02  baud     [type:1][error:float64]
//     0x03  state    [type:1][state:1]        0 none, 1 sync1, 2 sync2, 3 data
//
// NAVTEX sends the first two and not the third, which needs no handling: a
// state frame that never arrives is a case that never runs.
//
// All of them arrive on a timer rather than on an event: text every 100 ms
// whether or not a character was decoded, and the baud error every 200 ms. So a
// panel sees a steady trickle, not a burst.
//
// The console is the other half. v1 kept the text as one string and pushed it
// into a <pre>, stamping the time into the text itself as it went — which meant
// turning timestamps on only affected what arrived afterwards, and turning them
// off left the old ones in place. Here a line is a value with a time on it, so
// the toggle is a rendering choice and applies to everything on screen.

// The frame types, as the server writes them.
export const FRAME_TEXT = 0x01;
export const FRAME_BAUD = 0x02;
export const FRAME_STATE = 0x03;

// Lines kept before the oldest are dropped. v1 declared 1000 and never enforced
// it; at 45 baud a line is a few seconds, so this is a long evening of copy.
export const MAX_LINES = 1000;

// Full scale of the baud-error meter, in the decoder's own units. v1's number:
// the error is a drift estimate, and beyond about ±8 the decoder is not tracking
// at all, so more range would only make the useful part unreadable.
export const BAUD_ERROR_MAX = 8;

// The decoder's state machine, in the order its numbering runs.
export const STATE_LABELS = ['No signal', 'Signal', 'Sync', 'Decoding'];

/**
 * The three lamps v1 lit from the state number.
 *
 * They are cumulative rather than exclusive — decoding implies sync implies a
 * signal — which is what makes three lamps more useful than one label: you can
 * see how far the decoder got before it stopped.
 */
export function stateFlags(state) {
    const s = Number.isFinite(state) ? state : 0;
    return { signal: s > 0, sync: s >= 2, decode: s >= 3 };
}

const utf8 = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

function bytesOf(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
}

/**
 * One binary frame, as the value the panel acts on, or null.
 *
 * Null covers a frame that is truncated, of a type this client does not know,
 * or not binary at all. As with the JSON decoder in ../protocol.js it is the
 * only failure signal: a decoder frame is best-effort data and one bad one must
 * not take the panel down.
 */
export function decodeFrame(data) {
    const b = bytesOf(data);
    if (!b || b.length < 1) return null;
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);

    switch (b[0]) {
        case FRAME_TEXT: {
            if (b.length < 13) return null;
            // The timestamp is a big-endian uint64 of Unix seconds. Read as two
            // 32-bit halves rather than through getBigUint64, so no BigInt —
            // and no bigint-to-number conversion — is needed for a value that
            // is a small integer until the year 2106.
            const seconds = view.getUint32(1) * 4294967296 + view.getUint32(5);
            const length = view.getUint32(9);
            // A length that runs past the frame is a truncated frame, not a
            // reason to decode whatever happens to follow.
            if (length > b.length - 13) return null;
            const text = utf8 ? utf8.decode(b.subarray(13, 13 + length)) : '';
            // The server stamps the flush, so this is when the characters were
            // decoded rather than when the browser got round to them. A zero
            // means the field was never filled in; the arrival time is closer
            // to the truth than 1970.
            return { kind: 'text', text, at: seconds > 0 ? seconds * 1000 : Date.now() };
        }
        case FRAME_BAUD:
            if (b.length < 9) return null;
            return { kind: 'baud', error: view.getFloat64(1) };
        case FRAME_STATE:
            if (b.length < 2) return null;
            return { kind: 'state', state: b[1] };
        default:
            return null;
    }
}

// C0 controls other than tab and newline, which the character tables really do
// emit: ITA2 maps an all-zero code to NUL and one figures code to BEL, and a
// noisy channel produces both by the dozen. Dropping them here rather than at
// display time means they are also gone from what you copy and save.
//
// Carriage return goes with them: a teleprinter ends a line with CR LF (and
// often CR CR LF, to give the carriage time to travel), so keeping it would put
// a stray character or a blank line at the end of every line. The newline is
// what breaks lines here, exactly as in v1's export.
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * Append decoded text to the console, splitting it into lines.
 *
 * Text arrives in whatever chunks the server's 100 ms flush produced, so a line
 * is usually built over several calls: the last line stays open until a newline
 * closes it, and the next chunk continues it. `at` is the time the line
 * *started*, which is what a timestamp on a console line means.
 *
 * Ids are monotonic and assigned here so React has a stable key. They only ever
 * increase and lines only ever leave from the front, so an id is unique for as
 * long as the line it belongs to exists.
 */
export function appendText(lines, text, at, cap = MAX_LINES) {
    const clean = String(text == null ? '' : text).replace(CONTROLS, '');
    if (!clean) return lines;

    const out = lines.slice();
    const last = out.length ? out[out.length - 1] : null;
    // A copy, so the caller's previous state is never written through.
    let cur = last && last.open ? { ...last } : null;
    if (cur) out[out.length - 1] = cur;
    let nextId = out.length ? out[out.length - 1].id + 1 : 0;

    const parts = clean.split('\n');
    for (let i = 0; i < parts.length; i++) {
        if (parts[i] || (i < parts.length - 1 && !cur)) {
            if (!cur) {
                cur = { id: nextId++, at, text: '', open: true };
                out.push(cur);
            }
            cur.text += parts[i];
        }
        // Every part but the last was terminated by a newline.
        if (i < parts.length - 1 && cur) {
            cur.open = false;
            cur = null;
        }
    }

    return out.length > cap ? out.slice(out.length - cap) : out;
}

/** UTC clock time, matching the timestamps v1 wrote into the text. */
export function formatTime(ms) {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '--:--:--';
    return d.toISOString().substring(11, 19);
}

/**
 * The console as plain text, for the clipboard and the saved file.
 *
 * With timestamps if they are on screen: what you copy should be what you were
 * reading, and a log of received traffic without times is much less use.
 */
export function toText(lines, withTimestamps) {
    return lines
        .map((l) => (withTimestamps ? `[${formatTime(l.at)}] ${l.text}` : l.text))
        .join('\n');
}

// ── the decoder's settings ──────────────────────────────────────────────────

// What the server will accept (audio_extensions/fsk/extension.go validates
// centre 1-10000 Hz, shift 1-1000 Hz and baud up to 1000), narrowed to what is
// worth offering. The centre stops at the top of the audio the extension draws,
// and the baud rate at the fastest teleprinter mode anyone still transmits.
export const LIMITS = {
    center_frequency: { min: 300, max: 3000, step: 10 },
    shift: { min: 10, max: 1000, step: 5 },
    baud_rate: { min: 10, max: 300, step: 0.01 },
};

// Framings the demodulator implements — see NewITA2 and the CCIR476 path in
// audio_extensions/fsk/fsk_demod.go. 5N1.5 is the teleprinter standard: five
// data bits and a stop bit and a half, which the demodulator handles by
// sampling at twice the baud rate.
export const FRAMINGS = ['5N1', '5N1.5', '5N2', '7N1', '8N1', '4/7'];

// ITA2 is Baudot, CCIR476 is the seven-bit error-detecting code SITOR-B and
// NAVTEX use, and ASCII is the raw byte.
export const ENCODINGS = ['ITA2', 'ASCII', 'CCIR476'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// What a decoder falls back to when a setting is missing or nonsense. FSK is
// amateur radioteletype and NAVTEX is SITOR-B, so each passes its own — a
// NAVTEX attach that quietly fell back to Baudot would decode nothing and give
// no clue why.
export const RTTY_DEFAULTS = {
    center_frequency: 1000, shift: 170, baud_rate: 45.45, framing: '5N1.5', encoding: 'ITA2',
};

/**
 * Settings in the shape the attach carries, with the numbers made safe.
 *
 * The server refuses an out-of-range value outright, and a refused attach is an
 * error the user has to clear rather than a setting they can nudge back — so a
 * number that cannot be sent is clamped to one that can.
 */
export function attachParams(config, defaults = RTTY_DEFAULTS) {
    const num = (v, lim, fallback) => {
        const n = typeof v === 'number' ? v : parseFloat(v);
        return Number.isFinite(n) ? clamp(n, lim.min, lim.max) : fallback;
    };
    return {
        center_frequency: num(config.center_frequency, LIMITS.center_frequency, defaults.center_frequency),
        shift: num(config.shift, LIMITS.shift, defaults.shift),
        baud_rate: num(config.baud_rate, LIMITS.baud_rate, defaults.baud_rate),
        inverted: !!config.inverted,
        framing: FRAMINGS.includes(config.framing) ? config.framing : defaults.framing,
        encoding: ENCODINGS.includes(config.encoding) ? config.encoding : defaults.encoding,
    };
}

/**
 * The two tones, in audio Hz.
 *
 * Mark is the higher tone and space the lower — until `inverted`, which is what
 * that setting means. v1 drew the markers without it, so an inverted mode
 * labelled them the wrong way round.
 */
export function markSpace(config, defaults) {
    const p = attachParams(config, defaults);
    const half = p.shift / 2;
    return p.inverted
        ? { mark: p.center_frequency - half, space: p.center_frequency + half }
        : { mark: p.center_frequency + half, space: p.center_frequency - half };
}

/**
 * Which way the dial moves to bring an audio frequency down to another one.
 *
 * LSB and CW-L put the audio spectrum the other way up — a tone higher in the
 * passband is a *lower* radio frequency — so click-to-tune has to move the dial
 * the opposite way. v1 assumed USB and got this backwards on the lower sideband.
 */
export function sidebandSign(mode) {
    return mode === 'lsb' || mode === 'cwl' ? -1 : 1;
}

// The CW decoder's wire format, and the console it fills.
//
// Decoding happens on the server: audio_extensions/morse/extension.go feeds the
// session's audio to a `cw-decoder` subprocess built round ggmorse, which finds
// the tone and the sending speed for itself. Three binary frames come back, all
// big-endian (audio_extensions/morse/extension.go):
//
//   0x10  decode  [type:1][confidence:1][cost:f32][pitch:f32][speed:f32][len:u32][utf-8 text]
//   0x11  stats   [type:1][pitch:f32][speed:f32]
//   0x12  error   [type:1][len:u32][utf-8 message]
//
// The stats frame carries no text: it is how the decoder says what it is
// hearing while nothing is being copied, which is exactly when you want to know.
//
// The error frame is the one thing here that has no equivalent in the other
// decoders. `cw-decoder` is a separate binary that may not be installed at all,
// and the server reports that — and a subprocess that dies later — down this
// channel rather than as an attach failure, so a panel that ignores 0x12 shows
// a decoder that started cleanly and then says nothing for ever.
//
// ── confidence ──────────────────────────────────────────────────────────────
//
// Every decode carries ggmorse's own estimate of how much to trust it. That is
// worth more here than in any other decoder in this build: CW copy off a noisy
// band is part guesswork, and knowing which characters were guessed is the
// difference between a callsign and a callsign-shaped smear. So it is kept per
// chunk of text and coloured on screen, as v1 did.
//
// Unlike v1 the filter is applied when drawing rather than when receiving.
// v1 dropped filtered text as it arrived, so raising the threshold hid what was
// already on screen while lowering it showed nothing new, and the copy you
// saved depended on what the control happened to be set to while it ran. Here
// everything is kept and the threshold is a view of it — the same choice the
// teleprinter console makes for timestamps, for the same reason.

import { formatTime } from '../teleprinter.js';

export const FRAME_DECODE = 0x10;
export const FRAME_STATS = 0x11;
export const FRAME_ERROR = 0x12;

// Indexed by the confidence byte: 0 high, 1 medium, 2 low, 3 poor.
export const QUALITIES = ['high', 'medium', 'low', 'poor'];

export const QUALITY_RANK = { poor: 0, low: 1, medium: 2, high: 3 };

// What the "minimum quality" control offers, in v1's wording.
export const MIN_QUALITIES = [
    { id: 'all', label: 'All' },
    { id: 'low', label: 'Low+' },
    { id: 'medium', label: 'Medium+' },
    { id: 'high', label: 'High' },
];

const MIN_RANK = { all: 0, low: 1, medium: 2, high: 3 };

export function passesQuality(conf, minQuality) {
    return (QUALITY_RANK[conf] ?? 0) >= (MIN_RANK[minQuality] ?? 0);
}

const utf8 = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

function bytesOf(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
}

/**
 * One binary frame as the value the panel acts on, or null.
 *
 * Null covers a truncated frame, an unknown type, or something that is not
 * binary at all — the same contract as the other decoders' frame readers. One
 * bad frame is dropped rather than taking the panel down with it.
 *
 * The decode frame carries no timestamp of its own, so the console stamps it on
 * arrival. Over a link fast enough to carry audio that is within a frame's flush
 * of when the characters were sent.
 */
export function decodeFrame(data) {
    const b = bytesOf(data);
    if (!b || b.length < 1) return null;
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);

    switch (b[0]) {
        case FRAME_DECODE: {
            if (b.length < 18) return null;
            const length = view.getUint32(14);
            if (length > b.length - 18) return null;
            return {
                kind: 'decode',
                conf: QUALITIES[b[1]] || 'poor',
                cost: view.getFloat32(2),
                pitch: view.getFloat32(6),
                speed: view.getFloat32(10),
                text: utf8 ? utf8.decode(b.subarray(18, 18 + length)) : '',
                at: Date.now(),
            };
        }
        case FRAME_STATS:
            if (b.length < 9) return null;
            return { kind: 'stats', pitch: view.getFloat32(1), speed: view.getFloat32(5) };
        case FRAME_ERROR: {
            if (b.length < 5) return null;
            const length = view.getUint32(1);
            if (length > b.length - 5) return null;
            const message = utf8 ? utf8.decode(b.subarray(5, 5 + length)) : '';
            return { kind: 'error', message: message || 'the decoder stopped' };
        }
        default:
            return null;
    }
}

// ── the console ─────────────────────────────────────────────────────────────

// C0 controls, which a decoder fed noise will produce. Dropped here so they are
// gone from what is copied and saved too, exactly as the teleprinter console
// does it. Newline survives, because it is what breaks a line.
const CONTROLS = /[\x00-\x09\x0b-\x1f\x7f]/g;

export const MAX_LINES = 500;

// A line ends when the sender stops for this long. Morse has no line ending —
// ggmorse emits characters and word gaps and nothing else — so without a rule
// like this the console would be one line that never closed, its timestamp
// would say when the session started rather than when the transmission did, and
// the line cap would never trim anything.
export const LINE_GAP_MS = 10000;

// ...and at this many characters regardless, so a station that never pauses
// still produces something the cap can drop.
export const LINE_CHARS = 160;

/**
 * Add one decode to the console.
 *
 * A line holds chunks rather than a string: each chunk is the text from one
 * decode event and carries that event's confidence, which is what lets the
 * quality colouring and the quality filter work on part of a line. Runs of the
 * same confidence are merged as they arrive — ggmorse sends a character or two
 * at a time, and one span per character would be thousands of DOM nodes for a
 * page of copy.
 *
 * Ids are monotonic per line and per chunk within it, so React has a stable key
 * for something that only ever grows at the end.
 */
export function appendDecode(lines, decode, opts = {}) {
    const { gapMs = LINE_GAP_MS, maxChars = LINE_CHARS, cap = MAX_LINES } = opts;
    const clean = String((decode && decode.text) == null ? '' : decode.text).replace(CONTROLS, '');
    if (!clean) return lines;

    const at = Number.isFinite(decode.at) ? decode.at : Date.now();
    const conf = QUALITIES.includes(decode.conf) ? decode.conf : 'poor';

    const out = lines.slice();
    let nextId = out.length ? out[out.length - 1].id + 1 : 0;

    const parts = clean.split('\n');
    for (let i = 0; i < parts.length; i++) {
        if (parts[i]) {
            const prev = out.length ? out[out.length - 1] : null;
            let cur;
            if (!prev || prev.closed || at - prev.last > gapMs || prev.chars >= maxChars) {
                cur = { id: nextId++, at, last: at, chars: 0, chunks: [], closed: false };
                out.push(cur);
            } else {
                // Copy on write: the caller's previous state is a React value
                // and must never be written through.
                cur = { ...prev, chunks: prev.chunks.slice() };
                out[out.length - 1] = cur;
            }

            const last = cur.chunks[cur.chunks.length - 1];
            if (last && last.conf === conf) {
                cur.chunks[cur.chunks.length - 1] = { ...last, text: last.text + parts[i] };
            } else {
                cur.chunks.push({ id: cur.chunks.length, conf, text: parts[i] });
            }
            cur.chars += parts[i].length;
            cur.last = at;
        }
        // Every part but the last was terminated by a newline.
        if (i < parts.length - 1 && out.length) {
            out[out.length - 1] = { ...out[out.length - 1], closed: true };
        }
    }

    return out.length > cap ? out.slice(out.length - cap) : out;
}

/** The chunks of a line that pass the quality filter. */
export function visibleChunks(line, minQuality) {
    if (!line || !line.chunks) return [];
    if (!minQuality || minQuality === 'all') return line.chunks;
    return line.chunks.filter((c) => passesQuality(c.conf, minQuality));
}

/**
 * The console as plain text, for the clipboard and the saved file.
 *
 * What you see is what you get: the quality filter and the timestamps apply, so
 * a log saved while reading high-confidence copy holds that copy and not the
 * mush underneath it. Lines left empty by the filter are dropped rather than
 * saved as blanks.
 */
export function toText(lines, { timestamps = false, minQuality = 'all' } = {}) {
    const out = [];
    for (const line of lines || []) {
        const text = visibleChunks(line, minQuality).map((c) => c.text).join('');
        if (!text) continue;
        out.push(timestamps ? `[${formatTime(line.at)}] ${text}` : text);
    }
    return out.join('\n');
}

/**
 * A pitch or speed for display, or null when the decoder has not found one.
 *
 * ggmorse reports zero until it has locked on, and a display saying "0 Hz" is a
 * claim about the signal rather than an admission that there isn't one yet.
 */
export function positive(value) {
    return Number.isFinite(value) && value > 0 ? value : null;
}

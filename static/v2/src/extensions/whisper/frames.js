// Speech-to-text: the decoder's wire frames, and the transcript they build.
//
// The server runs the audio through a WhisperLive instance (see
// audio_extensions/whisper/decoder.go). Four message types reach the browser,
// and all four share one envelope:
//
//     [type:1][unix_nanoseconds:8][length:4][payload:length]
//
//     0x02  segments   payload is a JSON array of segments
//     0x03  language   payload is JSON {language, language_prob}
//     0x04  error      payload is a UTF-8 message, *not* JSON
//     0x05  summary    payload is JSON {summary, segments_used, …}
//
// The timestamp is ignored: it is when the server flushed the frame, whereas
// what a transcript wants is when the *speech* was, and that is carried by each
// segment's `start`. Two more types (0x06 summary request, 0x07 reset) travel
// the other way as `audio_extension_control` messages — see ../protocol.js.
//
// A segment is `{text, start, end, completed}`, with the two times in seconds
// from the start of the stream and sometimes arriving as strings. The important
// property, and the one the whole panel is shaped around:
//
//   **the last segment is provisional.** WhisperLive re-decodes the tail of its
//   audio buffer as more of the utterance arrives, so the incomplete segment's
//   text changes — words appear, and words already shown get corrected — until
//   the decoder settles and sends it again with `completed: true`. So a
//   transcript is not a list to append to: it is a list of settled lines plus
//   one live line that is rewritten in place.
//
// The server already suppresses a completed segment whose text it has sent
// before (processSegments in decoder.go), so nothing here needs to de-duplicate.

export const FRAME_SEGMENTS = 0x02;
export const FRAME_LANGUAGE = 0x03;
export const FRAME_ERROR = 0x04;
export const FRAME_SUMMARY = 0x05;

// Header before the payload: the type byte, the timestamp and the length.
const HEADER = 13;

// Completed segments kept in memory. Not a display limit — that is `limit`
// below, which the user sets — but a ceiling so a receiver left transcribing a
// broadcast station overnight does not grow without bound. At a segment every
// few seconds this is most of a day.
export const MAX_SEGMENTS = 5000;

// How many completed lines to draw. 0 is "all of them", which is why the list
// is not simply a number: "unlimited" has to be sayable.
export const LINE_LIMITS = [
    { value: 10, label: '10 lines' },
    { value: 20, label: '20 lines' },
    { value: 50, label: '50 lines' },
    { value: 100, label: '100 lines' },
    { value: 250, label: '250 lines' },
    { value: 0, label: 'Unlimited' },
];

// Which lines the console shows. v1 had this as two checkboxes — "only show
// in-progress" and "hide in-progress" — which could both be ticked, and then
// meant "show only the line you have just hidden". Three exclusive choices say
// the same thing without a contradictory state to get into.
export const VIEWS = [
    { value: 'all', label: 'All', title: 'Settled lines and the one still being decoded' },
    { value: 'done', label: 'Settled', title: 'Only lines the decoder has finished with — nothing on screen will change' },
    { value: 'live', label: 'Live', title: 'Only the line being decoded now, rewritten as the speaker talks' },
];

// The id given to the live segment. Negative so it can never collide with the
// monotonic ids handed to settled lines, and constant so React reuses the same
// element as its text is rewritten rather than remounting it every 100 ms.
export const LIVE_ID = -1;

export const EMPTY = { done: [], live: null, nextId: 0 };

const utf8 = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

function bytesOf(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
}

function json(text) {
    try {
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}

/**
 * One binary frame, as the value the panel acts on, or null.
 *
 * Null covers a truncated frame, an unparseable payload, and a type this client
 * does not know. As everywhere else in this directory it is the only failure
 * signal: a decode is best-effort data and one bad frame must not take the
 * panel down with it.
 */
export function decodeFrame(data) {
    const b = bytesOf(data);
    if (!b || b.length < HEADER) return null;
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);

    const length = view.getUint32(9);
    // A length that runs past the frame is a truncated frame, not licence to
    // decode whatever happens to follow it in the buffer.
    if (length > b.length - HEADER) return null;
    const payload = utf8 ? utf8.decode(b.subarray(HEADER, HEADER + length)) : '';

    switch (b[0]) {
        case FRAME_SEGMENTS: {
            const parsed = json(payload);
            if (!Array.isArray(parsed)) return null;
            return { kind: 'segments', segments: parsed };
        }
        case FRAME_LANGUAGE: {
            const parsed = json(payload);
            if (!parsed || typeof parsed !== 'object') return null;
            const prob = Number(parsed.language_prob);
            return {
                kind: 'language',
                code: String(parsed.language || ''),
                prob: Number.isFinite(prob) ? prob : null,
            };
        }
        // The one payload that is not JSON.
        case FRAME_ERROR:
            return { kind: 'error', error: payload };
        case FRAME_SUMMARY: {
            const parsed = json(payload);
            if (!parsed || typeof parsed !== 'object') return null;
            return {
                kind: 'summary',
                text: String(parsed.summary || ''),
                used: Number(parsed.segments_used) || 0,
                requested: Number(parsed.segments_requested) || 0,
                language: String(parsed.target_language || ''),
            };
        }
        default:
            return null;
    }
}

const num = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : null;
};

/**
 * A raw segment as the panel stores it, or null if there is nothing in it.
 *
 * `at` is worked out once, on arrival, rather than at render: `start` is
 * seconds into the *stream*, and the stream restarts whenever the decoder
 * re-attaches (changing the output language does exactly that). Resolving it
 * against the base in force at the time means an earlier line keeps the time it
 * was spoken instead of jumping when the clock is restarted underneath it.
 */
function normalise(raw, id, base, now) {
    if (!raw || typeof raw !== 'object') return null;
    const text = String(raw.text == null ? '' : raw.text).trim();
    if (!text) return null;
    const start = num(raw.start);
    return {
        id,
        text,
        start,
        end: num(raw.end),
        completed: !!raw.completed,
        at: base != null && start != null ? base + start * 1000 : now,
    };
}

/**
 * Fold one batch of segments into the transcript.
 *
 * Returns the new state and the lines that just settled, because those are what
 * the speech synthesiser reads out — text that is still being revised must not
 * be spoken, or every correction is heard twice.
 *
 * The live line is cleared by a batch that settles something without carrying a
 * new provisional segment: it *became* one of those settled lines, and leaving
 * it up would show the same sentence twice, once as history and once as if it
 * were still being spoken. (v1 left it, which is where its duplicated last line
 * came from.)
 */
export function applySegments(state, segments, base, now = Date.now()) {
    if (!Array.isArray(segments) || segments.length === 0) return { state, settled: [] };

    let nextId = state.nextId;
    const settled = [];
    let live = state.live;
    let sawProvisional = false;

    for (let i = 0; i < segments.length; i++) {
        const raw = segments[i];
        const completed = !!(raw && raw.completed);
        if (completed) {
            const seg = normalise(raw, nextId, base, now);
            if (seg) { settled.push(seg); nextId += 1; }
        } else if (i === segments.length - 1) {
            // Only the last may be provisional; anything else unfinished in the
            // middle of a batch has been superseded by what follows it.
            const seg = normalise(raw, LIVE_ID, base, now);
            if (seg) { live = seg; sawProvisional = true; }
        }
    }

    if (!settled.length && !sawProvisional) return { state, settled: [] };
    if (settled.length && !sawProvisional) live = null;

    let done = settled.length ? state.done.concat(settled) : state.done;
    if (done.length > MAX_SEGMENTS) done = done.slice(done.length - MAX_SEGMENTS);

    return { state: { done, live, nextId }, settled };
}

/** What the console draws, given the view and the line limit. */
export function visibleSegments(state, view, limit) {
    if (view === 'live') return state.live ? [state.live] : [];
    const n = Number(limit) || 0;
    const done = n > 0 && state.done.length > n
        ? state.done.slice(state.done.length - n)
        : state.done;
    if (view === 'done' || !state.live) return done;
    return done.concat(state.live);
}

/** Everything transcribed, settled lines then the live one. */
export function allSegments(state) {
    return state.live ? state.done.concat(state.live) : state.done;
}

/** UTC clock time, the same format every other extension stamps a line with. */
export function formatClock(ms) {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '--:--:--';
    return d.toISOString().substring(11, 19);
}

/**
 * The transcript as plain text, for the clipboard and the saved file.
 *
 * One line per segment with the times if they are on screen — what you copy
 * should be what you were reading. v1 copied with the segments run together on
 * one line and saved them with the raw stream offsets ("[12.30s - 15.10s]");
 * both are here as the wall-clock stamp the console shows, since a transcript
 * whose times cannot be lined up against a log is much less use.
 */
export function toText(segments, timestamps) {
    return segments
        .map((s) => (timestamps ? `[${formatClock(s.at)}] ${s.text}` : s.text))
        .join('\n');
}

/**
 * v1's download name: who, where, in what mode, and over which span.
 *
 * Colons and dots are not legal in a filename everywhere, hence the substitution
 * — and the milliseconds go with them, since a transcript is not timed to one.
 */
export function saveFilename({ callsign, frequency, mode, from, to }) {
    const stamp = (ms) => {
        const d = new Date(ms);
        const iso = Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
        return iso.replace(/[:.]/g, '-').slice(0, -5);
    };
    const mhz = (Number(frequency) || 0) / 1e6;
    const call = String(callsign || '').trim() || 'UNKNOWN';
    return `${call}_${mhz.toFixed(3)}MHz_${String(mode || 'usb').toUpperCase()}_${stamp(from)}_to_${stamp(to)}.txt`;
}

/**
 * How long since the last decode arrived, in v1's shorthand.
 *
 * This is the panel's only sign of life while nobody is speaking: transcription
 * is silent when there is nothing to transcribe, so "running but nothing for
 * four minutes" and "running but wedged" look identical without it.
 */
export function formatSince(ms) {
    const secs = Math.floor(Math.max(0, ms) / 1000);
    if (secs < 60) return `${secs}s`;
    return `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s`;
}

/**
 * Split summary text on its `**bold**` markers into `{text, bold}` runs.
 *
 * The summariser answers in light Markdown and bold is the only thing it uses,
 * so this is the whole of the Markdown support — deliberately, since anything
 * more means either a parser or setting innerHTML from a remote service.
 */
export function boldParts(text) {
    return String(text == null ? '' : text)
        .split(/\*\*([\s\S]+?)\*\*/)
        .map((part, i) => ({ text: part, bold: i % 2 === 1 }))
        .filter((p) => p.text !== '');
}

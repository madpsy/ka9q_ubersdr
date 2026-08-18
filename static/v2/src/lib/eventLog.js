// What the page has been doing, for the Log panel.
//
// A module store rather than React state, for the same reason the spot store
// and the feed gate are: the things worth logging are not all inside the React
// tree. The three EventSource feeds, the audio extensions, the spot socket and
// the spectrogram loader are plain modules or panels that mount and unmount,
// and the log was reachable only through `useRadio().actions.log` — so in
// practice the only things that ever logged were the two sockets RadioContext
// happens to own. Everything else on the page could open a stream, retry it
// eight times and give up without leaving a trace.
//
// Moving it out also stops the log costing a render of the whole app. It used
// to be state in RadioContext and part of the context value, so every line —
// including a burst of reconnect attempts — re-rendered every consumer of
// useRadio(). Now the panel subscribes on its own and nothing else notices.
//
// Levels are the four the panel styles: 'info' | 'good' | 'warn' | 'error'.

// How many lines survive. A ring: the oldest go when it is full.
//
// A hundred is a deliberate ceiling rather than a generous one. What this panel
// is for is the last few minutes — what happened either side of a drop — and a
// deeper history is not read, it is just memory held for the life of the tab
// and rows for the panel to page through. A reconnect storm fills a hundred
// lines in a couple of minutes and the oldest of those are the least useful.
//
// Exported because the panel's Show more must not offer to grow past it.
export const LOG_CAP = 100;

// How long apart two identical lines have to be to both be worth keeping.
// A stream retrying on a backoff produces one line per attempt, which is the
// point — but a component remounting in a loop can produce the same line many
// times a second, and a log that is 90% one repeated sentence is not a log.
const REPEAT_MS = 1000;

let entries = [];
let seq = 0;
const subs = new Set();

function emit() {
    for (const fn of [...subs]) {
        try { fn(entries); } catch (e) { console.error('log subscriber threw', e); }
    }
}

/**
 * Record something that happened.
 *
 * @param {'info'|'good'|'warn'|'error'} level
 * @param {string} text  written for somebody reading the panel, not for a
 *                       developer reading a stack trace: say what happened to
 *                       what, and where a code or a count distinguishes two
 *                       cases, include it.
 */
export function logEvent(level, text) {
    const line = String(text || '');
    if (!line) return;
    const now = Date.now();
    const last = entries[entries.length - 1];
    if (last && last.text === line && last.level === level && now - last.ms < REPEAT_MS) {
        // Same thing again, immediately. Counted rather than repeated, so the
        // panel shows "×4" instead of four identical rows — and a new object,
        // because subscribers compare by identity.
        const bumped = { ...last, repeats: (last.repeats || 1) + 1, at: new Date(now), ms: now };
        entries = entries.slice(0, -1).concat(bumped);
        emit();
        return;
    }
    seq += 1;
    entries = entries.concat({
        // Not Date.now(): two lines inside the same millisecond would collide,
        // and React keys have to be unique. A counter cannot.
        id: seq,
        at: new Date(now),
        ms: now,
        level,
        text: line,
        repeats: 1,
    });
    if (entries.length > LOG_CAP) entries = entries.slice(-LOG_CAP);
    emit();
}

/** Everything held, oldest first, newest LOG_CAP only. Treat as immutable — it is replaced, never mutated. */
export function eventLog() {
    return entries;
}

export function clearEventLog() {
    if (!entries.length) return;
    entries = [];
    emit();
}

/**
 * Subscribe. Fires on every change, not on subscribe — read eventLog() for what
 * is there now.
 *
 * @returns {() => void} unsubscribe
 */
export function onEventLog(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
}

/** Test seam. */
export function _resetEventLog() {
    entries = [];
    seq = 0;
    subs.clear();
}

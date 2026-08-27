// Which clock the top bar shows.
//
// Three states rather than a switch, because the useful answers are not two: an operator
// working DX thinks in UTC and wants nothing else in the way, somebody listening to a
// local net wants the time they are in, and plenty of people want both and the gap
// between them. So the clock cycles, and it is the clock itself that is the control —
// there is nothing else it could sensibly do when clicked.
//
// Showing one makes it bigger. The pair has to fit two lines into the height of the bar,
// which is why it is set small; alone there is a whole line's worth of room going spare,
// and a clock that is being watched deliberately should be the one thing on the bar that
// is easy to read from across the room.

export const CLOCK_MODES = ['both', 'utc', 'local'];

export const CLOCK_KEY = 'ubersdr.v2.topclock';

/** A stored or passed-in mode, made safe. Anything unrecognised is the pair. */
export const clockMode = (v) => (CLOCK_MODES.includes(v) ? v : CLOCK_MODES[0]);

/**
 * The next one round: both → UTC → local → both.
 *
 * UTC first, because it is the one somebody reaching for a single clock on a radio is
 * most often after — and because a cycle that reached it last would have people clicking
 * twice to get to the obvious answer.
 */
export function nextClockMode(v) {
    const at = CLOCK_MODES.indexOf(clockMode(v));
    return CLOCK_MODES[(at + 1) % CLOCK_MODES.length];
}

export function savedClockMode() {
    try { return clockMode(localStorage.getItem(CLOCK_KEY)); } catch (e) { return CLOCK_MODES[0]; }
}

export function saveClockMode(v) {
    const mode = clockMode(v);
    try { localStorage.setItem(CLOCK_KEY, mode); } catch (e) { /* private mode */ }
    return mode;
}

/**
 * What the tooltip says a click will do next, and whose clock "local" is.
 *
 * `tzName` is the receiver's IANA zone — `receiver.timezone` from
 * /api/description, e.g. "Europe/London". On a line of its own, because it
 * answers a different question from the first line and because it is the only
 * one of the two that is a fact rather than an instruction.
 *
 * Worth saying at all because the local clock here is the *receiver's* wall
 * clock, not the browser's — a distinction nothing else on screen makes, and one
 * that matters most to the people the local clock is for: somebody listening to
 * a net on the other side of the world sees a time that is neither theirs nor
 * UTC, with no way to tell which of the two it was meant to be.
 *
 * Absent on a server too old to send it, or one whose operator left the zone
 * unset. Then there is no second line at all rather than an empty one or a
 * guess — the browser's own zone would be a plausible-looking wrong answer,
 * since the clock falls back to the browser's time in exactly that case.
 */
export function clockHint(v, tzName) {
    const next = nextClockMode(v);
    const first = next === 'utc' ? 'Receiver time — click for UTC only'
        : next === 'local' ? 'UTC — click for local time only'
            : 'Local time — click for both';
    const zone = typeof tzName === 'string' ? tzName.trim() : '';
    return zone ? `${first}\nReceiver timezone: ${zone}` : first;
}

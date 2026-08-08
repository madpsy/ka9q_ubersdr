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

/** What the tooltip says a click will do next. */
export function clockHint(v) {
    const next = nextClockMode(v);
    if (next === 'utc') return 'Receiver time — click for UTC only';
    if (next === 'local') return 'UTC — click for local time only';
    return 'Local time — click for both';
}

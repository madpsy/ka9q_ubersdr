// Time stamps down the left of a waterfall.
//
// A waterfall is a picture of time as much as of frequency, but without a scale
// on that axis "how long ago was that?" is answered by counting rows. This puts
// a short tick and a clock reading at the left edge every so often, and they
// scroll down with the history they label.
//
// They are *not* painted into the ring. The ring's history is shifted sideways
// when the view pans ('follow'), and rescaled when the pane is resized — a label
// stored in it would slide off the edge with the first and smear with the
// second. Instead the ring keeps rows and this keeps a list of which row was
// written at what time; the caller paints the labels onto the visible canvas
// after each blit. That canvas is the one the smooth scroll translates, so the
// labels ride the slide exactly as the rows do.
//
// A mark's place is counted in rows written since it was made, which is all the
// geometry there is: the newest row is at the top of the canvas and every row
// written since a mark pushes it one row further down. Nothing here depends on
// where the ring's head happens to be, which is why a resize that keeps the
// history (and resets the head) keeps the marks.
//
// How often a mark is made follows how fast the waterfall is moving. A fixed
// ten seconds would be a stack of labels on top of one another at 40 rows a
// second... and one every few screens at 2. So the interval is the shortest
// "round" one — 5 s, 10 s, 15 s, 30 s, 1 min, ... — that leaves at least
// MIN_GAP_CSS between labels at the measured speed, and marks land on its
// boundaries (12:34:00, 12:34:30, ...) so they read as a clock rather than as
// arbitrary instants.

import { receiverOffsetMin } from './ntpTime.js';

/** Interval choices, in seconds. */
export const STEPS_S = [5, 10, 15, 20, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

/** The least space wanted between two labels, in CSS px. */
export const MIN_GAP_CSS = 70;

/** Bounds on how many marks are kept — more than any pane can show. */
const MAX_MARKS = 64;

// Weight for the speed estimate. Rows arrive in jittery bursts against the
// animation clock; the speed only has to be right to within a step of STEPS_S.
const SPEED_WEIGHT = 0.1;

// The least a row is taken to cover when deciding whether a boundary fell in it
// — rows can arrive a frame or two late against the animation clock.
const ROW_SLACK_MS = 250;

export function createTimeMarks() {
    return {
        rows: 0,          // device rows written since creation
        marks: [],        // { row, t } — `row` is the value of `rows` when made
        lastT: 0,         // wall time of the last committed row, ms
        liveT: 0,         // the clock when it was committed — lastT, unless a
                          // timeshift replay is showing history
        lastAt: 0,        // monotonic time of the last commit, ms
        speed: 0,         // device rows per second, estimated
    };
}

/** Forget every mark — the history they labelled has gone. */
export function clearTimeMarks(tm) {
    if (!tm) return;
    tm.marks.length = 0;
    tm.lastT = 0;
    tm.liveT = 0;
}

/**
 * The interval, in seconds, for a waterfall moving at `rowsPerSec` device rows a
 * second at device ratio `dpr`.
 */
export function stepFor(rowsPerSec, dpr) {
    const cssPerSec = rowsPerSec > 0 ? rowsPerSec / (dpr > 0 ? dpr : 1) : 0;
    if (!(cssPerSec > 0)) return STEPS_S[STEPS_S.length - 1];
    for (const s of STEPS_S) if (s * cssPerSec >= MIN_GAP_CSS) return s;
    return STEPS_S[STEPS_S.length - 1];
}

/**
 * Record `n` device rows just written, representing wall time `t` (ms), at
 * monotonic time `at` (ms) and wall clock `live` (ms; `t` itself unless a
 * timeshift replay is showing history). Makes a mark if a boundary of the
 * current interval was crossed since the previous row.
 */
export function noteRows(tm, n, t, at, dpr, live = t) {
    if (!tm || !(n > 0)) return;
    if (tm.lastAt > 0 && at > tm.lastAt) {
        const inst = (n * 1000) / (at - tm.lastAt);
        // A long gap (paused, hidden tab) says nothing about the running speed.
        if (at - tm.lastAt < 2000) {
            tm.speed = tm.speed > 0 ? tm.speed + (inst - tm.speed) * SPEED_WEIGHT : inst;
        }
    }
    tm.lastAt = at;
    tm.rows += n;
    tm.liveT = live;

    const prevT = tm.lastT;
    tm.lastT = t;
    // The first row, or a clock that went backwards (a replay started), only
    // sets the reference: there is no previous row to have crossed from.
    if (!(prevT > 0) || t <= prevT || !(tm.speed > 0)) return;

    const step = stepFor(tm.speed, dpr) * 1000;
    const boundary = Math.floor(t / step) * step;
    if (boundary <= prevT) return;
    // The mark goes on this row, so the boundary has to be a moment this row
    // could be showing — within about a row's time of it. Rows that follow one
    // another cover the gap between them and always pass; a jump forward does
    // not. Going live from a replay, skipping ahead in one, or a waterfall that
    // has sat stopped puts a row at `t` with nothing drawn for the time before
    // it, and the boundary crossed in that time would be stamped on a row up to
    // a whole step later than it says.
    const rowMs = (n * 1000) / tm.speed;
    if (t - boundary > Math.max(ROW_SLACK_MS, 2 * rowMs)) return;

    // A change of speed can make a new interval's boundary land close to the
    // last mark; better a missing label than two on top of each other.
    const last = tm.marks[tm.marks.length - 1];
    if (last && (tm.rows - last.row) / (dpr > 0 ? dpr : 1) < MIN_GAP_CSS * 0.6) return;

    // The row with the boundary in it is this one — the newest — so the mark is
    // made at the top of the n just written.
    tm.marks.push({ row: tm.rows, t: boundary, step });
    if (tm.marks.length > MAX_MARKS) tm.marks.shift();
}

/** How far down the canvas a mark sits, in device px from the top. */
export function markY(tm, mark) {
    return tm.rows - mark.row;
}

/**
 * The zones a stamp can be read in: 'ago' (how long before the newest row), or
 * one of the Time panel's three clocks.
 */
export const TIME_ZONES = ['ago', 'me', 'rx', 'utc'];

/**
 * How long ago `ms` is, as the stamp shows it: seconds under a minute, then
 * minutes and seconds, then hours and minutes. Whole units, rounded — the marks
 * are seconds apart at the very least, so a tenth would only flicker.
 */
export function agoLabel(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const p = (v) => String(v).padStart(2, '0');
    if (s < 60) return `${s}s ago`;
    if (s < 3600) {
        const m = Math.floor(s / 60);
        const r = s % 60;
        return r ? `${m}m${p(r)}s ago` : `${m}m ago`;
    }
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m ? `${h}h${p(m)}m ago` : `${h}h ago`;
}

/**
 * Minutes east of UTC that `zone` reads at instant `at`, and the suffix that says
 * so. `rx` is `receiver` from /api/description.
 *
 * A receiver that has not said where it is reads as UTC, marked as UTC, rather
 * than as this browser's zone: a plausible-looking wrong answer is the one thing
 * a clock must not be. See receiverOffsetMin.
 */
export function zoneReading(zone, rx, at) {
    if (zone === 'me') return { offsetMin: -new Date(at).getTimezoneOffset(), suffix: '' };
    if (zone === 'rx') {
        const off = receiverOffsetMin(rx, at);
        if (off != null) return { offsetMin: off, suffix: '' };
    }
    return { offsetMin: 0, suffix: 'Z' };
}

/**
 * A mark's label in `zone`: HH:MM, with seconds when the interval needs them.
 * Read from the UTC fields of a shifted epoch, as the Time panel does.
 *
 * 'ago' instead counts back from `now`, which the waterfall passes as the clock
 * when its newest row was drawn (tm.liveT) — not that row's own time. During a
 * timeshift replay the two differ by the delay, and the delay is exactly what
 * the label has to show: a row replayed 20 s behind *is* 20 s old, which is
 * what the Timeshift panel says, and the live rows still further down the
 * picture (newer than the replayed ones above them) keep honest ages rather
 * than all reading "0s ago". Counting from the last draw rather than from
 * Date.now() is still what keeps a paused waterfall from ageing a picture that
 * is not moving.
 */
export function timeMarkLabel(mark, zone = 'utc', rx = null, now = Date.now()) {
    if (zone === 'ago') return agoLabel(now - mark.t);
    const { offsetMin, suffix } = zoneReading(zone, rx, mark.t);
    const d = new Date(mark.t + offsetMin * 60000);
    const p = (v) => String(v).padStart(2, '0');
    const base = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
    return (mark.step < 60000 ? `${base}:${p(d.getUTCSeconds())}` : base) + suffix;
}

/**
 * Paint the marks onto `c`, a 2D context `H` device px tall. Drops marks that
 * have scrolled past the bottom of `limit` device px (the ring's height, or the
 * canvas's) — they can never be seen again.
 */
export function drawTimeMarks(c, tm, H, dpr, { zone = 'ago', rx = null, limit = H } = {}) {
    if (!tm || !tm.marks.length) return;
    while (tm.marks.length && markY(tm, tm.marks[0]) > limit) tm.marks.shift();
    if (!tm.marks.length) return;

    const k = dpr > 0 ? dpr : 1;
    const font = Math.round(10 * k);
    const tick = Math.round(6 * k);
    const padX = Math.round(3 * k);
    c.save();
    c.font = `${font}px "JetBrains Mono", ui-monospace, monospace`;
    c.textBaseline = 'top';
    c.textAlign = 'left';
    c.lineWidth = Math.max(1, Math.round(k));
    for (const mk of tm.marks) {
        const y = markY(tm, mk);
        if (y > H) continue;
        const yy = Math.round(y) + 0.5;
        // Cached on the mark, because this runs on every paint and the zone
        // lookup is the expensive part. The key is what the label depends on —
        // for 'ago', the age as shown, which changes about once a second.
        const key = zone === 'ago'
            ? `ago|${agoLabel(tm.liveT - mk.t)}`
            : `${zone}|${rx ? `${rx.timezone}|${rx.timezone_offset}` : ''}`;
        if (mk.labelKey !== key) {
            mk.label = timeMarkLabel(mk, zone, rx, tm.liveT);
            mk.labelKey = key;
        }
        const text = mk.label;
        const tw = c.measureText(text).width;
        // A dark plate under the text, so it reads over a bright signal as well
        // as over the noise floor.
        c.fillStyle = 'rgba(5, 7, 12, 0.6)';
        c.fillRect(tick, yy + k, tw + padX * 2, font + 2 * k);
        c.strokeStyle = 'rgba(255, 255, 255, 0.7)';
        c.beginPath();
        c.moveTo(0, yy);
        c.lineTo(tick + tw + padX * 2, yy);
        c.stroke();
        c.fillStyle = 'rgba(255, 255, 255, 0.85)';
        c.fillText(text, tick + padX, yy + 2 * k);
    }
    c.restore();
}

/**
 * The wall time a row committed now represents: the clock, less how far behind
 * live the timeshift is showing.
 *
 * behindMs, not delayMs. delayMs is only the playing delay: a pause leaves it as
 * it was and a seek while paused does not touch it, so a frame shown by a skip
 * back from a pause taken at live would be stamped as now. behindMs is measured
 * from the position actually on screen, playing or paused.
 */
export function rowWallTime(timeshift, now = Date.now()) {
    const lag = timeshift && timeshift.replaying ? (timeshift.behindMs || 0) : 0;
    return now - lag;
}

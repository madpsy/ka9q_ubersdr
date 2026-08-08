// A leaderboard of the frequency and mode combinations you actually use.
//
// Ported from widgets/top_freqmode.widget.html. The scoring is what makes it
// worth having: a combination earns a point for every full minute the dial stays
// on it, so tuning past a frequency never counts and the places you sit rise to
// the top on their own. Nothing to curate, unlike a bookmark list.
//
// The clock is here too, and that matters: it used to belong to the panel, so the
// leaderboard only counted the time you spent with the panel *open*. A panel is unmounted
// whenever its dock is collapsed — and a side dock spends most of its life collapsed — so a
// list of where the dial actually sits was being built from a few minutes a day. It runs
// from TopFreqWatch now, which App mounts once and never unmounts, the same arrangement the
// announcers and the hardware polls use.

const KEY = 'ubersdr.v2.topfreq';

// Rows shown before "show more", and how many each press adds. Five is the
// leaderboard the widget shows and about what a side dock holds without the
// panel becoming the dock.
export const TOP_FREQ_ROWS = 5;

// Combinations kept. Larger than the display so a frequency you worked last week
// is still there to climb back, bounded so a long session cannot grow it without
// limit — and the weakest go first, so what is dropped is what was never used.
export const TOP_FREQ_STORE = 100;

/**
 * A count of minutes as a duration: "4m", "2h20m", "3d5h".
 *
 * The count is the score *and* the time spent, so it may as well read as the
 * time spent — a leaderboard row saying 140 makes you do the division.
 *
 * Two units at most, largest first, and the smaller one dropped when it is zero:
 * "2h" rather than "2h0m". Past a day the minutes stop mattering, and a row that
 * grew to four figures would push the column about.
 */
export function formatDwell(minutes) {
    const m = Math.max(0, Math.round(Number(minutes) || 0));
    if (m < 60) return `${m}m`;
    const hours = Math.floor(m / 60);
    if (hours < 24) {
        const rem = m % 60;
        return rem ? `${hours}h${rem}m` : `${hours}h`;
    }
    const days = Math.floor(hours / 24);
    const rem = hours % 24;
    return rem ? `${days}d${rem}h` : `${days}d`;
}

export const comboKey = (hz, mode) => `${Math.round(hz)}|${String(mode || '').toLowerCase()}`;

/**
 * Every stored combination, best first.
 *
 * Ties break on which was used most recently, so two frequencies on the same
 * count do not swap places at random as the list is redrawn.
 */
export function sortedCombos(combos) {
    return Object.values(combos || {}).sort((a, b) => (
        b.count !== a.count ? b.count - a.count : (b.last || 0) - (a.last || 0)
    ));
}

export function loadCombos() {
    try {
        const raw = JSON.parse(localStorage.getItem(KEY));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
        const out = {};
        for (const [key, rec] of Object.entries(raw)) {
            const hz = Number(rec && rec.hz);
            const mode = String((rec && rec.mode) || '').toLowerCase();
            const count = Number(rec && rec.count);
            // A record that cannot be tuned to is worse than no record: it would
            // occupy a row and do nothing when clicked.
            if (!Number.isFinite(hz) || hz <= 0 || !mode || !Number.isFinite(count) || count <= 0) continue;
            if (key !== comboKey(hz, mode)) continue;
            out[key] = { hz, mode, count, last: Number(rec.last) || 0 };
        }
        return out;
    } catch (e) {
        return {};
    }
}

export function saveCombos(combos) {
    try { localStorage.setItem(KEY, JSON.stringify(combos)); } catch (e) { /* ignore */ }
}

/** Drops the weakest once the store is over its limit. */
export function pruneCombos(combos) {
    const keys = Object.keys(combos);
    if (keys.length <= TOP_FREQ_STORE) return combos;
    const keep = {};
    for (const c of sortedCombos(combos).slice(0, TOP_FREQ_STORE)) keep[comboKey(c.hz, c.mode)] = c;
    return keep;
}

/**
 * One more minute on this combination. Returns a new store — the caller decides
 * when to write it.
 */
export function creditMinute(combos, hz, mode, now = Date.now()) {
    const m = String(mode || '').toLowerCase();
    if (!Number.isFinite(hz) || hz <= 0 || !m) return combos;
    const key = comboKey(hz, m);
    const rec = combos[key];
    const next = {
        ...combos,
        [key]: rec
            ? { ...rec, count: rec.count + 1, last: now }
            : { hz: Math.round(hz), mode: m, count: 1, last: now },
    };
    return pruneCombos(next);
}

// ── The clock ────────────────────────────────────────────────────────────────
//
// One combination, one stay, and a point for each whole minute of it. What is fed in is the
// dial, the mode and whether the receiver is running — a minute with the audio stopped is a
// minute nobody spent listening, which is the one thing this has over the v1 widget.
//
// Time is measured, not counted in ticks. The panel's old interval assumed sixty seconds per
// firing, which was near enough while it only ran in front of somebody; running all session
// it is not. A background tab has its timers throttled to about one a minute, so counting
// firings would credit whatever the browser felt like giving.
//
// And the gap between two ticks is checked, because the other thing a wall clock notices is
// a machine that was asleep. Waking after three hours must not hand three hours to whatever
// the dial was left on — so a gap too large to be a tick is discarded entirely rather than
// trimmed: there is no way to know when the sleep began, and the conservative answer is the
// honest one.

// How often the clock is looked at, and the largest gap between two looks that can still be
// time somebody spent listening. The tick is well under a minute so a throttled tab's
// once-a-minute firing is still inside the limit.
export const DWELL_TICK_MS = 15000;
export const DWELL_MAX_STEP_MS = 90000;

const MINUTE_MS = 60000;

let combos = null;              // loaded on first use
let watchers = new Set();
let timer = null;
let last = 0;                   // when the clock was last looked at
let held = 0;                   // ms on this combination, gaps excluded
let dwell = 0;                  // whole minutes credited during this stay
let stay = { running: false, hz: 0, mode: '' };

const store = () => {
    if (!combos) combos = loadCombos();
    return combos;
};

const timing = () => !!(stay.running && stay.hz > 0 && stay.mode);

function notify() {
    const s = comboState();
    for (const fn of [...watchers]) fn(s);
}

/** The leaderboard, and what is being timed right now. */
export function comboState() {
    return { combos: store(), dwell, timing: timing() };
}

/** Redrawn whenever a minute lands or the stay changes. */
export function onCombos(fn) {
    watchers.add(fn);
    fn(comboState());
    return () => watchers.delete(fn);
}

function stopClock() {
    if (timer) { clearInterval(timer); timer = null; }
}

function tick(now = Date.now()) {
    if (!timing()) return;
    const step = now - last;
    last = now;
    // A gap that cannot be a tick is a machine that was asleep or a tab the browser stopped
    // entirely. Thrown away, not trimmed — see above.
    if (step <= 0 || step > DWELL_MAX_STEP_MS) return;
    held += step;
    const whole = Math.floor(held / MINUTE_MS);
    if (whole <= dwell) return;
    let next = store();
    for (let i = dwell; i < whole; i++) next = creditMinute(next, stay.hz, stay.mode, now);
    combos = next;
    dwell = whole;
    saveCombos(next);
    notify();
}

/**
 * What the receiver is doing. Called on every change of dial, mode or running state.
 *
 * A change restarts the stay, which is what makes the first point cost a *full* minute on
 * one combination rather than a minute spread over several. The part-minute in hand is
 * dropped, as the widget drops it: tuning away means it was not a minute spent there.
 */
export function trackDwell(next) {
    const running = !!(next && next.running);
    const hz = Math.round((next && next.hz) || 0);
    const mode = String((next && next.mode) || '').toLowerCase();
    if (running === stay.running && hz === stay.hz && mode === stay.mode) return;

    stay = { running, hz, mode };
    held = 0;
    const had = dwell;
    dwell = 0;
    last = Date.now();

    stopClock();
    if (timing()) timer = setInterval(() => tick(), DWELL_TICK_MS);
    // Only when the line the panel draws has actually changed, which is nearly never: most
    // moves happen inside the same part-minute.
    if (had !== 0) notify();
}

/** Wipes the leaderboard, and the stay in progress with it. */
export function clearCombos() {
    combos = {};
    held = 0;
    dwell = 0;
    last = Date.now();
    saveCombos(combos);
    notify();
}

/** Test seam. */
export function _clearCombos() {
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
}

/** Test seam: the clock, back to how it starts. */
export function _resetDwell() {
    stopClock();
    combos = null;
    watchers = new Set();
    held = 0;
    dwell = 0;
    last = 0;
    stay = { running: false, hz: 0, mode: '' };
}

/** Test seam: one look at the clock, at a time of the caller's choosing. */
export function _tickDwell(now) {
    tick(now);
}

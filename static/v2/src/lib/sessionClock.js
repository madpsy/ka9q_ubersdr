// How long this session has left.
//
// Two places show it now — the top bar's countdown and the Receiver info
// panel — so the arithmetic and the wording are here rather than in whichever
// of them was written first. A second-by-second countdown shown twice on one
// screen has to agree with itself: two copies of `Math.floor((now - start)/1000)`
// evaluated a render apart will sooner or later read 04:59 and 05:00 at the same
// time, one of them red and the other not.
//
// `session` is RadioContext's: { maxSec, startedAt }, from the /connection
// reply. maxSec 0 means unlimited, and null means no session has started yet —
// which is a third state rather than zero, and the reason this returns a shape
// instead of a number.

/** Under this many seconds, the countdown is worth being alarmed by. v1's five minutes. */
export const LOW_SEC = 300;

/** A count of seconds as HH:MM:SS. */
export function formatLeft(secs) {
    const s = Math.max(0, Math.floor(secs || 0));
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
}

/**
 * What the countdown should say right now.
 *
 *   state 'none'       nothing has started, or the server did not say — no
 *                      countdown, because a guess here reads as fact
 *         'unlimited'  the server set no limit
 *         'counting'   `left` seconds remain, `label` is them as HH:MM:SS
 *
 * A limit with no start time is 'none' rather than a countdown from an unknown
 * moment: the arithmetic would clamp to zero and the display would say the
 * session had already expired, which is both wrong and alarming.
 */
export function sessionClock(session, now = Date.now()) {
    const maxSec = session && session.maxSec;
    if (maxSec == null) return { state: 'none', left: null, label: '—', low: false };
    if (maxSec === 0) return { state: 'unlimited', left: null, label: 'Unlimited', low: false };
    if (!session.startedAt) return { state: 'none', left: null, label: '—', low: false };

    // Elapsed is clamped at both ends. Below zero it would report more time
    // than the server granted — which happens whenever the clock jumps back, a
    // resync or a laptop waking in another timezone — and the one answer that
    // cannot be right is "you have longer than your limit".
    const elapsed = Math.max(0, Math.floor((now - session.startedAt) / 1000));
    const left = Math.max(0, maxSec - elapsed);
    return { state: 'counting', left, label: formatLeft(left), low: left < LOW_SEC };
}

/**
 * Whether a second-by-second timer is worth running for this session.
 *
 * "Unlimited" and "—" never change, and a panel redrawing itself once a second
 * to show the same two characters is a wakeup a minute of nothing for as long
 * as it is open.
 */
// Named at length rather than `ticks`, which is a local in lib/spectrumTrace.js
// and in the Signal panel — an export sharing the name defeats
// test/unresolved.js for every file that has one.
export function sessionTicks(session) {
    return sessionClock(session).state === 'counting';
}

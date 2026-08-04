// Idle detection — v1's static/idle-detector.js, as rules rather than a class.
//
// The receiver is shared and its slots are finite, so the server reclaims a
// session that has been inactive for `session_timeout` seconds. Every websocket
// message touches the session, *including the keepalive ping*, so a client that
// pings on a timer can never time out: it would hold a slot for as long as the
// tab stayed open, which on a busy receiver is somebody else's evening.
//
// v1's answer, reproduced here:
//
//   * no unconditional keepalive. The sockets are pinged when the operator does
//     something, at most once every 10 s — so a session stays alive exactly as
//     long as somebody is there;
//   * a warning 30 s before the server would drop them, with a countdown and a
//     button, because being disconnected without notice reads as a fault;
//   * the receiver is stopped when that countdown runs out, rather than waiting
//     to be kicked, so the slot is released cleanly.
//
// The numbers are all v1's. The rules are here, away from the timers and the
// DOM, because that is the part worth checking.

// Fixed in v1: how long the "are you still there?" dialog waits for an answer.
export const CONFIRM_MS = 30000;

// Heartbeat rules. A ping goes out when the operator acts and it has been at
// least PING_EVERY_MS since the last one, or as soon as they come back after
// BACK_AFTER_MS away — the second case tells the server somebody has returned
// without waiting for the throttle.
export const PING_EVERY_MS = 10000;
export const BACK_AFTER_MS = 30000;

// Spectrum rate throttle while idle. Mobile idles sooner: the saving is the
// same but the connection is likelier to be metered.
export const THROTTLE_MS_MOBILE = 150000;    // 2.5 minutes
export const THROTTLE_MS_DESKTOP = 300000;   // 5 minutes
export const THROTTLE_DIVISOR = 2;           // half rate; v1 uses 2 as well
export const FULL_DIVISOR = 1;

// What to assume when /connection did not tell us — v1's fallback. Guessing a
// timeout costs a dialog nobody needed; guessing there is none costs a session
// dropped without warning, which is the worse of the two.
export const DEFAULT_IDLE_SEC = 300;

/**
 * How long to wait before warning, for a server timeout in seconds.
 *
 * null means "never warn", and only 0 means that: the operator has no
 * inactivity timeout, or this client is bypassed and the server said so. An
 * unknown value falls back to the default rather than to silence. A timeout too
 * short to fit the warning in still gets one, immediately — v1 does this rather
 * than skipping the dialog, so a disconnect is never a surprise.
 */
export function warnAfterMs(sessionTimeoutSec) {
    const secs = Number.isFinite(sessionTimeoutSec) ? sessionTimeoutSec : DEFAULT_IDLE_SEC;
    if (secs <= 0) return null;
    if (secs * 1000 <= CONFIRM_MS) return 1000;
    return (secs - CONFIRM_MS / 1000) * 1000;
}

/** v1's rule, both halves of it. */
export function shouldPing(now, lastPingAt, lastActivityAt) {
    return (now - lastPingAt) >= PING_EVERY_MS || (now - lastActivityAt) >= BACK_AFTER_MS;
}

export function throttleAfterMs(isMobile) {
    return isMobile ? THROTTLE_MS_MOBILE : THROTTLE_MS_DESKTOP;
}

/** "2 minutes and 5 seconds", as the dialog says it. */
export function idlePhrase(ms) {
    const secs = Math.max(0, Math.floor(ms / 1000));
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    if (mins > 0) return `${plural(mins, 'minute')} and ${plural(rem, 'second')}`;
    return plural(secs, 'second');
}

// --- activity the DOM never sees --------------------------------------------
//
// The whole point of the media controls is operating the receiver without
// touching the page, and none of the events IdleWatch listens for fire when the
// ⏭ button on a lock screen is pressed. Left alone, a listener working entirely
// from their phone would be asked whether they were still there — on a screen
// they cannot see — and then disconnected for not answering.
//
// So the media session reports its button presses here and IdleWatch treats
// them exactly like a click. Deliberately only *presses*: a session that stayed
// alive merely because audio was flowing would hold a slot on a shared receiver
// for as long as the tab was open, which is the thing this whole module exists
// to prevent.

const externalActivity = new Set();

export function onExternalActivity(fn) {
    externalActivity.add(fn);
    return () => externalActivity.delete(fn);
}

export function noteExternalActivity() {
    for (const fn of externalActivity) {
        try { fn(); } catch (err) { console.error('activity listener threw', err); }
    }
}

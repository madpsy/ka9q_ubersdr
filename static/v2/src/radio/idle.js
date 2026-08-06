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

// Spectrum rate throttle while idle.
export const THROTTLE_DIVISOR = 2;           // half rate; v1 uses 2 as well
export const FULL_DIVISOR = 1;

// How long a hidden tab keeps its spectrum socket open — v1's figure, from
// spectrum-display.js setupVisibilityDisconnect.
//
// Halving the rate is what a *present* operator who has stopped doing anything
// gets. A tab nobody is looking at gets nothing at all: the socket is closed and
// the server stops producing for it. The grace period is what makes that safe to
// do — switching tabs to check something and coming straight back is the common
// case, and it must not cost a reconnect. Five seconds is long enough to cover
// it and short enough that a tab left in the background is not still streaming
// a waterfall into a canvas nobody can see.
//
// The audio socket is deliberately untouched: listening with the tab in the
// background is the point of the media controls.
export const HIDDEN_SUSPEND_MS = 5000;

// How long to wait, in minutes, offered as a list. 0 is never.
//
// A list rather than a slider because there is no meaning between the rungs:
// this is "how long am I prepared to be counted as away", and the difference
// between 5 and 6 minutes is not a thought anybody has. The span is wide because
// the two ends are genuinely different uses — somebody working a pile-up wants
// it never, somebody monitoring a channel on a phone wants it soon.
export const THROTTLE_CHOICES = [0, 2, 5, 10, 30];

// Mobile idles sooner: the saving is the same but the connection is likelier to
// be metered and the battery smaller.
export const THROTTLE_MIN_MOBILE = 2;
export const THROTTLE_MIN_DESKTOP = 5;

// Stopping the spectrum altogether after a longer spell of nothing.
//
// The throttle halves the rate and undoes itself the moment anything happens, so
// it costs the operator nothing and needs no consent. This does not: the socket
// is closed, the display stops being live, and it stays that way until it is
// asked to come back. That is a different bargain, so it is a different setting
// with its own delays — longer ones, because the question is not "have you
// stopped doing anything" but "have you gone".
//
// Never on a desktop. A spectrum that had quietly stopped an hour ago is the
// worst thing a monitoring receiver can do, and nothing on a desktop is metered
// enough to be worth that risk by default. On a phone it is 30 minutes: a
// waterfall left running in a pocket is a real bill and a real battery, and the
// resume button is right there in the middle of the display.
export const PAUSE_CHOICES = [0, 5, 15, 30, 60];
export const PAUSE_MIN_MOBILE = 30;
export const PAUSE_MIN_DESKTOP = 0;

// Resolves one of these "minutes, or never" settings against a device default.
//
// A number and nothing else, deliberately: Number(null) is 0, and 0 is "never" —
// so coercing would read an unset setting as the operator having asked for the
// feature to be off. Everything that stores one writes a number, and everything
// that does not is absent. A value that is not on the list is from a build with
// different rungs or a hand-edited store: the control could not show it, so it
// must not be what is running.
function resolveMinutes(setting, choices, fallback) {
    if (typeof setting === 'number' && choices.includes(setting)) return setting;
    return fallback;
}

/**
 * The delay in force, in minutes, for a stored setting that may be absent.
 *
 * null or anything unrecognised means "not chosen", and gets this device's
 * default — the same shape as the display's other per-device settings, and the
 * reason the two defaults can differ without a phone and a desktop having to
 * disagree about what the stored value means. 0 is a choice like any other and
 * survives: it is the operator saying never.
 */
export function throttleMinutes(setting, isMobile) {
    return resolveMinutes(
        setting, THROTTLE_CHOICES,
        isMobile ? THROTTLE_MIN_MOBILE : THROTTLE_MIN_DESKTOP,
    );
}

/** The same as a delay in ms, or null for never — which arms no timer at all. */
export function throttleAfterMs(setting, isMobile) {
    const mins = throttleMinutes(setting, isMobile);
    return mins > 0 ? mins * 60000 : null;
}

/** How long before the spectrum socket is closed altogether. See PAUSE_CHOICES. */
export function pauseMinutes(setting, isMobile) {
    return resolveMinutes(
        setting, PAUSE_CHOICES,
        isMobile ? PAUSE_MIN_MOBILE : PAUSE_MIN_DESKTOP,
    );
}

/** The same in ms, or null for never — on a desktop that is the default. */
export function pauseAfterMs(setting, isMobile) {
    const mins = pauseMinutes(setting, isMobile);
    return mins > 0 ? mins * 60000 : null;
}

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

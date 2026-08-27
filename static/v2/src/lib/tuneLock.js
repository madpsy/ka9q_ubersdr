// The tuning lock's toast, and nothing else about the lock.
//
// Deliberately outside lib/notifications.js. What that file delivers is *news* —
// something happened on the band, or to the hardware, and it is worth a line in
// the history whether or not anybody was looking. This is neither: it is the
// answer to a press, it means nothing a second later, and it belongs in no
// history. Routed through the notification store it would also inherit three
// settings that are wrong for it — the master switch could silence the only
// explanation the operator has for a dead dial, the Desktop style would send
// "you pressed a locked button" to the operating system of a tab that is by
// definition in front of them, and the notification ding would fire on every
// refusal.
//
// So: its own store, its own layer, its own rules.
//
// It says one of two things, and the state it is in *is* the message:
//
//   'locked'     the lock is on — either it was just turned on, or something
//                was refused because of it
//   'unlocked'   the lock has just been turned off
//
// The second exists because the lock can now be thrown from a MIDI button, a
// FlexControl, or a bridge client, none of which are anywhere near the padlock
// above the waterfall. A receiver that silently stopped tuning is the failure
// this whole file is here to prevent; a receiver that silently *started* again
// is the same failure with the sign flipped.

// How long it stays up. Three seconds is a glance — long enough to read four
// words, short enough that it is gone before it is in the way.
const SHOW_MS = 3000;

// And how often it may say the lock refused something. A refused tune is not one
// call: dragging the waterfall or spinning an encoder refuses dozens a second,
// and the throttle is what makes this a message rather than a strobe. Thirty
// seconds because the message is the same every time — somebody who has read it
// once and carries on pressing is not being informed by the second one, they are
// being nagged.
//
// Only refusals are throttled. Throwing the lock is a deliberate act, it happens
// once, and it is always answered.
const EVERY_MS = 30000;

const subs = new Set();
let shownAt = 0;
let timer = null;
let state = null;

function notify() {
    for (const fn of Array.from(subs)) {
        try { fn(state); } catch (e) { console.error('lock toast subscriber threw', e); }
    }
}

export function onLockToast(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
}

/** `'locked'`, `'unlocked'`, or null for nothing on screen. */
export const lockToastState = () => state;

export const lockToastVisible = () => state !== null;

function show(next) {
    state = next;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; state = null; notify(); }, SHOW_MS);
    notify();
}

/**
 * A tuning change was refused because the lock is on. Says so, at most once
 * every EVERY_MS; the calls in between are dropped on purpose and there is
 * nothing queued for later.
 */
export function refusedByLock(now = Date.now()) {
    if (now - shownAt < EVERY_MS) return;
    shownAt = now;
    show('locked');
}

/**
 * The lock was thrown, either way. Always answered, whichever surface did it.
 *
 * Locking counts as a showing of the locked message, so the drag that runs into
 * the lock a second later does not say it again — the operator has just read it,
 * and the throttle exists precisely to stop the same four words arriving twice.
 * Unlocking clears the throttle instead: there is no lock left to explain, and
 * the next one to be turned on starts its thirty seconds from scratch.
 */
export function announceLock(on, now = Date.now()) {
    shownAt = on ? now : 0;
    show(on ? 'locked' : 'unlocked');
}

/** Tests only. */
export function _resetTuneLock() {
    clearTimeout(timer);
    timer = null;
    state = null;
    shownAt = 0;
    subs.clear();
}

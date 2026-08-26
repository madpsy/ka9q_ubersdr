// The tuning lock's toast, and nothing else about the lock.
//
// Deliberately outside lib/notifications.js. What that file delivers is *news* —
// something happened on the band, or to the hardware, and it is worth a line in
// the history whether or not anybody was looking. This is neither: it is the
// answer to a press that did nothing, it means nothing a second later, and it
// belongs in no history. Routed through the notification store it would also
// inherit three settings that are wrong for it — the master switch could
// silence the only explanation the operator has for a dead dial, the Desktop
// style would send "you pressed a locked button" to the operating system of a
// tab that is by definition in front of them, and the notification ding would
// fire on every refusal.
//
// So: its own store, its own layer, its own rules.

// How long it stays up. Three seconds is a glance — long enough to read four
// words, short enough that it is gone before it is in the way.
const SHOW_MS = 3000;

// And how often it may say it. A refused tune is not one call: dragging the
// waterfall or spinning an encoder refuses dozens a second, and the throttle is
// what makes this a message rather than a strobe. Thirty seconds because the
// message is the same every time — somebody who has read it once and carries on
// pressing is not being informed by the second one, they are being nagged.
const EVERY_MS = 30000;

const subs = new Set();
let shownAt = 0;
let timer = null;
let visible = false;

function notify() {
    for (const fn of Array.from(subs)) {
        try { fn(visible); } catch (e) { console.error('lock toast subscriber threw', e); }
    }
}

export function onLockToast(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
}

export const lockToastVisible = () => visible;

/**
 * A tuning change was refused because the lock is on. Says so, at most once
 * every EVERY_MS; the calls in between are dropped on purpose and there is
 * nothing queued for later.
 */
export function refusedByLock(now = Date.now()) {
    if (now - shownAt < EVERY_MS) return;
    shownAt = now;
    visible = true;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; visible = false; notify(); }, SHOW_MS);
    notify();
}

/**
 * The lock was toggled, either way.
 *
 * Clears both halves. The throttle, because the next refusal after a lock the
 * operator has just turned on is the first one of a new lock and has to be
 * explained even if the last one was twenty seconds ago; and the toast itself,
 * because "Tuning locked" left on screen after an unlock is a message that has
 * become untrue while being read.
 */
export function resetLockToast() {
    shownAt = 0;
    clearTimeout(timer);
    timer = null;
    if (!visible) return;
    visible = false;
    notify();
}

/** Tests only. */
export function _resetTuneLock() {
    clearTimeout(timer);
    timer = null;
    visible = false;
    shownAt = 0;
    subs.clear();
}

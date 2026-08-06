// Suspend something while the tab is hidden, and bring it back when it is not.
//
// Split out of VisibilityWatch because every interesting case here is one you
// cannot see: the tab is hidden, so whatever goes wrong goes wrong off screen
// and is over before anybody looks. The failures worth naming, all of which are
// guards below rather than anything the caller has to remember:
//
//   * suspending a socket that had already dropped on its own, taking ownership
//     of a reconnect that belongs to the backoff;
//   * resuming something this never suspended;
//   * arming a second countdown when the first is still running — visibilitychange
//     can fire more than once for one switch;
//   * suspending after the tab came back, because the timer had already been
//     scheduled by the time it did.
//
// The clock is injected so a test does not have to wait five seconds to find
// out, and `isHidden`/`isOpen` are asked afresh at every decision rather than
// remembered: both can change while the countdown runs, which is the whole
// reason the countdown exists.

/**
 * @param opts.delayMs    how long a hidden tab keeps it, before suspending.
 * @param opts.isHidden   () => bool.
 * @param opts.isOpen     () => bool — is there anything to suspend right now.
 * @param opts.suspend    called once when the countdown runs out.
 * @param opts.resume     called when the tab comes back, and only if suspended.
 * @param opts.timers     { set, clear }, defaulting to the host's.
 *
 * @returns { changed, stop, suspended } — call `changed()` on every
 *          visibilitychange and once at the start, `stop()` on teardown.
 */
export function visibilityPause({
    delayMs, isHidden, isOpen, suspend, resume,
    // Wrapped, not `{ set: setTimeout }`. Storing the browser's setTimeout as a
    // property and calling it as `timers.set(…)` passes this object as `this`,
    // and window.setTimeout is a Window method: Chrome answers that with
    // "Illegal invocation" and throws out of the visibilitychange handler, so
    // nothing is ever scheduled and the socket runs on untouched. Node's
    // setTimeout does not care about `this` at all, which is why the tests were
    // green the whole time it was broken in every browser.
    timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) },
}) {
    let timer = 0;
    let held = false;

    const fire = () => {
        timer = 0;
        // Re-asked, not assumed: the delay is long enough for the tab to have
        // come back, or for the connection to have gone on its own.
        if (!isHidden() || !isOpen()) return;
        held = true;
        suspend();
    };

    const changed = () => {
        if (isHidden()) {
            if (timer || held) return;      // already counting down, or already gone
            timer = timers.set(fire, delayMs);
            return;
        }
        if (timer) {
            timers.clear(timer);
            timer = 0;
        }
        if (!held) return;                  // never ours to bring back
        held = false;
        resume();
    };

    const stop = () => {
        if (timer) timers.clear(timer);
        timer = 0;
    };

    return { changed, stop, suspended: () => held };
}

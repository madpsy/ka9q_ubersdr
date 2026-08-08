// Whether this client may talk to the server on a schedule.
//
// Stop meant "stop the receiver", and only that: powerOff closes the audio and
// spectrum sockets and nothing else. Everything else in the app — the band
// spectrum stream, the spot feed, voice activity, the decoders, listeners,
// weather, space weather, the rotator poll — is owned by whichever panel or
// watcher opened it and keyed to being *mounted*, not to the receiver running.
// So a stopped receiver went on making a few dozen requests a minute, for as
// long as the tab was open, and the rotator poll went on at 1 Hz for the life
// of the page whether any panel was showing or not. Stop did not mean stop.
//
// This is the switch that makes it mean it. One flag for the whole page, set
// from `running` in RadioContext, and every recurring server call asks it.
//
//   feedInterval(fn, ms)   a setInterval that only exists while the gate is
//                          open, and fires once immediately whenever it opens.
//                          Nearly every poller in the app is this shape.
//   feedsAllowed()         for the handful that manage their own connection —
//                          the EventSource panels and the websockets — via the
//                          useFeedsAllowed hook in lib/useServerFeeds.js.
//
// What this deliberately does *not* gate:
//
//   one-shot loads     the bands list, the bookmark catalog, /api/description.
//                      A feed is something that repeats; a page that fetched
//                      its own configuration once is not polling, and gating it
//                      would leave panels permanently blank rather than merely
//                      not updating.
//   local clocks       the dozen `setInterval(() => setNow(Date.now()), 1000)`
//                      timers that re-render a relative age. They cost a render
//                      and touch nothing.
//   local hardware     radiosync's 10 Hz poll talks to a serial rig over
//                      WebSerial, not to this server, and a stopped receiver is
//                      no reason to drop somebody's rig control.
//
// The gate starts closed, because `running` starts false. That means the
// landing page behind the Start overlay no longer polls either — which is the
// same rule applied honestly rather than a separate decision, and it spares a
// busy receiver the cost of visitors who never press Start. The overlay's own
// requests (/connection, the IP lookup for the map) are direct calls and are
// not feeds, so they are unaffected.

let allowed = false;
const subs = new Set();

/** Whether recurring server calls are permitted right now. */
export function feedsAllowed() {
    return allowed;
}

/**
 * Open or close the gate. Called from one place — RadioContext, following
 * `running` — so that power on, power off, the idle timeout and a wake all
 * reach it without any of them knowing this module exists.
 */
export function setFeedsAllowed(on) {
    const next = !!on;
    if (next === allowed) return;
    allowed = next;
    // Copied: a subscriber is allowed to unsubscribe from inside its callback,
    // which a live iteration of the set would not survive.
    for (const fn of [...subs]) {
        try { fn(next); } catch (e) { /* one bad listener must not stop the rest */ }
    }
}

/**
 * Subscribe to the gate. Fires on every change, not on subscribe — read
 * feedsAllowed() for the value now.
 *
 * @returns {() => void} unsubscribe
 */
export function onFeedsAllowed(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
}

/**
 * A poll that exists only while the gate is open.
 *
 * Fires `fn` once immediately on start and again on every reopen, because a
 * feed that came back and then sat silent for its whole period is a panel
 * showing stale data with no sign that it is stale — the resumed poll has to
 * catch up before it settles into its rhythm.
 *
 * Shaped to drop straight into an effect:
 *
 *     useEffect(() => feedInterval(load, POLL_MS), [deps]);
 *
 * Callers that need to ignore a late response keep their own `cancelled` flag;
 * this stops the timer, not whatever is already in flight.
 *
 * @returns {() => void} stop, and unsubscribe from the gate.
 */
export function feedInterval(fn, ms) {
    let timer = null;

    const start = () => {
        if (timer != null) return;
        fn();
        timer = setInterval(fn, ms);
    };
    const stop = () => {
        if (timer == null) return;
        clearInterval(timer);
        timer = null;
    };

    if (allowed) start();
    const off = onFeedsAllowed((on) => (on ? start() : stop()));
    return () => { off(); stop(); };
}

/** Test seam: forget every subscriber and close the gate. */
export function resetFeeds() {
    subs.clear();
    allowed = false;
}

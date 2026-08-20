// Keeping a websocket honest: closing the ones we let go of, bounding how long
// a handshake may hang, and noticing the ones that died while nobody was
// looking.
//
// Three failures live here. All three produce the same symptom — a page that
// looks connected and is not — and none of them can be seen by the code that
// handles the socket's events, because in every one of them no event ever
// arrives:
//
//   * A socket replaced by a second connect() and never closed. The browser
//     keeps it: close() during CONNECTING is the only thing that aborts a
//     handshake, so an orphan sits there for ever. That is the pile of rows in
//     devtools with no status, no bytes and a Time of Pending.
//   * A handshake nothing ever answers. Every reconnect path in this client is
//     driven by onclose, and a socket that never opens never closes — so an
//     unanswered upgrade is the one failure the backoff cannot see, and the
//     connection waits for a close event that is not coming.
//   * A socket that was open when the tab was backgrounded and whose connection
//     died while it was away. Nothing sends a FIN to a machine that is asleep,
//     so readyState is still OPEN, `connected` is still true, and send() still
//     reports success. The page comes back showing a live receiver that is
//     deaf. This is what "it stops working if I leave the tab for a while" is,
//     and it is why the fix cannot live in the connect path: the failure
//     happens while no code is running.
//
// The first two are handled where the socket is made — abandon() and the
// handshake deadline. The third takes an outside event (the tab coming back,
// the network returning) and a probe, which is the rest of this file.
//
// The contract a connection has to meet to be watched, all of which the three
// here already had in some form:
//
//   ws          the socket in hand, or null
//   openedAt    Date.now() when it was created
//   lastRxAt    Date.now() of the last frame taken off it, of any kind
//   ping()      send something the server answers
//   _revive()   let this socket go and book a reconnect

// Spec-fixed readyState values. Written out rather than read off the global,
// because the global is a stub under test and `WebSocket.CONNECTING` is then
// undefined — which compares equal to nothing and quietly disables all of this.
const CONNECTING = 0;
const OPEN = 1;

// How long a handshake may sit unanswered before it is abandoned. Generous: a
// slow phone on a bad link still completes an upgrade in a second or two, and
// the cost of being wrong is a reconnect, so this is set for "nothing is
// coming" rather than "this is slow".
export const HANDSHAKE_TIMEOUT_MS = 15000;

// How long the server has to answer a probe before the socket carrying it is
// treated as dead.
export const PROBE_TIMEOUT_MS = 6000;

// setTimeout/clearTimeout, wrapped rather than stored as properties: calling
// `timers.set(...)` with window.setTimeout as a property value passes this
// object as `this`, which Chrome answers with "Illegal invocation". The same
// trap is documented at length in lib/visibilityPause.js, where it silently
// disabled that watcher in every browser while the tests stayed green.
const hostTimers = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (id) => clearTimeout(id),
};

/**
 * Let go of a socket: detach the handlers first, then close it.
 *
 * Both halves matter. Without the detach, the close arrives at a connection
 * that has moved on and is read as *its* socket dropping, which books a
 * reconnect on top of a connection that is working. Without the close, the
 * socket stays on the wire — still holding a session and a receiver slot at the
 * other end if it opened, and stuck in the handshake for ever if it did not.
 */
export function abandon(ws) {
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try { ws.close(1000, 'client'); } catch (e) { /* already gone */ }
}

/**
 * Is the socket this connection is holding actually alive?
 *
 * Called when there is reason to doubt it — the tab coming back, the network
 * returning — and never on a timer, because the answer costs a round trip and
 * the question is only interesting after something has happened to the machine.
 *
 * Silence is not the test. A squelched audio socket sends nothing for minutes
 * at a time and is perfectly healthy, so what is asked is whether the server
 * still answers: a ping goes out and anything at all coming back within
 * PROBE_TIMEOUT_MS settles it. Nothing coming back means the socket is one of
 * the half-open ones this file exists for.
 *
 * Returns what it decided, for the tests and for nothing else.
 */
export function checkSocket(conn, timers = hostTimers) {
    const ws = conn.ws;
    // No socket means the connection is idle or already inside its backoff,
    // and both of those are somebody else's business.
    if (!ws) return 'idle';

    if (ws.readyState === CONNECTING) {
        // A handshake that outlived its deadline. Usually found by the deadline
        // itself; found here when the tab was frozen with a connect in flight,
        // where the timer was frozen too and the socket underneath it was not.
        if (Date.now() - conn.openedAt >= HANDSHAKE_TIMEOUT_MS) {
            conn._revive('handshake');
            return 'handshake';
        }
        return 'connecting';
    }

    // CLOSING or CLOSED with the connection still holding it: the close event
    // is either in flight or was lost with the page's event loop while it was
    // frozen. Not worth waiting to find out which.
    if (ws.readyState !== OPEN) {
        conn._revive('closed');
        return 'closed';
    }

    // One probe at a time. Several of the wake events fire together — a tab
    // regaining focus is a visibilitychange *and* a focus — and three sockets
    // pinging three times each on every wake is exactly the kind of burst the
    // server's connection rate limit is there to stop.
    if (conn._probeTimer) return 'probing';

    const mark = conn.lastRxAt;
    conn.ping();
    conn._probeTimer = timers.set(() => {
        conn._probeTimer = null;
        // A socket that went away on its own while the probe was out has
        // already been dealt with by its own close handler.
        if (conn.ws !== ws) return;
        if (conn.lastRxAt > mark) return;
        conn._revive('silent');
    }, PROBE_TIMEOUT_MS);
    return 'probing';
}

// --- the wake events ---------------------------------------------------------
//
// One set of listeners for every connection rather than one set each: they all
// want the same answer to the same question at the same moment, and a listener
// per connection per event is four registrations for one tab switch.
//
// Events only — never an interval. The sockets in this client deliberately have
// no keepalive timer, because every message touches the session server side and
// a timer would make the session immortal and the operator's slot
// unreclaimable; each connection says so where its onopen would have started
// one. A probe is a message like any other, so the same rule holds for it, and
// it is why this asks only when something has happened to the machine. Each of
// these events is the operator arriving, which is the one moment a touched
// session is honest.

const watched = new Set();
let wired = false;

/** Ask every watched connection whether it is still there. Exported for tests. */
export function wakeCheck() {
    for (const conn of [...watched]) {
        try {
            conn.checkAlive();
        } catch (e) {
            // A connection that throws must not stop the others being asked.
            console.error('socket health check threw', e);
        }
    }
}

function wire() {
    if (wired) return;
    // Node, under test. Nothing to listen to, and nothing that could have gone
    // to sleep behind our back either.
    if (typeof document === 'undefined' || !document.addEventListener) return;
    wired = true;
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) wakeCheck();
    });
    if (typeof window !== 'undefined' && window.addEventListener) {
        // Coming back from the bfcache, which visibilitychange does not always
        // announce; a network that has returned; and a window regaining focus,
        // which catches the desktop client and a second monitor, where the tab
        // was never hidden but the machine was asleep.
        window.addEventListener('pageshow', wakeCheck);
        window.addEventListener('online', wakeCheck);
        window.addEventListener('focus', wakeCheck);
    }
}

/**
 * What to tell the operator about a socket this file let go of.
 *
 * These closes carry no code and no reason of their own — nothing closed them,
 * which is the point — so the event log would otherwise show the same bare
 * "closed (1006)" for a dead network, a wedged proxy and a laptop that has been
 * asleep. Those are three different problems and only one of them is the
 * receiver's.
 *
 * Empty for an ordinary close, which says what it is for itself.
 */
export function reviveReason(reason) {
    if (reason === 'handshake') return 'nothing answered the connection request';
    if (reason === 'silent') return 'the connection had gone quiet — probably slept';
    if (reason === 'closed') return 'the connection had already gone';
    return '';
}

/**
 * Have this connection checked whenever the page comes back to life.
 *
 * Called by the connection itself, once, at construction: what is being watched
 * is the connection and not any particular socket, and it has to be watched
 * whether or not it happens to hold one at the time.
 */
export function reviveOnWake(conn) {
    wire();
    watched.add(conn);
    return () => watched.delete(conn);
}

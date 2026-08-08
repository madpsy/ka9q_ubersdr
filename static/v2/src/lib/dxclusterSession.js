// The cluster login, held outside the panel that shows it.
//
// The socket used to belong to the component, which meant it lived and died with the
// panel — and in this interface a panel is unmounted for reasons that have nothing to do
// with wanting to leave the cluster: collapsing a dock, peeking at a collapsed one,
// dragging the panel to another dock, or switching sheets on a phone. Collapsing the
// bottom dock is the common one, and losing a login and a screenful of spots to it is
// not a trade anybody would make deliberately.
//
// So the session lives here, at module scope, and the panel is a view onto it. What ends
// a session is now a decision rather than an accident:
//
//   Disconnect, which is the operator saying so.
//   Moving the panel into a side dock, where it cannot be read — see dxSessionWanted.
//   Stopping the receiver, which stops every feed on the page.
//   Reloading the page, which ends everything.
//
// The transcript lives here too, for the same reason: coming back to a panel that has
// held its login but lost everything that scrolled past would be half a feature.

import { openTerminal, saveLogin, spotCommand, spotsEnabledBy, trimLines } from './dxclusterTerminal.js';

let term = null;
// `canSpot` is whether this session may submit spots — see spotAuthLine. It is part
// of the state rather than a separate flag so that a subscriber re-renders when it
// changes, which is what makes the context menu entry appear.
let state = { state: 'closed', detail: '', text: '', canSpot: false };
const listeners = new Set();

// Whether the remembered callsign has been offered a connection this page load. Here
// rather than in the panel because that is exactly the flag a remount would reset: the
// panel reappearing is not a reason to log in again over a disconnect.
let autoTried = false;

/**
 * `event` says what happened, which the panel needs and the state does not carry: a
 * chunk of text has to be known to be an echo *before* the transcript grows, or the new
 * lines have already pushed the view off the bottom and it reads as a deliberate scroll.
 */
function notify(event) {
    for (const fn of Array.from(listeners)) {
        try { fn(state, event); } catch (err) { console.error('dx session subscriber threw', err); }
    }
}

/**
 * Whether there should be a cluster session at all.
 *
 * The conditions, and — just as importantly — the ones that are not here. Whether
 * the panel is *mounted* is not a condition: a collapsed dock unmounts it, and this
 * lived in the panel's own effects until a remembered callsign in a collapsed bottom
 * dock turned out never to log in, because the effect that would have logged it in
 * had never run. Nor is whether the panel is open, or which sheet a phone is on.
 * See components/DXClusterWatch.jsx, which is where this is asked from.
 *
 *   available   the dxcluster addon is on this receiver. Without it every request
 *               404s and there is nothing to connect to.
 *   cramped     the panel is in a left or right dock, where it is a signpost rather
 *               than a terminal — a login held open behind a panel that cannot show
 *               the output is the worst of both. See DockTooNarrow.
 *   hidden      the panel has been taken off the layout altogether, which is a
 *               stronger statement than folding it shut.
 *   feeds       the receiver is running. Stop stops this like everything else —
 *               see lib/serverFeeds.js.
 *
 * @param {{available: boolean, cramped: boolean, hidden: boolean, feeds: boolean}} at
 * @returns {boolean}
 */
export function dxSessionWanted({ available, cramped, hidden, feeds }) {
    return !!available && !cramped && !hidden && !!feeds;
}

export const dxSession = () => state;

export const dxConnected = () => state.state === 'connected' || state.state === 'open';

export function onDxSession(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** Whether the remembered callsign has already had its one automatic attempt. */
export const dxAutoTried = () => autoTried;
export function markDxAutoTried() { autoTried = true; }

export function dxConnect({ callsign, password }) {
    const call = String(callsign || '').trim().toUpperCase();
    if (!call || term) return false;
    saveLogin({ callsign: call, password });
    state = { state: 'connecting', detail: '', text: '', canSpot: false };
    notify({ type: 'state' });

    term = openTerminal({
        callsign: call,
        password,
        on: {
            text: (chunk, isEcho) => {
                // Latching: the line arrives once, in the banner or in reply to
                // SET/SPOTPASS, and the rights last as long as the session does.
                const canSpot = state.canSpot || (!isEcho && spotsEnabledBy(chunk));
                state = { ...state, text: trimLines(state.text + chunk), canSpot };
                notify({ type: 'text', isEcho: !!isEcho });
            },
            state: (st, why) => {
                if (st === 'closed') term = null;
                state = { ...state, state: st, detail: why || '' };
                notify({ type: 'state' });
            },
        },
    });
    return true;
}

export function dxDisconnect() {
    if (term) term.close();
    term = null;
    // The transcript is kept. A disconnect is leaving the cluster, not throwing away
    // what it said — and reconnecting clears it, which is the point at which a fresh
    // screen is what anybody expects.
    // Spot rights go with the session: a reconnect authenticates again, and an
    // offer to spot on a closed cluster is an offer that cannot be met.
    state = { ...state, state: 'closed', detail: '', canSpot: false };
    notify({ type: 'state' });
}

/** Whether this session may submit spots: connected, and the password was accepted. */
export const dxCanSpot = () => dxConnected() && state.canSpot;

/**
 * Submit a spot. The command itself is spotCommand, in lib/dxclusterTerminal.js with
 * the rest of what goes down the socket.
 *
 * @returns {boolean} whether it was sent — false if there is no session, no spot
 *                    rights, or nothing sendable to build a command from.
 */
export function dxSpot({ hz, callsign, comment }) {
    if (!dxCanSpot()) return false;
    const cmd = spotCommand({ hz, callsign, comment });
    return cmd ? dxSend(cmd) : false;
}

export function dxSend(cmd) {
    if (!term) return false;
    return term.send(cmd);
}

/** Test seam: a page that has never opened a cluster. */
export function _resetDxSession() {
    if (term) term.close();
    term = null;
    state = { state: 'closed', detail: '', text: '', canSpot: false };
    listeners.clear();
    autoTried = false;
}

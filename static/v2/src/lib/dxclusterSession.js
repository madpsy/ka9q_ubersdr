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
//   Moving the panel into a side dock, where it cannot be read — see DXClusterPanel.
//   Reloading the page, which ends everything.
//
// The transcript lives here too, for the same reason: coming back to a panel that has
// held its login but lost everything that scrolled past would be half a feature.

import { openTerminal, saveLogin, trimLines } from './dxclusterTerminal.js';

let term = null;
let state = { state: 'closed', detail: '', text: '' };
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
    state = { state: 'connecting', detail: '', text: '' };
    notify({ type: 'state' });

    term = openTerminal({
        callsign: call,
        password,
        on: {
            text: (chunk, isEcho) => {
                state = { ...state, text: trimLines(state.text + chunk) };
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
    state = { ...state, state: 'closed', detail: '' };
    notify({ type: 'state' });
}

export function dxSend(cmd) {
    if (!term) return false;
    return term.send(cmd);
}

/** Test seam: a page that has never opened a cluster. */
export function _resetDxSession() {
    if (term) term.close();
    term = null;
    state = { state: 'closed', detail: '', text: '' };
    listeners.clear();
    autoTried = false;
}

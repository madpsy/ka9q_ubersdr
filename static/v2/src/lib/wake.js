// When touching a control should power the receiver back on.
//
// The rule, not the doing — see actions.wake in radio/RadioContext.jsx for the
// power-on itself, and radio/useWake.js for how a panel opts in. It is here and
// pure because all three of these have gone wrong in an obvious way at some
// point in every design that has this feature:
//
//   running       waking a receiver that is already on would mint a second
//                 session and drop the first, which on a server with a slot
//                 limit means kicking yourself off.
//   connecting    powerOn is async and one drag is dozens of pointer events, so
//                 without this a single spin of the drum opens a session per
//                 event.
//   everStarted   the first session of a visit belongs to the Start overlay:
//                 that is where the AudioContext gets its user gesture, where a
//                 full receiver says it is full, and where the bypass password
//                 is offered. Waking past it would fail silently under a thumb.
//
// @param {{running: boolean, connecting: boolean, everStarted: boolean}} state
// @returns {boolean}
export function shouldWake({ running, connecting, everStarted }) {
    return !running && !connecting && !!everStarted;
}

export default shouldWake;

// Wake-on-use: reaching for a control powers the receiver back on.
//
// The receiver can be off with the whole interface still live. The idle watch
// stops it after a long silence and leaves every panel on screen, and the top
// bar's power button is a toggle rather than a door out. In that state the
// controls all still work — the drum spins, the mode changes, the squelch
// slider moves — and none of them command anything, because applyTuning sends
// into a closed socket and AudioConnection.send drops it. Nothing says so. The
// only tell is that the audio never comes back.
//
// So the rule is that touching a panel is the operator saying they are back,
// and the receiver takes them at their word. See actions.wake in RadioContext
// for the guards; the short version is that it is a no-op while running, while
// a wake is already connecting, and before the first manual start of a visit —
// the Start overlay owns that one, because the capacity check and the bypass
// password live there.
//
// Applied once per panel *container* rather than per control: Section (docked),
// FloatingPanel (floating) and MobileShell (the phone's sheets) are the three
// places a panel body is rendered, so wiring those three covers every panel
// that exists and every panel added later without any of them knowing about
// this. The top bar is deliberately not one of them — the power button lives
// there, and a wake on the way to pressing Off would turn the receiver straight
// back on.
//
//     const wake = useWakeProps();
//     <div className="section__body" {...wake}>…</div>
//
// Capture phase, and it neither stops propagation nor preventDefaults: the
// control underneath must behave exactly as it did, and the wake is a thing
// that happens on the way past. Pointer-down rather than click so a drag that
// never becomes a click — which is most of what these panels are — still counts.

import { useMemo } from '../react.js';
import { useRadio } from './RadioContext.jsx';

/**
 * The wake callback on its own, for a component that already has a pointer
 * handler to add it to.
 *
 * @returns {() => boolean} true if this call started a power-on.
 */
export function useWake() {
    const { actions } = useRadio();
    return actions.wake;
}

/**
 * Props to spread onto any element whose interior should wake the receiver.
 *
 * @returns {{ onPointerDownCapture: () => void }}
 */
export default function useWakeProps() {
    const { actions } = useRadio();
    // Stable, so spreading this does not hand a fresh handler to the DOM on
    // every render of a panel body.
    return useMemo(() => ({ onPointerDownCapture: () => { actions.wake(); } }), [actions]);
}

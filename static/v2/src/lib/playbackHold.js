// A recording being played back, page-wide: while one is, the other audio
// this page makes holds its peace.
//
// The audio is the receiver's own, the IQ Demod panel's demodulators and the
// playground's Audio outs. The receiver is silenced by its duck; the other two
// join the output after the duck (AudioPlayer.outputBus) and are silenced
// here, by their watchers passing them "muted" while a hold is up — not by
// the operator's mute, which would say so on the mute button and stay down.
//
// Counted rather than a flag, so two players overlapping cannot have the
// first to stop let the other audio back in over the second.

import { useEffect, useState } from '../react.js';

let holds = 0;
const listeners = new Set();

function changed() {
    for (const fn of Array.from(listeners)) fn(holds > 0);
}

/** Take a hold. Returns its release, which does nothing after the first call. */
export function holdPlayback() {
    holds++;
    if (holds === 1) changed();
    let released = false;
    return () => {
        if (released) return;
        released = true;
        holds = Math.max(0, holds - 1);
        if (holds === 0) changed();
    };
}

/** Whether a recording is being played back just now. */
export function playbackHeld() {
    return holds > 0;
}

/** The same, as a hook that re-renders its caller when it changes. */
export function usePlaybackHold() {
    const [held, setHeld] = useState(holds > 0);
    useEffect(() => {
        listeners.add(setHeld);
        setHeld(holds > 0);
        return () => listeners.delete(setHeld);
    }, []);
    return held;
}

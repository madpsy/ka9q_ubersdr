// Puts the tuning step back to what it was last set to in this mode. Renders nothing.
//
// The step is one setting shared by everything that tunes — the Receiver panel's
// ± buttons, the Multipad's drum, click-to-tune, the wheel, the keyboard and any
// control surface — and that is right: two surfaces disagreeing about how far a
// step goes is worse than any default. But one figure for every mode is wrong in
// the other direction. 500 Hz is SSB; broadcast AM is tuned in 9 or 10 kHz
// channels and CW in tens of hertz, so anybody working more than one mode was
// re-picking the step at every change.
//
// So the step stays single and live, and the *choice* is remembered per mode:
// display.setTuneStep records which mode it was made in (see tuneStepByMode in
// DisplayContext), and this puts the recorded one back on the way into a mode.
//
// Here rather than in the panels for the usual reason — the mode can be changed
// from the Multipad, the Receiver panel, a bookmark, the keyboard, a control
// surface or the URL, and App mounts this once whether any of those panels is on
// screen or not. A step restored only when the Receiver panel happened to be
// open would be worse than not restoring it at all.

import { useEffect } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';

export default function TuneStepWatch() {
    const { tuning } = useRadio();
    const display = useDisplay();
    const mode = tuning.mode || '';
    const steps = display.tuneStepByMode;
    const set = display.set;

    // On the mode alone: a step *changed* while in a mode is the operator moving
    // it, and re-running here on the map would put it straight back.
    //
    // It runs on mount too, which is the restored mode getting its own step back
    // after a reload. That is almost always the step already in force — the two
    // are written together — so it is a no-op except where they have drifted,
    // which is exactly the case a shared browser or a second window makes.
    useEffect(() => {
        if (!mode) return;
        const hz = Number((steps || {})[mode]);
        // Nothing stored for this mode: keep the step in force. Adopting a
        // default here would move the dial's grid under somebody who never
        // asked for per-mode steps at all.
        if (!Number.isFinite(hz) || hz <= 0) return;
        set({ tuneStep: hz });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode]);

    return null;
}

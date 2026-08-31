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
// A mode nobody has chosen a step for falls back to the one its own band plan is
// written in — DEFAULT_STEP_BY_MODE in radio/constants.js. It used to keep
// whatever step was in force instead, on the grounds that a mode nobody had
// picked for should not be snapped to a guess. In use that read as the feature
// being broken: pick 9 kHz once and every mode not yet visited was on 9 kHz too,
// so the only way to get per-mode steps was to visit all of them and set each
// one by hand. The defaults are not a guess — 100 Hz in CW and 5 kHz on
// broadcast AM are what those bands are channelled at — and a chosen step still
// beats one, because the record is consulted first.
//
// Here rather than in the panels for the usual reason — the mode can be changed
// from the Multipad, the Receiver panel, a bookmark, the keyboard, a control
// surface or the URL, and App mounts this once whether any of those panels is on
// screen or not. A step restored only when the Receiver panel happened to be
// open would be worse than not restoring it at all.

import { useEffect } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import { defaultStepFor } from '../radio/constants.js';

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
        if (Number.isFinite(hz) && hz > 0) {
            set({ tuneStep: hz });
            return;
        }
        // Nothing on record for this mode — including a stored 0 or NaN, which
        // is no more tunable by than nothing at all. Its own default, or, for a
        // mode with no default either, the step in force.
        const def = defaultStepFor(mode);
        if (def) set({ tuneStep: def });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode]);

    return null;
}

// The timeshift buffer's two standing rules, held here rather than in its
// panel for the reason the recorder's format is: a collapsed panel is
// unmounted, and a replay must not outlive the only buttons that end it.
//
//   The buffer runs while the Timeshift panel is in the layout. Hidden, it is
//   a feature nobody can reach, and thirty seconds of copies is not free.
//
//   Tuning goes back to live, as changing channel does on a television — a
//   new frequency, mode or passband. The history is audio that has already
//   been demodulated, so none of the three can change what it sounds like;
//   carrying on replaying it under a dial that now says something else is two
//   answers to one question, and a filter that seems to do nothing.
//
// It draws nothing.

import { useEffect, useRef } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { useLayout } from '../layout/LayoutContext.jsx';
import { getTimeshift } from '../lib/timeshift.js';

export default function TimeshiftWatch() {
    const { tuning } = useRadio();
    const { sections } = useLayout();
    const ts = getTimeshift();

    const shown = !(sections && sections.timeshift && sections.timeshift.hidden);
    useEffect(() => { ts.setEnabled(shown); }, [ts, shown]);

    const tuned = useRef(null);
    const key = `${tuning.frequency}|${tuning.mode}|${tuning.bandwidthLow}|${tuning.bandwidthHigh}`;
    useEffect(() => {
        if (tuned.current !== null && tuned.current !== key) ts.goLive();
        tuned.current = key;
        // Stamped into the history, so a replay can say what it was tuned to.
        ts.noteTuning(tuning);
    }, [ts, key]);

    return null;
}

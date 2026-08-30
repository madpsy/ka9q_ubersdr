// Reading the Measure store from a component.
//
// Two hooks and not one, because the two halves of that store change at
// different rates and for different reasons — see lib/measureTool.js. The
// spectrum needs to know only whether the tool is running, several times a
// minute; the panel and the overlay need the reading, five times a second. A
// component that took both would be re-rendered by the second whether or not it
// used it.
//
// Kept here rather than in measureTool.js so that the store itself imports no
// React and can be tested as the plain object it is.

import { useEffect, useState } from '../react.js';
import { measureResult, measureState, onMeasureResult, onMeasureState } from './measureTool.js';

/**
 * Only whether the tool has the display's gestures.
 *
 * Separate from the state hook below, and the spectrum uses this one. A region
 * being dragged writes to the store on every pointer move, and the spectrum is
 * the largest tree in this interface — subscribing it to the whole state would
 * put a full reconciliation between the finger and the edge it is dragging. A
 * boolean that changes twice a session does not.
 */
export function useMeasureActive() {
    const [active, setActive] = useState(() => measureState().active);
    useEffect(() => {
        setActive(measureState().active);
        return onMeasureState((s) => setActive(s.active));
    }, []);
    return active;
}

/** The tool: running, where the region is, whether it is being dragged or held. */
export function useMeasureState() {
    const [state, setState] = useState(measureState);
    // Re-read on the way in as well as subscribing: something can have changed
    // between the first render and this effect, and the tool is switched on from
    // a panel that mounts at a different moment from the overlay.
    useEffect(() => {
        setState(measureState());
        return onMeasureState(setState);
    }, []);
    return state;
}

/** The latest reading, or null when there is not one. */
export function useMeasureResult() {
    const [result, setResult] = useState(measureResult);
    useEffect(() => {
        setResult(measureResult());
        return onMeasureResult(setResult);
    }, []);
    return result;
}

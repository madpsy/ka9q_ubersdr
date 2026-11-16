// The audio classifier's state, as React state: the tag and the Display panel
// both read it. The classifier is a module singleton outside React, so this
// subscribes to the object rather than to a context, as the control-surface
// tags do.

import { useEffect, useState } from '../../react.js';
import { getAudioClassifier } from './classifier.js';

export default function useAudioClass() {
    const [state, setState] = useState(() => getAudioClassifier().getState());
    useEffect(() => {
        const c = getAudioClassifier();
        // It may have moved on between the first render and this effect.
        setState(c.getState());
        return c.subscribe(setState);
    }, []);
    return state;
}

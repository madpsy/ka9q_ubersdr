// Type-a-frequency box.
//
// Wherever a frequency readout turns into an input — the Receiver panel's dial,
// the top bar's readout — it is this, so the two never drift apart on what they
// accept or when they commit. parseFreqInput does the reading, and it is
// generous: "7.1", "7100k", "7100000" and "7.100.000" all mean the same thing.
//
// Enter or moving focus away commits; Escape abandons. Mounted only while
// editing, so it opens focused with the current value selected — start typing
// and the old frequency is gone, which is what you want when retuning, while
// arrow keys still let you amend a digit.

import React, { useEffect, useRef, useState } from '../react.js';
import { parseFreqInput, clamp } from '../lib/format.js';
import { MAX_FREQ, MIN_FREQ } from '../radio/constants.js';

// `onDone` is called with the frequency in Hz, or null where nothing usable was
// typed — either way the caller closes the editor.
export default function FreqEntry({ frequency, className, onDone }) {
    const [draft, setDraft] = useState(() => String(Math.round(frequency)));
    const ref = useRef(null);
    const done = useRef(false);

    useEffect(() => {
        if (!ref.current) return;
        ref.current.focus();
        ref.current.select();
    }, []);

    // Enter commits and the input then loses focus on unmount, which would
    // otherwise commit a second time — harmless for a plain retune, not for the
    // callers that count on one call per edit.
    const commit = () => {
        if (done.current) return;
        done.current = true;
        const hz = parseFreqInput(draft);
        onDone(hz == null ? null : clamp(Math.round(hz), MIN_FREQ, MAX_FREQ));
    };

    return (
        <input
            ref={ref}
            className={className}
            value={draft}
            inputMode="decimal"
            aria-label="Frequency"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') { done.current = true; onDone(null); }
            }}
        />
    );
}

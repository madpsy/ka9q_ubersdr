// Type-a-frequency box.
//
// Wherever a frequency readout turns into an input — the Receiver panel's dial,
// the top bar's readout — it is this, so the two never drift apart on what they
// accept or when they commit.
//
// The unit is kHz: the box opens showing the current frequency in kHz, and a
// bare number typed into it is kHz. Explicit units still work ("7.1M",
// "7100000hz") — see parseFreqInput, which is where the reading happens.
//
// Out of range is refused rather than clamped. Clamping turns a slip into a
// silent retune to 30 MHz, which looks like the box working; refusing says the
// number was wrong while the number is still on screen to be corrected.
//
// Enter or moving focus away commits; Escape abandons. Mounted only while
// editing, so it opens focused with the current value selected — start typing
// and the old frequency is gone, which is what you want when retuning, while
// arrow keys still let you amend a digit.

import React, { useEffect, useRef, useState } from '../react.js';
import { freqInRange, freqToKHz, parseFreqInput } from '../lib/format.js';
import { MAX_FREQ, MIN_FREQ } from '../radio/constants.js';

const RANGE_HINT = `Frequency in kHz, ${MIN_FREQ / 1000} to ${MAX_FREQ / 1000}`;

// `onDone` is called with the frequency in Hz, or null where nothing usable was
// typed — either way the caller closes the editor.
// `fitKey` marks the box as one of the parts the top bar's readout scales — see
// lib/fitScale.js. It has to carry the same key the button it replaced does, or
// the measurement counts an 11ch input as fixed furniture *and* the frequency it
// stands in for, and the readout shrinks while somebody is typing into it.
export default function FreqEntry({ frequency, className, fitKey, onDone }) {
    const [draft, setDraft] = useState(() => freqToKHz(frequency));
    const ref = useRef(null);
    const done = useRef(false);

    useEffect(() => {
        if (!ref.current) return;
        ref.current.focus();
        ref.current.select();
    }, []);

    const hz = parseFreqInput(draft);
    const valid = freqInRange(hz);

    // Enter commits and the input then loses focus on unmount, which would
    // otherwise commit a second time — harmless for a plain retune, not for the
    // callers that count on one call per edit.
    const finish = (freq) => {
        if (done.current) return;
        done.current = true;
        onDone(freq);
    };

    return (
        <input
            ref={ref}
            className={`${className || ''}${valid ? '' : ' is-invalid'}`}
            data-fit={fitKey}
            value={draft}
            inputMode="decimal"
            aria-label="Frequency in kHz"
            aria-invalid={valid ? undefined : true}
            title={valid ? RANGE_HINT : `${RANGE_HINT} — ${draft.trim() ? 'out of range' : 'enter a frequency'}`}
            onChange={(e) => setDraft(e.target.value)}
            // Clicking away from a box that cannot be committed abandons the
            // edit: leaving it open would trap focus in a control the operator
            // has already moved on from.
            onBlur={() => finish(valid ? Math.round(hz) : null)}
            onKeyDown={(e) => {
                // Enter on something unusable does nothing at all — the box
                // stays open, red, with the text still there to fix.
                if (e.key === 'Enter' && valid) finish(Math.round(hz));
                if (e.key === 'Escape') finish(null);
            }}
        />
    );
}

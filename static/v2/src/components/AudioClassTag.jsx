// What the audio is, in the spectrum's tag row: the signal when the classifier
// is sure of it (FT8, CW, RTTY...), else its kind (FSK, PSK...), else VOICE,
// MUSIC or NOISE.
//
// The verdict is the audio classifier's (lib/audioClass/, verdict.js says how
// the answers combine); the tooltip carries the rest — how sure, what else it
// might be, what the model heard, what it cost. Nothing shows until there is a
// verdict, in a mode with nothing to classify, or if the classifier could not
// load (the Display panel says why: it is on by default, and a fault badge in
// front of every listener would be worse than no badge).
//
// Clickable, like MEDIA: it is a setting of this page, and the badge is where
// somebody who does not want it is looking when they notice it.

import React, { useEffect, useState } from '../react.js';
import { useDisplay } from '../display/DisplayContext.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import useAudioClass from '../lib/audioClass/useAudioClass.js';
import { badge } from '../lib/audioClass/verdict.js';

export default function AudioClassTag() {
    const display = useDisplay();
    const { tuning } = useRadio();
    const state = useAudioClass();
    // The tooltip is the browser's own (title), and a browser closes an open
    // one whenever the text changes -- which this one's does with every
    // verdict, every 2.5 s. So while the pointer is on the badge (or it has
    // focus) the text it had then is held, and the latest one shown again
    // once it leaves.
    const [held, setHeld] = useState(null);
    const b = display.audioClass === false ? null : badge(state, tuning && tuning.mode);
    // Gone while held (a retune, switched off): nothing to leave from, so let go.
    useEffect(() => {
        if (!b && held !== null) setHeld(null);
    }, [!b, held]);
    if (!b) return null;
    const hold = () => setHeld(b.title);
    const release = () => setHeld(null);
    return (
        <button
            type="button"
            className={`tag tag--button tag--${b.tone}`}
            title={held !== null ? held : b.title}
            onMouseEnter={hold}
            onMouseLeave={release}
            onFocus={hold}
            onBlur={release}
            onClick={() => display.set({ audioClass: false })}
        >
            {b.text}
        </button>
    );
}

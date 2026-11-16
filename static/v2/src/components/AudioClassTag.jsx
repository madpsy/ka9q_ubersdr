// What the audio is: VOICE, MUSIC or NOISE, in the spectrum's tag row.
//
// The verdict is the audio classifier's (lib/audioClass/), smoothed over its
// last three looks; the tooltip carries the rest — how sure, what the model
// heard, the recent looks, what it cost. Nothing shows until there is a
// verdict, in a mode with nothing to classify, or if the classifier could not
// load (the Display panel says why: it is on by default, and a fault badge in
// front of every listener would be worse than no badge).
//
// Clickable, like MEDIA: it is a setting of this page, and the badge is where
// somebody who does not want it is looking when they notice it.

import React from '../react.js';
import { useDisplay } from '../display/DisplayContext.jsx';
import useAudioClass from '../lib/audioClass/useAudioClass.js';
import { badge } from '../lib/audioClass/verdict.js';

export default function AudioClassTag() {
    const display = useDisplay();
    const state = useAudioClass();
    if (display.audioClass === false) return null;
    const b = badge(state);
    if (!b) return null;
    return (
        <button
            type="button"
            className={`tag tag--button tag--${b.tone}`}
            title={b.title}
            onClick={() => display.set({ audioClass: false })}
        >
            {b.text}
        </button>
    );
}

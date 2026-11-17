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

import React from '../react.js';
import { useDisplay } from '../display/DisplayContext.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import useAudioClass from '../lib/audioClass/useAudioClass.js';
import { badge } from '../lib/audioClass/verdict.js';

export default function AudioClassTag() {
    const display = useDisplay();
    const { tuning } = useRadio();
    const state = useAudioClass();
    if (display.audioClass === false) return null;
    const b = badge(state, tuning && tuning.mode);
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

// The audio classifier, driven from the radio's state.
//
// Here with the other watches rather than inside the tag that shows its
// verdict, for their reason: the tag is in the spectrum's row, which is not
// mounted everywhere the receiver plays (a phone's layout, a dock that has
// been rearranged), and a classifier that started and stopped with a badge
// would reload its model every time the row came back.
//
// It listens only while there is something to hear: audio playing, the page
// in view, a mode that carries demodulated audio (SSB, AM, FM, CW — not IQ or
// the data a decoder works on). Off in the Display panel, it unloads.
//
// It draws nothing.

import { useEffect } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import { usePageVisible } from '../lib/usePageVisible.js';
import { getAudioClassifier } from '../lib/audioClass/classifier.js';
import { classifiableMode } from '../lib/audioClass/verdict.js';

export default function AudioClassWatch() {
    const { running, tuning, player } = useRadio();
    const display = useDisplay();
    const visible = usePageVisible();
    const enabled = display.audioClass !== false;
    const mode = tuning.mode;
    const freq = tuning.frequency;
    const listening = !!running && visible && classifiableMode(mode);

    useEffect(() => {
        getAudioClassifier().configure({ enabled, listening, player, mode, freq });
    }, [enabled, listening, player, mode, freq]);

    return null;
}

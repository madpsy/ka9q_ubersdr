// The one place announcements are triggered from. Renders nothing.
//
// v1 called its TTS module from six places — the band buttons, the bookmark
// manager, the extensions, two paths in the spectrum, and the server echo in
// app.js — so every new way of tuning had to remember to announce, and two of
// them firing together is what `announceFrequencyAndMode` was written to paper
// over.
//
// There is one trigger here: `tuning`, the state every one of those paths ends
// up writing. Click-to-tune, the dial, a bookmark, a spot, a mapped MIDI
// encoder, a CAT-controlled rig, the server correcting us — all of it arrives
// as a change to the same object, and none of them knows this file exists.
//
// Mounted beside IdleWatch in App, not in the panel: the Announcements panel is
// unmounted whenever it is collapsed or dragged between docks, and a receiver
// that stops speaking because a panel was closed would be a puzzle.

import { useEffect, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import {
    announcement, announceSettings, onAnnounceSettings, refreshVoice, speak, stopSpeaking,
    FREQ_SETTLE_MS, MODE_SETTLE_MS, speechAvailable,
} from '../lib/announce.js';

export default function AnnounceWatch() {
    const { tuning, running } = useRadio();
    const [settings, setSettings] = useState(announceSettings);
    useEffect(() => onAnnounceSettings(setSettings), []);

    // What has been said, so a change is measured against the last thing
    // spoken rather than the last render.
    const said = useRef({ frequency: null, mode: null });
    const timer = useRef(null);

    // Chrome fills its voice list asynchronously and reports [] until it has.
    useEffect(() => {
        if (!speechAvailable()) return undefined;
        const on = () => refreshVoice();
        window.speechSynthesis.addEventListener('voiceschanged', on);
        return () => window.speechSynthesis.removeEventListener('voiceschanged', on);
    }, []);

    const { enabled, frequency: sayFreq, mode: sayMode, rate } = settings;

    useEffect(() => {
        clearTimeout(timer.current);

        // Nothing to say, and nothing to remember either: switching back on
        // should announce where the receiver is now, not narrate what was
        // missed while it was off.
        if (!enabled || !running) {
            said.current = { frequency: null, mode: null };
            return undefined;
        }

        const freqChanged = sayFreq && tuning.frequency !== said.current.frequency;
        const modeChanged = sayMode && tuning.mode !== said.current.mode;
        if (!freqChanged && !modeChanged) return undefined;

        // A frequency is still arriving while the dial turns, so it waits for
        // the turn to stop. A mode is a single choice, and waits only long
        // enough for a frequency set at the same moment — a bookmark, a spot —
        // to join it in one sentence.
        const wait = freqChanged ? FREQ_SETTLE_MS : MODE_SETTLE_MS;
        timer.current = setTimeout(() => {
            const text = announcement({
                frequency: freqChanged ? tuning.frequency : null,
                mode: modeChanged ? tuning.mode : null,
            });
            // Recorded whether or not it was spoken: a refused utterance is
            // still a reading the operator has had the chance to hear, and
            // repeating it on the next change would be worse.
            said.current = { frequency: tuning.frequency, mode: tuning.mode };
            speak(text, { rate });
        }, wait);

        return () => clearTimeout(timer.current);
    }, [enabled, running, sayFreq, sayMode, rate, tuning.frequency, tuning.mode]);

    // Switching off mid-sentence stops it there.
    useEffect(() => {
        if (!enabled) stopSpeaking();
    }, [enabled]);

    return null;
}

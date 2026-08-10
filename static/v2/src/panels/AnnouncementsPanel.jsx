// Spoken announcements — v1's TTS button, as a panel with the settings visible.
//
// The speaking itself is in lib/announce.js and the trigger is AnnounceWatch,
// which is mounted in App rather than here: this panel is unmounted whenever it
// is collapsed or dragged between docks, and announcements have to carry on
// through that.
//
// `minimal` keeps the switch and what is being announced, and drops the voice
// and rate — those are set once and then left alone.

import React, { useEffect, useState } from '../react.js';
import { Field, Slider, Switch } from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import {
    announceSettings, chromiumSpeech, currentVoice, listVoices, onAnnounceSettings,
    setAnnounceSettings, speak, speechAvailable,
} from '../lib/announce.js';

export default function AnnouncementsPanel({ minimal }) {
    const { tuning, running } = useRadio();
    const [s, setLocal] = useState(announceSettings);
    useEffect(() => onAnnounceSettings(setLocal), []);

    // The browser fills this in asynchronously and reports an empty list until
    // it has, so the dropdown is rebuilt when it arrives.
    const [voices, setVoices] = useState(listVoices);
    useEffect(() => {
        if (!speechAvailable()) return undefined;
        const on = () => setVoices(listVoices());
        window.speechSynthesis.addEventListener('voiceschanged', on);
        // Also once on mount: the event has usually already fired by now.
        on();
        return () => window.speechSynthesis.removeEventListener('voiceschanged', on);
    }, []);

    const supported = chromiumSpeech() && speechAvailable();
    const set = (patch) => setAnnounceSettings(patch);

    if (!supported) {
        return (
            <div className="stack">
                <div className="note note--warn">
                    Announcements need Chrome or Edge. They read the frequency and mode
                    aloud, and the voices other browsers ship make a poor job of spoken
                    numbers, so this is switched off rather than offered.
                </div>
            </div>
        );
    }

    const noVoices = voices.length === 0;
    const active = currentVoice();

    return (
        <div className="stack">
            <Field label="Announcements" inline>
                <Switch
                    checked={!!s.enabled}
                    disabled={noVoices}
                    onChange={(v) => set({ enabled: v })}
                    label={s.enabled ? 'On' : 'Off'}
                    title="Reads the frequency and mode aloud as they change"
                />
            </Field>

            {noVoices && (
                <div className="note note--warn">
                    No English voice is installed, so there is nothing to speak with.
                    On Linux the desktop client uses the system's voices — install
                    <code> speech-dispatcher</code> and <code>speech-dispatcher-espeak-ng</code>.
                </div>
            )}

            <Field label="Announce" hint={!s.frequency && !s.mode ? 'nothing selected' : undefined}>
                <div className="stack stack--tight">
                    <Switch
                        checked={!!s.frequency}
                        onChange={(v) => set({ frequency: v })}
                        label="Frequency"
                        title="Spoken a second after the dial stops, so turning it does not produce a stream of half-read numbers"
                    />
                    <Switch
                        checked={!!s.mode}
                        onChange={(v) => set({ mode: v })}
                        label="Mode"
                        title="Spoken as words — USB reads as “upper sideband”"
                    />
                </div>
            </Field>

            {s.enabled && !s.frequency && !s.mode && (
                <div className="note note--tight">
                    Nothing is selected, so nothing will be said. Turn one of the two on.
                </div>
            )}

            {!minimal && (
                <>
                    <div className="divider" />

                    <Field label="Voice" hint={s.voice ? undefined : 'automatic'}>
                        <select
                            className="select"
                            value={s.voice || ''}
                            onChange={(e) => set({ voice: e.target.value })}
                        >
                            {/* The automatic choice is the top of the same
                                preference order v1 used — Google UK English
                                Female, then Microsoft's online voices, which
                                are the neural ones, then British English among
                                whatever the system itself provides. */}
                            <option value="">
                                Automatic{active ? ` — ${active.name}` : ''}
                            </option>
                            {voices.map((v) => (
                                <option key={v.name} value={v.name}>{v.name}</option>
                            ))}
                        </select>
                    </Field>

                    <Field label="Speed" hint={`${s.rate.toFixed(1)}×`}>
                        <Slider
                            value={s.rate}
                            min={0.6}
                            max={1.8}
                            step={0.1}
                            onChange={(v) => set({ rate: v })}
                        />
                    </Field>

                    <div className="chip-row">
                        <button
                            type="button"
                            className="chip chip--button"
                            disabled={noVoices}
                            onClick={() => speak(
                                `${(tuning.frequency / 1e6).toFixed(3)} megahertz`,
                                { rate: s.rate },
                            )}
                        >
                            Test
                        </button>
                    </div>

                    <div className="note note--tight">
                        Announcements follow the receiver wherever the tuning comes from —
                        the dial, the spectrum, a bookmark, a spot, a mapped knob or a
                        synced rig. {running ? '' : 'Nothing is spoken until the receiver is started.'}
                    </div>
                </>
            )}
        </div>
    );
}

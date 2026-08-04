// FSK/RTTY decoder — v1's extension, rebuilt for v2.
//
// The decoding happens on the server: this attaches the `fsk` audio extension
// to the session's audio (see ../useAudioExtension.js) and reads the binary
// frames that come back (see ../teleprinter.js). There is no DSP here — the
// work is
// a console you can read while characters are still arriving, and enough of a
// tuning aid to get the two tones onto the two markers in the first place. The
// pieces NAVTEX draws the same way live in ../TeleprinterUI.jsx.
//
// Behaviour is v1's where v1 had a reason: the same presets and parameters, the
// same ±8 baud-error meter, the same three lamps off the decoder's state
// machine, click-to-tune on the spectrum, and copy/save/clear. Four things
// changed:
//
//   * Settings apply while running. Server-side they are fixed when the
//     extension is created, so v1 greyed them out once you pressed Start. The
//     hook re-attaches when `params` change by value, so changing the shift now
//     rebuilds the decoder in place — which is what you want when you are
//     hunting for the shift a signal is actually using. Number fields commit on
//     blur or Enter rather than per keystroke, so typing "45.45" restarts the
//     decoder once and not five times.
//   * Timestamps are a property of a line, not text baked into the buffer, so
//     the toggle applies to what is already on screen.
//   * The console fills the window instead of being sized in lines. A v1
//     extension lived in a fixed panel; this one is resizable, so a control for
//     how tall the text area is would be a second, worse way to do that.
//   * The spectrum can be switched off, and starts that way. v1 drew it always;
//     it is the thing you open when the copy is not coming out, and the rest of
//     the time it is 120 px of window and an FFT read per frame spent on
//     something nobody is looking at.

import React, { useEffect, useMemo, useState } from '../../react.js';
import { useRadio } from '../../radio/RadioContext.jsx';
import { Button, Icon, Switch } from '../../components/ui.jsx';
import { useAudioExtension } from '../useAudioExtension.js';
import { tunedOption } from '../frequencies.js';
import {
    AudioLevel, BaudMeter, Console, NumberField, SpectrumStrip,
} from '../TeleprinterUI.jsx';
import {
    ENCODINGS, FRAMINGS, LIMITS,
    appendText, attachParams, decodeFrame, markSpace, sidebandSign, stateFlags, toText,
} from '../teleprinter.js';
import { MAX_AUDIO_HZ } from '../toneSpectrum.js';
import { DEFAULT_PRESET, FSK_FREQUENCIES, PRESETS, presetConfig, presetOf } from './presets.js';

// The mode the decoder wants. FSK is demodulated as an audio pair, so the
// receiver has to be in a sideband mode for the tones to exist at all; the
// passband is the full span the spectrum draws, so click-to-tune can reach
// anything it shows.
const FSK_MODE = 'usb';
const FSK_BANDWIDTH = { low: 0, high: MAX_AUDIO_HZ };

// `minimal` keeps what you set the decoder up with and what it produces — the
// preset and its six parameters, the transport, and the console — and drops
// everything that is there to tell you how it is getting on: the spectrum, the
// view switches, the baud meter, the lamps and the audio level. See the
// registry's `minimal`.
//
// The transport bar stays. A view that cannot start the decoder is not a
// smaller version of this panel, it is a broken one.
export default function FSKExtension({ minimal }) {
    const { running, audioState, tuning, actions } = useRadio();
    // Attaching needs the audio session, not merely the power switch — see the
    // note on the same line in FT8Extension.jsx.
    const live = running && audioState === 'open';

    const [decoding, setDecoding] = useState(false);
    const [config, setConfig] = useState(() => presetConfig(DEFAULT_PRESET));
    const [lines, setLines] = useState([]);
    const [baudError, setBaudError] = useState(0);
    const [state, setState] = useState(0);
    // The spectrum starts off, as FT8's does: it is a tuning aid you reach for
    // when the copy is not coming out, not something you read while it is, and
    // it costs the window 120 px and an FFT read per frame until switched on.
    const [opts, setOpts] = useState({ timestamps: true, autoScroll: true, spectrum: false });
    const [copied, setCopied] = useState(false);

    const params = useMemo(() => attachParams(config), [config]);
    const tones = useMemo(() => markSpace(config), [config]);

    const onResult = (frame) => {
        if (frame.kind === 'text') setLines((prev) => appendText(prev, frame.text, frame.at));
        else if (frame.kind === 'baud') setBaudError(frame.error);
        else if (frame.kind === 'state') setState(frame.state);
    };

    const { state: attachState, error } = useAudioExtension({
        name: 'fsk',
        params,
        active: decoding && live,
        parse: decodeFrame,
        onResult,
    });

    // Powering the receiver off takes the audio session with it, so there is
    // nothing left to decode from. An audio *reconnect* is not that: the hook
    // re-attaches on its own and decoding stays on.
    useEffect(() => { if (!running && decoding) setDecoding(false); }, [running, decoding]);

    // The lamps are the server's, so they must not be left lit once it has
    // stopped sending — a stopped decoder showing "Decoding" is a lie.
    useEffect(() => { if (!decoding) { setState(0); setBaudError(0); } }, [decoding]);

    const set = (patch) => setOpts((prev) => ({ ...prev, ...patch }));
    const setCfg = (patch) => setConfig((prev) => ({ ...prev, ...patch }));

    const preset = presetOf(config);
    const lamps = stateFlags(state);
    const text = useMemo(() => toText(lines, opts.timestamps), [lines, opts.timestamps]);

    // The list entry the receiver is on. The menu holds signal frequencies and
    // the dial sits an audio centre below one, so the comparison has to add
    // that back — which also means the match follows the centre frequency: move
    // it and the decoder is listening somewhere else, so the menu says so.
    const tuned = tunedOption(FSK_FREQUENCIES, tuning.frequency + params.center_frequency);

    const tuneTo = (signalHz) => {
        // In USB the audio frequency is the offset above the dial, so putting
        // the signal at the configured centre means tuning that much below it.
        const dial = Math.round(signalHz - params.center_frequency);
        actions.tuneTo({
            frequency: dial,
            mode: FSK_MODE,
            bandwidthLow: FSK_BANDWIDTH.low,
            bandwidthHigh: FSK_BANDWIDTH.high,
        });
        actions.ensureVisible(dial);
    };

    // Click-to-tune: move the dial so the audio frequency clicked lands on the
    // centre frequency, which is where the decoder is listening.
    const tuneAudio = (audioHz) => {
        const offset = Math.round(audioHz - params.center_frequency);
        if (!offset) return;
        actions.nudge(sidebandSign(tuning.mode) * offset);
    };

    const clear = () => setLines([]);

    const copy = () => {
        if (!text || !navigator.clipboard) return;
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        }, () => { /* a refused clipboard is not worth an error state */ });
    };

    const save = () => {
        const blob = new Blob([`${text}\n`], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `fsk_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const statusLabel = !decoding
        ? 'Stopped'
        : (attachState === 'running' ? 'Running' : (attachState === 'error' ? 'Error' : 'Starting…'));
    const statusTone = !decoding
        ? 'off'
        : (attachState === 'running' ? 'on' : (attachState === 'error' ? 'bad' : 'wait'));

    return (
        <div className="tp fsk">
            <div className="tp__bar">
                <span
                    className={`tp__status tp__status--${statusTone}`}
                    title="Whether the decoder is attached to your audio session on the server"
                >
                    {statusLabel}
                </span>
                <span className="tp__bar-gap" />

                {/* Bound to where the receiver actually is, so this doubles as
                    a readout of which frequency you are on. Re-picking the
                    entry already shown is therefore a no-op, which is right:
                    it would tune to where the receiver already is. */}
                <select
                    className="select tp__freq"
                    value={tuned ? String(tuned.hz) : ''}
                    onChange={(e) => { if (e.target.value) tuneTo(Number(e.target.value)); }}
                    title={`Tune so the signal at this frequency lands on ${params.center_frequency} Hz of audio, in USB, and show which one the receiver is on`}
                >
                    <option value="">Tune to…</option>
                    {FSK_FREQUENCIES.map((g) => (
                        <optgroup key={g.group} label={g.group}>
                            {g.options.map((o) => <option key={o.hz} value={o.hz}>{o.label}</option>)}
                        </optgroup>
                    ))}
                </select>

                {decoding
                    ? (
                        <Button
                            size="sm"
                            onClick={() => setDecoding(false)}
                            icon={<Icon.Stop size={13} />}
                            title="Stop decoding and release the decoder on the server"
                        >
                            Stop
                        </Button>
                    )
                    : (
                        <Button
                            size="sm"
                            variant="primary"
                            onClick={() => setDecoding(true)}
                            disabled={!live}
                            icon={<Icon.Power size={13} />}
                            title={live
                                ? 'Start decoding the audio this receiver is tuned to'
                                : 'Start the receiver first — the decoder runs on your audio session'}
                        >
                            Start
                        </Button>
                    )}
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={copy}
                    disabled={!lines.length}
                    active={copied}
                    icon={<Icon.Copy size={13} />}
                    title="Copy everything decoded to the clipboard"
                />
                <Button size="sm" variant="ghost" onClick={save} disabled={!lines.length} icon={<Icon.Download size={13} />} title="Download everything decoded as a text file" />
                <Button size="sm" variant="ghost" onClick={clear} disabled={!lines.length} icon={<Icon.Trash size={13} />} title="Clear the console" />
            </div>

            {/* Settings stay editable while running: the hook re-attaches when
                they change, and hunting for the shift a signal is using is
                exactly the thing you do with the decoder already on. */}
            <div className="tp__config">
                <label className="tp__field" title="A named set of all six settings. Changing any of them by hand makes it Custom">
                    <span className="tp__field-label">Preset</span>
                    <select
                        className="select"
                        value={preset}
                        onChange={(e) => { if (e.target.value !== 'custom') setConfig(presetConfig(e.target.value)); }}
                    >
                        {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                        {/* Selectable but inert: it is what the menu reads once
                            you have edited a field, not something to choose. */}
                        <option value="custom">Custom</option>
                    </select>
                </label>

                <NumberField
                    label="Centre"
                    title="Audio frequency the pair of tones is centred on, in Hz. This is where the decoder listens, and what click-to-tune moves a signal onto"
                    value={config.center_frequency}
                    limits={LIMITS.center_frequency}
                    onCommit={(v) => setCfg({ center_frequency: v })}
                />
                <NumberField
                    label="Shift"
                    title="Spacing between the mark and space tones, in Hz. 170 for amateur RTTY, 450 for weather broadcasts"
                    value={config.shift}
                    limits={LIMITS.shift}
                    onCommit={(v) => setCfg({ shift: v })}
                />
                <NumberField
                    label="Baud"
                    title="Symbol rate. 45.45 for amateur RTTY, 50 for weather, 100 for SITOR-B and NAVTEX"
                    value={config.baud_rate}
                    limits={LIMITS.baud_rate}
                    onCommit={(v) => setCfg({ baud_rate: v })}
                />

                <label className="tp__field" title="Start, data and stop bits. 5N1.5 is the teleprinter standard; 4/7 is the seven-bit code SITOR-B and NAVTEX use">
                    <span className="tp__field-label">Framing</span>
                    <select className="select" value={config.framing} onChange={(e) => setCfg({ framing: e.target.value })}>
                        {FRAMINGS.map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                </label>

                <label className="tp__field" title="Character set. ITA2 is Baudot, CCIR476 is the error-detecting code SITOR-B and NAVTEX use">
                    <span className="tp__field-label">Encoding</span>
                    <select className="select" value={config.encoding} onChange={(e) => setCfg({ encoding: e.target.value })}>
                        {ENCODINGS.map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                </label>

                <Switch
                    label="Inverted"
                    title="Swap mark and space. Needed when the transmission is on the other sideband from the one you are receiving — weather RTTY usually is"
                    checked={!!config.inverted}
                    onChange={(v) => setCfg({ inverted: v })}
                />
            </div>

            {/* The hints go in the minimal view; the warnings stay. Being told
                what to do next is what you no longer need once you have cut
                the panel down, but a warning is news either way. */}
            {!minimal && !running && <div className="note note--tight">Start the receiver to decode.</div>}
            {!minimal && running && !live && <div className="note note--tight">Waiting for the audio connection…</div>}
            {!minimal && live && !decoding && <div className="note note--tight">Tune to a signal in USB, set the shift and baud rate, then press Start.</div>}
            {/* The decoder takes whatever audio the session produces, so a wrong
                mode does not fail — the two tones simply are not there. */}
            {decoding && tuning.mode !== 'usb' && tuning.mode !== 'lsb' && (
                <div className="note note--warn">
                    FSK needs a sideband mode; nothing will decode in {tuning.mode.toUpperCase()}.
                </div>
            )}
            {attachState === 'error' && <div className="note note--warn">{error}</div>}

            {!minimal && (
            <div className="tp__controls">
                <Switch
                    label="Timestamp"
                    title="Show the UTC time each line started. Applies to what is already on screen, and to what you copy or save"
                    checked={opts.timestamps}
                    onChange={(v) => set({ timestamps: v })}
                />
                <Switch
                    label="Auto-scroll"
                    title="Keep the newest line in view"
                    checked={opts.autoScroll}
                    onChange={(v) => set({ autoScroll: v })}
                />
                <Switch
                    label="Spectrum"
                    title="Show the 0–3 kHz audio spectrum with the mark and space tones marked on it"
                    checked={opts.spectrum}
                    onChange={(v) => set({ spectrum: v })}
                />
                <span className="tp__bar-gap" />
                <BaudMeter error={baudError} />
            </div>
            )}

            {/* Off in the minimal view whatever the switch says, and back as it
                was on the way out: the switch is not reachable from here, so
                writing to it would silently change a setting the user made. */}
            {opts.spectrum && running && !minimal && (
                <SpectrumStrip mark={tones.mark} space={tones.space} onTune={tuneAudio} />
            )}

            <Console lines={lines} timestamps={opts.timestamps} autoScroll={opts.autoScroll} />

            {/* The lamps are cumulative — decoding implies sync implies signal —
                so how far along they are lit says where the decoder gave up. */}
            {!minimal && (
            <div className="tp__foot">
                <span className={`tp__lamp${lamps.signal ? ' is-on' : ''}`} title="The demodulator is hearing something above its noise threshold">Signal</span>
                <span className={`tp__lamp${lamps.sync ? ' is-on' : ''}`} title="The bit clock has locked to the signal">Sync</span>
                <span className={`tp__lamp${lamps.decode ? ' is-on' : ''}`} title="Characters are being decoded">Decode</span>
                <span className="tp__bar-gap" />
                {running && <AudioLevel />}
            </div>
            )}
        </div>
    );
}

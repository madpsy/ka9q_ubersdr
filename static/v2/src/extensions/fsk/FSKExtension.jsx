// FSK/RTTY decoder — v1's extension, rebuilt for v2.
//
// The decoding happens on the server: this attaches the `fsk` audio extension
// to the session's audio (see ../useAudioExtension.js) and reads the binary
// frames that come back (see ./frames.js). There is no DSP here — the work is
// a console you can read while characters are still arriving, and enough of a
// tuning aid to get the two tones onto the two markers in the first place.
//
// Behaviour is v1's where v1 had a reason: the same presets and parameters, the
// same ±8 baud-error meter, the same three lamps off the decoder's state
// machine, click-to-tune on the spectrum, and copy/save/clear. Three things
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

import React, { memo, useEffect, useMemo, useRef, useState } from '../../react.js';
import { useRadio } from '../../radio/RadioContext.jsx';
import { Button, Empty, Icon, Switch } from '../../components/ui.jsx';
import { subscribeAudioSpectrum } from '../../lib/audioSpectrum.js';
import { useAudioExtension } from '../useAudioExtension.js';
import {
    BAUD_ERROR_MAX, DEFAULT_PRESET, ENCODINGS, FRAMINGS, LIMITS, PRESETS,
    appendText, attachParams, decodeFrame, formatTime, markSpace, presetConfig, presetOf,
    stateFlags, toText,
} from './frames.js';
import { MAX_AUDIO_HZ, drawSpectrum, waveLevelDb } from './spectrum.js';

// The mode the decoder wants. FSK is demodulated as an audio pair, so the
// receiver has to be in a sideband mode for the tones to exist at all; the
// passband is the full span the spectrum draws, so click-to-tune can reach
// anything it shows.
const FSK_MODE = 'usb';
const FSK_BANDWIDTH = { low: 0, high: MAX_AUDIO_HZ };

const SPECTRUM_H = 120;

// Frequencies worth a menu entry. These are the frequencies of the *signal*, so
// tuning one sets the dial low enough to put it at the configured audio centre
// — the same arithmetic click-to-tune does, done in advance.
const FSK_FREQUENCIES = [
    {
        group: 'Amateur RTTY',
        options: [
            { hz: 3590000, label: '3.590 MHz (80m)' },
            { hz: 7040000, label: '7.040 MHz (40m)' },
            { hz: 10140000, label: '10.140 MHz (30m)' },
            { hz: 14080000, label: '14.080 MHz (20m)' },
            { hz: 18100000, label: '18.100 MHz (17m)' },
            { hz: 21080000, label: '21.080 MHz (15m)' },
            { hz: 24920000, label: '24.920 MHz (12m)' },
            { hz: 28080000, label: '28.080 MHz (10m)' },
        ],
    },
    {
        // 50 baud, 450 Hz shift — the Weather RTTY preset.
        group: 'Weather RTTY — DWD Pinneberg',
        options: [
            { hz: 147300, label: '147.3 kHz' },
            { hz: 4583000, label: '4.583 MHz' },
            { hz: 7646000, label: '7.646 MHz' },
            { hz: 10100800, label: '10.1008 MHz' },
        ],
    },
];

// LSB and CW-L put the audio spectrum the other way up, so a tone higher in the
// passband is a *lower* radio frequency: click-to-tune has to move the dial the
// other way. v1 assumed USB and got this backwards on the lower sideband.
const sidebandSign = (mode) => (mode === 'lsb' || mode === 'cwl' ? -1 : 1);

/**
 * A number input that commits when you are finished with it.
 *
 * A controlled numeric field fires on every keystroke, and here every commit
 * re-attaches the decoder — so "45.45" would restart it at 4, 45, 45.4 and
 * 45.45 in turn, the first two of which the server refuses outright. Editing
 * happens against a draft string; blur and Enter commit, Escape abandons.
 */
function NumberField({ label, title, value, limits, disabled, onCommit }) {
    const [draft, setDraft] = useState(String(value));
    const [editing, setEditing] = useState(false);

    // Follow the value while the field is not being edited, so choosing a
    // preset updates it — but never overwrite what is being typed.
    useEffect(() => { if (!editing) setDraft(String(value)); }, [value, editing]);

    const commit = () => {
        setEditing(false);
        const n = parseFloat(draft);
        if (Number.isFinite(n)) onCommit(Math.min(limits.max, Math.max(limits.min, n)));
        else setDraft(String(value));
    };

    return (
        <label className="fsk__field" title={title}>
            <span className="fsk__field-label">{label}</span>
            <input
                className="input fsk__num"
                type="number"
                inputMode="decimal"
                min={limits.min}
                max={limits.max}
                step={limits.step}
                disabled={disabled}
                value={draft}
                onChange={(e) => { setEditing(true); setDraft(e.target.value); }}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.currentTarget.blur(); }
                    if (e.key === 'Escape') { setEditing(false); setDraft(String(value)); }
                }}
            />
        </label>
    );
}

/**
 * The baud-error meter: how far the decoder's bit clock is from the rate asked
 * for.
 *
 * It runs either side of centre because the sign says which way to correct —
 * a bar to the right means the signal is faster than the configured baud rate.
 * Near zero and the rate is right; pinned to one end and it is not.
 */
function BaudMeter({ error }) {
    const e = Number.isFinite(error) ? error : 0;
    const clamped = Math.max(-BAUD_ERROR_MAX, Math.min(BAUD_ERROR_MAX, e));
    const half = (Math.abs(clamped) / BAUD_ERROR_MAX) * 50;
    return (
        <div
            className="fsk__baud"
            title="Difference between the configured baud rate and the one the decoder is tracking. Centred means the rate is right"
        >
            <span className="fsk__baud-label">Baud err</span>
            <div className="fsk__baud-track">
                <span className="fsk__baud-zero" />
                <span
                    className={`fsk__baud-fill${clamped < 0 ? ' fsk__baud-fill--neg' : ''}`}
                    style={clamped < 0
                        ? { right: '50%', width: `${half}%` }
                        : { left: '50%', width: `${half}%` }}
                />
            </div>
            <span className="fsk__baud-value">{e.toFixed(1)}</span>
        </div>
    );
}

/**
 * The audio level, in its own component so its 10 Hz tick cannot re-render the
 * console.
 *
 * Same reasoning as FT8's cycle bar: this reads the analyser on every animation
 * frame, and nothing above it needs to know.
 */
function AudioLevel() {
    const { player } = useRadio();
    const [db, setDb] = useState(-Infinity);
    const last = useRef(0);

    useEffect(() => subscribeAudioSpectrum(player, { fftSize: 2048, bins: false, wave: true }, (f) => {
        const now = performance.now();
        if (now - last.current < 100) return;
        last.current = now;
        setDb(waveLevelDb(f.wave));
    }), [player]);

    const pct = Number.isFinite(db) ? Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) : 0;
    return (
        <div className="fsk__level" title="Level of the demodulated audio the decoder is being fed">
            <span className="fsk__level-label">Audio</span>
            <div className="fsk__level-track"><span className="fsk__level-fill" style={{ width: `${pct}%` }} /></div>
            <span className="fsk__level-value">{Number.isFinite(db) ? `${db.toFixed(0)} dB` : '−∞ dB'}</span>
        </div>
    );
}

// The 0-3 kHz audio spectrum with the two tones marked. Subscribes to the
// analyser directly and paints the canvas, so no frame of it reaches React.
function SpectrumStrip({ mark, space, onTune }) {
    const { player } = useRadio();
    const canvas = useRef(null);
    const tones = useRef({ mark, space });
    tones.current = { mark, space };

    useEffect(() => subscribeAudioSpectrum(player, { fftSize: 2048, bins: true }, (f) => {
        drawSpectrum(canvas.current, {
            bins: f.bins,
            binCount: f.binCount,
            sampleRate: f.sampleRate,
            mark: tones.current.mark,
            space: tones.current.space,
            cssHeight: SPECTRUM_H,
        });
    }), [player]);

    return (
        <div
            className="fsk__spectrum"
            style={{ height: SPECTRUM_H }}
            title="Audio spectrum, 0–3 kHz. Click a signal to move the dial so it lands on the centre frequency"
            onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                if (rect.width <= 0) return;
                onTune(((e.clientX - rect.left) / rect.width) * MAX_AUDIO_HZ);
            }}
        >
            <canvas ref={canvas} className="fsk__spectrum-canvas" />
        </div>
    );
}

/**
 * The decoded text.
 *
 * Memoised, and deliberately: the baud error arrives five times a second and
 * the state whenever it changes, both of which re-render the panel. Without
 * this the console's thousand lines would be reconciled every time one of them
 * moved a meter by a pixel.
 */
const Console = memo(function Console({ lines, timestamps, autoScroll }) {
    const box = useRef(null);

    // Newest is at the bottom here — a console reads downwards — so following
    // it means keeping the bottom in view.
    useEffect(() => {
        if (!autoScroll || !box.current) return;
        box.current.scrollTop = box.current.scrollHeight;
    }, [lines, autoScroll]);

    return (
        <div className="fsk__console" ref={box}>
            {lines.length === 0 && <Empty>Nothing decoded yet.</Empty>}
            {lines.map((l) => (
                <div key={l.id} className="fsk__line">
                    {timestamps && <span className="fsk__line-at">{formatTime(l.at)}</span>}
                    <span className="fsk__line-text">{l.text}</span>
                </div>
            ))}
        </div>
    );
});

export default function FSKExtension() {
    const { running, audioState, tuning, actions } = useRadio();
    // Attaching needs the audio session, not merely the power switch — see the
    // note on the same line in FT8Extension.jsx.
    const live = running && audioState === 'open';

    const [decoding, setDecoding] = useState(false);
    const [config, setConfig] = useState(() => presetConfig(DEFAULT_PRESET));
    const [lines, setLines] = useState([]);
    const [baudError, setBaudError] = useState(0);
    const [state, setState] = useState(0);
    const [opts, setOpts] = useState({ timestamps: true, autoScroll: true, spectrum: true });
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
        <div className="fsk">
            <div className="fsk__bar">
                <span
                    className={`fsk__status fsk__status--${statusTone}`}
                    title="Whether the decoder is attached to your audio session on the server"
                >
                    {statusLabel}
                </span>
                <span className="fsk__bar-gap" />

                <select
                    className="select fsk__freq"
                    value=""
                    onChange={(e) => { if (e.target.value) tuneTo(Number(e.target.value)); }}
                    title={`Tune so the signal at this frequency lands on ${params.center_frequency} Hz of audio, in USB`}
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
            <div className="fsk__config">
                <label className="fsk__field" title="A named set of all six settings. Changing any of them by hand makes it Custom">
                    <span className="fsk__field-label">Preset</span>
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

                <label className="fsk__field" title="Start, data and stop bits. 5N1.5 is the teleprinter standard; 4/7 is the seven-bit code SITOR-B and NAVTEX use">
                    <span className="fsk__field-label">Framing</span>
                    <select className="select" value={config.framing} onChange={(e) => setCfg({ framing: e.target.value })}>
                        {FRAMINGS.map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                </label>

                <label className="fsk__field" title="Character set. ITA2 is Baudot, CCIR476 is the error-detecting code SITOR-B and NAVTEX use">
                    <span className="fsk__field-label">Encoding</span>
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

            {!running && <div className="note note--tight">Start the receiver to decode.</div>}
            {running && !live && <div className="note note--tight">Waiting for the audio connection…</div>}
            {live && !decoding && <div className="note note--tight">Tune to a signal in USB, set the shift and baud rate, then press Start.</div>}
            {/* The decoder takes whatever audio the session produces, so a wrong
                mode does not fail — the two tones simply are not there. */}
            {decoding && tuning.mode !== 'usb' && tuning.mode !== 'lsb' && (
                <div className="note note--warn">
                    FSK needs a sideband mode; nothing will decode in {tuning.mode.toUpperCase()}.
                </div>
            )}
            {attachState === 'error' && <div className="note note--warn">{error}</div>}

            <div className="fsk__controls">
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
                <span className="fsk__bar-gap" />
                <BaudMeter error={baudError} />
            </div>

            {opts.spectrum && running && (
                <SpectrumStrip mark={tones.mark} space={tones.space} onTune={tuneAudio} />
            )}

            <Console lines={lines} timestamps={opts.timestamps} autoScroll={opts.autoScroll} />

            {/* The lamps are cumulative — decoding implies sync implies signal —
                so how far along they are lit says where the decoder gave up. */}
            <div className="fsk__foot">
                <span className={`fsk__lamp${lamps.signal ? ' is-on' : ''}`} title="The demodulator is hearing something above its noise threshold">Signal</span>
                <span className={`fsk__lamp${lamps.sync ? ' is-on' : ''}`} title="The bit clock has locked to the signal">Sync</span>
                <span className={`fsk__lamp${lamps.decode ? ' is-on' : ''}`} title="Characters are being decoded">Decode</span>
                <span className="fsk__bar-gap" />
                {running && <AudioLevel />}
            </div>
        </div>
    );
}

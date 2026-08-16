// CW decoder — v1's morse extension, rebuilt for v2.
//
// The decoding is the server's: this attaches the `morse` audio extension to
// the session's audio (see ../useAudioExtension.js) and reads the frames that
// come back (see ./frames.js). ggmorse finds the tone and the speed by itself,
// so unlike the teleprinter decoders there is almost nothing to set up — which
// is why this panel is mostly output.
//
// v1's behaviour where v1 had a reason: the same start/clear/copy transport, the
// same minimum-quality filter, the same colouring of the copy by confidence, and
// the same pitch/speed/quality readouts. What changed:
//
//   * The quality filter is a view, not a gate. See the note in ./frames.js.
//   * The pitch can be locked. The server has always taken a `pitch` parameter
//     and v1 never sent one, so ggmorse was always left hunting between 400 and
//     700 Hz — which is a fine default and hopeless if you are working a station
//     whose note sits outside it, or if there are two signals in the passband.
//   * Copy is kept as lines with a time on them rather than one string, so the
//     timestamps toggle applies to what is already on screen and to what you
//     save. A line ends at a gap in the sending, which is the only line ending
//     Morse has.
//   * A 0x12 error frame is shown. v1 handled it; nothing else in v2 needed to,
//     because no other decoder is a separate binary that may not be installed.
//   * The audio spectrum can be shown, with the pitch marked on it, and clicking
//     it moves the dial to bring a note onto that pitch.

import React, { memo, useEffect, useMemo, useRef, useState } from '../../react.js';
import { useRadio } from '../../radio/RadioContext.jsx';
import { Button, Empty, Icon, Switch } from '../../components/ui.jsx';
import { useAudioExtension } from '../useAudioExtension.js';
import { AudioLevel, NumberField, SpectrumStrip } from '../TeleprinterUI.jsx';
import { formatTime, sidebandSign } from '../teleprinter.js';
import {
    MIN_QUALITIES, appendDecode, decodeFrame, positive, toText, visibleChunks,
} from './frames.js';
import { saveFile } from '../../lib/saveFile.js';

// What the server will accept — audio_extensions/morse/extension.go refuses
// anything outside it, and a refused attach is an error the operator has to
// clear rather than a value they can nudge back.
const PITCH_LIMITS = { min: 100, max: 2000, step: 10 };

// Where click-to-tune puts a note when the pitch is not locked: the middle of
// the band ggmorse searches when it is left to itself.
const AUTO_TARGET_HZ = 550;

// Modes that produce a beat note for the decoder to hear. Everything else is
// not an error — the audio is taken as it comes — but nothing will be copied,
// and saying so beats leaving someone watching an empty console in AM.
const TONE_MODES = ['cwu', 'cwl', 'usb', 'lsb'];

// Memoised for the same reason the teleprinter console is: pitch and speed
// arrive several times a second while nothing is being copied, and each one
// re-renders the panel. Without this, every stats frame would reconcile a
// page of text to move a number by one hertz.
const MorseConsole = memo(function MorseConsole({ lines, timestamps, autoScroll, minQuality }) {
    const box = useRef(null);

    useEffect(() => {
        if (!autoScroll || !box.current) return;
        box.current.scrollTop = box.current.scrollHeight;
    }, [lines, autoScroll]);

    // Lines the filter has emptied are dropped rather than left as blanks: a
    // console of empty rows is a worse way of saying "nothing was that good".
    const shown = lines
        .map((l) => ({ line: l, chunks: visibleChunks(l, minQuality) }))
        .filter((l) => l.chunks.length);

    return (
        <div className="tp__console" ref={box}>
            {shown.length === 0 && (
                <Empty>
                    {lines.length ? 'Nothing decoded at this quality.' : 'Nothing decoded yet.'}
                </Empty>
            )}
            {shown.map(({ line, chunks }) => (
                <div key={line.id} className="tp__line">
                    {timestamps && <span className="tp__line-at">{formatTime(line.at)}</span>}
                    <span className="tp__line-text">
                        {chunks.map((c) => (
                            <span key={c.id} className={`mo__q mo__q--${c.conf}`}>{c.text}</span>
                        ))}
                    </span>
                </div>
            ))}
        </div>
    );
});

// `minimal` keeps the transport, the quality filter and the copy — what the
// decoder is for — and drops what tells you how it is getting on: the spectrum,
// the view switches, the readouts and the audio level. See the registry's
// `minimal`.
export default function MorseExtension({ minimal }) {
    const { running, audioState, tuning, actions } = useRadio();
    // Attaching needs the audio session, not merely the power switch — see the
    // note on the same line in FT8Extension.jsx.
    const live = running && audioState === 'open';

    const [decoding, setDecoding] = useState(false);
    const [lines, setLines] = useState([]);
    const [stats, setStats] = useState({ pitch: 0, speed: 0, conf: null, cost: null });
    // What the subprocess said when it failed. Kept apart from the hook's own
    // `error`, which is about the attach: the attach can succeed and the decoder
    // still be missing from the machine.
    const [fault, setFault] = useState(null);
    const [lockPitch, setLockPitch] = useState(false);
    const [pitch, setPitch] = useState(600);
    const [minQuality, setMinQuality] = useState('all');
    const [opts, setOpts] = useState({ timestamps: true, autoScroll: true, spectrum: false });
    const [copied, setCopied] = useState(false);

    // Omitted entirely when the pitch is not locked: the server reads a missing
    // `pitch` as "detect it", and sending 0 is not the same thing.
    const params = useMemo(() => (lockPitch ? { pitch } : {}), [lockPitch, pitch]);

    const onResult = (f) => {
        if (f.kind === 'decode') {
            setLines((prev) => appendDecode(prev, f));
            setStats({ pitch: f.pitch, speed: f.speed, conf: f.conf, cost: f.cost });
        } else if (f.kind === 'stats') {
            setStats((prev) => ({ ...prev, pitch: f.pitch, speed: f.speed }));
        } else if (f.kind === 'error') {
            // The subprocess is gone; the attach is still nominally up, so stop
            // rather than leave a panel that looks like it is decoding.
            setFault(f.message);
            setDecoding(false);
        }
    };

    const { state: attachState, error } = useAudioExtension({
        name: 'morse',
        params,
        active: decoding && live,
        parse: decodeFrame,
        onResult,
    });

    // Powering the receiver off takes the audio session with it. An audio
    // *reconnect* is not that: the hook re-attaches and decoding stays on.
    useEffect(() => { if (!running && decoding) setDecoding(false); }, [running, decoding]);

    // The readouts are the decoder's, so they must not be left showing the last
    // thing it heard once it has stopped.
    useEffect(() => {
        if (!decoding) setStats({ pitch: 0, speed: 0, conf: null, cost: null });
    }, [decoding]);

    const set = (patch) => setOpts((prev) => ({ ...prev, ...patch }));

    const text = useMemo(
        () => toText(lines, { timestamps: opts.timestamps, minQuality }),
        [lines, opts.timestamps, minQuality],
    );

    const start = () => { setFault(null); setDecoding(true); };

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
        saveFile(blob, `cw_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
    };

    // Click-to-tune: move the dial so the note clicked lands where the decoder
    // is listening. On the lower sideband the audio spectrum is the other way
    // up, which `sidebandSign` is for.
    const target = lockPitch ? pitch : AUTO_TARGET_HZ;
    const tuneAudio = (audioHz) => {
        const offset = Math.round(audioHz - target);
        if (!offset) return;
        actions.nudge(sidebandSign(tuning.mode) * offset);
    };

    const shownPitch = positive(stats.pitch);
    const shownSpeed = positive(stats.speed);

    const statusLabel = !decoding
        ? 'Stopped'
        : (attachState === 'running' ? 'Running' : (attachState === 'error' ? 'Error' : 'Starting…'));
    const statusTone = !decoding
        ? 'off'
        : (attachState === 'running' ? 'on' : (attachState === 'error' ? 'bad' : 'wait'));

    return (
        <div className="tp mo">
            <div className="tp__bar">
                <span
                    className={`tp__status tp__status--${statusTone}`}
                    title="Whether the decoder is attached to your audio session on the server"
                >
                    {statusLabel}
                </span>
                <span className="tp__bar-gap" />

                <label className="tp__field tp__field--inline" title="Hide copy the decoder is not confident about. Applies to what is already on screen, and to what you copy or save">
                    <span className="tp__field-label">Quality</span>
                    <select
                        className="select"
                        value={minQuality}
                        onChange={(e) => setMinQuality(e.target.value)}
                    >
                        {MIN_QUALITIES.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}
                    </select>
                </label>

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
                            onClick={start}
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
                    disabled={!text}
                    active={copied}
                    icon={<Icon.Copy size={13} />}
                    title="Copy the visible copy to the clipboard"
                />
                <Button size="sm" variant="ghost" onClick={save} disabled={!text} icon={<Icon.Download size={13} />} title="Download the visible copy as a text file" />
                <Button size="sm" variant="ghost" onClick={clear} disabled={!lines.length} icon={<Icon.Trash size={13} />} title="Clear the console" />
            </div>

            {/* Editable while running: the hook re-attaches when the parameters
                change by value, and finding the note a station is on is exactly
                the thing you do with the decoder already going. */}
            {!minimal && (
                <div className="tp__config">
                    <Switch
                        label="Lock pitch"
                        title="Tell the decoder which note to listen for instead of letting it hunt. ggmorse searches 400–700 Hz on its own, which is right for most CW and wrong for a station outside it or a passband with two signals in it"
                        checked={lockPitch}
                        onChange={setLockPitch}
                    />
                    <NumberField
                        label="Pitch"
                        title="The note to decode, in Hz of audio. Also where click-to-tune puts a signal"
                        value={pitch}
                        limits={PITCH_LIMITS}
                        disabled={!lockPitch}
                        onCommit={setPitch}
                    />
                </div>
            )}

            {!minimal && !running && <div className="note note--tight">Start the receiver to decode.</div>}
            {!minimal && running && !live && <div className="note note--tight">Waiting for the audio connection…</div>}
            {!minimal && live && !decoding && !fault && (
                <div className="note note--tight">
                    Tune a CW signal — CW-U or CW-L with a narrow filter is the easiest to copy — then press Start.
                </div>
            )}
            {/* v1 put `requiresMode: 'usb'` in its manifest, and the decoder
                framework switched the receiver into USB the moment the panel
                was opened — from CW-U too, where the copy is better. Here it is
                offered rather than done: an extension window is opened and
                closed freely in v2, and one that retunes the receiver behind
                you is a window you learn not to open. */}
            {!TONE_MODES.includes(tuning.mode) && (
                <div className="note note--warn mo__fix">
                    <span>
                        Nothing will be copied in {String(tuning.mode).toUpperCase()} — the decoder
                        needs a beat note, so use CW or a sideband mode.
                    </span>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => actions.tuneTo({ mode: 'usb' })}
                        title="Switch this receiver to USB with its standard passband, which is what v1's CW decoder did on opening"
                    >
                        Use USB
                    </Button>
                </div>
            )}
            {/* The decoder is a separate binary the receiver's operator has to
                install, so this is the one failure worth spelling out in full
                rather than reducing to "error". */}
            {fault && <div className="note note--warn">{fault}</div>}
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
                        title="Show the 0–3 kHz audio spectrum, with the note being decoded marked on it"
                        checked={opts.spectrum}
                        onChange={(v) => set({ spectrum: v })}
                    />
                </div>
            )}

            {/* Two markers, and they mean different things: the target is where
                the decoder is listening, the tone is what it says it has found.
                Getting them on top of each other is the whole job. */}
            {opts.spectrum && running && !minimal && (
                <SpectrumStrip
                    mark={shownPitch}
                    markLabel="Tone"
                    space={lockPitch ? pitch : null}
                    spaceLabel="Target"
                    onTune={tuneAudio}
                    title={`Audio spectrum, 0–3 kHz. Click a note to move the dial so it lands on ${target} Hz, where the decoder is listening`}
                />
            )}

            <MorseConsole
                lines={lines}
                timestamps={opts.timestamps}
                autoScroll={opts.autoScroll}
                minQuality={minQuality}
            />

            {!minimal && (
                <div className="tp__foot">
                    <span className="mo__stat" title="The tone the decoder is copying, in Hz of audio">
                        <span className="mo__stat-label">Pitch</span>
                        <span className="mo__stat-value">{shownPitch ? `${Math.round(shownPitch)} Hz` : '—'}</span>
                    </span>
                    <span className="mo__stat" title="Sending speed, in words per minute">
                        <span className="mo__stat-label">Speed</span>
                        <span className="mo__stat-value">{shownSpeed ? `${shownSpeed.toFixed(1)} WPM` : '—'}</span>
                    </span>
                    <span
                        className="mo__stat"
                        title={stats.cost != null
                            ? `How much of the last decode ggmorse had to guess (cost ${stats.cost.toFixed(2)} — lower is better)`
                            : 'How much of the last decode ggmorse had to guess'}
                    >
                        <span className="mo__stat-label">Quality</span>
                        <span className={`mo__stat-value mo__q--${stats.conf || 'none'}`}>
                            {stats.conf ? stats.conf.charAt(0).toUpperCase() + stats.conf.slice(1) : '—'}
                        </span>
                    </span>
                    <span className="tp__bar-gap" />
                    {running && <AudioLevel />}
                </div>
            )}
        </div>
    );
}

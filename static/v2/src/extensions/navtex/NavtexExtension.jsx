// NAVTEX decoder — v1's extension, rebuilt for v2.
//
// The decoding happens on the server: this attaches the `navtex` audio
// extension to the session's audio and reads the same binary frames FSK sends,
// because underneath it is the same decoder (see ../teleprinter.js). Everything
// v1 had is here — the station quick-tune, the three adjustable numbers, the
// baud-error meter, save and clear — with two additions:
//
//   * The output is messages, not a character stream. NAVTEX sends numbered
//     messages with a header saying which station, what subject and what serial
//     number; a receiver is meant to read that header and decide whether to
//     print at all. Showing it as a wall of text with "ZCZC IA47" buried in it
//     throws away the one thing the format gives you. The raw console is still
//     a click away, and is where anything the parser could not frame ends up.
//   * The tone spectrum, which v1's NAVTEX had no equivalent of. 518 kHz has to
//     be tuned within a few tens of hertz for the tones to land on the filters,
//     and doing that by ear is guesswork.
//
// Everything else follows the FSK panel, deliberately: same layout, same
// controls in the same places, same shared components. They are two views of
// one decoder and should not need learning twice.

import React, { useEffect, useMemo, useState } from '../../react.js';
import { useRadio } from '../../radio/RadioContext.jsx';
import { Button, Empty, Icon, Switch } from '../../components/ui.jsx';
import { useAudioExtension } from '../useAudioExtension.js';
import { tunedOption } from '../frequencies.js';
import { AudioLevel, BaudMeter, Console, NumberField, SpectrumStrip } from '../TeleprinterUI.jsx';
import {
    LIMITS, appendText, attachParams, decodeFrame, formatTime, markSpace, sidebandSign, toText,
} from '../teleprinter.js';
import { MAX_AUDIO_HZ } from '../toneSpectrum.js';
import { NAVTEX_CONFIG, NAVTEX_FREQUENCIES, parseMessages } from './messages.js';
import { subjectOf } from '../../lib/navtexCodes.js';
import { saveFile } from '../../lib/saveFile.js';

// NAVTEX is received in USB, and the passband is the span the spectrum draws so
// click-to-tune can reach anything it shows.
const NAVTEX_MODE = 'usb';
const NAVTEX_BANDWIDTH = { low: 0, high: MAX_AUDIO_HZ };

// What the decoder falls back to if a setting is unreadable. Not FSK's: a
// NAVTEX attach that quietly fell back to Baudot at 45 baud would decode
// nothing and give no clue why.
const DEFAULTS = NAVTEX_CONFIG;

/**
 * One decoded message.
 *
 * The header is spelled out rather than shown as the four characters it
 * arrived as: "IA47" is only meaningful if you already know the scheme, and if
 * you already know it you can still see the letters.
 */
function Message({ message, timestamps }) {
    const subject = subjectOf(message.subject);
    return (
        <article className={`ntx__msg${message.complete ? '' : ' ntx__msg--part'}`}>
            <header className="ntx__msg-head">
                <span
                    className="ntx__msg-id"
                    title="Station letter, subject letter and serial number, as sent"
                >
                    {message.station}{message.subject}{message.serial}
                </span>
                <span className={`ntx__msg-subject${subject && subject.vital ? ' is-vital' : ''}`}>
                    {subject
                        ? subject.label
                        /* M to U are reserved and undefined; naming one would
                           be inventing a meaning. */
                        : `Subject ${message.subject}`}
                </span>
                <span className="ntx__bar-gap" />
                {/* 00 is the serial that means "important": it is never
                    repeated and a receiver may not reject it. */}
                {message.serial === '00' && (
                    <span className="ntx__msg-flag" title="Serial 00 — sent once and never repeated">Important</span>
                )}
                {!message.complete && (
                    <span className="ntx__msg-flag ntx__msg-flag--part" title="No NNNN end-of-message was decoded; this may be cut short">
                        Unterminated
                    </span>
                )}
                {timestamps && <span className="ntx__msg-at">{formatTime(message.at)}</span>}
            </header>
            <pre className="ntx__msg-body">{message.body}</pre>
        </article>
    );
}

// `minimal` keeps the three decoder settings, the transport and the decoded
// messages, and drops the spectrum, the view switches, the baud meter and the
// audio level. See the registry's `minimal`.
export default function NavtexExtension({ minimal }) {
    const { running, audioState, tuning, actions } = useRadio();
    // Attaching needs the audio session, not merely the power switch — see the
    // note on the same line in FT8Extension.jsx.
    const live = running && audioState === 'open';

    const [decoding, setDecoding] = useState(false);
    const [config, setConfig] = useState(NAVTEX_CONFIG);
    const [lines, setLines] = useState([]);
    const [baudError, setBaudError] = useState(0);
    const [opts, setOpts] = useState({
        timestamps: true, autoScroll: true, spectrum: false, raw: false,
    });
    const [copied, setCopied] = useState(false);

    const params = useMemo(() => attachParams(config, DEFAULTS), [config]);
    const tones = useMemo(() => markSpace(config, DEFAULTS), [config]);
    const messages = useMemo(() => parseMessages(lines), [lines]);

    const onResult = (frame) => {
        if (frame.kind === 'text') setLines((prev) => appendText(prev, frame.text, frame.at));
        else if (frame.kind === 'baud') setBaudError(frame.error);
    };

    const { state: attachState, error } = useAudioExtension({
        name: 'navtex',
        params,
        active: decoding && live,
        parse: decodeFrame,
        onResult,
    });

    useEffect(() => { if (!running && decoding) setDecoding(false); }, [running, decoding]);
    useEffect(() => { if (!decoding) setBaudError(0); }, [decoding]);

    const set = (patch) => setOpts((prev) => ({ ...prev, ...patch }));
    const setCfg = (patch) => setConfig((prev) => ({ ...prev, ...patch }));

    // The menu holds assigned frequencies and the dial sits an audio centre
    // below one, so the comparison has to add that back.
    const tuned = tunedOption(NAVTEX_FREQUENCIES, tuning.frequency + params.center_frequency);

    const text = useMemo(() => toText(lines, opts.timestamps), [lines, opts.timestamps]);

    const tuneTo = (assignedHz) => {
        // In USB the audio frequency is the offset above the dial, so putting
        // the transmission at the configured centre means tuning that far below
        // its assigned frequency. This is v1's tuneToStation arithmetic.
        const dial = Math.round(assignedHz - params.center_frequency);
        actions.tuneTo({
            frequency: dial,
            mode: NAVTEX_MODE,
            bandwidthLow: NAVTEX_BANDWIDTH.low,
            bandwidthHigh: NAVTEX_BANDWIDTH.high,
        });
        actions.ensureVisible(dial);
    };

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
        saveFile(blob, `navtex_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
    };

    const statusLabel = !decoding
        ? 'Stopped'
        : (attachState === 'running' ? 'Running' : (attachState === 'error' ? 'Error' : 'Starting…'));
    const statusTone = !decoding
        ? 'off'
        : (attachState === 'running' ? 'on' : (attachState === 'error' ? 'bad' : 'wait'));

    return (
        <div className="tp ntx">
            <div className="tp__bar">
                <span
                    className={`tp__status tp__status--${statusTone}`}
                    title="Whether the decoder is attached to your audio session on the server"
                >
                    {statusLabel}
                </span>
                <span className="tp__bar-gap" />

                <select
                    className="select tp__freq ntx__freq"
                    value={tuned ? String(tuned.hz) : ''}
                    onChange={(e) => { if (e.target.value) tuneTo(Number(e.target.value)); }}
                    title={`Tune so the transmission lands on ${params.center_frequency} Hz of audio, in USB, and show which station frequency the receiver is on`}
                >
                    <option value="">Tune to…</option>
                    {NAVTEX_FREQUENCIES.map((g) => (
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
                <Button size="sm" variant="ghost" onClick={copy} disabled={!lines.length} active={copied} icon={<Icon.Copy size={13} />} title="Copy everything decoded to the clipboard" />
                <Button size="sm" variant="ghost" onClick={save} disabled={!lines.length} icon={<Icon.Download size={13} />} title="Download everything decoded as a text file" />
                <Button size="sm" variant="ghost" onClick={clear} disabled={!lines.length} icon={<Icon.Trash size={13} />} title="Clear everything decoded" />
            </div>

            {/* Three numbers and a polarity switch. Framing and encoding are
                absent rather than fixed-and-greyed: NAVTEX is SITOR-B by
                definition, so they were never choices — v1's encoding menu had
                one entry in it, which is a menu pretending to be a control. */}
            <div className="tp__config">
                <NumberField
                    label="Centre"
                    title="Audio frequency the pair of tones is centred on, in Hz. 500 is standard for NAVTEX; adjust if the signal is off frequency"
                    value={config.center_frequency}
                    limits={LIMITS.center_frequency}
                    onCommit={(v) => setCfg({ center_frequency: v })}
                />
                <NumberField
                    label="Shift"
                    title="Spacing between the mark and space tones, in Hz. 170 for NAVTEX and DSC"
                    value={config.shift}
                    limits={LIMITS.shift}
                    onCommit={(v) => setCfg({ shift: v })}
                />
                <NumberField
                    label="Baud"
                    title="Symbol rate. 100 for NAVTEX and DSC"
                    value={config.baud_rate}
                    limits={LIMITS.baud_rate}
                    onCommit={(v) => setCfg({ baud_rate: v })}
                />
                <Switch
                    label="Inverted"
                    title="Swap mark and space. Needed if the transmission is on the other sideband from the one you are receiving"
                    checked={!!config.inverted}
                    onChange={(v) => setCfg({ inverted: v })}
                />
                <span className="tp__bar-gap" />
                <span className="ntx__count" title="Complete NAVTEX messages framed so far">
                    {messages.length} {messages.length === 1 ? 'message' : 'messages'}
                </span>
            </div>

            {!minimal && !running && <div className="note note--tight">Start the receiver to decode.</div>}
            {!minimal && running && !live && <div className="note note--tight">Waiting for the audio connection…</div>}
            {!minimal && live && !decoding && <div className="note note--tight">Tune to a NAVTEX frequency in USB, then press Start.</div>}
            {/* The decoder takes whatever audio the session produces, so a wrong
                mode does not fail — the two tones simply are not there. */}
            {decoding && tuning.mode !== 'usb' && tuning.mode !== 'lsb' && (
                <div className="note note--warn">
                    NAVTEX needs a sideband mode; nothing will decode in {tuning.mode.toUpperCase()}.
                </div>
            )}
            {attachState === 'error' && <div className="note note--warn">{error}</div>}

            {!minimal && (
            <div className="tp__controls">
                <Switch
                    label="Raw"
                    title="Show every decoded character instead of the framed messages. This is where phasing, DSC bursts and anything the header could not be read from ends up"
                    checked={opts.raw}
                    onChange={(v) => set({ raw: v })}
                />
                <Switch
                    label="Timestamp"
                    title="Show the UTC time each message or line started"
                    checked={opts.timestamps}
                    onChange={(v) => set({ timestamps: v })}
                />
                <Switch
                    label="Auto-scroll"
                    title="Keep the newest message in view"
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
                was on the way out. */}
            {opts.spectrum && running && !minimal && (
                <SpectrumStrip mark={tones.mark} space={tones.space} onTune={tuneAudio} />
            )}

            {opts.raw
                ? (
                    <Console
                        lines={lines}
                        timestamps={opts.timestamps}
                        autoScroll={opts.autoScroll}
                        empty="Nothing decoded yet."
                    />
                )
                : <MessageList messages={messages} lines={lines} timestamps={opts.timestamps} autoScroll={opts.autoScroll} />}

            {!minimal && (
            <div className="tp__foot">
                <span className="tp__bar-gap" />
                {running && <AudioLevel />}
            </div>
            )}
        </div>
    );
}

/**
 * The framed messages, newest at the bottom.
 *
 * Separated from the panel so the empty state can say which of the two things
 * is true: nothing has been decoded at all, or characters are arriving but none
 * of them has carried a header the error correction could recover. Those look
 * identical and mean very different things — the second is a signal you are
 * receiving badly, not a decoder that is not running.
 */
function MessageList({ messages, lines, timestamps, autoScroll }) {
    const box = React.useRef(null);

    React.useEffect(() => {
        if (!autoScroll || !box.current) return;
        box.current.scrollTop = box.current.scrollHeight;
    }, [messages, autoScroll]);

    return (
        <div className="tp__console ntx__msgs" ref={box}>
            {messages.length === 0 && (
                <Empty>
                    {lines.length === 0
                        ? 'No messages yet.'
                        : 'Characters are arriving but no message header has decoded — switch on Raw to see them.'}
                </Empty>
            )}
            {messages.map((m) => <Message key={m.id} message={m} timestamps={timestamps} />)}
        </div>
    );
}

// Olivia decoder.
//
// The decoding happens on the server: this attaches the `olivia` audio
// extension to the session's audio (see ../useAudioExtension.js) and reads the
// JSON frames that come back (see ../../../../audio_extensions/olivia). There
// is no DSP here.
//
// It is laid out like the teleprinter decoders — transport bar, settings, a
// console you can read while characters are still arriving — and reuses their
// pieces from ../TeleprinterUI.jsx, because the output is the same shape: one
// column of text arriving a few characters at a time.
//
// Two things are particular to Olivia and drive the rest of this file:
//
//   * It is slow, and it is silent while it works. A block is one to four
//     seconds long and carries three to six characters, and the synchroniser
//     reads a block out only after integrating four of them — so nothing at all
//     appears for the first several seconds after Start, even on a strong
//     signal. That is not a fault, and a panel that shows an empty console and
//     no explanation makes it look like one. Hence the lock readouts, and the
//     hint under the console that says what it is waiting for.
//   * The squelch is live and everything else is not. Every other setting —
//     tones, bandwidth, centre, tune margin, integration depth, reverse, 8-bit
//     — resizes the receiver's arrays server-side, so changing one re-attaches,
//     which costs the lock. The squelch does not, so it travels by control
//     message and can be dragged while reading. That asymmetry is the reason
//     `params` deliberately does not track the squelch.
//
// The settings are fldigi's, and named the way fldigi names them, because
// someone reading an Olivia signal is usually looking at fldigi at the other
// end: the same eighteen modes in the same order, the same tune margin,
// integration period and 8-bit escape, with the same defaults.

import React, { useEffect, useMemo, useRef, useState } from '../../react.js';
import { useRadio } from '../../radio/RadioContext.jsx';
import { Button, Icon, Readout, Slider, Switch } from '../../components/ui.jsx';
import { dxcluster } from '../../radio/dxcluster-connection.js';
import { useAudioExtension } from '../useAudioExtension.js';
import { controlMessage } from '../protocol.js';
import { tunedOption } from '../frequencies.js';
import { AudioLevel, Console, NumberField } from '../TeleprinterUI.jsx';
import { appendText, toText } from '../teleprinter.js';
import { saveFile } from '../../lib/saveFile.js';
import {
    DEFAULT_MODE, DEFAULT_SYNC_INTEG, DEFAULT_SYNC_MARGIN, LIMITS, MODES, MODE_ID,
    OLIVIA_FREQUENCIES, SQUELCH, attachParams, modeLabel, modeRates,
} from './modes.js';

// Olivia is worked in USB. The passband is opened to the full audio span so the
// centre control can reach anywhere the decoder might listen.
const OLIVIA_MODE = 'usb';
const OLIVIA_BANDWIDTH = { low: 0, high: 3000 };

// `minimal` keeps the three settings you actually work — mode, centre, squelch —
// plus the transport and the console, and drops the rest: the readouts that say
// how it is getting on, the view switches, and the four settings you set once
// and leave. That is NAVTEX's split, which keeps its decoder settings, the
// transport and the decoded output and nothing else.
//
// The squelch stays because on Olivia it is not a diagnostic: it is the one
// control between a console that says nothing and one that fills with rubbish,
// and it is the only one that can be moved without losing the lock. See the
// registry's `minimal`.
export default function OliviaExtension({ minimal }) {
    const { running, audioState, tuning, actions } = useRadio();
    // Attaching needs the audio session, not merely the power switch.
    const live = running && audioState === 'open';

    const [decoding, setDecoding] = useState(false);
    const [config, setConfig] = useState(() => ({
        ...DEFAULT_MODE,
        center_frequency: 1000,
        sync_margin: DEFAULT_SYNC_MARGIN,
        sync_integ_len: DEFAULT_SYNC_INTEG,
        reverse: false,
        // On, as fldigi ships it. A sender that does not use the escape never
        // emits 127, so honouring it costs nothing.
        eight_bit: true,
    }));
    const [squelch, setSquelch] = useState(SQUELCH.default);
    const [lines, setLines] = useState([]);
    const [status, setStatus] = useState(null);
    const [srvConfig, setSrvConfig] = useState(null);
    const [opts, setOpts] = useState({ timestamps: true, autoScroll: true });
    const [copied, setCopied] = useState(false);

    // The squelch reaches the server two ways: baked into the attach params for
    // whatever value it holds at the moment something else re-attaches, and by
    // control message every time it moves. Reading it through a ref is what
    // keeps it out of the params identity — see the note at the top.
    const squelchRef = useRef(squelch);
    squelchRef.current = squelch;

    const params = useMemo(
        () => attachParams(config, squelchRef.current),
        [
            config.tones, config.bandwidth, config.center_frequency,
            config.sync_margin, config.sync_integ_len, config.reverse, config.eight_bit,
        ],
    );

    const onResult = (frame) => {
        if (frame.type === 'text') setLines((prev) => appendText(prev, frame.text, frame.ts));
        else if (frame.type === 'status') setStatus(frame);
        else if (frame.type === 'config') setSrvConfig(frame);
    };

    const { state: attachState, error } = useAudioExtension({
        name: 'olivia',
        params,
        active: decoding && live,
        onResult,
    });

    // Powering the receiver off takes the audio session with it. An audio
    // reconnect is not that — the hook re-attaches on its own.
    useEffect(() => { if (!running && decoding) setDecoding(false); }, [running, decoding]);

    // The readouts are the server's, so they must not be left showing a lock
    // once it has stopped sending: a stopped decoder reporting "Locked" is a lie.
    useEffect(() => {
        if (!decoding) { setStatus(null); setSrvConfig(null); }
    }, [decoding]);

    const setCfg = (patch) => setConfig((prev) => ({ ...prev, ...patch }));
    const set = (patch) => setOpts((prev) => ({ ...prev, ...patch }));

    // Live: sent straight to the running decoder rather than through the params,
    // so the lock survives. The server clamps and acknowledges with what it
    // actually applied; the slider's own bounds match, so the two agree.
    const commitSquelch = (v) => {
        setSquelch(v);
        if (attachState === 'running') {
            dxcluster.send(controlMessage('set_squelch', { sync_threshold: v }));
        }
    };

    const tuneTo = (dialHz) => {
        // Unlike the FSK panel, the menu holds dial frequencies rather than
        // signal frequencies — that is how Olivia is spotted — so this tunes
        // straight there and lets the centre control place the decoder within
        // the audio. See the note in modes.js.
        actions.tuneTo({
            frequency: dialHz,
            mode: OLIVIA_MODE,
            bandwidthLow: OLIVIA_BANDWIDTH.low,
            bandwidthHigh: OLIVIA_BANDWIDTH.high,
        });
        actions.ensureVisible(dialHz);
    };

    const text = useMemo(() => toText(lines, opts.timestamps), [lines, opts.timestamps]);
    const tuned = tunedOption(OLIVIA_FREQUENCIES, tuning.frequency);
    const rates = useMemo(() => modeRates(config), [config.tones, config.bandwidth]);

    const copy = () => {
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
        }).catch(() => {});
    };
    const save = () => saveFile(text, `olivia-${new Date().toISOString().slice(0, 19)}.txt`, 'text/plain');
    const clear = () => setLines([]);

    const statusLabel = !decoding ? 'Off'
        : (attachState === 'running' ? 'On' : (attachState === 'error' ? 'Error' : 'Attaching'));
    const statusTone = !decoding ? 'off'
        : (attachState === 'running' ? 'on' : (attachState === 'error' ? 'bad' : 'wait'));

    // How long before anything can appear: the synchroniser reads a block out
    // only once it has integrated four of them.
    const acquireSeconds = Math.round(rates.blockPeriod * 4);

    return (
        <div className="tp olivia">
            <div className="tp__bar">
                <span
                    className={`tp__status tp__status--${statusTone}`}
                    title="Whether the decoder is attached to your audio session on the server"
                >
                    {statusLabel}
                </span>
                <span className="tp__bar-gap" />

                <select
                    className="select tp__freq"
                    value={tuned ? String(tuned.hz) : ''}
                    onChange={(e) => { if (e.target.value) tuneTo(Number(e.target.value)); }}
                    title="Tune the dial to an Olivia frequency in USB, and show which one the receiver is on"
                >
                    <option value="">Tune to…</option>
                    {OLIVIA_FREQUENCIES.map((g) => (
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

            {/* Settings stay editable while running. Changing one re-attaches
                and costs the lock, which is why the squelch — the one the
                server can change in place — is not among them. */}
            <div className="tp__config">
                <label className="tp__field tp__field--wide" title="Number of tones and how wide they are spread. Wider carries more characters a second; more tones is more robust. The three marked ★ are what an unqualified &quot;Olivia&quot; usually means">
                    <span className="tp__field-label">Mode</span>
                    <select
                        className="select"
                        value={MODE_ID(config.tones, config.bandwidth)}
                        onChange={(e) => {
                            const m = MODES.find((x) => MODE_ID(x.tones, x.bandwidth) === e.target.value);
                            if (m) setCfg({ tones: m.tones, bandwidth: m.bandwidth });
                        }}
                    >
                        {MODES.map((m) => (
                            <option key={MODE_ID(m.tones, m.bandwidth)} value={MODE_ID(m.tones, m.bandwidth)}>
                                {modeLabel(m)}
                            </option>
                        ))}
                    </select>
                </label>

                <NumberField
                    label="Centre"
                    title="Audio frequency the tone block is centred on, in Hz. The decoder searches a little either side of this on its own, but not far — put the signal near it"
                    value={config.center_frequency}
                    limits={LIMITS.center_frequency}
                    onCommit={(v) => setCfg({ center_frequency: v })}
                />

                {/* Live — no re-attach. Wide enough to be draggable, because on
                    this mode it is the control you actually work. */}
                <label className="tp__field tp__field--wide" title="How strong the error-correction has to look before a block is printed. Lower prints more and risks rubbish; higher prints only what it is sure of. Takes effect immediately — this one does not restart the decoder">
                    <span className="tp__field-label">Squelch {squelch.toFixed(1)}</span>
                    <Slider
                        value={squelch}
                        min={SQUELCH.min}
                        max={SQUELCH.max}
                        step={SQUELCH.step}
                        onChange={commitSquelch}
                    />
                </label>

                {/* fldigi's three remaining Olivia settings. They live here
                    rather than in their own row because they are setup, not
                    reporting — but they are out of the minimal view, because
                    the mode, the centre and the squelch are what you actually
                    work and these are what you set once and leave. */}
                {!minimal && (
                    <>
                        <NumberField
                            label="Margin"
                            title="How far either side of the centre the decoder looks for the signal, in FFT bins — fldigi calls this the tune margin. Wider forgives sloppy tuning; narrower is better on a crowded band, because every extra offset is another chance for noise to win the sync race. Restarts the decoder"
                            value={config.sync_margin}
                            limits={LIMITS.sync_margin}
                            onCommit={(v) => setCfg({ sync_margin: Math.round(v) })}
                        />
                        <NumberField
                            label="Integration"
                            title="How many FEC blocks the synchroniser averages before it trusts a decision. Deeper copies further into the noise, but a block only leaves the decoder once this many have gone in — so it also makes the wait before anything prints proportionally longer. Restarts the decoder"
                            value={config.sync_integ_len}
                            limits={LIMITS.sync_integ_len}
                            onCommit={(v) => setCfg({ sync_integ_len: Math.round(v) })}
                        />
                        <Switch
                            label="Reverse"
                            title="Decode an inverted tone block, for a signal received on the opposite sideband to the one it was sent on. Restarts the decoder"
                            checked={!!config.reverse}
                            onChange={(v) => setCfg({ reverse: v })}
                        />
                        <Switch
                            label="8-bit"
                            title="Honour Olivia's escape for characters above 126: a 127 means the next character plus 128. On by default, as fldigi has it — a sender that does not use it never emits 127, so this costs nothing. Restarts the decoder"
                            checked={!!config.eight_bit}
                            onChange={(v) => setCfg({ eight_bit: v })}
                        />
                    </>
                )}
            </div>

            {/* The hints go in the minimal view; the warnings stay. Being told
                what to do next is what you no longer need once you have cut the
                panel down, but a warning is news either way. */}
            {!minimal && !running && <div className="note note--tight">Start the receiver to decode.</div>}
            {!minimal && running && !live && <div className="note note--tight">Waiting for the audio connection…</div>}
            {!minimal && live && !decoding && (
                <div className="note note--tight">
                    Tune to an Olivia signal in USB, pick the mode that matches its width, then press Start.
                </div>
            )}
            {/* The decoder takes whatever audio the session produces, so a wrong
                mode does not fail — the tones simply are not there. */}
            {decoding && tuning.mode !== 'usb' && tuning.mode !== 'lsb' && (
                <div className="note note--warn">
                    Olivia needs a sideband mode; nothing will decode in {tuning.mode.toUpperCase()}.
                </div>
            )}
            {/* The server narrows its own frequency search when the tone block
                sits too low in the passband to search around it. It still
                decodes, but only if you are tuned nearly exactly right. */}
            {srvConfig && srvConfig.narrowed && (
                <div className="note note--warn">
                    {srvConfig.bandwidth} Hz of tones at {srvConfig.center_hz} Hz leaves no room to search
                    either side — raise the centre frequency, or pick a narrower mode.
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
                    <span className="tp__bar-gap" />
                    <Readout
                        label="Lock"
                        value={status && status.synced ? `${status.quality}%` : '—'}
                        tone={status && status.synced ? 'good' : undefined}
                    />
                    <Readout label="S/N" value={status ? status.snr_db.toFixed(1) : '—'} unit="dB" />
                    <Readout
                        label="Offset"
                        value={status ? (status.offset_hz > 0 ? `+${status.offset_hz.toFixed(1)}` : status.offset_hz.toFixed(1)) : '—'}
                        unit="Hz"
                    />
                </div>
            )}

            <Console
                lines={lines}
                timestamps={opts.timestamps}
                autoScroll={opts.autoScroll}
                empty={decoding
                    ? `Listening. Olivia ${config.tones}/${config.bandwidth} prints ${rates.charsPerSec.toFixed(1)} characters a second and the decoder integrates four blocks before it prints anything, so give it about ${acquireSeconds} seconds.`
                    : undefined}
            />

            {!minimal && (
                <div className="tp__foot">
                    {/* What the server actually built, which is not always what
                        was asked for: the mode is quantised, and the search
                        narrows near the bottom of the passband. */}
                    {srvConfig
                        ? (
                            <span className="tp__hint">
                                {srvConfig.tones}/{srvConfig.bandwidth} · {srvConfig.baud_rate} Bd ·
                                {' '}{srvConfig.block_period}s blocks · search ±{srvConfig.sync_margin} bins
                            </span>
                        )
                        : <span className="tp__hint">{rates.baud.toFixed(2)} Bd · {rates.blockPeriod.toFixed(3)}s blocks</span>}
                    <span className="tp__bar-gap" />
                    {running && <AudioLevel />}
                </div>
            )}
        </div>
    );
}

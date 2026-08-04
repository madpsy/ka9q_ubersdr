// Sound Modem — v1's extension, rebuilt for v2.
//
// The odd decoder out in the other direction from QRSS: this one runs a whole
// separate program. The server starts a QtSoundModem subprocess per session and
// relays its KISS and AGW output, so the settings here are that program's
// settings — up to four independent modem channels — and what comes back is raw
// AX.25, decoded in the browser by ./ax25.js.
//
// Two consequences shape the panel:
//
//   * The configuration is the point, not an afterthought. A modem with no
//     channel enabled decodes nothing, and the modem type has to match the
//     transmission exactly — 1200 baud AFSK will not hear a 300 baud HF link.
//     So the channel strip is always visible and Start is refused until at
//     least one channel is on.
//   * There is a real "it will never work" failure. The server sends an error
//     frame when QtSoundModem is not installed or its subprocess dies, and that
//     is not a bad decode to shrug off — nothing will ever arrive. It is shown
//     as an error, not logged.
//
// Two things v1 had are not here, and are called out rather than quietly
// dropped: the APRS map, and the audio waterfall. v2 has a spectrum and an
// audio scope of its own, and a map is a panel rather than a corner of a
// decoder.

import React, { useCallback, useEffect, useMemo, useRef, useState } from '../../react.js';
import { useRadio } from '../../radio/RadioContext.jsx';
import { Button, Empty, Icon, Switch } from '../../components/ui.jsx';
import { useAudioExtension } from '../useAudioExtension.js';
import { tunedOption } from '../frequencies.js';
import { NumberField } from '../TeleprinterUI.jsx';
import { parseAX25 } from './ax25.js';
import {
    FRAME_FILTERS, FX25_MODES, IL2P_MODES, LIMITS, MAX_CHANNELS, MAX_FRAMES, MAX_LINES,
    MODEM_TYPES, SOUNDMODEM_CONFIG, SOUNDMODEM_FREQUENCIES,
    anyChannelEnabled, attachParams, decodeFrame, matchesFilter, matchesSearch,
} from './frames.js';

// Packet is received in USB on HF; on VHF a receiver is in NFM, which this
// receiver can also do — so the mode is not forced and only the tune-to menu
// picks one.
const HF_MODE = 'usb';

// How long a DCD lamp stays lit after the last "on". The server sends a pulse
// per state change and a channel that is decoding toggles constantly, so
// without this the lamps flicker rather than reading as activity.
const DCD_HOLD_MS = 400;

const RCVR_PAIRS = [0, 1, 2, 3, 4, 5, 6, 7, 8];

function timeOf(at) {
    return new Date(at).toISOString().substring(11, 19);
}

/** One modem channel's settings. */
function ChannelStrip({ index, channel, onChange, dcd }) {
    const set = (patch) => onChange({ ...channel, ...patch });
    return (
        <div className={`sm__ch${channel.enabled ? ' is-on' : ''}`}>
            <div className="sm__ch-head">
                <Switch
                    label={`Ch ${index + 1}`}
                    title="Run a modem on this channel. Each one listens to the same audio with its own settings, so you can watch two baud rates at once"
                    checked={!!channel.enabled}
                    onChange={(v) => set({ enabled: v })}
                />
                <span className="tp__bar-gap" />
                <span
                    className={`sm__dcd${dcd ? ' is-on' : ''}`}
                    title="Data carrier detect — this channel is hearing something it thinks is a signal"
                >
                    DCD
                </span>
            </div>

            {channel.enabled && (
                <div className="sm__ch-body">
                    <label className="tp__field" title="The modulation and rate to listen for. It has to match the transmission — 1200 baud AFSK will not hear a 300 baud HF link">
                        <span className="tp__field-label">Modem</span>
                        <select className="select" value={channel.modem} onChange={(e) => set({ modem: Number(e.target.value) })}>
                            {MODEM_TYPES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                        </select>
                    </label>

                    <NumberField
                        label="Freq"
                        title="Audio centre frequency in Hz. 1700 for Bell 202 (the tones are 1200 and 2200); 1500 for HF 300 baud"
                        value={channel.freq}
                        limits={LIMITS.freq}
                        onCommit={(v) => set({ freq: v })}
                    />

                    <label className="tp__field" title="Receiver diversity pairs. More decodes marginal signals better and costs CPU on a machine shared with every other listener">
                        <span className="tp__field-label">Pairs</span>
                        <select className="select" value={channel.rcvr_pairs} onChange={(e) => set({ rcvr_pairs: Number(e.target.value) })}>
                            {RCVR_PAIRS.map((n) => <option key={n} value={n}>{n}</option>)}
                        </select>
                    </label>

                    <label className="tp__field" title="FX.25 forward error correction — recovers frames a plain decoder would lose, and is ignored by senders that do not use it">
                        <span className="tp__field-label">FX.25</span>
                        <select className="select" value={channel.fx25} onChange={(e) => set({ fx25: Number(e.target.value) })}>
                            {FX25_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                        </select>
                    </label>

                    <label className="tp__field" title="IL2P framing — a different error-corrected layer 2, used by some networks instead of plain AX.25">
                        <span className="tp__field-label">IL2P</span>
                        <select className="select" value={channel.il2p} onChange={(e) => set({ il2p: Number(e.target.value) })}>
                            {IL2P_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                        </select>
                    </label>
                </div>
            )}
        </div>
    );
}

export default function SoundModemExtension({ minimal }) {
    const { running, audioState, tuning, actions } = useRadio();
    const live = running && audioState === 'open';

    const [decoding, setDecoding] = useState(false);
    const [config, setConfig] = useState(SOUNDMODEM_CONFIG);
    const [frames, setFrames] = useState([]);
    const [monitor, setMonitor] = useState([]);
    const [log, setLog] = useState([]);
    const [dcd, setDcd] = useState([false, false, false, false]);
    const [modemError, setModemError] = useState('');
    const [filter, setFilter] = useState('all');
    const [channelFilter, setChannelFilter] = useState('all');
    const [search, setSearch] = useState('');
    const [view, setView] = useState('frames');
    const [autoScroll, setAutoScroll] = useState(true);
    const [copied, setCopied] = useState(false);

    const seq = useRef(0);
    const dcdTimers = useRef([null, null, null, null]);
    const listRef = useRef(null);

    const params = useMemo(() => attachParams(config), [config]);
    const ready = anyChannelEnabled(config);

    const onResult = useCallback((msg) => {
        switch (msg.kind) {
            case 'packet': {
                const parsed = parseAX25(msg.bytes);
                // A channel delivers plenty of frames too damaged to read. They
                // are not worth a row, and not worth an error either.
                if (!parsed) break;
                const row = {
                    ...parsed,
                    key: seq.current++,
                    at: Date.now(),
                    // The KISS port is the modem channel it came from.
                    channel: msg.port,
                };
                setFrames((prev) => [row, ...prev].slice(0, MAX_FRAMES));
                break;
            }

            case 'dcd': {
                const ch = msg.channel;
                if (ch >= MAX_CHANNELS) break;
                clearTimeout(dcdTimers.current[ch]);
                if (msg.on) setDcd((prev) => (prev[ch] ? prev : prev.map((v, i) => (i === ch ? true : v))));
                // The lamp always goes out on a timer, never on the "off"
                // pulse: a channel that is decoding toggles carrier detect
                // constantly, and following it exactly makes the lamp flicker
                // rather than read as activity.
                dcdTimers.current[ch] = setTimeout(() => {
                    setDcd((prev) => (prev[ch] ? prev.map((v, i) => (i === ch ? false : v)) : prev));
                }, DCD_HOLD_MS);
                break;
            }

            case 'monitor':
                setMonitor((prev) => [
                    { key: seq.current++, at: Date.now(), channel: msg.channel, isTx: msg.isTx, text: msg.text },
                    ...prev,
                ].slice(0, MAX_LINES));
                break;

            case 'log':
                setLog((prev) => [{ key: seq.current++, at: Date.now(), text: msg.text }, ...prev].slice(0, MAX_LINES));
                break;

            case 'error':
                // Not a bad decode — the modem is not going to run at all.
                setModemError(msg.text || 'The sound modem failed to start.');
                break;

            default:
                break;
        }
    }, []);

    const { state: attachState, error } = useAudioExtension({
        name: 'soundmodem',
        params,
        active: decoding && live,
        parse: decodeFrame,
        onResult,
    });

    useEffect(() => { if (!running && decoding) setDecoding(false); }, [running, decoding]);

    useEffect(() => {
        if (decoding) { setModemError(''); return undefined; }
        for (const t of dcdTimers.current) clearTimeout(t);
        setDcd([false, false, false, false]);
        return undefined;
    }, [decoding]);

    useEffect(() => () => { for (const t of dcdTimers.current) clearTimeout(t); }, []);

    // Newest at the top, so following the traffic means keeping the top in view.
    useEffect(() => {
        if (!autoScroll || !listRef.current) return;
        listRef.current.scrollTop = 0;
    }, [frames, monitor, log, autoScroll]);


    const rows = useMemo(() => frames.filter((f) => (
        matchesFilter(f, filter)
        && (channelFilter === 'all' || f.channel === Number(channelFilter))
        && matchesSearch(f, search)
    )), [frames, filter, channelFilter, search]);

    const lastHeard = frames.length ? frames[0] : null;

    // ── actions ─────────────────────────────────────────────────────────────

    const setChannel = (i, next) => setConfig((prev) => ({
        ...prev,
        channels: prev.channels.map((c, n) => (n === i ? next : c)),
    }));

    const tuned = tunedOption(SOUNDMODEM_FREQUENCIES, tuning.frequency);

    const tuneTo = (hz) => {
        actions.tuneTo({ frequency: hz, mode: HF_MODE, bandwidthLow: 0, bandwidthHigh: 3000 });
        actions.ensureVisible(hz);
    };

    const asText = () => rows.map((f) => (
        `${timeOf(f.at)} ${f.from}>${f.to}${f.digipeaters.length ? `,${f.digipeaters.join(',')}` : ''} ${f.info}${f.infoRaw ? `\n${f.infoRaw}` : ''}`
    )).join('\n');

    const copy = () => {
        const text = asText();
        if (!text || !navigator.clipboard) return;
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        }, () => { /* a refused clipboard is not worth an error state */ });
    };

    const clear = () => {
        setFrames([]);
        setMonitor([]);
        setLog([]);
    };

    const statusLabel = !decoding
        ? 'Stopped'
        : (attachState === 'running' ? 'Running' : (attachState === 'error' ? 'Error' : 'Starting…'));
    const statusTone = !decoding
        ? 'off'
        : (attachState === 'running' ? 'on' : (attachState === 'error' ? 'bad' : 'wait'));

    return (
        <div className="tp sm">
            <div className="tp__bar">
                <span className={`tp__status tp__status--${statusTone}`} title="Whether the modem is attached to your audio session on the server">
                    {statusLabel}
                </span>
                <span className="sm__count" title="Frames decoded this session">{frames.length} frames</span>
                {lastHeard && (
                    <span className="sm__last" title={`Last frame at ${timeOf(lastHeard.at)}`}>{lastHeard.from}</span>
                )}
                <span className="tp__bar-gap" />

                <select
                    className="select tp__freq"
                    value={tuned ? String(tuned.hz) : ''}
                    onChange={(e) => { if (e.target.value) tuneTo(Number(e.target.value)); }}
                    title="Tune to a packet frequency in USB, and show whether the receiver is on one"
                >
                    <option value="">Tune to…</option>
                    {SOUNDMODEM_FREQUENCIES.map((g) => (
                        <optgroup key={g.group} label={g.group}>
                            {g.options.map((o) => <option key={o.hz} value={o.hz}>{o.label}</option>)}
                        </optgroup>
                    ))}
                </select>

                {decoding
                    ? (
                        <Button size="sm" onClick={() => setDecoding(false)} icon={<Icon.Stop size={13} />} title="Stop the modem and release it on the server">
                            Stop
                        </Button>
                    )
                    : (
                        <Button
                            size="sm"
                            variant="primary"
                            onClick={() => setDecoding(true)}
                            disabled={!live || !ready}
                            icon={<Icon.Power size={13} />}
                            title={!live
                                ? 'Start the receiver first — the modem runs on your audio session'
                                : (ready
                                    ? 'Start the modem'
                                    : 'Enable at least one channel first — a modem with none decodes nothing')}
                        >
                            Start
                        </Button>
                    )}
                <Button size="sm" variant="ghost" onClick={copy} disabled={!rows.length} active={copied} icon={<Icon.Copy size={13} />} title="Copy the frames on screen to the clipboard" />
                <Button size="sm" variant="ghost" onClick={clear} disabled={!frames.length && !monitor.length && !log.length} icon={<Icon.Trash size={13} />} title="Clear everything decoded" />
            </div>

            {/* Always visible, unlike the other decoders' settings: the modem
                type has to match the transmission, so this is the control you
                use rather than one you set once. */}
            <div className="sm__channels">
                {config.channels.slice(0, MAX_CHANNELS).map((c, i) => (
                    <ChannelStrip
                        // eslint-disable-next-line react/no-array-index-key
                        key={i}
                        index={i}
                        channel={c}
                        dcd={dcd[i]}
                        onChange={(next) => setChannel(i, next)}
                    />
                ))}
                <NumberField
                    label="DCD"
                    title="Carrier-detect threshold, 1–100. Lower is more sensitive and triggers on more noise"
                    value={config.dcd_threshold}
                    limits={LIMITS.dcd_threshold}
                    onCommit={(v) => setConfig((prev) => ({ ...prev, dcd_threshold: v }))}
                />
            </div>

            {!minimal && !running && <div className="note note--tight">Start the receiver to decode.</div>}
            {!minimal && running && !live && <div className="note note--tight">Waiting for the audio connection…</div>}
            {!minimal && live && !decoding && !ready && (
                <div className="note note--warn">Enable at least one channel — a modem with none decodes nothing.</div>
            )}
            {!minimal && live && !decoding && ready && (
                <div className="note note--tight">Set each channel&apos;s modem to match what you are listening to, then press Start.</div>
            )}
            {modemError && <div className="note note--warn">{modemError}</div>}
            {attachState === 'error' && <div className="note note--warn">{error}</div>}

            {!minimal && (
                <div className="tp__controls sm__filters">
                    <select className="select" value={filter} onChange={(e) => setFilter(e.target.value)} title="Which frames to show">
                        {FRAME_FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                    </select>
                    <select className="select" value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)} title="Which modem channel's frames to show">
                        <option value="all">All channels</option>
                        {config.channels.map((c, i) => (
                            // eslint-disable-next-line react/no-array-index-key
                            <option key={i} value={i}>Ch {i + 1}</option>
                        ))}
                    </select>
                    <input
                        className="input sm__search"
                        type="text"
                        placeholder="Search callsign, path or text…"
                        title="Show only frames whose callsigns, digipeater path or decoded text contain this"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                    <Switch label="Follow" title="Keep the newest frame in view" checked={autoScroll} onChange={setAutoScroll} />
                    <span className="tp__bar-gap" />
                    {/* The two diagnostics, behind a switch each: the monitor is
                        QtSoundModem's own view of the channel and the log is its
                        stderr, and neither is what you opened this for. */}
                    <Switch
                        label="Monitor"
                        title="QtSoundModem's own channel monitor text, rather than the frames it decoded"
                        checked={view === 'monitor'}
                        onChange={(v) => setView(v ? 'monitor' : 'frames')}
                    />
                    <Switch
                        label="Log"
                        title="The modem process's own output. Where to look when nothing is decoding and you want to know why"
                        checked={view === 'log'}
                        onChange={(v) => setView(v ? 'log' : 'frames')}
                    />
                </div>
            )}

            <div className="tp__console sm__list" ref={listRef}>
                {view === 'frames' && rows.length === 0 && (
                    <Empty>
                        {frames.length === 0
                            ? (decoding ? 'Listening. Nothing decoded yet.' : 'No frames yet.')
                            : 'No frames match these filters.'}
                    </Empty>
                )}
                {view === 'frames' && rows.map((f) => (
                    <div key={f.key} className={`sm__frame sm__frame--${f.frameClass.toLowerCase()}`}>
                        <span className="sm__at">{timeOf(f.at)}</span>
                        <span className="sm__ch-tag" title={`Modem channel ${f.channel + 1}`}>{f.channel + 1}</span>
                        <span className="sm__path">
                            <button
                                type="button"
                                className="sm__call"
                                title="Filter on this callsign"
                                onClick={() => setSearch(f.from)}
                            >
                                {f.from}
                            </button>
                            <span className="sm__arrow">&gt;</span>
                            <span className="sm__to">{f.to}</span>
                            {f.digipeaters.length > 0 && (
                                <span className="sm__digis" title="Digipeater path; * marks the last one that repeated it">
                                    ,{f.digipeaters.join(',')}
                                </span>
                            )}
                        </span>
                        <span className={`sm__info${f.isAPRS ? ' sm__info--aprs' : ''}`}>{f.info}</span>
                        {f.infoRaw && <pre className="sm__payload">{f.infoRaw}</pre>}
                    </div>
                ))}

                {view === 'monitor' && monitor.length === 0 && <Empty>No monitor text yet.</Empty>}
                {view === 'monitor' && monitor.map((m) => (
                    <div key={m.key} className={`sm__line${m.isTx ? ' sm__line--tx' : ''}`}>
                        <span className="sm__at">{timeOf(m.at)}</span>
                        <span className="sm__ch-tag">{m.channel + 1}</span>
                        <span className="sm__line-text">{m.text}</span>
                    </div>
                ))}

                {view === 'log' && log.length === 0 && <Empty>Nothing from the modem process yet.</Empty>}
                {view === 'log' && log.map((l) => (
                    <div key={l.key} className="sm__line sm__line--log">
                        <span className="sm__at">{timeOf(l.at)}</span>
                        <span className="sm__line-text">{l.text}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

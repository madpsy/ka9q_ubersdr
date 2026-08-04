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
//     least one channel is on. The minimal view keeps the strip for that
//     reason, collapsed to the four switches: which channels are running stays
//     answerable and changeable, while their settings — chosen once to match
//     the transmission — give their height to the frame list.
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
import { subscribeAudioSpectrum } from '../../lib/audioSpectrum.js';
import { useAudioExtension } from '../useAudioExtension.js';
import { tunedOption } from '../frequencies.js';
import { NumberField } from '../TeleprinterUI.jsx';
import { parseAX25 } from './ax25.js';
import {
    CHANNEL_NAMES, DEFAULT_FRAME_LIMIT, FRAME_FILTERS, FRAME_LIMITS, FX25_MODES, IL2P_MODES,
    LIMITS, MAX_CHANNELS, MAX_LINES, MODEM_TYPES, RCVR_PAIRS,
    SOUNDMODEM_CONFIG, SOUNDMODEM_FREQUENCIES,
    anyChannelEnabled, attachParams, decodeFrame, looksLikeRealFrame, matchesFilter,
    matchesSearch, trimFrames,
} from './frames.js';
import {
    CHANNEL_COLOURS, LINE_MS, MAX_AUDIO_HZ, buildBinMap, drawLine, modemBandwidth, xOf,
} from './waterfall.js';

// Packet is received in USB on HF; on VHF a receiver is in NFM, which this
// receiver can also do — so the mode is not forced and only the tune-to menu
// picks one.
const HF_MODE = 'usb';

// How long a lamp stays lit when no "off" follows the "on". v1's number. The
// server sends a pulse per state change, and a burst that ends without one
// would otherwise leave the lamp lit for ever.
const DCD_HOLD_MS = 500;

const WATERFALL_H = 120;

function timeOf(at) {
    return new Date(at).toISOString().substring(11, 19);
}

/**
 * The audio waterfall, with a marker per enabled channel.
 *
 * Runs whenever the receiver does, not only while the modem is started: the
 * point of it is choosing a modem frequency, which you do before pressing
 * Start. Nothing about it goes through React — the bins are read and painted
 * inside one animation callback.
 */
function Waterfall({ channels }) {
    const { player } = useRadio();
    const wrap = useRef(null);
    const wf = useRef(null);
    const overlay = useRef(null);
    // Everything the paint path needs across frames without causing a render.
    const g = useRef({ binMap: null, rgba: null, bins: 0, rate: 0, at: 0, width: 0 });

    // Redrawn on every change, so moving a channel's frequency moves its marker
    // as you type rather than when the modem next starts.
    const marks = useMemo(() => channels
        .map((c, i) => ({ ...c, index: i }))
        .filter((c) => c.enabled && xOf(c.freq) != null), [channels]);

    useEffect(() => {
        const canvas = overlay.current;
        if (!canvas) return;
        const box = wrap.current;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = Math.max(1, Math.round(box.clientWidth * dpr));
        canvas.height = Math.max(1, Math.round(WATERFALL_H * dpr));
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const w = box.clientWidth;
        ctx.clearRect(0, 0, w, WATERFALL_H);

        // Frequency scale along the bottom.
        ctx.font = '9px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        for (let hz = 0; hz <= MAX_AUDIO_HZ; hz += 500) {
            const x = (hz / MAX_AUDIO_HZ) * w;
            ctx.fillRect(x, WATERFALL_H - 4, 1, 4);
            ctx.fillText(String(hz), x + 2, WATERFALL_H - 5);
        }

        // One marker per enabled channel: a centre line, a bandwidth bar and
        // the channel's letter, so two channels a hundred hertz apart are still
        // told apart at a glance.
        for (const m of marks) {
            const colour = CHANNEL_COLOURS[m.index % CHANNEL_COLOURS.length];
            const x = xOf(m.freq) * w;
            const half = (modemBandwidth((MODEM_TYPES[m.modem] || {}).label) / 2 / MAX_AUDIO_HZ) * w;

            ctx.fillStyle = colour;
            ctx.globalAlpha = 0.16;
            ctx.fillRect(x - half, 0, half * 2, WATERFALL_H - 12);
            ctx.globalAlpha = 0.85;
            ctx.fillRect(x - 0.5, 0, 1, WATERFALL_H - 12);
            ctx.globalAlpha = 1;

            ctx.font = '600 10px ui-monospace, monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillStyle = 'rgba(0,0,0,0.65)';
            ctx.fillRect(x - 7, 1, 14, 12);
            ctx.fillStyle = colour;
            ctx.fillText(CHANNEL_NAMES[m.index], x, 2);
        }
    }, [marks]);

    useEffect(() => {
        const canvas = wf.current;
        const box = wrap.current;
        if (!canvas || !box) return undefined;
        const width = Math.max(1, Math.round(box.clientWidth));
        canvas.width = width;
        canvas.height = WATERFALL_H;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, WATERFALL_H);
        g.current.width = width;
        g.current.binMap = null;

        return subscribeAudioSpectrum(player, { fftSize: 2048, bins: false, byteBins: true }, (f) => {
            const s = g.current;
            if (!f.byteBins) return;
            // One line every LINE_MS, so the scroll speed is constant whatever
            // rate the animation loop runs at.
            const now = performance.now();
            if (now - s.at < LINE_MS) return;
            s.at = now;
            if (!s.binMap || s.bins !== f.binCount || s.rate !== f.sampleRate) {
                s.binMap = buildBinMap(canvas.width, f.binCount, f.sampleRate);
                s.bins = f.binCount;
                s.rate = f.sampleRate;
            }
            s.rgba = drawLine(ctx, f.byteBins, s.binMap, s.rgba);
        });
    }, [player]);

    return (
        <div className="sm__wf" style={{ height: WATERFALL_H }} ref={wrap} title="Audio spectrum over the last few seconds, with each enabled channel's listening frequency marked. Put the signal on a marker">
            <canvas ref={wf} className="sm__wf-canvas" />
            <canvas ref={overlay} className="sm__wf-overlay" />
        </div>
    );
}

/**
 * One modem channel's settings.
 *
 * `compact` leaves the on/off switch and nothing else — see the minimal view
 * below. The card's own DCD indicator goes with the rest: the lamps in the bar
 * at the top say the same thing, per channel and in the same colours, so
 * keeping a second copy would cost the width that lets all four switches sit on
 * one line.
 */
function ChannelStrip({ index, channel, onChange, dcd, compact }) {
    const set = (patch) => onChange({ ...channel, ...patch });
    return (
        <div className={`sm__ch sm__ch--${index}${channel.enabled ? ' is-on' : ''}`}>
            <div className="sm__ch-head">
                <Switch
                    label={`Ch ${CHANNEL_NAMES[index]}`}
                    title="Run a modem on this channel. Each one listens to the same audio with its own settings, so you can watch two baud rates at once"
                    checked={!!channel.enabled}
                    onChange={(v) => set({ enabled: v })}
                />
                {!compact && (
                    <>
                        <span className="tp__bar-gap" />
                        <span
                            className={`sm__dcd${dcd ? ' is-on' : ''}`}
                            title="Data carrier detect — this channel is hearing something it thinks is a signal"
                        >
                            DCD
                        </span>
                    </>
                )}
            </div>

            {!compact && channel.enabled && (
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
                            {RCVR_PAIRS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
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
    const [limit, setLimit] = useState(DEFAULT_FRAME_LIMIT);
    const [copied, setCopied] = useState(false);

    const seq = useRef(0);
    // Read from the socket callback, which is not re-created when the limit
    // changes, so it has to come from a ref rather than the closure.
    const limitRef = useRef(DEFAULT_FRAME_LIMIT);
    limitRef.current = limit;
    const dcdTimers = useRef([null, null, null, null]);
    const listRef = useRef(null);

    const params = useMemo(() => attachParams(config), [config]);
    const ready = anyChannelEnabled(config);

    const onResult = useCallback((msg) => {
        switch (msg.kind) {
            case 'packet': {
                const parsed = parseAX25(msg.bytes);
                // A channel delivers plenty of frames too damaged to read, and
                // plenty of noise bursts that decode into AX.25-shaped rubbish.
                // Neither is worth a row, and neither is worth an error.
                if (!parsed || !looksLikeRealFrame(parsed)) break;
                const row = {
                    ...parsed,
                    key: seq.current++,
                    at: Date.now(),
                    // The KISS port is the modem channel it came from.
                    channel: msg.port,
                };
                setFrames((prev) => trimFrames([row, ...prev], limitRef.current));
                break;
            }

            case 'dcd': {
                const ch = msg.channel;
                if (ch >= MAX_CHANNELS) break;
                clearTimeout(dcdTimers.current[ch]);
                dcdTimers.current[ch] = null;
                if (msg.on) {
                    setDcd((prev) => (prev[ch] ? prev : prev.map((v, i) => (i === ch ? true : v))));
                    // A safety net, not the normal path: an explicit "off"
                    // clears the lamp at once, and this only catches a burst
                    // whose "off" never arrives.
                    dcdTimers.current[ch] = setTimeout(() => {
                        setDcd((prev) => (prev[ch] ? prev.map((v, i) => (i === ch ? false : v)) : prev));
                    }, DCD_HOLD_MS);
                } else {
                    setDcd((prev) => (prev[ch] ? prev.map((v, i) => (i === ch ? false : v)) : prev));
                }
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

    useEffect(() => { setFrames((prev) => trimFrames(prev, limit)); }, [limit]);

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
                <span className="sm__count" title="Frames held">{frames.length} frames</span>
                {lastHeard && (
                    <span className="sm__last" title={`Last frame at ${timeOf(lastHeard.at)}`}>{lastHeard.from}</span>
                )}
                {/* One lamp per channel, always all four, so a dark lamp reads
                    as "that channel is quiet" and a missing one is impossible.
                    An enabled channel's lamp carries its marker colour, which
                    is how a lamp is matched to a line on the waterfall. */}
                <span className="sm__dcds" title="Data carrier detect, per modem channel">
                    {CHANNEL_NAMES.map((name, i) => (
                        <span
                            key={name}
                            className={`sm__lamp${dcd[i] ? ' is-on' : ''}${config.channels[i] && config.channels[i].enabled ? ' is-enabled' : ''}`}
                            style={{ '--ch': CHANNEL_COLOURS[i] }}
                            title={`Channel ${name}: ${config.channels[i] && config.channels[i].enabled ? (dcd[i] ? 'carrier detected' : 'enabled, idle') : 'disabled'}`}
                        >
                            {name}
                        </span>
                    ))}
                </span>
                {/* Beside the lamps, because it is the setting they answer to:
                    the threshold decides when a channel calls something a
                    carrier. One number never justified a row of its own. */}
                <span className="sm__thresh">
                    <NumberField
                        label="Threshold"
                        title="Carrier-detect threshold, 1–100. Lower is more sensitive and triggers on more noise"
                        value={config.dcd_threshold}
                        limits={LIMITS.dcd_threshold}
                        onCommit={(v) => setConfig((prev) => ({ ...prev, dcd_threshold: v }))}
                    />
                </span>
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

            {/* The waterfall runs whenever the receiver does, not only while
                the modem is started: choosing a modem frequency is what it is
                for, and you do that before pressing Start. */}
            {!minimal && running && <Waterfall channels={config.channels} />}

            {/* The channel strip stays even in the minimal view, unlike the
                other decoders' settings: a modem with no channel enabled
                decodes nothing, and switching a channel off is how you stop one
                that is only producing noise. It collapses to the four switches
                — modem type, frequency, pairs and the FEC modes are set to
                match the transmission and then left, and the height they take
                is height the frame list wants. */}
            <div className={`sm__channels${minimal ? ' sm__channels--compact' : ''}`}>
                {config.channels.slice(0, MAX_CHANNELS).map((c, i) => (
                    <ChannelStrip
                        // eslint-disable-next-line react/no-array-index-key
                        key={i}
                        index={i}
                        channel={c}
                        dcd={dcd[i]}
                        compact={minimal}
                        onChange={(next) => setChannel(i, next)}
                    />
                ))}
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
                        {CHANNEL_NAMES.map((name, i) => <option key={name} value={i}>Ch {name}</option>)}
                    </select>
                    <select
                        className="select"
                        value={limit}
                        onChange={(e) => setLimit(Number(e.target.value))}
                        title="How many frames to keep. Unlimited still stops at a couple of thousand — a tab left open overnight is not a reason to run out of memory"
                    >
                        {FRAME_LIMITS.map((n) => <option key={n} value={n}>{n === 0 ? '∞' : n}</option>)}
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
                        <span
                            className="sm__ch-tag"
                            style={{ '--ch': CHANNEL_COLOURS[f.channel % CHANNEL_COLOURS.length] }}
                            title={`Modem channel ${CHANNEL_NAMES[f.channel] || f.channel}`}
                        >
                            {CHANNEL_NAMES[f.channel] || f.channel}
                        </span>
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
                        <span className="sm__ch-tag" style={{ '--ch': CHANNEL_COLOURS[m.channel % CHANNEL_COLOURS.length] }}>
                            {CHANNEL_NAMES[m.channel] || m.channel}
                        </span>
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

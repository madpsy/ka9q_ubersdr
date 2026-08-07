// Packet: the AX.25 frames the addon is decoding, in a dock column.
//
// Four figures, the last few frames, and what is being listened to. The addon's own page
// has the monitor, the modem settings per channel, the waterfall and the audio preview,
// and there is a link to it at the bottom — this is the glance, not the workbench.
//
// Deliberately not the audio: the addon streams a WAV preview of each channel, and a
// receiver that plays a second stream over the one you are listening to has misjudged
// what a dock panel is for. What is worth having here is the decode.
//
// `minimal` is the frames and nothing else. A decoded frame says what it is by being
// one — the same call the SSTV panel makes about its pictures.

import React, { useCallback, useEffect, useRef, useState } from '../react.js';
import { Empty, Icon } from '../components/ui.jsx';
import {
    LIST_MAX, POLL_MS, addonUrl, channelSummary, channelsUrl, frameKind, framesUrl,
    mergeFrames, normaliseFrame, packetAvailable, packetStats, topStations, trimFrames,
} from '../lib/packet.js';
import { clockOf, sinceLabel } from '../lib/format.js';

export { packetAvailable };

// How often the ages and the rate are recomputed. They are all "how long ago" or "in
// the last ten minutes", so they move with the clock and not only with the frames.
const TICK_MS = 1000;

function Stat({ label, value, sub }) {
    return (
        <div className="pk__stat">
            <span className="pk__stat-k">{label}</span>
            <span className="pk__stat-v">{value}</span>
            {sub && <span className="pk__stat-s">{sub}</span>}
        </div>
    );
}

export default function PacketPanel({ minimal }) {
    const [frames, setFrames] = useState([]);
    const [channels, setChannels] = useState([]);
    const [state, setState] = useState('loading');   // loading | ok | error
    const [now, setNow] = useState(() => Date.now());
    // The newest frame, so an arrival can be shown as one. Kept as an id: a poll that
    // brings back nothing new must not re-run the animation.
    const [fresh, setFresh] = useState('');
    const alive = useRef(true);

    useEffect(() => () => { alive.current = false; }, []);

    useEffect(() => {
        const id = setInterval(() => {
            setNow(Date.now());
            setFrames((list) => {
                const kept = trimFrames(list);
                return kept.length === list.length ? list : kept;
            });
        }, TICK_MS);
        return () => clearInterval(id);
    }, []);

    // What is being monitored. Once, on mount: channels are added and removed from the
    // addon's own page, which is a thing somebody does deliberately and rarely.
    useEffect(() => {
        fetch(channelsUrl())
            .then((r) => (r.ok ? r.json() : null))
            .then((rows) => { if (alive.current && rows) setChannels(channelSummary(rows)); })
            .catch(() => { /* the frames are the panel; the channel line is a caption */ });
    }, []);

    const poll = useCallback(() => {
        fetch(framesUrl())
            .then((r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then((rows) => {
                if (!alive.current) return;
                const list = (Array.isArray(rows) ? rows : []).map(normaliseFrame).filter(Boolean);
                setFrames((prev) => {
                    const next = mergeFrames(prev, list);
                    // Only when something actually arrived, and only after the first
                    // poll: the panel opening with an hour of history behind it is not
                    // twenty frames arriving at once.
                    if (next !== prev && prev.length && next[0]) setFresh(next[0].id);
                    return next;
                });
                setState('ok');
            })
            .catch(() => {
                if (!alive.current) return;
                // A failed poll leaves what is on screen: the frames are still the last
                // ones decoded, whatever the addon is doing now.
                setState((s) => (s === 'ok' ? s : 'error'));
            });
    }, []);

    useEffect(() => {
        poll();
        const id = setInterval(poll, POLL_MS);
        return () => clearInterval(id);
    }, [poll]);

    const stats = packetStats(frames, now);
    const top = topStations(frames, 3, now);

    if (state === 'loading') return <Empty>Loading…</Empty>;

    return (
        <div className="stack pk">
            {!minimal && (
                <>
                    <div className="pk__stats">
                        <Stat label="Frames" value={stats.frames} sub="1h" />
                        <Stat label="Rate" value={stats.rate.toFixed(1)} sub="/min" />
                        <Stat label="Heard" value={stats.stations} sub="calls" />
                        <Stat label="Last" value={sinceLabel(stats.last, now)} />
                    </div>

                    {/* Who is actually out there, which on a quiet channel is the whole
                        answer and takes one line to give. Counts included: three frames
                        from one station and thirty from another are different bands of
                        activity, and the numbers say which is which. */}
                    {top.length > 0 && (
                        <div className="pk__top">
                            {top.map((s) => (
                                <span key={s.call} className="pk__top-call" title={`${s.n} frames in the last hour`}>
                                    {s.call}<i>{s.n}</i>
                                </span>
                            ))}
                        </div>
                    )}
                </>
            )}

            {frames.length === 0 ? (
                <Empty>
                    {state === 'error'
                        ? 'The packet addon is not answering.'
                        : 'No frames decoded in the last hour.'}
                </Empty>
            ) : (
                <ul className="pk__list">
                    {frames.slice(0, LIST_MAX).map((f) => (
                        <li key={f.id} className={`pk__frame${f.id === fresh ? ' is-new' : ''}`}>
                            <div className="pk__head">
                                <span className="pk__t">{clockOf(f.at)}</span>
                                {/* Source to destination, and the source is the one that
                                    matters — it is the station that was on the air. */}
                                <span className="pk__call" title={f.from}>{f.from || '?'}</span>
                                <span className="pk__arrow">›</span>
                                <span className="pk__to" title={f.to}>{f.to || '?'}</span>
                                {f.via.length > 0 && (
                                    <span className="pk__via" title={`Via ${f.via.join(', ')}`}>
                                        ·{f.via.length}
                                    </span>
                                )}
                                <span className={`pk__kind is-${frameKind(f) || 'other'}`}>
                                    {frameKind(f) || '—'}
                                </span>
                                {f.snr != null && <span className="pk__snr">{Math.round(f.snr)}</span>}
                            </div>
                            {/* The payload, on its own line and clipped to two: this is
                                the part that is worth reading, and it runs from a
                                six-character status to a hundred characters of telemetry.
                                The whole of it is in the tooltip, and on the addon's own
                                page. */}
                            {f.info && <div className="pk__info" title={f.info}>{f.info}</div>}
                        </li>
                    ))}
                </ul>
            )}

            {!minimal && channels.length > 0 && (
                <div className="pk__chans">
                    {channels.map((c) => (
                        <span
                            key={c.label || c.mhz}
                            className={`pk__chan${c.up ? ' is-up' : ''}`}
                            title={c.up ? 'Connected' : 'Not connected'}
                        >
                            {c.mhz ? `${c.mhz}` : c.label}
                        </span>
                    ))}
                </div>
            )}

            {/* The addon's page: the live monitor, the modem configuration for each
                channel, the waterfall and the audio preview. Same new tab as the Addons
                panel — these are separate applications with their own interface. */}
            {!minimal && (
                <div className="row-end">
                    <a
                        className="btn btn--ghost btn--sm"
                        href={addonUrl()}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        Open Packet
                        <Icon.External size={13} />
                    </a>
                </div>
            )}
        </div>
    );
}

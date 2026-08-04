import React, { useEffect, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Empty } from '../components/ui.jsx';
import { formatRate, formatSpan } from '../lib/format.js';

// How often the throughput readout is refreshed, and the window it averages
// over — they are the same thing: each tick reports the bytes since the last.
const RATE_MS = 1000;

function Row({ label, value }) {
    if (value == null || value === '') return null;
    return (
        <div className="kv">
            <span className="kv__k">{label}</span>
            <span className="kv__v">{value}</span>
        </div>
    );
}

// Bytes per second on a socket, from its own cumulative counter.
//
// Sampled here rather than tracked in the connection: this is the only thing
// that wants a rate, it only wants one while the panel is open, and a counter
// plus a clock is all it takes. Nothing is measured while the panel is shut.
function useThroughput(conn) {
    const [rate, setRate] = useState(null);
    const last = useRef(null);

    useEffect(() => {
        if (!conn) return undefined;
        last.current = { bytes: conn.bytesIn || 0, at: performance.now() };
        const id = setInterval(() => {
            const now = performance.now();
            const bytes = conn.bytesIn || 0;
            const prev = last.current;
            last.current = { bytes, at: now };
            const dt = (now - prev.at) / 1000;
            if (dt > 0) setRate(Math.max(0, (bytes - prev.bytes) / dt));
        }, RATE_MS);
        return () => clearInterval(id);
    }, [conn]);

    return rate;
}

// The link state, with what it is actually carrying beside it. The rate is only
// shown once the socket is up: "0.0 kbit/s" next to "idle" says nothing that
// "idle" has not said already.
function Link({ state, rate }) {
    return (
        <>
            <span className={`state state--${state}`}>{state}</span>
            {state === 'open' && rate != null && (
                <span className="kv__rate">{formatRate(rate)}</span>
            )}
        </>
    );
}

export default function StatusPanel() {
    const { serverInfo, audioState, spectrumState, view, audioConn, spectrumConn } = useRadio();
    // Before the early return: hooks cannot be called conditionally.
    const audioRate = useThroughput(audioConn);
    const spectrumRate = useThroughput(spectrumConn);

    if (!serverInfo) return <Empty>Loading receiver info…</Empty>;

    const rx = serverInfo.receiver || {};
    const gps = rx.gps || {};

    return (
        <div className="stack">
            <div className="kv-list">
                <Row label="Name" value={rx.name} />
                <Row label="Callsign" value={rx.callsign} />
                <Row label="Location" value={rx.location} />
                <Row label="Grid" value={gps.maidenhead} />
                <Row
                    label="Coordinates"
                    // 0,0 is the config default, not a real position.
                    value={gps.lat || gps.lon ? `${gps.lat.toFixed(4)}, ${gps.lon.toFixed(4)}` : null}
                />
                <Row label="Altitude" value={rx.asl != null ? `${rx.asl} m ASL` : null} />
                <Row label="Antenna" value={rx.antenna} />
                <Row label="Timezone" value={rx.timezone} />
                <Row label="Version" value={serverInfo.version} />
            </div>

            <div className="divider" />

            <div className="kv-list">
                <Row label="Audio link" value={<Link state={audioState} rate={audioRate} />} />
                <Row label="Spectrum link" value={<Link state={spectrumState} rate={spectrumRate} />} />
                <Row label="Span" value={view.span ? formatSpan(view.span) : '—'} />
                <Row label="Bins" value={view.binCount || '—'} />
                <Row label="Resolution" value={view.binBandwidth ? `${view.binBandwidth.toFixed(1)} Hz/bin` : '—'} />
            </div>

            {serverInfo.description && (
                <>
                    <div className="divider" />
                    <div
                        className="prose"
                        // Operator-authored blurb from the server config; the same
                        // field the v1 frontend renders as markup.
                        dangerouslySetInnerHTML={{ __html: serverInfo.description }}
                    />
                </>
            )}
        </div>
    );
}

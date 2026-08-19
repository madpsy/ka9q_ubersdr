import React, { useEffect, useRef, useState } from '../react.js';
import { useMeters, useRadio } from '../radio/RadioContext.jsx';
import { Empty } from '../components/ui.jsx';
import { isIQ } from '../radio/constants.js';
import { formatRate, formatSpan } from '../lib/format.js';

// Hover note for the rate row. The stream's rate and the context's are two
// different facts: the player asks for the former and falls back to the device
// default if the browser refuses it, and everything is resampled from then on.
// Only worth saying when they disagree — see AudioPanel's StreamFormat.
function rateNote(m) {
    if (!m.streamRate || !m.contextRate || m.contextRate === m.streamRate) return undefined;
    return `Playing at ${(m.contextRate / 1000).toFixed(1)} kHz — this browser refused `
        + 'the stream\'s own rate, so the audio is being resampled.';
}

// How often the throughput readout is refreshed, and the window it averages
// over — they are the same thing: each tick reports the bytes since the last.
const RATE_MS = 1000;

function Row({ label, value, title }) {
    if (value == null || value === '') return null;
    return (
        <div className="kv" title={title}>
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

// The spectrum poll rate, as the divisor this client has asked the server for.
//
// "Full" rather than "÷1", because a divisor of one is the absence of a
// throttle and reads better as such.
function rateLabel(divisor) {
    const d = Number(divisor) || 1;
    return d > 1 ? `÷${d}` : 'full';
}

// The one caveat worth carrying: the divisor is applied to a private channel —
// the one a session gets once it zooms — while the shared default channel is
// polled at a fixed rate server-side and ignores set_rate entirely. So a
// throttled session sitting at the default view is still receiving at the
// shared rate, and this line would otherwise be quietly wrong about that.
function rateTitle(divisor) {
    const d = Number(divisor) || 1;
    const what = d > 1
        ? `The server is polling the receiver at 1/${d} of the normal rate for this session.`
        : 'The server is polling the receiver at the full rate for this session.';
    return `${what} Halved automatically after a few minutes of inactivity and restored on the`
        + ' first activity. Only applies to a zoomed (private) spectrum channel — the shared'
        + ' default channel is polled at a fixed rate for everyone on it.';
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

// `minimal` keeps the link block — what the two sockets are doing and what the
// spectrum view is set to — and drops the receiver's identity and the
// operator's blurb, which are read once and then known. See the registry's
// `minimal`.
export default function StatusPanel({ minimal }) {
    const { serverInfo, audioState, spectrumState, view, audioConn, spectrumConn, tuning } = useRadio();
    // Before the early return: hooks cannot be called conditionally.
    const audioRate = useThroughput(audioConn);
    const spectrumRate = useThroughput(spectrumConn);
    // 4 Hz: these change only on a mode change, so the meter rate the signal
    // panel needs would be wasted here.
    const m = useMeters(4);
    const iq = isIQ(tuning.mode);

    // The link block needs no /api/description, so the minimal view has
    // nothing to wait for.
    if (!serverInfo && !minimal) return <Empty>Loading receiver info…</Empty>;

    const rx = (serverInfo && serverInfo.receiver) || {};
    const gps = rx.gps || {};

    return (
        <div className="stack">
            {!minimal && serverInfo && (
                <>
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
                </>
            )}

            <div className="kv-list">
                <Row label="Audio link" value={<Link state={audioState} rate={audioRate} />} />
                {/* What the stream actually is, rather than what the mode
                    implies: 12 kHz mono on SSB, 24 on the AM family, and 10 kHz
                    stereo in IQ where the two channels are I and Q rather than
                    left and right. Out of the minimal view, which is the link
                    block on its own. */}
                {!minimal && (
                    <>
                        <Row
                            label="Audio rate"
                            title={rateNote(m)}
                            value={m.streamRate ? `${(m.streamRate / 1000).toFixed(m.streamRate % 1000 ? 1 : 0)} kHz` : '—'}
                        />
                        <Row
                            label="Audio channels"
                            value={m.channels
                                ? `${m.channels} (${m.channels === 2 ? (iq ? 'I/Q' : 'stereo') : 'mono'})`
                                : '—'}
                        />
                    </>
                )}
                <Row label="Spectrum link" value={<Link state={spectrumState} rate={spectrumRate} />} />
                <Row label="Span" value={view.span ? formatSpan(view.span) : '—'} />
                <Row label="Bins" value={view.binCount || '—'} />
                <Row label="Resolution" value={view.binBandwidth ? `${view.binBandwidth.toFixed(1)} Hz/bin` : '—'} />
                {/* The poll divisor: how often the server asks the receiver for
                    a frame, as a fraction of the full rate. Worth a line here
                    because nothing else on screen shows it and it changes on
                    its own — the idle watch halves it after a few minutes of
                    nothing and restores it on the first sign of life, which
                    otherwise reads as a waterfall that has quietly slowed down. */}
                <Row
                    label="Poll rate"
                    title={rateTitle(view.rateDivisor)}
                    value={rateLabel(view.rateDivisor)}
                />
            </div>

            {!minimal && serverInfo && serverInfo.description && (
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

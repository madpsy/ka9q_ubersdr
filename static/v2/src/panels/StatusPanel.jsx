import React from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Empty } from '../components/ui.jsx';
import { formatSpan } from '../lib/format.js';

function Row({ label, value }) {
    if (value == null || value === '') return null;
    return (
        <div className="kv">
            <span className="kv__k">{label}</span>
            <span className="kv__v">{value}</span>
        </div>
    );
}

export default function StatusPanel() {
    const { serverInfo, audioState, spectrumState, view } = useRadio();

    if (!serverInfo) return <Empty>Loading receiver info…</Empty>;

    const rx = serverInfo.receiver || {};
    const gps = rx.gps || {};

    return (
        <div className="stack">
            <div className="kv-list">
                <Row label="Callsign" value={rx.callsign} />
                <Row label="Antenna" value={rx.antenna} />
                <Row
                    label="Location"
                    value={gps.lat != null && gps.lon != null ? `${gps.lat.toFixed(3)}, ${gps.lon.toFixed(3)}` : null}
                />
                <Row label="Listeners" value={`${(serverInfo.max_clients || 0) - (serverInfo.available_clients || 0)} / ${serverInfo.max_clients || '?'}`} />
                <Row label="Version" value={serverInfo.version} />
            </div>

            <div className="divider" />

            <div className="kv-list">
                <Row label="Audio link" value={<span className={`state state--${audioState}`}>{audioState}</span>} />
                <Row label="Spectrum link" value={<span className={`state state--${spectrumState}`}>{spectrumState}</span>} />
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

// Doppler: what the ionosphere is doing to the time stations, in a dock column.
//
// A row per station — where its carrier is, how far that has moved from where it has
// been sitting, and how strong it is — over three figures saying whether the addon is
// actually hearing anything. The curves, the hour-long history, the CSV for HamSCI and
// the station configuration are all on the addon's own page, linked at the bottom.
//
// The reading and the baseline are shown together on purpose: see lib/doppler.js. On a
// receiver without a GPSDO the absolute figure is arbitrary and the departure from the
// baseline is the measurement, so a panel that showed only the first would be showing
// the one number that means nothing.
//
// `minimal` is the stations and nothing else — which is the panel, really; the figures
// above them are a summary of the rows underneath.

import React, { useCallback, useEffect, useRef, useState } from '../react.js';
import { Empty, Icon } from '../components/ui.jsx';
import { retryDelay } from '../lib/backoff.js';
import {
    SPECTRUM_INTERVAL_S, STATIONS_POLL_MS, addonUrl, applyReading, baselineShift,
    clientToken, dopplerAvailable, dopplerSummary, formatShift, isLive, normaliseStation,
    shiftBand, shiftSource, spectrumIntervalUrl, stationsUrl, streamUrl,
} from '../lib/doppler.js';
import { sinceLabel } from '../lib/format.js';

export { dopplerAvailable };

// How often the ages and the live count are recomputed.
const TICK_MS = 1000;

function Stat({ label, value, sub, tone }) {
    return (
        <div className="dp__stat">
            <span className="dp__stat-k">{label}</span>
            <span className={`dp__stat-v${tone ? ` is-${tone}` : ''}`}>{value}</span>
            {sub && <span className="dp__stat-s">{sub}</span>}
        </div>
    );
}

export default function DopplerPanel({ minimal }) {
    const [stations, setStations] = useState([]);
    const [state, setState] = useState('loading');   // loading | ok | error
    const [live, setLive] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    const alive = useRef(true);
    // One per mount, and the stream carries it: the addon uses it to find this
    // connection when the panel asks for slower spectrum frames.
    const token = useRef(clientToken());

    useEffect(() => () => { alive.current = false; }, []);

    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), TICK_MS);
        return () => clearInterval(id);
    }, []);

    // The stations: their configuration, and the hour-long baseline that the live
    // readings are measured against. Polled slowly — see STATIONS_POLL_MS.
    const loadStations = useCallback(() => {
        fetch(stationsUrl())
            .then((r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then((rows) => {
                if (!alive.current) return;
                const list = (Array.isArray(rows) ? rows : []).map(normaliseStation).filter(Boolean);
                // Merged rather than replaced: a station poll is up to a minute old by
                // the time the next one lands, and the stream has been updating these
                // rows every second in the meantime. Only the parts the stream does not
                // carry are taken from it.
                setStations((prev) => list.map((s) => {
                    const had = prev.find((p) => p.label === s.label);
                    return had && had.at > s.at ? { ...s, ...liveFields(had) } : s;
                }));
                setState('ok');
            })
            .catch(() => { if (alive.current) setState((st) => (st === 'ok' ? st : 'error')); });
    }, []);

    useEffect(() => {
        loadStations();
        const id = setInterval(loadStations, STATIONS_POLL_MS);
        return () => clearInterval(id);
    }, [loadStations]);

    // ── The stream ───────────────────────────────────────────────────────────
    //
    // Same policy as the other two addon panels: every failure closes it and reopens on
    // the shared backoff curve, so there is one schedule rather than the browser's
    // running alongside ours.
    useEffect(() => {
        let es = null;
        let retry = null;
        let attempts = 0;
        let stopped = false;

        const slowSpectrum = () => {
            // Best effort, and nothing depends on it: the panel draws no spectrum, so
            // the worst case of this failing is frames arriving that are thrown away.
            fetch(spectrumIntervalUrl(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ interval_s: SPECTRUM_INTERVAL_S, client_token: token.current }),
            }).catch(() => {});
        };

        const open = () => {
            es = new EventSource(streamUrl(token.current));

            es.addEventListener('open', () => { setLive(true); slowSpectrum(); });
            // Unnamed messages are the readings. The spectrum frames are named and are
            // deliberately not listened for.
            es.addEventListener('message', (e) => {
                attempts = 0;
                setLive(true);
                try {
                    const msg = JSON.parse(e.data);
                    setStations((prev) => applyReading(prev, msg));
                } catch (err) { /* not a reading */ }
            });
            es.addEventListener('connected', () => { attempts = 0; setLive(true); slowSpectrum(); });
            es.addEventListener('heartbeat', () => { attempts = 0; setLive(true); });

            es.addEventListener('error', () => {
                if (es) { es.close(); es = null; }
                setLive(false);
                if (stopped || retry) return;
                const wait = retryDelay(attempts);
                attempts++;
                retry = setTimeout(() => { retry = null; if (!stopped) open(); }, wait);
            });
        };

        open();
        return () => {
            stopped = true;
            clearTimeout(retry);
            if (es) es.close();
        };
    }, []);

    const sum = dopplerSummary(stations, now);
    const shown = stations.filter((s) => s.enabled);

    if (state === 'loading') return <Empty>Loading…</Empty>;

    return (
        <div className="stack dp">
            {!minimal && (
                <div className="dp__stats">
                    <Stat label="Stations" value={`${sum.live}/${sum.watching}`} sub="live" />
                    {/* The largest departure from a baseline anywhere on the receiver,
                        which is the one figure that says "something is happening" — a
                        flare moves every path at once. */}
                    <Stat
                        label="Shift"
                        value={formatShift(sum.biggest)}
                        sub="Hz"
                        tone={shiftBand(sum.biggest)}
                    />
                    <Stat
                        label="Best"
                        value={sum.bestSnr == null ? '—' : Math.round(sum.bestSnr)}
                        sub="dB"
                    />
                </div>
            )}

            {shown.length === 0 ? (
                <Empty>
                    {state === 'error'
                        ? 'The doppler addon is not answering.'
                        : 'No stations configured.'}
                </Empty>
            ) : (
                <ul className="dp__list">
                    {shown.map((s) => {
                        const d = baselineShift(s);
                        const on = isLive(s, now);
                        return (
                            <li key={s.id} className={`dp__row${on ? '' : ' is-stale'}`}>
                                <div className="dp__head">
                                    <span className="dp__name" title={`${s.label} · ${s.mhz} MHz`}>
                                        {s.label}
                                    </span>
                                    {s.reference && (
                                        <span className="dp__ref" title="Reference station — its drift is subtracted from the others">
                                            ref
                                        </span>
                                    )}
                                    <span className="dp__mhz">{s.mhz}</span>
                                    {/* The departure from the baseline is the reading
                                        that means something, so it is the one in the
                                        larger type — see the note at the top of
                                        lib/doppler.js. */}
                                    <span
                                        className={`dp__shift is-${shiftBand(d) || 'none'}`}
                                        title={shiftTitle(s, d)}
                                    >
                                        {d == null ? '—' : formatShift(d)}
                                    </span>
                                </div>
                                <div className="dp__sub">
                                    <span title={s.corrected != null
                                        ? 'Corrected against the reference station'
                                        : 'Raw offset — arbitrary without a GPSDO'}>
                                        {formatShift(s.doppler)}{s.corrected != null ? '*' : ''} Hz
                                    </span>
                                    {s.snr != null && <span>{Math.round(s.snr)} dB</span>}
                                    {/* Spread and scintillation only when the addon has
                                        enough samples to have worked them out; they are
                                        the ionosphere's texture rather than its
                                        position, and mean nothing half-computed. */}
                                    {s.spread != null && (
                                        <span title="Doppler spread — spread-F, multipath or rapid fading">
                                            σ{s.spread.toFixed(2)}
                                        </span>
                                    )}
                                    {s.s4 != null && s.s4 >= 0.2 && (
                                        <span title="Scintillation index">S4 {s.s4.toFixed(2)}</span>
                                    )}
                                    <span className="dp__age">{on ? sinceLabel(s.at, now) : 'no signal'}</span>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}

            {!minimal && (
                <div className="dp__foot">
                    <span className={`dp__live${live ? ' is-on' : ''}`}>
                        {live ? 'live' : 'reconnecting…'}
                    </span>
                    {/* The addon's page: the curves over hours, the CSV the HamSCI
                        experiment wants, and where stations are added. */}
                    <a
                        className="btn btn--ghost btn--sm"
                        href={addonUrl()}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        Open Doppler
                        <Icon.External size={13} />
                    </a>
                </div>
            )}
        </div>
    );
}

/**
 * What the figure in the big type means, said in a sentence.
 *
 * Three different claims wear the same number — see shiftSource — and the tooltip is
 * where the difference lives, because the column itself has room for five characters.
 */
function shiftTitle(s, d) {
    if (d == null) {
        return 'No baseline yet — the addon needs a few minutes of readings before a'
            + ' departure from one means anything, and the raw figure is an arbitrary'
            + ' clock offset until then.';
    }
    const src = shiftSource(s);
    if (src === 'reference') {
        return `The reference station's own error: ${formatShift(s.doppler)} Hz from where it`
            + ' should be. Zero is the receiver exactly on frequency.';
    }
    if (src === 'corrected') {
        return `${formatShift(s.doppler)} Hz, corrected against the reference station — an`
            + ' absolute figure, so zero is the carrier exactly where it belongs.';
    }
    return `${formatShift(s.doppler)} Hz against an hour's baseline of ${formatShift(s.baseline)} Hz.`;
}

// What the stream owns, and so what survives a station poll that is older than the last
// reading. Everything else — the frequency, the baseline, whether this is the reference
// — belongs to /api/stations.
function liveFields(s) {
    return {
        valid: s.valid,
        at: s.at,
        raw: s.raw,
        corrected: s.corrected,
        doppler: s.doppler,
        snr: s.snr,
        spread: s.spread,
        s4: s.s4,
    };
}

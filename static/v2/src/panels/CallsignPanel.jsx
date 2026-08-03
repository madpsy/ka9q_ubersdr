// Callsign lookup — the same job as v1's qrz_lookup widget, in the dock.
//
// Type a callsign, get who it is, where they are, how far away and which way to
// point. The widget is a draggable HUD with its own chrome and its own copy of
// the geometry; this reuses v2's controls and keeps the maths in lib/callsign.js
// where it can be tested.
//
// Two server rules drive most of the states here:
//
//   * /api/lookup needs an *active audio session*, not just a registered UUID,
//     so nothing works until the receiver is running. The panel says that
//     rather than showing the raw 401.
//   * lookups are rate limited per UUID, with cache hits allowed ten times the
//     rate. Repeating a callsign is nearly free; a burst of new ones is not.
//
// Only mounted when /api/description reports lookup_service — see registry.jsx.

import React, { useEffect, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { getSessionId } from '../radio/session.js';
import { Button, Empty, Icon, Modal } from '../components/ui.jsx';
import { countryFlag } from '../lib/format.js';
import {
    displayName, distanceBearing, isValidCallsign, lookupCallsignData,
    normaliseCallsign, onLookupRequest, positionOf,
} from '../lib/callsign.js';
import { openCallsignLookup } from '../compat/legacyBridge.js';

const ROTCTL_PW = 'rotctl_password';

// Local time at the operator's position.
//
// tz_iana is only supplied when the provider's position is precise enough to
// sit inside the right zone — a DXCC or state centroid is refused server-side —
// so its absence means "do not claim to know their local time". The provider's
// own gmtoffset is deliberately unused: it is a whole-hour integer that cannot
// express +5:30 or +5:45, and its DST flag carries no switchover dates.
function LocalTime({ tz }) {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        if (!tz) return undefined;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [tz]);

    if (!tz) return null;

    let time = '';
    let offset = '';
    try {
        time = new Intl.DateTimeFormat([], {
            timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        }).format(now);
        // Intl reports this as "GMT+5:45"; ham convention is UTC.
        const parts = new Intl.DateTimeFormat([], { timeZone: tz, timeZoneName: 'shortOffset' })
            .formatToParts(now);
        const tzName = parts.find((p) => p.type === 'timeZoneName');
        if (tzName) offset = tzName.value.replace(/^GMT/, 'UTC');
    } catch (e) {
        return null;   // unknown zone, or a browser without shortOffset
    }

    return (
        <div className="kv">
            <span className="kv__k">Local time</span>
            <span className="kv__v" title={tz}>{time}{offset ? ` (${offset})` : ''}</span>
        </div>
    );
}

// Distance and bearing from this receiver, plus a one-click rotate when the
// rotator is enabled and a password is already stored. No password prompt here:
// the widget gates the button the same way, and the Rotator panel is where
// authenticating belongs.
function Beam({ position, serverInfo }) {
    const [sent, setSent] = useState(false);
    const gps = (serverInfo && serverInfo.receiver && serverInfo.receiver.gps) || {};
    const rotator = !!(serverInfo && serverInfo.rotator && serverInfo.rotator.enabled);

    let stored = '';
    try { stored = localStorage.getItem(ROTCTL_PW) || ''; } catch (e) { /* private mode */ }

    // 0,0 is the config default, not a position — a bearing from it is fiction.
    if (!position || (!gps.lat && !gps.lon)) return null;
    const db = distanceBearing(gps.lat, gps.lon, position.lat, position.lon);
    if (!db) return null;

    const rotate = () => {
        fetch('/api/rotctl/position', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: stored, azimuth: db.bearing }),
        }).then((r) => {
            if (r.status === 401) localStorage.removeItem(ROTCTL_PW);
            else setSent(true);
        }).catch(() => { /* the rotator panel is where errors are surfaced */ });
    };

    return (
        <div className="kv">
            <span className="kv__k">Distance</span>
            <span className="kv__v cs-beam">
                <span title={position.fromGrid ? 'Estimated from the grid square' : undefined}>
                    {db.distKm.toLocaleString()} km · {db.bearing}°{position.fromGrid ? ' ~' : ''}
                </span>
                {rotator && stored && (
                    <button
                        type="button"
                        className="chip chip--button"
                        title={`Rotate the antenna to ${db.bearing}°`}
                        onClick={rotate}
                    >
                        {sent ? '✓' : 'Point'}
                    </button>
                )}
            </span>
        </div>
    );
}

function Result({ call, data, serverInfo }) {
    const [photo, setPhoto] = useState(false);
    const name = displayName(data);
    const cty = data.cty || {};
    const country = data.country || cty.country || '';
    const flag = countryFlag(cty.country_code);
    const position = positionOf(data);

    return (
        <div className="cs-result">
            <div className="cs-result__head">
                <a
                    className="cs-result__call"
                    href={`https://www.qrz.com/db/${encodeURIComponent(call)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open on QRZ.com"
                >
                    {call}
                </a>
                {name && <span className="cs-result__name">{name}</span>}
            </div>

            <div className="kv-list">
                {country && (
                    <div className="kv">
                        <span className="kv__k">Country</span>
                        <span className="kv__v">{flag ? `${flag} ${country}` : country}</span>
                    </div>
                )}
                {data.grid && (
                    <div className="kv">
                        <span className="kv__k">Grid</span>
                        <span className="kv__v">{data.grid}</span>
                    </div>
                )}
                {cty.continent && (
                    <div className="kv">
                        <span className="kv__k">Continent</span>
                        <span className="kv__v">
                            {cty.continent}
                            {cty.cq_zone ? ` · CQ ${cty.cq_zone}` : ''}
                            {cty.itu_zone ? ` · ITU ${cty.itu_zone}` : ''}
                        </span>
                    </div>
                )}
                <LocalTime tz={data.tz_iana} />
                <Beam position={position} serverInfo={serverInfo} />
                {data.class && (
                    <div className="kv">
                        <span className="kv__k">Licence</span>
                        <span className="kv__v">{data.class}</span>
                    </div>
                )}
            </div>

            {/* Served through the same origin: the server rewrites the
                provider's URL to /api/lookup/image/<uuid> (lookup_image_proxy.go),
                so no request leaves for a third party.

                The thumbnail is deliberately small — most of these are portraits
                or shack photos and the panel is not a gallery — so clicking
                opens it full size rather than sending anyone to a new tab. */}
            {data.image && (
                <button
                    type="button"
                    className="cs-photo"
                    title="Show full size"
                    onClick={() => setPhoto(true)}
                >
                    <img src={data.image} alt={call} loading="lazy" />
                </button>
            )}

            {photo && data.image && (
                <Modal onClose={() => setPhoto(false)} label={`${call} photo`}>
                    <img className="cs-photo-full" src={data.image} alt={call} />
                </Modal>
            )}
        </div>
    );
}

export default function CallsignPanel() {
    const { serverInfo, running } = useRadio();
    const [entry, setEntry] = useState('');
    const [call, setCall] = useState('');
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const inputRef = useRef(null);
    // Guards against an earlier, slower lookup overwriting a later one.
    const seq = useRef(0);

    const run = (raw) => {
        const c = normaliseCallsign(raw);
        setEntry(c);
        if (!c) return;
        if (!isValidCallsign(c)) {
            setError('That does not look like a callsign.');
            setData(null);
            setCall('');
            return;
        }

        const mine = ++seq.current;
        setBusy(true);
        setError('');
        setCall(c);
        lookupCallsignData(c, getSessionId())
            .then((d) => { if (mine === seq.current) { setData(d); setError(''); } })
            .catch((err) => {
                if (mine !== seq.current) return;
                setData(null);
                setError(err.message || String(err));
            })
            .finally(() => { if (mine === seq.current) setBusy(false); });
    };

    // Clicking a spot elsewhere (the voice activity panel) lands here.
    useEffect(() => onLookupRequest((c) => {
        run(c);
        // Bring the field in step, so the box shows what is on screen.
        if (inputRef.current) inputRef.current.value = c;
    }), []);

    return (
        <div className="stack cs">
            <form
                className="cs-form"
                onSubmit={(e) => { e.preventDefault(); run(entry); }}
            >
                <input
                    ref={inputRef}
                    className="input cs-form__input"
                    type="search"
                    placeholder="Callsign…"
                    autoComplete="off"
                    spellCheck="false"
                    value={entry}
                    onChange={(e) => setEntry(e.target.value.toUpperCase())}
                />
                <Button
                    type="submit"
                    size="sm"
                    variant="primary"
                    icon={<Icon.Search />}
                    disabled={busy || !entry.trim()}
                    title="Look up"
                />
                {/* The v1 page, which carries the bio, the map and the QSL
                    details this panel does not. Whatever is in the box goes
                    with it. Icon only — it sits next to the primary action and
                    a second label would compete with it. */}
                <Button
                    size="sm"
                    variant="ghost"
                    icon={<Icon.External />}
                    title="Open the full callsign lookup page"
                    onClick={() => openCallsignLookup({
                        uuid: getSessionId(),
                        callsign: isValidCallsign(normaliseCallsign(entry)) ? entry : '',
                    })}
                />
            </form>

            {!running && (
                <div className="note note--tight">
                    Start the receiver — lookups need an active audio session.
                </div>
            )}

            {error && <div className="note note--warn">{error}</div>}

            {busy && !data && <Empty>Looking up {call}…</Empty>}

            {!busy && !data && !error && running && (
                <Empty>Enter a callsign to look it up.</Empty>
            )}

            {data && <Result call={call} data={data} serverInfo={serverInfo} />}
        </div>
    );
}

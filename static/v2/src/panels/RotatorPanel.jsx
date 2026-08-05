// Rotator — the v1 control panel's "🧭 Rotator" tab as a dock panel.
//
// Same endpoints as static/rotator-ui.js: /api/rotctl/status polled once a
// second, a bearing sent as POST /api/rotctl/position {password, azimuth},
// and the country bearings from /api/rotctl/countries used to say what the
// beam is pointing at. v1 puts those countries on a d3 azimuthal map you click
// to rotate; a dock panel is too narrow for that map, so the same two jobs —
// see where the beam is, click a direction to move it — are done on a compass
// dial, with the countries inside the beam listed underneath.
//
// Only mounted when /api/description reports rotator.enabled — see the
// registry's `requires`.

import React, { useCallback, useEffect, useRef, useState } from '../react.js';
import { Empty, Icon } from '../components/ui.jsx';
import { useLayout } from '../layout/LayoutContext.jsx';
import { loadScripts } from '../lib/loadScript.js';
import { PasswordRow, usePassword } from './hardwareAuth.jsx';

const POLL_MS = 1000;

// v1's azimuthal map, reused verbatim: static/rotator-display.js draws it with
// d3 and topojson, emits 'rotator-map-click' with a bearing, and takes azimuth
// and cone-marker updates through method calls. It needs a square of real
// estate, so it appears only when this panel is floating and has been resized
// big enough — in a dock the compass dial stands in for it.
const MAP_SCRIPTS = ['/d3.v7.min.js', '/d3-geo.v3.min.js', '/topojson.v3.min.js', '/rotator-display.js'];
const MAP_ID = 'v2-rotator-map';
const MAP_MIN = 260;        // px; below this the map is unreadable
const MAP_STEP = 20;        // quantise so a resize drag rebuilds a few times, not every pixel
const MAP_CHROME_H = 132;   // px of panel used by the header, readout and controls

let buildSeq = 0;           // makes each map container id unique — see below
const BEAM_WIDTH = 45;      // degrees, as in v1's RotatorDisplay
const R = 100;              // dial radius in SVG units
const CARDINALS = [['N', 0], ['E', 90], ['S', 180], ['W', 270]];

// Compass angles: 0° is up and increases clockwise, unlike SVG's maths angles.
const pt = (deg, radius) => {
    const a = (deg - 90) * Math.PI / 180;
    return [R + radius * Math.cos(a), R + radius * Math.sin(a)];
};

// Shortest signed distance from `a` to `b` on a circle, in degrees.
const delta = (a, b) => {
    let d = ((b - a + 540) % 360) - 180;
    return d;
};

function beamPath(azimuth) {
    const half = BEAM_WIDTH / 2;
    const [x0, y0] = pt(azimuth - half, R - 12);
    const [x1, y1] = pt(azimuth + half, R - 12);
    return `M ${R} ${R} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R - 12} ${R - 12} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
}

// `minimal` keeps where the beam is pointing and the two things you might need
// in a hurry: clicking a bearing on the dial, and Stop. What goes is the setup
// and the reference — the typed-bearing entry, the link to v1's full map page,
// the note about floating the panel to get the azimuthal map, and the list of
// countries in the beam. Stop stays because the dial does not: a rotation you
// can start with one click and cannot stop is worse than no control at all.
export default function RotatorPanel({ minimal }) {
    const [status, setStatus] = useState(null);
    const [countries, setCountries] = useState([]);
    const [target, setTarget] = useState(null);      // last bearing we asked for
    const [entry, setEntry] = useState('');          // the bearing input box
    const [pending, setPending] = useState(null);    // bearing awaiting a password
    const [error, setError] = useState('');
    const [selected, setSelected] = useState(null);  // country picked on the map
    const [mapFailed, setMapFailed] = useState(false);
    const { password, save, clear } = usePassword('rotctl_password');
    const { floats } = useLayout();

    const pwRef = useRef(password);
    pwRef.current = password;
    const dialRef = useRef(null);
    const mapHost = useRef(null);
    const displayRef = useRef(null);
    const countriesRef = useRef(countries);
    countriesRef.current = countries;
    const selectedRef = useRef(selected);
    selectedRef.current = selected;

    // The floating window's stored geometry is the size to draw at — measuring
    // the container instead would feed the map's own size back into the
    // observer. 0 means "not floating, or too small": show the dial.
    const geom = floats.rotator;
    const raw = geom ? Math.min(geom.w - 26, geom.h - MAP_CHROME_H) : 0;
    const mapSize = !mapFailed && raw >= MAP_MIN ? Math.round(raw / MAP_STEP) * MAP_STEP : 0;

    useEffect(() => {
        let cancelled = false;
        const load = () => fetch('/api/rotctl/status')
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (!cancelled && d) setStatus(d); })
            .catch(() => { if (!cancelled) setStatus((s) => ({ ...(s || {}), connected: false })); });
        load();
        const id = setInterval(load, POLL_MS);
        return () => { cancelled = true; clearInterval(id); };
    }, []);

    useEffect(() => {
        let cancelled = false;
        fetch('/api/rotctl/countries')
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (!cancelled && d && d.success && d.countries) setCountries(d.countries); })
            .catch(() => { /* the beam readout just stays empty */ });
        return () => { cancelled = true; };
    }, []);

    // Build (and rebuild, on resize) the v1 map. The delay collapses a resize
    // drag into one build; the scripts and the 110m world file are fetched once
    // and cached by loadScripts and the browser.
    useEffect(() => {
        if (!mapSize) return undefined;
        let cancelled = false;
        let display = null;

        const timer = setTimeout(async () => {
            try {
                await loadScripts(MAP_SCRIPTS);
            } catch (e) {
                if (!cancelled) setMapFailed(true);
                return;
            }
            // `class RotatorDisplay` in a classic script is a global lexical
            // binding, not a window property, so it is read as a free variable.
            const Ctor = typeof RotatorDisplay !== 'undefined' ? RotatorDisplay : null;
            if (cancelled || !mapHost.current) return;
            if (!Ctor) { setMapFailed(true); return; }

            // A fresh id per build: RotatorDisplay.init() is async, and an
            // instance abandoned mid-build looks its container up by id, so
            // renaming it makes that instance a no-op instead of letting it
            // paint into the map that replaced it.
            const cid = `${MAP_ID}-${(buildSeq += 1)}`;
            mapHost.current.id = cid;
            mapHost.current.innerHTML = '';
            display = new Ctor({
                containerId: cid,
                showMap: true,
                showCompass: false,
                showControls: false,
                showPassword: false,
                mapSize,
                updateInterval: 0,   // this panel already polls; feed it instead
            });
            displayRef.current = display;
            if (countriesRef.current.length) display.setCountriesData(countriesRef.current);
        }, 220);

        return () => {
            cancelled = true;
            clearTimeout(timer);
            if (display) display.destroy();
            if (displayRef.current === display) displayRef.current = null;
            if (mapHost.current) mapHost.current.innerHTML = '';
        };
    }, [mapSize]);

    // Push azimuth and cone markers into the map, the way v1's control panel
    // does on every status update.
    useEffect(() => {
        const d = displayRef.current;
        if (!d || !status || !status.position || status.position.azimuth == null) return;
        const az = status.position.azimuth;
        d.updateAzimuthDisplay(az);
        if (!countries.length) return;
        if (selected) d.showCountryMarker(selected.name, selected.bearing, selected.distance_km, countries, az);
        else d.updateConeMarkers(countries, az);
    }, [status, countries, selected, mapSize]);

    useEffect(() => {
        if (!mapSize) return undefined;
        const onMapClick = (e) => {
            const detail = e.detail || {};
            if (detail.bearing == null) return;
            const d = displayRef.current;
            if (d && countriesRef.current.length) {
                const c = d.findClosestCountry(detail.bearing, detail.distance);
                if (c) setSelected(c);
            }
            runRef.current(detail.bearing);
        };
        document.addEventListener('rotator-map-click', onMapClick);
        return () => document.removeEventListener('rotator-map-click', onMapClick);
    }, [mapSize]);

    const move = useCallback(async (bearing, pw) => {
        try {
            const resp = await fetch('/api/rotctl/position', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: pw, azimuth: bearing }),
            });
            const d = await resp.json().catch(() => ({}));
            if (resp.status === 401 || (d.error && String(d.error).toLowerCase().includes('password'))) {
                clear();
                setPending(bearing);
                setError('Incorrect password');
                return;
            }
            if (!resp.ok || d.success === false) {
                setError(d.error || 'Rotator refused the command');
                return;
            }
            setError('');
            setTarget(bearing);
        } catch (e) {
            setError('Command failed');
        }
    }, [clear]);

    const run = useCallback((bearing) => {
        const b = ((Math.round(bearing) % 360) + 360) % 360;
        if (!pwRef.current) {
            setPending(b);
            setError('');
            return;
        }
        move(b, pwRef.current);
    }, [move]);

    // The map's click listener is bound once per map build, so it reaches the
    // current handler through a ref rather than re-binding on every render.
    const runRef = useRef(run);
    runRef.current = run;

    const command = useCallback(async (cmd) => {
        if (!pwRef.current) { setPending({ command: cmd }); setError(''); return; }
        try {
            const resp = await fetch('/api/rotctl/command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: pwRef.current, command: cmd }),
            });
            if (resp.status === 401) { clear(); setPending({ command: cmd }); setError('Incorrect password'); }
        } catch (e) {
            setError('Command failed');
        }
    }, [clear]);

    // Bearing of the pointer within the dial, taken from its centre.
    const bearingAt = (e) => {
        const el = dialRef.current;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        if (!dx && !dy) return null;
        return (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
    };

    if (!status) return <Empty>Loading rotator…</Empty>;

    const azimuth = status.position && status.position.azimuth != null ? status.position.azimuth : 0;
    const readOnly = !!status.read_only;

    // Which countries the beam currently covers — v1 draws these as cone
    // markers around the map edge; here they are a list, nearest bearing first.
    const inBeam = countries
        .map((c) => ({ ...c, off: Math.abs(delta(azimuth, c.bearing)) }))
        .filter((c) => c.off <= BEAM_WIDTH / 2)
        .sort((a, b) => a.off - b.off)
        .slice(0, 8);

    return (
        <div className="stack">
            <div className="rot-head">
                <span className={`dot dot--${status.connected ? (status.moving ? 'warn' : 'good') : 'bad'}`} />
                <span className="rot-head__az">{Math.round(azimuth)}°</span>
                <span className="rot-head__state">
                    {!status.connected ? 'disconnected' : status.moving ? 'moving' : 'idle'}
                </span>
            </div>

            {mapSize > 0 ? (
                <div
                    ref={mapHost}
                    className="rot-map"
                    style={{ width: mapSize, height: mapSize }}
                />
            ) : (
            <svg
                ref={dialRef}
                className={`rot-dial${readOnly ? ' is-readonly' : ''}`}
                viewBox="0 0 200 200"
                role="button"
                aria-label="Click a bearing to rotate"
                onClick={(e) => {
                    if (readOnly) return;
                    const b = bearingAt(e);
                    if (b != null) run(b);
                }}
            >
                <circle className="rot-dial__face" cx={R} cy={R} r={R - 2} />
                <path className="rot-dial__beam" d={beamPath(azimuth)} />

                {Array.from({ length: 12 }, (_, i) => i * 30).map((deg) => {
                    const [x0, y0] = pt(deg, R - 4);
                    const [x1, y1] = pt(deg, deg % 90 === 0 ? R - 14 : R - 9);
                    return <line key={deg} className="rot-dial__tick" x1={x0} y1={y0} x2={x1} y2={y1} />;
                })}

                {CARDINALS.map(([label, deg]) => {
                    const [x, y] = pt(deg, R - 26);
                    return (
                        <text key={label} className="rot-dial__card" x={x} y={y} dominantBaseline="middle" textAnchor="middle">
                            {label}
                        </text>
                    );
                })}

                {target != null && Math.abs(delta(azimuth, target)) > 1 && (
                    <line
                        className="rot-dial__target"
                        x1={R} y1={R}
                        x2={pt(target, R - 16)[0]} y2={pt(target, R - 16)[1]}
                    />
                )}

                <line
                    className="rot-dial__needle"
                    x1={R} y1={R}
                    x2={pt(azimuth, R - 16)[0]} y2={pt(azimuth, R - 16)[1]}
                />
                <circle className="rot-dial__hub" cx={R} cy={R} r="4.5" />
            </svg>
            )}

            {!minimal && mapSize === 0 && !readOnly && (
                <div className="note note--tight">
                    {mapFailed
                        ? 'Azimuthal map unavailable — using the compass.'
                        : 'Float this panel and enlarge it for the azimuthal map.'}
                </div>
            )}

            {readOnly ? (
                !minimal && <div className="note note--tight">👁 View only — no rotator password configured.</div>
            ) : (
                <div className="rot-entry">
                    {!minimal && (
                        <>
                            <input
                                className="input rot-entry__input"
                                type="number"
                                min="0"
                                max="359"
                                placeholder="Bearing°"
                                value={entry}
                                onChange={(e) => setEntry(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key !== 'Enter') return;
                                    const v = parseFloat(entry);
                                    if (Number.isFinite(v)) { run(v); setEntry(''); }
                                }}
                            />
                            <button
                                type="button"
                                className="btn btn--primary btn--sm"
                                onClick={() => {
                                    const v = parseFloat(entry);
                                    if (Number.isFinite(v)) { run(v); setEntry(''); }
                                }}
                            >
                                Go
                            </button>
                        </>
                    )}
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => command('stop')}>Stop</button>
                    {!minimal && (
                        <a className="btn btn--ghost btn--sm" href="/rotator.html" target="_blank" rel="noopener noreferrer">
                            Map <Icon.External size={12} />
                        </a>
                    )}
                </div>
            )}

            {pending != null && (
                <PasswordRow
                    error={error}
                    onSubmit={(pw) => {
                        save(pw);
                        const p = pending;
                        setPending(null);
                        if (typeof p === 'number') move(p, pw);
                        else fetch('/api/rotctl/command', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ password: pw, command: p.command }),
                        }).catch(() => setError('Command failed'));
                    }}
                    onCancel={() => { setPending(null); setError(''); }}
                />
            )}

            {error && pending == null && <div className="note note--warn">{error}</div>}

            {!minimal && inBeam.length > 0 && (
                <>
                    <div className="divider" />
                    <span className="section-label">In the beam</span>
                    <div className="rot-beam">
                        {inBeam.map((c) => (
                            <button
                                key={c.name}
                                type="button"
                                className="chip chip--button"
                                title={`${c.name} — ${c.bearing}°, ${Math.round(c.distance_km)} km`}
                                disabled={readOnly}
                                onClick={() => run(c.bearing)}
                            >
                                {c.name} <span className="rot-beam__deg">{c.bearing}°</span>
                            </button>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}

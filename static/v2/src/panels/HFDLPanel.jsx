// HFDL: aeroplanes on shortwave, on a map.
//
// The panel is the map and three figures. Clicking it opens the same map several times
// the size with the aircraft beside it — flight, frequency, altitude, which ground
// station it was talking to and how long ago — and that is where it stops. The addon's
// own dashboard has the per-frequency statistics, the network topology, propagation, the
// message feed and the frequency configuration, and every one of those is a page in
// itself; both the panel and the modal link to it rather than reproducing any of it.
//
// The map is lib/worldMap.js, shared with the Countries game: the same projection and
// the same coastlines, fetched once for the page.
//
// `minimal` is the map alone — which is most of the point of the panel, and the reason
// it has a minimal view at all.

import React, { useCallback, useEffect, useMemo, useRef, useState } from '../react.js';
import { Button, Empty, Icon, Modal } from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { sinceLabel } from '../lib/format.js';
import { arcVisible, loadWorldArcs, project } from '../lib/worldMap.js';
import {
    MODAL_POLL_MS, POLL_MS, addonUrl, aircraftUrl, altLabel, freqLabel, hfdlAvailable,
    aircraftLabel, hfdlSummary, isStale, liveAircraft, stationList, stationOf, stationsUrl,
    statsUrl,
} from '../lib/hfdl.js';

export { hfdlAvailable };

// The map, in CSS pixels. 2:1 because that is the shape of the world in this projection
// — anything else is either empty ocean at the sides or the poles cropped off.
const MAP_W = 320;
const MAP_H = 160;
const BIG_W = 900;
const BIG_H = 450;

// How many aircraft the modal lists. Twenty is a busy night on HF and a table that still
// fits without scrolling into next week; the rest are on the map and on the dashboard.
const TABLE_ROWS = 20;

/**
 * The map.
 *
 * Whole world, no panning, no zoom. This is a picture of where the traffic is rather
 * than a chart to navigate — HFDL is intercontinental by nature, so the interesting
 * thing is always the spread, and pan-and-zoom on a 320-pixel map is a control that gets
 * in the way of the one thing it is for. The modal is the zoom.
 */
function Map({ w, h, arcs, aircraft, stations, me, now, pick, picked }) {
    const canvas = useRef(null);
    // Whole-world view: the projection takes one, and this one never changes.
    const view = useMemo(() => ({ lon: 0, lat: 0, z: 1 }), []);
    const hits = useRef([]);

    useEffect(() => {
        const el = canvas.current;
        if (!el) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        if (el.width !== Math.round(w * dpr)) {
            el.width = Math.round(w * dpr);
            el.height = Math.round(h * dpr);
        }
        const c = el.getContext('2d');
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.clearRect(0, 0, w, h);

        const css = getComputedStyle(document.documentElement);
        const ink = css.getPropertyValue('--text-faint').trim() || '#5c6779';
        const accent = css.getPropertyValue('--accent').trim() || '#08a2fb';
        const warn = css.getPropertyValue('--warn').trim() || '#f2b544';
        const good = css.getPropertyValue('--good').trim() || '#45d69a';

        // Coastlines first and faint: they are the reference, not the subject.
        if (arcs) {
            c.strokeStyle = ink;
            c.globalAlpha = 0.5;
            c.lineWidth = 0.7;
            c.beginPath();
            for (const arc of arcs) {
                if (!arcVisible(arc, view, w, h)) continue;
                let prevLon = null;
                for (let i = 0; i < arc.pts.length; i += 2) {
                    const lon = arc.pts[i];
                    const lat = arc.pts[i + 1];
                    const [x, y] = project(lon, lat, view, w, h);
                    // A jump of more than half the world is the antimeridian: break the
                    // path rather than drawing a line across the Pacific.
                    if (prevLon === null || Math.abs(lon - prevLon) > 180) c.moveTo(x, y);
                    else c.lineTo(x, y);
                    prevLon = lon;
                }
            }
            c.stroke();
            c.globalAlpha = 1;
        }

        // The ground stations. Squares, because they are the fixed points — an aircraft
        // is a dot and a station is a place, and the shape says which without a legend.
        for (const s of stations) {
            const [x, y] = project(s.lon, s.lat, view, w, h);
            c.fillStyle = s.active ? good : ink;
            c.globalAlpha = s.active ? 0.9 : 0.5;
            c.fillRect(x - 2, y - 2, 4, 4);
        }
        c.globalAlpha = 1;

        // This receiver, if it has told us where it is: the map means more with the
        // paths on it measured from somewhere.
        if (me) {
            const [x, y] = project(me.lon, me.lat, view, w, h);
            c.strokeStyle = accent;
            c.lineWidth = 1.2;
            c.beginPath();
            c.moveTo(x - 4, y);
            c.lineTo(x + 4, y);
            c.moveTo(x, y - 4);
            c.lineTo(x, y + 4);
            c.stroke();
        }

        // The aircraft, last so nothing is drawn over them.
        hits.current = [];
        const r = w > 500 ? 3.2 : 2.4;
        for (const a of aircraft) {
            const [x, y] = project(a.lon, a.lat, view, w, h);
            const stale = isStale(a, now);
            c.globalAlpha = stale ? 0.4 : 1;
            c.fillStyle = stale ? warn : accent;
            c.beginPath();
            c.arc(x, y, picked && picked.key === a.key ? r + 1.6 : r, 0, Math.PI * 2);
            c.fill();
            // A heading tick where the aircraft reported a track. Short: it says which
            // way, not how fast, and a long one on a small map is a line to nowhere.
            if (a.track != null) {
                const rad = (a.track - 90) * (Math.PI / 180);
                c.strokeStyle = c.fillStyle;
                c.lineWidth = 1;
                c.beginPath();
                c.moveTo(x, y);
                c.lineTo(x + Math.cos(rad) * (r + 4), y + Math.sin(rad) * (r + 4));
                c.stroke();
            }
            if (picked && picked.key === a.key) {
                c.strokeStyle = accent;
                c.lineWidth = 1;
                c.beginPath();
                c.arc(x, y, r + 4, 0, Math.PI * 2);
                c.stroke();
            }
            hits.current.push({ x, y, a });
        }
        c.globalAlpha = 1;

        // Labels, and only in the big map: at 320 px they overlap into a smear, and the
        // modal has the table for the detail anyway.
        if (w > 500) {
            c.font = '10px ui-monospace, monospace';
            c.textBaseline = 'bottom';
            c.textAlign = 'center';
            c.fillStyle = ink;
            for (const s of stations) {
                if (!s.active) continue;
                const [x, y] = project(s.lon, s.lat, view, w, h);
                c.fillText(s.name.slice(0, 14), x, y - 4);
            }
        }
    }, [w, h, arcs, aircraft, stations, me, now, view, picked]);

    // Nearest aircraft to the click, within a few pixels. Only in the modal, where there
    // is a table for it to select in.
    const onClick = pick ? (e) => {
        const rect = canvas.current.getBoundingClientRect();
        const x = (e.clientX - rect.left) * (w / rect.width);
        const y = (e.clientY - rect.top) * (h / rect.height);
        let best = null;
        let bestD = 12;
        for (const hit of hits.current) {
            const d = Math.hypot(hit.x - x, hit.y - y);
            if (d < bestD) { bestD = d; best = hit.a; }
        }
        pick(best);
    } : undefined;

    return (
        <canvas
            ref={canvas}
            className="hf__map"
            style={{ aspectRatio: `${w} / ${h}` }}
            onClick={onClick}
        />
    );
}

export default function HFDLPanel({ minimal }) {
    const { serverInfo } = useRadio();
    const [arcs, setArcs] = useState(null);
    const [aircraft, setAircraft] = useState([]);
    const [stations, setStations] = useState([]);
    const [stats, setStats] = useState(null);
    const [state, setState] = useState('loading');   // loading | ok | error
    const [now, setNow] = useState(() => Date.now());
    const [open, setOpen] = useState(false);
    const [picked, setPicked] = useState(null);
    const alive = useRef(true);

    useEffect(() => () => { alive.current = false; }, []);

    useEffect(() => { loadWorldArcs().then((a) => { if (alive.current) setArcs(a); }); }, []);

    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 15000);
        return () => clearInterval(id);
    }, []);

    const poll = useCallback((withStats) => {
        fetch(aircraftUrl())
            .then((r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then((rows) => {
                if (!alive.current) return;
                setAircraft(liveAircraft(rows));
                setState('ok');
            })
            .catch(() => {
                if (!alive.current) return;
                // A failed poll leaves the map as it was: those aircraft were where they
                // were, and they age out on their own — see DROP_MS.
                setState((s) => (s === 'ok' ? s : 'error'));
            });
        // Only for the modal, and only for two figures: /stats is the addon's whole
        // per-frequency picture and the panel needs none of it.
        if (withStats) {
            fetch(statsUrl())
                .then((r) => (r.ok ? r.json() : null))
                .then((j) => { if (alive.current && j) setStats(j); })
                .catch(() => {});
        }
    }, []);

    // The stations move when the addon is restarted and not otherwise, so once is enough.
    useEffect(() => {
        fetch(stationsUrl())
            .then((r) => (r.ok ? r.json() : null))
            .then((rows) => { if (alive.current && rows) setStations(stationList(rows)); })
            .catch(() => { /* the map still works without them */ });
    }, []);

    useEffect(() => {
        poll(open);
        const id = setInterval(() => poll(open), open ? MODAL_POLL_MS : POLL_MS);
        return () => clearInterval(id);
    }, [poll, open]);

    // Where this receiver is, so the map has an origin. Absent on an instance that has
    // not set its position, which is why nothing depends on it.
    const gps = (serverInfo && serverInfo.receiver && serverInfo.receiver.gps) || {};
    const me = (gps.lat || gps.lon) ? { lat: Number(gps.lat), lon: Number(gps.lon) } : null;

    const sum = hfdlSummary(aircraft, stats, now);

    if (state === 'loading') return <Empty>Loading…</Empty>;
    if (state === 'error' && !aircraft.length) {
        return <Empty>The HFDL addon is not answering.</Empty>;
    }

    return (
        <div className="stack hf">
            {/* The map is the button: there is nothing else on it to click, and a
                separate "expand" control would be a second thing to aim at. */}
            <button
                type="button"
                className="hf__open"
                onClick={() => setOpen(true)}
                title="Open the map full size"
            >
                <Map
                    w={MAP_W}
                    h={MAP_H}
                    arcs={arcs}
                    aircraft={aircraft}
                    stations={stations}
                    me={me}
                    now={now}
                />
            </button>

            {!minimal && (
                <div className="hf__stats">
                    <span>
                        <b>{sum.fresh}</b> aircraft
                        {sum.count > sum.fresh && <i> +{sum.count - sum.fresh} older</i>}
                    </span>
                    {sum.busiest > 0 && (
                        <span title={`${sum.onBusiest} aircraft heard on this frequency`}>
                            {freqLabel(sum.busiest)}
                        </span>
                    )}
                </div>
            )}

            {!minimal && (
                <div className="row-end">
                    <a
                        className="btn btn--ghost btn--sm"
                        href={addonUrl()}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        Open HFDL
                        <Icon.External size={13} />
                    </a>
                </div>
            )}

            {open && (
                <Modal onClose={() => setOpen(false)} label="HFDL aircraft">
                    <div className="hf__full">
                        <Map
                            w={BIG_W}
                            h={BIG_H}
                            arcs={arcs}
                            aircraft={aircraft}
                            stations={stations}
                            me={me}
                            now={now}
                            pick={setPicked}
                            picked={picked}
                        />

                        <div className="hf__legend">
                            <span><i className="hf__dot" /> aircraft</span>
                            <span><i className="hf__dot is-stale" /> no report for 30 min</span>
                            <span><i className="hf__sq" /> ground station</span>
                            {me && <span><i className="hf__me" /> this receiver</span>}
                            {sum.messages != null && (
                                <span className="hf__msgs">{sum.messages.toLocaleString()} messages decoded</span>
                            )}
                        </div>

                        {/* The aircraft themselves. Clicking the map picks one out here
                            and clicking a row marks it on the map — the two are the same
                            list seen twice, and matching them up by eye across a world
                            map is the thing that needs help. */}
                        {aircraft.length === 0 ? (
                            <Empty>Nothing heard yet.</Empty>
                        ) : (
                            <div className="hf__table">
                                <table>
                                    <thead>
                                        <tr>
                                            <th>Flight</th>
                                            <th>Freq</th>
                                            <th>Alt</th>
                                            <th>Via</th>
                                            <th>Msgs</th>
                                            <th>Heard</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {aircraft.slice(0, TABLE_ROWS).map((a) => {
                                            const gs = stationOf(stations, a.gs);
                                            return (
                                                <tr
                                                    key={a.key}
                                                    className={[
                                                        picked && picked.key === a.key ? 'is-picked' : '',
                                                        isStale(a, now) ? 'is-stale' : '',
                                                    ].filter(Boolean).join(' ')}
                                                    onClick={() => setPicked(a)}
                                                >
                                                    <td title={[a.icao, a.reg].filter(Boolean).join(' · ')}>
                                                        {aircraftLabel(a)}
                                                    </td>
                                                    <td>{a.khz ? (a.khz / 1000).toFixed(3) : '—'}</td>
                                                    <td>{altLabel(a.alt) || '—'}</td>
                                                    <td title={gs ? `Ground station ${gs.id}` : undefined}>
                                                        {gs ? gs.name : (a.gs || '—')}
                                                    </td>
                                                    <td>{a.msgs || '—'}</td>
                                                    <td>{a.at ? sinceLabel(a.at, now) : '—'}</td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}

                        <div className="row-end">
                            <a
                                className="btn btn--ghost btn--sm"
                                href={addonUrl()}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                Open HFDL
                                <Icon.External size={13} />
                            </a>
                            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                                Close
                            </Button>
                        </div>
                    </div>
                </Modal>
            )}
        </div>
    );
}

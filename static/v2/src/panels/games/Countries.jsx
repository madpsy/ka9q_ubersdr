// Where is this country? A pin on a world map and five names.
//
// The map is a canvas rather than the Leaflet the start overlay uses: it is 336
// by 168 of coastline outlines with no tiles, no labels and no attribution, which
// is a few hundred lines of arcs — and pulling a mapping library into a game
// panel for that would cost more than the whole rest of this panel put together.
//
// The projection, the clamp, the framing and the TopoJSON decode are all in
// lib/games/quiz.js, where they can be checked without a canvas.

import React, { useCallback, useEffect, useRef, useState } from '../../react.js';
import Frame from './Frame.jsx';
import { countryFlag } from '../../lib/format.js';
import {
    OPTIONS, RECENT_MAX, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, arcVisible, buildOptions, clampView,
    decodeArcs, pickCountry, project, unproject, viewFor,
} from '../../lib/games/quiz.js';

const W = 336;
const H = 168;
const NEXT_MS = 3000;
const BEST_KEY = 'ubersdr.v2.games.countries.best';

// One fetch each per page, shared by every mount of this panel — the arcs are a
// hundred kilobytes and the list is rate limited to a request a second.
let cache = null;

function loadData() {
    if (cache) return cache;
    cache = Promise.all([
        fetch('/api/maidenhead/country')
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => (j && Array.isArray(j.countries) ? j.countries : null))
            .catch(() => null),
        fetch('/countries-110m.json')
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null),
    ]).then(([list, topo]) => ({
        // Only entries that can be pinned and flagged.
        list: (list || []).filter((c) => c && c.country
            && typeof c.lat === 'number' && typeof c.lon === 'number'
            && typeof c.iso_a2 === 'string' && c.iso_a2.length === 2),
        arcs: decodeArcs(topo),
    }));
    return cache;
}

export default function Countries() {
    const [data, setData] = useState(null);
    const [question, setRound] = useState(null);
    const [picked, setPicked] = useState('');
    const [status, setStatus] = useState('Loading…');
    const [streak, setStreak] = useState(() => {
        let best = 0;
        try { best = parseInt(localStorage.getItem(BEST_KEY), 10) || 0; } catch (e) { /* private */ }
        return { now: 0, best };
    });
    const canvas = useRef(null);
    // The view is a ref, not state: a drag moves it every pointer event and the
    // canvas is painted by hand, so re-rendering the panel for it would be work
    // done twice at sixty hertz. Same split the spectrum makes.
    const view = useRef({ lon: 0, lat: 0, z: 1 });
    const recent = useRef([]);
    const timer = useRef(null);
    const alive = useRef(true);

    useEffect(() => () => { alive.current = false; clearTimeout(timer.current); }, []);

    const draw = useCallback(() => {
        const el = canvas.current;
        if (!el || !data) return;
        const c = el.getContext('2d');
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        if (el.width !== W * dpr) { el.width = W * dpr; el.height = H * dpr; }
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.clearRect(0, 0, W, H);

        if (data.arcs) {
            c.strokeStyle = 'rgba(149, 165, 166, 0.85)';
            c.lineWidth = 0.8;
            c.lineJoin = 'question';
            c.beginPath();
            for (const arc of data.arcs) {
                if (!arcVisible(arc, view.current, W, H)) continue;
                let prevLon = null;
                for (let i = 0; i < arc.pts.length; i += 2) {
                    const lon = arc.pts[i];
                    const lat = arc.pts[i + 1];
                    const [x, y] = project(lon, lat, view.current, W, H);
                    // A jump of more than half the world is an arc crossing the
                    // antimeridian: break the path rather than streak across it.
                    if (prevLon === null || Math.abs(lon - prevLon) > 180) c.moveTo(x, y);
                    else c.lineTo(x, y);
                    prevLon = lon;
                }
            }
            c.stroke();
        }

        if (!question) return;
        const [x, y] = project(question.lon, question.lat, view.current, W, H);
        // A teardrop with a halo, so it reads over a coastline.
        c.beginPath();
        c.arc(x, y, 8, 0, Math.PI * 2);
        c.fillStyle = 'rgba(231, 76, 60, 0.25)';
        c.fill();
        c.beginPath();
        c.moveTo(x, y + 7);
        c.lineTo(x - 3.3, y + 2.3);
        c.lineTo(x + 3.3, y + 2.3);
        c.closePath();
        c.moveTo(x + 4.6, y);
        c.arc(x, y, 4.6, 0, Math.PI * 2);
        c.fillStyle = '#e74c3c';
        c.fill();
        c.lineWidth = 1.2;
        c.strokeStyle = '#fff';
        c.stroke();
    }, [data, question]);

    useEffect(() => { draw(); }, [draw]);

    useEffect(() => {
        loadData().then((d) => {
            if (!alive.current) return;
            setData(d);
            if (!d.list.length) setStatus('Country list unavailable');
        });
    }, []);

    const nextRound = useCallback(() => {
        if (!data || !data.list.length) return;
        clearTimeout(timer.current);
        setPicked('');
        const c = pickCountry(data.list, recent.current);
        recent.current = [...recent.current, c.country].slice(-RECENT_MAX);
        view.current = viewFor(c, W, H);
        setRound({
            ...c,
            options: buildOptions(c.country, data.list.map((x) => x.country)),
            codes: new Map(data.list.map((x) => [x.country, x.iso_a2])),
        });
        setStatus('Where is this?');
    }, [data]);

    useEffect(() => {
        if (data && data.list.length && !question) nextRound();
    }, [data, question, nextRound]);

    // Pan and zoom. Pointer capture rather than window listeners, and a
    // non-passive wheel handler, for the same reasons the spectrum has both: a
    // drag that leaves the canvas should keep panning, and a scroll over a map
    // must not scroll the dock behind it.
    const drag = useRef(null);
    const onDown = (e) => {
        drag.current = { x: e.clientX, y: e.clientY };
        e.currentTarget.setPointerCapture(e.pointerId);
    };
    const onMove = (e) => {
        if (!drag.current) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const scale = rect.width / W;
        const dx = (e.clientX - drag.current.x) / scale;
        const dy = (e.clientY - drag.current.y) / scale;
        drag.current = { x: e.clientX, y: e.clientY };
        const [lon, lat] = unproject(W / 2 - dx, H / 2 - dy, view.current, W, H);
        view.current = clampView({ ...view.current, lon, lat }, W, H);
        draw();
    };
    const onUp = () => { drag.current = null; };

    useEffect(() => {
        const el = canvas.current;
        if (!el) return undefined;
        const onWheel = (e) => {
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            const scale = rect.width / W;
            const px = (e.clientX - rect.left) / scale;
            const py = (e.clientY - rect.top) / scale;
            // Zoom about the pointer: the point under it stays put, which is what
            // makes a map feel like a map rather than a slideshow.
            const [lon, lat] = unproject(px, py, view.current, W, H);
            const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN,
                e.deltaY < 0 ? view.current.z * ZOOM_STEP : view.current.z / ZOOM_STEP));
            const after = { ...view.current, z };
            const [lon2, lat2] = unproject(px, py, after, W, H);
            view.current = clampView(
                { z, lon: after.lon + (lon - lon2), lat: after.lat + (lat - lat2) }, W, H,
            );
            draw();
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [draw]);

    const answer = (name) => {
        if (picked || !question) return;
        setPicked(name);
        if (name === question.country) {
            setStreak((s) => {
                const now = s.now + 1;
                const best = Math.max(now, s.best);
                if (best !== s.best) {
                    try { localStorage.setItem(BEST_KEY, String(best)); } catch (e) { /* private */ }
                }
                return { now, best };
            });
            setStatus('Correct ✓');
        } else {
            setStreak((s) => ({ ...s, now: 0 }));
            setStatus(`Nope — ${question.country}`);
        }
        timer.current = setTimeout(() => { if (alive.current) nextRound(); }, NEXT_MS);
    };

    return (
        <Frame
            status={status}
            score={`Streak:${streak.now} Best:${streak.best}`}
            action={nextRound}
            actionLabel="Next"
            statusLines={2}
        >
            <div className="co">
                <canvas
                    ref={canvas}
                    className="co__map"
                    style={{ aspectRatio: `${W} / ${H}` }}
                    title="Drag to pan, scroll to zoom"
                    onPointerDown={onDown}
                    onPointerMove={onMove}
                    onPointerUp={onUp}
                    onPointerCancel={onUp}
                />
                {/* Five rows whether or not there are five names yet — see the
                    callsign quiz, which had the panel jumping a hundred and
                    thirty pixels between questions before this. */}
                <div className="co__options">
                    {Array.from({ length: OPTIONS }, (_, i) => {
                        const name = question && question.options[i];
                        if (!name) {
                            return <span className="cq__opt is-blank" key={`blank${i}`} aria-hidden="true" />;
                        }
                        return (
                            <button
                                key={name}
                                type="button"
                                className={[
                                    'cq__opt',
                                    picked ? 'is-done' : '',
                                    picked && name === question.country ? 'is-right' : '',
                                    picked === name && name !== question.country ? 'is-wrong' : '',
                                ].filter(Boolean).join(' ')}
                                onClick={() => answer(name)}
                                disabled={!!picked}
                                title={name}
                            >
                                {picked ? `${countryFlag(question.codes.get(name) || '')} ` : ''}{name}
                            </button>
                        );
                    })}
                </div>
            </div>
        </Frame>
    );
}

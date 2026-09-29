// NDB: aviation beacons on LF — a list in the panel, a map in the modal.
//
// The panel is the beacons being heard, a page at a time, live ones first: ident,
// frequency and signal, then name and how far and which way. The Map button, or any
// row, opens the modal: a map you can work with — pan and zoom, a readout under the
// pointer, and what the addon knows about the clicked beacon in a column beside it, with
// the path from this receiver drawn — and the full list under it.
//
// It is the HFDL panel's shape on purpose (see HFDLPanel.jsx): the same modal, the same
// map interaction, the same classes where the layout is the same. What differs is the
// map. HFDL's is the whole world because aeroplanes are everywhere; beacons are within a
// couple of thousand kilometres of the receiver, so this map frames the receiver and what
// it can hear (lib/ndb.js frameView), with range rings for scale — on a regional map the
// distance is the thing being read.
//
// Dots are green while a beacon is being received, faded when it has dropped out within
// the hour, fainter again after ten quiet minutes. That is the propagation story the
// panel is for: which paths are open now, and which were a while ago.
//
// The addon's own dashboard has the spectrum, every carrier, the live Morse copy, the
// heard log and search; both the panel and the modal link to it rather than reproducing
// any of it.
//
// `minimal` is the first page of the list, without the header or the pager.

import React, { useCallback, useEffect, useMemo, useRef, useState } from '../react.js';
import { Button, Empty, Icon, Modal, ShowMore } from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { countryFlag, sinceLabel } from '../lib/format.js';
import {
    ZOOM_MIN, ZOOM_STEP, arcVisible, loadWorldArcs, project, unproject,
} from '../lib/worldMap.js';
import { headingLabel, kmLabel } from '../lib/hfdl.js';
import {
    NDB_ZOOM_MAX, POLL_MS, WINDOW_S, addonUrl, beaconLabel, beaconList, beaconsUrl, clampNdbView,
    frameView, isQuiet,
    khzLabel, mappable, ndbAvailable, ndbSummary, rangeRing, ringsFor, snrLabel,
} from '../lib/ndb.js';
import { feedInterval } from '../lib/serverFeeds.js';

export { ndbAvailable };

// The modal's map, in CSS pixels. 2:1 like HFDL's; at these latitudes the region is
// wider than tall anyway.
const BIG_W = 900;
const BIG_H = 450;

// Rows before "Show more", and how many each press adds. Five, as the Listeners panel:
// this sits in a side dock among others, and a night with twenty beacons in should not
// make the dock a screen long until somebody asks it to.
const PAGE = 5;

// Tap versus drag, and how close a press has to land — the same figures, and the same
// reasons, as the HFDL map.
const CLICK_SLOP = 4;
const TOUCH_SLOP = 10;
const MOUSE_REACH = 12;
const TOUCH_REACH = 22;

/**
 * The map.
 *
 * `interactive` is the modal's copy: pan, pinch, wheel and buttons, a tip under the
 * pointer, and a click that selects. The panel's copy is a picture — the framed region
 * and nothing to operate — because pan-and-zoom on a 320-pixel map gets in the way of
 * the one thing it is for.
 *
 * `home` is the framed view. It is recomputed as beacons come and go, and the map
 * follows it until somebody pans or zooms; after that it stays where they put it until
 * the ⟲ button hands it back.
 */
function BeaconMap({
    w, h, arcs, beacons, me, now, pick, picked, interactive, home,
}) {
    const canvas = useRef(null);
    // A ref, not state: a drag moves it on every pointer event and the canvas is painted
    // by hand. Same split the HFDL map and the spectrum make.
    const view = useRef({ ...home });
    const userMoved = useRef(false);
    const hits = useRef([]);
    const [hover, setHover] = useState(null);
    const [z, setZ] = useState(home.z);

    const draw = useCallback(() => {
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

        // Text drawn larger by however much the canvas is about to be squeezed, so it
        // arrives at its design size on a phone — see the HFDL map for the long version.
        const shown = el.getBoundingClientRect().width || w;
        const textScale = Math.max(1, w / shown);

        const v = view.current;
        const css = getComputedStyle(document.documentElement);
        const ink = css.getPropertyValue('--text-faint').trim() || '#5c6779';
        const accent = css.getPropertyValue('--accent').trim() || '#08a2fb';
        const good = css.getPropertyValue('--good').trim() || '#45d69a';
        const text = css.getPropertyValue('--text').trim() || '#e6edf3';

        // Coastlines, faint: the reference, not the subject.
        if (arcs) {
            c.strokeStyle = ink;
            c.globalAlpha = 0.5;
            c.lineWidth = 0.7;
            c.beginPath();
            for (const arc of arcs) {
                if (!arcVisible(arc, v, w, h)) continue;
                let prevLon = null;
                for (let i = 0; i < arc.pts.length; i += 2) {
                    const lon = arc.pts[i];
                    const lat = arc.pts[i + 1];
                    const [x, y] = project(lon, lat, v, w, h);
                    if (prevLon === null || Math.abs(lon - prevLon) > 180) c.moveTo(x, y);
                    else c.lineTo(x, y);
                    prevLon = lon;
                }
            }
            c.stroke();
            c.globalAlpha = 1;
        }

        const drawn = mappable(beacons);

        // Range rings around the receiver: on a regional map the distance is the thing
        // being read, and a ring says "500 km" without a scale bar to squint at.
        if (me) {
            const reach = drawn.reduce((m, b) => Math.max(m, b.distKm || 0), 0);
            c.save();
            c.setLineDash([2, 4]);
            c.strokeStyle = accent;
            c.globalAlpha = 0.35;
            c.lineWidth = 0.8;
            c.font = `${(9 * textScale).toFixed(1)}px ui-monospace, monospace`;
            c.textAlign = 'center';
            c.textBaseline = 'top';
            for (const km of ringsFor(reach)) {
                const ring = rangeRing(me, km);
                c.beginPath();
                ring.forEach(([lon, lat], i) => {
                    const [x, y] = project(lon, lat, v, w, h);
                    if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
                });
                c.stroke();
                // Labelled at its southern point, where it rarely lands on a beacon north
                // of a European receiver — and only on the big map, where there is room.
                if (w > 500) {
                    const [lx, ly] = project(me.lon, ring[Math.floor(ring.length / 2)][1], v, w, h);
                    c.fillStyle = accent;
                    c.globalAlpha = 0.6;
                    c.fillText(km >= 1000 ? `${km / 1000}k km` : `${km} km`, lx, ly + 2);
                    c.globalAlpha = 0.35;
                }
            }
            c.restore();
        }

        // Paths from this receiver to what it is hearing now. Straight, not great-circle:
        // at a couple of thousand kilometres the difference is invisible, and a line from
        // here to there is the claim being made.
        const sel = picked ? drawn.find((b) => b.key === picked) : null;
        if (me) {
            const [mx, my] = project(me.lon, me.lat, v, w, h);
            for (const b of drawn) {
                if (!b.live && b !== sel) continue;
                const [x, y] = project(b.lon, b.lat, v, w, h);
                c.strokeStyle = b === sel ? accent : good;
                c.globalAlpha = b === sel ? 0.9 : 0.35;
                c.lineWidth = b === sel ? 1.4 : 0.9;
                c.beginPath();
                c.moveTo(mx, my);
                c.lineTo(x, y);
                c.stroke();
            }
            c.globalAlpha = 1;
        }

        // This receiver: a cross, as on the HFDL map.
        if (me) {
            const [x, y] = project(me.lon, me.lat, v, w, h);
            c.strokeStyle = accent;
            c.lineWidth = 1.4;
            c.beginPath();
            c.moveTo(x - 5, y); c.lineTo(x + 5, y);
            c.moveTo(x, y - 5); c.lineTo(x, y + 5);
            c.stroke();
        }

        // The beacons, last so nothing is drawn over them. The chart symbol for an NDB
        // is a dot in a ring of dots; at these sizes that is a dot in a ring.
        hits.current = [];
        const r = w > 500 ? 3.4 : 2.6;
        // Quiet ones first, so a live beacon is never under a faded one.
        const order = [...drawn].sort((a, b) => (a.live === b.live ? 0 : a.live ? 1 : -1));
        for (const b of order) {
            const [x, y] = project(b.lon, b.lat, v, w, h);
            c.globalAlpha = b.live ? 1 : isQuiet(b, now) ? 0.3 : 0.55;
            c.fillStyle = b.live ? good : ink;
            c.strokeStyle = c.fillStyle;
            c.beginPath();
            c.arc(x, y, r, 0, Math.PI * 2);
            c.fill();
            c.lineWidth = 1;
            c.beginPath();
            c.arc(x, y, r + 2.5, 0, Math.PI * 2);
            c.stroke();
            if (picked === b.key) {
                c.globalAlpha = 1;
                c.strokeStyle = text;
                c.lineWidth = 1.2;
                c.beginPath();
                c.arc(x, y, r + 5, 0, Math.PI * 2);
                c.stroke();
            }
            if (interactive) hits.current.push({ x, y, beacon: b });
        }
        c.globalAlpha = 1;

        // Idents. There are a dozen or two of these, not hundreds of aeroplanes, so they
        // fit even on the panel's map — and an ident is the thing a beacon is known by.
        c.font = `600 ${((w > 500 ? 11 : 8.5) * textScale).toFixed(1)}px ui-monospace, monospace`;
        c.textAlign = 'left';
        c.textBaseline = 'middle';
        for (const b of order) {
            const [x, y] = project(b.lon, b.lat, v, w, h);
            if (x < -30 || x > w + 30 || y < -10 || y > h + 10) continue;
            c.globalAlpha = b.live ? 0.95 : isQuiet(b, now) ? 0.35 : 0.6;
            c.fillStyle = b.live ? text : ink;
            c.fillText(b.ident, x + r + 4 * textScale, y);
        }
        c.globalAlpha = 1;
    }, [w, h, arcs, beacons, me, now, picked, interactive]);

    useEffect(() => { draw(); }, [draw]);

    // Follow the framing until the user takes over.
    useEffect(() => {
        if (userMoved.current) return;
        view.current = clampNdbView({ ...home }, w, h);
        setZ(view.current.z);
        draw();
    }, [home.lon, home.lat, home.z]);   // eslint-disable-line react-hooks/exhaustive-deps

    const at = (e) => {
        const rect = canvas.current.getBoundingClientRect();
        return [(e.clientX - rect.left) * (w / rect.width), (e.clientY - rect.top) * (h / rect.height)];
    };

    const nearest = (x, y, reach = MOUSE_REACH) => {
        let best = null;
        let bestD = reach;
        for (const hit of hits.current) {
            const d = Math.hypot(hit.x - x, hit.y - y);
            if (d < bestD) { bestD = d; best = hit; }
        }
        return best;
    };

    // Pan, pinch and tap, tracked per pointer — the HFDL map's handling, for the same
    // reasons: pointer capture keeps a drag that leaves the canvas, and two live pointers
    // are a pinch, which is the only way to zoom on a touchscreen.
    const drag = useRef(null);
    const pointers = useRef(new Map());
    const pinch = useRef(null);
    const pinched = useRef(false);

    const gesture = () => {
        const [a, b] = Array.from(pointers.current.values());
        if (!a || !b) return null;
        return { dist: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };

    const panBy = (dx, dy) => {
        const [lon, lat] = unproject(w / 2 - dx, h / 2 - dy, view.current, w, h);
        view.current = clampNdbView({ ...view.current, lon, lat }, w, h);
        userMoved.current = true;
    };

    const zoomTo = useCallback((next, px, py) => {
        const cx = px == null ? w / 2 : px;
        const cy = py == null ? h / 2 : py;
        const [lon, lat] = unproject(cx, cy, view.current, w, h);
        const zz = Math.min(NDB_ZOOM_MAX, Math.max(ZOOM_MIN, next));
        const after = { ...view.current, z: zz };
        const [lon2, lat2] = unproject(cx, cy, after, w, h);
        view.current = clampNdbView({ z: zz, lon: after.lon + (lon - lon2), lat: after.lat + (lat - lat2) }, w, h);
        userMoved.current = true;
        setZ(view.current.z);
        setHover(null);
        draw();
    }, [w, h, draw]);

    const onDown = (e) => {
        if (!interactive) return;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        e.currentTarget.setPointerCapture(e.pointerId);
        if (pointers.current.size >= 2) {
            drag.current = null;
            pinch.current = gesture();
            pinched.current = true;
            return;
        }
        drag.current = { x: e.clientX, y: e.clientY, moved: 0, kind: e.pointerType };
    };
    const onMove = (e) => {
        if (!interactive) return;
        if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.current.size >= 2 && pinch.current) {
            const g = gesture();
            if (!g) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const scale = rect.width / w;
            panBy((g.x - pinch.current.x) / scale, (g.y - pinch.current.y) / scale);
            if (pinch.current.dist > 0 && g.dist > 0) {
                zoomTo(view.current.z * (g.dist / pinch.current.dist), (g.x - rect.left) / scale, (g.y - rect.top) / scale);
            } else {
                setHover(null);
                draw();
            }
            pinch.current = g;
            return;
        }
        if (drag.current) {
            const rect = e.currentTarget.getBoundingClientRect();
            const scale = rect.width / w;
            const dx = (e.clientX - drag.current.x) / scale;
            const dy = (e.clientY - drag.current.y) / scale;
            drag.current.moved += Math.abs(e.clientX - drag.current.x) + Math.abs(e.clientY - drag.current.y);
            drag.current.x = e.clientX;
            drag.current.y = e.clientY;
            // A press that has not travelled past the tap slop is not a pan yet, so a
            // shaky click does not unhook the map from its framing.
            const touch = drag.current.kind && drag.current.kind !== 'mouse';
            if (drag.current.moved > (touch ? TOUCH_SLOP : CLICK_SLOP)) {
                panBy(dx, dy);
                setHover(null);
                draw();
            }
            return;
        }
        if (e.pointerType !== 'mouse') return;
        const [x, y] = at(e);
        const hit = nearest(x, y);
        setHover((prev) => {
            if (prev && hit && prev.beacon === hit.beacon) return prev;
            return hit ? { ...hit } : null;
        });
    };
    const onUp = (e) => {
        if (!interactive) return;
        pointers.current.delete(e.pointerId);
        if (pointers.current.size < 2) pinch.current = null;
        if (pointers.current.size === 1) {
            const [only] = Array.from(pointers.current.values());
            drag.current = { x: only.x, y: only.y, moved: 0 };
            return;
        }
        const wasPinch = pinched.current;
        if (pointers.current.size === 0) pinched.current = false;
        if (!drag.current) return;
        const touch = drag.current.kind && drag.current.kind !== 'mouse';
        const wasDrag = drag.current.moved > (touch ? TOUCH_SLOP : CLICK_SLOP);
        drag.current = null;
        if (wasDrag || wasPinch || !pick) return;
        const [x, y] = at(e);
        const rect = e.currentTarget.getBoundingClientRect();
        const squeeze = rect.width ? w / rect.width : 1;
        const hit = nearest(x, y, (touch ? TOUCH_REACH : MOUSE_REACH) * squeeze);
        // A click on empty map clears the selection.
        pick(hit ? hit.beacon : null);
    };

    // Non-passive, so a scroll over the map zooms it rather than the modal behind it.
    useEffect(() => {
        const el = canvas.current;
        if (!el || !interactive) return undefined;
        const onWheel = (e) => {
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            const scale = rect.width / w;
            zoomTo(
                e.deltaY < 0 ? view.current.z * ZOOM_STEP : view.current.z / ZOOM_STEP,
                (e.clientX - rect.left) / scale,
                (e.clientY - rect.top) / scale,
            );
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [interactive, w, zoomTo]);

    // Back to the framed view, and following it again.
    const reframe = () => {
        userMoved.current = false;
        view.current = clampNdbView({ ...home }, w, h);
        setZ(view.current.z);
        setHover(null);
        draw();
    };

    const canvasEl = (
        <canvas
            ref={canvas}
            className={interactive ? 'hf__map hf__map--live' : 'hf__map'}
            style={{ aspectRatio: `${w} / ${h}` }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onPointerLeave={() => setHover(null)}
        />
    );

    if (!interactive) return canvasEl;

    const hb = hover && hover.beacon;
    return (
        <div className="hf__stage">
            {canvasEl}
            {hover && (
                <i className="hf__ring" style={{ left: `${(hover.x / w) * 100}%`, top: `${(hover.y / h) * 100}%` }} />
            )}
            {hb && (
                <div
                    className={`hf__tip${hover.x > w * 0.6 ? ' is-left' : ''}`}
                    style={{ left: `${(hover.x / w) * 100}%`, top: `${(hover.y / h) * 100}%` }}
                >
                    <b>{hb.ident}{hb.name ? ` ${hb.name}` : ''} {countryFlag(hb.country)}</b>
                    <span>{[khzLabel(hb.khz), kmLabel(hb.distKm), headingLabel(hb.bearing)].filter(Boolean).join(' · ')}</span>
                    <span>
                        {hb.live
                            ? `live · ${snrLabel(hb.snr)}`
                            : `heard ${sinceLabel(hb.lastAt, now)} ago · best ${snrLabel(hb.bestSnr)}`}
                    </span>
                </div>
            )}
            <div className="hf__zoom">
                <button type="button" onClick={() => zoomTo(view.current.z * ZOOM_STEP)} disabled={z >= NDB_ZOOM_MAX} title="Zoom in">+</button>
                <button type="button" onClick={() => zoomTo(view.current.z / ZOOM_STEP)} disabled={z <= ZOOM_MIN} title="Zoom out">−</button>
                <button type="button" onClick={reframe} title="Back to the receiver and what it hears">⟲</button>
            </div>
        </div>
    );
}

/**
 * One beacon in the panel's list: ident, frequency and signal on the first line — the
 * signal while it is live, how long since it was heard once it is not — then its name
 * and how far and which way. Clicking it shows it on the map.
 */
function BeaconRow({ b, now, onOpen }) {
    const where = [
        b.name,
        b.country ? countryFlag(b.country) : '',
        b.distKm != null ? `${kmLabel(b.distKm)}${b.bearing != null ? ` ${headingLabel(b.bearing).split(' ')[1]}` : ''}` : '',
    ].filter(Boolean).join(' · ');
    const title = [
        beaconLabel(b),
        khzLabel(b.khz),
        b.distKm != null ? `${kmLabel(b.distKm)}, ${headingLabel(b.bearing)}` : '',
        b.live ? `Live, ${snrLabel(b.snr)}` : `Last heard ${sinceLabel(b.lastAt, now)} ago, best ${snrLabel(b.bestSnr)}`,
        'Click to show it on the map',
    ].filter(Boolean).join('\n');
    return (
        <button
            type="button"
            className={`list__row nd-row${b.live ? '' : isQuiet(b, now) ? ' is-quiet' : ' is-old'}`}
            title={title}
            onClick={() => onOpen(b)}
        >
            <span className="nd-row__id">
                <i className={`nd__dot${b.live ? '' : ' nd__dot--old'}`} />
                {b.ident}
            </span>
            <span className="nd-row__khz">{b.khz != null ? b.khz.toFixed(1) : ''}</span>
            <span className="nd-row__sig">{b.live ? snrLabel(b.snr) : sinceLabel(b.lastAt, now)}</span>
            <span className="nd-row__where">{where || '—'}</span>
        </button>
    );
}

/** One row of the detail column, absent when there is nothing to put in it. */
function Row({ k, children }) {
    if (children == null || children === '' || children === false) return null;
    return (
        <div className="kv">
            <span className="kv__k">{k}</span>
            <span className="kv__v">{children}</span>
        </div>
    );
}

/** Everything the addon knows about one beacon. All of it is in the poll already. */
function BeaconCard({ b, now, onClose }) {
    return (
        <div className="hf__card">
            <div className="hf__card-head">
                <span className="hf__card-call">{b.ident}</span>
                <button type="button" className="hf__card-close" onClick={onClose} title="Close">
                    <Icon.Close size={14} />
                </button>
            </div>
            {(b.name || b.country) && (
                <div className="hf__card-sub">
                    {[b.name, b.country && `${countryFlag(b.country)} ${b.country}`].filter(Boolean).join(' · ')}
                </div>
            )}
            <div className="kv-list">
                <Row k="Status">{b.live ? 'Live' : `Last heard ${sinceLabel(b.lastAt, now)} ago`}</Row>
                <Row k="Frequency">{khzLabel(b.khz)}</Row>
                <Row k="Distance">{kmLabel(b.distKm)}</Row>
                <Row k="Bearing">{headingLabel(b.bearing)}</Row>
                <Row k="SNR now">{b.live ? snrLabel(b.snr) : ''}</Row>
                <Row k="Best SNR">{snrLabel(b.bestSnr)}</Row>
                <Row k="First heard">{b.firstAt ? `${sinceLabel(b.firstAt, now)} ago` : ''}</Row>
                <Row k="Position">{b.lat != null ? `${b.lat.toFixed(3)}, ${b.lon.toFixed(3)}` : ''}</Row>
                <Row k="Listed">{b.confirmed ? 'In the navaid list' : 'Not in the navaid list'}</Row>
            </div>
        </div>
    );
}

export default function NDBPanel({ minimal }) {
    const { serverInfo } = useRadio();
    const [arcs, setArcs] = useState(null);
    const [beacons, setBeacons] = useState([]);
    const [state, setState] = useState('loading');   // loading | ok | error
    const [now, setNow] = useState(() => Date.now());
    const [open, setOpen] = useState(false);
    const [pickKey, setPickKey] = useState(null);
    const [shown, setShown] = useState(PAGE);
    const alive = useRef(true);

    useEffect(() => () => { alive.current = false; }, []);
    useEffect(() => { loadWorldArcs().then((a) => { if (alive.current) setArcs(a); }); }, []);
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 15000);
        return () => clearInterval(id);
    }, []);

    const poll = useCallback(() => {
        fetch(beaconsUrl(WINDOW_S))
            .then((r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then((reply) => {
                if (!alive.current) return;
                setBeacons(beaconList(reply));
                setNow(Date.now());
                setState('ok');
            })
            .catch(() => {
                if (!alive.current) return;
                // A failed poll leaves the map as it was: the beacons were there a moment
                // ago, and the next poll in five seconds will say otherwise if they are not.
                setState((s) => (s === 'ok' ? s : 'error'));
            });
    }, []);

    // Five seconds, open or closed: /api/beacons is small, and the list is the whole panel.
    useEffect(() => feedInterval(poll, POLL_MS), [poll]);

    const gps = (serverInfo && serverInfo.receiver && serverInfo.receiver.gps) || {};
    const me = (gps.lat || gps.lon) ? { lat: Number(gps.lat), lon: Number(gps.lon) } : null;

    // The framing, per map size. Rounded, so it only moves when the set of beacons moves
    // it rather than on every poll's floating-point noise.
    const frame = (w, h) => {
        const f = frameView(me, beacons, w, h);
        return { lon: Math.round(f.lon * 100) / 100, lat: Math.round(f.lat * 100) / 100, z: Math.round(f.z * 20) / 20 };
    };
    const big = useMemo(() => frame(BIG_W, BIG_H), [beacons, me && me.lat, me && me.lon]);   // eslint-disable-line react-hooks/exhaustive-deps

    const picked = useMemo(() => (pickKey ? beacons.find((b) => b.key === pickKey) || null : null), [beacons, pickKey]);
    const sum = ndbSummary(beacons, me);

    if (state === 'loading') return <Empty>Loading…</Empty>;
    if (state === 'error' && !beacons.length) return <Empty>The NDB addon is not answering.</Empty>;

    // Minimal is the first page and no way to grow it, so a list left expanded does not
    // stay expanded when the panel is cut down — the Listeners panel's rule.
    const page = beacons.slice(0, minimal ? PAGE : shown);
    const openAt = (b) => { setPickKey(b ? b.key : null); setOpen(true); };

    return (
        <div className="stack nd">
            {!minimal && (
                <div className="nd-head">
                    <span
                        className="nd-count"
                        title={sum.furthest
                            ? `Furthest being received: ${beaconLabel(sum.furthest.beacon)}, ${kmLabel(sum.furthest.km)}`
                            : undefined}
                    >
                        <b>{sum.live}</b> live
                        {sum.count > sum.live && <i> +{sum.count - sum.live} this hour</i>}
                        {sum.furthest && <i> · {sum.furthest.beacon.ident} {kmLabel(sum.furthest.km)}</i>}
                    </span>
                    <Button
                        size="sm"
                        variant="ghost"
                        icon={<Icon.Target />}
                        title="Open the beacon map"
                        onClick={() => openAt(null)}
                    >
                        Map
                    </Button>
                </div>
            )}

            {beacons.length === 0 ? (
                <Empty>No beacons heard in the last hour.</Empty>
            ) : (
                <div className="list nd-list">
                    {page.map((b) => <BeaconRow key={b.key} b={b} now={now} onOpen={openAt} />)}
                </div>
            )}

            {!minimal && (
                <ShowMore
                    shown={page.length}
                    total={beacons.length}
                    base={PAGE}
                    onMore={() => setShown((n) => n + PAGE)}
                    onLess={() => setShown(PAGE)}
                />
            )}

            {!minimal && (
                <div className="row-end">
                    <a className="btn btn--ghost btn--sm" href={addonUrl()} target="_blank" rel="noopener noreferrer">
                        Open NDB
                        <Icon.External size={13} />
                    </a>
                </div>
            )}

            {open && (
                <Modal onClose={() => setOpen(false)} label="NDB beacons">
                    <div className="hf__full">
                        <div className="hf__cols">
                            <div className="hf__mapcol">
                                <BeaconMap
                                    w={BIG_W}
                                    h={BIG_H}
                                    arcs={arcs}
                                    beacons={beacons}
                                    me={me}
                                    now={now}
                                    home={big}
                                    interactive
                                    pick={(b) => setPickKey(b ? b.key : null)}
                                    picked={pickKey}
                                />
                                <div className="hf__legend">
                                    <span><i className="nd__dot" /> live</span>
                                    <span><i className="nd__dot nd__dot--old" /> heard this hour</span>
                                    {me && <span><i className="hf__me" /> this receiver</span>}
                                    <span>rings: distance from here</span>
                                    <span className="hf__msgs">{sum.live} live · {sum.count} this hour</span>
                                </div>
                            </div>

                            {picked ? (
                                <BeaconCard b={picked} now={now} onClose={() => setPickKey(null)} />
                            ) : (
                                <div className="hf__card hf__card--empty">
                                    Click a beacon — on the map or in the list — for its frequency,
                                    distance, bearing and signal.
                                </div>
                            )}
                        </div>

                        {beacons.length === 0 ? (
                            <Empty>No beacons heard in the last hour.</Empty>
                        ) : (
                            <div className="hf__table">
                                <table>
                                    <thead>
                                        <tr>
                                            <th>Ident</th>
                                            <th>Name</th>
                                            <th>kHz</th>
                                            <th>Distance</th>
                                            <th>SNR</th>
                                            <th>Heard</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {beacons.map((b) => (
                                            <tr
                                                key={b.key}
                                                className={[
                                                    pickKey === b.key ? 'is-picked' : '',
                                                    b.live ? '' : 'is-stale',
                                                ].filter(Boolean).join(' ')}
                                                onClick={() => setPickKey(b.key)}
                                            >
                                                <td>
                                                    <i className={`nd__dot${b.live ? '' : ' nd__dot--old'}`} />
                                                    {b.ident}
                                                </td>
                                                <td title={b.country}>
                                                    {b.name || '—'}{b.country ? ` ${countryFlag(b.country)}` : ''}
                                                </td>
                                                <td>{b.khz != null ? b.khz.toFixed(1) : '—'}</td>
                                                <td>{b.distKm != null ? kmLabel(b.distKm) : '—'}</td>
                                                <td>{snrLabel(b.live ? b.snr : b.bestSnr) || '—'}</td>
                                                <td>{b.live ? 'now' : sinceLabel(b.lastAt, now)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}

                        <div className="row-end">
                            <a className="btn btn--ghost btn--sm" href={addonUrl()} target="_blank" rel="noopener noreferrer">
                                Open NDB
                                <Icon.External size={13} />
                            </a>
                            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Close</Button>
                        </div>
                    </div>
                </Modal>
            )}
        </div>
    );
}

// HFDL: aeroplanes on shortwave, on a map.
//
// The panel is the map and three figures. Clicking it opens the same map several times
// the size, and there it becomes a map you can work with: pan and zoom, a readout under
// the pointer, and — once an aircraft is clicked — everything the addon and the lookups
// know about it in a column beside it, with its recent track drawn and a line to the
// ground station it was talking to.
//
// The dots are coloured by MHz band, which is the one thing worth colouring them by:
// the band *is* the propagation, and three colours spread across a world map say which
// paths are open tonight in a way a column of frequencies cannot. The legend those
// colours need is also the filter, so the picture can be cut down to one band without a
// second control that does nothing else.
//
// The addon's own dashboard still has the per-frequency statistics, the network topology,
// propagation, the message feed and the frequency configuration, and every one of those
// is a page in itself; both the panel and the modal link to it rather than reproducing
// any of it.
//
// The map is lib/worldMap.js, shared with the Countries game: the same projection, the
// same coastlines and the same pan-and-zoom clamp, fetched once for the page.
//
// `minimal` is the map alone — which is most of the point of the panel, and the reason
// it has a minimal view at all.

import React, { useCallback, useEffect, useMemo, useRef, useState } from '../react.js';
import { Button, Empty, Icon, Modal } from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { sinceLabel } from '../lib/format.js';
import {
    ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, arcVisible, clampView, loadWorldArcs, project, unproject,
} from '../lib/worldMap.js';
import {
    MODAL_POLL_MS, POLL_MS, addonUrl, aircraftLabel, aircraftUrl, airportLabel, altLabel,
    bandColour, bandCounts, bandOf, enrichUrl, enrichment, firstPhoto, freqLabel, greatCircleKm,
    headingLabel, hfdlAvailable, hfdlSummary, icaoHex, isStale, kmLabel, liveAircraft, photoUrl,
    stationList, stationOf, stationsUrl, statsUrl, trackPoints, trackUrl, visibleAircraft,
} from '../lib/hfdl.js';
import { feedInterval } from '../lib/serverFeeds.js';

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

// Past this, the map has room to name what is on it. Below it the callsigns overlap into
// a smear, which is worse than no labels at all.
const LABEL_ZOOM = 3;

// A drag this far or further was a drag. Anything less was somebody aiming at a dot with
// a hand that is not made of stone, and should still select it.
// How far a press may travel and still count as a tap rather than a drag, in
// screen pixels. A mouse is held still; a finger is not, and one that rolls
// three pixels while pressing has still pointed at something.
const CLICK_SLOP = 4;
const TOUCH_SLOP = 10;

// How close a press has to land, in screen pixels. Both are radii: a mouse
// pointer is a single pixel and can be aimed, a fingertip covers about nine
// millimetres and cannot.
const MOUSE_REACH = 12;
const TOUCH_REACH = 22;

const HOME = { lon: 0, lat: 0, z: 1 };

/**
 * The map.
 *
 * The panel's copy is the whole world and nothing else: it is a picture of where the
 * traffic is rather than a chart to navigate, and pan-and-zoom on a 320-pixel map is a
 * control that gets in the way of the one thing it is for.
 *
 * `interactive` is the modal's copy, which is the opposite case — 900 pixels, being
 * looked at, and with the North Atlantic at that size holding twenty overlapping dots
 * that a zoom pulls apart.
 *
 * `WorldMap` and not `Map`, which is what it was called: a component by that name shadows
 * the global for the whole module, and the `new Map()` two hundred lines below it then
 * builds a React element instead of a cache. Silently, at import time.
 */
function WorldMap({
    w, h, arcs, aircraft, stations, me, now, pick, picked, interactive, track, focus,
}) {
    const canvas = useRef(null);
    // The view is a ref, not state: a drag moves it on every pointer event and the canvas
    // is painted by hand, so re-rendering the panel for it would be work done twice at
    // sixty hertz. Same split the spectrum and the Countries map make.
    const view = useRef({ ...HOME });
    const hits = useRef([]);
    // What the pointer is on, in canvas pixels, so the tip and the ring can be placed
    // over the canvas in HTML rather than drawn into it — a hover that repainted the
    // world's coastlines at pointer-move rate would be the most expensive thing here.
    const [hover, setHover] = useState(null);
    // Zoom is a ref and the buttons need the panel to notice it changed, so they can go
    // dim at the ends of the range and the labels can appear.
    const [z, setZ] = useState(1);

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

        // How much the canvas is squeezed to fit its column.
        //
        // Everything below is drawn in the canvas's own 900-wide coordinates
        // and then scaled to whatever width it is shown at. On a desktop that
        // is close to 1:1 and a 10 px label is 10 px. On a phone the same
        // canvas is shown at about 400, so the label lands at four and a half —
        // legible on the desktop it was written on, and a smear on the device
        // where somebody is most likely to be reading callsigns off it.
        //
        // Text is therefore drawn larger by the same factor it is about to be
        // shrunk by, so it arrives at the size it was designed to be. Never
        // smaller than 1: a map shown *wider* than its coordinates should keep
        // its proportions rather than growing spidery text.
        const shown = el.getBoundingClientRect().width || w;
        const textScale = Math.max(1, w / shown);

        const v = view.current;
        const css = getComputedStyle(document.documentElement);
        const ink = css.getPropertyValue('--text-faint').trim() || '#5c6779';
        const accent = css.getPropertyValue('--accent').trim() || '#08a2fb';
        const good = css.getPropertyValue('--good').trim() || '#45d69a';
        const text = css.getPropertyValue('--text').trim() || '#e6edf3';

        // Coastlines first and faint: they are the reference, not the subject.
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

        const sel = picked ? aircraft.find((a) => a.key === picked) : null;

        // Where the selected aircraft has been. Behind the dots, so the aeroplane at the
        // end of it is still the thing on top.
        if (sel && track && track.length > 1) {
            c.strokeStyle = bandColour(bandOf(sel.khz));
            c.globalAlpha = 0.75;
            c.lineWidth = 1.4;
            c.beginPath();
            let prevLon = null;
            for (const p of track) {
                const [x, y] = project(p.lon, p.lat, v, w, h);
                if (prevLon === null || Math.abs(p.lon - prevLon) > 180) c.moveTo(x, y);
                else c.lineTo(x, y);
                prevLon = p.lon;
            }
            c.stroke();
            // A mark at each fix, because the gaps are the information: HFDL reports are
            // ten to thirty minutes apart and an even line hides where one was missed.
            c.fillStyle = c.strokeStyle;
            c.globalAlpha = 0.5;
            for (const p of track) {
                const [x, y] = project(p.lon, p.lat, v, w, h);
                c.fillRect(x - 1, y - 1, 2, 2);
            }
            c.globalAlpha = 1;
        }

        // The link itself: the selected aircraft to the station it was last heard talking
        // to. This is the path the signal took, and on a world map it is usually the
        // surprising part — an aeroplane over Greenland working Krasnoyarsk.
        if (sel) {
            const gs = stationOf(stations, sel.gs);
            if (gs) {
                const [ax, ay] = project(sel.lon, sel.lat, v, w, h);
                const [gx, gy] = project(gs.lon, gs.lat, v, w, h);
                // Straight, not a great circle: this is "these two, joined", and a
                // geodesic on an equirectangular map is a curve that invites being read
                // as a route the aeroplane flew.
                if (Math.abs(sel.lon - gs.lon) < 180) {
                    c.save();
                    c.setLineDash([4, 4]);
                    c.strokeStyle = accent;
                    c.globalAlpha = 0.6;
                    c.lineWidth = 1;
                    c.beginPath();
                    c.moveTo(ax, ay);
                    c.lineTo(gx, gy);
                    c.stroke();
                    c.restore();
                }
            }
        }

        // The ground stations. Squares, because they are the fixed points — an aircraft
        // is a dot and a station is a place, and the shape says which without a legend.
        hits.current = [];
        for (const s of stations) {
            const [x, y] = project(s.lon, s.lat, v, w, h);
            c.fillStyle = s.active ? good : ink;
            c.globalAlpha = s.active ? 0.9 : 0.5;
            c.fillRect(x - 2, y - 2, 4, 4);
            if (interactive) hits.current.push({ x, y, station: s });
        }
        c.globalAlpha = 1;

        // This receiver, if it has told us where it is: the map means more with the
        // paths on it measured from somewhere.
        if (me) {
            const [x, y] = project(me.lon, me.lat, v, w, h);
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
        const r = w > 500 ? 3.2 : 2.4;
        for (const a of aircraft) {
            const [x, y] = project(a.lon, a.lat, v, w, h);
            const stale = isStale(a, now);
            // Colour is the band and nothing else — which makes fading the only thing
            // left to say "and this one has gone quiet", and the right thing anyway:
            // a stale aircraft is a weaker claim about the same frequency.
            c.globalAlpha = stale ? 0.35 : 1;
            c.fillStyle = bandColour(bandOf(a.khz));
            c.beginPath();
            c.arc(x, y, picked === a.key ? r + 1.6 : r, 0, Math.PI * 2);
            c.fill();
            // A heading tick where the aircraft reported a track. Short: it says which
            // way, not how fast, and a long one on a small map is a line to nowhere.
            if (a.track != null) {
                const rd = (a.track - 90) * (Math.PI / 180);
                c.strokeStyle = c.fillStyle;
                c.lineWidth = 1;
                c.beginPath();
                c.moveTo(x, y);
                c.lineTo(x + Math.cos(rd) * (r + 4), y + Math.sin(rd) * (r + 4));
                c.stroke();
            }
            if (picked === a.key) {
                c.globalAlpha = 1;
                c.strokeStyle = text;
                c.lineWidth = 1.2;
                c.beginPath();
                c.arc(x, y, r + 4, 0, Math.PI * 2);
                c.stroke();
            }
            if (interactive) hits.current.push({ x, y, aircraft: a });
        }
        c.globalAlpha = 1;

        // Labels, and only in the big map: at 320 px they overlap into a smear, and the
        // modal has the table for the detail anyway.
        if (w > 500) {
            c.font = `${(10 * textScale).toFixed(1)}px ui-monospace, monospace`;
            c.textBaseline = 'bottom';
            c.textAlign = 'center';
            c.fillStyle = ink;
            for (const s of stations) {
                if (!s.active) continue;
                const [x, y] = project(s.lon, s.lat, v, w, h);
                // The gap above the marker grows with the text, or a label
                // drawn twice the size sits on top of its own dot.
                c.fillText(s.name.slice(0, 14), x, y - 4 * textScale);
            }
            // And the aircraft too, once there is room for them. Zoomed out this would
            // be a hundred callsigns over each other; zoomed in it is the difference
            // between a scatter of dots and a picture of the North Atlantic track.
            if (v.z >= LABEL_ZOOM) {
                c.fillStyle = text;
                for (const a of aircraft) {
                    const name = aircraftLabel(a);
                    if (!name) continue;
                    const [x, y] = project(a.lon, a.lat, v, w, h);
                    if (x < -40 || x > w + 40 || y < -20 || y > h + 20) continue;
                    c.globalAlpha = isStale(a, now) ? 0.45 : 0.85;
                    c.fillText(name, x, y - 6 * textScale);
                }
                c.globalAlpha = 1;
            }
        }
    }, [w, h, arcs, aircraft, stations, me, now, picked, interactive, track]);

    useEffect(() => { draw(); }, [draw]);

    // Bring an aircraft picked in the table into view. Only when zoomed in — at the whole
    // world it is already on screen, and moving the map under somebody who clicked a row
    // would be a change they did not ask for.
    useEffect(() => {
        if (!interactive || !focus || view.current.z <= 1) return;
        view.current = clampView({ ...view.current, lon: focus.lon, lat: focus.lat }, w, h);
        draw();
        // `focus` is a fresh object only when the selection changes — see the caller.
    }, [focus]);   // eslint-disable-line react-hooks/exhaustive-deps

    // Canvas pixels from a pointer event, whatever CSS has scaled the canvas to.
    const at = (e) => {
        const rect = canvas.current.getBoundingClientRect();
        return [
            (e.clientX - rect.left) * (w / rect.width),
            (e.clientY - rect.top) * (h / rect.height),
        ];
    };

    // The nearest thing to a point, within a few pixels. Aircraft win ties against
    // stations because they are drawn on top and are what somebody is aiming at.
    // `reach` is in the canvas's own coordinates, which is not what a finger
    // works in: the modal's canvas is 900 wide and shown at whatever the column
    // allows — about 400 on a phone — so a radius of 12 there is five pixels on
    // the glass. The caller scales it by however much the canvas is squeezed.
    const nearest = (x, y, reach = MOUSE_REACH) => {
        let best = null;
        let bestD = reach;
        for (const hit of hits.current) {
            const d = Math.hypot(hit.x - x, hit.y - y);
            if (d < bestD || (hit.aircraft && d <= bestD)) { bestD = d; best = hit; }
        }
        return best;
    };

    // Pan and pinch. Pointer capture rather than window listeners, for the same
    // reason the spectrum has it: a drag that leaves the canvas should keep
    // panning.
    //
    // Every live pointer is tracked, not just the first. With one it is a drag;
    // with two it is a pinch, which is the only way to zoom on a touchscreen —
    // there is no wheel, and the +/- buttons are a poor substitute for the
    // gesture every other map on the device answers to. Holding a single
    // `drag` was also wrong before a pinch existed: a second finger overwrote
    // its origin and the map jumped.
    const drag = useRef(null);
    const pointers = useRef(new Map());
    const pinch = useRef(null);
    const pinched = useRef(false);

    // The two-finger gesture, in client coordinates: how far apart and where
    // between.
    const gesture = () => {
        const [a, b] = Array.from(pointers.current.values());
        if (!a || !b) return null;
        return {
            dist: Math.hypot(a.x - b.x, a.y - b.y),
            x: (a.x + b.x) / 2,
            y: (a.y + b.y) / 2,
        };
    };

    const panBy = (dx, dy) => {
        const [lon, lat] = unproject(w / 2 - dx, h / 2 - dy, view.current, w, h);
        view.current = clampView({ ...view.current, lon, lat }, w, h);
    };

    const onDown = (e) => {
        if (!interactive) return;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        e.currentTarget.setPointerCapture(e.pointerId);
        if (pointers.current.size >= 2) {
            // The drag is over: from here the two fingers move the map
            // together, and a drag origin left behind would fight them.
            drag.current = null;
            pinch.current = gesture();
            pinched.current = true;
            return;
        }
        drag.current = { x: e.clientX, y: e.clientY, moved: 0, kind: e.pointerType };
    };
    const onMove = (e) => {
        if (!interactive) return;
        if (pointers.current.has(e.pointerId)) {
            pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        }

        if (pointers.current.size >= 2 && pinch.current) {
            const now = gesture();
            if (!now) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const scale = rect.width / w;
            // The midpoint carries the pan, the separation carries the zoom.
            // Panning first means the zoom anchors on where the fingers are
            // now rather than where they were, so the map stays under them.
            panBy((now.x - pinch.current.x) / scale, (now.y - pinch.current.y) / scale);
            if (pinch.current.dist > 0 && now.dist > 0) {
                zoomTo(
                    view.current.z * (now.dist / pinch.current.dist),
                    (now.x - rect.left) / scale,
                    (now.y - rect.top) / scale,
                );
            } else {
                setHover(null);
                draw();
            }
            pinch.current = now;
            return;
        }

        if (drag.current) {
            const rect = e.currentTarget.getBoundingClientRect();
            const scale = rect.width / w;
            const dx = (e.clientX - drag.current.x) / scale;
            const dy = (e.clientY - drag.current.y) / scale;
            // Accumulated on the glass, not in canvas units. Divided by the
            // scale it was a tenth of the distance on a phone, so a tap that
            // moved two pixels read as a four-hundred-mile pan and the press
            // was never a click at all — which is why nothing could be
            // selected by touch however carefully it was aimed.
            drag.current.moved += Math.abs(e.clientX - drag.current.x)
                + Math.abs(e.clientY - drag.current.y);
            drag.current.x = e.clientX;
            drag.current.y = e.clientY;
            panBy(dx, dy);
            setHover(null);
            draw();
            return;
        }
        // A finger has no hover: it would put a tip up on touch-down and leave it there,
        // and the tap is already handled as a selection.
        if (e.pointerType !== 'mouse') return;
        const [x, y] = at(e);
        const hit = nearest(x, y);
        // Only when it is a different thing under the pointer. A mouse crossing the map
        // fires this sixty times a second, and re-rendering for each of them to say the
        // same aeroplane is still there is the one avoidable cost in here.
        setHover((prev) => {
            if (prev && hit && prev.aircraft === hit.aircraft && prev.station === hit.station) {
                return prev;
            }
            return hit ? { ...hit } : null;
        });
    };
    const onUp = (e) => {
        if (!interactive) return;
        pointers.current.delete(e.pointerId);
        if (pointers.current.size < 2) pinch.current = null;
        // Down to one finger after a pinch: that finger becomes the drag, from
        // where it is now. Without the fresh origin the map leaps by however
        // far it travelled during the pinch.
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
        // A pinch is not a tap, however still the last finger was.
        if (wasDrag || wasPinch || !pick) return;
        const [x, y] = at(e);
        const rect = e.currentTarget.getBoundingClientRect();
        const squeeze = rect.width ? w / rect.width : 1;
        const hit = nearest(x, y, (touch ? TOUCH_REACH : MOUSE_REACH) * squeeze);
        // A click on empty ocean clears the selection, which is the only way back from
        // one without hunting for a close button.
        pick(hit && hit.aircraft ? hit.aircraft : null);
    };

    const zoomTo = useCallback((next, px, py) => {
        const cx = px == null ? w / 2 : px;
        const cy = py == null ? h / 2 : py;
        // Zoom about a point: whatever is under it stays put, which is what makes a map
        // feel like a map rather than a slideshow.
        const [lon, lat] = unproject(cx, cy, view.current, w, h);
        const zz = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
        const after = { ...view.current, z: zz };
        const [lon2, lat2] = unproject(cx, cy, after, w, h);
        view.current = clampView(
            { z: zz, lon: after.lon + (lon - lon2), lat: after.lat + (lat - lat2) }, w, h,
        );
        setZ(view.current.z);
        setHover(null);
        draw();
    }, [w, h, draw]);

    // A non-passive wheel handler, because a scroll over a map must not scroll the modal
    // behind it — and preventDefault is not available to React's passive listener.
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

    const home = () => {
        view.current = { ...HOME };
        setZ(1);
        setHover(null);
        draw();
    };

    const canvasEl = (
        <canvas
            ref={canvas}
            /* touch-action only on the interactive copy: the browser must not
               claim the gesture there, and the panel's map is something you
               scroll the dock past. */
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

    const tip = hover && (hover.aircraft ? (
        <>
            <b>{aircraftLabel(hover.aircraft)}</b>
            <span>
                {[
                    freqLabel(hover.aircraft.khz),
                    altLabel(hover.aircraft.alt),
                    hover.aircraft.speed != null ? `${Math.round(hover.aircraft.speed)} kt` : '',
                ].filter(Boolean).join(' · ')}
            </span>
            <span>
                {[
                    (stationOf(stations, hover.aircraft.gs) || {}).name || '',
                    hover.aircraft.at ? sinceLabel(hover.aircraft.at, now) : '',
                ].filter(Boolean).join(' · ')}
            </span>
        </>
    ) : (
        <>
            <b>{hover.station.name || `GS ${hover.station.id}`}</b>
            <span>
                {hover.station.active ? 'Squitter heard' : 'No squitter'}
                {hover.station.at ? ` · ${sinceLabel(hover.station.at, now)}` : ''}
            </span>
        </>
    ));

    return (
        <div className="hf__stage">
            {canvasEl}

            {hover && (
                <i
                    className="hf__ring"
                    style={{ left: `${(hover.x / w) * 100}%`, top: `${(hover.y / h) * 100}%` }}
                />
            )}
            {hover && (
                <div
                    className={`hf__tip${hover.x > w * 0.6 ? ' is-left' : ''}`}
                    style={{ left: `${(hover.x / w) * 100}%`, top: `${(hover.y / h) * 100}%` }}
                >
                    {tip}
                </div>
            )}

            {/* Buttons as well as the wheel: a trackpad scroll is a zoom nobody asked
                for as often as it is one they did, and a touchscreen has no wheel. */}
            <div className="hf__zoom">
                <button
                    type="button"
                    onClick={() => zoomTo(view.current.z * ZOOM_STEP)}
                    disabled={z >= ZOOM_MAX}
                    title="Zoom in"
                >+</button>
                <button
                    type="button"
                    onClick={() => zoomTo(view.current.z / ZOOM_STEP)}
                    disabled={z <= ZOOM_MIN}
                    title="Zoom out"
                >−</button>
                <button
                    type="button"
                    onClick={home}
                    disabled={z <= ZOOM_MIN}
                    title="Whole world"
                >⟲</button>
            </div>
        </div>
    );
}

// What the lookups said, kept for the session. Two aircraft clicked twice is two
// requests to somebody else's API for an answer that has not changed since the aeroplane
// was built.
const enrichCache = new Map();
const photoCache = new Map();

const cached = (store, key, url) => {
    if (store.has(key)) return Promise.resolve(store.get(key));
    return fetch(url)
        .then((r) => (r.ok ? r.json() : null))
        // A 404 is an answer — nobody has a photo of this registration — and worth
        // remembering. A request that never arrived is not, so it is not cached: the
        // next click on that aeroplane should ask again.
        .then((j) => { store.set(key, j); return j; })
        .catch(() => null);
};

/** One row of the detail column, absent entirely when there is nothing to put in it. */
function Row({ k, children }) {
    if (children == null || children === '' || children === false) return null;
    return (
        <div className="kv">
            <span className="kv__k">{k}</span>
            <span className="kv__v">{children}</span>
        </div>
    );
}

/**
 * Everything about one aeroplane.
 *
 * The live half comes from the poll that is happening anyway; the photo, the operator and
 * the route come from the addon's lookup routes, which reach out to Planespotters and
 * adsbdb and are therefore asked for once per aircraft and only when one is clicked.
 * Nothing here blocks anything else: the panel is filled in from the position report
 * immediately and the rest arrives when it arrives, or does not.
 */
function AircraftCard({ a, stations, me, now, onClose }) {
    const [info, setInfo] = useState(null);
    const [photo, setPhoto] = useState(null);
    const hex = icaoHex(a);

    useEffect(() => {
        if (!hex) { setInfo(null); setPhoto(null); return undefined; }
        let alive = true;
        setInfo(null);
        setPhoto(null);
        cached(enrichCache, hex, enrichUrl(hex))
            .then((j) => { if (alive) setInfo(enrichment(j)); });
        cached(photoCache, hex, photoUrl(hex))
            .then((j) => { if (alive) setPhoto(firstPhoto(j)); });
        return () => { alive = false; };
    }, [hex]);

    const gs = stationOf(stations, a.gs);
    const dist = me ? greatCircleKm(me, a) : null;
    const route = info && (info.from || info.to)
        ? `${airportLabel(info.from) || '?'} → ${airportLabel(info.to) || '?'}`
        : '';

    return (
        <div className="hf__card">
            <div className="hf__card-head">
                <span className="hf__card-call">{aircraftLabel(a)}</span>
                <button type="button" className="hf__card-close" onClick={onClose} title="Close">
                    <Icon.Close size={14} />
                </button>
            </div>
            {(info && (info.operator || info.type)) ? (
                <div className="hf__card-sub">
                    {[info.operator, info.type].filter(Boolean).join(' · ')}
                </div>
            ) : null}

            {photo && (
                <a
                    className="hf__photo"
                    href={photo.link || undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={photo.by ? `${photo.by} · Planespotters.net` : 'Planespotters.net'}
                >
                    <img src={photo.src} alt={aircraftLabel(a)} loading="lazy" />
                    <span>{photo.by ? `${photo.by} · Planespotters` : 'Planespotters'}</span>
                </a>
            )}

            <div className="kv-list">
                <Row k="Registration">{(info && info.registration) || a.reg || ''}</Row>
                <Row k="ICAO">{hex}</Row>
                <Row k="Type">{info && info.icaoType}</Row>
                <Row k="Built by">{info && info.manufacturer}</Row>
                <Row k="Registered">{info && info.country}</Row>
                <Row k="IATA flight">{info && info.iataFlight}</Row>
                <Row k="Route">{route}</Row>
                <Row k="Frequency">{freqLabel(a.khz)}</Row>
                <Row k="Via">{gs ? gs.name : (a.gs ? `GS ${a.gs}` : '')}</Row>
                {/* Zero is the addon's "not measured", not a full-scale signal: sig_level
                    has no omitempty, so it arrives as 0 on a message that carried none. */}
                <Row k="Signal">{a.sig ? `${a.sig.toFixed(1)} dBFS` : ''}</Row>
                <Row k="Altitude">{altLabel(a.alt)}</Row>
                <Row k="Speed">{a.speed != null ? `${Math.round(a.speed)} kt` : ''}</Row>
                <Row k="Heading">{headingLabel(a.track)}</Row>
                <Row k="Distance">{kmLabel(dist)}</Row>
                <Row k="Tracked">{kmLabel(a.trackedKm)}</Row>
                <Row k="Messages">{a.msgs ? a.msgs.toLocaleString() : ''}</Row>
                <Row k="Last heard">{a.at ? sinceLabel(a.at, now) : ''}</Row>
            </div>
        </div>
    );
}

export default function HFDLPanel({ minimal }) {
    const { serverInfo } = useRadio();
    const [arcs, setArcs] = useState(null);
    const [all, setAll] = useState([]);
    const [stations, setStations] = useState([]);
    const [stats, setStats] = useState(null);
    const [state, setState] = useState('loading');   // loading | ok | error
    const [now, setNow] = useState(() => Date.now());
    const [open, setOpen] = useState(false);
    const [pickKey, setPickKey] = useState(null);
    const [track, setTrack] = useState(null);
    // The bands switched off in the legend. A Set of MHz, not persisted: a filter that
    // survived a reload would be a map quietly missing half its aircraft on a panel
    // whose legend is only visible in the modal.
    const [bandsOff, setBandsOff] = useState(() => new Set());
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
                setAll(liveAircraft(rows));
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
        return feedInterval(() => poll(open), open ? MODAL_POLL_MS : POLL_MS);
    }, [poll, open]);

    const bands = useMemo(() => bandCounts(all), [all]);
    const aircraft = useMemo(() => visibleAircraft(all, bandsOff), [all, bandsOff]);

    // The selection is a key rather than the record: the poll replaces every aircraft
    // object every thirty seconds, and a card holding the one it was opened with would
    // stop moving the moment it was opened.
    const picked = useMemo(
        () => (pickKey ? aircraft.find((a) => a.key === pickKey) || null : null),
        [aircraft, pickKey],
    );

    // The track, once per selection and again whenever that aircraft reports. Cleared
    // first, so the previous aeroplane's path is never drawn under this one's dot.
    useEffect(() => {
        if (!open || !picked) { setTrack(null); return undefined; }
        let live = true;
        fetch(trackUrl(picked.key))
            .then((r) => (r.ok ? r.json() : null))
            .then((rows) => { if (live && alive.current) setTrack(trackPoints(rows)); })
            .catch(() => { if (live) setTrack(null); });
        return () => { live = false; };
        // Deliberately keyed on the position rather than the whole record: `picked` is a
        // fresh object on every poll, and the track only changes when the aircraft moves.
    }, [open, pickKey, picked && picked.at]);   // eslint-disable-line react-hooks/exhaustive-deps

    // A new object only when the selection changes, so the map recentres on a pick and
    // not on every poll that arrives while somebody is panning.
    const focus = useMemo(
        () => (picked ? { lon: picked.lon, lat: picked.lat } : null),
        [pickKey],   // eslint-disable-line react-hooks/exhaustive-deps
    );

    const toggleBand = (mhz) => setBandsOff((prev) => {
        const next = new Set(prev);
        if (next.has(mhz)) next.delete(mhz);
        else next.add(mhz);
        return next;
    });

    // Where this receiver is, so the map has an origin. Absent on an instance that has
    // not set its position, which is why nothing depends on it.
    const gps = (serverInfo && serverInfo.receiver && serverInfo.receiver.gps) || {};
    const me = (gps.lat || gps.lon) ? { lat: Number(gps.lat), lon: Number(gps.lon) } : null;

    const sum = hfdlSummary(aircraft, stats, now);

    if (state === 'loading') return <Empty>Loading…</Empty>;
    if (state === 'error' && !all.length) {
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
                <WorldMap
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
                    {/* The band filter lives in the modal, and the map out here obeys it.
                        Without this the panel would just be quietly short of aeroplanes. */}
                    {bandsOff.size > 0 && (
                        <span title="Switched off in the map's band legend">
                            <i>−{bandsOff.size} band{bandsOff.size > 1 ? 's' : ''}</i>
                        </span>
                    )}
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
                        <div className="hf__cols">
                            <div className="hf__mapcol">
                                <WorldMap
                                    w={BIG_W}
                                    h={BIG_H}
                                    arcs={arcs}
                                    aircraft={aircraft}
                                    stations={stations}
                                    me={me}
                                    now={now}
                                    interactive
                                    track={track}
                                    focus={focus}
                                    pick={(a) => setPickKey(a ? a.key : null)}
                                    picked={pickKey}
                                />

                                {/* The legend is the filter. Each swatch is the colour of
                                    a band on the map and a switch for it, which is one
                                    control doing the job of two and is why the colours
                                    are worth having at all. */}
                                {bands.length > 0 && (
                                    <div className="hf__bands">
                                        {bands.map((b) => (
                                            <button
                                                key={b.mhz}
                                                type="button"
                                                className={`hf__band${bandsOff.has(b.mhz) ? ' is-off' : ''}`}
                                                onClick={() => toggleBand(b.mhz)}
                                                title={bandsOff.has(b.mhz)
                                                    ? `Show the ${b.mhz} MHz band`
                                                    : `Hide the ${b.mhz} MHz band`}
                                            >
                                                <i style={{ background: bandColour(b.mhz) }} />
                                                {b.mhz ? `${b.mhz} MHz` : 'no freq'}
                                                <em>{b.count}</em>
                                            </button>
                                        ))}
                                    </div>
                                )}

                                <div className="hf__legend">
                                    <span><i className="hf__sq" /> ground station</span>
                                    {me && <span><i className="hf__me" /> this receiver</span>}
                                    <span>faded — no report for 30 min</span>
                                    {sum.messages != null && (
                                        <span className="hf__msgs">
                                            {sum.messages.toLocaleString()} messages decoded
                                        </span>
                                    )}
                                </div>
                            </div>

                            {picked ? (
                                <AircraftCard
                                    a={picked}
                                    stations={stations}
                                    me={me}
                                    now={now}
                                    onClose={() => setPickKey(null)}
                                />
                            ) : (
                                <div className="hf__card hf__card--empty">
                                    Click an aircraft — on the map or in the list — for its
                                    registration, operator, route and track.
                                </div>
                            )}
                        </div>

                        {/* The aircraft themselves. Clicking the map picks one out here
                            and clicking a row marks it on the map — the two are the same
                            list seen twice, and matching them up by eye across a world
                            map is the thing that needs help. */}
                        {aircraft.length === 0 ? (
                            <Empty>
                                {all.length ? 'Every band is switched off.' : 'Nothing heard yet.'}
                            </Empty>
                        ) : (
                            <div className="hf__table">
                                <table>
                                    <thead>
                                        <tr>
                                            <th>Flight</th>
                                            <th>Freq</th>
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
                                                        pickKey === a.key ? 'is-picked' : '',
                                                        isStale(a, now) ? 'is-stale' : '',
                                                    ].filter(Boolean).join(' ')}
                                                    onClick={() => setPickKey(a.key)}
                                                >
                                                    <td title={[a.icao, a.reg].filter(Boolean).join(' · ')}>
                                                        <i
                                                            className="hf__swatch"
                                                            style={{ background: bandColour(bandOf(a.khz)) }}
                                                        />
                                                        {aircraftLabel(a)}
                                                    </td>
                                                    <td>{a.khz ? (a.khz / 1000).toFixed(3) : '—'}</td>
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

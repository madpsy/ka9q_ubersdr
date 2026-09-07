// Every spot that said where it was, on one map.
//
// The single-spot view answers "where is this one"; this answers the question
// that follows it — where is everything, and what does that say about the band.
// A list sorted by time cannot show that: propagation is a shape, and a column
// of callsigns is not a shape.
//
// ── What can be drawn ───────────────────────────────────────────────────────
//
// Only spots carrying a locator. A digital decode usually has one because the
// mode sends it; a DX cluster spot usually does not. There is no lookup here and
// there could not be — one request per station, several hundred stations, and a
// rate limit that exists precisely to stop that. The count says how many were
// left out rather than quietly showing a partial map as though it were the whole
// one.
//
// ── Holding still ───────────────────────────────────────────────────────────
//
// The map is built once and the markers are a layer that is emptied and refilled,
// because a busy FT8 band delivers a spot every second or so and rebuilding a
// Leaflet map at that rate would throw away the operator's pan and zoom each
// time. The refill is throttled for the same reason: it costs a few hundred
// markers, which is nothing once and a lot at 1 Hz.
//
// The view is fitted once, when the map opens. Refitting on every arrival would
// move the ground under a pointer that was going somewhere, and refitting on a
// filter change would do it while somebody was typing.

import React, { useEffect, useMemo, useRef, useState } from '../react.js';
import { loadScript, loadStyle } from '../lib/loadScript.js';
import { geodesicPoints, maidenheadToLatLon } from '../lib/callsign.js';
import { TOUCH_QUERY } from '../lib/useMediaQuery.js';

// Tooltip content is HTML to Leaflet, and every part of it — a callsign, a
// country from a prefix table — arrived over the wire.
const esc = (v) => String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const LEAFLET_JS = '/leaflet.js';
const LEAFLET_CSS = '/leaflet.css';

// How often the markers may be rebuilt, ms. Fast enough that a new decode
// appears while you are looking at it, slow enough that a busy band does not
// spend the frame budget on Leaflet.
const REDRAW_MS = 600;

// More than this and the map is a solid mass rather than a picture, and the
// browser is doing a lot of work to draw one. Newest first, which is the order
// the store keeps.
const MAX_POINTS = 1200;

// ── Hitting a dot with a finger ─────────────────────────────────────────────
//
// The markers are 4px circles, which is the right size to look at and about a
// fifth of the size a fingertip can be aimed at. With a mouse that is fine —
// the pointer is a pixel — so this map worked everywhere it was built and was
// unusable on the tablet: taps landed on the sea beside the operation rather
// than on it, and nothing opened. Two separate things in Leaflet cause that,
// and both are here rather than one, because fixing either alone still leaves
// a map you cannot press.
//
// 1. **Where the press has to land.** An SVG path is hit-tested by the browser
//    against the shape itself, so the target is the 9px the dot draws and not
//    a pixel more. Each dot therefore gets a second circle under it, several
//    times the size and painted with nothing: `fill` is a colour and
//    `fill-opacity` is 0, which is invisible and still a target, because
//    `pointer-events: visiblePainted` — what leaflet.css gives an interactive
//    path — asks whether `fill` is `none`, not how opaque it is. The handlers
//    go on both, so the dot answers a press and so does the ring of map around
//    it.
//
//    Leaflet has a `tolerance` option that does this without a second layer,
//    and it was the first thing tried. It exists only on the canvas renderer —
//    only there does Leaflet hit-test in JavaScript rather than leaving it to
//    the browser — so taking it means drawing the dots on a canvas, and on iOS
//    a canvas the size of the map, transformed as the map pans, tore into
//    vertical bands across the tiles. Every other platform was fine with it.
//    Not worth a rendering artifact on the one device the fix is for: SVG
//    draws the dots, as it always did, and the target is a shape rather than
//    an option.
//
// 2. **Whether the press counts as a press at all.** Leaflet begins panning as
//    soon as a pointer moves 3px (Draggable's own clickTolerance, summed across
//    both axes), and `Map._draggableMoved` then discards the click that
//    follows. A finger rolls further than that on the way down almost every
//    time, so even a tap dead on the dot was being spent panning the map a
//    pixel. Raised for a coarse pointer, not removed: past this it really was a
//    drag.
//
// Both only when there is a finger in play. A mouse asks for neither: it can
// hit 9px, a 36px target under it would make two nearby stations one, and the
// hit rings would double the number of paths on a map that already draws up to
// MAX_POINTS of them.
const TOUCH_SLOP = 18;   // radius of the invisible circle that takes the tap
const TAP_SLOP = 10;     // px of travel still counted as a tap, not a pan

// Is there a fingertip available, wherever the primary pointer is? The same
// question the rest of the interface asks — see TOUCH_QUERY, and note that it
// is `any-pointer`, so an iPad with a keyboard case still answers yes.
const coarsePointer = () => {
    try { return window.matchMedia(TOUCH_QUERY).matches; } catch (e) { return false; }
};

/** The spots that can be placed at all, with their positions attached. */
export function placeable(spots, limit = MAX_POINTS) {
    const out = [];
    for (const s of spots) {
        if (out.length >= limit) break;
        const at = s.grid ? maidenheadToLatLon(s.grid) : null;
        if (at) out.push({ spot: s, lat: at.lat, lon: at.lon });
    }
    return out;
}

export default function SpotsWorldMap({ points, receiver, onPick, labels, className }) {
    const box = useRef(null);
    const map = useRef(null);
    const layer = useRef(null);
    const [failed, setFailed] = useState(false);
    const [ready, setReady] = useState(false);
    const fitted = useRef(false);
    // The path under the pointer, if any. One line, moved rather than added to:
    // a map of several hundred stations with a path to each is a cat's cradle,
    // and the question a hover asks is about one of them.
    const hover = useRef(null);
    // Read by the redraw without making it a dependency: the timer fires on its
    // own schedule and wants whatever is current when it does.
    const live = useRef({ points, onPick, labels });
    live.current = { points, onPick, labels };
    const lastDrawn = useRef(0);

    const rx = receiver && receiver.gps && (receiver.gps.lat || receiver.gps.lon)
        ? { lat: receiver.gps.lat, lon: receiver.gps.lon, label: receiver.callsign || 'Receiver' }
        : null;

    // ---- the map, once ------------------------------------------------------
    useEffect(() => {
        let cancelled = false;
        const build = async () => {
            await Promise.all([loadStyle(LEAFLET_CSS), loadScript(LEAFLET_JS)]);
            const L = window.L;
            if (cancelled || !L || !box.current || map.current) return;

            const m = L.map(box.current, {
                scrollWheelZoom: true,
                attributionControl: false,
                worldCopyJump: true,
            }).setView(rx ? [rx.lat, rx.lon] : [20, 0], rx ? 3 : 2);
            map.current = m;

            // How far a finger may roll before the tap becomes a pan.
            const coarse = coarsePointer();
            // Leaflet offers no map option for it and no accessor either, so it
            // is set on the drag handler's own Draggable. Against a copy of
            // Leaflet that is vendored in this repository (static/leaflet.js,
            // 1.9.4) rather than one that can move underneath us — and guarded,
            // so a build with dragging disabled is a map that does not pan
            // rather than one that does not load.
            if (coarse && m.dragging && m.dragging._draggable) {
                m.dragging._draggable.options.clickTolerance = TAP_SLOP;
            }

            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
            }).addTo(m);

            if (rx) {
                L.marker([rx.lat, rx.lon], {
                    icon: L.divIcon({
                        className: '',
                        html: '<div style="width:14px;height:14px;background:#28a745;'
                            + 'border:3px solid #fff;border-radius:50%;'
                            + 'box-shadow:0 0 6px rgba(40,167,69,0.8);"></div>',
                        iconSize: [14, 14],
                        iconAnchor: [7, 7],
                    }),
                    // Above the spots, which are a layer of circles: the one
                    // fixed point on the map should not be lost under them.
                    zIndexOffset: 1000,
                }).addTo(m).bindTooltip(rx.label, { direction: 'top', className: 'csmap__tip' });
            }

            layer.current = L.layerGroup().addTo(m);
            setReady(true);
        };

        build().catch(() => { if (!cancelled) setFailed(true); });
        return () => {
            cancelled = true;
            if (map.current) {
                map.current.remove();
                map.current = null;
                layer.current = null;
            }
        };
        // Built once. The receiver cannot move under an open modal, and the
        // points are drawn by the effect below rather than by this one.
    }, []);

    // What is on screen, cheaply. Length and the two ends: the store prepends
    // and caps, and every filter change moves at least one of the three.
    const sig = useMemo(() => {
        const first = points.length ? points[0].spot.key : '';
        const last = points.length ? points[points.length - 1].spot.key : '';
        return `${points.length}|${first}|${last}`;
    }, [points]);

    // ---- the markers, throttled ---------------------------------------------
    //
    // Leading edge, then trailing: a filter change or a search keystroke is drawn
    // on the spot, and a run of arrivals afterwards is collapsed into one redraw
    // per REDRAW_MS. A plain interval would have done neither — it would lag
    // every edit by up to its own period and redraw a still map for ever.
    useEffect(() => {
        if (!ready) return undefined;

        const dropPath = () => {
            if (!hover.current) return;
            hover.current.remove();
            hover.current = null;
        };

        const drawPath = (lat, lon) => {
            const L = window.L;
            const m = map.current;
            if (!L || !m || !rx) return;
            dropPath();
            hover.current = L.polyline(geodesicPoints(rx.lat, rx.lon, lat, lon), {
                color: '#e5484d',
                weight: 2,
                opacity: 0.85,
                dashArray: '5, 6',
                // Nothing to press: the dot underneath owns the click, and a
                // line drawn across the map must not steal one meant for a
                // station it happens to pass over.
                interactive: false,
            }).addTo(m);
        };

        const draw = () => {
            const L = window.L;
            const m = map.current;
            const g = layer.current;
            if (!L || !m || !g) return;
            const { points: pts, onPick: pick, labels: named } = live.current;

            // Any path drawn over the old markers belongs to a marker that is
            // about to stop existing.
            dropPath();
            g.clearLayers();
            const coarse = pick ? coarsePointer() : false;
            for (const p of pts) {
                const s = p.spot;

                // What a fingertip actually hits — see TOUCH_SLOP. Added before
                // the dot so the dot lies on top of it, and only where there is
                // a finger and something for a press to do: on a mouse-driven
                // map this loop is exactly what it always was.
                if (coarse) {
                    const hit = L.circleMarker([p.lat, p.lon], {
                        radius: TOUCH_SLOP,
                        stroke: false,
                        // A fill that is a colour and no opacity at all: this
                        // has to be painted to be pressed, and invisible to be
                        // bearable. `csmap__hit` insists on the first of those
                        // in CSS, where the cascade can be seen.
                        fillOpacity: 0,
                        className: 'csmap__hit',
                    });
                    hit.on('click', () => { if (pick) pick(s); });
                    if (rx) {
                        hit.on('mouseover', () => drawPath(p.lat, p.lon));
                        hit.on('mouseout', dropPath);
                    }
                    hit.addTo(g);
                }
                const dot = L.circleMarker([p.lat, p.lon], {
                    radius: 4,
                    weight: 1,
                    color: 'rgba(255,255,255,0.85)',
                    fillColor: '#dc3545',
                    fillOpacity: 0.9,
                });
                // Hover, not permanent: several hundred permanent labels is a
                // wall of text with a map somewhere behind it.
                dot.bindTooltip(
                    [
                        `<b>${esc(s.callsign)}</b>`,
                        esc([s.submode ? `${s.mode}/${s.submode}` : s.mode,
                            s.snr != null ? `${s.snr > 0 ? '+' : ''}${s.snr} dB` : '',
                            s.grid || ''].filter(Boolean).join('  ·  ')),
                        esc(s.country || ''),
                        s.distanceKm != null ? `${Math.round(s.distanceKm)} km` : '',
                    ].filter(Boolean).join('<br>'),
                    { direction: 'top', className: 'csmap__tip' },
                );
                dot.on('click', () => { if (pick) pick(s); });
                // The great circle to this one, while the pointer is on it. It
                // is the thing a map of a band is for — not where the stations
                // are, but which way the signals came — and drawing it on hover
                // means every station answers that in turn without a single
                // press. On a touchscreen there is no hover and the path arrives
                // with the single-spot view instead, which a tap already opens.
                if (rx) {
                    dot.on('mouseover', () => drawPath(p.lat, p.lon));
                    dot.on('mouseout', dropPath);
                }
                dot.addTo(g);

                // The callsign, written under the dot and left there.
                //
                // A separate tooltip layer rather than the dot's own, because a
                // layer holds one: binding this to the marker would replace the
                // hover detail above it with a callsign that is already on
                // screen. Standalone tooltips are a Leaflet layer like any
                // other (`_source` is optional throughout Tooltip), so this
                // joins the same group and is cleared with everything else on
                // the next redraw.
                //
                // Below, where the hover tooltip is above: the two never fight
                // for the same strip of map, and the label cannot cover the
                // station it belongs to. Nothing to press, either — Leaflet's
                // own CSS gives a non-interactive tooltip `pointer-events:
                // none`, so a label lying over a neighbouring dot does not eat
                // the tap that was meant for it.
                if (named && s.callsign) {
                    L.tooltip({
                        permanent: true,
                        direction: 'bottom',
                        // Leaflet's own .leaflet-tooltip-bottom adds 6px of
                        // margin to this, so 2 puts the label 8px under the
                        // centre of a 4px dot — clear of it, and close enough
                        // that a crowd of them stays legible as pairs.
                        offset: [0, 2],
                        className: 'csmap__label',
                    })
                        .setLatLng([p.lat, p.lon])
                        .setContent(esc(s.callsign))
                        .addTo(g);
                }
            }

            // Once, on the first draw that had anything to fit. After that the
            // view belongs to whoever is panning it — refitting on an arrival
            // would move the ground under a pointer that was going somewhere.
            if (!fitted.current && pts.length) {
                fitted.current = true;
                const bounds = L.latLngBounds(pts.map((p) => [p.lat, p.lon]));
                if (rx) bounds.extend([rx.lat, rx.lon]);
                m.fitBounds(bounds.pad(0.1));
            }
        };

        const since = Date.now() - lastDrawn.current;
        const id = setTimeout(() => {
            lastDrawn.current = Date.now();
            draw();
        }, Math.max(0, REDRAW_MS - since));
        return () => {
            clearTimeout(id);
            dropPath();
        };
    }, [ready, sig]);

    // No great-circle paths here, deliberately: one per station is a cat's
    // cradle over the map, and the single-spot view draws the one that matters
    // once somebody has said which station they mean.
    if (failed) return null;
    return <div className={`csmap${className ? ` ${className}` : ''}`} ref={box} />;
}

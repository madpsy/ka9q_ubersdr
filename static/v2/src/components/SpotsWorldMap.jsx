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
import { maidenheadToLatLon } from '../lib/callsign.js';

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

export default function SpotsWorldMap({ points, receiver, onPick, className }) {
    const box = useRef(null);
    const map = useRef(null);
    const layer = useRef(null);
    const [failed, setFailed] = useState(false);
    const [ready, setReady] = useState(false);
    const fitted = useRef(false);
    // Read by the redraw without making it a dependency: the timer fires on its
    // own schedule and wants whatever is current when it does.
    const live = useRef({ points, onPick });
    live.current = { points, onPick };
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

        const draw = () => {
            const L = window.L;
            const m = map.current;
            const g = layer.current;
            if (!L || !m || !g) return;
            const { points: pts, onPick: pick } = live.current;

            g.clearLayers();
            for (const p of pts) {
                const s = p.spot;
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
                dot.addTo(g);
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
        return () => clearTimeout(id);
    }, [ready, sig]);

    // No great-circle paths here, deliberately: one per station is a cat's
    // cradle over the map, and the single-spot view draws the one that matters
    // once somebody has said which station they mean.
    if (failed) return null;
    return <div className={`csmap${className ? ` ${className}` : ''}`} ref={box} />;
}

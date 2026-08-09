// Where the station is, on the same map v1's callsign_lookup.html draws.
//
// OpenStreetMap tiles, one marker on the operator's position, and the callsign
// pinned to it as a permanent tooltip rather than a popup you have to open. A
// popup is right on the full page, where the map is the size of the window and
// carries distance, bearing and a local clock; here the map is a strip in a dock
// column and the one thing worth reading off it is which dot is whose.
//
// Leaflet is loaded on demand from the files the server already serves for v1 —
// 150 KB that only a map wants, so it stays out of the bundle and a session that
// never opens one never fetches it. StartMap does the same, and the two share
// nothing else on purpose: that map fits two pins and a path between them, this
// one has a single point and a callsign.

import React, { useEffect, useRef, useState } from '../react.js';
import { loadScript, loadStyle } from '../lib/loadScript.js';
import { geodesicPoints } from '../lib/callsign.js';

const LEAFLET_JS = '/leaflet.js';
const LEAFLET_CSS = '/leaflet.css';

// Close enough to see the town, far enough to see where the town is. v1 opens at
// 10 with a window to spare; this map is a few hundred pixels tall, so it starts
// wider and lets the operator zoom in.
const ZOOM = 7;
// A position derived from a four-character grid square is a 100-km box, and a
// map that opens at street level on one is stating a precision it does not have.
const ZOOM_GRID = 5;

/**
 * @param call      the callsign, and the first line of the label.
 * @param position  { lat, lon, fromGrid } — see positionOf.
 * @param lines     what else the label says, under the callsign. Empty in the
 *                  panel, where everything it could say is already in the rows
 *                  above the map; filled in the spot modal, where the map *is*
 *                  the answer and there is nothing else on screen.
 * @param className extra class for the box, so a modal can size it.
 * @param from      the receiver: { lat, lon, label }. Given one, the map draws
 *                  it as a second pin with a great-circle path to the station
 *                  and fits both on screen — the picture the distance and
 *                  bearing are numbers for. Omitted in the Callsign panel, where
 *                  the map is a strip and two pins on it would be two dots.
 */
export default function CallsignMap({ call, position, lines, className, from }) {
    const box = useRef(null);
    const map = useRef(null);
    const [failed, setFailed] = useState(false);

    const lat = position ? position.lat : null;
    const lon = position ? position.lon : null;
    const fromGrid = !!(position && position.fromGrid);

    useEffect(() => {
        if (lat == null || lon == null) return undefined;
        let cancelled = false;

        const build = async () => {
            await Promise.all([loadStyle(LEAFLET_CSS), loadScript(LEAFLET_JS)]);
            const L = window.L;
            if (cancelled || !L || !box.current || map.current) return;

            const m = L.map(box.current, {
                // The panel it sits in scrolls, and a map that ate the wheel
                // would trap the pointer on the way past. Dragging and the zoom
                // buttons still work, which is what a map this size is for.
                scrollWheelZoom: false,
                attributionControl: false,
            }).setView([lat, lon], fromGrid ? ZOOM_GRID : ZOOM);
            map.current = m;

            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
            }).addTo(m);

            // v1's marker: a red dot with a white ring, which reads on both the
            // land and the sea colours of the OSM tiles.
            const icon = L.divIcon({
                className: '',
                html: '<div style="width:14px;height:14px;background:#dc3545;'
                    + 'border:3px solid #fff;border-radius:50%;'
                    + 'box-shadow:0 0 6px rgba(220,53,69,0.8);"></div>',
                iconSize: [14, 14],
                iconAnchor: [7, 7],
            });

            // Escaped, not trusted: every line of this comes off the wire — a
            // lookup provider's idea of an operator's name, a country from a
            // prefix table — and Leaflet takes tooltip content as HTML.
            const esc = (v) => String(v)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const label = [
                // A tilde where the position came from a grid square, for the
                // same reason the distance readout carries one: it is the centre
                // of a square, not an address.
                `<b>${esc(call)}${fromGrid ? ' ~' : ''}</b>`,
                ...(lines || []).filter(Boolean).map(esc),
            ].join('<br>');

            L.marker([lat, lon], { icon })
                .addTo(m)
                // Permanent, so the map says whose it is without being touched.
                .bindTooltip(label, {
                    permanent: true,
                    direction: 'top',
                    offset: [0, -8],
                    className: 'csmap__tip',
                })
                .openTooltip();

            // The receiver, and the path between. Green against the station's
            // red, which is v1's pairing on the same map.
            if (from && Number.isFinite(from.lat) && Number.isFinite(from.lon)) {
                const rxIcon = L.divIcon({
                    className: '',
                    html: '<div style="width:14px;height:14px;background:#28a745;'
                        + 'border:3px solid #fff;border-radius:50%;'
                        + 'box-shadow:0 0 6px rgba(40,167,69,0.8);"></div>',
                    iconSize: [14, 14],
                    iconAnchor: [7, 7],
                });
                L.marker([from.lat, from.lon], { icon: rxIcon })
                    .addTo(m)
                    // Not permanent, unlike the station's. Two labels on a map
                    // this size overlap as soon as the path is short, and of the
                    // two the station is the one you opened this to read.
                    .bindTooltip(from.label || 'Receiver', { direction: 'top', className: 'csmap__tip' });

                // A curve, because that is the path: a straight line between two
                // distant points on a Mercator map is not where the signal went.
                L.polyline(geodesicPoints(from.lat, from.lon, lat, lon), {
                    color: '#e5484d',
                    weight: 2,
                    opacity: 0.85,
                    dashArray: '5, 6',
                }).addTo(m);

                // Both ends on screen, with room at the top for the station's
                // permanent tooltip — which sits above its pin and would
                // otherwise be cropped by the edge it was just fitted to.
                m.fitBounds(
                    L.latLngBounds([from.lat, from.lon], [lat, lon]).pad(0.15),
                    { paddingTopLeft: [0, 48] },
                );
            }
        };

        build().catch(() => { if (!cancelled) setFailed(true); });

        return () => {
            cancelled = true;
            if (map.current) {
                map.current.remove();
                map.current = null;
            }
        };
    }, [lat, lon, fromGrid, call, (lines || []).join('|'),
        from && from.lat, from && from.lon, from && from.label]);

    // Nothing to draw, or Leaflet did not load: no map, and no empty box where
    // one would have been. The button that opens this is only offered when there
    // is a position, so the first case is a lookup that answered without one.
    if (lat == null || lon == null || failed) return null;

    return <div className={`csmap${className ? ` ${className}` : ''}`} ref={box} />;
}

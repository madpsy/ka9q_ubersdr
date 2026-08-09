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

const LEAFLET_JS = '/leaflet.js';
const LEAFLET_CSS = '/leaflet.css';

// Close enough to see the town, far enough to see where the town is. v1 opens at
// 10 with a window to spare; this map is a few hundred pixels tall, so it starts
// wider and lets the operator zoom in.
const ZOOM = 7;
// A position derived from a four-character grid square is a 100-km box, and a
// map that opens at street level on one is stating a precision it does not have.
const ZOOM_GRID = 5;

export default function CallsignMap({ call, position }) {
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

            L.marker([lat, lon], { icon })
                .addTo(m)
                // Permanent, so the map says whose it is without being touched.
                // A tilde where the position came from a grid square, for the
                // same reason the distance readout carries one: it is the centre
                // of a square, not an address.
                .bindTooltip(`${call}${fromGrid ? ' ~' : ''}`, {
                    permanent: true,
                    direction: 'top',
                    offset: [0, -8],
                    className: 'csmap__tip',
                })
                .openTooltip();
        };

        build().catch(() => { if (!cancelled) setFailed(true); });

        return () => {
            cancelled = true;
            if (map.current) {
                map.current.remove();
                map.current = null;
            }
        };
    }, [lat, lon, fromGrid, call]);

    // Nothing to draw, or Leaflet did not load: no map, and no empty box where
    // one would have been. The button that opens this is only offered when there
    // is a position, so the first case is a lookup that answered without one.
    if (lat == null || lon == null || failed) return null;

    return <div className="csmap" ref={box} />;
}

// Where the receiver is, and where you are — v1's map on the audio-start
// overlay (app.js, the `data.receiver.gps` block).
//
// The same picture: OpenStreetMap tiles, a red pin on the receiver carrying its
// name, location, height and whether it is in daylight; a green pin on you from
// /api/myip; and a dashed line between the two with the view fitted to both. It
// answers the question everyone has before they press start — how far away is
// this thing, and can I hear it from here.
//
// Leaflet is loaded on demand from the same files v1 serves. It is 150 KB and
// only this map wants it, so it stays out of the bundle; a receiver with no
// position configured never fetches it at all.

import React, { useEffect, useRef, useState } from '../react.js';
import { addBaseLayer, TILE_ATTRIBUTION } from '../lib/leafletBase.js';
import { loadScript, loadStyle } from '../lib/loadScript.js';
import { fetchMyIp, greeting, hasPosition, myipPosition } from '../lib/myip.js';
import { buildPopup, fetchNearbyReceivers } from '../lib/nearbyReceivers.js';

const LEAFLET_JS = '/leaflet.js';
const LEAFLET_CSS = '/leaflet.css';
const SUNCALC_JS = '/suncalc.js';

// v1's zoom before it fits to both markers, and what it falls back to when
// there is nobody to fit to.
const ZOOM = 6;

// The other public receivers: small amber dots, under this receiver's red pin
// and your green one, so the map still reads as "here and you" first. Drawn on
// a canvas with a generous hit tolerance — a few hundred of them is cheap that
// way, and a 4 px dot is otherwise impossible to tap.
const OTHER_STYLE = {
    radius: 4, color: '#ffffff', weight: 1, opacity: 0.85,
    fillColor: '#f5a623', fillOpacity: 0.9,
};

// Daylight at the receiver, from v1's own SunCalc. Absent rather than guessed
// if the library will not load: an hour's error either way is worse than
// nothing when the whole point is propagation.
function dayNight(lat, lon) {
    const SunCalc = window.SunCalc;
    if (!SunCalc || typeof SunCalc.getTimes !== 'function') return '';
    try {
        const t = SunCalc.getTimes(new Date(), lat, lon);
        const now = new Date();
        return now >= t.sunrise && now < t.sunset ? ' ☀️ Day' : ' 🌙 Night';
    } catch (e) {
        return '';
    }
}

export default function StartMap({ receiver, handheld }) {
    const box = useRef(null);
    const map = useRef(null);
    const [greet, setGreet] = useState('');
    const [failed, setFailed] = useState(false);

    const gps = receiver && receiver.gps;

    useEffect(() => {
        if (!hasPosition(gps)) return undefined;
        let cancelled = false;
        const lat = gps.lat;
        const lon = gps.lon;

        // Started now, alongside Leaflet, and never awaited by anything else: the
        // pins, the greeting and the fit do not wait on it. It cannot reject.
        const nearbyAbort = typeof AbortController === 'function' ? new AbortController() : null;
        const nearby = fetchNearbyReceivers({ signal: nearbyAbort ? nearbyAbort.signal : undefined });

        const build = async () => {
            await Promise.all([loadStyle(LEAFLET_CSS), loadScript(LEAFLET_JS)]);
            // Best-effort: the map is worth having without the day/night note.
            await loadScript(SUNCALC_JS).catch(() => {});
            const L = window.L;
            if (cancelled || !L || !box.current || map.current) return;

            const m = L.map(box.current, {
                // Wheel zoom on: the other receivers are only found by zooming
                // out from the fit to this receiver and you. Pinch (touchZoom)
                // and the +/- buttons are Leaflet's defaults and stay on too.
                scrollWheelZoom: true,
                touchZoom: true,
            }).setView([lat, lon], ZOOM);
            map.current = m;

            // Tiles, with the local outline behind them if they will not come —
            // see lib/leafletBase.js. This map is the first thing a visitor
            // sees, and on a receiver with no route out it was a dark box.
            addBaseLayer(L, m, { attribution: TILE_ATTRIBUTION });

            const dot = (size, colour, glow) => L.divIcon({
                className: '',
                html: `<div style="width:${size}px;height:${size}px;background:${colour};`
                    + 'border:2px solid rgba(255,255,255,0.9);border-radius:50%;'
                    + `box-shadow:0 0 10px ${glow};"></div>`,
                iconSize: [size, size],
                iconAnchor: [size / 2, size / 2],
            });

            const label = [
                `<strong>${receiver.name || 'Receiver'}</strong>`,
                receiver.location || '',
                `${receiver.asl || 0}m ASL${dayNight(lat, lon)}`,
            ].filter(Boolean).join('<br>');

            L.marker([lat, lon], { icon: dot(20, '#ff0000', 'rgba(255,0,0,0.5)') })
                .addTo(m)
                .bindTooltip(label, { permanent: true, direction: 'top', className: 'startmap__tip' })
                .openTooltip();

            // Everyone else, whenever the list turns up. The view is left alone:
            // it stays fitted to this receiver and you, and the rest are there to
            // be found by zooming out.
            nearby.then((list) => {
                if (cancelled || map.current !== m || !list.length) return;
                const renderer = L.canvas({ padding: 0.5, tolerance: 8 });
                for (const r of list) {
                    const dot = L.circleMarker([r.lat, r.lon], { ...OTHER_STYLE, renderer });
                    if (!handheld && r.callsign) {
                        dot.bindTooltip(r.callsign, { direction: 'top', className: 'startmap__tip' });
                    }
                    dot.bindPopup(() => buildPopup(document, r), {
                        className: 'startmap-pop', closeButton: true, maxWidth: 240, autoPanPadding: [12, 12],
                    });
                    // The hover label would sit on top of the popup it opened.
                    dot.on('popupopen', () => dot.closeTooltip());
                    dot.addTo(m);
                }
            });

            // Where the listener is. Only ever an approximation from GeoIP, so
            // it is not labelled with a place — the line and the distance are
            // the point.
            // Shared and fetched once a page — the spectrum's stats readout wants
            // the same answer, and it never changes under an open session. Never
            // throws: the receiver's own pin is still worth showing without it.
            const myip = await fetchMyIp();
            if (cancelled) return;

            setGreet(greeting(myip, handheld));

            const you = myipPosition(myip);
            if (!you) return;

            L.marker(you, { icon: dot(16, '#00ff00', 'rgba(0,255,0,0.5)') })
                .addTo(m)
                .bindTooltip('You', { direction: 'top', className: 'startmap__tip' });

            L.polyline([[lat, lon], you], {
                color: '#007bff', weight: 2, opacity: 0.6, dashArray: '5, 10',
            }).addTo(m);

            // Padded, or the receiver's permanent tooltip sits off the edge.
            m.fitBounds(L.latLngBounds([[lat, lon], you]), { padding: [60, 60] });
        };

        build().catch(() => { if (!cancelled) setFailed(true); });

        return () => {
            cancelled = true;
            if (nearbyAbort) nearbyAbort.abort();
            if (map.current) {
                map.current.remove();
                map.current = null;
            }
        };
    }, [gps && gps.lat, gps && gps.lon, handheld]);

    // No position configured, or Leaflet did not load: no map, and no gap where
    // one would have been.
    if (!hasPosition(gps) || failed) return null;

    return (
        <div className="startmap">
            <div className="startmap__canvas" ref={box} />
            {greet && <div className="startmap__hello">{greet}</div>}
        </div>
    );
}

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
import { loadScript, loadStyle } from '../lib/loadScript.js';
import { fetchMyIp, greeting, hasPosition, myipPosition } from '../lib/myip.js';

const LEAFLET_JS = '/leaflet.js';
const LEAFLET_CSS = '/leaflet.css';
const SUNCALC_JS = '/suncalc.js';

// v1's zoom before it fits to both markers, and what it falls back to when
// there is nobody to fit to.
const ZOOM = 6;

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

export default function StartMap({ receiver, mobile }) {
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

        const build = async () => {
            await Promise.all([loadStyle(LEAFLET_CSS), loadScript(LEAFLET_JS)]);
            // Best-effort: the map is worth having without the day/night note.
            await loadScript(SUNCALC_JS).catch(() => {});
            const L = window.L;
            if (cancelled || !L || !box.current || map.current) return;

            const m = L.map(box.current, {
                // A map inside a dialog should not swallow the page's scroll;
                // it is here to be looked at, and the buttons matter more.
                scrollWheelZoom: false,
            }).setView([lat, lon], ZOOM);
            map.current = m;

            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
                maxZoom: 19,
            }).addTo(m);

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

            // Where the listener is. Only ever an approximation from GeoIP, so
            // it is not labelled with a place — the line and the distance are
            // the point.
            // Shared and fetched once a page — the spectrum's stats readout wants
            // the same answer, and it never changes under an open session. Never
            // throws: the receiver's own pin is still worth showing without it.
            const myip = await fetchMyIp();
            if (cancelled) return;

            setGreet(greeting(myip, mobile));

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
            if (map.current) {
                map.current.remove();
                map.current = null;
            }
        };
    }, [gps && gps.lat, gps && gps.lon, mobile]);

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

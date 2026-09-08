// The beacon network on a map: all eighteen, and the paths that got through.
//
// The picture static/ncdxf_beacons.html draws, in a modal. A list of callsigns
// and signal figures is the wrong shape for what a beacon panel is actually
// measuring — propagation is a direction, and the eighteen beacons are spread
// round the world precisely so that which ones you hear IS the direction. Two
// beacons heard and both of them east is a fact no column of rows states.
//
// Every beacon is drawn, not only the ones heard. Which of them stayed silent
// is half the reading: a map with Hawaii and Alaska lit and South Africa dark
// says something specific about the path, and one that simply omitted the dark
// ones would look like a map of a smaller network.
//
// Leaflet is loaded on demand from the files the server already serves for v1,
// exactly as CallsignMap and SpotsWorldMap do — 150 KB that only a map wants,
// so a session that never opens one never fetches it, and this is behind a
// button for that reason rather than drawn inline in the panel.
//
// The roster's coordinates are used rather than the ones on a spot. A CW spot
// is placed from its callsign's DXCC entity, which puts KH6RS at the middle of
// Hawaii and 4U1UN at the middle of the United States; the roster carries each
// beacon's actual site. For eighteen fixed stations there is no reason to draw
// the approximation.

import React, { useEffect, useRef, useState } from '../react.js';
import { loadScript, loadStyle } from '../lib/loadScript.js';
import { geodesicPoints } from '../lib/callsign.js';
import { snrColour } from '../lib/format.js';
import { BEACON_BANDS, receiverAt, snrLabel } from '../lib/ncdxf.js';

const LEAFLET_JS = '/leaflet.js';
const LEAFLET_CSS = '/leaflet.css';

// Tooltip and popup content is HTML to Leaflet, and a callsign here comes from
// a JSON file on this server while a band and an SNR come off the spots API.
// Escaped all the same: the rule is that nothing built from data is trusted,
// not that some data is.
const esc = (v) => String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A beacon that was heard, and one that was not. The heard dot takes the colour
// of its signal — the same scale lib/format.js paints every SNR in the app, and
// the same one the panel's pips use, so a strong beacon is the same green in
// both places. The silent dot is deliberately flat: it is context, not a
// reading.
const QUIET = '#6b7280';

export default function BeaconMap({ roster, rows, band, receiver, className }) {
    const box = useRef(null);
    const map = useRef(null);
    const layer = useRef(null);
    const [ready, setReady] = useState(false);
    const [failed, setFailed] = useState(false);
    // What the last fit framed. A new band is a new question and is refitted;
    // a poll landing under somebody who has panned somewhere is not, on the
    // same reasoning as SpotsWorldMap's `fitKey`.
    const fittedBand = useRef(null);

    const rx = receiverAt(receiver);

    // ---- the map, once ------------------------------------------------------
    useEffect(() => {
        let cancelled = false;

        const build = async () => {
            await Promise.all([loadStyle(LEAFLET_CSS), loadScript(LEAFLET_JS)]);
            const L = window.L;
            if (cancelled || !L || !box.current || map.current) return;

            const m = L.map(box.current, {
                attributionControl: false,
                worldCopyJump: true,
            }).setView(rx ? [rx.lat, rx.lon] : [20, 0], 2);
            map.current = m;

            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
            }).addTo(m);

            // The receiver, in the green every map in this app marks it with.
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
                    // Above the beacons: the one fixed point on the map should
                    // not be lost under a dot that happens to land on it.
                    zIndexOffset: 1000,
                }).addTo(m).bindTooltip(esc(rx.label), { direction: 'top', className: 'csmap__tip' });
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
        // beacons are drawn by the effect below.
    }, []);

    // Leaflet measures its box when it builds, and a modal's box is laid out in
    // the same frame — so without this the tiles stop at whatever the width was
    // at that instant.
    useEffect(() => {
        if (!ready || typeof ResizeObserver === 'undefined' || !box.current) return undefined;
        const ro = new ResizeObserver(() => { if (map.current) map.current.invalidateSize(); });
        ro.observe(box.current);
        return () => ro.disconnect();
    }, [ready]);

    // ---- the beacons --------------------------------------------------------
    useEffect(() => {
        if (!ready) return;
        const L = window.L;
        const m = map.current;
        const g = layer.current;
        if (!L || !m || !g) return;

        g.clearLayers();

        const heard = new Map((rows || []).map((r) => [r.call, r]));
        const bounds = [];
        if (rx) bounds.push([rx.lat, rx.lon]);

        for (const b of roster || []) {
            if (b.lat == null || b.lon == null) continue;
            const row = heard.get(b.callsign);
            const colour = row ? snrColour(row.snr) : QUIET;

            // The path first, so a dot is never drawn under its own line.
            if (row && rx) {
                L.polyline(geodesicPoints(rx.lat, rx.lon, b.lat, b.lon), {
                    color: colour,
                    weight: 2,
                    opacity: 0.75,
                    dashArray: '5, 6',
                    // Nothing to press: the line must not steal a click meant
                    // for a beacon it happens to pass over.
                    interactive: false,
                }).addTo(g);
            }

            const dot = L.circleMarker([b.lat, b.lon], {
                radius: row ? 8 : 5,
                weight: row ? 1.5 : 1,
                color: '#fff',
                fillColor: colour,
                fillOpacity: row ? 0.95 : 0.55,
            }).addTo(g);

            // Only the beacons that were heard carry a permanent label.
            // Eighteen of them would be a wall of callsigns with a map somewhere
            // behind it, and the silent ones are already saying what they have
            // to say by being grey.
            if (row) {
                dot.bindTooltip(esc(b.callsign), {
                    permanent: true,
                    direction: 'right',
                    offset: [8, 0],
                    // csmap__label, not csmap__tip: the quiet one, for labels
                    // that are all on screen at once. See its note in the
                    // stylesheet — a row of hovered-plate tooltips is a row of
                    // shouting boxes.
                    className: 'csmap__label',
                });
                bounds.push([b.lat, b.lon]);
            }

            const detail = row
                ? BEACON_BANDS
                    .filter((x) => row.bands[x])
                    .map((x) => `${esc(x)} ${esc(snrLabel(row.bands[x].snr))} · ${row.bands[x].count}×`)
                    .join('<br>')
                : 'Not heard';

            dot.bindPopup(
                `<div class="beacon-popup"><div class="bp-call">${esc(b.callsign)}</div>`
                + `<div class="bp-entity">${esc(b.entity)}</div>`
                + `<div class="bp-detail">${esc(b.location)}${b.grid ? ` · ${esc(b.grid)}` : ''}</div>`
                + `<div class="bp-spots">${detail}</div></div>`,
                // The only popup in v2, so it brings its own class: Leaflet's
                // stylesheet is appended after ours and its white plate would
                // otherwise win every tie. See .ncdxf-pop in the stylesheet.
                { autoPan: false, className: 'ncdxf-pop', closeButton: false },
            );
        }

        // Fitted when the question changes, and left alone otherwise — a poll
        // landing every fifteen minutes must not move the ground under somebody
        // who has panned to look at something.
        if (fittedBand.current !== band) {
            fittedBand.current = band;
            if (bounds.length > 1) {
                m.fitBounds(L.latLngBounds(bounds).pad(0.2), { paddingTopLeft: [0, 24] });
            } else if (bounds.length === 1) {
                m.setView(bounds[0], 3);
            }
        }
    }, [ready, roster, rows, band, rx && rx.lat, rx && rx.lon]);

    if (failed) {
        return <div className="note note--warn">The map could not be loaded.</div>;
    }

    return <div className={`csmap ncdxf-map${className ? ` ${className}` : ''}`} ref={box} />;
}

/**
 * wspr_phone_prediction.js
 * WSPR → SSB Phone Propagation Prediction
 *
 * Uses D3 + TopoJSON SVG choropleth (same pattern as session_stats.js).
 * Countries are coloured by predicted SSB SNR quality.
 * Country matching uses d3.geoContains() with Maidenhead locator → lat/lon.
 */

'use strict';

const app = (() => {

    // ── State ────────────────────────────────────────────────────────────────
    let predictions = [];       // Current API response predictions array
    let gridSquares = [];       // Current API response grid_squares array
    let meta = null;            // Current API response meta object
    let worldFeatures = null;   // TopoJSON country features
    let svg = null;
    let projection = null;
    let pathGen = null;
    let countryPaths = null;    // D3 selection of all country <path> elements
    let receiverMarkerGroup = null; // D3 group for the receiver marker (redrawn on zoom)
    let userLocationGroup = null;   // D3 group for the browser geolocation marker
    let userLocation = null;        // { lat, lon } from browser geolocation API
    let mapGroup = null;        // D3 group containing all map elements

    // Layer visibility state (persisted across data refreshes)
    let showDots   = true;
    let showGrids  = true;

    // Table sort state
    let sortCol = 'predicted_ssb_snr';
    let sortDir = 'desc';

    // ── Colour helpers ───────────────────────────────────────────────────────
    // Maps prediction value → CSS class on the country <path> element
    const PREDICTION_CLASS = {
        excellent:  'excellent',
        good:       'good',
        workable:   'workable',
        marginal:   'marginal',
        poor:       'poor',
        not_viable: 'not-viable',
    };

    function predictionClass(p) {
        return PREDICTION_CLASS[p] || 'no-data';
    }

    function snrClass(snr) {
        if (snr >= 15) return 'snr-excellent';
        if (snr >= 10) return 'snr-good';
        if (snr >= 6)  return 'snr-workable';
        if (snr >= 3)  return 'snr-marginal';
        if (snr >= 0)  return 'snr-poor';
        return 'snr-not-viable';
    }

    const PREDICTION_LABELS = {
        excellent:  'Excellent',
        good:       'Good',
        workable:   'Workable',
        marginal:   'Marginal',
        poor:       'Very Poor',
        not_viable: 'Not Viable',
    };

    function badgeHTML(prediction) {
        const label = PREDICTION_LABELS[prediction] || prediction;
        return `<span class="badge badge-${prediction.replace('_', '-')}">${label}</span>`;
    }

    // Tooltip class for prediction colour
    function tooltipPredClass(p) {
        const map = {
            excellent: 'tooltip-excellent',
            good:      'tooltip-good',
            workable:  'tooltip-workable',
            marginal:  'tooltip-marginal',
            poor:      'tooltip-poor',
            not_viable:'tooltip-not-viable',
        };
        return map[p] || 'tooltip-nodata';
    }

    // ── Map initialisation ───────────────────────────────────────────────────
    async function initMap() {
        const container = document.getElementById('map-container');
        const svgEl = document.getElementById('world-map');

        // Responsive sizing: 16:7 aspect ratio
        const width = container.clientWidth || 960;
        const height = Math.round(width * 7 / 16);
        svgEl.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svgEl.setAttribute('width', width);
        svgEl.setAttribute('height', height);

        svg = d3.select(svgEl);

        projection = d3.geoNaturalEarth1()
            .scale(width / 6.3)
            .translate([width / 2, height / 2]);

        pathGen = d3.geoPath().projection(projection);

        // Load world topology
        try {
            const resp = await fetch('countries-110m.json');
            const world = await resp.json();
            worldFeatures = topojson.feature(world, world.objects.countries).features;
        } catch (e) {
            console.error('Failed to load countries-110m.json:', e);
            return;
        }

        // Draw graticule
        const graticule = d3.geoGraticule();
        svg.append('path')
            .datum(graticule())
            .attr('d', pathGen)
            .attr('fill', 'none')
            .attr('stroke', '#1a2a3a')
            .attr('stroke-width', 0.3);

        // Draw countries — store group reference so receiver marker can be appended later
        mapGroup = svg.append('g').attr('class', 'map-group');
        // Country paths show a name tooltip on hover for countries with no spot data.
        // Spot circles drawn by updateMap() sit on top in SVG z-order and handle
        // the detailed tooltip for countries that do have spots.
        countryPaths = mapGroup.selectAll('path')
            .data(worldFeatures)
            .enter()
            .append('path')
            .attr('class', 'country-path no-data')
            .attr('d', pathGen)
            .on('mousemove', (event, d) => {
                const name = (d.properties && d.properties.name) || 'Unknown';
                tooltip.innerHTML = `
                    <div class="tooltip-title">${escHtml(name)}</div>
                    <div style="color:#666;font-size:11px;">No WSPR spots in this window</div>
                `;
                tooltip.style.display = 'block';
                positionTooltip(event);
            })
            .on('mouseout', () => { tooltip.style.display = 'none'; });

        // Sphere outline
        svg.append('path')
            .datum({ type: 'Sphere' })
            .attr('d', pathGen)
            .attr('fill', 'none')
            .attr('stroke', '#2a3a4a')
            .attr('stroke-width', 0.8);

        // Zoom behaviour — counter-scale circles so they stay constant screen size.
        // Spot markers (.spot-marker) use translate(mapX,mapY) in map-space, so when
        // the zoom transform is applied to mapGroup they scale up with the map.
        // We fix this by storing the original map-space coords as data-px/data-py and
        // recomputing each group's transform to translate(screenX,screenY) scale(1/k),
        // keeping the marker children drawn at their natural BASE_R size.
        const zoom = d3.zoom()
            .scaleExtent([1, 8])
            .on('zoom', (event) => {
                mapGroup.attr('transform', event.transform);
                const { k } = event.transform;

                // Spot markers: stay at their map-space position (translate(px,py))
                // but counter-scale so they remain constant screen size.
                // mapGroup already has the zoom transform, so children are in map-space.
                mapGroup.selectAll('.spot-marker').each(function() {
                    const g = d3.select(this);
                    const px = +g.attr('data-px');
                    const py = +g.attr('data-py');
                    if (!isNaN(px) && !isNaN(py)) {
                        g.attr('transform', `translate(${px},${py}) scale(${1 / k})`);
                    }
                });

                // Counter-scale receiver marker circles (data-base-r pattern)
                mapGroup.selectAll('.receiver-marker circle')
                    .attr('r', function() {
                        const base = +d3.select(this).attr('data-base-r');
                        return isNaN(base) ? null : base / k;
                    })
                    .style('stroke-width', function() {
                        const base = +d3.select(this).attr('data-base-sw');
                        return isNaN(base) ? null : (base / k) + 'px';
                    });
                // Counter-scale the user location marker the same way.
                mapGroup.selectAll('.user-location-marker circle')
                    .attr('r', function() {
                        const base = +d3.select(this).attr('data-base-r');
                        return isNaN(base) ? null : base / k;
                    })
                    .style('stroke-width', function() {
                        const base = +d3.select(this).attr('data-base-sw');
                        return isNaN(base) ? null : (base / k) + 'px';
                    });
            });
        svg.call(zoom);
    }

    // ── Receiver marker ──────────────────────────────────────────────────────
    // White dot with dark-blue border — contrasts against all signal-quality
    // colours (teal / green / yellow / orange / red / dark-red).
    function drawReceiverMarker(m) {
        if (receiverMarkerGroup) { receiverMarkerGroup.remove(); receiverMarkerGroup = null; }
        if (!m || m.receiver_lat == null || m.receiver_lon == null || !mapGroup) return;

        const [cx, cy] = projection([m.receiver_lon, m.receiver_lat]);
        if (isNaN(cx) || isNaN(cy)) return;

        // Read current zoom scale so the marker is immediately counter-scaled
        // to match the existing zoom level (avoids full-size dot on data refresh).
        const k = d3.zoomTransform(svg.node()).k;

        receiverMarkerGroup = mapGroup.append('g')
            .attr('class', 'receiver-marker');

        // Outer halo ring (subtle, non-interactive)
        receiverMarkerGroup.append('circle')
            .attr('cx', cx).attr('cy', cy)
            .attr('r', 12 / k).attr('data-base-r', 12).attr('data-base-sw', 0)
            .style('fill', 'none')
            .style('stroke', '#ffffff')
            .style('stroke-width', '0px')
            .style('opacity', '0.45')
            .style('pointer-events', 'none');

        // Main dot — white fill, dark-blue border
        receiverMarkerGroup.append('circle')
            .attr('cx', cx).attr('cy', cy)
            .attr('r', 8 / k).attr('data-base-r', 8).attr('data-base-sw', 2)
            .style('fill', '#ffffff')
            .style('stroke', '#0f3460')
            .style('stroke-width', (2 / k) + 'px')
            .style('cursor', 'pointer')
            .on('mousemove', (event) => {
                const callsign = m.receiver_callsign ? ` (${m.receiver_callsign})` : '';
                const locator  = m.receiver_locator  ? ` — ${m.receiver_locator}` : '';
                tooltip.innerHTML = `
                    <div class="tooltip-title">📡 Receiver${callsign}</div>
                    <div>Location: ${m.receiver_lat.toFixed(4)}°, ${m.receiver_lon.toFixed(4)}°${locator}</div>
                    <div style="color:#888;font-size:11px;margin-top:4px;">This is where WSPR signals are received</div>
                `;
                tooltip.style.display = 'block';
                positionTooltip(event);
            })
            .on('mouseout', () => { tooltip.style.display = 'none'; });

        // Centre pip — dark-blue
        receiverMarkerGroup.append('circle')
            .attr('cx', cx).attr('cy', cy)
            .attr('r', 2.5 / k).attr('data-base-r', 2.5).attr('data-base-sw', 0)
            .style('fill', '#0f3460')
            .style('pointer-events', 'none');
    }

    // ── User location marker ─────────────────────────────────────────────────
    // Blue pulsing dot — visually distinct from the white receiver marker.
    // Redrawn whenever userLocation changes or the map is refreshed.
    function drawUserLocationMarker() {
        if (userLocationGroup) { userLocationGroup.remove(); userLocationGroup = null; }
        if (!userLocation || !mapGroup) return;

        const [cx, cy] = projection([userLocation.lon, userLocation.lat]);
        if (isNaN(cx) || isNaN(cy)) return;

        const k = d3.zoomTransform(svg.node()).k;

        userLocationGroup = mapGroup.append('g').attr('class', 'user-location-marker');

        // Accuracy halo (large, very faint)
        userLocationGroup.append('circle')
            .attr('cx', cx).attr('cy', cy)
            .attr('r', 14 / k).attr('data-base-r', 14).attr('data-base-sw', 0)
            .style('fill', '#4a9eff')
            .style('fill-opacity', '0.12')
            .style('stroke', '#4a9eff')
            .style('stroke-width', (0.8 / k) + 'px')
            .style('stroke-opacity', '0.35')
            .style('pointer-events', 'none');

        // Main dot — blue fill, white border
        userLocationGroup.append('circle')
            .attr('cx', cx).attr('cy', cy)
            .attr('r', 7 / k).attr('data-base-r', 7).attr('data-base-sw', 2)
            .style('fill', '#4a9eff')
            .style('stroke', '#ffffff')
            .style('stroke-width', (2 / k) + 'px')
            .style('cursor', 'pointer')
            .on('mousemove', (event) => {
                const grid = latLonToMaidenhead(userLocation.lat, userLocation.lon, 2);
                tooltip.innerHTML = `
                    <div class="tooltip-title">📍 Your Location</div>
                    <div>${userLocation.lat.toFixed(4)}°, ${userLocation.lon.toFixed(4)}°</div>
                    ${grid ? `<div style="color:#aaa;font-size:11px;">Grid: <strong style="color:#e0e0e0">${grid}</strong></div>` : ''}
                `;
                tooltip.style.display = 'block';
                positionTooltip(event);
            })
            .on('mouseout', () => { tooltip.style.display = 'none'; });

        // Centre pip
        userLocationGroup.append('circle')
            .attr('cx', cx).attr('cy', cy)
            .attr('r', 2.5 / k).attr('data-base-r', 2.5).attr('data-base-sw', 0)
            .style('fill', '#ffffff')
            .style('pointer-events', 'none');
    }

    // ── Grid-square helpers ───────────────────────────────────────────────────

    /**
     * Convert a 4-char Maidenhead grid square to its geographic bounding box.
     * A 4-char square covers exactly 2° longitude × 1° latitude.
     * Returns [lonMin, latMin, lonMax, latMax].
     */
    function gridSquareBounds(grid4) {
        const g = grid4.toUpperCase();
        const lonMin = (g.charCodeAt(0) - 65) * 20 - 180 + parseInt(g[2], 10) * 2;
        const latMin = (g.charCodeAt(1) - 65) * 10 - 90  + parseInt(g[3], 10) * 1;
        return [lonMin, latMin, lonMin + 2, latMin + 1];
    }

    // Tooltip handler for grid-square hover
    function onGridSquareMouseMove(event, gs) {
        const bestSnrStr = (gs.best_ssb_snr >= 0 ? '+' : '') + gs.best_ssb_snr.toFixed(1);
        const predLabel = PREDICTION_LABELS[gs.best_prediction] || gs.best_prediction;

        const bandLines = (gs.bands || []).map(b => {
            const bsnr = (b.predicted_ssb_snr >= 0 ? '+' : '') + b.predicted_ssb_snr.toFixed(1);
            const cls  = tooltipPredClass(b.prediction);
            const blabel = PREDICTION_LABELS[b.prediction] || b.prediction;
            return `<div class="${cls}" style="margin-top:2px;">${escHtml(b.band)}: <strong>${blabel}</strong> (${bsnr} dB)</div>`;
        }).join('');

        tooltip.innerHTML = `
            <div class="tooltip-title">⊞ ${escHtml(gs.grid)} — ${escHtml(gs.country)}</div>
            <div class="${tooltipPredClass(gs.best_prediction)}">Best: <strong>${predLabel}</strong> (${bestSnrStr} dB)</div>
            ${bandLines}
        `;
        tooltip.style.display = 'block';
        positionTooltip(event);
    }

    // ── Country dot markers ───────────────────────────────────────────────────
    // One marker per country, positioned at the CTY entity lat/lon.
    // Single band → filled circle (band colour) + quality ring.
    // Multiple bands → D3 pie segments (band colours) + quality ring (best prediction).
    let spotMarkersGroup = null;
    let gridSquaresGroup = null; // D3 group for the grid-square heat-map layer

    // Prediction quality → fill colour (used for grid squares and quality rings)
    const PREDICTION_FILL = {
        excellent:  '#1abc9c',
        good:       '#27ae60',
        workable:   '#f1c40f',
        marginal:   '#e67e22',
        poor:       '#c0392b',
        not_viable: '#4a2020',
    };

    // Per-band colour palette (distinct hues, readable on dark background)
    const BAND_COLORS = {
        '2200m': '#c084fc', // purple
        '630m':  '#e879f9', // fuchsia
        '160m':  '#818cf8', // indigo
        '80m':   '#f472b6', // pink
        '60m':   '#fb923c', // orange
        '40m':   '#facc15', // yellow
        '30m':   '#4ade80', // green
        '20m':   '#22d3ee', // cyan
        '17m':   '#a78bfa', // violet
        '15m':   '#f87171', // red
        '12m':   '#34d399', // emerald
        '10m':   '#60a5fa', // blue
    };
    function bandColor(band) { return BAND_COLORS[band] || '#94a3b8'; }

    const PRED_RANK = { excellent: 0, good: 1, workable: 2, marginal: 3, poor: 4, not_viable: 5 };
    function bestPrediction(entries) {
        return entries.reduce((best, e) =>
            (PRED_RANK[e.prediction] ?? 99) < (PRED_RANK[best] ?? 99) ? e.prediction : best,
            entries[0].prediction);
    }

    function updateMap(preds, gsData) {
        if (!mapGroup) return;

        // Remove old layers
        if (gridSquaresGroup) { gridSquaresGroup.remove(); gridSquaresGroup = null; }
        if (spotMarkersGroup) { spotMarkersGroup.remove(); spotMarkersGroup = null; }

        // All country paths stay neutral (no-data class) — colouring is done via spot circles
        if (countryPaths) {
            countryPaths.classed('no-data', true)
                        .classed('excellent', false)
                        .classed('good', false)
                        .classed('workable', false)
                        .classed('marginal', false)
                        .classed('poor', false)
                        .classed('not-viable', false);
        }

        // ── Grid-square heat-map layer (drawn first, below spot circles) ──────
        gridSquaresGroup = mapGroup.append('g').attr('class', 'grid-squares');

        for (const gs of (gsData || [])) {
            if (!gs.grid || gs.grid.length < 4) continue;
            let bounds;
            try { bounds = gridSquareBounds(gs.grid); } catch (e) { continue; }
            const [lonMin, latMin, lonMax, latMax] = bounds;

            const fill = PREDICTION_FILL[gs.best_prediction] || '#555';
            const fillOpacity = 0.28;

            // GeoJSON exterior rings must be counter-clockwise (right-hand rule).
            // Clockwise winding causes D3 geoPath to fill the complement (entire world).
            // CCW: bottom-left → top-left → top-right → bottom-right → bottom-left
            gridSquaresGroup.append('path')
                .datum({
                    type: 'Feature',
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[[lonMin, latMin], [lonMin, latMax],
                                       [lonMax, latMax], [lonMax, latMin],
                                       [lonMin, latMin]]]
                    }
                })
                .attr('d', pathGen)
                .style('fill', fill)
                .style('fill-opacity', fillOpacity)
                .style('stroke', fill)
                .style('stroke-width', '0.5px')
                .style('stroke-opacity', '0.4')
                .style('cursor', 'pointer')
                .on('mousemove', (event) => onGridSquareMouseMove(event, gs))
                .on('mouseout', () => { tooltip.style.display = 'none'; });
        }

        // Apply current layer visibility
        gridSquaresGroup.style('display', showGrids ? null : 'none');

        // ── Country dot markers (collector-style) ────────────────────────────
        // Group predictions by country, using CTY entity lat/lon for position.
        // One marker per country: pie segments by band colour + quality ring.
        spotMarkersGroup = mapGroup.append('g').attr('class', 'spot-markers');

        // Read the current zoom scale so newly-drawn circles are immediately
        // counter-scaled to match the existing zoom level.
        const currentTransform = d3.zoomTransform(svg.node());
        const k = currentTransform.k;

        // Group by country — collect all band entries per country
        const byCountry = new Map();
        for (const entry of preds) {
            if (entry.lat == null || entry.lon == null) continue;
            if (!byCountry.has(entry.country)) {
                byCountry.set(entry.country, { lat: entry.lat, lon: entry.lon,
                    continent: entry.continent, bands: [] });
            }
            byCountry.get(entry.country).bands.push(entry);
        }

        const BASE_R = 8; // constant screen-pixel radius

        for (const [country, cdata] of byCountry) {
            const projected = projection([cdata.lon, cdata.lat]);
            if (!projected || isNaN(projected[0]) || isNaN(projected[1])) continue;
            const [px, py] = projected;

            const best = bestPrediction(cdata.bands);
            const ringColor = PREDICTION_FILL[best] || '#888';

            // Store map-space coords as data attributes so the zoom handler can
            // update the counter-scale transform on each zoom event.
            // Transform: translate to map-space position (mapGroup already has the
            // zoom transform applied, so children are in map-space) then scale(1/k)
            // to keep the marker a constant screen size.
            const markerG = spotMarkersGroup.append('g')
                .attr('class', 'spot-marker')
                .attr('data-px', px)
                .attr('data-py', py)
                .attr('transform', `translate(${px},${py}) scale(${1 / k})`);

            const cdataFull = { country, ...cdata };
            const onMove = (event) => onSpotMouseMove(event, cdataFull);
            const onOut  = () => { tooltip.style.display = 'none'; };

            const n = cdata.bands.length;
            // Children are drawn at BASE_R (screen pixels). The group's scale(1/k)
            // counter-scales them so they stay constant size as the map zooms.
            if (n === 1) {
                // Single band — plain filled circle (band colour)
                const bc = bandColor(cdata.bands[0].band);
                markerG.append('circle')
                    .attr('r', BASE_R)
                    .style('fill', bc)
                    .style('stroke', '#0f172a')
                    .style('stroke-width', '1.2px')
                    .style('cursor', 'pointer')
                    .on('mousemove', onMove)
                    .on('mouseout', onOut);
            } else {
                // Multiple bands — D3 pie segments (band colours)
                const arc  = d3.arc().innerRadius(0).outerRadius(BASE_R);
                const pie  = d3.pie().sort(null).value(() => 1);
                const arcs = pie(cdata.bands);
                arcs.forEach((a, idx) => {
                    markerG.append('path')
                        .attr('d', arc(a))
                        .style('fill', bandColor(cdata.bands[idx].band))
                        .style('stroke', '#0f172a')
                        .style('stroke-width', '0.8px')
                        .style('cursor', 'pointer')
                        .on('mousemove', onMove)
                        .on('mouseout', onOut);
                });
            }

            // Quality ring (prediction colour) — drawn on top, non-interactive
            markerG.append('circle')
                .attr('r', BASE_R + 2.5)
                .style('fill', 'none')
                .style('stroke', ringColor)
                .style('stroke-width', '1.5px')
                .style('stroke-opacity', '0.85')
                .style('pointer-events', 'none');

            // Invisible hit-area circle for reliable hover (covers gaps between pie slices)
            markerG.append('circle')
                .attr('r', BASE_R + 4)
                .style('fill', 'transparent')
                .style('cursor', 'pointer')
                .on('mousemove', onMove)
                .on('mouseout', onOut);
        }

        // Apply current layer visibility
        spotMarkersGroup.style('display', showDots ? null : 'none');

        // Draw receiver marker and user location marker on top
        drawReceiverMarker(meta);
        drawUserLocationMarker();
    }

    // ── Tooltip ──────────────────────────────────────────────────────────────
    const tooltip = document.getElementById('map-tooltip');

    // Tooltip for country dot markers (grouped: one entry per country, bands array)
    function onSpotMouseMove(event, cdata) {
        const bandOrder = ['2200m','630m','160m','80m','60m','40m','30m','20m','17m','15m','12m','10m'];
        const sorted = [...(cdata.bands || [])].sort((a, b) => {
            const ai = bandOrder.indexOf(a.band), bi = bandOrder.indexOf(b.band);
            return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
        });

        const bandRows = sorted.map(e => {
            const bc   = bandColor(e.band);
            const snr  = (e.predicted_ssb_snr >= 0 ? '+' : '') + e.predicted_ssb_snr.toFixed(1);
            const pred = PREDICTION_LABELS[e.prediction] || e.prediction;
            const qc   = tooltipPredClass(e.prediction);
            let extra = '';
            if (e.best_callsign) {
                const dbm = e.best_callsign_dbm != null ? ` @ ${e.best_callsign_dbm} dBm` : '';
                extra = `<span style="color:#888;font-size:10px;margin-left:4px;">${escHtml(e.best_callsign)}${escHtml(dbm)}</span>`;
            }
            return `<div style="display:flex;align-items:center;gap:6px;margin-top:3px;">
                <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${bc};flex-shrink:0;"></span>
                <span style="color:${bc};font-weight:600;min-width:32px;">${escHtml(e.band)}</span>
                <span class="${qc}"><strong>${pred}</strong> (${snr} dB)</span>
                ${extra}
            </div>`;
        }).join('');

        tooltip.innerHTML = `
            <div class="tooltip-title">${escHtml(cdata.country)}</div>
            <div style="color:#888;font-size:11px;margin-bottom:5px;">${escHtml(cdata.continent || '')}</div>
            ${bandRows}
        `;
        tooltip.style.display = 'block';
        positionTooltip(event);
    }

    function positionTooltip(event) {
        const margin = 14;
        const tw = tooltip.offsetWidth;
        const th = tooltip.offsetHeight;
        let x = event.clientX + margin;
        let y = event.clientY + margin;
        if (x + tw > window.innerWidth)  x = event.clientX - tw - margin;
        if (y + th > window.innerHeight) y = event.clientY - th - margin;
        tooltip.style.left = x + 'px';
        tooltip.style.top  = y + 'px';
    }

    // ── Table rendering ──────────────────────────────────────────────────────
    function renderTable(preds) {
        const tbody = document.getElementById('results-tbody');
        const table = document.getElementById('results-table');
        const noData = document.getElementById('no-data-msg');
        const loading = document.getElementById('loading-msg');

        loading.style.display = 'none';

        if (!preds || preds.length === 0) {
            table.style.display = 'none';
            noData.style.display = 'block';
            return;
        }

        noData.style.display = 'none';
        table.style.display = 'table';

        // Sort
        const sorted = [...preds].sort((a, b) => {
            let va = a[sortCol];
            let vb = b[sortCol];

            // Prediction sort order: best first
            if (sortCol === 'prediction') {
                const rank = { excellent: 0, good: 1, workable: 2, marginal: 3, poor: 4, not_viable: 5 };
                va = rank[va] ?? 6;
                vb = rank[vb] ?? 6;
            }

            if (va == null) va = sortDir === 'asc' ? Infinity : -Infinity;
            if (vb == null) vb = sortDir === 'asc' ? Infinity : -Infinity;

            if (typeof va === 'string') {
                return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
            }
            return sortDir === 'asc' ? va - vb : vb - va;
        });

        tbody.innerHTML = sorted.map(e => {
            const ssnr = e.predicted_ssb_snr;
            const ssnrStr = (ssnr >= 0 ? '+' : '') + ssnr.toFixed(1);
            const wsnrStr = (e.mean_wspr_snr >= 0 ? '+' : '') + e.mean_wspr_snr.toFixed(1);

            let distStr = '—';
            if (e.distance_km != null) {
                distStr = `${Math.round(e.distance_km)} km`;
            }

            let bearingStr = '—';
            if (e.bearing_deg != null) bearingStr = `${Math.round(e.bearing_deg)}°`;

            const lastSeen = e.last_seen
                ? new Date(e.last_seen).toISOString().replace('T', ' ').substring(0, 16) + ' UTC'
                : '—';

            return `<tr>
                <td>${badgeHTML(e.prediction)}</td>
                <td>${escHtml(e.country || '—')}</td>
                <td>${escHtml(e.continent || '—')}</td>
                <td>${escHtml(e.band)}</td>
                <td class="${snrClass(ssnr)}">${ssnrStr} dB</td>
                <td class="${snrClass(e.mean_wspr_snr)}">${wsnrStr} dB</td>
                <td>${distStr}</td>
                <td>${bearingStr}</td>
                <td>${e.spot_count}</td>
                <td>${lastSeen}</td>
            </tr>`;
        }).join('');
    }

    // ── Table sort headers ───────────────────────────────────────────────────
    function initTableSort() {
        document.querySelectorAll('thead th[data-col]').forEach(th => {
            th.addEventListener('click', () => {
                const col = th.dataset.col;
                if (sortCol === col) {
                    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
                } else {
                    sortCol = col;
                    sortDir = col === 'country' || col === 'continent' || col === 'band' || col === 'prediction'
                        ? 'asc' : 'desc';
                }
                // Update header classes
                document.querySelectorAll('thead th').forEach(h => {
                    h.classList.remove('sort-asc', 'sort-desc');
                });
                th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
                renderTable(predictions);
            });
        });

        // Set initial sort indicator
        const defaultTh = document.querySelector(`thead th[data-col="${sortCol}"]`);
        if (defaultTh) defaultTh.classList.add('sort-desc');
    }

    // ── Top-10 panel ─────────────────────────────────────────────────────────
    function renderTop10(preds, gsData) {
        const el = document.getElementById('top10-list');
        if (!el) return;

        if (!preds || preds.length === 0) {
            el.innerHTML = '<div style="color:#666;font-size:10px;">No data</div>';
            el._top10Data = null;
            return;
        }

        // Build grid-square count per country from gsData
        const gridCountByCountry = {};
        for (const gs of (gsData || [])) {
            if (gs.country) {
                gridCountByCountry[gs.country] = (gridCountByCountry[gs.country] || 0) + 1;
            }
        }

        // Group by country — collect all band entries, keep best SNR per band.
        const byCountry = new Map();
        for (const p of preds) {
            if (!p.country) continue;
            if (!byCountry.has(p.country)) {
                byCountry.set(p.country, {
                    continent: p.continent || '',
                    bands: new Map(),
                    bestSNR: -Infinity, bestBand: '', bestPred: ''
                });
            }
            const acc = byCountry.get(p.country);
            const existing = acc.bands.get(p.band);
            if (!existing || p.predicted_ssb_snr > existing.predicted_ssb_snr) {
                acc.bands.set(p.band, p);
            }
            if (p.predicted_ssb_snr > acc.bestSNR) {
                acc.bestSNR = p.predicted_ssb_snr;
                acc.bestBand = p.band;
                acc.bestPred = p.prediction;
            }
        }

        // Sort by best SNR descending, take top 10
        const top10 = [...byCountry.entries()]
            .sort((a, b) => b[1].bestSNR - a[1].bestSNR)
            .slice(0, 10);

        // Store tooltip data indexed by row position for event delegation
        const tooltipData = top10.map(([country, acc]) => ({
            country,
            continent: acc.continent,
            bands: [...acc.bands.values()],
        }));
        el._top10Data = tooltipData;

        const DOT_R = 7; // px — mini marker radius
        const CX = DOT_R + 1;
        const CY = DOT_R + 1;
        const SIZE = (DOT_R + 1) * 2;

        el.innerHTML = top10.map(([country, acc], idx) => {
            const bands = [...acc.bands.values()];
            const ringColor = PREDICTION_FILL[acc.bestPred] || '#888';
            const snrStr = (acc.bestSNR >= 0 ? '+' : '') + acc.bestSNR.toFixed(1);
            const countryEsc = escHtml(country || '—');
            const bandEsc = escHtml(acc.bestBand || '—');
            const gridCount = gridCountByCountry[country] || 0;
            const gridBadge = gridCount > 0
                ? `<div class="top10-grids" title="${gridCount} grid square${gridCount !== 1 ? 's' : ''} heard">${gridCount}⊞</div>`
                : '';

            // Build mini SVG pie marker (same logic as map markers)
            let dotSVG;
            if (bands.length === 1) {
                const bc = bandColor(bands[0].band);
                dotSVG = `<svg width="${SIZE}" height="${SIZE}" style="flex-shrink:0;overflow:visible">
                    <circle cx="${CX}" cy="${CY}" r="${DOT_R}" fill="${bc}" stroke="#0f172a" stroke-width="1"/>
                    <circle cx="${CX}" cy="${CY}" r="${DOT_R + 2}" fill="none" stroke="${ringColor}" stroke-width="1.5" opacity="0.85"/>
                </svg>`;
            } else {
                // Pie segments
                const n = bands.length;
                const sliceAngle = (2 * Math.PI) / n;
                let paths = '';
                for (let i = 0; i < n; i++) {
                    const a0 = i * sliceAngle - Math.PI / 2;
                    const a1 = a0 + sliceAngle;
                    const x0 = CX + DOT_R * Math.cos(a0);
                    const y0 = CY + DOT_R * Math.sin(a0);
                    const x1 = CX + DOT_R * Math.cos(a1);
                    const y1 = CY + DOT_R * Math.sin(a1);
                    const large = sliceAngle > Math.PI ? 1 : 0;
                    const bc = bandColor(bands[i].band);
                    paths += `<path d="M${CX},${CY} L${x0},${y0} A${DOT_R},${DOT_R} 0 ${large},1 ${x1},${y1} Z" fill="${bc}" stroke="#0f172a" stroke-width="0.8"/>`;
                }
                dotSVG = `<svg width="${SIZE}" height="${SIZE}" style="flex-shrink:0;overflow:visible">
                    ${paths}
                    <circle cx="${CX}" cy="${CY}" r="${DOT_R + 2}" fill="none" stroke="${ringColor}" stroke-width="1.5" opacity="0.85"/>
                </svg>`;
            }

            return `<div class="top10-row" data-idx="${idx}" style="cursor:pointer">
                ${dotSVG}
                <div class="top10-country" title="${countryEsc}">${countryEsc}</div>
                <div class="top10-snr">${bandEsc}&nbsp;${snrStr} dB</div>
                ${gridBadge}
            </div>`;
        }).join('');

        // Event delegation — one listener on the container
        el.onmousemove = (event) => {
            const row = event.target.closest('.top10-row');
            if (!row || !el._top10Data) return;
            const idx = parseInt(row.dataset.idx, 10);
            const cdata = el._top10Data[idx];
            if (cdata) onSpotMouseMove(event, cdata);
        };
        el.onmouseout = (event) => {
            if (!event.relatedTarget || !el.contains(event.relatedTarget)) {
                tooltip.style.display = 'none';
            }
        };
    }

    // ── Status bar update ────────────────────────────────────────────────────
    function updateStatusBar(m, predCount) {
        if (!m) return;
        document.getElementById('status-text').textContent = 'OK';
        document.getElementById('spot-count').textContent = m.spot_count.toLocaleString();
        document.getElementById('country-count').textContent = predCount.toLocaleString();
        document.getElementById('bw-penalty').textContent = m.bw_correction_db.toFixed(2) + ' dB';
        const gen = new Date(m.generated_at);
        document.getElementById('generated-at').textContent =
            gen.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
    }

    // ── API fetch ────────────────────────────────────────────────────────────
    async function fetchData() {
        const band       = document.getElementById('band-select').value;
        const minutes    = document.getElementById('minutes-select').value;
        const power      = document.getElementById('power-select').value;
        const minSSBSNR  = document.getElementById('min-snr-select').value;

        const btn = document.getElementById('refresh-btn');
        btn.classList.add('loading');
        btn.disabled = true;

        document.getElementById('status-text').textContent = 'Loading…';
        document.getElementById('loading-msg').style.display = 'block';
        document.getElementById('results-table').style.display = 'none';
        document.getElementById('no-data-msg').style.display = 'none';

        const params = new URLSearchParams({
            minutes,
            phone_power_w: power,
            min_ssb_snr: minSSBSNR,
        });
        if (band) params.set('band', band);

        try {
            const resp = await fetch(`/api/wspr/phone-prediction?${params}`);
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({ error: resp.statusText }));
                throw new Error(err.error || resp.statusText);
            }

            const data = await resp.json();
            predictions = data.predictions || [];
            gridSquares = data.grid_squares || [];
            meta = data.meta || null;

            updateStatusBar(meta, predictions.length);
            updateMap(predictions, gridSquares);
            renderTable(predictions);
            renderTop10(predictions, gridSquares);
            scheduleNearestGridsBanner();

        } catch (e) {
            console.error('WSPR prediction fetch error:', e);
            document.getElementById('status-text').textContent = 'Error: ' + e.message;
            document.getElementById('loading-msg').style.display = 'none';
            document.getElementById('no-data-msg').style.display = 'block';
            document.getElementById('no-data-msg').textContent =
                'Failed to load data: ' + e.message;
        } finally {
            btn.classList.remove('loading');
            btn.disabled = false;
        }
    }

    // ── Nearest-grids banner ─────────────────────────────────────────────────

    // Debounce timer for nearest-grids banner — prevents double-calls when
    // geolocation resolves at the same time as fetchData() completes.
    let _nearestGridsTimer = null;

    function scheduleNearestGridsBanner() {
        if (_nearestGridsTimer !== null) clearTimeout(_nearestGridsTimer);
        _nearestGridsTimer = setTimeout(() => {
            _nearestGridsTimer = null;
            fetchNearestGridsBanner();
        }, 150);
    }

    /**
     * Fetch the top-3 nearest active grid squares from the API and render the
     * banner above the status bar.  Silently hides the banner on any error or
     * when userLocation is not yet available.
     */
    async function fetchNearestGridsBanner() {
        const banner = document.getElementById('nearest-grids-banner');
        if (!banner) return;

        if (!userLocation) {
            banner.classList.remove('visible');
            return;
        }

        const minutes   = document.getElementById('minutes-select').value;
        const power     = document.getElementById('power-select').value;
        const minSSBSNR = document.getElementById('min-snr-select').value;

        const params = new URLSearchParams({
            lat:           userLocation.lat.toFixed(6),
            lon:           userLocation.lon.toFixed(6),
            count:         3,
            minutes,
            phone_power_w: power,
            min_ssb_snr:   minSSBSNR,
        });

        try {
            const resp = await fetch(`/api/wspr/nearest-grids?${params}`);
            if (!resp.ok) { banner.classList.remove('visible'); return; }
            const data = await resp.json();
            renderNearestGridsBanner(data.grids || []);
        } catch (_) {
            banner.classList.remove('visible');
        }
    }

    /**
     * Render the nearest-grids banner from an array of WSPRNearestGridEntry objects.
     * Hides the banner when the array is empty.
     */
    function renderNearestGridsBanner(grids) {
        const banner = document.getElementById('nearest-grids-banner');
        const items  = document.getElementById('ngb-items');
        if (!banner || !items) return;

        if (!grids || grids.length === 0) {
            banner.classList.remove('visible');
            return;
        }

        items.innerHTML = grids.map(g => {
            const distStr = g.distance_km < 50
                ? 'nearby'
                : `${Math.round(g.distance_km).toLocaleString()} km`;

            const bandBadges = (g.bands || []).map(b => {
                const color = bandColor(b.band);
                const predClass = tooltipPredClass(b.prediction);
                return `<span class="ngb-band-badge ${predClass}" style="background:${color}20;border:1px solid ${color};color:${color}">${escHtml(b.band)}</span>`;
            }).join('');

            return `<div class="ngb-grid-item">
                <span class="ngb-grid-name">${escHtml(g.grid)}</span>
                <span class="ngb-dist">${distStr}</span>
                <span class="ngb-bands">${bandBadges}</span>
            </div>`;
        }).join('');

        banner.classList.add('visible');
    }

    // ── Utility ──────────────────────────────────────────────────────────────
    function escHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ── Responsive map resize ────────────────────────────────────────────────
    function onResize() {
        const container = document.getElementById('map-container');
        const svgEl = document.getElementById('world-map');
        const width = container.clientWidth;
        const height = Math.round(width * 7 / 16);
        svgEl.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svgEl.setAttribute('width', width);
        svgEl.setAttribute('height', height);

        if (projection) {
            projection.scale(width / 6.3).translate([width / 2, height / 2]);
            if (pathGen && countryPaths) {
                countryPaths.attr('d', pathGen);
            }
        }
    }

    // ── Auto-refresh ─────────────────────────────────────────────────────────
    // Refresh every 2 minutes (aligned to WSPR cycle).
    // Pauses when the tab is hidden to avoid stacking up fetches.
    // Uses a single interval ID stored in closure — no leaks.
    const REFRESH_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
    let refreshTimer = null;
    let isFetching = false; // guard against overlapping fetches

    function startAutoRefresh() {
        stopAutoRefresh();
        refreshTimer = setInterval(async () => {
            // Skip if tab is hidden or a fetch is already in progress
            if (document.hidden || isFetching) return;
            isFetching = true;
            try {
                await fetchData();
            } finally {
                isFetching = false;
            }
        }, REFRESH_INTERVAL_MS);
    }

    function stopAutoRefresh() {
        if (refreshTimer !== null) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }
    }

    // ── Init ─────────────────────────────────────────────────────────────────
    async function init() {
        await initMap();
        initTableSort();

        // Request browser geolocation (non-blocking — map loads regardless).
        // If granted, draw a blue marker at the user's position and fetch the
        // nearest-grids banner.
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    userLocation = { lat: pos.coords.latitude, lon: pos.coords.longitude };
                    drawUserLocationMarker();
                    scheduleNearestGridsBanner();
                },
                () => { /* permission denied or unavailable — silently ignore */ },
                { timeout: 10000, maximumAge: 300000 }
            );
        }

        // Wire up controls to re-fetch immediately on change and reset the timer
        ['band-select', 'minutes-select', 'power-select', 'min-snr-select'].forEach(id => {
            document.getElementById(id).addEventListener('change', () => {
                fetchData();
                startAutoRefresh(); // reset 2-min timer after manual change
            });
        });

        // ── Layer toggle checkboxes ───────────────────────────────────────────
        function applyLayerToggle(id, rowId, groupGetter, stateGetter, stateSetter) {
            const cb  = document.getElementById(id);
            const row = document.getElementById(rowId);
            if (!cb) return;
            cb.addEventListener('change', () => {
                stateSetter(cb.checked);
                if (row) row.classList.toggle('layer-off', !cb.checked);
                const grp = groupGetter();
                if (grp) grp.style('display', cb.checked ? null : 'none');
            });
        }

        applyLayerToggle(
            'layer-toggle-dots', 'toggle-row-dots',
            () => spotMarkersGroup,
            () => showDots,
            v => { showDots = v; }
        );
        applyLayerToggle(
            'layer-toggle-grids', 'toggle-row-grids',
            () => gridSquaresGroup,
            () => showGrids,
            v => { showGrids = v; }
        );

        window.addEventListener('resize', onResize);

        // Stop timer when tab is hidden, restart when visible
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                stopAutoRefresh();
            } else {
                // Fetch immediately on return, then restart timer
                fetchData();
                startAutoRefresh();
            }
        });

        // Stop timer on page unload to prevent any lingering callbacks
        window.addEventListener('beforeunload', stopAutoRefresh);

        // Initial fetch then start timer
        await fetchData();
        startAutoRefresh();
    }

    // Public interface
    return { fetch: fetchData, init };
})();

// Boot
document.addEventListener('DOMContentLoaded', () => app.init());

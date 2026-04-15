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
    let meta = null;            // Current API response meta object
    let worldFeatures = null;   // TopoJSON country features
    let svg = null;
    let projection = null;
    let pathGen = null;
    let countryPaths = null;    // D3 selection of all country <path> elements
    let receiverMarkerGroup = null; // D3 group for the receiver marker (redrawn on zoom)
    let mapGroup = null;        // D3 group containing all map elements

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
        // Country paths are a neutral base map only — no mouse events on them.
        // Spot circles drawn by updateMap() handle all interaction.
        countryPaths = mapGroup.selectAll('path')
            .data(worldFeatures)
            .enter()
            .append('path')
            .attr('class', 'country-path no-data')
            .attr('d', pathGen);

        // Sphere outline
        svg.append('path')
            .datum({ type: 'Sphere' })
            .attr('d', pathGen)
            .attr('fill', 'none')
            .attr('stroke', '#2a3a4a')
            .attr('stroke-width', 0.8);

        // Zoom behaviour — counter-scale circles so they stay constant screen size
        const zoom = d3.zoom()
            .scaleExtent([1, 8])
            .on('zoom', (event) => {
                mapGroup.attr('transform', event.transform);
                const k = event.transform.k; // current zoom scale
                // Counter-scale all spot circles and their glow rings so they stay
                // a constant screen size regardless of zoom level
                mapGroup.selectAll('.spot-marker circle')
                    .attr('r', function() {
                        const base = +d3.select(this).attr('data-base-r');
                        return isNaN(base) ? null : base / k;
                    })
                    .style('stroke-width', function() {
                        const base = +d3.select(this).attr('data-base-sw');
                        return isNaN(base) ? null : (base / k) + 'px';
                    });
                // Counter-scale the receiver pin group so it stays constant screen size.
                // The pin was drawn with its tip at (cx, cy); we scale around that point.
                mapGroup.selectAll('.receiver-marker')
                    .attr('transform', function() {
                        const cx = +d3.select(this).attr('data-pin-cx');
                        const cy = +d3.select(this).attr('data-pin-cy');
                        if (isNaN(cx) || isNaN(cy)) return null;
                        return `translate(${cx},${cy}) scale(${1/k}) translate(${-cx},${-cy})`;
                    });
            });
        svg.call(zoom);
    }

    // ── Receiver marker ──────────────────────────────────────────────────────
    // Drawn as a classic teardrop map-pin: a circle on top of a downward point.
    // The pin tip sits exactly at the receiver's projected coordinates.
    function drawReceiverMarker(m) {
        // Remove any existing marker
        if (receiverMarkerGroup) {
            receiverMarkerGroup.remove();
            receiverMarkerGroup = null;
        }

        if (!m || m.receiver_lat == null || m.receiver_lon == null || !mapGroup) return;

        const [cx, cy] = projection([m.receiver_lon, m.receiver_lat]);
        if (isNaN(cx) || isNaN(cy)) return;

        receiverMarkerGroup = mapGroup.append('g')
            .attr('class', 'receiver-marker')
            .attr('data-pin-cx', cx)
            .attr('data-pin-cy', cy);

        // Pin dimensions (in map-space pixels at zoom=1)
        const pinR   = 8;   // radius of the circular head
        const pinH   = 20;  // total height from tip to top of circle
        // The circle centre sits pinH - pinR above the tip
        const headCY = cy - (pinH - pinR);

        // Teardrop path: circle head + two tangent lines meeting at the tip point
        // We use a path that combines an arc for the head and straight lines to the tip.
        // angle where the tangent from the tip touches the circle:
        //   sin(α) = r / d,  d = pinH - pinR  (distance from tip to circle centre)
        const d = pinH - pinR;
        const sinA = pinR / d;
        const alpha = Math.asin(sinA);  // half-angle of the "notch"
        const cosA  = Math.cos(alpha);

        // Tangent touch points on the circle (relative to circle centre)
        const tx = pinR * cosA;
        const ty = pinR * sinA;

        // SVG path: start at tip, line to right tangent, arc over the top, line back to tip
        const pinPath = [
            `M ${cx} ${cy}`,                                          // tip
            `L ${cx + tx} ${headCY + ty}`,                           // right tangent point
            `A ${pinR} ${pinR} 0 1 1 ${cx - tx} ${headCY + ty}`,    // arc (large arc = top half)
            'Z'
        ].join(' ');

        // Drop shadow / glow
        receiverMarkerGroup.append('path')
            .attr('d', pinPath)
            .attr('transform', `translate(1.5, 1.5)`)
            .style('fill', 'rgba(0,0,0,0.35)')
            .style('pointer-events', 'none');

        // Pin body
        receiverMarkerGroup.append('path')
            .attr('d', pinPath)
            .style('fill', '#e74c3c')
            .style('stroke', '#fff')
            .style('stroke-width', '1.5px')
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

        // White dot in the pin head
        receiverMarkerGroup.append('circle')
            .attr('cx', cx)
            .attr('cy', headCY)
            .attr('r', pinR * 0.35)
            .style('fill', '#fff')
            .style('pointer-events', 'none');
    }

    // ── Spot circle markers ───────────────────────────────────────────────────
    // Instead of colouring country polygons (which include overseas territories),
    // we draw a circle at each prediction's Maidenhead locator position.
    // This accurately represents where the signal was heard, not a whole country.
    let spotMarkersGroup = null;

    const PREDICTION_FILL = {
        excellent:  '#1abc9c',
        good:       '#27ae60',
        workable:   '#f1c40f',
        marginal:   '#e67e22',
        poor:       '#c0392b',
        not_viable: '#4a2020',
    };

    function updateMap(preds) {
        if (!mapGroup) return;

        // Remove old spot markers
        if (spotMarkersGroup) {
            spotMarkersGroup.remove();
            spotMarkersGroup = null;
        }

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

        // Draw spot circles at locator positions
        spotMarkersGroup = mapGroup.append('g').attr('class', 'spot-markers');

        for (const entry of preds) {
            if (!entry.locator || entry.locator.length < 4) continue;

            let coords;
            try {
                coords = maidenheadToLatLon(entry.locator);
            } catch (e) {
                continue;
            }

            const projected = projection([coords.lon, coords.lat]);
            if (!projected || isNaN(projected[0]) || isNaN(projected[1])) continue;

            const [cx, cy] = projected;
            const fill = PREDICTION_FILL[entry.prediction] || '#888';
            // Radius scales slightly with spot count (min 5, max 10)
            const r = Math.min(10, Math.max(5, 4 + Math.log2(entry.spot_count + 1)));

            const g = spotMarkersGroup.append('g').attr('class', 'spot-marker');

            // Outer ring — store base-r and base-sw for zoom counter-scaling
            g.append('circle')
                .attr('cx', cx).attr('cy', cy)
                .attr('r', r + 3)
                .attr('data-base-r', r + 3)
                .attr('data-base-sw', 1)
                .style('fill', 'none')
                .style('stroke', fill)
                .style('stroke-width', '1')
                .style('opacity', '0.35')
                .style('pointer-events', 'none');

            // Main circle — store base-r and base-sw for zoom counter-scaling
            g.append('circle')
                .attr('cx', cx).attr('cy', cy)
                .attr('r', r)
                .attr('data-base-r', r)
                .attr('data-base-sw', 1.2)
                .style('fill', fill)
                .style('stroke', '#fff')
                .style('stroke-width', '1.2')
                .style('cursor', 'pointer')
                .on('mousemove', (event) => onSpotMouseMove(event, entry))
                .on('mouseout', () => { tooltip.style.display = 'none'; });
        }

        // Draw receiver marker on top
        drawReceiverMarker(meta);
    }

    // ── Tooltip ──────────────────────────────────────────────────────────────
    const tooltip = document.getElementById('map-tooltip');

    // Tooltip for spot circle markers
    function onSpotMouseMove(event, entry) {
        const cls = entry.prediction;
        const snrStr = (entry.predicted_ssb_snr >= 0 ? '+' : '') + entry.predicted_ssb_snr.toFixed(1);
        const wsprSnrStr = (entry.mean_wspr_snr >= 0 ? '+' : '') + entry.mean_wspr_snr.toFixed(1);
        const pgStr = (entry.power_gain_db >= 0 ? '+' : '') + entry.power_gain_db.toFixed(1);

        let distStr = '—';
        if (entry.distance_km != null) distStr = `${Math.round(entry.distance_km)} km`;

        let bearingStr = '—';
        if (entry.bearing_deg != null) bearingStr = `${Math.round(entry.bearing_deg)}°`;

        const lastSeen = entry.last_seen
            ? new Date(entry.last_seen).toUTCString().replace(' GMT', ' UTC')
            : '—';

        const predLabel = PREDICTION_LABELS[cls] || cls;
        tooltip.innerHTML = `
            <div class="tooltip-title">${escHtml(entry.country)} — ${escHtml(entry.locator || '?')}</div>
            <div>Band: <strong>${escHtml(entry.band)}</strong> &nbsp; Continent: <strong>${escHtml(entry.continent || '—')}</strong></div>
            <div class="${tooltipPredClass(cls)}">Signal quality: <strong>${predLabel}</strong> (${snrStr} dB)</div>
            <div>Mean WSPR SNR: ${wsprSnrStr} dB &nbsp; Mean TX: ${entry.mean_tx_dbm.toFixed(1)} dBm &nbsp; (${entry.spot_count} spot${entry.spot_count !== 1 ? 's' : ''})</div>
            <div>BW penalty: −${entry.bw_correction_db.toFixed(1)} dB &nbsp; Power gain: ${pgStr} dB</div>
            <div>Distance: ${distStr} &nbsp; Bearing: ${bearingStr}</div>
            <div>Last seen: ${lastSeen}</div>
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
    function renderTop10(preds) {
        const el = document.getElementById('top10-list');
        if (!el) return;

        if (!preds || preds.length === 0) {
            el.innerHTML = '<div style="color:#666;font-size:10px;">No data</div>';
            return;
        }

        // Deduplicate by country + band — keep best predicted_ssb_snr per country/band pair
        const byCountryBand = new Map();
        for (const p of preds) {
            const key = (p.country || '—') + '\x00' + (p.band || '—');
            const existing = byCountryBand.get(key);
            if (!existing || p.predicted_ssb_snr > existing.predicted_ssb_snr) {
                byCountryBand.set(key, p);
            }
        }

        // Sort by predicted SSB SNR descending, take top 10
        const top10 = [...byCountryBand.values()]
            .sort((a, b) => b.predicted_ssb_snr - a.predicted_ssb_snr)
            .slice(0, 10);

        el.innerHTML = top10.map(p => {
            const fill = PREDICTION_FILL[p.prediction] || '#888';
            const snrStr = (p.predicted_ssb_snr >= 0 ? '+' : '') + p.predicted_ssb_snr.toFixed(1);
            const country = escHtml(p.country || '—');
            const band = escHtml(p.band || '—');
            return `<div class="top10-row">
                <div class="top10-dot" style="background:${fill}"></div>
                <div class="top10-country" title="${country} (${band})">${country}</div>
                <div class="top10-snr">${band}&nbsp;${snrStr} dB</div>
            </div>`;
        }).join('');
    }

    // ── Status bar update ────────────────────────────────────────────────────
    function updateStatusBar(m, predCount) {
        if (!m) return;
        document.getElementById('status-text').textContent = 'OK';
        document.getElementById('spot-count').textContent = m.spot_count.toLocaleString();
        document.getElementById('country-count').textContent = predCount.toLocaleString();
        document.getElementById('bw-penalty').textContent = m.bw_penalty_db.toFixed(1) + ' dB';
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
            meta = data.meta || null;

            updateStatusBar(meta, predictions.length);
            updateMap(predictions);
            renderTable(predictions);
            renderTop10(predictions);

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

        // Wire up controls to re-fetch immediately on change and reset the timer
        ['band-select', 'minutes-select', 'power-select', 'min-snr-select'].forEach(id => {
            document.getElementById(id).addEventListener('change', () => {
                fetchData();
                startAutoRefresh(); // reset 2-min timer after manual change
            });
        });

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

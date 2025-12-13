package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
)

// WebServer provides HTTP endpoints for statistics
type WebServer struct {
	stats      *StatisticsTracker
	aggregator *SpotAggregator
	wsprnet    *WSPRNet
	config     *Config
	port       int
}

// NewWebServer creates a new web server
func NewWebServer(stats *StatisticsTracker, aggregator *SpotAggregator, wsprnet *WSPRNet, config *Config, port int) *WebServer {
	return &WebServer{
		stats:      stats,
		aggregator: aggregator,
		wsprnet:    wsprnet,
		config:     config,
		port:       port,
	}
}

// Start starts the web server
func (ws *WebServer) Start() error {
	// API endpoints
	http.HandleFunc("/api/stats", ws.handleStats)
	http.HandleFunc("/api/instances", ws.handleInstances)
	http.HandleFunc("/api/windows", ws.handleWindows)
	http.HandleFunc("/api/aggregator", ws.handleAggregator)
	http.HandleFunc("/api/countries", ws.handleCountries)
	http.HandleFunc("/api/spots", ws.handleSpots)
	http.HandleFunc("/api/wsprnet", ws.handleWSPRNet)
	http.HandleFunc("/api/snr-history", ws.handleSNRHistory)
	http.HandleFunc("/api/receiver", ws.handleReceiver)

	// Dashboard
	http.HandleFunc("/", ws.handleDashboard)

	addr := fmt.Sprintf(":%d", ws.port)
	log.Printf("Web server starting on http://localhost%s", addr)

	go func() {
		if err := http.ListenAndServe(addr, nil); err != nil {
			log.Printf("Web server error: %v", err)
		}
	}()

	return nil
}

// handleStats returns overall statistics
func (ws *WebServer) handleStats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	stats := ws.stats.GetOverallStats()
	_ = json.NewEncoder(w).Encode(stats)
}

// handleInstances returns per-instance statistics
func (ws *WebServer) handleInstances(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	instances := ws.stats.GetInstanceStats()
	_ = json.NewEncoder(w).Encode(instances)
}

// handleWindows returns recent window statistics
func (ws *WebServer) handleWindows(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	// Get last 30 windows (1 hour of history)
	windows := ws.stats.GetRecentWindows(30)
	_ = json.NewEncoder(w).Encode(windows)
}

// handleAggregator returns current aggregator state
func (ws *WebServer) handleAggregator(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	aggStats := ws.aggregator.GetStats()
	_ = json.NewEncoder(w).Encode(aggStats)
}

// handleCountries returns country statistics
func (ws *WebServer) handleCountries(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	countries := ws.stats.GetCountryStats()
	_ = json.NewEncoder(w).Encode(countries)
}

// handleSpots returns current spots for mapping
func (ws *WebServer) handleSpots(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	spots := ws.stats.GetCurrentSpots()
	_ = json.NewEncoder(w).Encode(spots)
}

// handleWSPRNet returns WSPRNet statistics
func (ws *WebServer) handleWSPRNet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	wsprnetStats := ws.wsprnet.GetStats()
	_ = json.NewEncoder(w).Encode(wsprnetStats)
}

// handleSNRHistory returns SNR history for all bands and instances
func (ws *WebServer) handleSNRHistory(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	snrHistory := ws.stats.GetSNRHistory()
	_ = json.NewEncoder(w).Encode(snrHistory)
}

// handleReceiver returns receiver information from config
func (ws *WebServer) handleReceiver(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	receiverInfo := map[string]interface{}{
		"callsign": ws.config.Receiver.Callsign,
		"locator":  ws.config.Receiver.Locator,
	}
	_ = json.NewEncoder(w).Encode(receiverInfo)
}

// handleDashboard serves the HTML dashboard
func (ws *WebServer) handleDashboard(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html")

	html := `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WSPR MQTT Aggregator Dashboard</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css" />
    <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css" />
    <script src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: #0f172a;
            color: #e2e8f0;
            padding: 20px;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 30px;
            border-radius: 12px;
            margin-bottom: 30px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.3);
        }
        h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
        }
        .subtitle {
            opacity: 0.9;
            font-size: 1.1em;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        .stat-card {
            background: #1e293b;
            padding: 25px;
            border-radius: 12px;
            border: 1px solid #334155;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        .stat-label {
            color: #94a3b8;
            font-size: 0.9em;
            margin-bottom: 8px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .stat-value {
            font-size: 2.5em;
            font-weight: bold;
            color: #60a5fa;
        }
        .chart-container {
            background: #1e293b;
            padding: 25px;
            border-radius: 12px;
            margin-bottom: 30px;
            border: 1px solid #334155;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        .chart-title {
            font-size: 1.5em;
            margin-bottom: 20px;
            color: #f1f5f9;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            background: #1e293b;
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        th {
            background: #334155;
            padding: 15px;
            text-align: left;
            font-weight: 600;
            color: #f1f5f9;
            text-transform: uppercase;
            font-size: 0.85em;
            letter-spacing: 0.5px;
        }
        td {
            padding: 15px;
            border-top: 1px solid #334155;
        }
        tr:hover {
            background: #2d3748;
        }
        .badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 0.85em;
            font-weight: 600;
        }
        .badge-primary {
            background: #3b82f6;
            color: white;
        }
        .badge-success {
            background: #10b981;
            color: white;
        }
        .badge-warning {
            background: #f59e0b;
            color: white;
        }
        .last-update {
            text-align: center;
            color: #94a3b8;
            margin-top: 20px;
            font-size: 0.9em;
        }
        .grid-2col {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
            margin-bottom: 30px;
        }
        @media (max-width: 768px) {
            .grid-2col {
                grid-template-columns: 1fr;
            }
        }
        .instance-name {
            font-weight: 600;
            color: #60a5fa;
        }
        .progress-bar {
            width: 100%;
            height: 8px;
            background: #334155;
            border-radius: 4px;
            overflow: hidden;
            margin-top: 8px;
        }
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #3b82f6, #8b5cf6);
            transition: width 0.3s ease;
        }
        #map {
            height: 600px;
            width: 100%;
            border-radius: 8px;
        }
        .legend {
            background: rgba(30, 41, 59, 0.95);
            padding: 12px;
            border-radius: 8px;
            border: 2px solid #334155;
            box-shadow: 0 4px 6px rgba(0,0,0,0.3);
            line-height: 20px;
            color: #e2e8f0;
            font-size: 13px;
        }
        .legend h4 {
            margin: 0 0 8px 0;
            font-size: 14px;
            font-weight: 600;
            color: #f1f5f9;
        }
        .legend-item {
            display: flex;
            align-items: center;
            margin: 4px 0;
        }
        .legend-color {
            width: 16px;
            height: 16px;
            border-radius: 50%;
            margin-right: 8px;
            border: 2px solid white;
            box-shadow: 0 0 3px rgba(0,0,0,0.5);
        }
        .marker-cluster-small {
            background-color: rgba(59, 130, 246, 0.6);
        }
        .marker-cluster-small div {
            background-color: rgba(59, 130, 246, 0.8);
        }
        .marker-cluster-medium {
            background-color: rgba(245, 158, 11, 0.6);
        }
        .marker-cluster-medium div {
            background-color: rgba(245, 158, 11, 0.8);
        }
        .marker-cluster-large {
            background-color: rgba(239, 68, 68, 0.6);
        }
        .marker-cluster-large div {
            background-color: rgba(239, 68, 68, 0.8);
        }
        .sortable {
            cursor: pointer;
            user-select: none;
            position: relative;
            padding-right: 20px !important;
        }
        .sortable:hover {
            background: #475569;
        }
        .sortable::after {
            content: '⇅';
            position: absolute;
            right: 8px;
            opacity: 0.3;
        }
        .sortable.asc::after {
            content: '↑';
            opacity: 1;
        }
        .sortable.desc::after {
            content: '↓';
            opacity: 1;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🛰️ WSPR MQTT Aggregator</h1>
        <div class="subtitle">Real-time monitoring and statistics</div>
    </div>

    <div class="stats-grid">
        <div class="stat-card">
            <div class="stat-label">Successfully Sent</div>
            <div class="stat-value" id="successfulSent" style="color: #10b981;">-</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Failed (After Retries)</div>
            <div class="stat-value" id="failedSent" style="color: #ef4444;">-</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Duplicates Removed</div>
            <div class="stat-value" id="totalDuplicates">-</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Pending Spots</div>
            <div class="stat-value" id="pendingSpots">-</div>
        </div>
    </div>

    <div class="grid-2col">
        <div class="chart-container">
            <div class="chart-title">Spots Over Time</div>
            <canvas id="spotsChart"></canvas>
        </div>
        <div class="chart-container">
            <div class="chart-title">Band Distribution</div>
            <canvas id="bandChart"></canvas>
        </div>
    </div>

    <div class="chart-container">
        <div class="chart-title">Live WSPR Spots Map</div>
        <div id="map"></div>
    </div>

    <div class="chart-container">
        <div class="chart-title">Instance Performance</div>
        <table id="instanceTable">
            <thead>
                <tr>
                    <th>Instance</th>
                    <th>Total Spots</th>
                    <th>Unique</th>
                    <th>Best SNR Wins</th>
                    <th>Win Rate</th>
                    <th>Last Report</th>
                </tr>
            </thead>
            <tbody id="instanceTableBody">
            </tbody>
        </table>
    </div>

    <div class="chart-container">
        <div class="chart-title">Per-Band Instance Performance</div>
        <div id="bandInstanceTables"></div>
    </div>

    <div class="chart-container">
        <div class="chart-title">SNR History by Band</div>
        <div id="snrHistoryCharts"></div>
    </div>

    <div class="chart-container">
        <div class="chart-title">Country Statistics by Band</div>
        <div id="countryTables"></div>
    </div>

    <div class="last-update">
        Last updated: <span id="lastUpdate">-</span> | Auto-refresh every 60 seconds
    </div>

    <script>
        let spotsChart, bandChart, map, markerClusterGroup, receiverMarker;

        // Band colors for map markers (2200m through 10m)
        const bandColors = {
            '2200m': '#7c2d12',
            '630m': '#991b1b',
            '160m': '#dc2626',
            '80m': '#ea580c',
            '60m': '#f59e0b',
            '40m': '#eab308',
            '30m': '#84cc16',
            '20m': '#22c55e',
            '17m': '#10b981',
            '15m': '#14b8a6',
            '12m': '#06b6d4',
            '10m': '#0ea5e9'
        };

        // Initialize map
        function initMap() {
            map = L.map('map').setView([20, 0], 2);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap contributors',
                maxZoom: 18
            }).addTo(map);
            
            // Initialize marker cluster group
            markerClusterGroup = L.markerClusterGroup({
                maxClusterRadius: 30,
                spiderfyOnMaxZoom: true,
                showCoverageOnHover: false,
                zoomToBoundsOnClick: true,
                disableClusteringAtZoom: 6
            });
            map.addLayer(markerClusterGroup);

            // Add legend
            const legend = L.control({position: 'bottomright'});
            legend.onAdd = function(map) {
                const div = L.DomUtil.create('div', 'legend');
                div.innerHTML = '<h4>WSPR Bands</h4>';
                
                const bands = [
                    '2200m', '630m', '160m', '80m', '60m', '40m',
                    '30m', '20m', '17m', '15m', '12m', '10m'
                ];
                
                bands.forEach(band => {
                    div.innerHTML += ` + "`" + `
                        <div class="legend-item">
                            <div class="legend-color" style="background: ${bandColors[band]}"></div>
                            <span>${band}</span>
                        </div>
                    ` + "`" + `;
                });
                
                return div;
            };
            legend.addTo(map);
        }

        // Helper function to sort bands in proper order
        function sortBands(bands) {
            const bandOrder = ['2200m', '630m', '160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];
            return bands.sort((a, b) => {
                const aIndex = bandOrder.indexOf(a);
                const bIndex = bandOrder.indexOf(b);
                // If band not in order list, put it at the end
                if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
                if (aIndex === -1) return 1;
                if (bIndex === -1) return -1;
                return aIndex - bIndex;
            });
        }

        // Convert Maidenhead locator to lat/lon
        function maidenheadToLatLon(locator) {
            if (!locator || locator.length < 4) return null;

            locator = locator.toUpperCase();

            // Field (first 2 chars): 20° longitude, 10° latitude
            const lon1 = (locator.charCodeAt(0) - 65) * 20 - 180;
            const lat1 = (locator.charCodeAt(1) - 65) * 10 - 90;

            // Square (next 2 chars): 2° longitude, 1° latitude
            const lon2 = parseInt(locator[2]) * 2;
            const lat2 = parseInt(locator[3]) * 1;

            let lon = lon1 + lon2;
            let lat = lat1 + lat2;

            // Subsquare (optional 2 chars): 5' (2/24°) longitude, 2.5' (1/24°) latitude
            if (locator.length >= 6) {
                const lon3 = (locator.charCodeAt(4) - 65) * (2/24);
                const lat3 = (locator.charCodeAt(5) - 65) * (1/24);
                lon += lon3;
                lat += lat3;
                // Center of subsquare
                lon += (1/24);
                lat += (1/48);
            } else {
                // Center of square (4-char locator)
                lon += 1;
                lat += 0.5;
            }

            // Add small random offset to spread out multiple stations
            lon += (Math.random() - 0.5) * 0.02;
            lat += (Math.random() - 0.5) * 0.01;

            return [lat, lon];
        }

        // Create multi-colored marker icon
        function createMultiBandIcon(bands) {
            const colors = bands.map(b => bandColors[b] || '#666');
            
            if (colors.length === 1) {
                return L.divIcon({
                    className: 'custom-marker',
                    html: ` + "`" + `<div style="background: ${colors[0]}; width: 12px; height: 12px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 4px rgba(0,0,0,0.5);"></div>` + "`" + `,
                    iconSize: [16, 16],
                    iconAnchor: [8, 8]
                });
            }
            
            // Multi-band: create gradient or split effect
            let background;
            if (colors.length === 2) {
                // Split in half
                background = ` + "`" + `linear-gradient(90deg, ${colors[0]} 50%, ${colors[1]} 50%)` + "`" + `;
            } else if (colors.length === 3) {
                // Three sections
                background = ` + "`" + `linear-gradient(90deg, ${colors[0]} 33.33%, ${colors[1]} 33.33%, ${colors[1]} 66.66%, ${colors[2]} 66.66%)` + "`" + `;
            } else {
                // More than 3: use conic gradient for pie chart
                const stops = colors.map((color, i) => {
                    const start = (i / colors.length) * 360;
                    const end = ((i + 1) / colors.length) * 360;
                    return ` + "`" + `${color} ${start}deg ${end}deg` + "`" + `;
                }).join(', ');
                background = ` + "`" + `conic-gradient(from 0deg, ${stops})` + "`" + `;
            }
            
            return L.divIcon({
                className: 'custom-marker',
                html: ` + "`" + `<div style="background: ${background}; width: 14px; height: 14px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 4px rgba(0,0,0,0.5);"></div>` + "`" + `,
                iconSize: [18, 18],
                iconAnchor: [9, 9]
            });
        }

        // Update map with spots
        function updateMap(spots) {
            if (!map || !markerClusterGroup) return;
            
            // Clear existing markers from cluster group
            markerClusterGroup.clearLayers();
            
            if (!spots || spots.length === 0) return;
            
            spots.forEach(spot => {
                const coords = maidenheadToLatLon(spot.locator);
                if (!coords) return;
                
                const icon = createMultiBandIcon(spot.bands);
                const marker = L.marker(coords, { icon: icon });
                
                const bandList = spot.bands.map(b => ` + "`" + `<span style="color: ${bandColors[b]}">${b}</span>` + "`" + `).join(', ');
                const snrList = spot.bands.map((b, i) => ` + "`" + `${b}: ${spot.snr[i]} dB` + "`" + `).join('<br>');
                
                marker.bindPopup(` + "`" + `
                    <strong>${spot.callsign}</strong><br>
                    ${spot.country}<br>
                    Locator: ${spot.locator}<br>
                    Bands: ${bandList}<br>
                    SNR:<br>${snrList}
                ` + "`" + `);
                
                markerClusterGroup.addLayer(marker);
            });
        }

        // Update receiver marker on map
        function updateReceiverMarker(receiverInfo) {
            if (!map || !receiverInfo || !receiverInfo.locator) return;

            const coords = maidenheadToLatLon(receiverInfo.locator);
            if (!coords) return;

            // Remove existing receiver marker if present
            if (receiverMarker) {
                map.removeLayer(receiverMarker);
            }

            // Create custom icon for receiver
            const receiverIcon = L.divIcon({
                className: 'receiver-marker',
                html: ` + "`" + `<div style="background: radial-gradient(circle, #ef4444 0%, #dc2626 100%); width: 16px; height: 16px; border-radius: 50%; border: 3px solid white; box-shadow: 0 0 10px rgba(239, 68, 68, 0.8);"></div>` + "`" + `,
                iconSize: [22, 22],
                iconAnchor: [11, 11]
            });

            receiverMarker = L.marker(coords, {
                icon: receiverIcon,
                zIndexOffset: 1000
            });

            receiverMarker.bindPopup(` + "`" + `
                <strong>🏠 Receiver Station</strong><br>
                Callsign: ${receiverInfo.callsign}<br>
                Locator: ${receiverInfo.locator}
            ` + "`" + `);

            receiverMarker.addTo(map);
        }

        async function fetchData() {
            try {
                const [stats, instances, windows, aggregator, countries, spots, wsprnet, snrHistory, receiver] = await Promise.all([
                    fetch('/api/stats').then(r => r.json()),
                    fetch('/api/instances').then(r => r.json()),
                    fetch('/api/windows').then(r => r.json()),
                    fetch('/api/aggregator').then(r => r.json()),
                    fetch('/api/countries').then(r => r.json()),
                    fetch('/api/spots').then(r => r.json()),
                    fetch('/api/wsprnet').then(r => r.json()),
                    fetch('/api/snr-history').then(r => r.json()),
                    fetch('/api/receiver').then(r => r.json())
                ]);

                updateStats(stats, aggregator, wsprnet);
                updateCharts(windows);
                updateInstanceTable(instances);
                updateBandInstanceTable(instances);
                updateSNRHistoryCharts(snrHistory);
                updateCountryTables(countries);
                updateMap(spots);
                updateReceiverMarker(receiver);
                
                document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString();
            } catch (error) {
                console.error('Error fetching data:', error);
            }
        }

        function updateStats(stats, aggregator, wsprnet) {
            document.getElementById('successfulSent').textContent = wsprnet.successful || 0;
            document.getElementById('failedSent').textContent = wsprnet.failed || 0;
            document.getElementById('totalDuplicates').textContent = stats.total_duplicates || 0;
            document.getElementById('pendingSpots').textContent = aggregator.pending_spots || 0;
        }

        function updateCharts(windows) {
            if (!windows || windows.length === 0) return;

            // Spots over time chart
            const labels = windows.map(w => {
                const date = new Date(w.WindowTime);
                return date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
            });
            const spotData = windows.map(w => w.TotalSpots);
            const dupData = windows.map(w => w.DuplicateCount);

            if (spotsChart) {
                spotsChart.data.labels = labels;
                spotsChart.data.datasets[0].data = spotData;
                spotsChart.data.datasets[1].data = dupData;
                spotsChart.update();
            } else {
                const ctx = document.getElementById('spotsChart').getContext('2d');
                spotsChart = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: labels,
                        datasets: [{
                            label: 'Total Spots',
                            data: spotData,
                            borderColor: '#3b82f6',
                            backgroundColor: 'rgba(59, 130, 246, 0.1)',
                            tension: 0.4
                        }, {
                            label: 'Duplicates',
                            data: dupData,
                            borderColor: '#f59e0b',
                            backgroundColor: 'rgba(245, 158, 11, 0.1)',
                            tension: 0.4
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: true,
                        plugins: {
                            legend: {
                                labels: { color: '#e2e8f0' }
                            }
                        },
                        scales: {
                            y: {
                                beginAtZero: true,
                                ticks: { color: '#94a3b8' },
                                grid: { color: '#334155' }
                            },
                            x: {
                                ticks: { color: '#94a3b8' },
                                grid: { color: '#334155' }
                            }
                        }
                    }
                });
            }

            // Band distribution (sum of all windows in last 24 hours)
            if (windows && windows.length > 0) {
                // Aggregate band counts across all windows
                const bandTotals = {};
                windows.forEach(window => {
                    if (window.BandBreakdown) {
                        Object.entries(window.BandBreakdown).forEach(([band, count]) => {
                            bandTotals[band] = (bandTotals[band] || 0) + count;
                        });
                    }
                });

                // Sort bands properly
                const sortedBands = sortBands(Object.keys(bandTotals));
                const counts = sortedBands.map(band => bandTotals[band]);

                if (bandChart) {
                    bandChart.data.labels = sortedBands;
                    bandChart.data.datasets[0].data = counts;
                    bandChart.update();
                } else {
                    const ctx = document.getElementById('bandChart').getContext('2d');
                    bandChart = new Chart(ctx, {
                        type: 'bar',
                        data: {
                            labels: sortedBands,
                            datasets: [{
                                label: 'Spots per Band (24h)',
                                data: counts,
                                backgroundColor: [
                                    '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b',
                                    '#10b981', '#06b6d4', '#6366f1', '#a855f7',
                                    '#f43f5e', '#14b8a6', '#a855f7', '#22c55e'
                                ]
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: true,
                            plugins: {
                                legend: { display: false },
                                title: {
                                    display: true,
                                    text: 'Last 24 Hours',
                                    color: '#94a3b8',
                                    font: { size: 12 }
                                }
                            },
                            scales: {
                                y: {
                                    beginAtZero: true,
                                    ticks: { color: '#94a3b8' },
                                    grid: { color: '#334155' }
                                },
                                x: {
                                    ticks: { color: '#94a3b8' },
                                    grid: { color: '#334155' }
                                }
                            }
                        }
                    });
                }
            }
        }

        function updateInstanceTable(instances) {
            const tbody = document.getElementById('instanceTableBody');
            tbody.innerHTML = '';

            // Sort instances alphabetically by name
            const sortedInstances = Object.values(instances).sort((a, b) =>
                a.Name.localeCompare(b.Name)
            );

            sortedInstances.forEach(inst => {
                const winRate = inst.TotalSpots > 0 
                    ? ((inst.BestSNRWins / inst.TotalSpots) * 100).toFixed(1)
                    : '0.0';
                
                const lastReport = inst.LastReportTime 
                    ? new Date(inst.LastReportTime).toLocaleTimeString()
                    : 'Never';

                const row = ` + "`" + `
                    <tr>
                        <td><span class="instance-name">${inst.Name}</span></td>
                        <td>${inst.TotalSpots}</td>
                        <td><span class="badge badge-success">${inst.UniqueSpots}</span></td>
                        <td><span class="badge badge-primary">${inst.BestSNRWins}</span></td>
                        <td>
                            ${winRate}%
                            <div class="progress-bar">
                                <div class="progress-fill" style="width: ${winRate}%"></div>
                            </div>
                        </td>
                        <td>${lastReport}</td>
                    </tr>
                ` + "`" + `;
                tbody.innerHTML += row;
            });
        }

        // Store band charts globally
        const bandCharts = {};

        function updateBandInstanceTable(instances) {
            const container = document.getElementById('bandInstanceTables');
            container.innerHTML = '';

            // Create a grid container for the band sections
            const gridContainer = document.createElement('div');
            gridContainer.style.display = 'grid';
            gridContainer.style.gridTemplateColumns = 'repeat(auto-fit, minmax(500px, 1fr))';
            gridContainer.style.gap = '20px';

            // Collect all bands and organize data by band
            const bandData = {};
            
            // Sort instances alphabetically by name
            const sortedInstances = Object.values(instances).sort((a, b) =>
                a.Name.localeCompare(b.Name)
            );
            
            sortedInstances.forEach(inst => {
                Object.entries(inst.BandStats || {}).forEach(([band, stats]) => {
                    if (!bandData[band]) {
                        bandData[band] = [];
                    }
                    bandData[band].push({
                        name: inst.Name,
                        stats: stats
                    });
                });
            });

            // Sort bands properly
            const bands = sortBands(Object.keys(bandData));

            // Create a chart and table for each band
            bands.forEach(band => {
                const instanceList = bandData[band];
                
                // Sort instances alphabetically by name for consistent ordering
                instanceList.sort((a, b) => a.name.localeCompare(b.name));

                const chartId = ` + "`" + `bandChart_${band.replace(/[^a-zA-Z0-9]/g, '_')}` + "`" + `;

                const sectionHTML = ` + "`" + `
                    <div style="margin-bottom: 30px;">
                        <h3 style="color: #60a5fa; margin-bottom: 15px;">
                            <span class="badge badge-warning" style="font-size: 1.1em; padding: 6px 14px;">${band}</span>
                        </h3>
                        
                        <!-- Chart -->
                        <div style="background: #1e293b; padding: 20px; border-radius: 12px; margin-bottom: 15px; border: 1px solid #334155;">
                            <canvas id="${chartId}" style="max-height: 250px;"></canvas>
                        </div>
                        
                        <!-- Table -->
                        <table style="width: 100%;">
                            <thead>
                                <tr>
                                    <th>Instance</th>
                                    <th>Total Spots</th>
                                    <th>Unique</th>
                                    <th>Best SNR Wins</th>
                                    <th>Win Rate</th>
                                    <th>Avg SNR</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${instanceList.map(item => {
                                    const winRate = item.stats.TotalSpots > 0
                                        ? ((item.stats.BestSNRWins / item.stats.TotalSpots) * 100).toFixed(1)
                                        : '0.0';
                                    return ` + "`" + `
                                        <tr>
                                            <td><span class="instance-name">${item.name}</span></td>
                                            <td>${item.stats.TotalSpots}</td>
                                            <td><span class="badge badge-success">${item.stats.UniqueSpots}</span></td>
                                            <td><span class="badge badge-primary">${item.stats.BestSNRWins}</span></td>
                                            <td>
                                                ${winRate}%
                                                <div class="progress-bar">
                                                    <div class="progress-fill" style="width: ${winRate}%"></div>
                                                </div>
                                            </td>
                                            <td>${item.stats.AverageSNR.toFixed(1)} dB</td>
                                        </tr>
                                    ` + "`" + `;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>
                ` + "`" + `;

                const bandDiv = document.createElement('div');
                bandDiv.innerHTML = sectionHTML;
                gridContainer.appendChild(bandDiv);

                // Create chart after DOM is updated
                setTimeout(() => {
                    const ctx = document.getElementById(chartId);
                    if (!ctx) return;

                    const labels = instanceList.map(item => item.name);
                    const totalData = instanceList.map(item => item.stats.TotalSpots);
                    const uniqueData = instanceList.map(item => item.stats.UniqueSpots);

                    // Destroy existing chart if it exists
                    if (bandCharts[band]) {
                        bandCharts[band].destroy();
                    }

                    bandCharts[band] = new Chart(ctx, {
                        type: 'bar',
                        data: {
                            labels: labels,
                            datasets: [{
                                label: 'Total Spots',
                                data: totalData,
                                backgroundColor: '#3b82f6',
                                borderColor: '#2563eb',
                                borderWidth: 1
                            }, {
                                label: 'Unique Spots',
                                data: uniqueData,
                                backgroundColor: '#10b981',
                                borderColor: '#059669',
                                borderWidth: 1
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: true,
                            plugins: {
                                legend: {
                                    labels: { color: '#e2e8f0' }
                                },
                                title: {
                                    display: true,
                                    text: ` + "`" + `${band} - Instance Performance` + "`" + `,
                                    color: '#f1f5f9',
                                    font: { size: 16 }
                                }
                            },
                            scales: {
                                y: {
                                    beginAtZero: true,
                                    ticks: { color: '#94a3b8' },
                                    grid: { color: '#334155' }
                                },
                                x: {
                                    ticks: { color: '#94a3b8' },
                                    grid: { color: '#334155' }
                                }
                            }
                        }
                    });
                }, 0);
            });

            if (bands.length === 0) {
                container.innerHTML = '<p style="color: #94a3b8; text-align: center;">No band data available yet</p>';
            } else {
                container.appendChild(gridContainer);
            }
        }

        // Store country data for sorting
        let countryData = {};

        function updateCountryTables(countries) {
            const container = document.getElementById('countryTables');
            container.innerHTML = '';

            if (!countries || Object.keys(countries).length === 0) {
                container.innerHTML = '<p style="color: #94a3b8; text-align: center;">No country data available yet</p>';
                return;
            }

            // Store data globally for sorting
            countryData = countries;

            // Sort bands properly
            const bands = sortBands(Object.keys(countries));

            bands.forEach(band => {
                const countryList = countries[band];
                if (!countryList || countryList.length === 0) return;

                // Sort by total spots descending (default)
                countryList.sort((a, b) => b.total_spots - a.total_spots);

                const tableId = ` + "`" + `countryTable_${band.replace(/[^a-zA-Z0-9]/g, '_')}` + "`" + `;

                const tableHTML = ` + "`" + `
                    <div style="margin-bottom: 30px;">
                        <h3 style="color: #60a5fa; margin-bottom: 15px;">${band}</h3>
                        <table id="${tableId}" style="width: 100%;">
                            <thead>
                                <tr>
                                    <th class="sortable" data-band="${band}" data-column="country" data-type="string">Country</th>
                                    <th class="sortable" data-band="${band}" data-column="unique_callsigns" data-type="number">Unique Callsigns</th>
                                    <th class="sortable desc" data-band="${band}" data-column="total_spots" data-type="number">Total Spots</th>
                                    <th class="sortable" data-band="${band}" data-column="min_snr" data-type="number">Min SNR</th>
                                    <th class="sortable" data-band="${band}" data-column="max_snr" data-type="number">Max SNR</th>
                                    <th class="sortable" data-band="${band}" data-column="avg_snr" data-type="number">Avg SNR</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${countryList.map(c => ` + "`" + `
                                    <tr>
                                        <td><strong>${c.country}</strong></td>
                                        <td><span class="badge badge-success">${c.unique_callsigns}</span></td>
                                        <td>${c.total_spots}</td>
                                        <td>${c.min_snr} dB</td>
                                        <td>${c.max_snr} dB</td>
                                        <td>${c.avg_snr.toFixed(1)} dB</td>
                                    </tr>
                                ` + "`" + `).join('')}
                            </tbody>
                        </table>
                    </div>
                ` + "`" + `;

                container.innerHTML += tableHTML;
            });

            // Add click handlers for sorting
            document.querySelectorAll('.sortable').forEach(header => {
                header.addEventListener('click', function() {
                    const band = this.dataset.band;
                    const column = this.dataset.column;
                    const type = this.dataset.type;
                    const tableId = ` + "`" + `countryTable_${band.replace(/[^a-zA-Z0-9]/g, '_')}` + "`" + `;
                    
                    // Toggle sort direction
                    const isAsc = this.classList.contains('asc');
                    
                    // Remove sort classes from all headers in this table
                    document.querySelectorAll(` + "`" + `#${tableId} .sortable` + "`" + `).forEach(h => {
                        h.classList.remove('asc', 'desc');
                    });
                    
                    // Add appropriate class to clicked header
                    this.classList.add(isAsc ? 'desc' : 'asc');
                    
                    // Sort the data
                    sortCountryTable(band, column, type, !isAsc);
                });
            });
        }

        function sortCountryTable(band, column, type, ascending) {
            const countryList = [...countryData[band]];
            
            countryList.sort((a, b) => {
                let aVal = a[column];
                let bVal = b[column];
                
                if (type === 'number') {
                    aVal = parseFloat(aVal);
                    bVal = parseFloat(bVal);
                }
                
                if (ascending) {
                    return aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
                } else {
                    return aVal < bVal ? 1 : aVal > bVal ? -1 : 0;
                }
            });
            
            // Update table body
            const tableId = ` + "`" + `countryTable_${band.replace(/[^a-zA-Z0-9]/g, '_')}` + "`" + `;
            const tbody = document.querySelector(` + "`" + `#${tableId} tbody` + "`" + `);
            
            tbody.innerHTML = countryList.map(c => ` + "`" + `
                <tr>
                    <td><strong>${c.country}</strong></td>
                    <td><span class="badge badge-success">${c.unique_callsigns}</span></td>
                    <td>${c.total_spots}</td>
                    <td>${c.min_snr} dB</td>
                    <td>${c.max_snr} dB</td>
                    <td>${c.avg_snr.toFixed(1)} dB</td>
                </tr>
            ` + "`" + `).join('');
        }

        // Store SNR charts globally
        const snrCharts = {};

        function updateSNRHistoryCharts(snrHistory) {
            const container = document.getElementById('snrHistoryCharts');
            
            if (!snrHistory || Object.keys(snrHistory).length === 0) {
                container.innerHTML = '<p style="color: #94a3b8; text-align: center;">No SNR history data available yet</p>';
                return;
            }

            // Sort bands properly
            const bands = sortBands(Object.keys(snrHistory));

            container.innerHTML = '';

            bands.forEach(band => {
                const bandData = snrHistory[band];
                if (!bandData || !bandData.instances || Object.keys(bandData.instances).length === 0) {
                    return;
                }

                const chartId = ` + "`" + `snrChart_${band.replace(/[^a-zA-Z0-9]/g, '_')}` + "`" + `;

                const chartHTML = ` + "`" + `
                    <div style="margin-bottom: 40px;">
                        <h3 style="color: #60a5fa; margin-bottom: 15px;">
                            <span class="badge badge-warning" style="font-size: 1.1em; padding: 6px 14px;">${band}</span>
                            <span style="font-size: 0.8em; color: #94a3b8; margin-left: 10px;">Average SNR Over Time</span>
                        </h3>
                        <div style="background: #1e293b; padding: 20px; border-radius: 12px; border: 1px solid #334155;">
                            <canvas id="${chartId}" style="max-height: 400px;"></canvas>
                        </div>
                    </div>
                ` + "`" + `;

                container.innerHTML += chartHTML;

                // Create chart after DOM is updated
                setTimeout(() => {
                    const ctx = document.getElementById(chartId);
                    if (!ctx) return;

                    // Sort instances alphabetically
                    const instanceNames = Object.keys(bandData.instances).sort();

                    // Generate colors for each instance
                    const colors = [
                        '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
                        '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16',
                        '#f97316', '#14b8a6', '#a855f7', '#22c55e'
                    ];

                    const datasets = instanceNames.map((instance, idx) => {
                        const points = bandData.instances[instance];
                        const color = colors[idx % colors.length];

                        return {
                            label: instance,
                            data: points.map(p => ({
                                x: new Date(p.window_time),
                                y: p.average_snr
                            })),
                            borderColor: color,
                            backgroundColor: color + '20',
                            tension: 0.4,
                            pointRadius: 3,
                            pointHoverRadius: 5
                        };
                    });

                    // Destroy existing chart if it exists
                    if (snrCharts[band]) {
                        snrCharts[band].destroy();
                    }

                    snrCharts[band] = new Chart(ctx, {
                        type: 'line',
                        data: {
                            datasets: datasets
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: true,
                            plugins: {
                                legend: {
                                    labels: { color: '#e2e8f0' },
                                    position: 'top'
                                },
                                title: {
                                    display: true,
                                    text: ` + "`" + `${band} - Average SNR per Instance` + "`" + `,
                                    color: '#f1f5f9',
                                    font: { size: 16 }
                                },
                                tooltip: {
                                    callbacks: {
                                        label: function(context) {
                                            return context.dataset.label + ': ' + context.parsed.y.toFixed(1) + ' dB';
                                        }
                                    }
                                }
                            },
                            scales: {
                                x: {
                                    type: 'time',
                                    time: {
                                        unit: 'minute',
                                        displayFormats: {
                                            minute: 'HH:mm'
                                        }
                                    },
                                    ticks: { color: '#94a3b8' },
                                    grid: { color: '#334155' },
                                    title: {
                                        display: true,
                                        text: 'Time (UTC)',
                                        color: '#94a3b8'
                                    }
                                },
                                y: {
                                    beginAtZero: false,
                                    ticks: {
                                        color: '#94a3b8',
                                        callback: function(value) {
                                            return value + ' dB';
                                        }
                                    },
                                    grid: { color: '#334155' },
                                    title: {
                                        display: true,
                                        text: 'Average SNR (dB)',
                                        color: '#94a3b8'
                                    }
                                }
                            }
                        }
                    });
                }, 0);
            });

            if (bands.length === 0) {
                container.innerHTML = '<p style="color: #94a3b8; text-align: center;">No SNR history data available yet</p>';
            }
        }

        // Initialize map on load
        initMap();

        // Initial load
        fetchData();

        // Auto-refresh every 60 seconds
        setInterval(fetchData, 60000);
    </script>
</body>
</html>`

	_, _ = w.Write([]byte(html))
}

// CW Skimmer Map JavaScript
// Displays real-time CW spots on a Leaflet map

class CWSkimmerMap {
    constructor() {
        this.map = null;
        this.ws = null;
        this.spots = new Map(); // Store spots by unique key (callsign-band)
        this.markers = new Map(); // Store Leaflet markers
        this.markerClusterGroup = null; // Leaflet marker cluster group
        this.receiverMarker = null;
        this.receiverLocation = null;
        this.receiverInfo = null;
        this.greylineLayer = null;
        this.maxSpots = 10000; // Maximum number of spots to display
        this.maxAge = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
        this.userSessionID = this.generateUserSessionID();
        this.ageFilter = '60'; // Current age filter (max age in minutes) - default 1 hour
        this.bandFilter = 'all'; // Current band filter
        this.countryFilter = 'all'; // Current country filter
        this.continentFilter = 'all'; // Current continent filter
        this.snrFilter = 'none'; // Current SNR filter (minimum SNR)
        this.reconnectAttempts = 0; // Track reconnection attempts
        this.reconnectTimeout = null; // Store timeout ID
        this.liveMessages = []; // Store live messages
        this.maxLiveMessages = 10000; // Maximum number of live messages to keep
        this.liveMessagesPage = 1; // Current page
        this.liveMessagesPerPage = 200; // Messages per page
        this.liveMessagesCallsignFilter = ''; // Callsign filter
        this.bandConditionsInterval = null; // Store band conditions update interval
        this.bandConditionsAvailable = false; // Track if band conditions are available
        this.currentStatus = 'disconnected'; // Track current connection status to avoid unnecessary DOM updates

        // Track spots per minute
        this.spotTimestamps = []; // Array of timestamps for rate calculation
        this.lastSpotTime = null; // Timestamp of most recent spot

        // Track seen continent+band and country+band combinations for "new" detection
        this.seenContinentBands = new Set();
        this.seenCountryBands = new Set();
        this.latestNewContinent = null;
        this.latestNewCountry = null;

        // Continent code to name mapping
        this.continentNames = {
            'AF': 'Africa',
            'AS': 'Asia',
            'EU': 'Europe',
            'NA': 'North America',
            'OC': 'Oceania',
            'SA': 'South America',
            'AN': 'Antarctica'
        };

        // Band colors matching noisefloor.js
        this.bandColors = {
            '2200m': '#8B4513', // Saddle Brown
            '630m': '#A0522D',  // Sienna
            '160m': '#4E79A7',  // Blue
            '80m': '#F28E2B',   // Orange
            '60m': '#E15759',   // Red
            '40m': '#76B7B2',   // Cyan
            '30m': '#59A14F',   // Green
            '20m': '#EDC948',   // Yellow
            '17m': '#B07AA1',   // Purple
            '15m': '#FF9DA7',   // Pink
            '12m': '#9C755F',   // Brown
            '10m': '#00D9FF',   // Bright Cyan/Turquoise
            'unknown': '#FF0000' // Red for unknown bands
        };

        this.init();
    }

    generateUserSessionID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    hashCallsign(callsign) {
        // Simple hash function that produces consistent pseudo-random values
        let hash = 0;
        for (let i = 0; i < callsign.length; i++) {
            hash = ((hash << 5) - hash) + callsign.charCodeAt(i);
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash);
    }

    getCallsignOffset(callsign) {
        // Generate consistent offset within grid square based on callsign hash
        const hash = this.hashCallsign(callsign);
        // Maidenhead grid squares are approximately 1° latitude × 2° longitude
        // Use smaller offsets to keep stations well within their grid square
        const latOffset = ((hash % 1000) / 1000 - 0.5) * 0.8; // ±0.4 degrees
        const lonOffset = (((hash / 1000) % 1000) / 1000 - 0.5) * 1.6; // ±0.8 degrees
        return { lat: latOffset, lon: lonOffset };
    }

    async init() {
        // Setup overlay close button
        this.setupOverlay();

        // Load saved preferences
        this.loadPreferences();

        // Initialize map
        this.initMap();

        // Load receiver location
        await this.loadReceiverLocation();

        // Register connection before connecting to websocket
        await this.registerConnection();

        // Connect to websocket
        this.connectWebSocket();

        // Start cleanup interval
        this.startCleanup();

        // Update greyline
        this.updateGreyline();
        setInterval(() => this.updateGreyline(), 60000);

        // Setup live messages panel
        this.setupLiveMessagesPanel();

        // Start time display updates
        this.updateTimeDisplay();
        setInterval(() => this.updateTimeDisplay(), 1000);

        // Start last spot time updates
        this.updateLastSpotTime();
        setInterval(() => this.updateLastSpotTime(), 1000);

        // Load and update space weather
        this.loadSpaceWeather();
        setInterval(() => {
            this.loadSpaceWeather();
        }, 300000); // Update every 5 minutes

        // Load band conditions with adaptive retry
        this.startBandConditionsUpdates();

        // Start memory monitoring
        this.startMemoryMonitoring();

        // Periodically re-apply filters to handle aging spots
        // This ensures markers are hidden as they age past the filter threshold
        setInterval(() => this.applyFilters(), 60000); // Every 60 seconds
    }

    loadPreferences() {
        // Load checkbox states
        const showStats = localStorage.getItem('cwskimmer_showStats');
        const showSummary = localStorage.getItem('cwskimmer_showSummary');
        const showWeather = localStorage.getItem('cwskimmer_showWeather');
        const showLegend = localStorage.getItem('cwskimmer_showLegend');

        // Load filter values
        const ageFilter = localStorage.getItem('cwskimmer_ageFilter');
        const bandFilter = localStorage.getItem('cwskimmer_bandFilter');
        const countryFilter = localStorage.getItem('cwskimmer_countryFilter');
        const continentFilter = localStorage.getItem('cwskimmer_continentFilter');
        const snrFilter = localStorage.getItem('cwskimmer_snrFilter');

        // Load live messages collapsed state
        const liveMessagesCollapsed = localStorage.getItem('cwskimmer_liveMessagesCollapsed');

        // Load map view state
        const mapLat = localStorage.getItem('cwskimmer_mapLat');
        const mapLon = localStorage.getItem('cwskimmer_mapLon');
        const mapZoom = localStorage.getItem('cwskimmer_mapZoom');

        // Apply checkbox states (default to true/checked if not set, except weather which defaults to false)
        if (showStats !== null) {
            const checkbox = document.getElementById('show-stats-checkbox');
            if (checkbox) checkbox.checked = showStats === 'true';
        }
        if (showSummary !== null) {
            const checkbox = document.getElementById('show-summary-checkbox');
            if (checkbox) checkbox.checked = showSummary === 'true';
        }
        if (showWeather !== null) {
            const checkbox = document.getElementById('show-weather-checkbox');
            if (checkbox) checkbox.checked = showWeather === 'true';
        }
        if (showLegend !== null) {
            const checkbox = document.getElementById('show-legend-checkbox');
            if (checkbox) checkbox.checked = showLegend === 'true';
        }

        // Apply filter values
        if (ageFilter) {
            this.ageFilter = ageFilter;
            const select = document.getElementById('age-filter');
            if (select) select.value = ageFilter;
        }
        if (bandFilter) {
            this.bandFilter = bandFilter;
            const select = document.getElementById('band-filter');
            if (select) select.value = bandFilter;
        }
        if (countryFilter) {
            this.countryFilter = countryFilter;
            const select = document.getElementById('country-filter');
            if (select) select.value = countryFilter;
        }
        if (continentFilter) {
            this.continentFilter = continentFilter;
            const select = document.getElementById('continent-filter');
            if (select) select.value = continentFilter;
        }
        if (snrFilter) {
            this.snrFilter = snrFilter;
            const select = document.getElementById('snr-filter');
            if (select) select.value = snrFilter;
        }

        // Apply live messages collapsed state
        if (liveMessagesCollapsed !== null) {
            const content = document.getElementById('live-messages-content');
            const toggle = document.getElementById('live-messages-toggle');
            const filterDiv = document.querySelector('.live-messages-filter');
            const paginationDiv = document.getElementById('live-messages-pagination');

            if (liveMessagesCollapsed === 'true') {
                if (content) content.classList.add('collapsed');
                if (toggle) toggle.classList.add('collapsed');
                if (filterDiv) filterDiv.style.display = 'none';
                if (paginationDiv) paginationDiv.style.display = 'none';
            }
        }

        // Store map view preferences for later use in initMap
        this.savedMapView = null;
        if (mapLat !== null && mapLon !== null && mapZoom !== null) {
            this.savedMapView = {
                lat: parseFloat(mapLat),
                lon: parseFloat(mapLon),
                zoom: parseInt(mapZoom)
            };
        }
    }

    savePreference(key, value) {
        localStorage.setItem('cwskimmer_' + key, value);
    }

    setupOverlay() {
        const overlay = document.getElementById('resolution-overlay');
        const closeBtn = document.getElementById('close-overlay-btn');

        if (closeBtn && overlay) {
            closeBtn.addEventListener('click', () => {
                overlay.style.display = 'none';
            });

            // Add hover effect to button
            closeBtn.addEventListener('mouseenter', () => {
                closeBtn.style.background = '#3a8edf';
                closeBtn.style.transform = 'scale(1.05)';
            });

            closeBtn.addEventListener('mouseleave', () => {
                closeBtn.style.background = '#4a9eff';
                closeBtn.style.transform = 'scale(1)';
            });
        }
    }

    startMemoryMonitoring() {
        // Log memory metrics every 60 seconds
        setInterval(() => {
            const metrics = {
                timestamp: new Date().toISOString(),
                spots_size: this.spots.size,
                markers_size: this.markers.size,
                liveMessages_length: this.liveMessages.length,
                seenContinentBands_size: this.seenContinentBands.size,
                seenCountryBands_size: this.seenCountryBands.size,
                spotTimestamps_length: this.spotTimestamps.length,
                map_layers: this.map ? this.map._layers : 'N/A',
                map_layers_count: this.map ? Object.keys(this.map._layers).length : 0
            };

            // Add browser memory info if available
            if (performance.memory) {
                metrics.memory_used_mb = (performance.memory.usedJSHeapSize / 1048576).toFixed(2);
                metrics.memory_total_mb = (performance.memory.totalJSHeapSize / 1048576).toFixed(2);
                metrics.memory_limit_mb = (performance.memory.jsHeapSizeLimit / 1048576).toFixed(2);
                metrics.memory_usage_percent = ((performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit) * 100).toFixed(2);
            }

            console.log('[CW Skimmer Memory Metrics]', metrics);
        }, 60000); // Every 60 seconds
    }

    startBandConditionsUpdates() {
        // Initial load
        this.loadBandConditions();

        // Clear any existing interval
        if (this.bandConditionsInterval) {
            clearInterval(this.bandConditionsInterval);
        }

        // Start with 60-second retry interval (will switch to 5 minutes once data is available)
        this.bandConditionsInterval = setInterval(() => {
            this.loadBandConditions();
        }, 60000); // Check every 60 seconds
    }

    switchBandConditionsToNormalInterval() {
        // Switch to 5-minute interval once data is available
        if (this.bandConditionsInterval) {
            clearInterval(this.bandConditionsInterval);
        }

        this.bandConditionsInterval = setInterval(() => {
            this.loadBandConditions();
        }, 300000); // Update every 5 minutes
    }

    async loadSpaceWeather() {
        try {
            const response = await fetch('/api/spaceweather');

            if (!response.ok) {
                console.error('Failed to load space weather data');
                return;
            }

            const data = await response.json();
            this.displaySpaceWeather(data);
        } catch (error) {
            console.error('Error loading space weather:', error);
        }
    }

    async loadBandConditions() {
        try {
            const response = await fetch('/api/noisefloor/latest');

            if (response.status === 204 || !response.ok) {
                console.log('No band conditions data available yet, retrying in 60 seconds...');
                this.bandConditionsAvailable = false;
                this.hideBandConditions();
                return;
            }

            const data = await response.json();

            // Check if we have any valid band data
            const hasValidData = Object.keys(data).some(band => {
                return data[band] && data[band].ft8_snr;
            });

            if (hasValidData) {
                // Data is now available, switch to normal 5-minute interval if not already
                if (!this.bandConditionsAvailable) {
                    console.log('Band conditions data now available, switching to 5-minute updates');
                    this.bandConditionsAvailable = true;
                    this.switchBandConditionsToNormalInterval();
                }
                this.displayBandConditions(data);
            } else {
                console.log('No valid FT8 SNR data in response, retrying in 60 seconds...');
                this.bandConditionsAvailable = false;
                this.hideBandConditions();
            }
        } catch (error) {
            console.error('Error loading band conditions:', error);
            this.bandConditionsAvailable = false;
            this.hideBandConditions();
        }
    }

    hideBandConditions() {
        const sectionDiv = document.getElementById('band-conditions-section');
        if (sectionDiv) {
            sectionDiv.style.display = 'none';
        }
    }

    displaySpaceWeather(data) {
        const contentDiv = document.getElementById('space-weather-content');
        if (!contentDiv) return;

        // Determine propagation quality color
        const qualityColor = data.propagation_quality === 'Excellent' ? '#22c55e' :
                            data.propagation_quality === 'Good' ? '#fbbf24' :
                            data.propagation_quality === 'Fair' ? '#ff9800' : '#ef4444';

        let html = '';

        // Add forecast at the top if available and not quiet conditions
        if (data.forecast && data.forecast.geomagnetic_storm &&
            data.forecast.summary !== "Quiet conditions expected for the next 24 hours.") {
            html += `<div class="sw-metric">
                        <span class="sw-metric-label">Forecast</span>
                        <span class="sw-metric-value">${data.forecast.geomagnetic_storm}</span>
                     </div>`;
        }

        // Solar Flux
        html += `<div class="sw-metric">
                    <span class="sw-metric-label">Solar Flux</span>
                    <span class="sw-metric-value">${data.solar_flux.toFixed(0)} SFU</span>
                 </div>`;

        // K-Index
        html += `<div class="sw-metric">
                    <span class="sw-metric-label">K-Index</span>
                    <span class="sw-metric-value">${data.k_index} (${data.k_index_status})</span>
                 </div>`;

        // A-Index
        html += `<div class="sw-metric">
                    <span class="sw-metric-label">A-Index</span>
                    <span class="sw-metric-value">${data.a_index}</span>
                 </div>`;

        // Solar Wind Bz
        const bzDirection = data.solar_wind_bz < 0 ? 'Southward' : 'Northward';
        html += `<div class="sw-metric">
                    <span class="sw-metric-label">Solar Wind Bz</span>
                    <span class="sw-metric-value">${data.solar_wind_bz.toFixed(1)} nT (${bzDirection})</span>
                 </div>`;

        // Propagation
        html += `<div class="sw-metric">
                    <span class="sw-metric-label">Propagation</span>
                    <span class="sw-metric-value" style="color: ${qualityColor};">${data.propagation_quality}</span>
                 </div>`;

        contentDiv.innerHTML = html;
    }

    displayBandConditions(data) {
        const sectionDiv = document.getElementById('band-conditions-section');
        const badgesDiv = document.getElementById('band-conditions-badges');
        if (!sectionDiv || !badgesDiv) return;

        // Sort bands in order
        const bandOrder = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];
        const bands = Object.keys(data).sort((a, b) => {
            return bandOrder.indexOf(a) - bandOrder.indexOf(b);
        });

        // Clear existing badges
        badgesDiv.innerHTML = '';

        let hasBandData = false;
        const badgesToDisplay = [];

        // Collect badges to display
        bands.forEach(band => {
            const bandData = data[band];
            if (!bandData || !bandData.ft8_snr) return;

            hasBandData = true;
            const snr = bandData.ft8_snr;

            // Determine state based on SNR
            let bgColor, stateText;
            if (snr < 6) {
                bgColor = '#ef4444';
                stateText = 'POOR';
            } else if (snr >= 6 && snr < 20) {
                bgColor = '#ff9800';
                stateText = 'FAIR';
            } else if (snr >= 20 && snr < 30) {
                bgColor = '#fbbf24';
                stateText = 'GOOD';
            } else {
                bgColor = '#22c55e';
                stateText = 'EXCELLENT';
            }

            badgesToDisplay.push({ band, bgColor, stateText, snr });
        });

        // Create rows with 5 badges each
        const badgesPerRow = 5;
        for (let i = 0; i < badgesToDisplay.length; i += badgesPerRow) {
            const rowDiv = document.createElement('div');
            rowDiv.style.cssText = `
                display: flex;
                gap: 4px;
                justify-content: center;
                margin-bottom: 4px;
            `;

            const rowBadges = badgesToDisplay.slice(i, i + badgesPerRow);
            rowBadges.forEach(({ band, bgColor, stateText, snr }) => {
                const badge = document.createElement('div');
                badge.style.cssText = `
                    display: inline-flex;
                    align-items: center;
                    padding: 3px 6px;
                    border-radius: 10px;
                    font-size: 0.7em;
                    font-weight: bold;
                    background: ${bgColor};
                    color: white;
                    cursor: help;
                `;
                badge.textContent = band;
                badge.title = `${band}: ${stateText} (${snr.toFixed(1)} dB SNR)`;
                rowDiv.appendChild(badge);
            });

            badgesDiv.appendChild(rowDiv);
        }

        // Show or hide section based on data availability
        sectionDiv.style.display = hasBandData ? 'block' : 'none';
    }

    initMap() {
        // Initialize Leaflet map with saved view or default world view
        // Zoom level 3 shows the world once without duplication
        let initialLat = 20;
        let initialLon = 0;
        let initialZoom = 3;

        if (this.savedMapView) {
            initialLat = this.savedMapView.lat;
            initialLon = this.savedMapView.lon;
            initialZoom = this.savedMapView.zoom;
        }

        this.map = L.map('map').setView([initialLat, initialLon], initialZoom);

        // Add OpenStreetMap tiles
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors',
            maxZoom: 18,
            minZoom: 2
        }).addTo(this.map);

        // Initialize marker cluster group with zoom-dependent clustering
        this.markerClusterGroup = L.markerClusterGroup({
            maxClusterRadius: (zoom) => {
                // Much less aggressive clustering - smaller radius values
                if (zoom >= 10) return 10;  // Very tight clustering when zoomed in
                if (zoom >= 7) return 20;   // Medium clustering
                if (zoom >= 5) return 25;   // Looser clustering at mid-zoom
                if (zoom >= 3) return 30;   // Even looser at world view
                return 35;                   // Minimal clustering when fully zoomed out
            },
            spiderfyOnMaxZoom: true,
            showCoverageOnHover: true,
            zoomToBoundsOnClick: true,
            disableClusteringAtZoom: 10, // Disable clustering earlier (zoom 10 instead of 12)
            iconCreateFunction: (cluster) => {
                const count = cluster.getChildCount();
                let size = 'small';
                if (count >= 100) size = 'large';
                else if (count >= 10) size = 'medium';
                
                return L.divIcon({
                    html: `<div><span>${count}</span></div>`,
                    className: `marker-cluster marker-cluster-${size}`,
                    iconSize: L.point(40, 40)
                });
            }
        });
        
        this.map.addLayer(this.markerClusterGroup);

        // Setup filters
        this.setupFilters();

        // Setup visibility toggles
        this.setupVisibilityToggles();

        // Initialize panel visibility based on checkbox states
        this.initializePanelVisibility();

        // Setup map view state saving
        this.setupMapViewSaving();
    }

    setupMapViewSaving() {
        // Save map view state when user moves or zooms the map
        this.map.on('moveend', () => {
            const center = this.map.getCenter();
            const zoom = this.map.getZoom();
            this.savePreference('mapLat', center.lat);
            this.savePreference('mapLon', center.lng);
            this.savePreference('mapZoom', zoom);
        });
    }

    initializePanelVisibility() {
        // Apply visibility based on checkbox states (which have been loaded from localStorage)
        const statsCheckbox = document.getElementById('show-stats-checkbox');
        const summaryCheckbox = document.getElementById('show-summary-checkbox');
        const weatherCheckbox = document.getElementById('show-weather-checkbox');
        const legendCheckbox = document.getElementById('show-legend-checkbox');

        if (statsCheckbox) {
            this.toggleStatsPanel(statsCheckbox.checked);
        }
        if (summaryCheckbox) {
            this.toggleSummaryPanel(summaryCheckbox.checked);
        }
        if (weatherCheckbox) {
            this.toggleWeatherPanels(weatherCheckbox.checked);
        }
        if (legendCheckbox) {
            this.toggleLegendPanels(legendCheckbox.checked);
        }
    }

    setupVisibilityToggles() {
        const statsCheckbox = document.getElementById('show-stats-checkbox');
        const summaryCheckbox = document.getElementById('show-summary-checkbox');
        const weatherCheckbox = document.getElementById('show-weather-checkbox');
        const legendCheckbox = document.getElementById('show-legend-checkbox');

        if (statsCheckbox) {
            statsCheckbox.addEventListener('change', (e) => {
                this.toggleStatsPanel(e.target.checked);
                this.savePreference('showStats', e.target.checked);
            });
        }

        if (summaryCheckbox) {
            summaryCheckbox.addEventListener('change', (e) => {
                this.toggleSummaryPanel(e.target.checked);
                this.savePreference('showSummary', e.target.checked);
            });
        }

        if (weatherCheckbox) {
            weatherCheckbox.addEventListener('change', (e) => {
                this.toggleWeatherPanels(e.target.checked);
                this.savePreference('showWeather', e.target.checked);
            });
        }

        if (legendCheckbox) {
            legendCheckbox.addEventListener('change', (e) => {
                this.toggleLegendPanels(e.target.checked);
                this.savePreference('showLegend', e.target.checked);
            });
        }
    }

    toggleStatsPanel(show) {
        const distanceLegend = document.querySelector('.distance-legend');

        if (distanceLegend) {
            distanceLegend.style.display = show ? 'block' : 'none';
        }
    }

    toggleSummaryPanel(show) {
        const newEntitiesLegend = document.querySelector('.new-entities-legend');

        if (newEntitiesLegend) {
            newEntitiesLegend.style.display = show ? 'flex' : 'none';
        }
    }

    toggleWeatherPanels(show) {
        const spaceWeatherLegend = document.querySelector('.space-weather-legend');

        if (spaceWeatherLegend) {
            spaceWeatherLegend.style.display = show ? 'block' : 'none';
        }
    }

    toggleLegendPanels(show) {
        const legend = document.querySelector('.legend');

        if (legend) {
            legend.style.display = show ? 'block' : 'none';
        }
    }

    setupFilters() {
        const ageFilter = document.getElementById('age-filter');
        if (ageFilter) {
            ageFilter.addEventListener('change', (e) => {
                this.ageFilter = e.target.value;
                this.savePreference('ageFilter', e.target.value);
                this.applyFilters();
            });
        }

        const bandFilter = document.getElementById('band-filter');
        if (bandFilter) {
            bandFilter.addEventListener('change', (e) => {
                this.bandFilter = e.target.value;
                this.savePreference('bandFilter', e.target.value);
                this.applyFilters();
            });
        }

        const countryFilter = document.getElementById('country-filter');
        if (countryFilter) {
            countryFilter.addEventListener('change', (e) => {
                this.countryFilter = e.target.value;
                this.savePreference('countryFilter', e.target.value);
                this.applyFilters();
            });
        }

        const continentFilter = document.getElementById('continent-filter');
        if (continentFilter) {
            continentFilter.addEventListener('change', (e) => {
                this.continentFilter = e.target.value;
                this.savePreference('continentFilter', e.target.value);
                this.applyFilters();
            });
        }

        const snrFilter = document.getElementById('snr-filter');
        if (snrFilter) {
            snrFilter.addEventListener('change', (e) => {
                this.snrFilter = e.target.value;
                this.savePreference('snrFilter', e.target.value);
                this.applyFilters();
            });
        }
    }

    applyFilters() {
        // Clear cluster group and re-add filtered markers
        this.markerClusterGroup.clearLayers();
        
        const now = Date.now();
        this.markers.forEach((marker, key) => {
            const spot = this.spots.get(key);
            if (!spot) return;

            const bandMatch = this.bandFilter === 'all' || spot.band === this.bandFilter;
            const countryMatch = this.countryFilter === 'all' || spot.country === this.countryFilter;
            const continentMatch = this.continentFilter === 'all' || spot.Continent === this.continentFilter;
            const snrMatch = this.snrFilter === 'none' || spot.snr >= parseFloat(this.snrFilter);
            
            // Age filter check
            let ageMatch = true;
            if (this.ageFilter !== 'none') {
                const maxAgeMs = parseFloat(this.ageFilter) * 60 * 1000; // Convert minutes to milliseconds
                const spotTime = new Date(spot.timestamp).getTime();
                const age = now - spotTime;
                ageMatch = age <= maxAgeMs;
            }

            if (ageMatch && bandMatch && countryMatch && continentMatch && snrMatch) {
                this.markerClusterGroup.addLayer(marker);
            }
        });
        
        this.updateSpotCount();
        this.updateDistanceStatistics();
        this.updateLiveMessagesDisplay(); // Update live messages when filters change
        this.updateRarestEntities(); // Update rarest entities when filters change
        this.updateSpaceWeatherPosition(); // Update space weather panel position
    }

    async loadReceiverLocation() {
        try {
            const response = await fetch('/api/description');
            if (!response.ok) {
                console.warn('Failed to load receiver location');
                return;
            }

            const data = await response.json();
            if (data.receiver && data.receiver.gps) {
                this.receiverLocation = {
                    lat: data.receiver.gps.lat,
                    lon: data.receiver.gps.lon
                };

                // Store receiver info for tooltip
                this.receiverInfo = {
                    name: data.receiver.name || null,
                    location: data.receiver.location || null,
                    callsign: data.receiver.callsign || null
                };

                // Add receiver marker
                this.addReceiverMarker();

                // Keep world view - don't zoom in on receiver
                // this.map.setView([this.receiverLocation.lat, this.receiverLocation.lon], 5);
            }
        } catch (error) {
            console.error('Error loading receiver location:', error);
        }
    }

    addReceiverMarker() {
        if (!this.receiverLocation) return;

        // Create custom icon for receiver
        const receiverIcon = L.divIcon({
            className: '', // Empty className to avoid default Leaflet styling
            html: '<div style="width: 20px; height: 20px; background: #ff0000; border: 3px solid rgba(255, 255, 255, 0.9); border-radius: 50%; box-shadow: 0 0 10px rgba(255, 0, 0, 0.5);"></div>',
            iconSize: [20, 20],
            iconAnchor: [10, 10]
        });

        this.receiverMarker = L.marker(
            [this.receiverLocation.lat, this.receiverLocation.lon],
            { icon: receiverIcon }
        ).addTo(this.map);

        // Build popup content with receiver info
        let popupContent = '<div style="font-family: monospace; font-size: 12px;"><b>Receiver Location</b><br>';
        
        if (this.receiverInfo) {
            if (this.receiverInfo.name) {
                popupContent += `<b>Name:</b> ${this.receiverInfo.name}<br>`;
            }
            if (this.receiverInfo.location) {
                popupContent += `<b>Location:</b> ${this.receiverInfo.location}<br>`;
            }
            if (this.receiverInfo.callsign) {
                popupContent += `<b>Callsign:</b> ${this.receiverInfo.callsign}<br>`;
            }
        }
        
        popupContent += `<b>Coordinates:</b> ${this.receiverLocation.lat.toFixed(4)}, ${this.receiverLocation.lon.toFixed(4)}</div>`;
        
        this.receiverMarker.bindPopup(popupContent);
        this.receiverMarker.bindTooltip(popupContent, {
            direction: 'top',
            offset: [0, -15],
            permanent: false
        });
    }

    async registerConnection() {
        try {
            const body = {
                user_session_id: this.userSessionID
            };

            // Add bypass password if available
            if (window.bypassPassword) {
                body.password = window.bypassPassword;
            }

            const response = await fetch('/connection', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                if (response.status === 429) {
                    console.error('[CW Skimmer Map] Rate limited. Please try again later.');
                    this.updateStatus('disconnected', 'Rate Limited');
                    return;
                }
                console.error('[CW Skimmer Map] Failed to register connection:', response.status);
            } else {
                console.log('[CW Skimmer Map] Connection registered successfully');
            }
        } catch (error) {
            console.error('[CW Skimmer Map] Error registering connection:', error);
        }
    }

    connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        let wsUrl = `${protocol}//${window.location.host}/ws/dxcluster?user_session_id=${encodeURIComponent(this.userSessionID)}`;

        // Add bypass password if available
        if (window.bypassPassword) {
            wsUrl += `&password=${encodeURIComponent(window.bypassPassword)}`;
        }

        console.log('[CW Skimmer Map] Connecting to:', wsUrl);

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            console.log('WebSocket connected');

            // Subscribe to CW spots on server
            this.ws.send(JSON.stringify({ type: 'subscribe_cw_spots' }));
            console.log('Subscribed to CW spots');
            this.updateStatus('connected', 'Connected');
            // Reset reconnection attempts on successful connection
            this.reconnectAttempts = 0;
        };

        this.ws.onclose = () => {
            console.log('WebSocket disconnected');
            this.updateStatus('disconnected', 'Disconnected');
            // Attempt to reconnect with exponential backoff
            this.scheduleReconnect();
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            this.updateStatus('disconnected', 'Error');
        };

        this.ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                this.handleMessage(message);
            } catch (error) {
                console.error('Error parsing message:', error);
            }
        };
    }

    scheduleReconnect() {
        // Clear any existing reconnect timeout
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }

        // Calculate delay with exponential backoff: 2^attempts seconds, max 60 seconds
        const baseDelay = 1000; // 1 second
        const maxDelay = 60000; // 60 seconds (1 minute)
        const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts), maxDelay);

        console.log(`Reconnecting in ${delay / 1000} seconds (attempt ${this.reconnectAttempts + 1})...`);

        this.reconnectTimeout = setTimeout(() => {
            this.reconnectAttempts++;
            this.connectWebSocket();
        }, delay);
    }

    handleMessage(message) {
        if (message.type === 'cw_spot') {
            // Ensure we're marked as connected when receiving data
            this.updateStatus('connected', 'Connected');
            this.handleCWSpot(message.data);
        } else if (message.type === 'status') {
            // Handle connection status updates
            if (message.connected) {
                this.updateStatus('connected', 'Connected');
            } else {
                this.updateStatus('disconnected', 'Disconnected');
            }
        }
    }

    handleCWSpot(spot) {
        // CW spots use different field names than digital spots
        // Map CW spot fields to expected format
        const mappedSpot = {
            callsign: spot.dx_call,
            frequency: spot.frequency,
            band: spot.band,
            snr: spot.snr,
            timestamp: spot.time,
            country: spot.country,
            Continent: spot.continent,
            CQZone: spot.cq_zone,
            ITUZone: spot.itu_zone,
            // Server already converted CTY coords to standard format (+ for East, - for West)
            latitude: spot.latitude,
            longitude: spot.longitude,
            distance_km: spot.distance_km,
            bearing_deg: spot.bearing_deg,
            wpm: spot.wpm,
            comment: spot.comment
        };

        // Only process spots with valid coordinates
        if (!mappedSpot.latitude || !mappedSpot.longitude) {
            console.warn('[CW Skimmer Map] Skipping spot without coordinates:', mappedSpot.callsign);
            return;
        }

        // Create unique key for spot (CW spots don't have mode)
        const key = `${mappedSpot.callsign}-${mappedSpot.band}`;

        // Use the mapped spot
        spot = mappedSpot;

        // Track spot for rate calculation
        const now = Date.now();
        this.spotTimestamps.push(now);
        this.lastSpotTime = now;

        // Remove timestamps older than 1 minute
        const oneMinuteAgo = now - 60000;
        this.spotTimestamps = this.spotTimestamps.filter(ts => ts > oneMinuteAgo);

        // Update spots per minute display
        this.updateSpotsPerMinute();

        // Store spot
        this.spots.set(key, spot);

        // Check for new continent or country
        this.checkNewEntities(spot);

        // Add or update marker
        this.addOrUpdateMarker(key, spot);

        // Add to live messages
        this.addLiveMessage(spot);

        // Update spot count and distance statistics
        this.updateSpotCount();
        this.updateDistanceStatistics();
        
        // Update band legend
        this.updateBandLegend();
        
        // Update filter dropdowns
        this.updateFilterDropdowns();

        // Update rarest entities
        this.updateRarestEntities();

        // Limit number of spots
        if (this.spots.size > this.maxSpots) {
            this.removeOldestSpot();
        }
    }

    addOrUpdateMarker(key, spot) {
        // Remove existing marker if present
        if (this.markers.has(key)) {
            this.markerClusterGroup.removeLayer(this.markers.get(key));
        }

        // Get color for band
        const color = this.bandColors[spot.band] || '#999';

        // Log unknown or unrecognized bands
        if (spot.band === 'unknown' || !this.bandColors[spot.band]) {
            console.warn('[Unknown/Unrecognized Band]', {
                band: spot.band,
                callsign: spot.callsign,
                frequency: spot.frequency,
                frequencyMHz: spot.frequency ? (spot.frequency / 1e6).toFixed(3) : 'N/A',
                mode: spot.mode,
                locator: spot.locator,
                timestamp: spot.timestamp
            });
        }

        // Create custom icon
        const icon = L.divIcon({
            className: 'custom-marker',
            html: `<div style="width: 12px; height: 12px; background: ${color}; border-radius: 50%;"></div>`,
            iconSize: [12, 12],
            iconAnchor: [6, 6]
        });

        // Get current zoom level for dynamic offset
        const zoom = this.map.getZoom();
        
        // Apply consistent offset based on callsign hash
        const offset = this.getCallsignOffset(spot.callsign);
        let latOffset = offset.lat;
        let lonOffset = offset.lon;
        
        // Increase spread when zoomed in (zoom 7+)
        if (zoom >= 7 && zoom < 12) {
            const spreadFactor = (zoom - 6) * 0.5; // Gradually increase spread
            latOffset *= spreadFactor;
            lonOffset *= spreadFactor;
        } else if (zoom >= 12) {
            // Maximum spread when very zoomed in
            latOffset *= 3;
            lonOffset *= 3;
        }
        
        const adjustedLat = spot.latitude + latOffset;
        const adjustedLon = spot.longitude + lonOffset;

        // Create marker with adjusted position
        const marker = L.marker([adjustedLat, adjustedLon], { icon });

        // Create popup content
        const popupContent = this.createPopupContent(spot);
        marker.bindPopup(popupContent);
        marker.bindTooltip(popupContent, {
            direction: 'top',
            offset: [0, -10]
        });

        // Add to map only if it passes all filters
        const bandMatch = this.bandFilter === 'all' || spot.band === this.bandFilter;
        const countryMatch = this.countryFilter === 'all' || spot.country === this.countryFilter;
        const continentMatch = this.continentFilter === 'all' || spot.Continent === this.continentFilter;
        const snrMatch = this.snrFilter === 'none' || spot.snr >= parseFloat(this.snrFilter);
        
        // Age filter check
        let ageMatch = true;
        if (this.ageFilter !== 'none') {
            const maxAgeMs = parseFloat(this.ageFilter) * 60 * 1000;
            const spotTime = new Date(spot.timestamp).getTime();
            const age = Date.now() - spotTime;
            ageMatch = age <= maxAgeMs;
        }
        
        if (ageMatch && bandMatch && countryMatch && continentMatch && snrMatch) {
            this.markerClusterGroup.addLayer(marker);
        }

        // Store marker
        this.markers.set(key, marker);
    }

    createPopupContent(spot) {
        const time = new Date(spot.timestamp).toLocaleTimeString('en-US', { 
            hour12: false, 
            timeZone: 'UTC' 
        });

        let content = `
            <div style="font-family: monospace; font-size: 12px;">
                <b>${spot.callsign}</b><br>
        `;

        if (spot.country) {
            content += `<b>Country:</b> ${spot.country}<br>`;
        }

        content += `
                <b>Band:</b> ${spot.band}<br>
                <b>Frequency:</b> ${(spot.frequency / 1e6).toFixed(3)} MHz<br>
                <b>SNR:</b> ${spot.snr >= 0 ? '+' : ''}${spot.snr} dB<br>
                <b>WPM:</b> ${spot.wpm || 'N/A'}<br>
                <b>Time:</b> ${time} UTC<br>
        `;

        if (spot.distance_km !== undefined && spot.distance_km !== null) {
            content += `<b>Distance:</b> ${Math.round(spot.distance_km)} km<br>`;
        }

        if (spot.bearing_deg !== undefined && spot.bearing_deg !== null) {
            content += `<b>Bearing:</b> ${Math.round(spot.bearing_deg)}°<br>`;
        }

        if (spot.message) {
            content += `<b>Message:</b> ${spot.message}<br>`;
        }

        content += `</div>`;

        return content;
    }

    removeOldestSpot() {
        let oldestKey = null;
        let oldestTime = Date.now();

        for (const [key, spot] of this.spots.entries()) {
            const spotTime = new Date(spot.timestamp).getTime();
            if (spotTime < oldestTime) {
                oldestTime = spotTime;
                oldestKey = key;
            }
        }

        if (oldestKey) {
            this.removeSpot(oldestKey);
        }
    }

    removeSpot(key) {
        // Remove marker from cluster group
        if (this.markers.has(key)) {
            this.markerClusterGroup.removeLayer(this.markers.get(key));
            this.markers.delete(key);
        }

        // Remove spot from storage
        this.spots.delete(key);
    }

    startCleanup() {
        // Clean up old spots every minute
        setInterval(() => {
            const now = Date.now();
            const keysToRemove = [];

            for (const [key, spot] of this.spots.entries()) {
                const spotTime = new Date(spot.timestamp).getTime();
                const age = now - spotTime;

                // Remove spots older than maxAge (24 hours) only
                // Age filter should only affect visibility, not storage
                if (age > this.maxAge) {
                    keysToRemove.push(key);
                }
            }

            keysToRemove.forEach(key => this.removeSpot(key));

            if (keysToRemove.length > 0) {
                this.updateSpotCount();
                this.updateDistanceStatistics();
                this.updateLiveMessagesDisplay();
                this.updateRarestEntities();
            }
        }, 60000); // Every minute
    }

    updateStatus(status, text) {
        // Only update DOM if status has actually changed
        if (this.currentStatus === status) {
            return;
        }

        this.currentStatus = status;
        const badge = document.getElementById('status-badge');
        if (badge) {
            badge.textContent = text;
            badge.className = `status-badge status-${status}`;
        }
    }

    updateSpotCount() {
        const countEl = document.getElementById('spot-count');
        if (countEl) {
            // Count only visible spots based on all filters
            let visibleCount = 0;
            const now = Date.now();
            this.spots.forEach(spot => {
                const bandMatch = this.bandFilter === 'all' || spot.band === this.bandFilter;
                const countryMatch = this.countryFilter === 'all' || spot.country === this.countryFilter;
                const continentMatch = this.continentFilter === 'all' || spot.Continent === this.continentFilter;
                const snrMatch = this.snrFilter === 'none' || spot.snr >= parseFloat(this.snrFilter);
                
                // Age filter check
                let ageMatch = true;
                if (this.ageFilter !== 'none') {
                    const maxAgeMs = parseFloat(this.ageFilter) * 60 * 1000;
                    const spotTime = new Date(spot.timestamp).getTime();
                    const age = now - spotTime;
                    ageMatch = age <= maxAgeMs;
                }
                
                if (ageMatch && bandMatch && countryMatch && continentMatch && snrMatch) {
                    visibleCount++;
                }
            });
            
            const allFiltersDefault = this.ageFilter === 'none' && this.bandFilter === 'all' && this.countryFilter === 'all' &&
                                     this.continentFilter === 'all' && this.snrFilter === 'none';
            
            if (allFiltersDefault) {
                countEl.textContent = `${this.spots.size} spot${this.spots.size !== 1 ? 's' : ''}`;
            } else {
                countEl.textContent = `${visibleCount} / ${this.spots.size} spot${this.spots.size !== 1 ? 's' : ''}`;
            }
        }
    }

    updateFilterDropdowns() {
        // Collect unique countries and continents from all spots
        const countries = new Set();
        const continents = new Set();
        
        this.spots.forEach(spot => {
            if (spot.country && spot.country !== 'Unknown' && spot.country !== '') {
                countries.add(spot.country);
            }
            if (spot.Continent && spot.Continent !== '') {
                continents.add(spot.Continent);
            }
        });
        
        // Update country filter
        const countryFilter = document.getElementById('country-filter');
        if (countryFilter) {
            const currentValue = countryFilter.value;
            const sortedCountries = Array.from(countries).sort();
            
            // Rebuild options
            countryFilter.innerHTML = '<option value="all">All</option>';
            sortedCountries.forEach(country => {
                const option = document.createElement('option');
                option.value = country;
                option.textContent = country;
                countryFilter.appendChild(option);
            });
            
            // Restore selection if it still exists
            if (currentValue !== 'all' && countries.has(currentValue)) {
                countryFilter.value = currentValue;
            } else if (currentValue !== 'all') {
                // Selected country no longer exists, reset to 'all'
                countryFilter.value = 'all';
                this.countryFilter = 'all';
                this.applyFilters();
            }
        }
        
        // Update continent filter
        const continentFilter = document.getElementById('continent-filter');
        if (continentFilter) {
            const currentValue = continentFilter.value;
            const sortedContinents = Array.from(continents).sort();
            
            // Rebuild options
            continentFilter.innerHTML = '<option value="all">All</option>';
            sortedContinents.forEach(continent => {
                const option = document.createElement('option');
                option.value = continent;
                // Use full continent name if available, otherwise use code
                option.textContent = this.continentNames[continent] || continent;
                continentFilter.appendChild(option);
            });
            
            // Restore selection if it still exists
            if (currentValue !== 'all' && continents.has(currentValue)) {
                continentFilter.value = currentValue;
            } else if (currentValue !== 'all') {
                // Selected continent no longer exists, reset to 'all'
                continentFilter.value = 'all';
                this.continentFilter = 'all';
                this.applyFilters();
            }
        }
    }

    updateTopCountries(spots, containerEl) {
        if (!containerEl) return;
        
        // Count spots by country, CQ zone, and continent
        const countryCounts = {};
        const cqZones = new Set();
        const continents = new Set();
        
        spots.forEach(spot => {
            if (spot.country && spot.country !== 'Unknown') {
                countryCounts[spot.country] = (countryCounts[spot.country] || 0) + 1;
            }
            if (spot.CQZone && spot.CQZone > 0) {
                cqZones.add(spot.CQZone);
            }
            if (spot.Continent && spot.Continent !== '') {
                continents.add(spot.Continent);
            }
        });
        
        // Convert to array and sort by count
        const sortedCountries = Object.entries(countryCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);
        
        if (sortedCountries.length === 0) {
            containerEl.innerHTML = '<div style="font-size: 11px; color: #aaa;">No data</div>';
            return;
        }
        
        // Build HTML for top 10 countries
        let html = '';
        sortedCountries.forEach(([country, count], index) => {
            html += `
                <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 3px; color: #ccc;">
                    <span>${index + 1}. ${country}</span>
                    <span style="color: #4a9eff;">${count}</span>
                </div>
            `;
        });
        
        // Add separator line
        html += '<div style="margin: 8px 0; border-top: 1px solid #333;"></div>';
        
        // Add totals
        const totalCountries = Object.keys(countryCounts).length;
        const totalCQZones = cqZones.size;
        const totalContinents = continents.size;
        
        html += `
            <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 3px; color: #ccc;">
                <span>Countries:</span>
                <span style="color: #4a9eff;">${totalCountries}</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 3px; color: #ccc;">
                <span>CQ Zones:</span>
                <span style="color: #4a9eff;">${totalCQZones}</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 3px; color: #ccc;">
                <span>Continents:</span>
                <span style="color: #4a9eff;">${totalContinents}</span>
            </div>
        `;
        
        containerEl.innerHTML = html;
    }

    updateTopBands(spots, containerEl) {
        if (!containerEl) return;
        
        // Define all bands in order (2200m through 10m)
        const allBands = ['2200m', '630m', '160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];
        
        // Count spots by band
        const bandCounts = {};
        allBands.forEach(band => {
            bandCounts[band] = 0;
        });
        
        spots.forEach(spot => {
            if (spot.band && allBands.includes(spot.band)) {
                bandCounts[spot.band]++;
            }
        });
        
        // Check if we have any data
        const hasData = Object.values(bandCounts).some(count => count > 0);
        if (!hasData) {
            containerEl.innerHTML = '<div style="font-size: 11px; color: #aaa;">No data</div>';
            return;
        }
        
        // Sort bands by count (highest to lowest), then by band order for ties
        const sortedBands = allBands.sort((a, b) => {
            const countDiff = bandCounts[b] - bandCounts[a];
            if (countDiff !== 0) return countDiff;
            // If counts are equal, maintain original band order
            return allBands.indexOf(a) - allBands.indexOf(b);
        });

        // Build HTML showing bands sorted by count
        let html = '';
        sortedBands.forEach(band => {
            const count = bandCounts[band];
            const color = count > 0 ? '#ccc' : '#555';
            html += `
                <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 3px; color: ${color};">
                    <span>${band}</span>
                    <span style="color: ${count > 0 ? '#4a9eff' : '#555'};">${count}</span>
                </div>
            `;
        });

        containerEl.innerHTML = html;
    }


    updateBearingStatistics(spots, containerEl) {
        if (!containerEl) return;

        // Count spots by cardinal direction
        const directions = {
            'N': 0,    // 337.5 - 22.5
            'NE': 0,   // 22.5 - 67.5
            'E': 0,    // 67.5 - 112.5
            'SE': 0,   // 112.5 - 157.5
            'S': 0,    // 157.5 - 202.5
            'SW': 0,   // 202.5 - 247.5
            'W': 0,    // 247.5 - 292.5
            'NW': 0    // 292.5 - 337.5
        };

        let totalWithBearing = 0;

        spots.forEach(spot => {
            if (spot.bearing_deg !== undefined && spot.bearing_deg !== null) {
                totalWithBearing++;
                const bearing = spot.bearing_deg;

                // Determine cardinal direction
                if (bearing >= 337.5 || bearing < 22.5) {
                    directions['N']++;
                } else if (bearing >= 22.5 && bearing < 67.5) {
                    directions['NE']++;
                } else if (bearing >= 67.5 && bearing < 112.5) {
                    directions['E']++;
                } else if (bearing >= 112.5 && bearing < 157.5) {
                    directions['SE']++;
                } else if (bearing >= 157.5 && bearing < 202.5) {
                    directions['S']++;
                } else if (bearing >= 202.5 && bearing < 247.5) {
                    directions['SW']++;
                } else if (bearing >= 247.5 && bearing < 292.5) {
                    directions['W']++;
                } else if (bearing >= 292.5 && bearing < 337.5) {
                    directions['NW']++;
                }
            }
        });

        if (totalWithBearing === 0) {
            containerEl.innerHTML = '<div style="font-size: 11px; color: #aaa;">No bearing data</div>';
            return;
        }

        // Build HTML with 4-column grid layout (2 rows)
        let html = '<div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px;">';
        const directionOrder = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

        directionOrder.forEach(dir => {
            const count = directions[dir];
            const percentage = (count / totalWithBearing) * 100;
            const color = count > 0 ? '#ccc' : '#555';

            html += `
                <div style="font-size: 10px; color: ${color};">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;">
                        <span style="font-weight: 500;">${dir}</span>
                        <span style="color: ${count > 0 ? '#4a9eff' : '#555'}; font-size: 9px;">${count}</span>
                    </div>
                    <div style="height: 6px; background: rgba(255, 255, 255, 0.1); border-radius: 2px; overflow: hidden;">
                        <div style="height: 100%; background: linear-gradient(90deg, #4a9eff, #2d7dd2); width: ${percentage}%;"></div>
                    </div>
                    <div style="font-size: 8px; color: #888; text-align: center; margin-top: 1px;">${percentage.toFixed(0)}%</div>
                </div>
            `;
        });

        html += '</div>';
        containerEl.innerHTML = html;
    }

    updateDistanceStatistics() {
        const rangesEl = document.getElementById('distance-ranges');
        const bearingStatsEl = document.getElementById('bearing-stats');
        const closestEl = document.getElementById('closest-spot');
        const farthestEl = document.getElementById('farthest-spot');
        const topCountriesEl = document.getElementById('top-countries');
        const topBandsEl = document.getElementById('top-bands');

        if (!rangesEl || !bearingStatsEl || !closestEl || !farthestEl || !topCountriesEl || !topBandsEl) {
            return;
        }
        
        // Collect all spots that pass filters
        const filteredSpots = [];
        const spotsWithDistance = [];
        const now = Date.now();
        
        this.spots.forEach(spot => {
            // Apply band filter
            if (this.bandFilter !== 'all' && spot.band !== this.bandFilter) {
                return;
            }
            // Apply country filter
            if (this.countryFilter !== 'all' && spot.country !== this.countryFilter) {
                return;
            }
            // Apply continent filter
            if (this.continentFilter !== 'all' && spot.Continent !== this.continentFilter) {
                return;
            }
            // Apply SNR filter
            if (this.snrFilter !== 'none' && spot.snr < parseFloat(this.snrFilter)) {
                return;
            }
            // Apply age filter
            if (this.ageFilter !== 'none') {
                const maxAgeMs = parseFloat(this.ageFilter) * 60 * 1000;
                const spotTime = new Date(spot.timestamp).getTime();
                const age = now - spotTime;
                if (age > maxAgeMs) {
                    return;
                }
            }
            
            filteredSpots.push(spot);

            if (spot.distance_km !== undefined && spot.distance_km !== null && spot.distance_km > 0) {
                // Only include spots with valid country names for distance statistics
                if (spot.country && spot.country !== 'Unknown' && spot.country !== '') {
                    spotsWithDistance.push(spot);
                }
            }
        });
        
        // Update top countries and bands
        this.updateTopCountries(filteredSpots, topCountriesEl);
        this.updateTopBands(filteredSpots, topBandsEl);

        // Update bearing statistics
        this.updateBearingStatistics(spotsWithDistance, bearingStatsEl);

        if (spotsWithDistance.length === 0) {
            rangesEl.innerHTML = '<div style="font-size: 11px; color: #aaa;">No distance data</div>';
            closestEl.textContent = '-';
            farthestEl.textContent = '-';
            return;
        }
        
        // Find min and max distances
        const distances = spotsWithDistance.map(s => s.distance_km);
        const minDist = Math.min(...distances);
        const maxDist = Math.max(...distances);
        
        // Create 4 distance ranges
        const rangeSize = (maxDist - minDist) / 4;
        const ranges = [];
        for (let i = 0; i < 4; i++) {
            const rangeMin = minDist + (i * rangeSize);
            const rangeMax = i === 3 ? maxDist : minDist + ((i + 1) * rangeSize);
            ranges.push({
                min: rangeMin,
                max: rangeMax,
                count: 0
            });
        }
        
        // Count spots in each range
        spotsWithDistance.forEach(spot => {
            for (let i = 0; i < ranges.length; i++) {
                if (spot.distance_km >= ranges[i].min && spot.distance_km <= ranges[i].max) {
                    ranges[i].count++;
                    break;
                }
            }
        });
        
        // Find closest and farthest spots
        const closestSpot = spotsWithDistance.reduce((min, spot) =>
            spot.distance_km < min.distance_km ? spot : min
        );
        const farthestSpot = spotsWithDistance.reduce((max, spot) =>
            spot.distance_km > max.distance_km ? spot : max
        );
        
        // Build HTML for ranges
        let html = '';
        ranges.forEach((range, i) => {
            const percentage = (range.count / spotsWithDistance.length) * 100;
            const label = `${Math.round(range.min)}-${Math.round(range.max)} km`;
            html += `
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; margin-bottom: 3px; color: #ccc;">
                    <span style="min-width: 80px;">${label}</span>
                    <div style="flex: 1; height: 6px; background: rgba(255, 255, 255, 0.1); border-radius: 2px; margin: 0 8px; overflow: hidden;">
                        <div style="height: 100%; background: linear-gradient(90deg, #4a9eff, #2d7dd2); width: ${percentage}%; transition: width 0.3s ease;"></div>
                    </div>
                    <span style="min-width: 60px; text-align: right; color: #4a9eff;">${range.count} (${percentage.toFixed(0)}%)</span>
                </div>
            `;
        });
        
        rangesEl.innerHTML = html;
        // Format closest spot with details on separate lines
        let closestHtml = `${Math.round(closestSpot.distance_km)} km - ${closestSpot.callsign}`;
        if (closestSpot.locator) {
            closestHtml += ` (${closestSpot.locator})`;
        }
        const closestDetails = [];
        if (closestSpot.country && closestSpot.country !== 'Unknown') {
            closestDetails.push(closestSpot.country);
        }
        if (closestSpot.mode) {
            closestDetails.push(closestSpot.mode);
        }
        if (closestSpot.band) {
            closestDetails.push(closestSpot.band);
        }
        if (closestSpot.snr !== undefined) {
            closestDetails.push(`${closestSpot.snr >= 0 ? '+' : ''}${closestSpot.snr}dB`);
        }
        if (closestDetails.length > 0) {
            closestHtml += `<br><span style="font-size: 10px; color: #888;">${closestDetails.join(' • ')}</span>`;
        }
        closestEl.innerHTML = closestHtml;

        // Format farthest spot with details on separate lines
        let farthestHtml = `${Math.round(farthestSpot.distance_km)} km - ${farthestSpot.callsign}`;
        if (farthestSpot.locator) {
            farthestHtml += ` (${farthestSpot.locator})`;
        }
        const farthestDetails = [];
        if (farthestSpot.country && farthestSpot.country !== 'Unknown') {
            farthestDetails.push(farthestSpot.country);
        }
        if (farthestSpot.mode) {
            farthestDetails.push(farthestSpot.mode);
        }
        if (farthestSpot.band) {
            farthestDetails.push(farthestSpot.band);
        }
        if (farthestSpot.snr !== undefined) {
            farthestDetails.push(`${farthestSpot.snr >= 0 ? '+' : ''}${farthestSpot.snr}dB`);
        }
        if (farthestDetails.length > 0) {
            farthestHtml += `<br><span style="font-size: 10px; color: #888;">${farthestDetails.join(' • ')}</span>`;
        }
        farthestEl.innerHTML = farthestHtml;

        // Update space weather panel position after distance legend changes
        this.updateSpaceWeatherPosition();
    }

    updateSpaceWeatherPosition() {
        const distanceLegend = document.querySelector('.distance-legend');
        const spaceWeatherLegend = document.querySelector('.space-weather-legend');

        if (distanceLegend && spaceWeatherLegend) {
            // Get the actual height of the distance legend
            const distanceHeight = distanceLegend.offsetHeight;
            // Add some spacing (15px) between the panels
            const newBottom = distanceHeight + 15;
            spaceWeatherLegend.style.bottom = `${newBottom}px`;
        }
    }

    updateGreyline() {
        // Remove existing greyline layer if present
        if (this.greylineLayer) {
            this.map.removeLayer(this.greylineLayer);
        }

        const now = new Date();
        this.greylineLayer = L.layerGroup();

        // Create night overlay using SunCalc library
        const nightPolygon = this.createNightPolygon(now);

        if (nightPolygon.length > 0) {
            L.polygon(nightPolygon, {
                color: 'transparent',
                fillColor: '#000033',
                fillOpacity: 0.3,
                interactive: false
            }).addTo(this.greylineLayer);
        }

        this.greylineLayer.addTo(this.map);
    }

    createNightPolygon(date) {
        // Create polygon for night side using SunCalc
        const polygon = [];
        const resolution = 2; // degrees for smoother curve
        
        // Get sun position to find subsolar point (where sun is directly overhead)
        // We need to find where the sun's declination and hour angle place it
        const d = (date.valueOf() / 86400000) - 0.5 + 2440588 - 2451545; // Days since J2000
        const M = (357.5291 + 0.98560028 * d) * Math.PI / 180; // Solar mean anomaly
        const C = (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) * Math.PI / 180;
        const L = M + C + (102.9372 * Math.PI / 180) + Math.PI; // Ecliptic longitude
        const sunDec = Math.asin(Math.sin(L) * Math.sin(23.4397 * Math.PI / 180)); // Declination in radians
        
        // Calculate subsolar longitude (where sun is at zenith)
        const gmst = (280.16 + 360.9856235 * d) * Math.PI / 180; // Greenwich mean sidereal time
        const sunRA = Math.atan2(Math.sin(L) * Math.cos(23.4397 * Math.PI / 180), Math.cos(L)); // Right ascension
        const sunLon = ((sunRA - gmst) * 180 / Math.PI + 180) % 360 - 180; // Subsolar longitude
        
        // Calculate terminator line (where sun altitude = 0)
        const terminatorPoints = [];
        for (let lon = -180; lon <= 180; lon += resolution) {
            // At the terminator, the sun is at the horizon
            // The latitude of the terminator at a given longitude can be calculated from:
            // cos(zenith_angle) = sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(hour_angle)
            // At terminator, zenith_angle = 90°, so cos(90°) = 0
            // Therefore: 0 = sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(hour_angle)
            // Solving for lat: tan(lat) = -cos(hour_angle) / tan(dec)
            
            const hourAngle = (lon - sunLon) * Math.PI / 180;
            const tanLat = -Math.cos(hourAngle) / Math.tan(sunDec);
            const lat = Math.atan(tanLat) * 180 / Math.PI;
            
            // Handle edge cases where tan(dec) approaches 0 (equinoxes)
            if (!isNaN(lat) && isFinite(lat)) {
                terminatorPoints.push([lat, lon]);
            }
        }
        
        if (terminatorPoints.length === 0) {
            return polygon; // Return empty if calculation failed
        }
        
        // Determine which pole is in darkness
        // If sun declination is positive (northern summer), south pole is dark
        const darkPole = sunDec > 0 ? -90 : 90;
        
        // Build the night polygon
        // Start with the terminator line
        terminatorPoints.forEach(point => {
            polygon.push(point);
        });
        
        // Close the polygon by going to the dark pole
        polygon.push([darkPole, 180]);
        
        // Trace along the dark pole
        for (let lon = 180; lon >= -180; lon -= resolution * 4) {
            polygon.push([darkPole, lon]);
        }
        
        polygon.push([darkPole, -180]);
        
        return polygon;
    }

    setupLiveMessagesPanel() {
        const header = document.getElementById('live-messages-header');
        const toggle = document.getElementById('live-messages-toggle');
        const content = document.getElementById('live-messages-content');
        const filterInput = document.getElementById('live-messages-callsign-filter');
        const prevBtn = document.getElementById('live-messages-prev');
        const nextBtn = document.getElementById('live-messages-next');
        const clearBtn = document.getElementById('clear-messages-btn');

        if (header && toggle && content) {
            header.addEventListener('click', (e) => {
                // Don't toggle if clicking the clear button
                if (e.target.id === 'clear-messages-btn' || e.target.closest('#clear-messages-btn')) {
                    return;
                }
                content.classList.toggle('collapsed');
                toggle.classList.toggle('collapsed');
                const filterDiv = document.querySelector('.live-messages-filter');
                const paginationDiv = document.getElementById('live-messages-pagination');
                if (filterDiv) filterDiv.style.display = content.classList.contains('collapsed') ? 'none' : 'block';
                if (paginationDiv) paginationDiv.style.display = content.classList.contains('collapsed') ? 'none' : 'flex';

                // Save collapsed state to localStorage
                this.savePreference('liveMessagesCollapsed', content.classList.contains('collapsed'));
            });
        }

        if (clearBtn) {
            clearBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent header click event
                if (confirm('Clear all live messages?')) {
                    this.liveMessages = [];
                    this.liveMessagesPage = 1;
                    this.updateLiveMessagesDisplay();
                }
            });
        }

        if (filterInput) {
            filterInput.addEventListener('input', (e) => {
                this.liveMessagesCallsignFilter = e.target.value.toUpperCase();
                this.liveMessagesPage = 1; // Reset to first page
                this.updateLiveMessagesDisplay();
            });
        }

        if (prevBtn) {
            prevBtn.addEventListener('click', () => {
                if (this.liveMessagesPage > 1) {
                    this.liveMessagesPage--;
                    this.updateLiveMessagesDisplay();
                }
            });
        }

        if (nextBtn) {
            nextBtn.addEventListener('click', () => {
                const filteredMessages = this.getFilteredMessages();
                const totalPages = Math.ceil(filteredMessages.length / this.liveMessagesPerPage);
                if (this.liveMessagesPage < totalPages) {
                    this.liveMessagesPage++;
                    this.updateLiveMessagesDisplay();
                }
            });
        }
    }

    getFilteredMessages() {
        const now = Date.now();
        return this.liveMessages.filter(spot => {
            // Apply callsign filter
            if (this.liveMessagesCallsignFilter && !spot.callsign.toUpperCase().includes(this.liveMessagesCallsignFilter)) {
                return false;
            }

            // Apply band filter
            if (this.bandFilter !== 'all' && spot.band !== this.bandFilter) {
                return false;
            }

            // Apply country filter
            if (this.countryFilter !== 'all' && spot.country !== this.countryFilter) {
                return false;
            }

            // Apply continent filter
            if (this.continentFilter !== 'all' && spot.Continent !== this.continentFilter) {
                return false;
            }

            // Apply SNR filter
            if (this.snrFilter !== 'none' && spot.snr < parseFloat(this.snrFilter)) {
                return false;
            }

            // Apply age filter
            if (this.ageFilter !== 'none') {
                const maxAgeMs = parseFloat(this.ageFilter) * 60 * 1000;
                const spotTime = new Date(spot.timestamp).getTime();
                const age = now - spotTime;
                if (age > maxAgeMs) {
                    return false;
                }
            }

            return true;
        });
    }

    addLiveMessage(spot) {
        // Add to beginning of array
        this.liveMessages.unshift(spot);

        // Limit number of messages
        if (this.liveMessages.length > this.maxLiveMessages) {
            this.liveMessages.pop();
        }

        // Update display
        this.updateLiveMessagesDisplay();
    }

    updateLiveMessagesDisplay() {
        const content = document.getElementById('live-messages-content');
        const countEl = document.getElementById('live-message-count');
        const paginationDiv = document.getElementById('live-messages-pagination');
        const pageInfo = document.getElementById('live-messages-page-info');
        const prevBtn = document.getElementById('live-messages-prev');
        const nextBtn = document.getElementById('live-messages-next');

        if (!content) return;

        // Check if panel is collapsed
        const isCollapsed = content.classList.contains('collapsed');

        const filteredMessages = this.getFilteredMessages();

        if (this.liveMessages.length === 0) {
            content.innerHTML = '<div class="live-messages-empty">Waiting for spots...</div>';
            if (countEl) countEl.textContent = '0';
            if (paginationDiv) paginationDiv.style.display = 'none';
            return;
        }

        if (filteredMessages.length === 0) {
            content.innerHTML = '<div class="live-messages-empty">No matching callsigns</div>';
            if (countEl) countEl.textContent = '0';
            if (paginationDiv) paginationDiv.style.display = 'none';
            return;
        }

        // Update count - show only the filtered count
        if (countEl) {
            countEl.textContent = `${filteredMessages.length}`;
        }

        // Calculate pagination
        const totalPages = Math.ceil(filteredMessages.length / this.liveMessagesPerPage);
        const startIdx = (this.liveMessagesPage - 1) * this.liveMessagesPerPage;
        const endIdx = Math.min(startIdx + this.liveMessagesPerPage, filteredMessages.length);
        const pageMessages = filteredMessages.slice(startIdx, endIdx);

        // Update pagination controls - but keep hidden if panel is collapsed
        if (paginationDiv && totalPages > 1 && !isCollapsed) {
            paginationDiv.style.display = 'flex';
            if (pageInfo) {
                pageInfo.textContent = `Page ${this.liveMessagesPage} of ${totalPages}`;
            }
            if (prevBtn) {
                prevBtn.disabled = this.liveMessagesPage === 1;
                prevBtn.style.opacity = this.liveMessagesPage === 1 ? '0.5' : '1';
                prevBtn.style.cursor = this.liveMessagesPage === 1 ? 'not-allowed' : 'pointer';
            }
            if (nextBtn) {
                nextBtn.disabled = this.liveMessagesPage === totalPages;
                nextBtn.style.opacity = this.liveMessagesPage === totalPages ? '0.5' : '1';
                nextBtn.style.cursor = this.liveMessagesPage === totalPages ? 'not-allowed' : 'pointer';
            }
        } else if (paginationDiv) {
            paginationDiv.style.display = 'none';
        }

        // Build HTML for current page
        let html = '';
        pageMessages.forEach(spot => {
            const time = new Date(spot.timestamp).toLocaleTimeString('en-US', {
                hour12: false,
                timeZone: 'UTC'
            });

            // Calculate local time if TimeOffset is available
            // Note: CTY.DAT stores offsets as negative for west of UTC, positive for east
            // So we negate the offset when calculating local time
            let localTimeStr = '';
            if (spot.TimeOffset !== undefined && spot.TimeOffset !== null) {
                const utcDate = new Date(spot.timestamp);
                const localDate = new Date(utcDate.getTime() - (spot.TimeOffset * 3600000));
                const localTime = localDate.toLocaleTimeString('en-US', {
                    hour12: false,
                    timeZone: 'UTC'
                });
                const offsetSign = -spot.TimeOffset >= 0 ? '+' : '';
                localTimeStr = ` • ${localTime} GMT${offsetSign}${-spot.TimeOffset}`;
            }

            const bandColor = this.bandColors[spot.band] || '#999';

            const spotKey = `${spot.callsign}-${spot.band}`;
            html += `
                <div class="live-message">
                    <div class="live-message-time">${time} UTC${localTimeStr}</div>
                    <div>
                        <span class="live-message-callsign" style="cursor: pointer; text-decoration: underline;"
                              onclick="window.cwSkimmerMap.showSpotOnMap('${spotKey}')">${spot.callsign}</span>
                        ${spot.country ? `<span style="color: #888; font-size: 10px;"> • ${spot.country}</span>` : ''}
                        ${spot.Continent ? `<span style="color: #888; font-size: 10px;"> • ${spot.Continent}</span>` : ''}
                        ${spot.distance_km !== undefined && spot.distance_km !== null ? `<span style="color: #888; font-size: 10px;"> • ${Math.round(spot.distance_km)} km</span>` : ''}
                    </div>
                    <div class="live-message-details">
                        <span style="color: ${bandColor};">●</span> ${spot.band}
                        ${spot.snr !== undefined ? ` • ${spot.snr >= 0 ? '+' : ''}${spot.snr} dB` : ''}
                        ${spot.wpm ? ` • ${spot.wpm} WPM` : ''}
                        ${spot.frequency ? ` • ${(spot.frequency / 1e6).toFixed(3)} MHz` : ''}
                        ${spot.comment && spot.comment === 'CQ' ? ` • <strong>${spot.comment}</strong>` : ''}
                        ${spot.comment && spot.comment === 'DE' ? ` • ${spot.comment}` : ''}
                    </div>
                    ${spot.message ? `<div style="color: #aaa; font-size: 10px; margin-top: 4px;">${spot.message}</div>` : ''}
                </div>
            `;
        });

        content.innerHTML = html;
    }

    showSpotOnMap(spotKey) {
        // Find the marker for this spot
        const marker = this.markers.get(spotKey);
        if (marker) {
            // Pan to the marker and zoom in to ensure it's unclustered
            const latLng = marker.getLatLng();
            this.map.setView(latLng, Math.max(this.map.getZoom(), 12), {
                animate: true,
                duration: 0.5
            });
            
            // Open the popup after a short delay to allow unclustering
            setTimeout(() => {
                marker.openPopup();
            }, 600);
        }
    }

    updateBandLegend() {
        const legendContainer = document.getElementById('band-legend-items');
        if (!legendContainer) return;

        // Get unique bands from current spots
        const activeBands = new Set();
        this.spots.forEach(spot => {
            if (spot.band) {
                activeBands.add(spot.band);
            }
        });

        // Sort bands in standard order
        const bandOrder = ['2200m', '630m', '160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];
        const sortedBands = Array.from(activeBands).sort((a, b) => {
            return bandOrder.indexOf(a) - bandOrder.indexOf(b);
        });

        // Build legend HTML
        let html = '';
        sortedBands.forEach(band => {
            const color = this.bandColors[band] || '#999';

            // Log unknown bands in legend
            if (!this.bandColors[band]) {
                console.warn('[Unknown Band in Legend]', {
                    band: band,
                    activeBands: Array.from(activeBands)
                });
            }

            html += `
                <div class="band-legend-item">
                    <span class="band-legend-color" style="background-color: ${color};"></span>
                    <span class="band-legend-label">${band}</span>
                </div>
            `;
        });

        legendContainer.innerHTML = html || '<div style="color: #888; font-size: 11px;">No active bands</div>';
    }

    checkNewEntities(spot) {
        // Check for new continent+band combination
        if (spot.Continent && spot.Continent !== '' && spot.band) {
            const continentBandKey = `${spot.Continent}-${spot.band}`;
            if (!this.seenContinentBands.has(continentBandKey)) {
                this.seenContinentBands.add(continentBandKey);
                this.latestNewContinent = {
                    continent: spot.Continent,
                    band: spot.band,
                    callsign: spot.callsign,
                    snr: spot.snr
                };
                this.updateNewEntitiesDisplay();
            }
        }

        // Check for new country+band combination
        if (spot.country && spot.country !== '' && spot.country !== 'Unknown' && spot.band) {
            const countryBandKey = `${spot.country}-${spot.band}`;
            if (!this.seenCountryBands.has(countryBandKey)) {
                this.seenCountryBands.add(countryBandKey);
                this.latestNewCountry = {
                    country: spot.country,
                    band: spot.band,
                    callsign: spot.callsign,
                    snr: spot.snr
                };
                this.updateNewEntitiesDisplay();
            }
        }
    }

    updateNewEntitiesDisplay() {
        const continentInfo = document.getElementById('new-continent-info');
        const countryInfo = document.getElementById('new-country-info');

        if (continentInfo && this.latestNewContinent) {
            const continentName = this.continentNames[this.latestNewContinent.continent] || this.latestNewContinent.continent;
            const snrStr = this.latestNewContinent.snr !== undefined ?
                `${this.latestNewContinent.snr >= 0 ? '+' : ''}${this.latestNewContinent.snr}dB` : 'N/A';
            continentInfo.innerHTML = `
                <div style="font-weight: bold;">${continentName} • ${this.latestNewContinent.band}</div>
                <div style="font-size: 10px; color: #888; margin-top: 2px;">
                    ${this.latestNewContinent.callsign} • ${snrStr}
                </div>
            `;
        }

        if (countryInfo && this.latestNewCountry) {
            const snrStr = this.latestNewCountry.snr !== undefined ?
                `${this.latestNewCountry.snr >= 0 ? '+' : ''}${this.latestNewCountry.snr}dB` : 'N/A';
            countryInfo.innerHTML = `
                <div style="font-weight: bold;">${this.latestNewCountry.country} • ${this.latestNewCountry.band}</div>
                <div style="font-size: 10px; color: #888; margin-top: 2px;">
                    ${this.latestNewCountry.callsign} • ${snrStr}
                </div>
            `;
        }
    }

    updateRarestEntities() {
        const rarestContinentEl = document.getElementById('rarest-continent-info');
        const rarestCountryEl = document.getElementById('rarest-country-info');

        if (!rarestContinentEl || !rarestCountryEl) return;

        // Count spots by continent and country (considering current filters)
        const continentCounts = {};
        const countryCounts = {};
        const continentSpots = {}; // Store a sample spot for each continent
        const countrySpots = {}; // Store a sample spot for each country

        const now = Date.now();

        this.spots.forEach(spot => {
            // Apply filters
            const bandMatch = this.bandFilter === 'all' || spot.band === this.bandFilter;
            const countryMatch = this.countryFilter === 'all' || spot.country === this.countryFilter;
            const continentMatch = this.continentFilter === 'all' || spot.Continent === this.continentFilter;
            const snrMatch = this.snrFilter === 'none' || spot.snr >= parseFloat(this.snrFilter);

            let ageMatch = true;
            if (this.ageFilter !== 'none') {
                const maxAgeMs = parseFloat(this.ageFilter) * 60 * 1000;
                const spotTime = new Date(spot.timestamp).getTime();
                const age = now - spotTime;
                ageMatch = age <= maxAgeMs;
            }

            if (!ageMatch || !bandMatch || !countryMatch || !continentMatch || !snrMatch) {
                return;
            }

            // Count continents
            if (spot.Continent && spot.Continent !== '') {
                continentCounts[spot.Continent] = (continentCounts[spot.Continent] || 0) + 1;
                if (!continentSpots[spot.Continent]) {
                    continentSpots[spot.Continent] = spot;
                }
            }

            // Count countries
            if (spot.country && spot.country !== '' && spot.country !== 'Unknown') {
                countryCounts[spot.country] = (countryCounts[spot.country] || 0) + 1;
                if (!countrySpots[spot.country]) {
                    countrySpots[spot.country] = spot;
                }
            }
        });

        // Find rarest continent (minimum count, but must have at least 1)
        let rarestContinent = null;
        let minContinentCount = Infinity;
        for (const [continent, count] of Object.entries(continentCounts)) {
            if (count > 0 && count < minContinentCount) {
                minContinentCount = count;
                rarestContinent = continent;
            }
        }

        // Find rarest country (minimum count, but must have at least 1)
        let rarestCountry = null;
        let minCountryCount = Infinity;
        for (const [country, count] of Object.entries(countryCounts)) {
            if (count > 0 && count < minCountryCount) {
                minCountryCount = count;
                rarestCountry = country;
            }
        }

        // Update rarest continent display
        if (rarestContinent && continentSpots[rarestContinent]) {
            const spot = continentSpots[rarestContinent];
            const continentName = this.continentNames[rarestContinent] || rarestContinent;
            const snrStr = spot.snr !== undefined ?
                `${spot.snr >= 0 ? '+' : ''}${spot.snr}dB` : 'N/A';
            rarestContinentEl.innerHTML = `
                <div style="font-weight: bold;">${continentName} (${minContinentCount} spot${minContinentCount !== 1 ? 's' : ''})</div>
                <div style="font-size: 10px; color: #888; margin-top: 2px;">
                    ${spot.callsign} • ${spot.band} • ${snrStr}
                </div>
            `;
        } else {
            rarestContinentEl.textContent = '-';
        }

        // Update rarest country display
        if (rarestCountry && countrySpots[rarestCountry]) {
            const spot = countrySpots[rarestCountry];
            const snrStr = spot.snr !== undefined ?
                `${spot.snr >= 0 ? '+' : ''}${spot.snr}dB` : 'N/A';
            rarestCountryEl.innerHTML = `
                <div style="font-weight: bold;">${rarestCountry} (${minCountryCount} spot${minCountryCount !== 1 ? 's' : ''})</div>
                <div style="font-size: 10px; color: #888; margin-top: 2px;">
                    ${spot.callsign} • ${spot.band} • ${snrStr}
                </div>
            `;
        } else {
            rarestCountryEl.textContent = '-';
        }
    }

    updateTimeDisplay() {
        const utcTimeEl = document.getElementById('utc-time');
        const localTimeEl = document.getElementById('local-time');
        const localDateEl = document.getElementById('local-date');

        if (!utcTimeEl || !localTimeEl || !localDateEl) return;

        const now = new Date();

        // Format UTC time with seconds
        const utcTime = now.toLocaleTimeString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
            timeZone: 'UTC'
        });
        utcTimeEl.textContent = utcTime;

        // Format local time with seconds
        const localTime = now.toLocaleTimeString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
        localTimeEl.textContent = localTime;

        // Format local date with day name on one line, date on next line
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

        const dayName = days[now.getDay()];
        const dom = now.getDate();
        const monthName = months[now.getMonth()];
        const year = now.getFullYear();

        localDateEl.innerHTML = `${dayName}<br>${dom}-${monthName}-${year}`;
    }

    updateSpotsPerMinute() {
        const spotsPerMinEl = document.getElementById('spots-per-minute');
        if (!spotsPerMinEl) return;

        // Clean up old timestamps (older than 1 minute)
        const now = Date.now();
        const oneMinuteAgo = now - 60000;
        this.spotTimestamps = this.spotTimestamps.filter(ts => ts > oneMinuteAgo);

        // Calculate rate
        const rate = this.spotTimestamps.length;
        spotsPerMinEl.textContent = `${rate}/min`;
    }

    updateLastSpotTime() {
        const lastSpotEl = document.getElementById('last-spot-time');
        if (!lastSpotEl) return;

        if (!this.lastSpotTime) {
            lastSpotEl.textContent = '-';
            return;
        }

        const now = Date.now();
        const elapsed = now - this.lastSpotTime;
        const seconds = Math.floor(elapsed / 1000);

        if (seconds === 0) {
            lastSpotEl.textContent = 'now';
        } else if (seconds < 60) {
            lastSpotEl.textContent = `${seconds}s ago`;
        } else {
            const minutes = Math.floor(seconds / 60);
            const remainingSeconds = seconds % 60;
            lastSpotEl.textContent = `${minutes}m ${remainingSeconds}s ago`;
        }
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.cwSkimmerMap = new CWSkimmerMap();
});
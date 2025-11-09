// Digital Spots Map JavaScript
// Displays real-time digital mode spots on a Leaflet map

class DigitalSpotsMap {
    constructor() {
        this.map = null;
        this.ws = null;
        this.spots = new Map(); // Store spots by unique key (callsign-band-mode)
        this.markers = new Map(); // Store Leaflet markers
        this.receiverMarker = null;
        this.receiverLocation = null;
        this.receiverInfo = null;
        this.greylineLayer = null;
        this.maxSpots = 5000; // Maximum number of spots to display
        this.maxAge = 30 * 60 * 1000; // 30 minutes in milliseconds
        this.userSessionID = this.generateUserSessionID();
        this.modeFilter = 'all'; // Current mode filter
        this.ageFilter = 'none'; // Current age filter (max age in minutes)
        this.bandFilter = 'all'; // Current band filter
        this.snrFilter = 'none'; // Current SNR filter (minimum SNR)
        this.reconnectAttempts = 0; // Track reconnection attempts
        this.reconnectTimeout = null; // Store timeout ID
        this.liveMessages = []; // Store live messages
        this.maxLiveMessages = 10000; // Maximum number of live messages to keep
        this.liveMessagesPage = 1; // Current page
        this.liveMessagesPerPage = 200; // Messages per page
        this.liveMessagesCallsignFilter = ''; // Callsign filter

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
            '10m': '#BAB0AC'    // Gray
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

    async init() {
        // Initialize map
        this.initMap();

        // Load receiver location
        await this.loadReceiverLocation();

        // Connect to websocket
        this.connectWebSocket();

        // Start cleanup interval
        this.startCleanup();

        // Update greyline
        this.updateGreyline();
        setInterval(() => this.updateGreyline(), 60000);

        // Setup live messages panel
        this.setupLiveMessagesPanel();
    }

    initMap() {
        // Initialize Leaflet map with world view
        // Zoom level 3 shows the world once without duplication
        this.map = L.map('map').setView([20, 0], 3);

        // Add OpenStreetMap tiles
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors',
            maxZoom: 18,
            minZoom: 2
        }).addTo(this.map);

        // Setup mode filter
        this.setupModeFilter();
    }

    setupModeFilter() {
        const modeFilter = document.getElementById('mode-filter');
        if (modeFilter) {
            modeFilter.addEventListener('change', (e) => {
                this.modeFilter = e.target.value;
                this.applyFilters();
            });
        }

        const ageFilter = document.getElementById('age-filter');
        if (ageFilter) {
            ageFilter.addEventListener('change', (e) => {
                this.ageFilter = e.target.value;
                this.applyFilters();
            });
        }

        const bandFilter = document.getElementById('band-filter');
        if (bandFilter) {
            bandFilter.addEventListener('change', (e) => {
                this.bandFilter = e.target.value;
                this.applyFilters();
            });
        }

        const snrFilter = document.getElementById('snr-filter');
        if (snrFilter) {
            snrFilter.addEventListener('change', (e) => {
                this.snrFilter = e.target.value;
                this.applyFilters();
            });
        }
    }

    applyFilters() {
        // Hide/show markers based on mode, age, band, and SNR filters
        const now = Date.now();
        this.markers.forEach((marker, key) => {
            const spot = this.spots.get(key);
            if (!spot) return;

            const modeMatch = this.modeFilter === 'all' || spot.mode === this.modeFilter;
            const bandMatch = this.bandFilter === 'all' || spot.band === this.bandFilter;
            const snrMatch = this.snrFilter === 'none' || spot.snr >= parseFloat(this.snrFilter);
            
            // Age filter check
            let ageMatch = true;
            if (this.ageFilter !== 'none') {
                const maxAgeMs = parseFloat(this.ageFilter) * 60 * 1000; // Convert minutes to milliseconds
                const spotTime = new Date(spot.timestamp).getTime();
                const age = now - spotTime;
                ageMatch = age <= maxAgeMs;
            }

            if (modeMatch && ageMatch && bandMatch && snrMatch) {
                marker.addTo(this.map);
            } else {
                marker.remove();
            }
        });
        
        this.updateSpotCount();
        this.updateDistanceStatistics();
        this.updateLiveMessagesDisplay(); // Update live messages when filters change
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

    connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws/dxcluster?user_session_id=${encodeURIComponent(this.userSessionID)}`;

        console.log('[Digital Spots Map] Connecting to:', wsUrl);

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            console.log('WebSocket connected');
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
        if (message.type === 'digital_spot') {
            this.handleDigitalSpot(message.data);
        } else if (message.type === 'status') {
            // Handle connection status updates
            if (message.connected) {
                this.updateStatus('connected', 'Connected');
            } else {
                this.updateStatus('disconnected', 'Disconnected');
            }
        }
    }

    handleDigitalSpot(spot) {
        // Only process spots with valid coordinates
        if (!spot.latitude || !spot.longitude) {
            return;
        }

        // Create unique key for spot
        const key = `${spot.callsign}-${spot.band}-${spot.mode}`;

        // Add timestamp if not present
        if (!spot.timestamp) {
            spot.timestamp = new Date().toISOString();
        }

        // Store spot
        this.spots.set(key, spot);

        // Add or update marker
        this.addOrUpdateMarker(key, spot);

        // Add to live messages
        this.addLiveMessage(spot);

        // Update spot count and distance statistics
        this.updateSpotCount();
        this.updateDistanceStatistics();
        
        // Update band legend
        this.updateBandLegend();

        // Limit number of spots
        if (this.spots.size > this.maxSpots) {
            this.removeOldestSpot();
        }
    }

    addOrUpdateMarker(key, spot) {
        // Remove existing marker if present
        if (this.markers.has(key)) {
            this.map.removeLayer(this.markers.get(key));
        }

        // Get color for band
        const color = this.bandColors[spot.band] || '#999';

        // Create custom icon
        const icon = L.divIcon({
            className: 'custom-marker',
            html: `<div style="width: 12px; height: 12px; background: ${color}; border: 2px solid rgba(255, 255, 255, 0.5); border-radius: 50%;"></div>`,
            iconSize: [12, 12],
            iconAnchor: [6, 6]
        });

        // Create marker
        const marker = L.marker([spot.latitude, spot.longitude], { icon });

        // Create popup content
        const popupContent = this.createPopupContent(spot);
        marker.bindPopup(popupContent);
        marker.bindTooltip(popupContent, {
            direction: 'top',
            offset: [0, -10]
        });

        // Add to map only if it passes all filters
        const modeMatch = this.modeFilter === 'all' || spot.mode === this.modeFilter;
        const bandMatch = this.bandFilter === 'all' || spot.band === this.bandFilter;
        const snrMatch = this.snrFilter === 'none' || spot.snr >= parseFloat(this.snrFilter);
        
        // Age filter check
        let ageMatch = true;
        if (this.ageFilter !== 'none') {
            const maxAgeMs = parseFloat(this.ageFilter) * 60 * 1000;
            const spotTime = new Date(spot.timestamp).getTime();
            const age = Date.now() - spotTime;
            ageMatch = age <= maxAgeMs;
        }
        
        if (modeMatch && ageMatch && bandMatch && snrMatch) {
            marker.addTo(this.map);
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
                <b>Mode:</b> ${spot.mode}<br>
                <b>Frequency:</b> ${(spot.frequency / 1e6).toFixed(3)} MHz<br>
                <b>SNR:</b> ${spot.snr >= 0 ? '+' : ''}${spot.snr} dB<br>
                <b>Grid:</b> ${spot.locator || 'N/A'}<br>
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
        // Remove marker from map
        if (this.markers.has(key)) {
            this.map.removeLayer(this.markers.get(key));
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

                if (age > this.maxAge) {
                    keysToRemove.push(key);
                }
            }

            keysToRemove.forEach(key => this.removeSpot(key));

            if (keysToRemove.length > 0) {
                this.updateSpotCount();
            }
        }, 60000); // Every minute
    }

    updateStatus(status, text) {
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
                const modeMatch = this.modeFilter === 'all' || spot.mode === this.modeFilter;
                const bandMatch = this.bandFilter === 'all' || spot.band === this.bandFilter;
                const snrMatch = this.snrFilter === 'none' || spot.snr >= parseFloat(this.snrFilter);
                
                // Age filter check
                let ageMatch = true;
                if (this.ageFilter !== 'none') {
                    const maxAgeMs = parseFloat(this.ageFilter) * 60 * 1000;
                    const spotTime = new Date(spot.timestamp).getTime();
                    const age = now - spotTime;
                    ageMatch = age <= maxAgeMs;
                }
                
                if (modeMatch && ageMatch && bandMatch && snrMatch) {
                    visibleCount++;
                }
            });
            
            if (this.modeFilter === 'all' && this.ageFilter === 'none' && this.bandFilter === 'all' && this.snrFilter === 'none') {
                countEl.textContent = `${this.spots.size} spot${this.spots.size !== 1 ? 's' : ''}`;
            } else {
                countEl.textContent = `${visibleCount} / ${this.spots.size} spot${this.spots.size !== 1 ? 's' : ''}`;
            }
        }
    }

    updateTopCountries(spots, containerEl) {
        if (!containerEl) return;
        
        // Count spots by country
        const countryCounts = {};
        spots.forEach(spot => {
            if (spot.country && spot.country !== 'Unknown') {
                countryCounts[spot.country] = (countryCounts[spot.country] || 0) + 1;
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
        
        // Build HTML
        let html = '';
        sortedCountries.forEach(([country, count], index) => {
            html += `
                <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 3px; color: #ccc;">
                    <span>${index + 1}. ${country}</span>
                    <span style="color: #4a9eff;">${count}</span>
                </div>
            `;
        });
        
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
        
        // Build HTML showing all bands in order
        let html = '';
        allBands.forEach(band => {
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

    updateModeStats(spots, containerEl) {
        if (!containerEl) return;
        
        // Define the modes we're tracking
        const modes = ['FT8', 'FT4', 'WSPR'];
        
        // Count spots by mode
        const modeCounts = {};
        modes.forEach(mode => {
            modeCounts[mode] = 0;
        });
        
        spots.forEach(spot => {
            if (spot.mode && modes.includes(spot.mode)) {
                modeCounts[spot.mode]++;
            }
        });
        
        // Check if we have any data
        const hasData = Object.values(modeCounts).some(count => count > 0);
        if (!hasData) {
            containerEl.innerHTML = '<div style="font-size: 11px; color: #aaa;">No data</div>';
            return;
        }
        
        // Build HTML showing all modes
        let html = '';
        modes.forEach(mode => {
            const count = modeCounts[mode];
            const color = count > 0 ? '#ccc' : '#555';
            html += `
                <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 3px; color: ${color};">
                    <span>${mode}</span>
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

        // Build HTML
        let html = '';
        const directionOrder = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

        directionOrder.forEach(dir => {
            const count = directions[dir];
            const percentage = (count / totalWithBearing) * 100;
            const color = count > 0 ? '#ccc' : '#555';

            html += `
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; margin-bottom: 3px; color: ${color};">
                    <span style="min-width: 25px;">${dir}</span>
                    <div style="flex: 1; height: 12px; background: rgba(255, 255, 255, 0.1); border-radius: 2px; margin: 0 8px; overflow: hidden;">
                        <div style="height: 100%; background: linear-gradient(90deg, #4a9eff, #2d7dd2); width: ${percentage}%;"></div>
                    </div>
                    <span style="min-width: 50px; text-align: right; color: ${count > 0 ? '#4a9eff' : '#555'};">${count} (${percentage.toFixed(0)}%)</span>
                </div>
            `;
        });

        containerEl.innerHTML = html;
    }

    updateDistanceStatistics() {
        const rangesEl = document.getElementById('distance-ranges');
        const bearingStatsEl = document.getElementById('bearing-stats');
        const closestEl = document.getElementById('closest-spot');
        const farthestEl = document.getElementById('farthest-spot');
        const topCountriesEl = document.getElementById('top-countries');
        const topBandsEl = document.getElementById('top-bands');
        const modeStatsEl = document.getElementById('mode-stats');

        if (!rangesEl || !bearingStatsEl || !closestEl || !farthestEl || !topCountriesEl || !topBandsEl || !modeStatsEl) {
            return;
        }
        
        // Collect all spots that pass filters
        const filteredSpots = [];
        const spotsWithDistance = [];
        const now = Date.now();
        
        this.spots.forEach(spot => {
            // Apply mode filter
            if (this.modeFilter !== 'all' && spot.mode !== this.modeFilter) {
                return;
            }
            // Apply band filter
            if (this.bandFilter !== 'all' && spot.band !== this.bandFilter) {
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
                spotsWithDistance.push(spot);
            }
        });
        
        // Update top countries, bands, and mode stats
        this.updateTopCountries(filteredSpots, topCountriesEl);
        this.updateTopBands(filteredSpots, topBandsEl);
        this.updateModeStats(filteredSpots, modeStatsEl);

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
                <div class="distance-range">
                    <span style="min-width: 80px;">${label}</span>
                    <div class="distance-bar-container">
                        <div class="distance-bar" style="width: ${percentage}%"></div>
                    </div>
                    <span style="min-width: 60px; text-align: right;">${range.count} (${percentage.toFixed(0)}%)</span>
                </div>
            `;
        });
        
        rangesEl.innerHTML = html;
        // Format closest spot with details on separate lines
        let closestHtml = `${Math.round(closestSpot.distance_km)} km - ${closestSpot.callsign}`;
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
        if (closestDetails.length > 0) {
            closestHtml += `<br><span style="font-size: 10px; color: #888;">${closestDetails.join(' • ')}</span>`;
        }
        closestEl.innerHTML = closestHtml;

        // Format farthest spot with details on separate lines
        let farthestHtml = `${Math.round(farthestSpot.distance_km)} km - ${farthestSpot.callsign}`;
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
        if (farthestDetails.length > 0) {
            farthestHtml += `<br><span style="font-size: 10px; color: #888;">${farthestDetails.join(' • ')}</span>`;
        }
        farthestEl.innerHTML = farthestHtml;
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

            // Apply mode filter
            if (this.modeFilter !== 'all' && spot.mode !== this.modeFilter) {
                return false;
            }

            // Apply band filter
            if (this.bandFilter !== 'all' && spot.band !== this.bandFilter) {
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

        const filteredMessages = this.getFilteredMessages();

        if (this.liveMessages.length === 0) {
            content.innerHTML = '<div class="live-messages-empty">Waiting for spots...</div>';
            if (countEl) countEl.textContent = '(0)';
            if (paginationDiv) paginationDiv.style.display = 'none';
            return;
        }

        if (filteredMessages.length === 0) {
            content.innerHTML = '<div class="live-messages-empty">No matching callsigns</div>';
            if (countEl) countEl.textContent = `(0 / ${this.liveMessages.length})`;
            if (paginationDiv) paginationDiv.style.display = 'none';
            return;
        }

        // Update count
        if (countEl) {
            if (this.liveMessagesCallsignFilter) {
                countEl.textContent = `(${filteredMessages.length} / ${this.liveMessages.length})`;
            } else {
                countEl.textContent = `(${this.liveMessages.length})`;
            }
        }

        // Calculate pagination
        const totalPages = Math.ceil(filteredMessages.length / this.liveMessagesPerPage);
        const startIdx = (this.liveMessagesPage - 1) * this.liveMessagesPerPage;
        const endIdx = Math.min(startIdx + this.liveMessagesPerPage, filteredMessages.length);
        const pageMessages = filteredMessages.slice(startIdx, endIdx);

        // Update pagination controls
        if (paginationDiv && totalPages > 1) {
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

            const bandColor = this.bandColors[spot.band] || '#999';

            const spotKey = `${spot.callsign}-${spot.band}-${spot.mode}`;
            html += `
                <div class="live-message">
                    <div class="live-message-time">${time} UTC</div>
                    <div>
                        <span class="live-message-callsign" style="cursor: pointer; text-decoration: underline;"
                              onclick="window.digitalSpotsMap.showSpotOnMap('${spotKey}')">${spot.callsign}</span>
                        ${spot.country ? `<span style="color: #888; font-size: 10px;"> • ${spot.country}</span>` : ''}
                    </div>
                    <div class="live-message-details">
                        <span class="live-message-mode">${spot.mode}</span>
                        <span style="color: ${bandColor};">●</span> ${spot.band}
                        ${spot.snr !== undefined ? ` • ${spot.snr >= 0 ? '+' : ''}${spot.snr} dB` : ''}
                        ${spot.frequency ? ` • ${(spot.frequency / 1e6).toFixed(3)} MHz` : ''}
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
            // Pan to the marker
            const latLng = marker.getLatLng();
            this.map.setView(latLng, Math.max(this.map.getZoom(), 5), {
                animate: true,
                duration: 0.5
            });
            
            // Open the popup
            marker.openPopup();
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
            html += `
                <div class="band-legend-item">
                    <span class="band-legend-color" style="background-color: ${color};"></span>
                    <span class="band-legend-label">${band}</span>
                </div>
            `;
        });

        legendContainer.innerHTML = html || '<div style="color: #888; font-size: 11px;">No active bands</div>';
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.digitalSpotsMap = new DigitalSpotsMap();
});
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
        this.maxSpots = 5000; // Maximum number of spots to display
        this.maxAge = 30 * 60 * 1000; // 30 minutes in milliseconds
        this.userSessionID = this.generateUserSessionID();
        this.modeFilter = 'all'; // Current mode filter
        this.ageFilter = 'none'; // Current age filter (max age in minutes)
        this.bandFilter = 'all'; // Current band filter
        this.snrFilter = 'none'; // Current SNR filter (minimum SNR)
        this.reconnectAttempts = 0; // Track reconnection attempts
        this.reconnectTimeout = null; // Store timeout ID

        // Band colors matching noisefloor.js
        this.bandColors = {
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

        this.receiverMarker.bindPopup('<b>Receiver Location</b>');
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

        // Update spot count and distance statistics
        this.updateSpotCount();
        this.updateDistanceStatistics();

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
        
        // Define all bands in order (160m through 10m)
        const allBands = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];
        
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

    updateDistanceStatistics() {
        const rangesEl = document.getElementById('distance-ranges');
        const closestEl = document.getElementById('closest-spot');
        const farthestEl = document.getElementById('farthest-spot');
        const topCountriesEl = document.getElementById('top-countries');
        const topBandsEl = document.getElementById('top-bands');
        
        if (!rangesEl || !closestEl || !farthestEl || !topCountriesEl || !topBandsEl) {
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
        
        // Update top countries and bands
        this.updateTopCountries(filteredSpots, topCountriesEl);
        this.updateTopBands(filteredSpots, topBandsEl);
        
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
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new DigitalSpotsMap();
});
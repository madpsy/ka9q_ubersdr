// Decoder Spots History Map Module
// Displays historical spots on a Leaflet map with grid locator conversion

class DecoderSpotsHistoryMap {
    constructor() {
        this.map = null;
        this.markers = new Map();
        this.receiverMarker = null;
        this.receiverLocation = null;
        
        // Band colors matching digitalspots_map.js
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
    }

    /**
     * Convert Maidenhead grid locator to latitude/longitude
     * @param {string} locator - Grid locator (4 or 6 characters)
     * @returns {object} - {lat, lon} or null if invalid
     */
    gridToCoordinates(locator) {
        if (!locator || typeof locator !== 'string') {
            return null;
        }

        locator = locator.toUpperCase().trim();
        
        // Validate format: 2 letters + 2 digits (+ optional 2 letters)
        if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(locator)) {
            return null;
        }

        // Extract components
        const field = locator.substring(0, 2);
        const square = locator.substring(2, 4);
        const subsquare = locator.length >= 6 ? locator.substring(4, 6) : null;

        // Calculate longitude (field: 20° each, square: 2° each, subsquare: 5' each)
        let lon = -180;
        lon += (field.charCodeAt(0) - 65) * 20; // Field (A-R = 0-17)
        lon += parseInt(square[0]) * 2; // Square (0-9)
        if (subsquare) {
            lon += (subsquare.charCodeAt(0) - 65) * (2/24); // Subsquare (A-X = 0-23)
            lon += (2/24) / 2; // Center of subsquare
        } else {
            lon += 1; // Center of square
        }

        // Calculate latitude (field: 10° each, square: 1° each, subsquare: 2.5' each)
        let lat = -90;
        lat += (field.charCodeAt(1) - 65) * 10; // Field (A-R = 0-17)
        lat += parseInt(square[1]) * 1; // Square (0-9)
        if (subsquare) {
            lat += (subsquare.charCodeAt(1) - 65) * (1/24); // Subsquare (A-X = 0-23)
            lat += (1/24) / 2; // Center of subsquare
        } else {
            lat += 0.5; // Center of square
        }

        return { lat, lon };
    }

    /**
     * Hash a callsign to generate consistent pseudo-random values
     * @param {string} callsign - Station callsign
     * @returns {number} - Hash value
     */
    hashCallsign(callsign) {
        let hash = 0;
        for (let i = 0; i < callsign.length; i++) {
            hash = ((hash << 5) - hash) + callsign.charCodeAt(i);
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash);
    }

    /**
     * Get consistent offset for a callsign to prevent overlapping markers
     * @param {string} callsign - Station callsign
     * @returns {object} - {lat, lon} offset in degrees
     */
    getCallsignOffset(callsign) {
        const hash = this.hashCallsign(callsign);
        // Maidenhead grid squares are approximately 1° latitude × 2° longitude
        // Use smaller offsets to keep stations well within their grid square
        const latOffset = ((hash % 1000) / 1000 - 0.5) * 0.8; // ±0.4 degrees
        const lonOffset = (((hash / 1000) % 1000) / 1000 - 0.5) * 1.6; // ±0.8 degrees
        return { lat: latOffset, lon: lonOffset };
    }

    /**
     * Initialize the map
     */
    async initMap() {
        const mapContainer = document.getElementById('spots-map');
        if (!mapContainer) {
            console.error('Map container not found');
            return;
        }

        // Initialize Leaflet map with world view
        this.map = L.map('spots-map').setView([20, 0], 3);

        // Add OpenStreetMap tiles
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors',
            maxZoom: 18,
            minZoom: 2
        }).addTo(this.map);

        // Load receiver location
        await this.loadReceiverLocation();

        // Update legend
        this.updateLegend();
    }

    /**
     * Load receiver location from API
     */
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
            }
        } catch (error) {
            console.error('Error loading receiver location:', error);
        }
    }

    /**
     * Add receiver marker to map
     */
    addReceiverMarker() {
        if (!this.receiverLocation || !this.map) return;

        // Create custom icon for receiver
        const receiverIcon = L.divIcon({
            className: '',
            html: '<div style="width: 20px; height: 20px; background: #ff0000; border: 3px solid rgba(255, 255, 255, 0.9); border-radius: 50%; box-shadow: 0 0 10px rgba(255, 0, 0, 0.5);"></div>',
            iconSize: [20, 20],
            iconAnchor: [10, 10]
        });

        this.receiverMarker = L.marker(
            [this.receiverLocation.lat, this.receiverLocation.lon],
            { icon: receiverIcon }
        ).addTo(this.map);

        this.receiverMarker.bindPopup('<div style="font-family: monospace; font-size: 12px;"><b>Receiver Location</b></div>');
        this.receiverMarker.bindTooltip('Receiver Location', {
            direction: 'top',
            offset: [0, -15],
            permanent: false
        });
    }

    /**
     * Clear all spot markers from map
     */
    clearMarkers() {
        this.markers.forEach(marker => {
            this.map.removeLayer(marker);
        });
        this.markers.clear();
    }

    /**
     * Add spots to map
     * @param {Array} spots - Array of spot objects
     */
    addSpots(spots) {
        if (!this.map) {
            console.warn('Map not initialized');
            return;
        }

        // Clear existing markers
        this.clearMarkers();

        // Add new markers
        spots.forEach(spot => {
            if (!spot.locator) return;

            // Convert grid locator to coordinates
            const coords = this.gridToCoordinates(spot.locator);
            if (!coords) {
                console.warn('Invalid grid locator:', spot.locator);
                return;
            }

            // Apply consistent offset based on callsign
            const offset = this.getCallsignOffset(spot.callsign);
            const adjustedLat = coords.lat + offset.lat;
            const adjustedLon = coords.lon + offset.lon;

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

            // Create custom icon (exactly as in digitalspots_map.js)
            const icon = L.divIcon({
                className: 'custom-marker',
                html: `<div style="width: 12px; height: 12px; background: ${color}; border-radius: 50%;"></div>`,
                iconSize: [12, 12],
                iconAnchor: [6, 6]
            });

            // Create marker
            const marker = L.marker([adjustedLat, adjustedLon], { icon });

            // Create popup content
            const popupContent = this.createPopupContent(spot);
            marker.bindPopup(popupContent);
            marker.bindTooltip(popupContent, {
                direction: 'top',
                offset: [0, -10]
            });

            // Add to map
            marker.addTo(this.map);

            // Store marker
            const key = `${spot.callsign}-${spot.band}-${spot.mode}`;
            this.markers.set(key, marker);
        });

        // Update legend with active bands
        this.updateLegend();
    }

    /**
     * Create popup content for a spot
     * @param {object} spot - Spot data
     * @returns {string} - HTML content
     */
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

    /**
     * Update band legend
     */
    updateLegend() {
        const legendContainer = document.getElementById('map-band-legend-items');
        if (!legendContainer) return;

        // Build legend HTML starting with receiver marker
        let html = '';
        
        // Add receiver marker legend item first
        html += `
            <div class="band-legend-item">
                <span class="band-legend-color" style="background-color: #ff0000; border: 2px solid rgba(255, 255, 255, 0.9); box-sizing: border-box;"></span>
                <span class="band-legend-label">Receiver</span>
            </div>
        `;

        // Get unique bands from current markers
        const activeBands = new Set();
        this.markers.forEach((marker, key) => {
            const band = key.split('-')[1]; // Extract band from key
            if (band) {
                activeBands.add(band);
            }
        });

        // Only show legend if we have active bands
        if (activeBands.size > 0) {
            // Sort bands in standard order
            const bandOrder = ['2200m', '630m', '160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];
            const sortedBands = Array.from(activeBands).sort((a, b) => {
                return bandOrder.indexOf(a) - bandOrder.indexOf(b);
            });

            // Add band legend items
            sortedBands.forEach(band => {
                const color = this.bandColors[band] || this.bandColors['unknown'];
                html += `
                    <div class="band-legend-item">
                        <span class="band-legend-color" style="background-color: ${color};"></span>
                        <span class="band-legend-label">${band}</span>
                    </div>
                `;
            });
        }

        legendContainer.innerHTML = html;
    }

    /**
     * Show the map container
     */
    show() {
        const mapSection = document.getElementById('map-section');
        if (mapSection) {
            mapSection.style.display = 'block';
            // Invalidate size to fix rendering issues
            if (this.map) {
                setTimeout(() => this.map.invalidateSize(), 100);
            }
        }
    }

    /**
     * Hide the map container
     */
    hide() {
        const mapSection = document.getElementById('map-section');
        if (mapSection) {
            mapSection.style.display = 'none';
        }
    }
}

// Export for use in decoder_spots_history.js
window.DecoderSpotsHistoryMap = DecoderSpotsHistoryMap;
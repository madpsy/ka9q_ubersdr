// UberSDR Instance Directory JavaScript

const BANDS = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];
const REFRESH_INTERVAL = 60000; // 60 seconds

// Global map variable
let map = null;
let markers = [];
let terminator = null;
let userMarker = null;

// User location
let userLocation = null;

// SNR thresholds for band condition classification
function getConditionClass(snr) {
    if (snr === null || snr === undefined) return 'unknown';
    if (snr < 6) return 'poor';
    if (snr < 20) return 'fair';
    if (snr < 30) return 'good';
    return 'excellent';
}

function getConditionLabel(snr) {
    if (snr === null || snr === undefined) return 'N/A';
    if (snr < 6) return 'POOR';
    if (snr < 20) return 'FAIR';
    if (snr < 30) return 'GOOD';
    return 'EXCELLENT';
}

function formatSNR(snr) {
    if (snr === null || snr === undefined) return 'N/A';
    return `${snr.toFixed(1)} dB`;
}

// Calculate distance between two coordinates using Haversine formula
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's radius in kilometers
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in kilometers
}

// Request user's geolocation
async function requestUserLocation() {
    return new Promise((resolve) => {
        if (!navigator.geolocation) {
            console.log('Geolocation is not supported by this browser');
            resolve(null);
            return;
        }

        navigator.geolocation.getCurrentPosition(
            (position) => {
                userLocation = {
                    latitude: position.coords.latitude,
                    longitude: position.coords.longitude
                };
                console.log('User location obtained:', userLocation);
                resolve(userLocation);
            },
            (error) => {
                console.log('Geolocation permission denied or error:', error.message);
                resolve(null);
            },
            {
                enableHighAccuracy: false,
                timeout: 5000,
                maximumAge: 300000 // Cache for 5 minutes
            }
        );
    });
}

function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} min ago`;
    
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
}

function createBandBadge(band, snr) {
    const condition = getConditionClass(snr);
    const label = getConditionLabel(snr);
    const snrText = formatSNR(snr);
    
    return `
        <div class="band-badge ${condition}" title="${band}: ${snrText} (${label})">
            <span>${band}</span>
        </div>
    `;
}

function createInstanceCard(instance, isClosest = false) {
    const isOnline = instance.last_report_age_seconds < 1800; // 30 minutes
    const features = [];
    
    if (instance.cw_skimmer) features.push('CW Skimmer');
    if (instance.digital_decodes) features.push('Digital');
    if (instance.noise_floor) features.push('Noise Floor');
    
    // Add distance info if user location is available
    let distanceInfo = '';
    if (userLocation && instance.distance !== undefined) {
        distanceInfo = `
            <div class="instance-info-row">
                <span class="instance-info-label">📏 Distance:</span>
                <span class="instance-info-value">${instance.distance.toFixed(0)} km</span>
            </div>
        `;
    }
    
    // Parse band conditions if available (now included directly in instance data)
    let bandBadges = '';
    if (instance.band_conditions) {
        // Band conditions are now a simple map of band name to FT8 SNR value
        bandBadges = BANDS.map(band => {
            const snr = instance.band_conditions[band];
            return createBandBadge(band, snr);
        }).join('');
    } else if (instance.noise_floor) {
        // Show "Loading..." badges if noise floor is enabled but data not yet available
        bandBadges = BANDS.map(band =>
            `<div class="band-badge unknown"><span>${band}</span><span class="band-badge-snr">...</span></div>`
        ).join('');
    }
    
    const bandSection = instance.noise_floor ? `
        <div class="band-status-section">
            <div class="band-status-header">
                <div class="band-status-title">📡 Current Band Conditions</div>
                <button class="details-btn" onclick="showNoiseFloorDetails('${instance.id}', '${instance.callsign}')">Details</button>
            </div>
            <div class="band-badges">
                ${bandBadges || '<div style="opacity: 0.7; font-size: 0.9em;">No data available</div>'}
            </div>
            ${instance.conditions_updated_at ? `<div style="margin-top: 8px; font-size: 0.8em; opacity: 0.7;">Updated: ${formatTimestamp(instance.conditions_updated_at)}</div>` : ''}
        </div>
    ` : '';
    
    return `
        <div class="instance-card ${isClosest ? 'closest-instance' : ''}">
            <div class="instance-header">
                <div class="instance-callsign">
                    ${instance.callsign}
                </div>
                <div class="instance-status">
                    ${isClosest ? '<span class="status-badge closest">Closest</span>' : ''}
                    <span class="status-badge ${instance.available_clients > 0 ? 'online' : 'offline'}">
                        👥 ${instance.available_clients}/${instance.max_clients}
                    </span>
                    <span class="status-badge ${isOnline ? 'online' : 'offline'}">
                        ${isOnline ? '● Online' : '○ Offline'}
                    </span>
                </div>
            </div>
            <div class="instance-name" style="display: flex; justify-content: space-between; align-items: center;">
                <span>${instance.name}</span>
                <button class="uuid-btn" data-uuid="${instance.id || ''}" data-callsign="${instance.callsign}" style="margin-left: auto;">UUID</button>
            </div>
            
            <div class="instance-info">
                <div class="instance-info-row">
                    <span class="instance-info-label">📍 Location:</span>
                    <span class="instance-info-value">${instance.location}</span>
                </div>
                <div class="instance-info-row">
                    <span class="instance-info-label">🌍 Coordinates:</span>
                    <span class="instance-info-value">${instance.latitude.toFixed(4)}°, ${instance.longitude.toFixed(4)}° ${instance.maidenhead ? `(${instance.maidenhead})` : ''}</span>
                </div>
                <div class="instance-info-row">
                    <span class="instance-info-label">⛰️ Altitude:</span>
                    <span class="instance-info-value">${instance.altitude}m</span>
                </div>
                <div class="instance-info-row">
                    <span class="instance-info-label">🔧 Version:</span>
                    <span class="instance-info-value">${instance.version}</span>
                </div>
                ${instance.cpu_model && instance.cpu_model !== '' ? `
                <div class="instance-info-row">
                    <span class="instance-info-label">🖥️ CPU:</span>
                    <span class="instance-info-value">${instance.cpu_model}</span>
                </div>
                ` : ''}
                ${features.length > 0 ? `
                <div class="instance-info-row">
                    <span class="instance-info-label">✨ Features:</span>
                    <span class="instance-info-value">${features.map(f => `<span class="status-badge feature">${f}</span>`).join(' ')}</span>
                </div>
                ` : ''}
                <div class="instance-info-row">
                    <span class="instance-info-label">📻 Bandwidths:</span>
                    <span class="instance-info-value">
                        ${instance.public_iq_modes && instance.public_iq_modes.length > 0
                            ? instance.public_iq_modes.map(mode => {
                                const bandwidth = mode.replace('iq', '');
                                return `<span class="status-badge feature">${bandwidth} kHz</span>`;
                            }).join(' ')
                            : '<span class="status-badge feature">None</span>'
                        }
                    </span>
                </div>
                <div class="instance-info-row">
                    <span class="instance-info-label">🕐 Session Limit:</span>
                    <span class="instance-info-value">
                        ${instance.max_session_time === 0
                            ? 'Unlimited'
                            : `${Math.floor(instance.max_session_time / 60)} minutes`
                        }
                    </span>
                </div>
                ${distanceInfo}
                <div class="instance-info-row">
                    <span class="instance-info-label">🕐 Last Seen:</span>
                    <span class="instance-info-value">${formatTimestamp(instance.last_seen)}</span>
                </div>
            </div>
            
            <div style="display: flex; gap: 10px; margin-bottom: 15px; flex-wrap: wrap;">
                <a href="${instance.public_url}" target="_blank" class="instance-link" style="margin-bottom: 0;">
                    🔗 Connect to SDR
                </a>
                ${instance.digital_decodes ? `
                <a href="${instance.public_url}/digitalspots_map.html" target="_blank" class="instance-link" style="margin-bottom: 0; background: #10b981;">
                    🌍 Live Map
                </a>
                ` : ''}
            </div>
            
            ${bandSection}
        </div>
    `;
}

async function fetchInstances() {
    try {
        // Request instances with band conditions included
        const response = await fetch('/api/instances?conditions=true');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        return data.instances || [];
    } catch (error) {
        console.error('Error fetching instances:', error);
        throw error;
    }
}

function initMap() {
    // Initialize the map centered on the world
    map = L.map('map').setView([20, 0], 2);
    
    // Add OpenStreetMap tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19
    }).addTo(map);
    
    // Add day/night terminator (grey line)
    terminator = L.terminator({
        fillOpacity: 0.3,
        color: '#000',
        weight: 2
    }).addTo(map);
    
    // Update terminator every minute
    setInterval(function() {
        if (terminator && map) {
            terminator.setTime();
        }
    }, 60000);
}

function updateMap(instances) {
    if (!map) {
        initMap();
    }
    
    // Clear existing markers
    markers.forEach(marker => map.removeLayer(marker));
    markers = [];
    
    // Add user location marker if available
    if (userLocation) {
        if (userMarker) {
            map.removeLayer(userMarker);
        }
        
        // Create a custom icon for user location (blue circle with pulse)
        const userIconHtml = `
            <div style="position: relative;">
                <div style="
                    background-color: #3b82f6;
                    width: 16px;
                    height: 16px;
                    border-radius: 50%;
                    border: 3px solid white;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.4);
                "></div>
                <div style="
                    position: absolute;
                    top: -4px;
                    left: -4px;
                    background-color: rgba(59, 130, 246, 0.3);
                    width: 24px;
                    height: 24px;
                    border-radius: 50%;
                    animation: pulse-ring 2s ease-out infinite;
                "></div>
            </div>
        `;
        
        const userIcon = L.divIcon({
            html: userIconHtml,
            className: 'user-location-marker',
            iconSize: [24, 24],
            iconAnchor: [12, 12],
            popupAnchor: [0, -12]
        });
        
        userMarker = L.marker([userLocation.latitude, userLocation.longitude], { icon: userIcon }).addTo(map);
        
        userMarker.bindPopup(`
            <div style="font-family: sans-serif; min-width: 150px;">
                <h3 style="margin: 0 0 8px 0; font-size: 1.1em;">📍 Your Location</h3>
                <p style="margin: 0; font-size: 0.85em; color: #666;">
                    ${userLocation.latitude.toFixed(4)}°, ${userLocation.longitude.toFixed(4)}°
                </p>
            </div>
        `);
        
        userMarker.bindTooltip('📍 You are here', {
            direction: 'top',
            offset: [0, -12],
            permanent: false
        });
    }
    
    if (instances.length === 0) {
        return;
    }
    
    // Add markers for each instance
    const bounds = [];
    
    // Add user location to bounds if available
    if (userLocation) {
        bounds.push([userLocation.latitude, userLocation.longitude]);
    }
    
    instances.forEach(instance => {
        const lat = instance.latitude;
        const lon = instance.longitude;
        
        // Create marker with custom icon based on online status
        const isOnline = instance.last_report_age_seconds < 1800;
        const iconColor = isOnline ? 'green' : 'red';
        
        // Create custom icon HTML
        const iconHtml = `
            <div style="
                background-color: ${iconColor};
                width: 24px;
                height: 24px;
                border-radius: 50% 50% 50% 0;
                transform: rotate(-45deg);
                border: 2px solid white;
                box-shadow: 0 2px 4px rgba(0,0,0,0.3);
            "></div>
        `;
        
        const customIcon = L.divIcon({
            html: iconHtml,
            className: 'custom-marker',
            iconSize: [24, 24],
            iconAnchor: [12, 24],
            popupAnchor: [0, -24]
        });
        
        const marker = L.marker([lat, lon], { icon: customIcon }).addTo(map);
        
        // Create popup content
        const popupContent = `
            <div style="font-family: sans-serif; min-width: 200px;">
                <h3 style="margin: 0 0 8px 0; font-size: 1.1em;">${instance.callsign}</h3>
                <p style="margin: 0 0 4px 0; font-size: 0.9em;">${instance.name}</p>
                <p style="margin: 0; font-size: 0.85em; color: #666;">${instance.location}</p>
                <p style="margin: 8px 0 0 0; font-size: 0.85em;">
                    <strong>Status:</strong> <span style="color: ${isOnline ? 'green' : 'red'};">${isOnline ? 'Online' : 'Offline'}</span>
                </p>
                <a href="${instance.public_url}" target="_blank" style="
                    display: inline-block;
                    margin-top: 8px;
                    padding: 6px 12px;
                    background: #3b82f6;
                    color: white;
                    text-decoration: none;
                    border-radius: 4px;
                    font-size: 0.85em;
                ">Connect</a>
            </div>
        `;
        
        marker.bindPopup(popupContent);
        
        // Bind tooltip with callsign and name
        marker.bindTooltip(`<strong>${instance.callsign}</strong><br>${instance.name}`, {
            direction: 'top',
            offset: [0, -20]
        });
        
        markers.push(marker);
        bounds.push([lat, lon]);
    });
    
    // Fit map to show all markers
    if (bounds.length > 0) {
        map.fitBounds(bounds, { padding: [50, 50] });
    }
}

async function loadAndDisplayInstances() {
    const statusEl = document.getElementById('status');
    const containerEl = document.getElementById('instances-container');
    
    try {
        statusEl.textContent = 'Loading instances...';
        statusEl.className = 'status-bar loading';
        
        const instances = await fetchInstances();
        
        if (instances.length === 0) {
            containerEl.innerHTML = '<div class="no-instances">No instances currently registered. Check back later!</div>';
            statusEl.textContent = 'No instances found';
            statusEl.className = 'status-bar';
            return;
        }
        
        // Calculate distances if user location is available
        if (userLocation) {
            instances.forEach(instance => {
                instance.distance = calculateDistance(
                    userLocation.latitude,
                    userLocation.longitude,
                    instance.latitude,
                    instance.longitude
                );
            });
            
            // Sort instances by distance (closest first)
            instances.sort((a, b) => a.distance - b.distance);
        }
        
        // Create instance cards - mark the first one as closest if user location is available
        // Band conditions are now included directly in the instance data (no separate fetch needed)
        const cards = instances.map((instance, index) =>
            createInstanceCard(instance, userLocation && index === 0)
        ).join('');
        
        containerEl.innerHTML = cards;
        
        // Update the map with instance locations
        updateMap(instances);
        
        let statusText = `${instances.length} instance${instances.length !== 1 ? 's' : ''} found`;
        if (userLocation) {
            statusText += ` • Sorted by distance from your location`;
        }
        statusText += ` • Last updated: ${new Date().toLocaleTimeString()}`;
        statusEl.textContent = statusText;
        statusEl.className = 'status-bar success';
        
    } catch (error) {
        console.error('Error loading instances:', error);
        statusEl.textContent = `Error loading instances: ${error.message}`;
        statusEl.className = 'status-bar error';
        containerEl.innerHTML = '<div class="no-instances">Failed to load instances. Please try again later.</div>';
    }
}

// Wait for DOM to be ready before executing
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

async function init() {
    // Request user location first (non-blocking)
    await requestUserLocation();
    
    // Initial load
    await loadAndDisplayInstances();

    // Refresh periodically
    setInterval(loadAndDisplayInstances, REFRESH_INTERVAL);
}

// Show noise floor details modal
async function showNoiseFloorDetails(instanceId, callsign) {
    const modal = document.getElementById('noiseFloorModal');
    const modalTitle = document.getElementById('modalTitle');
    const modalContent = document.getElementById('modalContent');
    
    // Show modal with loading state
    modal.classList.add('active');
    modalTitle.textContent = `Noise Floor Details - ${callsign}`;
    modalContent.innerHTML = `
        <div class="modal-loading">
            <div class="modal-spinner"></div>
            <p>Loading noise floor data...</p>
        </div>
    `;
    
    try {
        const response = await fetch(`/api/noisefloor/${instanceId}`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const noiseFloorData = await response.json();
        
        // Display the noise floor data
        displayNoiseFloorData(noiseFloorData, modalContent);
        
    } catch (error) {
        console.error('Error fetching noise floor data:', error);
        modalContent.innerHTML = `
            <div class="modal-error">
                <p>❌ Failed to load noise floor data</p>
                <p style="font-size: 0.9em; margin-top: 10px;">${error.message}</p>
            </div>
        `;
    }
}

// Display noise floor data in modal
function displayNoiseFloorData(noiseFloorData, container) {
    const data = noiseFloorData.data;
    const updatedAt = noiseFloorData.updated_at;
    
    // Sort bands by frequency (using a predefined order)
    const bandOrder = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '2m'];
    const sortedBands = Object.keys(data).sort((a, b) => {
        const aIndex = bandOrder.indexOf(a);
        const bIndex = bandOrder.indexOf(b);
        if (aIndex === -1) return 1;
        if (bIndex === -1) return -1;
        return aIndex - bIndex;
    });
    
    let html = '<div class="noise-floor-grid">';
    
    for (const band of sortedBands) {
        const bandData = data[band];
        
        html += `
            <div class="noise-floor-card">
                <h3>${band}</h3>
                <div class="noise-floor-metric">
                    <span class="noise-floor-metric-label">Min Level:</span>
                    <span class="noise-floor-metric-value">${bandData.min_db?.toFixed(1) ?? 'N/A'} dB</span>
                </div>
                <div class="noise-floor-metric">
                    <span class="noise-floor-metric-label">Max Level:</span>
                    <span class="noise-floor-metric-value">${bandData.max_db?.toFixed(1) ?? 'N/A'} dB</span>
                </div>
                <div class="noise-floor-metric">
                    <span class="noise-floor-metric-label">Mean:</span>
                    <span class="noise-floor-metric-value">${bandData.mean_db?.toFixed(1) ?? 'N/A'} dB</span>
                </div>
                <div class="noise-floor-metric">
                    <span class="noise-floor-metric-label">Median:</span>
                    <span class="noise-floor-metric-value">${bandData.median_db?.toFixed(1) ?? 'N/A'} dB</span>
                </div>
                <div class="noise-floor-metric">
                    <span class="noise-floor-metric-label">P5:</span>
                    <span class="noise-floor-metric-value">${bandData.p5_db?.toFixed(1) ?? 'N/A'} dB</span>
                </div>
                <div class="noise-floor-metric">
                    <span class="noise-floor-metric-label">P10:</span>
                    <span class="noise-floor-metric-value">${bandData.p10_db?.toFixed(1) ?? 'N/A'} dB</span>
                </div>
                <div class="noise-floor-metric">
                    <span class="noise-floor-metric-label">P95:</span>
                    <span class="noise-floor-metric-value">${bandData.p95_db?.toFixed(1) ?? 'N/A'} dB</span>
                </div>
                <div class="noise-floor-metric">
                    <span class="noise-floor-metric-label">Dynamic Range:</span>
                    <span class="noise-floor-metric-value">${bandData.dynamic_range?.toFixed(1) ?? 'N/A'} dB</span>
                </div>
                <div class="noise-floor-metric">
                    <span class="noise-floor-metric-label">Occupancy:</span>
                    <span class="noise-floor-metric-value">${bandData.occupancy_pct?.toFixed(1) ?? 'N/A'}%</span>
                </div>
                <div class="noise-floor-metric">
                    <span class="noise-floor-metric-label">FT8 SNR:</span>
                    <span class="noise-floor-metric-value" style="color: ${getBandConditionColor(bandData.ft8_snr)}">${bandData.ft8_snr?.toFixed(1) ?? 'N/A'} dB</span>
                </div>
            </div>
        `;
    }
    
    html += '</div>';
    
    // Add timestamp
    const date = new Date(updatedAt);
    html += `
        <div class="modal-timestamp">
            Last updated: ${date.toLocaleString()}
        </div>
    `;
    
    container.innerHTML = html;
}

// Get color for band condition based on SNR
function getBandConditionColor(snr) {
    if (snr === null || snr === undefined) return '#9ca3af';
    if (snr < 6) return '#ef4444';
    if (snr < 20) return '#ff9800';
    if (snr < 30) return '#fbbf24';
    return '#22c55e';
}

// Close noise floor modal
function closeNoiseFloorModal() {
    const modal = document.getElementById('noiseFloorModal');
    modal.classList.remove('active');
}

// Show UUID modal
let currentUUID = '';

// Expose functions globally for onclick handlers
window.showUUIDModal = function(uuid, callsign) {
    const modal = document.getElementById('uuidModal');
    const modalTitle = document.getElementById('uuidModalTitle');
    const uuidDisplay = document.getElementById('uuidDisplay');
    const copyBtn = document.getElementById('copyUUIDBtn');
    
    currentUUID = uuid;
    modalTitle.textContent = `Instance UUID - ${callsign}`;
    
    if (uuid && uuid !== '') {
        uuidDisplay.textContent = uuid;
        uuidDisplay.style.opacity = '1';
    } else {
        uuidDisplay.textContent = 'No UUID available';
        uuidDisplay.style.opacity = '0.5';
    }
    
    // Reset copy button
    copyBtn.textContent = '📋 Copy to Clipboard';
    copyBtn.classList.remove('copied');
    
    modal.classList.add('active');
};

// Close UUID modal
window.closeUUIDModal = function() {
    const modal = document.getElementById('uuidModal');
    modal.classList.remove('active');
    currentUUID = '';
};

// Copy UUID to clipboard
window.copyUUID = async function() {
    const copyBtn = document.getElementById('copyUUIDBtn');
    
    if (!currentUUID || currentUUID === '') {
        return;
    }
    
    try {
        await navigator.clipboard.writeText(currentUUID);
        copyBtn.textContent = '✓ Copied!';
        copyBtn.classList.add('copied');
        
        // Reset button after 2 seconds
        setTimeout(() => {
            copyBtn.textContent = '📋 Copy to Clipboard';
            copyBtn.classList.remove('copied');
        }, 2000);
    } catch (err) {
        console.error('Failed to copy UUID:', err);
        copyBtn.textContent = '❌ Failed to copy';
        
        // Reset button after 2 seconds
        setTimeout(() => {
            copyBtn.textContent = '📋 Copy to Clipboard';
        }, 2000);
    }
};

// Close modals when clicking outside - setup after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    console.log('Setting up modal event listeners');
    
    // Add event delegation for UUID buttons - use capture phase to catch before inline handlers
    document.addEventListener('click', (e) => {
        // Check if the clicked element or its parent is a uuid-btn
        const uuidBtn = e.target.closest('.uuid-btn');
        if (uuidBtn) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            const uuid = uuidBtn.dataset.uuid;
            const callsign = uuidBtn.dataset.callsign;
            console.log('UUID button clicked:', uuid, callsign);
            window.showUUIDModal(uuid, callsign);
            return false;
        }
    }, true); // Use capture phase
    
    const noiseFloorModal = document.getElementById('noiseFloorModal');
    if (noiseFloorModal) {
        noiseFloorModal.addEventListener('click', (e) => {
            if (e.target === noiseFloorModal) {
                closeNoiseFloorModal();
            }
        });
    }
    
    const uuidModal = document.getElementById('uuidModal');
    if (uuidModal) {
        uuidModal.addEventListener('click', (e) => {
            if (e.target === uuidModal) {
                window.closeUUIDModal();
            }
        });
    }
});
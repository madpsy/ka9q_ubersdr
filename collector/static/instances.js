// UberSDR Instance Directory JavaScript

const BANDS = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];
const REFRESH_INTERVAL = 60000; // 60 seconds

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
        <div class="band-badge ${condition}" title="${band}: ${snrText}">
            <span>${band}</span>
            <span class="band-badge-snr">${label}</span>
        </div>
    `;
}

function createInstanceCard(instance, noiseFloorData) {
    const isOnline = instance.last_report_age_seconds < 1800; // 30 minutes
    const features = [];
    
    if (instance.cw_skimmer) features.push('CW Skimmer');
    if (instance.digital_decodes) features.push('Digital');
    if (instance.noise_floor) features.push('Noise Floor');
    
    // Parse noise floor data if available
    let bandBadges = '';
    if (noiseFloorData && noiseFloorData.data && noiseFloorData.data.bands) {
        const bands = noiseFloorData.data.bands;
        bandBadges = BANDS.map(band => {
            const bandData = bands[band];
            const snr = bandData ? bandData.snr : null;
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
            <div class="band-status-title">📡 Current Band Conditions</div>
            <div class="band-badges">
                ${bandBadges || '<div style="opacity: 0.7; font-size: 0.9em;">No data available</div>'}
            </div>
            ${noiseFloorData ? `<div style="margin-top: 8px; font-size: 0.8em; opacity: 0.7;">Updated: ${formatTimestamp(noiseFloorData.updated_at)}</div>` : ''}
        </div>
    ` : '';
    
    return `
        <div class="instance-card">
            <div class="instance-header">
                <div class="instance-title">
                    <div class="instance-callsign">${instance.callsign}</div>
                    <div class="instance-name">${instance.name}</div>
                </div>
                <div class="instance-status">
                    <span class="status-badge ${isOnline ? 'online' : 'offline'}">
                        ${isOnline ? '● Online' : '○ Offline'}
                    </span>
                </div>
            </div>
            
            <div class="instance-info">
                <div class="instance-info-row">
                    <span class="instance-info-label">📍 Location:</span>
                    <span class="instance-info-value">${instance.location}</span>
                </div>
                <div class="instance-info-row">
                    <span class="instance-info-label">🌍 Coordinates:</span>
                    <span class="instance-info-value">${instance.latitude.toFixed(4)}°, ${instance.longitude.toFixed(4)}°</span>
                </div>
                <div class="instance-info-row">
                    <span class="instance-info-label">⛰️ Altitude:</span>
                    <span class="instance-info-value">${instance.altitude}m</span>
                </div>
                <div class="instance-info-row">
                    <span class="instance-info-label">🔧 Version:</span>
                    <span class="instance-info-value">${instance.version}</span>
                </div>
                ${features.length > 0 ? `
                <div class="instance-info-row">
                    <span class="instance-info-label">✨ Features:</span>
                    <span class="instance-info-value">${features.map(f => `<span class="status-badge feature">${f}</span>`).join(' ')}</span>
                </div>
                ` : ''}
                <div class="instance-info-row">
                    <span class="instance-info-label">🕐 Last Seen:</span>
                    <span class="instance-info-value">${formatTimestamp(instance.last_seen)}</span>
                </div>
            </div>
            
            <a href="${instance.public_url}" target="_blank" class="instance-link">
                🔗 Connect to SDR
            </a>
            
            ${bandSection}
        </div>
    `;
}

async function fetchInstances() {
    try {
        // Use ?all=true to show all instances, not just those seen in last 30 minutes
        const response = await fetch('/api/instances?all=true');
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

async function fetchNoiseFloor(publicUUID) {
    try {
        const response = await fetch(`/api/noisefloor/${publicUUID}`);
        if (!response.ok) {
            if (response.status === 404) {
                return null; // No noise floor data available yet
            }
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
    } catch (error) {
        console.error(`Error fetching noise floor for ${publicUUID}:`, error);
        return null;
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
        
        // Fetch noise floor data for instances that have it enabled
        const noiseFloorPromises = instances.map(async (instance) => {
            if (instance.noise_floor) {
                return {
                    id: instance.id,
                    data: await fetchNoiseFloor(instance.id)
                };
            }
            return { id: instance.id, data: null };
        });
        
        const noiseFloorResults = await Promise.all(noiseFloorPromises);
        const noiseFloorMap = {};
        noiseFloorResults.forEach(result => {
            noiseFloorMap[result.id] = result.data;
        });
        
        // Create instance cards
        const cards = instances.map(instance => 
            createInstanceCard(instance, noiseFloorMap[instance.id])
        ).join('');
        
        containerEl.innerHTML = cards;
        
        statusEl.textContent = `${instances.length} instance${instances.length !== 1 ? 's' : ''} found • Last updated: ${new Date().toLocaleTimeString()}`;
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

function init() {
    // Initial load
    loadAndDisplayInstances();

    // Refresh periodically
    setInterval(loadAndDisplayInstances, REFRESH_INTERVAL);
}
/**
 * UberSDR Rotator UI Component
 * Adds a collapsible rotator panel to the main page (left side)
 * Requires: rotator-display.js library
 */

class RotatorUI {
    constructor() {
        this.isExpanded = false;
        this.rotatorDisplay = null;
        this.statusUpdateTimer = null;
        this.countriesData = []; // Store countries data for cone markers
        this.savedPassword = localStorage.getItem('rotctl_password') || ''; // Load saved password

        // Load saved state from localStorage
        const savedState = localStorage.getItem('ubersdr_rotator_expanded');
        this.isExpanded = savedState === 'true';
        
        this.createRotatorPanel();
        this.setupEventHandlers();
        
        // Start fetching status immediately for collapsed tab display
        this.startStatusUpdates();
    }
    
    /**
     * Start periodic status updates for the collapsed tab
     */
    startStatusUpdates() {
        // Do an immediate fetch
        this.fetchRotatorStatus();
        
        // Set up periodic updates every 1 second (same as rotator.html)
        this.statusUpdateTimer = setInterval(() => {
            this.fetchRotatorStatus();
        }, 1000);
    }
    
    /**
     * Stop periodic status updates
     */
    stopStatusUpdates() {
        if (this.statusUpdateTimer) {
            clearInterval(this.statusUpdateTimer);
            this.statusUpdateTimer = null;
        }
    }
    
    /**
     * Create the rotator panel HTML and inject into page
     */
    createRotatorPanel() {
        const rotatorHTML = `
            <div id="rotator-panel" class="rotator-panel ${this.isExpanded ? 'expanded' : 'collapsed'}">
                <!-- Rotator tab (always visible, on left edge) -->
                <div id="rotator-header" class="rotator-header" onclick="rotatorUI.togglePanel()">
                    <span id="rotator-tab-bearing" class="rotator-tab-bearing" style="display:${this.isExpanded ? 'none' : 'block'};">0°</span>
                    <span>🧭</span>
                    <span id="rotator-tab-status" class="rotator-tab-status disconnected" style="display:${this.isExpanded ? 'none' : 'block'};"></span>
                    <span id="rotator-collapse-arrow" class="rotator-collapse-arrow" style="display:${this.isExpanded ? 'block' : 'none'};">←</span>
                </div>
                
                <!-- Rotator content (slides out from left) -->
                <div id="rotator-content" class="rotator-content" style="display:${this.isExpanded ? 'flex' : 'none'};">
                    <div id="rotator-display-container" class="rotator-display-container">
                        <!-- Rotator display will be injected here -->
                        <div id="rotator-location-display" class="rotator-location-display">Loading...</div>
                        <div id="rotator-azimuth-display" class="rotator-azimuth-display">0°</div>
                        <div id="rotator-status-indicator" class="rotator-status-indicator disconnected"></div>
                        <button id="rotator-controls-button" class="rotator-controls-button" onclick="rotatorUI.openControls()">
                            Controls
                        </button>
                    </div>
                </div>
            </div>
        `;
        
        // Inject CSS
        this.injectCSS();
        
        // Inject HTML before time display (bottom left)
        const timeDisplay = document.getElementById('time-display');
        if (timeDisplay && timeDisplay.parentNode) {
            timeDisplay.insertAdjacentHTML('beforebegin', rotatorHTML);
        } else {
            // Fallback: append to body
            document.body.insertAdjacentHTML('beforeend', rotatorHTML);
        }
        
        // Initialize rotator display if expanded on load
        if (this.isExpanded) {
            this.initializeRotatorDisplay();
        }
    }
    
    /**
     * Inject CSS styles for rotator panel
     */
    injectCSS() {
        const style = document.createElement('style');
        style.textContent = `
            .rotator-panel {
                position: fixed;
                bottom: 50px;
                left: 0;
                z-index: 900;
                font-family: Arial, sans-serif;
                font-size: 13px;
                display: flex;
                flex-direction: row;
                align-items: flex-end;
                transition: all 0.3s ease;
            }
            
            .rotator-panel.collapsed {
                width: 40px;
            }
            
            .rotator-panel.expanded {
                width: min(540px, 100vw);
                max-width: 100vw;
            }
            
            .rotator-header {
                width: 40px;
                height: 100px;
                padding: 8px 0;
                background: rgba(50, 50, 50, 0.7);
                color: #fff;
                cursor: pointer;
                user-select: none;
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                gap: 6px;
                font-size: 20px;
                border: 1px solid rgba(100, 100, 100, 0.5);
                border-left: none;
                border-radius: 0 8px 8px 0;
                order: 1;
                flex-shrink: 0;
                position: relative;
                overflow: visible;
            }
            
            .rotator-tab-bearing {
                font-size: 11px;
                font-weight: 600;
                color: #fff;
                line-height: 1;
            }
            
            .rotator-tab-status {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                transition: background 0.3s, box-shadow 0.3s;
            }
            
            .rotator-tab-status.connected {
                background: #4CAF50;
                box-shadow: 0 0 6px #4CAF50;
            }
            
            .rotator-tab-status.disconnected {
                background: #f44336;
                box-shadow: 0 0 6px #f44336;
            }
            
            /* Flashing animation for moving state */
            @keyframes flash {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.3; }
            }

            .rotator-tab-status.moving,
            .rotator-status-indicator.moving {
                animation: flash 1s infinite;
            }

            .rotator-header:hover {
                background: rgba(70, 70, 70, 0.6);
            }
            
            .rotator-collapse-arrow {
                position: absolute;
                bottom: 8px;
                left: 50%;
                transform: translateX(-50%);
                font-size: 20px;
                color: #fff;
                font-weight: bold;
                z-index: 10;
                pointer-events: none;
            }
            
            .rotator-content {
                width: min(500px, calc(100vw - 40px));
                max-width: 100%;
                height: 500px;
                background: rgba(40, 40, 40, 0.7);
                border: 1px solid rgba(100, 100, 100, 0.6);
                border-left: none;
                border-radius: 0 8px 8px 0;
                order: 2;
                flex-shrink: 0;
                overflow: hidden;
            }
            
            .rotator-display-container {
                width: 100%;
                height: 100%;
                padding: 0;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                align-items: center;
                position: relative;
            }
            
            /* Position compass overlay on top-left of map */
            #rotator-display-container-compass {
                position: absolute !important;
                top: 20px !important;
                left: 20px !important;
                z-index: 100 !important;
                margin: 0 !important;
            }
            
            /* Location display in top-center */
            .rotator-location-display {
                position: absolute;
                top: 10px;
                left: 50%;
                transform: translateX(-50%);
                padding: 6px 12px;
                background: rgba(0, 0, 0, 0.6);
                color: white;
                border-radius: 6px;
                font-size: 12px;
                font-weight: 500;
                z-index: 100;
                box-shadow: 0 2px 6px rgba(0,0,0,0.3);
                text-align: center;
                line-height: 1.4;
                max-width: 80%;
            }
            
            /* Azimuth display in top-right */
            .rotator-azimuth-display {
                position: absolute;
                top: 20px;
                right: 20px;
                padding: 8px 12px;
                background: rgba(0, 0, 0, 0.6);
                color: white;
                border-radius: 6px;
                font-size: 16px;
                font-weight: 600;
                z-index: 100;
                box-shadow: 0 2px 6px rgba(0,0,0,0.3);
                min-width: 50px;
                text-align: center;
            }
            
            /* Status indicator in bottom-right */
            .rotator-status-indicator {
                position: absolute;
                bottom: 15px;
                right: 15px;
                width: 12px;
                height: 12px;
                border-radius: 50%;
                z-index: 100;
                transition: background 0.3s, box-shadow 0.3s;
            }
            
            .rotator-status-indicator.connected {
                background: #4CAF50;
                box-shadow: 0 0 10px #4CAF50;
            }
            
            .rotator-status-indicator.disconnected {
                background: #f44336;
                box-shadow: 0 0 10px #f44336;
            }
            
            /* Controls button in bottom-left */
            .rotator-controls-button {
                position: absolute;
                bottom: 10px;
                left: 10px;
                padding: 8px 16px;
                background: rgba(76, 175, 80, 0.9);
                color: white;
                border: none;
                border-radius: 6px;
                font-size: 13px;
                font-weight: 600;
                cursor: pointer;
                z-index: 100;
                transition: all 0.2s;
                box-shadow: 0 2px 6px rgba(0,0,0,0.3);
            }
            
            .rotator-controls-button:hover {
                background: rgba(76, 175, 80, 1);
                transform: translateY(-1px);
                box-shadow: 0 3px 8px rgba(0,0,0,0.4);
            }
            
            .rotator-controls-button:active {
                transform: translateY(0);
            }
            
            /* Mobile responsive styles */
            @media (max-width: 768px) {
                .rotator-panel.expanded {
                    width: 100vw;
                    left: 0;
                }
                
                .rotator-content {
                    width: calc(100vw - 40px);
                    height: 400px;
                }
            }
            
            @media (max-width: 480px) {
                .rotator-content {
                    height: 350px;
                }
            }
        `;
        document.head.appendChild(style);
    }
    
    /**
     * Set up DOM event handlers
     */
    setupEventHandlers() {
        // Panel toggle is handled via onclick in HTML
    }
    
    /**
     * Toggle rotator panel expanded/collapsed
     */
    togglePanel() {
        this.isExpanded = !this.isExpanded;
        const panel = document.getElementById('rotator-panel');
        const content = document.getElementById('rotator-content');
        const arrow = document.getElementById('rotator-collapse-arrow');
        const tabBearing = document.getElementById('rotator-tab-bearing');
        const tabStatus = document.getElementById('rotator-tab-status');
        
        if (this.isExpanded) {
            panel.classList.remove('collapsed');
            panel.classList.add('expanded');
            content.style.display = 'flex';
            if (arrow) arrow.style.display = 'block';
            if (tabBearing) tabBearing.style.display = 'none';
            if (tabStatus) tabStatus.style.display = 'none';
            
            // Initialize rotator display if not already done
            if (!this.rotatorDisplay) {
                this.initializeRotatorDisplay();
            } else {
                // Resume updates if already initialized
                if (this.rotatorDisplay.updateTimer === null && this.rotatorDisplay.updateInterval > 0) {
                    this.rotatorDisplay.startUpdates();
                }
                // Do an immediate fetch
                this.fetchRotatorStatus();
            }
        } else {
            panel.classList.remove('expanded');
            panel.classList.add('collapsed');
            content.style.display = 'none';
            if (arrow) arrow.style.display = 'none';
            if (tabBearing) tabBearing.style.display = 'block';
            if (tabStatus) tabStatus.style.display = 'block';
            
            // Keep updates running when collapsed to show bearing on tab
            // (updates continue but map is hidden)
        }
        
        // Save state to localStorage
        localStorage.setItem('ubersdr_rotator_expanded', this.isExpanded.toString());
    }
    
    /**
     * Initialize the rotator display component
     */
    initializeRotatorDisplay() {
        if (typeof RotatorDisplay === 'undefined') {
            console.error('[RotatorUI] RotatorDisplay class not found. Make sure rotator-display.js is loaded.');
            return;
        }
        
        // Create rotator display with map and compass, no controls
        // Set updateInterval to 0 to disable automatic fetching - we'll update manually
        this.rotatorDisplay = new RotatorDisplay({
            containerId: 'rotator-display-container',
            showMap: true,
            showCompass: true,
            showControls: false,
            showPassword: false,
            mapSize: 500,
            compassSize: 150,
            updateInterval: 0  // Disable automatic updates, we handle them in rotator-ui.js
        });
        
        // Fetch and display location
        this.fetchReceiverLocation();
        
        // Fetch countries for cone markers
        this.fetchCountries();

        // Listen for rotator status updates from RotatorDisplay
        document.addEventListener('rotator-status-update', (event) => {
            this.handleStatusUpdate(event.detail);
        });
        
        // Listen for map click events from RotatorDisplay
        document.addEventListener('rotator-map-click', (event) => {
            this.handleMapClick(event.detail);
        });

        // Do an initial status fetch
        this.fetchRotatorStatus();
    }
    
    /**
     * Fetch rotator status and update displays
     */
    async fetchRotatorStatus() {
        try {
            const response = await fetch('/api/rotctl/status');
            const data = await response.json();
            this.handleStatusUpdate(data);
        } catch (error) {
            console.error('[RotatorUI] Failed to fetch rotator status:', error);
            this.handleStatusUpdate({ connected: false });
        }
    }
    
    /**
     * Handle status update from RotatorDisplay or direct fetch
     */
    handleStatusUpdate(data) {
        // Update azimuth in expanded view
        if (data.position && data.position.azimuth !== undefined) {
            const azimuthElement = document.getElementById('rotator-azimuth-display');
            if (azimuthElement) {
                azimuthElement.textContent = Math.round(data.position.azimuth) + '°';
            }
            
            // Update bearing on collapsed tab button
            const tabBearing = document.getElementById('rotator-tab-bearing');
            if (tabBearing) {
                tabBearing.textContent = Math.round(data.position.azimuth) + '°';
            }

            // Manually update the rotator display azimuth
            if (this.rotatorDisplay) {
                this.rotatorDisplay.updateAzimuthDisplay(data.position.azimuth);
            }

            // Update cone markers to show countries in current beam direction
            if (this.rotatorDisplay && this.countriesData.length > 0) {
                this.rotatorDisplay.updateConeMarkers(this.countriesData, data.position.azimuth);
            }
        }
        
        // Update status indicator in expanded view
        const statusIndicator = document.getElementById('rotator-status-indicator');
        if (statusIndicator) {
            let className = 'rotator-status-indicator';
            if (data.connected) {
                className += ' connected';
                statusIndicator.title = 'Connected';
            } else {
                className += ' disconnected';
                statusIndicator.title = 'Disconnected';
            }
            // Add moving class if rotator is moving
            if (data.moving) {
                className += ' moving';
                statusIndicator.title += ' (Moving)';
            }
            statusIndicator.className = className;
        }
        
        // Update status indicator on collapsed tab button
        const tabStatus = document.getElementById('rotator-tab-status');
        if (tabStatus) {
            let className = 'rotator-tab-status';
            if (data.connected) {
                className += ' connected';
            } else {
                className += ' disconnected';
            }
            // Add moving class if rotator is moving
            if (data.moving) {
                className += ' moving';
            }
            tabStatus.className = className;
        }
    }
    
    /**
     * Fetch receiver location and display it
     */
    async fetchReceiverLocation() {
        try {
            const response = await fetch('/api/description');
            const data = await response.json();
            
            const locationElement = document.getElementById('rotator-location-display');
            if (!locationElement) return;
            
            if (data.receiver && data.receiver.gps) {
                const lat = data.receiver.gps.lat.toFixed(4);
                const lon = data.receiver.gps.lon.toFixed(4);
                
                // Format: coordinates on top, location name below
                if (data.receiver.location) {
                    locationElement.innerHTML = `${lat}, ${lon}<br>${data.receiver.location}`;
                } else {
                    locationElement.textContent = `${lat}, ${lon}`;
                }
            } else {
                locationElement.textContent = 'Location N/A';
            }
        } catch (error) {
            console.error('[RotatorUI] Failed to fetch receiver location:', error);
            const locationElement = document.getElementById('rotator-location-display');
            if (locationElement) {
                locationElement.textContent = 'Location Error';
            }
        }
    }
    
    /**
     * Fetch countries data for cone markers
     */
    async fetchCountries() {
        try {
            const response = await fetch('/api/rotctl/countries');
            const data = await response.json();

            if (data.success && data.countries) {
                this.countriesData = data.countries;

                // Pass countries data to rotator display for tooltip
                if (this.rotatorDisplay) {
                    this.rotatorDisplay.setCountriesData(data.countries);
                }
            } else {
                console.error('[RotatorUI] Failed to fetch countries:', data.error);
            }
        } catch (error) {
            console.error('[RotatorUI] Failed to fetch countries:', error);
        }
    }

    /**
     * Handle map click event
     */
    async handleMapClick(detail) {
        const bearing = detail.bearing;
        const distance = detail.distance;

        // Check if password is available, recheck localStorage if not
        if (!this.savedPassword) {
            this.savedPassword = localStorage.getItem('rotctl_password') || '';
            if (!this.savedPassword) {
                console.log('[RotatorUI] No password available. Click "Controls" button to set password.');
                return;
            }
        }

        // Find the closest country by bearing and distance (same as rotator.html)
        if (this.countriesData.length > 0 && this.rotatorDisplay) {
            const closestCountry = this.rotatorDisplay.findClosestCountry(bearing, distance);
            if (closestCountry) {
                // Get current azimuth for cone calculation
                try {
                    const statusResponse = await fetch('/api/rotctl/status');
                    const statusData = await statusResponse.json();
                    const currentAzimuth = statusData.position?.azimuth || 0;

                    // Show marker on map with cone markers
                    // Pass closestCountry.bearing to showCountryMarker so it can be excluded from cone markers
                    this.rotatorDisplay.showCountryMarker(
                        closestCountry.name,
                        closestCountry.bearing,
                        closestCountry.distance_km,
                        this.countriesData,
                        currentAzimuth
                    );
                } catch (error) {
                    console.error('[RotatorUI] Failed to get current azimuth for marker:', error);
                }
            }
        }

        // Send command to rotator with the exact cursor bearing (not country center)
        try {
            const response = await fetch('/api/rotctl/position', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    password: this.savedPassword,
                    azimuth: bearing
                })
            });

            const data = await response.json();

            if (data.success) {
                console.log(`[RotatorUI] Moving to ${bearing}°`);
            } else {
                console.error('[RotatorUI] Failed to set azimuth:', data.error);
                // If password is wrong, clear it
                if (data.error && data.error.toLowerCase().includes('password')) {
                    this.savedPassword = '';
                    localStorage.removeItem('rotctl_password');
                }
            }
        } catch (error) {
            console.error('[RotatorUI] Network error:', error);
        }
    }

    /**
     * Open rotator controls in a new tab
     */
    openControls() {
        window.open('/rotator.html', '_blank');
    }
    
    /**
     * Destroy the rotator display
     */
    destroy() {
        if (this.rotatorDisplay) {
            this.rotatorDisplay.destroy();
            this.rotatorDisplay = null;
        }
    }
}

// Global instance (will be initialized when rotator is enabled)
let rotatorUI = null;

/**
 * Initialize rotator UI
 * Call this after checking if rotator is enabled
 */
function initializeRotatorUI() {
    if (!rotatorUI) {
        rotatorUI = new RotatorUI();
        // Expose globally for debugging and access
        window.rotatorUI = rotatorUI;
    }
}

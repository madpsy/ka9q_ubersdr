// DX Cluster Extension for ka9q UberSDR
// Displays real-time DX spots from amateur radio DX clusters

// Global array for DX spot positions (for spectrum display)
let dxSpotPositions = [];
window.dxSpotPositions = dxSpotPositions;

// Global reference to the extension instance
let dxClusterExtensionInstance = null;

class DXClusterExtension extends DecoderExtension {
    constructor() {
        super('dx-cluster', {
            displayName: 'DX Cluster',
            autoTune: false,
            requiresMode: null,
            preferredBandwidth: null
        });

        this.spots = [];
        this.maxSpots = 500;
        this.ageFilter = 10; // Default 10 minutes
        this.bandFilter = 'all';
        this.callsignFilter = '';
        this.showMarkers = true; // Default: markers enabled
        this.highlightNew = true;
        this.unsubscribe = null;
        this.newSpotId = null; // Track ID of the newest spot to highlight
        this.spotIdCounter = 0; // Counter for unique spot IDs
        this.ageUpdateInterval = null; // Timer for updating spot ages

        // Continent code to name mapping
        this.continentNames = {
            'AF': 'Africa',
            'AS': 'Asia',
            'EU': 'Europe',
            'NA': 'North America',
            'SA': 'South America',
            'OC': 'Oceania',
            'AN': 'Antarctica'
        };

        // Band frequency ranges (in Hz)
        this.bands = {
            '160m': { min: 1800000, max: 2000000 },
            '80m': { min: 3500000, max: 4000000 },
            '60m': { min: 5330500, max: 5403500 },
            '40m': { min: 7000000, max: 7300000 },
            '30m': { min: 10100000, max: 10150000 },
            '20m': { min: 14000000, max: 14350000 },
            '17m': { min: 18068000, max: 18168000 },
            '15m': { min: 21000000, max: 21450000 },
            '12m': { min: 24890000, max: 24990000 },
            '10m': { min: 28000000, max: 29700000 }
        };

        // Subscribe to DX spots immediately in constructor (before extension is enabled)
        // This ensures we receive buffered spots that arrive right after WebSocket connection
        this.subscribeToDXSpots();

        // Set up connection status monitoring
        this.connectionCheckInterval = null;
    }

    onInitialize() {
        this.renderTemplate();
        
        // Set up event handlers after template is rendered
        // Use a more reliable method to ensure DOM is ready
        this.waitForDOMAndSetupHandlers();
        
        // subscribeToDXSpots() is now called in constructor to catch buffered spots
        this.updateConnectionStatus();
        this.startConnectionMonitoring();
        this.startAgeUpdates();
        this.startRadioStateMonitoring();
    }

    waitForDOMAndSetupHandlers() {
        // Try to set up handlers, retry if elements don't exist yet
        const trySetup = (attempts = 0) => {
            const maxAttempts = 10;

            // Check if key elements exist
            const ageFilter = document.getElementById('dx-cluster-age-filter');
            const bandFilter = document.getElementById('dx-cluster-band-filter');
            const tbody = document.getElementById('dx-cluster-spots');

            if (ageFilter && bandFilter && tbody) {
                // Elements exist, set up handlers
                this.setupEventHandlers();
                console.log('DX Cluster: Event handlers set up successfully');
            } else if (attempts < maxAttempts) {
                // Elements don't exist yet, try again
                console.log(`DX Cluster: Waiting for DOM elements (attempt ${attempts + 1}/${maxAttempts})`);
                requestAnimationFrame(() => trySetup(attempts + 1));
            } else {
                console.error('DX Cluster: Failed to find DOM elements after', maxAttempts, 'attempts');
            }
        };

        trySetup();
    }

    renderTemplate() {
        // Load template from global scope (loaded by extension-loader.js)
        const template = window.dx_cluster_template;

        if (!template) {
            console.error('DX Cluster extension template not loaded');
            return;
        }

        // Get container and inject template
        const container = this.getContentElement();
        if (!container) return;

        container.innerHTML = template;
    }

    getContentElement() {
        // Get the decoder extension content element
        const panel = document.querySelector('.decoder-extension-panel');
        if (panel) {
            return panel.querySelector('.decoder-extension-content');
        }
        return null;
    }

    setupEventHandlers() {
        console.log('DX Cluster: Setting up event handlers using event delegation');

        // Get the container element (parent of all controls)
        const container = this.getContentElement();
        if (!container) {
            console.error('DX Cluster: Container element not found');
            return;
        }

        console.log('DX Cluster: Container found:', container);

        // Use event delegation on the container to handle all events
        // This works even if elements are replaced in the DOM
        container.addEventListener('change', (e) => {
            console.log('DX Cluster: Change event detected on:', e.target.id);

            if (e.target.id === 'dx-cluster-age-filter') {
                const value = e.target.value;
                this.ageFilter = value === 'none' ? null : parseInt(value);
                console.log('DX Cluster: Age filter changed to:', this.ageFilter, 'spots count:', this.spots.length);
                this.filterAndRenderSpots();
            } else if (e.target.id === 'dx-cluster-band-filter') {
                this.bandFilter = e.target.value;
                console.log('DX Cluster: Band filter changed to:', this.bandFilter, 'spots count:', this.spots.length);
                this.filterAndRenderSpots();
            } else if (e.target.id === 'dx-cluster-show-markers') {
                this.showMarkers = e.target.checked;
                console.log('DX Cluster: Show markers changed to:', this.showMarkers);
                // Markers will be shown/hidden on next spectrum redraw
            }
        });

        container.addEventListener('input', (e) => {
            console.log('DX Cluster: Input event detected on:', e.target.id);

            if (e.target.id === 'dx-cluster-callsign-filter') {
                this.callsignFilter = e.target.value.toUpperCase();
                console.log('DX Cluster: Callsign filter changed to:', this.callsignFilter, 'spots count:', this.spots.length);
                this.filterAndRenderSpots();
            }
        });

        container.addEventListener('click', (e) => {
            console.log('DX Cluster: Click event detected on:', e.target.id);

            if (e.target.id === 'dx-cluster-clear') {
                console.log('DX Cluster: Clear button clicked');
                this.clearSpots();
            }
        });

        // Set initial values after handlers are attached
        requestAnimationFrame(() => {
            const ageFilter = document.getElementById('dx-cluster-age-filter');
            const bandFilter = document.getElementById('dx-cluster-band-filter');
            const callsignFilter = document.getElementById('dx-cluster-callsign-filter');
            const showMarkers = document.getElementById('dx-cluster-show-markers');

            if (ageFilter) ageFilter.value = this.ageFilter.toString();
            if (bandFilter) bandFilter.value = this.bandFilter;
            if (callsignFilter) callsignFilter.value = this.callsignFilter;
            if (showMarkers) showMarkers.checked = this.showMarkers;

            console.log('DX Cluster: Initial filter values set');
        });

        console.log('DX Cluster: Event delegation handlers attached successfully');
    }

    subscribeToDXSpots() {
        // Subscribe to DX spots via radioAPI
        this.unsubscribe = this.radio.onDXSpot((spot) => {
            this.handleSpot(spot);
        });

        // Subscription handled silently
    }

    startConnectionMonitoring() {
        // Update immediately
        this.updateConnectionStatus();

        // Check connection status every 500ms for responsive updates
        this.connectionCheckInterval = setInterval(() => {
            this.updateConnectionStatus();
        }, 500);
    }

    stopConnectionMonitoring() {
        if (this.connectionCheckInterval) {
            clearInterval(this.connectionCheckInterval);
            this.connectionCheckInterval = null;
        }
    }

    updateConnectionStatus() {
        const connected = this.radio.isDXClusterConnected();

        if (connected) {
            this.updateStatus('connected', 'Connected');
        } else {
            this.updateStatus('disconnected', 'Disconnected');
        }
    }

    handleSpot(spot) {
        // Check if this is a buffered spot (has a time more than 5 seconds old)
        const isBuffered = spot.time && (Date.now() - new Date(spot.time).getTime()) > 5000;
        this.addSpot(spot, !isBuffered);
    }

    addSpot(spot, isNewSpot = false) {
        // Assign unique ID to new spots only
        if (isNewSpot) {
            spot._highlightId = ++this.spotIdCounter;
            this.newSpotId = spot._highlightId;
        }
        
        // Add to beginning of array (newest first)
        this.spots.unshift(spot);

        // Trim to max spots
        if (this.spots.length > this.maxSpots) {
            this.spots = this.spots.slice(0, this.maxSpots);
        }

        // Update display
        this.filterAndRenderSpots();

        // Update last update time
        this.updateLastUpdate();

        // If this is a buffered spot (initial burst), schedule a marker redraw after a delay
        // This ensures markers appear even if spectrum data hasn't arrived yet
        if (!isNewSpot && this.spots.length <= 100) {
            // Clear any existing timeout
            if (this.initialMarkerTimeout) {
                clearTimeout(this.initialMarkerTimeout);
            }
            // Schedule redraw after 1 second (after burst completes and spectrum data arrived)
            this.initialMarkerTimeout = setTimeout(() => {
                this.ensureMarkersDrawn();
                this.initialMarkerTimeout = null;
            }, 1000);
        }
    }

    ensureMarkersDrawn() {
        // Try to draw markers, retry if spectrum data isn't ready yet
        if (!window.spectrumDisplay) {
            return;
        }

        window.spectrumDisplay.invalidateMarkerCache();

        // Check if spectrum has data
        if (window.spectrumDisplay.spectrumData && window.spectrumDisplay.spectrumData.length > 0) {
            // Spectrum data is ready, draw now
            window.spectrumDisplay.draw();
        } else {
            // Spectrum data not ready yet, retry after 500ms
            setTimeout(() => {
                if (window.spectrumDisplay && window.spectrumDisplay.spectrumData && window.spectrumDisplay.spectrumData.length > 0) {
                    window.spectrumDisplay.invalidateMarkerCache();
                    window.spectrumDisplay.draw();
                }
            }, 500);
        }
    }

    filterAndRenderSpots() {
        const tbody = document.getElementById('dx-cluster-spots');
        if (!tbody) return;

        // Invalidate spectrum marker cache when spots change
        // This ensures DX spot markers are redrawn on the spectrum display
        if (window.spectrumDisplay) {
            window.spectrumDisplay.invalidateMarkerCache();
            // Force immediate redraw of markers by calling draw()
            // draw() will handle the case where spectrumData doesn't exist yet
            window.spectrumDisplay.draw();
        }

        // Start with all spots (backend already filters to 0-30 MHz)
        let filteredSpots = this.spots;

        // Filter spots by age
        if (this.ageFilter !== null) {
            const now = new Date();
            const maxAgeMs = this.ageFilter * 60 * 1000; // Convert minutes to milliseconds
            filteredSpots = filteredSpots.filter(spot => {
                try {
                    const spotTime = new Date(spot.time);
                    const ageMs = now - spotTime;
                    return ageMs <= maxAgeMs;
                } catch (e) {
                    return true; // Keep spot if time parsing fails
                }
            });
        }

        // Filter spots by band
        if (this.bandFilter !== 'all') {
            const band = this.bands[this.bandFilter];
            if (band) {
                filteredSpots = filteredSpots.filter(spot =>
                    spot.frequency >= band.min && spot.frequency <= band.max
                );
            }
        }

        // Filter spots by callsign (DX call, spotter, or comment)
        if (this.callsignFilter) {
            filteredSpots = filteredSpots.filter(spot =>
                spot.dx_call.toUpperCase().includes(this.callsignFilter) ||
                spot.spotter.toUpperCase().includes(this.callsignFilter) ||
                (spot.comment && spot.comment.toUpperCase().includes(this.callsignFilter))
            );
        }

        // Clear table
        tbody.innerHTML = '';

        if (filteredSpots.length === 0) {
            const row = tbody.insertRow();
            row.className = 'no-spots';
            const cell = row.insertCell();
            cell.colSpan = 8;
            cell.textContent = this.spots.length === 0 ? 'Waiting for spots...' : 'No spots match filter';
            // Update count to show 0 filtered of total when no spots match filter
            this.updateCount(0, this.spots.length);
            return;
        }

        // Track if we've highlighted the new spot in this render
        let highlightedNewSpot = false;

        // Render spots
        filteredSpots.forEach((spot) => {
            const row = tbody.insertRow();

            // Highlight only if this spot has the current new spot ID
            if (this.newSpotId && spot._highlightId === this.newSpotId && this.highlightNew) {
                row.className = 'spot-new';
                highlightedNewSpot = true;
                // Remove class after animation completes (0.5s)
                setTimeout(() => {
                    row.classList.remove('spot-new');
                }, 500);
            }

            // Make row clickable to tune (always enabled)
            row.style.cursor = 'pointer';
            row.addEventListener('click', () => {
                this.tuneToSpot(spot);
            });

            // Time
            const timeCell = row.insertCell();
            timeCell.className = 'spot-time';
            timeCell.textContent = this.formatTime(spot.time);

            // Age (how long ago)
            const ageCell = row.insertCell();
            ageCell.className = 'spot-age';
            ageCell.setAttribute('data-timestamp', spot.time);
            ageCell.textContent = this.formatAge(spot.time);

            // Frequency
            const freqCell = row.insertCell();
            freqCell.className = 'spot-frequency';
            
            // Check if current radio state matches this spot
            const isCurrentSpot = this.isCurrentSpot(spot);
            
            if (isCurrentSpot) {
                freqCell.innerHTML = this.formatFrequency(spot.frequency) + ' <span class="current-spot-indicator">●</span>';
            } else {
                freqCell.textContent = this.formatFrequency(spot.frequency);
            }
            
            freqCell.addEventListener('click', (e) => {
                e.stopPropagation();
                this.tuneToSpot(spot);
            });

            // DX Call
            const dxCell = row.insertCell();
            dxCell.className = 'spot-dx-call';
            dxCell.textContent = spot.dx_call;
            dxCell.style.cursor = 'pointer';
            dxCell.addEventListener('click', (e) => {
                e.stopPropagation();
                this.openQRZ(spot.dx_call);
            });

            // Country
            const countryCell = row.insertCell();
            countryCell.className = 'spot-country';
            countryCell.textContent = spot.country || '';

            // Continent
            const continentCell = row.insertCell();
            continentCell.className = 'spot-continent';
            continentCell.textContent = spot.continent ? (this.continentNames[spot.continent] || spot.continent) : '';

            // Spotter
            const spotterCell = row.insertCell();
            spotterCell.className = 'spot-spotter';
            spotterCell.textContent = spot.spotter;

            // Comment
            const commentCell = row.insertCell();
            commentCell.className = 'spot-comment';
            commentCell.textContent = spot.comment || '';
        });

        // Clear new spot ID after first render to prevent re-highlighting
        if (highlightedNewSpot) {
            this.newSpotId = null;
        }

        // Update count with both filtered and total
        this.updateCount(filteredSpots.length, this.spots.length);
    }

    tuneToSpot(spot) {
        // Set frequency using RadioAPI
        this.radio.setFrequency(spot.frequency);

        // Determine appropriate mode based on frequency and comment
        let mode;
        const freqMHz = spot.frequency / 1000000;
        const comment = (spot.comment || '').toUpperCase();

        // Check for digital modes in the comment
        const isCW = comment.includes('CW');
        const isFT8 = comment.includes('FT8');
        const isFT4 = comment.includes('FT4');
        const isDigital = isFT8 || isFT4;

        console.log('DX Cluster tuneToSpot:', {
            callsign: spot.dx_call,
            frequency: spot.frequency,
            comment: spot.comment,
            isCW: isCW,
            isDigital: isDigital,
            freqMHz: freqMHz
        });

        if (isDigital) {
            // FT8/FT4: always use USB mode on all bands
            mode = 'usb';

            console.log('DX Cluster: Setting digital mode (FT8/FT4) to USB with mode defaults');

            // Set mode with preserveBandwidth=false to use USB mode defaults
            this.radio.setMode(mode, false);
        } else if (isCW) {
            // CW mode: use CWU for 10 MHz and above, CWL below
            mode = freqMHz >= 10 ? 'cwu' : 'cwl';

            console.log('DX Cluster: Setting CW mode to', mode, 'with mode defaults');

            // Set mode with preserveBandwidth=false to use CW mode defaults (-200/+200 Hz)
            // This ensures only ONE tune command is sent with correct mode AND bandwidth
            this.radio.setMode(mode, false);
        } else {
            // Voice mode: use USB for 10 MHz and above, LSB below
            mode = freqMHz >= 10 ? 'usb' : 'lsb';

            console.log('DX Cluster: Setting voice mode to', mode, 'with preserveBandwidth=false');

            // Set mode with preserveBandwidth=false to get default voice bandwidth
            this.radio.setMode(mode, false);
        }

        this.radio.log(`Tuned to ${spot.dx_call} on ${this.formatFrequency(spot.frequency)} MHz ${mode.toUpperCase()}`);
    }

    openQRZ(callsign) {
        // Strip anything after a slash (e.g., W1ABC/P becomes W1ABC)
        const baseCallsign = callsign.split('/')[0];
        const url = `https://www.qrz.com/db/${baseCallsign}`;
        window.open(url, '_blank');
    }

    formatFrequency(hz) {
        // Always return MHz without unit (unit is in column header)
        return (hz / 1000000).toFixed(5);
    }

    formatTime(timeStr) {
        // Time comes as ISO 8601 from backend
        if (!timeStr) return '';

        try {
            const date = new Date(timeStr);
            // Return time without "UTC" suffix (it's in column header)
            return date.toLocaleTimeString('en-US', { hour12: false, timeZone: 'UTC' });
        } catch (e) {
            return timeStr;
        }
    }

    updateStatus(status, text) {
        const badge = document.getElementById('dx-cluster-status-badge');
        if (badge) {
            badge.textContent = text;
            badge.className = `status-badge status-${status}`;
        }
    }

    updateCount(filteredCount, totalCount = null) {
        const countEl = document.getElementById('dx-cluster-count');
        if (countEl) {
            if (totalCount !== null && filteredCount !== totalCount) {
                // Show "x spots of n total" when filtering
                countEl.textContent = `${filteredCount} spot${filteredCount !== 1 ? 's' : ''} of ${totalCount} total`;
            } else {
                // Show just "x spots" when not filtering or all spots match
                countEl.textContent = `${filteredCount} spot${filteredCount !== 1 ? 's' : ''}`;
            }
        }
    }

    updateLastUpdate() {
        const lastUpdateEl = document.getElementById('dx-cluster-last-update');
        if (lastUpdateEl) {
            const now = new Date();
            lastUpdateEl.textContent = `Last: ${now.toLocaleTimeString()}`;
        }
    }

    clearSpots() {
        this.spots = [];
        this.filterAndRenderSpots();
    }

    formatAge(timeStr) {
        if (!timeStr) return '';
        
        try {
            const spotTime = new Date(timeStr);
            const now = new Date();
            const diffMs = now - spotTime;
            const diffSec = Math.floor(diffMs / 1000);
            
            if (diffSec < 60) {
                return `-${diffSec}s`;
            } else if (diffSec < 3600) {
                const minutes = Math.floor(diffSec / 60);
                const seconds = diffSec % 60;
                return `-${minutes}m${seconds}s`;
            } else if (diffSec < 86400) {
                const hours = Math.floor(diffSec / 3600);
                const minutes = Math.floor((diffSec % 3600) / 60);
                return `-${hours}h${minutes}m`;
            } else {
                const days = Math.floor(diffSec / 86400);
                return `-${days}d`;
            }
        } catch (e) {
            return '';
        }
    }

    startAgeUpdates() {
        // Update ages every second and re-render if age filter is active
        this.ageUpdateInterval = setInterval(() => {
            const ageCells = document.querySelectorAll('.spot-age');
            ageCells.forEach(cell => {
                const timestamp = cell.getAttribute('data-timestamp');
                if (timestamp) {
                    cell.textContent = this.formatAge(timestamp);
                }
            });

            // If age filter is active, re-render to remove spots that have aged out
            if (this.ageFilter !== null) {
                this.filterAndRenderSpots();
            }
        }, 1000);
    }

    stopAgeUpdates() {
        if (this.ageUpdateInterval) {
            clearInterval(this.ageUpdateInterval);
            this.ageUpdateInterval = null;
        }
    }

    startRadioStateMonitoring() {
        // Monitor radio state changes to update current spot indicator
        this.radioStateInterval = setInterval(() => {
            this.updateCurrentSpotIndicators();
        }, 500); // Check twice per second
    }

    stopRadioStateMonitoring() {
        if (this.radioStateInterval) {
            clearInterval(this.radioStateInterval);
            this.radioStateInterval = null;
        }
    }

    isCurrentSpot(spot) {
        // Get current radio state
        const currentFreq = this.radio.getFrequency();
        const currentMode = this.radio.getMode();
        
        if (!currentFreq || !currentMode) return false;
        
        // Determine expected mode for this spot
        const freqMHz = spot.frequency / 1000000;
        const comment = (spot.comment || '').toUpperCase();
        const isCW = comment.includes('CW');
        
        let expectedMode;
        if (isCW) {
            expectedMode = freqMHz >= 10 ? 'cwu' : 'cwl';
        } else {
            expectedMode = freqMHz >= 10 ? 'usb' : 'lsb';
        }
        
        // Check if frequency matches (within 1 kHz tolerance)
        const freqMatch = Math.abs(currentFreq - spot.frequency) < 1000;
        
        // Check if mode matches (case insensitive)
        const modeMatch = currentMode.toLowerCase() === expectedMode.toLowerCase();
        
        return freqMatch && modeMatch;
    }

    updateCurrentSpotIndicators() {
        // Update all frequency cells to show/hide current spot indicator
        const rows = document.querySelectorAll('#dx-cluster-spots tr');
        
        rows.forEach((row, index) => {
            if (row.classList.contains('no-spots')) return;
            
            // Get the spot for this row
            const tbody = document.getElementById('dx-cluster-spots');
            if (!tbody) return;
            
            // Filter spots same way as filterAndRenderSpots
            // Start with all spots (backend already filters to 0-30 MHz)
            let filteredSpots = this.spots;

            // Filter by age
            if (this.ageFilter !== null) {
                const now = new Date();
                const maxAgeMs = this.ageFilter * 60 * 1000;
                filteredSpots = filteredSpots.filter(spot => {
                    try {
                        const spotTime = new Date(spot.time);
                        const ageMs = now - spotTime;
                        return ageMs <= maxAgeMs;
                    } catch (e) {
                        return true;
                    }
                });
            }

            if (this.bandFilter !== 'all') {
                const band = this.bands[this.bandFilter];
                if (band) {
                    filteredSpots = filteredSpots.filter(spot =>
                        spot.frequency >= band.min && spot.frequency <= band.max
                    );
                }
            }

            if (this.callsignFilter) {
                filteredSpots = filteredSpots.filter(spot =>
                    spot.dx_call.toUpperCase().includes(this.callsignFilter) ||
                    spot.spotter.toUpperCase().includes(this.callsignFilter) ||
                    (spot.comment && spot.comment.toUpperCase().includes(this.callsignFilter))
                );
            }
            
            if (index >= filteredSpots.length) return;
            
            const spot = filteredSpots[index];
            const freqCell = row.cells[2]; // Frequency is 3rd column (index 2)
            
            if (freqCell && freqCell.classList.contains('spot-frequency')) {
                const isCurrentSpot = this.isCurrentSpot(spot);
                
                if (isCurrentSpot) {
                    freqCell.innerHTML = this.formatFrequency(spot.frequency) + ' <span class="current-spot-indicator">●</span>';
                } else {
                    freqCell.textContent = this.formatFrequency(spot.frequency);
                }
            }
        });
    }

    onEnable() {
        // Re-subscribe to DX spots when extension is enabled
        // This ensures we receive new spots after closing and reopening the extension
        if (!this.unsubscribe) {
            this.subscribeToDXSpots();
        }

        // Subscribe to DX spots on server
        if (window.dxClusterClient) {
            window.dxClusterClient.subscribeToDXSpots();
        }

        // Restart monitoring intervals
        this.updateConnectionStatus();
        this.startConnectionMonitoring();
        this.startAgeUpdates();
        this.startRadioStateMonitoring();
    }

    onDisable() {
        // Stop connection monitoring
        this.stopConnectionMonitoring();

        // Stop age updates
        this.stopAgeUpdates();

        // Stop radio state monitoring
        this.stopRadioStateMonitoring();

        // Unsubscribe from spots and clear the reference
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }

        // Unsubscribe from DX spots on server
        if (window.dxClusterClient) {
            window.dxClusterClient.unsubscribeFromDXSpots();
        }
    }

    // Required by DecoderExtension but not used for DX cluster
    onProcessAudio(dataArray) {
        // DX cluster doesn't process audio
    }
}

// Draw DX spots on spectrum display (exposed on window for spectrum-display.js access)
let lastDebugLog = 0;
function drawDXSpotsOnSpectrum(spectrumDisplay, log) {
    const now = Date.now();
    const shouldLog = (now - lastDebugLog) > 5000; // Log once every 5 seconds
    
    if (!spectrumDisplay || !spectrumDisplay.overlayCtx) {
        dxSpotPositions = [];
        window.dxSpotPositions = dxSpotPositions;
        return;
    }

    // Get the DX cluster extension instance from global reference
    const dxExtension = dxClusterExtensionInstance;

    // Only draw if extension exists, is enabled, has spots, AND showMarkers is enabled
    if (!dxExtension || !dxExtension.enabled || !dxExtension.spots || dxExtension.spots.length === 0 || !dxExtension.showMarkers) {
        dxSpotPositions = [];
        window.dxSpotPositions = dxSpotPositions;
        return;
    }
    
    if (shouldLog) {
        console.log('DX Spots: enabled=', dxExtension.enabled, 'spots=', dxExtension.spots.length);
        lastDebugLog = now;
    }

    // Use the overlay canvas context (same as bookmarks, but draw at bottom)
    const ctx = spectrumDisplay.overlayCtx;

    if (!ctx || !spectrumDisplay.totalBandwidth || !spectrumDisplay.centerFreq) {
        dxSpotPositions = [];
        window.dxSpotPositions = dxSpotPositions;
        return;
    }

    // Calculate frequency range
    const startFreq = spectrumDisplay.centerFreq - spectrumDisplay.totalBandwidth / 2;
    const endFreq = spectrumDisplay.centerFreq + spectrumDisplay.totalBandwidth / 2;

    // Clear spot positions array
    dxSpotPositions = [];

    // Get filtered spots (backend already filters to 0-30 MHz)
    let filteredSpots = dxExtension.spots;
    
    if (shouldLog) {
        console.log('Spectrum range:', (startFreq/1e6).toFixed(3), '-', (endFreq/1e6).toFixed(3), 'MHz');
        console.log('Filtered spots:', filteredSpots.length);
    }

    // Apply age filter
    if (dxExtension.ageFilter !== null) {
        const now = new Date();
        const maxAgeMs = dxExtension.ageFilter * 60 * 1000;
        filteredSpots = filteredSpots.filter(spot => {
            try {
                const spotTime = new Date(spot.time);
                const ageMs = now - spotTime;
                return ageMs <= maxAgeMs;
            } catch (e) {
                return true;
            }
        });
    }

    // Apply band filter
    if (dxExtension.bandFilter !== 'all') {
        const band = dxExtension.bands[dxExtension.bandFilter];
        if (band) {
            filteredSpots = filteredSpots.filter(spot =>
                spot.frequency >= band.min && spot.frequency <= band.max
            );
        }
    }

    // Apply callsign filter
    if (dxExtension.callsignFilter) {
        filteredSpots = filteredSpots.filter(spot =>
            spot.dx_call.toUpperCase().includes(dxExtension.callsignFilter) ||
            spot.spotter.toUpperCase().includes(dxExtension.callsignFilter) ||
            (spot.comment && spot.comment.toUpperCase().includes(dxExtension.callsignFilter))
        );
    }

    // Deduplicate spots by callsign+frequency combination - keep only the most recent
    const uniqueSpots = [];
    const seenCombinations = new Set();
    filteredSpots.forEach(spot => {
        const key = `${spot.dx_call}@${spot.frequency}`;
        if (!seenCombinations.has(key)) {
            uniqueSpots.push(spot);
            seenCombinations.add(key);
        }
    });

    // First pass: calculate positions for visible spots
    const visibleSpots = [];
    uniqueSpots.forEach(spot => {
        // Only process if frequency is within visible range
        if (spot.frequency < startFreq || spot.frequency > endFreq) {
            return;
        }

        // Calculate x position
        const x = ((spot.frequency - startFreq) / (endFreq - startFreq)) * spectrumDisplay.width;

        // Measure label width
        ctx.font = 'bold 10px monospace';
        const labelWidth = ctx.measureText(spot.dx_call).width + 8;

        visibleSpots.push({
            spot: spot,
            x: x,
            labelWidth: labelWidth,
            row: 0  // Will be assigned: 0 = bottom row, 1 = top row
        });
    });

    // Sort by x position
    visibleSpots.sort((a, b) => a.x - b.x);

    // Simple two-row collision detection (same algorithm as bookmarks)
    // Assign spots to rows to avoid overlaps
    const row0Spots = []; // Bottom row
    const row1Spots = []; // Top row

    visibleSpots.forEach(current => {
        // Check if it overlaps with any spot in row 0
        const overlapsRow0 = row0Spots.some(other => {
            const currentLeft = current.x - current.labelWidth / 2;
            const currentRight = current.x + current.labelWidth / 2;
            const otherLeft = other.x - other.labelWidth / 2;
            const otherRight = other.x + other.labelWidth / 2;
            // 3px gap threshold
            return !(currentRight + 3 < otherLeft || currentLeft - 3 > otherRight);
        });

        if (!overlapsRow0) {
            // No overlap in row 0, place it there
            current.row = 0;
            row0Spots.push(current);
        } else {
            // Overlaps row 0, try row 1
            const overlapsRow1 = row1Spots.some(other => {
                const currentLeft = current.x - current.labelWidth / 2;
                const currentRight = current.x + current.labelWidth / 2;
                const otherLeft = other.x - other.labelWidth / 2;
                const otherRight = other.x + other.labelWidth / 2;
                return !(currentRight + 3 < otherLeft || currentLeft - 3 > otherRight);
            });

            if (!overlapsRow1) {
                // No overlap in row 1, place it there
                current.row = 1;
                row1Spots.push(current);
            } else {
                // Overlaps both rows - place in row 0 anyway (will overlap)
                current.row = 0;
                row0Spots.push(current);
            }
        }
    });

    // Draw spots with row assignments
    const labelHeight = 12;
    const arrowLength = 6;
    const rowSpacing = 15; // Vertical spacing between rows (matches bookmarks)

    // Draw row 1 (top row) first, then row 0 (bottom row)
    // This ensures row 0 labels appear on top and aren't obscured by row 1 arrows
    const sortedByRow = [...visibleSpots].sort((a, b) => b.row - a.row);

    sortedByRow.forEach(item => {
        const { spot, x, labelWidth, row } = item;
        // Row 0 at y=32, Row 1 at y=17 (32 - 15) - matches bookmark positioning
        const labelY = 32 - (row * rowSpacing);

        if (shouldLog) {
            console.log(`Drawing ${spot.dx_call} at x=${x.toFixed(0)}, y=${labelY}, row=${row}`);
        }

        // Draw spot label
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        // Background for label
        ctx.fillStyle = 'rgba(40, 167, 69, 0.95)'; // Green background
        ctx.fillRect(x - labelWidth / 2, labelY, labelWidth, labelHeight);

        // Border for label
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x - labelWidth / 2, labelY, labelWidth, labelHeight);

        // Label text
        ctx.fillStyle = '#FFFFFF'; // White text on green background
        ctx.fillText(spot.dx_call, x, labelY + 2);

        // Draw downward arrow - extends from label to baseline
        const arrowStartY = labelY + labelHeight;
        const arrowTipY = 32 + labelHeight + arrowLength; // Always point to same baseline (adjusted for new position)
        ctx.fillStyle = 'rgba(40, 167, 69, 0.95)';
        ctx.beginPath();
        ctx.moveTo(x, arrowTipY); // Arrow tip at baseline
        ctx.lineTo(x - 4, arrowStartY); // Left point at label bottom
        ctx.lineTo(x + 4, arrowStartY); // Right point at label bottom
        ctx.closePath();
        ctx.fill();

        // Arrow border
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Store spot position for hover detection
        dxSpotPositions.push({
            x: x,
            y: labelY,
            width: labelWidth,
            height: labelHeight + (arrowTipY - arrowStartY),
            spot: spot
        });
    });

    // Update window reference
    window.dxSpotPositions = dxSpotPositions;
    
    if (shouldLog && visibleSpots.length > 0) {
        console.log('Drew', visibleSpots.length, 'DX spot markers on spectrum with collision detection');
    }
}

// Expose function on window for spectrum-display.js access
window.drawDXSpotsOnSpectrum = drawDXSpotsOnSpectrum;

// Register the extension
if (window.decoderManager) {
    dxClusterExtensionInstance = new DXClusterExtension();
    window.decoderManager.register(dxClusterExtensionInstance);
    console.log('DX Cluster extension registered:', dxClusterExtensionInstance);
} else {
    console.error('decoderManager not available for DX Cluster extension');
}

// Also expose the instance globally for debugging
window.dxClusterExtensionInstance = dxClusterExtensionInstance;
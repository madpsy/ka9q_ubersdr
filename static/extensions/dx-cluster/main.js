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
        this.maxSpots = 100;
        this.ageFilter = 10; // Default 10 minutes
        this.bandFilter = 'all';
        this.callsignFilter = '';
        this.highlightNew = true;
        this.unsubscribe = null;
        this.newSpotId = null; // Track ID of the newest spot to highlight
        this.spotIdCounter = 0; // Counter for unique spot IDs
        this.ageUpdateInterval = null; // Timer for updating spot ages

        // Band frequency ranges (in Hz)
        this.bands = {
            '160m': { min: 1800000, max: 2000000 },
            '80m': { min: 3500000, max: 4000000 },
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
    }

    onInitialize() {
        this.renderTemplate();
        
        // Set up event handlers after template is rendered
        // Use requestAnimationFrame to ensure DOM is updated
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                this.setupEventHandlers();
            });
        });
        
        // subscribeToDXSpots() is now called in constructor to catch buffered spots
        this.updateConnectionStatus();
        this.startAgeUpdates();
        this.startRadioStateMonitoring();
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
        // Age filter
        const ageFilter = document.getElementById('dx-cluster-age-filter');
        if (ageFilter) {
            ageFilter.value = this.ageFilter.toString();
            ageFilter.addEventListener('change', (e) => {
                const value = e.target.value;
                this.ageFilter = value === 'none' ? null : parseInt(value);
                console.log('Age filter changed to:', this.ageFilter);
                this.filterAndRenderSpots();
            });
        } else {
            console.error('Age filter element not found');
        }

        // Band filter
        const bandFilter = document.getElementById('dx-cluster-band-filter');
        if (bandFilter) {
            bandFilter.value = this.bandFilter;
            bandFilter.addEventListener('change', (e) => {
                this.bandFilter = e.target.value;
                console.log('Band filter changed to:', this.bandFilter);
                this.filterAndRenderSpots();
            });
        } else {
            console.error('Band filter element not found');
        }

        // Callsign filter
        const callsignFilter = document.getElementById('dx-cluster-callsign-filter');
        if (callsignFilter) {
            callsignFilter.value = this.callsignFilter;
            callsignFilter.addEventListener('input', (e) => {
                this.callsignFilter = e.target.value.toUpperCase();
                this.filterAndRenderSpots();
            });
        }

        // Clear button
        const clearButton = document.getElementById('dx-cluster-clear');
        if (clearButton) {
            clearButton.addEventListener('click', () => {
                this.clearSpots();
            });
        }
    }

    subscribeToDXSpots() {
        // Subscribe to DX spots via radioAPI
        this.unsubscribe = this.radio.onDXSpot((spot) => {
            this.handleSpot(spot);
        });

        // Subscription handled silently
    }

    updateConnectionStatus() {
        const connected = this.radio.isDXClusterConnected();

        if (connected) {
            this.updateStatus('connected', 'Connected');
        } else {
            this.updateStatus('disconnected', 'Disconnected');
        }

        // Check status periodically
        setTimeout(() => this.updateConnectionStatus(), 5000);
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
    }

    filterAndRenderSpots() {
        const tbody = document.getElementById('dx-cluster-spots');
        if (!tbody) return;

        // Filter spots by frequency range (0-30 MHz only)
        let filteredSpots = this.spots.filter(spot =>
            spot.frequency > 0 && spot.frequency <= 30000000
        );

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
            cell.colSpan = 5;
            cell.textContent = this.spots.length === 0 ? 'Waiting for spots...' : 'No spots match filter';
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

        // Update count
        this.updateCount(filteredSpots.length);
    }

    tuneToSpot(spot) {
        // Set frequency
        this.radio.setFrequency(spot.frequency);
        
        // Determine appropriate mode based on frequency and comment
        let mode;
        const freqMHz = spot.frequency / 1000000;
        const comment = (spot.comment || '').toUpperCase();
        
        // Check if CW is mentioned in the comment
        const isCW = comment.includes('CW');
        
        if (isCW) {
            // CW mode: use CWU for 10 MHz and above, CWL below
            mode = freqMHz >= 10 ? 'cwu' : 'cwl';
        } else {
            // Voice mode: use USB for 10 MHz and above, LSB below
            mode = freqMHz >= 10 ? 'usb' : 'lsb';
        }
        
        // Set the mode using the global setMode function
        if (window.setMode) {
            window.setMode(mode);
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
        return (hz / 1000000).toFixed(3);
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

    updateCount(count) {
        const countEl = document.getElementById('dx-cluster-count');
        if (countEl) {
            countEl.textContent = `${count} spot${count !== 1 ? 's' : ''}`;
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
            let filteredSpots = this.spots.filter(spot =>
                spot.frequency > 0 && spot.frequency <= 30000000
            );

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
        // Extension enabled
    }

    onDisable() {
        // Stop age updates
        this.stopAgeUpdates();
        
        // Stop radio state monitoring
        this.stopRadioStateMonitoring();
        
        // Unsubscribe from spots
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
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

    // Only draw if extension exists, is enabled, and has spots
    if (!dxExtension || !dxExtension.enabled || !dxExtension.spots || dxExtension.spots.length === 0) {
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

    // Get filtered spots (apply same filters as the extension)
    let filteredSpots = dxExtension.spots.filter(spot =>
        spot.frequency > 0 && spot.frequency <= 30000000
    );
    
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

    // Draw each unique spot that's within the visible range
    let drawnCount = 0;
    uniqueSpots.forEach(spot => {
        // Only draw if frequency is within visible range
        if (spot.frequency < startFreq || spot.frequency > endFreq) {
            return;
        }
        drawnCount++;

        // Calculate x position
        const x = ((spot.frequency - startFreq) / (endFreq - startFreq)) * spectrumDisplay.width;

        // Draw at same height as bookmarks (y=20) - match bookmark styling exactly
        const labelY = 20;
        
        if (shouldLog) {
            console.log(`Drawing ${spot.dx_call} at x=${x.toFixed(0)}, y=${labelY}`);
        }

        // Draw spot label (match bookmark styling exactly)
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        // Background for label
        const labelWidth = ctx.measureText(spot.dx_call).width + 8;
        const labelHeight = 12;

        ctx.fillStyle = 'rgba(40, 167, 69, 0.95)'; // Green background (instead of gold)
        ctx.fillRect(x - labelWidth / 2, labelY, labelWidth, labelHeight);

        // Border for label
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x - labelWidth / 2, labelY, labelWidth, labelHeight);

        // Label text
        ctx.fillStyle = '#FFFFFF'; // White text on green background
        ctx.fillText(spot.dx_call, x, labelY + 2);

        // Draw downward arrow below label (match bookmark arrow exactly)
        const arrowY = labelY + labelHeight;
        const arrowLength = 6;
        ctx.fillStyle = 'rgba(40, 167, 69, 0.95)';
        ctx.beginPath();
        ctx.moveTo(x, arrowY + arrowLength); // Arrow tip
        ctx.lineTo(x - 4, arrowY); // Left point
        ctx.lineTo(x + 4, arrowY); // Right point
        ctx.closePath();
        ctx.fill();

        // Arrow border
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Store spot position for hover detection (match bookmark position format)
        dxSpotPositions.push({
            x: x,
            y: labelY,
            width: labelWidth,
            height: labelHeight + arrowLength,
            spot: spot
        });
    });

    // Update window reference
    window.dxSpotPositions = dxSpotPositions;
    
    if (shouldLog && drawnCount > 0) {
        console.log('Drew', drawnCount, 'DX spot markers on spectrum');
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
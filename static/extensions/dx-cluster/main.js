// DX Cluster Extension for ka9q UberSDR
// Displays real-time DX spots from amateur radio DX clusters

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
        this.bandFilter = 'all';
        this.callsignFilter = '';
        this.highlightNew = true;
        this.unsubscribe = null;
        this.newSpotId = null; // Track ID of the newest spot to highlight
        this.spotIdCounter = 0; // Counter for unique spot IDs

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
        
        this.subscribeToDXSpots();
        this.updateConnectionStatus();
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
        // Band filter
        const bandFilter = document.getElementById('dx-cluster-band-filter');
        if (bandFilter) {
            bandFilter.value = this.bandFilter;
            bandFilter.addEventListener('change', (e) => {
                this.bandFilter = e.target.value;
                this.filterAndRenderSpots();
            });
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
        this.addSpot(spot, true);
    }

    addSpot(spot, isNewSpot = false) {
        // Assign unique ID to new spots
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

        // Render spots
        filteredSpots.forEach((spot) => {
            const row = tbody.insertRow();

            // Highlight only if this spot has the current new spot ID
            if (this.newSpotId && spot._highlightId === this.newSpotId && this.highlightNew) {
                row.className = 'spot-new';
                // Remove class after animation completes (0.5s)
                setTimeout(() => {
                    row.classList.remove('spot-new');
                    // Clear the new spot ID after highlighting
                    if (this.newSpotId === spot._highlightId) {
                        this.newSpotId = null;
                    }
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

            // Frequency
            const freqCell = row.insertCell();
            freqCell.className = 'spot-frequency';
            freqCell.textContent = this.formatFrequency(spot.frequency);
            freqCell.addEventListener('click', (e) => {
                e.stopPropagation();
                this.tuneToSpot(spot);
            });

            // DX Call
            const dxCell = row.insertCell();
            dxCell.className = 'spot-dx-call';
            dxCell.textContent = spot.dx_call;

            // Spotter
            const spotterCell = row.insertCell();
            spotterCell.className = 'spot-spotter';
            spotterCell.textContent = spot.spotter;

            // Comment
            const commentCell = row.insertCell();
            commentCell.className = 'spot-comment';
            commentCell.textContent = spot.comment || '';
        });

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

    onEnable() {
        // Extension enabled
    }

    onDisable() {
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

// Register the extension
if (window.decoderManager) {
    window.decoderManager.register(new DXClusterExtension());
}
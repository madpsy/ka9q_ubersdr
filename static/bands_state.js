/**
 * Band State Monitor
 * Polls the noise floor aggregate API to determine which amateur radio bands are open or closed
 * based on FT8 SNR values.
 */

class BandStateMonitor {
    constructor(options = {}) {
        this.pollInterval = options.pollInterval || 5 * 60 * 1000; // 5 minutes default
        this.snrThreshold = options.snrThreshold || 6; // SNR threshold for open/closed
        this.apiEndpoint = options.apiEndpoint || '/api/noisefloor/aggregate';
        this.bands = options.bands || ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];
        
        this.bandStates = {};
        this.lastUpdate = null;
        this.pollTimer = null;
        this.listeners = [];
    }

    /**
     * Get the current hour and previous hour in UTC
     * @returns {Object} Object with 'from' and 'to' ISO timestamp strings
     */
    getTimeRange() {
        const now = new Date();
        const to = now.toISOString();
        
        // Get the previous hour
        const from = new Date(now.getTime() - (60 * 60 * 1000));
        
        return {
            from: from.toISOString(),
            to: to
        };
    }

    /**
     * Fetch band state data from the API
     * @returns {Promise<Object>} Band states object
     */
    async fetchBandStates() {
        const timeRange = this.getTimeRange();
        
        const requestBody = {
            primary: {
                from: timeRange.from,
                to: timeRange.to
            },
            bands: this.bands,
            fields: ['ft8_snr'],
            interval: 'hour'
        };

        try {
            const response = await fetch(this.apiEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                throw new Error(`API request failed: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            return this.processBandData(data);
        } catch (error) {
            console.error('Error fetching band states:', error);
            throw error;
        }
    }

    /**
     * Process the API response and determine band states
     * @param {Object} data - API response data
     * @returns {Object} Processed band states
     */
    processBandData(data) {
        const states = {};
        
        if (!data.primary) {
            console.warn('No primary data in API response');
            return states;
        }

        for (const band of this.bands) {
            const bandData = data.primary[band];
            
            if (!bandData || bandData.length === 0) {
                states[band] = {
                    status: 'UNKNOWN',
                    snr: null,
                    timestamp: null,
                    sampleCount: 0
                };
                continue;
            }

            // Get the most recent data point
            const latestData = bandData[0];
            const snr = latestData.values?.ft8_snr;
            
            if (snr !== null && snr !== undefined) {
                states[band] = {
                    status: snr >= this.snrThreshold ? 'OPEN' : 'CLOSED',
                    snr: snr,
                    timestamp: latestData.timestamp,
                    sampleCount: latestData.sample_count || 0
                };
            } else {
                states[band] = {
                    status: 'UNKNOWN',
                    snr: null,
                    timestamp: latestData.timestamp,
                    sampleCount: latestData.sample_count || 0
                };
            }
        }

        return states;
    }

    /**
     * Update band states and notify listeners
     */
    async update() {
        try {
            const newStates = await this.fetchBandStates();
            this.bandStates = newStates;
            this.lastUpdate = new Date();
            this.notifyListeners(newStates);
            return newStates;
        } catch (error) {
            console.error('Failed to update band states:', error);
            throw error;
        }
    }

    /**
     * Start polling for band states
     */
    start() {
        if (this.pollTimer) {
            console.warn('Band state monitor already running');
            return;
        }

        // Initial update
        this.update().catch(err => console.error('Initial band state update failed:', err));

        // Set up polling
        this.pollTimer = setInterval(() => {
            this.update().catch(err => console.error('Band state update failed:', err));
        }, this.pollInterval);

        console.log(`Band state monitor started (polling every ${this.pollInterval / 1000}s)`);
    }

    /**
     * Stop polling for band states
     */
    stop() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
            console.log('Band state monitor stopped');
        }
    }

    /**
     * Get the current band states
     * @returns {Object} Current band states
     */
    getBandStates() {
        return { ...this.bandStates };
    }

    /**
     * Get the state of a specific band
     * @param {string} band - Band name (e.g., '20m')
     * @returns {Object|null} Band state or null if not found
     */
    getBandState(band) {
        return this.bandStates[band] || null;
    }

    /**
     * Get all open bands
     * @returns {Array<string>} Array of band names that are open
     */
    getOpenBands() {
        return Object.keys(this.bandStates).filter(
            band => this.bandStates[band].status === 'OPEN'
        );
    }

    /**
     * Get all closed bands
     * @returns {Array<string>} Array of band names that are closed
     */
    getClosedBands() {
        return Object.keys(this.bandStates).filter(
            band => this.bandStates[band].status === 'CLOSED'
        );
    }

    /**
     * Add a listener for band state updates
     * @param {Function} callback - Callback function to be called on updates
     */
    addListener(callback) {
        if (typeof callback === 'function') {
            this.listeners.push(callback);
        }
    }

    /**
     * Remove a listener
     * @param {Function} callback - Callback function to remove
     */
    removeListener(callback) {
        const index = this.listeners.indexOf(callback);
        if (index > -1) {
            this.listeners.splice(index, 1);
        }
    }

    /**
     * Notify all listeners of band state changes
     * @param {Object} states - New band states
     */
    notifyListeners(states) {
        for (const listener of this.listeners) {
            try {
                listener(states);
            } catch (error) {
                console.error('Error in band state listener:', error);
            }
        }
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = BandStateMonitor;
}

// UI Integration
let bandStateMonitor = null;

/**
 * Initialize the band state monitor and UI
 */
function initBandStateUI() {
    // Create the monitor instance
    bandStateMonitor = new BandStateMonitor({
        pollInterval: 5 * 60 * 1000, // 5 minutes
        snrThreshold: 6,
        apiEndpoint: '/api/noisefloor/aggregate'
    });

    // Add listener to update UI when band states change
    bandStateMonitor.addListener(updateBandStatusDisplay);

    // Start monitoring
    bandStateMonitor.start();

    console.log('Band state monitor initialized');
}

/**
 * Update the band status display in the UI
 * @param {Object} states - Band states from the monitor
 */
function updateBandStatusDisplay(states) {
    const bandStatusBar = document.querySelector('.band-status-bar');
    if (!bandStatusBar) return;

    // Update each band badge
    for (const [band, state] of Object.entries(states)) {
        const bandBadge = document.querySelector(`.band-status-badge[data-band="${band}"]`);
        if (!bandBadge) continue;

        // Treat UNKNOWN as OPEN (green) - assume band is open if no data
        const displayStatus = state.status === 'UNKNOWN' ? 'OPEN' : state.status;
        
        // Update data attribute for CSS styling
        bandBadge.setAttribute('data-status', displayStatus);

        // Add tooltip with FT8 SNR value if available
        if (state.snr !== null && state.snr !== undefined) {
            bandBadge.title = `${band}: ${state.status}\nFT8 SNR: ${state.snr.toFixed(2)} dB`;
        } else {
            bandBadge.title = `${band}: No data available`;
        }
    }

    console.log('Band status display updated', states);
}

/**
 * Get the current band states
 * @returns {Object} Current band states
 */
function getBandStates() {
    return bandStateMonitor ? bandStateMonitor.getBandStates() : {};
}

/**
 * Check if a specific band is open
 * @param {string} band - Band name (e.g., '20m')
 * @returns {boolean} True if band is open
 */
function isBandOpen(band) {
    if (!bandStateMonitor) return false;
    const state = bandStateMonitor.getBandState(band);
    return state && state.status === 'OPEN';
}

/**
 * Get all open bands
 * @returns {Array<string>} Array of open band names
 */
function getOpenBands() {
    return bandStateMonitor ? bandStateMonitor.getOpenBands() : [];
}

/**
 * Manually trigger a band state update
 */
function refreshBandStates() {
    if (bandStateMonitor) {
        bandStateMonitor.update().catch(err => {
            console.error('Failed to refresh band states:', err);
        });
    }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBandStateUI);
} else {
    initBandStateUI();
}

// Export functions for use in other scripts
window.bandStateUI = {
    getBandStates,
    isBandOpen,
    getOpenBands,
    refreshBandStates
};
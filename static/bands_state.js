/**
 * Band State Monitor
 * Polls the noise floor aggregate API to determine which amateur radio bands are open or closed
 * based on FT8 SNR values.
 */

class BandStateMonitor {
    constructor(options = {}) {
        this.pollInterval = options.pollInterval || 60 * 1000; // 1 minute default
        this.snrThreshold = options.snrThreshold || 6; // SNR threshold for open/closed
        this.apiEndpoint = options.apiEndpoint || '/api/noisefloor/aggregate';
        this.bands = options.bands || ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];
        
        this.bandStates = {};
        this.lastUpdate = null;
        this.pollTimer = null;
        this.listeners = [];
    }

    /**
     * Get the previous 10 minutes time range in UTC
     * @returns {Object} Object with 'from' and 'to' ISO timestamp strings
     */
    getTimeRange() {
        const now = new Date();
        const to = now.toISOString();
        
        // Get the previous 10 minutes
        const from = new Date(now.getTime() - (10 * 60 * 1000));
        
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
            interval: 'minute'
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

            // Calculate average SNR across all data points in the 10-minute window
            let totalSnr = 0;
            let totalSamples = 0;
            let latestTimestamp = null;
            
            for (const dataPoint of bandData) {
                const snr = dataPoint.values?.ft8_snr;
                if (snr !== null && snr !== undefined) {
                    totalSnr += snr;
                    totalSamples++;
                    // Track the most recent timestamp
                    if (!latestTimestamp || new Date(dataPoint.timestamp) > new Date(latestTimestamp)) {
                        latestTimestamp = dataPoint.timestamp;
                    }
                }
            }
            
            if (totalSamples === 0) {
                states[band] = {
                    status: 'UNKNOWN',
                    snr: null,
                    timestamp: latestTimestamp,
                    sampleCount: 0
                };
            } else {
                // Calculate average SNR
                const avgSnr = totalSnr / totalSamples;

                // Determine status based on SNR thresholds
                let status;
                if (avgSnr < 6) {
                    status = 'POOR';
                } else if (avgSnr >= 6 && avgSnr < 20) {
                    status = 'FAIR';
                } else if (avgSnr >= 20 && avgSnr < 30) {
                    status = 'GOOD';
                } else {
                    status = 'EXCELLENT';
                }

                states[band] = {
                    status: status,
                    snr: avgSnr,
                    timestamp: latestTimestamp,
                    sampleCount: totalSamples
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
            // On error, set all bands to UNKNOWN and notify listeners
            // This ensures the UI shows green (UNKNOWN is displayed as OPEN)
            const unknownStates = {};
            for (const band of this.bands) {
                unknownStates[band] = {
                    status: 'UNKNOWN',
                    snr: null,
                    timestamp: null,
                    sampleCount: 0
                };
            }
            this.bandStates = unknownStates;
            this.notifyListeners(unknownStates);
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
            band => this.bandStates[band].status === 'GOOD' || this.bandStates[band].status === 'EXCELLENT'
        );
    }

    /**
     * Get all closed bands
     * @returns {Array<string>} Array of band names that are closed
     */
    getClosedBands() {
        return Object.keys(this.bandStates).filter(
            band => this.bandStates[band].status === 'POOR'
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

// Band to keyboard shortcut mapping (matches visual order left to right)
const BAND_SHORTCUTS = {
    '160m': '1',
    '80m': '2',
    '60m': '3',
    '40m': '4',
    '30m': '5',
    '20m': '6',
    '17m': '7',
    '15m': '8',
    '12m': '9',
    '10m': '0'
};

/**
 * Initialize the band state monitor and UI
 */
function initBandStateUI() {
    // Create the monitor instance
    bandStateMonitor = new BandStateMonitor({
        pollInterval: 60 * 1000, // 1 minute
        snrThreshold: 6,
        apiEndpoint: '/api/noisefloor/aggregate'
    });

    // Add listener to update UI when band states change
    bandStateMonitor.addListener(updateBandStatusDisplay);

    // Start monitoring
    bandStateMonitor.start();

    // Add click handlers to band badges
    setupBandBadgeHandlers();

    // Add keyboard shortcuts
    setupBandKeyboardShortcuts();

    console.log('Band state monitor initialized');
}

/**
 * Setup click handlers for band badges
 */
function setupBandBadgeHandlers() {
    const badges = document.querySelectorAll('.band-status-badge');
    badges.forEach(badge => {
        const band = badge.getAttribute('data-band');
        badge.style.cursor = 'pointer';
        // Use onclick attribute for more reliable clicking
        badge.onclick = function(e) {
            e.stopPropagation();
            if (typeof setBand === 'function') {
                setBand(band);
            }
        };
    });
}

/**
 * Setup keyboard shortcuts for bands
 */
function setupBandKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Don't trigger if user is typing in an input field
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
            return;
        }

        // Find band for this key
        for (const [band, key] of Object.entries(BAND_SHORTCUTS)) {
            if (e.key === key) {
                e.preventDefault();
                if (typeof setBand === 'function') {
                    setBand(band);
                }
                break;
            }
        }
    });
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

        // Treat UNKNOWN as EXCELLENT (green) - assume band is open if no data
        const displayStatus = state.status === 'UNKNOWN' ? 'EXCELLENT' : state.status;
        
        // Update data attribute for CSS styling
        bandBadge.setAttribute('data-status', displayStatus);

        // Get keyboard shortcut for this band
        const shortcut = BAND_SHORTCUTS[band] || '';
        const shortcutText = shortcut ? `\nShortcut: ${shortcut} key` : '';

        // Add tooltip with FT8 SNR value if available
        if (state.snr !== null && state.snr !== undefined) {
            bandBadge.title = `${band}: ${state.status}\nFT8 SNR: ${state.snr.toFixed(2)} dB${shortcutText}`;
        } else {
            bandBadge.title = `${band}: No data available${shortcutText}`;
        }
    }

    // Update active state based on current frequency
    updateBandBadgeActiveStates();

    console.log('Band status display updated', states);
}

/**
 * Update the active state of band badges based on current frequency
 */
function updateBandBadgeActiveStates() {
    // Get current frequency from the frequency input
    const freqInput = document.getElementById('frequency');
    if (!freqInput) return;
    
    const currentFreq = parseInt(freqInput.value);
    if (isNaN(currentFreq)) return;

    // Get band ranges from app.js (if available)
    const bandRanges = window.bandRanges || {
        '160m': { min: 1810000, max: 2000000 },
        '80m': { min: 3500000, max: 3800000 },
        '60m': { min: 5258500, max: 5406500 },
        '40m': { min: 7000000, max: 7200000 },
        '30m': { min: 10100000, max: 10150000 },
        '20m': { min: 14000000, max: 14350000 },
        '17m': { min: 18068000, max: 18168000 },
        '15m': { min: 21000000, max: 21450000 },
        '12m': { min: 24890000, max: 24990000 },
        '10m': { min: 28000000, max: 29700000 }
    };

    // Update each band badge
    document.querySelectorAll('.band-status-badge').forEach(badge => {
        const band = badge.getAttribute('data-band');
        const range = bandRanges[band];
        
        if (range && currentFreq >= range.min && currentFreq <= range.max) {
            badge.classList.add('active');
        } else {
            badge.classList.remove('active');
        }
    });
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
    return state && (state.status === 'GOOD' || state.status === 'EXCELLENT');
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

// Export updateBandBadgeActiveStates globally for use in app.js
window.updateBandBadgeActiveStates = updateBandBadgeActiveStates;
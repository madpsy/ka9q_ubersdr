// Digital Spots Extension for ka9q UberSDR
// Displays real-time FT8, FT4, and WSPR spots from the multi-decoder

class DigitalSpotsExtension extends DecoderExtension {
    constructor() {
        super('digital-spots', {
            displayName: 'Digital Spots',
            autoTune: false,
            requiresMode: null,
            preferredBandwidth: null
        });

        this.spots = [];
        this.maxSpots = 100; // Reduced from 500 to prevent browser slowdown
        this.ageFilter = 10; // Default 10 minutes
        this.modeFilter = 'all';
        this.bandFilter = 'all'; // Start with 'all', will be updated on init
        this.snrFilter = null; // Default no limit
        this.distanceFilter = null; // Default no limit
        this.callsignFilter = '';
        this.highlightNew = true;
        this.unsubscribe = null;
        this.newSpotId = null;
        this.spotIdCounter = 0;
        this.ageUpdateInterval = null;
        this.connectionCheckInterval = null;
        this.renderPending = false; // Prevent multiple pending renders

        // Subscribe to digital spots immediately
        this.subscribeToDigitalSpots();
    }

    onInitialize() {
        console.log('Digital Spots: onInitialize called');
        this.renderTemplate();
        this.waitForDOMAndSetupHandlers();
        this.updateConnectionStatus();
        this.startConnectionMonitoring();
        this.startAgeUpdates();
        this.startRadioStateMonitoring();
        this.startFrequencyMonitoring();
        console.log('Digital Spots: onInitialize complete');
    }

    waitForDOMAndSetupHandlers() {
        const trySetup = (attempts = 0) => {
            const maxAttempts = 10;

            const ageFilter = document.getElementById('digital-spots-age-filter');
            const modeFilter = document.getElementById('digital-spots-mode-filter');
            const tbody = document.getElementById('digital-spots-tbody');

            if (ageFilter && modeFilter && tbody) {
                this.setupEventHandlers();
                console.log('Digital Spots: Event handlers set up successfully');
            } else if (attempts < maxAttempts) {
                console.log(`Digital Spots: Waiting for DOM elements (attempt ${attempts + 1}/${maxAttempts})`);
                requestAnimationFrame(() => trySetup(attempts + 1));
            } else {
                console.error('Digital Spots: Failed to find DOM elements after', maxAttempts, 'attempts');
            }
        };

        trySetup();
    }

    renderTemplate() {
        const template = window.digital_spots_template;

        if (!template) {
            console.error('Digital Spots extension template not loaded');
            return;
        }

        const container = this.getContentElement();
        if (!container) return;

        container.innerHTML = template;
    }

    getContentElement() {
        const panel = document.querySelector('.decoder-extension-panel');
        if (panel) {
            return panel.querySelector('.decoder-extension-content');
        }
        return null;
    }

    setupEventHandlers() {
        console.log('Digital Spots: Setting up event handlers');

        const container = this.getContentElement();
        if (!container) {
            console.error('Digital Spots: Container element not found');
            return;
        }

        container.addEventListener('change', (e) => {
            if (e.target.id === 'digital-spots-age-filter') {
                const value = e.target.value;
                this.ageFilter = value === 'none' ? null : parseInt(value);
                this.filterAndRenderSpots();
            } else if (e.target.id === 'digital-spots-mode-filter') {
                this.modeFilter = e.target.value;
                this.filterAndRenderSpots();
            } else if (e.target.id === 'digital-spots-band-filter') {
                this.bandFilter = e.target.value;
                this.filterAndRenderSpots();
            } else if (e.target.id === 'digital-spots-snr-filter') {
                const value = e.target.value;
                this.snrFilter = value === 'none' ? null : parseInt(value);
                this.filterAndRenderSpots();
            } else if (e.target.id === 'digital-spots-distance-filter') {
                const value = e.target.value;
                this.distanceFilter = value === 'none' ? null : parseInt(value);
                this.filterAndRenderSpots();
            }
        });

        container.addEventListener('input', (e) => {
            if (e.target.id === 'digital-spots-callsign-filter') {
                this.callsignFilter = e.target.value.toUpperCase();
                this.filterAndRenderSpots();
            }
        });

        container.addEventListener('click', (e) => {
            if (e.target.id === 'digital-spots-clear') {
                this.clearSpots();
            } else if (e.target.id === 'digital-spots-map-btn') {
                window.open('/digitalspots_map.html', '_blank');
            }
        });

        // Set initial values
        requestAnimationFrame(() => {
            const ageFilter = document.getElementById('digital-spots-age-filter');
            const modeFilter = document.getElementById('digital-spots-mode-filter');
            const bandFilter = document.getElementById('digital-spots-band-filter');
            const snrFilter = document.getElementById('digital-spots-snr-filter');
            const distanceFilter = document.getElementById('digital-spots-distance-filter');
            const callsignFilter = document.getElementById('digital-spots-callsign-filter');

            if (ageFilter) ageFilter.value = this.ageFilter.toString();
            if (modeFilter) modeFilter.value = this.modeFilter;
            if (bandFilter) bandFilter.value = this.bandFilter;
            if (snrFilter) snrFilter.value = this.snrFilter !== null ? this.snrFilter.toString() : 'none';
            if (distanceFilter) distanceFilter.value = this.distanceFilter !== null ? this.distanceFilter.toString() : 'none';
            if (callsignFilter) callsignFilter.value = this.callsignFilter;
        });
    }

    subscribeToDigitalSpots() {
        // Subscribe to digital spots via DX cluster websocket
        this.unsubscribe = this.radio.onDigitalSpot((spot) => {
            this.handleSpot(spot);
        });
    }

    startConnectionMonitoring() {
        this.updateConnectionStatus();

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
        const isBuffered = spot.timestamp && (Date.now() - new Date(spot.timestamp).getTime()) > 5000;
        this.addSpot(spot, !isBuffered);
    }

    addSpot(spot, isNewSpot = false) {
        if (isNewSpot) {
            spot._highlightId = ++this.spotIdCounter;
            this.newSpotId = spot._highlightId;
        }

        this.spots.unshift(spot);

        if (this.spots.length > this.maxSpots) {
            this.spots = this.spots.slice(0, this.maxSpots);
        }

        this.filterAndRenderSpots();
        this.updateLastUpdate();
    }

    filterAndRenderSpots() {
        const tbody = document.getElementById('digital-spots-tbody');
        if (!tbody) return;

        // Prevent multiple pending renders to avoid blocking audio thread
        if (this.renderPending) return;
        this.renderPending = true;

        // Apply all filters in a single pass for better performance
        const now = new Date();
        const maxAgeMs = this.ageFilter !== null ? this.ageFilter * 60 * 1000 : null;
        const minSnr = this.snrFilter;
        const minDistance = this.distanceFilter;
        const callsignUpper = this.callsignFilter.toUpperCase();
        
        const filteredSpots = this.spots.filter(spot => {
            // Filter out spots with empty Grid/locator
            if (!spot.locator || spot.locator.trim() === '') {
                return false;
            }

            // Age filter
            if (maxAgeMs !== null) {
                try {
                    const spotTime = new Date(spot.timestamp);
                    const ageMs = now - spotTime;
                    if (ageMs > maxAgeMs) return false;
                } catch (e) {
                    // Keep spot if timestamp is invalid
                }
            }
            
            // Mode filter
            if (this.modeFilter !== 'all' && spot.mode !== this.modeFilter) {
                return false;
            }
            
            // Band filter (using band property from backend)
            if (this.bandFilter !== 'all' && spot.band !== this.bandFilter) {
                return false;
            }
            
            // SNR filter
            if (minSnr !== null && spot.snr < minSnr) {
                return false;
            }
            
            // Distance filter
            if (minDistance !== null) {
                // Only filter if spot has distance_km field
                if (spot.distance_km !== undefined && spot.distance_km !== null) {
                    if (spot.distance_km < minDistance) {
                        return false;
                    }
                }
                // If spot doesn't have distance, keep it (don't filter out)
            }
            
            // Callsign filter
            if (callsignUpper &&
                !spot.callsign.toUpperCase().includes(callsignUpper) &&
                !(spot.locator && spot.locator.toUpperCase().includes(callsignUpper)) &&
                !(spot.message && spot.message.toUpperCase().includes(callsignUpper))) {
                return false;
            }
            
            return true;
        });

        // DEFER DOM UPDATES TO NEXT ANIMATION FRAME
        // This prevents blocking the audio thread during heavy spot activity
        requestAnimationFrame(() => {
            this.renderPending = false;

            // Use DocumentFragment for faster DOM updates
            const fragment = document.createDocumentFragment();

            if (filteredSpots.length === 0) {
                const row = document.createElement('tr');
                row.className = 'no-spots';
                const cell = document.createElement('td');
                cell.colSpan = 12;
                cell.textContent = this.spots.length === 0 ? 'Waiting for spots...' : 'No spots match filter';
                row.appendChild(cell);
                fragment.appendChild(row);
                tbody.innerHTML = '';
                tbody.appendChild(fragment);
                this.updateCount(0, this.spots.length);
                return;
            }

            let highlightedNewSpot = false;

            // Render spots using DocumentFragment
            filteredSpots.forEach((spot) => {
                const row = document.createElement('tr');

                if (this.newSpotId && spot._highlightId === this.newSpotId && this.highlightNew) {
                    row.className = 'spot-new';
                    highlightedNewSpot = true;
                    setTimeout(() => {
                        row.classList.remove('spot-new');
                    }, 500);
                }

                row.style.cursor = 'pointer';
                row.addEventListener('click', () => {
                    this.tuneToSpot(spot);
                });

                // Time
                const timeCell = document.createElement('td');
                timeCell.className = 'spot-time';
                timeCell.textContent = this.formatTime(spot.timestamp);
                row.appendChild(timeCell);

                // Age
                const ageCell = document.createElement('td');
                ageCell.className = 'spot-age';
                ageCell.setAttribute('data-timestamp', spot.timestamp);
                ageCell.textContent = this.formatAge(spot.timestamp);
                row.appendChild(ageCell);

                // Mode
                const modeCell = document.createElement('td');
                modeCell.className = `spot-mode spot-mode-${spot.mode}`;
                modeCell.textContent = spot.mode;
                row.appendChild(modeCell);

                // Frequency
                const freqCell = document.createElement('td');
                freqCell.className = 'spot-frequency';
                freqCell.textContent = this.formatFrequency(spot.frequency);
                freqCell.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.tuneToSpot(spot);
                });
                row.appendChild(freqCell);

                // Band
                const bandCell = document.createElement('td');
                bandCell.className = 'spot-band';
                bandCell.textContent = spot.band || '';
                row.appendChild(bandCell);

                // Callsign
                const callCell = document.createElement('td');
                callCell.className = 'spot-callsign';
                callCell.textContent = spot.callsign;
                callCell.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.openQRZ(spot.callsign);
                });
                row.appendChild(callCell);

                // Country
                const countryCell = document.createElement('td');
                countryCell.className = 'spot-country';
                countryCell.textContent = spot.country || '';
                row.appendChild(countryCell);

                // Grid
                const gridCell = document.createElement('td');
                gridCell.className = 'spot-grid';
                gridCell.textContent = spot.locator || '';
                row.appendChild(gridCell);

                // Distance
                const distanceCell = document.createElement('td');
                distanceCell.className = 'spot-distance';
                if (spot.distance_km !== undefined && spot.distance_km !== null) {
                    distanceCell.textContent = `${Math.round(spot.distance_km)} km`;
                } else {
                    distanceCell.textContent = '';
                }
                row.appendChild(distanceCell);

                // Bearing
                const bearingCell = document.createElement('td');
                bearingCell.className = 'spot-bearing';
                if (spot.bearing_deg !== undefined && spot.bearing_deg !== null) {
                    distanceCell.title = `${Math.round(spot.bearing_deg)}°`;
                    bearingCell.textContent = `${Math.round(spot.bearing_deg)}°`;
                } else {
                    bearingCell.textContent = '';
                }
                row.appendChild(bearingCell);

                // SNR
                const snrCell = document.createElement('td');
                snrCell.className = `spot-snr ${spot.snr >= 0 ? 'spot-snr-positive' : 'spot-snr-negative'}`;
                snrCell.textContent = spot.snr >= 0 ? `+${spot.snr}` : spot.snr;
                row.appendChild(snrCell);

                // Message
                const msgCell = document.createElement('td');
                msgCell.className = 'spot-message';
                msgCell.textContent = spot.message || '';
                row.appendChild(msgCell);

                fragment.appendChild(row);
            });

            // Clear and append all at once for better performance
            tbody.innerHTML = '';
            tbody.appendChild(fragment);

            if (highlightedNewSpot) {
                this.newSpotId = null;
            }

            this.updateCount(filteredSpots.length, this.spots.length);
        });
    }

    tuneToSpot(spot) {
        this.radio.setFrequency(spot.frequency);

        // Digital modes always use USB
        const mode = 'usb';
        this.radio.setMode(mode, false);

        this.radio.log(`Tuned to ${spot.callsign} on ${this.formatFrequency(spot.frequency)} MHz ${mode.toUpperCase()} (${spot.mode})`);
    }

    openQRZ(callsign) {
        const baseCallsign = callsign.split('/')[0];
        const url = `https://www.qrz.com/db/${baseCallsign}`;
        window.open(url, '_blank');
    }

    formatFrequency(hz) {
        return (hz / 1000000).toFixed(5);
    }

    formatTime(timeStr) {
        if (!timeStr) return '';

        try {
            const date = new Date(timeStr);
            return date.toLocaleTimeString('en-US', { hour12: false, timeZone: 'UTC' });
        } catch (e) {
            return timeStr;
        }
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

    updateStatus(status, text) {
        const badge = document.getElementById('digital-spots-status-badge');
        if (badge) {
            badge.textContent = text;
            badge.className = `status-badge status-${status}`;
        }
    }

    updateCount(filteredCount, totalCount = null) {
        const countEl = document.getElementById('digital-spots-count');
        if (countEl) {
            if (totalCount !== null && filteredCount !== totalCount) {
                countEl.textContent = `${filteredCount} spot${filteredCount !== 1 ? 's' : ''} of ${totalCount} total`;
            } else {
                countEl.textContent = `${filteredCount} spot${filteredCount !== 1 ? 's' : ''}`;
            }
        }
    }

    updateLastUpdate() {
        const lastUpdateEl = document.getElementById('digital-spots-last-update');
        if (lastUpdateEl) {
            const now = new Date();
            lastUpdateEl.textContent = `Last: ${now.toLocaleTimeString()}`;
        }
    }

    clearSpots() {
        this.spots = [];
        this.filterAndRenderSpots();
    }

    startAgeUpdates() {
        this.ageUpdateInterval = setInterval(() => {
            // Only update age text, don't re-render entire table
            const ageCells = document.querySelectorAll('.spot-age');
            ageCells.forEach(cell => {
                const timestamp = cell.getAttribute('data-timestamp');
                if (timestamp) {
                    cell.textContent = this.formatAge(timestamp);
                }
            });

            // Only re-filter if we have an age filter and enough time has passed
            // Check every 10 seconds instead of every second
            if (this.ageFilter !== null && !this.lastAgeFilterCheck) {
                this.lastAgeFilterCheck = Date.now();
            }
            
            if (this.ageFilter !== null && this.lastAgeFilterCheck &&
                (Date.now() - this.lastAgeFilterCheck) > 10000) {
                this.lastAgeFilterCheck = Date.now();
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
        this.radioStateInterval = setInterval(() => {
            // Could add current spot indicator here if needed
        }, 500);
    }

    stopRadioStateMonitoring() {
        if (this.radioStateInterval) {
            clearInterval(this.radioStateInterval);
            this.radioStateInterval = null;
        }
    }

    startFrequencyMonitoring() {
        console.log('Digital Spots: startFrequencyMonitoring called');
        // Update band filter based on current frequency immediately
        this.updateBandFilterFromFrequency();
    }

    stopFrequencyMonitoring() {
        // No cleanup needed - using base class event subscription
    }

    updateBandFilterFromFrequency() {
        const currentFreq = this.radio.getFrequency();
        console.log('Digital Spots: updateBandFilterFromFrequency - currentFreq:', currentFreq);

        if (!currentFreq) {
            console.log('Digital Spots: No current frequency');
            return;
        }

        const band = this.radio.getFrequencyBand(currentFreq);
        console.log('Digital Spots: Detected band:', band, 'for frequency:', currentFreq);

        if (!band) {
            console.log('Digital Spots: No band detected for frequency');
            return;
        }

        const bandFilter = document.getElementById('digital-spots-band-filter');
        if (!bandFilter) {
            console.log('Digital Spots: Band filter element not found');
            return;
        }

        // Check if the band exists in the dropdown options
        const bandOption = Array.from(bandFilter.options).find(
            option => option.value === band
        );

        console.log('Digital Spots: Band option found:', !!bandOption, 'Current filter:', this.bandFilter, 'New band:', band);

        if (bandOption) {
            // Update the dropdown value
            bandFilter.value = band;

            // Only update internal state and re-filter if band actually changed
            if (this.bandFilter !== band) {
                this.bandFilter = band;
                this.filterAndRenderSpots();
                console.log(`Digital Spots: Auto-updated band filter to ${band}`);
            } else {
                console.log('Digital Spots: Band filter already set to', band, '- dropdown updated but no re-filter needed');
            }
        } else {
            console.log('Digital Spots: Band', band, 'not found in dropdown options');
        }
    }

    // Override base class method to handle frequency changes
    onFrequencyChanged(frequency) {
        console.log('Digital Spots: onFrequencyChanged called with frequency:', frequency);

        // Update band filter when frequency changes
        this.updateBandFilterFromFrequency();
    }

    // Also add polling as a backup in case events don't fire
    startFrequencyPolling() {
        // Poll frequency every 500ms as backup
        this.frequencyPollInterval = setInterval(() => {
            const currentFreq = this.radio.getFrequency();
            if (currentFreq !== this.lastPolledFrequency) {
                console.log('Digital Spots: Frequency changed via polling:', this.lastPolledFrequency, '->', currentFreq);
                this.lastPolledFrequency = currentFreq;
                this.updateBandFilterFromFrequency();
            }
        }, 500);
    }

    stopFrequencyPolling() {
        if (this.frequencyPollInterval) {
            clearInterval(this.frequencyPollInterval);
            this.frequencyPollInterval = null;
        }
    }

    onEnable() {
        if (!this.unsubscribe) {
            this.subscribeToDigitalSpots();
        }

        this.updateConnectionStatus();
        this.startConnectionMonitoring();
        this.startAgeUpdates();
        this.startRadioStateMonitoring();
        this.startFrequencyMonitoring();
        this.startFrequencyPolling();
    }

    onDisable() {
        this.stopConnectionMonitoring();
        this.stopAgeUpdates();
        this.stopRadioStateMonitoring();
        this.stopFrequencyMonitoring();
        this.stopFrequencyPolling();

        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
    }

    onProcessAudio(dataArray) {
        // Digital spots extension doesn't process audio
    }
}

// Register the extension
if (window.decoderManager) {
    const digitalSpotsExtension = new DigitalSpotsExtension();
    window.decoderManager.register(digitalSpotsExtension);
    console.log('Digital Spots extension registered:', digitalSpotsExtension);
} else {
    console.error('decoderManager not available for Digital Spots extension');
}
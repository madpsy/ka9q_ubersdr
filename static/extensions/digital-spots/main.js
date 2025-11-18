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
        this.maxSpots = 1000; // Store up to 1000 spots in memory for excellent band filtering
        this.ageFilter = 10; // Default 10 minutes
        this.modeFilter = 'all';
        this.bandFilter = 'all'; // Start with 'all', will be updated on init
        this.snrFilter = null; // Default no limit
        this.distanceFilter = null; // Default no limit
        this.callsignFilter = '';
        this.highlightNew = true;
        this.showBadges = true; // Default to showing badges
        this.unsubscribe = null;
        this.newSpotId = null;
        this.spotIdCounter = 0;
        this.ageUpdateInterval = null;
        this.connectionCheckInterval = null;
        this.renderPending = false; // Prevent multiple pending renders
        this.currentModalCountry = null; // Track currently open modal
        this.currentModalBand = null;
        this.currentModalModeFilter = 'all'; // Track modal mode filter
        this.currentModalTab = 'graph'; // Track current modal tab (graph or table)

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

        // Initialize badges display
        this.updateBadges();

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
                this.updateBadges();
            } else if (e.target.id === 'digital-spots-snr-filter') {
                const value = e.target.value;
                this.snrFilter = value === 'none' ? null : parseInt(value);
                this.filterAndRenderSpots();
            } else if (e.target.id === 'digital-spots-distance-filter') {
                const value = e.target.value;
                this.distanceFilter = value === 'none' ? null : parseInt(value);
                this.filterAndRenderSpots();
            } else if (e.target.id === 'digital-spots-show-badges') {
                this.showBadges = e.target.checked;
                this.updateBadges();
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

            const showBadgesCheckbox = document.getElementById('digital-spots-show-badges');
            if (showBadgesCheckbox) showBadgesCheckbox.checked = this.showBadges;
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
        this.updateBadges();

        // Update modal if it's open
        if (this.currentModalCountry && this.currentModalBand) {
            this.refreshModalContent();
        }
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

            // Update badges after rendering spots
            this.updateBadges();
        });
    }

    updateBadges() {
        // Use the main page container instead of the extension panel container
        const container = document.getElementById('digital-spots-badges-main');
        if (!container) return;

        // Hide container if badges are disabled or extension is not enabled
        if (!this.showBadges || !this.enabled) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'flex';

        // Get current band from filter
        const currentBand = this.bandFilter;

        // If no specific band is selected, show message
        if (currentBand === 'all') {
            container.classList.add('empty');
            container.innerHTML = 'Select a specific band to see country badges';
            return;
        }

        // Get spots for current band from the last 10 minutes
        const now = Date.now();
        const tenMinutesAgo = now - (10 * 60 * 1000);

        const recentBandSpots = this.spots.filter(spot => {
            if (spot.band !== currentBand || !spot.country) return false;
            const spotTime = new Date(spot.timestamp).getTime();
            return spotTime >= tenMinutesAgo;
        });

        if (recentBandSpots.length === 0) {
            container.classList.add('empty');
            container.innerHTML = `No countries seen on ${currentBand} in the last 10 minutes`;
            return;
        }

        container.classList.remove('empty');

        // Track unique countries with their most recent spot data
        const countryMap = new Map();

        recentBandSpots.forEach(spot => {
            const country = spot.country;
            if (!country) return;

            const spotTime = new Date(spot.timestamp).getTime();

            if (!countryMap.has(country) || spotTime > countryMap.get(country).timestamp) {
                countryMap.set(country, {
                    timestamp: spotTime,
                    mode: spot.mode,
                    snr: spot.snr,
                    callsign: spot.callsign
                });
            }
        });

        // Convert to array and sort alphabetically by country name
        const countries = Array.from(countryMap.entries())
            .sort((a, b) => a[0].localeCompare(b[0])); // Sort alphabetically by country name

        // Create badges
        const fragment = document.createDocumentFragment();

        countries.forEach(([country, spotData]) => {
            const badge = document.createElement('span');
            badge.className = 'country-badge';
            badge.textContent = country;
            const snrText = spotData.snr >= 0 ? `+${spotData.snr}` : spotData.snr;
            badge.title = `${country} on ${currentBand}\nLast: ${spotData.callsign}\nMode: ${spotData.mode}\nSNR: ${snrText} dB`;

            // Add click handler to open modal
            badge.addEventListener('click', () => {
                this.openCountryModal(country, currentBand);
            });

            fragment.appendChild(badge);
        });

        container.innerHTML = '';
        container.appendChild(fragment);
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

            // Update modal age cells if modal is open
            const modalAgeCells = document.querySelectorAll('.modal-age');
            modalAgeCells.forEach(cell => {
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

            // Refresh modal content every second if it's open
            if (this.currentModalCountry && this.currentModalBand) {
                this.refreshModalContent();
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

        // Show badges when extension is enabled
        this.updateBadges();
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

        // Hide badges when extension is disabled
        const container = document.getElementById('digital-spots-badges-main');
        if (container) {
            container.style.display = 'none';
        }
    }

    onProcessAudio(dataArray) {
        // Digital spots extension doesn't process audio
    }

    openCountryModal(country, band) {
        // Track which modal is open
        this.currentModalCountry = country;
        this.currentModalBand = band;

        const modal = document.getElementById('country-spots-modal');
        const modalTitle = document.getElementById('country-spots-modal-title');

        if (!modal || !modalTitle) {
            console.error('Modal elements not found');
            return;
        }

        // Populate initial content (this will also update the title with count)
        this.refreshModalContent();

        // Show modal
        modal.style.display = 'flex';

        // Setup close handlers if not already done
        if (!this.modalHandlersSetup) {
            this.setupModalHandlers();
            this.modalHandlersSetup = true;
        }

        // Reset mode filter to 'all' when opening modal
        this.currentModalModeFilter = 'all';
        const modeFilter = document.getElementById('country-spots-modal-mode-filter');
        if (modeFilter) {
            modeFilter.value = 'all';
        }

        // Set default tab to graph
        this.switchModalTab('graph');
    }

    refreshModalContent() {
        // Refresh both table and graph content
        this.refreshModalTable();
        if (this.currentModalTab === 'graph') {
            this.refreshModalGraphs();
        }
    }

    refreshModalTable() {
        const modalTbody = document.getElementById('country-spots-modal-tbody');

        if (!modalTbody || !this.currentModalCountry || !this.currentModalBand) {
            return;
        }

        const country = this.currentModalCountry;
        const band = this.currentModalBand;

        // Get spots for this country and band from the last 10 minutes
        const now = Date.now();
        const tenMinutesAgo = now - (10 * 60 * 1000);

        const countrySpots = this.spots.filter(spot => {
            if (spot.band !== band || spot.country !== country) return false;

            // Apply mode filter
            if (this.currentModalModeFilter !== 'all' && spot.mode !== this.currentModalModeFilter) {
                return false;
            }

            const spotTime = new Date(spot.timestamp).getTime();
            return spotTime >= tenMinutesAgo;
        });

        // Get unique callsigns with their most recent spot data
        const callsignMap = new Map();

        countrySpots.forEach(spot => {
            const callsign = spot.callsign;
            const spotTime = new Date(spot.timestamp).getTime();

            if (!callsignMap.has(callsign) || spotTime > callsignMap.get(callsign).timestamp) {
                callsignMap.set(callsign, {
                    ...spot,
                    timestamp: spotTime
                });
            }
        });

        // Convert to array and sort by timestamp (newest first)
        const uniqueSpots = Array.from(callsignMap.values())
            .sort((a, b) => b.timestamp - a.timestamp);

        // Update modal title with count
        const modalTitle = document.getElementById('country-spots-modal-title');
        if (modalTitle) {
            const count = uniqueSpots.length;
            modalTitle.textContent = `${country} on ${band} (${count} callsign${count !== 1 ? 's' : ''})`;
        }

        // Populate modal table
        const fragment = document.createDocumentFragment();

        if (uniqueSpots.length === 0) {
            const row = document.createElement('tr');
            const cell = document.createElement('td');
            cell.colSpan = 8;
            cell.textContent = 'No spots found';
            cell.style.textAlign = 'center';
            cell.style.color = '#888';
            row.appendChild(cell);
            fragment.appendChild(row);
        } else {
            uniqueSpots.forEach(spot => {
                const row = document.createElement('tr');

                // Callsign - clickable to open QRZ
                const callsignCell = document.createElement('td');
                callsignCell.className = 'modal-callsign';
                callsignCell.textContent = spot.callsign;
                callsignCell.style.cursor = 'pointer';
                callsignCell.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.openQRZ(spot.callsign);
                });
                row.appendChild(callsignCell);

                // Mode
                const modeCell = document.createElement('td');
                modeCell.className = `modal-mode modal-mode-${spot.mode}`;
                modeCell.textContent = spot.mode;
                row.appendChild(modeCell);

                // SNR
                const snrCell = document.createElement('td');
                snrCell.className = `modal-snr ${spot.snr >= 0 ? 'modal-snr-positive' : 'modal-snr-negative'}`;
                snrCell.textContent = spot.snr >= 0 ? `+${spot.snr}` : spot.snr;
                row.appendChild(snrCell);

                // Grid
                const gridCell = document.createElement('td');
                gridCell.className = 'modal-grid';
                gridCell.textContent = spot.locator || '';
                row.appendChild(gridCell);

                // Distance
                const distanceCell = document.createElement('td');
                distanceCell.className = 'modal-distance';
                if (spot.distance_km !== undefined && spot.distance_km !== null) {
                    distanceCell.textContent = `${Math.round(spot.distance_km)} km`;
                } else {
                    distanceCell.textContent = '';
                }
                row.appendChild(distanceCell);

                // Bearing
                const bearingCell = document.createElement('td');
                bearingCell.className = 'modal-bearing';
                if (spot.bearing_deg !== undefined && spot.bearing_deg !== null) {
                    bearingCell.textContent = `${Math.round(spot.bearing_deg)}°`;
                } else {
                    bearingCell.textContent = '';
                }
                row.appendChild(bearingCell);

                // Age
                const ageCell = document.createElement('td');
                ageCell.className = 'modal-age';
                ageCell.setAttribute('data-timestamp', spot.timestamp);
                ageCell.textContent = this.formatAge(spot.timestamp);
                row.appendChild(ageCell);

                // Message
                const msgCell = document.createElement('td');
                msgCell.className = 'modal-message';
                msgCell.textContent = spot.message || '';
                row.appendChild(msgCell);

                fragment.appendChild(row);
            });
        }

        modalTbody.innerHTML = '';
        modalTbody.appendChild(fragment);
    }

    closeCountryModal() {
        // Clear tracking
        this.currentModalCountry = null;
        this.currentModalBand = null;

        const modal = document.getElementById('country-spots-modal');
        if (modal) {
            modal.style.display = 'none';
        }
    }

    setupModalHandlers() {
        const modal = document.getElementById('country-spots-modal');
        const closeBtn = document.getElementById('country-spots-modal-close');
        const modeFilter = document.getElementById('country-spots-modal-mode-filter');

        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                this.closeCountryModal();
            });
        }

        if (modeFilter) {
            modeFilter.addEventListener('change', (e) => {
                this.currentModalModeFilter = e.target.value;
                this.refreshModalContent();
            });
        }

        // Setup tab switching
        const tabButtons = document.querySelectorAll('.country-spots-tab');
        tabButtons.forEach(button => {
            button.addEventListener('click', () => {
                const tab = button.getAttribute('data-tab');
                this.switchModalTab(tab);
            });
        });

        if (modal) {
            // Close modal when clicking outside the content
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    this.closeCountryModal();
                }
            });

            // Close modal on Escape key
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && modal.style.display === 'flex') {
                    this.closeCountryModal();
                }
            });
        }
    }

    switchModalTab(tab) {
        this.currentModalTab = tab;

        // Update tab buttons
        const tabButtons = document.querySelectorAll('.country-spots-tab');
        tabButtons.forEach(button => {
            if (button.getAttribute('data-tab') === tab) {
                button.classList.add('active');
            } else {
                button.classList.remove('active');
            }
        });

        // Update tab content
        const tabContents = document.querySelectorAll('.country-spots-tab-content');
        tabContents.forEach(content => {
            if (content.id === `country-spots-${tab}-tab`) {
                content.classList.add('active');
            } else {
                content.classList.remove('active');
            }
        });

        // Refresh content if switching to graph tab
        if (tab === 'graph') {
            this.refreshModalGraphs();
        }
    }

    refreshModalGraphs() {
        if (!this.currentModalCountry || !this.currentModalBand) {
            return;
        }

        const country = this.currentModalCountry;
        const band = this.currentModalBand;

        // Get spots for this country and band from the last 10 minutes
        const now = Date.now();
        const tenMinutesAgo = now - (10 * 60 * 1000);

        const countrySpots = this.spots.filter(spot => {
            if (spot.band !== band || spot.country !== country) return false;

            // Apply mode filter
            if (this.currentModalModeFilter !== 'all' && spot.mode !== this.currentModalModeFilter) {
                return false;
            }

            const spotTime = new Date(spot.timestamp).getTime();
            return spotTime >= tenMinutesAgo;
        });

        // Group spots by mode
        const spotsByMode = {};
        countrySpots.forEach(spot => {
            if (!spotsByMode[spot.mode]) {
                spotsByMode[spot.mode] = [];
            }
            spotsByMode[spot.mode].push(spot);
        });

        // Create a signature of current data to detect changes
        const modes = Object.keys(spotsByMode).sort();
        const dataSignature = modes.map(m => `${m}:${spotsByMode[m].length}`).join('|');

        // Only re-render if data has changed
        if (this._lastGraphSignature === dataSignature) {
            return;
        }
        this._lastGraphSignature = dataSignature;

        // Render graphs
        const container = document.getElementById('country-spots-graphs-container');
        if (!container) return;

        // Save scroll position before updating
        const scrollTop = container.scrollTop;

        container.innerHTML = '';

        if (modes.length === 0) {
            container.innerHTML = '<div class="country-spots-graph-no-data">No spots found in the last 10 minutes</div>';
            return;
        }

        modes.forEach(mode => {
            const modeSpots = spotsByMode[mode];
            this.renderModeGraph(container, mode, modeSpots);
        });

        // Restore scroll position after rendering
        requestAnimationFrame(() => {
            container.scrollTop = scrollTop;
        });
    }

    renderModeGraph(container, mode, spots) {
        // Create graph container
        const graphDiv = document.createElement('div');
        graphDiv.className = 'country-spots-graph';

        const title = document.createElement('div');
        title.className = 'country-spots-graph-title';
        title.textContent = `${mode} - ${spots.length} spot${spots.length !== 1 ? 's' : ''}`;
        graphDiv.appendChild(title);

        const canvasContainer = document.createElement('div');
        canvasContainer.className = 'country-spots-graph-canvas-container';

        const canvas = document.createElement('canvas');
        canvas.className = 'country-spots-graph-canvas';
        canvasContainer.appendChild(canvas);
        graphDiv.appendChild(canvasContainer);

        container.appendChild(graphDiv);

        // Draw graph on canvas
        this.drawFrequencyTimeGraph(canvas, spots, mode);
    }

    drawFrequencyTimeGraph(canvas, spots, mode) {
        const ctx = canvas.getContext('2d');
        const rect = canvas.parentElement.getBoundingClientRect();

        // Set canvas size to match container
        canvas.width = rect.width;
        canvas.height = rect.height;

        const width = canvas.width;
        const height = canvas.height;

        // Clear canvas
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, width, height);

        if (spots.length === 0) {
            ctx.fillStyle = '#666';
            ctx.font = '14px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('No spots to display', width / 2, height / 2);
            return;
        }

        // Calculate time range (last 10 minutes)
        const now = Date.now();
        const tenMinutesAgo = now - (10 * 60 * 1000);
        const timeRange = now - tenMinutesAgo;

        // Calculate frequency range
        const frequencies = spots.map(s => s.frequency);
        const minFreq = Math.min(...frequencies);
        const maxFreq = Math.max(...frequencies);
        const freqRange = maxFreq - minFreq;
        const freqPadding = freqRange * 0.1 || 1000; // 10% padding or 1kHz minimum

        // Graph margins
        const marginLeft = 80;
        const marginRight = 20;
        const marginTop = 20;
        const marginBottom = 40;
        const graphWidth = width - marginLeft - marginRight;
        const graphHeight = height - marginTop - marginBottom;

        // Draw axes
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(marginLeft, marginTop);
        ctx.lineTo(marginLeft, height - marginBottom);
        ctx.lineTo(width - marginRight, height - marginBottom);
        ctx.stroke();

        // Draw Y-axis labels (Frequency in MHz)
        ctx.fillStyle = '#aaa';
        ctx.font = '11px monospace';
        ctx.textAlign = 'right';

        const numYTicks = 5;
        for (let i = 0; i <= numYTicks; i++) {
            const freq = minFreq - freqPadding + (freqRange + 2 * freqPadding) * (1 - i / numYTicks);
            const y = marginTop + (graphHeight * i / numYTicks);

            ctx.fillText((freq / 1000000).toFixed(5), marginLeft - 10, y + 4);

            // Draw grid line
            ctx.strokeStyle = '#2a2a2a';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(marginLeft, y);
            ctx.lineTo(width - marginRight, y);
            ctx.stroke();
        }

        // Draw X-axis labels (Time)
        ctx.textAlign = 'center';
        const numXTicks = 5;
        for (let i = 0; i <= numXTicks; i++) {
            const time = tenMinutesAgo + (timeRange * i / numXTicks);
            const x = marginLeft + (graphWidth * i / numXTicks);
            const date = new Date(time);
            const timeStr = date.toLocaleTimeString('en-US', {
                hour12: false,
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'UTC'
            });

            ctx.fillStyle = '#aaa';
            ctx.fillText(timeStr, x, height - marginBottom + 20);

            // Draw grid line
            ctx.strokeStyle = '#2a2a2a';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, marginTop);
            ctx.lineTo(x, height - marginBottom);
            ctx.stroke();
        }

        // Draw X-axis label
        ctx.fillStyle = '#888';
        ctx.font = '12px Arial';
        ctx.fillText('Time (UTC)', width / 2, height - 5);

        // Draw Y-axis label (moved further left to avoid overlap)
        ctx.save();
        ctx.translate(12, height / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText('Frequency (MHz)', 0, 0);
        ctx.restore();

        // Plot spots with callsigns as markers
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Color based on mode
        let textColor;
        switch (mode) {
            case 'FT8':
                textColor = '#28a745';
                break;
            case 'FT4':
                textColor = '#17a2b8';
                break;
            case 'WSPR':
                textColor = '#ffc107';
                break;
            default:
                textColor = '#4a9eff';
        }

        spots.forEach(spot => {
            const spotTime = new Date(spot.timestamp).getTime();
            const x = marginLeft + ((spotTime - tenMinutesAgo) / timeRange) * graphWidth;
            const y = height - marginBottom - ((spot.frequency - (minFreq - freqPadding)) / (freqRange + 2 * freqPadding)) * graphHeight;

            // Draw callsign as text
            ctx.fillStyle = textColor;
            ctx.fillText(spot.callsign, x, y);

            // Add a small dot for better visibility
            ctx.fillStyle = textColor;
            ctx.beginPath();
            ctx.arc(x, y, 2, 0, 2 * Math.PI);
            ctx.fill();
        });
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
// CW Spots Extension for ka9q UberSDR
// Displays real-time CW spots from CW Skimmer

class CWSpotsExtension extends DecoderExtension {
    constructor() {
        super('cw-spots', {
            displayName: 'CW Spots',
            autoTune: false,
            requiresMode: null,
            preferredBandwidth: null
        });

        this.spots = [];
        this.maxSpots = 5000;
        this.ageFilter = 10; // Default 10 minutes
        this.bandFilter = 'all';
        this.snrFilter = null;
        this.wpmFilter = null;
        this.distanceFilter = null;
        this.callsignFilter = '';
        this.highlightNew = true;
        this.unsubscribe = null;
        this.newSpotId = null;
        this.spotIdCounter = 0;
        this.ageUpdateInterval = null;
        this.connectionCheckInterval = null;
        this.renderPending = false;
        
        // Performance optimization
        this.filteredSpotsCache = null;
        this.lastFilterParams = null;
        this.maxDisplayRows = 500;
        this.showingAllRows = false;
        this.callsignFilterDebounceTimer = null;
        this.filterDebounceDelay = 300;
        this.pendingSpots = [];
        this.renderThrottleTimer = null;

        // Subscribe to CW spots immediately
        this.subscribeToCWSpots();
    }

    onInitialize() {
        console.log('CW Spots: onInitialize called');
        this.renderTemplate();
        this.waitForDOMAndSetupHandlers();
        this.updateConnectionStatus();
        this.startConnectionMonitoring();
        this.startAgeUpdates();
        this.startRadioStateMonitoring();
        this.startFrequencyMonitoring();
        console.log('CW Spots: onInitialize complete');
    }

    waitForDOMAndSetupHandlers() {
        const trySetup = (attempts = 0) => {
            const maxAttempts = 10;

            const ageFilter = document.getElementById('cw-spots-age-filter');
            const bandFilter = document.getElementById('cw-spots-band-filter');
            const tbody = document.getElementById('cw-spots-tbody');

            if (ageFilter && bandFilter && tbody) {
                this.setupEventHandlers();
                console.log('CW Spots: Event handlers set up successfully');
            } else if (attempts < maxAttempts) {
                console.log(`CW Spots: Waiting for DOM elements (attempt ${attempts + 1}/${maxAttempts})`);
                requestAnimationFrame(() => trySetup(attempts + 1));
            } else {
                console.error('CW Spots: Failed to find DOM elements after', maxAttempts, 'attempts');
            }
        };

        trySetup();
    }

    renderTemplate() {
        const template = window.cw_spots_template;

        if (!template) {
            console.error('CW Spots extension template not loaded');
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
        console.log('CW Spots: Setting up event handlers');

        const container = this.getContentElement();
        if (!container) {
            console.error('CW Spots: Container element not found');
            return;
        }

        container.addEventListener('change', (e) => {
            if (e.target.id === 'cw-spots-age-filter') {
                const value = e.target.value;
                this.ageFilter = value === 'none' ? null : parseInt(value);
                this.showingAllRows = false;
                this.filterAndRenderSpots();
            } else if (e.target.id === 'cw-spots-band-filter') {
                this.bandFilter = e.target.value;
                this.showingAllRows = false;
                this.filterAndRenderSpots();
            } else if (e.target.id === 'cw-spots-snr-filter') {
                const value = e.target.value;
                this.snrFilter = value === 'none' ? null : parseInt(value);
                this.showingAllRows = false;
                this.filterAndRenderSpots();
            } else if (e.target.id === 'cw-spots-wpm-filter') {
                const value = e.target.value;
                this.wpmFilter = value === 'none' ? null : parseInt(value);
                this.showingAllRows = false;
                this.filterAndRenderSpots();
            } else if (e.target.id === 'cw-spots-distance-filter') {
                const value = e.target.value;
                this.distanceFilter = value === 'none' ? null : parseInt(value);
                this.showingAllRows = false;
                this.filterAndRenderSpots();
            }
        });

        container.addEventListener('input', (e) => {
            if (e.target.id === 'cw-spots-callsign-filter') {
                if (this.callsignFilterDebounceTimer) {
                    clearTimeout(this.callsignFilterDebounceTimer);
                }
                
                this.callsignFilter = e.target.value.toUpperCase();
                this.callsignFilterDebounceTimer = setTimeout(() => {
                    this.showingAllRows = false;
                    this.filterAndRenderSpots();
                }, this.filterDebounceDelay);
            }
        });

        container.addEventListener('click', (e) => {
            if (e.target.id === 'cw-spots-clear') {
                this.clearSpots();
            }
        });

        // Set initial values
        requestAnimationFrame(() => {
            const ageFilter = document.getElementById('cw-spots-age-filter');
            const bandFilter = document.getElementById('cw-spots-band-filter');
            const snrFilter = document.getElementById('cw-spots-snr-filter');
            const wpmFilter = document.getElementById('cw-spots-wpm-filter');
            const distanceFilter = document.getElementById('cw-spots-distance-filter');
            const callsignFilter = document.getElementById('cw-spots-callsign-filter');

            if (ageFilter) ageFilter.value = this.ageFilter.toString();
            if (bandFilter) bandFilter.value = this.bandFilter;
            if (snrFilter) snrFilter.value = this.snrFilter !== null ? this.snrFilter.toString() : 'none';
            if (wpmFilter) wpmFilter.value = this.wpmFilter !== null ? this.wpmFilter.toString() : 'none';
            if (distanceFilter) distanceFilter.value = this.distanceFilter !== null ? this.distanceFilter.toString() : 'none';
            if (callsignFilter) callsignFilter.value = this.callsignFilter;
        });
    }

    subscribeToCWSpots() {
        // Subscribe to CW spots via DX cluster websocket
        this.unsubscribe = this.radio.onCWSpot((spot) => {
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
        const isBuffered = spot.time && (Date.now() - new Date(spot.time).getTime()) > 5000;
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

        // Invalidate cache
        this.filteredSpotsCache = null;

        // Only update UI if panel is visible
        const panel = document.querySelector('.decoder-extension-panel');
        const isPanelVisible = panel && panel.style.display !== 'none';

        if (isPanelVisible) {
            this.pendingSpots.push(spot);

            if (!this.renderThrottleTimer) {
                this.renderThrottleTimer = setTimeout(() => {
                    this.renderThrottleTimer = null;
                    this.renderPendingSpots();
                    this.updateLastUpdate();
                }, 500);
            }
        }
    }

    renderPendingSpots() {
        if (this.pendingSpots.length === 0) return;

        const tbody = document.getElementById('cw-spots-tbody');
        if (!tbody) return;

        const now = Date.now();
        const nowDate = new Date(now);
        const maxAgeMs = this.ageFilter !== null ? this.ageFilter * 60 * 1000 : null;
        const minSnr = this.snrFilter;
        const minWpm = this.wpmFilter;
        const minDistance = this.distanceFilter;
        const callsignUpper = this.callsignFilter.toUpperCase();

        const newFilteredSpots = this.pendingSpots.filter(spot => {
            // Age filter
            if (maxAgeMs !== null) {
                try {
                    const spotTime = new Date(spot.time);
                    const ageMs = nowDate - spotTime;
                    if (ageMs > maxAgeMs) return false;
                } catch (e) {
                    return false;
                }
            }
            // Band filter
            if (this.bandFilter !== 'all' && spot.band !== this.bandFilter) return false;
            // SNR filter
            if (minSnr !== null && spot.snr < minSnr) return false;
            // WPM filter
            if (minWpm !== null && spot.wpm < minWpm) return false;
            // Distance filter
            if (minDistance !== null && spot.distance_km !== undefined && spot.distance_km !== null) {
                if (spot.distance_km < minDistance) return false;
            }
            // Callsign filter
            if (callsignUpper &&
                !spot.dx_call.toUpperCase().includes(callsignUpper) &&
                !(spot.country && spot.country.toUpperCase().includes(callsignUpper))) {
                return false;
            }
            return true;
        });

        this.pendingSpots = [];

        if (newFilteredSpots.length === 0) return;

        const fragment = document.createDocumentFragment();
        newFilteredSpots.forEach(spot => {
            const row = this.createSpotRow(spot);
            fragment.appendChild(row);
        });

        if (tbody.firstChild) {
            tbody.insertBefore(fragment, tbody.firstChild);
        } else {
            tbody.appendChild(fragment);
        }

        // Enforce display limit
        const displayLimit = this.showingAllRows ? Infinity : this.maxDisplayRows;
        while (tbody.children.length > displayLimit + 1) {
            const lastChild = tbody.lastChild;
            if (lastChild && !lastChild.classList.contains('show-more-row') && !lastChild.classList.contains('show-less-row')) {
                tbody.removeChild(lastChild);
            } else {
                break;
            }
        }

        this.updateCount(tbody.children.length, this.spots.length);
    }

    createSpotRow(spot) {
        const row = document.createElement('tr');

        if (this.newSpotId && spot._highlightId === this.newSpotId && this.highlightNew) {
            row.className = 'spot-new';
            setTimeout(() => {
                row.classList.remove('spot-new');
            }, 500);
            this.newSpotId = null;
        }

        // Time
        const timeCell = document.createElement('td');
        timeCell.className = 'spot-time';
        timeCell.textContent = this.formatTime(spot.time);
        row.appendChild(timeCell);

        // Age
        const ageCell = document.createElement('td');
        ageCell.className = 'spot-age';
        ageCell.setAttribute('data-timestamp', spot.time);
        ageCell.textContent = this.formatAge(spot.time);
        row.appendChild(ageCell);

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
        callCell.textContent = spot.dx_call;
        callCell.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openQRZ(spot.dx_call);
        });
        row.appendChild(callCell);

        // Country
        const countryCell = document.createElement('td');
        countryCell.className = 'spot-country';
        countryCell.textContent = spot.country || '';
        row.appendChild(countryCell);

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

        // WPM
        const wpmCell = document.createElement('td');
        wpmCell.className = 'spot-wpm';
        wpmCell.textContent = spot.wpm || '';
        row.appendChild(wpmCell);

        // Comment
        const commentCell = document.createElement('td');
        commentCell.className = 'spot-comment';
        commentCell.textContent = spot.comment || '';
        row.appendChild(commentCell);

        return row;
    }

    filterAndRenderSpots(forceRefresh = false) {
        const tbody = document.getElementById('cw-spots-tbody');
        if (!tbody) return;

        if (this.renderPending) return;
        this.renderPending = true;

        const now = Date.now();
        const filterParams = JSON.stringify({
            age: this.ageFilter,
            band: this.bandFilter,
            snr: this.snrFilter,
            wpm: this.wpmFilter,
            distance: this.distanceFilter,
            callsign: this.callsignFilter,
            spotCount: this.spots.length
        });

        let filteredSpots;
        if (!forceRefresh && this.filteredSpotsCache && this.lastFilterParams === filterParams) {
            filteredSpots = this.filteredSpotsCache;
        } else {
            const nowDate = new Date(now);
            const maxAgeMs = this.ageFilter !== null ? this.ageFilter * 60 * 1000 : null;
            const minSnr = this.snrFilter;
            const minWpm = this.wpmFilter;
            const minDistance = this.distanceFilter;
            const callsignUpper = this.callsignFilter.toUpperCase();

            filteredSpots = this.spots.filter(spot => {
                // Age filter
                if (maxAgeMs !== null) {
                    try {
                        const spotTime = new Date(spot.time);
                        const ageMs = nowDate - spotTime;
                        if (ageMs > maxAgeMs) return false;
                    } catch (e) {
                        return false;
                    }
                }
                // Band filter
                if (this.bandFilter !== 'all' && spot.band !== this.bandFilter) return false;
                // SNR filter
                if (minSnr !== null && spot.snr < minSnr) return false;
                // WPM filter
                if (minWpm !== null && spot.wpm < minWpm) return false;
                // Distance filter
                if (minDistance !== null) {
                    if (spot.distance_km !== undefined && spot.distance_km !== null) {
                        if (spot.distance_km < minDistance) return false;
                    }
                }
                // Callsign filter
                if (callsignUpper &&
                    !spot.dx_call.toUpperCase().includes(callsignUpper) &&
                    !(spot.country && spot.country.toUpperCase().includes(callsignUpper))) {
                    return false;
                }
                return true;
            });

            this.filteredSpotsCache = filteredSpots;
            this.lastFilterParams = filterParams;
        }

        requestAnimationFrame(() => {
            this.renderPending = false;

            const fragment = document.createDocumentFragment();

            if (filteredSpots.length === 0) {
                const row = document.createElement('tr');
                row.className = 'no-spots';
                const cell = document.createElement('td');
                cell.colSpan = 11;
                cell.textContent = this.spots.length === 0 ? 'Waiting for spots...' : 'No spots match filter';
                row.appendChild(cell);
                fragment.appendChild(row);
                tbody.innerHTML = '';
                tbody.appendChild(fragment);
                this.updateCount(0, this.spots.length);
                return;
            }

            let highlightedNewSpot = false;

            const displayLimit = this.showingAllRows ? filteredSpots.length : Math.min(this.maxDisplayRows, filteredSpots.length);
            const spotsToRender = filteredSpots.slice(0, displayLimit);

            spotsToRender.forEach((spot) => {
                const row = this.createSpotRow(spot);
                if (this.newSpotId && spot._highlightId === this.newSpotId && this.highlightNew) {
                    highlightedNewSpot = true;
                }
                fragment.appendChild(row);
            });

            // Add show more/less buttons
            if (displayLimit < filteredSpots.length && !this.showingAllRows) {
                const row = document.createElement('tr');
                row.className = 'show-more-row';
                const cell = document.createElement('td');
                cell.colSpan = 11;
                cell.style.textAlign = 'center';
                cell.style.padding = '10px';
                cell.style.cursor = 'pointer';
                cell.style.backgroundColor = '#2a2a2a';
                cell.style.color = '#4a9eff';
                cell.textContent = `Show all ${filteredSpots.length} spots (currently showing ${displayLimit})`;
                cell.addEventListener('click', () => {
                    this.showingAllRows = true;
                    this.filterAndRenderSpots(true);
                });
                row.appendChild(cell);
                fragment.appendChild(row);
            } else if (this.showingAllRows && filteredSpots.length > this.maxDisplayRows) {
                const row = document.createElement('tr');
                row.className = 'show-less-row';
                const cell = document.createElement('td');
                cell.colSpan = 11;
                cell.style.textAlign = 'center';
                cell.style.padding = '10px';
                cell.style.cursor = 'pointer';
                cell.style.backgroundColor = '#2a2a2a';
                cell.style.color = '#4a9eff';
                cell.textContent = `Show less (showing all ${filteredSpots.length} spots)`;
                cell.addEventListener('click', () => {
                    this.showingAllRows = false;
                    this.filterAndRenderSpots(true);
                });
                row.appendChild(cell);
                fragment.appendChild(row);
            }

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

        // CW uses USB or CW mode
        const mode = 'usb';
        this.radio.setMode(mode, false);

        this.radio.log(`Tuned to ${spot.dx_call} on ${this.formatFrequency(spot.frequency)} MHz ${mode.toUpperCase()} (CW ${spot.wpm} WPM)`);
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
        const badge = document.getElementById('cw-spots-status-badge');
        if (badge) {
            badge.textContent = text;
            badge.className = `status-badge status-${status}`;
        }
    }

    updateCount(filteredCount, totalCount = null) {
        const countEl = document.getElementById('cw-spots-count');
        if (countEl) {
            if (totalCount !== null && filteredCount !== totalCount) {
                countEl.textContent = `${filteredCount} spot${filteredCount !== 1 ? 's' : ''} of ${totalCount} total`;
            } else {
                countEl.textContent = `${filteredCount} spot${filteredCount !== 1 ? 's' : ''}`;
            }
        }
    }

    updateLastUpdate() {
        const lastUpdateEl = document.getElementById('cw-spots-last-update');
        if (lastUpdateEl) {
            const now = new Date();
            lastUpdateEl.textContent = `Last: ${now.toLocaleTimeString()}`;
        }
    }

    clearSpots() {
        this.spots = [];
        this.filteredSpotsCache = null;
        this.showingAllRows = false;
        this.pendingSpots = [];
        if (this.renderThrottleTimer) {
            clearTimeout(this.renderThrottleTimer);
            this.renderThrottleTimer = null;
        }
        this.filterAndRenderSpots();
    }

    startAgeUpdates() {
        this.ageUpdateInterval = setInterval(() => {
            const panel = document.querySelector('.decoder-extension-panel');
            const isPanelVisible = panel && panel.style.display !== 'none';
            
            if (isPanelVisible) {
                const ageCells = document.querySelectorAll('.spot-age');
                ageCells.forEach(cell => {
                    const timestamp = cell.getAttribute('data-timestamp');
                    if (timestamp) {
                        cell.textContent = this.formatAge(timestamp);
                    }
                });

                if (this.ageFilter !== null && !this.lastAgeFilterCheck) {
                    this.lastAgeFilterCheck = Date.now();
                }

                if (this.ageFilter !== null && this.lastAgeFilterCheck &&
                    (Date.now() - this.lastAgeFilterCheck) > 10000) {
                    this.lastAgeFilterCheck = Date.now();
                    this.filterAndRenderSpots();
                }
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
        console.log('CW Spots: startFrequencyMonitoring called');
        this.updateBandFilterFromFrequency();
    }

    stopFrequencyMonitoring() {
        // No cleanup needed
    }

    updateBandFilterFromFrequency() {
        const currentFreq = this.radio.getFrequency();
        console.log('CW Spots: updateBandFilterFromFrequency - currentFreq:', currentFreq);

        if (!currentFreq) {
            console.log('CW Spots: No current frequency');
            return;
        }

        const band = this.radio.getFrequencyBand(currentFreq);
        console.log('CW Spots: Detected band:', band, 'for frequency:', currentFreq);

        if (!band) {
            console.log('CW Spots: No band detected for frequency');
            return;
        }

        const bandFilter = document.getElementById('cw-spots-band-filter');
        if (!bandFilter) {
            console.log('CW Spots: Band filter element not found');
            return;
        }

        const bandOption = Array.from(bandFilter.options).find(
            option => option.value === band
        );

        console.log('CW Spots: Band option found:', !!bandOption, 'Current filter:', this.bandFilter, 'New band:', band);

        if (bandOption) {
            bandFilter.value = band;

            if (this.bandFilter !== band) {
                this.bandFilter = band;
                this.filterAndRenderSpots();
                console.log(`CW Spots: Auto-updated band filter to ${band}`);
            } else {
                console.log('CW Spots: Band filter already set to', band);
            }
        } else {
            console.log('CW Spots: Band', band, 'not found in dropdown options');
        }
    }

    onFrequencyChanged(frequency) {
        console.log('CW Spots: onFrequencyChanged called with frequency:', frequency);
        this.updateBandFilterFromFrequency();
    }

    startFrequencyPolling() {
        this.frequencyPollInterval = setInterval(() => {
            const currentFreq = this.radio.getFrequency();
            if (currentFreq !== this.lastPolledFrequency) {
                console.log('CW Spots: Frequency changed via polling:', this.lastPolledFrequency, '->', currentFreq);
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
            this.subscribeToCWSpots();
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
        // CW spots extension doesn't process audio
    }
}

// Register the extension
if (window.decoderManager) {
    const cwSpotsExtension = new CWSpotsExtension();
    window.decoderManager.register(cwSpotsExtension);
    console.log('CW Spots extension registered:', cwSpotsExtension);
} else {
    console.error('decoderManager not available for CW Spots extension');
}
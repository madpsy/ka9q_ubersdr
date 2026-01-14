// CW Spots Extension for ka9q UberSDR
// Displays real-time CW spots from CW Skimmer
// Version: 2025-11-24-badge-fix-v1

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
        this.countryFilter = 'all'; // Default to all countries
        this.callsignFilter = '';
        this.highlightNew = true;
        this.showBadges = false; // Default to hiding badges
        this.unsubscribe = null;
        this.newSpotId = null;
        this.spotIdCounter = 0;
        this.ageUpdateInterval = null;
        this.connectionCheckInterval = null;
        this.renderPending = false;
        this.currentModalCountry = null; // Track currently open modal
        this.currentModalBand = null;
        this.currentModalTab = 'graph'; // Track current modal tab (graph or table)
        this.graphRefreshPending = false; // Prevent multiple pending graph refreshes
        this.lastGraphRefresh = 0; // Track last graph refresh time for throttling
        this.badgeUpdatePending = false; // Prevent multiple pending badge updates
        this.lastBadgeUpdate = 0; // Track last badge update time for throttling
        this.modalGraphRefreshInterval = null; // Interval for periodic graph updates
        this.showAllCountriesInModal = false; // Track "Show All Countries" checkbox state
        
        // Performance optimization
        this.filteredSpotsCache = null;
        this.lastFilterParams = null;
        this.maxDisplayRows = 500;
        this.showingAllRows = false;
        this.callsignFilterDebounceTimer = null;
        this.filterDebounceDelay = 300;
        this.badgeCache = null; // Cache badge data
        this.lastBadgeBand = null; // Track last band for badge cache
        this.pendingSpots = [];
        this.renderThrottleTimer = null;

        // Subscribe to CW spots immediately
        this.subscribeToCWSpots();
    }

    onInitialize() {
        console.log('CW Spots: onInitialize called');
        this.renderTemplate();
        this.waitForDOMAndSetupHandlers();
        this.fetchAndPopulateCountries();
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
                console.log('CW Spots: Band filter changed to:', e.target.value);
                this.bandFilter = e.target.value;
                this.badgeCache = null; // Invalidate badge cache when band changes
                this.lastBadgeBand = null; // Clear last band tracking
                this.lastBadgeUpdate = 0; // Reset throttle to allow immediate update
                this.showingAllRows = false;
                console.log('CW Spots: About to call updateBadges() synchronously');
                this.updateBadges(); // Update badges immediately BEFORE filtering spots
                console.log('CW Spots: updateBadges() completed, now calling filterAndRenderSpots()');
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
            } else if (e.target.id === 'cw-spots-country-filter') {
                this.countryFilter = e.target.value;
                this.showingAllRows = false;
                this.filteredSpotsCache = null; // Invalidate cache
                this.filterAndRenderSpots();
                // Redraw spectrum markers with new filter
                if (window.spectrumDisplay) {
                    window.spectrumDisplay.invalidateMarkerCache();
                    window.spectrumDisplay.draw();
                }
            } else if (e.target.id === 'cw-spots-show-badges') {
                this.showBadges = e.target.checked;
                this.updateBadges();
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
            } else if (e.target.id === 'cw-spots-map-btn') {
                window.open('/cwskimmer_map.html', '_blank');
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
            if (snrFilter) snrFilter.value = this.snrFilter !== null ? this.snrFilter.toString() : 'none';
            if (wpmFilter) wpmFilter.value = this.wpmFilter !== null ? this.wpmFilter.toString() : 'none';
            if (distanceFilter) distanceFilter.value = this.distanceFilter !== null ? this.distanceFilter.toString() : 'none';
            if (callsignFilter) callsignFilter.value = this.callsignFilter;

            const showBadgesCheckbox = document.getElementById('cw-spots-show-badges');
            if (showBadgesCheckbox) showBadgesCheckbox.checked = this.showBadges;

            // Update band filter from current frequency FIRST (updates this.bandFilter)
            this.updateBandFilterFromFrequency();
            
            // THEN set dropdown to match the updated internal value
            if (bandFilter) bandFilter.value = this.bandFilter;
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

        // Update modal tuned info if this spot is on the same frequency we're tuned to
        this.checkAndUpdateTunedInfo(spot);
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

        // Invalidate caches when new spot added
        this.filteredSpotsCache = null;
        this.badgeCache = null;

        // Invalidate spectrum marker cache when spots change
        if (window.spectrumDisplay) {
            window.spectrumDisplay.invalidateMarkerCache();
            window.spectrumDisplay.draw();
        }

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
                    this.scheduleBadgeUpdate();
                }, 500);
            }
        }

        // Update modal if it's open (modal can be open even if panel is closed)
        if (this.currentModalCountry && this.currentModalBand) {
            // Mark that graph needs refresh due to new spot
            this._modalNeedsGraphRefresh = true;
            this.refreshModalContent();
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
            // Country filter
            if (this.countryFilter !== 'all' && spot.country !== this.countryFilter) return false;
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
        if (spot.country) {
            countryCell.style.cursor = 'pointer';
            countryCell.addEventListener('click', (e) => {
                e.stopPropagation();
                this.filterByCountry(spot.country);
            });
        }
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
                // Country filter
                if (this.countryFilter !== 'all' && spot.country !== this.countryFilter) {
                    return false;
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

        // CW uses CWL for < 10 MHz, CWU for >= 10 MHz
        const mode = spot.frequency < 10000000 ? 'cwl' : 'cwu';
        this.radio.setMode(mode, false);

        this.radio.log(`Tuned to ${spot.dx_call} on ${this.formatFrequency(spot.frequency)} MHz ${mode.toUpperCase()} (CW ${spot.wpm} WPM)`);
        
        // Update modal tuned info if modal is open
        this.updateModalTunedInfo(spot);
    }

    openQRZ(callsign) {
        const baseCallsign = callsign.split('/')[0];
        const url = `https://www.qrz.com/db/${baseCallsign}`;
        window.open(url, '_blank');
    }

    formatFrequency(hz) {
        return (hz / 1000000).toFixed(5);
    }

    formatFrequencyShort(hz) {
        return (hz / 1000000).toFixed(3);
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
        this.badgeCache = null; // Invalidate badge cache
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

            // Update modal age cells if modal is open (modal can be open even if panel is closed)
            if (this.currentModalCountry && this.currentModalBand) {
                const modalAgeCells = document.querySelectorAll('.modal-age');
                modalAgeCells.forEach(cell => {
                    const timestamp = cell.getAttribute('data-timestamp');
                    if (timestamp) {
                        cell.textContent = this.formatAge(timestamp);
                    }
                });
                
                // Refresh modal content every second if it's open
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
            // Always update dropdown value to match internal state
            bandFilter.value = band;

            // Only re-filter if band actually changed
            if (this.bandFilter !== band) {
                this.bandFilter = band;
                this.badgeCache = null; // Invalidate badge cache
                this.lastBadgeBand = null; // Clear last band tracking
                this.lastBadgeUpdate = 0; // Reset throttle
                this.updateBadges(); // Update badges immediately
                this.filterAndRenderSpots();
                console.log(`CW Spots: Auto-updated band filter to ${band}`);
            } else {
                console.log('CW Spots: Band filter already set to', band, '- dropdown synced');
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

        // Subscribe to CW spots on server
        if (window.dxClusterClient) {
            window.dxClusterClient.subscribeToCWSpots();
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

        // Unsubscribe from CW spots on server
        if (window.dxClusterClient) {
            window.dxClusterClient.unsubscribeFromCWSpots();
        }

        // Hide badges when extension is disabled
        const container = document.getElementById('cw-spots-badges-main');
        if (container) {
            container.style.display = 'none';
        }

        // Invalidate spectrum marker cache to remove CW spot markers
        if (window.spectrumDisplay) {
            window.spectrumDisplay.invalidateMarkerCache();
            window.spectrumDisplay.draw();
        }
    }

    onProcessAudio(dataArray) {
        // CW spots extension doesn't process audio
    }

    scheduleBadgeUpdate() {
        // Skip if extension panel is not visible
        const panel = document.querySelector('.decoder-extension-panel');
        const isPanelVisible = panel && panel.style.display !== 'none';
        if (!isPanelVisible) return;

        // Throttle badge updates to prevent blocking audio thread
        // Only update once per second maximum
        const now = Date.now();
        const timeSinceLastUpdate = now - this.lastBadgeUpdate;

        if (timeSinceLastUpdate >= 1000) {
            // Enough time has passed, schedule update
            if (!this.badgeUpdatePending) {
                this.badgeUpdatePending = true;
                this.lastBadgeUpdate = now;
                requestAnimationFrame(() => {
                    this.badgeUpdatePending = false;
                    this.updateBadges();
                });
            }
        }
        // If less than 1 second, skip this update (will update on next spot)
    }

    updateBadges() {
        console.log('CW Spots: updateBadges called - bandFilter:', this.bandFilter, 'lastBadgeBand:', this.lastBadgeBand, 'badgeCache:', !!this.badgeCache);

        // Use the main page container instead of the extension panel container
        const container = document.getElementById('cw-spots-badges-main');
        if (!container) return;

        // Always hide container if extension is not enabled
        if (!this.enabled) {
            container.style.display = 'none';
            return;
        }

        // Hide container if badges are disabled
        if (!this.showBadges) {
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
            this.badgeCache = null;
            this.lastBadgeBand = null;
            return;
        }

        // Check if we can use cached badge data
        if (this.badgeCache && this.lastBadgeBand === currentBand) {
            // Use cached data - just update the DOM
            const fragment = document.createDocumentFragment();
            this.badgeCache.forEach(([country, spotData]) => {
                const badge = document.createElement('span');
                badge.className = 'country-badge';
                badge.textContent = country;
                const snrText = spotData.snr >= 0 ? `+${spotData.snr}` : spotData.snr;
                badge.title = `${country} on ${currentBand}\nLast: ${spotData.callsign}\nSNR: ${snrText} dB\nWPM: ${spotData.wpm}`;
                badge.addEventListener('click', () => {
                    this.openCountryModal(country, currentBand);
                });
                fragment.appendChild(badge);
            });
            container.innerHTML = '';
            container.appendChild(fragment);
            return;
        }

        // Get spots for current band from the last 10 minutes
        // Optimize: filter by time first (most selective), then band, then country
        const now = Date.now();
        const tenMinutesAgo = now - (10 * 60 * 1000);

        const recentBandSpots = this.spots.filter(spot => {
            // Time filter first (most selective)
            const spotTime = new Date(spot.time).getTime();
            if (spotTime < tenMinutesAgo) return false;
            // Band filter
            if (spot.band !== currentBand) return false;
            // Country filter
            if (!spot.country) return false;
            return true;
        });

        if (recentBandSpots.length === 0) {
            container.classList.add('empty');
            container.innerHTML = `No countries seen on ${currentBand} in the last 10 minutes`;
            this.badgeCache = null;
            this.lastBadgeBand = null;
            return;
        }

        container.classList.remove('empty');

        // Track unique countries with their most recent spot data
        const countryMap = new Map();

        recentBandSpots.forEach(spot => {
            const country = spot.country;
            const spotTime = new Date(spot.time).getTime();

            if (!countryMap.has(country) || spotTime > countryMap.get(country).timestamp) {
                countryMap.set(country, {
                    timestamp: spotTime,
                    snr: spot.snr,
                    wpm: spot.wpm,
                    callsign: spot.dx_call
                });
            }
        });

        // Convert to array and sort alphabetically by country name
        const countries = Array.from(countryMap.entries())
            .sort((a, b) => a[0].localeCompare(b[0]));

        // Cache the results
        this.badgeCache = countries;
        this.lastBadgeBand = currentBand;

        // Create badges
        const fragment = document.createDocumentFragment();

        countries.forEach(([country, spotData]) => {
            const badge = document.createElement('span');
            badge.className = 'country-badge';
            badge.textContent = country;
            const snrText = spotData.snr >= 0 ? `+${spotData.snr}` : spotData.snr;
            badge.title = `${country} on ${currentBand}\nLast: ${spotData.callsign}\nSNR: ${snrText} dB\nWPM: ${spotData.wpm}`;

            // Add click handler to open modal
            badge.addEventListener('click', () => {
                this.openCountryModal(country, currentBand);
            });

            fragment.appendChild(badge);
        });

        container.innerHTML = '';
        container.appendChild(fragment);
    }

    openCountryModal(country, band) {
        // Track which modal is open
        this.currentModalCountry = country;
        this.currentModalBand = band;

        const modal = document.getElementById('cw-country-spots-modal');
        const modalTitle = document.getElementById('cw-country-spots-modal-title');

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

        // Reset checkbox to unchecked when opening modal
        this.showAllCountriesInModal = false;
        const showAllCheckbox = document.getElementById('cw-country-spots-show-all-countries');
        if (showAllCheckbox) {
            showAllCheckbox.checked = false;
        }

        // Clear tuned info when opening modal
        this.clearModalTunedInfo();

        // Set default tab to graph
        this.switchModalTab('graph');

        // Start periodic graph refresh (every 5 seconds) to keep time axis current
        this.startModalGraphRefresh();
    }

    refreshModalContent() {
        // Refresh table content (which deduplicates by callsign)
        this.refreshModalTable();

        // Throttle graph updates to prevent blocking audio thread
        // Only update graph once per second maximum
        if (this.currentModalTab === 'graph' && this._modalNeedsGraphRefresh) {
            const now = Date.now();
            const timeSinceLastRefresh = now - this.lastGraphRefresh;

            // Throttle: only refresh if at least 1 second has passed
            if (timeSinceLastRefresh >= 1000) {
                this.scheduleGraphRefresh();
                this._modalNeedsGraphRefresh = false;
            }
            // If less than 1 second, leave flag set so it refreshes on next check
        }
    }

    scheduleGraphRefresh() {
        // Prevent multiple pending refreshes
        if (this.graphRefreshPending) return;

        this.graphRefreshPending = true;
        this.lastGraphRefresh = Date.now();

        // Defer to next animation frame to avoid blocking audio thread
        requestAnimationFrame(() => {
            this.graphRefreshPending = false;
            this.refreshModalGraphs();
        });
    }

    refreshModalTable() {
        const modalTbody = document.getElementById('cw-country-spots-modal-tbody');

        if (!modalTbody || !this.currentModalCountry || !this.currentModalBand) {
            return;
        }

        const country = this.currentModalCountry;
        const band = this.currentModalBand;

        // Get spots for this country and band from the last 10 minutes
        // IMPORTANT: Use raw spots array, not filtered by main table's age filter
        const now = Date.now();
        const tenMinutesAgo = now - (10 * 60 * 1000);

        const countrySpots = this.spots.filter(spot => {
            // Age filter FIRST (most selective - eliminates old spots early)
            const spotTime = new Date(spot.time).getTime();
            if (spotTime < tenMinutesAgo) return false;

            // Band filter (always apply)
            if (spot.band !== band) return false;

            // Country filter (conditional based on checkbox)
            if (!this.showAllCountriesInModal && spot.country !== country) return false;

            return true;
        });

        // Get unique callsigns with their most recent spot data
        const callsignMap = new Map();

        countrySpots.forEach(spot => {
            const callsign = spot.dx_call;
            const spotTime = new Date(spot.time).getTime();

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
        const modalTitle = document.getElementById('cw-country-spots-modal-title');
        if (modalTitle) {
            const count = uniqueSpots.length;
            const titleText = this.showAllCountriesInModal
                ? `All Countries on ${band} (${count} callsign${count !== 1 ? 's' : ''})`
                : `${country} on ${band} (${count} callsign${count !== 1 ? 's' : ''})`;
            modalTitle.textContent = titleText;
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

                // Callsign - clickable to tune radio
                const callsignCell = document.createElement('td');
                callsignCell.className = 'modal-callsign';
                callsignCell.textContent = spot.dx_call;
                callsignCell.style.cursor = 'pointer';
                callsignCell.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.tuneToSpot(spot);
                });
                row.appendChild(callsignCell);

                // Country
                const countryCell = document.createElement('td');
                countryCell.className = 'modal-country';
                countryCell.textContent = spot.country || '';
                row.appendChild(countryCell);

                // SNR
                const snrCell = document.createElement('td');
                snrCell.className = `modal-snr ${spot.snr >= 0 ? 'modal-snr-positive' : 'modal-snr-negative'}`;
                snrCell.textContent = spot.snr >= 0 ? `+${spot.snr}` : spot.snr;
                row.appendChild(snrCell);

                // WPM
                const wpmCell = document.createElement('td');
                wpmCell.className = 'modal-wpm';
                wpmCell.textContent = spot.wpm || '';
                row.appendChild(wpmCell);

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
                ageCell.setAttribute('data-timestamp', spot.time);
                ageCell.textContent = this.formatAge(spot.time);
                row.appendChild(ageCell);

                // Comment
                const commentCell = document.createElement('td');
                commentCell.className = 'modal-comment';
                commentCell.textContent = spot.comment || '';
                row.appendChild(commentCell);

                fragment.appendChild(row);
            });
        }

        modalTbody.innerHTML = '';
        modalTbody.appendChild(fragment);
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
            // Age filter FIRST (most selective - eliminates old spots early)
            const spotTime = new Date(spot.time).getTime();
            if (spotTime < tenMinutesAgo) return false;

            // Band filter (always apply)
            if (spot.band !== band) return false;

            // Country filter (conditional based on checkbox)
            if (!this.showAllCountriesInModal && spot.country !== country) return false;

            return true;
        });

        // Render graph
        const container = document.getElementById('cw-country-spots-graphs-container');
        if (!container) return;

        // Check if we need to rebuild the structure
        const existingGraph = container.querySelector('.country-spots-graph');

        if (!existingGraph || countrySpots.length === 0) {
            // Need to rebuild
            const scrollTop = container.scrollTop;
            container.innerHTML = '';

            if (countrySpots.length === 0) {
                container.innerHTML = '<div class="country-spots-graph-no-data">No spots found in the last 10 minutes</div>';
                return;
            }

            this.renderCWGraph(container, countrySpots);

            // Restore scroll position
            requestAnimationFrame(() => {
                container.scrollTop = scrollTop;
            });
        } else {
            // Just update existing canvas
            const graphDiv = container.querySelector('.country-spots-graph');
            if (graphDiv) {
                // Update title
                const title = graphDiv.querySelector('.country-spots-graph-title');
                if (title) {
                    title.textContent = `CW Spots - ${countrySpots.length} spot${countrySpots.length !== 1 ? 's' : ''}`;
                }
                // Redraw canvas with tooltip
                const canvas = graphDiv.querySelector('.country-spots-graph-canvas');
                const tooltip = graphDiv.querySelector('.country-spots-graph-tooltip');
                if (canvas) {
                    this.drawFrequencyTimeGraph(canvas, countrySpots, tooltip);
                }
            }
        }
    }

    renderCWGraph(container, spots) {
        // Create graph container
        const graphDiv = document.createElement('div');
        graphDiv.className = 'country-spots-graph';

        const title = document.createElement('div');
        title.className = 'country-spots-graph-title';
        title.textContent = `CW Spots - ${spots.length} spot${spots.length !== 1 ? 's' : ''}`;
        graphDiv.appendChild(title);

        const canvasContainer = document.createElement('div');
        canvasContainer.className = 'country-spots-graph-canvas-container';

        const canvas = document.createElement('canvas');
        canvas.className = 'country-spots-graph-canvas';
        canvasContainer.appendChild(canvas);

        // Create tooltip element
        const tooltip = document.createElement('div');
        tooltip.className = 'country-spots-graph-tooltip';
        tooltip.style.display = 'none';
        canvasContainer.appendChild(tooltip);

        graphDiv.appendChild(canvasContainer);
        container.appendChild(graphDiv);

        // Draw graph on canvas and setup interactivity
        this.drawFrequencyTimeGraph(canvas, spots, tooltip);
    }

    drawFrequencyTimeGraph(canvas, spots, tooltip = null) {
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

        // Calculate time range based on actual spot times
        const spotTimes = spots.map(s => new Date(s.time).getTime());
        const minTime = Math.min(...spotTimes);
        const maxTime = Math.max(...spotTimes);
        const timeRange = maxTime - minTime;

        // Add 5% padding on each side for better visualization
        const timePadding = Math.max(timeRange * 0.05, 30000); // At least 30 seconds padding
        const displayMinTime = minTime - timePadding;
        const displayMaxTime = maxTime + timePadding;
        const displayTimeRange = displayMaxTime - displayMinTime;

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

        // Draw X-axis labels (Time) - use actual spot timestamps for labels
        ctx.textAlign = 'center';

        // Get unique spot times and sort them
        const uniqueSpotTimes = [...new Set(spotTimes)].sort((a, b) => a - b);

        // Select evenly distributed spot times for labels (aim for ~5-7 labels)
        const targetLabels = 6;
        const labelTimes = [];

        if (uniqueSpotTimes.length <= targetLabels) {
            labelTimes.push(...uniqueSpotTimes);
        } else {
            const step = Math.floor(uniqueSpotTimes.length / (targetLabels - 1));
            for (let i = 0; i < targetLabels - 1; i++) {
                labelTimes.push(uniqueSpotTimes[i * step]);
            }
            labelTimes.push(uniqueSpotTimes[uniqueSpotTimes.length - 1]);
        }

        // Draw labels at actual spot times
        labelTimes.forEach(time => {
            const x = marginLeft + ((time - displayMinTime) / displayTimeRange) * graphWidth;
            const date = new Date(time);
            const timeStr = date.toLocaleTimeString('en-US', {
                hour12: false,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
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
        });

        // Draw X-axis label
        ctx.fillStyle = '#888';
        ctx.font = '12px Arial';
        ctx.fillText('Time (UTC)', width / 2, height - 5);

        // Draw Y-axis label
        ctx.save();
        ctx.translate(12, height / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText('Frequency (MHz)', 0, 0);
        ctx.restore();

        // Plot spots with callsigns as markers
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Helper function to get color based on SNR
        const getSNRColor = (snr) => {
            // CW typical range: -10 to +30 dB
            if (snr >= 15) {
                return '#28a745'; // Green - strong signal
            } else if (snr >= 5) {
                return '#ffc107'; // Yellow - good signal
            } else if (snr >= -5) {
                return '#ff8c00'; // Orange - weak signal
            } else {
                return '#dc3545'; // Red - very weak signal
            }
        };

        // Calculate positions and detect collisions
        const labelHeight = 12;
        const labelPadding = 2;
        const positions = [];

        spots.forEach(spot => {
            const spotTime = new Date(spot.time).getTime();
            const x = marginLeft + ((spotTime - displayMinTime) / displayTimeRange) * graphWidth;
            const baseY = height - marginBottom - ((spot.frequency - (minFreq - freqPadding)) / (freqRange + 2 * freqPadding)) * graphHeight;

            // Get color based on SNR
            const textColor = getSNRColor(spot.snr);

            // Measure text width
            const textWidth = ctx.measureText(spot.dx_call).width;

            // Find a non-overlapping position
            let y = baseY;
            let attempts = 0;
            const maxAttempts = 20;

            while (attempts < maxAttempts) {
                let overlaps = false;

                // Check for overlap with existing labels
                for (const pos of positions) {
                    const xOverlap = Math.abs(x - pos.x) < (textWidth + pos.width) / 2 + labelPadding;
                    const yOverlap = Math.abs(y - pos.y) < labelHeight + labelPadding;

                    if (xOverlap && yOverlap) {
                        overlaps = true;
                        break;
                    }
                }

                if (!overlaps) {
                    break;
                }

                // Try offsetting vertically
                attempts++;
                if (attempts % 2 === 0) {
                    y = baseY + (attempts / 2) * (labelHeight + labelPadding);
                } else {
                    y = baseY - (Math.ceil(attempts / 2)) * (labelHeight + labelPadding);
                }
            }

            positions.push({ x, y, width: textWidth, baseY });

            // Draw line from label to actual position if offset
            if (Math.abs(y - baseY) > 2) {
                ctx.strokeStyle = textColor;
                ctx.lineWidth = 1;
                ctx.setLineDash([2, 2]);
                ctx.beginPath();
                ctx.moveTo(x, baseY);
                ctx.lineTo(x, y);
                ctx.stroke();
                ctx.setLineDash([]);

                // Add a small dot at the actual frequency/time position
                ctx.fillStyle = textColor;
                ctx.beginPath();
                ctx.arc(x, baseY, 2, 0, 2 * Math.PI);
                ctx.fill();
            }

            // Draw callsign as text
            ctx.fillStyle = textColor;
            ctx.fillText(spot.dx_call, x, y);
        });

        // Setup mouse interaction for tooltips
        if (tooltip) {
            // Store spot positions for hit detection
            canvas._spotPositions = positions.map((pos, idx) => ({
                ...pos,
                spot: spots[idx]
            }));

            // Remove old listeners if they exist
            if (canvas._mouseMoveHandler) {
                canvas.removeEventListener('mousemove', canvas._mouseMoveHandler);
                canvas.removeEventListener('mouseleave', canvas._mouseLeaveHandler);
                canvas.removeEventListener('click', canvas._clickHandler);
            }

            // Mouse move handler
            canvas._mouseMoveHandler = (e) => {
                const rect = canvas.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;

                // Find hovered spot
                let hoveredSpot = null;
                for (const pos of canvas._spotPositions) {
                    const dx = mouseX - pos.x;
                    const dy = mouseY - pos.y;

                    // Check if mouse is near the label
                    if (Math.abs(dx) < pos.width / 2 + 5 && Math.abs(dy) < labelHeight / 2 + 5) {
                        hoveredSpot = pos.spot;
                        break;
                    }
                }

                if (hoveredSpot) {
                    // Show tooltip
                    const snrText = hoveredSpot.snr >= 0 ? `+${hoveredSpot.snr}` : hoveredSpot.snr;
                    const distanceText = hoveredSpot.distance_km !== undefined && hoveredSpot.distance_km !== null
                        ? `${Math.round(hoveredSpot.distance_km)} km`
                        : 'N/A';
                    const bearingText = hoveredSpot.bearing_deg !== undefined && hoveredSpot.bearing_deg !== null
                        ? `${Math.round(hoveredSpot.bearing_deg)}°`
                        : 'N/A';

                    // Get SNR color for callsign
                    const snrColor = getSNRColor(hoveredSpot.snr);

                    tooltip.innerHTML = `
                        <div class="tooltip-row"><strong style="color: ${snrColor}">${hoveredSpot.dx_call}</strong></div>
                        <div class="tooltip-row">Country: ${hoveredSpot.country || 'N/A'}</div>
                        <div class="tooltip-row">Freq: ${this.formatFrequencyShort(hoveredSpot.frequency)} MHz</div>
                        <div class="tooltip-row">SNR: ${snrText} dB</div>
                        <div class="tooltip-row">WPM: ${hoveredSpot.wpm || 'N/A'}</div>
                        <div class="tooltip-row">Distance: ${distanceText}</div>
                        <div class="tooltip-row">Bearing: ${bearingText}</div>
                        <div class="tooltip-row">Age: ${this.formatAge(hoveredSpot.time)}</div>
                        ${hoveredSpot.comment ? `<div class="tooltip-row">Comment: ${hoveredSpot.comment}</div>` : ''}
                    `;

                    tooltip.style.display = 'block';

                    // Smart positioning
                    const tooltipWidth = tooltip.offsetWidth || 200;
                    const tooltipHeight = tooltip.offsetHeight || 150;
                    
                    let left = mouseX + 10;
                    let top = mouseY + 10;

                    if (left + tooltipWidth > rect.width) {
                        left = mouseX - tooltipWidth - 10;
                    }

                    if (top + tooltipHeight > rect.height) {
                        top = mouseY - tooltipHeight - 10;
                    }

                    if (left < 0) {
                        left = 10;
                    }

                    if (top < 0) {
                        top = 10;
                    }

                    tooltip.style.left = left + 'px';
                    tooltip.style.top = top + 'px';

                    canvas.style.cursor = 'pointer';
                } else {
                    tooltip.style.display = 'none';
                    canvas.style.cursor = 'default';
                }
            };

            // Mouse leave handler
            canvas._mouseLeaveHandler = () => {
                tooltip.style.display = 'none';
                canvas.style.cursor = 'default';
            };

            // Click handler to tune radio
            canvas._clickHandler = (e) => {
                const rect = canvas.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;

                // Find clicked spot
                let clickedSpot = null;
                for (const pos of canvas._spotPositions) {
                    const dx = mouseX - pos.x;
                    const dy = mouseY - pos.y;

                    if (Math.abs(dx) < pos.width / 2 + 5 && Math.abs(dy) < labelHeight / 2 + 5) {
                        clickedSpot = pos.spot;
                        break;
                    }
                }

                if (clickedSpot) {
                    this.tuneToSpot(clickedSpot);
                }
            };

            canvas.addEventListener('mousemove', canvas._mouseMoveHandler);
            canvas.addEventListener('mouseleave', canvas._mouseLeaveHandler);
            canvas.addEventListener('click', canvas._clickHandler);
        }
    }

    closeCountryModal() {
        // Stop periodic graph refresh
        this.stopModalGraphRefresh();

        // Clear tracking
        this.currentModalCountry = null;
        this.currentModalBand = null;

        // Clear tuned info
        this.clearModalTunedInfo();

        const modal = document.getElementById('cw-country-spots-modal');
        if (modal) {
            modal.style.display = 'none';
        }
    }

    setupModalHandlers() {
        const modal = document.getElementById('cw-country-spots-modal');
        const closeBtn = document.getElementById('cw-country-spots-modal-close');
        const showAllCheckbox = document.getElementById('cw-country-spots-show-all-countries');

        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                this.closeCountryModal();
            });
        }

        if (showAllCheckbox) {
            showAllCheckbox.addEventListener('change', (e) => {
                this.showAllCountriesInModal = e.target.checked;
                // Mark that graph needs refresh due to filter change
                this._modalNeedsGraphRefresh = true;
                this.refreshModalContent();
            });
        }

        // Setup tab switching
        const tabButtons = document.querySelectorAll('.cw-country-spots-tab');
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
        const tabButtons = document.querySelectorAll('.cw-country-spots-tab');
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
            if (content.id === `cw-country-spots-${tab}-tab`) {
                content.classList.add('active');
            } else {
                content.classList.remove('active');
            }
        });

        // Refresh content if switching to graph tab
        if (tab === 'graph') {
            // Force immediate refresh when switching tabs (user action)
            this.lastGraphRefresh = 0;
            this.scheduleGraphRefresh();
            // Restart periodic refresh when switching to graph tab
            this.startModalGraphRefresh();
        } else {
            // Stop periodic refresh when switching away from graph tab
            this.stopModalGraphRefresh();
        }
    }

    startModalGraphRefresh() {
        // Clear any existing interval
        this.stopModalGraphRefresh();

        // Only start if modal is open and graph tab is active
        if (!this.currentModalCountry || !this.currentModalBand || this.currentModalTab !== 'graph') {
            return;
        }

        // Refresh graph every 5 seconds to keep time axis current
        this.modalGraphRefreshInterval = setInterval(() => {
            if (this.currentModalCountry && this.currentModalBand && this.currentModalTab === 'graph') {
                // Force refresh to update time axis
                this.lastGraphRefresh = 0;
                this._modalNeedsGraphRefresh = true;
                this.scheduleGraphRefresh();
            } else {
                // Stop if modal closed or switched tabs
                this.stopModalGraphRefresh();
            }
        }, 5000); // 5 second interval
    }

    stopModalGraphRefresh() {
        if (this.modalGraphRefreshInterval) {
            clearInterval(this.modalGraphRefreshInterval);
            this.modalGraphRefreshInterval = null;
        }
    }

    filterByCountry(country) {
        // Set the country filter dropdown
        const countryFilter = document.getElementById('cw-spots-country-filter');
        if (countryFilter) {
            countryFilter.value = country;
            this.countryFilter = country;
            this.showingAllRows = false;
            this.filteredSpotsCache = null;
            this.filterAndRenderSpots();
            // Redraw spectrum markers with new filter
            if (window.spectrumDisplay) {
                window.spectrumDisplay.invalidateMarkerCache();
                window.spectrumDisplay.draw();
            }
        }
    }

    async fetchAndPopulateCountries() {
        try {
            const response = await fetch('/api/cty/countries');
            const data = await response.json();

            if (data.success && data.data && data.data.countries) {
                // Sort countries alphabetically by name
                const countries = data.data.countries.sort((a, b) =>
                    a.name.localeCompare(b.name)
                );

                // Wait for DOM element to be available
                const waitForDropdown = (attempts = 0) => {
                    const maxAttempts = 20;
                    const countryFilter = document.getElementById('cw-spots-country-filter');
                    
                    if (countryFilter) {
                        // Keep the "All Countries" option and add countries
                        countries.forEach(country => {
                            const option = document.createElement('option');
                            option.value = country.name;
                            option.textContent = country.name;
                            countryFilter.appendChild(option);
                        });
                        console.log(`CW Spots: Loaded ${countries.length} countries`);
                    } else if (attempts < maxAttempts) {
                        setTimeout(() => waitForDropdown(attempts + 1), 100);
                    } else {
                        console.error('CW Spots: Country filter dropdown not found after', maxAttempts, 'attempts');
                    }
                };
                
                waitForDropdown();
            }
        } catch (error) {
            console.error('CW Spots: Failed to fetch countries:', error);
        }
    }

    updateModalTunedInfo(spot) {
        const tunedInfo = document.getElementById('cw-country-spots-tuned-info');
        if (!tunedInfo) return;

        // Store the tuned frequency for future updates
        this.tunedFrequency = spot.frequency;
        this.tunedCallsign = spot.dx_call;

        const snrText = spot.snr >= 0 ? `+${spot.snr}` : spot.snr;
        const baseCallsign = spot.dx_call.split('/')[0];
        const qrzUrl = `https://www.qrz.com/db/${baseCallsign}`;
        tunedInfo.innerHTML = `<a href="${qrzUrl}" target="_blank" style="color: #28a745; text-decoration: underline; font-weight: bold;">${spot.dx_call}</a> • ${this.formatFrequencyShort(spot.frequency)} MHz • ${spot.wpm} WPM • ${snrText} dB`;
        tunedInfo.style.display = 'flex';
    }

    clearModalTunedInfo() {
        const tunedInfo = document.getElementById('cw-country-spots-tuned-info');
        if (tunedInfo) {
            tunedInfo.style.display = 'none';
            tunedInfo.innerHTML = '';
        }
        // Clear stored tuned frequency
        this.tunedFrequency = null;
        this.tunedCallsign = null;
    }

    checkAndUpdateTunedInfo(spot) {
        // Only update if modal is open and we have a tuned frequency
        if (!this.currentModalCountry || !this.currentModalBand || !this.tunedFrequency) {
            return;
        }

        // Check if this spot is on the same frequency (within 10 Hz tolerance)
        if (Math.abs(spot.frequency - this.tunedFrequency) <= 10) {
            // Update the display with the new callsign
            const tunedInfo = document.getElementById('cw-country-spots-tuned-info');
            if (tunedInfo && tunedInfo.style.display !== 'none') {
                this.tunedCallsign = spot.dx_call;
                const snrText = spot.snr >= 0 ? `+${spot.snr}` : spot.snr;
                const baseCallsign = spot.dx_call.split('/')[0];
                const qrzUrl = `https://www.qrz.com/db/${baseCallsign}`;
                tunedInfo.innerHTML = `<a href="${qrzUrl}" target="_blank" style="color: #28a745; text-decoration: underline; font-weight: bold;">${spot.dx_call}</a> • ${this.formatFrequencyShort(spot.frequency)} MHz • ${spot.wpm} WPM • ${snrText} dB`;
            }
        }
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

        // Unsubscribe from CW spots on server
        if (window.dxClusterClient) {
            window.dxClusterClient.unsubscribeFromCWSpots();
        }

        // Hide badges when extension is disabled
        const container = document.getElementById('cw-spots-badges-main');
        if (container) {
            container.style.display = 'none';
        }

        // Invalidate spectrum marker cache to remove CW spot markers
        if (window.spectrumDisplay) {
            window.spectrumDisplay.invalidateMarkerCache();
            window.spectrumDisplay.draw();
        }
    }

    onProcessAudio(dataArray) {
        // CW spots extension doesn't process audio
    }
}

// Register the extension
// Global reference to the extension instance (must be declared before class instantiation)
let cwSpotsExtensionInstance = null;

if (window.decoderManager) {
    cwSpotsExtensionInstance = new CWSpotsExtension();
    window.decoderManager.register(cwSpotsExtensionInstance);
    console.log('CW Spots extension registered:', cwSpotsExtensionInstance);
} else {
    console.error('decoderManager not available for CW Spots extension');
}

// Also expose the instance globally for debugging
window.cwSpotsExtensionInstance = cwSpotsExtensionInstance;

// Draw CW spots on spectrum display (exposed on window for spectrum-display.js access)
// Global array for CW spot positions (for spectrum display)
let cwSpotPositions = [];
window.cwSpotPositions = cwSpotPositions;

let lastCWDebugLog = 0;
function drawCWSpotsOnSpectrum(spectrumDisplay, log) {
    const now = Date.now();
    const shouldLog = (now - lastCWDebugLog) > 5000; // Log once every 5 seconds
    
    if (!spectrumDisplay || !spectrumDisplay.overlayCtx) {
        cwSpotPositions = [];
        window.cwSpotPositions = cwSpotPositions;
        if (shouldLog) {
            console.log('CW Spots: No spectrum display or overlay context');
            lastCWDebugLog = now;
        }
        return;
    }

    // Get the CW spots extension instance from global reference
    const cwExtension = cwSpotsExtensionInstance;

    // Only draw if extension exists, is enabled, and has spots
    if (!cwExtension) {
        if (shouldLog) {
            console.log('CW Spots: Extension instance not found');
            lastCWDebugLog = now;
        }
        cwSpotPositions = [];
        window.cwSpotPositions = cwSpotPositions;
        return;
    }

    if (!cwExtension.enabled) {
        cwSpotPositions = [];
        window.cwSpotPositions = cwSpotPositions;
        return;
    }

    if (!cwExtension.spots || cwExtension.spots.length === 0) {
        if (shouldLog) {
            console.log('CW Spots: No spots available');
            lastCWDebugLog = now;
        }
        cwSpotPositions = [];
        window.cwSpotPositions = cwSpotPositions;
        return;
    }
    
    if (shouldLog) {
        console.log('CW Spots: enabled=', cwExtension.enabled, 'spots=', cwExtension.spots.length);
        lastCWDebugLog = now;
    }

    // Use the overlay canvas context (same as bookmarks and DX spots)
    const ctx = spectrumDisplay.overlayCtx;

    if (!ctx || !spectrumDisplay.totalBandwidth || !spectrumDisplay.centerFreq) {
        cwSpotPositions = [];
        window.cwSpotPositions = cwSpotPositions;
        return;
    }

    // Calculate frequency range
    const startFreq = spectrumDisplay.centerFreq - spectrumDisplay.totalBandwidth / 2;
    const endFreq = spectrumDisplay.centerFreq + spectrumDisplay.totalBandwidth / 2;

    // Clear spot positions array
    cwSpotPositions = [];

    // Get filtered spots
    let filteredSpots = cwExtension.spots;
    
    if (shouldLog) {
        console.log('Spectrum range:', (startFreq/1e6).toFixed(3), '-', (endFreq/1e6).toFixed(3), 'MHz');
        console.log('Filtered spots:', filteredSpots.length);
    }

    // Apply age filter
    if (cwExtension.ageFilter !== null) {
        const now = new Date();
        const maxAgeMs = cwExtension.ageFilter * 60 * 1000;
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
    if (cwExtension.bandFilter !== 'all') {
        const bandRanges = {
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
        const band = bandRanges[cwExtension.bandFilter];
        if (band) {
            filteredSpots = filteredSpots.filter(spot =>
                spot.frequency >= band.min && spot.frequency <= band.max
            );
        }
    }

    // Apply SNR filter
    if (cwExtension.snrFilter !== null) {
        filteredSpots = filteredSpots.filter(spot => spot.snr >= cwExtension.snrFilter);
    }

    // Apply WPM filter
    if (cwExtension.wpmFilter !== null) {
        filteredSpots = filteredSpots.filter(spot => spot.wpm >= cwExtension.wpmFilter);
    }

    // Apply distance filter
    if (cwExtension.distanceFilter !== null) {
        filteredSpots = filteredSpots.filter(spot =>
            spot.distance_km !== undefined && spot.distance_km !== null && spot.distance_km >= cwExtension.distanceFilter
        );
    }

    // Apply country filter
    if (cwExtension.countryFilter && cwExtension.countryFilter !== 'all') {
        filteredSpots = filteredSpots.filter(spot =>
            spot.country === cwExtension.countryFilter
        );
    }

    // Apply callsign filter
    if (cwExtension.callsignFilter) {
        filteredSpots = filteredSpots.filter(spot =>
            spot.dx_call.toUpperCase().includes(cwExtension.callsignFilter) ||
            (spot.country && spot.country.toUpperCase().includes(cwExtension.callsignFilter))
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

    visibleSpots.forEach(item => {
        const { spot, x, labelWidth, row } = item;
        // Row 0 at y=28, Row 1 at y=13 (28 - 15) - matches bookmark positioning
        const labelY = 28 - (row * rowSpacing);

        if (shouldLog) {
            console.log(`Drawing ${spot.dx_call} at x=${x.toFixed(0)}, y=${labelY}, row=${row}`);
        }

        // Draw spot label
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        // Background for label - use cyan/blue for CW spots (different from DX cluster green)
        ctx.fillStyle = 'rgba(23, 162, 184, 0.95)'; // Cyan background for CW
        ctx.fillRect(x - labelWidth / 2, labelY, labelWidth, labelHeight);

        // Border for label
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x - labelWidth / 2, labelY, labelWidth, labelHeight);

        // Label text
        ctx.fillStyle = '#FFFFFF'; // White text
        ctx.fillText(spot.dx_call, x, labelY + 2);

        // Draw downward arrow - extends from label to baseline
        const arrowStartY = labelY + labelHeight;
        const arrowTipY = 28 + labelHeight + arrowLength; // Always point to same baseline (adjusted for new position)
        ctx.fillStyle = 'rgba(23, 162, 184, 0.95)';
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
        cwSpotPositions.push({
            x: x,
            y: labelY,
            width: labelWidth,
            height: labelHeight + (arrowTipY - arrowStartY),
            spot: spot
        });
    });

    // Update window reference
    window.cwSpotPositions = cwSpotPositions;
    
    if (shouldLog && visibleSpots.length > 0) {
        console.log('Drew', visibleSpots.length, 'CW spot markers on spectrum with collision detection');
    }
}

// Expose function on window for spectrum-display.js access
window.drawCWSpotsOnSpectrum = drawCWSpotsOnSpectrum;
console.log('CW Spots: drawCWSpotsOnSpectrum function exposed on window');
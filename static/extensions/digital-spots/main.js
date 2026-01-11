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
        this.maxSpots = 5000; // Store up to 5000 spots in memory (enough for ~10 minutes at high activity)
        this.ageFilter = 10; // Default 10 minutes
        this.modeFilter = 'all';
        this.bandFilter = 'all'; // Start with 'all', will be updated on init
        this.snrFilter = null; // Default no limit
        this.distanceFilter = null; // Default no limit
        this.countryFilter = 'all'; // Default to all countries
        this.callsignFilter = '';
        this.highlightNew = true;
        this.showBadges = false; // Default to hiding badges
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
        this.graphRefreshPending = false; // Prevent multiple pending graph refreshes
        this.lastGraphRefresh = 0; // Track last graph refresh time for throttling
        this.badgeUpdatePending = false; // Prevent multiple pending badge updates
        this.lastBadgeUpdate = 0; // Track last badge update time for throttling
        this.modalGraphRefreshInterval = null; // Interval for periodic graph updates
        this.showAllCountriesInModal = false; // Track "Show All Countries" checkbox state
        
        // Performance optimization: caching and limits
        this.filteredSpotsCache = null; // Cache filtered results
        this.lastFilterParams = null; // Track filter parameters for cache invalidation
        this.maxDisplayRows = 500; // Limit displayed rows for performance
        this.showingAllRows = false; // Track if showing all or limited rows
        this.callsignFilterDebounceTimer = null; // Debounce timer for callsign filter
        this.filterDebounceDelay = 300; // ms delay for debouncing
        this.badgeCache = null; // Cache badge data
        this.lastBadgeBand = null; // Track last band for badge cache
        this.lastRenderedSpotId = null; // Track last rendered spot for incremental updates
        this.pendingSpots = []; // Queue of spots waiting to be rendered
        this.renderThrottleTimer = null; // Throttle timer for rendering

        // Subscribe to digital spots immediately
        this.subscribeToDigitalSpots();
    }

    onInitialize() {
        console.log('Digital Spots: onInitialize called');
        this.renderTemplate();
        this.waitForDOMAndSetupHandlers();
        this.fetchAndPopulateCountries();
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
                this.showingAllRows = false; // Reset display limit
                this.filterAndRenderSpots();
            } else if (e.target.id === 'digital-spots-mode-filter') {
                this.modeFilter = e.target.value;
                this.showingAllRows = false; // Reset display limit
                this.filterAndRenderSpots();
            } else if (e.target.id === 'digital-spots-band-filter') {
                this.bandFilter = e.target.value;
                this.showingAllRows = false; // Reset display limit
                this.filterAndRenderSpots();
                this.updateBadges();
            } else if (e.target.id === 'digital-spots-snr-filter') {
                const value = e.target.value;
                this.snrFilter = value === 'none' ? null : parseInt(value);
                this.showingAllRows = false; // Reset display limit
                this.filterAndRenderSpots();
            } else if (e.target.id === 'digital-spots-distance-filter') {
                const value = e.target.value;
                this.distanceFilter = value === 'none' ? null : parseInt(value);
                this.showingAllRows = false; // Reset display limit
                this.filterAndRenderSpots();
            } else if (e.target.id === 'digital-spots-country-filter') {
                this.countryFilter = e.target.value;
                this.showingAllRows = false; // Reset display limit
                this.filteredSpotsCache = null; // Invalidate cache
                this.filterAndRenderSpots();
            } else if (e.target.id === 'digital-spots-show-badges') {
                this.showBadges = e.target.checked;
                this.updateBadges();
            }
        });

        container.addEventListener('input', (e) => {
            if (e.target.id === 'digital-spots-callsign-filter') {
                // Debounce callsign filter to avoid filtering on every keystroke
                if (this.callsignFilterDebounceTimer) {
                    clearTimeout(this.callsignFilterDebounceTimer);
                }
                
                this.callsignFilter = e.target.value.toUpperCase();
                this.callsignFilterDebounceTimer = setTimeout(() => {
                    this.showingAllRows = false; // Reset display limit
                    this.filterAndRenderSpots();
                }, this.filterDebounceDelay);
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

        // Invalidate caches when new spot added
        this.filteredSpotsCache = null;
        this.badgeCache = null;

        // Only update UI if panel is visible
        const panel = document.querySelector('.decoder-extension-panel');
        const isPanelVisible = panel && panel.style.display !== 'none';

        if (isPanelVisible) {
            // Add to pending queue for incremental rendering
            this.pendingSpots.push(spot);

            // Throttle rendering to max once per 500ms
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

        const tbody = document.getElementById('digital-spots-tbody');
        if (!tbody) return;

        // Get current filter parameters
        const now = Date.now();
        const nowDate = new Date(now);
        const maxAgeMs = this.ageFilter !== null ? this.ageFilter * 60 * 1000 : null;
        const minSnr = this.snrFilter;
        const minDistance = this.distanceFilter;
        const callsignUpper = this.callsignFilter.toUpperCase();

        // Filter pending spots
        const newFilteredSpots = this.pendingSpots.filter(spot => {
            // Age filter FIRST
            if (maxAgeMs !== null) {
                try {
                    const spotTime = new Date(spot.timestamp);
                    const ageMs = nowDate - spotTime;
                    if (ageMs > maxAgeMs) return false;
                } catch (e) {
                    return false;
                }
            }
            // Band filter
            if (this.bandFilter !== 'all' && spot.band !== this.bandFilter) return false;
            // Mode filter
            if (this.modeFilter !== 'all' && spot.mode !== this.modeFilter) return false;
            // Locator filter
            if (!spot.locator || spot.locator.trim() === '') return false;
            // SNR filter
            if (minSnr !== null && spot.snr < minSnr) return false;
            // Distance filter
            if (minDistance !== null && spot.distance_km !== undefined && spot.distance_km !== null) {
                if (spot.distance_km < minDistance) return false;
            }
            // Country filter
            if (this.countryFilter !== 'all' && spot.country !== this.countryFilter) return false;
            // Callsign filter
            if (callsignUpper &&
                !spot.callsign.toUpperCase().includes(callsignUpper) &&
                !(spot.locator && spot.locator.toUpperCase().includes(callsignUpper)) &&
                !(spot.message && spot.message.toUpperCase().includes(callsignUpper))) {
                return false;
            }
            return true;
        });

        // Clear pending queue
        this.pendingSpots = [];

        if (newFilteredSpots.length === 0) return;

        // Create rows for new spots
        const fragment = document.createDocumentFragment();
        newFilteredSpots.forEach(spot => {
            const row = this.createSpotRow(spot);
            fragment.appendChild(row);
        });

        // Prepend new rows to table
        if (tbody.firstChild) {
            tbody.insertBefore(fragment, tbody.firstChild);
        } else {
            tbody.appendChild(fragment);
        }

        // Enforce display limit by removing excess rows from bottom
        const displayLimit = this.showingAllRows ? Infinity : this.maxDisplayRows;
        while (tbody.children.length > displayLimit + 1) { // +1 for potential "show more" row
            const lastChild = tbody.lastChild;
            if (lastChild && !lastChild.classList.contains('show-more-row') && !lastChild.classList.contains('show-less-row')) {
                tbody.removeChild(lastChild);
            } else {
                break;
            }
        }

        // Update count
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
        if (spot.country) {
            countryCell.style.cursor = 'pointer';
            countryCell.addEventListener('click', (e) => {
                e.stopPropagation();
                this.filterByCountry(spot.country);
            });
        }
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

        return row;
    }

    filterAndRenderSpots(forceRefresh = false) {
        const tbody = document.getElementById('digital-spots-tbody');
        if (!tbody) return;

        // Prevent multiple pending renders to avoid blocking audio thread
        if (this.renderPending) return;
        this.renderPending = true;

        // Check if we can use cached results
        const now = Date.now();
        const filterParams = JSON.stringify({
            age: this.ageFilter,
            mode: this.modeFilter,
            band: this.bandFilter,
            snr: this.snrFilter,
            distance: this.distanceFilter,
            callsign: this.callsignFilter,
            spotCount: this.spots.length
        });

        let filteredSpots;
        if (!forceRefresh && this.filteredSpotsCache && this.lastFilterParams === filterParams) {
            // Use cached results
            filteredSpots = this.filteredSpotsCache;
        } else {
            // Apply filters with optimized order (cheapest first, most selective early)
            const nowDate = new Date(now);
            const maxAgeMs = this.ageFilter !== null ? this.ageFilter * 60 * 1000 : null;
            const minSnr = this.snrFilter;
            const minDistance = this.distanceFilter;
            const callsignUpper = this.callsignFilter.toUpperCase();

            filteredSpots = this.spots.filter(spot => {
                // Age filter FIRST - most selective, eliminates old spots early
                if (maxAgeMs !== null) {
                    try {
                        const spotTime = new Date(spot.timestamp);
                        const ageMs = nowDate - spotTime;
                        if (ageMs > maxAgeMs) return false;
                    } catch (e) {
                        return false; // Skip invalid timestamps
                    }
                }

                // Band filter - very selective when not 'all'
                if (this.bandFilter !== 'all' && spot.band !== this.bandFilter) {
                    return false;
                }

                // Mode filter - selective when not 'all'
                if (this.modeFilter !== 'all' && spot.mode !== this.modeFilter) {
                    return false;
                }

                // Filter out spots with empty Grid/locator
                if (!spot.locator || spot.locator.trim() === '') {
                    return false;
                }

                // SNR filter - cheap comparison
                if (minSnr !== null && spot.snr < minSnr) {
                    return false;
                }

                // Distance filter - cheap comparison
                if (minDistance !== null) {
                    if (spot.distance_km !== undefined && spot.distance_km !== null) {
                        if (spot.distance_km < minDistance) {
                            return false;
                        }
                    }
                }

                // Country filter
                if (this.countryFilter !== 'all' && spot.country !== this.countryFilter) {
                    return false;
                }

                // Callsign filter LAST - most expensive (string operations)
                if (callsignUpper &&
                    !spot.callsign.toUpperCase().includes(callsignUpper) &&
                    !(spot.locator && spot.locator.toUpperCase().includes(callsignUpper)) &&
                    !(spot.message && spot.message.toUpperCase().includes(callsignUpper))) {
                    return false;
                }

                return true;
            });

            // Cache the results
            this.filteredSpotsCache = filteredSpots;
            this.lastFilterParams = filterParams;
        }

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

            // Limit displayed rows for performance (show first N rows)
            const displayLimit = this.showingAllRows ? filteredSpots.length : Math.min(this.maxDisplayRows, filteredSpots.length);
            const spotsToRender = filteredSpots.slice(0, displayLimit);

            // Render spots using DocumentFragment
            spotsToRender.forEach((spot) => {
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
                if (spot.country) {
                    countryCell.style.cursor = 'pointer';
                    countryCell.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.filterByCountry(spot.country);
                    });
                }
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

            // Add "show more" button if there are more spots to display
            if (displayLimit < filteredSpots.length && !this.showingAllRows) {
                const row = document.createElement('tr');
                row.className = 'show-more-row';
                const cell = document.createElement('td');
                cell.colSpan = 12;
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
                // Add "show less" button
                const row = document.createElement('tr');
                row.className = 'show-less-row';
                const cell = document.createElement('td');
                cell.colSpan = 12;
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
                badge.title = `${country} on ${currentBand}\nLast: ${spotData.callsign}\nMode: ${spotData.mode}\nSNR: ${snrText} dB`;
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
            const spotTime = new Date(spot.timestamp).getTime();
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
        this.filteredSpotsCache = null; // Invalidate cache
        this.badgeCache = null; // Invalidate badge cache
        this.showingAllRows = false; // Reset display limit
        this.pendingSpots = []; // Clear pending queue
        if (this.renderThrottleTimer) {
            clearTimeout(this.renderThrottleTimer);
            this.renderThrottleTimer = null;
        }
        this.filterAndRenderSpots();
    }

    startAgeUpdates() {
        this.ageUpdateInterval = setInterval(() => {
            // Skip all processing if extension panel is not visible
            const panel = document.querySelector('.decoder-extension-panel');
            const isPanelVisible = panel && panel.style.display !== 'none';
            
            if (isPanelVisible) {
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

        // Subscribe to digital spots on server
        if (window.dxClusterClient) {
            window.dxClusterClient.subscribeToDigitalSpots();
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

        // Unsubscribe from digital spots on server
        if (window.dxClusterClient) {
            window.dxClusterClient.unsubscribeFromDigitalSpots();
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

        // Reset mode filter to 'all' and checkbox to unchecked when opening modal
        this.currentModalModeFilter = 'all';
        const modeFilter = document.getElementById('country-spots-modal-mode-filter');
        if (modeFilter) {
            modeFilter.value = 'all';
        }

        this.showAllCountriesInModal = false;
        const showAllCheckbox = document.getElementById('country-spots-show-all-countries');
        if (showAllCheckbox) {
            showAllCheckbox.checked = false;
        }

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
        const modalTbody = document.getElementById('country-spots-modal-tbody');

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
            const spotTime = new Date(spot.timestamp).getTime();
            if (spotTime < tenMinutesAgo) return false;

            // Band filter (always apply)
            if (spot.band !== band) return false;

            // Country filter (conditional based on checkbox)
            if (!this.showAllCountriesInModal && spot.country !== country) return false;

            // Mode filter last (only if not 'all')
            if (this.currentModalModeFilter !== 'all' && spot.mode !== this.currentModalModeFilter) {
                return false;
            }

            return true;
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
            cell.colSpan = 9;
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

                // Country
                const countryCell = document.createElement('td');
                countryCell.className = 'modal-country';
                countryCell.textContent = spot.country || '';
                row.appendChild(countryCell);

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
        // Stop periodic graph refresh
        this.stopModalGraphRefresh();

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
        const showAllCheckbox = document.getElementById('country-spots-show-all-countries');

        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                this.closeCountryModal();
            });
        }

        if (modeFilter) {
            modeFilter.addEventListener('change', (e) => {
                this.currentModalModeFilter = e.target.value;
                // Mark that graph needs refresh due to filter change
                this._modalNeedsGraphRefresh = true;
                this.refreshModalContent();
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
            const spotTime = new Date(spot.timestamp).getTime();
            if (spotTime < tenMinutesAgo) return false;

            // Band filter (always apply)
            if (spot.band !== band) return false;

            // Country filter (conditional based on checkbox)
            if (!this.showAllCountriesInModal && spot.country !== country) return false;

            // Mode filter last (only if not 'all')
            if (this.currentModalModeFilter !== 'all' && spot.mode !== this.currentModalModeFilter) {
                return false;
            }

            return true;
        });

        // Group spots by mode
        const spotsByMode = {};
        countrySpots.forEach(spot => {
            if (!spotsByMode[spot.mode]) {
                spotsByMode[spot.mode] = [];
            }
            spotsByMode[spot.mode].push(spot);
        });

        // Sort modes in preferred order: FT8, FT4, WSPR, then others alphabetically
        const modeOrder = { 'FT8': 1, 'FT4': 2, 'WSPR': 3 };
        const modes = Object.keys(spotsByMode).sort((a, b) => {
            const orderA = modeOrder[a] || 999;
            const orderB = modeOrder[b] || 999;
            if (orderA !== orderB) {
                return orderA - orderB;
            }
            return a.localeCompare(b); // Alphabetical for other modes
        });

        // Render graphs
        const container = document.getElementById('country-spots-graphs-container');
        if (!container) return;

        // Check if we need to rebuild the structure (modes changed)
        const existingModes = Array.from(container.querySelectorAll('.country-spots-graph'))
            .map(g => g.getAttribute('data-mode'))
            .filter(m => m);

        const modesChanged = modes.length !== existingModes.length ||
                           !modes.every(m => existingModes.includes(m));

        if (modesChanged) {
            // Structure changed, need to rebuild
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

            // Restore scroll position
            requestAnimationFrame(() => {
                container.scrollTop = scrollTop;
            });
        } else {
            // Just update existing canvases without rebuilding
            modes.forEach(mode => {
                const modeSpots = spotsByMode[mode];
                const graphDiv = container.querySelector(`.country-spots-graph[data-mode="${mode}"]`);
                if (graphDiv) {
                    // Update title
                    const title = graphDiv.querySelector('.country-spots-graph-title');
                    if (title) {
                        title.textContent = `${mode} - ${modeSpots.length} spot${modeSpots.length !== 1 ? 's' : ''}`;
                    }
                    // Redraw canvas with tooltip
                    const canvas = graphDiv.querySelector('.country-spots-graph-canvas');
                    const tooltip = graphDiv.querySelector('.country-spots-graph-tooltip');
                    if (canvas) {
                        this.drawFrequencyTimeGraph(canvas, modeSpots, mode, tooltip);
                    }
                }
            });
        }
    }

    renderModeGraph(container, mode, spots) {
        // Create graph container
        const graphDiv = document.createElement('div');
        graphDiv.className = 'country-spots-graph';
        graphDiv.setAttribute('data-mode', mode);

        const title = document.createElement('div');
        title.className = 'country-spots-graph-title';
        title.textContent = `${mode} - ${spots.length} spot${spots.length !== 1 ? 's' : ''}`;
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
        this.drawFrequencyTimeGraph(canvas, spots, mode, tooltip);
    }

    drawFrequencyTimeGraph(canvas, spots, mode, tooltip = null) {
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

        // Calculate time range based on actual spot times (not rolling window)
        // This makes the time axis show absolute times where spots occurred
        const spotTimes = spots.map(s => new Date(s.timestamp).getTime());
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
        // This ensures labels align with mode-specific boundaries (FT8=15s, FT4=7.5s, WSPR=120s)
        ctx.textAlign = 'center';

        // Get unique spot times and sort them
        const uniqueSpotTimes = [...new Set(spotTimes)].sort((a, b) => a - b);

        // Select evenly distributed spot times for labels (aim for ~5-7 labels)
        const targetLabels = 6;
        const labelTimes = [];

        if (uniqueSpotTimes.length <= targetLabels) {
            // Use all unique times if we have few spots
            labelTimes.push(...uniqueSpotTimes);
        } else {
            // Select evenly distributed times from actual spots
            const step = Math.floor(uniqueSpotTimes.length / (targetLabels - 1));
            for (let i = 0; i < targetLabels - 1; i++) {
                labelTimes.push(uniqueSpotTimes[i * step]);
            }
            // Always include the last spot time
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

        // Helper function to get color based on SNR and mode
        const getSNRColor = (snr, mode) => {
            // Define SNR thresholds for each mode
            let thresholds;
            if (mode === 'WSPR') {
                // WSPR typical range: -31 to +10 dB
                thresholds = {
                    strong: -5,    // >= -5 dB: green (strong)
                    good: -15,     // >= -15 dB: yellow (good)
                    weak: -25      // >= -25 dB: orange (weak)
                    // < -25 dB: red (very weak)
                };
            } else {
                // FT8/FT4 typical range: -24 to +20 dB
                thresholds = {
                    strong: 5,     // >= +5 dB: green (strong)
                    good: -5,      // >= -5 dB: yellow (good)
                    weak: -15      // >= -15 dB: orange (weak)
                    // < -15 dB: red (very weak)
                };
            }

            if (snr >= thresholds.strong) {
                return '#28a745'; // Green - strong signal
            } else if (snr >= thresholds.good) {
                return '#ffc107'; // Yellow - good signal
            } else if (snr >= thresholds.weak) {
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
            const spotTime = new Date(spot.timestamp).getTime();
            const x = marginLeft + ((spotTime - displayMinTime) / displayTimeRange) * graphWidth;
            const baseY = height - marginBottom - ((spot.frequency - (minFreq - freqPadding)) / (freqRange + 2 * freqPadding)) * graphHeight;

            // Get color based on SNR
            const textColor = getSNRColor(spot.snr, mode);

            // Measure text width
            const textWidth = ctx.measureText(spot.callsign).width;

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

                // Add a small dot at the actual frequency/time position (only for shifted labels)
                ctx.fillStyle = textColor;
                ctx.beginPath();
                ctx.arc(x, baseY, 2, 0, 2 * Math.PI);
                ctx.fill();
            }

            // Draw callsign as text
            ctx.fillStyle = textColor;
            ctx.fillText(spot.callsign, x, y);
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
                    const distance = Math.sqrt(dx * dx + dy * dy);

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
                    const snrColor = getSNRColor(hoveredSpot.snr, mode);

                    tooltip.innerHTML = `
                        <div class="tooltip-row"><strong style="color: ${snrColor}">${hoveredSpot.callsign}</strong></div>
                        <div class="tooltip-row">Country: ${hoveredSpot.country || 'N/A'}</div>
                        <div class="tooltip-row">Mode: ${hoveredSpot.mode}</div>
                        <div class="tooltip-row">Freq: ${this.formatFrequency(hoveredSpot.frequency)} MHz</div>
                        <div class="tooltip-row">SNR: ${snrText} dB</div>
                        <div class="tooltip-row">Grid: ${hoveredSpot.locator || 'N/A'}</div>
                        <div class="tooltip-row">Distance: ${distanceText}</div>
                        <div class="tooltip-row">Bearing: ${bearingText}</div>
                        <div class="tooltip-row">Age: ${this.formatAge(hoveredSpot.timestamp)}</div>
                        ${hoveredSpot.message ? `<div class="tooltip-row">Msg: ${hoveredSpot.message}</div>` : ''}
                    `;

                    tooltip.style.display = 'block';

                    // Smart positioning: flip to left if too close to right edge
                    const tooltipWidth = tooltip.offsetWidth || 200; // Estimate if not yet rendered
                    const tooltipHeight = tooltip.offsetHeight || 150;
                    
                    let left = mouseX + 10;
                    let top = mouseY + 10;

                    // Check if tooltip would overflow right edge
                    if (left + tooltipWidth > rect.width) {
                        left = mouseX - tooltipWidth - 10;
                    }

                    // Check if tooltip would overflow bottom edge
                    if (top + tooltipHeight > rect.height) {
                        top = mouseY - tooltipHeight - 10;
                    }

                    // Ensure tooltip doesn't go off left edge
                    if (left < 0) {
                        left = 10;
                    }

                    // Ensure tooltip doesn't go off top edge
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

            // Click handler to open QRZ page
            canvas._clickHandler = (e) => {
                const rect = canvas.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;

                // Find clicked spot
                let clickedSpot = null;
                for (const pos of canvas._spotPositions) {
                    const dx = mouseX - pos.x;
                    const dy = mouseY - pos.y;

                    // Check if click is near the label
                    if (Math.abs(dx) < pos.width / 2 + 5 && Math.abs(dy) < labelHeight / 2 + 5) {
                        clickedSpot = pos.spot;
                        break;
                    }
                }

                if (clickedSpot) {
                    // Open QRZ page in new tab
                    this.openQRZ(clickedSpot.callsign);
                }
            };

            canvas.addEventListener('mousemove', canvas._mouseMoveHandler);
            canvas.addEventListener('mouseleave', canvas._mouseLeaveHandler);
            canvas.addEventListener('click', canvas._clickHandler);
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
        // This makes spots visually move from right to left as they age
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
        const countryFilter = document.getElementById('digital-spots-country-filter');
        if (countryFilter) {
            countryFilter.value = country;
            this.countryFilter = country;
            this.showingAllRows = false;
            this.filteredSpotsCache = null;
            this.filterAndRenderSpots();
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
                    const countryFilter = document.getElementById('digital-spots-country-filter');

                    if (countryFilter) {
                        // Keep the "All Countries" option and add countries
                        countries.forEach(country => {
                            const option = document.createElement('option');
                            option.value = country.name;
                            option.textContent = country.name;
                            countryFilter.appendChild(option);
                        });
                        console.log(`Digital Spots: Loaded ${countries.length} countries`);
                    } else if (attempts < maxAttempts) {
                        setTimeout(() => waitForDropdown(attempts + 1), 100);
                    } else {
                        console.error('Digital Spots: Country filter dropdown not found after', maxAttempts, 'attempts');
                    }
                };

                waitForDropdown();
            }
        } catch (error) {
            console.error('Digital Spots: Failed to fetch countries:', error);
        }
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
// CW Spots Graph Popup JavaScript
// Receives spot data from parent window via postMessage

// Register the datalabels plugin with Chart.js
Chart.register(ChartDataLabels);

// Escape before interpolating into marker tooltips/popups. The chart's tooltips
// are canvas-drawn by Chart.js so its strings need no escaping, but the map
// builds real HTML from the same spot fields plus operator-set receiver details.
function cwGraphEsc(value) {
    if (value == null) return '';
    return String(value).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function cwGraphIso2ToFlag(code) {
    if (!code || code.length !== 2) return '';
    const c = code.toUpperCase();
    return String.fromCodePoint(
        0x1F1E6 - 0x41 + c.charCodeAt(0),
        0x1F1E6 - 0x41 + c.charCodeAt(1)
    ) + ' ';
}

class CWSpotsGraph {
    constructor() {
        this.spots = [];
        this.chart = null;
        this.ageFilter = 10; // minutes
        this.bandFilter = 'all'; // band filter
        this.snrFilter = -999; // no filter
        this.lastSpotTime = null;
        this.showLabels = true; // Show callsign labels by default
        this.hoverTune = true; // Tune when hovering over spots
        this.autoTune = false; // Auto-tune to new spots
        this.autoLookup = false; // Update lookup popup on click and frequency change
        this.sessionUuid = ''; // UUID received from parent for lookup popup authentication
        this._lookupWindow = null; // Reference to the lookup popup opened from this window
        this._lastAutoLookupCallsign = null; // Track last auto-looked-up callsign to avoid repeated lookups
        this.parentCheckInterval = null;
        this.activeTooltip = null; // Track active tooltip from label hover
        this.currentFrequency = null; // Tuned frequency relayed from parent (Hz)
        this._lastHoverFrequency = null; // Debounce hover-tune: only send when spot changes

        // Map view state. The Chart/Map switcher only appears when the server
        // reports that CW spots carry real QRZ positions; until then the map is
        // never built and 'chart' is the only view.
        this.view = 'chart'; // 'chart' | 'map' — chart is always the default
        this.mapEnabled = false; // Set from /api/description
        this.map = null; // Leaflet map, lazily created on first switch to map view
        this.mapMarkers = new Map(); // dx_call -> { marker, stamp }, diffed against the filtered set
        this.description = null; // Cached /api/description payload (gating + receiver marker)
        this.rxMarker = null; // This instance's own location marker

        // CW decoder state
        this.morseRunning = false;
        this.morseTextBuffer = '';
        this.morseCollapsed = true; // Start collapsed; expands on Start or toggle
        this.morseMinQuality = 'all'; // Minimum quality filter: all | low | medium | high

        this.init();
    }

    init() {
        console.log('CW Spots Graph: Initializing...');

        // Setup message listener from parent window
        window.addEventListener('message', (event) => {
            this.handleMessage(event);
        });

        // Setup UI event handlers
        this.setupEventHandlers();
        this.setupDecoderHandlers();

        // Ask the server whether CW spots are enriched with QRZ positions.
        // Only then is a map worth offering (see checkMapAvailability).
        this.checkMapAvailability();

        // Apply initial collapsed state to decoder body
        this._morseApplyCollapsedState();

        // Sync checkbox states (Firefox remembers form state across refreshes)
        this.syncCheckboxStates();

        // Initialize chart
        this.initChart();

        // Request initial data from parent
        this.requestInitialData();

        // Update status
        this.updateStatus('connected');

        // Start monitoring parent window
        this.startParentMonitoring();

        console.log('CW Spots Graph: Ready');
    }

    startParentMonitoring() {
        // Check if parent window is still open every 2 seconds
        this.parentCheckInterval = setInterval(() => {
            if (!window.opener || window.opener.closed) {
                this.showDisconnectedOverlay();
                clearInterval(this.parentCheckInterval);
            }
        }, 2000);
    }

    showDisconnectedOverlay() {
        const overlay = document.getElementById('disconnected-overlay');
        if (overlay) {
            overlay.style.display = 'flex';
        }
        this.updateStatus('disconnected');
        // Stop the morse decoder if it was running — parent is gone
        if (this.morseRunning) {
            this.morseRunning = false;
            this._morseSetStatus('Connection lost — decoder stopped', 'error');
            this._morseUpdateButton();
        }
    }

    hideDisconnectedOverlay() {
        const overlay = document.getElementById('disconnected-overlay');
        if (overlay) {
            overlay.style.display = 'none';
        }
    }
    
    handleMessage(event) {
        const { type, data } = event.data;
        
        switch (type) {
            case 'cw_spot':
                this.addSpot(data);
                this.hideDisconnectedOverlay(); // Hide overlay if extension reconnects
                break;
            case 'cw_spots_initial':
                if (event.data.currentFrequency != null) {
                    this.currentFrequency = event.data.currentFrequency;
                }
                // Store UUID for lookup popup authentication
                if (event.data.uuid != null) {
                    this.sessionUuid = event.data.uuid;
                }
                // Enable/disable the Lookup checkbox based on server capability
                if (event.data.lookupServiceAvailable != null) {
                    const lookupCheckbox = document.getElementById('lookup-checkbox');
                    if (lookupCheckbox) {
                        lookupCheckbox.disabled = !event.data.lookupServiceAvailable;
                        if (!event.data.lookupServiceAvailable) {
                            lookupCheckbox.checked = false;
                            this.autoLookup = false;
                        }
                    }
                }
                this.loadInitialSpots(data, event.data.bandFilter);
                this.hideDisconnectedOverlay(); // Hide overlay if extension reconnects
                break;
            case 'band_filter_sync':
                // Explicit band filter sync from parent
                this.bandFilter = data;
                const syncBandSelect = document.getElementById('graph-band-filter');
                if (syncBandSelect) syncBandSelect.value = data;
                this.updateViews();
                this.updateUI();
                break;
            case 'frequency_changed':
                this.currentFrequency = event.data.frequency;
                this.updateViews();
                // Auto-lookup: if enabled, find matching spot and look it up — but only when
                // the matched callsign changes (debounce repeated lookups on same spot)
                if (this.autoLookup && this.currentFrequency != null) {
                    const filtered = this.getFilteredSpots();
                    const match = filtered.find(s => Math.abs(s.frequency - this.currentFrequency) <= 10);
                    const matchCallsign = match ? match.dx_call : null;
                    if (matchCallsign !== this._lastAutoLookupCallsign) {
                        this._lastAutoLookupCallsign = matchCallsign;
                        if (match && window.opener && !window.opener.closed) {
                            window.opener.postMessage({ type: 'tune_to_spot_click', spot: match }, '*');
                        }
                    }
                }
                break;
            case 'cw_spots_clear':
                this.clearSpots();
                break;
            case 'extension_disabled':
                this.showDisconnectedOverlay();
                break;
            case 'extension_enabled':
                this.hideDisconnectedOverlay();
                this.updateStatus('connected');
                break;
            case 'band_filter_changed':
                // Parent window changed the band filter - sync our dropdown
                this.bandFilter = data;
                const bandSelect = document.getElementById('graph-band-filter');
                if (bandSelect) bandSelect.value = data;
                this.updateViews();
                this.updateUI();
                break;
            case 'morse_attached':
                // Backend confirmed the morse decoder is running
                this._morseSetStatus('Running — listening for CW…', 'ok');
                break;
            case 'morse_frame':
                // Binary frame from the cw-decoder subprocess (relayed by parent)
                if (event.data.data instanceof ArrayBuffer) {
                    this._morseHandleBinary(event.data.data);
                }
                break;
            case 'morse_error':
                // Decoder error (WebSocket issue, subprocess crash, etc.)
                this._morseHandleError(event.data.msg || 'Unknown error');
                break;
            default:
                // Ignore unknown message types
                break;
        }
    }
    
    requestInitialData() {
        // Ask parent window for current spots
        if (window.opener) {
            window.opener.postMessage({ type: 'request_initial_spots' }, '*');
        }
    }
    
    loadInitialSpots(spots, bandFilter) {
        console.log('CW Spots Graph: Loading', spots.length, 'initial spots');
        this.spots = spots.map(spot => ({
            ...spot,
            timestamp: new Date(spot.time)
        }));
        // Sync band filter from parent if provided
        if (bandFilter !== undefined) {
            this.bandFilter = bandFilter;
            const bandSelect = document.getElementById('graph-band-filter');
            if (bandSelect) bandSelect.value = bandFilter;
        }
        this.updateViews();
        this.updateUI();
        this.updateLatestSpotForBand();
    }
    
    addSpot(spot) {
        // Add timestamp
        spot.timestamp = new Date(spot.time);
        
        // Add to spots array
        this.spots.unshift(spot);
        
        // Limit array size
        if (this.spots.length > 5000) {
            this.spots = this.spots.slice(0, 5000);
        }

        // Only update latest spot display and auto-tune if spot passes current filters
        const passesFilter = (!this.bandFilter || this.bandFilter === 'all' || spot.band === this.bandFilter)
            && (this.snrFilter <= -999 || spot.snr >= this.snrFilter);

        if (passesFilter) {
            // Update last spot time
            this.lastSpotTime = spot.timestamp;

            // Update latest spot display
            this.updateLatestSpot(spot);

            // Auto-tune if enabled
            if (this.autoTune) {
                this.tuneToSpot(spot);
            }
        }

        // Update chart and UI
        this.updateViews();
        this.updateUI();
    }

    clearSpots() {
        this.spots = [];
        this.lastSpotTime = null;

        // Reset latest spot display
        const latestSpotEl = document.getElementById('latest-spot');
        if (latestSpotEl) {
            latestSpotEl.textContent = 'No spots yet';
            latestSpotEl.className = 'latest-spot no-spot';
            latestSpotEl.style.cursor = 'default';
            latestSpotEl.onclick = null;
            delete latestSpotEl.dataset.spot;
        }

        this.updateViews();
        this.updateUI();
    }
    
    setupEventHandlers() {
        // Chart/Map view switcher (hidden unless QRZ lookups are enabled)
        document.querySelectorAll('.view-toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => this.setView(btn.dataset.view));
        });

        // Band filter
        document.getElementById('graph-band-filter').addEventListener('change', (e) => {
            this.bandFilter = e.target.value;
            this.updateViews();
            this.updateUI();
            this.updateLatestSpotForBand();
            // Notify parent window to sync its band filter (no data refresh needed)
            if (window.opener && !window.opener.closed) {
                window.opener.postMessage({
                    type: 'set_band_filter_only',
                    band: this.bandFilter
                }, '*');
            }
        });

        // Age filter
        document.getElementById('graph-age-filter').addEventListener('change', (e) => {
            this.ageFilter = parseInt(e.target.value);
            this.updateViews();
            this.updateUI();
        });
        
        // SNR filter
        document.getElementById('graph-snr-filter').addEventListener('change', (e) => {
            this.snrFilter = parseInt(e.target.value);
            this.updateViews();
            this.updateUI();
        });
        
        // Clear button
        document.getElementById('clear-btn').addEventListener('click', () => {
            this.clearSpots();
            // Notify parent to clear as well
            if (window.opener) {
                window.opener.postMessage({ type: 'clear_spots_from_graph' }, '*');
            }
        });

        // Show labels checkbox
        document.getElementById('show-labels-checkbox').addEventListener('change', (e) => {
            this.showLabels = e.target.checked;
            this.updateViews();
        });

        // Hover-tune checkbox
        document.getElementById('hover-tune-checkbox').addEventListener('change', (e) => {
            this.hoverTune = e.target.checked;
        });

        // Auto-tune checkbox
        document.getElementById('auto-tune-checkbox').addEventListener('change', (e) => {
            this.autoTune = e.target.checked;
        });

        // Lookup checkbox — open lookup window directly (user gesture here); notify parent to get reference
        document.getElementById('lookup-checkbox').addEventListener('change', (e) => {
            this.autoLookup = e.target.checked;
            if (!this.autoLookup) {
                this._lastAutoLookupCallsign = null; // Reset so next enable fires immediately
            }
            if (this.autoLookup) {
                const url = `/callsign_lookup.html?uuid=${encodeURIComponent(this.sessionUuid)}`;
                if (this._lookupWindow && !this._lookupWindow.closed) {
                    this._lookupWindow.focus();
                } else {
                    this._lookupWindow = window.open(url, 'callsign_lookup', 'width=520,height=800,resizable=yes,scrollbars=yes');
                    // Notify parent so it can probe the named window and store its own reference
                    if (window.opener && !window.opener.closed) {
                        window.opener.postMessage({ type: 'lookup_window_opened' }, '*');
                    }
                }
            }
        });

        // Fullscreen button
        document.getElementById('fullscreen-btn').addEventListener('click', () => {
            this.toggleFullscreen();
        });
    }

    syncCheckboxStates() {
        // Sync JavaScript properties with checkbox states
        // (Firefox remembers form state across refreshes)
        const showLabelsCheckbox = document.getElementById('show-labels-checkbox');
        if (showLabelsCheckbox) {
            this.showLabels = showLabelsCheckbox.checked;
        }

        const hoverTuneCheckbox = document.getElementById('hover-tune-checkbox');
        if (hoverTuneCheckbox) {
            this.hoverTune = hoverTuneCheckbox.checked;
        }

        const autoTuneCheckbox = document.getElementById('auto-tune-checkbox');
        if (autoTuneCheckbox) {
            this.autoTune = autoTuneCheckbox.checked;
        }

        const lookupCheckbox = document.getElementById('lookup-checkbox');
        if (lookupCheckbox) {
            this.autoLookup = lookupCheckbox.checked;
        }
    }

    toggleFullscreen() {
        if (!document.fullscreenElement) {
            // Enter fullscreen
            document.documentElement.requestFullscreen().catch(err => {
                console.error('Error attempting to enable fullscreen:', err);
            });
        } else {
            // Exit fullscreen
            if (document.exitFullscreen) {
                document.exitFullscreen();
            }
        }
    }
    
    initChart() {
        const ctx = document.getElementById('spotsChart').getContext('2d');
        const self = this; // Capture reference for use in callbacks
        
        this.chart = new Chart(ctx, {
            type: 'scatter',
            data: {
                datasets: []
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'point',
                    intersect: true
                },
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        animation: false,
                        displayColors: false,
                        backgroundColor: 'rgba(0, 0, 0, 0.8)',
                        titleColor: '#fff',
                        bodyColor: '#fff',
                        borderWidth: 2,
                        borderColor: (context) => {
                            const items = context.tooltipItems;
                            if (items && items.length > 0) {
                                const spot = items[0].raw.spot;
                                if (spot.snr > 26)  return '#28a745';
                                if (spot.snr >= 13) return '#ffc107';
                                if (spot.snr >= 6)  return '#ff8c00';
                                return '#dc3545';
                            }
                            return '#4CAF50';
                        },
                        callbacks: {
                            title: (items) => {
                                if (items.length > 0) {
                                    const spot = items[0].raw.spot;
                                    const flag = cwGraphIso2ToFlag(spot.country_code);
                                    return flag + (spot.dx_call || 'Unknown');
                                }
                                return '';
                            },
                            label: (item) => {
                                const spot = item.raw.spot;
                                const lines = [];
                                lines.push(`Freq: ${(spot.frequency / 1e6).toFixed(4)} MHz`);
                                lines.push(`Band: ${spot.band || 'Unknown'}`);
                                lines.push(`SNR: ${spot.snr} dB`);
                                lines.push(`WPM: ${spot.wpm || 'N/A'}`);
                                if (spot.country) lines.push(`Country: ${spot.country}`);
                                if (spot.distance_km) lines.push(`Distance: ${Math.round(spot.distance_km)} km`);
                                return lines;
                            }
                        }
                    },
                    datalabels: {
                        display: (context) => {
                            return self.showLabels;
                        },
                        formatter: (value, context) => {
                            const spot = value.spot;
                            const flag = cwGraphIso2ToFlag(spot.country_code);
                            return flag + (spot.dx_call || 'Unknown');
                        },
                        color: (context) => {
                            const spot = context.dataset.data[context.dataIndex]?.spot;
                            if (spot && self.currentFrequency != null &&
                                Math.abs(spot.frequency - self.currentFrequency) <= 10) {
                                return '#00e676'; // bright green for tuned station
                            }
                            return '#ffffff';
                        },
                        font: {
                            size: 10,
                            weight: 'normal'
                        },
                        align: 'right',
                        offset: 4,
                        backgroundColor: 'rgba(0, 0, 0, 0.6)',
                        borderRadius: 3,
                        padding: {
                            top: 2,
                            bottom: 2,
                            left: 4,
                            right: 4
                        },
                        clip: false
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            unit: 'minute',
                            displayFormats: {
                                minute: 'HH:mm'
                            }
                        },
                        title: {
                            display: true,
                            text: 'Time (UTC)',
                            color: '#aaa'
                        },
                        ticks: {
                            color: '#aaa'
                        },
                        grid: {
                            color: '#444'
                        },
                        afterFit: (scale) => {
                            // Add padding to the right to accommodate labels
                            scale.paddingRight = 60;
                        }
                    },
                    y: {
                        title: {
                            display: true,
                            text: 'Frequency (MHz)',
                            color: '#aaa'
                        },
                        ticks: {
                            color: '#aaa',
                            callback: function(value) {
                                return value.toFixed(3);
                            }
                        },
                        grid: {
                            color: '#444'
                        }
                    }
                },
                onClick: (event, elements) => {
                    if (elements.length > 0) {
                        const spot = elements[0].element.$context.raw.spot;
                        this.tuneToSpotClick(spot);
                    }
                },
                onHover: (event, elements) => {
                    if (this.hoverTune && elements.length > 0) {
                        // Get the chart element
                        const element = elements[0];
                        // Access the data through the chart's dataset
                        const datasetIndex = element.datasetIndex;
                        const index = element.index;
                        const spot = this.chart.data.datasets[datasetIndex].data[index].spot;
                        // Only tune if the hovered spot has changed — prevents flooding
                        // the parent with tune requests on every mousemove pixel
                        if (spot && spot.frequency !== this._lastHoverFrequency) {
                            this._lastHoverFrequency = spot.frequency;
                            this.tuneToSpot(spot);
                        }
                    } else if (elements.length === 0) {
                        this._lastHoverFrequency = null;
                    }
                }
            }
        });
    }
    
    // ── View switching (Chart / Map) ──────────────────────────────────────────

    async checkMapAvailability() {
        // The map is only offered when CW spots actually carry per-operator QRZ
        // positions. Without lookups every spot falls back to its DXCC entity
        // centroid, so a map would show one pile per country — worse than no map.
        try {
            const resp = await fetch('/api/description');
            if (!resp.ok) return;
            const info = await resp.json();
            if (!info.cw_skimmer_callsign_lookup) return;
            // Retained for the receiver marker, so the map costs no second fetch.
            this.description = info;
        } catch (err) {
            // Endpoint unreachable — leave the switcher hidden and stay on the chart.
            console.warn('CW Spots Graph: Could not determine lookup availability:', err);
            return;
        }

        this.mapEnabled = true;
        const toggle = document.getElementById('view-toggle');
        if (toggle) toggle.style.display = '';
        console.log('CW Spots Graph: QRZ lookups enabled — map view available');
    }

    setView(view) {
        if (!this.mapEnabled && view === 'map') return;
        if (view === this.view) return;
        this.view = view;

        const chartWrapper = document.getElementById('chart-wrapper');
        const mapWrapper = document.getElementById('map-wrapper');
        const chartFooter = document.getElementById('chart-footer-text');
        const mapFooter = document.getElementById('map-footer-text');
        const showMap = view === 'map';

        if (chartWrapper) chartWrapper.style.display = showMap ? 'none' : '';
        if (mapWrapper) mapWrapper.style.display = showMap ? '' : 'none';
        if (chartFooter) chartFooter.style.display = showMap ? 'none' : '';
        if (mapFooter) mapFooter.style.display = showMap ? '' : 'none';

        document.querySelectorAll('.view-toggle-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === view);
        });

        if (showMap) {
            this.initMap();
            // Leaflet cannot measure a hidden container, so the size it computed
            // while display:none was wrong. Recalculate now that it is visible.
            if (this.map) this.map.invalidateSize();
        }

        // Render whichever view just became visible with the current filter set.
        this.updateViews();
    }

    initMap() {
        if (this.map) return;

        this.map = L.map('spots-map', {
            worldCopyJump: true,
            preferCanvas: true
        }).setView([25, 0], 2);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors',
            maxZoom: 18
        }).addTo(this.map);

        this.addReceiverMarker();
    }

    // updateViews is the single entry point for "the filtered spot set may have
    // changed". Both views are driven from one getFilteredSpots() call so the map
    // can never drift from the chart — spots appear and age out identically.
    updateViews() {
        const filtered = this.getFilteredSpots();
        if (this.view === 'map') {
            this.updateMap(filtered);
        } else {
            this.updateChart(filtered);
        }
    }

    // Collapse the filtered spots to one entry per station, keeping the most
    // recent. The chart plots frequency against time, so repeated spots of the
    // same station are distinct and meaningful points there. A map has no time
    // axis: those repeats resolve to identical coordinates and would stack into
    // invisible duplicate markers. Same stations, same appear/disappear moments
    // as the chart — just without the time dimension the map cannot show.
    latestPerStation(spots) {
        const byCall = new Map();
        for (const spot of spots) {
            const prev = byCall.get(spot.dx_call);
            if (!prev || spot.timestamp > prev.timestamp) {
                byCall.set(spot.dx_call, spot);
            }
        }
        return byCall;
    }

    // Deterministic per-callsign scatter, used ONLY for centroid positions so a
    // country's spots don't stack on a single pixel. Precise QRZ positions are
    // never moved. Same hash approach as the standalone CW skimmer map.
    centroidOffset(callsign) {
        let hash = 0;
        for (let i = 0; i < callsign.length; i++) {
            hash = ((hash << 5) - hash) + callsign.charCodeAt(i);
            hash |= 0;
        }
        hash = Math.abs(hash);
        return {
            lat: ((hash % 1000) / 1000 - 0.5) * 0.8,   // ±0.4°
            lon: (((hash / 1000) % 1000) / 1000 - 0.5) * 1.6 // ±0.8°
        };
    }

    // Marker HTML: an SNR-coloured dot plus the flag+callsign label, mirroring
    // the chart's datalabels — same "Show Callsigns" toggle, same flag+call
    // text, and the same bright green for the station currently tuned.
    markerHtml(spot, approx) {
        const colour = this.snrColour(spot.snr);
        let html = `<div class="cw-map-marker${approx ? ' approx' : ''}" style="background:${colour};border-color:${colour}"></div>`;

        if (this.showLabels) {
            const tuned = this.currentFrequency != null &&
                Math.abs(spot.frequency - this.currentFrequency) <= 10;
            const flag = cwGraphIso2ToFlag(spot.country_code);
            const label = flag + cwGraphEsc(spot.dx_call || 'Unknown');
            html += `<span class="cw-map-label${tuned ? ' tuned' : ''}">${label}</span>`;
        }
        return html;
    }

    markerIcon(spot, approx) {
        return L.divIcon({
            className: 'cw-map-icon',
            html: this.markerHtml(spot, approx),
            iconSize: [11, 11],
            iconAnchor: [5.5, 5.5]
        });
    }

    updateMap(spots) {
        if (!this.map) return;

        const wanted = this.latestPerStation(spots);

        for (const [call, spot] of wanted) {
            // Spots without a resolved position can't be mapped at all.
            if (!spot.latitude && !spot.longitude) {
                wanted.delete(call);
                continue;
            }

            // loc_source tells us whether the position is a real QRZ one or the
            // DXCC centroid; only the latter gets scattered and drawn hollow.
            const approx = spot.loc_source !== 'qrz';
            const existing = this.mapMarkers.get(call);
            const stamp = spot.timestamp.getTime();

            if (existing) {
                // The icon depends on more than the spot itself — the "Show
                // Callsigns" toggle and the tuned frequency both change it — so
                // diff the rendered HTML rather than the timestamp, and repaint
                // only when it genuinely differs.
                const html = this.markerHtml(spot, approx);
                if (html !== existing.html) {
                    existing.marker.setIcon(this.markerIcon(spot, approx));
                    existing.html = html;
                }

                // Tooltip/popup/tune target only change when the spot does. The
                // position never does: QRZ coords and the centroid offset are
                // both per-callsign deterministic, so updating in place keeps
                // any open popup anchored instead of churning the marker.
                if (existing.stamp !== stamp) {
                    const content = this.mapPopupContent(spot, approx);
                    existing.marker.setTooltipContent(content);
                    existing.marker.setPopupContent(content);
                    existing.marker.off('click');
                    existing.marker.on('click', () => this.tuneToSpotClick(spot));
                    existing.stamp = stamp;
                }
                continue;
            }

            let lat = spot.latitude;
            let lon = spot.longitude;
            if (approx) {
                const off = this.centroidOffset(call || '');
                lat += off.lat;
                lon += off.lon;
            }

            const content = this.mapPopupContent(spot, approx);
            const marker = L.marker([lat, lon], { icon: this.markerIcon(spot, approx) });
            marker.bindTooltip(content, { direction: 'top', offset: [0, -8] });
            marker.bindPopup(content);
            marker.on('click', () => this.tuneToSpotClick(spot));

            marker.addTo(this.map);
            this.mapMarkers.set(call, { marker, stamp, html: this.markerHtml(spot, approx) });
        }

        // Drop markers for stations that no longer pass the filters — aged out,
        // band/SNR filter changed, or the spot list was cleared.
        for (const [call, entry] of this.mapMarkers) {
            if (!wanted.has(call)) {
                this.map.removeLayer(entry.marker);
                this.mapMarkers.delete(call);
            }
        }
    }

    // Marker tooltip/popup content. Deliberately mirrors the chart tooltip
    // (title + Freq/Band/SNR/WPM/Country/Distance, same formatting and same
    // conditional rows) so hovering a marker and hovering a chart point tell you
    // the same things — only the map-specific "approximate position" caveat is
    // added, because the chart has no position to caveat.
    mapPopupContent(spot, approx) {
        const flag = cwGraphIso2ToFlag(spot.country_code);
        const rows = [`<div class="cw-map-popup-call">${flag}${cwGraphEsc(spot.dx_call || 'Unknown')}</div>`];
        rows.push(`<div class="cw-map-popup-row">Freq: ${(spot.frequency / 1e6).toFixed(4)} MHz</div>`);
        rows.push(`<div class="cw-map-popup-row">Band: ${cwGraphEsc(spot.band || 'Unknown')}</div>`);
        rows.push(`<div class="cw-map-popup-row">SNR: ${cwGraphEsc(spot.snr)} dB</div>`);
        rows.push(`<div class="cw-map-popup-row">WPM: ${cwGraphEsc(spot.wpm || 'N/A')}</div>`);
        if (spot.country) rows.push(`<div class="cw-map-popup-row">Country: ${cwGraphEsc(spot.country)}</div>`);
        if (spot.distance_km) rows.push(`<div class="cw-map-popup-row">Distance: ${Math.round(spot.distance_km)} km</div>`);
        if (approx) {
            rows.push('<div class="cw-map-popup-hint">Approximate position (country centroid)</div>');
        }
        rows.push('<div class="cw-map-popup-hint">Click to tune</div>');
        return rows.join('');
    }

    // ── This receiver ─────────────────────────────────────────────────────────

    // Drop a marker on the instance's own site, mirroring map.html's loadReceiver.
    // Uses the /api/description response already fetched for the map gating, so
    // this costs no extra request.
    addReceiverMarker() {
        if (!this.map || this.rxMarker || !this.description) return;

        const rx = this.description.receiver || {};
        const gps = rx.gps || {};
        // 0,0 is the unset default, not a station in the Gulf of Guinea
        if (typeof gps.lat !== 'number' || typeof gps.lon !== 'number' ||
            (gps.lat === 0 && gps.lon === 0)) {
            return;
        }

        const ident = rx.callsign || rx.name || 'This receiver';
        const rows = [`<div class="cw-map-popup-call">📡 ${cwGraphEsc(ident)}</div>`];
        if (rx.callsign && rx.name && rx.name !== rx.callsign) {
            rows.push(`<div class="cw-map-popup-row">${cwGraphEsc(rx.name)}</div>`);
        }
        if (rx.location) rows.push(`<div class="cw-map-popup-row">${cwGraphEsc(rx.location)}</div>`);
        if (gps.maidenhead) rows.push(`<div class="cw-map-popup-row">${cwGraphEsc(gps.maidenhead)}</div>`);
        if (rx.antenna) rows.push(`<div class="cw-map-popup-row">Antenna: ${cwGraphEsc(rx.antenna)}</div>`);

        this.rxMarker = L.marker([gps.lat, gps.lon], {
            icon: L.divIcon({
                className: '',
                html: '<div class="cw-map-rx-marker">📡</div>',
                iconSize: [22, 22],
                iconAnchor: [11, 11]
            }),
            zIndexOffset: 1000 // always on top of the spot markers
        });

        const content = rows.join('');
        this.rxMarker.bindTooltip(content, { direction: 'top', offset: [0, -12] });
        this.rxMarker.bindPopup(content);
        this.rxMarker.addTo(this.map);

        // Open on the receiver rather than an arbitrary point, so the first view
        // is centred on where the spots are being heard from.
        this.map.setView([gps.lat, gps.lon], 3);
    }

    snrColour(snr) {
        if (snr > 26) return '#28a745';
        if (snr >= 13) return '#ffc107';
        if (snr >= 6) return '#ff8c00';
        return '#dc3545';
    }

    // ──────────────────────────────────────────────────────────────────────────

    updateChart(filtered) {
        if (!this.chart) return;

        // Filter spots (unless updateViews already did it for us)
        if (!filtered) filtered = this.getFilteredSpots();

        // Group by SNR for color coding
        const datasets = this.createDatasets(filtered);

        // Update chart
        this.chart.data.datasets = datasets;
        this.chart.update('none'); // Use 'none' mode for better performance
    }

    getFilteredSpots() {
        const now = new Date();
        const maxAge = this.ageFilter * 60 * 1000; // Convert to milliseconds

        return this.spots.filter(spot => {
            // Age filter
            if (this.ageFilter && (now - spot.timestamp) > maxAge) {
                return false;
            }

            // Band filter
            if (this.bandFilter && this.bandFilter !== 'all' && spot.band !== this.bandFilter) {
                return false;
            }

            // SNR filter
            if (this.snrFilter > -999 && spot.snr < this.snrFilter) {
                return false;
            }

            return true;
        });
    }
    
    createDatasets(spots) {
        // Group spots by SNR range for color coding
        const groups = {
            excellent: { label: 'Excellent (>26dB)', color: '#28a745', data: [] },
            good: { label: 'Good (13-26dB)', color: '#ffc107', data: [] },
            fair: { label: 'Fair (6-12dB)', color: '#ff8c00', data: [] },
            weak: { label: 'Weak (<6dB)', color: '#dc3545', data: [] }
        };
        
        spots.forEach(spot => {
            const point = {
                x: spot.timestamp,
                y: spot.frequency / 1e6, // Convert to MHz
                spot: spot
            };
            
            if (spot.snr > 26) {
                groups.excellent.data.push(point);
            } else if (spot.snr >= 13) {
                groups.good.data.push(point);
            } else if (spot.snr >= 6) {
                groups.fair.data.push(point);
            } else {
                groups.weak.data.push(point);
            }
        });
        
        return Object.values(groups).map(group => ({
            label: group.label,
            data: group.data,
            backgroundColor: group.color,
            borderColor: group.color,
            pointRadius: 4,
            pointHoverRadius: 6,
            pointHitRadius: 8
        }));
    }
    
    tuneToSpot(spot) {
        // Send message to parent window to tune the receiver (hover or auto-tune — no lookup)
        if (window.opener && !window.opener.closed) {
            window.opener.postMessage({
                type: 'tune_to_spot',
                spot: spot
            }, '*');
            console.log('CW Spots Graph: Tuning to', spot.dx_call, 'on', (spot.frequency / 1e6).toFixed(3), 'MHz');
        } else {
            console.warn('CW Spots Graph: Cannot tune - parent window not available');
        }
    }

    tuneToSpotClick(spot) {
        // Send message to parent window to tune the receiver
        // If Lookup checkbox is checked, also update the lookup popup.
        // Pre-set _lastAutoLookupCallsign so that the frequency_changed event
        // triggered by this tune does not fire a second lookup for the same callsign.
        if (this.autoLookup) {
            this._lastAutoLookupCallsign = spot.dx_call;
        }
        if (window.opener && !window.opener.closed) {
            const type = this.autoLookup ? 'tune_to_spot_click' : 'tune_to_spot';
            window.opener.postMessage({ type, spot }, '*');
            console.log('CW Spots Graph: Click-tuning to', spot.dx_call, 'on', (spot.frequency / 1e6).toFixed(3), 'MHz', this.autoLookup ? '(+lookup)' : '');
        } else {
            console.warn('CW Spots Graph: Cannot tune - parent window not available');
        }
    }
    
    updateLatestSpotForBand() {
        const latestSpotEl = document.getElementById('latest-spot');
        if (!latestSpotEl) return;

        // Find the most recent spot that passes the current band filter
        const filtered = this.getFilteredSpots();

        if (filtered.length === 0) {
            // No spots match — clear the banner
            latestSpotEl.textContent = 'No spots yet';
            latestSpotEl.className = 'latest-spot no-spot';
            latestSpotEl.style.cursor = 'default';
            latestSpotEl.onclick = null;
            delete latestSpotEl.dataset.spot;
            return;
        }

        // Spots are stored newest-first; getFilteredSpots preserves that order
        const mostRecent = filtered[0];
        this.updateLatestSpot(mostRecent);
    }

    updateLatestSpot(spot) {
        const latestSpotEl = document.getElementById('latest-spot');
        if (!latestSpotEl) return;

        // Determine SNR class
        let snrClass = 'snr-weak';
        if (spot.snr > 26) {
            snrClass = 'snr-excellent';
        } else if (spot.snr >= 13) {
            snrClass = 'snr-good';
        } else if (spot.snr >= 6) {
            snrClass = 'snr-fair';
        }

        // Format display text
        const flag = cwGraphIso2ToFlag(spot.country_code);
        const callsign = spot.dx_call || 'Unknown';
        const frequency = (spot.frequency / 1e6).toFixed(4);
        const wpm = spot.wpm || 'N/A';
        const country = spot.country || '';
        const countryText = country ? ` • ${country}` : '';

        latestSpotEl.textContent = `${flag}${callsign} • ${frequency} MHz • ${wpm} WPM${countryText}`;
        latestSpotEl.className = `latest-spot ${snrClass}`;
        latestSpotEl.style.cursor = 'pointer';

        // Store spot data for click handler
        latestSpotEl.dataset.spot = JSON.stringify(spot);

        // Add click handler if not already added
        if (!latestSpotEl.onclick) {
            latestSpotEl.onclick = () => {
                const spotData = JSON.parse(latestSpotEl.dataset.spot);
                this.tuneToSpotClick(spotData);
            };
        }
    }

    updateUI() {
        // Update spot count
        const filtered = this.getFilteredSpots();
        const countEl = document.getElementById('spot-count');
        if (countEl) {
            countEl.textContent = `${filtered.length} spot${filtered.length !== 1 ? 's' : ''}`;
        }
        
        // Update last spot time
        const lastSpotEl = document.getElementById('last-spot-time');
        if (lastSpotEl && this.lastSpotTime) {
            const age = Math.floor((new Date() - this.lastSpotTime) / 1000);
            if (age < 60) {
                lastSpotEl.textContent = `Last: ${age}s ago`;
            } else if (age < 3600) {
                lastSpotEl.textContent = `Last: ${Math.floor(age / 60)}m ago`;
            } else {
                lastSpotEl.textContent = `Last: ${Math.floor(age / 3600)}h ago`;
            }
        } else if (lastSpotEl) {
            lastSpotEl.textContent = '';
        }
    }
    
    updateStatus(status) {
        const statusEl = document.getElementById('status-indicator');
        if (!statusEl) return;
        
        statusEl.className = 'status-badge';
        
        switch (status) {
            case 'connected':
                statusEl.classList.add('status-connected');
                statusEl.textContent = 'Connected';
                break;
            case 'disconnected':
                statusEl.classList.add('status-disconnected');
                statusEl.textContent = 'Disconnected';
                break;
            default:
                statusEl.classList.add('status-waiting');
                statusEl.textContent = 'Waiting';
        }
    }

    // ── CW Decoder (relay from parent window) ────────────────────────────────

    setupDecoderHandlers() {
        const startBtn    = document.getElementById('cw-decoder-start-btn');
        const clearBtn    = document.getElementById('cw-decoder-clear-btn');
        const copyBtn     = document.getElementById('cw-decoder-copy-btn');
        const toggleBtn   = document.getElementById('cw-decoder-toggle-btn');
        const qualitySel  = document.getElementById('cw-decoder-min-quality');

        if (startBtn)   startBtn.addEventListener('click',  () => this._morseToggle());
        if (clearBtn)   clearBtn.addEventListener('click',  () => this._morseClear());
        if (copyBtn)    copyBtn.addEventListener('click',   () => this._morseCopy());
        if (toggleBtn)  toggleBtn.addEventListener('click', () => this._morseToggleCollapse());
        if (qualitySel) qualitySel.addEventListener('change', (e) => {
            this.morseMinQuality = e.target.value;
        });
    }

    _morseToggle() {
        if (this.morseRunning) {
            this._morseStop();
        } else {
            this._morseStart();
        }
    }

    _morseStart() {
        if (!window.opener || window.opener.closed) {
            this._morseSetStatus('Error: parent window not available', 'error');
            return;
        }
        window.opener.postMessage({ type: 'morse_start' }, '*');
        this.morseRunning = true;
        this._morseSetStatus('Connecting…');
        this._morseUpdateButton();
        // Auto-expand the decoder body when starting
        if (this.morseCollapsed) {
            this.morseCollapsed = false;
            this._morseApplyCollapsedState();
        }
    }

    _morseStop() {
        if (window.opener && !window.opener.closed) {
            window.opener.postMessage({ type: 'morse_stop' }, '*');
        }
        this.morseRunning = false;
        this._morseSetStatus('Stopped');
        this._morseClearStats();
        this._morseUpdateButton();
    }

    _morseUpdateButton() {
        const btn = document.getElementById('cw-decoder-start-btn');
        if (!btn) return;
        if (this.morseRunning) {
            btn.textContent = 'Stop';
            btn.classList.add('running');
        } else {
            btn.textContent = 'Start';
            btn.classList.remove('running');
        }
    }

    // ── Binary frame parsing (mirrors morse/main.js _handleBinary) ────────────

    _morseHandleBinary(buf) {
        const view = new DataView(buf);
        if (buf.byteLength < 1) return;
        const type = view.getUint8(0);
        switch (type) {
            case 0x10: this._morseHandleDecode(view, buf); break;
            case 0x11: this._morseHandleStats(view);       break;
            case 0x12: this._morseHandleBinaryError(view, buf); break;
            default:
                console.warn('[CW Decoder popup] unknown binary message type:', type);
        }
    }

    // 0x10 decode event
    // [type:1][confidence:1][cost:4 f32 BE][pitch:4 f32 BE][speed:4 f32 BE][text_len:4][text]
    _morseHandleDecode(view, buf) {
        if (buf.byteLength < 18) return;
        const confByte = view.getUint8(1);
        const pitch    = view.getFloat32(6,  false);
        const speed    = view.getFloat32(10, false);
        const textLen  = view.getUint32(14,  false);
        if (buf.byteLength < 18 + textLen) return;
        const text     = new TextDecoder().decode(new Uint8Array(buf, 18, textLen));
        const confName = ['high', 'medium', 'low', 'poor'][confByte] ?? 'poor';
        this._morseAppendText(text, confName);
        this._morseUpdateStats(pitch, speed, confName);
    }

    // 0x11 stats event
    // [type:1][pitch:4 f32 BE][speed:4 f32 BE]
    _morseHandleStats(view) {
        if (view.byteLength < 9) return;
        const pitch = view.getFloat32(1, false);
        const speed = view.getFloat32(5, false);
        this._morseUpdateStats(pitch, speed, null);
    }

    // 0x12 binary error event
    // [type:1][msg_len:4][msg]
    _morseHandleBinaryError(view, buf) {
        if (buf.byteLength < 5) return;
        const msgLen = view.getUint32(1, false);
        if (buf.byteLength < 5 + msgLen) return;
        const msg = new TextDecoder().decode(new Uint8Array(buf, 5, msgLen));
        this._morseHandleError(msg);
    }

    _morseHandleError(msg) {
        console.error('[CW Decoder popup] error:', msg);
        this._morseSetStatus('Error: ' + msg, 'error');
        this.morseRunning = false;
        this._morseClearStats();
        this._morseUpdateButton();
    }

    // ── UI helpers ────────────────────────────────────────────────────────────

    _morseAppendText(text, conf) {
        // Quality rank: poor=0, low=1, medium=2, high=3
        const rank = { poor: 0, low: 1, medium: 2, high: 3 };
        const minRank = { all: 0, low: 1, medium: 2, high: 3 }[this.morseMinQuality] ?? 0;
        if ((rank[conf] ?? 0) < minRank) return; // filtered out

        const el = document.getElementById('cw-decoder-text');
        if (!el) return;
        this.morseTextBuffer += text;
        const span = document.createElement('span');
        span.className = 'conf-' + conf;
        span.textContent = text;
        el.appendChild(span);
        // Auto-scroll
        const area = document.getElementById('cw-decoder-output');
        if (area) area.scrollTop = area.scrollHeight;
    }

    _morseUpdateStats(pitch, speed, conf) {
        const pitchEl   = document.getElementById('cw-decoder-pitch');
        const speedEl   = document.getElementById('cw-decoder-speed');
        const qualityEl = document.getElementById('cw-decoder-quality');
        if (pitchEl) pitchEl.textContent = pitch != null ? Math.round(pitch) : '---';
        if (speedEl) speedEl.textContent = speed != null ? speed.toFixed(1)  : '---';
        if (qualityEl && conf != null) {
            const labels = { high: 'High', medium: 'Medium', low: 'Low', poor: 'Poor' };
            qualityEl.textContent = labels[conf] ?? conf;
        }
    }

    _morseClearStats() {
        const pitchEl   = document.getElementById('cw-decoder-pitch');
        const speedEl   = document.getElementById('cw-decoder-speed');
        const qualityEl = document.getElementById('cw-decoder-quality');
        if (pitchEl)   pitchEl.textContent   = '---';
        if (speedEl)   speedEl.textContent   = '---';
        if (qualityEl) qualityEl.textContent = '---';
    }

    _morseSetStatus(text, cls) {
        const el = document.getElementById('cw-decoder-status');
        if (!el) return;
        el.textContent = text;
        el.className = cls || '';
    }

    _morseClear() {
        this.morseTextBuffer = '';
        const el = document.getElementById('cw-decoder-text');
        if (el) el.innerHTML = '';
    }

    _morseCopy() {
        if (!this.morseTextBuffer) return;
        navigator.clipboard.writeText(this.morseTextBuffer).then(() => {
            this._morseSetStatus('Copied to clipboard', 'ok');
            setTimeout(() => {
                this._morseSetStatus(
                    this.morseRunning ? 'Running — listening for CW…' : 'Stopped'
                );
            }, 2000);
        }).catch(err => {
            console.error('[CW Decoder popup] copy failed:', err);
        });
    }

    _morseToggleCollapse() {
        this.morseCollapsed = !this.morseCollapsed;
        this._morseApplyCollapsedState();
    }

    _morseApplyCollapsedState() {
        const body      = document.getElementById('cw-decoder-body');
        const toggleBtn = document.getElementById('cw-decoder-toggle-btn');
        if (body)      body.classList.toggle('collapsed', this.morseCollapsed);
        if (toggleBtn) {
            toggleBtn.classList.toggle('collapsed', this.morseCollapsed);
            toggleBtn.title = this.morseCollapsed ? 'Expand decoder' : 'Collapse decoder';
        }
    }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.cwSpotsGraph = new CWSpotsGraph();
    });
} else {
    window.cwSpotsGraph = new CWSpotsGraph();
}

// Update UI periodically
setInterval(() => {
    if (window.cwSpotsGraph) {
        window.cwSpotsGraph.updateUI();
        // The map has no time axis of its own, so ageing spots would linger
        // until the next spot arrived. Re-diff the markers every second so they
        // drop off exactly when the age filter says they should.
        if (window.cwSpotsGraph.view === 'map') {
            window.cwSpotsGraph.updateViews();
        }
    }
}, 1000);

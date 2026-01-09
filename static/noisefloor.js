// Noise Floor Monitor JavaScript
// Handles data fetching, visualization, and user interactions

class NoiseFloorMonitor {
    constructor() {
        // Generate session ID for audio preview (only used when preview is active)
        this.userSessionID = this.generateUserSessionID();
        
        this.trendChart = null;
        this.dynamicRangeChart = null;
        this.ft8SnrChart = null;
        this.bandStateChart = null;
        this.wideBandChart = null; // Wide-band spectrum chart (0-30 MHz)
        this.refreshInterval = null;
        this.fftRefreshInterval = null;
        this.currentDate = 'live';
        this.currentBand = 'all';
        this.compactView = true;
        this.savedCompactView = true; // Save compact view state when switching to single band
        this.historicalDataCache = {}; // Cache historical data to avoid redundant API calls
        this.sparklineCharts = {}; // Store sparkline chart references by band
        this.fftCharts = {}; // Store FFT chart references by band
        this.wasHistorical = false; // Track if we were viewing historical data
        
        // Wideband zoom controls
        this.widebandFrequency = 15; // MHz (center frequency)
        this.widebandWidth = 30000; // kHz (total width)

        // Comparison dates for historical single-band view
        this.comparisonDates = {
            trend: null,
            dynamicRange: null,
            ft8Snr: null,
            bandState: null
        };
        this.availableDates = []; // Store available dates for date picker
        this.datePicker = null; // Main date picker instance
        this.comparisonPickers = {}; // Comparison date pickers by chart type

        // Audio preview
        this.audioPreview = null;
        this.audioPreviewEnabled = false;
        this.audioPreviewFrequency = null; // Current tuned audio frequency
        this.audioPreviewVisualFrequency = null; // Visual indicator frequency (follows cursor)
        this.currentBandData = null; // Store current band data for audio preview
        this.tuneDebounceTimer = null; // Debounce timer for tune commands
        this.pendingTuneFrequency = null; // Pending frequency for debounced tune

        // Band configurations for spectrum WebSocket
        this.bandConfigs = null; // Will be loaded from /api/noisefloor/config

        // Tableau 10 color palette - designed for maximum distinction
        this.bandColors = {
            '160m': '#4E79A7',  // Blue
            '80m': '#F28E2B',   // Orange
            '60m': '#E15759',   // Red
            '40m': '#76B7B2',   // Cyan
            '30m': '#59A14F',   // Green
            '20m': '#EDC948',   // Yellow
            '17m': '#B07AA1',   // Purple
            '15m': '#FF9DA7',   // Pink
            '12m': '#9C755F',   // Brown
            '10m': '#BAB0AC'    // Gray
        };

        this.init();
        this.loadVersion();
        
        // Expose to window for date picker callbacks
        window.noiseFloorMonitor = this;
    }

    // Generate unique session ID
    generateUserSessionID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    async loadVersion() {
        try {
            const response = await fetch('/api/description');
            if (response.ok) {
                const data = await response.json();

                // Update version in footer
                const versionSpan = document.getElementById('footer-version');
                if (versionSpan && data.version) {
                    versionSpan.textContent = `• v${data.version}`;
                }

                // Update receiver name in subtitle
                const receiverNameEl = document.getElementById('receiver-name');
                if (receiverNameEl) {
                    if (data.receiver && data.receiver.name) {
                        receiverNameEl.textContent = data.receiver.name;
                    } else {
                        receiverNameEl.textContent = 'Noise Floor Monitor';
                    }
                }
            }
        } catch (error) {
            console.error('Error loading version:', error);
            // Set fallback text if fetch fails
            const receiverNameEl = document.getElementById('receiver-name');
            if (receiverNameEl) {
                receiverNameEl.textContent = 'Noise Floor Monitor';
            }
        }
    }

    sortBands(bands) {
        // Sort bands by their numeric value (160m, 80m, 60m, 40m, 30m, 20m, 17m, 15m, 12m, 10m)
        const bandOrder = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];
        return bands.sort((a, b) => {
            const indexA = bandOrder.indexOf(a);
            const indexB = bandOrder.indexOf(b);
            if (indexA === -1) return 1;
            if (indexB === -1) return -1;
            return indexA - indexB;
        });
    }

    init() {
        this.setupEventListeners();
        this.loadAvailableDates();
        this.loadBands();
        this.loadBandConfigs(); // Load band configurations for spectrum WebSocket
        this.loadFromURL();

        // Initialize button text based on default compact view state
        const btn = document.getElementById('viewToggleBtn');
        if (btn) {
            btn.textContent = this.compactView ? '📋 Full View' : '📊 Compact View';
        }

        this.startAutoRefresh();
    }

    setupEventListeners() {
        // Date mode selector (Live vs Historical)
        document.getElementById('dateMode').addEventListener('change', (e) => {
            const mode = e.target.value;
            const datePickerBtn = document.getElementById('datePickerBtn');
            
            if (mode === 'live') {
                datePickerBtn.style.display = 'none';
                this.currentDate = 'live';
                this.updateURL();
                this.cleanup();
                this.loadData();
            } else {
                datePickerBtn.style.display = 'block';
                // Show date picker if no date selected yet
                if (this.currentDate === 'live') {
                    this.openDatePicker();
                }
            }
        });

        // Date picker button
        document.getElementById('datePickerBtn').addEventListener('click', () => {
            this.openDatePicker();
        });

        document.getElementById('bandSelect').addEventListener('change', async (e) => {
            // Stop audio preview when changing bands
            if (this.audioPreview && this.audioPreviewEnabled) {
                // Disconnect spectrum WebSocket first to prevent callbacks to destroyed charts
                this.audioPreview.disconnectSpectrum();
                await this.audioPreview.stopPreview();
                this.audioPreviewEnabled = false;
                this.audioPreviewFrequency = null;
            }

            this.currentBand = e.target.value;
            this.updateURL();
            this.cleanup(); // Clean up before loading new data
            this.loadData();
        });

        document.getElementById('refreshBtn').addEventListener('click', () => {
            this.loadData();
        });

        document.getElementById('allBandsBtn').addEventListener('click', async () => {
            // Stop audio preview when switching to all bands
            if (this.audioPreview && this.audioPreviewEnabled) {
                // Disconnect spectrum WebSocket first
                this.audioPreview.disconnectSpectrum();
                await this.audioPreview.stopPreview();
                this.audioPreviewEnabled = false;
                this.audioPreviewFrequency = null;
            }

            this.currentBand = 'all';
            document.getElementById('bandSelect').value = 'all';
            this.updateURL();
            this.loadData();
        });

        document.getElementById('viewToggleBtn').addEventListener('click', () => {
            this.toggleCompactView();
        });

        // Wideband zoom control event listeners
        const frequencySlider = document.getElementById('wideband-frequency');
        const widthSlider = document.getElementById('wideband-width');
        const frequencyValue = document.getElementById('wideband-frequency-value');
        const widthValue = document.getElementById('wideband-width-value');

        if (frequencySlider) {
            frequencySlider.addEventListener('input', (e) => {
                this.widebandFrequency = parseFloat(e.target.value);
                frequencyValue.textContent = this.widebandFrequency.toFixed(3);
                this.updateWidebandZoom();
            });
        }

        if (widthSlider) {
            widthSlider.addEventListener('input', (e) => {
                this.widebandWidth = parseFloat(e.target.value);
                widthValue.textContent = this.widebandWidth.toFixed(0);
                this.updateWidebandZoom();
            });
        }
    }

    toggleCompactView() {
        // Only allow compact view toggle in "all bands" mode
        if (this.currentBand !== 'all') {
            return;
        }

        this.compactView = !this.compactView;
        const btn = document.getElementById('viewToggleBtn');
        btn.textContent = this.compactView ? '📋 Full View' : '📊 Compact View';

        // Toggle compact-view class on all cards
        const cards = document.querySelectorAll('.card');
        cards.forEach(card => {
            if (this.compactView) {
                card.classList.add('compact-view');
            } else {
                card.classList.remove('compact-view');
            }
        });
    }

    loadFromURL() {
        const params = new URLSearchParams(window.location.search);
        const band = params.get('band');

        if (band && band !== 'all') {
            this.currentBand = band;
            document.getElementById('bandSelect').value = band;
        }

        // Check if there's a date in the URL (for direct links)
        const date = params.get('date');
        if (date && date !== 'live') {
            // Set to historical mode
            document.getElementById('dateMode').value = 'historical';
            document.getElementById('datePickerBtn').style.display = 'block';
            document.getElementById('selectedDateText').textContent = date;
            this.currentDate = date;
        }
    }

    updateURL() {
        const params = new URLSearchParams();
        if (this.currentBand !== 'all') {
            params.set('band', this.currentBand);
        }
        if (this.currentDate !== 'live') {
            params.set('date', this.currentDate);
        }
        const newURL = params.toString() ? `?${params.toString()}` : window.location.pathname;
        window.history.replaceState({}, '', newURL);
    }

    async loadAvailableDates() {
        try {
            const response = await fetch('/api/noisefloor/dates');
            if (!response.ok) {
                throw new Error('Failed to load dates');
            }

            const data = await response.json();
            
            // Store available dates for date picker
            // Backend already excludes today's date (which uses rolling window)
            this.availableDates = data.dates || [];

            // Update date pickers if they exist
            if (this.datePicker) {
                this.datePicker.updateAvailableDates(this.availableDates);
            }
            Object.values(this.comparisonPickers).forEach(picker => {
                if (picker) {
                    picker.updateAvailableDates(this.availableDates.filter(d => d !== this.currentDate));
                }
            });
        } catch (error) {
            console.error('Error loading dates:', error);
        }
    }

    loadBands() {
        const bands = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];
        const select = document.getElementById('bandSelect');

        select.innerHTML = '<option value="all">All Bands</option>';
        bands.forEach(band => {
            const option = document.createElement('option');
            option.value = band;
            option.textContent = band;
            select.appendChild(option);
        });
    }

    async loadBandConfigs() {
        try {
            const response = await fetch('/api/noisefloor/config');
            if (!response.ok) {
                console.warn('Failed to load band configurations');
                return;
            }

            const data = await response.json();
            this.bandConfigs = {};

            // Index by band name for easy lookup
            data.bands.forEach(band => {
                this.bandConfigs[band.name] = band;
            });

            console.log('Band configurations loaded:', this.bandConfigs);
        } catch (error) {
            console.error('Error loading band configurations:', error);
        }
    }

    async loadData() {
        this.setStatus('Loading...', 'info');

        try {
            if (this.currentDate === 'live') {
                await this.loadLiveData();
            } else {
                await this.loadHistoricalData();
            }
            this.setStatus('Data loaded successfully', 'success');
        } catch (error) {
            console.error('Error loading data:', error);
            this.setStatus(`Error: ${error.message}`, 'error');
        }
    }

    async loadLiveData() {
        // Show the live data dashboard when viewing live data
        const liveDataSection = document.getElementById('liveData');
        liveDataSection.style.display = 'block';

        // Remove any comparison dropdowns (live mode never shows comparisons)
        this.removeComparisonDropdowns();

        // Only cleanup when switching from historical to live mode
        if (this.wasHistorical) {
            this.cleanup();
            this.wasHistorical = false;
        }

        const response = await fetch('/api/noisefloor/latest');

        // Handle 204 No Content (no data available yet)
        if (response.status === 204) {
            this.showNoData('Collecting initial data... Please wait a moment and refresh.');
            return;
        }

        if (!response.ok) {
            if (response.status === 503) {
                throw new Error('Noise floor monitoring is not enabled');
            }
            throw new Error('Failed to load live data');
        }

        const data = await response.json();

        if (!data || Object.keys(data).length === 0) {
            this.showNoData('No measurements available yet');
            return;
        }

        // Clear cache for new data load
        this.historicalDataCache = {};
        this.recentDataCache = {};
        this.trendDataCache = {};

        // Load data for all charts
        const today = new Date().toISOString().split('T')[0];
        const bands = this.currentBand === 'all' ? Object.keys(data).sort() : [this.currentBand];

        for (const band of bands) {
            if (data[band]) {
                try {
                    // Load recent data (last hour, all points) for sparklines
                    const recentResponse = await fetch(`/api/noisefloor/recent?band=${band}`);
                    if (recentResponse.ok && recentResponse.status !== 204) {
                        this.recentDataCache[band] = await recentResponse.json();
                    } else if (recentResponse.status === 204) {
                        this.recentDataCache[band] = []; // No data available yet
                    }

                    // Load trend data (24 hours, 10-min averages) for trend charts
                    const trendResponse = await fetch(`/api/noisefloor/trend?date=${today}&band=${band}`);
                    if (trendResponse.ok && trendResponse.status !== 204) {
                        this.trendDataCache[band] = await trendResponse.json();
                    } else if (trendResponse.status === 204) {
                        this.trendDataCache[band] = []; // No data available yet
                    }
                } catch (error) {
                    console.error(`Error loading data for ${band}:`, error);
                }
            }
        }

        // Load wide-band spectrum (only in "all bands" view)
        if (this.currentBand === 'all') {
            await this.createWideBandSpectrum('wideband-fft');
        }

        this.displayLiveData(data);
        await this.updateTrendChart(data);
        await this.updateDynamicRangeChart(data);
        await this.updateFT8SnrChart(data);
        await this.updateBandStateChart(data);
    }

    async loadHistoricalData() {
        // Hide the live data dashboard when viewing historical data
        const liveDataSection = document.getElementById('liveData');
        liveDataSection.style.display = 'none';

        // Mark that we're viewing historical data
        this.wasHistorical = true;

        // Remove comparison controls if switching to all bands view
        if (this.currentBand === 'all') {
            this.removeComparisonDropdowns();
        }

        // Use trend endpoint for 10-minute averaged data, just like live mode
        const url = `/api/noisefloor/trend?date=${this.currentDate}${this.currentBand !== 'all' ? '&band=' + this.currentBand : ''}`;
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error('Failed to load historical data');
        }

        const data = await response.json();

        if (!data || data.length === 0) {
            this.showNoData();
            return;
        }

        this.displayHistoricalData(data);
        await this.updateTrendChartHistorical(data);
        await this.updateDynamicRangeChartHistorical(data);
        await this.updateFT8SnrChartHistorical(data);
        await this.updateBandStateChartHistorical(data);
    }

    async updateTrendChartHistorical(data, comparisonData = null, comparisonDate = null) {
        // Only normalize timestamps when doing a comparison
        // Otherwise use actual timestamps for proper time display
        const shouldNormalize = comparisonData && comparisonDate;
        const referenceDate = shouldNormalize ? new Date(this.currentDate + 'T00:00:00') : null;
        
        // Group primary data by band
        const bandData = {};
        data.forEach(m => {
            if (!bandData[m.band]) {
                bandData[m.band] = [];
            }
            
            let timestamp;
            if (shouldNormalize) {
                // Extract time-of-day and apply to reference date for comparison overlay
                const ts = new Date(m.timestamp);
                const normalizedTime = new Date(referenceDate);
                normalizedTime.setHours(ts.getHours(), ts.getMinutes(), ts.getSeconds(), ts.getMilliseconds());
                timestamp = normalizedTime;
            } else {
                // Use actual timestamp for normal display
                timestamp = new Date(m.timestamp);
            }
            
            bandData[m.band].push({
                x: timestamp,
                y: m.p5_db
            });
        });

        const bands = this.sortBands(Object.keys(bandData));
        const datasets = bands.map(band => ({
            label: `${band} (${this.currentDate})`,
            data: bandData[band],
            borderColor: this.bandColors[band] || '#999',
            backgroundColor: this.bandColors[band] || '#999',
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 5,
            tension: 0.4
            // Solid line for primary date (no borderDash)
        }));

        // Add comparison data if provided
        if (comparisonData && comparisonDate) {
            const comparisonBandData = {};
            comparisonData.forEach(m => {
                if (!comparisonBandData[m.band]) {
                    comparisonBandData[m.band] = [];
                }
                // Extract time-of-day and apply to same reference date for alignment
                const ts = new Date(m.timestamp);
                const normalizedTime = new Date(referenceDate);
                normalizedTime.setHours(ts.getHours(), ts.getMinutes(), ts.getSeconds(), ts.getMilliseconds());
                
                comparisonBandData[m.band].push({
                    x: normalizedTime,
                    y: m.p5_db
                });
            });

            bands.forEach(band => {
                if (comparisonBandData[band]) {
                    datasets.push({
                        label: `${band} (${comparisonDate})`,
                        data: comparisonBandData[band],
                        borderColor: this.bandColors[band] || '#999',
                        backgroundColor: this.bandColors[band] || '#999',
                        borderWidth: 2,
                        pointRadius: 0,
                        pointHoverRadius: 5,
                        tension: 0.4,
                        borderDash: [5, 5] // Dashed line for comparison date
                    });
                }
            });
        }

        const ctx = document.getElementById('trendChart');

        if (this.trendChart) {
            this.trendChart.destroy();
        }

        this.trendChart = new Chart(ctx, {
            type: 'line',
            data: { datasets },
            options: {
                animation: false,
                responsive: true,
                maintainAspectRatio: true,
                aspectRatio: 2.5,
                plugins: {
                    title: {
                        display: false
                    },
                    legend: {
                        display: true,
                        labels: { color: '#fff' }
                    },
                    tooltip: {
                        callbacks: {
                            title: (items) => {
                                const date = new Date(items[0].parsed.x);
                                return date.toLocaleString('en-GB', {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    hour12: false
                                });
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            unit: 'hour',
                            displayFormats: {
                                hour: 'HH:mm'
                            }
                        },
                        title: {
                            display: true,
                            text: 'Time',
                            color: '#fff'
                        },
                        ticks: { color: '#fff' },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    },
                    y: {
                        title: {
                            display: true,
                            text: 'Noise Floor (dB)',
                            color: '#fff'
                        },
                        ticks: { color: '#fff' },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    }
                }
            }
        });

        // Add comparison dropdown if in historical single-band view
        const chartContainer = ctx.parentElement;
        this.createComparisonDropdown('trend', chartContainer);
    }

    displayLiveData(data) {
        const dashboard = document.getElementById('dashboard');
        const trendsContainer = document.getElementById('trendsContainer');
        const widebandContainer = document.getElementById('widebandContainer');

        // Filter by selected band if not "all"
        const bands = this.currentBand === 'all'
            ? this.sortBands(Object.keys(data))
            : [this.currentBand];

        // Show/hide wide-band spectrum based on view mode
        if (widebandContainer) {
            widebandContainer.style.display = this.currentBand === 'all' ? 'block' : 'none';
        }

        // Toggle layout classes based on view mode
        if (this.currentBand === 'all') {
            dashboard.classList.remove('single-band');
            // Restore saved compact view state when returning to all bands
            this.compactView = this.savedCompactView;
            const btn = document.getElementById('viewToggleBtn');
            btn.textContent = this.compactView ? '📋 Full View' : '📊 Compact View';
        } else {
            dashboard.classList.add('single-band');
            // Save current compact view state before switching to single band
            this.savedCompactView = this.compactView;
            // Always show full view in single band mode
            this.compactView = false;
            const btn = document.getElementById('viewToggleBtn');
            btn.textContent = '📊 Compact View';
        }

        // Always use two-column layout for trend charts
        trendsContainer.classList.add('two-column');

        // Calculate noise floor statistics for color coding
        const noiseFloors = bands.map(band => data[band]?.p5_db).filter(v => v !== undefined);
        const noiseFloorStats = this.calculateNoiseFloorStats(noiseFloors);

        // Check if we need to recreate cards (band selection changed or switching from historical)
        const existingBands = Array.from(dashboard.querySelectorAll('[data-band]')).map(card =>
            card.dataset.band
        );
        const needsRecreate = JSON.stringify(existingBands) !== JSON.stringify(bands) ||
                              dashboard.children.length === 0 || // Force recreate if dashboard is empty
                              Object.keys(this.sparklineCharts).length === 0; // Force recreate if no charts exist

        if (needsRecreate) {
            // Clean up old charts before recreating
            this.cleanupBandCharts(existingBands);
            dashboard.innerHTML = '';

            bands.forEach(band => {
                if (!data[band]) return;

                const measurement = data[band];
                const card = this.createBandCard(band, measurement, noiseFloorStats);
                dashboard.appendChild(card);
            });

            // Reapply compact view if it was enabled
            if (this.compactView) {
                const cards = document.querySelectorAll('.card');
                cards.forEach(card => card.classList.add('compact-view'));
            }
        } else {
            // Just update existing card data (no flicker)
            bands.forEach(band => {
                if (!data[band]) return;
                this.updateBandCard(band, data[band], noiseFloorStats);
                // Also update sparkline charts with new data
                this.createSparkline(`sparkline-${band}`, band);
            });
        }
    }

    calculateNoiseFloorStats(values) {
        if (values.length === 0) return { median: 0, q1: 0, q3: 0 };

        const sorted = [...values].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const q1 = sorted[Math.floor(sorted.length * 0.25)];
        const q3 = sorted[Math.floor(sorted.length * 0.75)];

        return { median, q1, q3 };
    }

    getNoiseFloorColor(value, stats) {
        // Lower (more negative) is better for noise floor
        // Green: below Q1 (best 25%)
        // Orange: between Q1 and Q3 (middle 50%)
        // Red: above Q3 (worst 25%)

        if (value <= stats.q1) {
            return '#4CAF50'; // Green - good
        } else if (value <= stats.q3) {
            return '#FF9800'; // Orange - average
        } else {
            return '#F44336'; // Red - poor
        }
    }

    createBandCard(band, measurement, noiseFloorStats = null) {
        // In single band view, create three separate cards
        if (this.currentBand !== 'all') {
            return this.createSingleBandCards(band, measurement, noiseFloorStats);
        }

        // Original card for "all bands" view
        const card = document.createElement('div');
        card.className = 'card';
        card.style.cursor = 'pointer';
        card.title = `Click to view ${band} only`;
        card.dataset.band = band;

        const clickHandler = () => {
            if (this.currentBand === 'all') {
                this.currentBand = band;
                document.getElementById('bandSelect').value = band;
                this.updateURL();
                this.cleanup();
                this.loadData();
            }
        };
        card.addEventListener('click', clickHandler);
        card._clickHandler = clickHandler;

        const timestamp = new Date(measurement.timestamp).toLocaleTimeString();
        const sparklineId = `sparkline-${band}`;
        const fftId = `fft-${band}`;

        const noiseFloorColor = noiseFloorStats
            ? this.getNoiseFloorColor(measurement.p5_db, noiseFloorStats)
            : '#4CAF50';

        const ft8SnrHtml = measurement.ft8_snr && measurement.ft8_snr > 0
            ? `<div class="metric">
                <span class="metric-label">FT8 SNR:</span>
                <span class="metric-value ft8-snr">${measurement.ft8_snr.toFixed(1)} dB</span>
            </div>`
            : '';

        card.innerHTML = `
            <h3 style="display: flex; justify-content: space-between; align-items: center;">
                <span>${band}</span>
                <span style="color: ${noiseFloorColor}; font-size: 0.9em;">${measurement.p5_db.toFixed(0)} dB</span>
            </h3>
            <div class="metric">
                <span class="metric-label">Last Update:</span>
                <span class="metric-value">${timestamp}</span>
            </div>
            <div class="metric">
                <span class="metric-label">Noise Floor (P5):</span>
                <span class="metric-value noise-floor">${measurement.p5_db.toFixed(1)} dB</span>
            </div>
            <div class="metric">
                <span class="metric-label">Signal Peak (Max):</span>
                <span class="metric-value signal-peak">${measurement.max_db.toFixed(1)} dB</span>
            </div>
            <div class="metric">
                <span class="metric-label">P95:</span>
                <span class="metric-value">${measurement.p95_db.toFixed(1)} dB</span>
            </div>
            <div class="metric">
                <span class="metric-label">Dynamic Range:</span>
                <span class="metric-value dynamic-range">${measurement.dynamic_range.toFixed(1)} dB</span>
            </div>
            <div class="metric">
                <span class="metric-label">Median:</span>
                <span class="metric-value">${measurement.median_db.toFixed(1)} dB</span>
            </div>
            <div class="metric">
                <span class="metric-label">Band Occupancy:</span>
                <span class="metric-value">${measurement.occupancy_pct.toFixed(1)}%</span>
            </div>
            ${ft8SnrHtml}
            <div style="margin-top: 15px; height: 100px;">
                <canvas id="${sparklineId}"></canvas>
            </div>
            <div style="margin-top: 15px; height: 200px;">
                <canvas id="${fftId}"></canvas>
            </div>
        `;

        setTimeout(() => {
            this.createSparkline(sparklineId, band);
            this.createFFTSpectrum(fftId, band);
        }, 0);

        return card;
    }

    createSingleBandCards(band, measurement, noiseFloorStats = null) {
        const container = document.createElement('div');
        container.style.display = 'contents'; // Makes children act as direct grid items
        container.dataset.band = band;

        const timestamp = new Date(measurement.timestamp).toLocaleTimeString();
        const sparklineId = `sparkline-${band}`;
        const fftId = `fft-${band}`;

        const noiseFloorColor = noiseFloorStats
            ? this.getNoiseFloorColor(measurement.p5_db, noiseFloorStats)
            : '#4CAF50';

        const ft8SnrHtml = measurement.ft8_snr && measurement.ft8_snr > 0
            ? `<div class="metric">
                <span class="metric-label">FT8 SNR:</span>
                <span class="metric-value ft8-snr">${measurement.ft8_snr.toFixed(1)} dB</span>
            </div>`
            : '';

        // Card 1: Metrics
        const metricsCard = document.createElement('div');
        metricsCard.className = 'card';
        metricsCard.innerHTML = `
            <h3 style="display: flex; justify-content: space-between; align-items: center;">
                <span>${band} Metrics</span>
                <span style="color: ${noiseFloorColor}; font-size: 0.9em;">${measurement.p5_db.toFixed(0)} dB</span>
            </h3>
            <div class="metric">
                <span class="metric-label">Last Update:</span>
                <span class="metric-value">${timestamp}</span>
            </div>
            <div class="metric">
                <span class="metric-label">Noise Floor (P5):</span>
                <span class="metric-value noise-floor">${measurement.p5_db.toFixed(1)} dB</span>
            </div>
            <div class="metric">
                <span class="metric-label">Signal Peak (Max):</span>
                <span class="metric-value signal-peak">${measurement.max_db.toFixed(1)} dB</span>
            </div>
            <div class="metric">
                <span class="metric-label">P95:</span>
                <span class="metric-value">${measurement.p95_db.toFixed(1)} dB</span>
            </div>
            <div class="metric">
                <span class="metric-label">Dynamic Range:</span>
                <span class="metric-value dynamic-range">${measurement.dynamic_range.toFixed(1)} dB</span>
            </div>
            <div class="metric">
                <span class="metric-label">Median:</span>
                <span class="metric-value">${measurement.median_db.toFixed(1)} dB</span>
            </div>
            <div class="metric">
                <span class="metric-label">Band Occupancy:</span>
                <span class="metric-value">${measurement.occupancy_pct.toFixed(1)}%</span>
            </div>
            ${ft8SnrHtml}
        `;

        // Card 2: Sparkline (1 hour noise floor)
        const sparklineCard = document.createElement('div');
        sparklineCard.className = 'card';
        sparklineCard.style.display = 'flex';
        sparklineCard.style.flexDirection = 'column';
        sparklineCard.innerHTML = `
            <h3>${band} Noise Floor (Last Hour)</h3>
            <div style="margin-top: 15px; flex: 1; min-height: 0;">
                <canvas id="${sparklineId}"></canvas>
            </div>
        `;

        // Card 3: FFT Spectrum with Audio Preview
        const fftCard = document.createElement('div');
        fftCard.className = 'card';
        fftCard.style.gridColumn = '1 / -1'; // Span both columns
        fftCard.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <h3>${band} Real-time Spectrum</h3>
                <button id="audio-preview-btn-${band}" style="padding: 8px 16px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px;">
                    🔊 Audio Preview
                </button>
            </div>
            <div style="margin-top: 15px; height: 300px; position: relative;">
                <canvas id="${fftId}" style="cursor: crosshair;"></canvas>
            </div>
        `;

        container.appendChild(metricsCard);
        container.appendChild(sparklineCard);
        container.appendChild(fftCard);

        setTimeout(() => {
            this.createSparkline(sparklineId, band);
            this.createFFTSpectrum(fftId, band);
            // Setup audio preview after a short delay to ensure chart is stored
            setTimeout(() => {
                this.setupAudioPreview(band, fftId);
            }, 100);
        }, 0);

        return container;
    }

    updateBandCard(band, measurement, noiseFloorStats = null) {
        const timestamp = new Date(measurement.timestamp).toLocaleTimeString();
        const noiseFloorColor = noiseFloorStats
            ? this.getNoiseFloorColor(measurement.p5_db, noiseFloorStats)
            : '#4CAF50';

        // In "all bands" view, find the card with data-band attribute
        // In single band view, find all cards (they're children of a container with data-band)
        let cards;
        if (this.currentBand === 'all') {
            const card = document.querySelector(`.card[data-band="${band}"]`);
            if (!card) return;
            cards = [card];
        } else {
            // In single band view, find the container and get all its card children
            const container = document.querySelector(`[data-band="${band}"]`);
            if (!container) return;
            cards = Array.from(container.querySelectorAll('.card'));
        }

        // Update all cards (in single band view there are 3, in all bands view there's 1)
        cards.forEach(card => {
            // Update h3 spans (noise floor value and color)
            const h3Spans = card.querySelectorAll('h3 span');
            if (h3Spans.length >= 2) {
                h3Spans[1].textContent = `${measurement.p5_db.toFixed(0)} dB`;
                h3Spans[1].style.color = noiseFloorColor;
            }

            // Update metric values
            const metricValues = card.querySelectorAll('.metric-value');
            if (metricValues.length >= 7) {
                metricValues[0].textContent = timestamp;
                metricValues[2].textContent = `${measurement.max_db.toFixed(1)} dB`;
                metricValues[3].textContent = `${measurement.p95_db.toFixed(1)} dB`;
                metricValues[5].textContent = `${measurement.median_db.toFixed(1)} dB`;
                metricValues[6].textContent = `${measurement.occupancy_pct.toFixed(1)}%`;
            }

            const noiseFloorEl = card.querySelector('.noise-floor');
            if (noiseFloorEl) noiseFloorEl.textContent = `${measurement.p5_db.toFixed(1)} dB`;

            const signalPeakEl = card.querySelector('.signal-peak');
            if (signalPeakEl) signalPeakEl.textContent = `${measurement.max_db.toFixed(1)} dB`;

            const dynamicRangeEl = card.querySelector('.dynamic-range');
            if (dynamicRangeEl) dynamicRangeEl.textContent = `${measurement.dynamic_range.toFixed(1)} dB`;

            // Update FT8 SNR if present
            const ft8SnrEl = card.querySelector('.ft8-snr');
            if (ft8SnrEl && measurement.ft8_snr && measurement.ft8_snr > 0) {
                ft8SnrEl.textContent = `${measurement.ft8_snr.toFixed(1)} dB`;
            }
        });
    }

    async createSparkline(canvasId, band) {
        try {
            // Use cached recent data (last hour, all points)
            const recentData = this.recentDataCache[band];

            if (!recentData || recentData.length === 0) {
                return;
            }

            const ctx = document.getElementById(canvasId);
            if (!ctx) return;

            // Check if chart already exists
            const existingChart = this.sparklineCharts[band];
            if (existingChart) {
                // Update existing chart data (no flicker)
                existingChart.data.labels = recentData.map(d => new Date(d.timestamp));
                existingChart.data.datasets[0].data = recentData.map(d => d.p5_db);
                existingChart.update('none');
                return;
            }

            // Create new chart and store reference
            this.sparklineCharts[band] = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: recentData.map(d => new Date(d.timestamp)),
                    datasets: [{
                        label: 'Noise Floor',
                        data: recentData.map(d => d.p5_db),
                        borderColor: this.bandColors[band] || '#4CAF50',
                        backgroundColor: `${this.bandColors[band] || '#4CAF50'}33`,
                        borderWidth: 2,
                        pointRadius: 0,
                        tension: 0.4,
                        fill: true
                    }]
                },
                options: {
                    animation: false,
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        title: {
                            display: true,
                            text: 'Noise Floor (Last Hour)',
                            color: 'rgba(255, 255, 255, 0.9)',
                            font: {
                                size: 11
                            }
                        },
                        legend: {
                            display: false
                        },
                        tooltip: {
                            enabled: true,
                            mode: 'index',
                            intersect: false,
                            callbacks: {
                                title: (items) => {
                                    return new Date(items[0].parsed.x).toLocaleTimeString();
                                },
                                label: (item) => {
                                    return `${item.parsed.y.toFixed(1)} dB`;
                                }
                            }
                        }
                    },
                    scales: {
                        x: {
                            type: 'time',
                            display: true,
                            time: {
                                unit: 'minute',
                                displayFormats: {
                                    minute: 'HH:mm'
                                }
                            },
                            title: {
                                display: true,
                                text: 'Time',
                                color: 'rgba(255, 255, 255, 0.7)',
                                font: {
                                    size: 10
                                }
                            },
                            ticks: {
                                color: 'rgba(255, 255, 255, 0.7)',
                                font: {
                                    size: 9
                                },
                                maxTicksLimit: 6
                            },
                            grid: {
                                color: 'rgba(255, 255, 255, 0.1)'
                            }
                        },
                        y: {
                            display: true,
                            title: {
                                display: true,
                                text: 'Power (dB)',
                                color: 'rgba(255, 255, 255, 0.7)',
                                font: {
                                    size: 10
                                }
                            },
                            ticks: {
                                color: 'rgba(255, 255, 255, 0.7)',
                                font: {
                                    size: 10
                                },
                                callback: (value) => value.toFixed(0)
                            },
                            grid: {
                                color: 'rgba(255, 255, 255, 0.1)'
                            }
                        }
                    },
                    interaction: {
                        intersect: false,
                        mode: 'index'
                    }
                }
            });
        } catch (error) {
            console.error(`Error creating sparkline for ${band}:`, error);
        }
    }

    async createFFTSpectrum(canvasId, band) {
        try {
            // Fetch FFT data for this band
            const response = await fetch(`/api/noisefloor/fft?band=${band}`);

            if (!response.ok) {
                return; // Silently fail if no data
            }

            const fftData = await response.json();

            if (!fftData || !fftData.data || fftData.data.length === 0) {
                return;
            }

            const ctx = document.getElementById(canvasId);
            if (!ctx) return;

            // Check if chart already exists
            const existingChart = this.fftCharts[band];
            if (existingChart) {
                // Update existing chart data (no flicker)
                existingChart.data.datasets[0].data = fftData.data;

                // Update Y-axis scaling
                const dataMin = Math.min(...fftData.data);
                const dataMax = Math.max(...fftData.data);
                const range = dataMax - dataMin;
                const padding = range * 0.05;
                existingChart.options.scales.y.min = Math.floor(dataMin - padding);
                existingChart.options.scales.y.max = Math.ceil(dataMax + padding);

                // Update marker annotations if they exist
                if (fftData.markers && fftData.markers.length > 0) {
                    existingChart.options.plugins.annotation.annotations = this.createMarkerAnnotations(fftData.markers);
                }

                existingChart.update('none');
                return;
            }

            // Calculate frequency for each bin
            const startFreq = fftData.start_freq / 1e6; // Convert to MHz
            const endFreq = fftData.end_freq / 1e6;
            const binWidthMHz = fftData.bin_width / 1e6; // Convert to MHz
            const numBins = fftData.data.length;

            // Create frequency labels
            const frequencies = [];
            for (let i = 0; i < numBins; i++) {
                const freq = startFreq + (i * binWidthMHz); // MHz
                frequencies.push(freq);
            }

            // Calculate actual min/max from data for proper Y-axis scaling
            const dataMin = Math.min(...fftData.data);
            const dataMax = Math.max(...fftData.data);
            const range = dataMax - dataMin;
            const padding = range * 0.05; // 5% padding
            const yMin = Math.floor(dataMin - padding);
            const yMax = Math.ceil(dataMax + padding);

            // Create marker annotations if markers exist
            const annotations = fftData.markers && fftData.markers.length > 0
                ? this.createMarkerAnnotations(fftData.markers)
                : {};

            // Create new chart and store reference
            this.fftCharts[band] = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: frequencies,
                    datasets: [{
                        label: 'Spectrum',
                        data: fftData.data,
                        borderColor: this.bandColors[band] || '#4CAF50',
                        backgroundColor: `${this.bandColors[band] || '#4CAF50'}22`,
                        borderWidth: 1,
                        pointRadius: 0,
                        tension: 0.1,
                        fill: true
                    }]
                },
                options: {
                    animation: false,
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            display: false
                        },
                        title: {
                            display: true,
                            text: 'Real-time Spectrum (10s)',
                            color: 'rgba(255, 255, 255, 0.9)',
                            font: {
                                size: 12
                            }
                        },
                        tooltip: {
                            enabled: true,
                            mode: 'index',
                            intersect: false,
                            callbacks: {
                                title: (items) => {
                                    return `${items[0].parsed.x.toFixed(3)} MHz`;
                                },
                                label: (item) => {
                                    return `${item.parsed.y.toFixed(1)} dB`;
                                }
                            }
                        },
                        annotation: {
                            annotations: annotations
                        }
                    },
                    scales: {
                        x: {
                            type: 'linear',
                            display: true,
                            min: startFreq,
                            max: endFreq,
                            title: {
                                display: true,
                                text: 'Frequency (MHz)',
                                color: 'rgba(255, 255, 255, 0.7)',
                                font: {
                                    size: 10
                                }
                            },
                            ticks: {
                                color: 'rgba(255, 255, 255, 0.7)',
                                font: {
                                    size: 9
                                },
                                callback: (value) => value.toFixed(2)
                            },
                            grid: {
                                color: 'rgba(255, 255, 255, 0.1)'
                            }
                        },
                        y: {
                            type: 'linear',
                            display: true,
                            min: yMin,
                            max: yMax,
                            ticks: {
                                color: 'rgba(255, 255, 255, 0.7)',
                                font: {
                                    size: 9,
                                    family: 'monospace'
                                },
                                callback: (value) => {
                                    // Pad to consistent width (4 chars: -100 to 100)
                                    const str = value.toFixed(0);
                                    return str.padStart(4, ' ');
                                },
                                autoSkip: true,
                                maxTicksLimit: 8
                            },
                            title: {
                                display: true,
                                text: 'Power (dB)',
                                color: 'rgba(255, 255, 255, 0.7)',
                                font: {
                                    size: 10
                                }
                            },
                            grid: {
                                color: 'rgba(255, 255, 255, 0.1)'
                            }
                        }
                    },
                    interaction: {
                        intersect: false,
                        mode: 'index'
                    }
                }
            });
        } catch (error) {
            console.error(`Error creating FFT spectrum for ${band}:`, error);
        }
    }

    async createWideBandSpectrum(canvasId) {
        try {
            // Fetch wide-band FFT data (0-30 MHz)
            const response = await fetch('/api/noisefloor/fft/wideband');

            if (!response.ok) {
                return; // Silently fail if no data
            }

            const fftData = await response.json();

            if (!fftData || !fftData.data || fftData.data.length === 0) {
                return;
            }

            const ctx = document.getElementById(canvasId);
            if (!ctx) return;

            // Calculate frequency labels correctly
            // The FFT is centered, so we need to calculate based on center frequency
            // After unwrapping: data goes from (center - bandwidth/2) to (center + bandwidth/2)
            const numBins = fftData.data.length;
            const binWidthHz = fftData.bin_width;
            const totalBandwidthHz = numBins * binWidthHz;
            
            // Calculate actual start frequency (center - half bandwidth)
            // For 15 MHz center with 30 MHz bandwidth: start = 0 MHz, end = 30 MHz
            const centerFreqHz = 15000000; // 15 MHz (from backend config)
            const startFreqHz = centerFreqHz - (totalBandwidthHz / 2);
            const startFreqMHz = startFreqHz / 1e6;
            const binWidthMHz = binWidthHz / 1e6;

            // Create frequency labels in MHz
            const frequencies = [];
            for (let i = 0; i < numBins; i++) {
                const freqMHz = startFreqMHz + (i * binWidthMHz);
                frequencies.push(freqMHz);
            }

            // Calculate Y-axis range from actual data with small padding
            // Only use data from valid frequency range (0-30 MHz) to exclude FFT artifacts
            const validIndices = [];
            const validValues = [];
            for (let i = 0; i < frequencies.length; i++) {
                if (frequencies[i] >= 0 && frequencies[i] <= 30) {
                    validIndices.push(i);
                    validValues.push(fftData.data[i]);
                }
            }
            
            // Find min and max with their frequencies
            let dataMin = Infinity;
            let dataMax = -Infinity;
            let minFreqMHz = 0;
            let maxFreqMHz = 0;
            
            for (let i = 0; i < validIndices.length; i++) {
                const idx = validIndices[i];
                const value = validValues[i];
                if (value < dataMin) {
                    dataMin = value;
                    minFreqMHz = frequencies[idx];
                }
                if (value > dataMax) {
                    dataMax = value;
                    maxFreqMHz = frequencies[idx];
                }
            }
            
            // Calculate P5 (noise floor estimate)
            const sortedValues = [...validValues].sort((a, b) => a - b);
            const p5 = sortedValues[Math.floor(sortedValues.length * 0.05)];
            
            const range = dataMax - dataMin;
            const dynamicRange = dataMax - p5;
            const padding = Math.max(2, range * 0.05); // At least 2 dB padding, or 5% of range
            const yMin = dataMin - padding;
            const yMax = dataMax + padding;

            // Update statistics display with frequencies
            document.getElementById('wideband-min').textContent = `${dataMin.toFixed(1)} dB @ ${minFreqMHz.toFixed(3)} MHz`;
            document.getElementById('wideband-max').textContent = `${dataMax.toFixed(1)} dB @ ${maxFreqMHz.toFixed(3)} MHz`;
            document.getElementById('wideband-p5').textContent = `${p5.toFixed(1)} dB`;
            document.getElementById('wideband-range').textContent = `${dynamicRange.toFixed(1)} dB`;

            console.log(`Wide-band spectrum Y-axis: min=${dataMin.toFixed(1)} dB, max=${dataMax.toFixed(1)} dB, P5=${p5.toFixed(1)} dB, range=${range.toFixed(1)} dB, yMin=${yMin.toFixed(1)}, yMax=${yMax.toFixed(1)}`);

            // Check if chart already exists
            if (this.wideBandChart) {
                // Check if Y-axis range changed significantly (>10 dB) - if so, destroy and recreate
                const currentMin = this.wideBandChart.options.scales.y.min;
                const currentMax = this.wideBandChart.options.scales.y.max;
                const minChanged = Math.abs(currentMin - yMin) > 10;
                const maxChanged = Math.abs(currentMax - yMax) > 10;

                if (minChanged || maxChanged) {
                    console.log(`Wide-band Y-axis range changed significantly, recreating chart`);
                    this.wideBandChart.destroy();
                    this.wideBandChart = null;
                    // Fall through to create new chart
                } else {
                    // Update existing chart data (no flicker)
                    this.wideBandChart.data.labels = frequencies;
                    this.wideBandChart.data.datasets[0].data = fftData.data;

                    // Update Y-axis scaling to fit data tightly
                    this.wideBandChart.options.scales.y.min = yMin;
                    this.wideBandChart.options.scales.y.max = yMax;

                    // Update annotations with new min/max/P5 values
                    this.wideBandChart.options.plugins.annotation.annotations = {
                        p5Line: {
                            type: 'line',
                            yMin: p5,
                            yMax: p5,
                            borderColor: 'rgba(76, 175, 80, 0.8)',
                            borderWidth: 2,
                            borderDash: [5, 5],
                            label: {
                                display: true,
                                content: `P5: ${p5.toFixed(1)} dB`,
                                position: 'end',
                                backgroundColor: 'rgba(76, 175, 80, 0.9)',
                                color: '#fff',
                                font: { size: 10, weight: 'bold' },
                                padding: 4
                            }
                        },
                        minLine: {
                            type: 'line',
                            xMin: minFreqMHz,
                            xMax: minFreqMHz,
                            borderColor: 'rgba(33, 150, 243, 0.8)',
                            borderWidth: 2,
                            borderDash: [5, 5],
                            label: {
                                display: true,
                                content: `${minFreqMHz.toFixed(3)} MHz`,
                                position: 'end',
                                backgroundColor: 'rgba(33, 150, 243, 0.9)',
                                color: '#fff',
                                font: { size: 10, weight: 'bold' },
                                padding: 4
                            }
                        },
                        maxLine: {
                            type: 'line',
                            xMin: maxFreqMHz,
                            xMax: maxFreqMHz,
                            borderColor: 'rgba(255, 152, 0, 0.8)',
                            borderWidth: 2,
                            borderDash: [5, 5],
                            label: {
                                display: true,
                                content: `${maxFreqMHz.toFixed(3)} MHz`,
                                position: 'end',
                                backgroundColor: 'rgba(255, 152, 0, 0.9)',
                                color: '#fff',
                                font: { size: 10, weight: 'bold' },
                                padding: 4
                            }
                        }
                    };

                    // Apply zoom after update
                    this.applyWidebandZoomToChart();
                    return;
                }
           }

           // Create annotations for min, max, and P5
            const annotations = {
                // P5 horizontal line (noise floor)
                p5Line: {
                    type: 'line',
                    yMin: p5,
                    yMax: p5,
                    borderColor: 'rgba(76, 175, 80, 0.8)', // Green
                    borderWidth: 2,
                    borderDash: [5, 5],
                    label: {
                        display: true,
                        content: `P5: ${p5.toFixed(1)} dB`,
                        position: 'end',
                        backgroundColor: 'rgba(76, 175, 80, 0.9)',
                        color: '#fff',
                        font: {
                            size: 10,
                            weight: 'bold'
                        },
                        padding: 4
                    }
                },
                // Min vertical line
                minLine: {
                    type: 'line',
                    xMin: minFreqMHz,
                    xMax: minFreqMHz,
                    borderColor: 'rgba(33, 150, 243, 0.8)', // Blue
                    borderWidth: 2,
                    borderDash: [5, 5],
                    label: {
                        display: true,
                        content: `${minFreqMHz.toFixed(3)} MHz`,
                        position: 'end',
                        backgroundColor: 'rgba(33, 150, 243, 0.9)',
                        color: '#fff',
                        font: {
                            size: 10,
                            weight: 'bold'
                        },
                        padding: 4
                    }
                },
                // Max vertical line
                maxLine: {
                    type: 'line',
                    xMin: maxFreqMHz,
                    xMax: maxFreqMHz,
                    borderColor: 'rgba(255, 152, 0, 0.8)', // Orange
                    borderWidth: 2,
                    borderDash: [5, 5],
                    label: {
                        display: true,
                        content: `${maxFreqMHz.toFixed(3)} MHz`,
                        position: 'end',
                        backgroundColor: 'rgba(255, 152, 0, 0.9)',
                        color: '#fff',
                        font: {
                            size: 10,
                            weight: 'bold'
                        },
                        padding: 4
                    }
                }
            };

            // Create gradient fill (similar to main spectrum line graph)
            // Gradient from bottom (weak signal) to top (strong signal)
            const gradient = ctx.getContext('2d').createLinearGradient(0, 300, 0, 0);
            // Jet color scheme (blue -> cyan -> yellow -> red) from bottom to top
            gradient.addColorStop(0, 'rgba(0, 0, 143, 0.8)');      // Dark blue (bottom/weak)
            gradient.addColorStop(0.2, 'rgba(0, 0, 255, 0.8)');    // Blue
            gradient.addColorStop(0.4, 'rgba(0, 255, 255, 0.8)');  // Cyan
            gradient.addColorStop(0.6, 'rgba(255, 255, 0, 0.8)');  // Yellow
            gradient.addColorStop(0.8, 'rgba(255, 0, 0, 0.8)');    // Red
            gradient.addColorStop(1, 'rgba(128, 0, 0, 0.8)');      // Dark red (top/strong)

            // Create new chart and store reference
            this.wideBandChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: frequencies,
                    datasets: [{
                        label: 'Full Spectrum',
                        data: fftData.data,
                        borderColor: 'rgba(255, 255, 255, 0)',
                        backgroundColor: gradient,
                        borderWidth: 0,
                        pointRadius: 0,
                        tension: 0.1,
                        fill: 'start'
                    }]
                },
                options: {
                    animation: false,
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            display: false
                        },
                        title: {
                            display: true,
                            text: 'Full HF Spectrum (10s avg)',
                            color: 'rgba(255, 255, 255, 0.9)',
                            font: {
                                size: 12
                            }
                        },
                        tooltip: {
                            enabled: true,
                            mode: 'index',
                            intersect: false,
                            callbacks: {
                                title: (items) => {
                                    return `${items[0].parsed.x.toFixed(3)} MHz`;
                                },
                                label: (item) => {
                                    return `${item.parsed.y.toFixed(1)} dB`;
                                }
                            }
                        },
                        annotation: {
                            annotations: annotations
                        },
                        zoom: {
                            pan: {
                                enabled: false
                            },
                            zoom: {
                                drag: {
                                    enabled: true,
                                    backgroundColor: 'rgba(255, 255, 255, 0.1)',
                                    borderColor: 'rgba(255, 255, 255, 0.5)',
                                    borderWidth: 1
                                },
                                mode: 'x',
                                onZoomComplete: () => {
                                    // Update chart after zoom
                                    if (this.wideBandChart) {
                                        this.wideBandChart.update('none');
                                    }
                                }
                            }
                        }
                    },
                    scales: {
                        x: {
                            type: 'linear',
                            display: true,
                            min: 0,
                            max: 30,
                            title: {
                                display: true,
                                text: 'Frequency (MHz)',
                                color: 'rgba(255, 255, 255, 0.7)',
                                font: {
                                    size: 10
                                }
                            },
                            ticks: {
                                color: 'rgba(255, 255, 255, 0.7)',
                                font: {
                                    size: 9
                                },
                                // Dynamic precision based on zoom level
                                callback: function(value) {
                                    const range = this.max - this.min;
                                    // If zoomed in to < 5 MHz range, show 3 decimals
                                    if (range < 5) {
                                        return value.toFixed(3);
                                    }
                                    // If zoomed to < 15 MHz range, show 2 decimals
                                    else if (range < 15) {
                                        return value.toFixed(2);
                                    }
                                    // Otherwise show 1 decimal for full view
                                    else {
                                        return value.toFixed(1);
                                    }
                                },
                                // Increase number of ticks for better granularity
                                maxTicksLimit: 20,
                                autoSkip: true
                            },
                            grid: {
                                color: 'rgba(255, 255, 255, 0.1)'
                            }
                        },
                        y: {
                            type: 'linear',
                            display: true,
                            min: yMin,
                            max: yMax,
                            ticks: {
                                color: 'rgba(255, 255, 255, 0.7)',
                                font: {
                                    size: 9,
                                    family: 'monospace'
                                },
                                callback: (value) => {
                                    const str = value.toFixed(0);
                                    return str.padStart(4, ' ');
                                },
                                autoSkip: true,
                                maxTicksLimit: 8
                            },
                            title: {
                                display: true,
                                text: 'Power (dB)',
                                color: 'rgba(255, 255, 255, 0.7)',
                                font: {
                                    size: 10
                                }
                            },
                            grid: {
                                color: 'rgba(255, 255, 255, 0.1)'
                            }
                        }
                    },
                    interaction: {
                        intersect: false,
                        mode: 'index'
                    }
                }
            });

            // Add double-click to reset zoom
            ctx.ondblclick = () => {
                if (this.wideBandChart) {
                    this.wideBandChart.resetZoom();
                }
            };

            // Apply initial zoom if not at default (full spectrum)
            this.applyWidebandZoomToChart();
        } catch (error) {
            console.error('Error creating wide-band spectrum:', error);
        }
    }

    updateWidebandZoom() {
        // Update the chart zoom when sliders change
        if (this.wideBandChart) {
            this.applyWidebandZoomToChart();
        }
    }

    applyWidebandZoomToChart() {
        if (!this.wideBandChart) return;

        // Calculate the frequency range based on center frequency and width
        const widthMHz = this.widebandWidth / 1000; // Convert kHz to MHz
        const halfWidth = widthMHz / 2;
        const minFreq = this.widebandFrequency - halfWidth;
        const maxFreq = this.widebandFrequency + halfWidth;

        // Ensure we stay within 0-30 MHz bounds
        const clampedMin = Math.max(0, minFreq);
        const clampedMax = Math.min(30, maxFreq);

        // Update the x-axis range
        this.wideBandChart.options.scales.x.min = clampedMin;
        this.wideBandChart.options.scales.x.max = clampedMax;

        // Add or update the center frequency marker (orange dashed line)
        if (!this.wideBandChart.options.plugins.annotation.annotations) {
            this.wideBandChart.options.plugins.annotation.annotations = {};
        }

        // Add center frequency marker
        this.wideBandChart.options.plugins.annotation.annotations.centerFreq = {
            type: 'line',
            xMin: this.widebandFrequency,
            xMax: this.widebandFrequency,
            borderColor: 'rgba(255, 152, 0, 0.9)', // Orange
            borderWidth: 2,
            borderDash: [5, 5],
            label: {
                display: true,
                content: `${this.widebandFrequency.toFixed(3)} MHz`,
                position: 'end',
                backgroundColor: 'rgba(255, 152, 0, 0.9)',
                color: '#fff',
                font: {
                    size: 11,
                    weight: 'bold'
                },
                padding: 4
            }
        };

        // Update the chart
        this.wideBandChart.update('none');
    }

    displayHistoricalData(data) {
        // Group by band
        const bandData = {};
        data.forEach(m => {
            if (!bandData[m.band]) {
                bandData[m.band] = [];
            }
            bandData[m.band].push(m);
        });

        // Display latest measurement for each band
        const dashboard = document.getElementById('dashboard');
        dashboard.innerHTML = '';

        this.sortBands(Object.keys(bandData)).forEach(band => {
            const measurements = bandData[band];
            const latest = measurements[measurements.length - 1];
            const card = this.createBandCard(band, latest);
            dashboard.appendChild(card);
        });

        // Reapply compact view if it was enabled
        if (this.compactView) {
            const cards = document.querySelectorAll('.card');
            cards.forEach(card => card.classList.add('compact-view'));
        }
    }

    async updateTrendChart(data) {
        const ctx = document.getElementById('trendChart');

        // Prepare datasets
        const bands = this.currentBand === 'all'
            ? this.sortBands(Object.keys(data))
            : [this.currentBand];

        // Load today's historical data for trend chart
        const today = new Date().toISOString().split('T')[0];
        const datasets = [];

        for (const band of bands) {
            if (!data[band]) continue;

            try {
                // Use cached trend data (24 hours, 10-min averages)
                const trendData = this.trendDataCache[band] || [];

                // If we have trend data, use it; otherwise just show current point
                const dataPoints = trendData.length > 0
                    ? trendData.map(d => ({
                        x: new Date(d.timestamp),
                        y: d.p5_db
                      }))
                    : [{
                        x: new Date(data[band].timestamp),
                        y: data[band].p5_db
                      }];

                datasets.push({
                    label: band,
                    data: dataPoints,
                    borderColor: this.bandColors[band] || '#999',
                    backgroundColor: this.bandColors[band] || '#999',
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    tension: 0.4
                });
            } catch (error) {
                console.error(`Error loading trend data for ${band}:`, error);
                // Fallback to just current point
                datasets.push({
                    label: `${band} Noise Floor`,
                    data: [{
                        x: new Date(data[band].timestamp),
                        y: data[band].p5_db
                    }],
                    borderColor: this.bandColors[band] || '#999',
                    backgroundColor: this.bandColors[band] || '#999',
                    tension: 0.4
                });
            }
        }

        // Update existing chart if it exists, otherwise create new one
        if (this.trendChart) {
            this.trendChart.data.datasets = datasets;
            this.trendChart.update('none');
            return;
        }

        this.trendChart = new Chart(ctx, {
            type: 'line',
            data: { datasets },
            options: {
                animation: false,
                responsive: true,
                maintainAspectRatio: true,
                aspectRatio: 2.5,
                plugins: {
                    title: {
                        display: false
                    },
                    legend: {
                        display: true,
                        labels: { color: '#fff' }
                    },
                    tooltip: {
                        callbacks: {
                            title: (items) => {
                                const date = new Date(items[0].parsed.x);
                                return date.toLocaleString('en-GB', {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    hour12: false
                                });
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            unit: 'hour',
                            displayFormats: {
                                hour: 'HH:mm'
                            }
                        },
                        title: {
                            display: true,
                            text: 'Time',
                            color: '#fff'
                        },
                        ticks: { color: '#fff' },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    },
                    y: {
                        title: {
                            display: true,
                            text: 'Noise Floor (dB)',
                            color: '#fff'
                        },
                        ticks: { color: '#fff' },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    }
                }
            }
        });
    }

    async updateDynamicRangeChart(data) {
        const bands = this.currentBand === 'all'
            ? this.sortBands(Object.keys(data))
            : [this.currentBand];

        const datasets = [];

        for (const band of bands) {
            if (!data[band]) continue;

            try {
                // Use cached trend data (24 hours, 10-min averages)
                const trendData = this.trendDataCache[band] || [];

                const dataPoints = trendData.length > 0
                    ? trendData.map(d => ({
                        x: new Date(d.timestamp),
                        y: d.dynamic_range
                      }))
                    : [{
                        x: new Date(data[band].timestamp),
                        y: data[band].dynamic_range
                      }];

                datasets.push({
                    label: band,
                    data: dataPoints,
                    borderColor: this.bandColors[band] || '#999',
                    backgroundColor: this.bandColors[band] || '#999',
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    tension: 0.4
                });
            } catch (error) {
                console.error(`Error loading dynamic range data for ${band}:`, error);
            }
        }

        const ctx = document.getElementById('dynamicRangeChart');

        // Update existing chart if it exists and canvas is still in DOM, otherwise create new one
        if (this.dynamicRangeChart && ctx && ctx.parentElement) {
            this.dynamicRangeChart.data.datasets = datasets;
            this.dynamicRangeChart.update('none');
            return;
        }

        // Destroy old chart if canvas was removed
        if (this.dynamicRangeChart && (!ctx || !ctx.parentElement)) {
            this.dynamicRangeChart.destroy();
            this.dynamicRangeChart = null;
        }

        if (!ctx) return;

        this.dynamicRangeChart = new Chart(ctx, {
            type: 'line',
            data: { datasets },
            options: {
                animation: false,
                responsive: true,
                maintainAspectRatio: true,
                aspectRatio: 2.5,
                plugins: {
                    title: {
                        display: false
                    },
                    legend: {
                        display: true,
                        labels: { color: '#fff' }
                    },
                    tooltip: {
                        callbacks: {
                            title: (items) => {
                                const date = new Date(items[0].parsed.x);
                                return date.toLocaleString('en-GB', {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    hour12: false
                                });
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            unit: 'hour',
                            displayFormats: {
                                hour: 'HH:mm'
                            }
                        },
                        title: {
                            display: true,
                            text: 'Time',
                            color: '#fff'
                        },
                        ticks: { color: '#fff' },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    },
                    y: {
                        title: {
                            display: true,
                            text: 'Dynamic Range (dB)',
                            color: '#fff'
                        },
                        ticks: { color: '#fff' },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    }
                }
            }
        });
    }

    async updateDynamicRangeChartHistorical(data, comparisonData = null, comparisonDate = null) {
        // Only normalize timestamps when doing a comparison
        // Otherwise use actual timestamps for proper time display
        const shouldNormalize = comparisonData && comparisonDate;
        const referenceDate = shouldNormalize ? new Date(this.currentDate + 'T00:00:00') : null;
        
        // Group primary data by band
        const bandData = {};
        data.forEach(m => {
            if (!bandData[m.band]) {
                bandData[m.band] = [];
            }
            
            let timestamp;
            if (shouldNormalize) {
                // Extract time-of-day and apply to reference date for comparison overlay
                const ts = new Date(m.timestamp);
                const normalizedTime = new Date(referenceDate);
                normalizedTime.setHours(ts.getHours(), ts.getMinutes(), ts.getSeconds(), ts.getMilliseconds());
                timestamp = normalizedTime;
            } else {
                // Use actual timestamp for normal display
                timestamp = new Date(m.timestamp);
            }
            
            bandData[m.band].push({
                x: timestamp,
                y: m.dynamic_range
            });
        });

        const bands = this.sortBands(Object.keys(bandData));
        const datasets = bands.map(band => ({
            label: `${band} (${this.currentDate})`,
            data: bandData[band],
            borderColor: this.bandColors[band] || '#999',
            backgroundColor: this.bandColors[band] || '#999',
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 5,
            tension: 0.4
            // Solid line for primary date (no borderDash)
        }));

        // Add comparison data if provided
        if (comparisonData && comparisonDate) {
            const comparisonBandData = {};
            comparisonData.forEach(m => {
                if (!comparisonBandData[m.band]) {
                    comparisonBandData[m.band] = [];
                }
                // Extract time-of-day and apply to same reference date for alignment
                const ts = new Date(m.timestamp);
                const normalizedTime = new Date(referenceDate);
                normalizedTime.setHours(ts.getHours(), ts.getMinutes(), ts.getSeconds(), ts.getMilliseconds());
                
                comparisonBandData[m.band].push({
                    x: normalizedTime,
                    y: m.dynamic_range
                });
            });

            bands.forEach(band => {
                if (comparisonBandData[band]) {
                    datasets.push({
                        label: `${band} (${comparisonDate})`,
                        data: comparisonBandData[band],
                        borderColor: this.bandColors[band] || '#999',
                        backgroundColor: this.bandColors[band] || '#999',
                        borderWidth: 2,
                        pointRadius: 0,
                        pointHoverRadius: 5,
                        tension: 0.4,
                        borderDash: [5, 5] // Dashed line for comparison date
                    });
                }
            });
        }

        const ctx = document.getElementById('dynamicRangeChart');

        if (this.dynamicRangeChart) {
            this.dynamicRangeChart.destroy();
        }

        this.dynamicRangeChart = new Chart(ctx, {
            type: 'line',
            data: { datasets },
            options: {
                animation: false,
                responsive: true,
                maintainAspectRatio: true,
                aspectRatio: 2.5,
                plugins: {
                    title: {
                        display: false
                    },
                    legend: {
                        display: true,
                        labels: { color: '#fff' }
                    },
                    tooltip: {
                        callbacks: {
                            title: (items) => {
                                const date = new Date(items[0].parsed.x);
                                return date.toLocaleString('en-GB', {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    hour12: false
                                });
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            unit: 'hour',
                            displayFormats: {
                                hour: 'HH:mm'
                            }
                        },
                        title: {
                            display: true,
                            text: 'Time',
                            color: '#fff'
                        },
                        ticks: { color: '#fff' },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    },
                    y: {
                        title: {
                            display: true,
                            text: 'Dynamic Range (dB)',
                            color: '#fff'
                        },
                        ticks: { color: '#fff' },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    }
                }
            }
        });

        // Add comparison dropdown if in historical single-band view
        const chartContainer = ctx.parentElement;
        this.createComparisonDropdown('dynamicRange', chartContainer);
    }

    async updateFT8SnrChart(data) {
        const bands = this.currentBand === 'all'
            ? this.sortBands(Object.keys(data))
            : [this.currentBand];

        const datasets = [];

        for (const band of bands) {
            if (!data[band]) continue;

            try {
                // Use cached trend data (24 hours, 10-min averages)
                const trendData = this.trendDataCache[band] || [];

                // Filter out bands with no FT8 frequency configured (ft8_snr = 0)
                const hasValidFT8Data = trendData.some(d => d.ft8_snr && d.ft8_snr > 0);
                if (!hasValidFT8Data && (!data[band].ft8_snr || data[band].ft8_snr <= 0)) {
                    continue; // Skip bands without FT8 configured
                }

                const dataPoints = trendData.length > 0
                    ? trendData.map(d => ({
                        x: new Date(d.timestamp),
                        y: d.ft8_snr || 0
                      }))
                    : [{
                        x: new Date(data[band].timestamp),
                        y: data[band].ft8_snr || 0
                      }];

                datasets.push({
                    label: band,
                    data: dataPoints,
                    borderColor: this.bandColors[band] || '#999',
                    backgroundColor: this.bandColors[band] || '#999',
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    tension: 0.4
                });
            } catch (error) {
                console.error(`Error loading FT8 SNR data for ${band}:`, error);
            }
        }

        const ctx = document.getElementById('ft8SnrChart');
        if (!ctx) return;

        // Only create/update chart if we have data
        if (datasets.length === 0) {
            if (this.ft8SnrChart) {
                this.ft8SnrChart.destroy();
                this.ft8SnrChart = null;
            }
            if (ctx.parentElement) {
                ctx.parentElement.style.display = 'none';
            }
            return;
        } else {
            if (ctx.parentElement) {
                ctx.parentElement.style.display = 'block';
            }
        }

        // Update existing chart if it exists and canvas is still in DOM, otherwise create new one
        if (this.ft8SnrChart && ctx && ctx.parentElement) {
            this.ft8SnrChart.data.datasets = datasets;
            this.ft8SnrChart.update('none');
            return;
        }

        // Destroy old chart if canvas was removed
        if (this.ft8SnrChart && (!ctx || !ctx.parentElement)) {
            this.ft8SnrChart.destroy();
            this.ft8SnrChart = null;
        }

        this.ft8SnrChart = new Chart(ctx, {
            type: 'line',
            data: { datasets },
            options: {
                animation: false,
                responsive: true,
                maintainAspectRatio: true,
                aspectRatio: 2.5,
                plugins: {
                    title: {
                        display: false
                    },
                    legend: {
                        display: true,
                        labels: { color: '#fff' }
                    },
                    tooltip: {
                        callbacks: {
                            title: (items) => {
                                const date = new Date(items[0].parsed.x);
                                return date.toLocaleString('en-GB', {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    hour12: false
                                });
                            },
                            label: (item) => {
                                return `${item.dataset.label}: ${item.parsed.y.toFixed(1)} dB`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            unit: 'hour',
                            displayFormats: {
                                hour: 'HH:mm'
                            }
                        },
                        title: {
                            display: true,
                            text: 'Time',
                            color: '#fff'
                        },
                        ticks: { color: '#fff' },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    },
                    y: {
                        title: {
                            display: true,
                            text: 'FT8 SNR (dB)',
                            color: '#fff'
                        },
                        ticks: { color: '#fff' },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    }
                }
            }
        });
    }

    async updateFT8SnrChartHistorical(data, comparisonData = null, comparisonDate = null) {
        // Only normalize timestamps when doing a comparison
        // Otherwise use actual timestamps for proper time display
        const shouldNormalize = comparisonData && comparisonDate;
        const referenceDate = shouldNormalize ? new Date(this.currentDate + 'T00:00:00') : null;
        
        // Group primary data by band
        const bandData = {};
        data.forEach(m => {
            // Only include bands with FT8 data
            if (m.ft8_snr && m.ft8_snr > 0) {
                if (!bandData[m.band]) {
                    bandData[m.band] = [];
                }
                
                let timestamp;
                if (shouldNormalize) {
                    // Extract time-of-day and apply to reference date for comparison overlay
                    const ts = new Date(m.timestamp);
                    const normalizedTime = new Date(referenceDate);
                    normalizedTime.setHours(ts.getHours(), ts.getMinutes(), ts.getSeconds(), ts.getMilliseconds());
                    timestamp = normalizedTime;
                } else {
                    // Use actual timestamp for normal display
                    timestamp = new Date(m.timestamp);
                }
                
                bandData[m.band].push({
                    x: timestamp,
                    y: m.ft8_snr
                });
            }
        });

        const bands = this.sortBands(Object.keys(bandData));
        const datasets = bands.map(band => ({
            label: `${band} (${this.currentDate})`,
            data: bandData[band],
            borderColor: this.bandColors[band] || '#999',
            backgroundColor: this.bandColors[band] || '#999',
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 5,
            tension: 0.4
            // Solid line for primary date (no borderDash)
        }));

        // Add comparison data if provided
        if (comparisonData && comparisonDate) {
            const comparisonBandData = {};
            comparisonData.forEach(m => {
                if (m.ft8_snr && m.ft8_snr > 0) {
                    if (!comparisonBandData[m.band]) {
                        comparisonBandData[m.band] = [];
                    }
                    // Extract time-of-day and apply to same reference date for alignment
                    const ts = new Date(m.timestamp);
                    const normalizedTime = new Date(referenceDate);
                    normalizedTime.setHours(ts.getHours(), ts.getMinutes(), ts.getSeconds(), ts.getMilliseconds());
                    
                    comparisonBandData[m.band].push({
                        x: normalizedTime,
                        y: m.ft8_snr
                    });
                }
            });

            bands.forEach(band => {
                if (comparisonBandData[band]) {
                    datasets.push({
                        label: `${band} (${comparisonDate})`,
                        data: comparisonBandData[band],
                        borderColor: this.bandColors[band] || '#999',
                        backgroundColor: this.bandColors[band] || '#999',
                        borderWidth: 2,
                        pointRadius: 0,
                        pointHoverRadius: 5,
                        tension: 0.4,
                        borderDash: [5, 5] // Dashed line for comparison date
                    });
                }
            });
        }

        const ctx = document.getElementById('ft8SnrChart');

        if (this.ft8SnrChart) {
            this.ft8SnrChart.destroy();
        }

        // Only create chart if we have data
        if (datasets.length === 0) {
            ctx.parentElement.style.display = 'none';
            return;
        } else {
            ctx.parentElement.style.display = 'block';
        }

        this.ft8SnrChart = new Chart(ctx, {
            type: 'line',
            data: { datasets },
            options: {
                animation: false,
                responsive: true,
                maintainAspectRatio: true,
                aspectRatio: 2.5,
                plugins: {
                    title: {
                        display: false
                    },
                    legend: {
                        display: true,
                        labels: { color: '#fff' }
                    },
                    tooltip: {
                        callbacks: {
                            title: (items) => {
                                const date = new Date(items[0].parsed.x);
                                return date.toLocaleString('en-GB', {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    hour12: false
                                });
                            },
                            label: (item) => {
                                return `${item.dataset.label}: ${item.parsed.y.toFixed(1)} dB`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            unit: 'hour',
                            displayFormats: {
                                hour: 'HH:mm'
                            }
                        },
                        title: {
                            display: true,
                            text: 'Time',
                            color: '#fff'
                        },
                        ticks: { color: '#fff' },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    },
                    y: {
                        title: {
                            display: true,
                            text: 'FT8 SNR (dB)',
                            color: '#fff'
                        },
                        ticks: { color: '#fff' },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    }
                }
            }
        });

        // Add comparison dropdown if in historical single-band view
        const chartContainer = ctx.parentElement;
        this.createComparisonDropdown('ft8Snr', chartContainer);
    }

    async updateBandStateChart(data) {
        const bands = this.currentBand === 'all'
            ? this.sortBands(Object.keys(data))
            : [this.currentBand];

        // Prepare data for heatmap - we need time series of band states
        const datasets = [];

        for (const band of bands) {
            if (!data[band]) continue;

            try {
                // Use cached trend data (24 hours, 10-min averages)
                const trendData = this.trendDataCache[band] || [];

                // Filter out bands with no FT8 frequency configured (ft8_snr = 0)
                const hasValidFT8Data = trendData.some(d => d.ft8_snr && d.ft8_snr > 0);
                if (!hasValidFT8Data && (!data[band].ft8_snr || data[band].ft8_snr <= 0)) {
                    continue; // Skip bands without FT8 configured
                }

                // Convert FT8 SNR values to band states
                // Normalize all timestamps to today's date (keeping time-of-day) - UTC
                const now = new Date();
                
                const dataPoints = trendData.length > 0
                    ? trendData.map(d => {
                        const snr = d.ft8_snr || 0;
                        let state;
                        if (snr < 6) {
                            state = 0; // POOR
                        } else if (snr >= 6 && snr < 20) {
                            state = 1; // FAIR
                        } else if (snr >= 20 && snr < 30) {
                            state = 2; // GOOD
                        } else {
                            state = 3; // EXCELLENT
                        }
                        
                        // Normalize timestamp to today's date using UTC
                        const originalTime = new Date(d.timestamp);
                        const normalizedTime = new Date(Date.UTC(
                            now.getUTCFullYear(),
                            now.getUTCMonth(),
                            now.getUTCDate(),
                            originalTime.getUTCHours(),
                            originalTime.getUTCMinutes(),
                            originalTime.getUTCSeconds(),
                            originalTime.getUTCMilliseconds()
                        ));
                        
                        return {
                            x: normalizedTime,
                            y: band,
                            v: state,
                            snr: snr
                        };
                    })
                    : [{
                        x: (() => {
                            const originalTime = new Date(data[band].timestamp);
                            return new Date(Date.UTC(
                                now.getUTCFullYear(),
                                now.getUTCMonth(),
                                now.getUTCDate(),
                                originalTime.getUTCHours(),
                                originalTime.getUTCMinutes(),
                                originalTime.getUTCSeconds(),
                                originalTime.getUTCMilliseconds()
                            ));
                        })(),
                        y: band,
                        v: data[band].ft8_snr < 6 ? 0 : (data[band].ft8_snr < 20 ? 1 : 2),
                        snr: data[band].ft8_snr || 0
                    }];

                datasets.push(...dataPoints);
            } catch (error) {
                console.error(`Error loading band state data for ${band}:`, error);
            }
        }

        const ctx = document.getElementById('bandStateChart');
        if (!ctx) return;

        // Only create/update chart if we have data
        if (datasets.length === 0) {
            if (this.bandStateChart) {
                this.bandStateChart.destroy();
                this.bandStateChart = null;
            }
            if (ctx.parentElement) {
                ctx.parentElement.style.display = 'none';
            }
            return;
        } else {
            if (ctx.parentElement) {
                ctx.parentElement.style.display = 'block';
            }
        }

        // Always destroy and recreate chart to ensure aspect ratio changes are applied
        if (this.bandStateChart) {
            this.bandStateChart.destroy();
            this.bandStateChart = null;
        }

        // Update existing chart if it exists and canvas is still in DOM, otherwise create new one
        if (false && this.bandStateChart && ctx && ctx.parentElement) {
            this.bandStateChart.data.datasets[0].data = datasets;
            
            // Update the "Now" indicator position (UTC time)
            const now = new Date();
            const startOfDay = new Date(now);
            startOfDay.setUTCHours(0, 0, 0, 0);
            const currentTimeNormalized = new Date(startOfDay);
            currentTimeNormalized.setUTCHours(now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(), now.getUTCMilliseconds());
            
            if (this.bandStateChart.options.plugins.annotation.annotations.currentTime) {
                this.bandStateChart.options.plugins.annotation.annotations.currentTime.xMin = currentTimeNormalized;
                this.bandStateChart.options.plugins.annotation.annotations.currentTime.xMax = currentTimeNormalized;
            }
            
            this.bandStateChart.update('none');
            return;
        }

        // Destroy old chart if canvas was removed
        if (this.bandStateChart && (!ctx || !ctx.parentElement)) {
            this.bandStateChart.destroy();
            this.bandStateChart = null;
        }

        // Get unique bands for y-axis
        const uniqueBands = [...new Set(datasets.map(d => d.y))];

        // Calculate time range for x-axis (00:00 to 23:59 today UTC)
        const now = new Date();
        const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
        const endOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));

        // Create annotation for current time indicator (normalized to today UTC)
        const currentTimeNormalized = new Date(Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate(),
            now.getUTCHours(),
            now.getUTCMinutes(),
            now.getUTCSeconds(),
            now.getUTCMilliseconds()
        ));
        
        const currentTimeAnnotation = {
            type: 'line',
            xMin: currentTimeNormalized,
            xMax: currentTimeNormalized,
            borderColor: 'rgba(255, 255, 255, 0.8)',
            borderWidth: 2,
            borderDash: [5, 5],
            label: {
                display: true,
                content: 'Now',
                position: 'start',
                backgroundColor: 'rgba(255, 255, 255, 0.9)',
                color: '#000',
                font: {
                    size: 10,
                    weight: 'bold'
                },
                padding: 4
            }
        };

        // Use scatter plot for both single and multi-band
        this.bandStateChart = new Chart(ctx, {
            type: 'scatter',
                data: {
                    datasets: [{
                        label: 'Band State',
                        data: datasets,
                        backgroundColor: (context) => {
                            const value = context.raw.v;
                            if (value === 0) return '#ef4444'; // POOR - red
                            if (value === 1) return '#ff9800'; // FAIR - orange
                            if (value === 2) return '#fbbf24'; // GOOD - yellow
                            if (value === 3) return '#22c55e'; // EXCELLENT - green
                            return '#9ca3af'; // UNKNOWN - gray
                        },
                        borderColor: 'rgba(255, 255, 255, 0.3)',
                        borderWidth: 1,
                        pointStyle: 'rect',
                        pointRadius: 8,
                        pointHoverRadius: 10
                    }]
                },
                options: {
                    animation: false,
                    responsive: true,
                    maintainAspectRatio: true,
                    aspectRatio: 2.5,
                    plugins: {
                        title: {
                            display: false
                        },
                        legend: {
                            display: false
                        },
                        tooltip: {
                            mode: 'point',
                            intersect: false,
                            callbacks: {
                                title: (items) => {
                                    if (items.length === 0) return '';
                                    const date = new Date(items[0].parsed.x);
                                    const hours = String(date.getUTCHours()).padStart(2, '0');
                                    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
                                    return `${hours}:${minutes} UTC`;
                                },
                                beforeBody: (items) => {
                                    // Find all points at the same x coordinate
                                    if (items.length === 0) return [];
                                    const hoveredX = items[0].parsed.x;
                                    const threshold = 5 * 60 * 1000; // 5 minutes tolerance

                                    const chart = items[0].chart;
                                    const bandMap = new Map(); // Use Map to deduplicate by band

                                    // Collect all data points at this time, keeping only the most recent for each band
                                    chart.data.datasets[0].data.forEach((point) => {
                                        if (Math.abs(point.x.getTime() - hoveredX) < threshold) {
                                            const state = point.v === 0 ? 'POOR' : (point.v === 1 ? 'FAIR' : (point.v === 2 ? 'GOOD' : 'EXCELLENT'));
                                            const snr = point.snr.toFixed(1);
                                            const bandName = point.y;

                                            // Only keep if we haven't seen this band yet, or if this point is more recent
                                            if (!bandMap.has(bandName)) {
                                                bandMap.set(bandName, {
                                                    text: `${bandName}: ${state} (${snr} dB)`,
                                                    timestamp: point.x.getTime()
                                                });
                                            } else {
                                                // Keep the more recent data point
                                                const existing = bandMap.get(bandName);
                                                if (point.x.getTime() > existing.timestamp) {
                                                    bandMap.set(bandName, {
                                                        text: `${bandName}: ${state} (${snr} dB)`,
                                                        timestamp: point.x.getTime()
                                                    });
                                                }
                                            }
                                        }
                                    });

                                    // Convert to array and sort by band order
                                    const bandOrder = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];
                                    const allPointsAtTime = Array.from(bandMap.entries())
                                        .sort((a, b) => bandOrder.indexOf(a[0]) - bandOrder.indexOf(b[0]))
                                        .map(entry => entry[1].text);

                                    return allPointsAtTime;
                                },
                                label: () => {
                                    // Return empty since we're showing everything in beforeBody
                                    return '';
                                }
                            }
                        },
                        annotation: {
                            annotations: {
                                currentTime: currentTimeAnnotation
                            }
                        }
                    },
                    scales: {
                        x: {
                            type: 'time',
                            min: startOfDay,
                            max: endOfDay,
                            time: {
                                unit: 'hour',
                                displayFormats: {
                                    hour: 'HH:mm'
                                }
                            },
                            title: {
                                display: true,
                                text: 'Time (UTC)',
                                color: '#fff'
                            },
                            ticks: {
                                color: '#fff',
                                source: 'auto',
                                autoSkip: true,
                                callback: function(value, index, ticks) {
                                    // Format tick as UTC time
                                    const date = new Date(value);
                                    const hours = String(date.getUTCHours()).padStart(2, '0');
                                    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
                                    return `${hours}:${minutes}`;
                                }
                            },
                            grid: { color: 'rgba(255, 255, 255, 0.1)' }
                        },
                        y: {
                            type: 'category',
                            labels: uniqueBands,
                            title: {
                                display: true,
                                text: 'Band',
                                color: '#fff'
                            },
                            ticks: { color: '#fff' },
                            grid: { color: 'rgba(255, 255, 255, 0.1)' }
                        }
                    }
                }
            });
    }

    async updateBandStateChartHistorical(data, comparisonData = null, comparisonDate = null) {
        // Only normalize timestamps when doing a comparison
        const shouldNormalize = comparisonData && comparisonDate;
        const referenceDate = shouldNormalize ? new Date(this.currentDate + 'T00:00:00') : null;

        // Prepare data for heatmap
        const datasets = [];

        data.forEach(m => {
            // Only include bands with FT8 data
            if (m.ft8_snr && m.ft8_snr > 0) {
                let timestamp;
                if (shouldNormalize) {
                    const ts = new Date(m.timestamp);
                    const normalizedTime = new Date(referenceDate);
                    normalizedTime.setHours(ts.getHours(), ts.getMinutes(), ts.getSeconds(), ts.getMilliseconds());
                    timestamp = normalizedTime;
                } else {
                    timestamp = new Date(m.timestamp);
                }

                // Determine state based on SNR thresholds
                let state;
                if (m.ft8_snr < 6) {
                    state = 0; // POOR
                } else if (m.ft8_snr >= 6 && m.ft8_snr < 20) {
                    state = 1; // FAIR
                } else if (m.ft8_snr >= 20 && m.ft8_snr < 30) {
                    state = 2; // GOOD
                } else {
                    state = 3; // EXCELLENT
                }

                datasets.push({
                    x: timestamp,
                    y: m.band,
                    v: state,
                    snr: m.ft8_snr,
                    date: this.currentDate
                });
            }
        });

        // Add comparison data if provided
        if (comparisonData && comparisonDate) {
            comparisonData.forEach(m => {
                if (m.ft8_snr && m.ft8_snr > 0) {
                    const ts = new Date(m.timestamp);
                    const normalizedTime = new Date(referenceDate);
                    normalizedTime.setHours(ts.getHours(), ts.getMinutes(), ts.getSeconds(), ts.getMilliseconds());

                    let state;
                    if (m.ft8_snr < 6) {
                        state = 0; // POOR
                    } else if (m.ft8_snr >= 6 && m.ft8_snr < 20) {
                        state = 1; // FAIR
                    } else if (m.ft8_snr >= 20 && m.ft8_snr < 30) {
                        state = 2; // GOOD
                    } else {
                        state = 3; // EXCELLENT
                    }

                    datasets.push({
                        x: normalizedTime,
                        y: m.band,
                        v: state,
                        snr: m.ft8_snr,
                        date: comparisonDate
                    });
                }
            });
        }

        const ctx = document.getElementById('bandStateChart');

        // Always destroy existing chart
        if (this.bandStateChart) {
            this.bandStateChart.destroy();
            this.bandStateChart = null;
        }

        // Only create chart if we have data
        if (datasets.length === 0) {
            ctx.parentElement.style.display = 'none';
            return;
        } else {
            ctx.parentElement.style.display = 'block';
        }

        // Handle comparison mode for single band
        let yLabels = this.sortBands([...new Set(datasets.map(d => d.y))]);
        if (this.currentBand !== 'all' && comparisonDate) {
            // For single band with comparison, create two rows: one for current date, one for comparison
            const bandName = yLabels[0];
            yLabels = [`${bandName} (${this.currentDate})`, `${bandName} (${comparisonDate})`];

            // Update datasets to use the new y-axis labels
            datasets.forEach(d => {
                if (d.date === this.currentDate) {
                    d.y = yLabels[0];
                } else if (d.date === comparisonDate) {
                    d.y = yLabels[1];
                }
            });
        }

        // Calculate time range for x-axis (24 hours starting at 00:00 of the selected date)
        const selectedDate = new Date(this.currentDate + 'T00:00:00');
        const startOfDay = new Date(selectedDate);
        const endOfDay = new Date(selectedDate);
        endOfDay.setHours(24, 0, 0, 0);

        // Adjust aspect ratio for single band mode to make chart shorter
        const aspectRatio = this.currentBand !== 'all' ? 10.0 : 2.5;

        this.bandStateChart = new Chart(ctx, {
            type: 'scatter',
                data: {
                    datasets: [{
                        label: 'Band State',
                        data: datasets,
                        backgroundColor: (context) => {
                            const value = context.raw.v;
                            if (value === 0) return '#ef4444'; // POOR - red
                            if (value === 1) return '#ff9800'; // FAIR - orange
                            if (value === 2) return '#fbbf24'; // GOOD - yellow
                            if (value === 3) return '#22c55e'; // EXCELLENT - green
                            return '#9ca3af'; // UNKNOWN - gray
                        },
                        borderColor: 'rgba(255, 255, 255, 0.3)',
                        borderWidth: 1,
                        pointStyle: 'rect',
                        pointRadius: 8,
                        pointHoverRadius: 10
                    }]
                },
                options: {
                    animation: false,
                    responsive: true,
                    maintainAspectRatio: true,
                    aspectRatio: aspectRatio,
                    plugins: {
                        title: {
                            display: false
                        },
                        legend: {
                            display: false
                        },
                        tooltip: {
                            mode: 'index',
                            axis: 'x',
                            intersect: false,
                            callbacks: {
                                title: (items) => {
                                    const date = new Date(items[0].parsed.x);
                                    return date.toLocaleString('en-GB', {
                                        hour: '2-digit',
                                        minute: '2-digit',
                                        hour12: false
                                    });
                                },
                                label: (item) => {
                                    const state = item.raw.v === 0 ? 'POOR' : (item.raw.v === 1 ? 'FAIR' : (item.raw.v === 2 ? 'GOOD' : 'EXCELLENT'));
                                    const snr = item.raw.snr.toFixed(1);
                                    const dateLabel = item.raw.date ? ` (${item.raw.date})` : '';
                                    return `${item.raw.y}: ${state} (${snr} dB)${dateLabel}`;
                                }
                            }
                        },
                        annotation: {
                            annotations: {}
                        }
                    },
                    scales: {
                        x: {
                            type: 'time',
                            min: startOfDay,
                            max: endOfDay,
                            time: {
                                unit: 'hour',
                                displayFormats: {
                                    hour: 'HH:mm'
                                }
                            },
                            title: {
                                display: true,
                                text: 'Time (Local)',
                                color: '#fff'
                            },
                            ticks: { color: '#fff' },
                            grid: { color: 'rgba(255, 255, 255, 0.1)' }
                        },
                        y: {
                            type: 'category',
                            labels: yLabels,
                            title: {
                                display: true,
                                text: 'Band',
                                color: '#fff'
                            },
                            ticks: { color: '#fff' },
                            grid: { color: 'rgba(255, 255, 255, 0.1)' }
                        }
                    }
                }
            });

        // Add comparison dropdown if in historical single-band view
        const chartContainer = ctx.parentElement;
        this.createComparisonDropdown('bandState', chartContainer);
    }

    // Create comparison date picker button for a chart
    createComparisonDropdown(chartType, chartContainer) {
        // Only show in historical single-band view
        if (this.currentDate === 'live' || this.currentBand === 'all') {
            return;
        }

        // Don't show comparison controls if viewing today's date
        // (today uses rolling 24-hour window, not single-day data)
        const today = new Date().toISOString().split('T')[0];
        if (this.currentDate === today) {
            return;
        }

        // Check if controls already exist
        let existingControls = chartContainer.querySelector('.comparison-controls');
        if (existingControls) {
            return; // Already exists
        }

        const controlsDiv = document.createElement('div');
        controlsDiv.className = 'comparison-controls';

        const label = document.createElement('label');
        label.textContent = 'Compare with:';

        // Create button to open date picker
        const button = document.createElement('button');
        button.id = `compare-btn-${chartType}`;
        button.textContent = this.comparisonDates[chartType] || 'Select Date';
        button.style.padding = '5px 10px';
        button.style.fontSize = '0.9em';
        button.onclick = () => this.openComparisonPicker(chartType);

        // Create clear button
        const clearBtn = document.createElement('button');
        clearBtn.textContent = '✕';
        clearBtn.style.padding = '5px 10px';
        clearBtn.style.fontSize = '0.9em';
        clearBtn.style.background = '#F44336';
        clearBtn.onclick = async () => {
            this.comparisonDates[chartType] = null;
            button.textContent = 'Select Date';
            await this.updateChartWithComparison(chartType);
        };

        controlsDiv.appendChild(label);
        controlsDiv.appendChild(button);
        controlsDiv.appendChild(clearBtn);
        chartContainer.appendChild(controlsDiv);
    }

    // Update a chart with comparison data
    async updateChartWithComparison(chartType) {
        const comparisonDate = this.comparisonDates[chartType];

        // Map chart type to chart instance and update method
        const chartMap = {
            'trend': {
                chart: this.trendChart,
                updateMethod: 'updateTrendChartHistorical'
            },
            'dynamicRange': {
                chart: this.dynamicRangeChart,
                updateMethod: 'updateDynamicRangeChartHistorical'
            },
            'ft8Snr': {
                chart: this.ft8SnrChart,
                updateMethod: 'updateFT8SnrChartHistorical'
            },
            'bandState': {
                chart: this.bandStateChart,
                updateMethod: 'updateBandStateChartHistorical'
            }
        };

        const chartInfo = chartMap[chartType];
        if (!chartInfo || !chartInfo.chart) {
            return;
        }

        // Get primary data (current date)
        const primaryData = await this.fetchTrendData(this.currentDate, this.currentBand);
        if (!primaryData || primaryData.length === 0) {
            return;
        }

        // If no comparison date, just show primary data
        if (!comparisonDate) {
            await this[chartInfo.updateMethod](primaryData);
            return;
        }

        // Get comparison data
        const comparisonData = await this.fetchTrendData(comparisonDate, this.currentBand);
        if (!comparisonData || comparisonData.length === 0) {
            console.warn(`No comparison data available for ${comparisonDate}`);
            await this[chartInfo.updateMethod](primaryData);
            return;
        }

        // Combine data for chart update
        await this[chartInfo.updateMethod](primaryData, comparisonData, comparisonDate);
    }

    // Fetch trend data for a specific date and band
    async fetchTrendData(date, band) {
        try {
            const url = `/api/noisefloor/trend?date=${date}${band !== 'all' ? '&band=' + band : ''}`;
            const response = await fetch(url);

            if (!response.ok) {
                return null;
            }

            return await response.json();
        } catch (error) {
            console.error(`Error fetching trend data for ${date}:`, error);
            return null;
        }
    }

    updateLegend(bands) {
        const legend = document.getElementById('legend');
        legend.innerHTML = '';

        bands.forEach(band => {
            const item = document.createElement('div');
            item.className = 'legend-item';
            item.innerHTML = `
                <div class="legend-color" style="background-color: ${this.bandColors[band] || '#999'}"></div>
                <span>${band}</span>
            `;
            legend.appendChild(item);
        });
    }

    showNoData(message = 'No data available') {
        const dashboard = document.getElementById('dashboard');
        dashboard.innerHTML = `<div class="loading"><p>${message}</p></div>`;
    }

    setStatus(message, type = 'info') {
        const status = document.getElementById('status');
        status.textContent = message;
        status.className = 'status';
        if (type === 'error') {
            status.classList.add('error');
        } else if (type === 'success') {
            status.classList.add('success');
        }
    }

    startAutoRefresh() {
        // Auto-refresh full data every 60 seconds for live data
        this.refreshInterval = setInterval(() => {
            if (this.currentDate === 'live') {
                this.loadData();
            }
        }, 60000);

        // Auto-refresh FFT spectrums every 10 seconds for live data
        this.fftRefreshInterval = setInterval(() => {
            if (this.currentDate === 'live') {
                this.updateFFTSpectrums();
            }
        }, 10000);

        // Initial load
        this.loadData();
    }

    stopAutoRefresh() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
        if (this.fftRefreshInterval) {
            clearInterval(this.fftRefreshInterval);
            this.fftRefreshInterval = null;
        }
    }

    async updateFFTSpectrums() {
        // Update wide-band spectrum first (only in "all bands" view and live mode)
        if (this.currentBand === 'all' && this.currentDate === 'live') {
            await this.createWideBandSpectrum('wideband-fft');
        }

        // Get all visible bands
        const bands = this.currentBand === 'all'
            ? ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m']
            : [this.currentBand];

        // Update FFT for each visible band, but skip if audio preview is active
        for (const band of bands) {
            // Skip FFT updates if audio preview is enabled for this band
            if (this.audioPreviewEnabled && this.currentBandData && this.currentBandData.band === band) {
                continue;
            }

            const canvasId = `fft-${band}`;
            const canvas = document.getElementById(canvasId);
            if (canvas) {
                await this.updateSingleFFT(canvasId, band);
            }
        }
    }

    async updateSingleFFT(canvasId, band) {
        try {
            const response = await fetch(`/api/noisefloor/fft?band=${band}`);

            if (!response.ok) {
                return;
            }

            const fftData = await response.json();

            if (!fftData || !fftData.data || fftData.data.length === 0) {
                return;
            }

            // Find the existing chart and update its data
            const canvas = document.getElementById(canvasId);
            if (!canvas) return;

            const chart = Chart.getChart(canvas);
            if (chart) {
                // Calculate frequency labels from static FFT data
                const startFreq = fftData.start_freq / 1e6; // Convert to MHz
                const endFreq = fftData.end_freq / 1e6;
                const binWidthMHz = fftData.bin_width / 1e6;
                const numBins = fftData.data.length;

                // Create frequency labels
                const frequencies = [];
                for (let i = 0; i < numBins; i++) {
                    const freq = startFreq + (i * binWidthMHz);
                    frequencies.push(freq);
                }

                // Update chart data and labels
                chart.data.labels = frequencies;
                chart.data.datasets[0].data = fftData.data;

                // Update X-axis range to original band frequency range
                chart.options.scales.x.min = startFreq;
                chart.options.scales.x.max = endFreq;

                // Update Y-axis scaling
                const dataMin = Math.min(...fftData.data);
                const dataMax = Math.max(...fftData.data);
                const range = dataMax - dataMin;
                const padding = range * 0.05;
                chart.options.scales.y.min = Math.floor(dataMin - padding);
                chart.options.scales.y.max = Math.ceil(dataMax + padding);

                // Update chart title back to static
                chart.options.plugins.title.text = 'Real-time Spectrum (10s)';

                // Update marker annotations if they exist
                if (fftData.markers && fftData.markers.length > 0) {
                    chart.options.plugins.annotation.annotations = this.createMarkerAnnotations(fftData.markers);
                } else {
                    // Clear any existing annotations (like preview indicators)
                    chart.options.plugins.annotation.annotations = {};
                }

                chart.update('none'); // Update without animation
            }
        } catch (error) {
            console.error(`Error updating FFT for ${band}:`, error);
        }
    }

    createMarkerAnnotations(markers) {
        const annotations = {};

        markers.forEach((marker, index) => {
            const freqMHz = marker.frequency / 1e6; // Convert Hz to MHz
            const bandwidthMHz = marker.bandwidth / 1e6;

            // Determine the frequency range based on sideband
            let xMin, xMax;
            if (marker.sideband === 'upper') {
                xMin = freqMHz;
                xMax = freqMHz + bandwidthMHz;
            } else if (marker.sideband === 'lower') {
                xMin = freqMHz - bandwidthMHz;
                xMax = freqMHz;
            } else { // 'both' or default
                xMin = freqMHz - (bandwidthMHz / 2);
                xMax = freqMHz + (bandwidthMHz / 2);
            }

            // Create shaded box annotation for bandwidth
            annotations[`marker_box_${index}`] = {
                type: 'box',
                xMin: xMin,
                xMax: xMax,
                backgroundColor: 'rgba(255, 193, 7, 0.15)', // Semi-transparent amber
                borderColor: 'rgba(255, 193, 7, 0.5)',
                borderWidth: 1,
                borderDash: [5, 5]
            };

            // Create label line at start of bandwidth (without visible line)
            annotations[`marker_label_${index}`] = {
                type: 'line',
                xMin: xMin,
                xMax: xMin,
                borderColor: 'rgba(255, 193, 7, 0)', // Transparent line
                borderWidth: 0,
                label: {
                    display: true,
                    content: marker.display_name,
                    position: 'start',
                    backgroundColor: 'rgba(255, 193, 7, 0.9)',
                    color: '#000',
                    font: {
                        size: 10,
                        weight: 'bold'
                    },
                    padding: 4
                }
            };
        });

        return annotations;
    }

    setupAudioPreview(band, canvasId) {
        const button = document.getElementById(`audio-preview-btn-${band}`);
        const canvas = document.getElementById(canvasId);

        console.log('setupAudioPreview called for band:', band);
        console.log('Button found:', button);
        console.log('Canvas found:', canvas);

        if (!button || !canvas) {
            console.warn('Button or canvas not found for audio preview setup');
            return;
        }

        // Get band frequency range from FFT data
        const chart = this.fftCharts[band];
        if (!chart) {
            console.warn('FFT chart not found for band:', band);
            return;
        }

        console.log('FFT chart found:', chart);
        console.log('Chart scales:', chart.options.scales);

        const startFreq = chart.options.scales.x.min * 1e6; // Convert MHz to Hz
        const endFreq = chart.options.scales.x.max * 1e6;
        const centerFreq = (startFreq + endFreq) / 2;

        console.log('Frequency range:', { startFreq, endFreq, centerFreq });

        // Store band data for audio preview
        this.currentBandData = {
            band: band,
            startFreq: startFreq,
            endFreq: endFreq,
            centerFreq: centerFreq
        };

        // Button click handler
        console.log('Adding click event listener to button');
        button.addEventListener('click', async () => {
            console.log('Audio preview button clicked!');
            this.audioPreviewEnabled = !this.audioPreviewEnabled;

            if (this.audioPreviewEnabled) {
                console.log('Enabling audio preview');
                // Initialize audio preview if needed
                if (!this.audioPreview) {
                    this.audioPreview = new MinimalRadio(this.userSessionID);
                    // Expose audio WebSocket to window for idle detector heartbeats
                    window.audioPreviewWs = this.audioPreview.ws;
                }

                // Update button appearance
                button.style.background = '#F44336'; // Red when active
                button.textContent = '🔇 Stop Preview';

                // Disable chart tooltip during audio preview
                const chart = this.fftCharts[band];
                if (chart) {
                    chart.options.plugins.tooltip.enabled = false;
                    chart.update('none');
                }

                // Start preview at center frequency (mode auto-detected by MinimalRadio)
                const freq = Math.round(this.currentBandData.centerFreq / 1000) * 1000; // Round to nearest kHz
                try {
                    console.log('Starting preview at frequency:', freq);
                    await this.audioPreview.startPreview(freq);
                    this.audioPreviewFrequency = freq;

                    // Expose audio WebSocket to window for idle detector heartbeats
                    window.audioPreviewWs = this.audioPreview.ws;

                    // Add visual indicator
                    this.updatePreviewIndicator(band, freq);

                    // Connect spectrum WebSocket for real-time FFT updates (delayed to avoid Cloudflare rate limiting)
                    if (this.bandConfigs && this.bandConfigs[band]) {
                        console.log('Connecting spectrum WebSocket for band:', band);
                        const bandConfig = this.bandConfigs[band];

                        // Delay spectrum connection by 1000ms to avoid simultaneous WebSocket creation
                        setTimeout(() => {
                            // Connect spectrum WebSocket with callback to update FFT chart
                            this.audioPreview.connectSpectrum(band, (spectrumData) => {
                                this.updateFFTFromSpectrum(band, spectrumData);
                            });

                            // Expose spectrum WebSocket to window for idle detector heartbeats
                            // Use a structure similar to spectrumDisplay for compatibility
                            if (!window.spectrumDisplay) {
                                window.spectrumDisplay = {};
                            }
                            window.spectrumDisplay.ws = this.audioPreview.spectrumWs;

                            // After connection, send spectrum request message
                            // Wait a bit for WebSocket to connect
                            setTimeout(() => {
                                if (this.audioPreview.spectrumConnected) {
                                    // Use the same parameters as the static noise floor FFT
                                    const request = {
                                        type: 'zoom',
                                        frequency: bandConfig.center_frequency,
                                        binBandwidth: bandConfig.bin_bandwidth
                                    };
                                    console.log('Sending spectrum request:', request);
                                    console.log('Band config:', {
                                        start: bandConfig.start_frequency / 1e6,
                                        end: bandConfig.end_frequency / 1e6,
                                        center: bandConfig.center_frequency / 1e6,
                                        binBandwidth: bandConfig.bin_bandwidth,
                                        binCount: bandConfig.bin_count,
                                        totalBandwidth: bandConfig.total_bandwidth / 1e3
                                    });
                                    this.audioPreview.spectrumWs.send(JSON.stringify(request));
                                }
                            }, 500);
                        }, 2000); // Delay spectrum connection by 2000ms
                    }

                    console.log('Audio preview started successfully');
                } catch (error) {
                    console.error('Failed to start audio preview:', error);
                    this.audioPreviewEnabled = false;
                    button.style.background = '#4CAF50';
                    button.textContent = '🔊 Audio Preview';
                    alert('Failed to start audio preview: ' + error.message);
                }
            } else {
                console.log('Disabling audio preview');
                // Stop audio preview and disconnect spectrum WebSocket
                if (this.audioPreview) {
                    this.audioPreview.disconnectSpectrum();
                    await this.audioPreview.stopPreview();
                    
                    // Clear window references
                    window.audioPreviewWs = null;
                    if (window.spectrumDisplay) {
                        window.spectrumDisplay.ws = null;
                    }
                }
                this.audioPreviewFrequency = null;
                this.audioPreviewVisualFrequency = null;

                // Remove visual indicator
                this.removePreviewIndicator(band);

                // Re-enable chart tooltip
                const chart = this.fftCharts[band];
                if (chart) {
                    chart.options.plugins.tooltip.enabled = true;
                    chart.update('none');
                }

                // Restore original FFT spectrum from HTTP endpoint
                const fftId = `fft-${band}`;
                await this.updateSingleFFT(fftId, band);

                // Update button appearance
                button.style.background = '#4CAF50'; // Green when inactive
                button.textContent = '🔊 Audio Preview';
            }
        });

        // Canvas hover handler for frequency tracking
        canvas.addEventListener('mousemove', (e) => {
            if (!this.audioPreviewEnabled || !this.audioPreview) return;

            const chart = this.fftCharts[band];
            if (!chart) return;

            // Use Chart.js to get the exact frequency at cursor position
            // This matches what the tooltip shows
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;

            // Get the x-axis scale and convert pixel to value
            const xScale = chart.scales.x;
            const freqMHz = xScale.getValueForPixel(x);

            if (freqMHz === undefined || freqMHz === null) return;

            // Convert MHz to Hz and round to nearest 1 kHz
            const freq = freqMHz * 1e6;
            const roundedFreq = Math.round(freq / 500) * 500;

            // Always update visual indicator to follow cursor exactly
            this.audioPreviewVisualFrequency = roundedFreq;
            this.updatePreviewIndicator(band, roundedFreq);

            // Only send tune command if frequency changed significantly (debounced)
            if (!this.pendingTuneFrequency || Math.abs(roundedFreq - this.pendingTuneFrequency) > 500) {
                this.debouncedTune(roundedFreq);
            }
        });

        // Canvas mouse leave handler
        canvas.addEventListener('mouseleave', () => {
            if (!this.audioPreviewEnabled || !this.audioPreview) return;

            // Return to center frequency when mouse leaves
            const centerFreq = Math.round(this.currentBandData.centerFreq / 1000) * 1000;
            if (this.audioPreviewVisualFrequency !== centerFreq) {
                this.audioPreviewVisualFrequency = centerFreq;

                // Update visual indicator
                this.updatePreviewIndicator(band, centerFreq);

                // Return to center frequency (debounced)
                this.debouncedTune(centerFreq);
            }
        });
    }

    debouncedTune(frequency) {
        // Store the pending frequency
        this.pendingTuneFrequency = frequency;

        // Clear any existing timer
        if (this.tuneDebounceTimer) {
            clearTimeout(this.tuneDebounceTimer);
        }

        // Set new timer for 50ms (fast response for hover tuning)
        this.tuneDebounceTimer = setTimeout(() => {
            if (this.pendingTuneFrequency !== null && this.audioPreview) {
                try {
                    this.audioPreview.changeFrequency(this.pendingTuneFrequency);
                    // Update the actual tuned frequency after command is sent
                    this.audioPreviewFrequency = this.pendingTuneFrequency;
                } catch (error) {
                    console.error('Failed to update preview frequency:', error);
                }
                this.pendingTuneFrequency = null;
            }
            this.tuneDebounceTimer = null;
        }, 50);
    }

    updatePreviewIndicator(band, frequency) {
        const chart = this.fftCharts[band];
        if (!chart || !this.audioPreview) return;

        const freqMHz = frequency / 1e6; // Convert Hz to MHz

        // Get bandwidth from MinimalRadio (in Hz)
        // For USB: bandwidthLow=50, bandwidthHigh=2850 (positive, shows right of center)
        // For LSB: bandwidthLow=-2850, bandwidthHigh=-50 (negative, shows left of center)
        const bandwidthLow = this.audioPreview.bandwidthLow / 1e6; // Convert to MHz
        const bandwidthHigh = this.audioPreview.bandwidthHigh / 1e6; // Convert to MHz

        // Calculate bandwidth edges - automatically correct for USB/LSB
        const xMin = freqMHz + bandwidthLow;
        const xMax = freqMHz + bandwidthHigh;

        // Get current mode for label
        const mode = this.audioPreview.currentMode.toUpperCase();

        // Create or update the preview indicator annotation
        if (!chart.options.plugins.annotation.annotations) {
            chart.options.plugins.annotation.annotations = {};
        }

        // Add shaded box for bandwidth (similar to FT8 markers)
        chart.options.plugins.annotation.annotations.preview_box = {
            type: 'box',
            xMin: xMin,
            xMax: xMax,
            backgroundColor: 'rgba(255, 0, 0, 0.15)', // Semi-transparent red
            borderColor: 'rgba(255, 0, 0, 0.5)',
            borderWidth: 1,
            borderDash: [5, 5]
        };

        // Add center line at tuned frequency
        chart.options.plugins.annotation.annotations.preview_line = {
            type: 'line',
            xMin: freqMHz,
            xMax: freqMHz,
            borderColor: 'rgba(255, 0, 0, 0.8)',
            borderWidth: 2,
            borderDash: [5, 5],
            label: {
                display: true,
                content: `${(frequency / 1e6).toFixed(3)} MHz (${mode})`,
                position: 'start',
                backgroundColor: 'rgba(255, 0, 0, 0.9)',
                color: '#fff',
                font: {
                    size: 10,
                    weight: 'bold'
                },
                padding: 4
            }
        };

        chart.update('none'); // Update without animation
    }

    removePreviewIndicator(band) {
        const chart = this.fftCharts[band];
        if (!chart || !chart.options.plugins.annotation.annotations) return;

        delete chart.options.plugins.annotation.annotations.preview_line;
        delete chart.options.plugins.annotation.annotations.preview_box;
        chart.update('none');
    }

    updateFFTFromSpectrum(band, spectrumData) {
        const chart = this.fftCharts[band];
        if (!chart) {
            console.warn('FFT chart not found for band:', band);
            return;
        }

        // spectrumData contains: { data: [...], config: { centerFreq, binCount, binBandwidth, totalBandwidth }, timestamp }
        if (!spectrumData || !spectrumData.data || spectrumData.data.length === 0) {
            console.warn('Invalid spectrum data received');
            return;
        }

        const config = spectrumData.config;
        if (!config) {
            console.warn('No spectrum config available yet');
            return;
        }

        // Calculate frequency labels based on spectrum config
        // The unwrapped data goes from (centerFreq - totalBandwidth/2) to (centerFreq + totalBandwidth/2)
        const numBins = spectrumData.data.length;
        const startFreqHz = config.centerFreq - (config.totalBandwidth / 2);
        const binWidthHz = config.binBandwidth;

        // Create frequency labels in MHz
        const frequencies = [];
        for (let i = 0; i < numBins; i++) {
            const freqHz = startFreqHz + (i * binWidthHz);
            frequencies.push(freqHz / 1e6); // Convert to MHz
        }

        // Update chart data and labels
        chart.data.labels = frequencies;
        chart.data.datasets[0].data = Array.from(spectrumData.data);

        // Update X-axis range
        const startFreqMHz = startFreqHz / 1e6;
        const endFreqMHz = (startFreqHz + (numBins * binWidthHz)) / 1e6;
        chart.options.scales.x.min = startFreqMHz;
        chart.options.scales.x.max = endFreqMHz;

        // Update Y-axis scaling based on new data
        const dataMin = Math.min(...spectrumData.data);
        const dataMax = Math.max(...spectrumData.data);
        const range = dataMax - dataMin;
        const padding = range * 0.05;
        chart.options.scales.y.min = Math.floor(dataMin - padding);
        chart.options.scales.y.max = Math.ceil(dataMax + padding);

        // Update chart title to show it's real-time
        chart.options.plugins.title.text = 'Real-time Spectrum (WebSocket)';

        // Update without animation for smooth real-time updates
        chart.update('none');
    }

    // Cleanup methods to prevent memory leaks
    cleanup() {
        // Stop audio preview if active
        if (this.audioPreview && this.audioPreviewEnabled) {
            // Disconnect spectrum WebSocket first
            this.audioPreview.disconnectSpectrum();
            this.audioPreview.stopPreview();
            this.audioPreviewEnabled = false;
            this.audioPreviewFrequency = null;
            this.audioPreviewVisualFrequency = null;
            
            // Clear window references
            window.audioPreviewWs = null;
            if (window.spectrumDisplay) {
                window.spectrumDisplay.ws = null;
            }

            // Remove preview indicator
            if (this.currentBandData) {
                this.removePreviewIndicator(this.currentBandData.band);
            }
        }

        // Destroy wide-band chart
        if (this.wideBandChart) {
            this.wideBandChart.destroy();
            this.wideBandChart = null;
        }

        // Destroy all stored charts
        Object.values(this.sparklineCharts).forEach(chart => {
            if (chart) chart.destroy();
        });
        Object.values(this.fftCharts).forEach(chart => {
            if (chart) chart.destroy();
        });

        this.sparklineCharts = {};
        this.fftCharts = {};

        // Clear caches
        this.historicalDataCache = {};
        this.recentDataCache = {};
        this.trendDataCache = {};

        // Remove event listeners from cards
        const cards = document.querySelectorAll('.card');
        cards.forEach(card => {
            if (card._clickHandler) {
                card.removeEventListener('click', card._clickHandler);
                delete card._clickHandler;
            }
        });
    }

    cleanupBandCharts(bands) {
        // Destroy charts for specific bands
        bands.forEach(band => {
            if (this.sparklineCharts[band]) {
                this.sparklineCharts[band].destroy();
                delete this.sparklineCharts[band];
            }
            if (this.fftCharts[band]) {
                this.fftCharts[band].destroy();
                delete this.fftCharts[band];
            }
        });
    }
    // Date Picker Methods
    openDatePicker() {
        if (!this.datePicker) {
            this.datePicker = new DatePicker(
                this.availableDates,
                (date) => this.onDateSelected(date),
                this.currentDate !== 'live' ? this.currentDate : null
            );
        } else {
            this.datePicker.updateAvailableDates(this.availableDates);
        }
        this.datePicker.show();
    }

    closeDatePicker() {
        if (this.datePicker) {
            this.datePicker.close();
        }
    }

    onDateSelected(date) {
        this.currentDate = date;
        document.getElementById('selectedDateText').textContent = date;
        this.updateURL();
        this.cleanup();
        this.loadData();
    }

    openComparisonPicker(chartType) {
        const currentComparison = this.comparisonDates[chartType];
        
        // Filter out the current date (backend already excludes today's date)
        const availableDates = this.availableDates.filter(d => d !== this.currentDate);
        
        if (!this.comparisonPickers[chartType]) {
            this.comparisonPickers[chartType] = new DatePicker(
                availableDates,
                (date) => this.onComparisonDateSelected(chartType, date),
                currentComparison
            );
        } else {
            this.comparisonPickers[chartType].updateAvailableDates(availableDates);
        }
        this.comparisonPickers[chartType].show();
    }

    async onComparisonDateSelected(chartType, date) {
        this.comparisonDates[chartType] = date;
        const btn = document.getElementById(`compare-btn-${chartType}`);
        if (btn) {
            btn.textContent = date || 'Select Date';
        }
        await this.updateChartWithComparison(chartType);
    }


    // Remove all comparison dropdowns from charts
    removeComparisonDropdowns() {
        const comparisonControls = document.querySelectorAll('.comparison-controls');
        comparisonControls.forEach(control => {
            control.remove();
        });

        // Clear comparison state
        this.comparisonDates = {
            trend: null,
            dynamicRange: null,
            ft8Snr: null,
            bandState: null
        };
    }}

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
    new NoiseFloorMonitor();
});

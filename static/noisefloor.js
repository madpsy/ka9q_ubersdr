// Noise Floor Monitor JavaScript
// Handles data fetching, visualization, and user interactions

class NoiseFloorMonitor {
    constructor() {
        this.trendChart = null;
        this.dynamicRangeChart = null;
        this.ft8SnrChart = null;
        this.refreshInterval = null;
        this.fftRefreshInterval = null;
        this.currentDate = 'live';
        this.currentBand = 'all';
        this.compactView = false;
        this.savedCompactView = false; // Save compact view state when switching to single band
        this.historicalDataCache = {}; // Cache historical data to avoid redundant API calls
        this.sparklineCharts = {}; // Store sparkline chart references by band
        this.fftCharts = {}; // Store FFT chart references by band
        this.wasHistorical = false; // Track if we were viewing historical data
        
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
    }
    
    async loadVersion() {
        try {
            const response = await fetch('/api/version');
            if (response.ok) {
                const data = await response.json();
                const versionSpan = document.getElementById('footer-version');
                if (versionSpan && data.version) {
                    versionSpan.textContent = `• v${data.version}`;
                }
            }
        } catch (error) {
            console.error('Error loading version:', error);
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
        this.loadFromURL();
        this.startAutoRefresh();
    }
    
    setupEventListeners() {
        document.getElementById('dateSelect').addEventListener('change', (e) => {
            this.currentDate = e.target.value;
            this.updateURL();
            this.cleanup(); // Clean up before loading new data
            this.loadData();
        });
        
        document.getElementById('bandSelect').addEventListener('change', (e) => {
            this.currentBand = e.target.value;
            this.updateURL();
            this.cleanup(); // Clean up before loading new data
            this.loadData();
        });
        
        document.getElementById('refreshBtn').addEventListener('click', () => {
            this.loadData();
        });
        
        document.getElementById('allBandsBtn').addEventListener('click', () => {
            this.currentBand = 'all';
            document.getElementById('bandSelect').value = 'all';
            this.updateURL();
            this.loadData();
        });
        
        document.getElementById('viewToggleBtn').addEventListener('click', () => {
            this.toggleCompactView();
        });
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
    }
    
    updateURL() {
        const params = new URLSearchParams();
        if (this.currentBand !== 'all') {
            params.set('band', this.currentBand);
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
            const select = document.getElementById('dateSelect');
            
            // Keep "Live Data" option
            select.innerHTML = '<option value="live">Live Data</option>';
            
            // Add historical dates
            if (data.dates && data.dates.length > 0) {
                data.dates.forEach(date => {
                    const option = document.createElement('option');
                    option.value = date;
                    option.textContent = date;
                    select.appendChild(option);
                });
            }
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
        
        this.displayLiveData(data);
        await this.updateTrendChart(data);
        await this.updateDynamicRangeChart(data);
        await this.updateFT8SnrChart(data);
    }
    
    async loadHistoricalData() {
        // Hide the live data dashboard when viewing historical data
        const liveDataSection = document.getElementById('liveData');
        liveDataSection.style.display = 'none';
        
        // Mark that we're viewing historical data
        this.wasHistorical = true;
        
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
    }
    
    async updateTrendChartHistorical(data) {
        // Group by band
        const bandData = {};
        data.forEach(m => {
            if (!bandData[m.band]) {
                bandData[m.band] = [];
            }
            bandData[m.band].push({
                x: new Date(m.timestamp),
                y: m.p5_db
            });
        });
        
        const bands = this.sortBands(Object.keys(bandData));
        const datasets = bands.map(band => ({
            label: band,
            data: bandData[band],
            borderColor: this.bandColors[band] || '#999',
            backgroundColor: this.bandColors[band] || '#999',
            borderWidth: 2,
            pointRadius: 2,
            tension: 0.4
        }));
        
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
    }
    
    displayLiveData(data) {
        const dashboard = document.getElementById('dashboard');
        const trendsContainer = document.getElementById('trendsContainer');
        
        // Filter by selected band if not "all"
        const bands = this.currentBand === 'all'
            ? this.sortBands(Object.keys(data))
            : [this.currentBand];
        
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
        
        // Card 3: FFT Spectrum
        const fftCard = document.createElement('div');
        fftCard.className = 'card';
        fftCard.style.gridColumn = '1 / -1'; // Span both columns
        fftCard.innerHTML = `
            <h3>${band} Real-time Spectrum</h3>
            <div style="margin-top: 15px; height: 300px;">
                <canvas id="${fftId}"></canvas>
            </div>
        `;
        
        container.appendChild(metricsCard);
        container.appendChild(sparklineCard);
        container.appendChild(fftCard);
        
        setTimeout(() => {
            this.createSparkline(sparklineId, band);
            this.createFFTSpectrum(fftId, band);
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
                                    size: 9
                                },
                                callback: (value) => value.toFixed(0)
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
                    pointRadius: 2,
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
                    pointRadius: 2,
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
    
    async updateDynamicRangeChartHistorical(data) {
        // Group by band
        const bandData = {};
        data.forEach(m => {
            if (!bandData[m.band]) {
                bandData[m.band] = [];
            }
            bandData[m.band].push({
                x: new Date(m.timestamp),
                y: m.dynamic_range
            });
        });
        
        const bands = this.sortBands(Object.keys(bandData));
        const datasets = bands.map(band => ({
            label: band,
            data: bandData[band],
            borderColor: this.bandColors[band] || '#999',
            backgroundColor: this.bandColors[band] || '#999',
            borderWidth: 2,
            pointRadius: 2,
            tension: 0.4
        }));
        
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
                    pointRadius: 2,
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
        if (this.ft8SnrChart && ctx.parentElement) {
            this.ft8SnrChart.data.datasets = datasets;
            this.ft8SnrChart.update('none');
            return;
        }
        
        // Destroy old chart if canvas was removed
        if (this.ft8SnrChart && !ctx.parentElement) {
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

    async updateFT8SnrChartHistorical(data) {
        // Group by band
        const bandData = {};
        data.forEach(m => {
            // Only include bands with FT8 data
            if (m.ft8_snr && m.ft8_snr > 0) {
                if (!bandData[m.band]) {
                    bandData[m.band] = [];
                }
                bandData[m.band].push({
                    x: new Date(m.timestamp),
                    y: m.ft8_snr
                });
            }
        });

        const bands = this.sortBands(Object.keys(bandData));
        const datasets = bands.map(band => ({
            label: band,
            data: bandData[band],
            borderColor: this.bandColors[band] || '#999',
            backgroundColor: this.bandColors[band] || '#999',
            borderWidth: 2,
            pointRadius: 2,
            tension: 0.4
        }));

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
        // Get all visible bands
        const bands = this.currentBand === 'all'
            ? ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m']
            : [this.currentBand];
        
        // Update FFT for each visible band
        for (const band of bands) {
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
                // Update the chart data
                chart.data.datasets[0].data = fftData.data;
                
                // Update Y-axis scaling
                const dataMin = Math.min(...fftData.data);
                const dataMax = Math.max(...fftData.data);
                const range = dataMax - dataMin;
                const padding = range * 0.05;
                chart.options.scales.y.min = Math.floor(dataMin - padding);
                chart.options.scales.y.max = Math.ceil(dataMax + padding);
                
                // Update marker annotations if they exist
                if (fftData.markers && fftData.markers.length > 0) {
                    chart.options.plugins.annotation.annotations = this.createMarkerAnnotations(fftData.markers);
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
    
    // Cleanup methods to prevent memory leaks
    cleanup() {
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
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new NoiseFloorMonitor();
});
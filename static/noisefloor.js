// Noise Floor Monitor JavaScript
// Handles data fetching, visualization, and user interactions

class NoiseFloorMonitor {
    constructor() {
        this.trendChart = null;
        this.dynamicRangeChart = null;
        this.refreshInterval = null;
        this.currentDate = 'live';
        this.currentBand = 'all';
        this.compactView = false;
        this.historicalDataCache = {}; // Cache historical data to avoid redundant API calls
        
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
            this.loadData();
        });
        
        document.getElementById('bandSelect').addEventListener('change', (e) => {
            this.currentBand = e.target.value;
            this.updateURL();
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
        
        // Load today's historical data once for all charts
        const today = new Date().toISOString().split('T')[0];
        const bands = this.currentBand === 'all' ? Object.keys(data).sort() : [this.currentBand];
        
        for (const band of bands) {
            if (data[band]) {
                try {
                    const response = await fetch(`/api/noisefloor/history?date=${today}&band=${band}`);
                    if (response.ok) {
                        this.historicalDataCache[band] = await response.json();
                    }
                } catch (error) {
                    console.error(`Error loading historical data for ${band}:`, error);
                }
            }
        }
        
        this.displayLiveData(data);
        await this.updateTrendChart(data);
        await this.updateDynamicRangeChart(data);
    }
    
    async loadHistoricalData() {
        const url = `/api/noisefloor/history?date=${this.currentDate}${this.currentBand !== 'all' ? '&band=' + this.currentBand : ''}`;
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
        await this.updateDynamicRangeChartHistorical(data);
    }
    
    displayLiveData(data) {
        const dashboard = document.getElementById('dashboard');
        dashboard.innerHTML = '';
        
        // Filter by selected band if not "all"
        const bands = this.currentBand === 'all'
            ? this.sortBands(Object.keys(data))
            : [this.currentBand];
        
        // Calculate noise floor statistics for color coding
        const noiseFloors = bands.map(band => data[band]?.p5_db).filter(v => v !== undefined);
        const noiseFloorStats = this.calculateNoiseFloorStats(noiseFloors);
        
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
        const card = document.createElement('div');
        card.className = 'card';
        card.style.cursor = 'pointer';
        card.title = `Click to view ${band} only`;
        
        // Add click handler to switch to this band
        card.addEventListener('click', () => {
            if (this.currentBand === 'all') {
                this.currentBand = band;
                document.getElementById('bandSelect').value = band;
                this.updateURL();
                this.loadData();
            }
        });
        
        const timestamp = new Date(measurement.timestamp).toLocaleTimeString();
        const sparklineId = `sparkline-${band}`;
        const fftId = `fft-${band}`;
        
        const noiseFloorColor = noiseFloorStats
            ? this.getNoiseFloorColor(measurement.p5_db, noiseFloorStats)
            : '#4CAF50';
        
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
            <div style="margin-top: 15px; height: ${this.currentBand === 'all' ? '100px' : '150px'};">
                <canvas id="${sparklineId}"></canvas>
            </div>
            <div style="margin-top: 15px; height: ${this.currentBand === 'all' ? '200px' : '400px'};">
                <canvas id="${fftId}"></canvas>
            </div>
        `;
        
        // Create sparkline and FFT spectrum after card is added to DOM
        setTimeout(() => {
            this.createSparkline(sparklineId, band);
            this.createFFTSpectrum(fftId, band);
        }, 0);
        
        return card;
    }
    
    async createSparkline(canvasId, band) {
        try {
            // Use cached historical data
            const data = this.historicalDataCache[band];
            
            if (!data || data.length === 0) {
                return;
            }
            
            // Filter to last hour
            const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
            const recentData = data.filter(d => new Date(d.timestamp) >= oneHourAgo);
            
            if (recentData.length === 0) {
                return;
            }
            
            const ctx = document.getElementById(canvasId);
            if (!ctx) return;
            
            new Chart(ctx, {
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
            
            console.log(`FFT for ${band}: ${numBins} bins, ${startFreq.toFixed(3)}-${endFreq.toFixed(3)} MHz, bin width ${(binWidthMHz*1000).toFixed(1)} kHz, Y-axis: ${yMin} to ${yMax} dB`);
            
            new Chart(ctx, {
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
                            text: 'Real-time Spectrum',
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
                // Use cached historical data
                const historicalData = this.historicalDataCache[band] || [];
                
                // If we have historical data, use it; otherwise just show current point
                const dataPoints = historicalData.length > 0
                    ? historicalData.map(d => ({
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
                // Use cached historical data
                const historicalData = this.historicalDataCache[band] || [];
                
                const dataPoints = historicalData.length > 0
                    ? historicalData.map(d => ({
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
        // Auto-refresh every 60 seconds for live data
        this.refreshInterval = setInterval(() => {
            if (this.currentDate === 'live') {
                this.loadData();
            }
        }, 60000);
        
        // Initial load
        this.loadData();
    }
    
    stopAutoRefresh() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new NoiseFloorMonitor();
});
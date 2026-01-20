// Decode Rates Dashboard
// Displays real-time decode activity for all bands with auto-refresh

class DecodeRatesDashboard {
    constructor() {
        this.charts = new Map(); // Map of band name to Chart instance
        this.autoRefreshInterval = null;
        this.autoRefreshSeconds = 900; // 15 minutes = 900 seconds
        this.countdownInterval = null;
        this.isLoading = false;
        this.allBands = []; // Store all bands data
        this.selectedMode = ''; // Current mode filter
        this.selectedFrequency = ''; // Current frequency filter
        
        this.init();
        this.loadVersion();
        this.loadData();
        this.startAutoRefresh();
    }

    init() {
        // Manual refresh button
        document.getElementById('refresh-btn').addEventListener('click', () => {
            this.loadData();
        });

        // Mode filter dropdown
        document.getElementById('mode-filter').addEventListener('change', (e) => {
            this.selectedMode = e.target.value;
            this.selectedFrequency = ''; // Reset frequency filter when mode changes
            this.updateFrequencyFilter();
            this.filterAndRenderCharts();
        });

        // Frequency filter dropdown
        document.getElementById('frequency-filter').addEventListener('change', (e) => {
            this.selectedFrequency = e.target.value;
            this.filterAndRenderCharts();
        });
    }

    async loadVersion() {
        try {
            const response = await fetch('/api/description');
            if (response.ok) {
                const data = await response.json();
                const receiverNameEl = document.getElementById('receiver-name');
                if (receiverNameEl && data.receiver && data.receiver.name) {
                    receiverNameEl.textContent = `${data.receiver.name} - Live Decode Activity`;
                }
                const versionSpan = document.getElementById('footer-version');
                if (versionSpan && data.version) {
                    versionSpan.textContent = `• v${data.version}`;
                }
            }
        } catch (error) {
            console.error('Error loading version:', error);
        }
    }

    startAutoRefresh() {
        // Auto-refresh every 30 seconds
        this.autoRefreshInterval = setInterval(() => {
            this.loadData();
        }, this.autoRefreshSeconds * 1000);

        // Start countdown timer
        this.startCountdown();
    }

    startCountdown() {
        let secondsLeft = this.autoRefreshSeconds;
        const refreshInfo = document.getElementById('refresh-info');
        
        // Clear any existing countdown
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
        }

        this.countdownInterval = setInterval(() => {
            secondsLeft--;
            if (secondsLeft <= 0) {
                secondsLeft = this.autoRefreshSeconds;
            }
            
            // Format as MM:SS
            const minutes = Math.floor(secondsLeft / 60);
            const seconds = secondsLeft % 60;
            refreshInfo.textContent = `Auto-refresh in ${minutes}:${seconds.toString().padStart(2, '0')}`;
        }, 1000);
    }

    async loadData() {
        if (this.isLoading) {
            console.log('Already loading, skipping...');
            return;
        }

        this.isLoading = true;
        const loadingEl = document.getElementById('loading');
        const errorEl = document.getElementById('error');
        const statusEl = document.getElementById('status-message');
        const refreshBtn = document.getElementById('refresh-btn');

        loadingEl.style.display = 'block';
        errorEl.style.display = 'none';
        refreshBtn.disabled = true;
        statusEl.textContent = 'Loading decode rates...';

        try {
            const response = await fetch('/api/decoder/rates/all');
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            
            if (!data.bands || data.bands.length === 0) {
                statusEl.textContent = 'No decoder bands configured';
                errorEl.textContent = 'No decoder bands are currently configured or enabled.';
                errorEl.style.display = 'block';
                return;
            }

            // Store all bands data
            this.allBands = data.bands;
            
            // Update mode filter dropdown
            this.updateModeFilter();
            
            // Render charts with current filter
            this.filterAndRenderCharts();
            
            const now = new Date();
            statusEl.textContent = `Last updated: ${now.toLocaleTimeString()} • ${data.bands.length} band(s)`;
            
            // Reset countdown
            this.startCountdown();
            
        } catch (error) {
            console.error('Error loading decode rates:', error);
            statusEl.textContent = 'Error loading data';
            errorEl.textContent = `Failed to load decode rates: ${error.message}`;
            errorEl.style.display = 'block';
        } finally {
            loadingEl.style.display = 'none';
            refreshBtn.disabled = false;
            this.isLoading = false;
        }
    }

    updateModeFilter() {
        const modeFilter = document.getElementById('mode-filter');
        const currentValue = modeFilter.value;

        // Get unique modes from all bands
        const modes = new Set();
        this.allBands.forEach(band => {
            modes.add(band.mode);
        });

        // Sort modes alphabetically
        const sortedModes = Array.from(modes).sort();

        // Update dropdown options (keep "All Modes" option)
        modeFilter.innerHTML = '<option value="">All Modes</option>';
        sortedModes.forEach(mode => {
            const option = document.createElement('option');
            option.value = mode;
            option.textContent = mode;
            modeFilter.appendChild(option);
        });

        // Restore previous selection if it still exists
        if (currentValue && sortedModes.includes(currentValue)) {
            modeFilter.value = currentValue;
        }

        // Update frequency filter visibility
        this.updateFrequencyFilter();
    }

    updateFrequencyFilter() {
        const frequencyFilterContainer = document.getElementById('frequency-filter-container');
        const frequencyFilter = document.getElementById('frequency-filter');

        // Show frequency filter only when a specific mode is selected
        if (this.selectedMode) {
            frequencyFilterContainer.style.display = 'flex';

            // Get unique frequencies for the selected mode
            const frequencies = new Set();
            this.allBands.forEach(band => {
                if (band.mode === this.selectedMode) {
                    frequencies.add(band.frequency);
                }
            });

            // Sort frequencies numerically
            const sortedFrequencies = Array.from(frequencies).sort((a, b) => a - b);

            // Update dropdown options
            frequencyFilter.innerHTML = '<option value="">All Frequencies</option>';
            sortedFrequencies.forEach(freq => {
                const option = document.createElement('option');
                option.value = freq;
                option.textContent = `${(freq / 1e6).toFixed(3)} MHz`;
                frequencyFilter.appendChild(option);
            });

            // Reset selection
            frequencyFilter.value = this.selectedFrequency;
        } else {
            // Hide frequency filter when "All Modes" is selected
            frequencyFilterContainer.style.display = 'none';
            this.selectedFrequency = '';
        }
    }

    filterAndRenderCharts() {
        // Filter bands based on selected mode and frequency
        let filteredBands = this.allBands;

        if (this.selectedMode) {
            filteredBands = filteredBands.filter(band => band.mode === this.selectedMode);
        }

        if (this.selectedFrequency) {
            filteredBands = filteredBands.filter(band => band.frequency == this.selectedFrequency);
        }

        // Render charts with filtered data
        this.renderCharts({ bands: filteredBands });
    }

    renderCharts(data) {
        const container = document.getElementById('charts-container');

        // Track which bands we've seen in this update
        const activeBands = new Set();

        // Process each band
        data.bands.forEach(band => {
            activeBands.add(band.band_name);
            
            // Check if chart already exists
            if (this.charts.has(band.band_name)) {
                // Update existing chart
                this.updateChart(band);
            } else {
                // Create new chart
                this.createChart(container, band);
            }
        });

        // Remove charts for bands that are no longer active
        this.charts.forEach((chart, bandName) => {
            if (!activeBands.has(bandName)) {
                chart.destroy();
                this.charts.delete(bandName);
                const chartContainer = document.getElementById(`chart-container-${bandName}`);
                if (chartContainer) {
                    chartContainer.remove();
                }
            }
        });
    }

    createChart(container, band) {
        // Create container for this chart
        const chartDiv = document.createElement('div');
        chartDiv.className = 'chart-container';
        chartDiv.id = `chart-container-${band.band_name}`;
        
        const title = document.createElement('h2');
        title.innerHTML = `
            <span>${band.mode} on ${band.band_name}</span>
            <span class="band-label">${(band.frequency / 1e6).toFixed(3)} MHz</span>
        `;
        
        const canvas = document.createElement('canvas');
        canvas.id = `chart-${band.band_name}`;
        
        chartDiv.appendChild(title);
        chartDiv.appendChild(canvas);
        container.appendChild(chartDiv);

        // Prepare data for chart
        const chartData = this.prepareChartData(band);
        
        // Create chart
        const ctx = canvas.getContext('2d');
        const chart = new Chart(ctx, {
            type: 'line',
            data: chartData,
            options: {
                responsive: true,
                maintainAspectRatio: true,
                aspectRatio: 2.5,
                animation: {
                    duration: 0 // Disable animation for smoother updates
                },
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        callbacks: {
                            title: (items) => {
                                if (items.length === 0) return '';
                                const date = new Date(items[0].parsed.x);
                                return date.toLocaleString('en-GB', {
                                    dateStyle: 'medium',
                                    timeStyle: 'short',
                                    hour12: false
                                });
                            },
                            label: (context) => {
                                // Calculate decodes per hour from the interval count
                                const decodesPerInterval = context.parsed.y;
                                const intervalMinutes = 15; // 15-minute intervals
                                const decodesPerHour = (decodesPerInterval / intervalMinutes) * 60;
                                return `${decodesPerInterval} decodes (${decodesPerHour.toFixed(1)}/hour)`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            tooltipFormat: 'yyyy-MM-dd HH:mm',
                            displayFormats: {
                                hour: 'HH:mm',
                                minute: 'HH:mm'
                            }
                        },
                        title: {
                            display: true,
                            text: 'Time (UTC)',
                            color: '#fff'
                        },
                        ticks: {
                            color: '#fff',
                            maxRotation: 0,
                            autoSkip: true
                        },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    },
                    y: {
                        type: 'linear',
                        title: {
                            display: true,
                            text: 'Decodes per 15 minutes',
                            color: '#fff'
                        },
                        ticks: { 
                            color: '#fff',
                            callback: function(value) {
                                return Math.round(value);
                            }
                        },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' },
                        beginAtZero: true
                    }
                }
            }
        });

        this.charts.set(band.band_name, chart);
    }

    updateChart(band) {
        const chart = this.charts.get(band.band_name);
        if (!chart) return;

        const chartData = this.prepareChartData(band);
        chart.data = chartData;
        chart.update('none'); // 'none' mode for no animation
    }

    prepareChartData(band) {
        // Extract time series data
        const dataPoints = [];
        
        if (band.time_series && band.time_series.length > 0) {
            // The time series contains data points with timestamps and decode counts
            band.time_series.forEach(point => {
                // Each point has a timestamp and data object
                // The data object has keys like "FT8:40m" with decode counts
                const key = `${band.mode}:${band.band_name}`;
                if (point.data && point.data[key]) {
                    dataPoints.push({
                        x: new Date(point.timestamp),
                        y: point.data[key].decode_count
                    });
                }
            });
        }

        // Sort by timestamp
        dataPoints.sort((a, b) => a.x - b.x);

        return {
            datasets: [{
                label: `${band.mode} ${band.band_name}`,
                data: dataPoints,
                borderColor: '#ef4444',
                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                tension: 0.4,
                fill: true,
                pointRadius: 2,
                pointHoverRadius: 5,
                borderWidth: 2
            }]
        };
    }

    destroy() {
        // Clean up intervals
        if (this.autoRefreshInterval) {
            clearInterval(this.autoRefreshInterval);
        }
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
        }
        
        // Destroy all charts
        this.charts.forEach(chart => chart.destroy());
        this.charts.clear();
    }
}

// Initialize dashboard when DOM is ready
let dashboard = null;
document.addEventListener("DOMContentLoaded", () => {
    dashboard = new DecodeRatesDashboard();
});

// Clean up on page unload
window.addEventListener('beforeunload', () => {
    if (dashboard) {
        dashboard.destroy();
    }
});

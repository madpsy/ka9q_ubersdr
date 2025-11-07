// Space Weather History Viewer
// Displays historical space weather data with flexible query modes

class SpaceWeatherHistory {
    constructor() {
        this.currentMode = 'all';
        this.chart = null;
        this.selectedDate = null;
        this.availableDates = [];
        this.datePicker = null;
        this.init();
        this.loadVersion();
        this.loadAvailableDates();
    }

    async loadVersion() {
        try {
            const response = await fetch('/api/description');
            if (response.ok) {
                const data = await response.json();

                // Update receiver name in subtitle
                const receiverNameEl = document.getElementById('receiver-name');
                if (receiverNameEl) {
                    if (data.receiver && data.receiver.name) {
                        receiverNameEl.textContent = `${data.receiver.name} - Historical Space Weather`;
                    }
                }

                // Update version in footer
                const versionSpan = document.getElementById('footer-version');
                if (versionSpan && data.version) {
                    versionSpan.textContent = `• v${data.version}`;
                }
            }
        } catch (error) {
            console.error('Error loading version:', error);
        }
    }

    async loadAvailableDates() {
        try {
            const response = await fetch('/api/spaceweather/dates');
            if (response.status === 429) {
                const errorData = await response.json();
                console.warn('Rate limit exceeded loading dates:', errorData.error);
                // Retry after a delay
                setTimeout(() => this.loadAvailableDates(), 2500);
                return;
            }
            if (response.ok) {
                const data = await response.json();
                if (data.dates && data.dates.length > 0) {
                    this.availableDates = data.dates;
                    // Set the most recent date as default
                    this.selectedDate = data.dates[0];
                    this.updateDateDisplay();
                    
                    // Initialize date picker after dates are loaded
                    this.initDatePicker();
                }
            }
        } catch (error) {
            console.error('Error loading available dates:', error);
        }
    }

    initDatePicker() {
        // Initialize the date picker with available dates
        this.datePicker = new DatePicker(
            this.availableDates,
            (date) => {
                this.selectedDate = date;
                this.updateDateDisplay();
            },
            this.selectedDate
        );

        // Set up date picker button
        const datePickerBtn = document.getElementById('datePickerBtn');
        datePickerBtn.addEventListener('click', () => {
            this.openDatePicker();
        });

        // Set up close buttons
        document.getElementById('closeDatePicker').addEventListener('click', () => {
            this.closeDatePicker();
        });
        document.getElementById('cancelDatePicker').addEventListener('click', () => {
            this.closeDatePicker();
        });
    }

    openDatePicker() {
        if (this.datePicker) {
            this.datePicker.show();
        }
    }

    closeDatePicker() {
        if (this.datePicker) {
            this.datePicker.close();
        }
    }

    updateDateDisplay() {
        const dateText = document.getElementById('selectedDateText');
        if (dateText && this.selectedDate) {
            // Handle both date-only and date-time formats
            const dateStr = this.selectedDate.includes('T') ? this.selectedDate.split('T')[0] : this.selectedDate;
            const date = new Date(dateStr + 'T00:00:00');
            dateText.textContent = date.toLocaleDateString('en-GB', {
                year: 'numeric',
                month: 'short',
                day: 'numeric'
            });
        }
    }

    init() {
        // Set current UTC time as default for single time input
        this.setCurrentUTCTime();

        // Set up query mode tabs
        const tabs = document.querySelectorAll('.query-mode-tab');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                this.switchMode(tab.dataset.mode);
            });
        });

        // Set up load button
        const loadBtn = document.getElementById('load-btn');
        loadBtn.addEventListener('click', () => {
            this.loadData();
        });

        // Set up download CSV button
        const downloadBtn = document.getElementById('download-csv-btn');
        downloadBtn.addEventListener('click', () => {
            this.downloadCSV();
        });
    }

    setCurrentUTCTime() {
        const now = new Date();
        const hours = String(now.getUTCHours()).padStart(2, '0');
        const minutes = String(now.getUTCMinutes()).padStart(2, '0');
        const timeInput = document.getElementById('time-input');
        if (timeInput) {
            timeInput.value = `${hours}:${minutes}`;
        }
    }

    switchMode(mode) {
        this.currentMode = mode;

        // Update active tab
        document.querySelectorAll('.query-mode-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.mode === mode);
        });

        // Show/hide appropriate controls
        const timeControl = document.getElementById('time-control');
        const fromTimeControl = document.getElementById('from-time-control');
        const toTimeControl = document.getElementById('to-time-control');

        timeControl.classList.toggle('hidden', mode !== 'single');
        fromTimeControl.classList.toggle('hidden', mode !== 'range');
        toTimeControl.classList.toggle('hidden', mode !== 'range');

        // Update time input to current UTC when switching to single mode
        if (mode === 'single') {
            this.setCurrentUTCTime();
        }
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

    async loadData() {
        if (!this.selectedDate) {
            this.setStatus('Please select a date', 'error');
            return;
        }

        this.setStatus('Loading...', 'info');

        try {
            let url = `/api/spaceweather/history?date=${this.selectedDate}`;

            // Add query parameters based on mode
            if (this.currentMode === 'single') {
                const timeInput = document.getElementById('time-input');
                if (timeInput.value) {
                    url += `&time=${timeInput.value}:00`;
                } else {
                    this.setStatus('Please enter a time', 'error');
                    return;
                }
            } else if (this.currentMode === 'range') {
                const fromTimeInput = document.getElementById('from-time-input');
                const toTimeInput = document.getElementById('to-time-input');
                
                if (fromTimeInput.value) {
                    url += `&from=${fromTimeInput.value}:00`;
                }
                if (toTimeInput.value) {
                    url += `&to=${toTimeInput.value}:00`;
                }
            }

            const response = await fetch(url);

            if (response.status === 429) {
                const errorData = await response.json();
                this.setStatus('Rate limit exceeded. Please wait 2.5 seconds and try again.', 'error');
                return;
            }

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to load data');
            }

            const data = await response.json();

            if (!data || data.length === 0) {
                this.setStatus('No data available for the selected date/time', 'info');
                document.getElementById('data-container').style.display = 'none';
                return;
            }

            this.displayData(data);
            this.setStatus(`Loaded ${data.length} record${data.length > 1 ? 's' : ''}`, 'success');
        } catch (error) {
            console.error('Error loading data:', error);
            this.setStatus(`Error: ${error.message}`, 'error');
            document.getElementById('data-container').style.display = 'none';
        }
    }

    displayData(data) {
        const container = document.getElementById('data-container');
        const content = document.getElementById('data-content');
        const title = document.getElementById('data-title');

        if (!container || !content) return;

        // Update title based on mode and data count
        if (data.length === 1) {
            const timestamp = new Date(data[0].timestamp);
            title.textContent = `Space Weather Data - ${timestamp.toLocaleString('en-GB', { 
                dateStyle: 'medium', 
                timeStyle: 'short',
                hour12: false 
            })} UTC`;
        } else {
            title.textContent = `Space Weather Data - ${data.length} Records`;
        }

        // If single record, display detailed view
        if (data.length === 1) {
            content.innerHTML = this.renderSingleRecord(data[0]);
        } else {
            // Multiple records - show chart and summary
            content.innerHTML = this.renderMultipleRecords(data);
            this.createChart(data);
            this.createBandConditionsChart(data);
        }

        container.style.display = 'block';
    }

    renderSingleRecord(record) {
        const qualityColor = record.propagation_quality === 'Excellent' ? '#22c55e' :
                            record.propagation_quality === 'Good' ? '#fbbf24' :
                            record.propagation_quality === 'Fair' ? '#ff9800' : '#ef4444';

        let html = '<div class="data-grid">';

        // Key metrics
        html += `<div class="data-card">
                    <h3>Solar Flux</h3>
                    <div class="data-value">${record.solar_flux.toFixed(0)}</div>
                    <div class="data-label">SFU</div>
                 </div>`;

        html += `<div class="data-card">
                    <h3>K-Index</h3>
                    <div class="data-value">${record.k_index}</div>
                    <div class="data-label">${record.k_index_status}</div>
                 </div>`;

        html += `<div class="data-card">
                    <h3>A-Index</h3>
                    <div class="data-value">${record.a_index}</div>
                    <div class="data-label">Planetary</div>
                 </div>`;

        html += `<div class="data-card">
                    <h3>Solar Wind Bz</h3>
                    <div class="data-value">${record.solar_wind_bz.toFixed(1)}</div>
                    <div class="data-label">nT (${record.solar_wind_bz < 0 ? 'Southward' : 'Northward'})</div>
                 </div>`;

        html += `<div class="data-card">
                    <h3>Propagation Quality</h3>
                    <div class="data-value" style="color: ${qualityColor};">${record.propagation_quality}</div>
                    <div class="data-label">Overall HF</div>
                 </div>`;

        html += '</div>';

        // Forecast section
        if (record.forecast) {
            html += '<div class="data-card" style="margin-top: 20px;">';
            html += '<h3>24-Hour Forecast</h3>';
            html += `<div style="margin-top: 10px; line-height: 1.8;">`;
            html += `<div><strong>Geomagnetic Storm:</strong> ${record.forecast.geomagnetic_storm}</div>`;
            html += `<div><strong>Radio Blackout:</strong> ${record.forecast.radio_blackout}</div>`;
            html += `<div><strong>Solar Radiation:</strong> ${record.forecast.solar_radiation}</div>`;
            if (record.forecast.summary) {
                html += `<div style="margin-top: 10px; padding: 10px; background: rgba(255,255,255,0.05); border-radius: 6px;">${record.forecast.summary}</div>`;
            }
            html += '</div></div>';
        }

        // Band conditions
        if (record.band_conditions_day && record.band_conditions_night) {
            html += '<div class="band-conditions">';
            html += '<h3 style="margin-bottom: 10px;">Band Conditions</h3>';
            
            const bandOrder = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];
            
            // Day conditions
            html += '<div style="margin-bottom: 15px;">';
            html += '<div style="font-size: 0.9em; opacity: 0.8; margin-bottom: 8px;">☀️ Day</div>';
            html += '<div class="band-row">';
            bandOrder.forEach(band => {
                if (record.band_conditions_day[band]) {
                    const condition = record.band_conditions_day[band].toLowerCase();
                    html += `<span class="band-badge ${condition}">${band}</span>`;
                }
            });
            html += '</div></div>';
            
            // Night conditions
            html += '<div>';
            html += '<div style="font-size: 0.9em; opacity: 0.8; margin-bottom: 8px;">🌙 Night</div>';
            html += '<div class="band-row">';
            bandOrder.forEach(band => {
                if (record.band_conditions_night[band]) {
                    const condition = record.band_conditions_night[band].toLowerCase();
                    html += `<span class="band-badge ${condition}">${band}</span>`;
                }
            });
            html += '</div></div>';
            
            html += '</div>';
        }

        return html;
    }

    renderMultipleRecords(data) {
        let html = '<div style="margin-bottom: 20px;">';
        html += `<div style="text-align: center; padding: 15px; background: rgba(255,255,255,0.05); border-radius: 8px;">`;
        html += `<div style="font-size: 1.2em; font-weight: bold; margin-bottom: 10px;">Summary Statistics</div>`;
        html += '<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px;">';
        
        // Calculate averages
        const avgSolarFlux = data.reduce((sum, r) => sum + r.solar_flux, 0) / data.length;
        const avgKIndex = data.reduce((sum, r) => sum + r.k_index, 0) / data.length;
        const avgAIndex = data.reduce((sum, r) => sum + r.a_index, 0) / data.length;
        const avgBz = data.reduce((sum, r) => sum + r.solar_wind_bz, 0) / data.length;
        
        html += `<div><div style="font-size: 0.8em; opacity: 0.7;">Avg Solar Flux</div><div style="font-size: 1.3em; font-weight: bold;">${avgSolarFlux.toFixed(0)} SFU</div></div>`;
        html += `<div><div style="font-size: 0.8em; opacity: 0.7;">Avg K-Index</div><div style="font-size: 1.3em; font-weight: bold;">${avgKIndex.toFixed(1)}</div></div>`;
        html += `<div><div style="font-size: 0.8em; opacity: 0.7;">Avg A-Index</div><div style="font-size: 1.3em; font-weight: bold;">${avgAIndex.toFixed(0)}</div></div>`;
        html += `<div><div style="font-size: 0.8em; opacity: 0.7;">Avg Bz</div><div style="font-size: 1.3em; font-weight: bold;">${avgBz.toFixed(1)} nT</div></div>`;
        
        html += '</div></div></div>';
        
        // Chart container
        html += '<div style="background: rgba(255,255,255,0.05); border-radius: 8px; padding: 20px; margin-bottom: 20px;">';
        html += '<canvas id="history-chart"></canvas>';
        html += '</div>';
        
        // Band conditions chart container
        html += '<div style="background: rgba(255,255,255,0.05); border-radius: 8px; padding: 20px;">';
        html += '<h3 style="margin-bottom: 15px;">Band Conditions Over Time</h3>';
        html += '<div style="margin-bottom: 10px; font-size: 0.9em; opacity: 0.8;">Day conditions (based on solar activity and propagation quality)</div>';
        html += '<canvas id="band-conditions-chart"></canvas>';
        html += '</div>';
        
        return html;
    }

    createChart(data) {
        const ctx = document.getElementById('history-chart');
        if (!ctx) return;

        // Destroy existing chart
        if (this.chart) {
            this.chart.destroy();
            this.chart = null;
        }

        // Prepare data
        const timestamps = data.map(d => new Date(d.timestamp));
        const solarFlux = data.map(d => d.solar_flux);
        const kIndex = data.map(d => d.k_index);
        const aIndex = data.map(d => d.a_index);
        const solarWindBz = data.map(d => d.solar_wind_bz);

        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: timestamps,
                datasets: [
                    {
                        label: 'Solar Flux (SFU)',
                        data: solarFlux,
                        borderColor: '#fbbf24',
                        backgroundColor: 'rgba(251, 191, 36, 0.1)',
                        yAxisID: 'y',
                        tension: 0.4
                    },
                    {
                        label: 'K-Index',
                        data: kIndex,
                        borderColor: '#ef4444',
                        backgroundColor: 'rgba(239, 68, 68, 0.1)',
                        yAxisID: 'y1',
                        tension: 0.4
                    },
                    {
                        label: 'A-Index',
                        data: aIndex,
                        borderColor: '#ff9800',
                        backgroundColor: 'rgba(255, 152, 0, 0.1)',
                        yAxisID: 'y1',
                        tension: 0.4
                    },
                    {
                        label: 'Solar Wind Bz (nT)',
                        data: solarWindBz,
                        borderColor: '#22c55e',
                        backgroundColor: 'rgba(34, 197, 94, 0.1)',
                        yAxisID: 'y2',
                        tension: 0.4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                aspectRatio: 2.5,
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                plugins: {
                    title: {
                        display: true,
                        text: 'Space Weather Metrics Over Time',
                        color: '#fff',
                        font: { size: 16 }
                    },
                    legend: {
                        labels: { color: '#fff' }
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
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
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
                        ticks: { color: '#fff' },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    },
                    y: {
                        type: 'linear',
                        display: true,
                        position: 'left',
                        title: {
                            display: true,
                            text: 'Solar Flux (SFU)',
                            color: '#fbbf24'
                        },
                        ticks: { color: '#fbbf24' },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    },
                    y1: {
                        type: 'linear',
                        display: true,
                        position: 'right',
                        title: {
                            display: true,
                            text: 'K/A Index',
                            color: '#ef4444'
                        },
                        ticks: { color: '#ef4444' },
                        grid: { drawOnChartArea: false }
                    },
                    y2: {
                        type: 'linear',
                        display: true,
                        position: 'right',
                        title: {
                            display: true,
                            text: 'Bz (nT)',
                            color: '#22c55e'
                        },
                        ticks: { color: '#22c55e' },
                        grid: { drawOnChartArea: false }
                    }
                }
            }
        });
    }
    createBandConditionsChart(data) {
        const ctx = document.getElementById('band-conditions-chart');
        if (!ctx) return;

        // Destroy existing chart
        if (this.bandConditionsChart) {
            this.bandConditionsChart.destroy();
            this.bandConditionsChart = null;
        }

        // Band order from lowest to highest frequency
        const bandOrder = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];
        const bandToNumber = {
            '160m': 1, '80m': 2, '60m': 3, '40m': 4, '30m': 5,
            '20m': 6, '17m': 7, '15m': 8, '12m': 9, '10m': 10
        };

        // Quality to numeric value mapping
        const qualityToValue = {
            'poor': 1,
            'fair': 2,
            'good': 3,
            'excellent': 4
        };

        // Quality to color mapping
        const qualityToColor = {
            'poor': '#ef4444',
            'fair': '#ff9800',
            'good': '#fbbf24',
            'excellent': '#22c55e'
        };

        // Prepare scatter plot data - one dataset per quality level
        const datasets = {
            'excellent': { label: 'Excellent', data: [], backgroundColor: qualityToColor.excellent },
            'good': { label: 'Good', data: [], backgroundColor: qualityToColor.good },
            'fair': { label: 'Fair', data: [], backgroundColor: qualityToColor.fair },
            'poor': { label: 'Poor', data: [], backgroundColor: qualityToColor.poor }
        };

        // Process each record
        data.forEach(record => {
            const timestamp = new Date(record.timestamp);
            
            // Process day conditions
            if (record.band_conditions_day) {
                bandOrder.forEach(band => {
                    const condition = record.band_conditions_day[band];
                    if (condition) {
                        const quality = condition.toLowerCase();
                        const bandNum = bandToNumber[band];
                        
                        if (datasets[quality]) {
                            datasets[quality].data.push({
                                x: timestamp,
                                y: bandNum
                            });
                        }
                    }
                });
            }
        });

        // Convert datasets object to array, filtering out empty datasets
        const chartDatasets = Object.values(datasets)
            .filter(ds => ds.data.length > 0)
            .map(ds => ({
                ...ds,
                pointRadius: 4,
                pointHoverRadius: 6
            }));

        this.bandConditionsChart = new Chart(ctx, {
            type: 'scatter',
            data: {
                datasets: chartDatasets
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                aspectRatio: 2.5,
                interaction: {
                    mode: 'nearest',
                    intersect: true
                },
                plugins: {
                    legend: {
                        labels: { color: '#fff' }
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
                                const bandNum = context.parsed.y;
                                const band = Object.keys(bandToNumber).find(k => bandToNumber[k] === bandNum);
                                return `${band}: ${context.dataset.label}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
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
                        ticks: { color: '#fff' },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    },
                    y: {
                        type: 'linear',
                        min: 0,
                        max: 11,
                        ticks: {
                            stepSize: 1,
                            color: '#fff',
                            autoSkip: false,
                            callback: function(value) {
                                // Map numeric values to band names - must match bandToNumber mapping
                                const numberToBand = {
                                    1: '160m', 2: '80m', 3: '60m', 4: '40m', 5: '30m',
                                    6: '20m', 7: '17m', 8: '15m', 9: '12m', 10: '10m'
                                };
                                return numberToBand[value] || '';
                            }
                        },
                        title: {
                            display: true,
                            text: 'Band',
                            color: '#fff'
                        },
                        grid: {
                            color: 'rgba(255, 255, 255, 0.1)',
                            drawTicks: true
                        }
                    }
                }
            }
        });
    }


    async downloadCSV() {
        if (!this.selectedDate) {
            this.setStatus('Please select a date', 'error');
            return;
        }

        // Build URL with parameters
        let url = `/api/spaceweather/csv?date=${this.selectedDate}`;

        // Add time range parameters if in range mode
        if (this.currentMode === 'range') {
            const fromTimeInput = document.getElementById('from-time-input');
            const toTimeInput = document.getElementById('to-time-input');
            
            if (fromTimeInput.value) {
                url += `&from=${fromTimeInput.value}:00`;
            }
            if (toTimeInput.value) {
                url += `&to=${toTimeInput.value}:00`;
            }
        }

        // Note: Single time mode doesn't make sense for CSV download, so we download all data for that date

        try {
            // Check if we can download (rate limit check)
            const response = await fetch(url, { method: 'HEAD' });
            if (response.status === 429) {
                this.setStatus('Rate limit exceeded. Please wait 2.5 seconds and try again.', 'error');
                return;
            }

            // Create a temporary link and trigger download
            const link = document.createElement('a');
            link.href = url;
            link.download = `spaceweather-${this.selectedDate}.csv`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            this.setStatus('CSV download started', 'success');
        } catch (error) {
            console.error('Error downloading CSV:', error);
            this.setStatus('Error starting CSV download', 'error');
        }
    }
}

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
    new SpaceWeatherHistory();
});
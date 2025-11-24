// CW Metrics Dashboard
// Displays comprehensive CW spot statistics with time-series graphs

class CWMetricsDashboard {
    constructor() {
        this.spotsChart = null;
        this.wpmChart = null;
        this.weekChart = null;
        this.monthChart = null;
        this.yearChart = null;
        this.summaryAutoRefreshInterval = null;
        this.BAND_COLORS = {
            '160m': 'rgba(139, 0, 0, 0.8)',
            '80m': 'rgba(255, 69, 0, 0.8)',
            '60m': 'rgba(255, 140, 0, 0.8)',
            '40m': 'rgba(255, 215, 0, 0.8)',
            '30m': 'rgba(154, 205, 50, 0.8)',
            '20m': 'rgba(0, 128, 0, 0.8)',
            '17m': 'rgba(0, 191, 255, 0.8)',
            '15m': 'rgba(30, 144, 255, 0.8)',
            '12m': 'rgba(138, 43, 226, 0.8)',
            '10m': 'rgba(148, 0, 211, 0.8)',
            '6m': 'rgba(255, 20, 147, 0.8)'
        };
        this.init();
        this.loadVersion();
        this.loadSkimmerNames();
        this.loadSummariesAndCharts();
        this.startSummaryAutoRefresh();
    }

    async loadSkimmerNames() {
        try {
            const response = await fetch('/api/cwskimmer/spots/names');
            if (response.ok) {
                const data = await response.json();
                const select = document.getElementById('skimmer-name');
                if (select && data.names) {
                    select.innerHTML = '<option value="">All Skimmers</option>';
                    data.names.forEach(name => {
                        const option = document.createElement('option');
                        option.value = name;
                        option.textContent = name;
                        select.appendChild(option);
                    });
                }
            }
        } catch (error) {
            console.error('Error loading skimmer names:', error);
        }
    }

    async loadVersion() {
        try {
            const response = await fetch('/api/description');
            if (response.ok) {
                const data = await response.json();
                const receiverNameEl = document.getElementById('receiver-name');
                if (receiverNameEl && data.receiver && data.receiver.name) {
                    receiverNameEl.textContent = `${data.receiver.name}`;
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

    init() {
        document.getElementById('load-btn').addEventListener('click', () => {
            this.loadMetrics();
        });

        document.getElementById('date-range-type').addEventListener('change', (e) => {
            this.toggleDateRangeInputs(e.target.value);
        });

        this.initializeDateInputs();
        this.toggleDateRangeInputs('hours');
    }

    toggleDateRangeInputs(type) {
        const quickSelect = document.getElementById('quick-select-controls');
        const customRangeFrom = document.getElementById('custom-range-controls');
        const customRangeTo = document.getElementById('custom-range-controls-to');

        if (type === 'hours') {
            quickSelect.style.display = 'block';
            customRangeFrom.style.display = 'none';
            customRangeTo.style.display = 'none';
        } else {
            quickSelect.style.display = 'none';
            customRangeFrom.style.display = 'block';
            customRangeTo.style.display = 'block';
        }
    }

    initializeDateInputs() {
        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        const formatForInput = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const hours = String(date.getHours()).padStart(2, '0');
            const minutes = String(date.getMinutes()).padStart(2, '0');
            return `${year}-${month}-${day}T${hours}:${minutes}`;
        };

        document.getElementById('date-from').value = formatForInput(yesterday);
        document.getElementById('date-to').value = formatForInput(now);
    }

    startSummaryAutoRefresh() {
        this.summaryAutoRefreshInterval = setInterval(() => {
            this.loadSummariesAndCharts();
        }, 10000);
    }

    async loadSummariesAndCharts() {
        const today = new Date();
        const todayStr = today.toISOString().split('T')[0];
        
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const monthStr = `${year}-${month}`;
        const yearStr = String(year);

        try {
            const [todayResponse, weekResponse, monthResponse, yearResponse] = await Promise.all([
                fetch(`/api/cwskimmer/metrics/summary?period=day&date=${todayStr}`),
                fetch(`/api/cwskimmer/metrics/summary?period=week&date=this-week`),
                fetch(`/api/cwskimmer/metrics/summary?period=month&date=${monthStr}`),
                fetch(`/api/cwskimmer/metrics/summary?period=year&date=${yearStr}`)
            ]);

            if (todayResponse.ok) {
                const todayData = await todayResponse.json();
                this.displaySummary('today-summary', todayData, 'day');
            } else {
                document.getElementById('today-summary').innerHTML = '<div style="opacity: 0.6;">No data available</div>';
            }

            if (weekResponse.ok) {
                const weekData = await weekResponse.json();
                this.updateWeekChart(weekData);
            }

            if (monthResponse.ok) {
                const monthData = await monthResponse.json();
                this.displaySummary('month-summary', monthData, 'month');
                this.updateMonthChart(monthData);
            } else {
                document.getElementById('month-summary').innerHTML = '<div style="opacity: 0.6;">No data available</div>';
            }

            if (yearResponse.ok) {
                const yearData = await yearResponse.json();
                this.displaySummary('year-summary', yearData, 'year');
                this.updateYearChart(yearData);
            } else {
                document.getElementById('year-summary').innerHTML = '<div style="opacity: 0.6;">No data available</div>';
            }
        } catch (error) {
            console.error('Error loading summaries:', error);
            document.getElementById('today-summary').innerHTML = '<div style="opacity: 0.6;">Error loading data</div>';
            document.getElementById('month-summary').innerHTML = '<div style="opacity: 0.6;">Error loading data</div>';
            document.getElementById('year-summary').innerHTML = '<div style="opacity: 0.6;">Error loading data</div>';
        }
    }

    displaySummary(elementId, data, period) {
        const element = document.getElementById(elementId);
        if (!element) return;

        let html = '';
        let totalSpots = 0;
        const bandBreakdown = {};

        if (data.summaries && data.summaries.length > 0) {
            data.summaries.forEach(summary => {
                totalSpots += summary.total_spots;
                if (!bandBreakdown[summary.band]) {
                    bandBreakdown[summary.band] = 0;
                }
                bandBreakdown[summary.band] += summary.total_spots;
            });

            html += `<div class="metric-row"><span class="metric-label">Total Spots:</span><span class="metric-value">${totalSpots.toLocaleString()}</span></div>`;
            
            html += '<div style="margin-top: 10px; font-size: 0.85em; opacity: 0.8;">By Band:</div>';
            Object.entries(bandBreakdown)
                .sort((a, b) => b[1] - a[1])
                .forEach(([band, count]) => {
                    html += `<div class="metric-row"><span class="metric-label">${band}:</span><span class="metric-value">${count.toLocaleString()}</span></div>`;
                });
        } else {
            html = '<div style="opacity: 0.6;">No spots recorded yet</div>';
        }

        element.innerHTML = html;
    }

    updateWeekChart(data) {
        try {
            if (!data.summaries || data.summaries.length === 0) return;

            const dailyData = {};
            data.summaries.forEach(summary => {
                if (summary.daily_breakdown) {
                    summary.daily_breakdown.forEach(day => {
                        const date = day.date;
                        if (!dailyData[date]) dailyData[date] = {};
                        if (!dailyData[date][summary.band]) dailyData[date][summary.band] = 0;
                        dailyData[date][summary.band] += day.spots;
                    });
                }
            });

            const dates = Object.keys(dailyData).sort();
            const labels = dates.map(d => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
            
            const allBands = new Set();
            Object.values(dailyData).forEach(dayData => {
                Object.keys(dayData).forEach(band => allBands.add(band));
            });

            const datasets = Array.from(allBands).map(band => ({
                label: band,
                data: dates.map(date => dailyData[date][band] || 0),
                backgroundColor: this.BAND_COLORS[band] || 'rgba(128, 128, 128, 0.8)',
                borderColor: (this.BAND_COLORS[band] || 'rgba(128, 128, 128, 0.8)').replace('0.8', '1'),
                borderWidth: 1
            }));

            if (this.weekChart) {
                this.weekChart.data.labels = labels;
                this.weekChart.data.datasets = datasets;
                this.weekChart.update('none');
            } else {
                const ctx = document.getElementById('week-chart').getContext('2d');
                this.weekChart = new Chart(ctx, {
                    type: 'bar',
                    data: { labels, datasets },
                    options: {
                        responsive: true,
                        maintainAspectRatio: true,
                        animation: { duration: 0 },
                        scales: {
                            x: { stacked: true, ticks: { color: '#fff' }, grid: { color: 'rgba(255, 255, 255, 0.1)' } },
                            y: { stacked: true, beginAtZero: true, ticks: { color: '#fff', callback: v => v.toLocaleString() }, grid: { color: 'rgba(255, 255, 255, 0.1)' } }
                        },
                        plugins: {
                            legend: { position: 'top', labels: { color: '#fff' } },
                            tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString()}` } }
                        }
                    }
                });
            }
        } catch (error) {
            console.error('Error loading week chart:', error);
        }
    }

    updateMonthChart(data) {
        try {
            if (!data.summaries || data.summaries.length === 0) return;

            const dailyData = {};
            data.summaries.forEach(summary => {
                if (summary.daily_breakdown) {
                    summary.daily_breakdown.forEach(day => {
                        const date = day.date;
                        if (!dailyData[date]) dailyData[date] = {};
                        if (!dailyData[date][summary.band]) dailyData[date][summary.band] = 0;
                        dailyData[date][summary.band] += day.spots;
                    });
                }
            });

            const dates = Object.keys(dailyData).sort();
            const labels = dates.map(d => new Date(d).getDate());
            
            const allBands = new Set();
            Object.values(dailyData).forEach(dayData => {
                Object.keys(dayData).forEach(band => allBands.add(band));
            });

            const datasets = Array.from(allBands).map(band => ({
                label: band,
                data: dates.map(date => dailyData[date][band] || 0),
                backgroundColor: this.BAND_COLORS[band] || 'rgba(128, 128, 128, 0.8)',
                borderColor: (this.BAND_COLORS[band] || 'rgba(128, 128, 128, 0.8)').replace('0.8', '1'),
                borderWidth: 1
            }));

            if (this.monthChart) {
                this.monthChart.data.labels = labels;
                this.monthChart.data.datasets = datasets;
                this.monthChart.update('none');
            } else {
                const ctx = document.getElementById('month-chart').getContext('2d');
                this.monthChart = new Chart(ctx, {
                    type: 'bar',
                    data: { labels, datasets },
                    options: {
                        responsive: true,
                        maintainAspectRatio: true,
                        animation: { duration: 0 },
                        scales: {
                            x: { stacked: true, title: { display: true, text: 'Day of Month', color: '#fff' }, ticks: { color: '#fff' }, grid: { color: 'rgba(255, 255, 255, 0.1)' } },
                            y: { stacked: true, beginAtZero: true, ticks: { color: '#fff', callback: v => v.toLocaleString() }, grid: { color: 'rgba(255, 255, 255, 0.1)' } }
                        },
                        plugins: {
                            legend: { position: 'top', labels: { color: '#fff' } },
                            tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString()}` } }
                        }
                    }
                });
            }
        } catch (error) {
            console.error('Error loading month chart:', error);
        }
    }

    updateYearChart(data) {
        try {
            if (!data.summaries || data.summaries.length === 0) return;

            const today = new Date();
            const year = today.getFullYear();
            const monthlyData = {};

            data.summaries.forEach(summary => {
                if (summary.monthly_breakdown && summary.monthly_breakdown.length > 0) {
                    summary.monthly_breakdown.forEach(month => {
                        const monthKey = month.month;
                        if (!monthlyData[monthKey]) monthlyData[monthKey] = {};
                        if (!monthlyData[monthKey][summary.band]) monthlyData[monthKey][summary.band] = 0;
                        monthlyData[monthKey][summary.band] += month.spots;
                    });
                }
            });

            data.summaries.forEach(summary => {
                if (!summary.monthly_breakdown || summary.monthly_breakdown.length === 0) {
                    const currentMonth = `${year}-${String(today.getMonth() + 1).padStart(2, '0')}`;
                    if (!monthlyData[currentMonth]) monthlyData[currentMonth] = {};
                    if (!monthlyData[currentMonth][summary.band]) monthlyData[currentMonth][summary.band] = 0;
                    monthlyData[currentMonth][summary.band] += summary.total_spots;
                }
            });

            const monthLabels = [];
            const allBands = new Set();
            
            Object.values(monthlyData).forEach(monthData => {
                Object.keys(monthData).forEach(band => allBands.add(band));
            });

            const monthlyDataArrays = {};
            allBands.forEach(band => { monthlyDataArrays[band] = []; });

            for (let month = 1; month <= 12; month++) {
                const monthKey = `${year}-${String(month).padStart(2, '0')}`;
                monthLabels.push(new Date(year, month - 1).toLocaleDateString('en-US', { month: 'short' }));
                const monthData = monthlyData[monthKey] || {};
                allBands.forEach(band => {
                    monthlyDataArrays[band].push(monthData[band] || 0);
                });
            }

            const datasets = Array.from(allBands).map(band => ({
                label: band,
                data: monthlyDataArrays[band],
                backgroundColor: this.BAND_COLORS[band] || 'rgba(128, 128, 128, 0.8)',
                borderColor: (this.BAND_COLORS[band] || 'rgba(128, 128, 128, 0.8)').replace('0.8', '1'),
                borderWidth: 1
            }));

            if (this.yearChart) {
                this.yearChart.data.labels = monthLabels;
                this.yearChart.data.datasets = datasets;
                this.yearChart.update('none');
            } else {
                const ctx = document.getElementById('year-chart').getContext('2d');
                this.yearChart = new Chart(ctx, {
                    type: 'bar',
                    data: { labels: monthLabels, datasets },
                    options: {
                        responsive: true,
                        maintainAspectRatio: true,
                        animation: { duration: 0 },
                        scales: {
                            x: { stacked: true, ticks: { color: '#fff' }, grid: { color: 'rgba(255, 255, 255, 0.1)' } },
                            y: { stacked: true, beginAtZero: true, ticks: { color: '#fff', callback: v => v.toLocaleString() }, grid: { color: 'rgba(255, 255, 255, 0.1)' } }
                        },
                        plugins: {
                            legend: { position: 'top', labels: { color: '#fff' } },
                            tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString()}` } }
                        }
                    }
                });
            }
        } catch (error) {
            console.error('Error loading year chart:', error);
        }
    }

    setStatus(message, type = 'info') {
        const status = document.getElementById('status');
        status.textContent = message;
        status.className = 'status';
        if (type === 'error') status.classList.add('error');
        else if (type === 'success') status.classList.add('success');
    }

    async loadMetrics() {
        const skimmerName = document.getElementById('skimmer-name').value;
        const interval = document.getElementById('interval').value;
        const dateRangeType = document.getElementById('date-range-type').value;

        const params = new URLSearchParams();
        if (skimmerName) params.append('band', skimmerName);
        params.append('timeseries', 'true');
        params.append('interval', interval);

        if (dateRangeType === 'hours') {
            const hours = document.getElementById('hours').value;
            params.append('hours', hours);
        } else {
            const fromInput = document.getElementById('date-from').value;
            const toInput = document.getElementById('date-to').value;

            if (fromInput && toInput) {
                const fromDate = new Date(fromInput);
                const toDate = new Date(toInput);

                if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
                    this.setStatus('Invalid date format', 'error');
                    return;
                }

                if (fromDate >= toDate) {
                    this.setStatus('Start date must be before end date', 'error');
                    return;
                }

                params.append('from', fromDate.toISOString());
                params.append('to', toDate.toISOString());
            } else {
                this.setStatus('Please select both start and end dates', 'error');
                return;
            }
        }

        const url = `/api/cwskimmer/metrics?${params.toString()}`;
        
        document.getElementById('loading').style.display = 'block';
        this.setStatus('Loading metrics...', 'info');

        try {
            const response = await fetch(url);
            
            if (response.status === 429) {
                this.setStatus('Rate limit exceeded. Please wait 2 seconds and try again.', 'error');
                return;
            }

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to load metrics');
            }

            const data = await response.json();

            if (!data.metrics || data.metrics.length === 0) {
                this.setStatus('No CW spot data available yet', 'info');
                document.getElementById('results').innerHTML = '';
                return;
            }

            this.displayMetrics(data);
            this.setStatus(`Loaded metrics for ${data.metrics.length} band(s)`, 'success');
        } catch (error) {
            console.error('Error loading metrics:', error);
            this.setStatus(`Error: ${error.message}`, 'error');
            document.getElementById('results').innerHTML = '';
        } finally {
            document.getElementById('loading').style.display = 'none';
        }
    }

    displayMetrics(data) {
        const results = document.getElementById('results');
        let html = '';

        // Summary section
        html += '<div class="chart-container">';
        html += '<h2>📈 Summary</h2>';
        html += '<div class="metrics-grid">';
        html += `<div class="metric-card">
                    <h3>Overview</h3>
                    <div class="metric-row"><span class="metric-label">Bands:</span><span class="metric-value">${data.summary.total_bands}</span></div>
                    <div class="metric-row"><span class="metric-label">Time Window:</span><span class="metric-value">${data.summary.time_window.hours}h</span></div>
                 </div>`;

        // Calculate totals
        const totalSpots24h = data.metrics.reduce((sum, m) => sum + m.spot_counts.last_24h, 0);
        const totalUnique24h = data.metrics.reduce((sum, m) => sum + m.unique_callsigns.last_24h, 0);
        const avgSpotsPerHour = data.metrics.reduce((sum, m) => sum + m.activity.spots_per_hour, 0) / data.metrics.length;

        html += `<div class="metric-card">
                    <h3>24-Hour Totals</h3>
                    <div class="metric-row"><span class="metric-label">Total Spots:</span><span class="metric-value">${totalSpots24h.toLocaleString()}</span></div>
                    <div class="metric-row"><span class="metric-label">Unique Callsigns:</span><span class="metric-value">${totalUnique24h.toLocaleString()}</span></div>
                    <div class="metric-row"><span class="metric-label">Avg Rate:</span><span class="metric-value">${avgSpotsPerHour.toFixed(1)}/hr</span></div>
                 </div>`;

        html += '</div></div>';

        // Time series chart
        if (data.time_series && data.time_series.length > 0) {
            html += '<div class="chart-container">';
            html += '<h2>📊 Spots Per Hour by Band</h2>';
            html += '<canvas id="spots-chart"></canvas>';
            html += '</div>';
        }

        // WPM time series chart
        if (data.wpm_time_series && data.wpm_time_series.length > 0) {
            html += '<div class="chart-container">';
            html += '<h2>⚡ Average WPM by Band</h2>';
            html += '<canvas id="wpm-chart"></canvas>';
            html += '</div>';
        }

        // Per band metrics
        html += '<div class="chart-container">';
        html += '<h2>📡 Detailed Metrics by Band</h2>';
        html += '<div class="metrics-grid">';

        data.metrics.forEach(metric => {
            html += '<div class="metric-card">';
            html += `<h3>${metric.band}</h3>`;
            
            html += '<div style="margin-top: 10px; font-size: 0.85em; opacity: 0.8;">Spot Counts</div>';
            html += `<div class="metric-row"><span class="metric-label">Last Hour:</span><span class="metric-value">${metric.spot_counts.last_1h}</span></div>`;
            html += `<div class="metric-row"><span class="metric-label">Last 24h:</span><span class="metric-value">${metric.spot_counts.last_24h}</span></div>`;
            
            html += '<div style="margin-top: 10px; font-size: 0.85em; opacity: 0.8;">Activity Rate</div>';
            html += `<div class="metric-row"><span class="metric-label">Spots/Hour:</span><span class="metric-value">${metric.activity.spots_per_hour.toFixed(1)}</span></div>`;
            html += `<div class="metric-row"><span class="metric-label">Callsigns/Hour:</span><span class="metric-value">${metric.activity.callsigns_per_hour.toFixed(1)}</span></div>`;
            html += `<div class="metric-row"><span class="metric-label">Activity Score:</span><span class="metric-value">${metric.activity.activity_score.toFixed(0)}%</span></div>`;
            
            html += '<div style="margin-top: 10px; font-size: 0.85em; opacity: 0.8;">Unique Callsigns</div>';
            html += `<div class="metric-row"><span class="metric-label">Last Hour:</span><span class="metric-value">${metric.unique_callsigns.last_1h}</span></div>`;
            html += `<div class="metric-row"><span class="metric-label">Last 24h:</span><span class="metric-value">${metric.unique_callsigns.last_24h}</span></div>`;
            
            html += '<div style="margin-top: 10px; font-size: 0.85em; opacity: 0.8;">WPM Statistics</div>';
            const wpm1m = metric.wpm_stats.last_1m;
            if (wpm1m && wpm1m.avg_wpm > 0) {
                html += '<div style="margin-top: 5px; font-size: 0.8em; opacity: 0.7;">Last 1 min:</div>';
                html += `<div class="metric-row"><span class="metric-label">Avg:</span><span class="metric-value">${wpm1m.avg_wpm.toFixed(1)} WPM</span></div>`;
                html += `<div class="metric-row"><span class="metric-label">Range:</span><span class="metric-value">${wpm1m.min_wpm}-${wpm1m.max_wpm} WPM</span></div>`;
            } else {
                html += `<div class="metric-row"><span class="metric-label">Status:</span><span class="metric-value" style="opacity: 0.6;">No recent WPM data</span></div>`;
            }
            
            html += '</div>';
        });

        html += '</div></div>';

        results.innerHTML = html;

        // Create charts if time series data exists
        if (data.time_series && data.time_series.length > 0) {
            this.createSpotsChart(data);
        }
        if (data.wpm_time_series && data.wpm_time_series.length > 0) {
            this.createWPMChart(data);
        }
    }

    createSpotsChart(data) {
        const ctx = document.getElementById('spots-chart');
        if (!ctx) return;

        if (this.spotsChart) {
            this.spotsChart.destroy();
            this.spotsChart = null;
        }

        const datasets = [];
        const seriesMap = new Map();
        
        data.time_series.forEach(point => {
            Object.entries(point.data).forEach(([band, value]) => {
                if (!seriesMap.has(band)) {
                    seriesMap.set(band, []);
                }
                seriesMap.get(band).push({
                    x: new Date(point.timestamp),
                    y: value.spot_count
                });
            });
        });

        seriesMap.forEach((points, band) => {
            datasets.push({
                label: band,
                data: points,
                borderColor: this.BAND_COLORS[band] || 'rgba(128, 128, 128, 0.8)',
                backgroundColor: (this.BAND_COLORS[band] || 'rgba(128, 128, 128, 0.8)') + '20',
                tension: 0.4,
                fill: false,
                pointRadius: 3,
                pointHoverRadius: 5
            });
        });

        this.spotsChart = new Chart(ctx, {
            type: 'line',
            data: { datasets },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                aspectRatio: 2.5,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    title: { display: true, text: 'Spot Count Over Time', color: '#fff', font: { size: 16 } },
                    legend: { labels: { color: '#fff' }, position: 'top' },
                    tooltip: {
                        callbacks: {
                            title: (items) => items.length ? new Date(items[0].parsed.x).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', hour12: false }) : '',
                            label: (context) => `${context.dataset.label}: ${context.parsed.y} spots`
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: { tooltipFormat: 'yyyy-MM-dd HH:mm' },
                        title: { display: true, text: 'Time (UTC)', color: '#fff' },
                        ticks: { color: '#fff', source: 'auto', maxRotation: 0, autoSkip: true },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    },
                    y: {
                        type: 'linear',
                        title: { display: true, text: 'Spots', color: '#fff' },
                        ticks: { color: '#fff' },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' },
                        beginAtZero: true
                    }
                }
            }
        });
    }

    createWPMChart(data) {
        const ctx = document.getElementById('wpm-chart');
        if (!ctx) return;

        if (this.wpmChart) {
            this.wpmChart.destroy();
            this.wpmChart = null;
        }

        const datasets = [];
        const seriesMap = new Map();
        
        data.wpm_time_series.forEach(point => {
            Object.entries(point.data).forEach(([band, value]) => {
                if (!seriesMap.has(band)) {
                    seriesMap.set(band, []);
                }
                seriesMap.get(band).push({
                    x: new Date(point.timestamp),
                    y: value.avg_wpm
                });
            });
        });

        seriesMap.forEach((points, band) => {
            datasets.push({
                label: band,
                data: points,
                borderColor: this.BAND_COLORS[band] || 'rgba(128, 128, 128, 0.8)',
                backgroundColor: (this.BAND_COLORS[band] || 'rgba(128, 128, 128, 0.8)') + '20',
                tension: 0.4,
                fill: false,
                pointRadius: 3,
                pointHoverRadius: 5
            });
        });

        this.wpmChart = new Chart(ctx, {
            type: 'line',
            data: { datasets },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                aspectRatio: 2.5,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    title: { display: true, text: 'Average WPM Over Time', color: '#fff', font: { size: 16 } },
                    legend: { labels: { color: '#fff' }, position: 'top' },
                    tooltip: {
                        callbacks: {
                            title: (items) => items.length ? new Date(items[0].parsed.x).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', hour12: false }) : '',
                            label: (context) => `${context.dataset.label}: ${context.parsed.y.toFixed(1)} WPM`
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: { tooltipFormat: 'yyyy-MM-dd HH:mm' },
                        title: { display: true, text: 'Time (UTC)', color: '#fff' },
                        ticks: { color: '#fff', source: 'auto', maxRotation: 0, autoSkip: true },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    },
                    y: {
                        type: 'linear',
                        title: { display: true, text: 'WPM', color: '#fff' },
                        ticks: { color: '#fff' },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' },
                        beginAtZero: true
                    }
                }
            }
        });
    }
}

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
    new CWMetricsDashboard();
});
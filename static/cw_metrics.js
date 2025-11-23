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
            
            html += '<div style="margin-top: 10px; font-size: 0.85em; opacity: 0.8;">Top Bands:</div>';
            Object.entries(bandBreakdown)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
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
        this.setStatus('CW metrics endpoint not yet implemented. Coming soon!', 'info');
        // TODO: Implement when backend endpoint is ready
    }
}

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
    new CWMetricsDashboard();
});
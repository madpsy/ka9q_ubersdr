// Decode Metrics Dashboard
// Displays comprehensive decode statistics with time-series graphs

class DecodeMetricsDashboard {
    constructor() {
        this.decodesChart = null;
        this.executionTimeChart = null;
        this.weekChart = null;
        this.monthChart = null;
        this.yearChart = null;
        this.weekBandChart = null;
        this.monthBandChart = null;
        this.yearBandChart = null;
        this.summaryAutoRefreshInterval = null; // Auto-refresh for summary data
        this.MODE_COLORS = {
            'FT8': 'rgba(54, 162, 235, 0.8)',
            'FT4': 'rgba(255, 159, 64, 0.8)',
            'WSPR': 'rgba(75, 192, 192, 0.8)'
        };
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
        this.colorCache = new Map(); // Cache for generated colors
        this.BAND_ORDER = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m'];
        this.init();
        this.loadVersion();
        this.loadDecoderNames(); // Load decoder band names
        this.loadSummariesAndCharts(); // Load summary statistics and charts
        this.startSummaryAutoRefresh(); // Start auto-refresh for summaries
        // Don't auto-load detailed metrics - user must click "Load Metrics" button
    }

    /**
     * Generate a consistent color for a band using a hash function
     * This ensures the same band always gets the same color across refreshes
     */
    hashStringToColor(str) {
        // Check cache first
        if (this.colorCache.has(str)) {
            return this.colorCache.get(str);
        }

        // Simple hash function
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
            hash = hash & hash; // Convert to 32-bit integer
        }

        // Generate RGB values from hash
        const r = (hash & 0xFF0000) >> 16;
        const g = (hash & 0x00FF00) >> 8;
        const b = hash & 0x0000FF;

        // Ensure colors are vibrant enough (avoid too dark colors)
        const minBrightness = 80;
        const adjustedR = Math.max(r, minBrightness);
        const adjustedG = Math.max(g, minBrightness);
        const adjustedB = Math.max(b, minBrightness);

        const color = `rgba(${adjustedR}, ${adjustedG}, ${adjustedB}, 0.8)`;

        // Cache the result
        this.colorCache.set(str, color);

        return color;
    }

    /**
     * Get color for a band - uses predefined colors if available,
     * otherwise generates a consistent color based on band name hash
     */
    getBandColor(band) {
        return this.BAND_COLORS[band] || this.hashStringToColor(band);
    }

    /**
     * Sort bands in the standard order (160m -> 10m -> 6m -> others)
     * Ensures consistent ordering across all charts
     */
    sortBands(bands) {
        return [...bands].sort((a, b) => {
            const indexA = this.BAND_ORDER.indexOf(a);
            const indexB = this.BAND_ORDER.indexOf(b);

            // If both bands are in the order list, sort by their position
            if (indexA !== -1 && indexB !== -1) {
                return indexA - indexB;
            }
            // If only A is in the list, it comes first
            if (indexA !== -1) return -1;
            // If only B is in the list, it comes first
            if (indexB !== -1) return 1;
            // If neither is in the list, sort alphabetically
            return a.localeCompare(b);
        });
    }

    async loadDecoderNames() {
        try {
            const response = await fetch('/api/decoder/band-names');
            if (response.ok) {
                const data = await response.json();
                const select = document.getElementById('decoder-name');
                if (select && data.band_names) {
                    // Clear existing options except "All Decoders"
                    select.innerHTML = '<option value="">All Decoders</option>';
                    // Add decoder names
                    data.band_names.forEach(name => {
                        const option = document.createElement('option');
                        option.value = name;
                        option.textContent = name;
                        select.appendChild(option);
                    });
                }
            }
        } catch (error) {
            console.error('Error loading decoder names:', error);
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

        // Handle date range type toggle
        document.getElementById('date-range-type').addEventListener('change', (e) => {
            this.toggleDateRangeInputs(e.target.value);
        });

        // Initialize datetime inputs with sensible defaults
        this.initializeDateInputs();

        // Initialize with quick select visible
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

        // Format for datetime-local input (YYYY-MM-DDTHH:MM)
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
        // Auto-refresh summary data every 10 seconds
        this.summaryAutoRefreshInterval = setInterval(() => {
            this.loadSummariesAndCharts();
        }, 10000);
    }

    async loadSummariesAndCharts() {
        const today = new Date();
        const todayStr = today.toISOString().split('T')[0]; // YYYY-MM-DD
        
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const monthStr = `${year}-${month}`;
        const yearStr = String(year);

        try {
            // Fetch all data in parallel
            const [todayResponse, weekResponse, monthResponse, yearResponse] = await Promise.all([
                fetch(`/api/decoder/metrics/summary?period=day&date=${todayStr}`),
                fetch(`/api/decoder/metrics/summary?period=week&date=this-week`),
                fetch(`/api/decoder/metrics/summary?period=month&date=${monthStr}`),
                fetch(`/api/decoder/metrics/summary?period=year&date=${yearStr}`)
            ]);

            // Process today's summary
            if (todayResponse.ok) {
                const todayData = await todayResponse.json();
                this.displaySummary('today-summary', todayData, 'day');
            } else {
                document.getElementById('today-summary').innerHTML = '<div style="opacity: 0.6;">No data available</div>';
            }

            // Process week charts
            if (weekResponse.ok) {
                const weekData = await weekResponse.json();
                this.updateWeekChart(weekData);
                this.updateWeekBandChart(weekData);
            }

            // Process month summary and charts
            if (monthResponse.ok) {
                const monthData = await monthResponse.json();
                this.displaySummary('month-summary', monthData, 'month');
                this.updateMonthChart(monthData);
                this.updateMonthBandChart(monthData);
            } else {
                document.getElementById('month-summary').innerHTML = '<div style="opacity: 0.6;">No data available</div>';
            }

            // Process year summary and charts
            if (yearResponse.ok) {
                const yearData = await yearResponse.json();
                this.displaySummary('year-summary', yearData, 'year');
                this.updateYearChart(yearData);
                this.updateYearBandChart(yearData);
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
        
        // Calculate totals across all modes and bands
        let totalSpots = 0;
        const modeBreakdown = {};
        const bandBreakdown = {};

        if (data.summaries && data.summaries.length > 0) {
            data.summaries.forEach(summary => {
                totalSpots += summary.total_spots;

                // Aggregate by mode
                if (!modeBreakdown[summary.mode]) {
                    modeBreakdown[summary.mode] = 0;
                }
                modeBreakdown[summary.mode] += summary.total_spots;

                // Aggregate by band
                if (!bandBreakdown[summary.band]) {
                    bandBreakdown[summary.band] = 0;
                }
                bandBreakdown[summary.band] += summary.total_spots;
            });

            // Display total
            html += `<div class="metric-row"><span class="metric-label">Total Spots:</span><span class="metric-value">${totalSpots.toLocaleString()}</span></div>`;
            
            // Display mode breakdown
            html += '<div style="margin-top: 10px; font-size: 0.85em; opacity: 0.8;">By Mode:</div>';
            Object.entries(modeBreakdown)
                .sort((a, b) => b[1] - a[1])
                .forEach(([mode, count]) => {
                    html += `<div class="metric-row"><span class="metric-label">${mode}:</span><span class="metric-value">${count.toLocaleString()}</span></div>`;
                });
            
            // Display top 5 bands
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
            if (!data.summaries || data.summaries.length === 0) {
                console.log('No weekly data available');
                return;
            }

            // Aggregate by mode across all bands for each day
            const dailyData = {};
            data.summaries.forEach(summary => {
                if (summary.daily_breakdown) {
                    summary.daily_breakdown.forEach(day => {
                        const date = day.date;
                        if (!dailyData[date]) {
                            dailyData[date] = { FT8: 0, FT4: 0, WSPR: 0, JS8: 0 };
                        }
                        if (dailyData[date][summary.mode] !== undefined) {
                            dailyData[date][summary.mode] += day.spots;
                        }
                    });
                }
            });

            // Sort dates and prepare chart data
            const dates = Object.keys(dailyData).sort();
            const labels = dates.map(d => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
            
            const datasets = Object.keys(this.MODE_COLORS).map(mode => ({
                label: mode,
                data: dates.map(date => dailyData[date][mode] || 0),
                backgroundColor: this.MODE_COLORS[mode],
                borderColor: this.MODE_COLORS[mode].replace('0.8', '1'),
                borderWidth: 1
            }));

            // Update existing chart if it exists, otherwise create new one
            if (this.weekChart) {
                // Preserve visibility state before updating
                const visibilityState = this.weekChart.data.datasets.map((dataset, index) => {
                    const meta = this.weekChart.getDatasetMeta(index);
                    return meta.hidden;
                });

                this.weekChart.data.labels = labels;
                this.weekChart.data.datasets = datasets;

                // Restore visibility state after updating
                this.weekChart.data.datasets.forEach((dataset, index) => {
                    if (index < visibilityState.length) {
                        const meta = this.weekChart.getDatasetMeta(index);
                        meta.hidden = visibilityState[index];
                    }
                });

                this.weekChart.update('none'); // 'none' animation mode for smooth update
            } else {
                const ctx = document.getElementById('week-chart').getContext('2d');
                this.weekChart = new Chart(ctx, {
                    type: 'bar',
                    data: { labels, datasets },
                    options: {
                        responsive: true,
                        maintainAspectRatio: true,
                        animation: {
                            duration: 0 // Disable animation for smoother updates
                        },
                        scales: {
                            x: {
                                stacked: true,
                                ticks: { color: '#fff' },
                                grid: { color: 'rgba(255, 255, 255, 0.1)' }
                            },
                            y: {
                                stacked: true,
                                beginAtZero: true,
                                ticks: {
                                    color: '#fff',
                                    callback: function(value) {
                                        return value.toLocaleString();
                                    }
                                },
                                grid: { color: 'rgba(255, 255, 255, 0.1)' }
                            }
                        },
                        plugins: {
                            legend: {
                                position: 'top',
                                labels: { color: '#fff' }
                            },
                            tooltip: {
                                callbacks: {
                                    label: function(context) {
                                        return `${context.dataset.label}: ${context.parsed.y.toLocaleString()}`;
                                    }
                                }
                            }
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
            if (!data.summaries || data.summaries.length === 0) {
                console.log('No monthly data available');
                return;
            }

            // Aggregate by mode across all bands for each day
            const dailyData = {};
            data.summaries.forEach(summary => {
                if (summary.daily_breakdown) {
                    summary.daily_breakdown.forEach(day => {
                        const date = day.date;
                        if (!dailyData[date]) {
                            dailyData[date] = { FT8: 0, FT4: 0, WSPR: 0, JS8: 0 };
                        }
                        if (dailyData[date][summary.mode] !== undefined) {
                            dailyData[date][summary.mode] += day.spots;
                        }
                    });
                }
            });

            // Sort dates and prepare chart data
            const dates = Object.keys(dailyData).sort();
            const labels = dates.map(d => new Date(d).getDate());
            
            const datasets = Object.keys(this.MODE_COLORS).map(mode => ({
                label: mode,
                data: dates.map(date => dailyData[date][mode] || 0),
                backgroundColor: this.MODE_COLORS[mode],
                borderColor: this.MODE_COLORS[mode].replace('0.8', '1'),
                borderWidth: 1
            }));

            // Update existing chart if it exists, otherwise create new one
            if (this.monthChart) {
                // Preserve visibility state before updating
                const visibilityState = this.monthChart.data.datasets.map((dataset, index) => {
                    const meta = this.monthChart.getDatasetMeta(index);
                    return meta.hidden;
                });

                this.monthChart.data.labels = labels;
                this.monthChart.data.datasets = datasets;

                // Restore visibility state after updating
                this.monthChart.data.datasets.forEach((dataset, index) => {
                    if (index < visibilityState.length) {
                        const meta = this.monthChart.getDatasetMeta(index);
                        meta.hidden = visibilityState[index];
                    }
                });

                this.monthChart.update('none'); // 'none' animation mode for smooth update
            } else {
                const ctx = document.getElementById('month-chart').getContext('2d');
                this.monthChart = new Chart(ctx, {
                    type: 'bar',
                    data: { labels, datasets },
                    options: {
                        responsive: true,
                        maintainAspectRatio: true,
                        animation: {
                            duration: 0 // Disable animation for smoother updates
                        },
                        scales: {
                            x: {
                                stacked: true,
                                title: { display: true, text: 'Day of Month', color: '#fff' },
                                ticks: { color: '#fff' },
                                grid: { color: 'rgba(255, 255, 255, 0.1)' }
                            },
                            y: {
                                stacked: true,
                                beginAtZero: true,
                                ticks: {
                                    color: '#fff',
                                    callback: function(value) {
                                        return value.toLocaleString();
                                    }
                                },
                                grid: { color: 'rgba(255, 255, 255, 0.1)' }
                            }
                        },
                        plugins: {
                            legend: {
                                position: 'top',
                                labels: { color: '#fff' }
                            },
                            tooltip: {
                                callbacks: {
                                    label: function(context) {
                                        return `${context.dataset.label}: ${context.parsed.y.toLocaleString()}`;
                                    }
                                }
                            }
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
            if (!data.summaries || data.summaries.length === 0) {
                console.log('No yearly data available');
                return;
            }

            const today = new Date();
            const year = today.getFullYear();

            // Aggregate by mode across all bands for each month
            const monthlyData = {};

            // First pass: collect all monthly_breakdown data
            data.summaries.forEach(summary => {
                if (summary.monthly_breakdown && summary.monthly_breakdown.length > 0) {
                    summary.monthly_breakdown.forEach(month => {
                        const monthKey = month.month;
                        if (!monthlyData[monthKey]) {
                            monthlyData[monthKey] = { FT8: 0, FT4: 0, WSPR: 0, JS8: 0 };
                        }
                        if (monthlyData[monthKey][summary.mode] !== undefined) {
                            monthlyData[monthKey][summary.mode] += month.spots;
                        }
                    });
                }
            });

            // Second pass: for summaries without monthly_breakdown, add total_spots to current month
            data.summaries.forEach(summary => {
                if (!summary.monthly_breakdown || summary.monthly_breakdown.length === 0) {
                    const currentMonth = `${year}-${String(today.getMonth() + 1).padStart(2, '0')}`;
                    if (!monthlyData[currentMonth]) {
                        monthlyData[currentMonth] = { FT8: 0, FT4: 0, WSPR: 0, JS8: 0 };
                    }
                    if (monthlyData[currentMonth][summary.mode] !== undefined) {
                        monthlyData[currentMonth][summary.mode] += summary.total_spots;
                    }
                }
            });

            console.log('Year chart monthly data:', monthlyData);

            // Create labels for all 12 months and prepare data
            const monthLabels = [];
            const monthlyDataArrays = { FT8: [], FT4: [], WSPR: [], JS8: [] };

            for (let month = 1; month <= 12; month++) {
                const monthKey = `${year}-${String(month).padStart(2, '0')}`;
                monthLabels.push(new Date(year, month - 1).toLocaleDateString('en-US', { month: 'short' }));

                // Use data if available, otherwise 0
                const monthData = monthlyData[monthKey] || { FT8: 0, FT4: 0, WSPR: 0, JS8: 0 };
                monthlyDataArrays.FT8.push(monthData.FT8);
                monthlyDataArrays.FT4.push(monthData.FT4);
                monthlyDataArrays.WSPR.push(monthData.WSPR);
                monthlyDataArrays.JS8.push(monthData.JS8);
            }

            const datasets = Object.keys(this.MODE_COLORS).map(mode => ({
                label: mode,
                data: monthlyDataArrays[mode],
                backgroundColor: this.MODE_COLORS[mode],
                borderColor: this.MODE_COLORS[mode].replace('0.8', '1'),
                borderWidth: 1
            }));

            // Update existing chart if it exists, otherwise create new one
            if (this.yearChart) {
                // Preserve visibility state before updating
                const visibilityState = this.yearChart.data.datasets.map((dataset, index) => {
                    const meta = this.yearChart.getDatasetMeta(index);
                    return meta.hidden;
                });

                this.yearChart.data.labels = monthLabels;
                this.yearChart.data.datasets = datasets;

                // Restore visibility state after updating
                this.yearChart.data.datasets.forEach((dataset, index) => {
                    if (index < visibilityState.length) {
                        const meta = this.yearChart.getDatasetMeta(index);
                        meta.hidden = visibilityState[index];
                    }
                });

                this.yearChart.update('none'); // 'none' animation mode for smooth update
            } else {
                const ctx = document.getElementById('year-chart').getContext('2d');
                this.yearChart = new Chart(ctx, {
                    type: 'bar',
                    data: { labels: monthLabels, datasets },
                    options: {
                        responsive: true,
                        maintainAspectRatio: true,
                        animation: {
                            duration: 0 // Disable animation for smoother updates
                        },
                        scales: {
                            x: {
                                stacked: true,
                                ticks: { color: '#fff' },
                                grid: { color: 'rgba(255, 255, 255, 0.1)' }
                            },
                            y: {
                                stacked: true,
                                beginAtZero: true,
                                ticks: {
                                    color: '#fff',
                                    callback: function(value) {
                                        return value.toLocaleString();
                                    }
                                },
                                grid: { color: 'rgba(255, 255, 255, 0.1)' }
                            }
                        },
                        plugins: {
                            legend: {
                                position: 'top',
                                labels: { color: '#fff' }
                            },
                            tooltip: {
                                callbacks: {
                                    label: function(context) {
                                        return `${context.dataset.label}: ${context.parsed.y.toLocaleString()}`;
                                    }
                                }
                            }
                        }
                    }
                });
            }
        } catch (error) {
            console.error('Error loading year chart:', error);
        }
    }

    updateWeekBandChart(data) {
        try {
            if (!data.summaries || data.summaries.length === 0) return;

            // Aggregate by band across all modes for each day
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

            const sortedBands = this.sortBands(Array.from(allBands));
            const datasets = sortedBands.map(band => {
                const color = this.getBandColor(band);
                return {
                    label: band,
                    data: dates.map(date => dailyData[date][band] || 0),
                    backgroundColor: color,
                    borderColor: color.replace('0.8', '1'),
                    borderWidth: 1
                };
            });

            if (this.weekBandChart) {
                // Preserve visibility state before updating
                const visibilityState = this.weekBandChart.data.datasets.map((dataset, index) => {
                    const meta = this.weekBandChart.getDatasetMeta(index);
                    return meta.hidden;
                });

                this.weekBandChart.data.labels = labels;
                this.weekBandChart.data.datasets = datasets;

                // Restore visibility state after updating
                this.weekBandChart.data.datasets.forEach((dataset, index) => {
                    if (index < visibilityState.length) {
                        const meta = this.weekBandChart.getDatasetMeta(index);
                        meta.hidden = visibilityState[index];
                    }
                });

                this.weekBandChart.update('none');
            } else {
                const ctx = document.getElementById('week-band-chart').getContext('2d');
                this.weekBandChart = new Chart(ctx, {
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
            console.error('Error loading week band chart:', error);
        }
    }

    updateMonthBandChart(data) {
        try {
            if (!data.summaries || data.summaries.length === 0) return;

            // Aggregate by band across all modes for each day
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

            const sortedBands = this.sortBands(Array.from(allBands));
            const datasets = sortedBands.map(band => {
                const color = this.getBandColor(band);
                return {
                    label: band,
                    data: dates.map(date => dailyData[date][band] || 0),
                    backgroundColor: color,
                    borderColor: color.replace('0.8', '1'),
                    borderWidth: 1
                };
            });

            if (this.monthBandChart) {
                // Preserve visibility state before updating
                const visibilityState = this.monthBandChart.data.datasets.map((dataset, index) => {
                    const meta = this.monthBandChart.getDatasetMeta(index);
                    return meta.hidden;
                });

                this.monthBandChart.data.labels = labels;
                this.monthBandChart.data.datasets = datasets;

                // Restore visibility state after updating
                this.monthBandChart.data.datasets.forEach((dataset, index) => {
                    if (index < visibilityState.length) {
                        const meta = this.monthBandChart.getDatasetMeta(index);
                        meta.hidden = visibilityState[index];
                    }
                });

                this.monthBandChart.update('none');
            } else {
                const ctx = document.getElementById('month-band-chart').getContext('2d');
                this.monthBandChart = new Chart(ctx, {
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
            console.error('Error loading month band chart:', error);
        }
    }

    updateYearBandChart(data) {
        try {
            if (!data.summaries || data.summaries.length === 0) return;

            const today = new Date();
            const year = today.getFullYear();
            const monthlyData = {};

            // Aggregate by band across all modes for each month
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

            // For summaries without monthly_breakdown, add to current month
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

            const sortedBands = this.sortBands(Array.from(allBands));
            const monthlyDataArrays = {};
            sortedBands.forEach(band => { monthlyDataArrays[band] = []; });

            for (let month = 1; month <= 12; month++) {
                const monthKey = `${year}-${String(month).padStart(2, '0')}`;
                monthLabels.push(new Date(year, month - 1).toLocaleDateString('en-US', { month: 'short' }));
                const monthData = monthlyData[monthKey] || {};
                sortedBands.forEach(band => {
                    monthlyDataArrays[band].push(monthData[band] || 0);
                });
            }

            const datasets = sortedBands.map(band => {
                const color = this.getBandColor(band);
                return {
                    label: band,
                    data: monthlyDataArrays[band],
                    backgroundColor: color,
                    borderColor: color.replace('0.8', '1'),
                    borderWidth: 1
                };
            });

            if (this.yearBandChart) {
                // Preserve visibility state before updating
                const visibilityState = this.yearBandChart.data.datasets.map((dataset, index) => {
                    const meta = this.yearBandChart.getDatasetMeta(index);
                    return meta.hidden;
                });

                this.yearBandChart.data.labels = monthLabels;
                this.yearBandChart.data.datasets = datasets;

                // Restore visibility state after updating
                this.yearBandChart.data.datasets.forEach((dataset, index) => {
                    if (index < visibilityState.length) {
                        const meta = this.yearBandChart.getDatasetMeta(index);
                        meta.hidden = visibilityState[index];
                    }
                });

                this.yearBandChart.update('none');
            } else {
                const ctx = document.getElementById('year-band-chart').getContext('2d');
                this.yearBandChart = new Chart(ctx, {
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
            console.error('Error loading year band chart:', error);
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

    async loadMetrics() {
        const decoderName = document.getElementById('decoder-name').value;
        const interval = document.getElementById('interval').value;
        const dateRangeType = document.getElementById('date-range-type').value;

        const params = new URLSearchParams();
        // Decoder name encompasses both mode and band, so use it as the band filter
        if (decoderName) params.append('band', decoderName);
        params.append('timeseries', 'true');
        params.append('interval', interval);

        // Handle date range based on type
        if (dateRangeType === 'hours') {
            // Quick select - use hours parameter
            const hours = document.getElementById('hours').value;
            params.append('hours', hours);
        } else {
            // Custom range - use from/to parameters
            const fromInput = document.getElementById('date-from').value;
            const toInput = document.getElementById('date-to').value;

            if (fromInput && toInput) {
                // Convert datetime-local format to ISO 8601 UTC
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

        const url = `/api/decoder/metrics?${params.toString()}`;
        
        document.getElementById('loading').style.display = 'block';
        this.setStatus('Loading metrics...', 'info');

        try {
            const response = await fetch(url);
            
            if (response.status === 429) {
                const errorData = await response.json();
                this.setStatus('Rate limit exceeded. Please wait 2 seconds and try again.', 'error');
                return;
            }

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to load metrics');
            }

            const data = await response.json();

            if (!data.metrics || data.metrics.length === 0) {
                this.setStatus('No decode data available yet', 'info');
                document.getElementById('results').innerHTML = '';
                return;
            }

            this.displayMetrics(data);
            this.setStatus(`Loaded metrics for ${data.metrics.length} mode/band combination(s)`, 'success');
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
                    <div class="metric-row"><span class="metric-label">Modes:</span><span class="metric-value">${data.summary.total_modes}</span></div>
                    <div class="metric-row"><span class="metric-label">Bands:</span><span class="metric-value">${data.summary.total_bands}</span></div>
                    <div class="metric-row"><span class="metric-label">Time Window:</span><span class="metric-value">${data.summary.time_window.hours}h</span></div>
                 </div>`;

        // Calculate totals
        const totalDecodes24h = data.metrics.reduce((sum, m) => sum + m.decode_counts.last_24h, 0);
        const totalUnique24h = data.metrics.reduce((sum, m) => sum + m.unique_callsigns.last_24h, 0);
        const avgDecodesPerHour = data.metrics.reduce((sum, m) => sum + m.activity.decodes_per_hour, 0) / data.metrics.length;

        html += `<div class="metric-card">
                    <h3>24-Hour Totals</h3>
                    <div class="metric-row"><span class="metric-label">Total Decodes:</span><span class="metric-value">${totalDecodes24h.toLocaleString()}</span></div>
                    <div class="metric-row"><span class="metric-label">Unique Callsigns:</span><span class="metric-value">${totalUnique24h.toLocaleString()}</span></div>
                    <div class="metric-row"><span class="metric-label">Avg Rate:</span><span class="metric-value">${avgDecodesPerHour.toFixed(1)}/hr</span></div>
                 </div>`;

        html += '</div></div>';

        // Time series chart
        if (data.time_series && data.time_series.length > 0) {
            html += '<div class="chart-container">';
            html += '<h2>📊 Decodes Per Hour by Band/Mode</h2>';
            html += '<canvas id="decodes-chart"></canvas>';
            html += '</div>';
        }

        // Execution time chart
        if (data.execution_time_series && data.execution_time_series.length > 0) {
            html += '<div class="chart-container">';
            html += '<h2>⚡ Decoder Execution Time by Band/Mode</h2>';
            html += '<canvas id="execution-time-chart"></canvas>';
            html += '</div>';
        }

        // Per mode/band metrics
        html += '<div class="chart-container">';
        html += '<h2>📡 Detailed Metrics by Mode/Band</h2>';
        html += '<div class="metrics-grid">';

        data.metrics.forEach(metric => {
            html += '<div class="metric-card">';
            html += `<h3>${metric.mode} on ${metric.band}</h3>`;
            
            html += '<div style="margin-top: 10px; font-size: 0.85em; opacity: 0.8;">Decode Counts</div>';
            html += `<div class="metric-row"><span class="metric-label">Last Hour:</span><span class="metric-value">${metric.decode_counts.last_1h}</span></div>`;
            html += `<div class="metric-row"><span class="metric-label">Last 24h:</span><span class="metric-value">${metric.decode_counts.last_24h}</span></div>`;
            
            html += '<div style="margin-top: 10px; font-size: 0.85em; opacity: 0.8;">Activity Rate</div>';
            html += `<div class="metric-row"><span class="metric-label">Decodes/Hour:</span><span class="metric-value">${metric.activity.decodes_per_hour.toFixed(1)}</span></div>`;
            html += `<div class="metric-row"><span class="metric-label">Callsigns/Hour:</span><span class="metric-value">${metric.activity.callsigns_per_hour.toFixed(1)}</span></div>`;
            html += `<div class="metric-row"><span class="metric-label">Activity Score:</span><span class="metric-value">${metric.activity.activity_score.toFixed(0)}%</span></div>`;
            
            html += '<div style="margin-top: 10px; font-size: 0.85em; opacity: 0.8;">Unique Callsigns</div>';
            html += `<div class="metric-row"><span class="metric-label">Last Hour:</span><span class="metric-value">${metric.unique_callsigns.last_1h}</span></div>`;
            html += `<div class="metric-row"><span class="metric-label">Last 24h:</span><span class="metric-value">${metric.unique_callsigns.last_24h}</span></div>`;
            
            // Always show decoder performance section
            html += '<div style="margin-top: 10px; font-size: 0.85em; opacity: 0.8;">Decoder Performance</div>';
            
            // Check if execution_time exists and has data - handle both snake_case and camelCase
            const execTime = metric.execution_time;
            if (execTime) {
                // Try last_1m first (snake_case from API)
                const time1m = execTime.last_1m || execTime.Last1Min;
                const time5m = execTime.last_5m || execTime.Last5Min;
                const time10m = execTime.last_10m || execTime.Last10Min;
                
                if (time1m && time1m.avg_seconds > 0) {
                    html += '<div style="margin-top: 5px; font-size: 0.8em; opacity: 0.7;">Last 1 min:</div>';
                    html += `<div class="metric-row"><span class="metric-label">Avg:</span><span class="metric-value">${time1m.avg_seconds.toFixed(3)}s</span></div>`;
                    html += `<div class="metric-row"><span class="metric-label">Min:</span><span class="metric-value">${time1m.min_seconds.toFixed(3)}s</span></div>`;
                    html += `<div class="metric-row"><span class="metric-label">Max:</span><span class="metric-value">${time1m.max_seconds.toFixed(3)}s</span></div>`;
                } else if (time5m && time5m.avg_seconds > 0) {
                    html += '<div style="margin-top: 5px; font-size: 0.8em; opacity: 0.7;">Last 5 min:</div>';
                    html += `<div class="metric-row"><span class="metric-label">Avg:</span><span class="metric-value">${time5m.avg_seconds.toFixed(3)}s</span></div>`;
                    html += `<div class="metric-row"><span class="metric-label">Min:</span><span class="metric-value">${time5m.min_seconds.toFixed(3)}s</span></div>`;
                    html += `<div class="metric-row"><span class="metric-label">Max:</span><span class="metric-value">${time5m.max_seconds.toFixed(3)}s</span></div>`;
                } else if (time10m && time10m.avg_seconds > 0) {
                    html += '<div style="margin-top: 5px; font-size: 0.8em; opacity: 0.7;">Last 10 min:</div>';
                    html += `<div class="metric-row"><span class="metric-label">Avg:</span><span class="metric-value">${time10m.avg_seconds.toFixed(3)}s</span></div>`;
                    html += `<div class="metric-row"><span class="metric-label">Min:</span><span class="metric-value">${time10m.min_seconds.toFixed(3)}s</span></div>`;
                    html += `<div class="metric-row"><span class="metric-label">Max:</span><span class="metric-value">${time10m.max_seconds.toFixed(3)}s</span></div>`;
                } else {
                    html += `<div class="metric-row"><span class="metric-label">Status:</span><span class="metric-value" style="opacity: 0.6;">No recent timing data</span></div>`;
                    console.log('Execution time structure for', metric.mode, metric.band, ':', execTime);
                }
                
                // Add warning if execution time is approaching limits
                const maxAllowed = metric.mode === 'FT4' ? 7 : (metric.mode === 'FT8' ? 15 : (metric.mode === 'WSPR' ? 120 : 0));
                const avgTime = (time1m && time1m.avg_seconds) ||
                               (time5m && time5m.avg_seconds) ||
                               (time10m && time10m.avg_seconds) || 0;
                if (maxAllowed > 0 && avgTime > 0) {
                    const percentOfMax = (avgTime / maxAllowed) * 100;
                    let statusColor = '#22c55e'; // green
                    let statusText = 'Good';
                    if (percentOfMax > 90) {
                        statusColor = '#ef4444'; // red
                        statusText = 'Critical';
                    } else if (percentOfMax > 75) {
                        statusColor = '#f59e0b'; // orange
                        statusText = 'Warning';
                    } else if (percentOfMax > 50) {
                        statusColor = '#eab308'; // yellow
                        statusText = 'Caution';
                    }
                    html += `<div class="metric-row"><span class="metric-label">Health:</span><span class="metric-value" style="color: ${statusColor};">${statusText} (${percentOfMax.toFixed(0)}% of ${maxAllowed}s)</span></div>`;
                }
            } else {
                // Debug: show what we have
                html += `<div class="metric-row"><span class="metric-label">Status:</span><span class="metric-value" style="opacity: 0.6;">No timing data in metrics</span></div>`;
                console.log('No execution_time field for', metric.mode, metric.band, '- Full metric:', metric);
            }
            
            html += '</div>';
        });

        html += '</div></div>';

        results.innerHTML = html;

        // Create charts if time series data exists
        if (data.time_series && data.time_series.length > 0) {
            this.createDecodesChart(data);
        }
        if (data.execution_time_series && data.execution_time_series.length > 0) {
            this.createExecutionTimeChart(data);
        }
    }

    createDecodesChart(data) {
        const ctx = document.getElementById('decodes-chart');
        if (!ctx) return;

        // Destroy existing chart
        if (this.decodesChart) {
            this.decodesChart.destroy();
            this.decodesChart = null;
        }

        // Prepare datasets - one line per mode/band combination
        const datasets = [];
        const colors = [
            '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16',
            '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9',
            '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
            '#ec4899', '#f43f5e'
        ];

        // Group data by mode:band
        const seriesMap = new Map();
        
        data.time_series.forEach(point => {
            Object.entries(point.data).forEach(([key, value]) => {
                if (!seriesMap.has(key)) {
                    seriesMap.set(key, []);
                }
                seriesMap.get(key).push({
                    x: new Date(point.timestamp),
                    y: value.decode_count
                });
            });
        });

        // Create dataset for each series
        let colorIndex = 0;
        seriesMap.forEach((points, key) => {
            const [mode, band] = key.split(':');
            datasets.push({
                label: `${mode} ${band}`,
                data: points,
                borderColor: colors[colorIndex % colors.length],
                backgroundColor: colors[colorIndex % colors.length] + '20',
                tension: 0.4,
                fill: false,
                pointRadius: 3,
                pointHoverRadius: 5
            });
            colorIndex++;
        });

        this.decodesChart = new Chart(ctx, {
            type: 'line',
            data: { datasets },
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
                        text: 'Decode Count Over Time',
                        color: '#fff',
                        font: { size: 16 }
                    },
                    legend: {
                        labels: { color: '#fff' },
                        position: 'top'
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
                                return `${context.dataset.label}: ${context.parsed.y} decodes`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            tooltipFormat: 'yyyy-MM-dd HH:mm'
                        },
                        title: {
                            display: true,
                            text: 'Time (UTC)',
                            color: '#fff'
                        },
                        ticks: {
                            color: '#fff',
                            source: 'auto',
                            maxRotation: 0,
                            autoSkip: true,
                            callback: function(value) {
                                const date = new Date(value);
                                return date.toLocaleTimeString('en-GB', {
                                    hour12: false,
                                    hour: '2-digit',
                                    minute: '2-digit'
                                });
                            }
                        },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    },
                    y: {
                        type: 'linear',
                        title: {
                            display: true,
                            text: 'Decodes',
                            color: '#fff'
                        },
                        ticks: { color: '#fff' },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' },
                        beginAtZero: true
                    }
                }
            }
        });
    }

    createExecutionTimeChart(data) {
        const ctx = document.getElementById('execution-time-chart');
        if (!ctx) return;

        // Destroy existing chart
        if (this.executionTimeChart) {
            this.executionTimeChart.destroy();
            this.executionTimeChart = null;
        }

        // Prepare datasets - one line per mode/band combination
        const datasets = [];
        const colors = [
            '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16',
            '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9',
            '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
            '#ec4899', '#f43f5e'
        ];

        // Group data by mode:band and track which modes are present
        const seriesMap = new Map();
        const modesPresent = new Set();

        data.execution_time_series.forEach(point => {
            Object.entries(point.data).forEach(([key, value]) => {
                if (!seriesMap.has(key)) {
                    seriesMap.set(key, []);
                }
                seriesMap.get(key).push({
                    x: new Date(point.timestamp),
                    y: value.avg_seconds
                });
                // Extract mode from key (format is "mode:band")
                const mode = key.split(':')[0];
                modesPresent.add(mode);
            });
        });

        // Create dataset for each series
        let colorIndex = 0;
        seriesMap.forEach((points, key) => {
            const [mode, band] = key.split(':');
            datasets.push({
                label: `${mode} ${band}`,
                data: points,
                borderColor: colors[colorIndex % colors.length],
                backgroundColor: colors[colorIndex % colors.length] + '20',
                tension: 0.4,
                fill: false,
                pointRadius: 3,
                pointHoverRadius: 5
            });
            colorIndex++;
        });

        // Add horizontal lines for maximum allowed execution times
        const annotations = {};
        if (modesPresent.has('FT4')) {
            annotations.ft4Max = {
                type: 'line',
                yMin: 7,
                yMax: 7,
                borderColor: 'rgba(255, 99, 132, 0.8)',
                borderWidth: 2,
                borderDash: [5, 5],
                label: {
                    display: true,
                    content: 'FT4 Max (7s)',
                    position: 'end',
                    backgroundColor: 'rgba(255, 99, 132, 0.8)',
                    color: '#fff'
                }
            };
        }
        if (modesPresent.has('FT8')) {
            annotations.ft8Max = {
                type: 'line',
                yMin: 15,
                yMax: 15,
                borderColor: 'rgba(255, 206, 86, 0.8)',
                borderWidth: 2,
                borderDash: [5, 5],
                label: {
                    display: true,
                    content: 'FT8 Max (15s)',
                    position: 'end',
                    backgroundColor: 'rgba(255, 206, 86, 0.8)',
                    color: '#fff'
                }
            };
        }
        if (modesPresent.has('WSPR')) {
            annotations.wsprMax = {
                type: 'line',
                yMin: 120,
                yMax: 120,
                borderColor: 'rgba(75, 192, 192, 0.8)',
                borderWidth: 2,
                borderDash: [5, 5],
                label: {
                    display: true,
                    content: 'WSPR Max (120s)',
                    position: 'end',
                    backgroundColor: 'rgba(75, 192, 192, 0.8)',
                    color: '#fff'
                }
            };
        }

        this.executionTimeChart = new Chart(ctx, {
            type: 'line',
            data: { datasets },
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
                        text: 'Decoder Execution Time Over Time',
                        color: '#fff',
                        font: { size: 16 }
                    },
                    legend: {
                        labels: { color: '#fff' },
                        position: 'top'
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
                                return `${context.dataset.label}: ${context.parsed.y.toFixed(3)}s`;
                            }
                        }
                    },
                    annotation: {
                        annotations: annotations
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            tooltipFormat: 'yyyy-MM-dd HH:mm'
                        },
                        title: {
                            display: true,
                            text: 'Time (UTC)',
                            color: '#fff'
                        },
                        ticks: {
                            color: '#fff',
                            source: 'auto',
                            maxRotation: 0,
                            autoSkip: true,
                            callback: function(value) {
                                const date = new Date(value);
                                return date.toLocaleTimeString('en-GB', {
                                    hour12: false,
                                    hour: '2-digit',
                                    minute: '2-digit'
                                });
                            }
                        },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    },
                    y: {
                        type: 'linear',
                        title: {
                            display: true,
                            text: 'Execution Time (seconds)',
                            color: '#fff'
                        },
                        ticks: {
                            color: '#fff',
                            callback: function(value) {
                                return value.toFixed(2) + 's';
                            }
                        },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' },
                        beginAtZero: true
                    }
                }
            }
        });
    }

    /**
     * Toggle all datasets in a chart on or off
     * @param {string} chartName - Name of the chart property (e.g., 'weekChart', 'monthBandChart')
     * @param {boolean} visible - true to show all, false to hide all
     */
    toggleAllDatasets(chartName, visible) {
        const chart = this[chartName];
        if (!chart) {
            console.error(`Chart ${chartName} not found`);
            return;
        }

        chart.data.datasets.forEach((dataset, index) => {
            const meta = chart.getDatasetMeta(index);
            meta.hidden = !visible;
        });

        chart.update();
    }
}

// Global dashboard instance for button access
let dashboard = null;

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
    dashboard = new DecodeMetricsDashboard();
});
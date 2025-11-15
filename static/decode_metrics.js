// Decode Metrics Dashboard
// Displays comprehensive decode statistics with time-series graphs

class DecodeMetricsDashboard {
    constructor() {
        this.decodesChart = null;
        this.executionTimeChart = null;
        this.autoRefreshInterval = null;
        this.autoRefreshEnabled = false;
        this.init();
        this.loadVersion();
        this.loadMetrics(); // Auto-load on page load
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

        document.getElementById('auto-refresh-btn').addEventListener('click', () => {
            this.toggleAutoRefresh();
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
        const customRange = document.getElementById('custom-range-controls');

        if (type === 'hours') {
            quickSelect.style.display = 'block';
            customRange.style.display = 'none';
        } else {
            quickSelect.style.display = 'none';
            customRange.style.display = 'block';
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

    toggleAutoRefresh() {
        this.autoRefreshEnabled = !this.autoRefreshEnabled;
        const btn = document.getElementById('auto-refresh-btn');
        
        if (this.autoRefreshEnabled) {
            btn.textContent = 'Auto-Refresh: ON';
            btn.style.background = '#22c55e';
            this.autoRefreshInterval = setInterval(() => {
                this.loadMetrics();
            }, 30000); // Refresh every 30 seconds
        } else {
            btn.textContent = 'Auto-Refresh: OFF';
            btn.style.background = '#2196F3';
            if (this.autoRefreshInterval) {
                clearInterval(this.autoRefreshInterval);
                this.autoRefreshInterval = null;
            }
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
        const mode = document.getElementById('mode').value;
        const band = document.getElementById('band').value;
        const interval = document.getElementById('interval').value;
        const dateRangeType = document.getElementById('date-range-type').value;

        const params = new URLSearchParams();
        if (mode) params.append('mode', mode);
        if (band) params.append('band', band);
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
}

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
    new DecodeMetricsDashboard();
});
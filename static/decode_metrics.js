// Decode Metrics Dashboard
// Displays comprehensive decode statistics with time-series graphs

class DecodeMetricsDashboard {
    constructor() {
        this.chart = null;
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
                    receiverNameEl.textContent = `${data.receiver.name} - Digital Mode Decode Statistics`;
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
        const hours = document.getElementById('hours').value;
        const interval = document.getElementById('interval').value;

        const params = new URLSearchParams();
        if (mode) params.append('mode', mode);
        if (band) params.append('band', band);
        params.append('hours', hours);
        params.append('timeseries', 'true');
        params.append('interval', interval);

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
            
            if (metric.execution_time.last_1m.avg > 0) {
                html += '<div style="margin-top: 10px; font-size: 0.85em; opacity: 0.8;">Decoder Performance</div>';
                html += `<div class="metric-row"><span class="metric-label">Avg Time:</span><span class="metric-value">${metric.execution_time.last_1m.avg.toFixed(2)}s</span></div>`;
            }
            
            html += '</div>';
        });

        html += '</div></div>';

        results.innerHTML = html;

        // Create chart if time series data exists
        if (data.time_series && data.time_series.length > 0) {
            this.createChart(data);
        }
    }

    createChart(data) {
        const ctx = document.getElementById('decodes-chart');
        if (!ctx) return;

        // Destroy existing chart
        if (this.chart) {
            this.chart.destroy();
            this.chart = null;
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

        this.chart = new Chart(ctx, {
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
}

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
    new DecodeMetricsDashboard();
});
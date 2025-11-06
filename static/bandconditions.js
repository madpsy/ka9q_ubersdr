// Band Conditions Monitor - Standalone Page
// Shows real-time band state chart for all bands

class BandConditionsMonitor {
    constructor() {
        this.bandStateChart = null;
        this.refreshInterval = null;
        this.countdownInterval = null;
        this.nextRefreshTime = null;
        this.trendDataCache = {};

        // Tableau 10 color palette
        this.bandColors = {
            '160m': '#4E79A7',
            '80m': '#F28E2B',
            '60m': '#E15759',
            '40m': '#76B7B2',
            '30m': '#59A14F',
            '20m': '#EDC948',
            '17m': '#B07AA1',
            '15m': '#FF9DA7',
            '12m': '#9C755F',
            '10m': '#BAB0AC'
        };

        this.init();
        this.setupResizeHandler();
        this.loadVersion();
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
                        receiverNameEl.textContent = data.receiver.name;
                    } else {
                        receiverNameEl.textContent = 'Band Conditions Monitor';
                    }
                }
            }
        } catch (error) {
            console.error('Error loading version:', error);
            // Set fallback text if fetch fails
            const receiverNameEl = document.getElementById('receiver-name');
            if (receiverNameEl) {
                receiverNameEl.textContent = 'Band Conditions Monitor';
            }
        }
    }

    setupResizeHandler() {
        // Handle window resize
        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                if (this.bandStateChart) {
                    this.bandStateChart.resize();
                }
            }, 250);
        });
    }

    sortBands(bands) {
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
        this.startAutoRefresh();
    }

    setStatus(message, type = 'info') {
        const status = document.getElementById('status');
        const countdown = document.getElementById('countdown');

        // Create a text node for the message
        const messageNode = document.createTextNode(message + ' ');

        // Clear and rebuild status content
        status.innerHTML = '';
        status.appendChild(messageNode);
        status.appendChild(countdown);

        status.className = 'status';
        if (type === 'error') {
            status.classList.add('error');
        } else if (type === 'success') {
            status.classList.add('success');
        }
    }

    updateCountdown() {
        const countdown = document.getElementById('countdown');
        if (!countdown || !this.nextRefreshTime) return;

        const now = Date.now();
        const remaining = Math.max(0, this.nextRefreshTime - now);
        const seconds = Math.floor(remaining / 1000);

        if (seconds > 60) {
            const minutes = Math.floor(seconds / 60);
            countdown.textContent = `(refreshing in ${minutes}m)`;
        } else if (seconds > 0) {
            countdown.textContent = `(refreshing in ${seconds}s)`;
        } else {
            countdown.textContent = '(refreshing...)';
        }
    }

    startCountdown() {
        // Set next refresh time
        this.nextRefreshTime = Date.now() + 60000; // 60 seconds from now

        // Clear any existing countdown interval
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
        }

        // Update countdown every second
        this.countdownInterval = setInterval(() => {
            this.updateCountdown();
        }, 1000);

        // Initial update
        this.updateCountdown();
    }

    stopCountdown() {
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
            this.countdownInterval = null;
        }
        this.nextRefreshTime = null;
        const countdown = document.getElementById('countdown');
        if (countdown) {
            countdown.textContent = '';
        }
    }

    async loadData() {
        this.setStatus('Loading...', 'info');

        try {
            // Get latest data
            const response = await fetch('/api/noisefloor/latest');

            if (response.status === 204) {
                this.setStatus('Collecting initial data... Please wait.', 'info');
                return;
            }

            if (!response.ok) {
                throw new Error('Failed to load data');
            }

            const data = await response.json();

            if (!data || Object.keys(data).length === 0) {
                this.setStatus('No measurements available yet', 'info');
                return;
            }

            // Load trend data for all bands
            const today = new Date().toISOString().split('T')[0];
            const bands = Object.keys(data).sort();

            for (const band of bands) {
                if (data[band]) {
                    try {
                        const trendResponse = await fetch(`/api/noisefloor/trend?date=${today}&band=${band}`);
                        if (trendResponse.ok && trendResponse.status !== 204) {
                            this.trendDataCache[band] = await trendResponse.json();
                        } else if (trendResponse.status === 204) {
                            this.trendDataCache[band] = [];
                        }
                    } catch (error) {
                        console.error(`Error loading data for ${band}:`, error);
                    }
                }
            }

            await this.updateBandStateChart(data);
            this.setStatus('Data loaded successfully', 'success');
            this.startCountdown();
        } catch (error) {
            console.error('Error loading data:', error);
            this.setStatus(`Error: ${error.message}`, 'error');
            this.stopCountdown();
        }
    }

    async updateBandStateChart(data) {
        const bands = this.sortBands(Object.keys(data));

        // Prepare data for chart
        const datasets = [];

        for (const band of bands) {
            if (!data[band]) continue;

            try {
                const trendData = this.trendDataCache[band] || [];

                // Filter out bands with no FT8 frequency configured
                const hasValidFT8Data = trendData.some(d => d.ft8_snr && d.ft8_snr > 0);
                if (!hasValidFT8Data && (!data[band].ft8_snr || data[band].ft8_snr <= 0)) {
                    continue;
                }

                // Normalize all timestamps to today's date
                const today = new Date();
                today.setHours(0, 0, 0, 0);

                const dataPoints = trendData.length > 0
                    ? trendData.map(d => {
                        const snr = d.ft8_snr || 0;
                        let state;
                        if (snr < 6) {
                            state = 0; // CLOSED
                        } else if (snr >= 6 && snr < 20) {
                            state = 1; // MARGINAL
                        } else {
                            state = 2; // OPEN
                        }

                        const originalTime = new Date(d.timestamp);
                        const normalizedTime = new Date(today);
                        normalizedTime.setHours(originalTime.getHours(), originalTime.getMinutes(), originalTime.getSeconds(), originalTime.getMilliseconds());

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
                            const normalizedTime = new Date(today);
                            normalizedTime.setHours(originalTime.getHours(), originalTime.getMinutes(), originalTime.getSeconds(), originalTime.getMilliseconds());
                            return normalizedTime;
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

        if (datasets.length === 0) {
            this.setStatus('No FT8 data available', 'info');
            return;
        }

        // Always destroy and recreate chart
        if (this.bandStateChart) {
            this.bandStateChart.destroy();
            this.bandStateChart = null;
        }

        // Get unique bands for y-axis
        const uniqueBands = [...new Set(datasets.map(d => d.y))];

        // Calculate time range for x-axis (00:00 to 23:59 today UTC)
        const now = new Date();
        const startOfDay = new Date(now);
        startOfDay.setUTCHours(0, 0, 0, 0);
        const endOfDay = new Date(startOfDay);
        endOfDay.setUTCHours(23, 59, 59, 999);

        // Create annotation for current time indicator
        const currentTimeNormalized = new Date(startOfDay);
        currentTimeNormalized.setUTCHours(now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(), now.getUTCMilliseconds());

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

        this.bandStateChart = new Chart(ctx, {
            type: 'scatter',
            data: {
                datasets: [{
                    label: 'Band State',
                    data: datasets,
                    backgroundColor: (context) => {
                        const value = context.raw.v;
                        if (value === 0) return '#ef4444'; // CLOSED - red
                        if (value === 1) return '#eab308'; // MARGINAL - yellow
                        if (value === 2) return '#22c55e'; // OPEN - green
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
                aspectRatio: 5.0,
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
                                return date.toLocaleString('en-GB', {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    hour12: false
                                });
                            },
                            beforeBody: (items) => {
                                if (items.length === 0) return [];
                                const hoveredX = items[0].parsed.x;
                                const threshold = 5 * 60 * 1000; // 5 minutes tolerance

                                const chart = items[0].chart;
                                const bandMap = new Map();

                                chart.data.datasets[0].data.forEach((point) => {
                                    if (Math.abs(point.x.getTime() - hoveredX) < threshold) {
                                        const state = point.v === 0 ? 'CLOSED' : (point.v === 1 ? 'MARGINAL' : 'OPEN');
                                        const snr = point.snr.toFixed(1);
                                        const bandName = point.y;

                                        if (!bandMap.has(bandName)) {
                                            bandMap.set(bandName, {
                                                text: `${bandName}: ${state} (${snr} dB)`,
                                                timestamp: point.x.getTime()
                                            });
                                        } else {
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

                                const bandOrder = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];
                                const allPointsAtTime = Array.from(bandMap.entries())
                                    .sort((a, b) => bandOrder.indexOf(a[0]) - bandOrder.indexOf(b[0]))
                                    .map(entry => entry[1].text);

                                return allPointsAtTime;
                            },
                            label: () => {
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
                        ticks: { color: '#fff' },
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

    startAutoRefresh() {
        // Auto-refresh every 60 seconds
        this.refreshInterval = setInterval(() => {
            this.loadData();
        }, 60000);

        // Initial load
        this.loadData();
    }

    stopAutoRefresh() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
        this.stopCountdown();
    }
}

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
    new BandConditionsMonitor();
});
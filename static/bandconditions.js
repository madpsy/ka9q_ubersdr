// Band Conditions Monitor - Standalone Page
// Shows real-time band state chart for all bands

class BandConditionsMonitor {
    constructor() {
        this.bandStateChart = null;
        this.refreshInterval = null;
        this.countdownInterval = null;
        this.nextRefreshTime = null;
        this.trendDataCache = {};
        this.gpsCoordinates = null; // Store GPS coordinates for sunrise/sunset calculation
        this.location = null; // Store location name if available
        this.utcClockInterval = null; // Interval for UTC clock updates

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
        this.startUTCClock();
    }

    async loadVersion() {
        try {
            const response = await fetch('/api/description');
            if (response.ok) {
                const data = await response.json();

                // Store GPS coordinates if available
                if (data.receiver && data.receiver.gps &&
                    data.receiver.gps.lat && data.receiver.gps.lon) {
                    this.gpsCoordinates = {
                        lat: data.receiver.gps.lat,
                        lon: data.receiver.gps.lon
                    };
                }

                // Store location name if available
                if (data.receiver && data.receiver.location && data.receiver.location.trim() !== '') {
                    this.location = data.receiver.location;
                }

                // Update receiver name in subtitle
                const receiverNameEl = document.getElementById('receiver-name');
                if (receiverNameEl) {
                    if (data.receiver && data.receiver.name) {
                        receiverNameEl.textContent = data.receiver.name;
                    } else {
                        receiverNameEl.textContent = 'Band Conditions Monitor';
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

    async loadSpaceWeather() {
        try {
            const response = await fetch('/api/spaceweather');
            
            if (!response.ok) {
                console.error('Failed to load space weather data');
                return;
            }

            const data = await response.json();
            this.displaySpaceWeather(data);
        } catch (error) {
            console.error('Error loading space weather:', error);
        }
    }

    displaySpaceWeather(data) {
        const summaryDiv = document.getElementById('spaceweather-summary');
        const contentDiv = document.getElementById('spaceweather-content');
        const forecastSummaryDiv = document.getElementById('spaceweather-forecast-summary');

        if (!summaryDiv || !contentDiv) return;

        // Determine overall quality color
        const qualityColor = data.propagation_quality === 'Excellent' ? '#22c55e' :
                            data.propagation_quality === 'Good' ? '#fbbf24' :
                            data.propagation_quality === 'Fair' ? '#ff9800' : '#ef4444';

        // Build compact display
        let html = '<div style="display: flex; flex-direction: column; gap: 12px;">';

        // Sunrise/Sunset times (if GPS coordinates available)
        if (this.gpsCoordinates && typeof SunCalc !== 'undefined') {
            const times = SunCalc.getTimes(new Date(), this.gpsCoordinates.lat, this.gpsCoordinates.lon);
            const sunrise = times.sunrise;
            const sunset = times.sunset;
            const now = new Date();
            
            // Determine if it's currently day or night
            const isDaytime = now >= sunrise && now < sunset;
            const dayNightIcon = isDaytime ? '☀️' : '🌙';
            const dayNightText = isDaytime ? 'Day' : 'Night';
            
            // Add location if available
            const locationText = this.location ? ` (${this.location})` : '';
            
            // Format times in UTC
            const sunriseStr = sunrise.toISOString().substr(11, 5); // Extract HH:MM from ISO string
            const sunsetStr = sunset.toISOString().substr(11, 5);
            
            html += `<div style="text-align: center; padding: 10px; background: rgba(255,255,255,0.05); border-radius: 6px;">
                        <div style="font-size: 1.1em; font-weight: bold; margin-bottom: 5px;">${dayNightIcon} Currently: ${dayNightText}${locationText}</div>
                        <div style="font-size: 0.9em; opacity: 0.8;">🌅 Sunrise: ${sunriseStr} UTC • 🌇 Sunset: ${sunsetStr} UTC</div>
                        <div id="utc-clock" style="font-size: 0.95em; margin-top: 5px; font-weight: bold; opacity: 0.9;">🕐 UTC: --:--:--</div>
                     </div>`;
        }

        // Last update timestamp
        const lastUpdate = new Date(data.last_update);
        const now = new Date();
        const minutesAgo = Math.floor((now - lastUpdate) / 60000);
        const timeAgo = minutesAgo < 1 ? 'just now' :
                       minutesAgo === 1 ? '1 minute ago' :
                       minutesAgo < 60 ? `${minutesAgo} minutes ago` :
                       `${Math.floor(minutesAgo / 60)} hours ago`;
        
        html += `<div style="text-align: center; font-size: 0.85em; opacity: 0.7;">Last updated: ${timeAgo}</div>`;

        // Top row: Key metrics in a compact grid
        html += '<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px;">';
        html += `<div style="text-align: center; padding: 8px; background: rgba(255,255,255,0.05); border-radius: 6px;">
                    <div style="font-size: 0.8em; opacity: 0.8;">Solar Flux</div>
                    <div style="font-size: 1.3em; font-weight: bold;">${data.solar_flux.toFixed(0)} SFU</div>
                 </div>`;
        html += `<div style="text-align: center; padding: 8px; background: rgba(255,255,255,0.05); border-radius: 6px;">
                    <div style="font-size: 0.8em; opacity: 0.8;">K-Index</div>
                    <div style="font-size: 1.3em; font-weight: bold;">${data.k_index} <span style="font-size: 0.7em;">(${data.k_index_status})</span></div>
                 </div>`;
        html += `<div style="text-align: center; padding: 8px; background: rgba(255,255,255,0.05); border-radius: 6px;">
                    <div style="font-size: 0.8em; opacity: 0.8;">A-Index</div>
                    <div style="font-size: 1.3em; font-weight: bold;">${data.a_index}</div>
                 </div>`;
        html += `<div style="text-align: center; padding: 8px; background: rgba(255,255,255,0.05); border-radius: 6px;">
                    <div style="font-size: 0.8em; opacity: 0.8;">Solar Wind Bz</div>
                    <div style="font-size: 1.3em; font-weight: bold;">${data.solar_wind_bz.toFixed(1)} nT <span style="font-size: 0.7em;">(${data.solar_wind_bz < 0 ? 'Southward' : 'Northward'})</span></div>
                 </div>`;
        html += `<div style="text-align: center; padding: 8px; background: rgba(255,255,255,0.05); border-radius: 6px;">
                    <div style="font-size: 0.8em; opacity: 0.8;">Propagation</div>
                    <div style="font-size: 1.3em; font-weight: bold; color: ${qualityColor};">${data.propagation_quality}</div>
                 </div>`;
        html += '</div>';

        // Band conditions in two rows (day and night)
        if (data.band_conditions_day && data.band_conditions_night) {
            const bandOrder = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];
            
            // Determine if it's currently day or night (reuse calculation from above)
            let isDaytime = false;
            if (this.gpsCoordinates && typeof SunCalc !== 'undefined') {
                const times = SunCalc.getTimes(new Date(), this.gpsCoordinates.lat, this.gpsCoordinates.lon);
                const now = new Date();
                isDaytime = now >= times.sunrise && now < times.sunset;
            }

            // Day conditions - add white border if currently daytime
            const dayBorderStyle = isDaytime ? 'border: 2px solid white; padding: 8px; border-radius: 6px;' : '';
            html += `<div style="margin-bottom: 8px; ${dayBorderStyle}">`;
            html += '<div style="font-size: 0.8em; opacity: 0.7; margin-bottom: 4px; text-align: center;">☀️ Day</div>';
            html += '<div style="display: flex; flex-wrap: wrap; gap: 5px; justify-content: center;">';
            bandOrder.forEach(band => {
                if (data.band_conditions_day[band]) {
                    const condition = data.band_conditions_day[band];
                    let emoji = '🔴'; // Poor - red
                    if (condition === 'Excellent') emoji = '🟢'; // Excellent - green
                    else if (condition === 'Good') emoji = '🟡'; // Good - yellow
                    else if (condition === 'Fair') emoji = '🟠'; // Fair - orange
                    html += `<span style="font-size: 0.85em; padding: 4px 8px; background: rgba(255,255,255,0.05); border-radius: 4px;" title="${band}: ${condition}">${emoji} ${band}</span>`;
                }
            });
            html += '</div></div>';
            
            // Night conditions - add white border if currently nighttime
            const nightBorderStyle = !isDaytime ? 'border: 2px solid white; padding: 8px; border-radius: 6px;' : '';
            html += `<div style="${nightBorderStyle}">`;
            html += '<div style="font-size: 0.8em; opacity: 0.7; margin-bottom: 4px; text-align: center;">🌙 Night</div>';
            html += '<div style="display: flex; flex-wrap: wrap; gap: 5px; justify-content: center;">';
            bandOrder.forEach(band => {
                if (data.band_conditions_night[band]) {
                    const condition = data.band_conditions_night[band];
                    let emoji = '🔴'; // Poor - red
                    if (condition === 'Excellent') emoji = '🟢'; // Excellent - green
                    else if (condition === 'Good') emoji = '🟡'; // Good - yellow
                    else if (condition === 'Fair') emoji = '🟠'; // Fair - orange
                    html += `<span style="font-size: 0.85em; padding: 4px 8px; background: rgba(255,255,255,0.05); border-radius: 4px;" title="${band}: ${condition}">${emoji} ${band}</span>`;
                }
            });
            html += '</div></div>';
        }

        html += '</div>';

        // Add link to history page
        html += '<div style="margin-top: 15px; text-align: center;">';
        html += '<a href="/spaceweather_history.html" style="display: inline-block; padding: 10px 20px; background: rgba(255, 255, 255, 0.15); color: white; text-decoration: none; border-radius: 6px; font-weight: bold; transition: all 0.3s; border: 1px solid rgba(255, 255, 255, 0.3);" onmouseover="this.style.background=\'rgba(255, 255, 255, 0.25)\'" onmouseout="this.style.background=\'rgba(255, 255, 255, 0.15)\'">View Space Weather History</a>';
        html += '</div>';

        contentDiv.innerHTML = html;
        summaryDiv.style.display = 'block';

        // Also populate the compact forecast summary at the top (if available)
        if (forecastSummaryDiv && data.forecast && data.forecast.summary !== "Quiet conditions expected for the next 24 hours.") {
            forecastSummaryDiv.innerHTML = `<div style="font-weight: bold; margin-bottom: 5px;">⚠️ Forecast: ${data.forecast.geomagnetic_storm}</div>
                <div style="opacity: 0.9;">${data.forecast.summary}</div>`;
            forecastSummaryDiv.style.display = 'block';
        } else if (forecastSummaryDiv) {
            forecastSummaryDiv.style.display = 'none';
        }
    }

    async loadData() {
        this.setStatus('Loading...', 'info');

        try {
            // Ensure GPS coordinates are loaded before space weather
            if (!this.gpsCoordinates) {
                await this.loadVersion();
            }

            // Load space weather data
            await this.loadSpaceWeather();

            // Get latest data
            const response = await fetch('/api/noisefloor/latest');

            if (response.status === 204) {
                this.setStatus('Collecting initial data... Please wait.', 'info');
                this.showChartLoadingMessage(true);
                return;
            }

            if (!response.ok) {
                throw new Error('Failed to load data');
            }

            const data = await response.json();

            if (!data || Object.keys(data).length === 0) {
                this.setStatus('No measurements available yet', 'info');
                this.showChartLoadingMessage(true);
                return;
            }

            // Load trend data for all bands in a single API call
            try {
                const trendResponse = await fetch('/api/noisefloor/trends');
                if (trendResponse.ok && trendResponse.status !== 204) {
                    const allTrendData = await trendResponse.json();
                    // Store the trend data for each band
                    for (const band in allTrendData) {
                        this.trendDataCache[band] = allTrendData[band];
                    }
                } else if (trendResponse.status === 204) {
                    // No data available yet
                    this.trendDataCache = {};
                }
            } catch (error) {
                console.error('Error loading trend data for all bands:', error);
            }

            await this.updateBandStateChart(data);
            this.updateBandStatusBadges(data);
            this.showChartLoadingMessage(false);
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
                            state = 0; // POOR
                        } else if (snr >= 6 && snr < 20) {
                            state = 1; // FAIR
                        } else if (snr >= 20 && snr < 30) {
                            state = 2; // GOOD
                        } else {
                            state = 3; // EXCELLENT
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
                        v: data[band].ft8_snr < 6 ? 0 : (data[band].ft8_snr < 20 ? 1 : (data[band].ft8_snr < 30 ? 2 : 3)),
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
            this.showChartLoadingMessage(true);
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
                        if (value === 0) return '#ef4444'; // POOR - red
                        if (value === 1) return '#ff9800'; // FAIR - orange
                        if (value === 2) return '#fbbf24'; // GOOD - bright yellow
                        if (value === 3) return '#22c55e'; // EXCELLENT - green
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
                                        const state = point.v === 0 ? 'POOR' : (point.v === 1 ? 'FAIR' : (point.v === 2 ? 'GOOD' : 'EXCELLENT'));
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

    updateBandStatusBadges(data) {
        const bandStatusRow = document.getElementById('bandStatusRow');
        if (!bandStatusRow) return;

        // Sort bands in order
        const bandOrder = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];
        const bands = Object.keys(data).sort((a, b) => {
            return bandOrder.indexOf(a) - bandOrder.indexOf(b);
        });

        // Clear existing badges
        bandStatusRow.innerHTML = '';

        // Create badges for each band
        bands.forEach(band => {
            const bandData = data[band];
            if (!bandData || !bandData.ft8_snr) return;

            const snr = bandData.ft8_snr;

            // Determine state based on SNR
            let stateClass, stateText;
            if (snr < 6) {
                stateClass = 'poor';
                stateText = 'POOR';
            } else if (snr >= 6 && snr < 20) {
                stateClass = 'fair';
                stateText = 'FAIR';
            } else if (snr >= 20 && snr < 30) {
                stateClass = 'good';
                stateText = 'GOOD';
            } else {
                stateClass = 'excellent';
                stateText = 'EXCELLENT';
            }

            const badge = document.createElement('div');
            badge.className = `band-badge ${stateClass}`;
            badge.textContent = band;
            badge.title = `${stateText} (${snr.toFixed(1)} dB)`; // Show details on hover
            bandStatusRow.appendChild(badge);
        });
    }

    showChartLoadingMessage(show) {
        const loadingMessage = document.getElementById('chart-loading-message');
        const chartWrapper = document.querySelector('.chart-wrapper');
        const bandStatusRow = document.getElementById('bandStatusRow');
        const legend = document.getElementById('legend');

        if (loadingMessage) {
            loadingMessage.style.display = show ? 'block' : 'none';
        }
        if (chartWrapper) {
            chartWrapper.style.display = show ? 'none' : 'block';
        }
        if (bandStatusRow) {
            bandStatusRow.style.display = show ? 'none' : 'flex';
        }
        if (legend) {
            legend.style.display = show ? 'none' : 'flex';
        }
    }

    startAutoRefresh() {
        // Auto-refresh every 60 seconds
        this.refreshInterval = setInterval(() => {
            this.loadData();
        }, 60000);

        // Initial load
        this.loadData();
    }

    startUTCClock() {
        // Update UTC clock every second
        this.updateUTCClock();
        this.utcClockInterval = setInterval(() => {
            this.updateUTCClock();
        }, 1000);
    }

    updateUTCClock() {
        const clockEl = document.getElementById('utc-clock');
        if (clockEl) {
            const now = new Date();
            const timeStr = now.toISOString().substr(11, 8); // Extract HH:MM:SS
            clockEl.textContent = `🕐 UTC: ${timeStr}`;
        }
    }

    stopAutoRefresh() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
        if (this.utcClockInterval) {
            clearInterval(this.utcClockInterval);
            this.utcClockInterval = null;
        }
        this.stopCountdown();
    }
}

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
    new BandConditionsMonitor();
});
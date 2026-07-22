// Band Conditions Monitor - Standalone Page
// Shows real-time band state chart for all bands

function bcIso2ToFlag(code) {
    if (!code || code.length !== 2) return '';
    return String.fromCodePoint(
        0x1F1E6 - 65 + code.toUpperCase().charCodeAt(0),
        0x1F1E6 - 65 + code.toUpperCase().charCodeAt(1)
    );
}

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
        this.wsprEnabled = false; // Whether WSPR phone predictions are available
        this.weatherData = null; // Cached local weather data from /api/weather

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

                // Store WSPR enabled flag
                if (data.digital_decodes === true &&
                    Array.isArray(data.digital_modes) &&
                    data.digital_modes.includes('WSPR')) {
                    this.wsprEnabled = true;
                }

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

    async loadWsprPredictions() {
        const section = document.getElementById('wspr-predictions-section');
        const content = document.getElementById('wspr-predictions-content');
        if (!section || !content) return;

        try {
            const response = await fetch('/api/wspr/phone-prediction?summary=true&by=band&phone_power_w=250');
            if (!response.ok) {
                console.error('Failed to load WSPR phone predictions');
                section.style.display = 'none';
                return;
            }

            const data = await response.json();
            if (!data.predictions || data.predictions.length === 0) {
                section.style.display = 'none';
                return;
            }

            const bandOrder = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m'];
            const sorted = data.predictions.slice().sort((a, b) => {
                const ia = bandOrder.indexOf(a.band);
                const ib = bandOrder.indexOf(b.band);
                return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
            });

            let html = '';
            for (const bandEntry of sorted) {
                if (!bandEntry.countries || bandEntry.countries.length === 0) continue;

                const badges = bandEntry.countries.map(c => {
                    const cls = (c.prediction || 'poor').toLowerCase();
                    const snr = typeof c.predicted_ssb_snr === 'number' ? c.predicted_ssb_snr.toFixed(1) : '?';
                    const flag = c.country_code ? bcIso2ToFlag(c.country_code) + '\u202F' : '';
                    return `<span class="wspr-badge ${cls}" title="${c.prediction} (${snr} dB SSB SNR)">${flag}${c.country}</span>`;
                }).join('');

                html += `<div class="wspr-band-block">
                    <div class="wspr-band-title">${bandEntry.band} <span style="font-size:0.8em;opacity:0.7;">(${bandEntry.country_count} countr${bandEntry.country_count === 1 ? 'y' : 'ies'}, best: ${bandEntry.best_prediction})</span></div>
                    <div class="wspr-badges">${badges}</div>
                </div>`;
            }

            if (html === '') {
                section.style.display = 'none';
                return;
            }

            content.innerHTML = html;
            section.style.display = 'block';
        } catch (error) {
            console.error('Error loading WSPR phone predictions:', error);
            section.style.display = 'none';
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

    async loadWeather() {
        try {
            // Reuse the shared promise set by app.js to avoid a duplicate HTTP
            // request that would exhaust the per-IP rate limiter on /api/weather.
            if (!window.weatherPromise) {
                window.weatherPromise = fetch('/api/weather')
                    .then(r => r.ok ? r.json() : null)
                    .catch(() => null);
            }
            this.weatherData = await window.weatherPromise;
        } catch (error) {
            console.error('Error loading weather:', error);
            this.weatherData = null;
        }
    }

    displaySpaceWeather(data) {
        const summaryDiv = document.getElementById('spaceweather-summary');
        const contentDiv = document.getElementById('spaceweather-content');
        const forecastSummaryDiv = document.getElementById('spaceweather-forecast-summary');

        if (!summaryDiv || !contentDiv) return;

        // Determine overall quality color
        const qualityColor = data.propagation_quality === 'Excellent' ? '#16a34a' :
                            data.propagation_quality === 'Good' ? '#fbbf24' :
                            data.propagation_quality === 'Fair' ? '#ea580c' : '#dc2626';

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

        // Local weather row (only shown if data is available from /api/weather)
        if (this.weatherData && this.weatherData.weather && this.weatherData.weather.length > 0) {
            const wd = this.weatherData;
            const iconCode = wd.weather[0].icon; // e.g. "04d" — already has d/n suffix
            const iconUrl = `/weather/${iconCode}_t.png`;
            const description = wd.weather[0].description
                .split(' ')
                .map(w => w.charAt(0).toUpperCase() + w.slice(1))
                .join(' ');
            const tempC = wd.main && wd.main.temp !== undefined ? Math.round(wd.main.temp) : null;
            const tempMin = wd.main && wd.main.temp_min !== undefined ? Math.round(wd.main.temp_min) : null;
            const tempMax = wd.main && wd.main.temp_max !== undefined ? Math.round(wd.main.temp_max) : null;
            const feelsLike = wd.main && wd.main.feels_like !== undefined ? Math.round(wd.main.feels_like) : null;
            const humidity = wd.main && wd.main.humidity !== undefined ? wd.main.humidity : null;
            const pressure = wd.main && wd.main.pressure !== undefined ? wd.main.pressure : null;
            const seaLevel = wd.main && wd.main.sea_level !== undefined ? wd.main.sea_level : null;
            const windMs = wd.wind && wd.wind.speed !== undefined ? wd.wind.speed : null;
            const windKmh = windMs !== null ? Math.round(windMs * 3.6) : null;
            const windDeg = wd.wind && wd.wind.deg !== undefined ? wd.wind.deg : null;
            const windDir = windDeg !== null ? (['N','NE','E','SE','S','SW','W','NW','N'])[Math.round(windDeg / 45) % 8] : null;
            const gustMs = wd.wind && wd.wind.gust !== undefined ? wd.wind.gust : null;
            const gustKmh = gustMs !== null ? Math.round(gustMs * 3.6) : null;

            let weatherParts = [];
            if (tempC !== null) {
                let tempTooltip = `Current temperature`;
                const extras = [];
                if (feelsLike !== null) extras.push(`Feels like ${feelsLike}°C`);
                if (tempMin !== null && tempMax !== null) extras.push(`Min ${tempMin}°C / Max ${tempMax}°C`);
                if (extras.length) tempTooltip += ` — ${extras.join(' • ')}`;
                weatherParts.push(`<span title="${tempTooltip}">🌡️ ${tempC}°C</span>`);
            }
            if (humidity !== null) {
                weatherParts.push(`<span title="Relative humidity">💧 ${humidity}%</span>`);
            }
            if (pressure !== null) {
                const pressureTooltip = seaLevel !== null ? `Atmospheric pressure (sea level: ${seaLevel} hPa)` : 'Atmospheric pressure';
                weatherParts.push(`<span title="${pressureTooltip}">🔵 ${pressure} hPa</span>`);
            }
            if (windKmh !== null) {
                const dirStr = windDir ? ` ${windDir}` : '';
                const gustStr = gustKmh !== null ? ` (gusts ${gustKmh})` : '';
                const windDirFull = windDir && windDeg !== null ? `${windDir} (${windDeg}°)` : windDir || (windDeg !== null ? `${windDeg}°` : '');
                const windTooltip = [
                    `Wind from ${windDirFull || 'unknown direction'}`,
                    gustKmh !== null ? `Gusts up to ${gustKmh} km/h` : '',
                ].filter(Boolean).join(' • ');
                weatherParts.push(`<span title="${windTooltip}">💨 ${windKmh} km/h${dirStr}${gustStr}</span>`);
            }

            html += `<div style="display: flex; justify-content: center; align-items: center; gap: 14px; padding: 10px 14px; background: rgba(255,255,255,0.05); border-radius: 6px; text-align: center;">
                        <img src="${iconUrl}" alt="${description}" width="50" height="50" style="flex-shrink: 0;" onerror="this.style.display='none'">
                        <div>
                            <div style="font-weight: bold; font-size: 1em;">${description}</div>
                            <div style="font-size: 0.9em; opacity: 0.85; margin-top: 3px;">${weatherParts.join(' &nbsp;•&nbsp; ')}</div>
                        </div>
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

            // Load local weather first (needed by displaySpaceWeather), then space weather
            await this.loadWeather();
            await this.loadSpaceWeather();

            // Load phone/SSB predictions if WSPR is available
            if (this.wsprEnabled) {
                await this.loadWsprPredictions();
            }

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

                // Normalize all timestamps to today's date (UTC)
                const now = new Date();
                const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

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
                        // Create UTC timestamp for today at the same time-of-day
                        const normalizedTime = new Date(Date.UTC(
                            now.getUTCFullYear(),
                            now.getUTCMonth(),
                            now.getUTCDate(),
                            originalTime.getUTCHours(),
                            originalTime.getUTCMinutes(),
                            originalTime.getUTCSeconds(),
                            originalTime.getUTCMilliseconds()
                        ));

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
                            // Create UTC timestamp for today at the same time-of-day
                            return new Date(Date.UTC(
                                now.getUTCFullYear(),
                                now.getUTCMonth(),
                                now.getUTCDate(),
                                originalTime.getUTCHours(),
                                originalTime.getUTCMinutes(),
                                originalTime.getUTCSeconds(),
                                originalTime.getUTCMilliseconds()
                            ));
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
        const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
        const endOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));

        // Create annotation for current time indicator (UTC)
        const currentTimeNormalized = new Date(Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate(),
            now.getUTCHours(),
            now.getUTCMinutes(),
            now.getUTCSeconds(),
            now.getUTCMilliseconds()
        ));

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
                        if (value === 0) return '#dc2626'; // POOR - red
                        if (value === 1) return '#ea580c'; // FAIR - burnt orange
                        if (value === 2) return '#fbbf24'; // GOOD - yellow
                        if (value === 3) return '#16a34a'; // EXCELLENT - green
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
                                const hours = String(date.getUTCHours()).padStart(2, '0');
                                const minutes = String(date.getUTCMinutes()).padStart(2, '0');
                                return `${hours}:${minutes} UTC`;
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
                        ticks: {
                            color: '#fff',
                            source: 'auto',
                            autoSkip: true,
                            callback: function(value, index, ticks) {
                                // Format tick as UTC time
                                const date = new Date(value);
                                const hours = String(date.getUTCHours()).padStart(2, '0');
                                const minutes = String(date.getUTCMinutes()).padStart(2, '0');
                                return `${hours}:${minutes}`;
                            }
                        },
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
    new MUFMap();
});

// ─────────────────────────────────────────────────────────────────────────────
// MUF Map — shown above the space weather forecast when the collector's
// ionosonde endpoints are reachable (all three return HTTP 200).
//
// Endpoints probed (all on https://instances.ubersdr.org):
//   GET /api/ionosonde/mufd.png      — viridis raster overlay
//   GET /api/ionosonde/mufd.geojson  — contour LineStrings
//   GET /api/ionosonde/stations.json — per-ionosonde dots + map timestamp
//
// The instance's own location (from /api/description) is plotted as a marker
// and its local MUF(3000) is fetched from /api/ionosonde/muf?lat=…&lon=…
// ─────────────────────────────────────────────────────────────────────────────

class MUFMap {
    constructor() {
        this.COLLECTOR = 'https://instances.ubersdr.org';
        this.REFRESH_MS = 15 * 60 * 1000; // 15 min — matches collector poll
        this.map = null;
        this.layerGroup = null;
        this.pngObjectURL = null;
        this.instanceLat = null;
        this.instanceLon = null;
        this.instanceCallsign = null;
        this.refreshTimer = null;

        // Viridis colour stops (32-entry subset matching instances.js)
        this.VIRIDIS_STOPS = [
            [68,1,84],[71,13,96],[72,24,106],[72,36,117],
            [71,46,124],[69,56,130],[66,65,134],[62,76,138],
            [58,84,140],[54,93,141],[50,101,142],[46,109,142],
            [43,117,142],[40,125,142],[37,132,142],[34,140,141],
            [31,148,140],[30,156,137],[32,163,134],[37,171,130],
            [46,179,124],[58,186,118],[72,193,110],[88,199,101],
            [105,205,91],[127,211,78],[147,215,65],[168,219,52],
            [189,223,38],[213,226,26],[234,229,26],[253,231,37],
        ];

        // Contour level → viridis colour (matching instances.js MUF_LEVEL_COLOURS)
        this.LEVEL_COLOURS = {
            5.3:  '#462d7c',
            7.0:  '#3a538b',
            10.1: '#277d8e',
            14.0: '#1fa286',
            18.0: '#3ebc73',
            21.0: '#62ca5f',
            24.8: '#92d741',
            28.0: '#b7dd29',
        };

        this.init();
    }

    // ── Colour helpers ────────────────────────────────────────────────────────

    /** Map a MUF value (MHz) to [r,g,b] via viridis + LogNorm(4,35). */
    viridisRGB(mufd) {
        const MIN = 4.0, MAX = 35.0;
        let t = (Math.log(mufd) - Math.log(MIN)) / (Math.log(MAX) - Math.log(MIN));
        if (!isFinite(t) || t < 0) t = 0;
        if (t > 1) t = 1;
        const pos = t * (this.VIRIDIS_STOPS.length - 1);
        const i0 = Math.min(Math.floor(pos), this.VIRIDIS_STOPS.length - 1);
        const i1 = Math.min(i0 + 1, this.VIRIDIS_STOPS.length - 1);
        const f = pos - i0;
        const a = this.VIRIDIS_STOPS[i0], b = this.VIRIDIS_STOPS[i1];
        return [
            Math.round(a[0] * (1 - f) + b[0] * f),
            Math.round(a[1] * (1 - f) + b[1] * f),
            Math.round(a[2] * (1 - f) + b[2] * f),
        ];
    }

    /** Normalised [0,1] position along the LogNorm(4,35) scale. */
    scaleFraction(mhz) {
        const MIN = 4.0, MAX = 35.0;
        let t = (Math.log(mhz) - Math.log(MIN)) / (Math.log(MAX) - Math.log(MIN));
        if (!isFinite(t) || t < 0) t = 0;
        if (t > 1) t = 1;
        return t;
    }

    /** Closest defined contour colour for a given level. */
    levelColour(level) {
        const levels = Object.keys(this.LEVEL_COLOURS).map(Number);
        let closest = levels[0], minDiff = Math.abs(level - closest);
        for (const l of levels) {
            const d = Math.abs(level - l);
            if (d < minDiff) { minDiff = d; closest = l; }
        }
        return this.LEVEL_COLOURS[closest] || '#888888';
    }

    // ── Endpoint probe ────────────────────────────────────────────────────────

    /**
     * HEAD-probe all three ionosonde endpoints.
     * Returns true only if every one responds with HTTP 200.
     */
    async probeEndpoints() {
        const urls = [
            `${this.COLLECTOR}/api/ionosonde/mufd.png`,
            `${this.COLLECTOR}/api/ionosonde/mufd.geojson`,
            `${this.COLLECTOR}/api/ionosonde/stations.json`,
        ];
        try {
            const results = await Promise.all(
                urls.map(u => fetch(u, { method: 'HEAD' }).then(r => r.ok).catch(() => false))
            );
            return results.every(Boolean);
        } catch {
            return false;
        }
    }

    // ── Initialisation ────────────────────────────────────────────────────────

    async init() {
        // Probe endpoints first — bail silently if unavailable
        const available = await this.probeEndpoints();
        if (!available) return;

        // Fetch instance location from /api/description
        try {
            const r = await fetch('/api/description');
            if (r.ok) {
                const d = await r.json();
                if (d.receiver && d.receiver.gps) {
                    this.instanceLat = d.receiver.gps.lat;
                    this.instanceLon = d.receiver.gps.lon;
                }
                if (d.receiver && d.receiver.callsign) {
                    this.instanceCallsign = d.receiver.callsign;
                }
            }
        } catch { /* location unavailable — map still shown without marker */ }

        // Show the section and build the map
        const section = document.getElementById('muf-map-section');
        if (section) section.style.display = 'block';

        this.buildLegend();
        this.initMap();
        await this.loadLayer();

        // Refresh every 15 minutes
        this.refreshTimer = setInterval(() => this.loadLayer(), this.REFRESH_MS);
    }

    // ── Legend ────────────────────────────────────────────────────────────────

    buildLegend() {
        const barEl = document.getElementById('muf-legend-bar');
        const labelsEl = document.getElementById('muf-legend-labels');
        if (!barEl || !labelsEl) return;

        // Build CSS gradient from viridis stops
        const stops = this.VIRIDIS_STOPS.map((c, i) => {
            const pct = (i / (this.VIRIDIS_STOPS.length - 1) * 100).toFixed(2);
            return `rgb(${c[0]},${c[1]},${c[2]}) ${pct}%`;
        }).join(',');
        barEl.style.background = `linear-gradient(to right, ${stops})`;

        // Notches + labels at each contour level
        const levels = Object.keys(this.LEVEL_COLOURS).map(Number).sort((a, b) => a - b);
        let notchHtml = '', labelHtml = '';
        const halo = '0 0 3px rgba(0,0,0,0.9),0 0 2px rgba(0,0,0,0.9)';

        for (const l of levels) {
            const pct = (this.scaleFraction(l) * 100).toFixed(2);
            notchHtml += `<span style="position:absolute;left:${pct}%;top:-2px;bottom:-2px;width:1px;margin-left:-0.5px;background:rgba(255,255,255,0.8);"></span>`;
            labelHtml += `<span style="position:absolute;left:${pct}%;transform:translateX(-50%);font-size:9px;font-weight:700;color:#fff;white-space:nowrap;text-shadow:${halo};">${l}</span>`;
        }
        // End-caps
        const capStyle = `position:absolute;font-size:8px;font-weight:600;color:rgba(255,255,255,0.65);text-shadow:${halo};`;
        labelHtml += `<span style="${capStyle}left:0;top:1px;">4</span>`;
        labelHtml += `<span style="${capStyle}right:0;top:1px;">35</span>`;

        barEl.innerHTML = notchHtml;
        labelsEl.innerHTML = labelHtml;
    }

    // ── Leaflet map ───────────────────────────────────────────────────────────

    initMap() {
        if (this.map) return;
        this.map = L.map('muf-map', {
            center: [20, 0],
            zoom: 2,
            zoomControl: true,
            attributionControl: true,
        });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors',
            maxZoom: 10,
        }).addTo(this.map);
    }

    // ── Layer load ────────────────────────────────────────────────────────────

    async loadLayer() {
        if (!this.map) return;

        // Remove previous layer group
        if (this.layerGroup) {
            this.map.removeLayer(this.layerGroup);
            this.layerGroup = null;
        }
        // Revoke previous PNG blob URL
        if (this.pngObjectURL) {
            URL.revokeObjectURL(this.pngObjectURL);
            this.pngObjectURL = null;
        }

        try {
            const [pngResp, geojsonResp, stationsResp] = await Promise.all([
                fetch(`${this.COLLECTOR}/api/ionosonde/mufd.png`),
                fetch(`${this.COLLECTOR}/api/ionosonde/mufd.geojson`),
                fetch(`${this.COLLECTOR}/api/ionosonde/stations.json`),
            ]);

            // All three must be 200 — if any fail, hide the section and bail
            if (!pngResp.ok || !geojsonResp.ok || !stationsResp.ok) {
                this.hideSection();
                return;
            }

            const [geojson, stationsPayload] = await Promise.all([
                geojsonResp.json(),
                stationsResp.json(),
            ]);

            const group = L.layerGroup();

            // ── Raster PNG overlay ────────────────────────────────────────────
            const pngBlob = await pngResp.blob();
            this.pngObjectURL = URL.createObjectURL(pngBlob);
            const MERCATOR_MAX_LAT = 85.0511287798066;
            const overlay = L.imageOverlay(this.pngObjectURL, [
                [-MERCATOR_MAX_LAT, -180],
                [ MERCATOR_MAX_LAT,  180],
            ], {
                opacity: 1.0,
                interactive: false,
                zIndex: 200,
            });
            overlay.on('load', () => {
                const el = overlay.getElement();
                if (el) el.style.imageRendering = 'auto';
            });
            overlay.addTo(group);

            // ── GeoJSON contour lines ─────────────────────────────────────────
            L.geoJSON(geojson, {
                style: (feature) => ({
                    color: this.levelColour(feature.properties && feature.properties.level),
                    weight: 1.5,
                    opacity: 0.85,
                    fill: false,
                }),
                onEachFeature: (feature, layer) => {
                    const level = feature.properties && feature.properties.level;
                    if (level != null) {
                        layer.bindTooltip(`MUF ${level} MHz`, { sticky: true });
                    }
                },
            }).addTo(group);

            // Inline frequency labels — one per level on the longest segment
            const longestByLevel = {};
            for (const feature of geojson.features) {
                const level = feature.properties && feature.properties.level;
                if (level == null) continue;
                const coords = feature.geometry && feature.geometry.coordinates;
                if (!coords || coords.length < 2) continue;
                if (!longestByLevel[level] || coords.length > longestByLevel[level].coords.length) {
                    longestByLevel[level] = { coords, level };
                }
            }
            for (const { coords, level } of Object.values(longestByLevel)) {
                const mid = coords[Math.floor(coords.length / 2)];
                if (!mid) continue;
                const colour = this.levelColour(level);
                L.marker([mid[1], mid[0]], {
                    icon: L.divIcon({
                        className: '',
                        html: `<span style="font-size:10px;font-weight:bold;color:${colour};background:rgba(255,255,255,0.75);padding:0 2px;border-radius:2px;white-space:nowrap;pointer-events:none;">${Math.round(level)} MHz</span>`,
                        iconAnchor: [16, 7],
                    }),
                    interactive: false,
                    keyboard: false,
                }).addTo(group);
            }

            // ── Ionosonde station dots ────────────────────────────────────────
            const stations = stationsPayload.stations || [];
            let mapTS = stationsPayload.ts || null;

            for (const s of stations) {
                const [r, g, b] = this.viridisRGB(s.mufd);
                const alpha = Math.min(1, 0.35 + 0.6 * (s.cs || 0));
                const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
                const fg = lum > 0.55 ? '#111' : '#fff';
                const icon = L.divIcon({
                    className: '',
                    html: `<div style="width:22px;height:22px;border-radius:50%;background:rgba(${r},${g},${b},${alpha.toFixed(2)});border:1.5px solid rgba(255,255,255,0.85);box-shadow:0 0 3px rgba(0,0,0,0.5);color:${fg};font-size:10px;font-weight:700;line-height:22px;text-align:center;">${Math.round(s.mufd)}</div>`,
                    iconSize: [22, 22],
                    iconAnchor: [11, 11],
                });
                const age = Math.max(0, Math.round((Date.now() / 1000 - s.time) / 60));
                const extra = [];
                if (s.fof2 != null) extra.push(`foF2 ${s.fof2.toFixed(2)} MHz`);
                if (s.hmf2 != null) extra.push(`hmF2 ${Math.round(s.hmf2)} km`);
                L.marker([s.lat, s.lon], { icon, keyboard: false })
                    .bindTooltip(
                        `<b>${s.name}</b>${s.code ? ` (${s.code})` : ''}<br>` +
                        `MUF ${s.mufd.toFixed(1)} MHz` +
                        (extra.length ? `<br>${extra.join('<br>')}` : '') +
                        `<br>${s.source} · ${age} min ago · cs ${s.cs.toFixed(2)}`
                    )
                    .addTo(group);
            }

            // ── Instance marker + local MUF ───────────────────────────────────
            if (this.instanceLat != null && this.instanceLon != null) {
                // Fetch the point MUF for this instance's location
                let localMUF = null;
                try {
                    const mufResp = await fetch(
                        `${this.COLLECTOR}/api/ionosonde/muf` +
                        `?lat=${this.instanceLat.toFixed(4)}&lon=${this.instanceLon.toFixed(4)}`
                    );
                    if (mufResp.ok) {
                        const mufData = await mufResp.json();
                        localMUF = mufData.point && mufData.point.muf_3000_mhz;
                    }
                } catch { /* non-fatal */ }

                const label = this.instanceCallsign || 'SDR';
                const mufText = localMUF != null ? `${localMUF.toFixed(1)} MHz` : '';
                const [mr, mg, mb] = localMUF != null ? this.viridisRGB(localMUF) : [255, 152, 0];
                const markerHtml = `
                    <div style="position:relative;text-align:center;">
                        <div style="
                            background:rgba(${mr},${mg},${mb},0.9);
                            color:#fff;
                            font-size:10px;
                            font-weight:700;
                            padding:2px 5px;
                            border-radius:3px;
                            white-space:nowrap;
                            border:1px solid rgba(255,255,255,0.7);
                            box-shadow:0 1px 4px rgba(0,0,0,0.5);
                            margin-bottom:2px;
                            text-shadow:0 0 2px rgba(0,0,0,0.6);
                        ">${label}${mufText ? ` · ${mufText}` : ''}</div>
                        <div style="
                            width:0;height:0;
                            border-left:6px solid transparent;
                            border-right:6px solid transparent;
                            border-top:8px solid rgba(${mr},${mg},${mb},0.9);
                            margin:0 auto;
                        "></div>
                    </div>`;

                // Measure label width approximately (10px font, ~6px/char)
                const approxW = Math.max(60, (label.length + (mufText ? mufText.length + 3 : 0)) * 6 + 10);
                const approxH = 28;

                L.marker([this.instanceLat, this.instanceLon], {
                    icon: L.divIcon({
                        className: '',
                        html: markerHtml,
                        iconSize: [approxW, approxH + 8],
                        iconAnchor: [approxW / 2, approxH + 8],
                        popupAnchor: [0, -(approxH + 8)],
                    }),
                    zIndexOffset: 1000,
                    keyboard: false,
                })
                .bindTooltip(
                    `<b>${label}</b><br>` +
                    (mufText ? `MUF (3000 km): ${mufText}<br>` : '') +
                    `${this.instanceLat.toFixed(4)}°, ${this.instanceLon.toFixed(4)}°`
                )
                .addTo(group);
            }

            this.layerGroup = group;
            group.addTo(this.map);

            // ── Timestamp label ───────────────────────────────────────────────
            this.updateTimestamp(mapTS);

        } catch (err) {
            console.warn('MUFMap: failed to load layer:', err);
            this.hideSection();
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    updateTimestamp(ts) {
        const el = document.getElementById('muf-map-timestamp');
        if (!el) return;
        if (!ts) { el.textContent = ''; return; }
        const d = new Date(ts * 1000);
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const mm = String(d.getUTCMinutes()).padStart(2, '0');
        const ageMin = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60));
        const ageText = ageMin < 60
            ? `${ageMin} min ago`
            : `${Math.floor(ageMin / 60)}h ${ageMin % 60}m ago`;
        el.textContent = `· Data ${hh}:${mm} UTC · ${ageText}`;
    }

    hideSection() {
        const section = document.getElementById('muf-map-section');
        if (section) section.style.display = 'none';
    }
}
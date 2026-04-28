// Signal Meter - Displays signal strength with dBFS and SNR modes
// Extracted from spectrum-display.js for better modularity

class SignalMeter {
    constructor() {
        // Display mode: 'dbfs', 'snr', 'dbfs-led', or 'snr-led'
        this.displayMode = localStorage.getItem('signalMeterDisplayMode') || 'dbfs';

        // Peak history for smoothing
        this.peakHistory = [];
        this.peakHistoryMaxAge = 100; // 100ms window - reduced for faster response
        this.lastMeterUpdate = 0;
        this.meterUpdateInterval = 33; // Update display every 33ms (30 fps) - matches oscilloscope

        // Noise floor tracking (same as line graph)
        this.noiseFloorHistory = [];
        this.noiseFloorHistoryMaxAge = 2000; // 2 second window for noise floor

        // SNR smoothing for spectrum data source
        this.snrSmoothingHistory = [];
        this.snrSmoothingMaxAge = 2000; // 2 second window for SNR smoothing (more aggressive smoothing)
        this.lastSnrHistoryUpdate = 0;
        this.snrHistoryUpdateInterval = 100; // Update SNR history every 100ms (matches audio packet rate)
        
        // Get DOM elements
        this.meterBar = document.getElementById('signal-meter-bar');
        this.meterValue = document.getElementById('signal-meter-value');
        this.meterContainer = document.querySelector('.signal-meter');
        this.meterLeds = document.getElementById('signal-meter-leds');
        
        // Add click handler to toggle between modes
        if (this.meterValue) {
            this.meterValue.style.cursor = 'pointer';
            this.meterValue.title = 'Click to cycle meter display mode';
            this.meterValue.addEventListener('click', () => this.toggleDisplayMode());
        }
        
        // Add click handler to meter bar as well
        if (this.meterContainer) {
            this.meterContainer.style.cursor = 'pointer';
            this.meterContainer.title = 'Click to cycle meter display mode';
            this.meterContainer.addEventListener('click', () => this.toggleDisplayMode());
        }

        // Add click handler to LED container
        if (this.meterLeds) {
            this.meterLeds.style.cursor = 'pointer';
            this.meterLeds.title = 'Click to cycle meter display mode';
            this.meterLeds.addEventListener('click', () => this.toggleDisplayMode());
        }

        // Build the 10 LED elements once
        this._buildLeds();

        // Apply correct initial visibility
        this._applyModeVisibility();
    }

    // Build 10 LED <span> elements inside the LED container
    _buildLeds() {
        if (!this.meterLeds) return;
        this.meterLeds.innerHTML = '';
        this._ledElements = [];
        for (let i = 0; i < 10; i++) {
            const led = document.createElement('span');
            led.className = 'signal-meter-led';
            this.meterLeds.appendChild(led);
            this._ledElements.push(led);
        }
    }

    // Show/hide bar vs LED container based on current mode
    _applyModeVisibility() {
        const isLed = this.displayMode === 'dbfs-led' || this.displayMode === 'snr-led';
        if (this.meterContainer) {
            this.meterContainer.style.display = isLed ? 'none' : '';
        }
        if (this.meterLeds) {
            this.meterLeds.style.display = isLed ? 'flex' : 'none';
        }
    }
    
    // Cycle through all four display modes
    toggleDisplayMode() {
        const modes = ['dbfs', 'snr', 'dbfs-led', 'snr-led'];
        const idx = modes.indexOf(this.displayMode);
        this.displayMode = modes[(idx + 1) % modes.length];
        localStorage.setItem('signalMeterDisplayMode', this.displayMode);
        console.log(`Signal meter mode: ${this.displayMode}`);

        this._applyModeVisibility();

        // Update tooltips
        const modeLabels = { 'dbfs': 'dBFS bar', 'snr': 'SNR bar', 'dbfs-led': 'dBFS LED', 'snr-led': 'SNR LED' };
        const modeText = modeLabels[this.displayMode] || this.displayMode;
        const tip = `Click to cycle meter mode (currently: ${modeText})`;
        if (this.meterValue)    this.meterValue.title    = tip;
        if (this.meterContainer) this.meterContainer.title = tip;
        if (this.meterLeds)     this.meterLeds.title     = tip;
    }
    
    // Update noise floor from spectrum data (called by spectrum display)
    updateNoiseFloor(spectrumData) {
        if (!spectrumData || spectrumData.length === 0) return;
        
        // Find minimum value in spectrum data
        let currentMinDb = Infinity;
        for (let i = 0; i < spectrumData.length; i++) {
            const db = spectrumData[i];
            if (isFinite(db)) {
                currentMinDb = Math.min(currentMinDb, db);
            }
        }
        
        // Track minimum values over time for stable noise floor
        const now = Date.now();
        this.noiseFloorHistory.push({ value: currentMinDb, timestamp: now });
        
        // Remove values older than 2 seconds
        this.noiseFloorHistory = this.noiseFloorHistory.filter(m => now - m.timestamp <= this.noiseFloorHistoryMaxAge);
    }
    
    // Get current noise floor (average of recent minimums)
    getNoiseFloor() {
        if (this.noiseFloorHistory.length === 0) return -120;
        
        const avgMinDb = this.noiseFloorHistory.reduce((sum, m) => sum + m.value, 0) / this.noiseFloorHistory.length;
        return avgMinDb;
    }
    
    // Update signal meter based on peak (highest) dB in tuned bandwidth
    update(spectrumData, currentTunedFreq, currentBandwidthLow, currentBandwidthHigh, centerFreq, totalBandwidth) {
        if (!spectrumData || !currentTunedFreq || !totalBandwidth) {
            // Reset meter if no data
            this.reset();
            return;
        }
        
        // Update noise floor from full spectrum
        this.updateNoiseFloor(spectrumData);
        
        // Calculate frequency range for tuned bandwidth
        const startFreq = centerFreq - totalBandwidth / 2;
        const lowFreq = currentTunedFreq + currentBandwidthLow;
        const highFreq = currentTunedFreq + currentBandwidthHigh;
        
        // Convert frequencies to bin indices
        const lowBinFloat = ((lowFreq - startFreq) / totalBandwidth) * spectrumData.length;
        const highBinFloat = ((highFreq - startFreq) / totalBandwidth) * spectrumData.length;
        
        const lowBin = Math.max(0, Math.floor(lowBinFloat));
        const highBin = Math.min(spectrumData.length - 1, Math.ceil(highBinFloat));
        
        // Find peak (maximum) dB across the bandwidth
        let peakDb = -120;
        for (let i = lowBin; i <= highBin; i++) {
            if (i >= 0 && i < spectrumData.length) {
                peakDb = Math.max(peakDb, spectrumData[i]);
            }
        }
        
        // Add current peak to history with timestamp
        const now = Date.now();
        this.peakHistory.push({ value: peakDb, timestamp: now });
        
        // Remove peaks older than 500ms
        this.peakHistory = this.peakHistory.filter(p => now - p.timestamp <= this.peakHistoryMaxAge);
        
        // Calculate average of peaks in the window
        const avgPeakDb = this.peakHistory.reduce((sum, p) => sum + p.value, 0) / this.peakHistory.length;
        
        // Throttle display updates to every 100ms for smoother appearance
        if (now - this.lastMeterUpdate < this.meterUpdateInterval) {
            return;
        }
        this.lastMeterUpdate = now;
        
        // Update meter display
        this.updateDisplay(avgPeakDb);
    }
    
    // Update the visual display
    updateDisplay(avgPeakDb) {
        if (!this.meterBar || !this.meterValue) return;

        // Check data source selection (default to 'audio' if not set)
        const dataSource = window.signalDataSource || 'audio';

        let basebandPower, noiseDensity;

        if (dataSource === 'audio') {
            // Use audio stream data from radiod.
            // Use explicit undefined checks — the values are negative dBFS numbers,
            // so || -999 would incorrectly treat 0 as "no data". More importantly,
            // window.currentNoiseDensity may arrive later than currentBasebandPower
            // on some page loads, causing snr=null and the SNR needle to stay stuck.
            basebandPower = (window.currentBasebandPower !== undefined && window.currentBasebandPower !== null)
                ? window.currentBasebandPower : -999;
            noiseDensity = (window.currentNoiseDensity !== undefined && window.currentNoiseDensity !== null)
                ? window.currentNoiseDensity : -999;
        } else {
            // Use spectrum FFT data (original behavior)
            basebandPower = avgPeakDb;
            noiseDensity = this.getNoiseFloor();

            // Update global window variables so modal and other components can use spectrum data
            window.currentBasebandPower = basebandPower;
            window.currentNoiseDensity = noiseDensity;

            // Update SNR history for the graph with smoothing (same logic as audio packets)
            const snr = Math.max(0, basebandPower - noiseDensity);
            const timestamp = Date.now();

            // Add to smoothing history
            this.snrSmoothingHistory.push({ value: snr, timestamp: timestamp });

            // Remove old entries from smoothing history (older than 2 seconds)
            this.snrSmoothingHistory = this.snrSmoothingHistory.filter(entry => timestamp - entry.timestamp <= this.snrSmoothingMaxAge);

            // Only update SNR history every 100ms (throttled like audio packets)
            if (timestamp - this.lastSnrHistoryUpdate >= this.snrHistoryUpdateInterval) {
                // Calculate smoothed SNR (average over 2 second window)
                const smoothedSnr = this.snrSmoothingHistory.reduce((sum, entry) => sum + entry.value, 0) / this.snrSmoothingHistory.length;

                // Access global snrHistory array from app.js
                if (typeof window.snrHistory !== 'undefined') {
                    window.snrHistory.push({ value: smoothedSnr, timestamp: timestamp });

                    // Remove old entries (older than 10 seconds)
                    const SNR_HISTORY_MAX_AGE = 10000; // 10 seconds
                    window.snrHistory = window.snrHistory.filter(entry => timestamp - entry.timestamp <= SNR_HISTORY_MAX_AGE);
                }

                // Update modal display if it's open (every 100ms)
                if (typeof updateSignalQualityDisplay === 'function') {
                    updateSignalQualityDisplay();
                }

                this.lastSnrHistoryUpdate = timestamp;
            }
        }

        // Update S-meter needle if it exists
        if (typeof sMeterNeedle !== 'undefined' && sMeterNeedle) {
            // Guard against NaN/non-finite values from getFloat32() on malformed packets,
            // and against the -999 sentinel used when audio hasn't arrived yet.
            const bpValid = isFinite(basebandPower) && basebandPower !== -999;
            const ndValid = isFinite(noiseDensity) && noiseDensity !== -999;
            const snr = (bpValid && ndValid)
                ? Math.max(0, basebandPower - noiseDensity)
                : null;
            // Log transitions between null and valid SNR (not every frame)
            if (snr === null && this._lastSnrWasValid) {
                console.warn(`[SignalMeter] SNR went null: bp=${basebandPower}, nd=${noiseDensity}`);
                this._lastSnrWasValid = false;
            } else if (snr !== null && !this._lastSnrWasValid) {
                console.log(`[SignalMeter] SNR now valid: ${snr.toFixed(1)} dB (bp=${basebandPower.toFixed(1)}, nd=${noiseDensity.toFixed(1)})`);
                this._lastSnrWasValid = true;
            }
            sMeterNeedle.update(basebandPower, snr);
        }
        
        // ── Scale constants matching s-meter-needle.js ──────────────────────
        // dBFS: minDb = -127, maxDb = -33  (same as SMeterNeedle.minDb/maxDb)
        // SNR:  snrMin = 30,  snrMax = 60  (same as SMeterNeedle.snrMin/snrMax)
        const DBFS_MIN = -127;
        const DBFS_MAX = -33;
        const SNR_MIN  = 30;
        const SNR_MAX  = 60;

        // ── Colour helpers matching s-meter-needle.js ────────────────────────
        // sMeterColour: red at -115 → yellow at -91 → green at -73 (HSL 0→120)
        const sMeterColour = (dbfs) => {
            const clamped = Math.max(-115, Math.min(-73, dbfs));
            const hue = Math.round(((clamped + 115) / 42) * 120);
            return `hsl(${hue}, 90%, 55%)`;
        };
        // snrColour: red at 30 → green at 50 (HSL 0→120)
        const snrColour = (snr) => {
            const snrClamped = Math.max(30, Math.min(50, snr));
            const hue = Math.round(((snrClamped - 30) / 20) * 120);
            return `hsl(${hue}, 90%, 55%)`;
        };

        // Calculate SNR if in SNR-based mode
        const isSnrMode = this.displayMode === 'snr' || this.displayMode === 'snr-led';
        const isLedMode = this.displayMode === 'dbfs-led' || this.displayMode === 'snr-led';

        let displayValue = basebandPower;
        let displayText = '';

        if (isSnrMode) {
            const snr = basebandPower - noiseDensity;
            displayValue = snr;
            const snrText = snr.toFixed(1);
            const paddedSnrText = (Math.abs(snr) < 10) ? '\u00A0' + snrText : snrText;
            displayText = `${paddedSnrText} dB (SNR)`;
        } else {
            displayText = `${basebandPower.toFixed(1)} dBFS`;
        }

        // Linear percentage mapping — same range as S-meter needle
        let percentage;
        if (isSnrMode) {
            percentage = ((displayValue - SNR_MIN) / (SNR_MAX - SNR_MIN)) * 100;
        } else {
            percentage = ((basebandPower - DBFS_MIN) / (DBFS_MAX - DBFS_MIN)) * 100;
        }
        percentage = Math.max(0, Math.min(100, percentage));

        // Colour for the text label (based on current value)
        let color;
        if (isSnrMode) {
            color = snrColour(displayValue);
        } else {
            color = sMeterColour(basebandPower);
        }

        this.meterValue.textContent = displayText;
        this.meterValue.style.color = color;

        // Add flashing animation for extremely strong signals (only in dBFS bar mode)
        if (this.displayMode === 'dbfs' && basebandPower > DBFS_MAX) {
            this.meterValue.classList.add('flashing');
        } else {
            this.meterValue.classList.remove('flashing');
        }

        if (isLedMode) {
            // ── LED mode ─────────────────────────────────────────────────────
            if (this._ledElements && this._ledElements.length === 10) {
                const litCount = Math.round(percentage / 10); // 0–10 LEDs lit
                for (let i = 0; i < 10; i++) {
                    const led = this._ledElements[i];
                    if (i < litCount) {
                        // Compute this LED's intrinsic colour from its position on the scale
                        let ledColor;
                        if (isSnrMode) {
                            const ledSnr = SNR_MIN + (i / 9) * (SNR_MAX - SNR_MIN);
                            ledColor = snrColour(ledSnr);
                        } else {
                            const ledDbfs = DBFS_MIN + (i / 9) * (DBFS_MAX - DBFS_MIN);
                            ledColor = sMeterColour(ledDbfs);
                        }
                        led.style.background = ledColor;
                        led.style.boxShadow = `0 0 5px ${ledColor}`;
                        led.classList.add('lit');
                    } else {
                        led.style.background = '';
                        led.style.boxShadow = '';
                        led.classList.remove('lit');
                    }
                }
            }
        } else {
            // ── Bar mode ──────────────────────────────────────────────────────
            this.meterBar.style.width = percentage + '%';
            this.meterBar.style.background = color;
        }
    }

    // Reset meter display
    reset() {
        const isSnrMode = this.displayMode === 'snr' || this.displayMode === 'snr-led';
        const isLedMode = this.displayMode === 'dbfs-led' || this.displayMode === 'snr-led';

        if (this.meterValue) {
            const suffix = isSnrMode ? ' dB (SNR)' : ' dBFS';
            this.meterValue.textContent = '--' + suffix;
        }

        if (isLedMode) {
            if (this._ledElements) {
                this._ledElements.forEach(led => {
                    led.style.background = '';
                    led.style.boxShadow = '';
                    led.classList.remove('lit');
                });
            }
        } else {
            if (this.meterBar) this.meterBar.style.width = '0%';
        }
    }
}
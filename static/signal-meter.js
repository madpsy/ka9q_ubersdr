// Signal Meter - Displays signal strength with dBFS and SNR modes
// Extracted from spectrum-display.js for better modularity

class SignalMeter {
    constructor() {
        // Display mode: 'dbfs' or 'snr'
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
        
        // Add click handler to toggle between modes
        if (this.meterValue) {
            this.meterValue.style.cursor = 'pointer';
            this.meterValue.title = 'Click to toggle between dBFS and SNR';
            this.meterValue.addEventListener('click', () => this.toggleDisplayMode());
        }
        
        // Add click handler to meter bar as well
        if (this.meterContainer) {
            this.meterContainer.style.cursor = 'pointer';
            this.meterContainer.title = 'Click to toggle between dBFS and SNR';
            this.meterContainer.addEventListener('click', () => this.toggleDisplayMode());
        }
    }
    
    // Toggle between dBFS and SNR display modes
    toggleDisplayMode() {
        this.displayMode = this.displayMode === 'dbfs' ? 'snr' : 'dbfs';
        localStorage.setItem('signalMeterDisplayMode', this.displayMode);
        console.log(`Signal meter mode: ${this.displayMode.toUpperCase()}`);
        
        // Update tooltip
        const modeText = this.displayMode === 'dbfs' ? 'dBFS' : 'SNR (dB)';
        if (this.meterValue) {
            this.meterValue.title = `Click to toggle between dBFS and SNR (currently: ${modeText})`;
        }
        if (this.meterContainer) {
            this.meterContainer.title = `Click to toggle between dBFS and SNR (currently: ${modeText})`;
        }
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

        // Use audio stream data from radiod
        const basebandPower = window.currentBasebandPower || -999;
        const noiseDensity = window.currentNoiseDensity || -999;

        // Update S-meter needle if it exists
        if (typeof sMeterNeedle !== 'undefined' && sMeterNeedle) {
            const snr = (noiseDensity !== -999 && basebandPower !== -999)
                ? Math.max(0, basebandPower - noiseDensity)
                : null;
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

        // Calculate SNR if in SNR mode
        let displayValue = basebandPower;
        let displayText = '';

        if (this.displayMode === 'snr') {
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
        if (this.displayMode === 'snr') {
            percentage = ((displayValue - SNR_MIN) / (SNR_MAX - SNR_MIN)) * 100;
        } else {
            percentage = ((basebandPower - DBFS_MIN) / (DBFS_MAX - DBFS_MIN)) * 100;
        }
        percentage = Math.max(0, Math.min(100, percentage));

        this.meterBar.style.width = percentage + '%';
        this.meterValue.textContent = displayText;

        // Colour coding — mirrors s-meter-needle.js gradient logic
        let color;
        if (this.displayMode === 'snr') {
            color = snrColour(displayValue);
        } else {
            color = sMeterColour(basebandPower);
        }

        // Add flashing animation for extremely strong signals (only in dBFS mode, above S9+40 = -33 dBFS)
        if (this.displayMode === 'dbfs' && basebandPower > DBFS_MAX) {
            this.meterValue.classList.add('flashing');
        } else {
            this.meterValue.classList.remove('flashing');
        }

        this.meterBar.style.background = color;
        this.meterValue.style.color = color;
    }
    
    // Reset meter display
    reset() {
        if (this.meterBar) this.meterBar.style.width = '0%';
        if (this.meterValue) {
            const suffix = this.displayMode === 'snr' ? ' dB (SNR)' : ' dBFS';
            this.meterValue.textContent = '--' + suffix;
        }
    }
}
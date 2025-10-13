// Signal Meter - Displays signal strength with dBFS and SNR modes
// Extracted from spectrum-display.js for better modularity

class SignalMeter {
    constructor() {
        // Display mode: 'dbfs' or 'snr'
        this.displayMode = 'dbfs';
        
        // Peak history for smoothing
        this.peakHistory = [];
        this.peakHistoryMaxAge = 500; // 500ms window
        this.lastMeterUpdate = 0;
        this.meterUpdateInterval = 100; // Update display every 100ms
        
        // Noise floor tracking (same as line graph)
        this.noiseFloorHistory = [];
        this.noiseFloorHistoryMaxAge = 2000; // 2 second window for noise floor
        
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
        
        // Calculate SNR if in SNR mode
        let displayValue = avgPeakDb;
        let displayText = '';
        
        if (this.displayMode === 'snr') {
            const noiseFloor = this.getNoiseFloor();
            const snr = avgPeakDb - noiseFloor;
            displayValue = snr;
            displayText = `${snr.toFixed(1)} dB (SNR)`;
        } else {
            displayText = `${avgPeakDb.toFixed(1)} dBFS`;
        }
        
        // S-meter style logarithmic scale
        let percentage;
        if (this.displayMode === 'snr') {
            // SNR mode: 0-60 dB range
            // 0-20 dB: 0-40% (weak)
            // 20-40 dB: 40-80% (medium)
            // 40-60 dB: 80-100% (strong)
            if (displayValue < 20) {
                percentage = (displayValue / 20) * 40;
            } else if (displayValue < 40) {
                percentage = 40 + ((displayValue - 20) / 20) * 40;
            } else {
                percentage = 80 + ((displayValue - 40) / 20) * 20;
            }
        } else {
            // dBFS mode: -120 to -20 dB range
            // Weak signals (-120 to -80 dB) use 0-40% of meter
            // Medium signals (-80 to -60 dB) use 40-80% of meter
            // Strong signals (-60 to -20 dB) use 80-100% of meter (highly compressed)
            if (avgPeakDb < -80) {
                percentage = ((avgPeakDb + 120) / 40) * 40;
            } else if (avgPeakDb < -60) {
                percentage = 40 + ((avgPeakDb + 80) / 20) * 40;
            } else {
                percentage = 80 + ((avgPeakDb + 60) / 40) * 20;
            }
        }
        
        percentage = Math.max(0, Math.min(100, percentage));
        
        this.meterBar.style.width = percentage + '%';
        this.meterValue.textContent = displayText;
        
        // Color code both bar and text based on signal strength
        let color;
        if (this.displayMode === 'snr') {
            // SNR color coding
            if (displayValue >= 30) {
                color = '#28a745'; // Green - strong signal
            } else if (displayValue >= 15) {
                color = '#ffc107'; // Yellow - moderate signal
            } else {
                color = '#dc3545'; // Red - weak signal
            }
        } else {
            // dBFS color coding
            if (avgPeakDb >= -70) {
                color = '#28a745'; // Green - strong signal
            } else if (avgPeakDb >= -85) {
                color = '#ffc107'; // Yellow - moderate signal
            } else {
                color = '#dc3545'; // Red - weak signal
            }
        }
        
        // Add flashing animation for extremely strong signals (only in dBFS mode)
        if (this.displayMode === 'dbfs' && avgPeakDb > -30) {
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
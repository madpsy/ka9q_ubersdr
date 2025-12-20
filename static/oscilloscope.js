// Oscilloscope Display Module
// Handles waveform visualization with time and amplitude measurements

class Oscilloscope {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
        
        // Oscilloscope state
        this.zoom = 200; // Zoom level (1-200, affects timebase)
        this.triggerEnabled = false;
        this.triggerFreq = 0;
        this.yScale = 1.0; // Y-axis scale factor
        this.autoScaleEnabled = true;
        this.frequencyOffset = 0; // Frequency offset in Hz for adjusted dial frequency display
        this.freqHistory = []; // Store recent frequency measurements for averaging
        this.freqHistoryMaxSize = 60; // Average over last 60 samples (~2 seconds at 30fps)
        
        // Frequency tracking state
        this.trackingEnabled = false;
        this.trackingInterval = null;
        this.trackingStartFreq = null;
        this.trackingHistory = [];
        this.trackingStableCount = 0;
        this.trackingLocked = false;
        
        // Tracking constants
        this.TRACKING_LOCK_THRESHOLD = 2; // Hz
        this.TRACKING_UPDATE_RATE = 1000; // ms
        this.TRACKING_DRIFT_LIMIT = 1000; // Hz
        this.TRACKING_HISTORY_SIZE = 3;
        this.TRACKING_MIN_ERROR = 0.5; // Hz
        this.TRACKING_COARSE_THRESHOLD = 10; // Hz
        this.TRACKING_DAMPING_COARSE = 0.3;
        this.TRACKING_DAMPING_FINE = 0.5;
        
        // Throttling
        this.lastUpdate = 0;
        this.updateInterval = 33; // 30 fps
    }
    
    // Update oscilloscope display
    update(analyser, audioContext, currentMode, currentBandwidthLow, currentBandwidthHigh) {
        if (!analyser || !this.ctx) return;
        
        const now = performance.now();
        if (now - this.lastUpdate < this.updateInterval) return;
        this.lastUpdate = now;
        
        const bufferLength = analyser.fftSize;
        const dataArray = new Uint8Array(bufferLength);
        analyser.getByteTimeDomainData(dataArray);
        
        const width = this.canvas.width;
        const height = this.canvas.height;
        
        // Calculate frequency using zero-crossing detection
        const detectedFreq = this.detectFrequencyFromWaveform(dataArray, audioContext.sampleRate);
        
        // Add to frequency history for averaging
        if (detectedFreq > 0) {
            this.freqHistory.push(detectedFreq);
            if (this.freqHistory.length > this.freqHistoryMaxSize) {
                this.freqHistory.shift();
            }
        }
        
        // Calculate averaged frequency
        const avgFreq = this.freqHistory.length > 0
            ? this.freqHistory.reduce((sum, f) => sum + f, 0) / this.freqHistory.length
            : detectedFreq;
        
        // Calculate DC offset for AM/SAM modes
        let dcOffset = 128;
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i];
        }
        dcOffset = sum / dataArray.length;
        
        // Auto scale if enabled
        if (this.autoScaleEnabled) {
            let min = 255;
            let max = 0;
            
            for (let i = 0; i < dataArray.length; i++) {
                const centered = dataArray[i] - dcOffset + 128;
                min = Math.min(min, centered);
                max = Math.max(max, centered);
            }
            
            const minNorm = (min - 128) / 128;
            const maxNorm = (max - 128) / 128;
            const peakToPeak = maxNorm - minNorm;
            
            if (peakToPeak > 0.01) {
                const targetRange = 1.6;
                const newScale = targetRange / peakToPeak;
                const clampedScale = Math.max(0.1, Math.min(10, newScale));
                this.yScale = this.yScale * 0.9 + clampedScale * 0.1;
            }
        }
        
        // Calculate samples to display based on zoom
        const minFraction = 0.005;
        const maxFraction = 1.0;
        const logMin = Math.log10(minFraction);
        const logMax = Math.log10(maxFraction);
        const logRange = logMax - logMin;
        const normalizedSlider = (this.zoom - 1) / 199;
        const logValue = logMin + (normalizedSlider * logRange);
        const fraction = Math.pow(10, logValue);
        const samplesToDisplay = Math.floor(bufferLength * fraction);
        
        // Find trigger point if enabled
        let startSample;
        if (this.triggerEnabled && this.triggerFreq > 0) {
            const threshold = 128;
            let triggerPoint = -1;
            
            for (let i = 1; i < bufferLength / 2; i++) {
                if (dataArray[i - 1] < threshold && dataArray[i] >= threshold) {
                    triggerPoint = i;
                    break;
                }
            }
            
            if (triggerPoint >= 0 && triggerPoint + samplesToDisplay < bufferLength) {
                startSample = triggerPoint;
            } else {
                startSample = Math.floor((bufferLength - samplesToDisplay) / 2);
            }
        } else {
            startSample = Math.floor((bufferLength - samplesToDisplay) / 2);
        }
        
        // Clear canvas
        this.ctx.fillStyle = '#2c3e50';
        this.ctx.fillRect(0, 0, width, height);
        
        // Draw grid and labels
        this.drawGrid(width, height, analyser, audioContext);
        
        // Draw waveform
        this.ctx.lineWidth = 2;
        this.ctx.strokeStyle = '#00ff00';
        this.ctx.beginPath();
        
        const sliceWidth = width / samplesToDisplay;
        let x = 0;
        
        for (let i = 0; i < samplesToDisplay; i++) {
            const sampleIndex = startSample + i;
            const centered = dataArray[sampleIndex] - dcOffset + 128;
            const v = centered / 128.0;
            const scaledV = ((v - 1.0) * this.yScale) + 1.0;
            const y = (scaledV * height) / 2;
            
            if (i === 0) {
                this.ctx.moveTo(x, y);
            } else {
                this.ctx.lineTo(x, y);
            }
            
            x += sliceWidth;
        }
        
        this.ctx.stroke();
        
        // Draw frequency display
        this.drawFrequencyDisplay(width, avgFreq);
    }
    
    // Draw grid lines and labels
    drawGrid(width, height, analyser, audioContext) {
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        this.ctx.lineWidth = 1;
        this.ctx.font = 'bold 10px monospace';
        this.ctx.textAlign = 'left';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        
        // Horizontal grid lines (amplitude)
        for (let i = 0; i <= 4; i++) {
            const y = (i / 4) * height;
            this.ctx.beginPath();
            this.ctx.moveTo(0, y);
            this.ctx.lineTo(width, y);
            this.ctx.stroke();
            
            const baseAmplitude = 1.0 - (i / 4) * 2.0;
            const scaledAmplitude = baseAmplitude / this.yScale;
            const label = scaledAmplitude.toFixed(2);
            
            const textWidth = this.ctx.measureText(label).width;
            this.ctx.fillStyle = 'rgba(44, 62, 80, 0.8)';
            this.ctx.fillRect(2, y - 6, textWidth + 4, 12);
            
            this.ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
            this.ctx.fillText(label, 4, y);
        }
        
        // Vertical grid lines (time)
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'top';
        
        if (analyser && audioContext) {
            const bufferLength = analyser.fftSize;
            const sampleRate = audioContext.sampleRate;
            const totalTimeMs = (bufferLength / sampleRate) * 1000;
            const invertedZoom = 201 - this.zoom;
            const displayedTimeMs = totalTimeMs / invertedZoom;
            const timePerDivision = displayedTimeMs / 8;
            
            for (let i = 0; i <= 8; i++) {
                const x = (i / 8) * width;
                this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
                this.ctx.lineWidth = 1;
                this.ctx.beginPath();
                this.ctx.moveTo(x, 0);
                this.ctx.lineTo(x, height);
                this.ctx.stroke();
                
                if (i > 0 && i < 8) {
                    const timeValue = i * timePerDivision;
                    let timeLabel;
                    
                    if (timeValue >= 1) {
                        timeLabel = timeValue.toFixed(1) + 'ms';
                    } else {
                        timeLabel = (timeValue * 1000).toFixed(0) + 'µs';
                    }
                    
                    const textWidth = this.ctx.measureText(timeLabel).width;
                    this.ctx.fillStyle = 'rgba(44, 62, 80, 0.8)';
                    this.ctx.fillRect(x - textWidth / 2 - 2, height - 14, textWidth + 4, 12);
                    
                    this.ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
                    this.ctx.fillText(timeLabel, x, height - 12);
                }
            }
        }
        
        // Draw center line
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(0, height / 2);
        this.ctx.lineTo(width, height / 2);
        this.ctx.stroke();
    }
    
    // Draw frequency display
    drawFrequencyDisplay(width, avgFreq) {
        if (avgFreq <= 0) return;
        
        const height = this.canvas.height;
        
        this.ctx.font = 'bold 14px monospace';
        this.ctx.textAlign = 'right';
        this.ctx.textBaseline = 'top';
        
        const freqText = `${Math.round(avgFreq)} Hz`;
        
        let adjustedFreqText = '';
        let totalHeight = 20;
        
        if (this.trackingEnabled) {
            const freqInput = document.getElementById('frequency');
            if (freqInput) {
                const currentDialFreq = parseInt(freqInput.value);
                if (!isNaN(currentDialFreq)) {
                    const adjustedDialFreq = currentDialFreq + this.frequencyOffset;
                    adjustedFreqText = `${(adjustedDialFreq / 1000).toFixed(2)} kHz`;
                    totalHeight = 40;
                }
            }
        }
        
        const textWidth = Math.max(
            this.ctx.measureText(freqText).width,
            adjustedFreqText ? this.ctx.measureText(adjustedFreqText).width : 0
        );
        
        this.ctx.fillStyle = 'rgba(44, 62, 80, 0.9)';
        this.ctx.fillRect(width - textWidth - 12, 4, textWidth + 8, totalHeight);
        
        this.ctx.strokeStyle = '#000000';
        this.ctx.lineWidth = 3;
        this.ctx.strokeText(freqText, width - 6, 6);
        
        this.ctx.fillStyle = '#00ff00';
        this.ctx.fillText(freqText, width - 6, 6);
        
        if (adjustedFreqText) {
            this.ctx.font = 'bold 12px monospace';
            this.ctx.strokeStyle = '#000000';
            this.ctx.lineWidth = 3;
            this.ctx.strokeText(adjustedFreqText, width - 6, 24);
            
            this.ctx.fillStyle = '#ffaa00';
            this.ctx.fillText(adjustedFreqText, width - 6, 24);
        }
    }
    
    // Detect frequency from waveform using zero-crossing
    detectFrequencyFromWaveform(dataArray, sampleRate) {
        if (!dataArray || dataArray.length < 2) return 0;
        
        const zeroCrossings = [];
        const threshold = 128;
        
        for (let i = 1; i < dataArray.length; i++) {
            const prev = dataArray[i - 1];
            const curr = dataArray[i];
            
            if (prev < threshold && curr >= threshold) {
                const fraction = (threshold - prev) / (curr - prev);
                const crossingIndex = (i - 1) + fraction;
                zeroCrossings.push(crossingIndex);
            }
        }
        
        if (zeroCrossings.length < 2) return 0;
        
        let totalPeriod = 0;
        for (let i = 1; i < zeroCrossings.length; i++) {
            totalPeriod += zeroCrossings[i] - zeroCrossings[i - 1];
        }
        const avgPeriod = totalPeriod / (zeroCrossings.length - 1);
        
        const frequency = sampleRate / avgPeriod;
        
        if (frequency < 20 || frequency > 20000) return 0;
        
        return frequency;
    }
    
    // Update zoom level
    setZoom(value) {
        this.zoom = value;
    }
    
    // Toggle auto scale
    toggleAutoScale() {
        this.autoScaleEnabled = !this.autoScaleEnabled;
        if (!this.autoScaleEnabled) {
            this.yScale = 1.0;
        }
        return this.autoScaleEnabled;
    }
    
    // Auto sync (trigger lock)
    autoSync(analyser, audioContext) {
        if (this.triggerEnabled) {
            this.triggerEnabled = false;
            this.triggerFreq = 0;
            return false;
        }
        
        if (!analyser || !audioContext) return false;
        
        const bufferLength = analyser.fftSize;
        const frequencyData = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(frequencyData);
        
        const sampleRate = audioContext.sampleRate;
        const nyquist = sampleRate / 2;
        
        let maxMagnitude = 0;
        let maxBinIndex = 0;
        
        for (let i = 0; i < frequencyData.length; i++) {
            if (frequencyData[i] > maxMagnitude) {
                maxMagnitude = frequencyData[i];
                maxBinIndex = i;
            }
        }
        
        if (maxMagnitude < 50) return false;
        
        const detectedFreq = (maxBinIndex / frequencyData.length) * nyquist;
        
        if (detectedFreq < 20 || detectedFreq > 20000) return false;
        
        const periodSeconds = 1 / detectedFreq;
        const periodMs = periodSeconds * 1000;
        const targetCycles = 2.5;
        const targetTimeMs = periodMs * targetCycles;
        const totalBufferTimeMs = (bufferLength / audioContext.sampleRate) * 1000;
        const targetFraction = targetTimeMs / totalBufferTimeMs;
        
        const minFraction = 0.005;
        const maxFraction = 1.0;
        const logMin = Math.log10(minFraction);
        const logMax = Math.log10(maxFraction);
        const logRange = logMax - logMin;
        const clampedFraction = Math.max(minFraction, Math.min(maxFraction, targetFraction));
        const logValue = Math.log10(clampedFraction);
        const normalizedSlider = (logValue - logMin) / logRange;
        const targetSliderValue = Math.round(1 + (normalizedSlider * 199));
        const clampedValue = Math.max(1, Math.min(200, targetSliderValue));
        
        this.zoom = clampedValue;
        this.triggerEnabled = true;
        this.triggerFreq = detectedFreq;
        
        return { frequency: detectedFreq, zoom: clampedValue };
    }
    
    // Resize canvas
    resize() {
        if (!this.canvas) return;
        
        const rect = this.canvas.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            this.canvas.width = Math.floor(rect.width);
            this.canvas.height = Math.floor(rect.height);
        }
    }
}

// Export for use in app.js
window.Oscilloscope = Oscilloscope;
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

        // --- Time markers ---
        // markersEnabled: whether the marker overlay is shown
        this.markersEnabled = false;
        // Marker positions as fractions of canvas width (0.0 – 1.0)
        this.markerA = 0.25;
        this.markerB = 0.75;
        // Which marker is being dragged: null | 'A' | 'B'
        this._draggingMarker = null;
        // Cache bufferLength and sampleRate so _drawMarkerReadout() can recompute
        // the displayed time dynamically from the current zoom at draw time.
        this._cachedBufferLength = 0;
        this._cachedSampleRate = 0;
        // Snapshot of the canvas pixels taken just before markers are drawn,
        // so we can restore it when redrawing markers while paused.
        this._frozenSnapshot = null;

        // Bind mouse handlers once so we can remove them on destroy
        this._onMouseDown = this._markerMouseDown.bind(this);
        this._onMouseMove = this._markerMouseMove.bind(this);
        this._onMouseUp   = this._markerMouseUp.bind(this);

        if (this.canvas) {
            this.canvas.addEventListener('mousedown', this._onMouseDown);
            window.addEventListener('mousemove', this._onMouseMove);
            window.addEventListener('mouseup',   this._onMouseUp);
        }
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

        // Cache bufferLength and sampleRate so _drawMarkerReadout() can compute
        // the actual displayed time from the current zoom at draw time.
        const sampleRate = audioContext.sampleRate;
        this._cachedBufferLength = bufferLength;
        this._cachedSampleRate = sampleRate;
        
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

        // Draw time markers (on top of waveform).
        // Take a snapshot of the canvas just before drawing markers so we can
        // restore it when the user drags a marker while the visualization is paused.
        if (this.markersEnabled) {
            this._frozenSnapshot = this.ctx.getImageData(0, 0, width, height);
            this.drawMarkers(width, height);
        } else {
            this._frozenSnapshot = null;
        }
        
        // Draw frequency display
        this.drawFrequencyDisplay(width, avgFreq);
    }

    // -----------------------------------------------------------------------
    // Time marker drawing
    // -----------------------------------------------------------------------

    drawMarkers(width, height) {
        const ctx = this.ctx;
        const xA = Math.round(this.markerA * width);
        const xB = Math.round(this.markerB * width);

        // --- Marker A (cyan) ---
        ctx.save();
        ctx.strokeStyle = '#00e5ff';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(xA, 0);
        ctx.lineTo(xA, height);
        ctx.stroke();
        ctx.setLineDash([]);

        // Label "A" at top
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(xA - 8, 2, 16, 14);
        ctx.fillStyle = '#00e5ff';
        ctx.fillText('A', xA, 3);
        ctx.restore();

        // --- Marker B (yellow) ---
        ctx.save();
        ctx.strokeStyle = '#ffd600';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(xB, 0);
        ctx.lineTo(xB, height);
        ctx.stroke();
        ctx.setLineDash([]);

        // Label "B" at top
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(xB - 8, 2, 16, 14);
        ctx.fillStyle = '#ffd600';
        ctx.fillText('B', xB, 3);
        ctx.restore();

        // --- ΔT readout ---
        this._drawMarkerReadout(width, height);
    }

    // Compute the actual displayed time span in ms from the current zoom level,
    // using the same log-scale formula as the waveform drawing code.
    _computeDisplayedTimeMs() {
        if (!this._cachedBufferLength || !this._cachedSampleRate) return 0;
        const minFraction = 0.005;
        const maxFraction = 1.0;
        const logMin = Math.log10(minFraction);
        const logMax = Math.log10(maxFraction);
        const logRange = logMax - logMin;
        const normalizedSlider = (this.zoom - 1) / 199;
        const logValue = logMin + (normalizedSlider * logRange);
        const fraction = Math.pow(10, logValue);
        const samplesToDisplay = Math.floor(this._cachedBufferLength * fraction);
        return (samplesToDisplay / this._cachedSampleRate) * 1000;
    }

    _drawMarkerReadout(width, height) {
        const displayedTimeMs = this._computeDisplayedTimeMs();
        if (displayedTimeMs <= 0) return;

        const ctx = this.ctx;
        const deltaFrac = Math.abs(this.markerB - this.markerA);
        const deltaMs = deltaFrac * displayedTimeMs;

        let deltaLabel;
        if (deltaMs >= 1) {
            deltaLabel = deltaMs.toFixed(3) + ' ms';
        } else {
            deltaLabel = (deltaMs * 1000).toFixed(1) + ' µs';
        }

        let freqLabel = '';
        if (deltaMs > 0) {
            const impliedFreq = 1000 / deltaMs; // Hz
            if (impliedFreq >= 1000) {
                freqLabel = ' = ' + (impliedFreq / 1000).toFixed(2) + ' kHz';
            } else {
                freqLabel = ' = ' + impliedFreq.toFixed(1) + ' Hz';
            }
        }

        const line1 = `ΔT: ${deltaLabel}${freqLabel}`;

        ctx.save();
        ctx.font = 'bold 12px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';

        const padding = 5;
        const boxW = ctx.measureText(line1).width + padding * 2;
        const boxH = 18;

        // Position: bottom-left, above the time scale labels
        const bx = 4;
        const by = height - boxH - 18; // 18px above bottom to clear time labels

        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.fillRect(bx, by, boxW, boxH);

        ctx.fillStyle = '#ffffff';
        ctx.fillText(line1, bx + padding, by + 3);
        ctx.restore();
    }

    // -----------------------------------------------------------------------
    // Mouse interaction for dragging markers
    // -----------------------------------------------------------------------

    _markerHitTest(fracX) {
        // Returns 'A', 'B', or null depending on which marker is within 8px
        if (!this.canvas) return null;
        const width = this.canvas.width;
        const pxA = this.markerA * width;
        const pxB = this.markerB * width;
        const px  = fracX * width;
        const hitRadius = 8;
        const dA = Math.abs(px - pxA);
        const dB = Math.abs(px - pxB);
        if (dA <= hitRadius && dA <= dB) return 'A';
        if (dB <= hitRadius) return 'B';
        return null;
    }

    _canvasFracX(e) {
        if (!this.canvas) return 0;
        const rect = this.canvas.getBoundingClientRect();
        const cssX = e.clientX - rect.left;
        return Math.max(0, Math.min(1, cssX / rect.width));
    }

    _markerMouseDown(e) {
        if (!this.markersEnabled) return;
        const frac = this._canvasFracX(e);
        const hit = this._markerHitTest(frac);
        if (hit) {
            this._draggingMarker = hit;
            e.preventDefault();
        }
    }

    _markerMouseMove(e) {
        if (!this._draggingMarker || !this.canvas) return;
        const frac = this._canvasFracX(e);
        if (this._draggingMarker === 'A') {
            this.markerA = frac;
        } else {
            this.markerB = frac;
        }
        // Update cursor style
        this.canvas.style.cursor = 'ew-resize';

        // If the visualization is paused (update() is not being called), we still
        // need to redraw the markers on top of the frozen waveform so the user
        // can see them move in real time.
        if (this._frozenSnapshot && this.ctx) {
            const w = this.canvas.width;
            const h = this.canvas.height;
            this.ctx.putImageData(this._frozenSnapshot, 0, 0);
            this.drawMarkers(w, h);
        }

        e.preventDefault();
    }

    _markerMouseUp(e) {
        if (this._draggingMarker) {
            this._draggingMarker = null;
            if (this.canvas) this.canvas.style.cursor = '';
        }
    }

    // Toggle markers on/off; returns new state
    toggleMarkers() {
        this.markersEnabled = !this.markersEnabled;
        // Reset to sensible default positions when enabling
        if (this.markersEnabled) {
            this.markerA = 0.25;
            this.markerB = 0.75;
        }
        return this.markersEnabled;
    }

    // Draw markers on top of the current canvas content without waiting for update().
    // Called when markers are enabled while the visualization is paused — takes a
    // snapshot of whatever is currently on the canvas, stores it as _frozenSnapshot,
    // then draws the marker overlay on top.
    drawMarkersOnFrozenCanvas() {
        if (!this.canvas || !this.ctx || !this.markersEnabled) return;
        const w = this.canvas.width;
        const h = this.canvas.height;
        if (w <= 0 || h <= 0) return;
        // Capture the current canvas as the frozen background
        this._frozenSnapshot = this.ctx.getImageData(0, 0, w, h);
        this.drawMarkers(w, h);
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
            // Use the same log-scale formula as the waveform drawing so grid
            // time labels match what is actually displayed on screen.
            const bufferLength = analyser.fftSize;
            const sampleRate = audioContext.sampleRate;
            const minFraction = 0.005;
            const maxFraction = 1.0;
            const logMin = Math.log10(minFraction);
            const logMax = Math.log10(maxFraction);
            const logRange = logMax - logMin;
            const normalizedSlider = (this.zoom - 1) / 199;
            const logValue = logMin + (normalizedSlider * logRange);
            const fraction = Math.pow(10, logValue);
            const samplesToDisplay = Math.floor(bufferLength * fraction);
            const displayedTimeMs = (samplesToDisplay / sampleRate) * 1000;
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
                const currentDialFreq = parseInt(freqInput.getAttribute('data-hz-value') || freqInput.value);
                if (!isNaN(currentDialFreq)) {
                    const adjustedDialFreq = currentDialFreq + this.frequencyOffset;
                    const adjustedMHz = adjustedDialFreq / 1e6;
                    adjustedFreqText = adjustedMHz >= 1
                        ? `${adjustedMHz.toFixed(6)} MHz`
                        : `${(adjustedDialFreq / 1000).toFixed(3)} kHz`;
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

    // Clean up event listeners
    destroy() {
        if (this.canvas) {
            this.canvas.removeEventListener('mousedown', this._onMouseDown);
        }
        window.removeEventListener('mousemove', this._onMouseMove);
        window.removeEventListener('mouseup',   this._onMouseUp);
    }
}

// Export for use in app.js
window.Oscilloscope = Oscilloscope;

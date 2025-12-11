// Audio Visualizer for UberSDR Go Client
// Handles FFT spectrum analysis and waterfall display

class AudioVisualizer {
    constructor(spectrumCanvas, waterfallCanvas) {
        this.spectrumCanvas = spectrumCanvas;
        this.waterfallCanvas = waterfallCanvas;

        // FFT parameters - increased for more detail
        this.fftSize = 8192;  // Increased from 2048 for 4x more frequency resolution
        this.waterfallHistory = [];
        this.maxWaterfallLines = 200;

        // Display parameters - will be dynamically adjusted
        this.minDb = -80;
        this.maxDb = -20;

        // Bandwidth parameters (will be updated from app)
        this.bandwidthLow = 50;
        this.bandwidthHigh = 2700;
        this.currentMode = 'usb';

        // Get canvas contexts
        this.spectrumCtx = spectrumCanvas ? spectrumCanvas.getContext('2d') : null;
        this.waterfallCtx = waterfallCanvas ? waterfallCanvas.getContext('2d') : null;

        // Web Audio API components for efficient FFT (exactly like main app)
        // AudioContext will be created on first audio data (after user gesture)
        this.audioContext = null;
        this.analyser = null;
        this.channelSplitter = null;
        this.source = null;
        this.lastSampleRate = 0;

        // Animation frame for visualization updates
        this.animationFrameId = null;

        // Channel selection (0 = left, 1 = right) - default to left to avoid phase cancellation
        this.selectedChannel = 0;

        // Temporal smoothing for autoranging (like main app lines 237-241)
        this.minHistory = [];  // Track minimum values over time for stable noise floor
        this.maxHistory = [];  // Track maximum values over time for stable ceiling
        this.minHistoryMaxAge = 2000;   // 2 second window for noise floor
        this.maxHistoryMaxAge = 20000;  // 20 second window for maximum (handles FT8 cycles)

        // Cached display range values
        this.cachedMinDb = -100;
        this.cachedMaxDb = -20;

        // Waterfall auto-adjust parameters (like main app lines 5366-5371)
        this.waterfallNoiseFloorHistory = [];
        this.waterfallPeakHistory = [];
        this.waterfallHistorySize = 10;  // Average over 10 samples
        this.waterfallContrast = 0;      // Noise floor suppression (0-100)
        this.waterfallIntensity = 0;     // Brightness adjustment (-1 to +1)
    }

    // Update bandwidth settings from app
    updateBandwidth(low, high, mode) {
        this.bandwidthLow = low;
        this.bandwidthHigh = high;
        this.currentMode = mode;
        console.log(`AudioVisualizer bandwidth updated: ${low} to ${high} Hz (mode: ${mode})`);

        // For audio FFT, we should show the FULL audio spectrum, not just the bandwidth
        // The bandwidth is just for the RF signal, but the audio contains the full spectrum
        // So we'll display from 0 Hz to the full bandwidth extent
        // This matches how the main app works
    }

    async addAudioData(arrayBuffer, sampleRate, channels) {
        // Initialize AudioContext on first audio data (after user gesture)
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            // Resume AudioContext if suspended (required by browser autoplay policy)
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }
            this.initAnalyser();
        }

        if (!this.audioContext || !this.analyser) {
            return;
        }

        // Resume AudioContext if it got suspended
        if (this.audioContext.state === 'suspended') {
            try {
                await this.audioContext.resume();
            } catch (e) {
                console.warn('Failed to resume AudioContext:', e);
                return;
            }
        }

        // Convert PCM data to AudioBuffer (like main app does in playAudioBuffer)
        const dataView = new DataView(arrayBuffer);
        const numSamples = arrayBuffer.byteLength / 2;
        const samplesPerChannel = numSamples / channels;

        // Create audio buffer
        const audioBuffer = this.audioContext.createBuffer(channels, samplesPerChannel, sampleRate);

        // Fill channels
        for (let channel = 0; channel < channels; channel++) {
            const channelData = audioBuffer.getChannelData(channel);
            for (let i = 0; i < samplesPerChannel; i++) {
                const sampleIndex = (i * channels + channel) * 2;
                const sample = dataView.getInt16(sampleIndex, true);
                channelData[i] = sample / 32768.0;
            }
        }

        // Play the buffer through channel splitter and analyser
        // This prevents phase cancellation from stereo downmixing
        const source = this.audioContext.createBufferSource();
        source.buffer = audioBuffer;

        if (channels > 1 && this.channelSplitter) {
            // For stereo: split channels and connect only the selected channel
            source.connect(this.channelSplitter);
        } else {
            // For mono: connect directly
            source.connect(this.analyser);
        }
        source.start();
    }

    initAnalyser() {
        if (!this.audioContext) {
            return;
        }

        // Create analyser node with native FFT (exactly like main app)
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = this.fftSize;
        this.analyser.smoothingTimeConstant = 0.3; // Light smoothing for cleaner display

        // Create channel splitter to avoid phase cancellation in stereo
        // This splits stereo into separate left/right channels
        this.channelSplitter = this.audioContext.createChannelSplitter(2);

        // Connect the selected channel (default: left = 0) to the analyser
        this.channelSplitter.connect(this.analyser, this.selectedChannel);

        // Start visualization loop (like main app's startVisualization)
        this.startVisualization();
    }

    // Allow switching between left (0) and right (1) channels
    setChannel(channel) {
        if (channel !== 0 && channel !== 1) {
            console.warn('Invalid channel:', channel, '- must be 0 (left) or 1 (right)');
            return;
        }

        this.selectedChannel = channel;

        // Reconnect if analyser already exists
        if (this.channelSplitter && this.analyser) {
            this.channelSplitter.disconnect();
            this.channelSplitter.connect(this.analyser, this.selectedChannel);
            console.log(`AudioVisualizer now displaying channel ${channel === 0 ? 'LEFT' : 'RIGHT'}`);
        }
    }

    startVisualization() {
        // Throttle updates to 30fps max (like main app)
        let lastUpdate = 0;
        const updateInterval = 1000 / 30; // 30 fps

        const draw = () => {
            if (!this.analyser) return;

            const now = performance.now();
            if (now - lastUpdate < updateInterval) {
                this.animationFrameId = requestAnimationFrame(draw);
                return;
            }
            lastUpdate = now;

            // Get frequency data from analyser (like main app at line 4259-4260)
            const bufferLength = this.analyser.frequencyBinCount;
            const dbData = new Float32Array(bufferLength);
            this.analyser.getFloatFrequencyData(dbData);

            // Update visualizations
            this.drawSpectrum(dbData, this.audioContext.sampleRate);
            this.drawWaterfall(dbData, this.audioContext.sampleRate);

            this.animationFrameId = requestAnimationFrame(draw);
        };

        draw();
    }

    drawSpectrum(dbData, sampleRate) {
        if (!this.spectrumCtx) return;

        const ctx = this.spectrumCtx;
        const width = this.spectrumCanvas.width;
        const height = this.spectrumCanvas.height;

        // Clear canvas
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, width, height);

        // Calculate display range based on configured bandwidth
        // The bandwidth values are RF offsets (can be negative for LSB)
        // For audio FFT, we want to show from 0 Hz to the maximum extent
        const maxExtent = Math.max(Math.abs(this.bandwidthLow), Math.abs(this.bandwidthHigh));
        // Add 20% margin to show a bit beyond the filter edges
        const displayBandwidth = maxExtent * 1.2;

        // Debug logging (only log occasionally to avoid spam)
        if (Math.random() < 0.01) {
            console.log(`FFT Display: BW Low=${this.bandwidthLow}, High=${this.bandwidthHigh}, MaxExtent=${maxExtent}, Display=${displayBandwidth}`);
        }

        // Display from 0 to the bandwidth (with 20% margin)
        const binStartFreq = 0;
        const binEndFreq = displayBandwidth;
        const bandwidth = displayBandwidth;

        // Map to FFT bins using the ACTUAL sample rate (e.g., 48 kHz)
        const actualNyquist = sampleRate / 2;
        const startBin = Math.floor((binStartFreq / actualNyquist) * dbData.length);
        const binsForBandwidth = Math.floor((bandwidth / actualNyquist) * dbData.length);

        // Dynamic dB range with temporal smoothing (like main app lines 4286-4312)
        const now = Date.now();

        // Find min and max in current frame (only in visible bandwidth)
        let currentMinDb = 0;
        let currentMaxDb = -Infinity;
        for (let i = startBin; i < startBin + binsForBandwidth && i < dbData.length; i++) {
            const db = dbData[i];
            if (isFinite(db)) {
                currentMaxDb = Math.max(currentMaxDb, db);
                if (currentMinDb === 0 || db < currentMinDb) {
                    currentMinDb = db;
                }
            }
        }

        // Track minimum values over time for stable noise floor (2 second window)
        this.minHistory.push({ value: currentMinDb, timestamp: now });
        this.minHistory = this.minHistory.filter(m => now - m.timestamp <= this.minHistoryMaxAge);
        const avgMinDb = this.minHistory.length > 0
            ? this.minHistory.reduce((sum, m) => sum + m.value, 0) / this.minHistory.length
            : currentMinDb;

        // Track maximum values over time for stable ceiling (20 second window)
        this.maxHistory.push({ value: currentMaxDb, timestamp: now });
        this.maxHistory = this.maxHistory.filter(m => now - m.timestamp <= this.maxHistoryMaxAge);
        const avgMaxDb = this.maxHistory.length > 0
            ? this.maxHistory.reduce((sum, m) => sum + m.value, 0) / this.maxHistory.length
            : currentMaxDb;

        // Use smoothed values for display range
        const minDb = avgMinDb;
        const maxDb = avgMaxDb;
        let dbRange = maxDb - minDb;

        // Fallback to reasonable range if no valid data
        if (dbRange <= 0 || !isFinite(dbRange)) {
            this.cachedMinDb = -100;
            this.cachedMaxDb = -20;
        } else {
            this.cachedMinDb = minDb;
            this.cachedMaxDb = maxDb;
        }

        dbRange = this.cachedMaxDb - this.cachedMinDb;

        // Draw dB scale grid and labels
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        ctx.fillStyle = '#fff';
        ctx.font = '10px monospace';
        ctx.textAlign = 'right';

        for (let i = 0; i <= 4; i++) {
            const db = maxDb - (i / 4) * dbRange;
            const y = (i / 4) * height;

            // Grid line
            ctx.beginPath();
            ctx.moveTo(50, y);
            ctx.lineTo(width, y);
            ctx.stroke();

            // dB label
            ctx.fillText(`${db.toFixed(0)}`, 45, y + 4);
        }

        // Draw "dB" label
        ctx.textAlign = 'left';
        ctx.fillText('dB', 5, 15);


        // Draw spectrum line
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 2;
        ctx.beginPath();

        const numPoints = width - 50;
        const binsPerPoint = binsForBandwidth / numPoints;

        for (let i = 0; i < numPoints; i++) {
            // Average the bins for this point (like main app)
            const pointStartBin = startBin + (i * binsPerPoint);
            const pointEndBin = pointStartBin + binsPerPoint;

            let sum = 0;
            let count = 0;

            for (let binIndex = Math.floor(pointStartBin); binIndex < Math.ceil(pointEndBin) && binIndex < dbData.length; binIndex++) {
                sum += dbData[binIndex] || 0;
                count++;
            }

            const average = count > 0 ? sum / count : this.cachedMinDb;
            const normalized = (average - this.cachedMinDb) / dbRange;
            const y = height - (Math.max(0, Math.min(1, normalized)) * height);
            const x = 50 + i;

            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.stroke();

        // Draw frequency axis labels (show actual audio frequencies with 20% margin)
        ctx.fillStyle = '#fff';
        ctx.font = '10px monospace';
        ctx.textAlign = 'center';

        // Calculate appropriate label spacing based on display bandwidth
        let labelStep;
        if (displayBandwidth <= 100) {
            labelStep = 20;
        } else if (displayBandwidth <= 200) {
            labelStep = 50;
        } else if (displayBandwidth <= 500) {
            labelStep = 100;
        } else if (displayBandwidth <= 1000) {
            labelStep = 200;
        } else if (displayBandwidth <= 2000) {
            labelStep = 250;
        } else if (displayBandwidth <= 5000) {
            labelStep = 500;
        } else {
            labelStep = 1000;
        }

        // Draw labels from 0 to display bandwidth
        const startLabelFreq = 0;
        for (let freq = startLabelFreq; freq <= binEndFreq; freq += labelStep) {
            const pixelPos = (freq / bandwidth) * (width - 50);
            const x = 50 + pixelPos;

            const label = freq >= 1000 ? `${(freq/1000).toFixed(1)}k` : `${freq.toFixed(0)}`;
            ctx.fillText(label, x, height - 5);
        }

        // Draw "Hz" label
        ctx.textAlign = 'right';
        ctx.fillText('Hz', width - 5, height - 5);
    }

    drawWaterfall(dbData, sampleRate) {
        if (!this.waterfallCtx) return;

        const ctx = this.waterfallCtx;
        const width = this.waterfallCanvas.width;
        const height = this.waterfallCanvas.height;
        const leftMargin = 50; // Match spectrum's left margin for axis labels

        // Scroll existing content down by 1 pixel (efficient like main app)
        ctx.drawImage(this.waterfallCanvas, 0, 0, width, height - 1, 0, 1, width, height - 1);

        // Clear the left margin area
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, leftMargin, 1);

        // Calculate display range based on configured bandwidth
        // The bandwidth values are RF offsets (can be negative for LSB)
        // For audio FFT, we want to show from 0 Hz to the maximum extent
        const maxExtent = Math.max(Math.abs(this.bandwidthLow), Math.abs(this.bandwidthHigh));
        // Add 20% margin to show a bit beyond the filter edges
        const displayBandwidth = maxExtent * 1.2;

        // Display from 0 to the bandwidth (with 20% margin)
        const binStartFreq = 0;
        const binEndFreq = displayBandwidth;
        const bandwidth = displayBandwidth;

        // Map to FFT bins using the ACTUAL sample rate (e.g., 48 kHz)
        const actualNyquist = sampleRate / 2;
        const startBin = Math.floor((binStartFreq / actualNyquist) * dbData.length);
        const binsForBandwidth = Math.floor((bandwidth / actualNyquist) * dbData.length);

        // Waterfall auto-adjust (like main app lines 5375-5463)
        // Collect all dB values in visible bandwidth for percentile calculation
        const visibleValues = [];
        for (let i = startBin; i < startBin + binsForBandwidth && i < dbData.length; i++) {
            const db = dbData[i];
            if (isFinite(db)) {
                visibleValues.push(db);
            }
        }

        // Update auto-adjust parameters if we have data
        if (visibleValues.length > 0) {
            // Sort for percentile calculation
            visibleValues.sort((a, b) => a - b);

            // Use percentiles to handle outliers
            // 10th percentile for noise floor (ignores very weak noise spikes)
            // 99th percentile for peak level (captures nearly all signals)
            const noiseFloorIndex = Math.floor(visibleValues.length * 0.10);
            const peakIndex = Math.floor(visibleValues.length * 0.99);

            const noiseFloor = visibleValues[noiseFloorIndex];
            const peak = visibleValues[peakIndex];

            // Add to history for temporal smoothing
            this.waterfallNoiseFloorHistory.push(noiseFloor);
            this.waterfallPeakHistory.push(peak);

            if (this.waterfallNoiseFloorHistory.length > this.waterfallHistorySize) {
                this.waterfallNoiseFloorHistory.shift();
            }
            if (this.waterfallPeakHistory.length > this.waterfallHistorySize) {
                this.waterfallPeakHistory.shift();
            }

            // Calculate smoothed values if we have enough history
            if (this.waterfallNoiseFloorHistory.length >= this.waterfallHistorySize) {
                const avgNoiseFloor = this.waterfallNoiseFloorHistory.reduce((sum, v) => sum + v, 0) / this.waterfallNoiseFloorHistory.length;
                const avgPeak = this.waterfallPeakHistory.reduce((sum, v) => sum + v, 0) / this.waterfallPeakHistory.length;

                // Calculate dynamic range
                const dynamicRange = avgPeak - avgNoiseFloor;

                // Calculate optimal contrast (noise floor suppression)
                // Set contrast just above noise floor to preserve all signals
                const contrastDb = avgNoiseFloor + (dynamicRange * 0.05);

                // Calculate optimal intensity based on dynamic range
                if (dynamicRange < 20) {
                    this.waterfallIntensity = 0.5;  // Low dynamic range - boost significantly
                } else if (dynamicRange < 40) {
                    this.waterfallIntensity = 0.3;  // Medium dynamic range - moderate boost
                } else if (dynamicRange < 60) {
                    this.waterfallIntensity = 0.1;  // Good dynamic range - slight boost
                } else {
                    this.waterfallIntensity = 0.0;  // Excellent dynamic range - no boost
                }

                // Store contrast threshold
                this.waterfallContrast = contrastDb;
            }
        }

        // Use cached display range from spectrum (for consistency)
        const minDb = this.cachedMinDb;
        const maxDb = this.cachedMaxDb;
        const dbRange = maxDb - minDb;

        // Draw new line at top (starting after left margin)
        const displayWidth = width - leftMargin;
        const binsPerPixel = binsForBandwidth / displayWidth;

        for (let x = 0; x < displayWidth; x++) {
            // Average the bins for this pixel (like main app)
            const pixelStartBin = startBin + (x * binsPerPixel);
            const pixelEndBin = pixelStartBin + binsPerPixel;

            let sum = 0;
            let count = 0;

            for (let binIndex = Math.floor(pixelStartBin); binIndex < Math.ceil(pixelEndBin) && binIndex < dbData.length; binIndex++) {
                sum += dbData[binIndex] || 0;
                count++;
            }

            let average = count > 0 ? sum / count : minDb;

            // Apply contrast threshold (noise floor suppression)
            if (this.waterfallNoiseFloorHistory.length >= this.waterfallHistorySize) {
                if (average < this.waterfallContrast) {
                    average = minDb;  // Suppress below threshold
                } else {
                    // Rescale remaining values to use full range
                    average = minDb + ((average - this.waterfallContrast) / (maxDb - this.waterfallContrast)) * dbRange;
                }
            }

            // Apply intensity adjustment
            let normalized = (average - minDb) / dbRange;
            if (this.waterfallIntensity < 0) {
                // Reduce intensity (darken)
                normalized = normalized * (1 + this.waterfallIntensity);
            } else if (this.waterfallIntensity > 0) {
                // Increase intensity (brighten)
                normalized = Math.min(1, normalized * (1 + this.waterfallIntensity * 2));
            }

            const color = this.dbToColor(Math.max(0, Math.min(1, normalized)));

            ctx.fillStyle = color;
            ctx.fillRect(leftMargin + x, 0, 1, 1);
        }
    }

    dbToColor(normalized) {
        // Color gradient: blue (low) -> cyan -> green -> yellow -> red (high)
        let r, g, b;

        if (normalized < 0.25) {
            const t = normalized / 0.25;
            r = 0;
            g = Math.floor(t * 255);
            b = 255;
        } else if (normalized < 0.5) {
            const t = (normalized - 0.25) / 0.25;
            r = 0;
            g = 255;
            b = Math.floor((1 - t) * 255);
        } else if (normalized < 0.75) {
            const t = (normalized - 0.5) / 0.25;
            r = Math.floor(t * 255);
            g = 255;
            b = 0;
        } else {
            const t = (normalized - 0.75) / 0.25;
            r = 255;
            g = Math.floor((1 - t) * 255);
            b = 0;
        }

        return `rgb(${r},${g},${b})`;
    }

    clear() {
        this.waterfallHistory = [];

        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }

        if (this.spectrumCtx) {
            this.spectrumCtx.fillStyle = '#1a1a1a';
            this.spectrumCtx.fillRect(0, 0, this.spectrumCanvas.width, this.spectrumCanvas.height);
        }

        if (this.waterfallCtx) {
            this.waterfallCtx.fillStyle = '#000';
            this.waterfallCtx.fillRect(0, 0, this.waterfallCanvas.width, this.waterfallCanvas.height);
        }

        // Close AudioContext when clearing
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
            this.analyser = null;
        }
    }
}
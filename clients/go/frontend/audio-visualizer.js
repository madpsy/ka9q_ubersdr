// Audio Visualizer for UberSDR Go Client
// Handles FFT spectrum analysis and waterfall display

class AudioVisualizer {
    constructor(spectrumCanvas, waterfallCanvas) {
        this.spectrumCanvas = spectrumCanvas;
        this.waterfallCanvas = waterfallCanvas;

        // FFT parameters - increased for more detail
        this.fftSize = 16384;  // Increased for better frequency resolution
        this.waterfallHistory = [];
        this.maxWaterfallLines = 200;

        // Waterfall ImageData (like RF spectrum)
        this.waterfallImageData = null;

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

        // Peak tracking with averaging (like Python client)
        this.peakHistory = [];  // Store last peaks
        this.peakTimestamps = [];
        this.peakAverageWindow = 500;  // 500ms averaging window

        // Waterfall auto-adjust parameters (like main app lines 5366-5371)
        this.waterfallNoiseFloorHistory = [];
        this.waterfallPeakHistory = [];
        this.waterfallHistorySize = 10;  // Average over 10 samples
        this.waterfallContrast = 0;      // Noise floor suppression (0-100)
        this.waterfallIntensity = 0;     // Brightness adjustment (-1 to +1)

        // Cursor/tooltip state (like RF spectrum)
        this.cursorX = -1;
        this.cursorY = -1;
        this.cursorCanvas = null;  // Track which canvas is being hovered
        this.cursorFreq = 0;
        this.cursorDbValue = null;

        // Current FFT data for tooltip
        this.currentDbData = null;
        this.currentSampleRate = 0;

        // Setup mouse handlers for tooltip
        this.setupMouseHandlers();

        // Initialize waterfall ImageData
        this.initWaterfall();
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
        this.analyser.smoothingTimeConstant = 0; // No smoothing for more responsive display (like Python client)

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

            // Store current data for tooltip
            this.currentDbData = dbData;
            this.currentSampleRate = this.audioContext.sampleRate;

            // Update visualizations
            this.drawSpectrum(dbData, this.audioContext.sampleRate);
            this.drawWaterfall(dbData, this.audioContext.sampleRate);

            // Update peak display
            this.updatePeakDisplay(dbData, this.audioContext.sampleRate);

            // Draw cursor line and tooltip AFTER both spectrum and waterfall are drawn
            if (this.cursorX >= 0) {
                // Recalculate dB value at cursor position with updated spectrum data
                const marginLeft = 50;
                const marginRight = 0;
                const graphWidth = this.spectrumCanvas.width - marginLeft - marginRight;
                const x = this.cursorX - marginLeft;

                if (x >= 0 && x <= graphWidth && this.currentDbData && this.currentSampleRate > 0) {
                    const maxExtent = Math.max(Math.abs(this.bandwidthLow), Math.abs(this.bandwidthHigh));
                    const displayBandwidth = maxExtent * 1.1;
                    const freq = (x / graphWidth) * displayBandwidth;
                    const actualNyquist = this.currentSampleRate / 2;
                    const binIndex = Math.floor((freq / actualNyquist) * this.currentDbData.length);
                    if (binIndex >= 0 && binIndex < this.currentDbData.length) {
                        this.cursorDbValue = this.currentDbData[binIndex];
                    }
                }

                // Draw cursor line on both canvases (like RF spectrum)
                this.drawCursorLine(this.spectrumCanvas, this.cursorX);
                this.drawCursorLine(this.waterfallCanvas, this.cursorX);

                // Draw tooltip on the canvas being hovered (stored in cursorCanvas)
                const canvas = this.cursorCanvas || this.spectrumCanvas;
                this.drawTooltip(canvas, this.cursorX, this.cursorY, this.cursorFreq, this.cursorDbValue);
            }

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
        const displayBandwidth = maxExtent * 1.1;

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

        // Dynamic dB range using percentiles (like Python client)
        // Collect all valid dB values in visible bandwidth
        const visibleValues = [];
        for (let i = startBin; i < startBin + binsForBandwidth && i < dbData.length; i++) {
            const db = dbData[i];
            if (isFinite(db)) {
                visibleValues.push(db);
            }
        }

        let minDb, maxDb;
        if (visibleValues.length > 0) {
            // Sort for percentile calculation
            visibleValues.sort((a, b) => a - b);

            // Use percentiles to separate noise from signals (like Python client)
            // 5th percentile for noise floor, 95th percentile for signal peaks
            const p5Index = Math.floor(visibleValues.length * 0.05);
            const p95Index = Math.floor(visibleValues.length * 0.95);

            const p5 = visibleValues[p5Index];
            const p95 = visibleValues[p95Index];

            // Set min_db well below noise floor to show it properly (like Python: p5 - 10)
            minDb = p5 - 10;
            // Set max_db above typical peaks (like Python: p95 + 10)
            maxDb = p95 + 10;

            // Ensure reasonable range (at least 40 dB, max 80 dB)
            let dbRange = maxDb - minDb;
            if (dbRange < 40) {
                // Expand range symmetrically
                const center = (maxDb + minDb) / 2;
                minDb = center - 20;
                maxDb = center + 20;
            } else if (dbRange > 80) {
                // Limit range to avoid too much compression
                minDb = maxDb - 80;
            }
        } else {
            // Fallback to reasonable range if no valid data
            minDb = -100;
            maxDb = -20;
        }

        // Cache the calculated range
        this.cachedMinDb = minDb;
        this.cachedMaxDb = maxDb;
        const dbRange = maxDb - minDb;

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
        ctx.lineWidth = 1;
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

        // Draw filled area under the spectrum line (like RF spectrum)
        ctx.fillStyle = 'rgba(30, 144, 255, 0.3)';
        ctx.lineTo(width, height);
        ctx.lineTo(50, height);
        ctx.closePath();
        ctx.fill();

        // Draw white dashed vertical lines at bandwidth edges (matching Python client)
        this.drawBandwidthMarkers(ctx, width, height, displayBandwidth);

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

    drawBandwidthMarkers(ctx, width, height, displayBandwidth) {
        // Draw white dashed vertical lines showing the actual bandwidth edges
        // This matches the Python client's audio_spectrum_display.py _draw_bandwidth_markers method
        if (this.bandwidthLow === 0 && this.bandwidthHigh === 0) {
            return;
        }

        const leftMargin = 50;
        const graphWidth = width - leftMargin;
        const absLow = Math.abs(this.bandwidthLow);
        const absHigh = Math.abs(this.bandwidthHigh);

        // Check if this is CW mode
        const isCwMode = (this.bandwidthLow < 0 && this.bandwidthHigh > 0 && absLow < 500 && absHigh < 500);

        ctx.strokeStyle = '#FFFFFF';  // White
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 3]);  // Dashed pattern

        if (isCwMode) {
            // CW mode: show markers at 500 Hz ± bandwidth edges
            const cwOffset = 500;
            const lowMarker = cwOffset - absLow;
            const highMarker = cwOffset + absHigh;

            // Draw low edge marker
            if (lowMarker <= displayBandwidth) {
                const lowX = leftMargin + (lowMarker / displayBandwidth) * graphWidth;
                if (leftMargin <= lowX && lowX <= width) {
                    ctx.beginPath();
                    ctx.moveTo(lowX, 0);
                    ctx.lineTo(lowX, height);
                    ctx.stroke();
                }
            }

            // Draw high edge marker
            if (highMarker <= displayBandwidth) {
                const highX = leftMargin + (highMarker / displayBandwidth) * graphWidth;
                if (leftMargin <= highX && highX <= width) {
                    ctx.beginPath();
                    ctx.moveTo(highX, 0);
                    ctx.lineTo(highX, height);
                    ctx.stroke();
                }
            }
        } else if (this.bandwidthLow < 0 && this.bandwidthHigh > 0) {
            // Other symmetric modes (AM, FM): show the full span
            const bandwidthSpan = absLow + absHigh;

            // Draw marker at the full bandwidth edge
            if (bandwidthSpan <= displayBandwidth) {
                const markerX = leftMargin + (bandwidthSpan / displayBandwidth) * graphWidth;
                if (leftMargin <= markerX && markerX <= width) {
                    ctx.beginPath();
                    ctx.moveTo(markerX, 0);
                    ctx.lineTo(markerX, height);
                    ctx.stroke();
                }
            }
        } else {
            // Asymmetric mode (USB, LSB): show individual edges
            const lowFreq = absLow;
            const highFreq = absHigh;

            // Draw low edge marker
            if (lowFreq <= displayBandwidth) {
                const lowX = leftMargin + (lowFreq / displayBandwidth) * graphWidth;
                if (leftMargin <= lowX && lowX <= width) {
                    ctx.beginPath();
                    ctx.moveTo(lowX, 0);
                    ctx.lineTo(lowX, height);
                    ctx.stroke();
                }
            }

            // Draw high edge marker
            if (highFreq <= displayBandwidth) {
                const highX = leftMargin + (highFreq / displayBandwidth) * graphWidth;
                if (leftMargin <= highX && highX <= width) {
                    ctx.beginPath();
                    ctx.moveTo(highX, 0);
                    ctx.lineTo(highX, height);
                    ctx.stroke();
                }
            }
        }

        // Reset line style
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
    }

    initWaterfall() {
        if (!this.waterfallCtx) return;

        this.waterfallImageData = this.waterfallCtx.createImageData(
            this.waterfallCanvas.width,
            this.waterfallCanvas.height
        );
        // Fill with black
        for (let i = 0; i < this.waterfallImageData.data.length; i += 4) {
            this.waterfallImageData.data[i] = 26;     // R (matches #1a1a1a)
            this.waterfallImageData.data[i + 1] = 26; // G
            this.waterfallImageData.data[i + 2] = 26; // B
            this.waterfallImageData.data[i + 3] = 255; // A
        }
    }

    drawWaterfall(dbData, sampleRate) {
        if (!this.waterfallCtx || !this.waterfallImageData) return;

        const ctx = this.waterfallCtx;
        const width = this.waterfallCanvas.width;
        const height = this.waterfallCanvas.height;
        const leftMargin = 50; // Match spectrum's left margin for axis labels

        // Scroll waterfall down by manipulating ImageData directly (like RF spectrum)
        const imageData = this.waterfallImageData;
        const data = imageData.data;

        // Shift pixels down by one row
        for (let y = height - 1; y > 0; y--) {
            for (let x = 0; x < width; x++) {
                const srcIdx = ((y - 1) * width + x) * 4;
                const dstIdx = (y * width + x) * 4;
                data[dstIdx] = data[srcIdx];
                data[dstIdx + 1] = data[srcIdx + 1];
                data[dstIdx + 2] = data[srcIdx + 2];
                data[dstIdx + 3] = 255;
            }
        }

        // Calculate display range based on configured bandwidth
        // The bandwidth values are RF offsets (can be negative for LSB)
        // For audio FFT, we want to show from 0 Hz to the maximum extent
        const maxExtent = Math.max(Math.abs(this.bandwidthLow), Math.abs(this.bandwidthHigh));
        // Add 10% margin to show a bit beyond the filter edges (matching spectrum)
        const displayBandwidth = maxExtent * 1.1;

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

        // Fill left margin with black
        for (let x = 0; x < leftMargin; x++) {
            const idx = x * 4;
            data[idx] = 26;     // R (matches #1a1a1a)
            data[idx + 1] = 26; // G
            data[idx + 2] = 26; // B
            data[idx + 3] = 255; // A
        }

        // Add new spectrum line at top (starting after left margin)
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

            // Convert normalized value to RGB
            const rgb = this.dbToRgb(Math.max(0, Math.min(1, normalized)));

            // Write to ImageData
            const canvasX = leftMargin + x;
            const idx = canvasX * 4;
            data[idx] = rgb[0];
            data[idx + 1] = rgb[1];
            data[idx + 2] = rgb[2];
            data[idx + 3] = 255;
        }

        // Draw ImageData to canvas
        ctx.putImageData(imageData, 0, 0);

        // Draw white dashed vertical lines at bandwidth edges on waterfall (matching Python client)
        this.drawBandwidthMarkersOnWaterfall(ctx, width, height, displayBandwidth, leftMargin);
    }

    drawBandwidthMarkersOnWaterfall(ctx, width, height, displayBandwidth, leftMargin) {
        // Draw white dashed vertical lines showing the actual bandwidth edges on waterfall
        if (this.bandwidthLow === 0 && this.bandwidthHigh === 0) {
            return;
        }

        const graphWidth = width - leftMargin;
        const absLow = Math.abs(this.bandwidthLow);
        const absHigh = Math.abs(this.bandwidthHigh);

        // Check if this is CW mode
        const isCwMode = (this.bandwidthLow < 0 && this.bandwidthHigh > 0 && absLow < 500 && absHigh < 500);

        ctx.strokeStyle = '#FFFFFF';  // White
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 3]);  // Dashed pattern

        if (isCwMode) {
            // CW mode: show markers at 500 Hz ± bandwidth edges
            const cwOffset = 500;
            const lowMarker = cwOffset - absLow;
            const highMarker = cwOffset + absHigh;

            // Draw low edge marker
            if (lowMarker <= displayBandwidth) {
                const lowX = leftMargin + (lowMarker / displayBandwidth) * graphWidth;
                if (leftMargin <= lowX && lowX <= width) {
                    ctx.beginPath();
                    ctx.moveTo(lowX, 0);
                    ctx.lineTo(lowX, height);
                    ctx.stroke();
                }
            }

            // Draw high edge marker
            if (highMarker <= displayBandwidth) {
                const highX = leftMargin + (highMarker / displayBandwidth) * graphWidth;
                if (leftMargin <= highX && highX <= width) {
                    ctx.beginPath();
                    ctx.moveTo(highX, 0);
                    ctx.lineTo(highX, height);
                    ctx.stroke();
                }
            }
        } else if (this.bandwidthLow < 0 && this.bandwidthHigh > 0) {
            // Other symmetric modes (AM, FM): show the full span
            const bandwidthSpan = absLow + absHigh;

            // Draw marker at the full bandwidth edge
            if (bandwidthSpan <= displayBandwidth) {
                const markerX = leftMargin + (bandwidthSpan / displayBandwidth) * graphWidth;
                if (leftMargin <= markerX && markerX <= width) {
                    ctx.beginPath();
                    ctx.moveTo(markerX, 0);
                    ctx.lineTo(markerX, height);
                    ctx.stroke();
                }
            }
        } else {
            // Asymmetric mode (USB, LSB): show individual edges
            const lowFreq = absLow;
            const highFreq = absHigh;

            // Draw low edge marker
            if (lowFreq <= displayBandwidth) {
                const lowX = leftMargin + (lowFreq / displayBandwidth) * graphWidth;
                if (leftMargin <= lowX && lowX <= width) {
                    ctx.beginPath();
                    ctx.moveTo(lowX, 0);
                    ctx.lineTo(lowX, height);
                    ctx.stroke();
                }
            }

            // Draw high edge marker
            if (highFreq <= displayBandwidth) {
                const highX = leftMargin + (highFreq / displayBandwidth) * graphWidth;
                if (leftMargin <= highX && highX <= width) {
                    ctx.beginPath();
                    ctx.moveTo(highX, 0);
                    ctx.lineTo(highX, height);
                    ctx.stroke();
                }
            }
        }

        // Reset line style
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
    }

    dbToRgb(normalized) {
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

        return [r, g, b];
    }

    setupMouseHandlers() {
        if (!this.spectrumCanvas) return;

        // Mouse move - handle tooltip (for both spectrum and waterfall)
        const handleMouseMove = (e) => {
            const canvas = e.target;
            const rect = canvas.getBoundingClientRect();
            const marginLeft = 50;
            const marginRight = 0;
            const graphWidth = canvas.width - marginLeft - marginRight;

            // Get mouse position relative to canvas (accounting for canvas scaling)
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;
            const canvasX = (e.clientX - rect.left) * scaleX;
            const canvasY = (e.clientY - rect.top) * scaleY;

            const x = canvasX - marginLeft;

            // Clear tooltip if outside graph area
            if (x < 0 || x > graphWidth) {
                this.cursorX = -1;
                return;
            }

            // Calculate frequency at cursor
            const maxExtent = Math.max(Math.abs(this.bandwidthLow), Math.abs(this.bandwidthHigh));
            const displayBandwidth = maxExtent * 1.1;
            const freq = (x / graphWidth) * displayBandwidth;

            // Get dB value at cursor position
            let dbValue = null;
            if (this.currentDbData && this.currentSampleRate > 0) {
                const actualNyquist = this.currentSampleRate / 2;
                const binIndex = Math.floor((freq / actualNyquist) * this.currentDbData.length);
                if (binIndex >= 0 && binIndex < this.currentDbData.length) {
                    dbValue = this.currentDbData[binIndex];
                }
            }

            // Store cursor state
            this.cursorX = canvasX;
            this.cursorY = canvasY;
            this.cursorCanvas = canvas;  // Store which canvas is being hovered
            this.cursorFreq = freq;
            this.cursorDbValue = dbValue;
        };

        // Add handlers to both canvases
        this.spectrumCanvas.addEventListener('mousemove', handleMouseMove);
        if (this.waterfallCanvas) {
            this.waterfallCanvas.addEventListener('mousemove', handleMouseMove);
        }

        // Mouse leave - clear tooltip (for both canvases)
        const handleMouseLeave = () => {
            this.cursorX = -1;
        };

        this.spectrumCanvas.addEventListener('mouseleave', handleMouseLeave);
        if (this.waterfallCanvas) {
            this.waterfallCanvas.addEventListener('mouseleave', handleMouseLeave);
        }
    }

    drawCursorLine(canvas, x) {
        const ctx = canvas.getContext('2d');

        // Save the current state
        ctx.save();

        // Draw dashed white vertical line
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();

        // Restore the state
        ctx.restore();
    }

    drawTooltip(canvas, x, y, freq, dbValue) {
        const ctx = canvas.getContext('2d');

        // Format tooltip text
        let text = `${freq.toFixed(1)} Hz`;
        if (dbValue !== null && !isNaN(dbValue) && isFinite(dbValue)) {
            text += `\n${dbValue.toFixed(1)} dB`;
        }

        // Set font for measuring
        ctx.font = 'bold 9px monospace';

        // Measure text size
        const lines = text.split('\n');
        const lineHeight = 14;
        const textWidth = Math.max(...lines.map(line => ctx.measureText(line).width));
        const textHeight = lines.length * lineHeight;

        // Position tooltip (left or right of cursor depending on space)
        let tooltipX, anchor;
        if (x > canvas.width / 2) {
            tooltipX = x - 10;
            anchor = 'right';
        } else {
            tooltipX = x + 10;
            anchor = 'left';
        }
        const tooltipY = y - 10;

        // Draw white background
        ctx.fillStyle = 'white';
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 1;
        ctx.setLineDash([]);

        let bgX, bgY, bgWidth, bgHeight;
        if (anchor === 'right') {
            bgX = tooltipX - textWidth - 4;
            bgY = tooltipY - textHeight / 2 - 2;
            bgWidth = textWidth + 4;
            bgHeight = textHeight + 4;
        } else {
            bgX = tooltipX - 2;
            bgY = tooltipY - textHeight / 2 - 2;
            bgWidth = textWidth + 4;
            bgHeight = textHeight + 4;
        }

        ctx.fillRect(bgX, bgY, bgWidth, bgHeight);
        ctx.strokeRect(bgX, bgY, bgWidth, bgHeight);

        // Draw text
        ctx.fillStyle = 'black';
        ctx.textBaseline = 'middle';
        ctx.textAlign = anchor === 'right' ? 'right' : 'left';

        lines.forEach((line, i) => {
            const lineY = tooltipY - textHeight / 2 + (i + 0.5) * lineHeight;
            const lineX = anchor === 'right' ? tooltipX - 2 : tooltipX + 2;
            ctx.fillText(line, lineX, lineY);
        });
    }

    updatePeakDisplay(dbData, sampleRate) {
        // Find peak frequency and level within filter bandwidth (like Python client)
        if (!dbData || dbData.length === 0) return;

        const nyquist = sampleRate / 2;
        const absLow = Math.abs(this.bandwidthLow);
        const absHigh = Math.abs(this.bandwidthHigh);

        // Check if this is CW mode
        const isCwMode = (this.bandwidthLow < 0 && this.bandwidthHigh > 0 && absLow < 500 && absHigh < 500);

        let lowBin, highBin;

        if (isCwMode) {
            // CW mode: search around 500 Hz ± bandwidth
            const cwOffset = 500;
            const searchLow = cwOffset - absLow;
            const searchHigh = cwOffset + absHigh;
            lowBin = Math.floor((searchLow / nyquist) * dbData.length);
            highBin = Math.floor((searchHigh / nyquist) * dbData.length);
        } else if (this.bandwidthLow < 0 && this.bandwidthHigh > 0) {
            // Other symmetric modes: bandwidth spans from 0 to (abs(low) + abs(high))
            const bandwidthSpan = absLow + absHigh;
            lowBin = 0;
            highBin = Math.floor((bandwidthSpan / nyquist) * dbData.length);
        } else {
            // Asymmetric mode: use absolute values
            if (this.bandwidthLow < 0 && this.bandwidthHigh < 0) {
                // LSB mode: swap abs values
                lowBin = Math.floor((absHigh / nyquist) * dbData.length);
                highBin = Math.floor((absLow / nyquist) * dbData.length);
            } else {
                // USB mode: use normal order
                lowBin = Math.floor((absLow / nyquist) * dbData.length);
                highBin = Math.floor((absHigh / nyquist) * dbData.length);
            }
        }

        // Ensure valid range
        lowBin = Math.max(0, Math.min(lowBin, dbData.length - 1));
        highBin = Math.max(lowBin + 1, Math.min(highBin, dbData.length));

        // Find peak within bandwidth
        const bandwidthData = dbData.slice(lowBin, highBin);
        const validData = bandwidthData.filter(v => isFinite(v));

        if (validData.length === 0) {
            // Hide display if no valid data
            const peakDisplay = document.getElementById('audio-peak-display');
            if (peakDisplay) peakDisplay.style.display = 'none';
            return;
        }

        // Find instantaneous peak
        let peakIdx = 0;
        let peakDb = bandwidthData[0];
        for (let i = 1; i < bandwidthData.length; i++) {
            if (isFinite(bandwidthData[i]) && bandwidthData[i] > peakDb) {
                peakDb = bandwidthData[i];
                peakIdx = i;
            }
        }

        // Convert bin index to frequency
        const actualBin = lowBin + peakIdx;
        const peakFreq = (actualBin / dbData.length) * nyquist;

        // Add to history with timestamp
        const currentTime = performance.now();
        this.peakHistory.push({ freq: peakFreq, db: peakDb });
        this.peakTimestamps.push(currentTime);

        // Average peaks over last 500ms
        const cutoffTime = currentTime - this.peakAverageWindow;
        const recentPeaks = [];
        for (let i = 0; i < this.peakTimestamps.length; i++) {
            if (this.peakTimestamps[i] >= cutoffTime) {
                recentPeaks.push(this.peakHistory[i]);
            }
        }

        // Remove old entries
        while (this.peakTimestamps.length > 0 && this.peakTimestamps[0] < cutoffTime) {
            this.peakTimestamps.shift();
            this.peakHistory.shift();
        }

        if (recentPeaks.length === 0) {
            recentPeaks.push({ freq: peakFreq, db: peakDb });
        }

        // Calculate weighted average (more recent = higher weight)
        let totalWeight = 0;
        let weightedFreq = 0;
        let weightedDb = 0;

        for (let i = 0; i < recentPeaks.length; i++) {
            // Linear weight: newer samples get higher weight
            const weight = i + 1;
            weightedFreq += recentPeaks[i].freq * weight;
            weightedDb += recentPeaks[i].db * weight;
            totalWeight += weight;
        }

        const avgFreq = weightedFreq / totalWeight;
        const avgDb = weightedDb / totalWeight;

        // Update display
        const peakDisplay = document.getElementById('audio-peak-display');
        const peakFreqSpan = document.getElementById('audio-peak-freq');
        const peakLevelSpan = document.getElementById('audio-peak-level');

        if (peakDisplay && peakFreqSpan && peakLevelSpan) {
            peakFreqSpan.textContent = avgFreq.toFixed(0);
            peakLevelSpan.textContent = avgDb.toFixed(1);
            peakDisplay.style.display = 'block';
        }
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
            this.initWaterfall();
            this.waterfallCtx.putImageData(this.waterfallImageData, 0, 0);
        }

        // Close AudioContext when clearing
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
            this.analyser = null;
        }

        // Hide peak display
        const peakDisplay = document.getElementById('audio-peak-display');
        if (peakDisplay) peakDisplay.style.display = 'none';
    }
}
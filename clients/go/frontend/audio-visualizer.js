// Audio Visualizer for UberSDR Go Client
// Handles FFT spectrum analysis and waterfall display

class AudioVisualizer {
    constructor(spectrumCanvas, waterfallCanvas) {
        this.spectrumCanvas = spectrumCanvas;
        this.waterfallCanvas = waterfallCanvas;

        // FFT parameters
        this.fftSize = 2048;
        this.waterfallHistory = [];
        this.maxWaterfallLines = 200;

        // Display parameters
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
        this.source = null;
        this.lastSampleRate = 0;

        // Animation frame for visualization updates
        this.animationFrameId = null;
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

        // Play the buffer through the analyser (like main app)
        const source = this.audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.analyser);
        source.start();
    }

    initAnalyser() {
        if (!this.audioContext) {
            return;
        }

        // Create analyser node with native FFT (exactly like main app)
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = this.fftSize;
        this.analyser.smoothingTimeConstant = 0; // No smoothing for real-time display

        // Start visualization loop (like main app's startVisualization)
        this.startVisualization();
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

        // Simple fixed dB range (no expensive auto-ranging)
        const minDb = -100;
        const maxDb = -20;
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

        // Calculate display range - matches main app's displayLow/displayHigh logic
        // The main app displays from displayLow to displayHigh (the configured bandwidth with CW offset)
        const nyquist = sampleRate / 2;

        // Add CW offset if in CW mode (matches main app lines 3288, 4815, 5012)
        const cwOffset = (Math.abs(this.bandwidthLow) < 500 && Math.abs(this.bandwidthHigh) < 500) ? 500 : 0;
        const displayLow = cwOffset + this.bandwidthLow;
        const displayHigh = cwOffset + this.bandwidthHigh;

        // For LSB mode, frequencies are negative, so we need to handle them specially
        let binStartFreq, binEndFreq;
        if (this.bandwidthLow < 0 && this.bandwidthHigh <= 0) {
            // LSB: bandwidth is negative (e.g., -2700 to -50)
            // FFT bins are always positive, so convert: display -2700 to -50 as 50 to 2700
            binStartFreq = Math.abs(displayHigh);
            binEndFreq = Math.abs(displayLow);
        } else {
            // USB, CW, AM, etc: use display range directly
            binStartFreq = Math.max(0, displayLow);
            binEndFreq = displayHigh;
        }

        const bandwidth = binEndFreq - binStartFreq;

        // Map to FFT bins
        const startBin = Math.floor((binStartFreq / nyquist) * dbData.length);
        const binsForBandwidth = Math.floor((bandwidth / nyquist) * dbData.length);

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

            const average = count > 0 ? sum / count : minDb;
            const normalized = (average - minDb) / dbRange;
            const y = height - (Math.max(0, Math.min(1, normalized)) * height);
            const x = 50 + i;

            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.stroke();

        // Draw frequency axis labels (show actual audio frequencies)
        ctx.fillStyle = '#fff';
        ctx.font = '10px monospace';
        ctx.textAlign = 'center';

        // Calculate appropriate label spacing based on bandwidth
        const audioBandwidth = bandwidth;
        let labelStep;
        if (audioBandwidth <= 100) {
            labelStep = 20;
        } else if (audioBandwidth <= 200) {
            labelStep = 50;
        } else if (audioBandwidth <= 500) {
            labelStep = 100;
        } else if (audioBandwidth <= 1000) {
            labelStep = 200;
        } else if (audioBandwidth <= 2000) {
            labelStep = 250;
        } else if (audioBandwidth <= 5000) {
            labelStep = 500;
        } else {
            labelStep = 1000;
        }

        // Draw labels from low to high frequency
        const startLabelFreq = Math.ceil(binStartFreq / labelStep) * labelStep;
        for (let freq = startLabelFreq; freq <= binEndFreq; freq += labelStep) {
            const pixelPos = ((freq - binStartFreq) / bandwidth) * (width - 50);
            const x = 50 + pixelPos;

            // For LSB mode, show inverted frequencies
            let displayFreq;
            if (this.bandwidthLow < 0 && this.bandwidthHigh <= 0) {
                // LSB: invert display
                displayFreq = Math.abs(this.bandwidthLow) + Math.abs(this.bandwidthHigh) - Math.abs(freq);
            } else {
                displayFreq = freq;
            }

            const label = displayFreq >= 1000 ? `${(displayFreq/1000).toFixed(1)}k` : `${displayFreq.toFixed(0)}`;
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

        // Simple fixed dB range
        const minDb = -100;
        const maxDb = -20;
        const dbRange = maxDb - minDb;

        // Calculate frequency range - EXACTLY like spectrum
        const nyquist = sampleRate / 2;
        let binStartFreq, binEndFreq;

        // Check if we're in CW mode (narrow bandwidth around zero)
        if (Math.abs(this.bandwidthLow) < 500 && Math.abs(this.bandwidthHigh) < 500) {
            // CW mode: center the display on 500 Hz (the inherent CW offset)
            const cwOffset = 500;
            const halfBW = Math.max(Math.abs(this.bandwidthLow), Math.abs(this.bandwidthHigh));
            binStartFreq = Math.max(0, cwOffset - halfBW);
            binEndFreq = cwOffset + halfBW;
        } else if (this.bandwidthLow < 0 && this.bandwidthHigh > 0) {
            // Bandwidth spans zero (e.g., AM/SAM: -5000 to +5000)
            // Show the full range from 0 to the maximum extent
            binStartFreq = 0;
            binEndFreq = Math.max(Math.abs(this.bandwidthLow), Math.abs(this.bandwidthHigh));
        } else if (this.bandwidthLow < 0 && this.bandwidthHigh <= 0) {
            // Both negative (e.g., LSB: -2700 to -50)
            // Convert to positive frequencies (reversed order)
            binStartFreq = Math.abs(this.bandwidthHigh);
            binEndFreq = Math.abs(this.bandwidthLow);
        } else {
            // Both positive or zero (e.g., USB: 50 to 2700)
            binStartFreq = Math.max(0, this.bandwidthLow);
            binEndFreq = this.bandwidthHigh;
        }

        const bandwidth = binEndFreq - binStartFreq;

        // Map to FFT bins
        const startBin = Math.floor((binStartFreq / nyquist) * dbData.length);
        const binsForBandwidth = Math.floor((bandwidth / nyquist) * dbData.length);

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

            const average = count > 0 ? sum / count : minDb;
            const normalized = (average - minDb) / dbRange;
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
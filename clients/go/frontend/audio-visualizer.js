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

        // Calculate frequency range to display based on bandwidth
        // Show only the actual bandwidth being used (e.g., 50-2700 Hz for USB)
        const nyquist = sampleRate / 2;
        let startFreq, endFreq;

        if (this.bandwidthLow < 0 && this.bandwidthHigh <= 0) {
            // LSB mode: negative bandwidth, but audio spectrum is positive
            startFreq = Math.abs(this.bandwidthHigh);
            endFreq = Math.abs(this.bandwidthLow);
        } else {
            // USB/other modes: use bandwidth as-is
            startFreq = Math.max(0, this.bandwidthLow);
            endFreq = this.bandwidthHigh;
        }

        // Map frequencies to FFT bins
        // dbData.length = fftSize/2 (number of frequency bins from 0 to Nyquist)
        // To map a frequency to a bin: bin = (freq / nyquist) * dbData.length
        const startBin = Math.floor((startFreq / nyquist) * dbData.length);
        const endBin = Math.ceil((endFreq / nyquist) * dbData.length);
        const numBins = endBin - startBin;

        // Debug logging (only log occasionally to avoid spam)
        if (Math.random() < 0.01) {
            console.log(`Spectrum: sampleRate=${sampleRate}, nyquist=${nyquist}`);
            console.log(`Bandwidth: ${this.bandwidthLow}-${this.bandwidthHigh} Hz, display=${startFreq}-${endFreq} Hz (${endFreq-startFreq} Hz total)`);
            console.log(`FFT bins: start=${startBin}, end=${endBin}, numBins=${numBins}, totalBins=${dbData.length}`);
        }

        // Draw spectrum line (only the bandwidth range)
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 2;
        ctx.beginPath();

        let pointsDrawn = 0;
        for (let i = 0; i < numBins; i++) {
            const binIndex = startBin + i;
            if (binIndex >= dbData.length) {
                console.warn(`Bin ${binIndex} out of range (max ${dbData.length})`);
                break;
            }

            const x = 50 + (i / numBins) * (width - 50);
            const normalized = (dbData[binIndex] - minDb) / dbRange;
            const y = height - (Math.max(0, Math.min(1, normalized)) * height);

            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
            pointsDrawn++;
        }
        ctx.stroke();

        // Debug: show how many points were actually drawn
        if (Math.random() < 0.01) {
            console.log(`Drew ${pointsDrawn} points from ${numBins} bins`);
        }

        // Draw frequency axis labels (show actual audio frequencies)
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        const displayBandwidth = endFreq - startFreq;

        // Add more detailed debug info
        ctx.font = '9px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`BW: ${startFreq}-${endFreq} Hz (${displayBandwidth} Hz)`, 55, 15);
        ctx.fillText(`Bins: ${startBin}-${endBin} (${numBins} of ${dbData.length})`, 55, 25);

        // Draw frequency axis labels
        ctx.font = '10px monospace';
        ctx.textAlign = 'center';
        for (let i = 0; i <= 4; i++) {
            const freq = startFreq + (i / 4) * displayBandwidth;
            const x = 50 + (i / 4) * (width - 50);
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

        // Simple fixed dB range
        const minDb = -100;
        const maxDb = -20;
        const dbRange = maxDb - minDb;

        // Calculate frequency range to display based on bandwidth
        const nyquist = sampleRate / 2;
        let startFreq, endFreq;

        if (this.bandwidthLow < 0 && this.bandwidthHigh <= 0) {
            // LSB mode: negative bandwidth, but audio spectrum is positive
            startFreq = Math.abs(this.bandwidthHigh);
            endFreq = Math.abs(this.bandwidthLow);
        } else {
            // USB/other modes: use bandwidth as-is
            startFreq = Math.max(0, this.bandwidthLow);
            endFreq = this.bandwidthHigh;
        }

        // Map frequencies to FFT bins (same as spectrum)
        const startBin = Math.floor((startFreq / nyquist) * dbData.length);
        const endBin = Math.ceil((endFreq / nyquist) * dbData.length);
        const numBins = endBin - startBin;

        // Draw new line at top (only the bandwidth range, starting after left margin)
        const displayWidth = width - leftMargin;
        for (let x = 0; x < displayWidth; x++) {
            const binOffset = Math.floor((x / displayWidth) * numBins);
            const binIndex = startBin + binOffset;
            if (binIndex >= dbData.length) break;

            const db = dbData[binIndex];
            const normalized = (db - minDb) / dbRange;
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
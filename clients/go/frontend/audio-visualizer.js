// Audio Visualizer for UberSDR Go Client
// Handles FFT spectrum analysis and waterfall display

class AudioVisualizer {
    constructor(spectrumCanvas, waterfallCanvas) {
        this.spectrumCanvas = spectrumCanvas;
        this.waterfallCanvas = waterfallCanvas;
        
        // FFT parameters
        this.fftSize = 2048;
        this.audioBuffer = [];
        this.waterfallHistory = [];
        this.maxWaterfallLines = 200;
        
        // Display parameters
        this.minDb = -80;
        this.maxDb = -20;
        
        // Get canvas contexts
        this.spectrumCtx = spectrumCanvas ? spectrumCanvas.getContext('2d') : null;
        this.waterfallCtx = waterfallCanvas ? waterfallCanvas.getContext('2d') : null;
    }
    
    addAudioData(arrayBuffer, sampleRate, channels) {
        // Convert to float32 samples for FFT
        const dataView = new DataView(arrayBuffer);
        const numSamples = arrayBuffer.byteLength / 2;
        
        // Extract mono audio (average channels if stereo)
        for (let i = 0; i < numSamples; i += channels) {
            let sample = 0;
            for (let ch = 0; ch < channels; ch++) {
                const sampleIndex = (i + ch) * 2;
                if (sampleIndex < arrayBuffer.byteLength) {
                    sample += dataView.getInt16(sampleIndex, true) / 32768.0;
                }
            }
            this.audioBuffer.push(sample / channels);
        }
        
        // Process FFT when we have enough samples
        while (this.audioBuffer.length >= this.fftSize) {
            const chunk = this.audioBuffer.splice(0, this.fftSize);
            this.processFFT(chunk, sampleRate);
        }
    }
    
    processFFT(samples, sampleRate) {
        // Apply Hanning window
        const windowed = new Float32Array(this.fftSize);
        for (let i = 0; i < this.fftSize; i++) {
            const window = 0.5 * (1 - Math.cos(2 * Math.PI * i / (this.fftSize - 1)));
            windowed[i] = samples[i] * window;
        }
        
        // Perform FFT
        const fftData = this.performFFT(windowed);
        
        // Convert to dB
        const dbData = new Float32Array(fftData.length);
        for (let i = 0; i < fftData.length; i++) {
            const magnitude = fftData[i] / this.fftSize;
            dbData[i] = 20 * Math.log10(Math.max(magnitude, 1e-10));
        }
        
        // Auto-range dB scale
        this.autoRangeDb(dbData);
        
        // Update visualizations
        this.drawSpectrum(dbData, sampleRate);
        this.drawWaterfall(dbData, sampleRate);
    }
    
    performFFT(samples) {
        // Simple DFT implementation (could be optimized with FFT library)
        const N = samples.length;
        const halfN = Math.floor(N / 2);
        const result = new Float32Array(halfN);
        
        for (let k = 0; k < halfN; k++) {
            let real = 0;
            let imag = 0;
            
            for (let n = 0; n < N; n++) {
                const angle = -2 * Math.PI * k * n / N;
                real += samples[n] * Math.cos(angle);
                imag += samples[n] * Math.sin(angle);
            }
            
            result[k] = Math.sqrt(real * real + imag * imag);
        }
        
        return result;
    }
    
    autoRangeDb(dbData) {
        // Find valid data range
        const validData = Array.from(dbData).filter(v => isFinite(v));
        if (validData.length === 0) return;
        
        // Use percentiles for auto-ranging
        validData.sort((a, b) => a - b);
        const p5 = validData[Math.floor(validData.length * 0.05)];
        const p95 = validData[Math.floor(validData.length * 0.95)];
        
        // Set range with some margin
        this.minDb = p5 - 10;
        this.maxDb = p95 + 10;
        
        // Ensure reasonable range
        const dbRange = this.maxDb - this.minDb;
        if (dbRange < 40) {
            const center = (this.maxDb + this.minDb) / 2;
            this.minDb = center - 20;
            this.maxDb = center + 20;
        } else if (dbRange > 80) {
            this.minDb = this.maxDb - 80;
        }
    }
    
    drawSpectrum(dbData, sampleRate) {
        if (!this.spectrumCtx) return;
        
        const ctx = this.spectrumCtx;
        const width = this.spectrumCanvas.width;
        const height = this.spectrumCanvas.height;
        
        // Clear canvas
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, width, height);
        
        // Draw grid
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const y = (i / 4) * height;
            ctx.beginPath();
            ctx.moveTo(50, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        }
        
        // Draw dB labels
        ctx.fillStyle = '#fff';
        ctx.font = '10px monospace';
        ctx.textAlign = 'right';
        const dbRange = this.maxDb - this.minDb;
        for (let i = 0; i <= 4; i++) {
            const db = this.maxDb - (i / 4) * dbRange;
            const y = (i / 4) * height;
            ctx.fillText(`${db.toFixed(0)}`, 45, y + 4);
        }
        
        // Draw spectrum line with fill
        ctx.fillStyle = 'rgba(30, 144, 255, 0.3)';
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 2;
        
        ctx.beginPath();
        ctx.moveTo(50, height);
        
        for (let i = 0; i < dbData.length; i++) {
            const x = 50 + (i / dbData.length) * (width - 50);
            const normalized = (dbData[i] - this.minDb) / dbRange;
            const y = height - (Math.max(0, Math.min(1, normalized)) * height);
            ctx.lineTo(x, y);
        }
        
        ctx.lineTo(width, height);
        ctx.closePath();
        ctx.fill();
        
        // Draw line on top
        ctx.beginPath();
        for (let i = 0; i < dbData.length; i++) {
            const x = 50 + (i / dbData.length) * (width - 50);
            const normalized = (dbData[i] - this.minDb) / dbRange;
            const y = height - (Math.max(0, Math.min(1, normalized)) * height);
            
            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.stroke();
        
        // Draw frequency labels
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        const nyquist = sampleRate / 2;
        for (let i = 0; i <= 4; i++) {
            const freq = (i / 4) * nyquist;
            const x = 50 + (i / 4) * (width - 50);
            const label = freq >= 1000 ? `${(freq/1000).toFixed(1)}k` : `${freq.toFixed(0)}`;
            ctx.fillText(label, x, height - 5);
        }
        
        // Draw "dB" label
        ctx.textAlign = 'left';
        ctx.fillText('dB', 5, 15);
        
        // Draw "Hz" label
        ctx.textAlign = 'right';
        ctx.fillText('Hz', width - 5, height - 5);
    }
    
    drawWaterfall(dbData, sampleRate) {
        if (!this.waterfallCtx) return;
        
        const ctx = this.waterfallCtx;
        const width = this.waterfallCanvas.width;
        const height = this.waterfallCanvas.height;
        
        // Add new line to history
        this.waterfallHistory.push(Array.from(dbData));
        if (this.waterfallHistory.length > this.maxWaterfallLines) {
            this.waterfallHistory.shift();
        }
        
        // Clear canvas
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);
        
        // Draw waterfall
        const lineHeight = height / this.maxWaterfallLines;
        const dbRange = this.maxDb - this.minDb;
        
        for (let y = 0; y < this.waterfallHistory.length; y++) {
            const line = this.waterfallHistory[this.waterfallHistory.length - 1 - y];
            const yPos = y * lineHeight;
            
            for (let x = 50; x < width; x++) {
                const binIndex = Math.floor(((x - 50) / (width - 50)) * line.length);
                const db = line[binIndex];
                const normalized = (db - this.minDb) / dbRange;
                const color = this.dbToColor(Math.max(0, Math.min(1, normalized)));
                
                ctx.fillStyle = color;
                ctx.fillRect(x, yPos, 1, Math.ceil(lineHeight) + 1);
            }
        }
        
        // Draw frequency labels
        ctx.fillStyle = '#fff';
        ctx.font = '10px monospace';
        ctx.textAlign = 'center';
        const nyquist = sampleRate / 2;
        for (let i = 0; i <= 4; i++) {
            const freq = (i / 4) * nyquist;
            const x = 50 + (i / 4) * (width - 50);
            const label = freq >= 1000 ? `${(freq/1000).toFixed(1)}k` : `${freq.toFixed(0)}`;
            ctx.fillText(label, x, height - 5);
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
        this.audioBuffer = [];
        this.waterfallHistory = [];
        
        if (this.spectrumCtx) {
            this.spectrumCtx.fillStyle = '#1a1a1a';
            this.spectrumCtx.fillRect(0, 0, this.spectrumCanvas.width, this.spectrumCanvas.height);
        }
        
        if (this.waterfallCtx) {
            this.waterfallCtx.fillStyle = '#000';
            this.waterfallCtx.fillRect(0, 0, this.waterfallCanvas.width, this.waterfallCanvas.height);
        }
    }
}
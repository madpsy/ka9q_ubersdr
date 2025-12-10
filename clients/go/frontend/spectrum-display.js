// Spectrum Display Component for UberSDR Go Client
// Displays RF spectrum and waterfall from the UberSDR server

class SpectrumDisplay {
    constructor(spectrumCanvas, waterfallCanvas) {
        this.spectrumCanvas = spectrumCanvas;
        this.waterfallCanvas = waterfallCanvas;
        this.spectrumCtx = spectrumCanvas.getContext('2d');
        this.waterfallCtx = waterfallCanvas.getContext('2d');
        
        // Spectrum data
        this.spectrumData = null;
        this.centerFreq = 0;
        this.binCount = 0;
        this.binBandwidth = 0;
        this.totalBandwidth = 0;
        this.initialBinBandwidth = 0;
        
        // Display parameters
        this.minDb = -100;
        this.maxDb = 0;
        
        // Waterfall
        this.waterfallImageData = null;
        this.waterfallHistory = [];
        this.maxHistory = waterfallCanvas.height;
        
        // WebSocket connection
        this.ws = null;
        this.connected = false;
        this.enabled = false;
        
        // Mouse interaction
        this.setupMouseHandlers();
        
        // Initialize waterfall
        this.initWaterfall();
    }
    
    initWaterfall() {
        this.waterfallImageData = this.waterfallCtx.createImageData(
            this.waterfallCanvas.width,
            this.waterfallCanvas.height
        );
        // Fill with black
        for (let i = 0; i < this.waterfallImageData.data.length; i += 4) {
            this.waterfallImageData.data[i] = 0;     // R
            this.waterfallImageData.data[i + 1] = 0; // G
            this.waterfallImageData.data[i + 2] = 0; // B
            this.waterfallImageData.data[i + 3] = 255; // A
        }
    }
    
    enable(ws) {
        if (this.enabled) return;
        
        this.ws = ws;
        this.enabled = true;
        
        // Send spectrum stream enable message
        const msg = {
            type: 'spectrum_stream',
            enabled: true,
            room: 'spectrum_preview'
        };
        
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
            console.log('Spectrum stream enabled');
        }
    }
    
    disable() {
        if (!this.enabled) return;
        
        this.enabled = false;
        
        // Send spectrum stream disable message
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const msg = {
                type: 'spectrum_stream',
                enabled: false,
                room: 'spectrum_preview'
            };
            this.ws.send(JSON.stringify(msg));
            console.log('Spectrum stream disabled');
        }
        
        // Clear displays
        this.clear();
    }
    
    handleMessage(data) {
        if (!this.enabled) return;
        
        const msgType = data.type;
        
        if (msgType === 'config') {
            // Configuration update
            this.centerFreq = data.centerFreq || 0;
            this.binCount = data.binCount || 0;
            this.binBandwidth = data.binBandwidth || 0;
            this.totalBandwidth = data.totalBandwidth || 0;
            
            if (this.initialBinBandwidth === 0) {
                this.initialBinBandwidth = this.binBandwidth;
            }
            
            console.log(`Spectrum config: ${this.binCount} bins @ ${this.binBandwidth.toFixed(2)} Hz/bin = ${(this.totalBandwidth/1000).toFixed(1)} kHz total`);
            
            // Send initial zoom to 200 kHz if this is first config
            if (this.binCount > 0 && this.centerFreq > 0) {
                this.sendZoomCommand(this.centerFreq, 200000);
            }
        } else if (msgType === 'spectrum') {
            // Spectrum data update
            const rawData = data.data || [];
            
            if (rawData.length > 0) {
                // Unwrap FFT bin ordering
                const N = rawData.length;
                const halfBins = Math.floor(N / 2);
                
                // Rearrange: [negative freqs, positive freqs]
                this.spectrumData = [...rawData.slice(halfBins), ...rawData.slice(0, halfBins)];
                
                // Update displays
                this.draw();
            }
        }
    }
    
    sendZoomCommand(frequency, bandwidth) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (this.binCount === 0) return;
        
        const binBandwidth = bandwidth / this.binCount;
        
        const command = {
            type: 'zoom',
            frequency: frequency,
            binBandwidth: binBandwidth
        };
        
        console.log(`Sending zoom: ${(bandwidth/1000).toFixed(1)} kHz (${binBandwidth.toFixed(2)} Hz/bin)`);
        this.ws.send(JSON.stringify(command));
    }
    
    sendPanCommand(frequency) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        
        const command = {
            type: 'pan',
            frequency: frequency
        };
        
        this.ws.send(JSON.stringify(command));
    }
    
    draw() {
        if (!this.spectrumData) return;
        
        // Auto-range dB scale
        const validData = this.spectrumData.filter(v => isFinite(v));
        if (validData.length > 0) {
            const p1 = this.percentile(validData, 1);
            const p99 = this.percentile(validData, 99);
            this.minDb = p1 - 2;
            this.maxDb = p99 + 5;
        }
        
        this.drawSpectrum();
        this.drawWaterfall();
    }
    
    drawSpectrum() {
        const ctx = this.spectrumCtx;
        const width = this.spectrumCanvas.width;
        const height = this.spectrumCanvas.height;
        
        // Clear
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, width, height);
        
        if (!this.spectrumData || this.spectrumData.length === 0) return;
        
        const marginLeft = 50;
        const marginRight = 20;
        const marginTop = 30;
        const marginBottom = 5;  // Reduced from 30 to 5 to eliminate gap
        const graphWidth = width - marginLeft - marginRight;
        const graphHeight = height - marginTop - marginBottom;
        
        // Draw dB scale
        ctx.fillStyle = '#ffffff';
        ctx.font = '10px monospace';
        ctx.textAlign = 'right';
        
        for (let i = 0; i < 5; i++) {
            const db = this.minDb + (i / 4) * (this.maxDb - this.minDb);
            const y = marginTop + graphHeight - (i / 4) * graphHeight;
            
            ctx.fillText(db.toFixed(0), marginLeft - 10, y + 4);
            
            // Grid line
            ctx.strokeStyle = '#333333';
            ctx.beginPath();
            ctx.moveTo(marginLeft, y);
            ctx.lineTo(marginLeft + graphWidth, y);
            ctx.stroke();
        }
        
        // Don't draw frequency scale on spectrum (waterfall will have it)
        
        // Draw spectrum line
        const dbRange = this.maxDb - this.minDb;
        if (dbRange === 0) return;
        
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 1;
        ctx.beginPath();
        
        let firstPoint = true;
        for (let i = 0; i < this.spectrumData.length; i++) {
            const db = this.spectrumData[i];
            if (!isFinite(db)) continue;
            
            const x = marginLeft + (i / this.spectrumData.length) * graphWidth;
            const normalized = Math.max(0, Math.min(1, (db - this.minDb) / dbRange));
            const y = marginTop + graphHeight - (normalized * graphHeight);
            
            if (firstPoint) {
                ctx.moveTo(x, y);
                firstPoint = false;
            } else {
                ctx.lineTo(x, y);
            }
        }
        
        ctx.stroke();
        
        // Draw filled area
        ctx.fillStyle = 'rgba(30, 144, 255, 0.3)';
        ctx.lineTo(marginLeft + graphWidth, marginTop + graphHeight);
        ctx.lineTo(marginLeft, marginTop + graphHeight);
        ctx.closePath();
        ctx.fill();
    }
    
    drawWaterfall() {
        if (!this.spectrumData || this.spectrumData.length === 0) return;
        
        const width = this.waterfallCanvas.width;
        const height = this.waterfallCanvas.height;
        
        // Use same margins as spectrum display
        const marginLeft = 50;
        const marginRight = 20;
        const graphWidth = width - marginLeft - marginRight;
        
        // Scroll waterfall down
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
        
        // Add new spectrum line at top (only in the graph area)
        const dbRange = this.maxDb - this.minDb;
        
        // Fill left margin with black
        for (let x = 0; x < marginLeft; x++) {
            const idx = x * 4;
            data[idx] = 0;
            data[idx + 1] = 0;
            data[idx + 2] = 0;
            data[idx + 3] = 255;
        }
        
        // Fill graph area with spectrum data
        for (let x = 0; x < graphWidth; x++) {
            const binIdx = Math.floor((x / graphWidth) * this.spectrumData.length);
            const db = this.spectrumData[binIdx];
            
            if (isFinite(db)) {
                const normalized = Math.max(0, Math.min(1, (db - this.minDb) / dbRange));
                const rgb = this.dbToRgb(normalized);
                
                const canvasX = marginLeft + x;
                const idx = canvasX * 4;
                data[idx] = rgb[0];
                data[idx + 1] = rgb[1];
                data[idx + 2] = rgb[2];
                data[idx + 3] = 255;
            }
        }
        
        // Fill right margin with black
        for (let x = marginLeft + graphWidth; x < width; x++) {
            const idx = x * 4;
            data[idx] = 0;
            data[idx + 1] = 0;
            data[idx + 2] = 0;
            data[idx + 3] = 255;
        }
        
        // Draw to canvas
        this.waterfallCtx.putImageData(imageData, 0, 0);
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
    
    percentile(arr, p) {
        const sorted = [...arr].sort((a, b) => a - b);
        const index = Math.floor((p / 100) * sorted.length);
        return sorted[index];
    }
    
    setupMouseHandlers() {
        // Add mouse interaction for click-to-tune, zoom, etc.
        // This can be expanded based on requirements
    }
    
    clear() {
        // Clear spectrum
        this.spectrumCtx.fillStyle = '#000000';
        this.spectrumCtx.fillRect(0, 0, this.spectrumCanvas.width, this.spectrumCanvas.height);
        
        // Clear waterfall
        this.initWaterfall();
        this.waterfallCtx.putImageData(this.waterfallImageData, 0, 0);
        
        this.spectrumData = null;
    }
}
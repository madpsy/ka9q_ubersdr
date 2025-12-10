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
        this.tunedFreq = 0;  // Tuned frequency (where we're listening)
        
        // Display parameters
        this.minDb = -100;
        this.maxDb = 0;
        
        // Drag state for panning
        this.dragging = false;
        this.dragStartX = 0;
        this.dragStartFreq = 0;
        this.dragThreshold = 5;  // Pixels - movement less than this is considered a click
        
        // Frequency change callback
        this.frequencyCallback = null;
        
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

        console.log(`Spectrum display enable() called with tunedFreq: ${this.tunedFreq}`);

        // Send spectrum stream enable message
        const msg = {
            type: 'spectrum_stream',
            enabled: true,
            room: 'spectrum_preview'
        };
        
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
            console.log('Spectrum stream enabled, waiting for config...');
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
            const oldBinCount = this.binCount;
            this.centerFreq = data.centerFreq || 0;
            this.binCount = data.binCount || 0;
            this.binBandwidth = data.binBandwidth || 0;
            this.totalBandwidth = data.totalBandwidth || 0;
            
            if (this.initialBinBandwidth === 0) {
                this.initialBinBandwidth = this.binBandwidth;
            }
            
            console.log(`Spectrum config: ${this.binCount} bins @ ${this.binBandwidth.toFixed(2)} Hz/bin = ${(this.totalBandwidth/1000).toFixed(1)} kHz total`);
            
            // Send initial zoom to 200 kHz if this is first config
            // Use tunedFreq if set, otherwise fall back to centerFreq
            if (oldBinCount === 0 && this.binCount > 0) {
                const zoomFreq = this.tunedFreq || this.centerFreq;
                console.log(`Sending initial zoom to ${zoomFreq} Hz (tunedFreq: ${this.tunedFreq}, centerFreq: ${this.centerFreq})`);
                this.sendZoomCommand(zoomFreq, 200000);
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
        const marginBottom = 30;  // Increased to make room for frequency scale
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
        
        // Draw frequency scale at bottom
        this.drawFrequencyScale(ctx, marginLeft, marginRight, marginTop, marginBottom, graphWidth, graphHeight);
        
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
    
    drawFrequencyScale(ctx, marginLeft, marginRight, marginTop, marginBottom, graphWidth, graphHeight) {
        if (this.totalBandwidth === 0) return;
        
        const startFreq = this.centerFreq - this.totalBandwidth / 2;
        const scaleY = this.spectrumCanvas.height - marginBottom + 10;
        
        ctx.fillStyle = '#ffffff';
        ctx.font = '9px monospace';
        ctx.textAlign = 'center';
        
        // Draw 5 frequency markers
        for (let i = 0; i < 5; i++) {
            const freq = startFreq + (i / 4) * this.totalBandwidth;
            const x = marginLeft + (i / 4) * graphWidth;
            
            // Draw tick
            ctx.strokeStyle = '#ffffff';
            ctx.beginPath();
            ctx.moveTo(x, scaleY - 5);
            ctx.lineTo(x, scaleY);
            ctx.stroke();
            
            // Draw label
            const freqMhz = freq / 1e6;
            ctx.fillText(freqMhz.toFixed(3), x, scaleY + 10);
        }
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
        // Mouse wheel for zoom
        const handleWheel = (e) => {
            e.preventDefault();
            if (e.deltaY < 0) {
                this.zoomIn();
            } else {
                this.zoomOut();
            }
        };
        
        this.spectrumCanvas.addEventListener('wheel', handleWheel);
        this.waterfallCanvas.addEventListener('wheel', handleWheel);
        
        // Mouse down - start drag
        const handleMouseDown = (e) => {
            this.dragging = true;
            this.dragStartX = e.offsetX;
            this.dragStartFreq = this.centerFreq;
        };
        
        this.spectrumCanvas.addEventListener('mousedown', handleMouseDown);
        this.waterfallCanvas.addEventListener('mousedown', handleMouseDown);
        
        // Mouse up - end drag or process click
        const handleMouseUp = (e) => {
            if (this.dragging) {
                const dragDistance = Math.abs(e.offsetX - this.dragStartX);
                if (dragDistance < this.dragThreshold) {
                    // Small movement - treat as click
                    this.handleClick(e);
                }
            }
            this.dragging = false;
        };
        
        this.spectrumCanvas.addEventListener('mouseup', handleMouseUp);
        this.waterfallCanvas.addEventListener('mouseup', handleMouseUp);
        
        // Mouse move - handle drag
        const handleMouseMove = (e) => {
            if (!this.dragging || this.totalBandwidth === 0) return;
            
            const canvas = e.target;
            const marginLeft = 50;
            const marginRight = 20;
            const graphWidth = canvas.width - marginLeft - marginRight;
            
            // Calculate frequency change based on pixel movement
            const dx = e.offsetX - this.dragStartX;
            const freqPerPixel = this.totalBandwidth / graphWidth;
            const freqChange = -dx * freqPerPixel;  // Negative for natural drag direction
            
            let newCenter = this.dragStartFreq + freqChange;
            
            // Constrain to valid range (keep view within 100 kHz - 30 MHz)
            const halfBw = this.totalBandwidth / 2;
            const minCenter = 100000 + halfBw;
            const maxCenter = 30000000 - halfBw;
            newCenter = Math.max(minCenter, Math.min(maxCenter, newCenter));
            
            // Check if tuned frequency will be off-screen after pan
            if (this.tunedFreq !== 0) {
                const startFreq = newCenter - halfBw;
                const endFreq = newCenter + halfBw;
                
                // If tuned frequency is outside the new view, retune to keep it visible
                if (this.tunedFreq < startFreq || this.tunedFreq > endFreq) {
                    let newTunedFreq;
                    if (this.tunedFreq < startFreq) {
                        // Tuned freq is off the left edge - retune to left edge
                        newTunedFreq = startFreq + (halfBw * 0.1);  // 10% from edge
                    } else {
                        // Tuned freq is off the right edge - retune to right edge
                        newTunedFreq = endFreq - (halfBw * 0.1);  // 10% from edge
                    }
                    
                    // Snap to 1 kHz boundary
                    newTunedFreq = Math.round(newTunedFreq / 1000) * 1000;
                    
                    // Call frequency callback to update tuned frequency
                    if (this.frequencyCallback) {
                        this.frequencyCallback(newTunedFreq);
                    }
                }
            }
            
            // Send pan command
            this.sendPanCommand(newCenter);
        };
        
        this.spectrumCanvas.addEventListener('mousemove', handleMouseMove);
        this.waterfallCanvas.addEventListener('mousemove', handleMouseMove);
    }
    
    handleClick(e) {
        if (this.totalBandwidth === 0) return;
        
        const canvas = e.target;
        const marginLeft = 50;
        const marginRight = 20;
        const graphWidth = canvas.width - marginLeft - marginRight;
        
        // Calculate clicked frequency
        const x = e.offsetX - marginLeft;
        if (x < 0 || x > graphWidth) return;
        
        const freqOffset = (x / graphWidth - 0.5) * this.totalBandwidth;
        const clickedFreq = this.centerFreq + freqOffset;
        
        // Snap to nearest 1 kHz boundary
        const newFreq = Math.round(clickedFreq / 1000) * 1000;
        
        // Call frequency callback
        if (this.frequencyCallback) {
            this.frequencyCallback(newFreq);
        }
    }
    
    zoomIn() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (this.binCount === 0) return;
        
        // Halve the bin bandwidth = half the total bandwidth = 2x zoom
        const newBinBandwidth = this.binBandwidth / 2;
        
        // Minimum practical limit
        if (newBinBandwidth < 1) {
            console.log('Maximum zoom reached (1 Hz/bin minimum)');
            return;
        }
        
        // Calculate new total bandwidth
        const newTotalBandwidth = newBinBandwidth * this.binCount;
        
        // Always center on current tuned frequency
        const zoomCenter = this.tunedFreq || this.centerFreq;
        
        // Constrain center frequency to keep view within 100 kHz - 30 MHz
        const halfBandwidth = newTotalBandwidth / 2;
        const minCenter = 100000 + halfBandwidth;
        const maxCenter = 30000000 - halfBandwidth;
        const constrainedCenter = Math.max(minCenter, Math.min(maxCenter, zoomCenter));
        
        console.log(`Zoom in: ${(this.totalBandwidth/1000).toFixed(1)} kHz -> ${(newTotalBandwidth/1000).toFixed(1)} kHz`);
        
        this.sendZoomCommand(constrainedCenter, newTotalBandwidth);
    }
    
    zoomOut() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (this.binCount === 0) return;
        
        // Don't zoom out past initial bandwidth
        if (this.initialBinBandwidth > 0 && this.binBandwidth >= this.initialBinBandwidth) {
            console.log('Already at full bandwidth');
            return;
        }
        
        // Double the bin bandwidth = double the total bandwidth = 0.5x zoom
        let newBinBandwidth = this.binBandwidth * 2;
        
        // Don't zoom out past initial bandwidth
        if (this.initialBinBandwidth > 0 && newBinBandwidth > this.initialBinBandwidth) {
            newBinBandwidth = this.initialBinBandwidth;
        }
        
        // Calculate new total bandwidth
        const newTotalBandwidth = newBinBandwidth * this.binCount;
        
        // Always center on current tuned frequency
        const zoomCenter = this.tunedFreq || this.centerFreq;
        
        // Constrain center frequency to keep view within 100 kHz - 30 MHz
        const halfBandwidth = newTotalBandwidth / 2;
        const minCenter = 100000 + halfBandwidth;
        const maxCenter = 30000000 - halfBandwidth;
        const constrainedCenter = Math.max(minCenter, Math.min(maxCenter, zoomCenter));
        
        console.log(`Zoom out: ${(this.totalBandwidth/1000).toFixed(1)} kHz -> ${(newTotalBandwidth/1000).toFixed(1)} kHz`);
        
        this.sendZoomCommand(constrainedCenter, newTotalBandwidth);
    }
    
    setFrequencyCallback(callback) {
        this.frequencyCallback = callback;
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